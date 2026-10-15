# Experimental sparse synchronization: B3

B3 extends the [B2 scalar path](sparse-execution.md) with actual translated
atomic instructions, bounded Linux futex syscalls and separate internal CPU
contexts for threads sharing an address space. Select `linux=1 guestmem=broker1`
explicitly. Memory ABI 1 and checkpoint format 1 remain unchanged; step ABI and
coverage revision are now 2. Older step modules are rejected.

## Admission and atomic effects

The complete source-instruction and IR checks admit LOCK CMPXCHG and LOCK XADD
with 4/8-byte memory operands. The emitter sends a CAS/FETCH_ADD request through
the same authority that handles scalar loads/stores. It never uses a guest VA
as a Wasm offset. The authority validates READ|WRITE access before effects and
returns the old value separately from status. CAS retains write intent on
comparison failure, including permission and copy-on-write allocation checks.

Natural alignment is required by this bounded profile. Unaligned atomics return
UNSUPPORTED before any effect; this does not claim x86 unaligned-atomic support.
Other atomic instructions, byte/word atomics, paired atomics and multiple memory
effects remain unsupported. FEX computes architectural register and flag results.
Typed memory failures restore the complete pre-instruction checkpoint only after
the Wasm call has unwound.

## Spilled syscall and futex boundary

A plain SYSCALL instruction is admitted as operation 5, width 0. Its generated
Wasm performs architectural RCX/R11 updates, spills full state and returns
STEP_SYSCALL=3. It does not import or call the ordinary syscall handler. After
the Wasm call returns, the kernel accepts only Linux x86-64 syscall 202 with
FUTEX_WAIT/FUTEX_WAKE, optionally FUTEX_PRIVATE_FLAG. Uncovered syscalls or futex
operations return UNSUPPORTED and restore the pre-instruction checkpoint.

The dedicated route compares and enqueues synchronously, with no await/reply gap.
A wait parks only the requesting mailbox; the kernel continues servicing other
threads. PRIVATE keys contain address-space identity and the complete guest VA.
Shared keys contain canonical backing-object identity, page and byte offset.
Each queued wait retains backing/key lifetime across unmapping and object close.
Wake detaches all selected entries before invoking completion callbacks.

Implemented results include compare mismatch (-EAGAIN), relative timeout
(-ETIMEDOUT), safe-boundary signal cancellation (-EINTR), bad alignment/count/
timespec (-EINVAL) and inaccessible memory (-EFAULT). Retirement cancels timers
and removes waits without replying to stale leases or reused slots. A completion
checks the exact current thread, lease, sequence and busy mailbox before writing
RAX or transport state. General signal frames, handlers and restart semantics
remain unsupported; pending signals stop execution at the next BEGIN boundary.

## Ownership and capacity

`createSparseProcess` and `createSparseThread` are trusted host fixture APIs,
not guest fork/exec/clone implementations. A process owns one guest address
space. Each thread owns a distinct fixed internal Wasm memory with initial and
maximum sizes of 33 pages (2162688 bytes), including its 2 MiB thread block.
At most eight thread contexts may be retained per Kernel, counting retired
thread records. The ninth allocation fails before creating another context.
The primary context is only a compatibility diagnostic alias; sparse execution
and completion always use the authenticated thread's own CPU/scratch view.

The actual/imported memory maximum is enforced, and guest limits remain
independent of internal memory. A sparse process admits only the low canonical
x86 user window through 2^47. Mutable executable aliases, concurrent remapping,
snapshots, guest ELF loading, general syscalls, file lifecycle and wider opcode
coverage remain unsupported. Persistent broker-step caches remain disabled.

## Reproducible host evidence

Build a fresh host translator, then run:

```sh
node tests/sdk/linux-host/sparse-atomics.cjs .build/host-fex/fexserve /outside/repo/atomics.json
node tests/sdk/linux-host/sparse-sync.cjs .build/host-fex/fexserve /outside/repo/sync.json
node --test tests/sdk/linux-guest-memory.test.mjs tests/sdk/linux-guest-memory-broker.test.mjs tests/sdk/linux-sparse-routing.test.mjs tests/sdk/linux-sparse-futex.test.mjs
```

The atomic differential test requires Linux x86-64 and a C compiler. Its
independent native x86 oracle supplies nine register/memory/defined-arithmetic-
flag results and verifies that a failed compare on read-only memory faults.
Fresh FEX-generated Wasm matches those results; a spilled SYSCALL unit exposes
FEX-packed flags without dispatching a syscall. Further actual Wasm cases verify
read-only mismatch, unaligned admission and injected allocation failure, with
full CPU/lazy-flags/rounding restoration and no memory effect.

The synchronization fixture creates three independent guest process records and
four workers; two threads share one process address space but have separate
internal memories. It executes 172 fresh FEX-generated modules/steps. Forty-eight
LOCK XADD increments return unique old values 0..47, followed by failed and
successful CMPXCHG and a final shared value of 99. Nine translated futex syscalls
verify shared alias wake, PRIVATE separation across processes, same-process
PRIVATE wake, full-VA PRIVATE alias separation (aliases differ by 2^32), compare
mismatch, timeout and signal cancellation. Another process performs private
memory work while a waiter is parked. All waits complete and backing payload
returns to zero after cleanup. Initial/post-increment barriers are host test
control; wait/wake operations themselves execute translated SYSCALL instructions.

These are Linux host FEX frontend-to-Wasm tests. They establish neither guest
process creation nor native FEX JIT, Apple WebKit/device compatibility or measured
resident-memory savings. The ordinary runtime and its packaged Wine evidence
remain separate from this experimental profile.
