// SPDX-License-Identifier: GPL-3.0-or-later
// Native hardware oracle and real pinned FEX/Wasm unary register contracts.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const {serve}=require('./native-step-contract.cjs'),description=require('./sparse-unary-cases.json'),golden=require('./sparse-unary-oracle.json');
for(const n of ['guest_memory','guest_memory_broker','thread_core'])vm.runInThisContext(fs.readFileSync(path.resolve(__dirname,'../../../Sources/BetterJITLinux/Resources/linux',n+'.js'),'utf8'));
const M=BetterJITGuestMemory,B=BetterJITGuestMemoryBroker,RIP=0x123400008000n,forms=description.operations.flatMap(op=>description.forms.map(form=>({...op,...form}))),rows=new Map(golden.map(r=>[r.slice(0,3).join(':'),r]));
function values(width){const mask=(1n<<BigInt(width*8))-1n,sign=(mask+1n)>>1n;return[0n,1n,2n,15n,16n,17n,0x7fn,0x80n,0xffn,sign-1n,sign,sign+1n,mask-1n,mask,mask^0x55n,mask>>1n];}
function inputValue(form,n){const mask=((1n<<BigInt(form.width*8))-1n)<<BigInt(form.shift);return(BigInt(description.unrelatedBits)&~mask)|((values(form.width)[n]<<BigInt(form.shift))&mask);}
const even=n=>[...Number(n&255n).toString(2)].filter(c=>c==='1').length%2===0;
function expected(form,input,flags){const bits=BigInt(form.width*8),shift=BigInt(form.shift),mask=(1n<<bits)-1n,sign=1n<<(bits-1n),x=input>>shift&mask;
 const total=form.kind===1?-x:form.kind===2?~x:form.kind===3?x+1n:x-1n,r=total&mask,result=form.width<4?(input&~(mask<<shift))|(r<<shift):r;
 if(form.kind===2)return{result,flags};
 const cf=form.kind===1?Number(x!==0n):flags&1,af=form.kind===1?!!(x&15n):form.kind===3?(x&15n)===15n:(x&15n)===0n,
  of=form.kind===1?x===sign:form.kind===3?x===sign-1n:x===sign;
 return{result,flags:cf|(even(r)?4:0)|(af?16:0)|(r===0n?64:0)|(r&sign?128:0)|(of?2048:0)|(flags&1024)};
}
function nativeOracle(){const check=spawnSync('python3',[path.resolve(__dirname,'../../../scripts/generate-sparse-unary-tests.py'),'--check'],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);
 if(process.platform!=='linux'||process.arch!=='x64')return{supported:false,reason:'Retained native x86 rows used; fresh hardware oracle requires Linux x86-64'};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-unary-'));try{const binary=path.join(dir,'oracle'),build=spawnSync(process.env.CC||'cc',['-O2','-mno-red-zone','-Wall','-Wextra','-Werror',path.join(__dirname,'sparse-unary-oracle.c'),'-o',binary],{encoding:'utf8'});assert.equal(build.status,0,build.stderr);const run=spawnSync(binary,[],{encoding:'utf8',maxBuffer:2*1024*1024});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),golden);return{supported:true,rows:golden.length};}finally{fs.rmSync(dir,{recursive:true,force:true});}}
function encoding(op,byte,word,rex,rm){return[...(word?[0x66]:[]),...(rex===undefined?[]:[rex]),byte?op.byteOpcode:op.wideOpcode,0xc0|op.group<<3|rm];}
async function main(){const oracle=nativeOracle();assert.equal(golden.length,(description.operations.length+description.sequences.length)*description.forms.length*description.flagSeeds.length*description.inputCount);assert.equal(rows.size,golden.length);for(const [id,seed,input,result,flags]of golden){const sequence=id<forms.length?[forms[id].kind]:description.sequences[Math.floor((id-forms.length)/description.forms.length)],form=id<forms.length?forms[id]:description.forms[id%description.forms.length];let e={result:inputValue(form,input),flags:description.flagSeeds[seed]};for(const kind of sequence)e=expected({...form,kind},e.result,e.flags);assert.equal(BigInt(result),e.result);assert.equal(flags,e.flags);}
 let report;await serve('guestmem=broker1',async(get,log)=>{
  const cfg=await(await get('/xlat/config')).json(),initial=new Uint8Array(await(await get('/xlat/state')).arrayBuffer()),memory=B.createInternalMemory(),view=new DataView(memory.buffer),tb=B.ABI.threadBase,cpu=cfg.checkpoint.cpu,g=tb+cpu.offset+cpu.generalRegistersOffset,lazy=tb+cfg.checkpoint.lazyFlags.offset;
  const budget=new M.BackingBudget(),space=new M.GuestAddressSpace(budget),broker=new B.GuestMemoryBroker(),token=broker.register(0,{space,memory,checkpointLayout:cfg.checkpoint});const cache=new Map();let steps=0,checks=0,consumers=0;
  async function request(code,rip=RIP){await get('/xlat/code?addr='+rip.toString(16),{method:'POST',body:Uint8Array.from(code)});return FexLinuxThread.parseBrokerStep(new Uint8Array(await(await get('/xlat/step?rip='+rip)).arrayBuffer()));}
  async function compile(code){const key=code.join(':');if(cache.has(key))return cache.get(key);const u=await request(code);assert.equal(u.status,0,Buffer.from(code).toString('hex')+': '+log());const module=await WebAssembly.compile(u.code);assert(WebAssembly.Module.imports(module).every(i=>i.module==='e'&&['mem','tb'].includes(i.name)));u.instance=await WebAssembly.instantiate(module,{e:{mem:memory,tb:new WebAssembly.Global({value:'i32'},tb)}});cache.set(key,u);return u;}
  const snapshot=()=>['cpu','lazyFlags','roundMode'].map(n=>{const p=cfg.checkpoint[n];return new Uint8Array(memory.buffer,tb+p.offset,p.size).slice();});
  function step(u,status){view.setBigUint64(tb+cpu.offset+cpu.ripOffset,u.rip,true);broker.beginInstruction(token,u);const before=snapshot(),actual=u.instance.exports.run();steps++;const done=broker.finishInstruction(token,{status:status??actual,nextRip:u.nextRip});return{status:actual,done,before};}
  function seed(flags,register,value){new Uint8Array(memory.buffer,tb+cpu.offset,cpu.size).set(initial);for(let r=0;r<16;r++)view.setBigUint64(g+r*8,r===register?value:0xfedcba9876540000n+BigInt(r)*0x101n,true);view.setUint32(lazy,0,true);view.setUint32(lazy+4,0x543210ff,true);view.setBigUint64(lazy+8,0x123456789abcdef0n,true);view.setBigUint64(lazy+16,0x8765432101234567n,true);view.setUint32(tb+cfg.checkpoint.roundMode.offset,3,true);
   view.setUint32(tb+cpu.offset+cpu.nzcvOffset,((flags&128?0x80000000:0)|(flags&64?0x40000000:0)|(flags&1?0:0x20000000)|(flags&2048?0x10000000:0))>>>0,true);view.setUint32(tb+cpu.offset+cpu.parityRawOffset,flags&4?0:1,true);view.setUint32(tb+cpu.offset+cpu.auxiliaryRawOffset,0xabcdef00|(flags&16),true);view.setInt8(tb+cpu.offset+cpu.nzcvOffset-14,flags&1024?-1:1);
  }
  const syscall=await compile([15,5]),setcc=[];for(let cc=0;cc<16;cc++)setcc.push(await compile([0x41,15,0x90+cc,0xc6]));
  const condition=(cc,f)=>{const c=!!(f&1),p=!!(f&4),z=!!(f&64),s=!!(f&128),o=!!(f&2048);return[o,!o,c,!c,z,!z,c||z,!c&&!z,s,!s,p,!p,s!==o,s===o,z||s!==o,!z&&s===o][cc];};
  const records=[];
  try{for(const op of description.operations)for(const byte of [true,false])for(const word of [false,true])for(const rex of [undefined,...Array.from({length:16},(_,i)=>0x40+i)])for(let rm=0;rm<8;rm++){
   const code=encoding(op,byte,word,rex,rm),width=byte?1:rex&8?8:word?2:4,shift=byte&&rex===undefined&&rm>=4?8:0,register=shift?rm-4:rm+(rex&1?8:0),formIndex=forms.findIndex(f=>f.kind===op.kind&&f.width===width&&f.shift===shift),form=forms[formIndex],u=await compile(code);assert.deepEqual(u.unaryOperand,{kind:op.kind,width,shift,register,length:code.length});
   for(let si=0;si<description.flagSeeds.length;si++)for(let n=0;n<description.inputCount;n++){
    const row=rows.get([formIndex,si,n].join(':'));seed(description.flagSeeds[si],register,inputValue(form,n));assert.equal(step(u).status,0,code.join(','));assert.equal(view.getBigUint64(g+register*8,true),BigInt(row[3]));checks++;
    if(register===0&&!word&&rex===undefined&&n<2)for(let cc=0;cc<16;cc++){step(setcc[cc]);assert.equal(view.getBigUint64(g+112,true)&255n,condition(cc,row[4])?1n:0n);consumers++;}
    step(syscall);assert.equal(view.getBigUint64(g+88,true)&0xcd5n,BigInt(row[4]),op.name+' native flags');
   }
   records.push({kind:op.kind,width,shift,register,rex:rex??null,word,rows:64});
  }
  let sequenceChecks=0;
  for(const [id,si,n,result,flags]of golden.filter(r=>r[0]>=forms.length)){
   const kinds=description.sequences[Math.floor((id-forms.length)/description.forms.length)],form=description.forms[id%description.forms.length];
   for(const register of form.shift?[0]:[0,12]){
    seed(description.flagSeeds[si],register,inputValue(form,n));
    for(const kind of kinds){const op=description.operations.find(o=>o.kind===kind),rm=form.shift?4:register&7,rex=form.shift?undefined:form.width===8?(register>=8?0x49:0x48):register>=8?0x41:undefined;step(await compile(encoding(op,form.width===1,form.width===2,rex,rm)));}
    assert.equal(view.getBigUint64(g+register*8,true),BigInt(result));step(syscall);assert.equal(view.getBigUint64(g+88,true)&0xcd5n,BigInt(flags));sequenceChecks++;
   }
  }
  const rollback=[];for(const op of description.operations){const u=await compile(encoding(op,false,false,0x49,4));seed(0xcd5,12,0x8000000000000000n);const r=step(u,2);assert.deepEqual(snapshot(),r.before);assert.equal(r.done.rip,u.rip);rollback.push(op.name);}
  const refused=[];for(const op of description.operations)for(const code of [[op.byteOpcode,op.group<<3],[op.wideOpcode,op.group<<3],[0xf0,op.wideOpcode,0xc0|op.group<<3],[0x67,op.wideOpcode,0xc0|op.group<<3],[0x40,0x66,op.wideOpcode,0xc0|op.group<<3],[0x66,0x66,op.wideOpcode,0xc0|op.group<<3]]){assert.equal((await request(code)).status,2,code.join(','));refused.push(code);}
  for(const op of description.operations)for(const code of [[op.byteOpcode],[0x66,op.wideOpcode],[0x49,op.wideOpcode]])assert.equal((await request(code)).status,2);
  const boundaries=[];for(const op of description.operations)for(const width of [1,2,4,8])for(const valid of [true,false]){const code=encoding(op,width===1,width===2,width===8?0x49:0x41,4),rip=(1n<<47n)-BigInt(code.length)-(valid?1n:0n),u=await request(code,rip);assert.equal(u.status,valid?0:2);boundaries.push({kind:op.kind,width,valid,status:u.status});}
  const native=await(await get('/xlat/totals')).json();for(const key of ['irCacheEntries','irOwnedEntries','irDataBytes','irListBytes','irBufferCapacityBytes'])assert.equal(native[key],0);assert.equal(native.irDiscards,native.irGenerations);assert.equal(broker.stats().requests,0);
  report={evidence:'Native hardware unary flags/results and actual pinned FEX/Wasm, all widths/GPRs/REX aliases/high bytes, exact broker-owned state and write-free rollback. No memory-unary, Wine completion or device claim.',nativeOracle:oracle,coverageVersion:cfg.coverageVersion,buildID:cfg.buildID,checks,sequenceChecks,consumers,steps,records,rollback,refused,boundaries,native};
  }finally{broker.unregister(token);space.close();assert.equal(budget.stats().ownedPayloadBytes,0);}
 });report.nativeChildClosed=true;if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,records:report.records.length}));}
main().catch(e=>{console.error(e);process.exitCode=1;});
