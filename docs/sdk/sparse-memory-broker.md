# Experimental broker foundation: B1

B1 provides an executable memory request contract, checkpoint storage and a
native single-instruction diagnostic. It does not connect guest memory accesses
to the translator or the Linux kernel. The default runtime does not load
`guest_memory.js` or `guest_memory_broker.js`.

Requesting `guestmem=broker1` explicitly fails translator creation. Only
`guestmem=direct` is supported there. This prevents an experimental caller from
silently executing the direct guest-memory path under a different name.

## Address and ownership domains

`BetterJITGuestMemoryBroker` requires storage contract 1. Its
`createInternalMemory()` constructs shared Wasm memory with both initial and
maximum sizes of 33 pages, or 2162688 bytes. Growing it fails. Guest data remains
in independent Slice A backing pages, addressed with full i64 BigInt bits.
The internal memory reserves a 0x10000 prefix and one 0x200000-byte thread block.
It supports one thread per internal memory; arbitrary preexisting memories and
reuse of a previously registered memory are rejected.

The kernel-side owner registers its thread slot, address space, internal memory
and native checkpoint layout. The returned registration is an opaque token with
a u64 lease generation. `dispatch` takes that token from the authenticated thread
record, plus the mailbox's lease and sequence. The request has no PID or address
space selector. Retirement removes the registration and checkpoint references.
A stale token or mailbox lease is rejected before reading or writing scratch.

Request sequences start at 1 and advance exactly once. Duplicates, skipped
sequences and wraparound are rejected without replaying an operation or
overwriting its previous response. Protocol errors with an otherwise valid
sequence consume that sequence and return a typed unsupported result. No async
operations or deferred replies are implemented yet.

## ABI 1

The constants identify memory ABI 1, checkpoint format 1, future step ABI 1 and
coverage revision 1. Reserved request numbers are MEMORY_REQUEST=0x10003 and
INSTRUCTION_BOUNDARY=0x10004. These numbers are not routed in the kernel yet.

Scratch is 128 bytes at thread base + 0x1f0000, physically 0x200000 in this
one-thread profile. All fields are little-endian. Offsets are exported in
`FIELD`; status and values are always separate.

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u32 | Magic 0x314d4a42 (BJM1) |
| 4 | u32 | ABI version |
| 8 | u32 | Request sequence |
| 12 | u32 | Status: OK=0, FAULT=1, UNSUPPORTED=2 |
| 16 | u32 | Operation: READ=1, WRITE=2, CAS=3, FETCH_ADD=4 |
| 20 | u32 | Width in bytes |
| 24 | u32 | Required READ or WRITE access bit |
| 28 | u32 | Typed reason |
| 32 | u64 | Complete effective guest VA |
| 40 | u64 | Guest instruction RIP |
| 48 | u64 | Checkpoint generation |
| 56 | u64 | Operand 0 |
| 64 | u64 | Operand 1, reserved |
| 72 | u64 | Result 0 |
| 80 | u64 | Result 1, reserved |
| 88 | u64 | Fault VA |
| 96 | u64 | Validated checkpoint RIP |
| 104 | u64 | Next RIP, reserved for execution integration |
| 112 | u32 | Completed sequence, published after response fields |
| 116 | u32 | Boundary control, reserved for execution integration |
| 120 | u64 | Registered thread lease |

Reasons 1 through 5 are RANGE, UNMAPPED, PROTECTION, ALIGNMENT and ALLOCATION.
Unsupported/rejection reasons 16 through 22 are OPCODE, WIDTH, PROTOCOL,
CHECKPOINT, STALE_LEASE, SEQUENCE and ACCESS. Zero means no error. A loaded zero,
sign bit or all-one i64 is valid data with OK.

The authority synchronously performs scalar READ/WRITE of 1/2/4/8 bytes. Slice A
checks every touched page before writing, including copy-on-write allocation.
Scalar reads gather bytes from potentially nonadjacent frames. Allocation and
mapping/protection failures become typed faults; unexpected internal errors
poison the registration and throw an invariant error. Atomic operation numbers
are reserved but return UNSUPPORTED. They are not implemented atomics.

There are no syscall, signal-delivery, redirect or scheduling callbacks in this
dispatch. A future mailbox integration must publish S_DONE only after dispatch
returns, with the existing atomic transport ordering. Do not route memory RPC
through `kcall`, `Kernel.request`, `attempt` or `syncShared`.

## Architectural checkpoints and instruction admission

Native configuration exports `checkpoint.version=1` with exact CPUState
`sizeof`/RIP `offsetof`, lazy-flag spill [0x40,0x58), and the separate four-byte
rounding word at 0x70. JS does not hardcode the native CPUState size. All spans
must be bounded, mutually disjoint and outside scratch.

At a safe boundary after full state is spilled, `beginInstruction` copies those
spans and records a fresh u64 generation and full RIP. Its operation/width are
trusted compile-time admission metadata, not a guest request. Supported plans
are register-only or exactly one scalar read/write. The broker checks request
RIP, generation, access, width and operation against that plan.

After a step returns with no live guest Wasm locals, `finishInstruction`
validates the complete post-state RIP on success, or restores all checkpoint
spans for a typed fault/unsupported exit. It does not restore state while a
guest instruction is suspended in a memory RPC. A second memory request in one
admitted instruction, an unsupported exit after a memory effect, or an invalid
step transition is a fatal compiler/runtime invariant failure. It is never
reported as a successfully rolled-back instruction.

The emitter must classify the complete instruction before executing any effect.
This admission classifier is not implemented in B1. Scalar IR node counts alone
are insufficient: CALL/PUSH, paired accesses and restart-sensitive instructions
can have other effects. Unclassified accesses, SIMD/masked/gather operations,
bulk REP/copy/fill, atomics and mutable executable aliases must remain explicit
unsupported cases until their complete semantics are implemented. Effective
addresses must retain folded displacement and FS/GS before lookup; do not
globally replace `Wrap`, which also handles non-memory narrowing.

## Native diagnostic and evidence

`maxinst=1` passes an explicit frontend instruction limit, forces guest
instruction markers independently of memtrace, disables multiblock, regions,
inlining, dispatcher calls, register arguments, ABI pruning and cross-unit flag
pruning. Code mapping ABI hints cannot reenable them. `instmeta=1` separately
retains markers without memtrace. Default options preserve their behavior.

This diagnostic still imports direct guest memory with the legacy declared
maximum and returns the legacy i32 RIP. It is not the broker execution profile,
full opcode admission or a new step ABI. Broker execution must declare and
allocate the small internal maximum in both producer and consumer, move
`allocTb` outside guest VMAs, retain full u64 PCs, emit typed step exits and
connect dedicated kernel/worker routes before it can be enabled. Native copied
code vectors remain keyed by full guest addresses.

Run actual storage/broker tests with:

```sh
node --test tests/sdk/linux-guest-memory.test.mjs tests/sdk/linux-guest-memory-broker.test.mjs
```

These use real storage bytes with a synthetic request producer and CPU layout.
They do not run guest instructions. The separate native test requires a freshly
built host translator:

```sh
node tests/sdk/linux-host/native-step-contract.cjs .build/host-fex/fexserve /outside/repo/native-step.json
```

It executes freshly generated FEX Wasm for two register instructions, proves the
one-instruction limit, checks native checkpoint metadata and rejected profiles,
and verifies that failed profile creation leaves the server usable. It does not
run sparse guest accesses, Linux processes, atomics, futexes or a device.

Before B is complete, three actual FEX/Wasm guest processes must rendezvous at a
barrier and verify full pointers, private high-page sentinels, shared aliases,
typed fault RIP/GPR/flags, coherent atomic values, PRIVATE versus shared futex
isolation, precise internal sizes and versioned cache identities. Compare and
enqueue must be atomic; waiting must park only the requester, retain backing/key
lifetime, and cancel replies safely across thread retirement. All reads, writes,
file updates and atomics must share one authority, bypassing old worker-local
futex/clock shortcuts. No host storage test establishes phone RAM savings.
