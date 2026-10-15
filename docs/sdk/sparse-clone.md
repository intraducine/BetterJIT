# Experimental guest-initiated clone and thread exit

The separately selected [version-3 static ELF exec profile](sparse-exec.md)
adds checked image loading and acknowledged replacement; the version described
here keeps its original syscall scope.

This opt-in host profile supports an actual Linux x86-64 guest `clone` syscall
and per-thread `exit` through FEX-generated Wasm. It is the first guest-created
thread increment. It creates no new process or image and enables neither fork,
exec, wait4, an ELF loader nor ordinary descriptor I/O. The default runtime and
browser sparse lifecycle remain unchanged.

The host must supply `sparseLifecycleVersion: 1`, `spawnSparseThread(spec)` and
`stopSparseThread({slot, lease})`. Only the authority creates and publishes thread
records; callbacks synchronously submit host operations, while readiness and
termination are acknowledged separately. The spawn callback provisions the exact prepared worker. The stop
callback must terminate that exact owned worker, or confirm no worker was
created. In either case it clears W_OCCUPIED only after actual termination or
confirmed absence, then wakes the kernel. A thrown spawn callback has an
uncertain creation outcome: the authority requests an exact-lease stop and waits
for acknowledgement before reporting failure. A failed stop callback is a fatal
host ownership error, not a guest errno. An elapsed timer never releases a slot.

The admitted clone contract is syscall 56, flags exactly `0x10f00`
(VM|FS|FILES|SIGHAND|THREAD), zero exit signal, and a nonzero 16-byte-aligned
full-width child stack. The word immediately below the stack pointer must be
writable private backing. This is a declared profile restriction, not Linux's
general stack validation rule. Parent-TID, child-TID and TLS arguments must be
zero; SETTLS, TID stores/clear-TID, robust lists, other flag combinations, vfork,
clone3, fork and exec remain unsupported. Current caught signal dispositions or
pending signals refuse admission. The calling blocked mask is inherited;
general signal delivery/restart remains unsupported.

Unsupported combinations restore the complete pre-instruction state before
effects. Capacity exhaustion returns EAGAIN. Each allocated internal context
counts toward the existing limit of eight, including cancelled attempts; this
is deliberately conservative. Child CPUState, lazy flags and rounding state
are copied after the parent's SYSCALL spill. Child RAX becomes zero and RSP
becomes the supplied stack; parent receives the published TID. Both share the
same Process, address space, descriptors and signal dispositions, but own
separate fixed 33-page internal memories. No legacy direct-memory clone path is
called, and no guest stack is used as internal CPU/scratch storage.

The child is initially unpublished behind a fresh 16-byte startup gate carrying
version and exact lease. Its worker validates configuration and prepares the
first admitted module before changing PENDING to READY. It cannot execute a
guest instruction before the authority publishes membership and changes READY
to RUN. The authority rechecks continuation code and stack permissions before
publication. The caller parks while the kernel continues servicing other requests.
Failure, a 30-second startup deadline, caller signal/death, owner replacement or
invalid readiness cancels the gate and stops the worker. Cleanup waits for host
exit acknowledgement, unregisters the staged broker owner, and returns EAGAIN
(or EINTR for a queued caller signal) only to the original live caller. Late
readiness cannot target a reused lease. A failure after RUN is a worker failure,
not a failed clone that can be rolled back.

Syscall 60 records the low eight bits of that thread's supplied exit code. A
separate kernel syscall-completion value ends its worker loop after the Wasm
stack has unwound; it is not a new native step result or redirect. No subsequent
guest instruction runs. Transport/profile terminal status and guest exit code
are separate. Last-thread diagnostic metadata is not a Linux wait status;
wait4, process-group exit accounting and child reaping are still unimplemented.
Workers release slots only after host-confirmed termination.

The real fixture boots one host-created process. Guest MOV instructions supply
clone flags, syscall number and a high child stack; an actual translated SYSCALL
creates its second thread. Both execute the same guest continuation, store their
own clone return on their own guest stack and call exit. There is no
host-selected child instruction stream. The successful case executes 16 steps
across two workers: parent stores the child's TID, child stores zero. Same-low32
decoys remain untouched. Two additional real-worker cases remove the first
child continuation or terminate the child before readiness; each executes the
parent's 12 steps, publishes no child, returns EAGAIN and leaves no broker owner
or backing after cleanup. Synthetic kernel tests separately exercise complete
state inheritance, cancellation, deadline, stale owner/lease, capacity and
unsupported-profile behavior.

On Linux x86-64, a separately compiled native syscall oracle checks the same
flag combination, parent/child return values, separate high stacks and inherited
blocked mask. Other hosts explicitly skip that native oracle while still running
the actual FEX/Wasm fixture. This does not establish native FEX JIT, general
sparse Linux/Wine compatibility, WebKit worker retirement, device compatibility
or resident RAM savings. The existing adapted Wine nested CreateProcess test
runs the default runtime; it remains separate from both this clone fixture and
the failing stock Wine controls. Native memory/checkpoint/step/coverage ABIs
remain 1/1/2/2, so existing provenance-validated native assets remain reusable.
