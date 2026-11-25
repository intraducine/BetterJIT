# Runtime diagnostic matrix

The FEX Host now has a second harness for architecture-level diagnostics. The existing baseline/full/extended suites remain regression coverage. Diagnostics are intended to answer larger questions in one device run and use fresh sessions so one failure does not poison later probes.

Presets: Quick, Runtime Core, Transport, Memory / Paging, Threads, Wine Readiness, Graphics Readiness, and Full Diagnostic Matrix. Full runs 28 safe probes. The optional stress toggle adds a 512 MiB Wasm allocation/touch probe and a 1 GiB logical OPFS paging probe; stress is intentionally excluded by default because it can trigger thermal or WebContent memory pressure.

The report records PASS, FAIL, UNSUPPORTED and SKIPPED separately. Missing Wine/DXMT functionality is UNSUPPORTED rather than a fake pass.

Current probes include native mmap/mprotect, app-container file I/O, native concurrency, WebKit feature inventory, copied vs mapped service round trips up to 1 MiB with a direct A/B summary, Wasm memory growth, synchronous OPFS throughput, a bounded software pager, SharedArrayBuffer/Atomics workers, compiled Wasm module cloning, live SysV/Win64 FEX, SSE2, hot-region installation, a minimal synchronous Linux syscall subset, repeated session lifecycle, Metal command submission, and Wine/DXMT readiness gates.

The minimal FEX syscall subset deliberately covers only getpid, gettid, sched_yield, time, write-to-log semantics already available in the runtime fallback, with unknown calls returning -ENOSYS. It is not yet sufficient for Wine. The Wine readiness result remains UNSUPPORTED until a broad syscall/VFS/mmap/signals layer and Wine loader/rootfs are integrated.

Every diagnostic report is checkpointed and shareable as JSON. User toggles for Home Screen/no-debugger and offline status are recorded but not independently verified.

The Runtime Core preset checks a small Win64 function. It compares the original call, a call after writing replacement bytes to the same guest address, and a call in a fresh session seeded with the replacement. Both calls with changed code must return the updated result. Call timings exclude session setup and guest writes.

The Win64 call boundary check compares 64 Swift-to-WebKit calls with a single
call that runs the same 64 dependent additions inside the guest. The test checks
results, alternates the measurement order, and records warm timings and translation
requests during the samples. It measures call overhead for a small fixture.
Launch with `--fex-bridge` or `--fex-mutation` to run just one of these diagnostics
and print its result to the device console.
