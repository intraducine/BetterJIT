# Sparse integer sign and zero extension

Coverage 9 adds the accumulator sign-extension family to the existing sparse
register-only admission. The memory/checkpoint/step ABIs remain 1/1/3, the step
header remains 96 bytes and internal memory remains 33 pages. Exact coverage
matching prevents mixing older native emitters with the current JS runtime.

| Instruction | Source | Destination | Full-register behavior |
| --- | --- | --- | --- |
| CBW (`66 98`) | AL | AX | Preserve RAX bits 16–63 |
| CWDE (`98`) | AX | EAX | Clear RAX bits 32–63 |
| CDQE (`48 98`) | EAX | RAX | Sign-extend through bit 63 |
| CWD (`66 99`) | AX sign | DX | Preserve RDX bits 16–63; preserve RAX |
| CDQ (`99`) | EAX sign | EDX | Clear RDX bits 32–63; preserve RAX |
| CQO (`48 99`) | RAX sign | RDX | Fill RDX with zero or all ones; preserve RAX |

One optional operand-size prefix and one following REX prefix are admitted.
REX.W selects 64 bits even after `66`; REX.R/X/B do not change these implicit
register operands. Duplicate prefixes, reversed REX/operand-size order, LOCK,
REP, address-size and segment prefixes remain outside this bounded addition.
No ModRM byte or guest memory access belongs to either new opcode.

The existing MOVSX, MOVZX and REX.W MOVSXD paths remain supported. MOVSX to a
32-bit destination first sign-extends within 32 bits, then clears the upper
half of the full destination register. A 16-bit destination preserves its
upper 48 bits. Without REX, byte register encodings 4–7 select AH/CH/DH/BH;
with REX they select SPL/BPL/SIL/DIL. These cases are part of the regression
matrix, alongside extended source/destination registers and partial SP writes.

FEX's pinned frontend lowers accumulator and explicit sign extension through
SBFE (signed bit extract), with BFI for partial-register writes. Zero extension
uses BFE or the existing destination-width store. The existing Wasm emitters
already implement those operations. This change adds no emitter fallback or IR
node allowance: the full instruction must still pass the register-only effect
check, with no memory RPC, flag-state modification, branch or syscall effect.

All six accumulator forms and explicit extension instructions preserve flags.
The native oracle executes 17 canonical forms over eleven values and six flag
seeds, including CF/PF/AF/ZF/SF/OF. Actual FEX/Wasm checks the complete CPU state
except the declared destination and RIP, unchanged lazy flags and rounding
state, correct operand-size precedence and full-width source/destination data.

Memory-source MOVSX/MOVZX/MOVSXD use the existing operation-1 READ contract at
exact source widths 1/2/4. Their unaligned and cross-page accesses stay in the
broker; they never wrap guest addresses into linear memory or write guest
storage. Unmapped, inaccessible, out-of-range and forged-width requests verify
typed failure and complete CPU/lazy/round checkpoint restoration after unwind.

`--synthetic-extensions` runs a synthetic ELF interpreter containing all six
accumulator forms inside two nested CALL/RET pairs through the production
kernel/worker/host. It reaches the expected UD2 boundary after 13 Wasm steps,
with four successful stack RPCs, original RSP restored, RAX `ffffffffffffff80`
and RDX `ffffffffffffffff`. This is not Wine or real libc execution evidence.

The last exact prepared Wine/musl result, published at `5b81e2d`, executed eight
steps and stopped at `0x7f00000364cc` on `48 98` (CDQE). The launcher and musl
hashes matched the preceding four-step result. A later real Wine boundary must
be established by rerunning those retained inputs; the synthetic control does
not establish one. Relocations, TLS and RELRO were incomplete, guest exit was
null, and guest-access quiescence did not imply physical worker retirement.

The subsequent `35daab3` probe passed CDQE and reached nine real Wine/musl
steps before the architectural NOP boundary. See [sparse NOPs](sparse-nops.md)
for the exact retained input identities and the coverage 10 milestone.
[Non-LOCK memory ADD](sparse-memory-add.md) documents the coverage 11 milestone;
[register shifts](sparse-register-shifts.md) document coverage 12;
[register jumps](sparse-register-jumps.md) document coverage 13;
[register PUSH/POP](sparse-register-stack.md) document current coverage 14.
