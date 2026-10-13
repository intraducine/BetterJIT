// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/web/file_transport.js',import.meta.url),'utf8'));
test('HTTP fallback reads bounded ranges, offsets and every byte without loading a whole file',()=>{
 const source=Uint8Array.from({length:3*1024*1024+17},(_,i)=>(i*31+7)&255),calls=[];
 const into=new Uint8Array(2*1024*1024+19);
 BetterJITFileTransport.httpRange((method,url)=>{
  const query=new URL(url).searchParams,offset=Number(query.get('off')),length=Number(query.get('len'));
  assert.equal(method,'GET');assert.equal(query.get('p'),'/file with space');assert.ok(length<=1024*1024);
  calls.push({offset,length});return source.slice(offset,offset+length);
 },'http://127.0.0.1:1234','/file with space',123,into.length,into);
 assert.deepEqual(into,source.slice(123,123+into.length));assert.equal(calls.length,3);
});
test('range failures and malformed inputs cannot silently leave unchecked bytes',()=>{
 const out=new Uint8Array(16);
 assert.throws(()=>BetterJITFileTransport.httpRange(()=>new Uint8Array(15),'http://host','/file',0,16,out),/short HTTP/);
 for(const [offset,length] of [[-1,1],[0,17],[NaN,1],[0,1.5]])
  assert.throws(()=>BetterJITFileTransport.httpRange(()=>{throw Error('must not request');},'http://host','/file',offset,length,out),/Invalid file range/);
});
