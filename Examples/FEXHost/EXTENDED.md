# Extended device suite (v2)

This adds an opt-in **Run extended suite (SIMD / regions / long timings)** button.
The original Quick baseline and 27-check Full suite remain unchanged, including
all scalar x86 fixture bytes. The extended mode runs those checks plus 16 new
checks: **43 total in 16 stages**. Do not treat the earlier scalar device PASS as
validation of these new workloads.

## Install the source update

Apply the supplied patch to a checkout of the reviewed `feature/runtime-sdk`
base `21b30fc7973d998f0196c6dbf625128fc76351c8`. `git apply --check` must succeed
before applying it. This is a source-only change, not a new native FEX build.

From the repository root after applying the patch:

```sh
python3 Examples/FEXHost/prepare.py
open Examples/FEXHost/BetterJITFEXHost.xcodeproj
```

The project now explicitly generates the **BetterJITFEXHost** application scheme
with Release and debugger disabled. Choose it instead of the CFEXWasm library.
Check your personal signing team and unique test-app bundle ID again after
regeneration; existing local project signing edits may be reset. App version/build
are now explicitly recorded as 0.3.0/3. No new entitlements are requested. The
previously built `.build/FEXNativePackage` is reused; do not rebuild it for this
patch. The new guest images are included as generated Swift bytes, so a normal
Mac build does not need LLVM/LLD or fixture regeneration.

An uncommitted patch is correctly reported as tracked source changes at project
generation, with the base source revision. The report's `device-suite-v2` identity
and additional fixture hashes distinguish it from the old v1 report. For your
own repeatable source reference, commit local edits before regenerating the
project. No script commits or pushes these edits automatically.

Run Quick baseline first, then Extended from the Home Screen without the debugger,
StikDebug or LiveContainer. Keep the app foregrounded. Repeat offline as before.
The condition switches record your statements; they do not detect or change those
conditions. Share the JSON even if some checks fail. A thermal limit or stop leaves
an explicit partial report, not a manufactured pass.

## SIMD correctness

Four new correctness fixtures run under **both SysV and Win64**. They exercise
unaligned packed-word operations (wrapping add, shifts, shuffle/rotate), signed
word-to-unsigned-byte saturation and unsigned-byte addition saturation, packed
Float32 arithmetic/comparison masks, and packed Float64 arithmetic/comparison
masks. Complete prefix, payload and suffix bytes are compared against independent
Swift expectations. Floating-point fixtures deliberately use exactly representable
finite values; they do not establish NaN behavior, arbitrary rounding modes, x87,
AVX or full SSE instruction coverage.

`Guest/extended.c` and `Guest/build-extended.py` produce the new self-contained
x86 images. Text and read-only constants share one image; other allocated sections
and unresolved relocations are rejected. `ExtendedGuest.swift` records source and
image SHA-256 values, compiler identity and flags. The bundled bytes have been
executed directly on an x86-64 Linux test host, including guard-byte checks and
randomized integer/saturation inputs. This validates fixture bytes/oracles, **not
FEX's translation of those SIMD instructions on iOS**.

## Calibrated timings

Six workloads (branching, nested calls, packed 32-bit recurrence, for each ABI)
adapt their iteration counts toward **200 ms**, accepting a **100–500 ms** window.
Every probe is correctness-checked. There are at most ten probes, a six-second
calibration budget checked between calls, and an absolute 128,000,000-iteration
ceiling. Growth/shrink factors are bounded. Each selected workload size is then
frozen for five checked measured calls; sizes do not change between those samples.

First-call, probe and final-series results remain separate. Initial iteration
count and first expected/actual values are retained even when calibration changes
the final expected checksum. SIMD recurrence expectations use a scalar affine
exponentiation oracle, not the vector instruction sequence. The scalar references
run outside the invocation timer. Large scalar references still consume real CPU
time/energy; that can affect thermal conditions and is not ignored in interpretation.

A valid comparable timing series needs five in-window samples and no thermal stop,
including a thermal transition after the last sample. Otherwise raw timings are
retained, `windowSatisfied` is false and a comparison median is suppressed. A
correctness PASS does not imply `calibratedTimingStatus: COMPLETE`. Calibration
limits on an especially slow/fast device are reported as timing limitations,
not wrong-answer failures. These budgets are checked between SDK calls, not a
promise to forcibly interrupt an in-flight native C call; the existing execution
deadline still applies.

These remain end-to-end invocation wall times: bridge scheduling, translation
misses, WebKit and JSPI waits are included. Input/reset/readback and verification
are outside the measured interval. First call is not guaranteed cold because
native FEX caches may survive stages. There is **no normal-FEX ARM64 denominator,
FPS score, percent-of-JIT claim, OPFS fast transport or resident-memory test**.

## Region evidence, not just requests

The new worker advertises additive `fex.runtimeStatistics`. A statistics reply
includes an immutable snapshot of units, installed regions, installed region
entries and cache flushes; ordinary module metrics are unchanged. No new native
library API or fabricated profile is used.

A separate fresh session repeatedly invokes one existing scalar root to drive
actual hot-entry profiling. Up to 512 correctness-checked priming calls or ten
seconds (checked between calls) are allowed. A successful region check requires:

1. A native region request and exactly one installed region/entry for exactly one
   translated unit, without cache flushes.
2. Two additional checksum-correct calls to the same root after installation.
3. No new translation requests or flushes during those final calls.

The single-unit constraint permits attribution to the installed region without
instrumenting every guest instruction. It is not an instruction counter, an
optimization speedup measurement, or proof of multi-unit region coverage. A region
request alone is insufficient. Multiple units, absent runtime statistics, failed
promotion or state changes produce an explicit coverage failure; later independent
stages still get a new executor. No claim is made that this path is device-verified
until a new report demonstrates it.

## Maintainer checks

```sh
bash scripts/check-fexhost.sh
python3 Examples/FEXHost/Guest/build-extended.py --check
```

The generator reproducibility check requires the recorded LLVM 17 compiler and
LLD. The checked images contain packed SSE2 instructions; normal device builds do
not need these tools. Portable tests cover calibration bounds, timing drift and
thermal transitions, cancellation, failed/partial reports, request-only region
false positives, multiple-unit and cache-flush rejection, and old report decoding.
Worker tests use the actual worker routing with a **fixture engine**, not native
FEX. Executable test mappings occur only in the Linux direct-x86 fixture checker,
never in the iOS app. Apple UI syntax checks are not Apple SDK compilation or a
physical-device run.
