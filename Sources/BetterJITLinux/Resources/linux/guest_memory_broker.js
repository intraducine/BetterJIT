// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental reference authority. Not loaded by the default Linux runtime.
(function(root) {
  'use strict';
  const storage=root.BetterJITGuestMemory;
  if(!storage||storage.STORAGE_VERSION!==1)throw new Error('Guest storage contract 1 required');
  const ABI=Object.freeze({version:1,checkpointVersion:1,stepVersion:4,coverageVersion:26,stepHeaderBytes:96,
    magic:0x314d4a42,internalPages:33,threadBase:0x10000,threadBytes:0x200000,
    scratchOffset:0x1f0000,scratchBytes:128,memoryRequest:0x10003,instructionBoundary:0x10004,maximumThreads:8,parkedState:4,
    userCopyBytes:65536});
  const FIELD=Object.freeze({magic:0,version:4,sequence:8,status:12,operation:16,width:20,access:24,reason:28,
    address:32,rip:40,checkpoint:48,operand0:56,operand1:64,result0:72,result1:80,faultAddress:88,
    checkpointRip:96,nextRip:104,completedSequence:112,boundaryControl:116,lease:120});
  const STATUS=Object.freeze({OK:0,FAULT:1,UNSUPPORTED:2});
  const OP=Object.freeze({READ:1,WRITE:2,CAS:3,FETCH_ADD:4,SYSCALL:5,FLAGS:6,BRANCH:7,READ_FLAGS:8,CALL:9,RETURN:10,ADD_MEMORY:11,JUMP_REGISTER:12,PUSH_REGISTER:13,POP_REGISTER:14,ADD_REGISTER_MEMORY:15,OR_MEMORY:16,DIV_REGISTER:17,SUB_REGISTER_MEMORY:18});
  const STEP=Object.freeze({OK:0,FAULT:1,UNSUPPORTED:2,SYSCALL:3,DIVIDE_ERROR:5});
  // Host startup gate / spilled syscall completion, separate from native step exits.
  const LIFECYCLE=Object.freeze({version:1,PENDING:0,READY:1,RUN:2,CANCEL:3,FAILED:4,syscallExit:4});
  const REASON=Object.freeze({NONE:0,RANGE:1,UNMAPPED:2,PROTECTION:3,ALIGNMENT:4,ALLOCATION:5,
    OPCODE:16,WIDTH:17,PROTOCOL:18,CHECKPOINT:19,STALE_LEASE:20,SEQUENCE:21,ACCESS:22,ADDRESS_DOMAIN:23,CONTROL_TARGET:24});
  const memories=new WeakSet(),registeredMemories=new WeakSet(),owners=new WeakMap(),brokers=new WeakMap(),waits=new WeakMap();
  const U64=1n<<64n;
  function u64(value) {
    if(typeof value!=='bigint'||value<-(1n<<63n)||value>=U64)throw new TypeError('Exact i64 BigInt required');
    return BigInt.asUintN(64,value);
  }
  function jumpSourceRegister(p) {
    const b=p.instruction,i=b?.length===3&&b[0]>=0x40&&b[0]<=0x4f?1:0;
    if(!(b instanceof Uint8Array)||b.length!==i+2||b[i]!==0xff||(b[i+1]&0xf8)!==0xe0||
       p.operation!==OP.JUMP_REGISTER||p.width!==0||p.continuationKind!==5||p.branchTarget!==0n||
       !canonical(p.rip)||p.nextRip!==p.rip+BigInt(b.length)||!canonical(p.nextRip))throw new TypeError('Invalid register jump metadata');
    return (b[i+1]&7)+(i&&(b[0]&1)?8:0);
  }
  function callSourceRegister(p) {
    const b=p.instruction,i=b?.length===3&&b[0]>=0x40&&b[0]<=0x4f?1:0;
    if(!(b instanceof Uint8Array)||b.length!==i+2||b[i]!==0xff||(b[i+1]&0xf8)!==0xd0||
       p.operation!==OP.CALL||p.width!==8||p.continuationKind!==6||p.branchTarget!==0n||
       !canonical(p.rip)||p.nextRip!==p.rip+BigInt(b.length)||!canonical(p.nextRip))throw new TypeError('Invalid register call metadata');
    return (b[i+1]&7)+(i&&(b[0]&1)?8:0);
  }
  function instructionContinuations(p) {
    const kind=p.continuationKind??0,target=p.branchTarget??0n;
    if(p.operation===OP.JUMP_REGISTER){jumpSourceRegister(p);return Object.freeze([]);}
    if(p.operation===OP.PUSH_REGISTER||p.operation===OP.POP_REGISTER){stackRegister(p);return Object.freeze([p.nextRip]);}
    if(p.operation===OP.ADD_REGISTER_MEMORY){addMemoryOperand(p);return Object.freeze([p.nextRip]);}
    if(p.operation===OP.SUB_REGISTER_MEMORY){subMemoryOperand(p);return Object.freeze([p.nextRip]);}
    if(p.operation===OP.OR_MEMORY){orMemoryOperand(p);return Object.freeze([p.nextRip]);}
    if(p.operation===OP.DIV_REGISTER){divisionOperand(p);return Object.freeze([p.nextRip]);}
    if(p.operation===OP.READ_FLAGS&&p.width===2){wordCompareOperand(p);return Object.freeze([p.nextRip]);}
    if(p.operation===OP.CALL) {
      if(kind===6){callSourceRegister(p);return Object.freeze([]);}
      const b=p.instruction;
      if(b.length!==5||b[0]!==0xe8||kind!==3||p.width!==8)throw new TypeError('Invalid direct call metadata');
      const next=p.rip+5n,expected=next+BigInt(new DataView(b.buffer,b.byteOffset,b.byteLength).getInt32(1,true));
      if(!canonical(p.rip)||p.nextRip!==next||!canonical(next)||!canonical(expected)||target!==expected)throw new TypeError('Invalid direct call target');
      return Object.freeze([target]);
    }
    if(p.operation===OP.RETURN) {
      if(p.instruction.length!==1||p.instruction[0]!==0xc3||kind!==4||target!==0n||p.width!==8||
         !canonical(p.rip)||p.nextRip!==p.rip+1n||!canonical(p.nextRip))throw new TypeError('Invalid checked return metadata');
      return Object.freeze([]); // resolved only from the broker-owned checked stack read
    }
    if(p.operation!==OP.BRANCH) {
      if(kind!==0||target!==0n)throw new TypeError('Unexpected branch metadata');
      return Object.freeze([p.nextRip]);
    }
    const b=p.instruction,v=new DataView(b.buffer,b.byteOffset,b.byteLength);let flow,offset;
    if(b.length===2&&((b[0]>=0x70&&b[0]<=0x7f)||b[0]===0xeb)){flow=b[0]===0xeb?1:2;offset=BigInt(v.getInt8(1));}
    else if(b.length===5&&b[0]===0xe9){flow=1;offset=BigInt(v.getInt32(1,true));}
    else if(b.length===6&&b[0]===0x0f&&b[1]>=0x80&&b[1]<=0x8f){flow=2;offset=BigInt(v.getInt32(2,true));}
    else throw new TypeError('Uncovered branch instruction');
    if(!canonical(p.rip)||!canonical(p.nextRip)||p.nextRip!==p.rip+BigInt(b.length)||!canonical(target)||kind!==flow||typeof target!=='bigint'||target!==p.nextRip+offset)throw new TypeError('Invalid branch continuation');
    return Object.freeze(kind===1?[target]:[p.nextRip,target]);
  }
  function wordCompareOperand(p) {
    const b=p.instruction;let i=0,rex=0;
    const fail=()=>{throw new TypeError('Invalid word CMP metadata');};
    if(!(b instanceof Uint8Array)||b[i++]!==0x66)fail();
    if(b[i]>=0x40&&b[i]<=0x47)rex=b[i++];
    const opcode=b[i++],imm=opcode===0x81||opcode===0x83||opcode===0x3d;
    if(![0x81,0x83,0x39,0x3b,0x3d].includes(opcode))fail();
    let kind=4,leftRegister=0,rightRegister=16,base=-1,index=-1,scale=1,displacement=0n,ripRelative=false,bytes=0;
    if(opcode!==0x3d){
      if(i>=b.length)fail();const m=b[i++],mod=m>>6,rm=m&7,r=(m>>3&7)+((rex&4)?8:0),operand=rm+((rex&1)?8:0);
      if(imm&&(m&0x38)!==0x38)fail();
      if(mod===3){kind=imm?4:3;leftRegister=imm||opcode===0x39?operand:r;rightRegister=imm?16:opcode===0x39?r:operand;}
      else{
        kind=imm?0:opcode===0x39?1:2;leftRegister=kind===2?r:16;rightRegister=kind===1?r:16;
        bytes=mod===1?1:mod===2?4:0;
        if(rm===4){if(i>=b.length)fail();const sib=b[i++],lowBase=sib&7,lowIndex=sib>>3&7;scale=1<<(sib>>6);
          if(lowIndex!==4||(rex&2))index=lowIndex+((rex&2)?8:0);
          if(mod===0&&lowBase===5){if(rex&1)fail();bytes=4;}else base=lowBase+((rex&1)?8:0);
        }else if(mod===0&&rm===5){ripRelative=true;bytes=4;}else base=operand;
      }
    }
    const immediateBytes=imm?(opcode===0x83?1:2):0;if(i+bytes+immediateBytes!==b.length)fail();
    const v=new DataView(b.buffer,b.byteOffset,b.byteLength);
    if(bytes===1)displacement=BigInt(v.getInt8(i));if(bytes===4)displacement=BigInt(v.getInt32(i,true));i+=bytes;
    const immediate=imm?(opcode===0x83?v.getInt8(i)&65535:v.getUint16(i,true)):0;
    if(p.operation!==(kind<3?OP.READ_FLAGS:OP.FLAGS)||p.width!==(kind<3?2:0)||p.continuationKind!==0||p.branchTarget!==0n||
       !canonical(p.rip)||p.nextRip!==p.rip+BigInt(b.length)||!canonical(p.nextRip)||p.length!==b.length)fail();
    return Object.freeze({kind,leftRegister,rightRegister,base,index,scale,displacement,ripRelative,immediate,length:b.length});
  }
  function wordLogicalOperand(p) {
    const b=p.instruction;let i=0,rex=0;const fail=()=>{throw new TypeError('Invalid word logical metadata');};
    if(!(b instanceof Uint8Array)||b[i++]!==0x66)fail();if(b[i]>=0x40&&b[i]<=0x47)rex=b[i++];
    const opcode=b[i++];let register=0,kind=opcode===0x0d?1:opcode===0x25?4:opcode===0x35?6:0;
    if(!kind){if(![0x81,0x83].includes(opcode)||i>=b.length)fail();const m=b[i++];if(m<0xc0)fail();kind=m>>3&7;register=(m&7)+((rex&1)?8:0);}
    if(![1,4,6].includes(kind)||i+(opcode===0x83?1:2)!==b.length)fail();
    const v=new DataView(b.buffer,b.byteOffset,b.byteLength),mask=opcode===0x83?v.getInt8(i)&65535:v.getUint16(i,true);
    if(p.operation!==OP.FLAGS||p.width!==0||p.continuationKind!==0||p.branchTarget!==0n||p.length!==b.length||
       !canonical(p.rip)||!canonical(p.nextRip)||p.nextRip!==p.rip+BigInt(b.length))fail();
    return Object.freeze({register,kind,mask,length:b.length});
  }
  function conditionOperand(p) {
    const b=p.instruction;let i=0,rex=0;const fail=()=>{throw new TypeError('Invalid scalar condition metadata');};
    if(!(b instanceof Uint8Array))fail();
    if(p.operation===OP.BRANCH&&p.continuationKind===2){
      if(p.width!==0||p.length!==b.length||!canonical(p.rip)||!canonical(p.nextRip)||p.nextRip!==p.rip+BigInt(b.length))fail();
      instructionContinuations(p);
      if(b.length===2&&b[0]>=0x70&&b[0]<=0x7f)return Object.freeze({code:b[0]&15,width:0,register:16,source:16,length:b.length});
      if(b.length===6&&b[0]===0x0f&&b[1]>=0x80&&b[1]<=0x8f)return Object.freeze({code:b[1]&15,width:0,register:16,source:16,length:b.length});
      fail();
    }
    if(b[i]>=0x40&&b[i]<=0x4f)rex=b[i++];
    if(b.length!==i+3||b[i++]!==0x0f||b[i]<0x40||b[i]>0x4f)fail();const code=b[i++]&15,m=b[i];
    if(m<0xc0||p.operation!==OP.FLAGS||p.width!==0||p.continuationKind!==0||p.branchTarget!==0n||p.length!==b.length||
       !canonical(p.rip)||!canonical(p.nextRip)||p.nextRip!==p.rip+BigInt(b.length))fail();
    return Object.freeze({code,width:rex&8?8:4,register:(m>>3&7)+((rex&4)?8:0),source:(m&7)+((rex&1)?8:0),length:b.length});
  }
  // Derive the optional register-only profiles from independently checked bytes.
  function scalarOperands(p) {
    const b=p.instruction;if(p.operation===OP.READ_FLAGS&&p.width===2)return {wordCompareOperand:wordCompareOperand(p)};
    if(p.operation===OP.BRANCH&&p.continuationKind===2)return {conditionOperand:conditionOperand(p)};
    if(p.operation!==OP.FLAGS)return {};
    if(b[0]===0x66){const i=b[1]>=0x40&&b[1]<=0x47?2:1,op=b[i],group=b[i+1]>>3&7;
      if([0x39,0x3b,0x3d].includes(op)||[0x81,0x83].includes(op)&&group===7)return {wordCompareOperand:wordCompareOperand(p)};
      if([0x0d,0x25,0x35].includes(op)||[0x81,0x83].includes(op)&&[1,4,6].includes(group))return {wordLogicalOperand:wordLogicalOperand(p)};
    }
    const i=b[0]>=0x40&&b[0]<=0x4f?1:0;
    if(b[i]===0x0f&&b[i+1]>=0x40&&b[i+1]<=0x4f)return {conditionOperand:conditionOperand(p)};
    return {};
  }
  function divisionOperand(p) {
    const b=p.instruction,i=b?.length===3&&b[0]>=0x40&&b[0]<=0x4f?1:0,rex=i?b[0]:0;
    if(!(b instanceof Uint8Array)||b.length!==i+2||b[i]!==0xf7||(b[i+1]&0xf8)!==0xf0||
       p.operation!==OP.DIV_REGISTER||p.width!==((rex&8)?8:4)||p.continuationKind!==0||p.branchTarget!==0n||
       !canonical(p.rip)||p.nextRip!==p.rip+BigInt(b.length)||!canonical(p.nextRip))throw new TypeError('Invalid register DIV metadata');
    return Object.freeze({register:(b[i+1]&7)+((rex&1)?8:0),length:b.length});
  }
  function addMemoryOperand(p) {
    return memoryArithmeticOperand(p,OP.ADD_REGISTER_MEMORY,0x03,'register memory ADD');
  }
  function subMemoryOperand(p) {
    return memoryArithmeticOperand(p,OP.SUB_REGISTER_MEMORY,0x2b,'register memory SUB');
  }
  // Restricted counterpart of backend.cpp MaterializeFlags/EmitNZCVOfKind.
  // The family gate below also binds kind/width, operands and stored NZCV.
  function materializeArithmeticNZCV(kind,a,b,stored) {
    if(![0,1,2,19,20].includes(kind))throw new TypeError('Unknown arithmetic lazy flag kind');
    if(kind===0)return stored>>>0;
    const width=kind===1||kind===19?32:64,sub=kind===1||kind===2;
    a=BigInt.asUintN(width,a);b=BigInt.asUintN(width,b);
    const r=BigInt.asUintN(width,sub?a-b:a+b),sign=BigInt(width-1),
      carry=sub?a>=b:r<a,overflow=sub?((a^b)&(a^r))>>sign:((a^r)&(b^r))>>sign;
    const nzcv=((Number(r>>sign)<<31)|(Number(r===0n)<<30)|(Number(carry)<<29)|(Number(overflow)<<28))>>>0;
    return (sub?nzcv:nzcv^0x20000000)>>>0;
  }
  // Scalar counterpart of EmitNZCVOfKind. Float descriptors are outside this
  // admitted instruction set. Keep-carry kinds consume only the owned C bit.
  function materializeScalarNZCV(kind,a,b,stored) {
    if(kind===0)return stored>>>0;
    const inverted=!!(kind&16),base=kind&~16;
    if(!Number.isInteger(kind)||kind<0||base<1||base>10)throw new TypeError('Unknown scalar lazy flag kind');
    const kept=base>=7,k=kept?base-6:base,width=k===1||k===3||k===5?32:64,mask=(1n<<BigInt(width))-1n;
    if(a<0n||a>mask||b<0n||b>=U64||(k!==5&&k!==6&&b>mask))throw new TypeError('Invalid scalar lazy operands');
    const sub=k===1||k===2,logic=k===5||k===6,r=logic?a:BigInt.asUintN(width,sub?a-b:a+b),sign=BigInt(width-1),
      carry=logic?false:sub?a>=b:r<a,overflow=logic?0n:(sub?(a^b)&(a^r):(a^r)&(b^r))>>sign;
    let nzcv=((Number(r>>sign)<<31)|(Number(r===0n)<<30)|(Number(carry)<<29)|(Number(overflow&1n)<<28))>>>0;
    if(kept)nzcv=((nzcv&~0x20000000)|(stored&0x20000000))>>>0;
    return (inverted?nzcv^0x20000000:nzcv)>>>0;
  }
  function conditionHolds(code,nzcv,pf) {
    if(!Number.isInteger(code)||code<0||code>=16)throw new TypeError('Invalid scalar condition');
    const c=!(nzcv&0x20000000),z=!!(nzcv&0x40000000),s=!!(nzcv&0x80000000),o=!!(nzcv&0x10000000),p=!!parity(pf&255);
    return [o,!o,c,!c,z,!z,c||z,!c&&!z,s,!s,p,!p,s!==o,s===o,z||s!==o,!z&&s===o][code];
  }
  function validateScalarPostState(s,a,nextRip) {
    const f=s.layout.arithmeticFlags,c=a.wordComparison,l=a.wordLogical,d=a.scalarCondition;
    let left,right,result,expectedRip=a.nextRip;
    if(c){left=c.kind===0||c.kind===1?a.result.data:c.left;right=c.kind===2?a.result.data:c.kind===0||c.kind===4?BigInt(c.immediate):c.right;}
    if(l){const mask=BigInt(l.mask),low=l.input&65535n;result=(l.input&~65535n)|(l.kind===1?low|mask:l.kind===4?low&mask:low^mask);}
    if(d)expectedRip=d.width===0?(d.taken?a.continuations[1]:a.nextRip):a.nextRip;
    if(nextRip!==expectedRip)invariant(s,'Scalar instruction changed its owned continuation');
    for(const p of a.snapshot){
      const expected=p.bytes.slice(),v=new DataView(expected.buffer),actual=new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,expected.length);
      if(p.offset===s.layout.spans[0].offset){
        v.setBigUint64(s.layout.ripAddress-ABI.threadBase-p.offset,expectedRip,true);
        if(c){v.setUint32(f.parityRawOffset,Number(BigInt.asUintN(32,left-right)),true);
          const aux=c.kind===0||c.kind===4?(c.immediate&16?~left:left):left^right;
          v.setUint32(f.auxiliaryRawOffset,Number(BigInt.asUintN(32,aux)),true);}
        if(l){v.setBigUint64(s.layout.generalRegistersOffset+l.register*8,result,true);v.setUint32(f.parityRawOffset,Number(result&0xffffffffn),true);}
        if(d){
          if(d.width)v.setBigUint64(s.layout.generalRegistersOffset+d.register*8,BigInt.asUintN(d.width*8,d.taken?d.value:d.destination),true);
          if(d.width||![10,11].includes(d.code))v.setUint32(f.nzcvOffset,d.nzcv,true);
        }
      }else if(p.offset===s.layout.spans[1].offset){
        if(c){v.setUint32(0,1,true);v.setBigUint64(8,(left&65535n)<<16n,true);v.setBigUint64(16,(right&65535n)<<16n,true);}
        if(l){v.setUint32(0,21,true);v.setBigUint64(8,(result&65535n)<<16n,true);}
        if(d&&(d.width||![10,11].includes(d.code))){v.setUint32(0,0,true);
          if(d.width&&[10,11].includes(d.code))v.setBigUint64(8,BigInt(d.code===10?parity(d.pf&255):parity(d.pf&255)^1),true);
        }
      }
      if(!actual.every((n,i)=>n===expected[i]))invariant(s,'Scalar instruction changed unexpected checkpoint state');
    }
  }
  function parity(byte){let odd=0;for(;byte;byte>>>=1)odd^=byte&1;return odd^1;}
  // Expected flags come only from owned inputs, using signed overflow bounds
  // and nibble carry/borrow independently of the materializer's bit formulas.
  function ownedArithmeticFlags(sub,width,a,b,result) {
    const bits=width*8,sign=1n<<BigInt(bits-1),mask=(sign<<1n)-1n,
      signed=n=>n&sign?n-(mask+1n):n,total=sub?signed(a)-signed(b):signed(a)+signed(b),
      carry=sub?a<b:a+b>mask,aux=sub?(a&15n)<(b&15n):(a&15n)+(b&15n)>15n;
    return Number(carry)|(parity(Number(result&255n))<<2)|(Number(aux)<<4)|
      (Number(result===0n)<<6)|(Number(!!(result&sign))<<7)|(Number(total < -sign||total>=sign)<<11);
  }
  function validateArithmeticFlags(s,a,result) {
    const sub=a.operation===OP.SUB_REGISTER_MEMORY,bits=a.width*8,flags=s.layout.arithmeticFlags,
      old=a.memoryArithmetic.destinationValue,x=BigInt.asUintN(bits,old),y=BigInt.asUintN(bits,a.result.data),
      cpu=ABI.threadBase+s.layout.spans[0].offset,lazy=ABI.threadBase+s.layout.spans[1].offset,
      kind=s.view.getUint32(lazy,true),fa=s.view.getBigUint64(lazy+8,true),fb=s.view.getBigUint64(lazy+16,true),
      expectedKind=sub?(a.width===4?1:2):(a.width===4?19:20),stored=s.view.getUint32(cpu+flags.nzcvOffset,true);
    if((kind!==0&&kind!==expectedKind)||fa!==x||fb!==y)invariant(s,'Register memory arithmetic changed lazy flag operands/kind');
    const expected=ownedArithmeticFlags(sub,a.width,x,y,result),nzcv=materializeArithmeticNZCV(kind,fa,fb,stored),
      pf=s.view.getUint32(cpu+flags.parityRawOffset,true),af=s.view.getUint32(cpu+flags.auxiliaryRawOffset,true),
      observed=(((nzcv>>>29)^1)&1)|(parity(pf&255)<<2)|((af^pf)&16)|
        (((nzcv>>>30)&1)<<6)|(((nzcv>>>31)&1)<<7)|(((nzcv>>>28)&1)<<11);
    const canonical=((Number(!!(expected&128))<<31)|(Number(!!(expected&64))<<30)|
      (Number(!(expected&1))<<29)|(Number(!!(expected&2048))<<28))>>>0,
      before=new DataView(a.snapshot[0].bytes.buffer).getUint32(flags.nzcvOffset,true);
    if(observed!==expected||(kind===0?stored!==canonical:stored!==before))invariant(s,'Register memory arithmetic changed final flags/NZCV');
  }
  function orMemoryOperand(p) {
    return memoryArithmeticOperand(p,OP.OR_MEMORY,0x09,'OR memory');
  }
  function memoryArithmeticOperand(p,operation,opcode,label) {
    const b=p.instruction;let i=0,rex=0;
    const fail=()=>{throw new TypeError('Invalid '+label+' metadata');};
    if(!(b instanceof Uint8Array)||b.length<2)fail();
    if(b[i]>=0x40&&b[i]<=0x4f)rex=b[i++];
    if(b[i++]!==opcode||i>=b.length)fail();
    const m=b[i++],mod=m>>6,rm=m&7;let base=-1,index=-1,scale=1,displacement=0n,ripRelative=false,bytes=mod===1?1:mod===2?4:0;
    if(mod===3)fail();
    if(rm===4){if(i>=b.length)fail();const sib=b[i++],lowBase=sib&7,lowIndex=sib>>3&7;scale=1<<(sib>>6);
      if(lowIndex!==4||(rex&2))index=lowIndex+((rex&2)?8:0);
      if(mod===0&&lowBase===5){if(rex&1)fail();bytes=4;}else base=lowBase+((rex&1)?8:0);
    }else if(mod===0&&rm===5){ripRelative=true;bytes=4;}else base=rm+((rex&1)?8:0);
    if(i+bytes!==b.length)fail();
    if(bytes===1)displacement=BigInt((b[i]<<24)>>24);
    if(bytes===4)displacement=BigInt(new DataView(b.buffer,b.byteOffset+i,4).getInt32(0,true));
    if(p.operation!==operation||p.width!==((rex&8)?8:4)||p.continuationKind!==0||p.branchTarget!==0n||
       !canonical(p.rip)||p.nextRip!==p.rip+BigInt(b.length)||!canonical(p.nextRip))fail();
    return Object.freeze({register:(m>>3&7)+((rex&4)?8:0),base,index,scale,displacement,ripRelative,length:b.length});
  }
  function stackRegister(p) {
    const b=p.instruction,i=b?.length===2&&b[0]>=0x40&&b[0]<=0x4f?1:0;
    if(!(b instanceof Uint8Array)||b.length!==i+1||
       ![OP.PUSH_REGISTER,OP.POP_REGISTER].includes(p.operation)||(b[i]&0xf8)!==(p.operation===OP.PUSH_REGISTER?0x50:0x58)||
       p.width!==8||p.continuationKind!==0||p.branchTarget!==0n||!canonical(p.rip)||p.nextRip!==p.rip+BigInt(b.length)||!canonical(p.nextRip))
      throw new TypeError('Invalid register stack metadata');
    return (b[i]&7)+(i&&(b[0]&1)?8:0);
  }
  function parseStepHeader(bytes) {
    if(!(bytes instanceof Uint8Array)||bytes.length!==ABI.stepHeaderBytes)throw new Error('Broker step header required');
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(v.getUint32(0,true)!==0x31534a42||v.getUint32(4,true)!==ABI.version||
       v.getUint32(8,true)!==ABI.checkpointVersion||v.getUint32(12,true)!==ABI.stepVersion||
       v.getUint32(16,true)!==ABI.coverageVersion)throw new Error('Incompatible broker step ABI');
    const status=v.getUint32(20,true),operation=v.getUint32(24,true),width=v.getUint32(28,true),
      rip=v.getBigUint64(32,true),nextRip=v.getBigUint64(40,true),size=v.getUint32(56,true),length=v.getUint32(60,true);
    if(![0,2].includes(status)||
       (status===2&&(size||length))||(status===0&&(!size||length<1||length>15||nextRip!==rip+BigInt(length)||
         !(([0,5,6,7,12].includes(operation)&&width===0)||([1,2,8].includes(operation)&&[1,2,4,8].includes(width))||
           ([3,4,11,15,16,17,18].includes(operation)&&[4,8].includes(width))||([9,10,13,14].includes(operation)&&width===8)))))
      throw new Error('Invalid broker step metadata');
    if(v.getUint32(92,true)!==0)throw new Error('Invalid broker step reserved field');
    const result={status,operation,width,rip,nextRip,length,hash:v.getBigUint64(48,true),
      continuationKind:v.getUint32(88,true),branchTarget:v.getBigUint64(80,true),
      instruction:bytes.slice(64,64+length),codeBytes:size};
    if(status===0)try{result.continuations=instructionContinuations(result);if(operation===OP.JUMP_REGISTER)result.sourceRegister=jumpSourceRegister(result);if(operation===OP.CALL&&result.continuationKind===6)result.sourceRegister=callSourceRegister(result);if([OP.PUSH_REGISTER,OP.POP_REGISTER].includes(operation))result.stackRegister=stackRegister(result);if(operation===OP.ADD_REGISTER_MEMORY)result.addMemoryOperand=addMemoryOperand(result);if(operation===OP.SUB_REGISTER_MEMORY)result.subMemoryOperand=subMemoryOperand(result);if(operation===OP.OR_MEMORY)result.orMemoryOperand=orMemoryOperand(result);if(operation===OP.DIV_REGISTER)result.divisionOperand=divisionOperand(result);Object.assign(result,scalarOperands(result));}catch(error){throw new Error('Invalid broker continuation metadata: '+error.message);}
    return result;
  }

  function createInternalMemory() {
    const memory=new WebAssembly.Memory({initial:ABI.internalPages,maximum:ABI.internalPages,shared:true});
    memories.add(memory);return memory;
  }
  function canonical(value){return typeof value==='bigint'&&value>=0n&&value<(1n<<47n);}
  class BrokerInvariantError extends Error {
    constructor(message){super(message);this.name='BrokerInvariantError';}
  }
  class UserCopyUnsupported extends Error {
    constructor(){super('User copy exceeds the bounded transfer limit');this.name='UserCopyUnsupported';}
  }
  function copyLength(length) {
    if(typeof length==='number') {
      if(!Number.isSafeInteger(length))throw new TypeError('Exact user copy length required');
      length=BigInt(length);
    }
    if(typeof length!=='bigint'||length<0n)throw new TypeError('Nonnegative user copy length required');
    if(length>BigInt(ABI.userCopyBytes))throw new UserCopyUnsupported();
    return Number(length);
  }
  function invariant(s,message) {s.poisoned=true;throw new BrokerInvariantError(message);}
  function current(broker,token) {
    const s=owners.get(token),b=brokers.get(broker);
    return s&&s.broker===broker&&b.slots.get(s.slot)===s&&!s.closed?s:null;
  }
  function requireOwner(broker,token) {
    const s=current(broker,token);
    if(!s)throw new BrokerInvariantError('Retired or foreign thread registration');
    if(s.poisoned)throw new BrokerInvariantError('Thread registration failed an invariant');
    return s;
  }
  function userOwner(broker,token,prepared=false) {
    const s=requireOwner(broker,token);
    if(!s.spilledSyscall||s.active||s.waits.size)throw new BrokerInvariantError('User copy requires a runnable spilled syscall boundary');
    if(!prepared&&s.preparedCopies.size)throw new BrokerInvariantError('Prepared copyout must complete first');
    return s;
  }
  function layoutFor(layout) {
    if(!layout||layout.version!==ABI.checkpointVersion)throw new TypeError('Checkpoint layout version 1 required');
    const spans=['cpu','lazyFlags','roundMode'].map(name=>{
      const p=layout[name];
      if(!p||!Number.isSafeInteger(p.offset)||!Number.isSafeInteger(p.size)||p.offset<0||p.size<=0||
         p.offset+p.size>ABI.threadBytes)throw new TypeError('Invalid checkpoint span');
      return Object.freeze({name,offset:p.offset,size:p.size});
    });
    if(spans[1].size!==24||spans[2].size!==4||!Number.isSafeInteger(layout.cpu.ripOffset)||
       layout.cpu.ripOffset<0||layout.cpu.ripOffset+8>spans[0].size)throw new TypeError('Invalid architectural checkpoint');
    const all=[...spans,{offset:ABI.scratchOffset,size:ABI.scratchBytes}].sort((a,b)=>a.offset-b.offset);
    for(let i=1;i<all.length;i++)if(all[i-1].offset+all[i-1].size>all[i].offset)
      throw new TypeError('Checkpoint and scratch spans must be disjoint');
    const sp=layout.cpu.stackPointerOffset;
    if(sp!==undefined&&(!Number.isSafeInteger(sp)||sp<0||sp%8||sp+8>layout.cpu.size||
       (sp<layout.cpu.ripOffset+8&&sp+8>layout.cpu.ripOffset)))throw new TypeError('Invalid stack pointer checkpoint offset');
    const gp=layout.cpu.generalRegistersOffset;
    if(gp!==undefined&&(!Number.isSafeInteger(gp)||gp<0||gp%8||gp+16*8>layout.cpu.size||
       (gp<layout.cpu.ripOffset+8&&gp+16*8>layout.cpu.ripOffset)))throw new TypeError('Invalid general registers checkpoint offset');
    const flagNames=['parityRawOffset','auxiliaryRawOffset','nzcvOffset'];let arithmeticFlags;
    if(flagNames.some(n=>layout.cpu[n]!==undefined)) {
      const protectedRanges=[[layout.cpu.ripOffset,8],...(gp===undefined?[]:[[gp,128]]),...(sp===undefined?[]:[[sp,8]])];
      const offsets=flagNames.map(n=>layout.cpu[n]);
      for(let i=0;i<offsets.length;i++){const a=offsets[i];if(!Number.isSafeInteger(a)||a<0||a%4||a+4>layout.cpu.size||
        protectedRanges.some(([b,n])=>a<b+n&&a+4>b)||offsets.slice(0,i).some(b=>a<b+4&&a+4>b))throw new TypeError('Invalid arithmetic flag checkpoint offsets');}
      arithmeticFlags=Object.freeze(Object.fromEntries(flagNames.map((n,i)=>[n,offsets[i]])));
    }
    return {spans,generalRegistersOffset:gp,arithmeticFlags,ripAddress:ABI.threadBase+spans[0].offset+layout.cpu.ripOffset,
      stackAddress:sp===undefined?undefined:ABI.threadBase+spans[0].offset+sp};
  }
  function cpuRip(s){return s.view.getBigUint64(s.layout.ripAddress,true);}
  function restore(s,snapshot=s.active.snapshot) {
    for(const p of snapshot)new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,p.bytes.length).set(p.bytes);
  }
  function response(s,sequence,status,reason=REASON.NONE,data=0n,faultAddress=0n) {
    const v=s.scratch;
    v.setUint32(FIELD.status,status,true);v.setUint32(FIELD.reason,reason,true);
    v.setBigUint64(FIELD.result0,data,true);v.setBigUint64(FIELD.result1,0n,true);
    v.setBigUint64(FIELD.faultAddress,faultAddress,true);
    v.setBigUint64(FIELD.checkpointRip,s.active?.rip??0n,true);
    v.setBigUint64(FIELD.nextRip,0n,true);v.setUint32(FIELD.boundaryControl,0,true);
    // The transport publishes S_DONE only after this method returns.
    v.setUint32(FIELD.completedSequence,sequence,true);
    const result=Object.freeze({status,reason,data,faultAddress,rip:s.active?.rip??0n});
    if(s.active)s.active.result=result;
    const b=brokers.get(s.broker);b[status===STATUS.OK?'ok':status===STATUS.FAULT?'faults':'unsupported']++;
    return Object.freeze({accepted:true,...result});
  }
  function futexKey(identity) {
    return identity.kind==='private'?'p:'+identity.spaceId+':'+identity.guestAddress.toString(16):
      's:'+identity.objectId+':'+identity.page+':'+identity.byteOffset;
  }
  function finishWait(b,rec,result,notify,deferred) {
    if(rec.done)return false;
    rec.done=true;const q=b.queues.get(rec.key),i=q.indexOf(rec);q.splice(i,1);if(!q.length)b.queues.delete(rec.key);
    rec.owner.waits.delete(rec);waits.delete(rec.handle);rec.pin.close();rec.pin=null;b.waiting--;b.completed++;
    const complete=()=>{rec.onClose?.();if(notify&&!rec.owner.poisoned&&current(rec.owner.broker,rec.token)===rec.owner)rec.complete(result);};
    if(deferred)deferred.push(complete);else complete();
    return true;
  }
  class GuestMemoryBroker {
    constructor(){brokers.set(this,{slots:new Map(),nextLease:1n,requests:0,ok:0,faults:0,unsupported:0,rejected:0,
      queues:new Map(),waiting:0,queued:0,completed:0});}
    register(slot,{space,memory,checkpointLayout}) {
      const b=brokers.get(this);
      if(!Number.isSafeInteger(slot)||slot<0||b.slots.has(slot))throw new TypeError('Unoccupied trusted thread slot required');
      if(!(space instanceof storage.GuestAddressSpace)||space.stats().closed)throw new TypeError('Live GuestAddressSpace required');
      if(!memories.has(memory)||registeredMemories.has(memory)||memory.buffer.byteLength!==ABI.internalPages*65536)
        throw new TypeError('Fresh bounded internal memory required');
      const layout=layoutFor(checkpointLayout);
      if(b.nextLease>=U64)throw new BrokerInvariantError('Thread lease exhausted');
      const generation=b.nextLease++,token=Object.freeze({generation});
      const s={broker:this,slot,generation,space,memory,layout,view:new DataView(memory.buffer),
        scratch:new DataView(memory.buffer,ABI.threadBase+ABI.scratchOffset,ABI.scratchBytes),
        lastSequence:0,checkpoint:0n,active:null,spilledSyscall:false,closed:false,poisoned:false,waits:new Set(),preparedCopies:new Set()};
      new Uint8Array(memory.buffer,ABI.threadBase+ABI.scratchOffset,ABI.scratchBytes).fill(0);
      s.scratch.setUint32(FIELD.magic,ABI.magic,true);s.scratch.setUint32(FIELD.version,ABI.version,true);
      s.scratch.setBigUint64(FIELD.lease,generation,true);
      registeredMemories.add(memory);owners.set(token,s);b.slots.set(slot,s);return token;
    }
    unregister(token) {
      const s=current(this,token);if(!s)return false;
      for(const rec of [...s.preparedCopies])rec.cancel();
      for(const rec of [...s.waits])finishWait(brokers.get(this),rec,-4n,false);
      brokers.get(this).slots.delete(s.slot);owners.delete(token);s.closed=true;s.active=null;s.syscallCheckpoint=null;return true;
    }
    // Called at a safe boundary after native code has spilled the full CPU state.
    // operation/width must come from compile-time admission, never guest input.
    beginInstruction(token,{rip,operation=0,width=0,continuations,nextRip,sourceRegister,stackRegister,addMemoryOperand,subMemoryOperand,orMemoryOperand,divisionOperand,wordCompareOperand,wordLogicalOperand,conditionOperand}) {
      const s=requireOwner(this,token);rip=u64(rip);
      if(s.preparedCopies.size)throw new BrokerInvariantError('Prepared copyout must complete before BEGIN');
      if(s.active||s.waits.size)invariant(s,'Instruction already active or parked');
      s.spilledSyscall=false;s.syscallCheckpoint=null;
      if(!(([0,OP.SYSCALL,OP.FLAGS,OP.BRANCH,OP.JUMP_REGISTER].includes(operation)&&width===0)||([OP.READ,OP.WRITE,OP.READ_FLAGS].includes(operation)&&[1,2,4,8].includes(width))||
           ([OP.CAS,OP.FETCH_ADD,OP.ADD_MEMORY,OP.ADD_REGISTER_MEMORY,OP.SUB_REGISTER_MEMORY,OP.OR_MEMORY,OP.DIV_REGISTER].includes(operation)&&[4,8].includes(width))||([OP.CALL,OP.RETURN,OP.PUSH_REGISTER,OP.POP_REGISTER].includes(operation)&&width===8)))
        throw new TypeError('Unsupported instruction admission');
      if(operation===OP.BRANCH||operation===OP.CALL) {
        const dynamic=operation===OP.CALL&&sourceRegister!==undefined;
        if(!Array.isArray(continuations)||(dynamic?continuations.length!==0:continuations.length<1||continuations.length>2))throw new TypeError('Finite branch continuations required');
        continuations=Object.freeze(continuations.map(u64));
      }
      let stackBefore,stackAfter;
      const indirectCall=operation===OP.CALL&&sourceRegister!==undefined;
      const wordCompare=!!wordCompareOperand||operation===OP.READ_FLAGS&&width===2,c=wordCompareOperand?Object.freeze({...wordCompareOperand}):null;
      const reg=n=>Number.isInteger(n)&&n>=0&&n<16;
      if(wordCompare&&(s.layout.generalRegistersOffset===undefined||!s.layout.arithmeticFlags||!c||
         !Number.isInteger(c.kind)||c.kind<0||c.kind>4||operation!==(c.kind<3?OP.READ_FLAGS:OP.FLAGS)||width!==(c.kind<3?2:0)||
         (c.kind===0?(c.leftRegister!==16||c.rightRegister!==16):c.kind===1?(c.leftRegister!==16||!reg(c.rightRegister)):
          c.kind===2?(!reg(c.leftRegister)||c.rightRegister!==16):c.kind===3?(!reg(c.leftRegister)||!reg(c.rightRegister)):(!reg(c.leftRegister)||c.rightRegister!==16))||
         !['base','index'].every(n=>Number.isInteger(c[n])&&c[n]>=-1&&c[n]<16)||![1,2,4,8].includes(c.scale)||
         typeof c.displacement!=='bigint'||c.displacement<-(1n<<31n)||c.displacement>=(1n<<31n)||
         typeof c.ripRelative!=='boolean'||(c.ripRelative&&(c.base!==-1||c.index!==-1))||
         (c.kind>=3&&(c.base!==-1||c.index!==-1||c.scale!==1||c.displacement!==0n||c.ripRelative))||
         !Number.isInteger(c.immediate)||c.immediate<0||c.immediate>65535||([1,2,3].includes(c.kind)&&c.immediate!==0)||
         !Number.isInteger(c.length)||c.length<3||c.length>11||!canonical(rip)||!canonical(nextRip)||nextRip!==rip+BigInt(c.length)||
         !Array.isArray(continuations)||continuations.length!==1||continuations[0]!==nextRip))throw new TypeError('Checked word CMP metadata required');
      const logical=wordLogicalOperand?Object.freeze({...wordLogicalOperand}):null,conditional=conditionOperand?Object.freeze({...conditionOperand}):null;
      if(logical&&(wordCompare||conditional||operation!==OP.FLAGS||width||s.layout.generalRegistersOffset===undefined||!s.layout.arithmeticFlags||
         !reg(logical.register)||![1,4,6].includes(logical.kind)||!Number.isInteger(logical.mask)||logical.mask<0||logical.mask>65535||
         !Number.isInteger(logical.length)||logical.length<4||logical.length>6||!canonical(rip)||!canonical(nextRip)||nextRip!==rip+BigInt(logical.length)||
         !Array.isArray(continuations)||continuations.length!==1||continuations[0]!==nextRip))throw new TypeError('Checked word logical metadata required');
      if(conditional&&(wordCompare||logical||s.layout.generalRegistersOffset===undefined||!s.layout.arithmeticFlags||
         !Number.isInteger(conditional.code)||conditional.code<0||conditional.code>=16||width||
         (conditional.width===0?(operation!==OP.BRANCH||conditional.register!==16||conditional.source!==16||![2,6].includes(conditional.length)||continuations.length!==2):
           (operation!==OP.FLAGS||![4,8].includes(conditional.width)||!reg(conditional.register)||!reg(conditional.source)||![3,4].includes(conditional.length)||
            !Array.isArray(continuations)||continuations.length!==1||continuations[0]!==nextRip))||
         !canonical(rip)||!canonical(nextRip)||nextRip!==rip+BigInt(conditional.length)))throw new TypeError('Checked scalar condition metadata required');
      if(operation===OP.DIV_REGISTER&&(s.layout.generalRegistersOffset===undefined||!divisionOperand||
         !Number.isInteger(divisionOperand.register)||divisionOperand.register<0||divisionOperand.register>=16||
         ![2,3].includes(divisionOperand.length)||!canonical(rip)||!canonical(nextRip)||nextRip!==rip+BigInt(divisionOperand.length)||
         !Array.isArray(continuations)||continuations.length!==1||continuations[0]!==nextRip))throw new TypeError('Checked register DIV metadata required');
      const readArithmetic=operation===OP.ADD_REGISTER_MEMORY||operation===OP.SUB_REGISTER_MEMORY,
        memoryOr=operation===OP.OR_MEMORY,o=readArithmetic?(operation===OP.ADD_REGISTER_MEMORY?addMemoryOperand:subMemoryOperand):orMemoryOperand;
      if((readArithmetic||memoryOr)&&(s.layout.generalRegistersOffset===undefined||!s.layout.arithmeticFlags||!o||
         !['register','base','index'].every(n=>Number.isInteger(o[n])&&o[n]>=(n==='register'?0:-1)&&o[n]<16)||
         ![1,2,4,8].includes(o.scale)||typeof o.displacement!=='bigint'||o.displacement<-(1n<<31n)||o.displacement>=(1n<<31n)||
         typeof o.ripRelative!=='boolean'||(o.ripRelative&&(o.base!==-1||o.index!==-1))||
         !Number.isInteger(o.length)||o.length<2||o.length>8||!canonical(rip)||!canonical(nextRip)||nextRip!==rip+BigInt(o.length)||
         !Array.isArray(continuations)||continuations.length!==1||continuations[0]!==nextRip))throw new TypeError(readArithmetic?(operation===OP.ADD_REGISTER_MEMORY?'Checked register memory ADD metadata required':'Checked register memory SUB metadata required'):'Checked OR memory metadata required');
      const registerStack=operation===OP.PUSH_REGISTER||operation===OP.POP_REGISTER;
      if(registerStack&&(s.layout.generalRegistersOffset===undefined||
         s.layout.stackAddress!==ABI.threadBase+s.layout.spans[0].offset+s.layout.generalRegistersOffset+32||
         !Number.isInteger(stackRegister)||stackRegister<0||stackRegister>=16||!canonical(rip)||!canonical(nextRip)||
         (nextRip!==rip+1n&&nextRip!==rip+2n)||!Array.isArray(continuations)||continuations.length!==1||continuations[0]!==nextRip))
        throw new TypeError('Checked register stack metadata required');
      if(operation===OP.JUMP_REGISTER&&(s.layout.generalRegistersOffset===undefined||!Number.isInteger(sourceRegister)||sourceRegister<0||sourceRegister>=16||
         !canonical(rip)||!canonical(nextRip)||(nextRip!==rip+2n&&nextRip!==rip+3n)||!Array.isArray(continuations)||continuations.length))
        throw new TypeError('Checked register jump metadata required');
      if(operation===OP.CALL||operation===OP.RETURN) {
        if(s.layout.stackAddress===undefined||!canonical(rip)||!canonical(nextRip)||
           (indirectCall?(s.layout.generalRegistersOffset===undefined||!Number.isInteger(sourceRegister)||sourceRegister<0||sourceRegister>=16||
              (nextRip!==rip+2n&&nextRip!==rip+3n)||!Array.isArray(continuations)||continuations.length!==0):nextRip!==rip+(operation===OP.CALL?5n:1n))||
           (operation===OP.CALL&&!indirectCall&&(continuations.length!==1||!canonical(continuations[0])))||
           (operation===OP.RETURN&&continuations!==undefined&&(!Array.isArray(continuations)||continuations.length)))throw new TypeError('Checked stack control metadata required');
        stackBefore=s.view.getBigUint64(s.layout.stackAddress,true);
        stackAfter=stackBefore+(operation===OP.CALL?-8n:8n);
      }
      if(cpuRip(s)!==rip)invariant(s,'Full pre-instruction RIP was not spilled');
      if(s.checkpoint===U64-1n)invariant(s,'Checkpoint generation exhausted');
      const snapshot=s.layout.spans.map(p=>({offset:p.offset,
        bytes:new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,p.size).slice()}));
      if(indirectCall)continuations=Object.freeze([new DataView(snapshot[0].bytes.buffer).getBigUint64(s.layout.generalRegistersOffset+sourceRegister*8,true)]);
      const jumpTarget=operation===OP.JUMP_REGISTER?new DataView(snapshot[0].bytes.buffer).getBigUint64(s.layout.generalRegistersOffset+sourceRegister*8,true):undefined;
      let memoryArithmetic,memoryOR,wordComparison;
      const ownedCPU=new DataView(snapshot[0].bytes.buffer),ownedReg=n=>n<0||n===16?0n:ownedCPU.getBigUint64(s.layout.generalRegistersOffset+n*8,true);
      if(wordCompare)wordComparison=Object.freeze({...c,left:ownedReg(c.leftRegister),right:ownedReg(c.rightRegister),
        address:c.kind<3?BigInt.asUintN(64,(c.ripRelative?nextRip:0n)+ownedReg(c.base)+ownedReg(c.index)*BigInt(c.scale)+c.displacement):undefined});
      const wordLogical=logical?Object.freeze({...logical,input:ownedReg(logical.register)}):null;
      let scalarCondition;
      if(conditional){const f=s.layout.arithmeticFlags,lazy=new DataView(snapshot[1].bytes.buffer),kind=lazy.getUint32(0,true),fa=lazy.getBigUint64(8,true),fb=lazy.getBigUint64(16,true),
          nzcv=materializeScalarNZCV(kind,fa,fb,ownedCPU.getUint32(f.nzcvOffset,true)),pf=ownedCPU.getUint32(f.parityRawOffset,true),taken=conditionHolds(conditional.code,nzcv,pf);
        scalarCondition=Object.freeze({...conditional,nzcv,pf,kind,fa,fb,taken,destination:ownedReg(conditional.register),value:ownedReg(conditional.source)});
      }
      if(readArithmetic){const cpu=new DataView(snapshot[0].bytes.buffer),reg=n=>n<0?0n:cpu.getBigUint64(s.layout.generalRegistersOffset+n*8,true);
        memoryArithmetic=Object.freeze({register:o.register,destinationValue:reg(o.register),
          address:BigInt.asUintN(64,(o.ripRelative?nextRip:0n)+reg(o.base)+reg(o.index)*BigInt(o.scale)+o.displacement)});}
      if(memoryOr){const cpu=new DataView(snapshot[0].bytes.buffer),reg=n=>n<0?0n:cpu.getBigUint64(s.layout.generalRegistersOffset+n*8,true);
        memoryOR=Object.freeze({sourceValue:reg(o.register),
          address:BigInt.asUintN(64,(o.ripRelative?nextRip:0n)+reg(o.base)+reg(o.index)*BigInt(o.scale)+o.displacement)});}
      let stackValue;
      if(registerStack){const cpu=new DataView(snapshot[0].bytes.buffer);stackBefore=cpu.getBigUint64(s.layout.generalRegistersOffset+32,true);
        stackAfter=stackBefore+(operation===OP.PUSH_REGISTER?-8n:8n);stackValue=cpu.getBigUint64(s.layout.generalRegistersOffset+stackRegister*8,true);}
      let division;
      if(operation===OP.DIV_REGISTER){const cpu=new DataView(snapshot[0].bytes.buffer),reg=n=>BigInt.asUintN(width*8,cpu.getBigUint64(s.layout.generalRegistersOffset+n*8,true)),low=reg(0),high=reg(2),divisor=reg(divisionOperand.register);
        division=Object.freeze({low,high,divisor,reason:divisor===0n?'zero-divisor':high>=divisor?'quotient-overflow':null});}
      s.active={rip,generation:++s.checkpoint,operation,width,continuations,snapshot,result:null,nextRip,stackBefore,stackAfter,jumpTarget,stackRegister,stackValue,memoryArithmetic,memoryOR,division,wordComparison,wordLogical,scalarCondition,indirectCall};return s.checkpoint;
    }
    // The caller uses its authenticated thread record's token, not a request PID.
    // This synchronous route has no syscall, signal, redirect or await callbacks.
    dispatch(token,{lease,sequence}) {
      const b=brokers.get(this),s=current(this,token);
      if(!s||lease!==s.generation){b.rejected++;return Object.freeze({accepted:false,reason:REASON.STALE_LEASE});}
      if(s.poisoned)throw new BrokerInvariantError('Thread registration failed an invariant');
      if(!Number.isInteger(sequence)||sequence<=0||sequence>0xffffffff||sequence!==s.lastSequence+1) {
        b.rejected++;return Object.freeze({accepted:false,reason:REASON.SEQUENCE});
      }
      if(s.active?.result)invariant(s,'More than one memory request in an admitted instruction');
      const q=new DataView(new Uint8Array(s.memory.buffer,ABI.threadBase+ABI.scratchOffset,ABI.scratchBytes).slice().buffer);
      s.lastSequence=sequence;b.requests++;
      const fail=reason=>response(s,sequence,STATUS.UNSUPPORTED,reason);
      if(q.getUint32(FIELD.magic,true)!==ABI.magic||q.getUint32(FIELD.version,true)!==ABI.version||
         q.getUint32(FIELD.sequence,true)!==sequence||q.getBigUint64(FIELD.lease,true)!==lease)return fail(REASON.PROTOCOL);
      const operation=q.getUint32(FIELD.operation,true),width=q.getUint32(FIELD.width,true),access=q.getUint32(FIELD.access,true);
      if(![OP.READ,OP.WRITE,OP.CAS,OP.FETCH_ADD,OP.ADD_MEMORY,OP.JUMP_REGISTER,OP.OR_MEMORY].includes(operation))return fail(REASON.OPCODE);
      if(operation===OP.JUMP_REGISTER?width!==0:(![1,2,4,8].includes(width)||([OP.CAS,OP.FETCH_ADD,OP.ADD_MEMORY,OP.OR_MEMORY].includes(operation)&&![4,8].includes(width))))return fail(REASON.WIDTH);
      if(access!==(operation===OP.JUMP_REGISTER?storage.PROT.EXEC:operation===OP.READ?storage.PROT.READ:operation===OP.WRITE?storage.PROT.WRITE:storage.PROT.READ|storage.PROT.WRITE))
        return fail(REASON.ACCESS);
      const a=s.active;
      if(!a||q.getBigUint64(FIELD.rip,true)!==a.rip||q.getBigUint64(FIELD.checkpoint,true)!==a.generation||
         operation!==([OP.READ_FLAGS,OP.RETURN,OP.POP_REGISTER,OP.ADD_REGISTER_MEMORY,OP.SUB_REGISTER_MEMORY].includes(a.operation)?OP.READ:[OP.CALL,OP.PUSH_REGISTER].includes(a.operation)?OP.WRITE:a.operation)||width!==a.width)return fail(REASON.CHECKPOINT);
      const address=q.getBigUint64(FIELD.address,true);
      if(a.wordComparison&&address!==a.wordComparison.address)return fail(REASON.CHECKPOINT);
      if((a.operation===OP.ADD_REGISTER_MEMORY||a.operation===OP.SUB_REGISTER_MEMORY)&&address!==a.memoryArithmetic.address)return fail(REASON.CHECKPOINT);
      if(a.operation===OP.OR_MEMORY&&(address!==a.memoryOR.address||q.getBigUint64(FIELD.operand0,true)!==a.memoryOR.sourceValue))return fail(REASON.CHECKPOINT);
      if(a.operation===OP.PUSH_REGISTER||a.operation===OP.POP_REGISTER) {
        // POP may leave a one-past-window RSP, or load any 64-bit RSP data.
        // Validate the actual old-RSP access, without treating popped data as
        // a return target. The next stack access validates its own pre-RSP.
        if(!canonical(a.stackBefore)||(a.operation===OP.PUSH_REGISTER?!canonical(a.stackAfter):a.stackAfter>(1n<<47n)))return fail(REASON.ADDRESS_DOMAIN);
        if(address!==(a.operation===OP.PUSH_REGISTER?a.stackAfter:a.stackBefore)||
           (a.operation===OP.PUSH_REGISTER&&q.getBigUint64(FIELD.operand0,true)!==a.stackValue))return fail(REASON.CHECKPOINT);
      }
      if(operation===OP.JUMP_REGISTER) {
        if(address!==a.jumpTarget)return fail(REASON.CHECKPOINT);
        if(!canonical(address))return fail(REASON.CONTROL_TARGET);
        try{s.space.executableSnapshot(address,1);s.space.read(address,1);}catch(error){
          if(error instanceof storage.MemoryFault)return fail(REASON.CONTROL_TARGET);throw error;
        }
        return response(s,sequence,STATUS.OK,REASON.NONE,address);
      }
      if(a.operation===OP.CALL||a.operation===OP.RETURN) {
        if(!canonical(a.stackBefore)||!canonical(a.stackAfter))return fail(REASON.ADDRESS_DOMAIN);
        if(address!==(a.operation===OP.CALL?a.stackAfter:a.stackBefore)||
           (a.operation===OP.CALL&&q.getBigUint64(FIELD.operand0,true)!==a.nextRip))return fail(REASON.CHECKPOINT);
        if(a.operation===OP.CALL&&!canonical(a.continuations[0]))return fail(REASON.CONTROL_TARGET);
        if(a.operation===OP.CALL)try{s.space.executableSnapshot(a.continuations[0],1);s.space.read(a.continuations[0],1);}catch(error){
          if(error instanceof storage.MemoryFault)return fail(REASON.CONTROL_TARGET);throw error;
        }
      }
      if([OP.CAS,OP.FETCH_ADD].includes(operation)&&address%BigInt(width))return fail(REASON.ALIGNMENT);
      try {
        if(operation===OP.ADD_MEMORY||operation===OP.OR_MEMORY) {
          // Non-LOCK arithmetic: one synchronous authority transaction, no alignment
          // restriction or guest atomic-ordering guarantee. Validate the whole
          // READ+WRITE range and stage all COW pages before publishing anything.
          const tx=s.space.prepareWrite(address,width);
          try {
            if(current(this,token)!==s||s.active!==a||s.poisoned)invariant(s,'Memory arithmetic owner changed during preparation');
            const bytes=s.space.read(address,width);let old=0n;
            for(let i=width-1;i>=0;i--)old=old<<8n|BigInt(bytes[i]);
            let sum=BigInt.asUintN(width*8,operation===OP.OR_MEMORY?old|a.memoryOR.sourceValue:old+q.getBigUint64(FIELD.operand0,true));
            for(let i=0;i<width;i++){tx.bytes[i]=Number(sum&255n);sum>>=8n;}
            tx.commit();return response(s,sequence,STATUS.OK,REASON.NONE,old);
          }finally{tx.cancel();}
        }
        if(operation===OP.CAS||operation===OP.FETCH_ADD) {
          const old=operation===OP.CAS?s.space.compareExchange(address,width,q.getBigUint64(FIELD.operand0,true),q.getBigUint64(FIELD.operand1,true)):
            s.space.fetchAdd(address,width,q.getBigUint64(FIELD.operand0,true));
          return response(s,sequence,STATUS.OK,REASON.NONE,old);
        }
        if(operation===OP.READ) {
          const bytes=s.space.read(address,width);let value=0n;
          for(let i=width-1;i>=0;i--)value=(value<<8n)|BigInt(bytes[i]);
          if(a.operation===OP.RETURN) {
            if(!canonical(value))return fail(REASON.CONTROL_TARGET);
            try{s.space.executableSnapshot(value,1);s.space.read(value,1);}catch(error){
              if(error instanceof storage.MemoryFault)return fail(REASON.CONTROL_TARGET);throw error;
            }
          }
          return response(s,sequence,STATUS.OK,REASON.NONE,value);
        }
        let value=q.getBigUint64(FIELD.operand0,true);const bytes=new Uint8Array(width);
        for(let i=0;i<width;i++){bytes[i]=Number(value&255n);value>>=8n;}
        if(a.operation===OP.CALL||a.operation===OP.PUSH_REGISTER) {
          // COW preparation can call the trusted allocator. Recheck ownership
          // after it returns, before publishing the return-address bytes.
          const tx=s.space.prepareWrite(address,width);
          try {
            if(current(this,token)!==s||s.active!==a||s.poisoned)invariant(s,'Stack write owner changed during preparation');
            if(a.indirectCall)try{s.space.executableSnapshot(a.continuations[0],1);s.space.read(a.continuations[0],1);}catch(error){
              if(error instanceof storage.MemoryFault)return fail(REASON.CONTROL_TARGET);throw error;
            }
            tx.bytes.set(bytes);tx.commit();
          }finally{tx.cancel();}
        }else s.space.write(address,bytes);
        return response(s,sequence,STATUS.OK);
      } catch(error) {
        if(error instanceof storage.AllocationFailure)return response(s,sequence,STATUS.FAULT,REASON.ALLOCATION,0n,address);
        if(error instanceof storage.MemoryFault) {
          if(error.faultAddress<0n||error.faultAddress>=U64)return fail(REASON.ADDRESS_DOMAIN);
          const reason=({range:REASON.RANGE,unmapped:REASON.UNMAPPED,uncommitted:REASON.UNMAPPED,
            protection:REASON.PROTECTION,alignment:REASON.ALIGNMENT})[error.reason];
          if(reason!==undefined)return response(s,sequence,STATUS.FAULT,reason,0n,error.faultAddress);
        }
        invariant(s,'Unexpected storage failure: '+String(error));
      }
    }
    // Called only after STEP_* has returned and no guest Wasm locals remain live.
    finishInstruction(token,{status,nextRip}) {
      const s=requireOwner(this,token),a=s.active;
      if(!a)invariant(s,'No instruction checkpoint');
      let exception=null;
      if(status===STEP.OK) {
        if(a.division?.reason)invariant(s,'DIV succeeded despite an architectural divide error');
        const control=[OP.BRANCH,OP.CALL,OP.RETURN,OP.JUMP_REGISTER].includes(a.operation);
        nextRip=control?cpuRip(s):u64(nextRip);
        if(([OP.BRANCH,OP.CALL].includes(a.operation)&&!a.continuations.includes(nextRip))||
           ([OP.RETURN,OP.JUMP_REGISTER].includes(a.operation)&&nextRip!==a.result?.data)||
           ([OP.CALL,OP.RETURN].includes(a.operation)&&s.view.getBigUint64(s.layout.stackAddress,true)!==a.stackAfter)||
           ([OP.READ,OP.WRITE,OP.CAS,OP.FETCH_ADD,OP.READ_FLAGS,OP.CALL,OP.RETURN,OP.ADD_MEMORY,OP.JUMP_REGISTER,OP.PUSH_REGISTER,OP.POP_REGISTER,OP.ADD_REGISTER_MEMORY,OP.SUB_REGISTER_MEMORY,OP.OR_MEMORY].includes(a.operation)&&a.result?.status!==STATUS.OK)||
           ([0,OP.FLAGS,OP.BRANCH,OP.DIV_REGISTER].includes(a.operation)&&a.result)||
           a.operation===OP.SYSCALL||cpuRip(s)!==nextRip)
          invariant(s,'Full successful post-state was not spilled');
        if(a.indirectCall)for(const p of a.snapshot){
          const expected=p.bytes.slice(),actual=new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,expected.length);
          if(p.offset===s.layout.spans[0].offset){const v=new DataView(expected.buffer);
            v.setBigUint64(s.layout.ripAddress-ABI.threadBase-p.offset,nextRip,true);
            v.setBigUint64(s.layout.stackAddress-ABI.threadBase-p.offset,a.stackAfter,true);}
          if(!actual.every((v,i)=>v===expected[i]))invariant(s,'Register CALL changed unexpected checkpoint state');
        }
        if(a.operation===OP.DIV_REGISTER){
          if(nextRip!==a.nextRip)invariant(s,'Register DIV fallthrough changed');
          const dividend=(a.division.high<<BigInt(a.width*8))|a.division.low;
          for(const p of a.snapshot){const expected=p.bytes.slice();
            if(p.offset===s.layout.spans[0].offset){const cpu=new DataView(expected.buffer);
              cpu.setBigUint64(s.layout.ripAddress-ABI.threadBase-p.offset,a.nextRip,true);
              cpu.setBigUint64(s.layout.generalRegistersOffset,dividend/a.division.divisor,true);
              cpu.setBigUint64(s.layout.generalRegistersOffset+16,dividend%a.division.divisor,true);}
            if(!new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,expected.length).every((v,i)=>v===expected[i]))invariant(s,'Register DIV changed unexpected checkpoint state');
          }
        }
        if(a.operation===OP.OR_MEMORY) {
          if(nextRip!==a.nextRip)invariant(s,'OR memory fallthrough changed');
          const result=BigInt.asUintN(a.width*8,a.result.data|a.memoryOR.sourceValue),flags=s.layout.arithmeticFlags;
          for(const p of a.snapshot){const expected=p.bytes.slice(),actual=new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,expected.length);
            if(p.offset===s.layout.spans[0].offset){const cpu=new DataView(expected.buffer);
              cpu.setBigUint64(s.layout.ripAddress-ABI.threadBase-p.offset,a.nextRip,true);
              cpu.setUint32(flags.parityRawOffset,Number(BigInt.asUintN(32,result)),true);
              // NZCV and lazy data may retain a representation of the proved
              // SUB(result,0); native flag consumers check all defined flags.
              if(!actual.every((v,i)=>(i>=flags.nzcvOffset&&i<flags.nzcvOffset+4)||v===expected[i]))invariant(s,'OR memory changed unexpected CPU state');
            }else if(p.offset===s.layout.spans[1].offset){
              if(!actual.subarray(4,8).every((v,i)=>v===expected[i+4]))invariant(s,'OR memory changed lazy padding');
            }else if(!actual.every((v,i)=>v===expected[i]))invariant(s,'OR memory changed rounding state');
          }
        }
        if(a.wordComparison||a.wordLogical||a.scalarCondition)validateScalarPostState(s,a,nextRip);
        if(a.operation===OP.ADD_REGISTER_MEMORY||a.operation===OP.SUB_REGISTER_MEMORY) {
          if(nextRip!==a.nextRip)invariant(s,'Register memory arithmetic fallthrough changed');
          const sum=BigInt.asUintN(a.width*8,a.operation===OP.ADD_REGISTER_MEMORY?
            a.memoryArithmetic.destinationValue+a.result.data:a.memoryArithmetic.destinationValue-a.result.data),flags=s.layout.arithmeticFlags;
          validateArithmeticFlags(s,a,sum);
          for(const p of a.snapshot){const expected=p.bytes.slice(),actual=new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,expected.length);
            if(p.offset===s.layout.spans[0].offset){const cpu=new DataView(expected.buffer);
              cpu.setBigUint64(s.layout.ripAddress-ABI.threadBase-p.offset,a.nextRip,true);
              cpu.setBigUint64(s.layout.generalRegistersOffset+a.memoryArithmetic.register*8,sum,true);
              cpu.setUint32(flags.parityRawOffset,Number(BigInt.asUintN(32,sum)),true);
              cpu.setUint32(flags.auxiliaryRawOffset,Number(BigInt.asUintN(32,a.memoryArithmetic.destinationValue^a.result.data)),true);
              // Semantic validation above checks this exact word and the
              // owned lazy descriptor before accepting either representation.
              if(!actual.every((v,i)=>(i>=flags.nzcvOffset&&i<flags.nzcvOffset+4)||v===expected[i]))invariant(s,'Register memory arithmetic changed unexpected CPU state');
            }else if(p.offset===s.layout.spans[1].offset){
              const v=new DataView(actual.buffer,actual.byteOffset,actual.byteLength),e=new DataView(expected.buffer);
              e.setUint32(0,v.getUint32(0,true),true);e.setBigUint64(8,v.getBigUint64(8,true),true);e.setBigUint64(16,v.getBigUint64(16,true),true);
              if(!actual.every((v,i)=>v===expected[i]))invariant(s,'Register memory arithmetic changed lazy padding');
            }else if(!actual.every((v,i)=>v===expected[i]))invariant(s,'Register memory arithmetic changed rounding state');
          }
        }
        if(a.operation===OP.PUSH_REGISTER||a.operation===OP.POP_REGISTER) {
          if(nextRip!==a.nextRip)invariant(s,'Register stack fallthrough changed');
          for(const p of a.snapshot) {
            const expected=p.bytes.slice();
            if(p.offset===s.layout.spans[0].offset){const cpu=new DataView(expected.buffer);
              cpu.setBigUint64(s.layout.ripAddress-ABI.threadBase-p.offset,a.nextRip,true);
              cpu.setBigUint64(s.layout.generalRegistersOffset+32,a.stackAfter,true);
              if(a.operation===OP.POP_REGISTER)cpu.setBigUint64(s.layout.generalRegistersOffset+a.stackRegister*8,a.result.data,true);
            }
            const actual=new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,expected.length);
            if(!actual.every((value,i)=>value===expected[i]))invariant(s,'Register stack changed unexpected checkpoint state');
          }
        }
        if(a.operation===OP.JUMP_REGISTER)for(const p of a.snapshot) {
          const bytes=new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,p.bytes.length);
          for(let i=0;i<bytes.length;i++) {
            const at=ABI.threadBase+p.offset+i;
            if((at<s.layout.ripAddress||at>=s.layout.ripAddress+8)&&bytes[i]!==p.bytes[i])invariant(s,'Register jump changed non-RIP checkpoint state');
          }
        }
        // No data-memory effect occurred. Revocation during the worker's RPC
        // return may safely restore this jump; the next BEGIN still checks the
        // entire target instruction, including units obtained from the cache.
        if(a.operation===OP.JUMP_REGISTER)try{s.space.executableSnapshot(nextRip,1);s.space.read(nextRip,1);}catch(error){
          if(!(error instanceof storage.MemoryFault))throw error;
          status=STEP.UNSUPPORTED;restore(s);nextRip=a.rip;
          a.result=Object.freeze({...a.result,status:STATUS.UNSUPPORTED,reason:REASON.CONTROL_TARGET});
        }
      } else if(status===STEP.SYSCALL) {
        nextRip=u64(nextRip);
        if(a.operation!==OP.SYSCALL||a.result||cpuRip(s)!==nextRip)invariant(s,'Invalid spilled syscall boundary');
      } else if(status===STEP.DIVIDE_ERROR) {
        if(a.operation!==OP.DIV_REGISTER||!a.division?.reason||a.result)invariant(s,'DIVIDE_ERROR without an owned failing DIV');
        // Check before restoration: a trap or partial result cannot masquerade
        // as the emitter's write-free typed exit.
        for(const p of a.snapshot)if(!new Uint8Array(s.memory.buffer,ABI.threadBase+p.offset,p.bytes.length).every((v,i)=>v===p.bytes[i]))invariant(s,'DIVIDE_ERROR changed checkpoint state');
        restore(s);nextRip=a.rip;
        exception=Object.freeze({kind:'divide-error',vector:0,reason:a.division.reason,rip:a.rip});
      } else if(status===STEP.FAULT) {
        if(a.result?.status!==STATUS.FAULT)invariant(s,'STEP_FAULT without a typed memory fault');
        restore(s);nextRip=a.rip;
      } else if(status===STEP.UNSUPPORTED) {
        if(a.result&&a.result.status!==STATUS.UNSUPPORTED)invariant(s,'Unsupported instruction after a memory effect');
        restore(s);nextRip=a.rip;
      } else invariant(s,'Unknown step result');
      const result=Object.freeze({status,rip:nextRip,memory:a.result,...(exception?{exception}:{})});
      s.active=null;s.spilledSyscall=status===STEP.SYSCALL;s.syscallCheckpoint=s.spilledSyscall?a:null;return result;
    }
    // Refuse a prepared-but-unsupported exec before any irreversible effect.
    abortSpilledSyscall(token) {
      const s=userOwner(this,token);
      if(s.preparedCopies.size||!s.syscallCheckpoint)throw new BrokerInvariantError('No abortable syscall checkpoint');
      const a=s.syscallCheckpoint;restore(s,a.snapshot);s.spilledSyscall=false;s.syscallCheckpoint=null;
      return Object.freeze({status:STEP.UNSUPPORTED,rip:a.rip,memory:null});
    }
    // Kernel copyin/copyout only, after Wasm has fully unwound. These never
    // return backing views and do not consume a memory-RPC sequence or call I/O.
    copyIn(token,address,length) {
      const s=userOwner(this,token);return s.space.read(u64(address),copyLength(length));
    }
    copyOut(token,address,bytes) {
      const s=userOwner(this,token);address=u64(address);
      if(!(bytes instanceof Uint8Array)||!(bytes.buffer instanceof ArrayBuffer)||bytes.buffer.resizable)
        throw new TypeError('Fixed ordinary user copy bytes required');
      copyLength(bytes.byteLength);
      // Snapshot before storage allocation callbacks; write() validates all
      // pages and stages every private-view detachment before publishing bytes.
      s.space.write(address,new Uint8Array(bytes));
    }
    readUserU64(token,address) {
      const bytes=this.copyIn(token,address,8);return new DataView(bytes.buffer,bytes.byteOffset,8).getBigUint64(0,true);
    }
    prepareCopyOut(token,address,length) {
      const s=userOwner(this,token),tx=s.space.prepareWrite(u64(address),copyLength(length));
      // A custom frame allocator can retire the registration during preparation.
      try{userOwner(this,token);}catch(error){tx.cancel();throw error;}
      const rec={open:true,cancel:()=>{
        if(!rec.open)return false;rec.open=false;s.preparedCopies.delete(rec);tx.cancel();return true;
      }};
      s.preparedCopies.add(rec);
      const guard=(commit,count)=>{
        try {
          userOwner(this,token,true);
          if(!rec.open||!s.preparedCopies.has(rec))throw new BrokerInvariantError('Prepared copyout is closed');
          if(!commit)return tx.validate();
          const n=tx.commit(count);rec.open=false;s.preparedCopies.delete(rec);return n;
        }catch(error){rec.cancel();throw error;}
      };
      return Object.freeze({bytes:tx.bytes,length:tx.length,cancel:rec.cancel,
        validate:()=>guard(false),commit:count=>guard(true,count)});
    }
    assertCopiesComplete(token) {
      if(requireOwner(this,token).preparedCopies.size)throw new BrokerInvariantError('Prepared copyout must complete before syscall reply');
    }
    // Called at a spilled syscall boundary. Comparison and enqueue have no
    // await/reply gap. Only the requester parks; the authority keeps running.
    waitFutex(token,{address,expected,private:priv=false},complete,onClose) {
      const s=requireOwner(this,token),b=brokers.get(this);
      if(s.preparedCopies.size)throw new BrokerInvariantError('Prepared copyout cannot park');
      if(s.active||s.waits.size)invariant(s,'Futex wait requires an idle spilled thread');
      if(typeof complete!=='function'||(onClose!==undefined&&typeof onClose!=='function'))throw new TypeError('Futex completion required');
      const value=Number(BigInt.asUintN(32,u64(expected))),pin=s.space.pinFutex(address,{private:priv});
      let queued=false;
      try {
        if(pin.value()!==value)return Object.freeze({parked:false,result:-11n});
        const key=futexKey(pin.identity),handle=Object.freeze({}),
          rec={owner:s,token,key,handle,pin,complete,onClose,done:false};
        let q=b.queues.get(key);if(!q)b.queues.set(key,q=[]);
        q.push(rec);s.waits.add(rec);waits.set(handle,rec);b.waiting++;b.queued++;queued=true;
        return Object.freeze({parked:true,handle});
      } finally {if(!queued)pin.close();}
    }
    wakeFutex(token,{address,count,private:priv=false}) {
      const s=requireOwner(this,token),b=brokers.get(this);
      if(s.preparedCopies.size)throw new BrokerInvariantError('Prepared copyout must complete before wake');
      if(s.active||s.waits.size)invariant(s,'Futex wake requires a runnable spilled thread');
      if(!Number.isInteger(count)||count<0||count>0x7fffffff)throw new TypeError('Invalid futex wake count');
      const pin=s.space.pinFutex(address,{private:priv});let key;
      try{key=futexKey(pin.identity);}finally{pin.close();}
      const selected=(b.queues.get(key)||[]).slice(0,count),deferred=[];
      for(const rec of selected)finishWait(b,rec,0n,true,deferred);
      for(const complete of deferred)complete();
      return selected.length;
    }
    cancelFutex(handle,result=-110n,{notify=true}={}) {
      const rec=waits.get(handle);
      if(!rec||rec.owner.broker!==this)return false;
      if(typeof result!=='bigint')throw new TypeError('Exact futex result required');
      return finishWait(brokers.get(this),rec,result,notify);
    }
    futexStats(){const b=brokers.get(this);return Object.freeze({waiting:b.waiting,queued:b.queued,completed:b.completed});}
    stats() {
      const b=brokers.get(this);return Object.freeze({threads:b.slots.size,requests:b.requests,ok:b.ok,
        faults:b.faults,unsupported:b.unsupported,rejected:b.rejected});
    }
  }
  root.BetterJITGuestMemoryBroker=Object.freeze({ABI,FIELD,STATUS,REASON,OP,STEP,LIFECYCLE,jumpSourceRegister,callSourceRegister,stackRegister,addMemoryOperand,subMemoryOperand,orMemoryOperand,divisionOperand,wordCompareOperand,wordLogicalOperand,conditionOperand,scalarOperands,materializeScalarNZCV,conditionHolds,materializeArithmeticNZCV,instructionContinuations,parseStepHeader,createInternalMemory,
    BrokerInvariantError,UserCopyUnsupported,GuestMemoryBroker});
})(typeof globalThis!=='undefined'?globalThis:self);
