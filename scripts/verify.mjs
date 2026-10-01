import assert from 'node:assert/strict';
import fs from 'node:fs';
import {OPFSMemory, checkedOffset, fnv1a, readExact, writeExact, arithmeticReference} from '../Web/transport.mjs';

const directory = process.argv[2] ?? '.build/fixtures';
let count = 0;
async function instantiate(name, guest = {load64() { throw Error('unexpected read'); }, store64() { throw Error('unexpected write'); }}) {
  const bytes = fs.readFileSync(`${directory}/${name}.wasm`);
  assert(WebAssembly.validate(bytes), `${name} module validation`);
  const {instance} = await WebAssembly.instantiate(bytes, {guest});
  return instance.exports.run;
}
const run = await instantiate('arithmetic');
for (const n of [0, 1, 2, 63, 1000, 1000000]) {
  for (const seed of [0n, 1n, 7n, -1n, -(1n << 63n)]) {
    assert.equal(run(n, seed), arithmeticReference(n, seed)); count++;
  }
}
assert.throws(() => run(-1, 0n), WebAssembly.RuntimeError);
assert.throws(() => run(10000001, 0n), WebAssembly.RuntimeError);
const minus = await instantiate('negative');
assert.equal(minus(3, 0n), -3n);
assert.equal(minus(1, -(1n << 63n)), (1n << 63n) - 1n);
const extended = await instantiate('extended');
assert.equal(extended(3, 0n), -3n);
assert.equal((await instantiate('sign-boundary'))(1, 0n), -(1n << 63n));

// Sparse in-memory test double: only unit-tests helper semantics. Browser smoke
// tests below exercise REAL OPFS; neither is substituted for iOS native sharing.
const cells = new Map();
const handle = {
  getSize: () => 2 ** 31 + 131072,
  read(bytes, {at}) { for (let i = 0; i < bytes.length; i++) bytes[i] = cells.get(at + i) ?? 0; return bytes.length; },
  write(bytes, {at}) { bytes.forEach((byte, i) => cells.set(at + i, byte)); return bytes.length; }
};
const memory = new OPFSMemory(handle);
for (const [name, address] of [['low-memory', 8192n], ['high-memory', BigInt(2 ** 31 + 65536)]]) {
  const runMemory = await instantiate(name, memory);
  memory.store64(address, 41n);
  assert.equal(runMemory(1, 0n), 42n);
  assert.equal(memory.load64(address), 42n); count++;
  memory.store64(address, -1n);
  assert.equal(runMemory(1, 0n), 0n);
}
for (const pointer of [-1n, 0n, 4095n, 1n << 53n, BigInt(handle.getSize() - 7)]) {
  assert.throws(() => memory.load64(pointer), RangeError);
}
assert.throws(() => checkedOffset(8192, 8, 9000), RangeError);
assert.equal(fnv1a(new TextEncoder().encode('hello')), 0x4f9f2cab);
for (const method of [readExact, writeExact]) {
  assert.throws(() => method({read: () => 0, write: () => 0}, new Uint8Array(8), 0));
  let calls = 0;
  method({read: () => {calls++; return 1;}, write: () => {calls++; return 1;}}, new Uint8Array(8), 0);
  assert.equal(calls, 8);
}
console.log(`PASS: ${count} translated execution cases plus validation, bounds, wraparound and partial-I/O tests`);
