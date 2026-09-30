// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {
  MappedLane, MAPPED_FILE_SIZE, MAPPED_HEADER_SIZE, MAPPED_SLOT_SIZE,
  MAPPED_REQUEST_TAG, MAPPED_VALUE_TAG, MAPPED_RESPONSE_TAG, fnv1a,
} from '../../Sources/BetterJITWebKit/Resources/mapped-lane.mjs';

if (typeof globalThis.btoa !== 'function') globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64');
if (typeof globalThis.atob !== 'function') globalThis.atob = s => Buffer.from(s, 'base64').toString('binary');

class FakeSync {
  constructor() { this.bytes = new Uint8Array(0); this.closed = false; }
  truncate(size) { this.bytes = new Uint8Array(size); }
  getSize() { return this.bytes.length; }
  write(source, { at }) { this.bytes.set(source, at); return source.length; }
  read(target, { at }) { target.set(this.bytes.subarray(at, at + target.length)); return target.length; }
  flush() {}
  close() { this.closed = true; }
}
class FakeRoot {
  constructor() { this.sync = new FakeSync(); this.removed = []; }
  async getFileHandle(name) { this.name = name; return { createSyncAccessHandle: async () => this.sync }; }
  async removeEntry(name) { this.removed.push(name); }
}
function base64(bytes) { return Buffer.from(bytes).toString('base64'); }

const token = '12345678-1234-4123-8123-123456789abc';
const root = new FakeRoot();
const lane = await MappedLane.create(token, 4096, root);
assert.equal(root.sync.getSize(), MAPPED_FILE_SIZE);
assert.equal(new TextDecoder().decode(root.sync.bytes.subarray(0, `BetterJIT-mapped-v1:${token}\n`.length)), `BetterJIT-mapped-v1:${token}\n`);

const raw = Uint8Array.from({ length: 8192 }, (_, i) => (i * 17 + 3) & 255);
const encoded = lane.encodeRequest({ method: 'region', profile: base64(raw), other: 'small' });
assert(encoded.lease);
const env = encoded.payload[MAPPED_REQUEST_TAG];
assert.equal(env.token, token);
assert.equal(env.offset, String(MAPPED_HEADER_SIZE));
assert.equal(env.capacity, MAPPED_SLOT_SIZE);
assert.equal(env.payload.profile[MAPPED_VALUE_TAG].length, raw.length);
assert.equal(env.payload.profile[MAPPED_VALUE_TAG].hash, fnv1a(raw));
assert.deepEqual(root.sync.bytes.subarray(encoded.lease.offset, encoded.lease.offset + raw.length), raw);

const reply = Uint8Array.from({ length: 65536 }, (_, i) => (i * 29 + 11) & 255);
root.sync.bytes.set(reply, encoded.lease.offset);
const wireReply = { [MAPPED_RESPONSE_TAG]: {
  token, slot: encoded.lease.slot, offset: String(encoded.lease.offset), length: reply.length,
  capacity: encoded.lease.capacity, generation: String(encoded.lease.generation), hash: fnv1a(reply),
} };
assert.equal(lane.decodeResponse(wireReply, encoded.lease), base64(reply));
lane.release(encoded.lease);

const small = lane.encodeRequest({ bytes: base64(new Uint8Array(16)) });
assert(small.lease, 'an active call reserves a reply slot even when its request remains copied');
assert.equal(small.payload[MAPPED_REQUEST_TAG].payload.bytes, base64(new Uint8Array(16)));
lane.release(small.lease);

const bad = lane.encodeRequest({ bytes: base64(raw) });
const badReply = { [MAPPED_RESPONSE_TAG]: {
  token, slot: bad.lease.slot, offset: String(bad.lease.offset), length: 1,
  capacity: bad.lease.capacity, generation: String(bad.lease.generation), hash: 0,
} };
root.sync.bytes[bad.lease.offset] = 1;
assert.throws(() => lane.decodeResponse(badReply, bad.lease), /checksum/);
lane.release(bad.lease);

await lane.close(true);
assert(root.sync.closed);
assert.deepEqual(root.removed, [`betterjit-${token}.bin`]);
console.log('PASS: mapped OPFS lane leases, descriptors, checksums, copied fallback and cleanup.');
