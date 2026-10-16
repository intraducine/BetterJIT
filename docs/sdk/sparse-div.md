# Bounded register DIV

Step ABI 4 / coverage 22 admits unsigned `F7 /6` register DIV32 and DIV64,
with at most one REX prefix. Byte/word division, IDIV, memory operands and
legacy/repeated prefixes remain unsupported. Memory ABI 1, checkpoint ABI 1
and the 96-byte step header are unchanged. Operation 17 carries width 4 or 8.

The backend proves the complete pinned FEX lowering: original RAX/RDX/divisor
reads (including aliases), distinct quotient/remainder handles, one UDiv,
exact 32-bit output normalization, RAX/RDX stores and constant fallthrough.
The sparse entry checks the original masked divisor and high half before any
architectural write. Zero divisor or `high >= divisor` returns
`STEP.DIVIDE_ERROR` (5) without an epilogue or Wasm divide. Valid DIV64 retains
the existing wide unsigned helper. The generic nonbroker UDiv lowering is
unchanged; its lower-bits contract does not itself guarantee architectural #DE.

BEGIN snapshots the original operands. FINISH accepts status 5 only for an
owned failing DIV with every CPU/lazy-flag/rounding/RIP byte unchanged, and
returns a frozen exception `{kind:'divide-error',vector:0,reason,rip}`.
The reason is `zero-divisor` or `quotient-overflow`. A failing DIV cannot finish
successfully. Successful DIV must produce the exact quotient/remainder and
fallthrough while preserving all other checkpoint bytes. Native successful
arithmetic flags are undefined; preservation is a stronger pinned FEX property.

The worker executes `run()` and counts that step before requiring matching
FINISH status 5. Terminal status 5 must match that exact accepted FINISH owner,
lease, sequence, result and original RIP. Status 4 remains reserved for the
separate spilled-syscall lifecycle. Unexpected Wasm traps remain failures.

This typed terminal stop does not deliver Linux SIGFPE, produce a normal guest
exit code or create a child wait status. The retained process supervisor stops
all published/staged owners, waits for their guest/native request drains, then
unregisters broker owners, closes guest images and drops native catalogues.
Occupied worker slots and internal contexts remain retained until session
teardown. Existing step, byte, time and cache limits are unchanged.

`sparse-div.cjs` checks actual FEX/Wasm against a retained native Linux x86
oracle, refreshed on x86 Linux, plus every admitted REX/register form, aliases,
masked DIV32 and nonzero-high DIV64. `register-div-ir.cpp` mutates actual FEX IR.
`linux-sparse-div.test.mjs` exercises checkpoint ownership, forged completions,
blocking workers and session drain fences. These are host diagnostics; they do
not establish full Wine execution, physical-device behavior or JIT replacement.
