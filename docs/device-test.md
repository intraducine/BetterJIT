# Device test: distinguish execution, transport and memory claims

## Baseline conditions

Use the IPA from this branch's exact successful Actions commit, not the older VPN/interface probe. Record the commit shown in the JSON report, app build number, iPhone/iPad model and iOS version. Use a Release build. Launch it from the Home Screen with no debugger attached, no StikDebug activation, no VPN, and no existing JIT-enablement step. Airplane Mode is a useful second pass to check that no external network is required; loopback is still local networking.

Keep the app foregrounded and the diagnostic WebView visible. Record thermal conditions and device power mode when comparing timings. An attached debugger, simulator, LiveContainer host, or desktop WebKit result is a different test condition; do not combine those measurements.

## Default suite

Tap **Run tests**, leaving the high-offset option off.

| Stage | Required result | What it establishes |
| --- | --- | --- |
| `native-translated-wasm` | PASS, correct checksums | Native-generated Wasm executed correctly in this host. Does not identify the internal WebKit compiler tier. |
| `wasm-opfs-memory` | PASS, 41 -> 42 | Translated i64 guest load/store helpers operate through a real OPFS sync handle. |
| `opfs-native-mmap` | PASS at 4 KiB, 64 KiB, 1 MiB | Native found the worker-created backing file, read correct bytes through mmap, and the worker read the native transformation. |
| `cleanup` | PASS | This run closed its sync handle and removed its temporary OPFS file. |

Share `BetterJIT-last-report.json` from the toolbar. A browser-only `SKIP` for native mmap is not a device transport pass. A passing Wasm test does not mean OPFS sharing passed. Missing backing-file access must remain a failure, not trigger a copied-file fallback.

If the locator fails, preserve the exact error/OS/build first. Only inspect the app's own storage container to determine whether WebKit changed layout or access. Do not add private selectors, request broader filesystem access, or silently create a separate “shared” file.

## Optional >2 GiB logical offset

After the default suite passes, select **Also test a sparse file offset above 2 GiB** and run again. This requests OPFS capacity beyond 2 GiB and may fail for quota/disk reasons even with little actual data. The probe checks reported quota first, but that estimate is not a guarantee.

`high-offset-memory: PASS` means a Wasm i64-addressed helper loaded 41, incremented it to 42, and stored it at offset **2,147,549,184**. `high-offset-native-mmap: PASS` separately proves the native side exchanged a 4 KiB window at that offset. The default Wasm linear memory is not enlarged. Neither result measures a >2 GiB resident set or proves that WebContent's process budget was bypassed.

On a normal run, the file is reduced and removed. After a watchdog/native timeout it is intentionally retained rather than risking truncation of an in-flight mapping. If that occurs, fully close the app before clearing its storage. No automatic enormous allocation/resident-memory stress test is included.

## Performance interpretation

Compilation and first-run timings are separated from five warm arithmetic samples. Native Swift arithmetic is a same-device AOT reference only; it is not FEX's ARM64 backend. Transport reports a first exchange and warm samples, including copy/checksum/control-bridge overhead. Do not convert either microbenchmark into a claim of “70% normal JIT” or game FPS.

A real game comparison must use the same device, scene, graphics settings, frame-skip setting, resolution, thermal state, and native FEX/Wasm revisions. Record submitted/rendered/displayed frames separately. The supplied report of 200 FPS against 500–600 FPS is roughly 33–40% for that described scene, not a measured 70% result for this repository.
