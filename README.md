# BetterJIT — private Iridium add-on

This branch is for **intraducine's local Iridium experiments**. Keep this repository private. Do not open a PR against public Iridium, push the generated host checkout, upload lab IPAs, or include game files, signing material or personal logs here.

## What the add-on does

The local build adds a **BetterJIT Lab** button to Iridium's library toolbar. It runs the real FEX frontend and Wasm backend natively, executes the generated Wasm in WKWebView, and checks the bundled x86-64 and Win64 CPU fixtures. Translation is on-device; it does not use StikDebug, a VPN or an external execution server. The lab is idle until a test is selected. Closing it stops its loopback server and drops its translator. Logs live under `Documents/BetterJITPrivate` and are shared only when you select **Share lab log**.

**This is a source add-on for your own rebuilt Iridium, not an installable extension for an existing IPA. It is not yet a replacement game backend.** Iridium's normal game launch path is not switched to Wasm. PR #4 did not include the complete Wine/rootfs/DXMT game runtime, and a CPU checksum test must not be described as running Windows games. The OPFS and software-pager research remains available for that later integration; it is not wired into the private lab's game path.

## Set up locally on your Mac

Use an existing committed Iridium checkout. Setup copies committed source into a **different directory**; it does not change the original, copy its untracked/signing files or share its submodule working trees.

```sh
git switch private/iridium-addon
python3 addon/iridium/prepare.py \
  --iridium /path/to/iridium-full \
  --output "$HOME/Developer/Private/Iridium-BetterJIT"
bash addon/iridium/build-local.sh "$HOME/Developer/Private/Iridium-BetterJIT"
```

macOS, Xcode, CMake, Ninja, Python 3 and XcodeGen are needed. The first build also needs network access to fetch pinned source dependencies; execution of the bundled lab tests is local. The host's existing build scripts prepare its runtime dependencies and print the unsigned IPA path. Sign/install it using your own normal local workflow; these scripts do not read certificates, sign, install, push or upload anything.

The app is named **Iridium Lab**, with bundle ID `software.iridium.betterjit-local`, distinct from normal Iridium. Open **BetterJIT Lab**, then **Run x86-64** or **Run Win64**. JSPI availability is checked at runtime; an older/incompatible WebKit produces a failure report rather than a fake pass. These tests require no games. Close any active game before opening the lab.

The overlay was reviewed against Iridium commit `31ca8f113b842d4c995474438f14c04ef50b7110`. It checks hashes of the three integration files and refuses incompatible revisions instead of guessing. Uncommitted Iridium changes are deliberately not copied. Existing destination directories are never overwritten.

## Private experiment workflow

Edit the add-on/backend **in BetterJIT**, then run `build-local.sh` again. It rebuilds the libraries and refreshes the private snapshot, checking for local edits before overwriting add-on-owned files. A manifest records source revisions, dirty-tree status and snapshot hashes. To experiment directly in the private host snapshot, build there with `bash ci/build-betterjit-private.sh` instead of refreshing it. Keep both repositories on disk; neither one uploads your edits.

The generated host has **no Git remotes**, a rejecting pre-push hook and inactive workflow files. These are accidental-publication safeguards, not DRM; someone with filesystem access can remove them. Removing the private checkout/app rolls back the experiment without modifying normal Iridium. No public Iridium commit is required.

Repository privacy and local build guards are not a verified collaborator audit. For strictly owner-only access, check BetterJIT's **Settings → Collaborators** and installed-app access; do not add collaborators. Workflow files on this branch are manual-only, require a private repository and the `intraducine` actor, and upload no binaries or source archives. No claim is made that this locks an IPA to one person/device.

## Tests and retained research

Run `bash scripts/check.sh` for Swift unit tests, local-checkout safety tests, browser orchestration tests, failed-compiler regression tests and imported FEX fixture replay. These do not replace compiling the combined Iridium target or testing it on your device.

PR #3's isolated transport fixture remains at root `App/`, `Web/`, `Sources/`, `Tests/` and `project.yml`. PR #4's FEX research is in `fexwasm/` and `WasmProbe/`. Both are present in this branch's history. Historical device logs in `WasmProbe/results/` are retained unchanged and are not measurements of this add-on. Standalone diagnostics remain optional; the primary workflow is the local Iridium overlay.

No 70% performance claim, unrestricted memory claim or App Store approval is asserted. The full Madeira game runtime is not included. Preserve `COPYING`, bundled Box2D/CoreMark licenses and upstream FEX notices. The FEX source is pinned to `0f8edf8f6383ae8085e0ffac511c789cdae97514` plus `patches/fex-wasm.patch`.
