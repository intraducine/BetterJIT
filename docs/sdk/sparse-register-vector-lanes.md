# Register vector interleave and bitwise operations

Coverage 29 extends the bounded legacy register profile with PUNPCKL/H at
byte, word, dword and qword lane sizes; UNPCKL/HPS and UNPCKL/HPD aliases;
PAND/PANDN/POR/PXOR and AND/ANDN/OR/XOR PS/PD bitwise aliases. These operations
are independent of application, instruction address and chosen register.
One optional `66` precedes at most one REX; mandatory prefix requirements are
checked per opcode. REX.R/B select all sixteen XMM slots, while irrelevant
REX.W/X bits are accepted aliases. MMX, memory-vector operands, VEX/EVEX,
LOCK, extra/reordered prefixes and floating-point arithmetic remain excluded.

The profile reuses the explicit version-1 packed XMM descriptor and unchanged
full CPU/lazy/rounding spans. Memory/checkpoint/step ABI remains 1/1/4; wire
operation 6 has width zero and performs no guest memory RPC. No new checkpoint
layout or arbitrary-width memory operation is introduced.

Interleaving takes the low or high 64-bit half of each old 128-bit operand,
and alternates one destination lane and one source lane into the new 128-bit
destination. Bitwise operations act on all 128 bits. ANDNOT means
`(~old_destination) & old_source`. PS/PD bitwise names do not perform floating
point arithmetic, conversions or exception handling. Both equal and distinct
register operands, and equal values in distinct registers, obey this contract.
Same-register XOR is a zero idiom and may omit both input loads.

The compiler proof binds each exact FPR class, slot, 128-bit load/store size,
operation and element width, old-operand dataflow and ordering, sole destination
store and constant fallthrough. Low and high forms require VZip and VZip2
respectively. FEX loads the bitwise source before the old destination; its
VAndn uses `source & ~destination`, matching Wasm andnot. That reversal is
checked explicitly. The XOR optimization requires the same decoded register
on both sides and exactly FEX's named zero constant, with its full 128-bit
size. Other named/indexed constants, scalar profiles, context stores, flags,
memory or additional effects are rejected before emission. Existing pinned
emitters are reused unchanged.

The broker owns old operand bytes from BEGIN and computes the exact resulting
destination. FINISH compares the complete CPU, lazy flags and rounding spans,
allowing only RIP and that XMM slot to differ. Flags, opaque lazy descriptors,
GPRs, other vectors, separate AVX upper halves and padding remain identical.
Unsupported completion restores all spans. A forged vector memory request
cannot publish storage or backing-accounting changes. Kernel plans rederive
lane descriptors from executable bytes and ignore supplied descriptors.

A compact description generates literal native x86 instructions for every
form with same/different registers, equal/distinct values, lane markers,
zeros/all-ones, signed boundaries, arbitrary NaN bit patterns and four incoming
flag patterns. Hardware supplies retained oracle rows, independently checked
against an integer lane/bit model. The FEX/Wasm matrix covers every register,
REX and opcode alias. Copied actual IR controls mutate legal lane widths,
low/high operation, register classes/slots, ANDNOT operand order, zero constant
identity, use order and extra effects. Portable controls test full checkpoint
corruption, metadata ownership and rollback. The production kernel/worker ELF
adds self-interleave, zero idiom and ANDNOT/OR/AND chains within its original
200-step/30-second limits and retains its exact first-read fault path.

Run 39016456243 at `f1298cf` passed both CI jobs. The independently verified
unchanged Wine report confirms MOVQ executed and then stopped at
`0x7f00000412f3`, bytes `66 0f 6c c0` (PUNPCKLQDQ XMM0,XMM0), with no guest
exit. Synthetic lane tests do not establish Wine completion or device execution.
Future actual probes must keep the same launcher, musl, Wine provenance,
argv/environment, execution/translation/backing limits and lifecycle reporting.
Runtime worker retirement remains separate from successful later host teardown.
