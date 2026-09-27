# Execution and validation contracts

This SDK remains experimental. These changes strengthen the app-independent
runtime; they do not supply an OS, a Wine launcher, a native renderer, or an
OPFS fast transport. The existing Iridium adapter is not changed by this work.

## Failure and ownership

`RuntimeFailureReportingTransport` optionally notifies a session of an idle
transport failure. `WebKitTransport` implements it. `RuntimeSession.failure`
retains the first causal error; explicit close remains closed when a late
response or cancellation arrives. A malformed typed response is terminal.
WebKit and the worker impose native-service deadlines independently of the
request queue. Closing replaces the execution document and shuts down the
asset server; native callbacks completing afterward cannot re-enter the guest.

Cancelling a Swift task is cooperative. It cannot forcibly interrupt an arbitrary
native function, undo external side effects, or roll back earlier batched calls.
Consumers must explicitly close their sessions and close owned FEX services.
FEX's native binding locks both the C call and copying its borrowed result buffer.
It remains a native compiler handling guest bytes, not an audited hostile-input
security boundary.

## Bounded execution profile

The v1 numeric host ABI requires finite decimal floats and exact signed integer
strings. Preflight now checks exported argument/result signatures before executing
any guest code. Supported function types are numeric/SIMD; v128 cannot cross the
numeric host-call API. Recursive/GC reference types are outside this profile.
Private memory, extra imports, unbounded tables, and Wasm start sections are
rejected. Export an explicit initialization function instead of a start section.
WebAssembly.compile still performs full binary/instruction validation.

Additional RuntimeLimits fields have bounded defaults when absent in older v1
configuration messages:

| Limit | Default | Meaning |
| --- | ---: | --- |
| maximumResidentModuleBytes | 32 MiB | Loaded ordinary Wasm input bytes; FEX live-code budget |
| maximumCumulativeModuleBytes | 256 MiB | Bytes submitted to compilation over the session, including failed compilation attempts |
| maximumTableElements | 65,536 | Aggregate declared ordinary table capacity; FEX table cap |
| maximumPendingBytes | 64 MiB | Aggregate queued wire bytes |
| maximumBatchOperations | 64 | Calls in one ordered batch |

Unloading returns the ordinary loaded-module budget, not the cumulative compile
budget. These are accounting bounds, **not measurements or guarantees about
resident JIT pages**, GC timing, total process RAM, or JSC's current compiler tier.
FEX dispatch-table probing is bounded and table growth has a declared maximum.
FEX still uses one unshared guest-address window; no guest threading is added.

`invokeBatch` prevalidates all signatures, then runs calls in order through one
request. It is not transactional. A guest trap terminates the session; earlier
writes or native-service actions are not rolled back. The FEX function-call API
now accepts 0 through 16 integer/pointer arguments, including ABI stack arguments
and Win64 shadow space. Floating-point/aggregate guest arguments are not supplied.
A missing translation or backend failure during FEX execution is terminal. The
SDK rejects guest syscalls instead of silently using the research runtime's
simulated write/getpid/time results; an OS adapter is not implemented here.

`statistics()` reports counts, submitted/loaded module bytes, table reservations,
ordinary memory size, compile time and invocation wall time. Invocation time can
include JSPI waiting. Generic native-call counters exclude internal FEX service
requests; use `FEXService.statistics()` for FEX request/response counters. Ordinary
loaded-module counters do not account for FEX's internal table entries.

## Reproducible checks without physical devices

```sh
bash scripts/check-sdk.sh
python3 tests/sdk/native-binding.test.py
bash Examples/CGuest/build.sh
python3 tests/sdk/browser-sdk.py --c-guest --native-service --research-fixtures
```

For a selected Chromium use `--chromium /path/to/chromium`. On macOS, Apple's
Clang may not include a Wasm backend; set `WASM_CLANG` to an LLVM Clang with wasm32
support. The C guest is compiled from source and compared against 256 outputs
from the same C algorithm compiled natively. Six native-service cases exercise
unsigned 32-bit boundaries through a real Swift NativeService. The browser/Swift
connection is a test-only stdio adapter, **not WKWebView's native bridge**.

Recorded FEX replay covers the 18 non-Box2D kernels in each SysV/Win64 dump. The
saved Box2D units are not a self-contained live-translation oracle: expanding
replay reached absent unit 0x419b90 (and 0x407ef3 when starting tumbler alone).
Those gaps are not converted into successes or substituted with native results.
The 36 recorded calls do not establish fresh native FEX translation.

On a Mac with a GUI session, `swift test --filter AppleHostTests` runs the actual
WKWebView host, native Swift service, a busy-worker deadline, and repeated
lifecycle tests. The idle termination case injects the delegate notification;
it does not claim the OS killed the process. Linux explicitly skips this suite.
WebKit without JSPI explicitly skips the native-service case, not its other tests.

`Examples/FEXHost` embeds the real optional C binding and requests freshly
translated x86-64 additions for both ABIs. It includes no recorded modules and
requires nonzero translation-request counts plus RAX=42. Build it after
`bash Backends/FEX/build-ios.sh`. Its build/run are distinct from C-shim ownership
tests and recorded replay. The manual SDK workflow separates Apple tests, ordinary
iOS compilation and optional native-FEX consumer compilation. No physical device,
fresh native-FEX execution, Apple compilation, or performance percentage is
inferred from Linux/Chromium results.
