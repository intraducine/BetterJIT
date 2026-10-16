// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic ELF layout controls; these bytes are not a Wine compatibility test.
const INTERP='/lib/ld-test.so',MAIN=0x555500000000n,BASE=0x7f0000000000n;
function image({interpreter=false,type=3,calls=false}={}) {
 const bytes=new Uint8Array(0x3200),v=new DataView(bytes.buffer),headers=[];
 const ph=(type,flags,off,va,filesz,memsz=filesz,align=4096n)=>headers.push({type,flags,off,va,filesz,memsz,align});
 bytes.set([127,69,76,70,2,1,1]);v.setUint16(16,type,true);v.setUint16(18,62,true);v.setUint32(20,1,true);
 v.setBigUint64(24,0x1000n,true);v.setBigUint64(32,64n,true);v.setUint16(52,64,true);v.setUint16(54,56,true);
 if(!interpreter){const b=new TextEncoder().encode(INTERP+'\0');bytes.set(b,0x380);ph(3,4,0x380n,0x380n,BigInt(b.length),BigInt(b.length),1n);}
 ph(1,4,0n,0n,4096n);ph(1,5,0x1000n,0x1000n,0x100n,0x1000n);
 // The RW load starts inside its page and has a distinct BSS tail.
 ph(1,6,0x2180n,0x3180n,0x80n,0x1080n);ph(2,6,0x21a0n,0x31a0n,0x20n,0x20n,8n);
 ph(0x6474e552,4,0x2180n,0x3180n,0x80n,0x80n,1n);ph(0x6474e551,6,0n,0n,0n,0n,16n);
 // Same first two instructions as the musl entry, followed by unsupported UD2.
 bytes.set([0x48,0x89,0xe7,0x48,0x8d,0x35,0,0,0,0,0x0f,0x0b],0x1000);bytes.fill(0x5a,0x2000,0x2180);bytes.fill(0x6b,0x2180,0x2200);
 // Optional nested-call control, explicitly synthetic. Both returns restore
 // the original stack before the same expected unsupported UD2 boundary.
 if(calls){bytes.set([0xe8,0x11,0,0,0,0x0f,0x0b],0x100a);bytes.set([0xe8,0x0b,0,0,0,0xc3],0x1020);bytes[0x1030]=0xc3;}
 v.setUint16(56,headers.length,true);
 headers.forEach((p,i)=>{const at=64+i*56;v.setUint32(at,p.type,true);v.setUint32(at+4,p.flags,true);for(const [off,key]of [[8,'off'],[16,'va'],[32,'filesz'],[40,'memsz'],[48,'align']])v.setBigUint64(at+off,p[key],true);});
 return bytes;
}
module.exports={image,INTERP,MAIN,BASE};
