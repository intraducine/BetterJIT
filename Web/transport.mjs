export const HEADER_SIZE = 4096;
export const MAX_PAYLOAD = 1024 * 1024;
export const HIGH_OFFSET = 2 ** 31 + 65536;

export function fnv1a(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash;
}

export function checkedOffset(address, length, fileSize) {
  if (typeof address !== 'bigint' || !Number.isSafeInteger(length) || length < 1 ||
      !Number.isSafeInteger(fileSize) || fileSize < 0) throw new RangeError('Invalid memory range');
  // Wasm i64 -> JS arrives signed. Preserve the guest pointer's 64-bit bit pattern.
  const unsigned = BigInt.asUintN(64, address);
  if (unsigned < BigInt(HEADER_SIZE) || unsigned > BigInt(Number.MAX_SAFE_INTEGER - length)) {
    throw new RangeError('Guest address outside supported file-offset range');
  }
  const offset = Number(unsigned);
  if (offset + length > fileSize) throw new RangeError('Guest access beyond backing file');
  return offset;
}

function transfer(handle, method, bytes, at) {
  let done = 0;
  while (done < bytes.byteLength) {
    const count = handle[method](bytes.subarray(done), {at: at + done});
    if (!Number.isInteger(count) || count < 1 || count > bytes.byteLength - done) {
      throw new Error(`Short/invalid OPFS ${method}: ${done}/${bytes.byteLength}`);
    }
    done += count;
  }
  return done;
}
export const readExact = (handle, bytes, at) => transfer(handle, 'read', bytes, at);
export const writeExact = (handle, bytes, at) => transfer(handle, 'write', bytes, at);

// Correctness-first external memory helper. Each guest access copies eight bytes
// through the synchronous file API. It is NOT a zero-copy Wasm linear memory.
export class OPFSMemory {
  constructor(handle) {
    this.handle = handle;
    this.scratch = new Uint8Array(8);
    this.view = new DataView(this.scratch.buffer);
  }
  load64 = address => {
    const offset = checkedOffset(address, 8, this.handle.getSize());
    readExact(this.handle, this.scratch, offset);
    return this.view.getBigInt64(0, true);
  };
  store64 = (address, value) => {
    const offset = checkedOffset(address, 8, this.handle.getSize());
    this.view.setBigInt64(0, BigInt.asIntN(64, value), true);
    writeExact(this.handle, this.scratch, offset);
  };
}

export function arithmeticReference(iterations, seed) {
  // Independent affine exponentiation oracle for x := 3*x + 1 mod 2^64.
  const mask = (1n << 64n) - 1n;
  let n = iterations, a = 3n, b = 1n, result = seed & mask;
  while (n > 0) {
    if (n % 2) result = (a * result + b) & mask;
    b = (a * b + b) & mask;
    a = (a * a) & mask;
    n = Math.floor(n / 2);
  }
  return BigInt.asIntN(64, result);
}
