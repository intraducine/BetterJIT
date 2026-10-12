// SPDX-License-Identifier: GPL-3.0-or-later
// Regression tests against the exported kernel, real VFS files and pipe queue.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
globalThis.self=globalThis;
vm.runInThisContext(fs.readFileSync(new URL('../../Sources/BetterJITLinux/Resources/linux/web/linux-kernel.js',import.meta.url),'utf8'));
const {Kernel,HostFile,Pipe,PipeEnd,BLOCK,ConsoleFile}=LinuxBundle.require('./kernel.js');
const {sys}=LinuxBundle.require('./syscalls.js');
const {WebVfs}=LinuxBundle.require('./vfs_web.js');
const {SYS,E,O}=LinuxBundle.require('./abi.js');
function setup() {
 const bytes=Uint8Array.from({length:256*1024},(_,i)=>(i*31+7)&255);
 const ranges=[],fetchFile=()=>{throw Error('sendfile must use bounded file ranges');};
 fetchFile.range=(p,offset,length,into)=>{ranges.push(length);into.set(bytes.subarray(offset,offset+length));};
 const vfs=new WebVfs([['/input','f',0o444,bytes.length,0]],fetchFile,1000,1000);
 const opened=vfs.open('/input',0,0),input=new HostFile(vfs,opened.fd,opened.path,0,false);
 const pipe=new Pipe(),reader=new PipeEnd(pipe,false),writer=new PipeEnd(pipe,true);
 const dv=new DataView(new ArrayBuffer(64));
 const t={proc:{file:fd=>fd===3?input:writer,mm:{dv}},waitingOn:new Set()};
 const k={pollChanged(){},signalThread(){},makeRunnable(){}};
 const send=ptr=>sys[SYS.sendfile].call(k,t,4n,3n,BigInt(ptr),1n<<24n);
 return {bytes,input,pipe,reader,writer,dv,t,k,send,ranges};
}
test('sendfile preserves all 256 KiB across partial pipe writes and blocked retries',()=>{
 const s=setup(),result=new Uint8Array(s.bytes.length);let total=0;
 while(total<result.length) {
  assert.equal(s.send(0),65536);assert.equal(s.input.pos,total+65536);
  assert.equal(s.send(0),total+65536===result.length?0:BLOCK);assert.equal(s.input.pos,total+65536);
  const n=s.reader.read(s.k,s.t,result.subarray(total,total+65536));assert.equal(n,65536);total+=n;
 }
 assert.equal(s.send(0),0);assert.deepEqual(result,s.bytes);assert.ok(s.ranges.every(n=>n<=s.pipe.capacity));
});
test('explicit sendfile offset advances only accepted bytes and leaves file position unchanged',()=>{
 const s=setup();s.input.pos=123;s.dv.setBigInt64(8,17n,true);
 assert.equal(s.send(8),65536);assert.equal(s.dv.getBigInt64(8,true),65553n);assert.equal(s.input.pos,123);
 assert.equal(s.send(8),BLOCK);assert.equal(s.dv.getBigInt64(8,true),65553n);assert.equal(s.input.pos,123);
 s.pipe.readers=0;
 assert.throws(()=>s.send(8),e=>e.code===E.PIPE);assert.equal(s.dv.getBigInt64(8,true),65553n);
});
test('sendfile errors do not consume input and console descriptors have correct access modes',()=>{
 const s=setup();s.writer.flags|=O.NONBLOCK;
 assert.equal(s.send(0),65536);assert.throws(()=>s.send(0),e=>e.code===E.AGAIN);assert.equal(s.input.pos,65536);
 s.writer.flags|=O.APPEND;
 assert.throws(()=>s.send(0),e=>e.code===E.INVAL);assert.equal(s.input.pos,65536);
 assert.equal(new ConsoleFile(0).flags&O.ACCMODE,0);assert.equal(new ConsoleFile(1).flags&O.ACCMODE,O.WRONLY);
});
test('Wine bootstraps a missing prefix with the client and can prestart an existing prefix',()=>{
 const calls=[],vfs=new WebVfs([['/home/user','d',0o755,0,0]],()=>new Uint8Array(),1000,1000);
 const k={host:{sharedSpace:true},vfs,wineEnv:Kernel.prototype.wineEnv,
  spawnInit:(...args)=>calls.push(args)};
 const argv=['/opt/wine/bin/wine','cmd','/c','ver'],env=['HOME=/home/user'];
 Kernel.prototype.boot.call(k,argv,env);
 assert.deepEqual(calls[0][1],argv);assert.equal(k.onListen,undefined);
 vfs.add('/home/user/.wine','d',0o700,0,0);calls.length=0;
 Kernel.prototype.boot.call(k,argv,env);
 assert.deepEqual(calls[0][1],['/opt/wine/bin/wineserver','-f']);
 k.onListen();assert.deepEqual(calls[1][1],argv);assert.equal(k.onListen,null);
 calls.length=0;Kernel.prototype.boot.call(k,argv,[...env,'WINEPREFIX=/new-prefix']);
 assert.deepEqual(calls[0][1],argv);
});
test('explicit direct Wine policy carries across preloader exec without changing stock or unrelated execs',()=>{
 const stopped=Error('ordinary ELF loader reached'),calls=[];
 const k={directWineLoader:true,log(){},vfs:{stat(){throw stopped;}},
  loadImage:(...args)=>{calls.push(args);return 'redirected to real ELF loader';}};
 const argv=['/usr/lib/wine/x86_64-unix/wine-preloader','/usr/lib/wine/x86_64-unix/wine','cmd','/c','ver'];
 assert.equal(Kernel.prototype.loadImage.call(k,{},argv[0],argv,['HOME=/home/user','WINELOADERNOEXEC=0']),
  'redirected to real ELF loader');
 assert.equal(calls[0][1],argv[1]);assert.deepEqual(calls[0][2],argv.slice(1));
 assert.deepEqual(calls[0][3],['HOME=/home/user','WINELOADERNOEXEC=1']);
 k.directWineLoader=false;
 assert.throws(()=>Kernel.prototype.loadImage.call(k,{},argv[0],argv,[]),e=>e===stopped);
 k.directWineLoader=true;
 assert.throws(()=>Kernel.prototype.loadImage.call(k,{},'/bin/busybox',argv,[]),e=>e===stopped);
 assert.throws(()=>Kernel.prototype.loadImage.call(k,{},argv[0],[argv[0],'/bin/busybox'],[]),e=>e===stopped);
});
