// ABI layout tests use a simulated dispatcher, not FEX execution. Actual saved
// translations are covered separately by browser-sdk.py --research-fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../../Sources/BetterJITWebKit/Resources/engine.mjs';
import {limits} from './fixtures.mjs';
for (const abi of ['sysv','win64']) {
 test(`${abi} register/stack arguments 0..16 and maximum u64 are laid out exactly`,async()=>{
  for(let count=0;count<=16;count++) {
   const e=new Engine();await e.command('configure',{limits,services:[]});
   const cfg={guestAbi:abi,ctx:256,stateSize:512,gregsOff:32,windowHi:20480,stackTop:0x10000,halt:0x2000,imageLow:0x3000};
   const args=Array.from({length:count},(_,i)=>(i===count-1 ? 0xffffffffffffffffn : BigInt(i+1)));
   let visited=false;
   e.fex={cfg,state:new Uint8Array(512),imageBytes:32,runtime:{runAsync:async(entry,stop)=>{
    assert.equal(entry,0x3000);assert.equal(stop,0x2000);visited=true;
    const dv=new DataView(e.memory.buffer),g=cfg.ctx+cfg.gregsOff,w=BigInt(cfg.windowHi)<<32n;
    const registers=abi==='win64'?[1,2,8,9]:[7,6,2,1,8,9],shadow=abi==='win64'?32:0;
    const sp=Number(dv.getBigUint64(g+32,true)-w);assert.equal(sp%16,8);
    assert.equal(dv.getBigUint64(sp,true),w+BigInt(stop));
    args.forEach((value,i)=>assert.equal(dv.getBigUint64(i<registers.length?g+registers[i]*8:sp+8+shadow+(i-registers.length)*8,true),value));
    if(shadow)for(let i=0;i<shadow;i++)assert.equal(dv.getUint8(sp+8+i),0);
    dv.setBigUint64(g,42n,true);
   }}};
   assert.equal(await e.command('fex.call',{entry:0x3000,arguments:args.map(String)}),'42');assert.equal(visited,true);e.close();
  }
 });
}
test('FEX invalid values and overlapping stack are rejected before dispatch',async()=>{
 const e=new Engine();await e.command('configure',{limits,services:[]});
 let calls=0;e.fex={cfg:{guestAbi:'sysv',ctx:256,stateSize:512,gregsOff:32,windowHi:0,stackTop:512,halt:20,imageLow:4096},state:new Uint8Array(512),imageBytes:32,runtime:{runAsync:()=>{calls++;}}};
 for(const args of [['18446744073709551616'],['-1'],['01'],['1\n'],Array(17).fill('1')])await assert.rejects(()=>e.command('fex.call',{entry:1,arguments:args}));
 await assert.rejects(()=>e.command('fex.call',{entry:1,arguments:['1']}),{code:'invalidBackend'});assert.equal(calls,0);e.close();
});
test('FEX execution failure is terminal and not reported as a normal return',async()=>{
 const e=new Engine();await e.command('configure',{limits,services:[]});
 e.fex={cfg:{guestAbi:'sysv',ctx:256,stateSize:512,gregsOff:32,windowHi:0,stackTop:65536,halt:20,imageLow:4096},state:new Uint8Array(512),imageBytes:32,runtime:{runAsync:()=>{throw Object.assign(Error('missing'),{code:'translationMissing'});}}};
 await assert.rejects(()=>e.command('fex.call',{entry:1,arguments:[]}),{code:'fexExecution'});assert.equal(e.closed,true);
 await assert.rejects(()=>e.command('read',{offset:0,count:1}),{code:'closed'});
});
