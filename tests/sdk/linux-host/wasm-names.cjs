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
module.exports={functionNames};
