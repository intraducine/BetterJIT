# Runtime diagnostic matrix

The FEX Host now has a second harness for architecture-level diagnostics. The existing baseline/full/extended suites remain regression coverage. Diagnostics are intended to answer larger questions in one device run and use fresh sessions so one failure does not poison later probes.

Presets: Quick, Runtime Core, Transport, Memory / Paging, Threads, Wine Readiness, Graphics Readiness, and Full Diagnostic Matrix. Full runs 26 safe probes. The optional stress toggle adds a 512 MiB Wasm allocation/touch probe and a 1 GiB logical OPFS paging probe; stress is intentionally excluded by default because it can trigger thermal or WebContent memory pressure.

The report records PASS, FAIL, UNSUPPORTED and SKIPPED separately. Missing Wine/DXMT functionality is UNSUPPORTED rather than a fake pass.

Current probes include native mmap/mprotect, app-container file I/O, native concurrency, WebKit feature inventory, copied vs mapped service round trips up to 1 MiB with a direct A/B summary, Wasm memory growth, synchronous OPFS throughput, a bounded software pager, SharedArrayBuffer/Atomics workers, compiled Wasm module cloning, live SysV/Win64 FEX, SSE2, hot-region installation, a minimal synchronous Linux syscall subset, repeated session lifecycle, Metal command submission, and Wine/DXMT readiness gates.

The minimal FEX syscall subset deliberately covers only getpid, gettid, sched_yield, time, write-to-log semantics already available in the runtime fallback, with unknown calls returning -ENOSYS. It is not yet sufficient for Wine. The Wine readiness result remains UNSUPPORTED until a broad syscall/VFS/mmap/signals layer and Wine loader/rootfs are integrated.

Every diagnostic report is checkpointed and shareable as JSON. User toggles for Home Screen/no-debugger and offline status are recorded but not independently verified.
