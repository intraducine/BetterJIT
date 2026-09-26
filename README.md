# BetterJIT

**App-independent WebAssembly execution and x86-64 translation infrastructure.**
BetterJIT is an embeddable SDK for applications that need a WebKit-backed execution
engine, a native-service bridge, or an optional FEX translation backend. Iridium
is one integration, not the framework's host or required dependency.

This is an experimental SDK, not a system-wide JIT unlocker. An application must
integrate it and route work through its runtime. The initial native executor is
WKWebView on iOS/macOS; the protocol and JavaScript engine are host-independent.
No App Store approval, unrestricted memory or performance percentage is claimed.

## Public products

| Product | Responsibility |
| --- | --- |
| `BetterJIT` | Typed values, limits, lifecycle, versioned protocol, deadlines and request correlation. |
| `BetterJITWebKit` | Loopback assets, per-session WebView, dedicated worker, Wasm execution and registered native services. |
| `BetterJITFEX` | Optional serialized native translation service and FEX guest-call adapter. |

The SDK does not import Iridium's models, UI, paths, renderer or build scripts.
FEX native libraries are optional, separately linked dependencies. Ordinary Wasm
users do not need an Iridium checkout or a FEX build.

```swift
let transport = try WebKitTransport()
let runtime = try RuntimeSession(transport: transport, limits: RuntimeLimits())
// Mount transport.webView in your own UI before starting.
try await runtime.start()
let module = try await runtime.load(wasmBytes)
let answer = try await runtime.invoke(module, export: "add",
                                      arguments: [.i32(20), .i32(22)])
runtime.close()
```

Start with [SDK integration](docs/sdk/README.md), [protocol v1](docs/sdk/protocol.md)
and the **non-Iridium** `Examples/MinimalHost` app. Use the package products from
the root Package.swift. A clean source SDK export excludes the legacy probe products.

## Implemented boundaries

Sessions have separate workers, module tables, memory and native-service allowlists.
Calls support exact i64 values, memory reads/writes, module load/unload, bounded
queues, deadlines, cancellation and WebContent termination handling. A timeout
terminates the session rather than pretending an interrupted guest is safe to reuse.
Native services require explicit registration and JSPI capability support.

The FEX driver connects the existing native translator and Wasm runtime through
an application-independent service interface. It supports one unshared guest
window, on-demand units/regions, and SysV/Win64 function calls. It does not include
a full Windows/Linux environment, Wine launcher, DXMT renderer or arbitrary game
support. The native translator and custom services require their own input-security
review. The default message bridge copies data; OPFS/native-mmap paging remains
experimental research, not a promoted stable or zero-copy SDK transport.

## Develop and validate

```sh
bash scripts/check-sdk.sh
# Optional real JSPI/FEX fixture execution in a current browser:
python3 tests/sdk/browser-sdk.py --chromium /path/to/chromium --research-fixtures
```

The standalone sample and WebKit target need an Apple SDK for compilation. Portable
Swift/Node and Chromium tests do not establish physical-device behavior. Optional
SDK CI is manual-only and does not publish artifacts or require a particular user.
[Source provenance](docs/sdk/provenance.md) records the imported FEX runtime.

## Source distribution

```sh
python3 scripts/export-sdk.py --check
python3 scripts/export-sdk.py --output /outside/repo/BetterJIT-SDK.tar.gz
```

The exact-path SDK export is distinct from the older Iridium-add-on exporter.
It is a reproducible local source candidate with licenses and checksums, not a
release. Follow [SDK publication](docs/sdk/publishing.md) before distributing it.
The repository remains private; new architecture does not publish old research
history or change its licenses. See COPYING and the retained third-party notices.

## Existing integrations and research

`addon/iridium` remains an optional adapter with its reviewed host profiles and
local build safeguards. Its earlier compatibility defaults are unchanged. The
private experiment branch is preserved. Root App/Web/BetterJITCore and WasmProbe
remain legacy research harnesses; consumers of the new SDK need neither.

`feature/runtime-sdk` is the consolidated development lane. See [branch maintenance](docs/branches.md)
for the exact-tip archive/prune plan, which preserves unique old experiments and
keeps `main` and `private/iridium-addon`. No unreviewed code is merged into main.
