# BetterJIT

App-independent WebAssembly execution and optional x86-64 translation
infrastructure. Applications embed the SDK and supply workloads and explicitly
registered native services. Iridium is an optional adapter, not a dependency.

This is an experimental SDK, not a system-wide JIT unlocker or complete Windows
runtime. The native executor targets iOS/macOS WKWebView. Nothing here grants an
unmodified application native JIT, unrestricted RAM, or App Store approval.

## Package products

- `BetterJIT`: exact numeric values, sessions, protocol, bounded requests,
  lifecycle failure reporting, batched calls and execution statistics.
- `BetterJITWebKit`: per-session worker, bundled loopback assets, Wasm execution,
  memory transfers and explicitly registered native services.
- `BetterJITFEX`: optional serialized FEX translation service and SysV/Win64
  integer/pointer function-call adapter. Native FEX is built separately.

```swift
import BetterJIT
import BetterJITWebKit

let transport = try WebKitTransport()
let runtime = try RuntimeSession(transport: transport, limits: RuntimeLimits())
// Mount transport.webView in your own UI before starting.
try await runtime.start()
let module = try await runtime.load(wasmBytes)
let result = try await runtime.invoke(module, export: "add",
                                      arguments: [.i32(20), .i32(22)])
runtime.close()
```

See [integration](docs/sdk/README.md), [protocol](docs/sdk/protocol.md), and
[execution/validation contracts](docs/sdk/hardening.md). The SDK has no Iridium
models, renderer, signing identity or filesystem dependency.

## Examples and checks

`Examples/MinimalHost` is an ordinary non-Iridium iOS Wasm consumer.
`Examples/CGuest` compiles real C to Wasm and a native differential reference.
`Examples/FEXHost` requests fresh native FEX translations, without recorded
modules; it needs the separately built device-arm64 backend.

```sh
bash scripts/check-sdk.sh
python3 tests/sdk/native-binding.test.py
bash Examples/CGuest/build.sh
python3 tests/sdk/browser-sdk.py --c-guest --native-service --research-fixtures
# On macOS with a graphical session:
swift test --filter AppleHostTests
```

Browser/native-stdio tests, C-shim ownership checks, recorded FEX replay, Apple
compilation and physical-device runs are separate evidence levels. A passing
Linux or Chromium check is not an iPhone, live native-FEX, or game compatibility
claim. Manual CI uploads no artifacts and performs no signing or publication.

## Boundaries

Native services require JSPI; unsupported engines fail explicitly. Sessions
serialize calls and bound input memory, compilation bytes, tables and queues.
The limits do not measure JIT code allocation or remove OS memory limits. Typed
signatures are checked before guest execution, and new operations are advertised
through capability extensions. Timeouts, malformed typed replies and guest traps
end a session; cancellation does not roll back native side effects.

FEX supports one unshared guest-address window and 0–16 integer/pointer arguments,
not complete Linux/Windows processes, multithreading, struct/float guest ABIs,
Wine or DXMT. Unsupported syscalls fail rather than returning research stubs.
FEX and application-defined native services still require hostile-input review.
The default bridge copies bounded messages. OPFS/native-mapped paging remains
research, not a stable or zero-copy SDK transport.

## Distribution and maintained work

`python3 scripts/export-sdk.py --check` validates the SDK-only exact-path source
allowlist. `--output /outside/repo/BetterJIT-SDK.tar.gz` creates a local candidate;
it does not publish. See [publication](docs/sdk/publishing.md) and
[provenance](docs/sdk/provenance.md). Preserve COPYING and component notices.
An app-independent API does not change the existing GPL licensing.

Use `feature/runtime-sdk` and the consolidated SDK PR for current development.
The private Iridium adapter remains untouched on its private lane. Legacy probes
and historical logs are not prerequisites and are excluded from the SDK export.
[Branch maintenance](docs/branches.md) documents ancestry preservation and the
leased cleanup command. Repository visibility is unchanged; no release is made.
