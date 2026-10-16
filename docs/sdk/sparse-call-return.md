# Checked sparse direct calls and returns

Coverage 8 adds only unprefixed x86-64 `E8 rel32` CALL and `C3` RET. Standalone
PUSH/POP, indirect/far calls, far returns, `RET imm16`, prefix variants and CET
remain unsupported. This is ordinary stack return-address behavior, without a
shadow stack or call-history policy. The existing instruction limit and mapped
guest stack bound nesting; guest calls do not recurse through host Wasm calls.

Coverage 9 retains these target and post-effect invariant restrictions while
adding [integer extensions](sparse-integer-extensions.md).

The 96-byte step header and memory/checkpoint/step ABIs stay 1/1/3. Operation 9
is an eight-byte stack write plus a fixed direct continuation (flow 3).
Operation 10 is an eight-byte stack read plus a checked return continuation
(flow 4, header target zero). CALL uses exact signed rel32 arithmetic and rejects
overflow, underflow and addresses outside the low canonical user window. Native
and JS header validation independently derive the same target. Zero-displacement
CALL retains its push even though the next PC is also its return address.

The native checkpoint exports `cpu.stackPointerOffset`. The kernel verifies it
against the RSP slot derived from `gregsOff`; the broker validates its alignment,
bounds and disjointness from RIP. Older synthetic scalar layouts may omit this
field, but cannot execute CALL/RET. BEGIN retains the full pre-RSP and trusted
fallthrough. The one RPC must address RSP-8 for CALL or RSP for RET; a CALL must
write exactly the complete fallthrough PC. Stack arithmetic is checked before
access, including RET's post-RSP increment. FINISH requires exactly one successful
RPC, the correct post-RSP and the actual fully spilled continuation.

CALL validates one byte of its target as private readable/executable storage
without writable/shared aliases before preparing its stack write. COW staging
and an owner recheck precede publication. RET applies the same target policy to
the checked eight-byte stack value; FINISH compares against broker-owned read
data, never mutable scratch alone. The next instruction still needs independent
admission and IR validation. Mapping a target does not advertise its ISA family.

Bad target/domain checks return typed UNSUPPORTED before a CALL write or after
a side-effect-free RET read. Stack mapping/permission/allocation failures return
typed FAULT. Both paths restore the complete CPU, lazy flags and rounding state
after Wasm unwinds. Storage preparation validates all pages and stages all COW
allocations before writing bytes. Duplicate RPCs, forged successful post-state
and an unsupported result after an already committed write are fatal invariants;
they cannot pretend an effect was rolled back. The fixed 33-page internal memory
and existing guest backing budgets are unchanged.

FEX emits dedicated PUSH/POP IR for these two instructions. Their broker paths
perform one checked RPC and never wrap guest pointers into linear memory. Full
IR validation checks widths, pushed return PC, RSP-only register access, exact
call/return exit shape, the link between RET's POP value and its exit PC, and
complete effect counts. No legacy dispatcher or direct-memory fallback runs.

`tests/sdk/linux-host/sparse-call.cjs` compares actual generated Wasm with a
separately compiled native x86 flags/stack oracle. It covers forward/backward/
zero displacement, unaligned and cross-page stacks, private COW views, complete
CPU preservation except RIP/RSP, unchanged lazy/rounding state, and all defined
arithmetic flags including AF. Separate tests exercise signed/canonical metadata
limits, invalid targets, forged requests, stack faults and first/second-page COW
allocation failure. The optional `--synthetic-calls` bootstrap runs two nested
calls and two returns through the production kernel/worker/host, restores RSP,
then reaches an expected UD2 boundary after six Wasm steps and four memory RPCs.

The previous exact Wine/musl probe at commit `bd9f872` executed four steps and
stopped at CALL. The new host controls do not replace its retained inputs or
establish a later real Wine boundary. That requires rerunning the exact prepared
input in CI. No completed sparse Wine command, dynamic linker/TLS completion,
WebKit/device execution, physical retirement or lower resident RAM is claimed.
