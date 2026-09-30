// SPDX-License-Identifier: GPL-3.0-or-later

export const MAPPED_HEADER_SIZE = 4096;
export const MAPPED_SLOT_SIZE = 16 * 1024 * 1024 + 4096;
export const MAPPED_SLOT_COUNT = 4;
export const MAPPED_FILE_SIZE = MAPPED_HEADER_SIZE + MAPPED_SLOT_SIZE * MAPPED_SLOT_COUNT;
export const MAPPED_THRESHOLD = 4096;
export const MAPPED_REQUEST_TAG = '__betterjitMappedRequestV1';
export const MAPPED_VALUE_TAG = '__betterjitMappedValueV1';
export const MAPPED_RESPONSE_TAG = '__betterjitMappedResponseV1';

const encoder = new TextEncoder();

export function fnv1a(bytes) {
  let hash = 2166136261 >>> 0;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash;
}

function writeExact(handle, bytes, offset) {
  let done = 0;
  while (done < bytes.length) {
    const n = handle.write(bytes.subarray(done), { at: offset + done });
    if (!Number.isInteger(n) || n <= 0 || n > bytes.length - done) {
      throw new Error('Mapped OPFS write was short.');
    }
    done += n;
  }
}

function readExact(handle, bytes, offset) {
  let done = 0;
  while (done < bytes.length) {
    const n = handle.read(bytes.subarray(done), { at: offset + done });
    if (!Number.isInteger(n) || n <= 0 || n > bytes.length - done) {
      throw new Error('Mapped OPFS read was short.');
    }
    done += n;
  }
}

function encodeBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 16384) {
    text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  }
  return btoa(text);
}

function decodeCanonicalBase64(value, maximum) {
  if (typeof value !== 'string' || value.length < 4 || value.length > 4 * Math.ceil(maximum / 3) ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  let bytes;
  try { bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
  catch { return null; }
  if (bytes.length > maximum || encodeBase64(bytes) !== value) return null;
  return bytes;
}

function canonicalToken(token) {
  return typeof token === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token);
}

function descriptor(lease, length, hash) {
  return {
    token: lease.token,
    slot: lease.slot,
    offset: String(lease.offset),
    length,
    capacity: lease.capacity,
    generation: String(lease.generation),
    hash,
  };
}

export class MappedLane {
  constructor(root, fileHandle, access, token, threshold = MAPPED_THRESHOLD) {
    this.root = root;
    this.fileHandle = fileHandle;
    this.access = access;
    this.token = token;
    this.threshold = threshold;
    this.free = Array.from({ length: MAPPED_SLOT_COUNT }, (_, i) => i);
    this.generations = Array(MAPPED_SLOT_COUNT).fill(0n);
    this.closed = false;
    this.workerToNativeBytes = 0;
    this.nativeToWorkerBytes = 0;
    this.mappedCalls = 0;
  }

  static async create(token, threshold = MAPPED_THRESHOLD, rootOverride = null) {
    if (!canonicalToken(token)) throw new Error('Mapped session token is invalid.');
    if (!Number.isInteger(threshold) || threshold < 1024 || threshold > MAPPED_SLOT_SIZE) {
      throw new Error('Mapped threshold is invalid.');
    }
    const root = rootOverride ?? await navigator.storage.getDirectory();
    const name = `betterjit-${token}.bin`;
    const fileHandle = await root.getFileHandle(name, { create: true });
    if (typeof fileHandle.createSyncAccessHandle !== 'function') {
      throw new Error('Synchronous OPFS access is unavailable.');
    }
    const access = await fileHandle.createSyncAccessHandle();
    try {
      access.truncate(MAPPED_FILE_SIZE);
      const marker = encoder.encode(`BetterJIT-mapped-v1:${token}\n`);
      if (marker.length > MAPPED_HEADER_SIZE) throw new Error('Mapped marker is too large.');
      writeExact(access, marker, 0);
      access.flush();
      if (access.getSize() !== MAPPED_FILE_SIZE) throw new Error('Mapped OPFS file has the wrong size.');
      return new MappedLane(root, fileHandle, access, token, threshold);
    } catch (error) {
      try { access.close(); } catch {}
      try { await root.removeEntry(name); } catch {}
      throw error;
    }
  }

  candidate() {
    return {
      candidate: 1,
      version: 1,
      headerSize: MAPPED_HEADER_SIZE,
      slotSize: MAPPED_SLOT_SIZE,
      slotCount: MAPPED_SLOT_COUNT,
      fileSize: MAPPED_FILE_SIZE,
      thresholdBytes: this.threshold,
    };
  }

  acquire() {
    if (this.closed || this.free.length === 0) return null;
    const slot = this.free.shift();
    this.generations[slot] += 1n;
    return {
      token: this.token,
      slot,
      offset: MAPPED_HEADER_SIZE + slot * MAPPED_SLOT_SIZE,
      capacity: MAPPED_SLOT_SIZE,
      generation: this.generations[slot],
    };
  }

  release(lease) {
    if (!lease || this.closed || lease.token !== this.token || !Number.isInteger(lease.slot) ||
        lease.slot < 0 || lease.slot >= MAPPED_SLOT_COUNT) return;
    if (!this.free.includes(lease.slot)) this.free.push(lease.slot);
  }

  validateDescriptor(meta, lease, allowLength = true) {
    if (!meta || typeof meta !== 'object' || !lease || meta.token !== lease.token || meta.slot !== lease.slot ||
        meta.offset !== String(lease.offset) || meta.capacity !== lease.capacity ||
        meta.generation !== String(lease.generation)) throw new Error('Mapped descriptor does not match its lease.');
    if (allowLength && (!Number.isInteger(meta.length) || meta.length < 0 || meta.length > lease.capacity ||
        !Number.isInteger(meta.hash) || meta.hash < 0 || meta.hash > 0xffffffff)) {
      throw new Error('Mapped descriptor length/hash is invalid.');
    }
  }

  encodeRequest(payload) {
    const lease = this.acquire();
    if (!lease) return { payload, lease: null, mappedBytes: 0 };
    let used = false;
    let mappedBytes = 0;
    const visit = value => {
      if (!used && typeof value === 'string') {
        const bytes = decodeCanonicalBase64(value, lease.capacity);
        if (bytes && bytes.length >= this.threshold) {
          // Ownership of this slot transfers to native until the service reply.
          // MAP_SHARED and the sync-access handle observe the same page cache;
          // do not fsync/flush per message. The session marker was flushed once.
          writeExact(this.access, bytes, lease.offset);
          used = true;
          mappedBytes = bytes.length;
          this.workerToNativeBytes += bytes.length;
          return { [MAPPED_VALUE_TAG]: { length: bytes.length, hash: fnv1a(bytes) } };
        }
      }
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === 'object') {
        const out = {};
        for (const [key, child] of Object.entries(value)) out[key] = visit(child);
        return out;
      }
      return value;
    };
    const transformed = visit(payload);
    return {
      payload: { [MAPPED_REQUEST_TAG]: { ...descriptor(lease, 0, 0), payload: transformed } },
      lease,
      mappedBytes,
    };
  }

  decodeResponse(value, lease) {
    if (!lease || !value || typeof value !== 'object' || Array.isArray(value) || !(MAPPED_RESPONSE_TAG in value)) return value;
    const meta = value[MAPPED_RESPONSE_TAG];
    this.validateDescriptor(meta, lease, true);
    const bytes = new Uint8Array(meta.length);
    if (bytes.length) readExact(this.access, bytes, lease.offset);
    if (fnv1a(bytes) !== (meta.hash >>> 0)) throw new Error('Mapped native response checksum mismatch.');
    this.nativeToWorkerBytes += bytes.length;
    this.mappedCalls += 1;
    return encodeBase64(bytes);
  }

  statistics() {
    return {
      schema: 1,
      workerToNativeBytes: this.workerToNativeBytes,
      nativeToWorkerBytes: this.nativeToWorkerBytes,
      mappedCalls: this.mappedCalls,
    };
  }

  async close(remove = true) {
    if (this.closed) return;
    this.closed = true;
    try { this.access.close(); } catch {}
    if (remove) {
      try { await this.root.removeEntry(`betterjit-${this.token}.bin`); } catch {}
    }
  }
}
