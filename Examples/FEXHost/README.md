# Device correctness and timing suite

This expands the previously working FEX Host, not the SDK backend or Iridium.
The original seven-byte addition programs remain available as **Quick baseline**.
**Run full suite** includes those two checks plus compiler-generated x86-64
workloads for both SysV and Win64, memory readback, an independent Wasm/Swift
native-service test, and three new create/execute/close FEX sessions.

## Update an existing device-test checkout

Keep commit `9e5735f893b0` as the known-working addition-only source reference. On the SDK branch after
fetching this change, run from the repository root:

```sh
python3 Examples/FEXHost/prepare.py
open Examples/FEXHost/BetterJITFEXHost.xcodeproj
```

You do **not** need to rerun `Backends/FEX/build-ios.sh`, regenerate the guest
code, rebuild FEX, or reinstall Homebrew dependencies. This change adds Swift
sources to the sample, so regenerate the Xcode project once. Generation may reset
Xcode's local signing edits: select your existing team and unique bundle ID again.
Use Release and leave **Debug executable** unchecked. Native libraries and signing
entitlements are unchanged. A new checkout still needs the existing optional
native FEX package before building the sample.

The helper records the selected source revision and tracked-edit state in the
app's Info.plist; rerun it after source edits. Plain `xcodegen generate` still
works, but records revision/state as `unrecorded`. Neither route signs, installs,
uploads, fetches a dependency or requests additional entitlements.

Run **Quick baseline** first. Then close the app, launch from the Home Screen
without a debugger, and run **Run full suite**. The two condition switches record
what you did; they neither change networking nor detect an attached debugger.
As with the previous test, do not use StikDebug/LiveContainer for the standalone
baseline. Repeat with Wi-Fi and cellular disabled to check the offline condition.
Keep the app foregrounded. **Stop** or backgrounding marks the run cancelled or
interrupted. Remaining tests are not promoted to passes.

## What is tested

There are **27 named checks** in eight stages:

- Two original addition checks, one for each ABI.
- Ten compiled-C checks per ABI: wrapping and above-2^53 integer arithmetic;
  sixteen weighted arguments across registers/stack; zero and nonzero branch
  loops; nested calls/returns; guarded unaligned 31-byte and 16,401-byte memory
  operations; and two longer timed workloads.
- Wasm → native Swift → Wasm byte transformations at 64 and 4,096 bytes. This
  independently tests the registered-service bridge; it is not a FEX syscall,
  DXMT call or OPFS transport test.
- Three newly created FEX sessions, each executing and closing before the next.

Only one stage's executor is owned at a time. The native FEX configuration still
uses its existing 256-MiB Wasm memory. No huge-allocation or memory-pressure stress
probe is added. Closing a session is not proof of immediate OS memory reclamation.

The C source is `Guest/kernels.c`. `GuestImage.swift` includes its SHA-256, Clang
version/flags, code-image hashes and entry addresses. The app supplies these x86
bytes to native FEX, never recorded Wasm. Native translation-unit requests must be
observed before a FEX stage passes; internal FEX caches can still serve repeated
requests. Exact fixture bytes have also been executed directly as x86 on a hosted
Linux machine against the independent Swift oracles. That is compiler-fixture
validation, not evidence of these larger workloads working through FEX on iOS.

## Timing interpretation

Setup records native initialization, WebKit startup, and executor opening
separately. Every named check records its first call. Each longer workload then
has one correctness-checked, untimed warmup and five measured calls. Service tests
use three measured calls. Every result and any memory/guard readback must match.
No averages from failed or unchecked calls are reported as valid performance.

Call timing uses a monotonic wall clock around one SDK invocation. It includes
bridge scheduling, native translation requests/misses, JSPI waits and WebKit
execution. Input reset, readback and reference verification happen outside that
interval. These are **not** pure guest instruction timings. The first call is not
guaranteed cold: native translation caches may survive earlier stages or runs.
There is no native-FEX ARM64 comparison, FPS, 70%-of-JIT claim, resident-memory
measurement or App Store certification.

Thermal state and Low Power Mode are recorded at the start/end. Warm sampling
stops or is skipped under serious/critical thermal pressure, with an explicit
note; correctness may still pass without a complete timing series. Compare only
matching suite/source/fixture versions, device/OS, workloads and conditions.

## Reports and failures

Use **Share JSON report** after the run (including failed/cancelled runs). The
report includes source identity, OS/device class and hardware model (not device name/UDID), self-reported
conditions, per-stage capabilities and request counts, expected/actual 64-bit
results as decimal strings, all measured samples, computed medians and first errors.
It does not contain game files, signing credentials, local Mac paths or a device ID.

A checkpoint is saved before each stage/case and after completed work in
`Documents/BetterJITBenchmarks`. A previous running checkpoint is shown as
`INTERRUPTED` after relaunch, not PASS. The run-ID file preserves that run while
`latest.json` tracks the newest one. No report is uploaded automatically. Share
controls are disabled while the file is still being updated. An explicit storage
error means the checkpoint could not be persisted; keep the on-screen error.

An execution/memory failure stops the current stage and marks remaining checks in
that session skipped. Independent later stages get a fresh executor. The full run
is PASS only when every stage/check passed; failures, skipped checks and partial
runs remain distinguishable. Native compiler calls cannot be forcibly interrupted
mid-function; Stop requests cancellation and closes the guest session cooperatively.

## Maintainer checks

```sh
bash scripts/check-fexhost.sh
# Optional reproducibility check with the recorded LLVM 17 toolchain:
python3 Examples/FEXHost/Guest/build.py --check
```

The portable runner tests use fixture executors and do not claim Apple execution.
The direct-x86 test uses executable mappings **only on an x86-64 Linux test host**;
the iOS app does not use them. Clang/LLD regeneration rejects additional allocated
sections and unresolved relocations. Normal device builds need neither tool.
The Apple UI/adapter still requires Xcode compilation and this suite requires a
new physical-device run. The old addition-only device success is not reused as
validation of the expanded suite.


## Linux / Wine mode

The app now includes the promoted `BetterJITLinux` runtime. **Run Linux ELF**
uses a bundled x86-64 static ELF and needs no external root. **Run Wine cmd**
uses `Documents/linuxroot` and becomes available when
`Documents/linuxroot/opt/wine/bin/wine` exists.

This path uses the real browser Linux kernel/VFS/thread runtime and dynamic
native FEX code mapping. It currently selects the correctness-first HTTP
fallback for kernel/translator file operations; the ordinary BetterJIT binary
service lane remains the validated fast native/WebKit data plane.
