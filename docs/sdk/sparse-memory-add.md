# Bounded non-LOCK ADD memory

Coverage 11 adds `01 /r` with a memory destination and a 32- or 64-bit register
source. It covers the `48 01 10` (`ADD qword ptr [RAX],RDX`) boundary verified at
`0x7f0000036705` in the prepared Wine probe from green commit `7f6a023` / run
[38871692398](https://github.com/intraducine/BetterJIT/actions/runs/38871692398).
That report reached 653 Wasm executions from 100 compiled units, stopped with
typed unsupported status and no guest exit. New ADD host tests do not establish
a later Wine boundary; that requires another exact prepared-input probe.

The raw admission rule excludes LOCK, REP, segment/address-size/operand-size
prefixes, byte and 16-bit destinations, immediates, ADC/SUB and other arithmetic
families. FEX must still decode exactly one instruction. Its complete IR must
contain one linked load, ADD-with-flags and same-address store of the same
width. A bounded structural comparison handles regenerated SIB and RIP-relative
address nodes. The source GPR must be loaded before the memory operation; GPR
writes and unknown IR effects are refused. AF/PF and carry-normalization nodes
must match the arithmetic result and occur after their producers.

Dedicated broker operation 11 performs one synchronous authority request. It
prepares the entire write range, checks read permission, stages every needed
private-view COW page, rechecks the exact owner/checkpoint after allocation
callbacks, computes the modulo-width sum and commits without callbacks. It
returns the old memory value. The original FEX arithmetic computes all six
defined flags (CF/PF/AF/ZF/SF/OF); only the proven linked memory store is
suppressed. Dword ADD preserves the source register's upper bits and adjacent
memory bytes. Internal memory remains fixed at 33 pages.

Unaligned and cross-page operands are permitted. No Atomics operation, LOCK
ordering guarantee or atomic alignment rule is introduced. The authority's
existing synchronous serialization is an implementation detail. This increment
does not expand the guest LOCK or concurrency contract.

Permission, range and allocation failures return typed faults before any ADD
memory effect; the normal instruction checkpoint restores CPU, lazy flags and
rounding state. Partial COW staging is released. Owner retirement/slot reuse or
aliased-backing revision changes during allocation fail closed before commit;
they do not publish through the stale capability.

`sparse-memory-add.cjs` compares actual FEX/Wasm against 200 retained native x86
result/flag rows. Linux x86 hosts independently rebuild and execute the oracle;
other hosts explicitly report that native-oracle execution is unavailable and
still check the retained rows. The matrix covers REX, displacement, SIB,
RIP-relative, source/address aliasing, all GPR preservation and one RPC per ADD.
Separate cases check shared/private/COW cross-page effects, read/write intent
including a zero addend, both COW allocation failures, full checkpoint rollback,
owner retirement/reuse, alias mutation and bounded instruction refusals. These
are host fixtures, with no physical device, successful Wine or RAM claim.

The host build also produces `sparse-memory-add-ir`. It clones actual FEX IR
and checks four valid shapes plus 134 forced mutations, including stale flag
reads, wrong data/width/address, definition-order violations and early exits.
Every refused shape must return an error without a Wasm module. This executable
is a required hashed host-cache output; its source participates in the cache
identity. CI reruns the diagnostic and retains its log even on a cache hit.
