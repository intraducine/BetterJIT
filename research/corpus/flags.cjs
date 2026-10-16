// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Read-only counterpart of backend.cpp MaterializeFlags and its FlagKind helpers.
// Keep the raw descriptor: stored NZCV alone need not describe the final flags.
function materializeNZCV(kind, inputA, inputB, stored) {
  if (!Number.isInteger(kind) || kind < 0 || kind > 30 || (kind & 15) > 14)
    throw new Error('unknown lazy flag kind: ' + kind);
  const base = kind & ~16, inverted = !!(kind & 16);
  const a64 = BigInt.asUintN(64, BigInt(inputA)), b64 = BigInt.asUintN(64, BigInt(inputB));
  stored >>>= 0;
  const pack = (n, z, c, v) => ((Number(n) << 31) | (Number(z) << 30) | (Number(c) << 29) | (Number(v) << 28)) >>> 0;
  let result;
  if (base >= 11) {
    const wide = base === 12 || base === 14, ax = base === 13 || base === 14;
    const decode = bits => {
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, bits, true);
      return wide ? view.getFloat64(0, true) : view.getFloat32(0, true);
    };
    const a = decode(a64), b = decode(b64);
    const raw = a < b ? 8 : a === b ? 6 : a > b ? 2 : 3;
    const n = raw >>> 3 & 1, z = raw >>> 2 & 1, c = raw >>> 1 & 1, v = raw & 1;
    result = ax ? pack(0, z | v, c & (v ^ 1), 0) : pack(n, z, c, v);
  } else if (base === 0) {
    result = stored;
  } else {
    const kept = base >= 7, operation = kept ? base - 6 : base;
    const width = operation === 1 || operation === 3 || operation === 5 ? 32 : 64;
    const a = BigInt.asUintN(width, a64), b = BigInt.asUintN(width, b64), sign = BigInt(width - 1);
    let r, c = false, v = false;
    if (operation === 1 || operation === 2) {
      r = BigInt.asUintN(width, a - b); c = a >= b;
      v = !!(((a ^ b) & (a ^ r)) >> sign);
    } else if (operation === 3 || operation === 4) {
      r = BigInt.asUintN(width, a + b); c = r < a;
      v = !!(((a ^ r) & (b ^ r)) >> sign);
    } else {
      r = a;
    }
    result = pack(!!(r >> sign), r === 0n, c, v);
    if (kept) result = ((result & ~0x20000000) | (stored & 0x20000000)) >>> 0;
  }
  return (inverted ? result ^ 0x20000000 : result) >>> 0;
}
module.exports = {materializeNZCV};
