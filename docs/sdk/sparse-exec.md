# Experimental static ELF exec

Host capability `sparseLifecycleVersion: 3` adds guest `execve(59)` to the
[bounded fork/wait profile](sparse-fork.md). Only initial bootstrap creation and
worker provisioning are host operations: the running guest supplies the path,
argv and envp pointers, selects the executable file and executes its new entry.
The default Linux/Wine runtime is unchanged. This is a Node reference profile;
WebKit sparse worker retirement and device compatibility remain unimplemented.

The host loads `guest_image.js` after guest storage, supplies an
`ExecutableStore` as `sparseExecutables`, and implements `spawnSparseThread`,
`stopSparseThread` and `dropSparseSpace`. Secure `crypto.getRandomValues` must be
available. Versions 1 and 2 still refuse exec before effects. Native memory and
checkpoint ABIs remain 1/1, step and coverage remain 3/3 with 96-byte headers.
Existing compatible native assets can be reused without a native rebuild.

## Files and arguments

`ExecutableStore` copies regular-file bytes at construction and returns fresh
snapshots. Its namespace consists of canonical absolute UTF-8 paths and implied
directories. It has no host filesystem fallback, symlinks, mount traversal,
relative paths, credential model, writable files or descriptor operations.
Executable permission requires at least one execute bit; mode bits are limited
to 0777, so there is no set-ID transition. Missing paths, directories and denied
execute permission return ENOENT/EACCES. This rule is an explicitly limited
filesystem model, not Linux UID/GID permission emulation.

Path, argv and envp reads use the authenticated spilled caller and full 64-bit
pointers. C strings stop at NUL within each page without reading a following
unmapped page. Paths/strings are limited to 4096 bytes including NUL; each vector
has at most 1024 entries and argv must be nonempty. NULL envp is accepted. The
combined argument/environment string bound is 128 KiB including terminators.
These are profile bounds, not claims about Linux's maximum argument allowance.
Raw argument/environment bytes survive; only the executable path requires UTF-8.
Pointer faults return EFAULT before any image publication.

## Image and stack

The loader accepts static ELF64 little-endian x86-64 ET_EXEC files up to 1 MiB,
with at most 16 program headers. PT_LOAD pages must be distinct and 4096-aligned,
readable, and R, RW or RX. W+X, dynamic linking, interpreters, PIE, shebangs,
other segment types, overlapping loads and unsupported alignments refuse with a
typed unsupported result. PT_NULL and a RW/non-executable GNU_STACK are accepted.
Mapped program headers must lie in a read-only data load; entry must lie in
file-backed executable bytes. File, memory, table and pointer spans are checked
as BigInts before conversion to bounded byte offsets. Malformed images return
ENOEXEC. Mapping payload, including stack, is bounded to 32 MiB and the shared
backing budget also applies during preparation alongside the old image.

A fresh address space shares the budget/window, never the old mappings. Load
bytes are copied, BSS and page tails zeroed, and final protections installed.
The stack is 256 KiB RW near the top of the low-canonical window with an unmapped
page below. RSP is 16-byte aligned; argc, argv, envp and their terminators contain
full 64-bit pointers. The deliberately small auxv supplies PHDR, PHENT, PHNUM,
PAGESZ, ENTRY, 16 fresh AT_RANDOM bytes and AT_NULL. Missing auxv entries,
credentials, vDSO, ASLR and general libc/program startup remain outside this
profile. The stack shape and zero-fill rules are checked against
[Linux v6.12 create_elf_tables/elf_load](https://github.com/torvalds/linux/blob/v6.12/fs/binfmt_elf.c).

## Replacement and ownership

Exec requires a single live leader, empty descriptor table, default signal
actions/flags, no pending signals, no unreaped children, and no clear-TID,
robust-list or alternate-stack state. Broader Linux exec cleanup is refused
before effects. The blocked mask and process identity/parent relationship
survive. The replacement CPU starts from the host's fresh native state, with the
ELF entry and prepared RSP, rather than inheriting old registers or lazy flags.

The replacement gets a new internal memory, broker lease, slot and monotonically
allocated native code catalogue. The worker prepares its first translated module
before publishing exact-lease READY. Its separate 96-byte admission mailbox is
never a guest Wasm import. The authority parses the same header contract as the
worker, validates finite continuations and compares raw instruction bytes to the
immutable RX mapping at startup and every BEGIN. New-image instructions are
translated on demand at the guest-selected RIP; there is no host-selected target
instruction sequence or persistent per-image plan cache.

Before requesting old-worker stop, preparation failures retain the old image:
resource/startup failures return ENOMEM/EAGAIN, and declared profile limitations
restore the complete pre-SYSCALL CPU/lazy/round snapshot and return typed
UNSUPPORTED, not an errno or guest success. A cancelled replacement retains its
broker/storage/catalogue until actual worker termination or confirmed absence.
A timeout requests exact-lease stop; it never fabricates acknowledgement.

Requesting old-worker stop is the irreversible boundary. Only after its ACK does
the authority publish the new mm/context under the same PID/TID, close the old
image and release RUN. The old worker cannot return from successful exec. Failure
after stop is fatal to the exec attempt; both workers must drain before storage
release, and no errno continuation or normal guest wait status is fabricated.
This boundary follows the need for fatal handling after Linux's
[begin_new_exec point of no return](https://github.com/torvalds/linux/blob/v6.12/fs/exec.c#L1222),
without claiming complete Linux fatal-signal or multithreaded exec semantics.

The Node host owns every native request by worker/lease/catalogue. ACK requires
actual worker exit **and** all native translation/upload promises to settle;
late replies are discarded. A queued request cannot recreate a namespace after
it is dropped. Native catalogue references survive fork; cancellation/reaping
release them only after ACK, and the last image owner queues `dropSparseSpace`.
IDs are bounded to uint32 and never wrap. Eight internal contexts includes old
images and cancelled startup attempts; this does not demonstrate constant RAM.

## Reproduction and evidence

Run storage/authority tests with `node --test tests/sdk/linux-guest-image.test.mjs
tests/sdk/linux-sparse-exec.test.mjs`. Run actual native execution separately:

```
node tests/sdk/linux-host/sparse-exec.cjs /path/to/fexserve /tmp/sparse-exec.json
```

The initial guest forks PID101. Its child executes `/bin/second` with argc2,
argv1 `abcDEFg` and env `K=VALUE`. The ELF checks those values, argv NULL and BSS,
then exits37. The parent receives PID101/status0x2500 and exits17. The successful
case executes55 actual FEX/Wasm steps across three worker generations and two
process identities. Separate missing-file, malformed-file and two terminated
startup cases execute28 steps each and follow the old guest errno path. One
startup is terminated while a real native request is pending; ACK follows its
drain. An unsupported entry restores pre-exec state, emits typed UNSUPPORTED and
aborts the fixture explicitly, without a successful child/parent exit claim.
On Linux x86-64, the identical ELF also runs as an independent native process and
exits37; Apple explicitly skips that Linux-only oracle while still running the
actual FEX/Wasm path. All fixture workers are acknowledged before image cleanup.

Descriptor I/O/inheritance/CLOEXEC, mutable executable files, wider Linux ELF and
auxv support, interpreters/dynamic linking, general process/signal semantics,
WebKit lifecycle, Wine compatibility, device behavior and resident RAM remain
unproven. This work makes no stock Wine or DXMT claim.
