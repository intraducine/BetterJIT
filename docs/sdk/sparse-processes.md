# Bounded static process trees in the browser

`LinuxRuntimeConfiguration.ExecutionProfile.sparseStaticProcesses` is an
experimental opt-in profile for small static C programs. It adds guest fork,
exec from an immutable allowlist, specific-child wait and normal exit to the
existing finite captured-stdio profile. The original `.sparseStatic` remains
single-process and explicitly refuses those lifecycle syscalls.

```swift
let process = try FEXProcess(
    root: root,
    configuration: .init(
        arguments: ["/test/pipeline", "/test/cat"],
        regions: false, useNativeChannels: false,
        standardIO: .captured, executionProfile: .sparseStaticProcesses,
        standardInput: Data("A parent and child share this input.\n".utf8),
        additionalExecutablePaths: ["/test/cat"]),
    overlay: ["/test/pipeline": parentELF, "/test/cat": childELF])
// Mount process.webView in the existing UI before starting.
let result = try await process.run() // closes on exit, failure or cancellation
```

The additional executable list contains at most four distinct canonical
absolute paths. Each file is read once before guest startup, bounded to 1 MiB,
and copied into the authority's immutable executable store. Later guest exec
cannot consult an arbitrary host file or observe changes to those snapshots.
An absent allowlisted target returns ENOENT. Unsupported ELF/instruction/FD
policies remain typed UNSUPPORTED rather than a direct-runtime fallback.

The actual command is ordinary compiler output: its C parent reads/writes one
input byte, forks, the child execs the compiler-built copy program, and the
parent waits for its real guest status. The input open description and cursor
are shared, so the child continues after the consumed prefix. The compiler's
C frame has RSP modulo 16 equal to 8: fork preserves that frame and now admits
8-byte stack alignment. The separate same-process clone contract still
requires a fresh 16-byte stack; this browser profile refuses thread clone.

## Completion and retained resources

Guest-execution quiescence is different from physical worker retirement.
Every guest worker receives only its fixed 33-page internal memory and an
authenticated RPC route. Guest backing frames remain inside the kernel
authority; they are never borrowed by a guest worker or returned in a host
callback. The worker disables its entry point after its one run loop returns
or cooperatively unwinds, verifies that it has no pending unit replies and
reports its exact lease/slot identity. The host drains every owned code-map,
translation and compilation promise before publishing the matching receipt.
Uncertain native operations and worker errors without that receipt cannot
acknowledge completion. A timer is never a receipt.

The authority then revokes the old broker token. Exec can replace its image
and wait can reap normal guest status and close guest backing only after the
required receipts. Failed startup retains staged resources until its receipt;
failure after irreversible old-image stop cannot resume that image with errno
or fabricate a successful child status. Code catalogues also wait for native
request ownership to drain before dropping.

`W_OCCUPIED` stays set. Internal memories and their slots are never reused in
this browser profile, even after a guest-access receipt. All allocated internal
contexts remain retained until whole-session teardown, with a lifetime bound
of eight contexts. The parent/fork/exec command uses three, retaining 6,488,064
internal bytes. A normal result explicitly reports:

```
guestAccessQuiescenceAcknowledged: true
workerRetirementAcknowledged: false
internalContextsRetainedUntilSessionTeardown: true
```

Zero owned guest backing after completion is an authority accounting result.
It does not establish JavaScript collection, physical worker termination,
resident RAM reduction or a device memory limit. Whole-session close requests
worker termination and closes the backend; it makes no physical completion
claim. The legacy dense-memory browser path and its timed quarantine policy
are unchanged by this opt-in route.

## Bounds and evidence

All guest images share a 32 MiB backing budget. Internal contexts, input and
executable snapshots, native code catalogues and module caches are separate
bounded resources. Input stays limited to 1 MiB and each read/write to 64 KiB;
captured output remains UTF-8 text with an aggregate 4 MiB retention limit.
The process host bounds its translation cache to 256 entries and 2 MiB of
received translation bytes. Each run loop admits at most 20,000 instructions.

The syscall contract remains narrow: finite read/write, one leader per
process, at most one unreaped child, checked static exec, specific-child wait
and normal exit under default signal policies. Thread clone, futex, general
signals, filesystem/open/socket descriptors and dynamic ELF loading are not
enabled. Native memory/checkpoint/step/header/coverage are now 1/1/3/96/8;
existing raw-byte, IR-effect and full-pointer checks still precede execution.
This is not a Wine, libc, game, DXMT or general Linux compatibility profile.

```
python3 Examples/FEXHost/Guest/build-sparse-pipeline.py --native-check --output /tmp/pipeline.json
node tests/sdk/linux-host/sparse-pipeline.cjs /path/to/fexserve /tmp/processes.json /tmp/pipeline.json
python3 tests/sdk/sparse-process-browser.py --translator /path/to/fexserve
```

The native Linux oracle and live FEX tests include empty/text input, a read
boundary and failure propagation. The production browser worker runs inside
actual Node workers that deliberately stay physically alive after guest
completion, checking that quiescence cannot clear occupancy or imply physical
retirement. Actual Chromium adds BOM and larger-stream cases plus explicit
single-process refusal and missing-isolation controls. Ownership tests cover
lease mismatch, pending/uncertain native work, staged failure and rollback.
An opt-in macOS WKWebView test separately exercises production Swift transport
and resources with actual host FEX; its execution or capability skips must be
reported separately from compilation and physical-device testing.

The integrated app adds **Compiled C: fork, exec and inherited stdin** fourth
in Run All. Reports record both ELF identities, exact output/input hashes,
fork/exec identity, consumed input, guest steps, native counters, closed guest
backing and retained internal contexts. The two earlier sparse command phases
keep their original narrower contracts. Stop after a completed target phase,
wait for teardown, then share an explicitly partial report.
