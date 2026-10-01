import {HEADER_SIZE, MAX_PAYLOAD, HIGH_OFFSET, OPFSMemory, fnv1a,
        readExact, writeExact, arithmeticReference} from './transport.mjs';

let nextID = 0, transportUncertain = false;
const pending = new Map();
function native(body) {
  const id = ++nextID;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      transportUncertain = true;
      reject(new Error('Native reply timed out; backing file retained to avoid resizing an in-flight mapping'));
    }, 15000);
    pending.set(id, {resolve, reject, timer});
    postMessage({type: 'native', id, body});
  });
}
self.onmessage = event => {
  const message = event.data;
  if (message.type === 'reply') {
    const call = pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(message.id);
    message.error ? call.reject(new Error(message.error)) : call.resolve(message.result);
  } else if (message.type === 'start') {
    run(message.config, message.large).catch(error => {
      postMessage({type: 'record', record: {stage: 'suite', status: 'FAIL', error: String(error)}});
      postMessage({type: 'done'});
    });
  }
};

const bytes = base64 => Uint8Array.from(atob(base64), char => char.charCodeAt(0));
const record = (stage, status, detail = {}) => postMessage({type: 'record', record: {stage, status, ...detail}});
const median = samples => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
function assert(condition, message) { if (!condition) throw new Error(message); }

async function run(config, large) {
  record('environment', 'INFO', {
    userAgent: navigator.userAgent, secureContext: isSecureContext,
    crossOriginIsolated, nativeHost: config.nativeHost, nativeEnvironment: config.environment ?? null,
    wasm: typeof WebAssembly !== 'undefined', sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined'
  });
  const noMemory = {
    load64() { throw new Error('Unexpected memory read'); },
    store64() { throw new Error('Unexpected memory write'); }
  };
  const compileStart = performance.now();
  const arithmetic = await WebAssembly.instantiate(bytes(config.arithmetic), {guest: noMemory});
  const compileMs = performance.now() - compileStart;
  for (const n of [0, 1, 2, 63, 1000]) {
    for (const seed of [0n, -1n, 7n, -(1n << 63n)]) {
      assert(arithmetic.instance.exports.run(n, seed) === arithmeticReference(n, seed), 'Arithmetic oracle mismatch');
    }
  }
  const iterations = 1_000_000, seed = 7n;
  const expected = arithmeticReference(iterations, seed);
  if (config.baseline) {
    assert(config.baseline.iterations === iterations && config.baseline.samples.every(sample =>
      sample.checksum === expected.toString()), 'Native baseline checksum mismatch');
  }
  const coldStart = performance.now();
  assert(arithmetic.instance.exports.run(iterations, seed) === expected, 'Cold checksum mismatch');
  const coldRunMs = performance.now() - coldStart;
  arithmetic.instance.exports.run(10_000, seed);
  const samplesMs = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now();
    const result = arithmetic.instance.exports.run(iterations, seed);
    samplesMs.push(performance.now() - start);
    assert(result === expected, 'Warm checksum mismatch');
  }
  record('native-translated-wasm', 'PASS', {
    iterations, checksum: expected.toString(), compileMs, coldRunMs, samplesMs,
    medianMs: median(samplesMs), nativeArithmeticBaseline: config.baseline ?? null,
    scope: 'Restricted integer fixture, not FEX/game performance; engine tier is not observable here'
  });
  // Report a modest allocation, never probe process limits by allocating gigabytes.
  const linear = new WebAssembly.Memory({initial: 1, maximum: 1024});
  linear.grow(15);
  record('linear-memory', 'PASS', {testedBytes: linear.buffer.byteLength,
    maximumDeclaredBytes: 64 * 1024 * 1024, limitMeasured: false});

  let root, handle;
  const filename = `betterjit-${config.session}.bin`;
  let sequence = 0;
  try {
    assert(isSecureContext && navigator.storage?.getDirectory, 'OPFS requires a supported secure origin');
    root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle(filename, {create: true});
    handle = await file.createSyncAccessHandle();
    handle.truncate(HEADER_SIZE + MAX_PAYLOAD);
    writeExact(handle, new TextEncoder().encode(`BetterJIT-v1:${config.session}\n`), 0);
    handle.flush(); // initialization only, excluded from transport timings
    const memory = new OPFSMemory(handle);
    const low = await WebAssembly.instantiate(bytes(config['low-memory']), {guest: memory});
    memory.store64(8192n, 41n);
    assert(low.instance.exports.run(1, 0n) === 42n && memory.load64(8192n) === 42n, 'Low memory fixture mismatch');
    record('wasm-opfs-memory', 'PASS', {address: '8192', value: '42',
      directLinearMemory: false, readWriteCopies: true});

    async function exchange(offset, length) {
      const input = new Uint8Array(length);
      const seq = ++sequence;
      for (let i = 0; i < length; i++) input[i] = ((i * 31) ^ seq) & 255;
      const hash = fnv1a(input);
      const start = performance.now();
      writeExact(handle, input, offset);
      const afterWrite = performance.now();
      const response = await native({command: 'exchange', session: config.session,
        sequence: seq, offset: String(offset), length, hash});
      const afterNative = performance.now();
      const output = new Uint8Array(length);
      readExact(handle, output, offset);
      const afterRead = performance.now();
      assert(response.sequence === seq, 'Native sequence mismatch');
      assert(fnv1a(output) === response.hash, 'Native -> worker checksum mismatch');
      for (let i = 0; i < length; i++) assert(output[i] === (input[i] ^ 0x5a), `Payload mismatch at ${i}`);
      return {bytes: length, sequence: seq, writeMs: afterWrite - start,
        nativeRoundTripMs: afterNative - afterWrite, readMs: afterRead - afterNative,
        totalMs: performance.now() - start, nativeMapMs: response.nativeMapMs,
        backingDevice: response.device, backingInode: response.inode};
    }

    if (config.nativeHost) {
      for (const length of [4096, 65536, MAX_PAYLOAD]) {
        const samples = [];
        for (let n = 0; n < 4; n++) samples.push(await exchange(HEADER_SIZE, length));
        record('opfs-native-mmap', 'PASS', {length, cold: samples[0], warm: samples.slice(1),
          includesChecksumAndBridgeOverhead: true, payloadOverMessageBridge: false});
      }
    } else {
      record('opfs-native-mmap', 'SKIP', {reason: 'No native iOS host; browser-only tests cannot prove WKWebView sharing'});
    }

    if (large) {
      // This tests a sparse logical offset, not 2 GiB of resident/usable RAM.
      // Quota still applies even when the filesystem creates a sparse file.
      const targetSize = HIGH_OFFSET + 4096;
      const quota = await navigator.storage.estimate();
      if (Number.isFinite(quota.quota) && quota.quota - (quota.usage || 0) < targetSize) {
        record('high-offset-memory', 'SKIP', {reason: 'Insufficient reported OPFS quota', quota, targetSize});
      } else {
        try {
          handle.truncate(targetSize);
          const high = await WebAssembly.instantiate(bytes(config['high-memory']), {guest: memory});
          memory.store64(BigInt(HIGH_OFFSET), 41n);
          assert(high.instance.exports.run(1, 0n) === 42n && memory.load64(BigInt(HIGH_OFFSET)) === 42n,
            'High-offset Wasm load/store mismatch');
          record('high-offset-memory', 'PASS', {offset: String(HIGH_OFFSET), fileSize: handle.getSize(),
            logicalAddressOnly: true, residentRAMMeasured: false, linearMemoryEnlarged: false});
          if (config.nativeHost) record('high-offset-native-mmap', 'PASS', await exchange(HIGH_OFFSET, 4096));
          else record('high-offset-native-mmap', 'SKIP', {reason: 'Native host unavailable'});
        } catch (error) {
          record('high-offset-memory', 'FAIL', {error: String(error), quota,
            note: 'Storage/quota failure is not evidence of a WebView RAM limit'});
        } finally {
          if (!transportUncertain) handle.truncate(HEADER_SIZE + MAX_PAYLOAD);
        }
      }
    } else {
      record('high-offset-memory', 'SKIP', {reason: 'Opt-in sparse >2 GiB test was not selected'});
    }
  } catch (error) {
    record('opfs', 'FAIL', {error: String(error)});
  } finally {
    if (handle) handle.close();
    if (root && !transportUncertain) {
      try { await root.removeEntry(filename); record('cleanup', 'PASS'); }
      catch (error) { record('cleanup', 'FAIL', {error: String(error)}); }
    } else if (transportUncertain) {
      record('cleanup', 'SKIP', {reason: 'Native operation may still be in flight; file left intact', filename});
    }
  }
  postMessage({type: 'done'});
}
