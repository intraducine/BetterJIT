# BetterJIT Device Session

Install **BetterJIT Session** once with your existing iPhone signing/install route.
The GitHub artifact contains an **unsigned** device-arm64 IPA; it requires signing
before iOS will install it. No signing credentials are collected by this workflow.

1. Launch from the Home Screen. Keep the app in the foreground.
2. Tap **Run All**. Expand a phase to see its live guest log and individual checks.
3. When finished, tap **Share session report** once. That JSON includes every
   phase, guest log, nested case, sample, capability and exact source identity.

The bundled Linux programs need no download or external root. The first must print
`BetterJIT Linux OK` and exit 0. The larger static ELF reads exact file bytes,
checks mmap/mprotect/munmap return values and mapped readback (not a write-fault test),
queries the clock and random bytes, clones a guest thread and uses shared state
and a futex wake (the parent may observe the value before waiting) before printing
`BetterJIT Linux services OK` and exiting 0. Each Linux success also requires
observed native FEX code mapping and translation-unit requests.

Wine is attempted as `/opt/wine/bin/wine cmd /c ver`. Missing Wine inputs produce
UNSUPPORTED. A present but broken root, failed exit, missing Windows version,
trap or timeout produces FAIL. **Choose staged Wine root folder** can replace the bundled candidate with your
existing redistributable root without rebuilding the app. Alternatively copy it
into the app's `Documents/linuxroot` using Files/Finder. Stage inputs with
`scripts/stage-linux-runtime.py --strict` first; the selected folder must contain
`opt/wine/bin/wine` and preserve `.symlinks.json` / `.modes.json`. The cloud workflow prepares and bundles a stock Alpine Wine candidate automatically.
A source build can do the same with `python3 scripts/prepare-wine-root.py` before
project generation; Docker with Linux/amd64 support and Alpine repository access
are required. The base image digest and Wine version are fixed; dependency versions,
image digest, package license identifiers and root hash are recorded in the root
provenance. This is input preparation, not FEX/Wine compatibility evidence. It does
not include the historical custom Wine/wasmdrv or DXMT patches. No commercial games
or credentials are bundled. If root preparation is blocked, the app can still be
built without that optional resource and run all available checks; Wine then needs
an existing staged root or reports UNSUPPORTED. The import replaces the old root
only after copying completes; it can be cancelled.

Run All runs the complete existing extended suite in copied and mapped-required
modes: SysV/Win64 integer/stack ABI, SIMD, guarded memory, real FEX-to-Wasm,
automatic hot-region installation, native-service calls, lifecycle and checked
calibrated timing. The safe diagnostic matrix adds binary transport, OPFS,
linear memory, software paging, shared workers, Atomics, module cloning, native
threads, VM and filesystem checks. The Metal check renders a fullscreen triangle
and verifies all 4096 pixels after GPU readback. This is host GPU execution;
DXMT resource/command integration and guest game rendering remain UNSUPPORTED.
Linux's optional native channels may fall back to HTTP; the report records
observed attachment and successful native-channel reply counts. The channel
phase is UNSUPPORTED if both xlat and kernel native requests were not observed,
even when the Linux guest passed through HTTP fallback. The combined matrix omits
the separate Wine-readiness placeholder because the Wine phase supplies execution
evidence; DXMT readiness remains independently unsupported.

**Stop** closes the current guest/session and saves partial evidence. Backgrounding
marks the session interrupted. Relaunching recovers its last atomic checkpoint;
**Resume unfinished** creates a new report and retries only unfinished phases.
Completed phases are retained with their original timestamps. An unfinished phase
restarts from its beginning, including Wine's guest side effects. Older run-ID
reports stay in `Documents/BetterJITSessions`. A source build may contain previous
`BetterJITBenchmarks` reports; those historical files are left untouched.

Each phase has a host deadline (40/50/110 seconds for Linux/Wine, 480 seconds for
each full suite/matrix). SDK requests have their own limits. Native FEX compiler
calls cannot be forcibly interrupted in the middle of a native function. Teardown
must finish before a new session can start. Stress probes are off by default;
enabling them may terminate WebContent and will be recorded as incomplete/failure.
The aggregate says PARTIAL if any integration is unsupported, FAIL for failures,
and PASS only when every phase passes. Transport timings are not game speed.

## Source build

From a Mac checkout of this branch:

```sh
bash Backends/FEX/build-ios.sh # only if the local native package is absent
python3 Examples/FEXHost/prepare.py
open Examples/FEXHost/BetterJITFEXHost.xcodeproj
```

Use your existing team/unique bundle ID, Release, and Debug executable OFF. Existing
native FEX builds can be reused. GitHub's **One iPhone device session** workflow
builds the app and uploads `BetterJIT-Device-Session-<exact SHA>` with the unsigned
IPA, build logs, file hashes and these instructions. Compilation and direct native
x86 fixture checks are separate evidence from real execution on an iPhone.

## Current cloud build blockers (2026-10-11)

Run `38178983059` failed before any steps executed, in both attempts. GitHub exposed
no job log or artifacts. The connector rejects the annotations endpoint; the
environment's authenticated `gh api` returns Forbidden for it. The runner cause
is therefore unavailable; billing is not inferred. No Apple compile/device result
or IPA is claimed. The saved execution environment remains connected.

The official Alpine base image downloaded successfully, at pinned digest
`sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412`.
Wine package preparation then failed because the environment denied access to the
Alpine v3.22 main/community APK indexes (HTTPS CONNECT 403; APK Permission denied).
No Wine root or compatibility result was produced here. The preparation recipe
and automatic bundling route are checked in for execution where those downloads
and the GitHub Apple runner are available.
