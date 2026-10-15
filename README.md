# workerd console trace attribution repro

Two overlapping RPC requests to the same Durable Object can produce a console log whose native trace ID belongs to the other request, even though `tracing.getActiveSpan().spanContext()` returns the correct trace and span.

```text
A starts:   API = trace A / span A; console = trace A / span A
B starts:   API = trace B / span B; console = trace B / span B
A resumes:  API = trace A / span A; console = trace B / span A  <-- mismatch
```

## Run

Requires Node.js 22+ and a platform supported by the workerd npm package.

```sh
npm ci
npm start
```

The dependency lock pins Miniflare and the official workerd `1.20261015.1` runtime. No Cloudflare account, credentials, deployment, or external service is needed. The probe's fetch is intercepted locally; `.invalid` URLs are synthetic.

The run prints a comparison table and writes `output.json` with the four logs and native tail events. On the affected runtime, expect:

```json
{
  "logs": 4,
  "apiErrors": 0,
  "consoleMismatches": 1,
  "wrongInvocations": 1,
  "wrongStreams": 1
}
```

Default mode reports observations without requiring the bug to be present. To test another binary and require the mismatch to be fixed:

```sh
WORKERD_BINARY=/absolute/path/to/workerd npm start -- --assert-fixed
```

## What is measured

`repro.mjs` contains the Worker, the tail collector, and the local harness. A waits on a gated fetch; B then enters the same object and waits; the harness releases A before B. Ordering uses explicit gates, not a race or a timing delay.

Each call logs only `start` and `resume`. The log **body** contains the IDs returned directly by `getActiveSpan().spanContext()`. The collector independently records the **native metadata** added by workerd: `event.spanContext`, invocation ID, and receiving tail stream. Native `spanOpen` events establish the span's owning trace. Hex IDs are normalized to account for omitted leading zeroes.

No custom spans, third-party tracing SDK, exporter, or application framework is involved. The reproduction checks console log attribution; it does **not** test exception-event attribution or claim that the tracing API is correct in every possible scenario.

See [VALIDATION.md](VALIDATION.md) for before/after evidence, implementation scope, related upstream work, and the verified introduction boundary. All committed events come from this synthetic local probe.
