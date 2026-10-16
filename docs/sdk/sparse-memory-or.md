# Bounded non-LOCK OR memory

Coverage 16 adds `09 /r`, `OR r/m32,r32` and `OR r/m64,r64`, with one
optional REX prefix. Operation 16 has width four or eight and constant
fallthrough. Memory/checkpoint/step ABIs remain 1/1/3, headers stay 96 bytes,
and internal memory stays fixed at 33 pages. LOCK, REP, segment/address-size/
operand-size prefixes, repeated REX, byte/word operands and immediate OR remain
outside this slice. Existing register-only OR retains its earlier profile.

This addresses the exact `48 09 74 24 88`, `OR qword ptr [RSP-0x78],RSI`,
boundary at `0x7f0000037fbc` from green commit `953c78a` / run
[38903003596](https://github.com/intraducine/BetterJIT/actions/runs/38903003596).
The retained, same-input adapted Wine/musl probe reached 2,103 Wasm executions
from 235 compiled units and stopped unsupported with no guest exit. These OR
host fixtures establish no subsequent Wine boundary. Earlier phone and dense
Wine memory-limit evidence is unchanged.

Raw admission and JS independently decode complete ModRM/SIB/displacement
lengths and the source GPR. The known pinned-FEX discrepancy for
`mod=0, SIB.base=5, REX.B=1` stays explicitly refused, as documented in
[register-destination memory ADD](sparse-register-memory-add.md). No vendor
decoder change is included. RIP-relative ModRM with REX.B remains supported.

The complete ordered IR proof is specific to logical flags: one scalar load,
`Or(old memory, old source)`, AF invalidation, `SubWithFlags(OR result,0)`,
same-address store of the OR result, `StorePF` of the flag producer, and exact
constant fallthrough. SUB against zero sets the five defined logical flags:
CF and OF clear, with PF/ZF/SF from the width-truncated result. AF is undefined;
the current invalidation emitter leaves its raw storage unchanged. Arithmetic
ADD/AF/carry-inversion patterns, extra flag producers, GPR/context stores and
unknown effects are refused. Address trees must be ready before their effects;
regenerated store addresses must be structurally equivalent to the load.

BEGIN owns the original CPU checkpoint and derives the old source and wrapped
64-bit effective address from byte-derived operands. The request must match
that address, complete source value, width, READ|WRITE intent, opcode, RIP and
checkpoint. Source/base/index/RSP aliases therefore retain their old values.

The existing transactional ADD infrastructure stages every required COW page,
validates the complete read/write range, rechecks owner/checkpoint after trusted
allocator callbacks, computes the modulo-width OR and commits without callbacks.
It returns the old memory value. The original FEX logical nodes then compute
flags; only the proven linked memory store is suppressed. No-change or zero-
source OR still requires both read and write permission. Dword OR preserves
adjacent upper memory bytes and every GPR, including source upper bits.

FINISH checks exact fallthrough, broker-owned old data, PF raw, all GPRs, AF raw,
lazy padding, rounding mode and every other CPU byte. The precise NZCV word and
lazy operands may retain the existing flag representation; the complete IR proof,
native oracle and live flag consumers verify their meaning. Fault/refusal exits
restore the complete CPU/lazy/round checkpoint only after Wasm unwinds. Typed
range, mapping, permission or allocation failures publish no memory changes and
release staged pages. Owner retirement, slot reuse or backing revision changes
during preparation fail before commit. A later successful-state invariant failure
is fatal; it does not promise rollback of an already committed memory operation.

Unaligned and cross-page operands are supported. This synchronous authority
transaction adds no guest LOCK ordering, atomic alignment rule, or expansion of
the existing atomic opcode contract.

Validation combines fresh Linux x86 result/defined-flag rows with retained
oracle rows for other hosts, actual FEX/Wasm source/address aliases and all GPRs,
live branch consumers, cross-page private/shared/COW effects, allocation and
permission failures, forged requests and dynamic ELF/kernel/worker fixtures.
The separate `sparse-memory-or-ir` diagnostic mutates copies of actual FEX IR
and is a required hashed host-build output. CI runs both new diagnostics and
retains their reports; the Wine input cache recipe is unchanged. SDK exports
include all focused sources and are validated outside the checkout.
