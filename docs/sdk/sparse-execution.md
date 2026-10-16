# Experimental sparse scalar execution: B2

B2 connects actual FEX-generated Wasm to Slice A storage through the B1 broker.
It is an explicitly selected, bounded host execution path. [B3 synchronization](sparse-synchronization.md) extends this scalar baseline
with aligned atomics, bounded futex syscalls and multiple internal thread contexts.
The later opt-in [guest clone/exit profile](sparse-clone.md) creates a same-mm
thread from an actual translated guest syscall; B2/B3's original process
records remain host-created fixtures.
The current step/coverage versions are 3/15;
[register-destination memory ADD](sparse-register-memory-add.md), [register PUSH/POP](sparse-register-stack.md),
[register jumps](sparse-register-jumps.md), [register shifts](sparse-register-shifts.md),
[non-LOCK memory ADD](sparse-memory-add.md),
[architectural NOPs](sparse-nops.md) and [integer extensions](sparse-integer-extensions.md)
document the later increments. [Bounded control flow](sparse-control-flow.md)
added TEST/CMP and direct finite continuations. Default execution
keeps its existing memory model. The fixture creates kernel Process/Thread
records with independent address spaces and separate workers; it does not load
ELF, implement Linux fork/exec or run Wine.

## Native profile and complete instruction admission

`linux=1 guestmem=broker1` requires shared internal memory with physical thread
base 0x10000. Both the imported Wasm memory's initial and declared maximum sizes
are 33 pages. The kernel constructs a separate fixed-maximum memory per thread;
the 2 MiB thread block is internal and never a guest VMA. Guest virtual limits
and backing payload are independent of that memory. B2 originally used one thread per process; B3 permits host-created threads
sharing one process address space, each with separate CPU/scratch memory. A
Kernel retains at most eight internal contexts, including retired thread records.
Its guest address-space limit must be at most 2^47, the low canonical x86 user
window. The generic storage layer can represent wider ranges; this process
profile does not admit noncanonical or upper/kernel mappings.

The profile forces one decoded instruction, instruction markers, no multiblock,
regions, inlining, ABI pruning, register arguments, legacy dispatcher calls or
window relocation. Native code remains copied into guest-keyed FexHost vectors.
The legacy `fexwasm_unit`/dispatcher paths return no module in this profile.
Nonempty persistent `cache=` is rejected until that format supports broker
steps; no direct-mode cached module is used. Build identity, memory/checkpoint/
step/coverage versions and exact module hashes identify the fresh output.

Admission checks the original instruction's semantic family before generation,
then FEX's exact one-instruction decoded length, mapped byte bounds, a complete
IR allowlist, a single block/exit and the exact memory operation count/width.
Unknown IR cannot reach a direct guest-memory emitter. Initially eligible x86
families are:

- Plain NOP and MOV register/immediate.
- MOV GPR loads/stores of 1/2/4/8 bytes, including ModRM/SIB/displacements and
  immediate stores. FS/GS and operand-size prefixes are permitted; unsupported
  or repeated prefixes are refused.
- MOVZX, MOVSX and 64-bit MOVSXD around one scalar source, subject to the same
  complete lowering checks.

The B2 baseline rejected SYSCALL and locked atomics. B3 admits only LOCK
CMPXCHG/XADD with 4/8-byte memory operands and a spilled SYSCALL boundary whose
only implemented syscall is bounded futex WAIT/WAKE. PUSH/POP/CALL/RET, branches,
other atomics, SIMD/masked/gather, REP and address-size override remain explicit
unsupported results before execution. This is not a general x86 opcode implementation. Expanding admission requires
complete effect, flag, fault and restart semantics.

`fexwasm_step(T, uint64_t RIP)` returns a 96-byte little-endian BJS1 header:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u32 | Magic 0x31534a42 |
| 4, 8, 12, 16 | u32 each | Memory, checkpoint, step and coverage versions |
| 20 | u32 | OK=0 or UNSUPPORTED=2 |
| 24, 28 | u32 each | Admitted operation and width |
| 32, 40 | u64 each | Full RIP and logical next RIP |
| 48 | u64 | Module hash |
| 56, 60 | u32 each | Module byte count and decoded instruction length |
| 64 | 16 bytes | Original instruction bytes, zero-padded |
| 80 | u64 | Full direct branch target, zero for fallthrough instructions |
| 88, 92 | u32 each | Continuation kind (0 fallthrough, 1 jump, 2 conditional) and reserved zero |
| 96 | bytes | Wasm module, absent for unsupported results |

The worker parser requires matching versions and exact sizes. At instruction
boundaries the kernel also compares immutable private RX bytes with the
admitted instruction. Writable/shared executable backing and changed code are
refused. Concurrent remapping and executable-alias invalidation are not enabled.

## Dedicated execution and fault boundaries

`Kernel.createSparseProcess` accepts a separately owned GuestAddressSpace,
entry RIP and trusted native admission plans. It allocates internal state and
registers a broker lease. Duplicate address-space ownership is rejected.
`Kernel.serviceRequests` routes registered sparse threads before syscall
counters, `freezeRequest`, `syncShared`, `attempt`, `reply` or signal delivery.
Memory transport carries a lease/sequence, without a PID selector. Workers use
a separate loop, so old local futex, clock and GPU shortcuts cannot run.

At BEGIN the kernel verifies the full CPU RIP/code bytes and copies all native
checkpoint spans. A scalar emitter computes the full i64 effective address,
including folded displacement and FS/GS, into internal scratch. `e.memory`
transfers that request through the mailbox and returns only typed status.
Loaded i64 data stays separate, including zero and all-one values. Guest VAs
never become Wasm offsets; CPU/scratch accesses remain internal offsets.

On memory failure the emitted function returns FAULT/UNSUPPORTED without a
register epilogue. The worker first unwinds the Wasm call, then sends FINISH.
Only there does the kernel restore complete CPUState, lazy flags and rounding
state. Success spills changed state and a full u64 next RIP before FINISH.
The broker validates that RIP against the admitted continuation. A second
memory effect, invalid post-state or unexpected internal error is fatal, not a
claimed rolled-back instruction.

Pending signals and snapshots are explicitly unsupported at BEGIN. They cannot
be delivered during memory RPC. Typed memory reasons are not complete Linux
signal/trap delivery, and the profile makes no #GP/#PF/si_code compatibility
claim. Ordinary syscall/ELF entry points reject the profile. Worker retirement
unregisters broker state; occupied slots remain held until host termination
acknowledgement. The bounded fixture tears down all workers and backing.

## Real translated evidence and remaining gates

With a freshly built host translator:

```sh
node tests/sdk/linux-host/sparse-live.cjs .build/host-fex/fexserve /outside/repo/sparse-live.json
node tests/sdk/linux-host/sparse-scalars.cjs .build/host-fex/fexserve /outside/repo/sparse-scalars.json
```

The first test generates 13 real FEX Wasm modules at high RIP 0x123400004000.
Three host-created kernel processes execute 39 steps with private data at
0x123456780000, independent low-address sentinels and canonical shared backing
mapped at different VAs. All three separate workers rendezvous before execution
and after shared writes. Their barriers are host test control, not guest futexes.
The test verifies cross-page stores/loads, FS/GS, exact register values, a typed
cross-page protection fault with no partial store, full checkpoint restoration,
zero syscall dispatch, actual/declared 33-page limits, and backing release.
The current fixture also rejects 11 uncovered instruction cases with no executable
module; its atomic and syscall negatives use uncovered CMPXCHG16B and int 0x80.

The separate 28-case emitter matrix executes actual translated byte/word/dword/
qword, partial/high-byte, sign/zero extension, immediate and register moves,
positive/negative/FS displacements, zero/all-one values and typed unmapped,
range, virtual-limit crossing and injected copy-on-write allocation faults. The
limit-crossing case preserves the access start separately from the first
inaccessible byte. It uses one host process
and the actual broker directly; it does not substitute for kernel routing.

This is host FEX frontend/Wasm evidence, not native FEX JIT, Apple WebKit,
physical-device compatibility or measured RAM savings. The
[B3 synchronization fixture](sparse-synchronization.md) now supplies aligned
atomics, nonblocking futex compare/enqueue, wake, timeout, cancellation and
retained backing/key lifetime. Guest process creation, general syscalls and
signal delivery, file lifecycle and wider instruction coverage remain unsupported.
