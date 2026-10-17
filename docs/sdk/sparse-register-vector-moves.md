# Register vector movement

Coverage 28 adds legacy register MOVD/MOVQ between GPRs and XMMs, MOVAPS/MOVUPS,
MOVAPD/MOVUPD, MOVDQA/MOVDQU, XMM MOVQ, and register MOVSS/MOVSD. Both opcode
directions are admitted. A single mandatory prefix (`66`, `F2` or `F3`, as
required by the opcode) precedes at most one REX. REX.R/B select the full set
of sixteen registers; REX.X and irrelevant REX.W bits are accepted aliases.
REX.W selects 64-bit rather than 32-bit GPR movement. MMX, memory operands,
LOCK, segment/address-size prefixes, repeated/reordered prefixes, VEX/EVEX,
and vector arithmetic remain outside this profile.

The wire operation remains 6 with width zero; there is no guest data-memory
RPC. Memory/checkpoint/step ABI versions remain 1/1/4. The existing full CPU
checkpoint now advertises an optional `cpu.xmmRegisters` descriptor:

```json
{"version":1,"offset":512,"stride":16,"count":16,"bytes":16}
```

The example offset is illustrative; consumers use the native configuration's
actual `offsetof(CPUState, xmm)`, also exposed as `xmmOff`. This descriptor
names sixteen packed 128-bit SSE slots, never 32-byte AVX-interleaved slots.
The physical CPU/lazy/rounding spans do not change. Vector BEGIN requires the
descriptor; scalar-only checkpoints may omit it. Registration validates its
version, exact stride/count/slot size, alignment, bounds and disjointness from
RIP, GPRs, stack pointer and supplied flag fields. It owns a frozen copy.
FEX's separate `avx_high` area and unused XMM union padding are covered by the
full CPU snapshot and must remain byte-identical.

MOVD to XMM clears its upper 96 bits; MOVQ from GPR or XMM clears the upper 64
bits of its XMM destination. MOVD to a GPR zero-extends its 32-bit result.
Full copies preserve all 128 source bits. Register MOVSS replaces only the low
32 bits and register MOVSD only the low 64 bits of the old destination. Every
move preserves the complete flags representation, lazy-state padding, rounding,
other GPRs and vectors, and AVX upper halves. Same-slot copies may be optimized
to an effect-free fallthrough; same-slot MOVQ must still clear its upper half.

The backend's dedicated proof binds exact FPR/GPR classes, source/destination
slots, load and store widths, vector operation and element width, extract and
insert indices, old destination for merges, use order and sole constant exit.
Only after that proof may these FPR/vector nodes enter the broker allowlist.
Existing emitters are reused. Unrelated effects, memory/context operations,
flag writes, changed lanes, or incompatible scalar profiles are rejected.
FINISH computes the expected complete checkpoint from the broker's BEGIN
snapshot. Only RIP and the decoded destination bytes may differ. Unsupported
completion restores every owned span; a forged memory RPC publishes no data.

The compact case description generates literal native x86 instructions for
all movement forms. Retained hardware rows include zeros, all ones, signed
boundaries, arbitrary floating-point bit patterns and varied incoming flags.
The actual pinned FEX/Wasm matrix covers every register/REX/opcode alias,
including same-slot and high-register cases. Copied actual IR mutations check
legal alternative lane widths, dataflow, classes, indices, ordering and extra
effects. Portable broker tests check descriptor compatibility, state corruption,
rollback, metadata ownership and executable-byte derivation in the kernel.
The dynamic ELF fixture exercises the production kernel/workers and keeps its
200-step/30-second limits and exact read-fault rollback.

Run 39013453364 at `1302f92` passed CI. Its unchanged Wine trace cleared NEG
and stopped at RIP `0x7f00000412eb`, bytes `66 48 0f 6e c7` (MOVQ XMM0,RDI),
without a guest exit or recorded stdout. Synthetic tests for this batch do not
establish Wine completion or device execution. Future real probes retain the
exact launcher, musl, Wine provenance, argv/environment and execution budgets.
Runtime worker retirement remains distinct from successful later host teardown.
