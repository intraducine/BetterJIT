# Architecture, evidence and next integration boundary

## What the supplied description establishes

The described approach keeps the translator native, emits Wasm rather than ARM64, executes the guest in WebKit, and transports guest graphics commands to a native DXMT component through OPFS-backed storage. This is architectural information supplied by the user, not source code or an independently reproduced benchmark.

It does not grant native JIT permission to Iridium/Madeira. A working implementation would replace substantial backend, memory, Linux/Wine and graphics-thunk machinery. An entitlement toggle or a wrapper around the existing ARM64 code generator cannot implement it.

## Prototype path

```text
Native app                                 WebKit WebContent / worker
----------                                 ------------------------
restricted x86 fixture -> Wasm bytes  --->  WebAssembly.instantiate
                                           execute bounded translated loop
                                           OPFS sync handle read/write helpers
app-owned OPFS file <-------------------->  same backing file
    bounded MAP_SHARED windows
    validate input / transform / reply --->  read and verify transformed payload
```

The Wasm module has i64 integer registers and imported `guest.load64(i64)` / `guest.store64(i64,i64)` operations. The host keeps guest addresses as `BigInt` until checked conversion to a precisely representable file offset. Memory accesses into the transport header or outside the existing file are rejected. No arbitrary native address is exposed.

The translator accepts REX.W MOV-immediate, register MOV/ADD/SUB/XOR/IMUL, ADD/SUB accumulator imm32, and absolute accumulator loads/stores. It sign-extends imm32 and wraps integer arithmetic modulo 2^64. Flags are not modeled; all flag-consuming/control-flow instructions are rejected. RET terminates a fixture and does not emulate a stack pop. This restricted machine model cannot run arbitrary x86 functions. Unsupported bytes stop translation, rather than silently falling back or being miscompiled.

## OPFS ownership and lifecycle

One worker owns one sync access handle for one random session. Native only searches `Library/WebKit` and `Library/Caches/WebKit` under its own container, with time/entry budgets, a matching filename and a marker checked through an opened descriptor. Symlink files and hardlinks are rejected. It never creates a substitute file or expands a file behind WebKit's back.

The worker writes a complete payload, then posts a sequence-numbered request containing only the offset, length and checksum. Until the native reply, that range belongs exclusively to native code. Native validates, maps a bounded window, checks the input, transforms it, unmaps/closes, then replies. The worker reads and verifies every transformed byte. This is serialized ownership, **not a lock-free ring**. Neither `Atomics` nor file locks are presented as cross-process guarantees.

A one-time OPFS `flush()` publishes the initial marker. The timed exchange does not use per-message `fsync`/`msync`. Whether mapped writes and OPFS reads provide the expected coherence on a particular iOS build is exactly what the checksum test measures. File growth occurs through OPFS with no native mapping outstanding. A timed-out native call retains its backing file rather than truncating a possibly mapped file. A crash/watchdog may leave test storage; relaunch/clear app data only after no probe is running.

The initial Wasm module is small and uses base64 over the control bridge. That is a bootstrap convenience, not a claim that production code-cache transfer should use base64. Bulk payloads use the OPFS path.

## Memory claim: three distinct quantities

1. **Wasm linear memory:** the addressable ArrayBuffer-backed memory of a Wasm instance. An OPFS file cannot be substituted for it using the standard public constructor.
2. **Guest logical address space:** translated i64 loads/stores can call helpers that access file offsets outside that linear memory. This allows a larger *logical* address space without allocating a same-sized Wasm buffer.
3. **Resident memory / process budget:** WebContent, the app, the OS file cache, mappings and graphics resources still consume resources. A sparse high-offset success says nothing about how many GiB can remain resident before memory pressure or jetsam.

There is no assumed universal “WKWebView = 2 GB” limit in the probe. The default linear-memory check grows only to 1 MiB with a 64 MiB declared maximum, explicitly leaving the process limit unmeasured. The optional test creates a logical file just beyond 2 GiB and touches only tiny windows; storage quota may reject it independently of RAM availability. It never bypasses WebKit's quota accounting with native `ftruncate`.

## What to build after a physical-device transport pass

The next integration unit should be **one real FEX IR block**, not Wine startup:

- Pin the intended Madeira/FEX revision and add a Wasm lowering backend at its existing IR/backend boundary. Keep FEX's native decoder and optimizations. Replace the disposable Swift fixture, rather than claiming it is FEX integration.
- Define a versioned CPU-state/block-exit ABI: registers, flags, vector state, guest RIP, traps, syscall/thunk exits, instruction/page invalidation and code-cache ownership. Differentially test individual IR operations against a reference execution path before linking blocks.
- Implement a bounded Wasm linear-memory hot-page cache with checked slow paths to the external backing store, or another measured memory design. Per-load JS/OPFS calls are a correctness baseline, not a credible high-performance endpoint. Test unaligned accesses, page crossings, atomics, aliasing, faults, executable-page invalidation and guest multithreading explicitly.
- Establish a batched, versioned graphics-command ABI with handles and validated ranges rather than native pointers. Initially test a native Metal clear/present response before porting DXMT thunks. Shader conversion and rendering can remain native, but this repository does not yet implement that path.
- Only then connect the emulated Linux syscalls/rootfs, Wine and the target game. Measure compile/warmup time, CPU execution, memory helpers, transport, native graphics and displayed frames separately.

## Primary sources checked for the design

- [WebKit: File System API / OPFS](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/): origin-scoped storage, worker sync access handles, explicit read/write operations, and warning that entries need not have externally usable filesystem paths.
- [WHATWG File System Standard](https://fs.spec.whatwg.org/): the supported API and locking model; not a native mapping or cross-process JS atomics API.
- [WebKit FileSystemStorageHandle.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/storage/FileSystemStorageHandle.cpp): the inspected upstream implementation opens a backing file and constructs a shared file handle for sync access. This explains why the experiment is plausible; it is not a stable API commitment for the user's shipping iOS build.
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), particularly 2.5.1, 2.5.2, 2.5.6 and 4.7.2. Public WebKit execution does not settle all review questions. Native API exposure and relying on undocumented storage layout need review; no approval or legal conclusion is implied.

Reviewed 2026-09-25. No supplied private source from the other developer has been copied into this repository.
