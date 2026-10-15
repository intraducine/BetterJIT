# Experimental Linux interpreter bootstrap

`guest_linux_image.js` prepares a bounded x86-64 Linux executable with one
`PT_INTERP` image. It is an internal integration step toward sparse adapted Wine.
The public `.sparseStatic` and `.sparseStaticProcesses` profiles retain their
static-only loader and still refuse these dynamic images. The new loader is not
selected by the app or by guest `execve`.

The executable and interpreter each come from owned ordinary byte snapshots,
at most 1 MiB per file. The interpreter is resolved only through an immutable
`ExecutableStore`; absence and execute-permission failures return image errors.
There is no host-file fallback. Each image has at most 32 program headers, and
combined load pages plus the 256 KiB stack are limited to 32 MiB of guest backing.
Load pages must be distinct, readable and R/RX/RW. Executable stacks, unknown
segments, noncanonical interpreter paths, nested interpreters, overlapping
images and unsupported GNU properties fail before guest execution.

The loader supports `ET_EXEC` at its linked addresses and `ET_DYN` with a fixed
high load bias. The interpreter is `ET_DYN` at a separate high bias. These
deterministic placements are not ASLR. Partial-page file prefixes, zero-fill BSS,
mapped program headers and checked ELF metadata are preserved. Both images are
validated before a new address space is created; any allocation failure closes
that temporary space and leaves the old image unchanged.

Initial RIP points at the interpreter. `AT_PHDR`, `AT_PHENT`, `AT_PHNUM` and
`AT_ENTRY` describe the main executable; `AT_BASE` describes the interpreter.
The stack also includes `AT_PAGESZ`, `AT_FLAGS`, `AT_SECURE=0`, `AT_RANDOM` and
`AT_EXECFN`. No VDSO, CPU feature, TLS, relocation or sealed RELRO state is
invented. Dynamic linking, TLS initialization and final RELRO protection remain
the interpreter's responsibility and require additional sparse runtime support.
The layout follows the [ELF program-header and base-address contracts](https://www.sco.com/developers/gabi/latest/ch5.pheader.html).

Run the bounded host probe with prepared inputs:

```sh
node tests/sdk/linux-host/sparse-linux-bootstrap.cjs \
  .build/host-fex/fexserve .build/sparse-wine-bootstrap-results.json \
  .build/device-linuxroot
```

The experimental CI workflow requires this probe. It verifies the adapted Wine
launcher's SHA-256 against its preparation receipt, resolves its staged musl
interpreter through the guest symlink manifest, and runs the actual entry bytes
through the production sparse kernel, browser worker and host with fresh
FEX-generated Wasm. It records the first unsupported instruction, actual executed
step count and guest-access quiescence. A typed unsupported stop is the expected
bootstrap boundary, with no guest exit code or successful Wine-command claim.
Native requests must drain before catalog removal and guest storage release.
The fixed internal worker memory and occupied slot remain retained until session
teardown; this does not prove physical retirement or lower resident RAM.

`--synthetic` instead selects explicit synthetic layout controls; `--system-elf`
selects the local Linux `true` and glibc interpreter. Those runs are labeled
separately and cannot stand in for the prepared adapted Wine result. None of
these host probes is WebKit or physical-device evidence. Full sparse adapted
Wine, dynamic `execve`, the broader Linux syscall surface and the remaining
instruction families are still unfinished.
