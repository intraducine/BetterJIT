// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental Linux interpreter bootstrap. Not selected by the static profiles.
(function(root) {
 'use strict';
 const I=root.BetterJITGuestImage,P=4096n,U64=1n<<64n;
 if(!I)throw new Error('Immutable guest image contract required');
 const ordinary=b=>b instanceof Uint8Array&&b.buffer instanceof ArrayBuffer&&!b.buffer.resizable;
 const canonical=p=>typeof p==='string'&&p.startsWith('/')&&p!=='/'&&!p.includes('\0')&&p.split('/').slice(1).every(s=>s&&s!=='.'&&s!=='..');
 const bad=m=>{throw new I.ImageError(8,m);},unsupported=m=>{throw new I.ImageUnsupported(m);};
 const down=n=>n/P*P,up=n=>(n+P-1n)/P*P;

 function parse(bytes,interpreter) {
  if(!ordinary(bytes))throw new TypeError('Owned ordinary ELF bytes required');
  if(bytes.length>1024*1024)unsupported('ELF file exceeds 1 MiB');
  if(bytes.length<64||!bytes.subarray(0,7).every((b,i)=>b===[127,69,76,70,2,1,1][i]))bad('Invalid ELF64 identification');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),type=v.getUint16(16,true),fileSize=BigInt(bytes.length);
  if(v.getUint16(18,true)!==62||v.getUint32(20,true)!==1||v.getUint16(52,true)!==64)bad('Invalid ELF64 x86-64 header');
  if(interpreter?type!==3:![2,3].includes(type))unsupported('Linux image requires ET_EXEC/ET_DYN and an ET_DYN interpreter');
  const entry=v.getBigUint64(24,true),phoff=v.getBigUint64(32,true),phnum=v.getUint16(56,true),phent=v.getUint16(54,true);
  if(!phnum||phent!==56||phoff<64n||phoff+BigInt(phnum)*56n>fileSize)bad('Invalid program-header table');
  if(phnum>32)unsupported('More than 32 program headers');
  const loads=[],metadata=[];let interp=null,phdr,seenLoad=false,lastVA=-1n;
  for(let i=0;i<phnum;i++) {
   const at=Number(phoff)+i*56,p={type:v.getUint32(at,true),flags:v.getUint32(at+4,true),off:v.getBigUint64(at+8,true),va:v.getBigUint64(at+16,true),filesz:v.getBigUint64(at+32,true),memsz:v.getBigUint64(at+40,true),align:v.getBigUint64(at+48,true)};
   if(!p.type)continue;
   if(p.filesz>p.memsz||p.off+p.filesz>fileSize||p.va+p.memsz>U64)bad('Invalid ELF segment span');
   if(p.type===3) {
    if(interpreter||interp!==null||seenLoad)bad('Nested, duplicate or misplaced ELF interpreter');
    if(p.filesz<2n||p.filesz>4096n)bad('Invalid ELF interpreter path length');
    const b=bytes.subarray(Number(p.off),Number(p.off+p.filesz));
    if(b[b.length-1]!==0||b.subarray(0,-1).includes(0))bad('Unterminated or embedded-NUL interpreter path');
    try{interp=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b.subarray(0,-1));}catch{unsupported('Non-UTF-8 interpreter path');}
    if(!canonical(interp))unsupported('Only canonical absolute interpreter paths');
    continue;
   }
   if(p.type===0x6474e551) {if(p.flags!==6)unsupported('Only RW non-executable GNU stack');continue;}
   if(p.type!==1) {
    if(![2,4,6,7,0x6474e550,0x6474e552,0x6474e553].includes(p.type))unsupported('Unimplemented Linux ELF segment type');
    if(p.type===6&&(phdr||seenLoad))bad('Duplicate or misplaced PT_PHDR');
    if(p.type===6)phdr=p;
    if(metadata.some(q=>q.type===p.type)&&p.type!==4)bad('Duplicate Linux ELF metadata');
    metadata.push(p);continue;
   }
   seenLoad=true;
   if(p.va<lastVA)bad('Unordered load segments');lastVA=p.va;
   if(!p.memsz)continue;
   if((p.flags&~7)||!(p.flags&4)||(p.flags&3)===3)unsupported('Load permissions outside RX/R/RW');
   if(p.off%P!==p.va%P||p.align>2n*1024n*1024n||(p.align>1n&&((p.align&(p.align-1n))||p.off%p.align!==p.va%p.align)))unsupported('Unsupported load alignment');
   p.start=down(p.va);p.end=up(p.va+p.memsz);
   if(loads.some(q=>p.start<q.end&&p.end>q.start))unsupported('Overlapping Linux load pages');
   loads.push(p);
  }
  if(!loads.length||!loads.some(p=>(p.flags&1)&&entry>=p.va&&entry<p.va+p.filesz))bad('Entry outside executable file bytes');
  if(!interpreter&&interp===null)unsupported('Linux bootstrap requires a PT_INTERP executable');
  const mapped=(off,va,length)=>loads.some(p=>off>=p.off&&off+length<=p.off+p.filesz&&va===p.va+off-p.off);
  const table=loads.find(p=>phoff>=p.off&&phoff+BigInt(phnum)*56n<=p.off+p.filesz);
  if(!table)unsupported('Program headers must be file-backed and readable');
  const phdrVA=table.va+phoff-table.off;
  if(phdr&&(phdr.off!==phoff||phdr.va!==phdrVA||phdr.filesz!==BigInt(phnum)*56n||phdr.memsz!==phdr.filesz||phdr.flags!==4))bad('PT_PHDR does not describe the mapped program headers');
  for(const p of metadata) {
   if(p.type===6)continue;
   if(p.type===0x6474e552) {
    if(!loads.some(q=>p.va>=q.va&&p.va+p.memsz<=q.va+q.memsz))bad('RELRO outside a load segment');
    continue; // The interpreter, not this loader, must apply mprotect after relocations.
   }
   if(p.type===7) {
    if(!loads.some(q=>p.va>=q.va&&p.va+p.memsz<=q.va+q.memsz)||!mapped(p.off,p.va,p.filesz))bad('TLS template outside load bytes');
    continue; // No TLS is allocated or advertised as initialized here.
   }
   if(!mapped(p.off,p.va,p.filesz))bad('ELF metadata outside corresponding file-backed load bytes');
   if(p.type===2&&(p.filesz%16n||!p.filesz))bad('Invalid ELF64 dynamic table span');
   if(p.type===4||p.type===0x6474e553)checkNotes(bytes,p);
  }
  return {bytes,type,entry,phdr:phdrVA,phnum,loads,interp,metadata};
 }

 function checkNotes(bytes,p) {
  if(p.filesz>65536n)unsupported('ELF notes exceed 64 KiB');
  // GNU build IDs and ABI tags are passive metadata. FEATURE_1_AND with
  // IBT/SHSTK compatibility bits does not enable or advertise CET here.
  // The observed Wine FEATURE_2_USED X86 bit and ISA_1_USED baseline bit
  // describe scalar/baseline use; they never enable more native emitters.
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),end=Number(p.off+p.filesz);let at=Number(p.off);
  while(at<end) {
   if(at+12>end)bad('Truncated ELF note');
   const name=v.getUint32(at,true),size=v.getUint32(at+4,true),type=v.getUint32(at+8,true),data=at+12+Math.ceil(name/4)*4,next=data+Math.ceil(size/4)*4;
   if(name!==4||next>end||v.getUint32(at+12,true)!==0x00554e47)unsupported('Only bounded GNU ELF notes');
   if(type===3) {if(!size||size>64)unsupported('Unsupported GNU build ID');}
   else if(type===1) {if(size!==16)bad('Invalid GNU ABI tag');}
   else if(type===5) {
    if(!size||size%16)unsupported('Unsupported GNU property span');
    for(let prop=data;prop<data+size;prop+=16) {
     const kind=v.getUint32(prop,true),value=v.getUint32(prop+8,true);
     const length=v.getUint32(prop+4,true),padding=v.getUint32(prop+12,true);
     const baselineUsed=(kind===0xc0010001||kind===0xc0010002)&&!(value&~1);
     if(length!==4||padding!==0||!((kind===0xc0000002&&!(value&~3))||(kind===0xc0008002&&value===1)||baselineUsed))
      unsupported('Unsupported GNU property kind=0x'+kind.toString(16)+' value=0x'+value.toString(16)+' size='+length+' padding=0x'+padding.toString(16)+' fileOffset=0x'+prop.toString(16));
    }
   }else unsupported('Unsupported GNU ELF note');
   at=next;
  }
 }

 function prepare(oldSpace,bytes,args,random,store) {
  if(!(store instanceof I.ExecutableStore))throw new TypeError('Immutable interpreter executable store required');
  if(!ordinary(random)||random.length!==16)throw new TypeError('Owned 16-byte AT_RANDOM required');
  if(!args||!canonical(args.path)||new TextEncoder().encode(args.path).length>=4096||!Array.isArray(args.argv)||!args.argv.length||!Array.isArray(args.envp)||args.argv.length>1024||args.envp.length>1024||
     [...args.argv,...args.envp].some(b=>!ordinary(b)||b.includes(0)||b.length>=4096)||[...args.argv,...args.envp].reduce((n,b)=>n+b.length+1,0)>128*1024)unsupported('Arguments outside declared exec bounds');
  // Both snapshots and every mapping are checked before allocating a new space.
  const main=parse(bytes,false),interpreter=parse(store.readExecutableSnapshot(main.interp),true);
  const limit=oldSpace.stats().virtualLimit,stackBytes=256n*1024n,stackTop=down(limit)-16n*P,stackBase=stackTop-stackBytes;
  const images=[{image:main,bias:main.type===3?0x555500000000n:0n},{image:interpreter,bias:0x7f0000000000n}],ranges=[];let mapped=stackBytes;
  for(const {image,bias}of images)for(const p of image.loads) {
   const start=p.start+bias,end=p.end+bias;
   if(start<0x10000n||end>stackBase-P||end>U64||ranges.some(q=>start<q.end&&end>q.start))unsupported('Linux image overlaps another image or lies outside guest window');
   ranges.push({start,end});mapped+=end-start;
   if(mapped>32n*1024n*1024n)unsupported('Linux image backing exceeds 32 MiB');
  }
  const space=oldSpace.createEmpty(),codes=[];
  try {
   for(const {image,bias}of images)for(const p of image.loads) {
    const start=p.start+bias,end=p.end+bias,prefix=p.va-p.start;
    space.mapAnonymous(start,end-start,3);
    if(p.filesz)space.write(start,image.bytes.slice(Number(p.off-prefix),Number(p.off+p.filesz)));
    space.protect(start,end-start,(p.flags&4?1:0)|(p.flags&2?2:0)|(p.flags&1?4:0));
    if(p.flags&1)codes.push(Object.freeze({address:p.va+bias,bytes:image.bytes.slice(Number(p.off),Number(p.off+p.filesz))}));
   }
   space.mapAnonymous(stackBase,stackBytes,3);let sp=stackTop;
   const string=b=>{sp-=BigInt(b.length+1);const out=new Uint8Array(b.length+1);out.set(b);space.write(sp,out);return sp;};
   const strings=values=>{const ptrs=[];for(let i=values.length-1;i>=0;i--)ptrs[i]=string(values[i]);return ptrs;};
   const execfn=string(new TextEncoder().encode(args.path)),env=strings(args.envp),argv=strings(args.argv);sp=(sp-16n)&~15n;const randomAt=sp;space.write(sp,Uint8Array.from(random));
   const loadBias=images[0].bias,base=images[1].bias,imageEntry=main.entry+loadBias,entry=interpreter.entry+base,phdr=main.phdr+loadBias;
   const auxv=[3n,phdr,4n,56n,5n,BigInt(main.phnum),6n,P,7n,base,8n,0n,9n,imageEntry,23n,0n,25n,randomAt,31n,execfn,0n,0n];
   const values=[BigInt(argv.length),...argv,0n,...env,0n,...auxv];sp=(sp-BigInt(values.length)*8n)&~15n;
   if(sp<stackBase)unsupported('Initial Linux stack exceeds admitted size');
   const table=new Uint8Array(values.length*8),dv=new DataView(table.buffer);values.forEach((n,i)=>dv.setBigUint64(i*8,n,true));space.write(sp,table);
   return Object.freeze({space,entry,imageEntry,loadBias,stackPointer:sp,stackBase,stackTop,phdr,codes:Object.freeze(codes),path:args.path,
    interpreter:Object.freeze({path:main.interp,base,entry}),relocationsApplied:false,tlsInitialized:false,relroSealed:false});
  }catch(error){space.close();throw error;}
 }
 root.BetterJITGuestLinuxImage=Object.freeze({VERSION:1,prepare});
})(typeof globalThis!=='undefined'?globalThis:self);
