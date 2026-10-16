# Checked sparse register jumps

Coverage 13 adds x86-64 near `JMP r64`: `FF /4` with a register ModRM and at most
one REX prefix. REX.B selects R8–R15; REX.W is unnecessary for this 64-bit near
jump, and REX.R/X do not extend the opcode group. Memory-indirect jumps, indirect
calls, far transfers, legacy prefixes and repeated REX prefixes remain outside
this bounded profile. Existing direct CALL/RET restrictions remain in place.

Operation 12 has width zero, flow 5, a zero static target and an empty static
continuation set. The 96-byte header and memory/checkpoint/step ABIs remain
1/1/3. Native admission and JS metadata validation independently derive the
source register from the exact instruction. Static plan fields cannot override
that byte-derived source. Coverage 12 headers are rejected rather than silently
using an older authority contract.

FEX must lower the instruction to exactly one i64 GPR load and an exit using
that same SSA value with no call/return hint or auxiliary operands. A dedicated
complete IR allowlist excludes register/flag writes, memory effects, syscalls,
address arithmetic and other effects. All block, exit and effect counts still
apply. No guest pointer becomes a Wasm linear-memory address.

The checkpoint exports `cpu.generalRegistersOffset`; the kernel binds it to
`gregsOff`. The broker validates an aligned, bounded 16-register window disjoint
from RIP. BEGIN retains the target from the owned CPU snapshot, independently of
later mutable CPU or scratch bytes. The one operation-12 RPC uses EXEC access
and width zero. Its address must equal that checkpointed register value. The
broker requires a low canonical target and current private executable storage
with READ permission, excluding writable, shared and private-view executable
mappings. This RPC validates control authority; it performs no guest data load
or store and does not resolve a memory-indirect operand.

After a successful RPC, the emitter spills only its accepted target as RIP.
FINISH requires that exact broker-owned result and byte-for-byte unchanged CPU,
lazy flags and rounding state except RIP. Forged successful state, duplicate or
missing RPCs, and foreign/retired owners fail invariants. FINISH rechecks current
target authority. Revocation between RPC and FINISH returns typed UNSUPPORTED
and restores the complete pre-JMP checkpoint after Wasm unwinds. Both the kernel
mailbox and worker loop propagate that downgrade; a restored jump is not retried
as a successful step.

The target-address check covers one byte, not the next complete instruction.
After a completed jump, every target unit still passes the kernel's full-length
private executable snapshot comparison at BEGIN, including cached Wasm and after
an asynchronous unit fetch. Changed bytes or revoked execution authority fail
before that unit executes. A compatible private RX remapping with identical
instruction bytes can reuse the cached translation. A failure at this later
admission leaves RIP at the already completed target; it does not roll back the
prior jump. Dropping a drained native namespace clears its cached units and
prevents numeric or string/BigInt aliases from restarting it through the host.

Validation includes a native Linux x86-64 local-label oracle for all 16 GPRs and
four arithmetic-flag seeds, checked against fresh FEX-generated Wasm on every
host. On non-x86 hosts the retained oracle is used and fresh native x86 execution
is explicitly skipped. The Wasm matrix covers 72 encodings, 1,152 valid jumps,
unaligned/page-edge targets, full state preservation, forged requests and
mapping/revocation failures. Copied real FEX IR is also mutated to test malformed
source, width, class, SSA, hint, auxiliary operands, profile and unknown effects.
The dynamic ELF kernel/worker fixtures test a successful jump and a three-step
revocation rollback through the actual mailbox. CI retains those reports and
runs the same prepared adapted Wine/musl input to its next proven boundary.

Run 83 at `4a26f5845b5d4b1e0708392895df7b2b9a90c3ad` established the incoming
boundary: 1,746 executed Wasm steps, 116 compiled units, then unsupported `FF E0`
at `0x7f0000036722`, with RAX `0x7f0000038e80` and null guest exit. That is a
bounded interpreter probe, not completed Wine, app compatibility, phone execution
or JIT replacement. Its prior phone and memory-limit receipts remain unchanged.
