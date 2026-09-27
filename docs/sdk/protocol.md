# Execution protocol v1

Messages are JSON objects with `v: 1`, a random per-session `session`, opaque `id`,
`kind`, optional `operation`, `payload` and optional `{code, message}` error.
Kinds: request, response, service, serviceResponse, ready, fatal. Stale sessions
cannot resolve current requests. Duplicate in-flight worker IDs are fatal rather
than resolving the wrong continuation. Pending count and serialized byte budgets
are independent. Native replies bypass guest queues to avoid JSPI deadlock.

Commands: configure, load, unload, invoke, invokeBatch, statistics, read, write,
fex.open and fex.call. Configure happens once; ordinary Wasm and FEX occupy
separate sessions. New operations/ABIs are advertised in `extensions`: batch,
statistics, typedSignatures, resourceBudgets, fex.integerArguments. Missing
extensions in old v1 peers mean unsupported, not implicit support. The legacy
single FEX argument remains accepted and is used with older peers.

`invokeBatch` payload is `{calls: [{module, export, arguments, results}, ...]}`.
The reply is one ordered result array per call. All signatures are checked before
any call; runtime/native side effects are not transactional. `statistics` returns
counts and input-byte/time accounting, not JIT-machine-code residency.

`fex.call` accepts `entry` (low unsigned 32-bit guest address) and either the legacy
`argument` or `arguments` (0–16 canonical unsigned 64-bit decimal strings), never
both. Replies are unsigned 64-bit decimal RAX strings. The extension supplies
integer/pointer register and stack argument placement, not a general struct/float
ABI. FEX execution errors terminate the session. Unsupported syscalls fail.

Generic imports are limited to betterjit.memory and betterjit.call. Native
services are registered capability names, not arbitrary APIs. The latter import
requires the exact `(i32,i32,i32,i32,i32)->i32` signature and JSPI. The `fex` service
exposes config/image/state/dispatcher/unit/region with bounded binary profiles.
FEX compilation remains native and requires its own security review.

WebKit accepts messages only from the configured main frame, exact loopback
origin/port and session. Assets are immutable, paths and Host headers exact;
request bodies, transfer coding and arbitrary filesystem routes are rejected.
Values cross into JavaScript as arguments, never interpolated source. Service
failures/deadlines and process termination reach the public lifecycle immediately.

Protocol v1 is experimental. Additive extensions are not a stable 1.0 ABI promise.
No transport selection, new shared-memory model or OS ABI may be silently inferred.
See [execution contracts](hardening.md) and [source provenance](provenance.md).

Primary references: Apple WKWebView/callAsyncJavaScript documentation;
WebAssembly core binary module specification and JS Promise Integration proposal.
They describe platform facilities, not approval or validation of this SDK.
