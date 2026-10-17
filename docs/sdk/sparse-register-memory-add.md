# Checked register-destination memory-source ADD

For the current shared ADD/SUB family and semantic FINISH flag validation, see
[register-memory arithmetic](sparse-register-memory-arithmetic.md). The following
describes the original coverage-15 ADD milestone and its historical receipts.

Coverage 15 adds `ADD r32,r/m32` and `ADD r64,r/m64` with a memory source
(`03 /r`, optionally prefixed by one REX). The memory/checkpoint/step ABIs remain
1/1/3 and the header stays 96 bytes. Operation 15 has width four or eight,
fallthrough flow and zero static target. It uses the existing READ RPC; it
performs no guest-memory write or COW detachment. Memory-destination ADD remains
the separate operation 11 read/write transaction.

Raw admission and JS metadata parsing independently check the complete
ModRM/SIB/displacement length. REX.R selects the destination; REX.B/X extend
address registers. Address-size, operand-size, segment, LOCK, REP and repeated
REX prefixes remain refused, as do byte ADD and other memory arithmetic.
Register-direct ADD keeps its earlier register-only profile.

One encoding is deliberately excluded: `mod=0, SIB.base=5, REX.B=1`. Native
x86 ignores the base register for this no-base SIB, while pinned FEX
`0f8edf8f6383ae8085e0ffac511c789cdae97514` retains R13. Independent actual-IR
inspection and a native x86 probe confirmed the discrepancy. The new raw and
JS gates refuse this form; no vendor source or other instruction family changes.
RIP-relative ModRM with REX.B remains admitted and ignores that bit correctly.

The complete ordered IR proof requires exactly one checked scalar load,
`AddWithFlags(old destination, loaded memory)`, one full GPR destination store,
and the exact AF/PF/NZCV dataflow and constant fallthrough. Both widths load the
old destination as i64 and use an i64 architectural register store; 32-bit ADD
zero-extends its result. Address-tree producers precede the memory load. The
old destination load may follow memory, but precedes ADD and AF calculation.
No additional memory, architectural register, syscall or control effect is
allowed. Unknown IR never reaches a direct guest-memory emitter.

BEGIN owns the original register checkpoint and calculates the effective
address from the byte-derived base/index/scale and signed displacement.
Arithmetic wraps to 64 bits before checked storage validates the complete read
against the low 47-bit guest window. This preserves old address values even
when destination, base and index alias. RIP-relative addressing uses the next
instruction RIP. The request must match that owned address, width, access,
operation, RIP and checkpoint.

FINISH requires one successful READ and computes the destination from the
owned old register and broker-owned read result. An arbitrary ADD result,
including one written to RSP, is data; later memory accesses validate their own
addresses. Only the destination and RIP may change among architectural GPRs.
The checkpoint now supplies exact, bounded, disjoint PF-raw, AF-raw and NZCV
word offsets. PF-raw and AF-raw are checked against the owned arithmetic inputs.
The precise four-byte NZCV word and lazy flag fields may reflect the emitter's
materialized or lazy carry-inversion representation; the full native IR proof,
arithmetic oracle and subsequent flag consumer validate their semantics. Lazy
padding, rounding mode and every other CPU byte must remain unchanged.
The kernel binds the NZCV offset to the existing native NZCV address.

Read faults and typed refusals restore the complete CPU, lazy-flags and
rounding checkpoint after Wasm unwinds. Full-range validation prevents a
cross-page protection or mapping fault from partially changing state. Reads
preserve shared bytes, private-view frames, aliases and budget accounting even
when no additional page allocation is possible. Forged successful state fails
an invariant; it is never converted to a successful ADD.

Validation uses a 200-row native Linux x86 arithmetic oracle covering all six
defined arithmetic flags and both widths, including nonzero destination upper
bits. Other hosts explicitly skip fresh x86 execution and compare with the
retained oracle. Actual FEX/Wasm cases cover every destination GPR, ordinary,
SIB and RIP-relative addresses, base/index/destination aliasing, wrapped address
arithmetic, read-only/shared/private-view storage and exact fault rollback.
Mutations of copied real FEX IR exercise wrong widths, registers, classes,
operands, address ordering, flags, stores and extra effects. Broker tests cover
metadata/request/result forgery and ownership. Dynamic ELF fixtures use the
production kernel and worker for both ADD widths, upper-bit clearing and
destination/base aliasing, with writable and read-only source loads.

The incoming parent-verified run 85 at
`6c682ecd2a7b2a78784978e9bb69368f668c06ef` used the same adapted Wine launcher
and musl interpreter as run 84. It advanced from 1,747 to 1,774 executed Wasm
steps and 117 to 140 compiled units, then refused `48 03 78 20`
(`ADD RDI,qword ptr [RAX+0x20]`) at `0x7f0000038ee1`, with null guest exit.
This change's host fixtures do not establish a later Wine boundary. That needs
the reviewed commit's automatic probe. Earlier phone fork/exec/cat receipts and
dense-Wine memory-limit evidence remain unchanged; these tests do not establish
Wine completion, app compatibility, phone execution or JIT replacement.
