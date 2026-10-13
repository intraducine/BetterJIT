// SPDX-License-Identifier: GPL-3.0-or-later
function functionNames(module) {
 const result=[];
 for(const section of WebAssembly.Module.customSections(module,'name')) {
  const b=new Uint8Array(section);let p=0;
  function u32(){let n=0,s=0;for(let i=0;i<5;i++){if(p>=b.length)throw Error('Truncated Wasm name metadata');const c=b[p++];n+=(c&127)*2**s;if(!(c&128))return n;s+=7;}throw Error('Invalid Wasm name integer');}
  while(p<b.length){const id=b[p++],length=u32(),end=p+length;if(end>b.length)throw Error('Truncated Wasm name subsection');
   if(id===1){const n=u32();for(let i=0;i<n;i++){u32();const size=u32();if(p+size>end)throw Error('Truncated Wasm function name');result.push(new TextDecoder().decode(b.subarray(p,p+size)));p+=size;}}
   p=end;
  }
 }
 return result;
}
function unitMetadata(rip,unit) {
 return {rip:'0x'+BigInt(rip).toString(16),slot:unit.slot,
  relocation:{displacementDecimal:String(unit.reloc?.d??0n),slots:unit.reloc?.s??[]}};
}
function diagnosticCapture({maxBytes=64*1024*1024,maxUnits=16384}={}) {
 const crypto=require('crypto'),saved=new Set();
 const stats={bytes:0,units:0,duplicateRequests:0,omittedRequests:0,truncated:false,maxBytes,maxUnits};
 return {
  keep(space,rip,unit) {
   const metadata=unitMetadata(rip,unit);
   const hash=crypto.createHash('sha256').update(unit.code).update(JSON.stringify(metadata)).digest('hex');
   const stem=`space-${space}-rip-${rip.toString(16)}-unit-${hash}`;
   if(saved.has(stem)){stats.duplicateRequests++;return null;}
   // This is a bound on retained diagnostics, not a guest memory/execution limit.
   if(saved.size>=maxUnits||unit.code.length>maxBytes-stats.bytes) {
    stats.omittedRequests++;stats.truncated=true;return null;
   }
   saved.add(stem);stats.bytes+=unit.code.length;stats.units++;
   return {stem,metadata};
  },
  statistics(){return {...stats};}
 };
}
module.exports={functionNames,unitMetadata,diagnosticCapture};
