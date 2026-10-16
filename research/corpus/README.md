# Pinned corpus measurement pilot

This directory measures a frozen, reviewed fixture selection. It changes no
production opcode, FEX pin, SDK API, application or device setting. The
`corpus-measurement.yml` workflow runs on pushes to
`experimental/sparse-guest-backing` when its corpus paths or workflow file change.
These paths do not match the existing automatic device-session workflow's path
filters. This launch works without a default-branch merge; GitHub's manual
dispatch requires the workflow file to exist on the default branch, where the
current probe files are absent. A reviewed push is one measurement run; do not
also dispatch the same commit.

The target is Madeira `279fd0f83170425db002fe25d6bd62f6355f497d`'s FEX gitlink,
`f59cab95659e8add0c88f0c76ec1cf483c536dbf`. `source.py` fetches this public pin
into `.build/corpus-source/fex` and checks its clean state. The normal prepared
BetterJIT FEX checkout remains on its existing production pin and patch.

`pilot.json` freezes 14 source paths and SHA256 values before execution. Twelve
mode64 fixtures cover carry/widths, extension, small shifts, XADD aliases,
branches, SSE memory/lanes and x87. BMI and guest32 fixtures exercise exclusion
gates. Feature gates precede assembly/execution; unresolved required features
are skips. This is an explicit selection, not an automatic corpus safety scan.

The Linux job assembles each eligible fixture once and runs an independent x86
oracle. Only `BITS 64` and the common load address are prepended; the source
body is unchanged. NASM listings identify the explicit HLT. The macOS job
downloads these exact bytes and oracle outcomes from the same workflow run.

The native ARM64 adapter uses an unmodified pinned FEX core, mode64, GuestWindow
off, AVX off, full x87 precision and TSO off. Host features are explicitly seeded:
Atomics/RCPC/CRC on, all other optional feature booleans off, 64-byte cache
lines and 16 synthetic Firestorm MIDRs `0x610f0230`, matching the production
translator's synthetic CPU count. This is not the runner's physical CPU count.
MAXINST/MULTIBLOCK profiles are
1/0, 500/0 and 500/1, matching the upstream corpus profile choices.

Compilation occurs with normal macOS JIT write protection disabled for the
current thread; execution occurs with it enabled. A measurement-only exit-link
callback returns through FEX's existing spilled thread-stop path after each
block, without dynamic backpatching. Unexpected runtime compilation or service
dispatch fails. A single ordinary process MAP_JIT arena supplies executable
allocations. Unavailable mapping capability is an explicit skip; the harness
does not change entitlements, signing or security settings. This adapter still
requires its first real macOS ARM64 build/execution validation.

The Wasm layer uses the existing production translator's **legacy dense file
window**, maxinst1/ABI-none/x87-80. That transport requires a 256 MiB shared
Wasm memory; it does not establish sparse broker, iOS runtime or app behavior.
The native 500-instruction profiles have no equivalent in this single-step
Wasm diagnostic. Guest code/stack addresses are identical across all layers,
above macOS PAGEZERO and within one 4 GiB guest window.
Its prepared FEX pin is `0f8edf8f6383ae8085e0ffac511c789cdae97514`, with adapter
patch SHA256 `c961a6db1fcdf3fb237ced1fc717f5917fa47e1ca2695cda197e17ebe5fc25b3`.
Result summaries distinguish this translator recipe from the fixture/native
target pin and retain the actual executable SHA256 and runtime buildID.

Every outcome retains source/binary identity, raw exit, feature/policy decisions
and declared expectations. Successful and refused Wasm states retain all 16
GPRs, 16 XMMs, eight physical x87/MM payloads, RIP, flags and FP controls/status.
Full mapped code/stack contents are hashed. Opaque FEX frame pointers are excluded.

The original frozen pilot checked RegData, exact HLT RIP and complete code/stack
hashes. Its flag reader inspected stored NZCV without the backend's pending
lazy descriptor. SHL and SHRD-suite final snapshots therefore showed stale
SF/ZF. These old Wasm receipts omit the descriptor and cannot be corrected after
the fact. Their original projection pass counts remain unchanged.

The separate `meaningful-final-state-v2` contract adds all 16 GPRs, all 16 XMMs,
MXCSR, FCW, FTW and live tagged physical x87 payloads against the matched oracle.
Empty x87 payload bytes are retained but excluded from equality. The two x87
arithmetic fixtures use FSW mask `0xBAFF`, excluding undefined C0/C2/C3; expected
final FSW is `0x3800` for fadd and `0x3000` for valid_operation. Non-x87 fixtures
use `0xFFFF` and preserve the complete seeded zero FSW, including C0/C2/C3.

`assertions.json` defines fixture-specific final flag masks independently of
the compiled native component recipe: `0xCD5` by default, `0x4C4` for SHL and
`0xCC5` for the final XOR/AND fixtures. The dormant, profile-skipped ANDN entry
uses `0xCC1` with expected masked flags `0x40`. Expected masked flags are `0x44` for SHL,
Jcc, the SHRD suite and valid_operation, and zero for the other enabled fixtures.
Reserved bit1 and preserved IF are checked separately from seed `0x202`; trap
RF and undefined bits are excluded. These final checks do not establish flags
overwritten by later instructions. Original Match metadata is retained without
claiming stock full-harness equivalence or device parity.

`flags.cjs` reproduces the existing production materializer in the reader,
without changing guest memory or backend code. Each snapshot retains raw FK,
FA, FB, stored NZCV/RFLAGS, PF/AF/DF raw values and derived NZCV. The integrity
suite compares 38,400 boundary vectors with the exact extracted production C++
function, including carry inversion, kept carry and float/NaN cases. Negative
mutations cover defined flags, seed controls, every GPR/XMM lane, FP controls,
live x87 payloads and defined FSW. Undefined flags/status, RF and empty x87
payloads are explicitly tested as exclusions. Missing descriptors and unknown
lazy kinds fail. BMI1 and guest32 remain skipped; refusals remain refusals.

Global, host/jit and CPU policy source lists are retained. The pinned classifier
does not classify macOS `arm64`, so no CPU-specific policy is silently guessed.
Completed comparisons use XFAIL/XPASS for known failures; raw execution failures
also retain the upstream expectation. Exit77 skips never become passes. Missing
execution layers become explicit untested ledgers. A failed or
refused measurement keeps the job unsuccessful while preserving other layers.

Each fixture has a five-second wall limit, output cap, 10,000-block limit and
64 KiB input limit. All child process groups are killed/reaped. Export is capped
at 8 MiB and excludes binaries. Production host assets are reused only after
the existing producer/tool/output verification. A separate cache validates the
native measurement pin, complete adapter recipe, macOS tools and binary hash;
test outcomes are always fresh. A production translator cache miss builds the
host component once, without app/Wine/device jobs or pretending to be the
existing asset producer.

`target-profiles.json` records source-defined iOS static, WOW64 and ARM64EC
presets and source hashes. Their defaults are MAXINST5000/MULTIBLOCK1 before
runtime overrides. Madeira's scripts preserve an existing CMake cache. The
installed device-effective options, probes, linked module and CPUID remain
unknown. This uncertainty does not block the explicit macOS core measurement.

Local Linux reproduction requires NASM, Node, Python and a C++ compiler for the
materializer reference test. Build the existing host translator through its
approved build script:

```sh
python3 research/corpus/source.py .build/corpus-source/fex
python3 research/corpus/test-pilot.py
python3 research/corpus/pilot.py prepare --fex .build/corpus-source/fex --nasm nasm --output .build/corpus-pilot/inputs
cc -O2 -mno-red-zone -Wall -Wextra -Werror research/corpus/native-x86.c research/corpus/native-x86.S -o .build/corpus-pilot/corpus-native-x86
python3 research/corpus/pilot.py run --inputs .build/corpus-pilot/inputs --layer oracle --executable .build/corpus-pilot/corpus-native-x86 --output .build/corpus-pilot/results/oracle.jsonl
python3 research/corpus/pilot.py run --inputs .build/corpus-pilot/inputs --layer wasm --executable .build/host-fex/fexserve --oracle .build/corpus-pilot/results/oracle.jsonl --output .build/corpus-pilot/results/wasm.jsonl
python3 research/corpus/verify-results.py .build/corpus-pilot
```

A bounded future integrity task remains for arbitrary CLI oracle ledgers: validate
oracle layer/method, unique fixture identities, state shape/digest, HLT and raw
exit before accepting them as independent references. The current loader trusts
supplied layer/status/digest fields and can accept a Wasm ledger as its own
reference. Same-run workflow artifact naming protects the current controlled
route; arbitrary CLI reference independence is not yet established.

No overall coverage percentage is defined: the legal-form denominator, full
2467-fixture corpus, native ARM64 results, dense semantic coverage and device
integration remain separate open work. Previous audited P0 receipts establish
only that their measurement batch passed.
