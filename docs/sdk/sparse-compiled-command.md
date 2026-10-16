# Compiled C command and first phone route

The convergence target is a small, useful command: `rot13 TEXT` transforms ASCII
letters in one argument, preserves other UTF-8 bytes, writes a newline to stdout,
and reports usage/length errors on stderr. It is freestanding C compiled by an
ordinary Linux GCC and linker, with no libc. The only assembly is Linux syscall
wrappers and a three-instruction entry shim that passes the original process
stack to C and reserves eight bytes for System V callee stack alignment. The C
entry never returns; its reserved return-address slot is not read.
Neither the x86 instruction stream nor ELF headers are edited after compilation.
This is compiled application logic, rather than a hand-authored instruction plan.
The source, complete build flags, compiler version, source hash and ELF hash are
retained in `Examples/FEXHost/Guest/sparse-rot13.{c,json}`.

## What blocked the preceding static ELF path

The GCC output at the preceding implementation boundary failed in four concrete
places. GNU ld emitted a zero-file-size BSS PT_LOAD starting at offset 0x40 within
a distinct page; the loader required page-aligned virtual addresses. Its loop
used LEA, byte TEST/CMP, immediate/register arithmetic, unsigned JA and CMOVA;
raw admission stopped these instructions. A memory CMP needs one authenticated
read plus flag updates, a different effect from a plain MOV read. Finally,
write(1) and inherited stdout/stderr were absent. The changed loader admits the
zero-fill BSS case while retaining alignment restrictions for file-backed loads;
readable distinct R/RW/RX pages, W+X refusal and rollback bounds still apply.

Native memory/checkpoint versions remain 1/1, step remains 3 with a 96-byte header,
and **coverage is now 8**, including the later finite-stdin/sign-branch,
[immediate AND](sparse-linux-bootstrap.md) and [checked CALL/RET](sparse-call-return.md) increments.
The added family `READ_FLAGS=8` accepts exactly one
READ RPC and flag updates; it cannot write, perform RMW, branch or call a syscall.
The complete IR effect checks still precede emission. Arithmetic remains
register-only; standalone stack PUSH/POP, indirect control flow, signed relational/parity/
overflow branches, SIMD, 16-bit flag arithmetic and general ISA coverage remain
unsupported. New register arithmetic/byte flags/memory comparisons and all six
unsigned/equality branch conditions, plus short/near JS/JNS sign branches, are
checked against 104 independently executed native x86 rows, producing 1,040
FEX/Wasm branch/flag comparisons.
The previous 64 branch comparisons, memory faults and lifecycle fixtures remain
separate regressions.

The fresh Ubuntu GCC 13 output also contains GNU property metadata and `ENDBR64`
at its C entry. The first Apple CI run refused the metadata before target startup;
the isolated marker was also outside admission. Rebuilding with that exact
compiler locally reproduced the identical ELF hash and failure. The loader now
accepts only one aligned 32-byte GNU `FEATURE_1_AND` IBT/SHSTK compatibility note
and its optional PT_NOTE/PT_GNU_PROPERTY alias, contained in the same read-only
file-backed load. It checks the note framing, property size, feature mask,
padding and alias identity before any image allocation. Unknown/required
properties, duplicate/distinct notes and malformed framing remain refused.
[Linux's CET application-enabling documentation](https://github.com/torvalds/linux/blob/v6.12/Documentation/arch/x86/shstk.rst)
distinguishes this compatibility marker from explicit userspace enablement;
the sparse profile never enables CET and refuses its enabling syscalls.
The instruction profile now admits only the
exact `f3 0f 1e fa` marker with legacy no-op semantics; CET is not enabled or
advertised, and indirect branches remain unsupported. FEX still decodes it and
checks the complete IR effects. A live step verifies full CPU, lazy flags and
rounding state preservation, no guest-memory RPC and RIP+4; ENDBR32, truncated,
wrong-prefix and extra-prefix forms still refuse. This follows
[Intel's backward-compatible ENDBR semantics](https://edc.intel.com/content/www/us/en/design/ipla/software-development-platforms/client/platforms/alder-lake-desktop/12th-generation-intel-core-processors-datasheet-volume-1-of-2/010/indirect-branch-tracking/),
not an emulation of CET enforcement. The compiler payload and recipe remain
unaltered; no compiler flag suppresses the marker to make validation pass.

Host lifecycle capability 4 adds bounded write(1) and actual stdout/stderr file
descriptions in the process descriptor table. Only descriptors 1 and 2 of this
owned kind are admitted across fork/exec; their references inherit and release
at process exit or cancelled fork. Other descriptors and CLOEXEC remain outside
this profile. Every write first copies at most 64 KiB through authenticated
full-pointer copyin, then calls a synchronous host output sink with owned bytes.
Pointer faults and EBADF occur before sink effects; zero-length and short writes
have explicit results. Oversized requests restore pre-SYSCALL state with typed
UNSUPPORTED. A broken host acceptance contract is fatal, never a fabricated
successful write or errno rollback after an output effect. There is no open,
seek, ioctl, general FD inheritance or terminal model. The subsequent
[finite captured-stdin profile](sparse-stdin.md) adds owned descriptor 0 and
bounded read(0) without changing the dbef9e78 phone-test baseline artifact.

## Completed host use case

The initial host-created bootstrap forks. Guest code execs the GCC ELF by its
path, the compiled C loop reads argv and writes its output, and the parent waits
for the real guest status. Five cases match native Linux execution: ordinary
text, empty input, ASCII boundaries plus UTF-8, missing argument, and an argument
longer than 255 bytes. They execute 389/47/283/37/4124 FEX/Wasm steps with target
exit codes 0/0/0/64/65. Standard-output descriptions survive actual guest fork and
exec. All worker/native owners drain before reaping/backing release on this Node
route. The default fixtures remain in the source tree, but the target program
has no preselected target instruction list. Its units translate at the running
RIP; a bounded immutable-code cache holds at most 128 units/1 MiB of generated
code to execute loops without recompiling every iteration.

Rebuild with an ordinary compiler, independently run its native oracle, and run
that exact fresh output through FEX:

```
python3 Examples/FEXHost/Guest/build-sparse-rot13.py --output /tmp/rot13.json --native-check
node tests/sdk/linux-host/sparse-compiled.cjs /path/to/fexserve /tmp/compiled.json /tmp/rot13.json
node tests/sdk/linux-host/sparse-alu.cjs /path/to/fexserve /tmp/alu.json
```

The Linux CI job builds a fresh compiler output and transfers it to Apple, where
both the recorded GCC payload and that fresh output execute through live FEX.
Apple does not claim direct native Linux execution. The compiler/ISA profile is
still bounded: different optimizations, compiler versions, libc, musl/BusyBox,
dynamic linking and larger ordinary applications may require further work.

## Existing single phone app

The app previously had no sparse page or kernel/thread provisioning path, and
its Swift backend exposed only the low-32-bit direct-unit endpoint. It also
always configured the direct-unit disk cache, which native broker mode explicitly
rejects, and the app gated all Linux phases on JSPI. These are distinct from the
compiled program's instruction and I/O gaps.

`LinuxRuntimeConfiguration.executionProfile = .sparseStatic` now selects an
explicit single-process sparse page. `FEXProcess` selects broker native options
without the incompatible direct-unit disk cache. The Swift protocol, loopback
server and native adapter expose `/xlat/step` using UInt64 RIPs. Legacy backend
implementations retain a default unsupported method rather than a truncating
fallback. The native adapter refuses translator recreation after close, including
requests queued during server shutdown. The direct profile remains the default.
Use captured stdio, set regions/native channels/tracing/display off and use cwd `/` for this profile;
unsupported legacy options fail explicitly.

Run All includes **Compiled C: ROT13 text command** using the bundled compiler
payload, the same checked ELF/stack loader, full-width FEX steps, shared storage,
captured streams and normal exit. It checks `Uryyb, OrggreWVG 2026!\n`, empty
stderr, exit 0 and actual native step/code-map counters. JSPI is not required;
shared WebAssembly memory, isolated workers and Atomics.wait are required.
Missing capabilities produce UNSUPPORTED, not a direct-runtime/replay fallback.

This first browser route deliberately accepts only write and normal exit.
**Browser fork/exec/futex/reaping/worker-retirement acknowledgement remain
unsupported.** Worker.terminate() has no awaitable completion here. On normal
exit the guest has fully unwound, its broker owner unregisters, but occupancy,
guest backing, internal context, module cache and native catalogue are retained
until whole-session teardown. No fake W_OCCUPIED acknowledgement, namespace drop,
backing reuse, physical worker termination or resident-RAM saving is claimed.
The report records that retention and the fixed 33-page internal context. Abrupt
session teardown cancels owned workers/requests and closes the locked native
backend; it does not generate a completed guest/reaping result.

The same production page runs the five original cases and an additional BOM
argument regression in real Chromium with live FEX,
and CI invokes an opt-in real macOS WKWebView test after the host translator is
built. That test uses the production Swift session/server/resources and live
native FEX through a test-only HTTP backend. The linked device backend is compiled
in the complete unsigned app; this is not a physical phone run. Missing shared
memory is explicitly skipped on the Apple host, while an unsupported target
instruction or wrong output fails validation.

```
python3 tests/sdk/sparse-browser.py --translator /path/to/fexserve --output /tmp/browser.json
BETTERJIT_SPARSE_FEXSERVE=/path/to/fexserve swift test -j 2 --filter SparseWebKitHostTests
```

The next phone-testable goal is to use the existing signing/install route for the
CI app and run its compiled C phase, retaining the exact source revision, ELF
hash, stdout/stderr, native counters, and retention policy in the local session
report. Cloud CI/Chromium/macOS results do not establish phone compatibility or
RAM use. A later browser fork/exec goal still needs a supported worker-retirement
contract before it can release/reuse backing. General/stock Wine, DXMT and device
behavior remain outside the evidence from this command.
