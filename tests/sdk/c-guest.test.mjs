// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {Engine,encodeBytes,capabilities} from '../../Sources/BetterJITWebKit/Resources/engine.mjs';
import {limits} from './fixtures.mjs';
// The C module imports a service, so current JSPI is required at instantiation.
// Chromium runs the same complete C test; Node's unsupported result is explicit.
test('compiler-produced C module matches 256 native reference vectors',async(t)=>{
 if(!capabilities().jspi){t.skip('JSPI unavailable in this Node; browser hardening suite runs the C differential test.');return;}
 if(!fs.existsSync('.build/c-guest/guest.wasm') || !fs.existsSync('.build/c-guest/reference.txt')){t.skip('Run bash Examples/CGuest/build.sh to generate the compiler-produced guest/reference.');return;}
 const e=new Engine();await e.command('configure',{limits,services:[]});
 await e.command('load',{module:'c',bytes:encodeBytes(fs.readFileSync('.build/c-guest/guest.wasm'))});
 for(const row of fs.readFileSync('.build/c-guest/reference.txt','utf8').trim().split('\n')){
  const [seed,count,want]=row.split(' ');
  const out=await e.command('invoke',{module:'c',export:'checksum',arguments:[{type:'i32',value:String(Number(seed)|0)},{type:'i32',value:count}],results:['i64']});
  assert.equal(BigInt.asUintN(64,BigInt(out[0].value)),BigInt(want));
 }e.close();
});
