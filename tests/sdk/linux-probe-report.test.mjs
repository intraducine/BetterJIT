// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';import assert from 'node:assert/strict';
import P from './linux-host/sparse-linux-probe-report.cjs';
const entry=0x12340000n,stackPointer=0x7ffff000n;
const image=bytes=>({entry,stackPointer,codes:[{address:entry,bytes:Uint8Array.from(bytes)}],space:{executableSnapshot(){throw Error('Must not read guest mapping');}}});
test('entry transfer is checked at first MOV, independently of later RDI',()=>{
 const check=P.entryStackCheck(image([0x48,0x89,0xe7]));P.observeEntry(check,{status:0,rip:entry+3n},stackPointer);
 assert.equal(check.verified,true);assert.equal(check.observedRDI,stackPointer);
});
test('incorrect initial transfer and incorrect first continuation still fail',()=>{
 for(const [last,rdi]of [[{status:0,rip:entry+3n},1n],[{status:0,rip:entry+4n},stackPointer],[{status:2,rip:entry+3n},stackPointer]]){
  const check=P.entryStackCheck(image([0x48,0x89,0xe7]));assert.throws(()=>P.observeEntry(check,last,rdi),assert.AssertionError);assert.equal(check.verified,false);
 }
});
test('short, missing and different entry bytes remain explicitly unverified without extra reads',()=>{
 for(const bytes of [[],[0x48],[0x48,0x89],[0x90,0x90,0x90],[0x0f,0x0b]]){
  const check=P.entryStackCheck(image(bytes));P.observeEntry(check,{status:0,rip:entry+3n},stackPointer);
  assert.equal(check.applicable,false);assert.equal(check.verified,false);
 }
});
test('failure JSON is bounded, serializable and excludes paths, stacks and memory dumps',()=>{
 const error=Object.assign(Error('cannot open /workspace/private/secret.bin https://host.invalid/?token=PRIVATE '+ 'x'.repeat(100000)),{code:'ENOENT'});
 error.actual={};error.actual.self=error.actual;error.expected=1n<<100000n;error.stack='SECRET STACK';
 const progress={stage:'test',rip:entry,rdi:1n,instruction:Array(10000).fill(0x90),steps:Array.from({length:10000},()=>({rip:entry,status:0})),memory:new Uint8Array(1000000)};
 const report=P.failureReport({stage:'execute',input:{path:'/workspace/private',elf:Uint8Array.of(1),interpreter:Uint8Array.of(2)},progress,native:{units:3},cfg:{buildID:'test',coverageVersion:10}},error);
 const text=P.stringify(report);assert(text.length<12000);assert(!/secret\.bin|PRIVATE|SECRET STACK|1000000|workspace/.test(text));
 assert.equal(report.status,'probe-failed');assert.equal(report.error.expected,'[integer omitted]');assert.equal(report.progress.instruction.length,15);assert.equal(report.progress.steps.length,64);assert.equal(JSON.parse(text).progress.rdi,'0x1');
});
