# WasmProbe findings — x86 → wasm → JSC JIT inside WKWebView, for Madeira on the App Store

Measured on an iPhone 18 Pro (iPhone19,2, iOS 27.0 24A437, 6 cores, 11.5 GB), 2026-09-24.
The app is unentitled unless noted, with no debugger attached (App Store conditions).
Raw logs are in `results/*.log`, one `@@R {json}` line per measurement.

## Headline

- **JSC's wasm JIT output is close to native.**
  - Clang-compiled C: 1.11× native (geomean).
  - FEX-style translated blocks with table dispatch: 3.2–3.5 ns/block, against 2.7–3.4 ns/block native.
  - JSC's own interpreter (in-app JSContext, no JIT) is 11.7× slower than native.
- **It is not a pass-through.** You cannot hand JSC arm64. FEX would need a wasm backend that emits from its IR. JSC then recompiles through IPInt → BBQ → OMG (B3). See `results/omg_vs_native_block3.txt`: OMG emits 72 instructions where clang emits 58 for the same block.
- **Real x86-64 code through our FEX IR → wasm backend runs on the iPhone** (run41, 2026-09-25).
  - 22 guest kernels: CoreMark, Box2D v3, and C kernels. All match native bit for bit.
  - Geomean 1.43× native; the original 13 kernels are at about 1.0×.
  - CoreMark 1.50×. Box2D 1.9–2.3× on short runs (1.6–2.1× on the Mac's longer runs).
  - Guest threads (Box2D's scheduler) run on Web Workers with shared modules. Win64-ABI builds run as well.
- **The blockers are architectural, not code quality:**
  - Around 2 GB of resident memory before WebContent is killed, and app entitlements do not change that. Software paging to the app over a shared OPFS file works around this (see below).
  - A separate process: about 40 µs per synchronous round trip over WebKit messaging, or about 3 µs over the shared OPFS file.
  - x86 semantics are expensive in wasm: TSO atomics, flags, faults/SEH, page protection.
  - The JIT pool fills and silently falls back to the interpreter.

## Real x86-64 through a FEX fork: FEX IR → wasm (`~/Documents/wasm-jit/fexwasm`)

**Pipeline**
- FEX's frontend, opcode dispatcher and IR passes do the translation. On the `wasm-backend` branch of `~/Documents/wasm-jit/FEX`, the only changes are macOS build guards and an opt-in "flags are dead at call/ret" rule in the dead-flag pass.
- A new backend, `fexwasm/src/backend.cpp`, lives outside the FEX tree and lowers the IR to wasm:
  - One wasm function per FEX unit.
  - Structured control flow using Ramsey's dominator-tree algorithm.
  - Guest registers as locals; lazy flags.
  - SSE mapped onto SIMD128.
  - A wasm hash-table dispatcher.
- The guest is `kernels.c` compiled by clang for x86-64 Linux (`guest/build_guest.sh`).
- The units were translated ahead of time on the Mac (`fexrun --dump`) and replayed in WKWebView (`w:fexkernels`).

iPhone 18 Pro results (run34, 2026-09-25); all 18 checksums match. run28 is the previous day's backend; "first backend" is run22:

| kernel | native arm64 | x86-64 via FEX→wasm | ratio | run28 | first backend |
|---|---:|---:|---:|---:|---:|
| intmix | 19.1 ms | 12.5 ms | 0.66 | 0.71 | 0.79 |
| sieve (SSE) | 7.0 | 5.8 | 0.82† | 1.12 | 1.03 |
| qsort (recursive) | 41.3 | 48.3 | 1.17 | 1.16 | 1.17 |
| hash | 8.6 | 8.7 | 1.01 | 1.02 | 1.00 |
| ptrchase (SSE) | 12.5 | 16.2 | 1.30 | 1.44 | 1.30 |
| memcpy (`rep movsb`) | 4.7 | 4.4 | 0.95 | 0.96 | 0.93 |
| crc32 (SSE) | 28.3 | 33.5 | 1.18 | 1.48 | 1.49 |
| tree | 18.2 | 23.5 | 1.29 | 1.96 | 2.00 |
| matmul (SSE float) | 3.5 | 3.5 | 1.00 | 1.00 | 1.00 |
| nbody (SSE double) | 6.7 | 8.2 | 1.23 | 1.61 | 2.52 |
| calls (call/ret micro) | 8.1 | 8.2 | 1.01 | 1.76 | 9.46 |
| switch (jump-table micro) | 13.3 | 4.7 | 0.35 | 0.36 | 3.02 |
| interp (jump-table interpreter) | 11.2 | 22.9 | 2.04 | 2.83 | 17.6 |
| vcall (indirect calls, 4 targets) | 6.8 | 8.1 | 1.19 | 3.14 | — |
| fib (recursion) | 1.5 | 4.6 | 3.09 | 7.54 | — |
| rswitch (random jump table) | 13.4 | 69.5 | 5.18* | 5.36 | — |
| walk (recursion, asm) | 1.4 | 6.2 | 4.34 | — | — |
| **CoreMark 1.0** (2000 iterations) | 33.2 | 51.4 | **1.55** | — | — |

Geomean: original 13 kernels **1.90× (first) → 1.20× (run28) → 1.01×**. All 18: **1.32×**. Intermediate device runs on the same day:

| run | original 13 | all 18 |
|---|---:|---:|
| run31 (register arguments) | 1.14 | 1.54 |
| run32 (call inline cache) | 1.13 | 1.49 |
| run33 (structured regions) | 1.06 | 1.40 |
| run34 | 1.01 | 1.32 |

† This run's native sieve (7.0 ms) is slower than usual (5.1–5.4 ms), so the true ratio is about 1.15.

\* rswitch: native arm64 clang turned the switch into branchless `csel` code, while the x86-64 guest has a real, unpredictable jump table. A random 11-way jump table costs about 13 ns per dispatch in native C on an M-series Mac as well; JSC's `br_table` (13 ns) is at parity. So this ratio reflects different code, not translation overhead.

walk is a hand-written recursive tree walk in which the skip-the-call branch is an indirect jump. That makes the call's return address also a jump target in another unit, which stresses region forming.

**Box2D v3 (a real game physics engine, 36K lines of C).** `guest/box2d` holds Box2D at commit 956ce4e, built as a freestanding x86-64 guest (SSE2, `-ffp-contract=off`, libc stubs, a pooled allocator) and natively for arm64 (NEON) with the same deterministic setup. Box2D is designed for cross-platform determinism, so the world state hash is the correctness check:
- The x86-64 build agrees with arm64 on macOS (native, and x86_64 under Rosetta) and after translation on the Mac.
- On the iPhone (run35), all four scenes match bit for bit.

| scene (steps) | iPhone native | FEX→wasm | ratio | Mac, longer run |
|---|---:|---:|---:|---:|
| large pyramid (30) | 37.4 ms | 74.7 ms | 2.00 | 1.64 (100 steps) |
| tumbler (60) | 15.2 | 50.6 | 3.33 | 1.83 (300) |
| joint grid (20) | 38.8 | 99.4 | 2.56 | 2.31 (100) |
| rain (100) | 56.7 | 142.2 | 2.51 | 2.67 (300) |

Short runs include compiling and tier-up. For reference, Rosetta runs the x86_64 build at 1.12–1.36× native on the same Mac.

Box2D exposed things the kernels hadn't:
- **`ucomiss` + FEX's `AXFlag`.** This was lowered through a run-time flag kind, so the branch after every float compare called the generic flag helper (13% of the time). Now it's the direct `axflag` definition: joint grid 4.0× → 2.5×, rain 4.4× → 2.9×.
- **Conditional compares** (`ccmp`) are materialised inline for the same reason.
- **Calls.** The solver calls `b2SolveJoint` per joint, and a call costs about 40 ARM64 instructions: JSC's frame setup and callee-saved registers, a cross-instance switch, and argument and result moves.

The remaining gap is spread out:
- Call overhead.
- Register pressure in big regions (spills).
- `tbl` shuffles that B3 can't pattern-match.

**FEX running on the iPhone: live translation (run42, run43).** FEX's frontend and our backend are now linked into the app and translate as the guest runs. Nothing is prepared on the Mac anymore except the guest image.
- **Build.**
  - FEXCore for iOS: CMake's iOS support with `CMAKE_SYSTEM_PROCESSOR=aarch64`, no LTO, no assertions (`fexwasm/build_ios.sh`).
  - The backend, the FEX host and a C API (`fexwasm/src/translator.h`) go into `libfexwasm.a`. The app links it with FEX's archives.
  - FEX never JITs here, so nothing executable is allocated in the app.
- **Guest code needn't sit at its x86 address.** A hook in FEX's decoder (`FEXCore::Frontend::GuestCodeSource`, the same split the vsyscall page uses) reads instruction bytes from a host buffer while guest addresses keep their meaning. The Mac tools use it too, so no fixed guest mapping is needed anywhere.
- **Protocol** (`Web/fexlive.js`, `runtime.js` async mode):
  - A miss asks the app for the unit. The app returns the module and a table slot it assigned, so every thread uses the same slots.
  - A unit that gets hot asks for its region, sending the dispatcher's successor and call-site profile, which the app can't read from the page's memory. The unit's wasm stack waits under JSPI.
  - `tools/fexserve` plus `tools/liverun.js` run the same protocol on the Mac.
- **Result.**
  - All 22 kernels match native with every unit and region translated on the phone (509 units, 155 regions).
  - Steady-state speed equals the replayed dumps.
  - The phone's translation CPU: FEX 6.4 ms, backend 62 ms for all of it, about 0.1 ms per request.
- **The transport is the cost.**
  - Over loopback HTTP a request takes about 0.6 ms end to end (401 ms in total).
  - Over the app's loopback WebSocket it takes about 0.3 ms (207 ms in total).
  - Box2D's first (warm-up) run went from 285 to 181 ms, and tumbler's timed short run from 72 to 58 ms (46 ms with a dump).
  - Next steps: fewer round trips (send a unit's statically reachable units along with it), and translating ahead.

**Win64 guests (run38).** Windows games under Wine run PE code with the Win64 calling convention:
- arguments in RCX/RDX/R8/R9 with 32 bytes of shadow space;
- RSI/RDI and xmm6–15 callee-saved;
- 8-byte structs such as `b2Vec2` passed and returned in general-purpose registers.

`guest/build_guest_win64.sh` builds the same suite (kernels, CoreMark, Box2D) with clang's `x86_64-w64-windows-gnu` target. It links a fixed-base PE with `lld-link` and lays it out as a flat image. `FEXWASM_GUEST=win64` calls the kernels with that convention and turns on the backend's Win64 ABI rules for liveness, callee-saved registers and flags.
- **Correct.** All 22 kernels match native, on the Mac and on the iPhone. That includes Box2D's world hashes and the 4-worker scheduler kernel. The ASM suite also passes 2029 with `FEXWASM_ABI=win64`.
- **Bug found.** The build exposed an LLP64 bug in our guest platform layer: syscall arguments were `long`, which is 32-bit on Win64 and truncated pointers above 4 GB. They are `intptr_t` now.
- **Speed.** Close to the SysV build on the iPhone: CoreMark 1.47 vs 1.41, Box2D pyramid 1.95 vs 1.91, tumbler 3.28 vs 3.00, joint grid 2.49 vs 2.30, rain 2.19 vs 2.11.
  - Win64 functions that use xmm6–14 save and restore them with `movaps` in every prologue and epilogue. Translated, that is a CPUState load, a stack store, a stack load and a CPUState store per register, per call.
  - Removing it would need save/restore recognition, and SEH unwinding reads those slots.

**Guest threads (run36).** Box2D's own scheduler (`workerCount` 4: three worker threads plus the caller) runs as x86-64 guest threads on Web Workers in the WKWebView. The workers share one `WebAssembly.Memory`. TSO mode 3 is on: loads get a fence after them and stores are atomic.
- **Guest side** (`guest/box2d/platform_guest.c`): Box2D's platform layer as syscalls.
  - 1000 creates a thread (entry, arg, stack top) and 1001 exits one.
  - 202 is a futex, 24 is `sched_yield`.
  - Mutexes and semaphores are built on the futex.
- **Host side** (`js/fexthreads.js`, shared by the Node harness `tools/threadrun.js` and `Web/fexworker.js`):
  - A pool of workers. Each has its own runtime (instances, table, dispatcher) and its own Sys area at a thread base, which the modules import as the `e.tb` global (`ThreadBaseGlobal`).
  - A guest thread-create takes an idle worker through a control slot in shared memory, so nothing waits for a worker to start.
  - The futex maps to `Atomics.wait`/`notify`, and exit throws out of the wasm stack.
- **Code no profile reached.** The worker threads run code the single-thread profiling run never executed: `thread_entry`, the scheduler loop, and paths that only other threads take. fexrun translates it ahead of time (`FEXWASM_AOT`), following constant jumps and calls, call return points, and code addresses taken as constants, such as task callbacks. Jump tables are not followed. That adds 1,539 units, 28 MB of wasm. A real JIT would translate on demand from any thread, for example with a synchronous XHR to the app's scheme handler, which workers can do.
- **Correct.** Every thread count gives the native state hash, on V8 (Node) and on JSC (iPhone).

iPhone, same state hash native and wasm (run36/36b):

| scene (steps) | threads | native | FEX→wasm | ratio |
|---|---:|---:|---:|---:|
| large pyramid (300) | 1 | 311 ms | 582 ms | 1.87 |
| | 2 | 176 | 367 | 2.08 |
| | 3 | 222 | 378 | 1.70 |
| | 4 | 204 | 354 | 1.73 |
| joint grid (200) | 1 | 393 | 1074 | 2.73 |
| | 2 | 222 | 726 | 3.27 |
| | 4 | 204 | 627 | 3.08 |

**Shared code for guest threads (run40).** The shape a real translator would have: code is compiled once, and every guest-thread worker gets the same `WebAssembly.Module`.
- The page (standing in for the app's translator) compiles each module once and posts it to whichever worker asks (`FexThreads.translationServer`).
- A worker that misses a unit awaits it at the JS level (`runAsync`). The wasm stack has already unwound back to the dispatcher's `enter`, so no stack switching is needed there.
- A unit that gets hot calls `hot()`. That import is a JSPI `WebAssembly.Suspending` function (JSPI ships in iOS 27's WebKit; Node needs `--experimental-wasm-jspi`). It suspends the worker's wasm stack until the region's Module arrives, installs it, and resumes the unit.

iPhone, Box2D's scheduler, same hashes as native:

| | box2d_mt4, 4 threads | joint grid, 4 threads | warm-up (30 steps) | compile time per worker |
|---|---:|---:|---:|---:|
| each worker compiles its own | 351 ms | 612 ms | 221 ms | 14–34 ms |
| shared modules | **314 ms** | 604 ms | **94 ms** | 1–2 ms |

- The warm-up gain comes from the modules that already tiered up during the 1-thread run: other threads pick up the optimized code at once.
- JIT memory is also counted once instead of once per thread.

Native Box2D stops scaling after 2 threads on this phone as well: 2 performance cores, and Box2D's stages spin-wait on the slowest worker. The translated code follows the same curve. On the Mac (Node/V8), 4 threads give 2.85× for the pyramid (native 2.97×) and 2.84× for the joint grid.

**Baseline tier (BBQ).** Warm but not-yet-hot code, and any function JSC won't optimise, runs in BBQ, which keeps every wasm local in a stack slot. Measured on the Mac with `jsc --useOMGJIT=false`:

| kernel | BBQ before | BBQ after | speed-up |
|---|---:|---:|---:|
| intmix | 648 ms | 67 ms | 9.7× |
| hash | 226 ms | 33 ms | 6.9× |
| CoreMark | 2132 ms | 710 ms | 3× |

Two changes did it:
- **Fewer locals.** Register reads alias the register's local (when it isn't rewritten before the value's last use), and dead results are dropped.
- **Stackification.** A single-use result that the next op reads first stays on the wasm stack. A register store becomes `local.tee` when the next op reads that register first. Both are verified as they're emitted and rolled back otherwise.

Units also got 22% smaller. OMG code is unchanged, since B3 removed those copies already.

**Correctness.** FEX's own ASM unit tests (`unittests/ASM`, 2222 tests) run through the backend with `tools/asmtests.py` (about 20 s on the Mac): **2028 of 2043 non-skipped tests pass**. They pass in every mode: default, `FEXWASM_HOT=5` (regions everywhere), `FEXWASM_BRTABLE=1`, ABI-local flags, and `FEXWASM_REGARGS=0`. The 15 failures are not backend bugs:
- AES/PCLMUL not advertised.
- Self-modifying code not handled yet.
- A NASM encoding difference.
- `int 0x80`.

That covers:
- AVX/AVX2 through FEX's 128-bit AVX path (gathers, masked moves, FMA3).
- BMI1/2, atomics, CRC32, F16C and SSE4.2 string compares.
- x87 through reduced precision.

FMA is exact: f32 goes through f64 with round-to-odd, and f64 uses the Dekker two-product.

CoreMark 1.0 (EEMBC) runs as a guest with its full validation. The seed CRCs and the final CRC match native.

**What made the difference** (Mac numbers unless noted):
- Structured control flow (Ramsey) instead of a `br_table` loop: qsort 2.1× → 1.2×, sieve 1.8× → 1.3×.
- A wasm hash-table dispatcher instead of a JS loop: interp 56× → 21×.
- **Inlining guest calls.** This works because FEX IR is offset-based, so a unit's IR can be copied and kept alive. The callee's blocks run on the caller's locals, and its `ret` to the call's return address becomes a branch. calls 8.4× → 2.5×.
  - Callees that can leave other than by returning (a jump table, a tail call) are not inlined. Inlined, such an exit abandons the caller's function.
- **Regions.** The dispatcher counts unit runs and records successors. At 100 runs the runtime compiles the unit plus its jump-connected units into one wasm function, with a dense `br_table` over (RIP − base).
  - Regions follow jumps only. Call targets stay out, because a call into a big region function re-enters all of it. Pure return points stay out too (`BackendConfig::ReturnAddrs`), because returns always leave a region. Before this, CoreMark regions were full of big caller units and hit the size cap.
  - A jump to the RIP an enclosing call waits for (StopAddr) is checked only where the target can be a return address: interp −14%.
- **Guest registers as wasm values.** Spilling the state to CPUState at every call put store→load forwarding on the critical path.
  - A microbenchmark showed that 8 i64 wasm params and multi-value results make a call about 3× cheaper (fib 13.4 → 4.7 ms). Values past about 12 go to the stack and get expensive.
  - Now `run(rax..rdi) → (rip, rax..rdi)`. The dispatcher threads them from unit to unit, and JS enters through `enter(rip, stop)`, which loads and stores them.
- **Direct calls.**
  - Calls into a unit of the same region are direct wasm calls. The region's entry selector (global 0) is set first. Missing that reset caused a CoreMark checksum bug.
  - Other constant-target calls use a **call inline cache**: `call_indirect` straight to the callee's table slot while a per-slot RIP tag still matches, else the dispatcher. CoreMark −9%.
  - Units count their own entries (a counter hashed by RIP) and report hot themselves, because inline-cached calls bypass the dispatcher's counts.
  - Region code calls a dispatcher entry without call-site profiling.
- **ABI-local flags** (`BackendConfig::ABILocalFlags`, on in the harness). The x86-64 ABIs leave flags undefined across call/ret, so the lazy flag state isn't spilled or reloaded there.
  - The same rule was added to FEX's dead-flag pass: Return and Call exits read no flags. That removes flag work that only a `ret` would "read", such as `inc`'s carry preservation.
  - calls 1.64× → 1.00×, vcall 2.6× → 1.3×, fib −25%. All 2028 ASM tests still pass with it on.
- **Irreducible CFGs made reducible.** Six CoreMark units, `core_bench_list` among them, had multi-entry loops and fell back to a `br_table` loop over all their blocks.
  - Each multi-entry SCC now gets a synthetic dispatch block that all edges into its entries go through (the LLVM WebAssembly approach), and the rest stays structured.
  - CoreMark 2.29× → 1.88×.
- **Known flag kinds flow into single-predecessor blocks**, so `setcc`/`cmov` after a `jcc` don't call the generic flag materialiser: tree 2.09× → 1.47×.
- **Structured regions.** A region is compiled as structured code over its units' CFG, with one entry. Direct jumps between units become plain branches and real wasm loops. Each indirect jump gets its own local `br_table` over its targets (like threaded code) instead of all transitions sharing one `br_table` at the region loop head. interp 2.45× → 1.83×, CoreMark 1.69× → 1.51× (Mac).
- **Call depth as a parameter.** The depth is run's last parameter, so JSC puts it on the stack and it doesn't take an argument register. It replaces a memory counter that put a store→load chain through every call: fib −6% (−15% was the cost of the counter).
- **Scalar SSE without lane inserts.** A scalar op's lane-0 result is also kept in an f32/f64 local, following register store→load aliases, and later scalar ops and `movsd`/`movss` stores read it from there. Every `addsd` no longer puts an `ins` on the dependency chain: nbody 1.52× → 1.18× (Mac).
- **IR peepholes B3 doesn't do:**
  - `Bfe`/`Sbfe` of a `Bfi` into bit 0 reads the inserted source, so `movzbl` after `xorb` skips the partial-register merge: crc32 1.48× → 1.24×.
  - Lazy carry inversion also works on logic flags (`test` then FEX's carry flip).
- **Profiling.** Each module has a `name` section (`u<rip>`/`r<rip>`, and `dispatch`/`dispatchnp`), so `jsc --sample tools/jscrun.js -- <dump> <kernel>` profiles by unit and region.
- **Flag materialisation without the generic helper.**
  - Known flag producers are computed inline.
  - `inc`/`dec` carry preservation and FEX's exit carry inversion become lazy flag kinds.
- **Profile-guided indirect-call inlining**: the call-site profile records up to 4 targets per site. vcall 9.4× → 2.6× (then 1.3× with the changes above).
- **JSC codegen details:**
  - A constant-0 wasm address costs `mov`+`add` per access, so an opaque zero base is loaded once per function.
  - Benchmarks warm up with n/10 so the tier-up to OMG happens before timing.

- **Float compares as lazy flag kinds.** `ucomiss`/`comisd` is FEX's `FCmp` followed by `AXFlag`. Both now only record the operands' bits (kinds FCMP and FCMPAX). A branch or `setcc` reads them with a single `f32`/`f64` compare, picked by evaluating its condition on each of the four outcomes (less, equal, greater, unordered).
  - Before, the fcmp NZCV was built with 4 compares, `axflag` remapped it, and the branch tested a bit: about 20 ARM64 instructions.
  - Joint grid 2.43× → 2.17× (Mac).
- **Demanded lanes.** A backward pass over each unit (`ComputeDemand`) records which bytes of each vector value, and of each xmm register, anything reads. Shuffles map byte by byte. An inlined call reads what the callee's entry reads. ABI exits read their registers.
  - When nothing reads a scalar SSE result's upper lanes, it is a splat instead of a lane insert into the old register value.
  - `movss`/`movsd` loads are scalar loads that feed the lane-0 cache. They get their zeroed upper lanes only if something reads them.
  - JSC turns every correct zero-extending load form (`load32_zero`, `replace_lane` into zero) into load, copy and `ins`: 3 instructions.
  - Joint grid −4%, rain −6%. An unsafe experiment with every upper lane treated as dead gained nothing on the pyramid, so lane traffic is not a bottleneck on Apple cores.
- **Callee-saved registers survive calls.** After an ABI call, the callee-saved registers the call's epilogue stored are not reloaded: the callee restores them, so the locals are still right. CoreMark 1.52× → 1.48×, vcall 1.19× → 1.12×.
- **Inlining where it pays.** The limit for callees inlined into regions went from 200 to 600 IR nodes: rain 2.66× → 2.14×, CoreMark 1.49× → 1.41× (Mac).
  - Units (the first tier, which anything that runs 100 times replaces with a region) now inline only callees of up to 60 nodes.
  - Unit code went from 88 to 33 bytes of wasm per x86 instruction for Box2D (120 → 36 for rain), with the same speed and less compile time. With no inlining at all in units, `calls` regressed 6×.

- **Flags across unit boundaries.** FEX's dead-flag pass treated every jump out of a unit as reading all the flags. So a `dec` (which keeps CF) at the end of an interpreter's case block had to fetch the incoming carry, which at a unit entry means the generic flag helper. Its flags were also spilled at the exit, though the loop head's `cmp` rewrites them all.
  - The pass (in our FEX clone, next to the ABI rule) now reports each unit's entry live-in flags once it has converged (`NoteEntryFlags`).
  - A jump to a constant target whose unit reads no flag before writing it (`FlagsDeadAtEntry`) reads none. The backend skips the lazy-flag spill at such an exit (`BackendConfig::FlagsDeadAt`).
  - Knowledge comes from units already generated, so a jump to a unit not yet seen stays conservative. That is always correct, and in execution order loop heads come before their bodies.
  - interp 1.84× → 1.30× (Mac). ASM suite unchanged at 2029 (on by default in fexrun and fextest; `FEXWASM_NOCROSSFLAGS` turns it off).
- **`rswitch` (5.2×) is not a translation cost.** arm64 clang compiles its `switch` branch-free with `csel` (2.25 ns per iteration natively), while the x86-64 guest build uses a jump table with an unpredictable target. JSC lowers `br_table` to a real jump table (`ldr` + `brab`), so we run the x86 code's indirect branch faithfully: 9.7 ns in a wasm microbenchmark of the same loop.

**iPhone, run37 (same dump format as run35):**

| kernel | run35 | run37 |
|---|---:|---:|
| CoreMark | 1.53 | 1.49 |
| nbody | 1.23 | 1.17 |
| Box2D pyramid (30) | 2.00 | 1.91 |
| tumbler (60) | 3.33 | 3.09 |
| joint grid (20) | 2.56 | 2.29 |
| rain (100) | 2.51 | 2.14 |

All 22 kernels match native. The device dump went from 5.7 MB to 3.7 MB.

**Tried and rejected (measured on the Mac):**
- **Inlining jump-table and tail-call targets inside inlined callees** (`FEXWASM_JUMPINLINE`, opt-in). Profiled targets go behind compares, with a nested dispatch as the fallback.
  - Box2D's per-joint call (`b2SolveJoint` → jump table → tail call into the revolute solver) still isn't inlined, because the solver is about 1,500 IR nodes.
  - The pyramid got 5% slower. Inlining leaf callees with only the nested-dispatch fallback was far worse (joint grid 2.14× → 2.87×).
- **Load→load order by address dependency instead of `dmb ish`** (TSO "mode 4"). Each TSO load's address got `+ (previous TSO load value & opaque zero)`.
  - Twice as slow as a fence after every load: interp 88 → 179 ms, CoreMark 122 → 255 ms.
  - The exit fences it needed cost nothing; the chains did. On Apple cores the barrier is cheaper than making each load wait for the previous one's data.
- **Earlier region forming** (hot threshold 30 or 10 instead of 100). Short Box2D runs got faster (tumbler 3.66× → 3.06×), but CoreMark (1.39× → 1.68×) and interp (1.78× → 4.35× at 10) got slower, because regions are built from less profile.
- **Call cost, measured** (JSC microbenchmark, 9 values in and out). A same-module `call_indirect` costs 0.66 ns and a cross-instance one 2.43 ns.
  - The ~10 ns a guest call costs in Box2D's solver loop is mostly JSC's frame setup plus our state sync, not the instance switch.
  - Dropping the depth parameter (so everything fits in registers) and taking the system base from a global (so its load can be dropped) changed nothing measurable.
- **Kept:** under TSO mode 3, a load whose next TSO access is a store skips its fence, since the `swpal` store is fully ordered. No measurable effect, but correct.

**Self-modifying code (not implemented yet; measured).** Guests that generate x86 at run time (Mono/.NET JITs, LuaJIT, hot patching) need their stale translations invalidated. FEX does it with page protection (mtrack), which wasm doesn't have.
- **Store barrier** (`FEXWASM_X_SMCBARRIER`, an experiment): before each store whose address isn't RSP-based, test a per-page byte (all zero here) and branch.
  - Cost: CoreMark +8%, Box2D +5–10%, qsort +5%, tree +4%, `matmul` +82% (a store-heavy inner loop). Too much to pay on every guest.
- **Better plan:**
  - JIT code lives in pages the guest makes writable and executable (`VirtualAlloc`/`VirtualProtect` → Wine → the host's mmap/mprotect), so the host knows them.
  - Units translated from such pages check their source bytes at entry, as FEX's "full" SMC mode does for all code.
  - Making image code writable invalidates its translations.
  - Read-only code, most of a game, pays nothing.

- **Configurable register arguments** (`BackendConfig::RegArgMask`, `FEXWASM_REGMASK`). A JSC microbenchmark showed a 9th wasm parameter going to the stack (JSC's arm64 convention passes 8 in registers): 1.40 ns per recursive call, against 0.99 ns with 7 registers plus depth. But with 7 GPRs (dropping RBP, RBX or RSI) instead of 8, fib, walk, CoreMark and Box2D stayed within noise. JSC's frame setup and callee-saved saves dominate a guest call, not the stack slot. The default stays RAX..RDI.

**Translator speed.** `FEXWASM_RECOMPILE=n` recompiles everything a run translated, for timing and profiling the backend alone. Before → after:

| | per unit | per region |
|---|---:|---:|
| before | 194 µs | 581 µs |
| after | 106 µs | 330 µs |

Unit times include FEX's frontend. The changes:
- Vector-backed maps and sets keyed by node ID replace `unordered_map`/`unordered_set`, whose per-entry allocations were a big share of the time.
- Environment switches are read once.
- The register-alias scan is linear instead of quadratic.
- The demanded-lanes pass skips units without xmm registers.

The generated wasm is byte for byte the same. FEX's own IR generation for inlining and regions (`FetchIR`) is about 10% of region time. Our FEX build has `ENABLE_ASSERTIONS=ON`, which runs IR validation; a product build would turn it off.

**What is left:**
- **Recursion** (fib 3.1×, walk 4.3×). The guest call is now a plain wasm call with 8 register arguments. What remains is JSC's own convention: pointer-auth frame setup, saving up to 8 callee-saved registers, and moving 9 arguments and 9 results. That's about 50 instructions per call, against about 12 native.
- **Interpreters** (interp 2.0×).
- **Memory-bound code**: wasm32 addressing adds the memory base, so a guest `[base + index*scale]` load is an `add` then `ldr [x22, w, uxtw]`, about one extra cycle on every pointer-chasing hop.
- **Code size.** About 45 bytes of wasm per x86 instruction. That matters against the roughly 160 MB JIT pool for game-sized code.

## CPU: same C kernels (`Kernels/kernels.c`), identical checksums

| kernel   | native ms | WKWebView (JIT) | × | in-app JSContext (no JIT) | × |
|----------|----------:|----------------:|---:|---------------------------:|---:|
| intmix   | 125.0 | 123.8 | 0.99 | 1498 | 12.0 |
| sieve    |  45.4 |  63.4 | 1.40 | 1465 | 32.3 |
| qsort    | 159.4 | 165.0 | 1.04 | 1545 |  9.7 |
| matmul   |  49.8 |  56.2 | 1.13 | 2909 | 58.4 |
| nbody    |  67.2 |  86.8 | 1.29 | 2322 | 34.6 |
| hash     |  62.4 |  62.3 | 1.00 |  663 | 10.6 |
| interp   | 110.7 | 116.7 | 1.05 | 4805 | 43.4 |
| ptrchase |  34.0 |  38.6 | 1.14 |  146 |  4.3 |
| memcpy   |  42.8 |  43.7 | 1.02 |   45 |  1.0 |
| crc32    | 104.6 | 120.1 | 1.15 |  796 |  7.6 |
| tree     | 119.6 | 131.3 | 1.10 |  592 |  4.9 |
| **geomean** | | | **1.11** | | **11.7** |

The JSContext memcpy checksum differs only because that run skips the warm-up call, and the kernel carries state between calls.

## Translated-code dispatch (`tools/gen_guest.py`, `Web/wasmgen.js`)

The guest program has 512 blocks. They operate on 16 guest registers held in a memory CPU state and a 1 MB guest heap. Each block ends in a conditional or 4-way indirect branch. The run is 2M block executions, and every variant matches the native checksum.

| variant (ns / block) | native | WKWebView | JSContext no-JIT |
|---|---:|---:|---:|
| one function, `switch` / `br_table`, regs in locals | 2.66 | 3.52 | 41.0 |
| function per block + dispatcher loop (`call_indirect`) | 3.38 | 3.43 | 93.1 |
| tail-call chaining (`return_call_indirect`) | 3.39 | 3.23 | 90.3 |
| module per block (incremental JIT) + dispatcher | — | 3.53 | 95.6 |
| JS loop calling exported block functions | — | 3.30 | 107.2 |
| + software page-permission check per guest access | — | +0% (switch) / +20% (fnptr) | +10% |
| + soft MMU: 64-bit guest VAs above 4 GB through a 256-entry software TLB | — | 4.54 / 4.58 (+29–32%) | — |
| module per block + cross-module tail calls | — | **crashes WebContent** | 89.7 |

**Cross-module `return_call_indirect` through an imported table crashes WebContent on iOS 27.** It crashed 9 of 12 runs, including runs that never execute the tail call; only the three `steps=1` runs survived. The same code runs fine in the in-app interpreter and in macOS JSC, and the device writes no crash log. Same-module tail calls work.

## JIT compile cost and capacity

**Compile cost**
- One module per block (about 360 B each): 21 µs to compile and instantiate (p50 20 µs, p99 40 µs).
- Batched: 2.9 µs/block with 8 blocks per module, 1.6 µs with 64, and 0.7 µs with 512.

**Tier-up**
- A fresh module runs at about 39 ns/block for the first 20k steps.
- It reaches steady state (3–5 ns/block) within about 50 ms.

**Capacity**
- Live code was kept at about 10 KB of wasm per module, each tiered up. At about 161 MB of wasm (around 16,400 modules), new modules stop being JIT-compiled.
  - They silently run in the interpreter: 1.3 → 8.3 ns/op.
  - No exception is thrown.
- Per WebKit source, the pool is 512 MB on arm64, of which 75% is usable, shared with all JS.
- A translator therefore needs its own code-cache eviction, and has to drop module references so GC frees the code.
- **Measured (`w:jitgc`, run29/run30):**
  - **Reclamation works.** Filling 90 MB of wasm, dropping every reference, churning garbage for about 1 s, and repeating 4 times compiled 360 MB cumulatively. All of it ran JIT-fast (1 slow module of 7,824).
  - **Exhaustion is sticky.** After filling to the cliff (158 MB, 3,430 modules of 47 KB), dropping everything and churning for 3 s did not bring the JIT back: fresh modules stayed in the interpreter at 5.5–13 ns/op versus 0.43.
  - So the code cache has to evict *before* the limit: keep live wasm under about 120 MB, LRU by unit and region.
  - Our FEX backend emits about 50 bytes of wasm per x86 instruction, so this is roughly 2.4 M hot x86 instructions.
- **Code budget in the runtime (`host.codeBudget`, `FEXWASM_CODE_BUDGET`).**
  - The runtime counts the wasm bytes of the code its table holds. Past the budget, a miss flushes everything, as QEMU does: the dispatcher hash, slot tags and unit counters are cleared, the table slots are nulled, and code is recompiled on demand.
  - A region over budget is skipped until the next miss flushes.
  - A unit that a region takes over is now dropped from the runtime's cache. Before, its code stayed reachable (a leak), even though the table no longer used it. With that fix, the whole kernel set above fits in 3 MB of live wasm without a flush.
  - Stress test: with a 200 KB budget, below a single Box2D scene's working set, every kernel still matches native while thrashing (Box2D 93× slower). At 2 MB the biggest scenes flush once or twice.
  - A full flush is simple and robust, but costs a recompile burst when the working set is near the budget. A real game would want something finer (evicting cold regions first), with a budget around 100 MB.

**Atomics lowering** (macOS JSC OMG, same compiler)
- `i64.atomic.load` becomes `ldaddal` (an RMW), and `i64.atomic.store` becomes `swpal`.
- Both carry an alignment check that traps, and x86 permits unaligned accesses.
- A microbench of 4 loads and 2 stores ran at 0.89 ns plain and 5.80 ns atomic (6.5×), uncontended.
- FEX's TSO emulation uses `ldapr`/`stlr`, which cost roughly as much as plain loads.

## x86 memory ordering (TSO): wasm vs FEX's emulated TSO, measured on iPhone (`native_tso`, `w:tso`)

**Setup and lowering**
- With FEX's TSO enabled, the IR marks non-stack accesses `LoadMemTSO`/`StoreMemTSO`; stack accesses stay plain. The backend (`BackendConfig::TSOMode`, `FEXWASM_TSO=n` in fexrun) lowers them two ways:
  - mode 1: a fence after each load and a fence before each store.
  - mode 3: a fence after each load; stores become seq-cst atomic stores.
- JSC (macOS 27) lowers:
  - `atomic.fence` → `dmb ish`
  - `i64.atomic.store` → `swpal`
  - `i64.atomic.load` → `ldaddal`, an RMW that takes the line exclusive
- It never emits `ldar`/`stlr`, so wasm has nothing as cheap as FEX's `ldapr`/`stlr`.

Kernel ratios vs native (Mac, current backend):

| TSO | sieve | qsort | hash | interp | crc32 | others |
|---|---:|---:|---:|---:|---:|---|
| off | 1.26 | 1.18 | 1.00 | 2.62 | 1.48 | unchanged |
| mode 1 (fences) | 2.57 | 1.67 | 14.8 | 4.12 | 5.81 | unchanged |
| mode 3 (load fence + atomic store) | 3.45 | 1.25 | 1.01 | 4.10 | 1.49 | unchanged |

A full barrier before every store is catastrophic for streaming writes: hash and crc32 fill megabytes. `swpal` stores are much cheaper there, but a little worse for dense byte stores (sieve). Mode 3 is the better default. TSO-heavy code (non-stack loads and stores in loops) pays about 1.5–3× on top.



- Madeira runs FEX's default emulated TSO:
  - GPR loads become `ldapr` and stores become `stlr`.
  - Stack (RSP-based) accesses are exempt, and so are vector and `memcpy`/`memset` accesses.
  - Unaligned accesses fall back to barriers.
- Wasm has no acquire/release accesses. Its options are seq_cst atomics (JSC emits `ldaddal`/`swpal`) or `atomic.fence`, which JSC emits as a full `dmb ish`.

ns per iteration of 4 loads from shared lines, plus 2 stores to per-thread lines:

| | 1 thread, loads | 1 thread, loads + stores | 4 threads, loads | 4 threads, loads + stores |
|---|---:|---:|---:|---:|
| native plain `ldr`/`str` | 1.21 | 0.76 | 0.96 | 1.09 |
| **native FEX TSO `ldapr`/`stlr`** | 1.50 | **1.30** | 1.14 | **1.60** |
| native `ldr`+`dmb ish` / `dmb ish`+`str` | 1.51 | 4.02 | 1.66 | 4.10 |
| wasm plain | 0.41 | 0.46 | 1.01 | 0.99 |
| wasm fence after loads, before stores | 1.15 | 3.90 | 1.50 | 3.71 |
| wasm fence after loads + atomic stores | — | 2.87 | — | 3.71 |
| wasm seq_cst atomics | 2.04 | 3.05 | 200 | 218 |

**Conclusions**
- Atomics are unusable, because RMW loads fight over shared lines.
- With fences, TSO loads cost about what FEX's `ldapr` does.
- TSO stores cost roughly 1.3 ns more each than `stlr`, because the full barrier drains the store buffer.
- On this store-heavy loop, the wasm approach is about 2.2–2.3× FEX's TSO.
- On typical game code, where about 10% of instructions are stores and around half of those hit the stack and are exempt, I estimate about 1.3–1.5× FEX's TSO cost.
- The native loads-only rows are slower than loads + stores. That's an artifact of how the inline-asm loop is built, so compare within a column rather than across.

## Memory

- A WebAssembly.Memory can be reserved at 4 GB and a shared memory at a 4 GB maximum.
  - memory64 is not available in shipping iOS 27.
  - In JSC it is IPInt-only, per its option text, and capped near 4 GB on iOS, per source.
- **The WebContent process is killed between 1,984 and 2,048 MB of touched wasm memory.**
  - No jetsam report is written.
  - The kill point is the same with the app's increased-memory-limit, extended-virtual-addressing and Game Mode keys.
  - Those entitlements raised only the app's own budget, from 3,369 to 8,185 MB.

## Shared memory and file-backed guest memory (OPFS) — the way past 2 GB

Sharing memory between the app and the WebView *is* possible. It works through
an OPFS file that both processes touch.

**The file**
- A worker's `FileSystemSyncAccessHandle` is an ordinary file in the app container, keeping the name JS gave it: `Library/WebKit/WebsiteData/Default/<hash>/<hash>/FileSystem/<name>`.
- Its protection class is `CompleteUntilFirstUserAuthentication`.
- The app `mmap`s it `MAP_SHARED`.
- A second sync handle is refused, even with `readwrite-unsafe`.
- The origin (and so the directory) depends on the loopback port, so keep that port fixed.

**Coherence and speed**
- Coherent both ways; verified by hashing 64 MB regions each direction.
- WebView `write` 6.7 GB/s and `read` 20 GB/s. A tiny sync read costs about 0.5 µs, i.e. a direct syscall, not IPC.
- **Doorbell round trip** (worker `write` → app thread spinning on its mapping → worker `read`): **about 3 µs on average**, against 40 µs for WebKit messaging.

**Capacity**
- Wrote 6 GB of real data (a 7.5 GB file) and WebContent survived.
- The quota was 10.3 GB and grew to 20.6 GB once in use.
- Writes are throttled in bursts (54 ms to 6.9 s per GB): the same dirty-page throttling Madeira's canary found.

**Demand-paged guest memory**
- Setup (`Kernels/bigmem.c`, `Web/pager.js`):
  - A 64-bit guest address space above 4 GB.
  - A page table in wasm memory, with 16 KB pages.
  - A resident pool of 1 GB of wasm memory with CLOCK replacement.
- JS runs only on page-ins.
- Checksums are identical against a flat baseline and across backings.

| | result |
|---|---|
| translation cost, everything resident (random access) | 11.1 ns vs 7.0 ns direct |
| page-in from OPFS file, sparse hole / page cache | ~2 µs / ~7–16 µs |
| page-in from OPFS file, flash (8 GB file) | ~70–100 µs |
| page-in from **app RAM** through the shared file (app thread serves swaps) | **6.4–7.7 µs**, steady |

**Full-size check (`appram:7`)**
- The guest wrote one distinct word into every 16 KB page of a 7 GB address space, with 1 GB resident in the WebView.
  - It took 4.2 s: 458,752 demand-zero pages and 393,216 evictions into app RAM.
- It then read every page back.
  - That took 4.7 s: 458,752 page-ins from app RAM at about 10 µs per fault, including dirty write-backs.
  - **0 mismatches.**
- The app's footprint reached 7,183 MB, and WebContent stayed alive.
- Streaming page by page runs at about 1.5–1.7 GB/s.

Capacity then becomes: about 1.5 GB resident in WebContent, plus the app's own budget (8.2 GB with increased-memory-limit), plus Madeira-style file-backed memory in the app beyond that.

### RAM or flash? (`storagecheck` suite, app-side)

| 16 KB random read | avg | p99 | sequential |
|---|---:|---:|---:|
| page cache (RAM) | 0.88 µs | 1.7 µs | 32 GB/s |
| flash (`F_NOCACHE`) | 62 µs | 69 µs | 3.1 GB/s read / 2.1 GB/s write |

The shared file lives in the page cache, which is RAM. Flash is touched only by background writeback and by re-reads after eviction.

Doorbell wear, measured over 15 s:
- Re-dirtying one word of a `MAP_SHARED` mapping about 26 billion times wrote 64 KB to flash.
- 10.5 million 8-byte `pwrite`s (85 MB of logical writes) wrote 16 KB.

So rings and doorbells cost essentially nothing. SSD speed only matters when the file itself serves as a large swap store that spills out of the page cache.

## Native ↔ WebView data movement over WebKit channels

| path | result |
|---|---|
| `postMessage` with reply, tiny, round trip | p50 40 µs, p99 120 µs |
| `postMessage` fire-and-forget | 6.6 µs/msg |
| ArrayBuffer / TypedArray via `postMessage` | **does not transfer** (empty dict / index-keyed dict) |
| JS→native base64 via `postMessage` | ~1.4 GB/s |
| JS→native `fetch` POST to custom scheme | ~4 GB/s (1 ms timer, approximate) |
| JS→native `fetch` POST to 127.0.0.1 server | ~1.1 GB/s |
| native→JS `fetch` GET from custom scheme | ~6–8 GB/s |
| native→JS `fetch` GET from 127.0.0.1 | ~2.5 GB/s |
| native→JS `callAsyncJavaScript` / `evaluateJavaScript` base64 | ~1.5 GB/s (NSData args rejected) |
| worker → main → native → wake worker (Atomics relay): a sync "syscall" | p50 40 µs |
| worker sync XHR, custom scheme / 127.0.0.1 | ~80 µs / ~500 µs |
| WebSocket to in-app NWListener | RTT 100 µs; 0.8 GB/s up, 2.3 GB/s down |

Cross-origin isolation (SharedArrayBuffer, wasm threads, 20 µs timers) works only when the page comes from an in-app `http://127.0.0.1` server. A `WKURLSchemeHandler` origin reports `crossOriginIsolated` but has no SharedArrayBuffer, and its timer resolution is 1 ms.

## Threads

- wasm in N workers:
  - intmix scaled about linearly to 4 workers (3.6× throughput), then degraded at 6–8.
  - qsort reached 3.6× at 6 workers.
- `navigator.hardwareConcurrency` reports 4.
- x86-64 guest threads (Box2D's scheduler) on workers: see "Guest threads" in the fexwasm section.
- **Posted modules share tiered code (run39, `w:modshare`).**
  - A `WebAssembly.Module` posted to a second worker, after a first worker warmed it up, ran its very first call at steady-state speed: 0.28 ms, against 0.68 ms for the first worker's first call.
  - A worker that compiled its own Module from the same bytes paid the warm-up again: 0.80 ms first call.
  - Posting costs nothing (0 ms "compile").
  - So a translator should compile each unit once and post the Module to the guest-thread workers. Compiling per worker multiplies JIT memory, which runs out at about 160 MB, and the tier-up work by the number of threads. The current `fexthreads.js` harness still compiles per worker.

## Headless WKWebView

- In the window but invisible (`alpha=0`, `isHidden`, offscreen, 1×1): full speed, rAF at 61/s, normal timers.
- Detached or never attached:
  - wasm compute is still full speed.
  - `visibility=hidden`, `setTimeout` throttled to about 12/s, and no rAF.
  - This is unchanged with `inactiveSchedulingPolicy = .none`.

## WebGPU in WKWebView

- Available, with these features: `texture-compression-bc`, ASTC, ETC2, `shader-f16`, `float32-filterable`, `timestamp-query` and more.
- Submit to GPU complete: 1,000 draws in 0.5 ms and 10,000 draws in 3.3 ms.
- Buffer upload 4–6.7 GB/s; readback about 2.8 GB/s.

## Re-running

```
tools/run.sh <logname> '<suite,suite,...>'        # builds, installs, runs, saves results/<logname>.log
EXTRA_ARGS=--inactive-none tools/run.sh ...        # WKPreferences.inactiveSchedulingPolicy = .none
```

Suites:
- Native side: `native_kernels`, `native_dispatch`, `jsc_kernels`, `jsc_dispatch`.
- Pages: `page:localhost`, `page:scheme`.
- In-page, via `w:<name>[:{json with ; for ,}]`: `env`, `kernels`, `dispatch`, `jitcost`, `jitcap`, `memres`, `memtouch`, `ipc`, `worker`, `ws`, `threads`, `webgpu`, `liveness`.
- Native-driven: `native_to_js`, `hidden`, `meminfo`.
- OPFS: `native_cleanup`, `opfs_share` (find and map the file, coherence, doorbell), `opfs_big:<GB>` (slow; writes GBs), `opfs_bigmem`, `opfs_cleanup`. Summarise with `tools/bigmem_summary.py results/<log>.log`.
- Keep device runs short. `opfs_big` and 8 GB page-in runs take minutes.
