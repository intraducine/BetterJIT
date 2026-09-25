# BetterJIT

On-device x86-64 translation to WebAssembly, executed by WebKit rather than enabling native-process JIT.

## Two complementary probes

- **FEX research runtime:** `fexwasm/` contains the real FEX IR-to-Wasm backend and browser runtime. `WasmProbe/` is its iOS host, native reference kernels, fixtures and historical device measurements. This is the main development path from PR #4.
- **Isolated transport probe:** root `App/`, `Sources/`, `Web/` and `Tests/` retain PR #3's small Swift translator and independent OPFS/mmap integrity checks. This is a diagnostic fixture, not a replacement for FEX. Run `bash scripts/check.sh`; build with `bash scripts/build-ios.sh`.

These are deliberately separate app targets. The root `project.yml` builds `BetterJITProbe`; `WasmProbe/project.yml` builds `WasmProbe`. Do not confuse the two IPA artifacts.

## FEX build

On macOS, install Xcode, CMake, Ninja and XcodeGen. Set up the pinned FEX source:

```sh
git clone https://github.com/willfaust/FEX.git FEX
git -C FEX checkout 0f8edf8f6383ae8085e0ffac511c789cdae97514
git -C FEX submodule update --init --recursive
git -C FEX apply ../patches/fex-wasm.patch
bash fexwasm/build_ios.sh
cd WasmProbe
xcodegen generate
xcodebuild -project WasmProbe.xcodeproj -scheme WasmProbe -configuration Release -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

Sign with your own team for installation. An unsigned build is not a runtime test. Device measurements must identify the exact commit and signing configuration, run from the Home Screen without a debugger or JIT enabler, and distinguish cold compilation from steady-state execution.

## Evidence and limitations

`WasmProbe/FINDINGS.md` and `WasmProbe/results/` are imported historical measurements, not results obtained from the merged tree. The imported pager tests report guest data beyond 2 GiB backed by native-app RAM with a smaller Wasm resident pool; they do not establish unlimited RAM or a universally fixed WebView memory limit. The root diagnostic's high-offset test is a different, smaller experiment.

OPFS/native sharing depends on WebKit's undocumented storage layout and external-file coherence. It is not zero-copy Wasm linear memory. These probes are not the complete Madeira game runtime and do not establish App Store approval or a game-performance percentage.

## Provenance

PR #4 imported `fexwasm/` from Madeira branch `wasm-webview` at `dfbb409`, plus the local CPU probe and a patch containing two FEX commits after `0f8edf8f6383ae8085e0ffac511c789cdae97514`. Games, signed bundles and the full Madeira runtime were excluded. The FEX research import is GPL-3.0-or-later; preserve `COPYING`, bundled Box2D/CoreMark licenses and upstream FEX notices. The older VPN/interface experiments remain on their original branches.
