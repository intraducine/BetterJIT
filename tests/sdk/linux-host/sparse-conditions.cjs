// SPDX-License-Identifier: GPL-3.0-or-later
// Real pinned FEX IR -> Wasm, owned broker checkpoints and native x86 rows.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs'),golden=require('./sparse-conditions-oracle.json');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',n+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,RIP=0x123400008000n,DATA=0x123456780000n;
const values=[0n,1n,15n,16n,0x7fffn,0x8000n,0xffffn,0x89abcdef7654ff80n];
const condition=(cc,f)=>{const c=!!(f&1),p=!!(f&4),z=!!(f&64),s=!!(f&128),o=!!(f&2048);return[o,!o,c,!c,z,!z,c||z,!c&&!z,s,!s,p,!p,s!==o,s===o,z||s!==o,!z&&s===o][cc];};
const parity=n=>[...(n&255).toString(2)].filter(x=>x==='1').length%2===0;
function compareFlags(x,y,df){const a=Number(x&65535n),b=Number(y&65535n),r=(a-b)&65535,signed=n=>n&32768?n-65536:n,total=signed(a)-signed(b);return(a<b?1:0)|(parity(r)?4:0)|((a&15)<(b&15)?16:0)|(r===0?64:0)|(r&32768?128:0)|(total< -32768||total>32767?2048:0)|(df?1024:0);}
const compareRows=new Map(golden.compare.map(r=>[r.slice(0,4).join(':'),r[4]]));
function nativeOracle(){if(process.platform!=='linux'||process.arch!=='x64')return{supported:false,reason:'Retained native x86 rows; fresh oracle requires Linux x86-64'};const dir=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-condition-'));try{const binary=path.join(dir,'oracle'),build=spawnSync(process.env.CC||'cc',['-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-conditions-oracle.c'),'-o',binary],{encoding:'utf8'});assert.equal(build.status,0,build.stderr);const run=spawnSync(binary,[],{encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return{supported:true,compare:golden.compare.length,logical:golden.logical.length,conditions:golden.conditions.length,producers:golden.producers.length};}finally{fs.rmSync(dir,{recursive:true,force:true});}}
const rex=(bits,force=false)=>bits||force?[0x40|bits]:[],imm16=n=>[n&255,n>>8&255];
function compareEncoding(form,left,right){const bits=(left>=8?1:0)|(right>=8?4:0);return form===0?[0x66,...rex(bits),0x39,0xc0|((right&7)<<3)|(left&7)]:form===1?[0x66,...rex(right>=8?4:0),0x39,0x40|((right&7)<<3),6]:form===2?[0x66,...rex(left>=8?4:0),0x3b,0x40|((left&7)<<3),6]:form===7?[0x66,0x3d,0x80,0xff]:[0x66,...rex(left>=8?1:0),...(form===5?[0x81,0xf8|(left&7),0,0x80]:[0x83,0xf8|(left&7),[0,0,0,1,16,0,0x80][form]])];}
function logicalDefinition(form){return{kind:[1,4,6][form>>2],mask:[0,0xff80,0xffff,0x8000][form&3]};}
function logicalEncoding(form,r,alias=0){const {kind,mask}=logicalDefinition(form),n=form&3;return[0x66,...rex((r>=8?1:0)|alias),...(n===3?[kind===1?0x0d:kind===4?0x25:0x35,...imm16(mask)]:n===2?[0x81,0xc0|kind<<3|(r&7),...imm16(mask)]:[0x83,0xc0|kind<<3|(r&7),n===0?0:0x80])];}
async function main(){
 const oracle=nativeOracle();assert.equal(golden.compare.length,1024);assert.equal(golden.logical.length,192);assert.equal(golden.conditions.length,1024);
 for(const [form,x,y,df,f]of golden.compare){const l=form===2?values[y]:values[x],r=form<3?(form===2?values[x]:values[y]):[0n,0n,0n,1n,16n,0x8000n,0xff80n,0xff80n][form];assert.equal(f,compareFlags(l,r,df));}
 for(const [form,x,df,r,f]of golden.logical){const {kind,mask}=logicalDefinition(form),v=values[x],low=v&65535n,m=BigInt(mask),result=(v&~65535n)|(kind===1?low|m:kind===4?low&m:low^m),word=Number(result&65535n);assert.equal(BigInt(r),result);assert.equal(f,(parity(word)?4:0)|(word===0?64:0)|(word&32768?128:0)|(df?1024:0));}
 for(const [cc,f,a,b,s,t]of golden.conditions){const taken=condition(cc,f);assert.equal(t,Number(taken));assert.equal(BigInt(a),taken?0x76543210n:0xaabbccddn);assert.equal(BigInt(b),taken?0xfedcba9876543210n:0x12345678aabbccddn);assert.equal(BigInt(s),0xaabbccddn);}
 let report;
 await serve('guestmem=broker1',async(get,log)=>{
  const cfg=await(await get('/xlat/config')).json(),initial=new Uint8Array(await(await get('/xlat/state')).arrayBuffer()),memory=B.createInternalMemory(),view=new DataView(memory.buffer),tb=B.ABI.threadBase,cpu=cfg.checkpoint.cpu,g=tb+cpu.offset+cpu.generalRegistersOffset,lazy=tb+cfg.checkpoint.lazyFlags.offset;
  const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget,{virtualLimit:1n<<47n}),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint});space.mapAnonymous(DATA,8192n,3);
  const q=new DataView(memory.buffer,tb+B.ABI.scratchOffset,128),snapshot=()=>['cpu','lazyFlags','roundMode'].map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();}),compiled=new Map();let sequence=0,steps=0,compareChecks=0,logicalChecks=0,conditionChecks=0,consumerChecks=0;
  async function request(code){await get('/xlat/code?addr='+RIP.toString(16),{method:'POST',body:Uint8Array.from(code)});return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+RIP)).arrayBuffer()));}
  async function compile(code){const key=code.join(':');if(compiled.has(key))return compiled.get(key);const u=await request(code);assert.equal(u.status,0,Buffer.from(code).toString('hex')+': '+log());const module=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(module).every(i=>i.module==='e'&&['mem','tb','memory'].includes(i.name)));u.instance=await WebAssembly.instantiate(module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb),memory:()=>{q.setUint32(B.FIELD.sequence,++sequence,true);q.setBigUint64(B.FIELD.lease,token.generation,true);return broker.dispatch(token,{lease:token.generation,sequence}).status;}}});compiled.set(key,u);return u;}
  function step(u,{after,finish=true,status}={}){view.setBigUint64(tb+cpu.offset+cpu.ripOffset,u.rip,true);q.setBigUint64(B.FIELD.checkpoint,broker.beginInstruction(token,u),true);const before=snapshot(),requests=broker.stats().requests,actual=u.instance.exports.run();steps++;after?.();const done=finish?broker.finishInstruction(token,{status:status??actual,nextRip:u.nextRip}):null;assert.equal(broker.stats().requests-requests,u.operation===8?1:0);return{status:actual,done,before};}
  function seed(flags=0){new Uint8Array(memory.buffer,tb+cpu.offset,cpu.size).set(initial);for(let i=0;i<16;i++)view.setBigUint64(g+i*8,0x12345678aabbccddn+BigInt(i),true);view.setUint32(lazy,0,true);view.setUint32(lazy+4,0x89abcdef,true);view.setBigUint64(lazy+8,0xabcdeffedcba9876n,true);view.setBigUint64(lazy+16,0x123456789abcdef0n,true);view.setUint32(tb+cfg.checkpoint.roundMode.offset,3,true);const nzcv=((flags&128?0x80000000:0)|(flags&64?0x40000000:0)|(flags&1?0:0x20000000)|(flags&2048?0x10000000:0))>>>0;view.setUint32(tb+cpu.offset+cpu.nzcvOffset,nzcv,true);view.setUint32(tb+cpu.offset+cpu.parityRawOffset,flags&4?0x89abcdee:0x89abcdef,true);view.setUint32(tb+cpu.offset+cpu.auxiliaryRawOffset,0x54321000,true);view.setInt8(tb+cpu.offset+cpu.nzcvOffset-14,flags&1024?-1:1);}
  const syscall=await compile([15,5]),sets=[];for(let cc=0;cc<16;cc++)sets.push(await compile([0x41,15,0x90+cc,0xc6]));
  const checkFlags=(expected,mask=0xcd5n)=>{step(syscall);assert.equal(view.getBigUint64(g+88,true)&mask,BigInt(expected));};
  try{
   for(let form=0;form<8;form++)for(let r=0;r<(form===7?1:16);r++){
    const source=(r+1)%16,left=form===2?r:r,right=form===0?source:r,u=await compile(compareEncoding(form,left,right));
    for(let x=0;x<values.length;x++)for(let y=0;y<(form<3?values.length:1);y++)for(let df=0;df<2;df++){
     seed(df?0xcd5:0);view.setBigUint64(g+r*8,form===1||form===2?values[y]:values[x],true);if(form===0)view.setBigUint64(g+source*8,values[y],true);
     if(form===1||form===2){view.setBigUint64(g,DATA-6n,true);if(r===0)continue;space.write(DATA,Uint8Array.of(Number(values[x]&255n),Number(values[x]>>8n&255n)));}
     const expected=compareRows.get([form,x,y,df].join(':')),before=space.read(DATA,32);assert.equal(step(u).status,0);compareChecks++;assert.deepEqual(space.read(DATA,32),before);checkFlags(expected);
    }
   }
   // Equal operands, both ModRM directions, and high-register aliases.
   for(const op of [0x39,0x3b])for(let r=0;r<16;r++){const u=await compile([0x66,...rex((r>=8?5:0)|2),op,0xc0|((r&7)<<3)|(r&7)]);seed();view.setBigUint64(g+r*8,values[7],true);step(u);checkFlags(0x44);compareChecks++;}
   for(let form=0;form<12;form++)for(let r=0;r<((form&3)===3?1:16);r++)for(const alias of [0,2,4,6]){
    const u=await compile(logicalEncoding(form,r,alias));for(const row of golden.logical.filter(x=>x[0]===form)){const [,x,df,result,flags]=row;seed(df?0xcd5:0);view.setBigUint64(g+r*8,values[x],true);step(u);assert.equal(view.getBigUint64(g+r*8,true),BigInt(result));logicalChecks++;
     if(r===0&&alias===0&&x<2)for(let cc=0;cc<16;cc++){step(sets[cc]);assert.equal(view.getBigUint64(g+112,true)&255n,condition(cc,flags)?1n:0n);consumerChecks++;}checkFlags(flags,0xcc5n);}
   }
   // All conditions, both branch lengths and all signed displacement directions.
   for(let cc=0;cc<16;cc++)for(const code of [[0x70+cc,0],[0x70+cc,0x7f],[0x70+cc,0x80],[15,0x80+cc,0,0,0,0],[15,0x80+cc,0xff,0xff,0xff,0x7f],[15,0x80+cc,0,0,0,0x80]]){
    const u=await compile(code);for(const [,flags,,,,taken]of golden.conditions.filter(x=>x[0]===cc)){seed(flags);const r=step(u);assert.equal(r.done.rip,taken?u.branchTarget:u.nextRip);conditionChecks++;}
   }
   // Full flag truth table, all GPRs, equal-register and distinct-register forms.
   for(let cc=0;cc<16;cc++)for(const width of [4,8])for(let r=0;r<16;r++)for(const source of [r,(r+1)%16]){
    const u=await compile([...rex((width===8?8:0)|(r>=8?4:0)|(source>=8?1:0)),15,0x40+cc,0xc0|((r&7)<<3)|(source&7)]);
    for(const [,flags,r32,r64,same]of golden.conditions.filter(x=>x[0]===cc)){seed(flags);view.setBigUint64(g+r*8,0x12345678aabbccddn,true);if(source!==r)view.setBigUint64(g+source*8,0xfedcba9876543210n,true);step(u);assert.equal(view.getBigUint64(g+r*8,true),source===r?(width===4?BigInt(same):0x12345678aabbccddn):BigInt(width===4?r32:r64));conditionChecks++;}
   }
   // Condition consumers of actual lazy word producers, before materialization.
   for(const code of [[0x66,0x39,0xc8],[0x66,0x83,0xf0,0x80]])for(const input of values){const producer=await compile(code);for(let cc=0;cc<16;cc++){
    seed();view.setBigUint64(g,input,true);view.setBigUint64(g+8,0x8000n,true);step(producer);const flags=code[1]===0x39?compareFlags(input,0x8000n,0):(()=>{const n=Number((input^0xff80n)&65535n);return(parity(n)?4:0)|(n===0?64:0)|(n&32768?128:0);})();
    const consumer=await compile([0x7c+(cc-12),1]);assert.equal(step(consumer).done.rip,condition(cc,flags)?consumer.branchTarget:consumer.nextRip);consumerChecks++;
   }}
   // ADD/SUB and TEST32/64 feed the new
   // conditions while their actual lazy descriptors are still live.
   const producerCodes=[[1,0xc8],[0x48,1,0xc8],[0x29,0xc8],[0x48,0x29,0xc8],[0x85,0xc8],[0x48,0x85,0xc8]];
   for(const [form,x,y,df,flags]of golden.producers){const producer=await compile(producerCodes[form]);
    for(let cc=0;cc<16;cc++)for(const branch of [true,false]){
     seed(df?0xcd5:0);view.setBigUint64(g,values[x],true);view.setBigUint64(g+8,values[y],true);step(producer);
     view.setBigUint64(g+16,0x12345678aabbccddn,true);view.setBigUint64(g+24,0xfedcba9876543210n,true);
     const consumer=await compile(branch?[0x70+cc,0x40]:[0x48,15,0x40+cc,0xd3]),r=step(consumer),taken=condition(cc,flags);
     if(branch)assert.equal(r.done.rip,taken?consumer.branchTarget:consumer.nextRip);else assert.equal(view.getBigUint64(g+16,true),taken?0xfedcba9876543210n:0x12345678aabbccddn);
     consumerChecks++;
    }
   }
   const memoryEdges=[];
   for(const op of [0x39,0x3b])for(const blocked of [false,true]){
    const u=await compile([0x66,op,0x48,6]);seed();view.setBigUint64(g,DATA+4089n,true);view.setBigUint64(g+8,values[7],true);space.write(DATA+4095n,Uint8Array.of(0xff,0x7f));space.protect(DATA+4096n,4096n,blocked?0:1);
    const before=space.read(DATA,4096),accounting=budget.stats(),r=step(u);assert.equal(r.status,blocked?1:0);
    if(blocked){assert.deepEqual(snapshot(),r.before);assert.equal(q.getBigUint64(B.FIELD.faultAddress,true),DATA+4096n);}assert.deepEqual(space.read(DATA,4096),before);assert.deepEqual(budget.stats(),accounting);space.protect(DATA+4096n,4096n,3);memoryEdges.push({opcode:op,status:r.status});
   }
   // A data register may also own the effective-address base. Its complete
   // prestate, rather than the loaded word, remains the register operand.
   for(const op of [0x39,0x3b])for(const n of [0n,1n,15n,16n]){const u=await compile([0x66,op,0x40,6]);seed();const address=DATA+n+6n;view.setBigUint64(g,address-6n,true);space.write(address,Uint8Array.of(0,0x80));step(u);checkFlags(op===0x39?compareFlags(0x8000n,n,0):compareFlags(n,0x8000n,0));compareChecks++;}
   const rollback=[];
   for(const code of [[0x66,0x39,0xc8],[0x66,0x83,0xe0,0xff],[15,0x4a,0xc1],[0x7c,1]]){const u=await compile(code);seed();const r=step(u,{status:2});assert.equal(r.done.status,2);assert.deepEqual(snapshot(),r.before);rollback.push(code);}
   // An independent owner per failure because invariant failures poison owners.
   for(const code of [[0x66,0x67,0x39,0xc8],[0x66,0x48,0x39,0xc8],[0x66,0x0f,0x4c,0xc1],[0xf0,15,0x4c,0xc1],[15,0x4c,1],[0x66,0x83,0x08,1]])assert.equal((await request(code)).status,2,Buffer.from(code).toString('hex'));
   const native=await(await get('/xlat/totals')).json();for(const field of ['irCacheEntries','irOwnedEntries','irDataBytes','irListBytes','irBufferCapacityBytes'])assert.equal(native[field],0);assert.equal(native.irGenerations,native.irDiscards);
   report={evidence:'Native x86 scalar/condition rows, actual pinned FEX/Wasm, exact owned full checkpoints and rollback. Synthetic inputs; no Wine completion or device execution claim.',nativeOracle:oracle,coverageVersion:cfg.coverageVersion,buildID:cfg.buildID,compiled:compiled.size,compareChecks,logicalChecks,conditionChecks,consumerChecks,steps,rollback,memoryEdges,native};
  }finally{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
 });report.nativeChildClosed=true;if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
