'use strict';
// Execute the actual imported Wasm fixtures and both shipped dispatchers.
// This is a checksum test in V8, not live FEX translation or an iOS benchmark.
const fs = require('node:fs/promises');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve('WasmProbe/Web');
async function checkSDKImagePatch() {
  if (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function') {
    console.log('SKIP: SDK Win64 image patch replay requires WebAssembly JSPI');
    return;
  }
  const {Engine} = await import('../Sources/BetterJITWebKit/Resources/engine.mjs');
  const {limits} = await import('../tests/sdk/fixtures.mjs');
  const read = name => readFileSync(path.join(root, 'fexw64', name));
  const config = JSON.parse(read('config.json'));
  const image = read('image.bin');
  const kernel = config.kernels.find(k => k.name === 'sieve');
  const packed = read('units.bin');
  const units = new Map();
  for (let i = 0, offset = 4; i < packed.readUInt32LE(0); i++) {
    const rip = packed.readUInt32LE(offset);
    const size = packed.readUInt32LE(offset + 4);
    const slot = Buffer.alloc(4);
    slot.writeUInt32LE(i + 1);
    units.set(rip, Buffer.concat([slot, packed.subarray(offset + 8, offset + 8 + size)]));
    offset += 8 + size;
  }
  const patches = [];
  let requests = 0;
  let acknowledge = true;
  const engine = new Engine({hostCall: async (service, payload) => {
    assert.equal(service, 'fex');
    switch (payload.method) {
      case 'config': return config;
      case 'image': return image;
      case 'state': return read('state.bin');
      case 'dispatcher': return read('dispatcher.wasm');
      case 'unit': requests++; return units.get(payload.rip) ?? '';
      case 'region': return '';
      case 'patchImage': patches.push(payload); return acknowledge;
      default: assert.fail(`Unexpected FEX operation ${payload.method}`);
    }
  }});
  await engine.command('configure', {limits, services: ['fex']});
  await engine.command('fex.open');
  const call = {entry: kernel.entry, arguments: [String(kernel.n)]};
  const original = await engine.command('fex.call', call);
  assert.equal(Number(BigInt(original) & 0xffffffffn), kernel.chk);
  assert.equal(requests, 1);

  const imageEnd = config.imageLow + image.length;
  await engine.command('write', {offset: imageEnd, bytes: 'AwQ='});
  await engine.command('write', {offset: kernel.entry, bytes: ''});
  assert.equal(await engine.command('fex.call', call), original);
  assert.equal(patches.length, 0);
  assert.equal(requests, 1);

  assert.notEqual(await engine.command('read', {offset: kernel.entry, count: 2}), 'AQI=');
  await engine.command('write', {offset: kernel.entry, bytes: 'AQI='});
  assert.equal(await engine.command('read', {offset: kernel.entry, count: 2}), 'AQI=');
  assert.deepEqual(patches[0], {method: 'patchImage', offset: kernel.entry - config.imageLow, bytes: 'AQI='});
  assert.equal(await engine.command('fex.call', call), original);
  assert.equal(requests, 2, 'cached code must be fetched again, even when the fixture returns the same unit');

  await engine.command('write', {offset: imageEnd - 1, bytes: 'BQY='});
  assert.deepEqual(patches[1], {method: 'patchImage', offset: image.length - 1, bytes: 'BQ=='});
  assert.equal(await engine.command('read', {offset: imageEnd - 1, count: 2}), 'BQY=');

  acknowledge = false;
  const previous = new Uint8Array(engine.memory.buffer, kernel.entry, 2);
  await assert.rejects(engine.command('write', {offset: kernel.entry, bytes: 'Bwg='}), {code: 'fexExecution'});
  assert.deepEqual([...previous], [1, 2]);
  await assert.rejects(engine.command('fex.call', call), {code: 'closed'});
  console.log('PASS: SDK Win64 image patch reloads recorded code, clips overlap, and closes on a failed patch');
}

(async () => {
  let checked = 0;
  for (const runtime of ['WasmProbe/Web/fexruntime.js', 'fexwasm/js/runtime.js']) {
    const records = [];
    const context = vm.createContext({ console, performance, setTimeout, clearTimeout, URLSearchParams,
      location: { search: '', origin: 'fixture://local' },
      document: { getElementById: () => ({ textContent: '' }) },
      fetch: async (name) => {
        const file = path.resolve(root, name);
        assert(file.startsWith(root + path.sep));
        const data = await fs.readFile(file);
        return { ok: true, json: async () => JSON.parse(data.toString()),
          arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
      },
      webkit: { messageHandlers: { log: { postMessage: (s) => records.push(JSON.parse(s)) } } },
    });
    vm.runInContext('window = globalThis; self = globalThis;', context);
    for (const file of [runtime, 'WasmProbe/Web/probe.js'])
      vm.runInContext(await fs.readFile(file, 'utf8'), context, { filename: file });
    for (const dir of ['fex', 'fexw64']) {
      records.length = 0;
      const result = await context.Probe.run('fexkernels', { dir });
      assert.equal(result, 'ok', JSON.stringify(records.filter(r => r.error)));
      const expected = JSON.parse(await fs.readFile(path.join(root, dir, 'config.json'))).kernels;
      const actual = records.filter(r => r.suite === 'fexkernels' && r.kernel);
      assert.equal(actual.length, expected.length, 'every expected kernel must execute');
      for (const k of expected) {
        const r = actual.find(r => r.kernel === k.name);
        assert(r && r.match && r.chk === k.chk, `${runtime}/${dir}/${k.name}: ${JSON.stringify(r)}`);
        checked++;
      }
      console.log(`PASS ${runtime} ${dir}: ${actual.length} replay checksums`);
    }
  }
  console.log(`PASS: ${checked} FEX fixture replay checks (not device measurements)`);
  await checkSDKImagePatch();
})().catch(error => { console.error(error); process.exitCode = 1; });
