# Register logical immediates

Coverage 24 adds group-1 immediate OR (`81/83 /1`) and XOR (`81/83 /6`)
alongside AND (`81/83 /4`). The destination is a 32-bit or 64-bit GPR,
including RSP and R8–R15. These are generic register operations; no instruction
address or application identity selects the implementation.

An optional single REX selects width and the destination register. REX.R/X are
ignored opcode-group aliases; REX.B extends the destination. Opcode `83` uses a
sign-extended imm8. Opcode `81` uses imm32, sign-extended for the 64-bit form.
Writing a 32-bit destination clears its upper half. Byte/word group forms,
memory destinations, `82`, ADC/SBB, LOCK, segment/address-size/REP prefixes and
extra/reordered prefixes remain outside this profile. Existing accumulator
logical forms retain their earlier admission contract.

The native frontend independently decodes the bounded instruction length,
destination, width and immediate. A dedicated backend check then proves the
pinned FEX IR: exactly one source GPR and destination store, the matching
logical result, PF source, AF invalidation and constant fallthrough. OR/XOR
use `SUB(result,0)` to set logical flags. All-ones XOR may use NOT. AND uses
`AndWithFlags` followed by the exact NZCV carry-normalization sequence. Wrong
operands, widths, immediates, flag producers, effect ordering, extra memory or
context operations and control transfers fail before Wasm emission.

CF and OF clear; PF, ZF and SF reflect the width-masked result. AF is
architecturally undefined and is excluded from native flag comparisons. The
current emitter leaves its raw AF storage unchanged; regression tests check
that storage preservation without assigning AF an architectural value. DF,
other CPU bytes, lazy-spill padding and rounding mode remain unchanged.

The wire contract stays operation 6, width 0, with memory/checkpoint/step ABI
1/1/4 and the 96-byte header. Generated modules import only internal memory and
the thread-base global. They perform no guest memory RPC, change no execution
budgets and preserve the existing ownership/accounting limits. An injected
unsupported completion after real Wasm execution restores the full owned CPU,
lazy-flag and rounding checkpoint; it is a rollback test, not a memory fault.

`tests/sdk/linux-host/sparse-logical-immediate.cjs` checks literal native x86
oracle rows against actual FEX-generated Wasm, every destination GPR, ignored
REX aliases, both immediate forms and sign boundaries. It checks SETcc and
finite branch consumers, exact unrelated state, refusals, fallthrough address
bounds, checkpoint rollback, native IR discard and backing cleanup.
`fexwasm/src/testing/logical-immediate-ir.cpp` separately mutates copies of
actual FEX IR and sweeps raw admission encodings. The normal Apple workflow
builds and runs both diagnostics and retains their results.

The independently inspected coverage-23 Wine probe used unchanged executable
and musl interpreter bytes and stopped at `0x7f0000036818`, `83 c8 01`
(`OR EAX,1`), with no guest exit. That run's later host teardown succeeded,
while `workerRetirementAcknowledged` remained false. Neither the new synthetic
logical tests nor the earlier passing probe gate establishes Wine completion,
physical-device execution or integration with Madeira, PPSSPP or MeloNX. The
next real probe must keep the same input bytes and bounded accounting.
