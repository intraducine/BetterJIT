// SPDX-License-Identifier: GPL-3.0-or-later
// Legacy dense file-window diagnostic, independent of the sparse broker ABI.
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const {materializeNZCV} = require('./flags.cjs');
const spec = require('./pilot.json');
const CODE = BigInt(spec.layout.codeBase), STACK = BigInt(spec.layout.stackBase);
const low = value => Number(BigInt.asUintN(32, value));
const hex = value => '0x' + BigInt.asUintN(64, value).toString(16).padStart(16, '0');
let child, childClosed, snapshot, logs = '', stage = 'startup';
async function stop() {
  if (child) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await childClosed;
  }
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function main() {
  const [translator, file, haltText] = process.argv.slice(2), halt = Number(haltText);
  const bytes = fs.readFileSync(file);
  assert(bytes.length <= spec.budgets.maximumInputBytes && bytes[halt] === 0xf4);
  const port = await freePort();
  child = spawn(translator, [file, CODE.toString(16), String(port),
    'maxinst=1 shared=1 tb=10000 abi=none x87=80 hot=0 xflags=0 localflags=0 trackrip=1'],
    {stdio: ['ignore', 'pipe', 'pipe']});
  childClosed = new Promise(resolve => child.once('close', resolve));
  child.on('error', error => {logs += error.message;});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {logs = (logs + data.toString()).slice(-12000);});
  const get = async path => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {signal: AbortSignal.timeout(1000)});
    assert.equal(response.status, 200);
    const body = new Uint8Array(await response.arrayBuffer());
    assert(body.length <= 524288);
    return body;
  };
  let cfg;
  for (let attempt = 0; attempt < 100; ++attempt) {
    try {cfg = JSON.parse(Buffer.from(await get('/xlat/config')).toString()); break;}
    catch (error) {if (child.exitCode !== null || attempt === 99) throw error; await new Promise(resolve => setTimeout(resolve, 10));}
  }
  assert.equal(cfg.linux, false); assert.equal(cfg.windowHi, Number(CODE >> 32n));
  assert.equal(cfg.maxInstructions, 1); assert.equal(cfg.callsViaDispatcher, false);
  assert.equal(cfg.shared, true); assert.equal(cfg.regArgs, 0);
  assert.equal(cfg.memPages, 4096); assert.equal(cfg.memMaxPages, 0);
  // Verified against the prepared production CPUState header, not a target-pin guess.
  const flagsOffset = cfg.nzcvAddr - cfg.ctx - 24;
  assert.equal(cfg.stateSize, 1472); assert.equal(flagsOffset, 1008);
  assert.equal(cfg.gregsOff, 32); assert.equal(cfg.xmmOff, 448);
  assert.equal(cfg.mxcsrOff, 972); assert.equal(cfg.ripOff, 24);
  const memory = new WebAssembly.Memory({initial: 4096, maximum: 4096, shared: true});
  const buffer = new Uint8Array(memory.buffer), view = new DataView(memory.buffer), tb = cfg.threadBase;
  const context = tb + cfg.ctx, flags = context + flagsOffset;
  buffer.set(await get('/xlat/state'), context);
  // Match the explicit native seed, including zeroed physical x87 payloads.
  buffer.fill(0, context + cfg.gregsOff, context + cfg.gregsOff + 128);
  buffer.fill(0, context + cfg.xmmOff, context + cfg.xmmOff + 512);
  buffer.fill(0, flags, flags + 48 + 128);
  buffer[flags + 1] = 1; buffer[flags + 9] = 1; buffer[flags + 10] = 1;
  view.setUint32(flags + 24, 0x20000000, true);
  view.setUint32(context + cfg.checkpoint.cpu.parityRawOffset, 1, true);
  view.setUint32(context + cfg.checkpoint.cpu.auxiliaryRawOffset, 0, true);
  view.setUint16(context + 1200, 0x37f, true); buffer[context + 1202] = 0;
  view.setUint32(context + cfg.mxcsrOff, 0x1f80, true);
  view.setBigUint64(context + cfg.gregsOff + 4 * 8, BigInt(spec.layout.stackPointer), true);
  buffer.set(bytes, low(CODE));
  let rip = CODE, blocks = 0, halted = false;
  snapshot = () => ({...capture(), rip: hex(rip), blocks, config: cfg});
  stage = 'compile';
  for (; blocks < spec.budgets.maximumBlocks; ++blocks) {
    assert(rip >= CODE && rip < CODE + BigInt(bytes.length), 'guest RIP outside frozen input');
    view.setBigUint64(context + cfg.ripOff, rip, true);
    const result = await get('/xlat/unit?rip=' + low(rip));
    if (result.length < 12) {
      await stop(); // Drain native diagnostics before sealing a refusal receipt.
      console.log(JSON.stringify({status: 'refused', stage, rip: hex(rip), blocks,
        ...capture(), config: cfg, instructionBytes: bytes.subarray(Number(rip - CODE), Number(rip - CODE) + 16).toString('hex'),
        reason: 'no legacy Wasm unit returned', logs}));
      process.exitCode = 1; return;
    }
    const module = await WebAssembly.compile(result.subarray(4));
    const imports = WebAssembly.Module.imports(module);
    assert(imports.every(i => i.module === 'e' && ['mem', 'tb'].includes(i.name)),
      'unit needs an import outside the frozen no-service pilot: ' + JSON.stringify(imports));
    const instance = await WebAssembly.instantiate(module, {e: {mem: memory, tb: new WebAssembly.Global({value: 'i32'}, tb)}});
    view.setBigUint64(tb + cfg.faultAddr, 0n, true);
    stage = 'execute';
    const next = instance.exports.run();
    const fault = view.getBigUint64(tb + cfg.faultAddr, true);
    if (fault) {
      // HLT generates SIGSEGV/#GP; retain the raw reason and original guest RIP.
      assert.equal(rip, CODE + BigInt(halt), 'unexpected guest fault');
      assert.equal(Number(fault & 255n), 11); assert.equal(Number((fault >> 8n) & 255n), 13);
      halted = true; ++blocks; break;
    }
    rip = (CODE & ~0xffffffffn) | BigInt(next >>> 0);
    stage = 'compile';
  }
  assert(halted, 'block budget exhausted');
  function capture() {
  const pf = view.getUint32(context + cfg.checkpoint.cpu.parityRawOffset, true) & 255, af = view.getUint32(context + cfg.checkpoint.cpu.auxiliaryRawOffset, true);
  const storedNZCV = view.getUint32(flags + 24, true);
  const kind = view.getUint32(tb + cfg.flagSpillAddr, true);
  const operandA = view.getBigUint64(tb + cfg.flagSpillAddr + 8, true);
  const operandB = view.getBigUint64(tb + cfg.flagSpillAddr + 16, true);
  const nzcv = materializeNZCV(kind, operandA, operandB, storedNZCV);
  function compactFlags(value) {
    let result = 0;
    for (let bit = 0; bit < 24; ++bit)
      if (![0, 2, 4, 6, 7, 8, 10, 11].includes(bit)) result |= buffer[flags + bit] << bit;
    const parity = byte => {let count = 0; for (; byte; byte >>>= 1) count ^= byte & 1; return count;};
    result |= (((value >>> 29) ^ 1) & 1) | (parity(pf ^ 1) << 2) | ((af ^ pf) & 16);
    result |= ((value >>> 30) & 1) << 6 | ((value >>> 31) & 1) << 7 | ((value >>> 28) & 1) << 11;
    result |= (buffer[flags + 8] & 1) << 8 | (buffer[flags + 10] >>> 7) << 10;
    return result >>> 0;
  }
  const rflags = compactFlags(nzcv);
  const lazyFlags = {representation: 'backend-materialize-v1', kind, operandA: hex(operandA), operandB: hex(operandB),
    storedNZCV: hex(BigInt(storedNZCV)), materializedNZCV: hex(BigInt(nzcv)),
    storedRFLAGS: hex(BigInt(compactFlags(storedNZCV))),
    parityRaw: view.getUint32(context + cfg.checkpoint.cpu.parityRawOffset, true),
    auxiliaryRaw: af, directionRaw: buffer[flags + 10]};
  let fsw = 0;
  for (let bit = 0; bit < 11; ++bit) fsw |= (buffer[flags + 32 + bit] & 1) << bit;
  fsw |= (buffer[flags + 43] & 7) << 11 | (buffer[flags + 46] & 1) << 14 | (buffer[flags + 47] & 1) << 15;
  const read = offset => hex(view.getBigUint64(context + offset, true));
  const state = {RIP: read(cfg.ripOff), RFLAGS: hex(BigInt(rflags >>> 0)),
    GPR: Array.from({length: 16}, (_, r) => read(cfg.gregsOff + 8 * r)),
    XMM: Array.from({length: 16}, (_, r) => [read(cfg.xmmOff + 16 * r), read(cfg.xmmOff + 16 * r + 8)]),
    MM: Array.from({length: 8}, (_, r) => [read(1056 + 16 * r), hex(BigInt(view.getUint16(context + 1056 + 16 * r + 8, true)))]),
    MXCSR: view.getUint32(context + cfg.mxcsrOff, true), FCW: view.getUint16(context + 1200, true),
    FSW: fsw, FTW: buffer[context + 1202]};
  return {state, lazyFlags, codeHex: Buffer.from(memory.buffer, low(CODE), 65536).toString('hex'),
    stackHex: Buffer.from(memory.buffer, low(STACK), 65536).toString('hex')};
  }
  await stop();
  console.log(JSON.stringify({schema: 1, method: 'legacy-dense-file-window-maxinst1', termination: 'hlt', blocks,
    config: cfg, ...capture()}));
}
main().catch(async error => {
  await stop();
  console.log(JSON.stringify({status: 'failure', stage, reason: String(error), logs, ...(snapshot ? snapshot() : {})})); process.exitCode = 1;
}).finally(stop);
