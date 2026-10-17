// SPDX-License-Identifier: GPL-3.0-or-later
// Group-1 AND and accumulator AND/OR/XOR reuse the sparse register FLAGS path.
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
    assert.equal(cfg.coverageVersion,27);
    const state = new Uint8Array(await (await get('/xlat/state')).arrayBuffer());
    async function request(code, rip = CODE) {
      await get('/xlat/code?addr=' + rip.toString(16), {method: 'POST', body: Uint8Array.from(code)});
      return FexLinuxThread.parseBrokerStep(new Uint8Array(await (await get('/xlat/step?rip=' + rip)).arrayBuffer()));
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
    let executedWasmSteps = 0, accumulatorChecks = 0, accumulatorBranchChecks = 0;
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
    for (const row of golden.filter(row => !row.family)) for (const dest of destinations) {
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
    const accumulatorRows=golden.filter(row=>row.family), rowMap=new Map(accumulatorRows.map(row=>[[row.family,row.width,row.maskIndex,row.form,row.seed,row.input].join(':'),row]));
    assert.equal(accumulatorRows.length,4608);assert.equal(rowMap.size,accumulatorRows.length);
    for(const row of accumulatorRows){const canonical=rowMap.get([row.family,row.width,row.maskIndex,0,row.seed,row.input].join(':'));assert.equal(row.result,canonical.result);assert.equal(row.flags,canonical.flags);}
    const prefixes=[[],[0x66],...Array.from({length:16},(_,i)=>[0x40+i]),...Array.from({length:16},(_,i)=>[0x66,0x40+i])],accumulatorRecords=[];
    function masks(width){const n=Math.min(width,4),bits=n*8;return[0,1,2**(bits-1)-1,2**(bits-1),2**bits-1,0x55aa%(2**bits),0x80,0xff00%(2**bits)];}
    const cpu=cfg.checkpoint.cpu,spans=['cpu','lazyFlags','roundMode'],snapshot=()=>spans.map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
    let accumulatorCompiled=0;
    for(const [family,opcode]of [['and',0x24],['or',0x0c],['xor',0x34]])for(const byte of [true,false])for(const prefix of prefixes){
      const width=byte?1:prefix.some(x=>x>=0x48&&x<=0x4f)?8:prefix.includes(0x66)?2:4;
      for(let maskIndex=0;maskIndex<8;maskIndex++){
        const immediate=masks(width)[maskIndex],immediateBytes=Array.from({length:Math.min(width,4)},(_,i)=>Number(BigInt(immediate)>>BigInt(i*8)&255n)),code=[...prefix,opcode+(byte?0:1),...immediateBytes],unit=await compile(code,6);accumulatorCompiled++;
        const rows=accumulatorRows.filter(row=>row.family===family&&row.width===width&&row.maskIndex===maskIndex&&row.form===0);
        assert.equal(rows.length,16);
        for(const row of rows){
          new Uint8Array(memory.buffer,tb+cfg.ctx,state.length).set(state);
          // Real cross-unit lazy ADD flags start with CF=OF=1. Logical ops must
          // clear them independently of the immediate and previous flag state.
          view.setBigUint64(g,0x80000000n,true);view.setBigUint64(g+24,0x80000000n,true);await step(seed);
          view.setUint8(tb+cpu.offset+cpu.nzcvOffset-24+10,row.seed?255:1);
          for(let r=0;r<16;r++)view.setBigUint64(g+r*8,r===0?BigInt(row.input):0x1122334455000000n+BigInt(r)*0x10101n,true);
          view.setUint32(tb+cfg.checkpoint.roundMode.offset,2,true);view.setBigUint64(tb+cfg.ctx+cfg.ripOff,unit.rip,true);
          const before=snapshot(),expected=before[0].slice(),ev=new DataView(expected.buffer);ev.setBigUint64(cpu.generalRegistersOffset,BigInt(row.result),true);ev.setBigUint64(cpu.ripOffset,unit.nextRip,true);
          await step(unit);accumulatorChecks++;const after=snapshot();
          const flagField=i=>(i>=cpu.nzcvOffset&&i<cpu.nzcvOffset+4)||(i>=cpu.parityRawOffset&&i<cpu.parityRawOffset+4)||(i>=cpu.auxiliaryRawOffset&&i<cpu.auxiliaryRawOffset+4);
          assert(after[0].every((x,i)=>flagField(i)||x===expected[i]),family+' exact accumulator/otherCPU preservation');
          assert.deepEqual(after[1].subarray(4,8),before[1].subarray(4,8));assert.deepEqual(after[2],before[2]);
          if(prefix.length===0||(prefix.length===1&&(prefix[0]===0x66||prefix[0]===0x48)))for(const branch of branches){const op=branch.instruction[0]===15?branch.instruction[1]-16:branch.instruction[0],cf=!!(row.flags&1),zf=!!(row.flags&64),sf=!!(row.flags&128),taken=[cf,!cf,zf,!zf,cf||zf,!cf&&!zf,sf,!sf][op-0x72];assert.equal((await step(branch)).rip,taken?branch.branchTarget:branch.nextRip);accumulatorBranchChecks++;}
          await step(syscall);assert.equal(view.getBigUint64(g+88,true)&0xcc5n,BigInt(row.flags),family+' native logical flags/DF');
        }
        accumulatorRecords.push({family,width,prefix,immediate,maskIndex,instruction:code,checks:rows.length});
      }
    }
    const negatives = {
      memory32: [0x83, 0x20, 0xf0], memory64: [0x48, 0x81, 0x20, 0xf0, 0xff, 0xff, 0xff],
      byte: [0x80, 0xe0, 0xf0], wordMemory: [0x66, 0x83, 0x20, 0xf0],
      lock: [0xf0, 0x48, 0x83, 0xe0, 0xf0], fs: [0x64, 0x48, 0x83, 0xe0, 0xf0],
      gs: [0x65, 0x48, 0x83, 0xe0, 0xf0], rep: [0xf3, 0x48, 0x83, 0xe0, 0xf0],
      addressOverride: [0x67, 0x48, 0x83, 0xe0, 0xf0],
      adc: [0x48, 0x83, 0xd0, 0xf0],
      sbb: [0x48, 0x83, 0xd8, 0xf0],
      truncated8: [0x48, 0x83, 0xe0], truncated32: [0x48, 0x81, 0xe0, 0xf0, 0xff, 0xff],
    };
    for(const [family,opcode]of [['and',0x24],['or',0x0c],['xor',0x34]]){
      for(const prefix of prefixes)for(const byte of [true,false]){const width=byte?1:prefix.some(x=>x>=0x48&&x<=0x4f)?8:prefix.includes(0x66)?2:4,full=[...prefix,opcode+(byte?0:1),...new Array(Math.min(width,4)).fill(1)];for(let n=prefix.length+1;n<full.length;n++)negatives[family+'-truncated-'+prefix.join('-')+'-'+byte+'-'+n]=full.slice(0,n);}
      for(const prefix of [[0xf0],[0xf2],[0xf3],[0x64],[0x65],[0x67],[0x2e],[0x66,0x66],[0x40,0x66],[0x41,0x66],[0x40,0x41]])negatives[family+'-prefix-'+prefix.join('-')]=[...prefix,opcode,0x80];
    }
    const rejected = [];
    for (const [name, code] of Object.entries(negatives)) {
      const before = new Uint8Array(memory.buffer).slice(), unit = await request(code);
      assert.equal(unit.status, 2, name + ': ' + log()); assert.equal(unit.code.length, 0);
      assert.equal(unit.nextRip, CODE); assert.equal(unit.instruction.length, 0);
      assert.deepEqual(new Uint8Array(memory.buffer), before, name + ' cannot mutate execution state');
      rejected.push(name);
    }
    const addressCases=[];
    for(const [family,opcode]of [['and',0x24],['or',0x0c],['xor',0x34]])for(const width of [1,2,4,8]){
      const code=[...(width===2?[0x66]:width===8?[0x48]:[]),opcode+(width===1?0:1),1,...new Array(Math.min(width,4)-1).fill(0)];
      for(const supported of [true,false]){const rip=(1n<<47n)-BigInt(code.length)-(supported?1n:0n),before=new Uint8Array(memory.buffer).slice(),unit=await request(code,rip);assert.equal(unit.status,supported?0:2);if(supported){assert.equal(unit.nextRip,(1n<<47n)-1n);assert(WebAssembly.validate(unit.code));}else{assert.equal(unit.code.length,0);assert.equal(unit.nextRip,rip);}assert.deepEqual(new Uint8Array(memory.buffer),before);addressCases.push({family,width,rip:'0x'+rip.toString(16),supported});}
    }
    assert.equal(broker.stats().requests, 0, 'No guest memory effects');
    broker.unregister(token); space.close();
    const native = await (await get('/xlat/stats')).json();
    assert.equal(executedWasmSteps, records.length * 14 + accumulatorChecks * 3 + accumulatorBranchChecks);
    assert.equal(native.units, 72 + accumulatorCompiled); assert.equal(native.guestInsts, 72 + accumulatorCompiled);
    assert.equal(native.failed, rejected.length + 12);
    const result = {evidence: 'Actual sparse FEX/Wasm group-1 AND32/64 and accumulator AND/OR/XOR8/16/32/64, all optional66/singleREX prefixes, native x86 flags/DF, full-register results and finite branches. AF undefined; no Wine or device claim.',
      nativeOracle, coverageVersion: cfg.coverageVersion, buildID: cfg.buildID, executedWasmSteps, accumulatorChecks, accumulatorBranchChecks, records, accumulatorRecords, addressCases, rejected, native};
    const text = JSON.stringify(result, null, 2);
    if (process.argv[3]) fs.writeFileSync(process.argv[3], text + '\n');
    console.log(text);
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
