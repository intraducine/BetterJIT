# Sparse register BT

Coverage 21 adds register-only `BT r16/r32/r64,r16/r32/r64` (`0F A3`)
and `BT r16/r32/r64,imm8` (`0F BA /4`) to the existing operation 6,
wire width 0 contract. The memory/checkpoint/step ABIs remain 1/1/3 and
the header remains 96 bytes. This is shared SDK execution coverage.

The bounded prefix grammar permits one optional `66`, then one optional REX.
REX.W overrides `66`; REX.B selects the base register, REX.R selects a register
index and is ignored for `/4`. REX.X has no effect on a register encoding.
The ModRM must select a register. All operands and the immediate must be present.
Memory BT, BTS/BTR/BTC, LOCK/REP, segment/address-size prefixes, repeated prefixes
and prefixes in the wrong order remain unsupported. There is no byte BT form.

The bit index is modulo 16, 32 or 64. BT sets carry to that selected bit and
writes neither operand, including the upper 32 bits of a 32-bit operand. Intel
specifies ZF as unaffected; AMD lists the noncarry arithmetic flags as undefined.
The pinned FEX lowering preserves ZF/SF/OF and the raw PF/AF values. That stronger
implementation behavior is tested separately from the native carry result and
observed ZF/DF preservation. No native undefined OF/SF/AF/PF value is an oracle.

A dedicated internal BT marker binds the complete pinned FEX IR to the decoded
base/index/width. It permits full GPR reads, a word-index mask of 15 when needed,
the correct 32/64-bit logical shift, a one-bit extract, an old-NZCV read and
one-bit carry merge, inverted-carry normalization, one NZCV store and exact
fallthrough. It rejects any GPR, PF/AF, context or guest-memory write, extra
effects and altered or reordered dataflow. Alias operands use one shared load.
The normal complete broker-effect gate still runs. No emitter body changed.
FEX's instruction length must match the independent decoder and the fallthrough
must stay below the existing low-47-bit address limit.

`sparse-bit-test-oracle.c/json` retain actual native x86-64 register and immediate
results, large/negative indexes and self-index aliases. Both complete operands
must remain unchanged. `sparse-bit-test.cjs` compares the retained oracle with
actual FEX-generated Wasm, all supported prefix/register combinations, all 256
immediates, independently varied flags/DF, real lazy flag predecessors, short
and near carry branches, raw refusal cases and address-domain controls. A fresh
native replay is explicitly skipped on non-x86 hosts while the retained oracle
and actual FEX/Wasm checks still run. The existing immediate-TEST IR diagnostic
also mutates actual BT IR to test the complete linked proof.

```sh
node tests/sdk/linux-host/sparse-bit-test.cjs .build/host-fex/fexserve .build/sparse-bit-test-results.json
.build/host-fex/sparse-test-immediate-ir > .build/sparse-test-immediate-ir-results.log
```

The preserved run 92 receipt at source `aaae963` advanced the exact adapted Wine
launcher/musl probe from 3,381 to 3,491 Wasm steps and from 439 to 505 compiled
units, then stopped at `480fa3c8` (`BT RAX,RCX`), RIP `0x7f00000367e9`, with
guest exit null. Its host cache had 506 entries and 293,924 serialized bytes
before drop, leaving six slots under the unchanged 512-entry host probe cap.
These are historical pre-BT results, not a new Wine boundary for coverage 21.
The separate cache proposal changes no policy in this patch. Host fixtures do
not establish complete Wine execution, phone memory headroom, or guest native
JIT replacement.
