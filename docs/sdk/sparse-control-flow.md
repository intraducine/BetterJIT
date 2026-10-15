# Experimental finite guest continuations

The [compiled C command profile](sparse-compiled-command.md) now extends this
work with coverage4, bounded stdout/stderr and a separate single-process phone
route. Its browser route still refuses fork/exec/retirement; host evidence is
separate from physical-device validation.

Step ABI and coverage revision 3 extend broker1 with register TEST/CMP (32/64-bit),
direct JZ/JNZ (rel8/rel32) and direct JMP (rel8/rel32). Memory/checkpoint ABIs stay
1/1. Unknown conditions, indirect control flow, calls/returns, stack effects and
memory TEST/CMP remain unsupported before execution. No default runtime policy
changes. The worker's existing step limit still bounds guest loops.

The 96-byte BJS1 header retains the old fields through byte 79 and adds a full
u64 branch target at 80, continuation kind at 88 (fallthrough/jump/conditional),
and reserved zero at 92. Module bytes start at 96. Parser and kernel independently
derive the expected target/kind from the admitted instruction bytes, preserving
signed displacement and full u64 PC arithmetic. Old versions and forged or
inconsistent target metadata cannot run.

Raw semantic admission is followed by complete FEX IR/effect validation. Branch
IR must contain exactly the declared constant exits; conditional instructions
must have the expected three-block/one-condition/two-exit shape and EQ/NEQ
condition. Memory and syscall effects remain separately counted. TEST permits
only the frontend's explicit AF invalidation hint; AF is architecturally
undefined there and is excluded from its flag oracle. No new guest-memory import
is added and no uncovered IR reaches a direct-memory fallback.

Branch exits spill their actual full RIP rather than replacing it with a forced
fallthrough. BEGIN checkpoints the trusted finite continuation set. FINISH accepts
only a fully spilled member of that set; an unexpected post-PC is a fatal
invariant, never silently corrected. Fault/unsupported paths retain the existing
complete CPU/lazy-flag/rounding restoration after unwind. Immutable private RX
bytes are still rechecked at every BEGIN.

The host execution matrix checks CMP/TEST 32/64-bit flag results and both JZ/JNZ
encodings against checked-in results from a separately compiled native x86
oracle. On Linux x86-64 it rebuilds that oracle and requires an exact match;
other hosts explicitly report the native oracle unavailable while checking real
FEX/Wasm against those fixed results. Taken/not-taken paths, signed backwards
targets, full high PCs, unchanged source registers, defined flag preservation,
and direct jumps are executed rather than inferred from emitted metadata.

An additional actual guest clone program tests RAX and chooses distinct parent
and child exit paths using generated TEST/JZ/JMP. The host does not select either
continuation. The initial process is host-created; its second thread is created
by guest clone as documented separately. Startup failure cases continue through
the guest parent path without publishing a child. This is the control-flow
prerequisite for a bounded fork/new-process program, not fork/exec support itself.

Native code changes require new provenance-checked iOS/host assets; incompatible
cached assets must be rebuilt, not relabeled or bypassed. Existing source and
native regression fixtures use the new versions. This remains host FEX-to-Wasm
evidence, separate from adapted Wine, stock Wine, WebKit/device execution and RAM
measurements.
