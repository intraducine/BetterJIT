# Execution protocol v1

Messages are JSON objects with `v: 1`, a per-session random `session`, an opaque
`id`, `kind`, optional `operation`, `payload` and optional `{code, message}` error.
Kinds are `request`, `response`, `service`, `serviceResponse`, `ready` and `fatal`.
Request IDs are unique; replies resolve at most one pending request. Session or
version mismatches cannot fulfill a different session's continuation.

Commands: `configure`, `load`, `unload`, `invoke`, `read`, `write`, `fex.open`,
`fex.call`. Configuration precedes execution and cannot be replaced in-place.
FEX and ordinary modules use separate sessions. Command execution is serialized;
service replies bypass the command queue so a suspended guest can resume.
A worker failure, deadline or cancellation tears down the whole session.

Generic Wasm imports are restricted to `betterjit.memory` and `betterjit.call`.
The latter requires JSPI and an application-registered `host.<u32>` service.
Native services are capability names, not filesystem paths or arbitrary APIs.
The `fex` service accepts config/image/state/dispatcher/unit/region requests;
regions are bounded little-endian profiles checked before native translation.

The WebKit host serves only fixed SDK assets from random per-session loopback
paths. Host headers and asset paths are checked exactly; bodies, transfer coding,
duplicate headers and arbitrary routes are rejected. WebKit replies are checked
for main frame, loopback origin, port, protocol and session. JavaScript receives
JSON as an argument, never as interpolated executable source.

Protocol v1 is experimental, not a stable 1.0 API promise. Add capability negotiation
before adding new backend ABIs, service behavior or shared-memory transport. Never
silently reinterpret an existing opcode or integer encoding.

Primary platform references:
- Apple WKWebView: https://developer.apple.com/documentation/webkit/wkwebview
- Apple callAsyncJavaScript: https://developer.apple.com/documentation/webkit/wkwebview/callasyncjavascript(_:arguments:in:contentworld:completionhandler:)
- WebKit OPFS design: https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/
- WebAssembly JSPI: https://github.com/WebAssembly/js-promise-integration

These describe platform facilities, not approval of this SDK or independent
verification of its implementation.
