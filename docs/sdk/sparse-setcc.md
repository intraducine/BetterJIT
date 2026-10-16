# Sparse register SETcc

Coverage 18 admits `0F 90..9F` with a register destination. It uses existing
wire operation 6 with width zero. Each condition writes exactly one byte;
all other destination bits and architectural flags, including AF and DF,
remain unchanged. Memory destinations remain unsupported.

The bounded prefix grammar accepts an optional `66` followed by at most one
REX. Operand size, REX.W/R/X and ModRM.reg do not change SETcc semantics.
Without REX, register numbers 4–7 select AH/CH/DH/BH. Any REX selects low bytes
instead; REX.B extends the register number. Repeated prefixes, REX before `66`,
address/segment overrides, REP and LOCK remain outside this profile.

The native decoder independently binds instruction length, condition, register
and byte shift. Before emission, the complete IR proof requires one exact
condition read, one selected GPR64 read, BFI8, one selected GPR64 store and
constant fallthrough. Nonparity conditions use the pinned FEX NZCVSelect
mapping; parity conditions require the exact LoadPF/Parity mask and inversion.
All additional memory, context, flag, syscall and register effects are refused.
Condition reads may materialize the backend's lazy NZCV representation while
preserving architectural flags and the PF/AF raw fields.

The retained native x86 oracle covers all sixteen conditions, all 32 combinations
of CF/PF/ZF/SF/OF, independently varied AF/DF, four full-width destination inputs,
and AL/AH/SPL/R12B plus ignored prefix and ModRM bits. On Linux x86-64 the test
rebuilds and reruns it before comparison. On other hosts the test explicitly
reports that the retained native oracle supplies the comparison. The sparse
FEX/Wasm matrix covers every low/high legacy byte and every REX byte register,
all seven flag bits, ignored encoding bits and actual lazy-flag predecessors.
The IR diagnostic mutates copies of real frontend IR to verify refusal.

The preceding same-input Wine/musl host probe at `d62ca11`, successful run
[38925276704](https://github.com/intraducine/BetterJIT/actions/runs/38925276704),
reached 3,341 Wasm steps and 399 compiled units before unsupported `0f94c0`
(`SETE AL`) at `0x7f0000036c54`, with no guest exit. It used the explicit host
probe budget of 512 units, 2 MiB serialized translations, 20,000 steps and
30 seconds. Before cleanup the report observed 400 cache entries, 231,547
serialized translation bytes, Node RSS 189,857,792 bytes including workers,
and native child RSS 7,962,624 bytes. After worker/kernel cleanup it reported
zero cache entries, Node RSS 181,026,816 and native child RSS 7,913,472, sampled
before native shutdown; all cleanup acknowledgements were true. These distinct
measurements are not summed and do not measure native IR allocator retention,
compiled Wasm allocation or phone headroom. This receipt is a host boundary,
not full Wine execution, physical-device evidence or native guest JIT replacement.
