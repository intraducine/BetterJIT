// SPDX-License-Identifier: GPL-3.0-or-later
// Mutate copies of actual pinned FEX IR; no native guest JIT or vendor edits.
#include "backend.h"
#include "broker_step.h"
#include "fexhost.h"
#include "Interface/IR/IR.h"
#include "Interface/IR/IntrusiveIRList.h"
#include "Interface/IR/RegisterAllocationData.h"
#include <cstdio>
#include <cstring>
#include <functional>
#include <vector>
using namespace FEXCore::IR;
struct Shape {
  const IRListView& IR;
  Ref Source{}, Result{}, Flags{}, Invalidate{}, PF{}, Read{}, Carry{}, NZCV{}, Store{}, Marker{}, Exit{};
  Shape(const IRListView& V, unsigned Kind):IR(V) {
    for(auto [Block,Header]:IR.GetBlocks())for(auto [N,H]:IR.GetCode(Block))switch(H->Op){
    case OP_LOADREGISTER:Source=N;break;
    case OP_ANDWITHFLAGS:Result=Flags=N;break;
    case OP_OR:case OP_NOT:Result=N;break;
    case OP_XOR:if(Kind==4)Carry=N;else Result=N;break;
    case OP_SUBWITHFLAGS:Flags=N;break;
    case OP_INVALIDATEFLAGS:Invalidate=N;break;
    case OP_STOREPF:PF=N;break;
    case OP_LOADNZCV:Read=N;break;
    case OP_STORENZCV:NZCV=N;break;
    case OP_STOREREGISTER:Store=N;break;
    case OP_GUESTOPCODE:Marker=N;break;
    case OP_EXITFUNCTION:Exit=N;break;
    default:break;
    }
  }
  IROp_Header* Op(Ref N){return IR.GetOp<IROp_Header>(N);}
  void Before(Ref N,Ref Target){N->Unlink(IR.GetListData());Target->prepend(IR.GetListData(),N);}
  void After(Ref N,Ref Target){N->Unlink(IR.GetListData());Target->append(IR.GetListData(),N);}
  void Constant(OrderedNodeWrapper W,uint64_t Value){auto H=IR.GetOp<IROp_Header>(W);if(H->Op==OP_INLINECONSTANT)IR.GetOp<IROp_InlineConstant>(W)->Constant=Value;else IR.GetOp<IROp_Constant>(W)->Constant=Value;}
};
struct Case {const char* Name;std::function<void(Shape&)> Change;std::function<bool(Shape&)> Applies{};};
int main(){
 const Case Cases[]={
  {"valid",[](Shape&){}},
  {"profile-kind",[](Shape&){}},{"profile-logical-width",[](Shape&){}},{"profile-immediate",[](Shape&){}},
  {"profile-immediate-domain",[](Shape&){}},{"profile-wire-width",[](Shape&){}},{"profile-operation",[](Shape&){}},
  {"profile-register",[](Shape&){}},{"profile-flow",[](Shape&){}},{"profile-target",[](Shape&){}},
  {"profile-next",[](Shape&){}},{"profile-NOP",[](Shape&){}},{"profile-TEST",[](Shape&){}},
  {"profile-SETcc",[](Shape&){}},{"profile-BT",[](Shape&){}},{"profile-shared",[](Shape&){}},
  {"source-register",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Reg^=1;}},
  {"source-class",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Class=RegClass::FPR;}},
  {"source-width",[](Shape& S){S.Op(S.Source)->Size=OpSize::i32Bit;}},
  {"source-after-result",[](Shape& S){S.After(S.Source,S.Result);}},
  {"result-opcode",[](Shape& S){S.Op(S.Result)->Op=OP_ADD;}},
  {"result-width",[](Shape& S){S.Op(S.Result)->Size=OpSize::i128Bit;}},
  {"result-input",[](Shape& S){S.Op(S.Result)->Args[0]=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;}},
  {"result-mask",[](Shape& S){auto W=S.Op(S.Result)->Args[1];auto H=S.IR.GetOp<IROp_Header>(W);uint64_t C=H->Op==OP_INLINECONSTANT?H->C<IROp_InlineConstant>()->Constant:H->C<IROp_Constant>()->Constant;S.Constant(W,C^1);},[](Shape& S){return S.Op(S.Result)->Op!=OP_NOT;}},
  {"mask-width",[](Shape& S){S.IR.GetOp<IROp_Header>(S.Op(S.Result)->Args[1])->Size=OpSize::i32Bit;},[](Shape& S){return S.Op(S.Result)->Op!=OP_NOT;}},
  {"mask-after-result",[](Shape& S){S.After(S.IR.GetNode(S.Op(S.Result)->Args[1]),S.Result);},[](Shape& S){return S.Op(S.Result)->Op!=OP_NOT;}},
  {"flag-opcode",[](Shape& S){S.Op(S.Flags)->Op=OP_ADDWITHFLAGS;}},
  {"flag-width",[](Shape& S){S.Op(S.Flags)->Size=OpSize::i128Bit;}},
  {"flag-input",[](Shape& S){S.Op(S.Flags)->Args[0]=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;}},
  {"flag-zero",[](Shape& S){S.Constant(S.Op(S.Flags)->Args[1],1);},[](Shape& S){return S.Flags!=S.Result;}},
  {"flags-before-result",[](Shape& S){S.Before(S.Flags,S.Result);},[](Shape& S){return S.Flags!=S.Result;}},
  {"AF-mask",[](Shape& S){S.IR.GetOp<IROp_InvalidateFlags>(S.Invalidate)->Flags=1;}},
  {"AF-width",[](Shape& S){S.Op(S.Invalidate)->Size=OpSize::i32Bit;}},
  {"AF-before-result",[](Shape& S){S.Before(S.Invalidate,S.Result);}},
  {"PF-input",[](Shape& S){S.Op(S.PF)->Args[0]=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;}},
  {"PF-width",[](Shape& S){S.Op(S.PF)->Size=OpSize::i32Bit;}},
  {"PF-before-flags",[](Shape& S){S.Before(S.PF,S.Flags);}},
  {"store-register",[](Shape& S){auto R=PhysicalRegister(S.Store);S.Store->Reg=PhysicalRegister(RegClass::GPRFixed,R.Reg^1).Raw;}},
  {"store-class",[](Shape& S){S.Store->Reg=PhysicalRegister(RegClass::FPRFixed,0).Raw;}},
  {"store-width",[](Shape& S){S.Op(S.Store)->Size=OpSize::i32Bit;}},
  {"store-value",[](Shape& S){S.IR.GetOp<IROp_StoreRegister>(S.Store)->Value=S.IR.WrapNode(S.Source);}},
  {"store-before-PF",[](Shape& S){S.Before(S.Store,S.PF);}},
  {"carry-mask",[](Shape& S){S.Constant(S.Op(S.Carry)->Args[1],0x10000000);},[](Shape& S){return bool(S.Carry);}},
  {"carry-width",[](Shape& S){S.Op(S.Carry)->Size=OpSize::i64Bit;},[](Shape& S){return bool(S.Carry);}},
  {"carry-value",[](Shape& S){S.Op(S.Carry)->Args[0]=S.IR.WrapNode(S.Source);},[](Shape& S){return bool(S.Carry);}},
  {"carry-before-read",[](Shape& S){S.Before(S.Carry,S.Read);},[](Shape& S){return bool(S.Carry);}},
  {"NZCV-input",[](Shape& S){S.Op(S.NZCV)->Args[0]=S.IR.WrapNode(S.Read);},[](Shape& S){return bool(S.NZCV);}},
  {"NZCV-after-PF",[](Shape& S){S.After(S.NZCV,S.PF);},[](Shape& S){return bool(S.NZCV);}},
  {"read-after-carry",[](Shape& S){S.After(S.Read,S.Carry);},[](Shape& S){return bool(S.Read);}},
  {"extra-memory-read",[](Shape& S){S.Op(S.Marker)->Op=OP_LOADMEM;}},
  {"extra-memory-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREMEM;}},
  {"extra-context-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STORECONTEXT;}},
  {"extra-syscall",[](Shape& S){S.Op(S.Marker)->Op=OP_SYSCALL;}},
  {"extra-atomic",[](Shape& S){S.Op(S.Marker)->Op=OP_ATOMICFETCHADD;}},
  {"effect-after-exit",[](Shape& S){S.After(S.Marker,S.Exit);}},
  {"exit-target",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP=S.IR.WrapNode(S.Source);}},
  {"exit-hint",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->Hint=BranchHint::Call;}},
 };
 fexwasm::FexHost::Options Options;Options.MaxInstructions=1;Options.DebugGuestInstructions=true;Options.Multiblock=false;fexwasm::FexHost Host(Options);
 unsigned Checked=0,Valid=0,Unexpected=0,RawChecks=0,Truncations=0;
 // Sweep every group/ModRM and single REX with sampled immediate boundaries.
 // This portable admission check covers destination, sign extension and ignored R/X.
 for(unsigned Rex=0;Rex<=16;Rex++)for(unsigned Opcode:{0x81,0x83})for(unsigned M=0;M<256;M++)for(unsigned Imm:{0u,1u,127u,128u,255u,0x7fffffffu,0x80000000u,0xffffffffu}){
  std::vector<unsigned char> C;if(Rex)C.push_back(0x3f+Rex);C.push_back(Opcode);C.push_back(M);for(unsigned I=0;I<(Opcode==0x83?1:4);I++)C.push_back(Imm>>(I*8));auto P=fexwasm::broker::Admit(C.data(),C.size());const unsigned Kind=(M>>3)&7,R=Rex?0x3f+Rex:0;const bool Expected=(M>>6)==3&&(Kind==1||Kind==4||Kind==6);
  if(bool(P.LogicalWidth)!=Expected)return 10;if(Expected){const unsigned W=(R&8)?8:4;const uint64_t Raw=Opcode==0x83?(Imm&255u):Imm,Sign=Opcode==0x83?128u:0x80000000u,Upper=Opcode==0x83?(~0ull<<8):(~0ull<<32),Mask=(Raw&Sign)?Raw|Upper:Raw;if(!P.Supported||P.Operation!=6||P.Width||P.LogicalKind!=Kind||P.LogicalWidth!=W||P.LogicalMask!=(W==4?uint32_t(Mask):Mask)||P.Register!=((M&7)+((R&1)?8:0))||P.Length!=C.size())return 11;for(unsigned L=0;L<C.size();L++){if(fexwasm::broker::Admit(C.data(),L).Supported)return 12;Truncations++;}}RawChecks++;
 }
 constexpr uint64_t RIP=0x123400008000;
 for(unsigned Kind:{1,4,6})for(unsigned Width:{4,8})for(unsigned Opcode:{0x81,0x83})for(unsigned Mask:{0u,1u,0x7fu,0x80u,0xffu,0x7fffffffu,0x80000000u,0xffffffffu})for(unsigned Register:{0,4,8,15}){
  if(Opcode==0x83&&Mask>255)continue;std::vector<unsigned char> C;unsigned Rex=(Width==8?8:0)|(Register>=8?1:0);if(Rex)C.push_back(0x40|Rex);C.push_back(Opcode);C.push_back(0xc0|(Kind<<3)|(Register&7));for(unsigned I=0;I<(Opcode==0x83?1:4);I++)C.push_back(Mask>>(I*8));auto Plan=fexwasm::broker::Admit(C.data(),C.size());if(!Plan.Supported)return 20;
  Host.MapGuest(RIP,C.data(),C.size());uint64_t N=0;auto Original=Host.GenerateIR(RIP,&N);if(!Original||N!=1||Host.InstructionLength(RIP)!=C.size())return 21;
  for(const auto& T:Cases){
   std::vector<unsigned char> Data(Original->GetDataSize()),List(Original->GetListSize());memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());IRListView IR(Data.data(),List.data(),Data.size(),List.size());Shape S(IR,Kind);if(T.Applies&&!T.Applies(S))continue;T.Change(S);
   fexwasm::BackendConfig B;B.BrokerMemory=true;B.BrokerOperation=6;B.BrokerTargetRegister=Register;B.BrokerLogicalWidth=Width;B.BrokerLogicalKind=Kind;B.BrokerLogicalMask=Plan.LogicalMask;B.BrokerNextRIP=RIP+C.size();B.SharedMemory=true;B.ThreadBaseGlobal=true;B.MemPages=B.MemMaxPages=fexwasm::broker::Pages;B.RegArgs=0;B.CallsViaDispatcher=false;
   if(!strcmp(T.Name,"profile-kind"))B.BrokerLogicalKind=3;
   if(!strcmp(T.Name,"profile-logical-width"))B.BrokerLogicalWidth=2;
   if(!strcmp(T.Name,"profile-immediate"))B.BrokerLogicalMask^=1;
   if(!strcmp(T.Name,"profile-immediate-domain"))B.BrokerLogicalMask=1ull<<32;
   if(!strcmp(T.Name,"profile-wire-width"))B.BrokerWidth=Width;
   if(!strcmp(T.Name,"profile-operation"))B.BrokerOperation=0;
   if(!strcmp(T.Name,"profile-register"))B.BrokerTargetRegister^=1;
   if(!strcmp(T.Name,"profile-flow"))B.BrokerFlow=1;
   if(!strcmp(T.Name,"profile-target"))B.BrokerTarget=RIP;
   if(!strcmp(T.Name,"profile-next"))B.BrokerNextRIP++;
   if(!strcmp(T.Name,"profile-NOP"))B.BrokerNoEffects=true;
   if(!strcmp(T.Name,"profile-TEST"))B.BrokerTestWidth=4;
   if(!strcmp(T.Name,"profile-SETcc"))B.BrokerSetCondition=0;
   if(!strcmp(T.Name,"profile-BT"))B.BrokerBitWidth=4;
   if(!strcmp(T.Name,"profile-shared"))B.SharedMemory=false;
   const auto R=fexwasm::Compile(IR,RIP,B);const bool Expected=!strcmp(T.Name,"valid"),OK=Expected?(R.Error.empty()&&!R.Module.empty()):(!R.Error.empty()&&R.Module.empty());Checked++;Valid+=Expected;Unexpected+=!OK;
   printf("logical%u width%u opcode%02x mask%08x reg%u %s: %s%s\n",Kind,Width,Opcode,Mask,Register,T.Name,R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
  }
  Host.Release();Host.DiscardIR(RIP);
 }
 printf("checked %u actual logical-immediate IR copies; valid %u; unexpected %u; raw encodings %u; raw truncations %u\n",Checked,Valid,Unexpected,RawChecks,Truncations);return Unexpected?1:0;
}
