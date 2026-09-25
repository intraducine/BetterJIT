'use strict';
// Execute the actual imported Wasm fixtures and both shipped dispatchers.
// This is a checksum test in V8, not live FEX translation or an iOS benchmark.
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve('WasmProbe/Web');
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
})().catch(error => { console.error(error); process.exitCode = 1; });
