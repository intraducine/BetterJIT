# SDK integration

Add the root Swift package to your application and select `BetterJIT` plus
`BetterJITWebKit`. Ordinary Wasm consumers need neither Iridium nor FEX. The
public API is main-actor isolated; guest computation runs in a dedicated worker.
Mount the transport's WKWebView, retain session/transport, and close explicitly.
The app needs `NSAppTransportSecurity.NSAllowsLocalNetworking = true`. Only
bundled assets are served; there is no external execution server.

```swift
let transport = try WebKitTransport()
let session = try RuntimeSession(transport: transport, limits: RuntimeLimits())
// Mount transport.webView in your UI here.
let capabilities = try await session.start()
let module = try await session.load(wasmBytes)
let answer = try await session.invoke(module, export: "add",
                                      arguments: [.i32(20), .i32(22)])
let results = try await session.invokeBatch([
    WasmInvocation(module: module, export: "add", arguments: [.i32(1), .i32(2)]),
    WasmInvocation(module: module, export: "add", arguments: [.i32(3), .i32(4)])
])
let statistics = try await session.statistics()
session.close()
```

The peer advertises `batch`, `statistics`, `typedSignatures`, `resourceBudgets`
and `fex.integerArguments` in an additive extensions list. New public operations
reject peers that do not support them. Older v1 capability messages decode with
an empty list. The single-argument FEX API retains its older wire representation
when talking to an older peer.

## Guest ABI

Memory-bearing modules import `betterjit.memory` (unshared memory32); private
linear memories are rejected. `readMemory` and `writeMemory` access that session
memory with checked offsets and lengths. Function argument/result types must
match exports exactly. Finite floating-point numbers use decimal strings and
64-bit integers never pass through JSON floating-point numbers. Wasm start
sections are rejected; export and invoke initialization explicitly. Tables must
have finite declared maxima. See [hardening](hardening.md) for the exact profile.

`Guest/include/betterjit.h` declares the C guest's `betterjit.call` import. It
accepts a registered numeric service ID, guest buffer offsets/lengths, and a reply
buffer/capacity; it returns the reply byte count. It never exposes native pointers.
`Examples/CGuest/build.sh` shows the required LLVM memory-import linker options.
This is not WASI; undeclared/unsupported imports are rejected.

## Native services

A service registered as `host.1` is selected by guest service ID 1. The handler
accepts/returns a JSON string containing base64 bytes. It may implement the app's
own renderer commands, storage abstraction or compute operation. Validate its
inputs and register only the minimum capabilities; this SDK does not expose
arbitrary selectors, native APIs, paths or a complete rendering implementation.

```swift
let transport = try WebKitTransport(services: ["host.1": { payload in
    // Validate, process and return a bounded base64 reply.
    return payload
}])
```

The service path requires WebAssembly JSPI and fails explicitly when absent.
Honor cancellation and avoid blocking the main actor. A task deadline cannot
forcibly stop arbitrary native C code or reverse side effects already performed.
The default bridge copies data. OPFS fast transport and software paging remain
separate experimental research; no zero-copy Wasm memory or extra RAM is implied.

## Optional native FEX

From the full research checkout, `bash Backends/FEX/build-ios.sh` prepares the
pinned frontend and creates `.build/FEXNativePackage`, a local device-arm64
CFEXWasm package. It does not supply a simulator slice. Link that package plus
BetterJITFEX and add `Backends/FEX/Swift/LinkedFEXTranslator.swift` to the host.
See `Examples/FEXHost/project.yml` for a standalone consumer.

```swift
let native = try LinkedFEXTranslator(image: image, guestBase: 0x500000400000,
                                     abi: .sysv) // or .win64
let fex = try FEXService(translator: native, image: image)
let transport = try WebKitTransport(services: ["fex": { try await fex.handle($0) }])
let session = try RuntimeSession(transport: transport,
    limits: RuntimeLimits(maximumMemoryPages: 4096))
// Mount transport.webView.
try await session.start()
try await session.openFEX()
let rax = try await session.callFEX(entry: 0x400000, arguments: [20,22])
session.close()
await fex.close()
```

The image must fit one 4-GiB guest-address window; this is not a 4-GiB RAM grant.
Integer/pointer arguments are placed in ABI registers and stack/shadow slots.
Floating-point/aggregate arguments, a guest loader/OS and thread management are
not supplied. Syscalls explicitly fail without a guest OS adapter. Do not infer
Windows game support from an integer checksum. Use trusted guest inputs until
the native compiler and services receive hostile-input review.

## Failures and validation

Observe session.state and session.failure. WebKit idle termination propagates to
the public state; the first cause survives later cleanup errors. Close is
idempotent. Late replies, terminal errors, cancellation and traps cannot turn a
closed session back into a usable one. Recreate a session and reload app-owned
state after terminal failure. An ordered batch is not a transaction.

See [validation commands and evidence boundaries](hardening.md). macOS WebKit
integration tests use the actual host, while Linux explicitly skips them. The
separate Swift stdio adapter proves browser-to-Swift service semantics, not the
WKWebView bridge. The FEX sample requests fresh native translations; recorded
replay tests and C-shim ownership tests are not substitutes for running it.
