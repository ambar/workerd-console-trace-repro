import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const binary = resolve(process.env.WORKERD_BINARY || require('workerd').default);
process.env.MINIFLARE_WORKERD_PATH = binary;
const { Miniflare, Log, LogLevel } = await import('miniflare');

const worker = `
import { DurableObject, tracing } from 'cloudflare:workers';
export class Probe extends DurableObject {
  async run(id) {
    const emit = phase => console.log(JSON.stringify({
      id, phase, api: tracing.getActiveSpan().spanContext()
    }));
    emit('start');
    await (await fetch('https://gate.invalid/' + id)).text();
    emit('resume');
    return { id };
  }
}
export default {
  async fetch(request, env) {
    const id = new URL(request.url).pathname.slice(1);
    return Response.json(await env.PROBE.get(env.PROBE.idFromName('same')).run(id));
  }
};`;

// Keep only synthetic payloads and native correlation fields, before any exporter.
const tail = `
const events = [];
export default {
  tailStream(onset) {
    function capture(e) {
      events.push({
        type: e.event.type, spanContext: e.spanContext,
        invocationId: e.invocationId, streamInvocation: onset.invocationId,
        spanId: e.event.spanId,
        message: e.event.type === 'log' ? e.event.message : undefined
      });
    }
    capture(onset);
    return capture;
  },
  fetch() { return Response.json(events); }
};`;

async function waitFor(read, ready) {
  const deadline = Date.now() + 10000;
  do {
    const value = await read();
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for the local reproduction');
}

const entered = new Set();
const release = {};
const gates = Object.fromEntries(['A', 'B'].map(id =>
  [id, new Promise(resolve => { release[id] = resolve; })]));
const mf = new Miniflare({
  cf: false, log: new Log(LogLevel.ERROR), port: 0, inspectorPort: 0,
  workers: [{
    name: 'probe', modules: true, script: worker,
    compatibilityDate: '2026-05-21', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROBE: { className: 'Probe', useSQLite: true } },
    streamingTails: ['tail'],
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://gate.invalid');
      const id = url.pathname.slice(1);
      assert.ok(id === 'A' || id === 'B');
      entered.add(id);
      await gates[id];
      return new Response('ok');
    }
  }, {
    name: 'tail', modules: true, script: tail, compatibilityDate: '2026-05-21'
  }]
});

const pending = [];
function start(id) {
  const request = mf.dispatchFetch('https://probe.invalid/' + id).then(async response => {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id });
  });
  pending.push(request);
  return request;
}

try {
  const a = start('A');
  await waitFor(() => entered.has('A'), Boolean);
  const b = start('B');
  await waitFor(() => entered.has('B'), Boolean);
  release.A();
  await a;
  release.B();
  await b;

  const collector = await mf.getWorker('tail');
  const events = await waitFor(
    async () => (await collector.fetch('https://tail.invalid/')).json(),
    events => events.filter(e => e.type === 'outcome').length === 4);
  const logs = events.filter(e => e.type === 'log').map(e => ({
    ...e, body: JSON.parse(e.message[0])
  }));
  assert.equal(logs.length, 4, 'Capture every emitted log');
  const starts = new Map(logs.filter(e => e.body.phase === 'start').map(e => [e.body.id, e]));
  assert.equal(starts.size, 2);
  // The API uses fixed-width hex; tail IDs may omit leading zeroes.
  const hex = value => BigInt('0x' + value);
  assert.notEqual(hex(starts.get('A').body.api.traceId), hex(starts.get('B').body.api.traceId));
  const owners = new Map();
  for (const e of events.filter(e => e.type === 'spanOpen')) {
    const span = hex(e.spanId), trace = hex(e.spanContext.traceId);
    assert.ok(!owners.has(span) || owners.get(span) === trace, 'Unambiguous native span owner');
    owners.set(span, trace);
  }
  const rows = logs.map(e => {
    const { id, phase, api } = e.body, initial = starts.get(id);
    return {
      id, phase, api, console: e.spanContext,
      apiCorrect: hex(api.traceId) === hex(initial.body.api.traceId)
        && hex(api.spanId) === hex(initial.body.api.spanId)
        && owners.get(hex(api.spanId)) === hex(api.traceId),
      consoleMismatch: hex(api.traceId) !== hex(e.spanContext.traceId)
        || hex(api.spanId) !== hex(e.spanContext.spanId),
      wrongInvocation: e.invocationId !== initial.invocationId,
      wrongStream: e.streamInvocation !== initial.streamInvocation
    };
  });
  const result = {
    runtime: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
    binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
    logs: rows.length,
    apiErrors: rows.filter(r => !r.apiCorrect).length,
    consoleMismatches: rows.filter(r => r.consoleMismatch).length,
    wrongInvocations: rows.filter(r => r.wrongInvocation).length,
    wrongStreams: rows.filter(r => r.wrongStream).length,
    rows, events
  };
  await writeFile('output.json', JSON.stringify(result, null, 2) + '\n');
  console.table(rows.map(r => ({
    request: r.id, phase: r.phase, apiTrace: r.api.traceId,
    consoleTrace: r.console.traceId, span: r.api.spanId, mismatch: r.consoleMismatch
  })));
  console.log(JSON.stringify({ ...result, rows: undefined, events: undefined }, null, 2));
  assert.equal(result.apiErrors, 0, 'Active span must retain its request identity');
  if (process.argv.includes('--assert-fixed')) {
    assert.equal(result.consoleMismatches, 0);
    assert.equal(result.wrongInvocations, 0);
    assert.equal(result.wrongStreams, 0);
  }
} finally {
  release.A(); release.B();
  await Promise.allSettled(pending);
  await mf.dispose();
}
