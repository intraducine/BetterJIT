# Execution coverage and remaining gaps

This inventory separates implemented mechanisms, tested samples, and unsupported
integration. It is not a statement that all x86 instructions, Linux applications,
Windows programs or graphics paths work. Source build identity and per-case
outcomes remain in the one device-session export.

| Area | Available mechanism and evidence | Next milestone / remaining limits |
| --- | --- | --- |
| Instruction translation | Fresh native FEX IR → Wasm; SysV/Win64 scalar, stack, memory, SSE2 and hot-region samples in the app. Historical device results apply only to their recorded source. | Host live Linux workload uses the same backend and promoted runtime. Full instruction, x87, AVX, exception and self-modifying-code coverage is not established by these samples. |
| Linux ABI / syscalls | ELF loader, address-space setup, Linux kernel worker, broad syscall implementation. Bundled libc-free ELF and service fixture. | New real musl/BusyBox shell pipeline and file checksum exercise dynamic ELF loading, userland, pipes, processes and reads. Unknown/unsupported syscalls and Linux ABI edge cases remain visible failures/ENOSYS; no complete Linux compatibility claim. |
| Files / mapped memory / protection | Manifest-based root, symlinks/modes, guarded memory cases, mapped/copy transports, mmap metadata. HTTP range fallback now reads bounded pieces even without native channels. | Report fetched bytes/ranges and validate large-file bytes. mprotect return/readability is covered; enforcement of guest write faults/guard pages is not proven. Paging probes are prototypes, not extra resident-RAM entitlement. |
| Processes / threads / signals | Shared guest memory, worker threads, clone/fork/exec/wait, futex and signal machinery. | BusyBox pipeline is a real multi-process milestone. The cloned-thread fixture does not prove every futex branch. POSIX signal delivery, synchronous faults, Windows SEH and concurrent ordering require additional workload evidence. |
| Wine loader / runtime | Stock signed Alpine Wine 10.7-r0 and dependencies are bundled. App attempts cmd /c ver with real FEX translation and checks exit/version. | Host attempts the same command after required Linux milestones and saves the actual outcome. No arbitrary Windows compatibility, successful device Wine run or persistent initialized Wine prefix is asserted. Stock Wine lacks the historical guest wasmdrv patch. |
| Transport / practical performance | Copied and mapped suites, live request counters, hot-region verification, bounded HTTP file ranges. | Host statistics measure translation, compilation and guest/VFS activity in this host configuration. Transport timings are not game speed or native-FEX ratios. Native-channel attachment alone remains unsupported coverage without successful requests. |
| Graphics | Host Metal renders/readbacks pixels; browser software compositor and optional GPU channel delegate exist. | No native DXMT implementation, guest command/resource contract or matching Wine driver is present. A complete DXMT/Metal presentation path is a separate integration; no guest/game rendering claim. |
| Apple / physical device | Prior unified app compiled for iPhone; macOS WKWebView checks distinguished JSPI skips. | Next automatic app build includes the new workload and live host evidence. No device report has been received. Node host FEX/Wasm success is not iPhone/WebKit execution evidence. |

Required host milestones: Linux ELF prints `BetterJIT Linux OK`; the libc-free
service workload prints `BetterJIT Linux services OK`; BusyBox runs a shell
pipeline and prints the exact SHA-256 of the bundled 256 KiB input plus
`BetterJIT userspace OK`. Each must exit 0 and observe native FEX translations
and compiled Wasm modules. Recorded Wasm and direct native x86 execution cannot
satisfy these milestones. Wine is attempted separately and its actual error or
success remains in `LIVE-LINUX-RESULTS.json`.

The Node host adapter loads `Sources/BetterJITLinux/Resources` kernel/thread/runtime
files directly. Native FEX constructs IR and Wasm via the constants-only backend;
it does not execute native FEX ARM64 JIT. Node's WebAssembly engine is host
execution evidence. Native OPFS channels and Apple WebKit require their own runs.

Automatic builds use only pushes to the active development branch (plus explicit
manual dispatch), filtered to relevant source/tool/test changes; no duplicate PR
build trigger is added. New pushes supersede stale running builds. Cached native
outputs bind FEX source, patch, build scripts, architecture and Xcode identity;
cache reuse does not replace fresh guest translation or correctness checks.
