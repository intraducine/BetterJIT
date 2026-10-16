# Checked sparse register PUSH/POP

Coverage 14 adds 64-bit register PUSH (`50`–`57`) and POP (`58`–`5F`), with at
most one REX prefix. REX.B selects R8–R15; the other REX bits do not change the
operand. Operand-size, address-size, segment, LOCK, REP and repeated REX prefixes
are refused. Immediate, segment, memory and alternate ModRM stack encodings
remain outside this addition. The memory/checkpoint/step ABIs remain 1/1/3 and
the step header stays 96 bytes. Older coverage headers are rejected.

Operations 13 and 14 have width eight, fallthrough flow and zero static target.
Native admission and JS validation derive the selected GPR from the instruction
bytes. Static plans cannot override that selection. A complete ordered IR proof
requires the selected source and stack loads, one exact-width PUSH/POP, its
linked SSA operands, the expected register stores and the constant fallthrough.
POP's operand size and IR header size must both be eight. No additional memory,
register, flag, syscall or control effect is allowed. Existing PUSH/POP emitters
use checked broker WRITE/READ requests; guest addresses never become Wasm
linear-memory addresses.

BEGIN owns copies of CPU, lazy flags and rounding state, including the original
RSP and PUSH source. PUSH writes that original source at RSP minus eight, so
PUSH RSP stores the pre-decrement value. POP reads eight bytes at the original
RSP. Ordinary POP increments RSP by eight and replaces only its selected GPR.
POP RSP replaces RSP with the loaded value, overriding the increment. Loaded
data may be any 64-bit value; it is not treated as an executable target.

The bounded profile requires the original RSP and actual memory access to lie
in the low 47-bit guest window. PUSH checks subtraction and the new stack
address. POP checks its complete read range; an ordinary POP at the last valid
eight bytes may leave a one-past-window RSP as data. A later stack access checks
that new RSP independently. These restrictions are admission policy, not claims
to model every architectural stack-address fault.

PUSH prepares every write page and COW allocation before committing, rechecking
the active lease and owner after preparation. An unmapped/protected second page,
allocation failure or retired owner leaves bytes, frames, accounting and aliases
unchanged. POP never detaches a private view. FINISH requires exactly one owned
successful RPC and byte-for-byte expected CPU, lazy flags and rounding state,
including unchanged arithmetic flags and unrelated registers. Typed failures
restore the complete checkpoint after Wasm unwinds. Forged success after a
committed PUSH write remains a fatal invariant failure.

Validation uses 512 fresh native x86-64 oracle rows for all 16 registers, four
values and four arithmetic-flag seeds. Other hosts explicitly skip fresh x86
execution and compare with the retained oracle. The actual FEX/Wasm matrix
checks 144 encodings and 13,056 cases, including PUSH RSP, arbitrary POP RSP,
unaligned/cross-page stacks, private-view COW and full state preservation.
Mutations of copied real FEX IR test wrong widths, classes, operands, ordering,
stores, hints and effects. Broker tests cover forged requests/results, duplicate
RPCs, ownership changes, shared storage and two-page COW failures. Production
dynamic ELF/kernel/worker fixtures exercise successful stack operations,
underflow and a POP RSP value rejected by the following stack access.

The incoming Wine boundary is the parent-verified run 84 at
`fc57c11b89677198c1d5ade912d2d62210d610df`: the same adapted Wine/musl input
advanced from 1,746 to 1,747 executed Wasm steps, reached the admitted register
jump target `0x7f0000038e80`, then stopped at `55` (PUSH RBP). This change's host
fixtures do not establish a new Wine boundary. Only the reviewed commit's
automatic build can supply that next receipt. Prior phone fork/exec/cat and
dense-Wine memory-limit evidence remain unchanged; no Wine completion, app
compatibility, phone execution or JIT replacement claim follows from these tests.
