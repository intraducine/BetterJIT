# Word memory-immediate compare

Coverage 25 initially admitted `66 81 /7` (`CMP r/m16,imm16`) and `66 83 /7`
(`CMP r/m16,sign-extended imm8`) with a memory operand. The instruction updates
all six arithmetic flags and writes neither the operand nor a GPR. This is a
generic instruction family; no application identity or instruction address
selects the implementation.

One operand-size prefix may precede one optional non-W REX prefix. REX.R is an
ignored opcode-group alias; REX.B/X select address registers. Ordinary 64-bit
ModRM/SIB addresses include base/index aliases, all scales, signed disp8/disp32,
RIP-relative addresses and modulo-64-bit effective-address arithmetic. The
whole instruction length includes the immediate when calculating RIP-relative
addresses. The pinned frontend's no-base SIB with REX.B remains excluded.
Register destinations, other group extensions, REX.W, repeated/reordered
prefixes, segments, address-size override, LOCK and REP remain outside this
word profile. Existing byte/dword/qword compare admission is unchanged.

Native admission independently decodes the complete address and immediate.
The backend proves the actual FEX IR's address as a modulo-64-bit linear
expression over the decoded GPRs and displacement. It requires one GPR-class
word load, word `SubNZCV`, a 32-bit parity subtraction, the immediate-dependent
AF source and a constant fallthrough. Extra reads, writes, context changes,
flag producers, GPR stores and control transfers are rejected before emission.
The raw portable diagnostic checks every imm16/imm8 bit pattern at one ordinary
address; its separate address/REX sweep uses sampled immediate boundaries.
Actual FEX IR mutation coverage is a separate, sampled matrix.

The symbolic load offset follows `Emitter::Address`: an `OP_INLINECONSTANT`
is added unscaled; `OP_CONSTANT`, both entrypoint-offset kinds and register
offsets retain `OffsetScale`. Copied frontend IR tests cover unchanged inline
offsets and compensated wrong addresses at scales 2, 4 and 8, with positive
and negative controls for every generic scaled node kind.

The wire contract stays memory/checkpoint/step ABI 1/1/4 with the 96-byte
header: operation 8, width 2, one READ RPC of width 2. The kernel rederives
operands from executable bytes. BEGIN captures the address from owned GPRs
and copies the decoded immediate; the RPC cannot redirect that read. FINISH
requires the exact pinned descriptor: lazy SUB32 with both word operands
shifted left 16 bits, an unchanged saved NZCV word, and exact PF/AF storage.
Every other CPU byte, GPR, lazy-spill padding byte and rounding byte must remain
unchanged. This profile does not permit a different materialized descriptor.

CF, PF, AF, ZF, SF and OF are all defined for CMP. The oracle compares all six
plus unchanged DF. FEX's raw PF value is the 32-bit subtraction, while raw AF
uses the loaded word or its 32-bit complement according to immediate bit 4;
these internal values are not individual architectural flag bits.

Unaligned, cross-page and read-only sources use the same checked-read route.
Unmapped, protected, write-only and range failures report the precise failing
address and restore the full checkpoint. Tests observe every still-mapped
initialized page, its frame identity, permissions and backing accounting;
deliberately unmapped pages are checked for absence. Injected byte, frame and
fault-address changes prove that the preservation checks detect corruption.
Shared and full-budget private-view reads preserve backing and aliases without
allocating COW pages. No execution/cache/backing limit is raised.

`sparse-word-compare.cjs` runs the independent native x86 oracle and generated
FEX/Wasm matrix. `linux-sparse-word-compare.test.mjs` checks broker/header/kernel
contracts and forged metadata/state. `word-compare-ir.cpp` mutates copies of
real FEX IR. The existing synthetic dynamic ELF program also checks both word
forms, normal stdout/exit and its original read-fault rollback route.

The independently inspected coverage-24 Wine/musl probe retained the same
input bytes and stopped at `0x7f00000244a3`, `66 83 78 06 00`
(`CMP word ptr [RAX+6],0`), with no guest exit. Its later host teardown drained
guest payload/cache and closed workers/native child. That teardown does not
establish an earlier runtime retirement acknowledgement. The coverage-25
synthetic checks do not establish Wine completion or device/app integration;
the next reviewed automatic probe must retain the immutable inputs and budgets.

[Coverage 26](sparse-scalar-conditions.md) extends the same exact contract to
word register/immediate, register/register and both memory/register directions.
