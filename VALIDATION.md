# Validation and scope

The runnable reproduction is independent of any proposed fix or upstream pull request. This document records additional comparisons; none of them is needed to run `npm ci && npm start`.

## Minimal reproduction results

All three runs use the exact committed `repro.mjs`, on macOS arm64 with Node.js 26.7.0, Miniflare 4.20260714.0, and compatibility date 2026-05-21. Each run captures all four emitted logs.

| Runtime | Incorrect API trace/span | Console metadata mismatches | Wrong invocation | Wrong tail stream |
|---|---:|---:|---:|---:|
| [Official 1.20261015.1](evidence/baseline.json) | 0/4 | 1/4 | 1/4 | 1/4 |
| [Pinned base + upstream #7578](evidence/upstream-7578.json) | 0/4 | 1/4 | 1/4 | 1/4 |
| [Pinned base + proposed fix](evidence/fixed.json) | 0/4 | 0/4 | 0/4 | 0/4 |

For the same `A / resume` log in the official binary:

| Source | traceId | spanId |
|---|---|---|
| `getActiveSpan().spanContext()` | `aa98c497ef5d5ad1f3fa9115527c1be0` | `265aca35b39c009f` |
| Native console event metadata | `188bedcc8cb42f18ed582fed0f4456e1` | `265aca35b39c009f` |

The native `spanOpen` event independently associates this span with A's trace. The API still returns A/A, while the log metadata combines B/A and the log is delivered on B's tail stream. This demonstrates a console attribution defect in this reproduction; it does not establish universal correctness of `getActiveSpan()`.

## Proposed fix

[Preview branch](https://github.com/ambar/workerd/tree/codex/fix-do-log-trace-context) · [Fix commit](https://github.com/ambar/workerd/commit/75cd50267f4570a2fda1f8e54171d14564004323)

The patch makes `IoContext::getWorkerTracer()` and `getInvocationSpanContext()` read the existing request-specific `UserTraceAsyncContext`. Nested spans inherit the originating async context, while invocation entry starts from its incoming request. The tracer remains weak, cross-IoContext access is checked, and GC logging paths establish a handle scope.

The upstream regression test added by the patch covers serial execution and three overlap orders (A completes first, A fails first, B completes first), including nested-span restoration and diagnostic events. 33 distinct related runtime test targets and the new test's ESLint target passed. No upstream PR has been submitted as part of this preview.

## Background-task lifecycle regression and correction

Review of the first preview commit (`b12fba00383c0ee52fcd603dbff9121537f97142`) found that a captured weak tracer could expire while a Durable Object background task remained live. The initial patch returned no tracer in that case and silently dropped subsequent console logs.

The follow-up fix distinguishes an expired tracer from a frame that was never traced. A live originating tracer retains its original request context. When that tracer has ended, the tracer, invocation IDs, and span parent fall back together to the current incoming request, which owns the object's continuing background work. This does not reopen a closed trace or extend its lifetime with a strong reference. Deliberately untraced frames remain untraced.

A deterministic test makes A register a `waitUntil()` callback on an object-local Promise and return. B enters; the test waits for A's tail outcome before B releases A's callback. The callback logs, creates a nested span, publishes a diagnostic event, and signals completion while B remains active. Native span ownership and receiving invocation/stream are checked throughout.

| Independent background probe | Logs emitted | Logs captured | Background completion confirmed |
|---|---:|---:|---|
| Official release | 4 | 4 (continuation attributed to B) | Yes |
| Initial preview fix | 4 | 3 | Yes |
| Updated fix | 4 | 4 (consistent B/B native context) | Yes |

This completed-request fallback differs from the main reproduction, where A's trace is still live and both API and console must retain A/A. The main reproduction still reports zero console mismatches on the updated fix.

The expanded `do-log-attribution-test@` first failed on the initial preview at its log-completeness assertion, then passed with the lifecycle fix. Default, all-compatibility-flags, all-autogates, and GC-stress variants pass, covering 46 logs and nine diagnostic events. The broader suite also covers tracing hierarchy, RPC callbacks/pipelines, ordinary tail delivery, structured errors, async_hooks/AsyncResource, and foreign-context GC. This is bounded regression evidence, not a claim about every production configuration or performance.

## Relationship to upstream #7578

[cloudflare/workerd#7578](https://github.com/cloudflare/workerd/pull/7578) was tested at head `af66a61d0c2c09f46115f1d7051de37bfde8de31`, integrated into the same pinned base as the proposed fix. It was open and unmerged when inspected. Two integration conflicts only involved adjacent declarations in `io-context.h` and `worker.h`; both sets of declarations were retained. The tested binary contains that PR but not the proposed console fix.

The PR threads the owning `IncomingRequest` through exception-reporting paths so that the tracer and request-root span are selected from the originating request. It updates request handlers, alarms, RPC sessions, hibernatable WebSockets, UDP connect, and trace/tail handlers. It also corrects some RPC-info and return-event attribution, so describing it as modifying *only* exceptions would be too narrow.

It does not correct the general console `addLog()` path: that path still selects the latest incoming request's tracer and trace/invocation IDs while taking the active user span from async context. It does not change the `getActiveSpan()` implementation.

The PR's own `actor-exception-attribution-tail-test@` passed. That test makes an older DO fetch throw while a newer request is active, then checks that the older trace contains the exception and the newer/release traces do not. The console reproduction above does not test this behavior.

An earlier, broader four-scenario probe also exercised an RPC failure. Its two mismatches in that scenario were the `resume` and `failed` **console log events**. The caller caught the RPC error and returned HTTP 500; there was no exception-type event in that captured run. That result must not be interpreted as evidence that #7578 failed to fix exception attribution.

## Introduction boundary

There are two different symptoms: logs assigned to another request, and an internally mixed trace/span pair.

- [a0fb590](https://github.com/cloudflare/workerd/commit/a0fb590cd7d5035cd3a60ffd414a3794444fbbb0), committed April 24, 2026, introduced the split-source formula for non-span events: incoming trace/invocation IDs plus the active async span ID. First containing public tag: `v1.20260425.1`. This code history alone does not prove this RPC reproduction failed in April.
- [d735ee3](https://github.com/cloudflare/workerd/commit/d735ee3478fc7999ed84c3f920cf8678e7156965), committed September 4, installed RPC async-span scopes behind the JSRPC tracing gate.
- [d099c3f](https://github.com/cloudflare/workerd/commit/d099c3f21576d15ea58c6e3301249d2234a102c1), committed September 28, 2026 at 16:59:51 UTC, removed that gate. First containing public tag: `v1.20260929.1`.

An earlier four-scenario console-only probe (six logs per scenario, without directly reading API IDs) produced these results against official npm releases:

| Official release | Serial: mixed pair / wrong invocation | Each overlapping case: mixed pair / wrong invocation |
|---|---|---|
| 1.20260904.1 | 0/6 / 0/6 | 0/6 / 2/6 |
| 1.20260905.1 | 0/6 / 0/6 | 0/6 / 2/6 |
| 1.20260928.1 | 0/6 / 0/6 | 0/6 / 2/6 |
| 1.20260929.1 | 0/6 / 0/6 | 2/6 / 2/6 |
| 1.20261015.1 | 0/6 / 0/6 | 2/6 / 2/6 |

Thus wrong-request attribution predates September 29, while September 29 is the verified public default-runtime boundary for the mixed B/A pair in that probe. This is not a claim about the hosted platform's rollout date. Within a failing run, the initial A/B logs are correct; A first becomes misattributed when it resumes after B has entered. The current minimal script additionally reads API IDs and is pinned to a runtime supporting that API; it is not presented as a historical-version test harness.

## Build provenance

- Pinned source base: `ea98c6103bd34bfca4a20bd5c6c52bf4c15a5c59`.
- Official release tag: `v1.20261015.1` (`fc3b0fe23cc395c167e546f5bac3120c0181a821`). Only compatibility-date source files differ from the pinned base; the relevant tracing/RPC code is identical.
- Proposed fix: `75cd50267f4570a2fda1f8e54171d14564004323` on that base. The initial fix and the background-lifecycle correction are separate commits; both use the GitHub account's noreply identity.

The source-built runtimes used Bazel 9.3.0 and target `//src/workerd/server:workerd`. Local build options were:

```sh
bazel build //src/workerd/server:workerd \
  --jobs=4 --local_resources=cpu=4 --copt=-g0 --strip=never \
  --@rules_rust//:extra_exec_rustc_flags=-Cdebug-assertions=n,-Cstrip=none \
  --@rules_rust//:extra_rustc_flag=-Cstrip=none
```

Binary SHA-256 values are included in each evidence file:

- Official 1.20261015.1: `64dad95c963694864b26dd62fa5d0636974f7840f81691fe42d456f435a3e0d1`.
- Pinned base + upstream #7578: `7898b7a4670a7ec6e4d4841fa198543fc5f81ea4bcf8fdb0fabf7c87423ce1a2`.
- Pinned base + proposed fix: `93a9db728491d7dd54c66c31b3100503258e3d11555ac5a7fd8eb7bc0530d69f`.

Committed evidence contains only synthetic local events. No production logs, request headers, account configuration, filesystem paths, or credentials are included.
