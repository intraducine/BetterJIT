# BetterJIT SDK integration

BetterJIT is an embeddable execution and translation infrastructure project.
Applications depend on the SDK; the SDK does not depend on Iridium. An emulator,
language runtime or compute application supplies modules or a translator, its
native services and its UI. The initial native host is iOS/macOS WKWebView.
This is not a facility for enabling executable native pages in an arbitrary
unmodified app, and it is not a universal binary compatibility layer.

## Package products

- `BetterJIT`: typed values, configuration, lifecycle, protocol and request broker.
  Foundation-only; its tests run on Linux too.
- `BetterJITWebKit`: per-session loopback asset host, WebView and dedicated worker.
  Supports ordinary Wasm and the FEX execution driver. No Iridium types or paths.
- `BetterJITFEX`: optional serialized translation service and guest-call API.
  Uses a caller-supplied native translator, with a concrete binding in
  `Backends/FEX/Swift/LinkedFEXTranslator.swift`.

`BetterJITCore` and `betterjit-probe` in the full research checkout are legacy
probe products, not prerequisites for these three SDK products. The clean SDK
export has its own manifest with only the SDK products.

## Ordinary Wasm

Add this repository as a Swift package and select BetterJIT and BetterJITWebKit.
Mount the transport's WebView in your application's view hierarchy. Keep the
session and transport alive, then:

```swift
import BetterJIT
import BetterJITWebKit

let transport = try WebKitTransport()
let runtime = try RuntimeSession(transport: transport, limits: RuntimeLimits())
// Add transport.webView to your UIView/NSView hierarchy before starting.
let capabilities = try await runtime.start()
let module = try await runtime.load(wasmBytes)
let result = try await runtime.invoke(module, export: "add",
                                      arguments: [.i32(20), .i32(22)])
// result == [WasmValue.i32(42)]
runtime.close()
```

These APIs are main-actor isolated; guest execution occurs in the worker. Public
numeric values are tagged and encoded as strings, preserving all i64 bits.
The host-call ABI intentionally rejects nonfinite floats at its boundary.
Memory-bearing modules must import `betterjit.memory`, not define private
linear memories. `readMemory` and `writeMemory` access that session memory.
The runtime serializes commands, including writes while a guest is suspended.
It is not a WASI implementation: arbitrary imports are rejected.

The app needs `NSAppTransportSecurity.NSAllowsLocalNetworking = true` to serve
its bundled resources over IPv4 loopback. There is no external execution server,
Wi-Fi requirement, arbitrary filesystem server, downloaded JavaScript or public
network listener in the SDK. The sample's generated Info.plist supplies this key.

## Native services

Register only the services the guest needs. With a `host.1` registration, a Wasm
import `betterjit.call(i32 service, i32 inputOffset, i32 inputLength,
i32 outputOffset, i32 outputCapacity) -> i32` calls it and returns the response
length. The service receives/returns a JSON string containing base64 bytes.
For example, a service could consume a batch of your renderer's commands and
return an acknowledgment. The SDK does not provide a renderer or expose arbitrary
native pointers, selectors or platform APIs.

This path requires WebAssembly JSPI. Capability detection returns an explicit
unsupported error when it is absent; no native JIT or slow interpreter substitute
is quietly selected. Native handlers run with your application's privileges:
audit them, validate their inputs, avoid blocking the main actor, and honor
cancellation. An uncooperative native handler cannot be forcibly terminated by
cancelling a Swift task.

## FEX x86-64 backend

In a full source checkout, `bash Backends/FEX/build-ios.sh` prepares the pinned
FEX sources and creates a local device-arm64 `CFEXWasm` package under
`.build/FEXNativePackage`. Add that package, the `BetterJITFEX` product and the
concrete `LinkedFEXTranslator.swift` source to your host. No simulator binary is
produced. The optional native backend is built separately; SwiftPM does not
fetch/build FEX for every SDK consumer.

```swift
import BetterJITFEX
let native = try LinkedFEXTranslator(image: imageBytes, guestBase: guestBase,
                                     abi: .sysv) // or .win64
let fex = try FEXService(translator: native, image: imageBytes)
let transport = try WebKitTransport(services: ["fex": { try await fex.handle($0) }])
let runtime = try RuntimeSession(transport: transport,
    limits: RuntimeLimits(maximumMemoryPages: 4096))
// Mount transport.webView.
try await runtime.start()
try await runtime.openFEX()
let rax = try await runtime.callFEX(entry: entryLow32, argument: 1000)
runtime.close()
await fex.close()
```

The native translator is exclusively owned by the service. This driver currently
supports one unshared FEX guest-address window, SysV/Win64 function calls and
on-demand unit/region requests. It is a function-execution interface, not a Wine
launcher, complete Linux machine, Windows process loader or multithreaded guest
API. Existing OS, OPFS pager and DXMT research remains separate. No game support
is inferred from a function checksum.

The native translator processes guest instructions outside WebKit's sandbox.
Use trusted code inputs until that compiler and all custom native services have
been reviewed for hostile inputs. The generic Wasm checks do not turn FEX into
an audited security boundary.

## Lifecycle, limits and errors

A session starts once and closes idempotently. A timeout or cancellation aborts
the entire worker and all pending calls: continuing with uncertain memory state
would be unsafe. Recreate the session and reload application-owned state after
WebContent termination. Late replies and replies from another session are ignored.
Do not share module identifiers across sessions.

Limits cover imported linear memory, input/transfer bytes, module count and queue
depth, not all engine code/heap allocations or system memory pressure. Unloading
modules does not force JavaScriptCore's garbage collector or guarantee immediate
JIT code reclamation. The engine's JIT tier is not observable through this API.

The portable default bridge copies bounded messages. It is not the fast OPFS
native-mmap transport, does not claim zero-copy memory, and does not lift a
WebContent resident-memory limit. OPFS backing-file discovery relies on private
storage layout and is not promoted into the stable SDK contract in this revision.
The protocol/transport boundary permits a separately negotiated fast transport
without tying consumers to Iridium's filesystem or renderer.

## Standalone sample and verification

`Examples/MinimalHost` compiles a separate app with no Iridium checkout or FEX
library. Run XcodeGen in that directory and open its generated project; configure
your own signing team locally. It computes 20 + 22 in a real Wasm module.

`bash scripts/check-sdk.sh` checks the portable Swift and JS components. To test
current JSPI behavior, install Playwright and Chromium and run
`python3 tests/sdk/browser-sdk.py --chromium /path/to/chromium`. The full research
checkout additionally supports `--research-fixtures`, which replays recorded FEX
translations through the new service protocol. That is not live native translation.
The manual SDK workflow also compiles the Apple WebKit implementation and sample.
A Linux pass does not typecheck WebKit against Apple's SDK or establish iOS behavior.
