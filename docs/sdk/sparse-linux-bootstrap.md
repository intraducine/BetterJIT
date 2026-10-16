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
The prepared Wine/musl inputs include `GNU_PROPERTY_X86_FEATURE_2_USED`
(`0xc0010001`) values `1` and `0xb` (X86/X87/XMM usage). Defined optional
`FEATURE_2_USED` and `ISA_1_USED` bits are recognized; these usage descriptions
do not require enabling those CPU features. Unknown bits and unsupported
`NEEDED` requirements remain refused. Constants follow the
[LLVM ELF definitions](https://github.com/llvm/llvm-project/blob/main/llvm/include/llvm/BinaryFormat/ELF.h).
The usage/requirement distinction follows section 5.2.1 of the
[AMD64 ABI](https://raw.githubusercontent.com/wiki/hjl-tools/x86-psabi/x86-64-psABI-draft.pdf).
Recognition does not broaden the native emitter: SIMD, x87 and other uncovered
instructions still stop through ordinary typed instruction admission.

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
The host explicitly enforces a 20,000-step execution budget and a 30-second
deadline; the 64-entry diagnostic trace is a separate history cap. Completed
unsupported probes must have a positive integer executed count within that
budget. Step-limit exhaustion remains a failure with retained partial progress.
Native `units` and `guestInsts` count successful single-instruction translations,
not executions: cached units may run repeatedly. Both native counts must match,
be positive and not exceed executed steps, with exactly one rejected terminal
translation. A synthetic finite loop verifies 258 executions of four translated
units; lowering its budget to 64 must fail without a completed result.
The fixed internal worker memory and occupied slot remain retained until session
teardown; this does not prove physical retirement or lower resident RAM.

Coverage 7 adds the register-only `81 /4` and `83 /4` immediate AND forms for
32/64-bit operands, including the interpreter's `and rsp,-16` alignment step.
FEX still performs the full decode and existing IR/effect validation. The
immediate is sign-extended from 8 bits for `83`, or from 32 bits for a 64-bit
`81` destination; 32-bit writes zero the upper register half. Memory, byte,
16-bit and prefixed forms remain outside this increment. The host companion
`sparse-and.cjs` executes 384 cases across RAX/RSP/R8 against 128 native x86
oracle rows. It checks defined CF/PF/ZF/SF/OF, live flag replacement, finite
branches, other GPR/rounding preservation and typed rejection with no module
for unsupported/truncated forms. AF is undefined and excluded. These scalar
results do not establish a later Wine bootstrap boundary; that requires the
separately labeled exact prepared-input probe above.

The subsequent [coverage-8 CALL/RET slice](sparse-call-return.md) handles the
direct CALL proven at `0x7f000006a986` by the coverage-7 prepared-input probe.
Its synthetic nested-call control is separate from that exact Wine input.

`--synthetic` instead selects explicit synthetic layout controls; `--system-elf`
selects the local Linux `true` and glibc interpreter. Those runs are labeled
separately and cannot stand in for the prepared adapted Wine result. None of
these host probes is WebKit or physical-device evidence. Full sparse adapted
Wine, dynamic `execve`, the broader Linux syscall surface and the remaining
instruction families are still unfinished.

The probe checks the musl-shaped entry's `MOV RDI,RSP` immediately after that
first instruction. Later code may change RDI. Applicability is determined from
the owned executable input bytes, without reading beyond a short guest mapping.
Other entry sequences report `applicable:false, verified:false`; they do not
claim that this instruction-specific stack transfer was verified. Terminal
status, null exit, quiescence, retained contexts, stack RPC and expected-register
assertions still apply.

Failures write `status:"probe-failed"` JSON to the requested report path and
retain a nonzero CLI exit. The record includes input hashes, stage, the exact
bounded error, available native counters, and the last received guest progress
or completed result. Progress survives loss of the native child. Diagnostic
code is limited to 15 bytes and trace history to 64 steps; full CPU/memory dumps,
environment, host stacks and host paths are omitted. The existing CI sparse
artifact retains this report even when the probe fails.

`sparse-bootstrap-contract.cjs` exercises all three controls, a legal later
RDI clobber, a different entry sequence, an incorrect initial stack transfer,
native startup/death and a post-result assertion failure. Its synthetic results
do not identify the exact failed assertion in run 38863139120, whose Wine
command failed before producing a report.

The enclosing contract test also saves a bounded checkpoint before inspecting
the native-death subprocess report. On failure it retains `contract-failed`
JSON with partial case results, subprocess exit status/signal, redacted stderr,
executable-access booleans and fault-injection milestones. A confirmed third-step
kill is distinguished from an earlier startup exit or an unconfirmed kill.
The failure artifact retains these diagnostics after temporary files are removed.
The original report, exit, counter and progress assertions remain required.

The [coverage-11 non-LOCK ADD memory slice](sparse-memory-add.md) addresses the
next instruction proven by green run 38871692398. Its host arithmetic and memory
fixtures remain separate from the exact prepared Wine result.
