# BetterJIT — WKWebView / Wasm / OPFS experiment

A new, independent prototype for **native translation -> Wasm execution in WKWebView -> native file-backed transport**. The existing VPN/interface experiments remain on their original branches; this branch does not enable native-process JIT.

## Implemented

- A small **native Swift x86-64-to-Wasm translator**, with strict rejection of unsupported instructions. Wasm bytes are generated on-device, not downloaded or precompiled to native executable pages.
- An iOS 17+ diagnostic app using a visible `WKWebView` and dedicated module worker, served from bundled assets on **127.0.0.1 only**. No external server, Wi-Fi, VPN, debugger, JIT entitlement, or private WebKit selector is used by the prototype.
- A bidirectional OPFS/native-`mmap` integrity and timing probe at 4 KiB, 64 KiB and 1 MiB. Payload bytes go through the file; WK messages carry control/metadata only. Native finds the worker-created, UUID-marked file under the app's own WebKit storage. Missing/inaccessible backing files fail explicitly.
- An opt-in **sparse offset above 2 GiB** test, using 64-bit Wasm guest addresses and bounded native mapping windows. This is not a 2 GiB RAM allocation or proof that a process memory limit has been removed.
- Differential arithmetic checks, malformed-input/bounds tests, partial-I/O handling, ordered request/reply ownership, JSON reports, and CI for portable tests plus an unsigned iOS IPA.

## Not implemented or demonstrated

**This is not FEX, Wine, a Linux rootfs, DXMT, or a game-capable runtime.** The restricted translator is a disposable integration fixture, not a replacement CPU emulator. No 70% performance claim is made. The reported 200 FPS vs 500–600 FPS and possible 70% target supplied in the discussion are unverified, workload-specific reports, not BetterJIT measurements.

The OPFS on-disk locator deliberately tests an **undocumented WebKit storage layout**. Public APIs do not promise a native URL for an OPFS entry. A portable unit test or desktop browser pass does not prove this locator works on an iPhone. The device test is required.

The Wasm memory helpers perform synchronous `read`/`write` copies. A native `MAP_SHARED` view of the backing file does **not** make it a `WebAssembly.Memory`, a `SharedArrayBuffer`, or cross-process JavaScript atomic memory. This branch makes no claim of zero-copy Wasm guest loads, unlimited RAM, or guaranteed App Store acceptance.

## Build and test

Portable checks (Swift 5.9+, Node 22):

```sh
bash scripts/check.sh
```

Real browser/worker OPFS checks, without pretending to have a native bridge:

```sh
python -m pip install playwright==1.57.0
python -m playwright install chromium webkit
python scripts/browser_smoke.py --browser chromium
python scripts/browser_smoke.py --browser webkit
# Optional: sparse high-offset check; may consume storage quota.
python scripts/browser_smoke.py --browser chromium --large
```

On a Mac with Xcode and XcodeGen:

```sh
brew install xcodegen
bash scripts/build-ios.sh
```

The output is `.build/BetterJITProbe-unsigned.ipa`. Sign it before installation. Alternatively, run `xcodegen generate`, open `BetterJITProbe.xcodeproj`, select a signing team and physical device, and build. For measurements, use **Release**, launch from the device Home Screen with the debugger detached, and do not enable JIT.

The **Wasm OPFS probe** GitHub Actions workflow builds the IPA from the selected branch/commit. An uploaded unsigned IPA is not an App Store-approved build.

Run the default suite first; only then select the high-offset checkbox. Use **Share report** in the native toolbar. See [device-test.md](docs/device-test.md) for acceptance criteria and [architecture.md](docs/architecture.md) for the FEX integration plan and primary sources.
