# Experimental guest fork, wait and exit

Host capability `sparseLifecycleVersion: 2` extends the version-1
[clone/exit profile](sparse-clone.md) with guest fork (57) and bounded wait4 (61).
The startup/termination callbacks and exact-lease gate remain unchanged. Step and
coverage versions are 3/3, with [finite guest continuations](sparse-control-flow.md).
Version 1 does not admit these new syscalls. No default/browser policy changes.

Fork requires a single live process-leader thread, an empty descriptor table,
default signal dispositions/flags, no pending signals, SIGCHLD unblocked and no
unreaped child. The inherited stack must satisfy the private writable aligned
stack bound. The empty-fd rule avoids claiming descriptor lifecycle not yet
implemented by this profile. Other blocked signals are inherited. Ignored/caught
SIGCHLD, NOCLDWAIT, blocked SIGCHLD, multithreaded fork, orphan/reparent behavior,
vfork and exec remain unsupported before effects.

The authority reserves a PID/context, transactionally forks committed guest
storage, and prepares a new Process and independent CPU/scratch memory. Private
pages, including private RX snapshots, are copied; canonical shared backing is
retained. CPUState/lazy flags/rounding state and the calling blocked mask are
copied after the syscall spill, with child RAX zero and inherited RSP. Cwd,
umask, process group/session, argv/exe diagnostics, limits and default actions are
copied. Both processes may use the inherited immutable translation catalogue;
guest-memory authority is bound to their distinct address spaces. This creates
no new image and does not implement an ELF loader or exec generation protocol.

No process, parent-child relationship or runnable thread is published before
worker READY and the authority's code/stack/owner checks. Parent receives the
published child PID. Allocation failure returns ENOMEM with no unpublished
frames; worker-start failure returns EAGAIN only after termination/absence is
acknowledged. Cancellation retains the copied address space until that
acknowledgement. Existing eight-context accounting includes cancelled attempts.
Fork-created processes remain single-threaded in this profile; further thread
clone is refused, and a parent must reap its child before guest exit. These are
declared restrictions, not general Linux requirements.

Wait admits a specific positive signed-32-bit child PID, options zero, NULL
rusage and an optional full-width status pointer. No wait-any, WNOHANG, stopped,
continued or resource-usage semantics are claimed. An unrelated or already
reaped PID returns ECHILD. Parent may park while the authority services other
requests. Completion requires a normal guest exit and actual host termination
acknowledgement. Worker/profile failure is not fabricated into a Linux wait
status. A queued caller signal returns EINTR without reaping; signal frames and
restart still remain unsupported. Exact thread/process/MM and child identities
prevent stale wait completion from mutating a replacement owner.

Normal status is the child's eight-bit exit code shifted by eight. Reaping
removes the parent-child relationship, retains bounded diagnostic records and
closes guest storage only after workers have terminated. **Status-copy EFAULT
still reaps the child**; a repeated wait returns ECHILD. This corrects the saved
proposal's zombie-preserving assumption: pinned [Linux v6.12 kernel_wait4](https://github.com/torvalds/linux/blob/v6.12/kernel/exit.c#L1743) calls do_wait
before copying status. The independent native Linux oracle confirms EFAULT then
ECHILD. Copyout allocation/protection/range faults leave destination bytes
unchanged, while preserving that irreversible reaping order. No whole-syscall
rollback is claimed.

The real FEX/Wasm program boots one host-created initial process. Guest MOVs
supply fork, CMP/TEST/JZ select child and parent paths, child writes private and
canonical shared sentinels and exits 23, and parent calls wait4 then observes
status 0x1700, shared data, distinct private bytes, and ECHILD on repeated wait
before exiting 17. It executes 39 steps across two processes/workers. Host test
scheduling holds the child at a safe boundary until the parent actually parks;
the guest still chooses all instruction paths and issues all lifecycle syscalls.
Two real worker-start failures take a guest error branch and exit 31 after 11
steps, with no child publication. A fourth actual guest case supplies a bad
status pointer and verifies EFAULT/ECHILD, private/shared state and cleanup.

Native Linux x86-64 separately checks fork isolation, shared visibility, mask
inheritance, default/unblocked SIGCHLD, encoded status, repeat wait and status
EFAULT reaping. Apple hosts explicitly skip this independent native oracle while
running the actual FEX/Wasm cases. Synthetic kernel tests also cover partial
allocation rollback, delayed acknowledgement, unsupported policy, copyout
allocation/faults, stale identities, interrupted wait and failed workers.

General descriptor I/O, strings/vectors, ELF/exec, broader process/signal/clone
semantics, WebKit sparse retirement, device compatibility and resident RAM
savings remain unproven or unsupported. Default adapted Wine tests and failing
stock Wine controls remain separate evidence.
