// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental immutable executable snapshots and bounded static ELF preparation.
(function(root){
 'use strict';
 const M=root.BetterJITGuestMemory,P=4096n,stores=new WeakMap();
 class ImageError extends Error{constructor(errno,message){super(message);this.name='ImageError';this.errno=errno;}}
 class ImageUnsupported extends Error{constructor(message){super(message);this.name='ImageUnsupported';}}
 const ordinary=b=>b instanceof Uint8Array&&b.buffer instanceof ArrayBuffer&&!b.buffer.resizable;
 function canonical(path){return typeof path==='string'&&path.startsWith('/')&&!path.includes('\0')&&
  (path==='/'||path.split('/').slice(1).every(p=>p&&p!=='.'&&p!=='..'));}
 class ExecutableStore {
  constructor(files){const map=new Map();for(const {path,bytes,mode=0o755}of files){
   if(!canonical(path)||path==='/'||!ordinary(bytes)||!Number.isInteger(mode)||mode<0||mode>0o777||map.has(path)||[...map.keys()].some(p=>p.startsWith(path+'/')||path.startsWith(p+'/')))throw new TypeError('Invalid immutable executable');
   map.set(path,{bytes:Uint8Array.from(bytes),mode});
  }stores.set(this,map);Object.freeze(this);}
  readExecutableSnapshot(path){if(!canonical(path))throw new ImageUnsupported('Only canonical absolute UTF-8 paths are admitted');
   const map=stores.get(this),item=map.get(path);if(path==='/')throw new ImageError(13,'Executable is a directory');
   if(!item){if([...map.keys()].some(p=>p.startsWith(path==='/'?'/':path+'/')))throw new ImageError(13,'Executable is a directory');throw new ImageError(2,'Executable does not exist');}
   if(!(item.mode&0o111))throw new ImageError(13,'Executable permission denied');return Uint8Array.from(item.bytes);
  }
 }
 function readCString(copy,address,maximum=4096){
  if(typeof address!=='bigint'||address<-(1n<<63n)||address>=1n<<64n)throw new TypeError('Full guest i64 pointer required');let at=BigInt.asUintN(64,address),count=0;const chunks=[];
  while(count<maximum){const n=Math.min(maximum-count,Number(P-at%P)),bytes=copy.copyIn(at,n),nul=bytes.indexOf(0),take=nul<0?n:nul;chunks.push(bytes.slice(0,take));count+=take;
   if(nul>=0){const out=new Uint8Array(count);let off=0;for(const b of chunks){out.set(b,off);off+=b.length;}return out;}
   at+=BigInt(n);if(at>=1n<<64n)throw new M.MemoryFault('range',address,BigInt(count+1),'read');
  }throw new ImageUnsupported('Guest string exceeds the declared bound');
 }
 function readArguments(copy,pathPointer,argvPointer,envPointer){
  const pathBytes=readCString(copy,pathPointer,4096);let path;
  try{path=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(pathBytes);}catch{throw new ImageUnsupported('Non-UTF-8 executable path');}
  if(!path)throw new ImageError(2,'Empty executable path');if(!canonical(path))throw new ImageUnsupported('Only canonical absolute executable paths are admitted');
  let total=0;
  function vector(pointer,required){
   if(!pointer){if(required)throw new ImageUnsupported('At least one argv entry is required');return [];}
   const out=[];
   for(let i=0;i<=1024;i++){
    const at=pointer+BigInt(i)*8n;if(at<0n||at+8n>1n<<64n)throw new M.MemoryFault('range',pointer,BigInt(i+1)*8n,'read');
    const p=copy.readU64(at);if(!p){if(required&&!out.length)throw new ImageUnsupported('Empty argv is not admitted');return out;}
    if(i===1024)throw new ImageUnsupported('Guest pointer vector exceeds 1024 entries');
    const bytes=readCString(copy,p,4096);total+=bytes.length+1;if(total>128*1024)throw new ImageUnsupported('Exec arguments exceed 128KiB');out.push(bytes);
   }
  }
  return Object.freeze({path,argv:vector(argvPointer,true),envp:vector(envPointer,false)});
 }
 function prepare(oldSpace,bytes,args,random){
  if(!ordinary(bytes))throw new TypeError('Owned ordinary ELF bytes required');
  if(bytes.length>1024*1024)throw new ImageUnsupported('ELF file exceeds 1 MiB');
  const bad=m=>{throw new ImageError(8,m);},unsupported=m=>{throw new ImageUnsupported(m);};
  if(bytes.length<64||bytes[0]!==127||bytes[1]!==69||bytes[2]!==76||bytes[3]!==70)bad('Not ELF');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes[4]!==2||bytes[5]!==1||bytes[6]!==1||v.getUint16(18,true)!==62||v.getUint32(20,true)!==1||v.getUint16(52,true)!==64)bad('Invalid ELF64 x86-64 header');
  if(v.getUint16(16,true)!==2)unsupported('Only static ET_EXEC is admitted');
  const entry=v.getBigUint64(24,true),phoff=v.getBigUint64(32,true),phnum=v.getUint16(56,true),phent=v.getUint16(54,true),fileSize=BigInt(bytes.length);
  if(phent!==56||!phnum)bad('Invalid program-header table');if(phnum>16)unsupported('More than 16 program headers');
  if(phoff<64n||phoff+BigInt(phnum)*56n>fileSize)bad('Program-header table outside file');
  const limit=oldSpace.stats().virtualLimit,loads=[],stackBytes=256n*1024n,stackTop=limit/P*P-16n*P,stackBase=stackTop-stackBytes;let mapped=stackBytes,phdr;
  if(stackBase<0x10000n)unsupported('Guest window too small for exec stack');
  for(let i=0;i<phnum;i++){
   const at=Number(phoff)+i*56,type=v.getUint32(at,true),flags=v.getUint32(at+4,true),off=v.getBigUint64(at+8,true),va=v.getBigUint64(at+16,true),filesz=v.getBigUint64(at+32,true),memsz=v.getBigUint64(at+40,true),align=v.getBigUint64(at+48,true);
   if(type===0)continue;
   if(type===0x6474e551){if(flags!==6)unsupported('Only RW non-executable GNU stack');continue;}
   if(type!==1)unsupported('Unimplemented ELF segment type');
   if(filesz>memsz||off+filesz>fileSize||va+memsz>1n<<64n)bad('Invalid ELF segment span');if(!memsz)continue;
   if((flags&~7)||!(flags&4)||(flags&3)===3)unsupported('Load permissions are outside the RX/R/RW profile');
   if(align!==P||off%P!==va%P||(filesz&&va%P))unsupported('Only aligned file loads and distinct zero-fill BSS pages are admitted');
   const start=va/P*P,end=(va+memsz+P-1n)/P*P;if(start<0x10000n||end>limit||end>stackBase-P)unsupported('ELF outside guest window or overlaps stack');
   if(loads.some(p=>start<p.end&&end>p.start))unsupported('Overlapping load pages');mapped+=end-start;if(mapped>32n*1024n*1024n)unsupported('ELF backing exceeds 32MiB');
   if(flags===4&&phoff>=off&&phoff+BigInt(phnum)*56n<=off+filesz)phdr=va+phoff-off;
   loads.push({start,va,end,off,filesz,memsz,flags});
  }
  if(!loads.some(p=>(p.flags&1)&&entry>=p.va&&entry<p.va+p.filesz))bad('Entry is not in file-backed executable bytes');
  if(phdr===undefined)unsupported('Program headers must be mapped read-only');
  if(!ordinary(random)||random.length!==16)throw new TypeError('Owned 16-byte AT_RANDOM required');
  if(!args||!canonical(args.path)||!Array.isArray(args.argv)||!args.argv.length||!Array.isArray(args.envp)||args.argv.length>1024||args.envp.length>1024||
     [...args.argv,...args.envp].some(b=>!ordinary(b)||b.includes(0)||b.length>=4096)||
     [...args.argv,...args.envp].reduce((n,b)=>n+b.length+1,0)>128*1024)throw new ImageUnsupported('Arguments outside declared exec bounds');
  const space=oldSpace.createEmpty(),codes=[];
  try {
   for(const p of loads){space.mapAnonymous(p.start,p.end-p.start,3);if(p.filesz)space.write(p.va,bytes.slice(Number(p.off),Number(p.off+p.filesz)));
    const prot=(p.flags&4?1:0)|(p.flags&2?2:0)|(p.flags&1?4:0);space.protect(p.start,p.end-p.start,prot);if(p.flags&1)codes.push(Object.freeze({address:p.va,bytes:bytes.slice(Number(p.off),Number(p.off+p.filesz))}));}
   space.mapAnonymous(stackBase,stackBytes,3);let sp=stackTop;
   function strings(values){const ptrs=[];for(let i=values.length-1;i>=0;i--){const b=values[i];sp-=BigInt(b.length+1);const out=new Uint8Array(b.length+1);out.set(b);space.write(sp,out);ptrs[i]=sp;}return ptrs;}
   const env=strings(args.envp),argv=strings(args.argv);sp=(sp-16n)&~15n;const randomAt=sp;space.write(sp,Uint8Array.from(random));
   const values=[BigInt(argv.length),...argv,0n,...env,0n,3n,phdr,4n,56n,5n,BigInt(phnum),6n,P,9n,entry,25n,randomAt,0n,0n];sp=(sp-BigInt(values.length)*8n)&~15n;
   if(sp<stackBase)unsupported('Initial stack exceeds admitted size');const table=new Uint8Array(values.length*8),dv=new DataView(table.buffer);values.forEach((x,i)=>dv.setBigUint64(i*8,x,true));space.write(sp,table);
   return Object.freeze({space,entry,stackPointer:sp,stackBase,stackTop,phdr,codes:Object.freeze(codes),path:args.path,argv:args.argv.map(b=>new TextDecoder().decode(b))});
  }catch(error){space.close();throw error;}
 }
 root.BetterJITGuestImage=Object.freeze({VERSION:1,ImageError,ImageUnsupported,ExecutableStore,readCString,readArguments,prepare});
})(typeof globalThis!=='undefined'?globalThis:self);
