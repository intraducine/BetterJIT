# Bounded immediate register TEST

Coverage 17 admits `F6 /0` register-byte TEST, `F7 /0` register TEST at
16/32/64 bits, and the accumulator forms `A8`/`A9`. These retain wire operation
6 (FLAGS), width zero, constant fallthrough and no guest-memory import or RPC.
Memory/checkpoint/step ABIs remain 1/1/3, headers remain 96 bytes and internal
memory remains fixed at 33 pages. Existing memory TEST coverage is unchanged.

The preceding same-input adapted Wine/musl probe at `726f716`, green run
[38909519761](https://github.com/intraducine/BetterJIT/actions/runs/38909519761),
executed 2,366 Wasm steps from 253 compiled units and stopped unsupported at
`0x7f0000037ffc` on `f6 c4 80`, `TEST AH,0x80`, with null guest exit. This
milestone preserves the earlier prepared-input identities and phone evidence;
the focused host fixtures below establish no subsequent Wine boundary.

Raw admission independently binds complete length, source GPR, operand width,
high-byte selection and immediate mask. A single optional `66` precedes a single
optional REX. `F6`/`A8` stay byte-sized; `F7`/`A9` default to dword, `66` selects
word, and REX.W takes precedence for qword. Qword immediates sign-extend imm32.
Without REX, byte ModRM selectors 4..7 name AH/CH/DH/BH. Any REX changes these to
the corresponding low byte registers; REX.B extends ModRM selection to R8..R15.
Accumulator forms always select RAX, including when REX.B is present. The pinned
vendor decoder accepts a `/1` TEST alias; this profile explicitly refuses it.
Memory operands, other group operations, LOCK/REP, segment/address-size prefixes,
repeated prefixes and REX before `66` remain outside this slice.

An internal TEST-specific proof checks the complete ordered FEX IR before the
existing FLAGS emitter runs. It permits one selected 64-bit source load, the
required high-byte extraction, one logical flag producer, AF invalidation,
the linked parity value, any required carry normalization, and exact fallthrough.
Four observed optimized shapes cover general AND-with-flags, small nonnegative
byte/word masks, all-ones byte/word masks, and all-ones dword/qword masks. Constants,
widths, masks, dependencies and effect order must match the decoded instruction.
GPR writes, memory/context writes, extra flag effects, syscalls and unknown IR
are refused. The generic FLAGS profile is not sufficient proof for TEST.

TEST preserves every bit of every GPR, including upper bits of dword operands.
CF and OF clear; PF, ZF and SF derive from the width-truncated AND result. AF is
architecturally undefined, and the current invalidation emitter preserves its raw
storage. Tests exclude AF from native flag comparison while checking that storage
and unrelated CPU bytes remain unchanged. The all-ones byte/word optimization
retains the original source in raw PF storage, whose low byte determines parity.

Validation includes 3,744 retained native x86 rows, rebuilt and matched on Linux
x86 hosts; 928 actual FEX/Wasm forms and masks, 24,128 operand/flag checks, 8,320
live branch checks and 80,704 Wasm invocations; 27 refused encodings; and an
actual dynamic ELF/kernel/worker fixture. The separate mandatory
`sparse-test-immediate-ir` host diagnostic checks 80 original frontend forms and
3,486 rejected mutations, including source/extraction/mask/order changes, wrong
flag/AF/PF/carry effects, hidden writes and bad exits. Both diagnostics and their
sources are included in CI and the SDK source export. These are bounded host
execution results, not full Wine execution, phone execution or native guest JIT.
