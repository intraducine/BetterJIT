# Bounded register SHL, SHR and SAR

Coverage 12 adds register-only `D1 /4,/5,/7`, `C1 /4,/5,/7 ib` and
`D3 /4,/5,/7`: 32- and 64-bit SHL, SHR and SAR with count one, immediate byte
or CL. They use existing register-flags operation 6, with no guest memory RPC.
Memory, byte/word, rotates, `/6`, double shifts, LOCK, REP, segment and
address/operand-size prefix forms remain outside this increment. A single
optional REX selects width and destination; FEX must decode the complete one
instruction and its IR must pass the existing complete effect gate.

The new gate admits `ShiftFlags` only for operation 6, an i64 PF result, an
embedded operand size of 32/64 bits, and LSL/LSR/ASR. The result header size and
embedded guest operand size are different fields. Immediate shifts already
lower to admitted arithmetic/flag operations; variable shifts use the existing
Wasm shift/conditional-flags emitter. Unknown IR remains a typed unsupported
result with no executable module. No vendor FEX source or shift emitter was
changed for this increment.

Counts use five low bits for dword operands and six for qword operands.
Effective zero preserves every arithmetic flag, including AF, PF and OF.
The dword destination still clears its upper 32 bits, including for effective
zero. CL aliases use the old RCX value for both input and count. For nonzero
effective counts, CF/PF/ZF/SF are defined; OF is defined only for count one.
AF after nonzero shifts and OF after larger shifts are unspecified. Tests
exclude those undefined values from comparison. Every nonzero masked count in
this 32/64-bit family is below its operand width, so CF remains defined even
when the unmasked byte was at least the width. These rules follow the
[Intel instruction reference, SAL/SAR/SHL/SHR](https://cdrdv2.intel.com/v1/dl/getContent/671241),
Vol. 2B, pages 4-603 through 4-606.

`sparse-shift-oracle.c` executes native x86 shifts and captures flags immediately
before and after each instruction. Immediate-byte encodings are emitted
explicitly, including count one. Its 6,480 retained rows contain only defined
result/flag expectations, selected boundary counts from 0 through 255, sign and
upper-bit patterns, three ADD32/SUB64 flag seeds and old-CL alias cases. Linux
x86 hosts rebuild and execute the oracle. Apple arm64 explicitly reports no
fresh x86 oracle and compares actual FEX/Wasm against the retained rows.

`sparse-shift.cjs` executes 19,560 shifts and checks all 16 GPRs, all destination
registers, rounding state, zero memory RPCs and finite branch consumption of live
flags. Its 4,074 zero-count cases additionally preserve the entire CPU flag
representation and lazy kind/operands. Unsupported encoding tests cover 69
memory/prefix/width/other-family/truncation cases. The production dynamic-kernel
bootstrap also executes eight synthetic instructions, including masked-zero CL
and dword shifts, with no memory requests and released guest backing.

The host `sparse-scalar-shift-ir` diagnostic compiles copies of actual FEX IR:
eight valid 32/64-bit forms and 56 malformed width/header/shift/profile/effect
variants. Its source participates in host identity, its produced bytes are
hashed in the cache inventory, and CI runs it and retains its log even when
the host translator is reused. This is a compiler diagnostic, separate from
the actual Wasm execution matrix.

The parent inspector verified green `e55d07f` / run
[38879069597](https://github.com/intraducine/BetterJIT/actions/runs/38879069597)
against sparse artifact SHA-256
`415a0c19ddc608d4ae0174348283415aba7a6a85f121f5549b9813e5bd98aca0`.
With the same prepared inputs, Wine advanced from 653 to 665 Wasm steps and
100 to 104 compiled units, then stopped at `0x7f00000366d4`, bytes `48 d1 e8`
(`SHR RAX,1`), with guest exit null. Its ADD matrix passed 1,644 checks /
4,885 Wasm steps against retained Linux oracle rows, not a fresh macOS x86
oracle. Its ADD IR diagnostic checked 138 copies with zero unexpected outcomes.
The new shift fixtures do not establish a later Wine boundary. That requires
another exact prepared-input probe after this patch is reviewed and published.
No physical-device, full Wine, RAM or JIT-replacement result is claimed.
