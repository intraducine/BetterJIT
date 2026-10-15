# Finite captured stdin for compiler-built commands

`dbef9e78a72d5963eaefa21be56b2751796f97c1` remains the identifiable first
ROT13 phone-test baseline. This next experimental increment runs a second real
program: `sparse-cat.c`, an ordinary freestanding C read/write loop. GCC emits
its instructions and ELF unchanged. It needs no libc, files, terminal or JSPI.
Its assembly is limited to syscall wrappers and a process-entry shim that
preserves C stack alignment and restores assembler section state.

## Public process input

`LinuxRuntimeConfiguration.standardInput: Data?` adds a finite byte snapshot to
`.sparseStatic` with captured stdio. Nil means EOF. Inputs are at most 1 MiB;
non-sparse input or oversized data fails before WebContent starts. Input bytes
travel through the authenticated loopback `/stdin` endpoint, never a launch URL
or fallback host-file read. The kernel owns a fixed ordinary copy.

```swift
let process = try FEXProcess(
    root: root,
    configuration: .init(
        arguments: ["/test/cat"], regions: false, useNativeChannels: false,
        standardIO: .captured, executionProfile: .sparseStatic,
        standardInput: Data("Hello from captured stdin.\n".utf8)),
    overlay: ["/test/cat": compiledELF])
// Mount process.webView in the existing UI before running.
let result = try await process.run() // closes after exit, failure or cancellation
```

Captured output is still separate UTF-8 text, with streaming decoding across
writes and explicit truncation; it is not a lossless binary-output API. Input
accepts bytes, including zero bytes. Valid BOM scalars are preserved at stream
and write boundaries; invalid output UTF-8 becomes U+FFFD.
Interactive input, asynchronous input producers, general open/read/seek/ioctl,
CLOEXEC and arbitrary inherited descriptors remain unsupported.

## Kernel and instruction contract

Host lifecycle capability 5 adds descriptor 0 backed by a finite owned snapshot.
Versions 1–4 retain their previous syscall scopes. Reads are bounded to 64 KiB
per call. Descriptor/first-byte errors return EBADF/EFAULT without consuming
input. EOF and zero-length reads need no mapped destination, after the requested
address-domain check. Fully mapped reads return the available prefix and then
EOF. Oversized operations and unsupported descriptor policies restore the
complete pre-SYSCALL checkpoint with typed UNSUPPORTED.

Read validates the destination and prepares copyout before touching the shared
input cursor. It copies only the selected prefix into owned staging, rechecks
the exact runnable owner, descriptor and cursor, and commits guest bytes before
advancing the cursor. There is no await, callback or guest allocation between
commit and consumption. Preparation allocation failure returns ENOMEM with the
old input and guest bytes intact; owner/cursor corruption is fatal. An unexpected
post-commit failure cannot be translated into a fabricated errno rollback.

A native Linux pipe oracle found that a partially faulting destination does not
have a universal writable-prefix return: this host returned EFAULT for a five-byte
read crossing into an unmapped/read-only page. A pure permission/commitment probe
therefore refuses those partial-fault cases before SYSCALL effects. The probe
allocates no guest frames and does not detach private views. This increment does
not claim generic Linux partial-fault semantics or silently turn them into a
successful short read. Native EOF, zero-count, address-domain and first-byte
fault cases are recorded independently.

The input open description and cursor are shared across actual guest fork and
preserved by exec. A parent can read/write one byte, then a compiler-built child
reads the remainder: combined output is exact, without replaying the prefix.
Cancellation releases only the attempted child's references. Fatal exec after
old-worker stop closes all owned stdio after both worker acknowledgements; it
cannot resume the old image with errno or invent a child wait status.

The compiler's negative-read check uses JS. Coverage becomes 6, adding short and
near JS/JNS to the existing finite branch contract. Memory/checkpoint/step/header
remain 1/1/3/96. FEX raw admission and complete IR validation remain mandatory;
104 native arithmetic rows now yield 1,040 FEX/Wasm comparisons across unsigned,
equality and sign branches, including both sign-branch encodings. Other signed
relational, parity and overflow branches, CALL/RET, PUSH/POP and general ISA
coverage remain unsupported. The native/JS coverage version rejects stale peers.

## Validation and integrated app

```
python3 Examples/FEXHost/Guest/build-sparse-cat.py --output /tmp/cat.json --native-check
node tests/sdk/linux-host/sparse-cat.cjs /path/to/fexserve /tmp/cat-live.json /tmp/cat.json
python3 tests/sdk/sparse-browser.py --program cat --translator /path/to/fexserve
```

Ten real FEX/Wasm cases cover empty/text input, UTF-8 split at a 4096-byte read
boundary, a 256 KiB stream, argument refusal, a closed stdin error using JS and a
shared cursor across fork/exec, plus BOM scalars at stream start and split or
aligned read boundaries. They compare actual output byte counts/hashes
against direct native execution and finish with zero broker owners/backing after
owned request/worker drains. The independent pipe oracle records ten memory/EOF
cases. Chromium executes eight public-profile cases with exact output and input
consumption; large stdout is hashed in evidence rather than printed in full.
Linux CI also builds fresh compiler output for Apple FEX validation. An opt-in
real macOS WKWebView test uses the production Swift session/server/resources;
its execution or capability skip must be reported separately from compilation.

The same integrated app keeps **Compiled C: ROT13 text command** second in Run All
and adds **Compiled C: captured stdin and stdout** next. The latter supplies UTF-8
crossing a read boundary and checks exact captured output, exit, native activity
and structured input-consumption evidence. Shared reports include source and
ELF hashes, input/output digests, provided/consumed input bytes, positive reads,
guest Wasm steps, separate native counters, streams and truncation flags. Stop
after a desired completed phase, wait for teardown and share the partial session;
unrun phases remain explicitly skipped. No separate app or cosmetic-only phone
build is required.

Browser process creation, guest exec, futex, wait/reaping and worker-retirement
acknowledgement remain unsupported. Guest backing, internal contexts, module cache
and native catalogue stay retained until whole-session teardown. Input copies
are separately bounded host buffers, not part of the guest backing counter.
Host execution/unsigned app compilation establishes no physical-phone, resident
RAM, stock Wine or DXMT compatibility. Paused stock-preloader research is not
part of this increment. A portable SDK export and outside-checkout consumer build
remain separate deliverables from publishing a repository/package or release.

For the separate opt-in compiled parent/child route, see
[bounded static process trees](sparse-processes.md). The original profile and
its retention policy remain unchanged.
