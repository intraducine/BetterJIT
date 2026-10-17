# Register NEG, NOT, INC and DEC

Coverage 27 adds the coherent register-unary family to the explicit sparse
profile. Memory/checkpoint/step ABI remains 1/1/4. NEG (`F6/F7 /3`), NOT
(`F6/F7 /2`), INC (`FE/FF /0`) and DEC (`FE/FF /1`) admit register ModRM only.
There is one optional `66`, followed by at most one REX. Byte forms ignore
operand size; REX.W selects qword over `66` for wide forms. REX.R/X are ignored
opcode-group aliases and REX.B selects high registers. Without REX, byte
selectors 4–7 name AH/CH/DH/BH; any REX selects the corresponding low byte.
Memory forms, LOCK, segments, address-size, REP and repeated/reordered prefixes
remain excluded. Admission is independent of application and instruction address.

All widths and aliases use operation 6, width 0 and no guest memory request.
Byte and word operations preserve every other destination bit; dword writes
zero the upper half. The backend reuses `BrokerScalarProof` for ordering,
constants and exits. Its unary proof binds the selected GPR, exact operation
and width, high-byte extraction, partial-register merge, flag operands, each
flag store and the sole constant fallthrough. An effect count alone cannot
satisfy this proof. Extra memory, context, control and unrelated-register effects
are rejected before emission. Small INC reuses the existing `AddNZCV` emitter;
only its proved unary contract enters the broker allowlist.

NEG defines CF from nonzero input and OF at the signed minimum, plus PF/AF/ZF/SF
from subtraction from zero. NOT preserves all flags and the complete lazy
representation. INC/DEC preserve the old CF while defining the other five
arithmetic flags. Their actual pinned FEX graph saves old carry before the
operation and restores it through an exact NZCV bit insertion. Small widths
materialize the updated descriptor; wide widths retain the checked carry-keeping
lazy kind. The broker computes the expected result from its BEGIN snapshot and
requires the exact allowed CPU/lazy/rounding changes at FINISH. It owns the old
carry even when the incoming representation is lazy. Unsupported completion
restores all spans; a forged memory request cannot create a unary storage effect.

The compact `sparse-unary-cases.json` describes the four operations, five width/
byte positions, flag seeds and chained producers. `generate-sparse-unary-tests.py`
generates literal native x86 instruction sequences from it; `--check` verifies
source reproducibility. Hardware supplies the retained oracle results, which
are also checked against independent architectural arithmetic. The actual FEX/
Wasm matrix covers every complete register/REX/operand-size encoding. Chained
NEG/INC, INC/DEC, DEC/INC and INC/NOT/DEC cases keep lazy flags live between steps.
Separate copied-real-IR mutations test dataflow, widths, merges, carry ownership,
ordering, profiles and extra effects. Broker controls check raw metadata,
forged state, full rollback and kernel byte-derived operands. The dynamic ELF
fixture uses the production kernel/workers and retains its original fault path.

The incremental runner selects `unary` together with neighboring F6/F7 groups,
condition consumers and the production-worker fixture. The ordinary Apple
workflow runs and retains the new driver and IR diagnostic after review.
No execution, translation, backing or worker limit is raised.

Published run 39010692724 at `1d1f53b` completed its CI gates successfully but
its unchanged real Wine input stopped at `0x7f0000041399`, `49 f7 dc` (NEG R12),
with no guest exit. It cleared the prior register-CALL boundary. This family
addresses that generic instruction; synthetic success does not establish Wine
command completion or device execution. Runtime worker retirement remains
separate from later host teardown. Future real probes must preserve the exact
Wine/musl bytes, provenance, argv/environment and existing execution budgets.
