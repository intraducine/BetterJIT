# Experimental guest storage: Slice A

`Sources/BetterJITLinux/Resources/linux/guest_memory.js` exports
`BetterJITGuestMemory` with storage-contract version 1. This module is not loaded
by the default runtime. The existing kernel, translator, thread workers and
public execution configuration are unchanged.

[B1 broker and native diagnostic](sparse-memory-broker.md) defines the next
executable contract and its remaining integration gates. The default execution
path remains unchanged.
The [B2 scalar execution slice](sparse-execution.md) now connects that contract
to admitted native FEX instructions in an explicitly selected host fixture.

The module stores real 4 KiB byte pages behind guest virtual mappings. Address
arguments and returned virtual addresses use BigInt; signed Wasm i64 inputs
retain their unsigned 64-bit bit pattern. A separate configurable virtual limit
defines the accepted window. No guest address is used as an array-buffer offset
or a native pointer.

`BackingBudget` limits owned page payload bytes across its address spaces and
shared objects. Its counters include unique private/shared frames, references,
allocation attempts, failures and high-water payload bytes. These counts exclude
mapping/object overhead and caller-owned read/copy result buffers. They do not
measure engine reservations, garbage collection or resident RAM. `allocatePage`
allows deterministic failure injection; pages must use fixed ArrayBuffers.
SharedArrayBuffer wrappers can conceal shared data-block identity and are
rejected. Duplicate live buffers are rejected before initialization, including
duplicates offered to different budgets. Canonical sharing occurs through the
broker-owned backing object, not through independent shared-buffer wrappers.

`GuestAddressSpace` supports:

- `reserve`, `mapAnonymous`, `commit`, `protect`, `decommit` and `unmap` with
  page-aligned intervals. A PROT_NONE reservation has metadata without data
  frames. Protecting committed bytes to NONE preserves their frames and data;
  decommitting private pages discards them. A fresh anonymous mapping is zeroed.
- Checked `read`, `write` and `copy`. Every touched mapping/page and requested
  permission is checked before effects. Copy has explicit memmove snapshot
  semantics; it does not implement x86 REP fault/restart semantics.
- Canonical `SharedBacking` aliases and private views that copy on first write.
  Mappings retain a shared frame independently of the canonical object's handle.
  Closing the handle prevents new mappings while existing aliases remain live.
  Backing references are released exactly once by unmap/close.
- `fork` with eager committed-private copies and retained canonical shared/view
  identities. Reserved holes have no copied payload. Backing allocation failure
  during map replacement, commitment, protection, detachment or fork releases
  staged frames/references and preserves the previous address space.
- Read-only mapping identity and statistics snapshots. Read results are copies;
  callers cannot obtain the underlying storage bytes through this API.

Mapping permissions are explicit READ/WRITE/EXEC bits. Architecture-specific
Linux protection normalization belongs to the future syscall integration.
Shared/view decommit is explicitly unsupported rather than silently becoming a
fresh private mapping. Shared backing objects describe byte storage here; file
EOF, SIGBUS, device mappings, and file-I/O visibility are not yet implemented.
The budget must be shared by spaces and objects that alias each other's frames.

`futexIdentity` is only a checked identity operation, not a wait/atomic API.
PRIVATE keys contain address-space identity plus the full guest VA: different
VAs in one space remain different PRIVATE futexes even if they alias one frame.
Canonical shared keys contain backing-object identity, object page and byte
offset. Actual compare-and-enqueue, wait, wake and atomic operations remain
future broker work.

## Deterministic evidence

`node --test tests/sdk/linux-guest-memory.test.mjs` executes the actual storage
implementation and byte operations under deterministic payload budgets. It
tests three distinct live address spaces at the same high address, wide pointer
bits, sparse reservation holes, nonadjacent cross-page backing, full bounds and
permission checks, protection retention, decommit/remap zeroing, shared alias
coherence and lifetime, fork copies, private-view detachment, allocation rollback
and futex key distinctions. It does not run FEX, Wasm guest instructions or a
phone and supplies no RAM-saving claim.

## Required gates for the bounded FEX integration

The reviewed next slice must use a dedicated non-signalling memory dispatch.
The existing syscall `kcall`/`attempt` path may redirect workers or deliver
signals while guest registers remain Wasm locals; reusing those semantics is
unsafe. Infer address space from the authenticated thread slot. Return separate
MEM_OK, MEM_FAULT and MEM_UNSUPPORTED status plus data, with 64-bit values and
fault metadata in internal per-thread scratch. A loaded value is never an error
sentinel. Deliver asynchronous signals only at explicit instruction boundaries.

Start with one supported guest instruction per unit and a full pre-instruction
architectural checkpoint including lazy flags. Disable regions, inlining and
ABI state pruning. Guest-instruction metadata must be enabled independently of
the existing memtrace-dependent DebugGuestInstructions switch. Reject uncovered
memory opcodes, multiple-effect and restart-sensitive instructions explicitly.
Validate effective VA, folded displacement, FS/GS and every touched page before
effects; `Wrap` also handles branch targets and lengths and cannot be globally
replaced. Bypass old `syncShared` copies and worker-local futex/clock shortcuts.

`translator.cpp` currently fixes Linux `Cfg.MemMaxPages` at 65536. The next mode
must agree on a genuinely small internal Wasm maximum and move the 2 MiB thread
block out of guest VMAs (`allocTb`). Guest limits remain independent of this
internal memory. Native `FexHost` already keeps copied code in guest-keyed sparse
vectors; preserve that design, full uint64_t RIP/VA and copied code payloads.
Never reinterpret a guest VA as a native pointer.

All reference reads/writes/atomics use one broker authority. Compare-and-enqueue
must be atomic and waits must not block the kernel worker. Mutable executable
aliases and concurrent code remapping may remain explicit unsupported cases in
the initial bounded fixture; later invalidation follows canonical backing across
all aliases. A versioned memory ABI/cache identity and actual translated
parent/child/grandchild execution with barriers, exact pointers/sentinels,
register/fault state, atomics and futex isolation are required before claiming
that later milestone. The stock-preloader investigation remains paused.
