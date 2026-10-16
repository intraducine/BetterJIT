# Sparse architectural NOPs

Coverage 10 admits the architectural `90` and `0F 1F /0` NOP families through
actual single-instruction FEX IR. Memory/checkpoint/step ABIs remain 1/1/3,
the header remains 96 bytes, and internal memory remains 33 pages. Both native
and JS coverage versions must match exactly.

The bounded prefix grammar accepts any sequence of operand-size (`66`),
address-size (`67`) and segment (`26/2E/36/3E/64/65`) prefixes, followed by at
most one REX prefix. Repeated legacy prefixes are permitted within the x86
15-byte instruction limit. A legacy prefix following REX, multiple REX prefixes,
LOCK and REP/REPNE remain outside this slice. In particular, `F3 90` is PAUSE
and is refused. For `90`, REX.B must be zero: `41 90` exchanges EAX with R8D,
and `49 90` exchanges RAX with R8. Neither is a NOP. Plain `90` preserves the
upper half of RAX, including without REX.W.

`0F 1F /0` accepts register and memory ModRM forms, SIB and displacement bytes,
operand/address-size prefixes and all REX bits. ModRM extension bits must be
zero. Neighboring `0F 19` through `0F 1E` encodings remain outside this NOP
addition even though the pinned FEX dispatcher treats some as NOPs; the existing
exact ENDBR64 admission is unchanged. No ModRM operand is accessed: an unmapped,
inaccessible or noncanonical effective address causes no load, store or memory
RPC. Segment bases and address arithmetic are not needed.

Admission computes the complete encoding length independently and checks it
against FEX's decoded length. Truncated prefixes, ModRM, SIB and displacement
fields, and instructions longer than 15 bytes, cannot produce a runnable unit.
Trailing bytes belong to the next instruction. The backend requires actual
FEX IR containing only structural/instruction markers, constants and one
constant fallthrough exit. It refuses even otherwise-supported GPR loads or
stores, flag operations, arithmetic, memory effects, syscalls and branches for
this family. NOPs are not replaced with a synthetic Wasm shortcut.

The native Linux x86-64 oracle tests 1,490 encodings over four register-value
sets, six arithmetic-flag seeds and both DF states: 71,520 executions. Its
assembly trampoline compares all sixteen GPRs, including arbitrary RSP, and
complete RFLAGS. The retained receipt fingerprints every encoding. On other
hosts, the FEX/Wasm test explicitly reports the native oracle unavailable and
checks that retained receipt while compiling fresh modules.

The actual FEX/Wasm matrix checks 35,832 NOP steps, all CPU bytes except RIP,
lazy flag and rounding state, native arithmetic flags including AF, zero guest
mappings, zero guest backing and zero memory RPCs. It includes every ModRM
mode, every SIB combination, all REX bits, the exact eleven-byte Wine encoding,
legal 15-byte forms and trailing-instruction boundaries. It also checks 2,653
distinct truncation, overlength and excluded-encoding refusals.

`--synthetic-nops` runs six NOPs inside the synthetic ELF interpreter's nested
CALL/RET and accumulator-extension control. It must reach UD2 after 19 Wasm
steps with four checked stack RPCs, original RSP, RAX `ffffffffffffff80` and
RDX `ffffffffffffffff`. These host fixtures do not establish Wine compatibility,
WebKit execution, physical worker retirement or phone memory usage.

The last real prepared Wine/musl probe at `35daab3` executed nine steps, with
guest exit null, before refusing `66 66 2e 0f 1f 84 00 00 00 00 00` at
`0x7f00000364ce`. That result comes from the independently retrieved CI artifact
for [run 38858773685](https://github.com/intraducine/BetterJIT/actions/runs/38858773685),
not this synthetic control. The launcher SHA-256 was
`9041d16b7c1efba02ac968655fa547d6d9c91e4a38705bba553e630bf09852ad`
and musl interpreter SHA-256 was
`1cc5c3f502179e2a4befae29658fb109102effefc75742893aa4a449fd3fbb03`.
This addition needs a new probe of those retained inputs to establish the next
real boundary; no full Wine execution or JIT replacement is claimed.
