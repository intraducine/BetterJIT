// SPDX-License-Identifier: GPL-3.0-or-later
// Immediate AND in the production sparse emitter, checked against native x86.
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const {spawnSync} = require('child_process'), assert = require('node:assert/strict');
const {serve} = require('./native-step-contract.cjs');
const golden = require('./sparse-and-oracle.json');
for (const name of ['guest_memory', 'guest_memory_broker', 'thread_core']) {
  vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,
    '../../../Sources/BetterJITLinux/Resources/linux', name + '.js'), 'utf8'));
}
const M = BetterJITGuestMemory, B = BetterJITGuestMemoryBroker, CODE = 0x123400008000n;
const immediates = [[0x83, [0xf0]], [0x83, [0x80]], [0x83, [0x7f]], [0x83, [0]],
  [0x81, [0xf0, 0xff, 0xff, 0xff]], [0x81, [0, 0, 0, 0x80]],
  [0x81, [0xff, 0xff, 0xff, 0x7f]], [0x81, [0, 0, 0, 0]]];
const destinations = [{name: 'rax', index: 0}, {name: 'rsp', index: 4}, {name: 'r8', index: 8}];
function instruction(op, index) {
  const [opcode, bytes] = immediates[op >> 1], rex = (op & 1 ? 0x48 : 0x40) | (index >= 8 ? 1 : 0);
  return [...(rex === 0x40 ? [] : [rex]), opcode, 0xe0 | (index & 7), ...bytes];
}
function oracle() {
  if (process.platform !== 'linux' || process.arch !== 'x64') return {supported: false,
    reason: 'Native oracle requires Linux x86-64; fresh FEX/Wasm still checks retained native results'};
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'betterjit-and-'));
  try {
    const binary = path.join(temp, 'oracle');
    const build = spawnSync(process.env.CC || 'cc', ['-O2', '-mno-red-zone', '-Wall', '-Wextra', '-Werror',
      path.join(__dirname, 'sparse-and-oracle.c'), '-o', binary], {encoding: 'utf8'});
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), golden);
    return {supported: true, rows: golden.length};
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
}
async function main() {
  const nativeOracle = oracle();
  await serve('guestmem=broker1', async (get, log) => {
    const cfg = await (await get('/xlat/config')).json();
    const state = new Uint8Array(await (await get('/xlat/state')).arrayBuffer());
    async function request(code) {
      await get('/xlat/code?addr=' + CODE.toString(16), {method: 'POST', body: Uint8Array.from(code)});
      return FexLinuxThread.parseBrokerStep(new Uint8Array(await (await get('/xlat/step?rip=' + CODE)).arrayBuffer()));
    }
    async function compile(code, operation) {
      const unit = await request(code);
      assert.equal(unit.status, 0, code + ': ' + log());
      assert.equal(unit.operation, operation); assert.equal(unit.width, 0);
      assert.deepEqual([...unit.instruction], code); assert.equal(unit.nextRip, CODE + BigInt(code.length));
      unit.module = await WebAssembly.compile(unit.code);
      assert(WebAssembly.Module.imports(unit.module).every(i => i.module === 'e' && ['mem', 'tb'].includes(i.name)),
        'Register-only steps must not import guest memory access');
      return unit;
    }
    const units = new Map();
    for (let op = 0; op < 16; op++) for (const dest of destinations) {
      units.set(op + ':' + dest.index, await compile(instruction(op, dest.index), 6));
    }
    const seed = await compile([0x01, 0xd8], 6), syscall = await compile([15, 5], 5), branches = [];
    for (let op = 0x72; op <= 0x79; op++) branches.push(await compile([op, 0x40], 7));
    for (const op of [0x88, 0x89]) branches.push(await compile([15, op, 0xc0, 0xff, 0xff, 0xff], 7));
    const space = new M.GuestAddressSpace(new M.BackingBudget()), memory = B.createInternalMemory();
    const broker = new B.GuestMemoryBroker(), token = broker.register(0, {space, memory, checkpointLayout: cfg.checkpoint});
    const view = new DataView(memory.buffer), tb = B.ABI.threadBase, g = tb + cfg.ctx + cfg.gregsOff;
    let executedWasmSteps = 0;
    async function step(unit) {
      view.setBigUint64(tb + cfg.ctx + cfg.ripOff, unit.rip, true);
      const checkpoint = broker.beginInstruction(token, {rip: unit.rip, operation: unit.operation,
        width: unit.width, continuations: unit.continuations});
      view.setBigUint64(tb + B.ABI.scratchOffset + B.FIELD.checkpoint, checkpoint, true);
      const instance = await WebAssembly.instantiate(unit.module, {e: {mem: memory,
        tb: new WebAssembly.Global({value: 'i32'}, tb)}});
      const result = broker.finishInstruction(token, {status: instance.exports.run(), nextRip: unit.nextRip});
      executedWasmSteps++;
      assert.equal(result.status, unit.operation === 5 ? B.STEP.SYSCALL : B.STEP.OK); return result;
    }
    const records = [];
    for (const row of golden) for (const dest of destinations) {
      const unit = units.get(row.op + ':' + dest.index);
      new Uint8Array(memory.buffer, tb + cfg.ctx, state.length).set(state);
      // Establish live CF=OF=1 first, then ensure AND clears both across steps.
      view.setBigUint64(g, 0x80000000n, true); view.setBigUint64(g + 24, 0x80000000n, true);
      await step(seed); await step(syscall);
      assert.equal(view.getBigUint64(g + 88, true) & 0x801n, 0x801n);
      const before = Array.from({length: 16}, (_, i) => 0x1122334400000000n + BigInt(i));
      before[dest.index] = BigInt(row.input);
      before.forEach((value, i) => view.setBigUint64(g + i * 8, value, true));
      view.setUint32(tb + cfg.checkpoint.roundMode.offset, 2, true);
      await step(unit);
      before.forEach((value, i) => assert.equal(view.getBigUint64(g + i * 8, true),
        i === dest.index ? BigInt(row.result) : value, row.op + ' ' + dest.name + ' GPR ' + i));
      assert.equal(view.getUint32(tb + cfg.checkpoint.roundMode.offset, true), 2);
      const cf = !!(row.flags & 1), zf = !!(row.flags & 64), sf = !!(row.flags & 128);
      for (const branch of branches) {
        const op = branch.instruction[0] === 15 ? branch.instruction[1] - 16 : branch.instruction[0];
        const taken = [cf, !cf, zf, !zf, cf || zf, !cf && !zf, sf, !sf][op - 0x72];
        assert.equal((await step(branch)).rip, taken ? branch.branchTarget : branch.nextRip);
      }
      await step(syscall);
      assert.equal(view.getBigUint64(g + 88, true) & 0x8c5n, BigInt(row.flags), row.op + ' ' + dest.name + ' flags');
      records.push({op: row.op, destination: dest.name, input: row.input, result: row.result,
        flags: row.flags, instruction: [...unit.instruction]});
    }
    const negatives = {
      memory32: [0x83, 0x20, 0xf0], memory64: [0x48, 0x81, 0x20, 0xf0, 0xff, 0xff, 0xff],
      byte: [0x80, 0xe0, 0xf0], word: [0x66, 0x83, 0xe0, 0xf0],
      accumulator: [0x48, 0x25, 0xf0, 0xff, 0xff, 0xff],
      lock: [0xf0, 0x48, 0x83, 0xe0, 0xf0], fs: [0x64, 0x48, 0x83, 0xe0, 0xf0],
      gs: [0x65, 0x48, 0x83, 0xe0, 0xf0], rep: [0xf3, 0x48, 0x83, 0xe0, 0xf0],
      addressOverride: [0x67, 0x48, 0x83, 0xe0, 0xf0],
      or: [0x48, 0x83, 0xc8, 0xf0], adc: [0x48, 0x83, 0xd0, 0xf0],
      sbb: [0x48, 0x83, 0xd8, 0xf0], xor: [0x48, 0x83, 0xf0, 0xf0],
      truncated8: [0x48, 0x83, 0xe0], truncated32: [0x48, 0x81, 0xe0, 0xf0, 0xff, 0xff],
    };
    const rejected = [];
    for (const [name, code] of Object.entries(negatives)) {
      const before = new Uint8Array(memory.buffer).slice(), unit = await request(code);
      assert.equal(unit.status, 2, name + ': ' + log()); assert.equal(unit.code.length, 0);
      assert.equal(unit.nextRip, CODE); assert.equal(unit.instruction.length, 0);
      assert.deepEqual(new Uint8Array(memory.buffer), before, name + ' cannot mutate execution state');
      rejected.push(name);
    }
    assert.equal(broker.stats().requests, 0, 'No guest memory effects');
    broker.unregister(token); space.close();
    const native = await (await get('/xlat/stats')).json();
    assert.equal(executedWasmSteps, records.length * 14);
    assert.equal(native.units, 60); assert.equal(native.guestInsts, 60);
    assert.equal(native.failed, rejected.length);
    const result = {evidence: 'Fresh sparse FEX/Wasm immediate AND in 32/64-bit RAX/RSP/R8; native x86 oracle, live flags and finite branches. No Wine or device claim.',
      nativeOracle, coverageVersion: cfg.coverageVersion, buildID: cfg.buildID, executedWasmSteps, records, rejected, native};
    const text = JSON.stringify(result, null, 2);
    if (process.argv[3]) fs.writeFileSync(process.argv[3], text + '\n');
    console.log(text);
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
