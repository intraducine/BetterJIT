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

Stage the existing Wine root tree at:

`Documents/linuxroot`

with `/opt/wine/bin/wine` present. **Run Wine cmd** launches:

`/opt/wine/bin/wine cmd /c ver`

using the same runtime. This is a runtime bring-up target, not a claim that
arbitrary games already render. The promoted Linux stack contains the Wine
process/syscall/VFS/ntsync/audio/compositor machinery; native DXMT command
handling and Metal presentation remain an application-supplied graphics backend.

The first integration uses the runtime's HTTP fallback for synchronous code/file
operations (`chan=0`) because it is correctness-first and does not require a
second OPFS channel protocol. Large FEX service traffic in the ordinary
BetterJIT execution path already uses the validated typed binary mapped lane.
A native channel backend can replace the Linux HTTP fallback without changing
the guest kernel contract.

## Filesystem

`DirectoryLinuxFileSystem` indexes a directory lazily and supports bounded
range reads for large game data files. An overlay dictionary can inject bundled
files without copying them into Documents; the sample uses this for the smoke
ELF. `.symlinks.json` is honored for roots staged by tools that cannot preserve
all Unix symlinks.

## Boundaries

The guest address space is WebAssembly memory32 and therefore remains below
4 GiB per process. That is an address-space limit, not a RAM entitlement.
WebKit/OS memory pressure still applies. The software-paging experiments remain
a separate backing strategy rather than silently pretending a larger resident
Wasm memory exists.
