# Packaged FEX backend

The `BetterJIT-Consumer-<SHA>` Actions artifact contains three sibling Swift
packages: `BetterJIT-SDK`, `FEXNativePackage` and `BetterJITFEXAdapter`.
Keep them together and add **BetterJITFEXAdapter** as a local package in Xcode.
The adapter product supplies the native translator, Linux runtime, WebKit
ownership, filesystem boundary, translation cache and transport configuration.
It links the native C++ runtime. No separate translator Swift files are required
in the consuming app. This binary supports **iOS device arm64**, not Simulator
or macOS. The package manifest records the source revision and hashes every
packaged SDK/backend input file, including the existing CFEXWasm binary. The
outer GitHub artifact has its own digest; generated Xcode project files added
during validation are outside the input manifest's scope.

```swift
import BetterJITFEXAdapter

// On MainActor, keep this object and mount FEXProcessView(process: process)
// while it runs. Supply a staged redistributable Linux root with BusyBox/musl.
let process = try FEXProcess(
    root: linuxRoot,
    configuration: .init(
        arguments: ["/bin/busybox", "sha256sum", "/input/document"],
        timeoutSeconds: 60, sharedAddressSpace: false),
    overlay: ["/input/document": documentBytes])
process.onLog = { text in /* update progress */ }
process.onOutput = { stream, text in /* append UTF-8 stdout or stderr fragments */ }
let result = try await process.run()
// Check result.exitCode and the actual output; close on early abandonment.
```

`run()` closes the one-shot process on completion, failure or task cancellation.
`close()` is idempotent. Create another process for another command; the disk
translation cache is reused. Statistics remain available after cleanup. WebKit
termination is propagated as failure. The runtime uses existing request/guest
deadlines; a native translation call cannot be forcibly interrupted mid-function.
Runtime execution requires WebKit JSPI and shared Wasm memory. Missing support
must be reported as unsupported by the consumer. A timeout or guest trap remains
a failed execution. Linux roots and large input data are supplied by the host;
the companion package does not silently download software or collect credentials.

The **Use backend** tab in the delivered app is a real consumer. It exposes one
async document-digest operation, with Native and BetterJIT implementations.
Native uses CryptoKit. BetterJIT runs the actual x86 Linux BusyBox `sha256sum`
against the selected document bytes, requires exit 0 and native translation/code
mapping evidence, then checks the result against CryptoKit. The default document
is 256 KiB; selected files are limited to 32 MiB and stay on the device. Run All
also includes this consumer operation in its persisted/shareable session report.
The bundled app supplies its signed Alpine BusyBox/musl root; a separate consumer
must supply a compatible staged root. Native is a reference implementation, not
evidence of a native JIT performance comparison.

This is a replaceable backend at an **async operation or guest-process boundary**.
It cannot transparently replace an arbitrary native JIT API that returns callable
host function pointers, executable pages or host pointers into generated code.
Guest addresses stay inside the supported Wasm address window, and host callbacks
must cross explicit services/transport. Native synchronous calling conventions,
host signal handling, threads sharing arbitrary host memory, arbitrary 64-bit
guest mappings and a native graphics driver require integration work. DXMT,
Windows game rendering and general Wine compatibility remain unsupported. The
adapter does not turn these into mocks or silently truncate guest addresses.

From an Apple checkout, after building or restoring the native package:

```sh
python3 scripts/package-fex-adapter.py
python3 scripts/package-fex-consumer.py --output /tmp/BetterJIT-Consumer
python3 /tmp/BetterJIT-Consumer/BetterJIT-SDK/Examples/FEXHost/prepare.py \
  --native-package /tmp/BetterJIT-Consumer/FEXNativePackage \
  --adapter-package /tmp/BetterJIT-Consumer/BetterJITFEXAdapter
```

Packaging uses the committed SDK tree and preserves licenses; existing output
directories are retained instead of overwritten. The automatic Apple workflow
builds both the app and the exported consumer outside the repository before
uploading the bundle. Compilation is separate from phone execution. The artifact
is unsigned and does not include an installation, merge or release action.
