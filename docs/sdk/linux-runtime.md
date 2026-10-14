# Linux and Wine runtime

`BetterJITLinux` promotes the repository's existing browser Linux/Wine research
runtime into a package product. It is separate from the small `RuntimeSession`
Wasm API: this mode runs an x86-64 Linux process model with shared guest memory,
Web Workers for guest threads, FEX translation on demand, ELF loading, a Linux
syscall/VFS layer, futexes/signals, ntsync support and the browser compositor.

The application supplies two capabilities:

- a `LinuxTranslationBackend` backed by the native FEX frontend/backend;
- a `LinuxFileSystemSource` containing a Linux/Wine root tree.

`LinuxRuntimeSession` owns a loopback-only server and WKWebView. The initial
request carries a random session token which becomes a same-origin session
cookie; dynamic translator/filesystem routes reject requests without it.
Cross-origin isolation headers enable SharedArrayBuffer and shared
WebAssembly.Memory. No public-network listener is used.

The package contains the promoted runtime assets under
`Sources/BetterJITLinux/Resources`. `Examples/FEXHost` supplies
`LinkedLinuxFEXBackend` using the locally-built device-arm64 CFEXWasm package.

## Device smoke

The FEX Host contains a tiny bundled x86-64 ELF that writes
`BetterJIT Linux OK` and exits through real Linux syscalls. It does not need an
external rootfs. Use **Run Linux ELF** to exercise:

1. the ELF loader;
2. Linux address-space setup;
3. shared guest memory/thread worker startup;
4. dynamic code mapping into native FEX;
5. on-demand FEX -> Wasm translation;
6. guest syscalls through the Linux kernel worker;
7. process exit and cleanup.

## Wine

The combined FEX Host session can bundle a stock Alpine/musl Wine input candidate.
`python3 scripts/prepare-wine-root.py` uses a digest-pinned official Alpine image,
fixed Wine version, signed APK verification and recorded dependency/source
provenance; it requires Docker/Linux-amd64 and repository download access.
The device-session workflow transfers that prepared root to the Apple app build.
It is not the historical patched Wine/wasmdrv stack and is not yet compatibility
or DXMT evidence. Missing optional inputs remain explicitly unsupported.


Stage the existing Wine root tree at:

`Documents/linuxroot`

with `/opt/wine/bin/wine` present. The FEX Host enables iOS file sharing, so
its Documents directory is visible in Files/Finder. If you have the historical
BetterJIT build outputs on a Mac, assemble the expected single-root layout with:

```bash
python3 scripts/stage-linux-runtime.py --clean --strict
```

The default output is `.build/device-linuxroot`; copy/rename that directory to
`linuxroot` inside the app's Documents directory. The staging tool merges the
historical root, musl `lib`, `/opt/wine`, and test mounts and writes
`.symlinks.json` plus `.modes.json` so guest symlinks and executable modes do
not depend on metadata surviving the transfer. **Run Wine cmd** launches:

`/opt/wine/bin/wine cmd /c ver`

using the same runtime. This is a runtime bring-up target, not a claim that
arbitrary games already render. The promoted Linux stack contains the Wine
process/syscall/VFS/ntsync/audio/compositor machinery; native DXMT command
handling and Metal presentation remain an application-supplied graphics backend.

The runtime enables the existing OPFS channel protocol by default. WebKit workers
create fixed-size per-kind channel files, the native host discovers and MAP_SHARED
maps those files by an unguessable magic header, and dedicated responders handle
translator-unit requests plus kernel code/file operations without loopback HTTP
round trips. Channel files use bounded request/response regions and fixed headers.

If OPFS discovery/attachment fails, the JavaScript runtime retains its existing
same-origin HTTP fallback for translator and filesystem operations. GPU channel
requests use the same mechanism but are delegated to the application's optional
`LinuxGPUChannelHandler`; BetterJIT does not fabricate a DXMT implementation.
The ordinary BetterJIT execution API separately keeps its validated typed-binary
mapped service lane for high-volume registered native services.

## Filesystem

`DirectoryLinuxFileSystem` indexes a directory lazily and supports bounded
range reads for large game data files. An overlay dictionary can inject bundled
files without copying them into Documents; the sample uses this for the smoke
ELF. `.symlinks.json` and `.modes.json` are honored for roots staged by tools
or Files providers that cannot preserve Unix symlinks and executable modes.

## Boundaries

`LinuxRuntimeConfiguration.standardIO` defaults to `.terminal`. Use `.captured`
for headless output: stdin reaches EOF and terminal ioctls return ENOTTY.
These streams report FIFO file type instead
of a terminal character device. The adapted command and nested Win64 tests use
this mode so Wine handles them as redirected streams. The nested fixture checks
the Win32 output handle type and absence of console mode before its spawn tests.
This does not change Wine bootstrap services or guest memory limits.

`LinuxRuntimeResult.stdout` and `.stderr` contain separate UTF-8 text streams.
Decoding continues across guest writes, with no inserted newlines; malformed or
incomplete UTF-8 becomes U+FFFD. This is text capture, not a lossless binary API.
Use guest files and the filesystem interface for binary output. `.log` and
`onLog` contain runtime diagnostics only; `onOutput` identifies each guest stream.
Consumers must check success markers in `.stdout`, not a merged diagnostic log.
The shared retention limit remains 4 MiB of UTF-8 across all three strings;
`outputTruncated` reports omitted text. Ordered transport batches deliver retained
text before the explicit exit event. Guest text that resembles a log or exit
marker is never interpreted as process completion. Failed output delivery cannot
produce a successful completion; the session remains subject to its deadline.

Fork constructs a small child memory, grows it to cover inherited mappings, and
copies their tracked dirty bytes without sharing private data or changing the
configured maximum. It does not construct the parent's entire grown buffer up
front or copy an unmapped tail. This is an allocation strategy, not a RAM grant.
`[memory-allocation]` records failures at construction, pooled-memory growth, or
mapping growth, with requested/current pages, inherited mappings, pool state and
the current kernel's live memories. Mapping failures identify the requesting
process, address space, executable and mmap parameters. Sampling retains the
first failure for each process/operation within the sixteen-event limit, so
repeated allocation probes do not hide later processes. Reports preserve first
and last sampled failures; neither is automatically the workload's root cause.
Tracked dirty bytes and Wasm linear sizes
are not OS resident memory or an iOS/WebContent memory-limit measurement.
The pool retains compatible reservations within its original six-entry budget,
so simultaneous fork/exec demand can reuse more than one buffer if construction
is refused before collection progresses. It releases incompatible maximum-size
classes when allocating another class. A ready buffer already large enough is
preferred over growing a smaller one. Every buffer keeps its own 1.5-second
quarantine; discarded buffers are never cleared or reused while a terminating
worker may still own them. `pool-pruned` events describe released references,
not immediate engine collection or OS RSS reduction. A construction failure can
also be recovered by quarantined-memory reuse in a passed phase.

The opted-in adapted Wine loader provides a reuse hint for its known fixed
shared-user-data address before exec publishes the image. Pool selection uses
that address as well as the small initial allocation. A fitting retired buffer
can complete its quarantine within the existing total 1.5-second wait budget
before an undersized ready buffer is selected. With no fitting spare, construction
still starts small; the hint does not force growth, change maxima, or bypass
guest mappings. Active memories are never swapped on a late growth failure.
Bounded `memory-selected` events identify constructor versus pool selection,
selected capacity, the selection target and time spent waiting.

The page explicitly owns every guest worker. Termination clears callback captures,
removes ownership and rejects delayed translation replies for that worker. Slot
release callbacks retain only the small kernel control buffer and slot number,
not the full guest spawn message. Session exit and page navigation stop worker,
statistics, log and deadline activity. This bounds ownership; it does not promise
that WebKit will immediately reclaim every reservation or accept the next fork.


The guest address space is WebAssembly memory32 and therefore remains below
4 GiB per process. That is an address-space limit, not a RAM entitlement.
WebKit/OS memory pressure still applies. The software-paging experiments remain
a separate backing strategy rather than silently pretending a larger resident
Wasm memory exists.


## Native channels

The xlat channel currently handles translated-unit lookup and writable/executable
code patch notifications. The kernel channel handles executable-code mapping,
unmapping, address-space drops, and bounded file range reads. Region translation
remains on the authenticated same-origin request path because it is asynchronous
and not on the synchronous syscall critical path.

The channel backing file is accepted only when it is a regular single-link file
of the exact expected size, is opened with `O_NOFOLLOW`, and begins with the
session magic supplied by the WebKit worker. Native mappings are non-executable.

The separately adapted Wine input can opt into `BETTERJIT_WINE_SPAWN=1`. This
uses parent-prepared argv/environment and POSIX spawn actions for stdio, cwd,
session, SIGPIPE and server-socket inheritance, removing an intermediate
double-fork address-space copy. It does not replace generic fork with vfork.
Spawned Unix children are owned and reaped by a detached native thread; a
reaping setup failure terminates and waits for the child instead of abandoning
it. Stock Wine retains its existing launch path. The candidate records this
policy and runs a real spawn contract before Wine in the same device phase.
Actual Windows output and exit 0 remain required. Native contract, guest contract,
Wine host execution and phone execution are separate evidence levels.
