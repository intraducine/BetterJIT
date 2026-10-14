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

Fork constructs a small child memory, grows it to cover inherited mappings, and
copies their tracked dirty bytes without sharing private data or changing the
configured maximum. It does not construct the parent's entire grown buffer up
front or copy an unmapped tail. This is an allocation strategy, not a RAM grant.
`[memory-allocation]` records failures at construction, pooled-memory growth, or
mapping growth, with requested/current pages, inherited mappings, pool state and
the current kernel's live memories. Tracked dirty bytes and Wasm linear sizes
are not OS resident memory or an iOS/WebContent memory-limit measurement.
The pool retains one spare per immutable maximum and releases incompatible
spares when allocating another size class. It prefers a grown spare, preserving
each retained buffer's own 1.5-second quarantine; equal-capacity retirements keep
the earlier candidate. Discarded buffers are never cleared or reused while a
terminating worker may still own them. `pool-pruned` events record released
references separately from allocation failures and successful forks. Engine
collection and budget reclamation are not guaranteed immediately. A construction
failure can also be recovered by quarantined-memory reuse in a passed phase.

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
