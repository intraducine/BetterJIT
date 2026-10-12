# Execution coverage and remaining gaps

This inventory separates implemented mechanisms, tested samples, and unsupported
integration. It is not a statement that all x86 instructions, Linux applications,
Windows programs or graphics paths work. Source build identity and per-case
outcomes remain in the one device-session export.

| Area | Available mechanism and evidence | Next milestone / remaining limits |
| --- | --- | --- |
| Instruction translation | Fresh native FEX IR → Wasm; SysV/Win64 scalar, stack, memory, SSE2 and hot-region samples in the app. Historical device results apply only to their recorded source. | Host live Linux workload uses the same backend and promoted runtime. Full instruction, x87, AVX, exception and self-modifying-code coverage is not established by these samples. |
| Linux ABI / syscalls | ELF loader, address-space setup, Linux kernel worker, broad syscall implementation. Bundled libc-free ELF and service fixture. | Real musl/BusyBox shell exercises dynamic ELF loading, pipes, file copy/compare/rename/removal, exact SHA-256, a trapped self-signal and child exit status. Unknown/unsupported syscalls and Linux ABI edge cases remain visible failures/ENOSYS; no complete Linux compatibility claim. |
| Files / mapped memory / protection | Manifest-based root, symlinks/modes, guarded memory cases, mapped/copy transports, mmap metadata. HTTP range fallback now reads bounded pieces even without native channels. | Report fetched bytes/ranges and validate large-file bytes. mprotect return/readability is covered; enforcement of guest write faults/guard pages is not proven. Paging probes are prototypes, not extra resident-RAM entitlement. |
| Processes / threads / signals | Shared guest memory, worker threads, clone/fork/exec/wait, futex and signal machinery. | BusyBox includes a real multi-process pipeline, trapped USR1 and child exit-status check. The cloned-thread fixture does not prove every futex branch. The sampled signal does not establish general POSIX signal delivery; synchronous faults, Windows SEH and concurrent ordering require additional workload evidence. |
| Wine loader / runtime | Stock signed Alpine Wine 10.7-r0 and dependencies are bundled. App attempts cmd /c ver through both stock preloader and direct-loader paths with real FEX translation and checks exit/version. | Host attempts the same command after required Linux milestones and saves the actual outcome. No arbitrary Windows compatibility, successful device Wine run or persistent initialized Wine prefix is asserted. The direct-loader session explicitly routes Wine preloader child execs to the requested real Wine ELF and retains its original arguments. Stock Wine lacks the historical guest wasmdrv patch. |
| Transport / practical performance | Copied and mapped suites, live request counters, hot-region verification, bounded HTTP file ranges. | Host statistics measure translation, compilation and guest/VFS activity in this host configuration. Transport timings are not game speed or native-FEX ratios. Native-channel attachment alone remains unsupported coverage without successful requests. |
| Graphics | Host Metal renders/readbacks pixels; browser software compositor and optional GPU channel delegate exist. | No native DXMT implementation, guest command/resource contract or matching Wine driver is present. A complete DXMT/Metal presentation path is a separate integration; no guest/game rendering claim. |
| Apple / physical device | Prior unified app compiled for iPhone; macOS WKWebView checks distinguished JSPI skips. | Automatic app builds include the new workload and per-case live host evidence. No device report has been received. Node host FEX/Wasm success is not iPhone/WebKit execution evidence. |

Required host milestones: Linux ELF prints `BetterJIT Linux OK`; the libc-free
service workload prints `BetterJIT Linux services OK`; BusyBox runs a shell
pipeline and prints the exact SHA-256 of the bundled 256 KiB input plus
`BetterJIT userspace OK`. Each must exit 0 and observe native FEX translations
and compiled Wasm modules. Recorded Wasm and direct native x86 execution cannot
satisfy these milestones. Wine is attempted separately and its actual error or
success remains in `LIVE-LINUX-RESULTS.json`.

Host cases run in separate owned process groups with an external deadline watchdog.
Partial logs survive forced termination. Reused TIDs after exec retain their
replacement worker and all owned workers are closed at session end.

The Node host adapter loads `Sources/BetterJITLinux/Resources` kernel/thread/runtime
files directly. Native FEX constructs IR and Wasm via the constants-only backend;
it does not execute native FEX ARM64 JIT. Node's WebAssembly engine is host
execution evidence. Native OPFS channels and Apple WebKit require their own runs.

Automatic builds use only pushes to the active development branch (plus explicit
manual dispatch), filtered to relevant source/tool/test changes; no duplicate PR
build trigger is added. New pushes supersede stale running builds. Cached native
outputs bind FEX source, patch, build scripts, architecture and Xcode identity;
cache reuse does not replace fresh guest translation or correctness checks.

The direct-loader setting follows the bundled Wine 10.7 [loader source](https://github.com/wine-mirror/wine/blob/wine-10.7/dlls/ntdll/unix/loader.c). It is an experimental compatibility policy, not evidence that the preloader or arbitrary Windows applications work.

Observed live host checkpoint (`f61a6ea`, run `38292621515`): Linux services,
direct BusyBox hashing and the expanded userspace workload passed. A supervisor
cleanup race replaced the ELF result with Darwin `kill EPERM`; it was not a
guest failure. The stock Wine preloader trapped. Carrying direct loading through
children moved Wine into a later runtime path, then it trapped again without a
Windows version; the captured CPU state included `r12=0x140003c40` while Wasm
memory remained below 4 GiB. This is a concrete limit to investigate, not a proven
instruction-level root cause or evidence that arbitrary Wine is supported.
