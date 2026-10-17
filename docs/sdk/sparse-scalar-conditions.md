# Scalar conditions and register calls

Coverage 26 keeps memory/checkpoint/step ABI 1/1/4 and the 96-byte header.
It adds generic register-indirect near CALL (`FF /2`, register ModRM), the
remaining short/near Jcc and register CMOV conditions, word CMP register forms
and word logical immediates. The default runtime and execution budgets retain
their existing contracts. Admission depends on instruction bytes and operands.

Register CALL admits all 16 GPRs and a single optional REX, whose B bit extends
the selected target. The compiler proves the actual FEX load of that GPR before
the push, one checked 8-byte return-address write at old RSP minus 8, the RSP
store and the dynamic exit. CALL RSP therefore targets the original RSP. BEGIN
owns that complete target and stack pointer. The broker checks executable,
readable target storage before publishing any push, rechecks it after COW
preparation, and requires the exact decoded return PC. FINISH permits only RIP
and RSP changes. Memory-indirect/far CALL and additional prefixes remain refused.
A failed push or invalid target preserves the complete checkpoint and storage;
a committed write cannot subsequently be reported as unsupported rollback.

Word CMP admits `66 39`, `66 3b`, `66 3d` and register `66 81/83 /7` in addition
to the existing memory-immediate forms. Ordinary 64-bit ModRM/SIB/RIP-relative
addressing and one non-W REX are supported. REX.W, segment/address-size/LOCK/REP
and repeated/reordered prefixes remain outside this word profile. Register
forms use operation 6, width 0, with no guest memory request; memory forms keep
operation 8, width 2 and exactly one checked read. The decoder records both
operand roles and the compiler binds those roles to word NZCV, full low-32-bit
PF subtraction and immediate-dependent or XOR-derived AF. It preserves all
GPRs. The inline-constant offset scale correction remains part of the shared
address proof, with compensated wrong-address controls at scales 2, 4 and 8.

Word OR/AND/XOR admits register `66 81/83 /1,/4,/6` and accumulator
`66 0d/25/35`. It preserves the upper 48 GPR bits and computes word flags.
The compiler proves the actual 64-bit result/mask, word TEST, carry inversion,
PF store and destination; the all-ones AND identity has its own exact shape.
CF and OF clear, PF/ZF/SF reflect the word, and AF remains undefined. The broker
requires the pinned descriptor and unchanged raw AF, padding and rounding.

All 16 Jcc conditions admit short `70..7f` and near `0f 80..8f` forms. All 16
CMOV conditions admit register-only 32/64-bit `0f 40..4f` forms. The compiler
binds the true and false branch blocks to their decoded targets and proves
CMOV's source, old destination, width and flag preservation, including parity's
NZCV save/restore sequence. CMOV32 clears the upper half even on false and
same-register paths. The broker evaluates the condition from owned scalar lazy
flags, validates the exact allowed representation changes, and rejects changed
operands, flags, rounding or unrelated state. Floating-point descriptors remain
outside this scalar contract.

`sparse-conditions.cjs` compares actual pinned FEX/Wasm to retained and freshly
reproduced native x86 rows. It covers all conditions, both CMOV widths, every
GPR, signed branch displacements, word producers, ADD/SUB/TEST lazy
producers, exact checkpoint ownership, read faults and rollback.
`scalar-condition-ir.cpp` mutates independent copies of real FEX IR and includes
the complete register-CALL proof matrix. Broker/header/kernel controls are in
`linux-sparse-conditions.test.mjs` and `linux-sparse-call.test.mjs`. The dynamic
ELF fixture exercises the new forms and nested calls through production workers.
The normal Apple workflow builds and retains these diagnostics. The local
iteration runner selects `conditions` and `call` alongside existing families.

The last inspected Wine run, `39006530922`, used published `3c43db4` and stopped
at `0x7f000003905a`, `ff d0` (CALL RAX), without a guest exit. Its successful CI
gate is a bounded prefix. These synthetic checks establish neither Wine command
completion nor device execution. Runtime retirement acknowledgement remains a
separate event from successful later host teardown. The next automatic probe
must retain the exact Wine/musl inputs, argv/environment and execution budgets.
