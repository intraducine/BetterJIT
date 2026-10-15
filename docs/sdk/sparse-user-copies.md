# Experimental spilled user-memory copies

This first lifecycle prerequisite extends the bounded broker profile with
authenticated `copyIn`, `copyOut` and `readU64` operations. It does not enable
guest fork/exec/clone, ELF loading or general I/O syscalls. The default runtime
does not load the experimental storage/broker modules.

The broker accepts copies only after a successful STEP_SYSCALL spill, when no
instruction is active and the owner is not parked. BEGIN revokes that boundary;
retired, foreign or poisoned registrations cannot copy. The kernel's frozen
`sparseUserMemory(thread)` capability rechecks the exact thread/slot/token,
W_OCCUPIED and original guest address-space identity on every use. It refuses
image replacement, retirement, active instructions and parked calls. There is
no guest-supplied process/address-space selector or backing-page view.

Addresses must be full BigInt i64/u64 values. Counts must be exact nonnegative
integers no larger than 65536 bytes; larger transfers throw UserCopyUnsupported
before effects or guest-buffer allocation. Reads return fresh byte copies.
`readU64` gathers eight bytes with full pointer/value bits. Copyout requires a
fixed ordinary Uint8Array source, snapshots it before storage callbacks and uses
the existing all-page permission/allocation checks and transactional private-view
detachment. A later page or allocation failure leaves all destination bytes and
mapping identities unchanged. Typed MemoryFault/AllocationFailure remain intact;
these operations do not consume memory-RPC sequences or mutate guest CPU state.

The existing futex relative-timespec read now uses this authenticated copyin.
The real FEX/Wasm synchronization fixture asserts that its high-VA 16-byte
timespec traverses the capability exactly once while retaining the existing
172-step, three-process-record/four-worker checks. These records remain host
created. Storage/capability regressions use synthetic spilled producers and
test isolation, stale owners, exact lengths, cross-page faults and rollback.

This is a pure-memory boundary. It is not a prepared copyout transaction spanning
file input consumption, nor an implementation of Linux partial I/O, string/vector
arguments or image preparation. Those remain the next stages of the reviewed
[lifecycle proposal](https://github.com/intraducine/BetterJIT/blob/d144603471f2564067fefe1a6c20ff323cfe5dac/docs/sparse-process-lifecycle-plan.md).
Do not call legacy direct-buffer helpers or consume file input before the later
prepared-copyout contract exists. Memory/checkpoint/step/coverage ABIs remain
1/1/2/2; this adds no native import or opcode family. Host tests establish no
device compatibility, sparse WebKit lifecycle support or RAM savings.
