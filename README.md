# BetterJIT: FEX to WebAssembly probe

This branch contains the iOS WebAssembly research probe and its FEX IR to WebAssembly translator. It does not enable native JIT in an iOS app or include the full Madeira game runtime. The other BetterJIT prototypes remain on their own branches.

`WasmProbe/` is the test app, web assets, measurements, and source for native reference kernels. `fexwasm/` is the translator, guest code, and browser runtime. [FINDINGS.md](WasmProbe/FINDINGS.md) records earlier device results; this import has not been remeasured on a device.

The source came from the local `wasm-jit` workspace. `fexwasm/` is from Madeira branch `wasm-webview` at `dfbb409`, with the local CPU probe in `js/linux/web/`. `patches/fex-wasm.patch` contains the two local FEX commits after public commit `0f8edf8f6383ae8085e0ffac511c789cdae97514`. Intermediate build directories, signed app bundles, games, and scratch traces are excluded. The WebAssembly fixtures used by the recorded tests are included.

## Build on macOS

Xcode, CMake, Ninja, XcodeGen, Clang, and LLVM's `ld.lld` are required. Set up FEX beside the two source folders:

```sh
git clone https://github.com/willfaust/FEX.git FEX
git -C FEX checkout 0f8edf8f6383ae8085e0ffac511c789cdae97514
git -C FEX submodule update --init --recursive
git -C FEX apply ../patches/fex-wasm.patch
./fexwasm/build_ios.sh
cd WasmProbe
xcodegen generate
```

An unsigned build can be checked with `xcodebuild -project WasmProbe.xcodeproj -scheme WasmProbe -configuration Release -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`. This build passed on the import machine. It is not a device runtime check.

For installation, open `WasmProbe.xcodeproj` and select your own signing team and iPhone. Change the bundle identifier if your team cannot provision the existing one. The project does not carry the source author's signing team. `fexwasm/build.sh` builds Mac test tools after the same FEX setup. `WasmProbe/tools/sync_linux_web.sh` refreshes the bundled browser runtime from `fexwasm/js`.

The imported code is GPL-3.0-or-later. See [COPYING](COPYING), the bundled Box2D and CoreMark licenses, and the licenses in the FEX checkout.
