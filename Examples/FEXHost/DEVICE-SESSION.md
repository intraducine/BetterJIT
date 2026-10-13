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
queries the clock and random bytes, and clones a guest thread with shared state.
The assembly contains futex wait/wake paths; which calls complete depends on
scheduling (the parent may observe the value before waiting) before printing
`BetterJIT Linux services OK` and exiting 0. Each Linux success also requires
observed native FEX code mapping and translation-unit requests.

The bundled musl/BusyBox shell also copies, compares, renames, checksums and removes
256 KiB of exact bytes; traps a self-sent USR1; checks a child exit status of 7;
and sends the full input through a cat/sha256sum pipe. Every milestone marker and
the exact pipeline digest are required. This uses the same script as live host
validation and runs in the existing userspace phase without another build.

Wine is attempted as `/opt/wine/bin/wine cmd /c ver` in two independent phases.
The second uses Wine's existing `WINELOADERNOEXEC=1` loader setting with
`WINEARCH=win64` to attempt startup without its native Linux preloader. The
explicit session policy routes later Wine preloader execs to the requested real
Wine ELF too, because Wine clears the startup variable during initialization. Both
require actual Windows version output and exit 0; one failed path stays FAIL
even if the other succeeds.

Both Wine attempts include guest-instruction fault tracing in the exported phase
details and log. It records full addresses, actual Wasm addresses, segment bases
and bulk fill/copy operands and counts. `boundsConfirmed` identifies whether that
record explains the bounds trap; an unconfirmed last access is not its proved
cause. Wine uses unit translation for this trace, and its phase time includes
diagnostic overhead. The separate ABI suites still exercise hot regions.
The stock Wine 10.7 path currently requires a kernel stack above 4 GiB, outside
the Linux mapper's supported range. Its loader can continue after that allocation
fails, then trap while copying its startup context through a zero stack base.
The report keeps this as a failed execution attempt. A compatible address-space
integration or a suitable redistributable Wine build is still required.
Missing Wine inputs produce UNSUPPORTED. A present but broken root, failed exit, missing Windows version,
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
A single WebKit capability check is reused across Linux/Wine phases. Missing JSPI
or shared Wasm memory produces UNSUPPORTED; actual guest traps stay FAIL.
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

## Cloud validation

The automatic workflow produces an unsigned iPhone build with the bundled
stock Wine root. Its `BUILD-MANIFEST.json` identifies the exact source and payload
hashes. That is Apple compilation, not a device execution result. Live arm64 host runs use the promoted
SDK kernel/thread/runtime and fresh FEX-to-Wasm translation in Node workers;
their per-case stdout, errors, syscall/fetch/translation statistics and exact
source are included as `LIVE-LINUX-RESULTS.json` beside the IPA.

The first real BusyBox pipeline exposed partial-write data loss in `sendfile`:
only 64 KiB reached the pipe while the input advanced 256 KiB. The kernel now
advances by accepted bytes and bounds pipe read-ahead. Fresh Wine prefixes are
bootstrapped by the client before prestarting wineserver. These fixes do not imply
arbitrary Wine compatibility; inspect the actual Wine phase outcome. Host evidence
is distinct from Apple WebKit and physical iPhone execution.

Fork allocation failure returns ENOMEM and leaves no child or inherited file
reference behind. Under reservation pressure, the kernel can wait at most 1.5 s
for an already retired memory to finish its existing quarantine before reuse;
guest memory limits remain unchanged. This failure path is verified with an
injected allocation limit; phone workload success still requires every marker
and the exact checksum.

This cloud workspace can run portable Swift/JavaScript checks and direct native
Linux fixtures. Its Alpine APK downloads return Permission denied/HTTPS CONNECT
403, so the supported GitHub route prepares the stock root and builds on Apple.
Device results must come from an exported phone session. Successful DXMT
integration and a native-FEX speed ratio have not been established.
