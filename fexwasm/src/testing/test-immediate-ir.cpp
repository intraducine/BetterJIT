// SPDX-License-Identifier: GPL-3.0-or-later
// Mutate copies of actual immediate-TEST FEX IR. No native guest JIT.
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
  Ref Source {}, Extract {}, And {}, Flags {}, Invalidate {}, PF {}, ReadNZCV {}, Carry {}, StoreNZCV {}, Store {}, Marker {}, Exit {};
  explicit Shape(const IRListView& View) : IR(View) {
    for(auto [Block,Header]:IR.GetBlocks())for(auto [Node,H]:IR.GetCode(Block))switch(H->Op){
    case OP_LOADREGISTER: Source=Node;break;
    case OP_LSHR: Extract=Node;break;
    case OP_AND: And=Node;break;
    case OP_ANDWITHFLAGS: And=Flags=Node;break;
    case OP_SUBNZCV:case OP_SUBWITHFLAGS:case OP_TESTNZ:Flags=Node;break;
    case OP_INVALIDATEFLAGS:Invalidate=Node;break;
    case OP_STOREPF:PF=Node;break;
    case OP_LOADNZCV:ReadNZCV=Node;break;
    case OP_XOR:Carry=Node;break;
    case OP_STORENZCV:StoreNZCV=Node;break;
    case OP_STOREREGISTER:Store=Node;break;
    case OP_GUESTOPCODE:Marker=Node;break;
    case OP_EXITFUNCTION:Exit=Node;break;
    default:break;
    }
  }
  IROp_Header* Op(Ref N){return IR.GetOp<IROp_Header>(N);}
  void Before(Ref N,Ref Target){N->Unlink(IR.GetListData());Target->prepend(IR.GetListData(),N);}
  void After(Ref N,Ref Target){N->Unlink(IR.GetListData());Target->append(IR.GetListData(),N);}
};
struct Case{const char* Name;std::function<void(Shape&)> Mutate;std::function<bool(const Shape&)> Applicable{};};
// Reuse this diagnostic's real-IR copy/mutation harness and the existing
// generic register FLAGS gate. This is an effects regression matrix, not a new
// production semantic proof rejecting every altered immediate or GPR dataflow.
static int CheckAccumulatorLogical(fexwasm::FexHost& Host){
 const Case Cases[]={
  {"valid",[](Shape&){}},
  {"memory-read",[](Shape& S){S.Op(S.Marker)->Op=OP_LOADMEM;}},
  {"memory-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREMEM;}},
  {"context-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STORECONTEXT;}},
  {"syscall",[](Shape& S){S.Op(S.Marker)->Op=OP_SYSCALL;}},
  {"atomic",[](Shape& S){S.Op(S.Marker)->Op=OP_ATOMICFETCHADD;}},
  {"wrong-AF-invalidation",[](Shape& S){S.IR.GetOp<IROp_InvalidateFlags>(S.Invalidate)->Flags=1;}},
  {"wrong-load-class",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Class=RegClass::FPR;}},
  {"out-of-range-load",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Reg=18;}},
  {"wrong-store-class",[](Shape& S){S.Store->Reg=PhysicalRegister(RegClass::FPRFixed,0).Raw;}},
  {"out-of-range-store",[](Shape& S){S.Store->Reg=PhysicalRegister(RegClass::GPRFixed,18).Raw;}},
  {"variable-exit",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP=S.IR.WrapNode(S.Source);}},
  {"wrong-next",[](Shape&){}},
  {"NOP-profile",[](Shape&){}},
  {"unshared-profile",[](Shape&){}},
 };
 std::vector<std::vector<unsigned char>> Prefixes={{},{0x66}};for(unsigned R=0x40;R<=0x4f;R++)Prefixes.push_back({(unsigned char)R});for(unsigned R=0x40;R<=0x4f;R++)Prefixes.push_back({0x66,(unsigned char)R});
 unsigned Checked=0,Valid=0,Unexpected=0,Truncated=0;
 for(const auto& Prefix:Prefixes)for(unsigned Opcode:{0x24,0x25,0x0c,0x0d,0x34,0x35}){
  bool Word=false,Wide=false;for(auto B:Prefix){Word|=B==0x66;Wide|=B>=0x48&&B<=0x4f;}
  const unsigned Width=!(Opcode&1)?1:Wide?8:Word?2:4,N=Width==8?4:Width;
  const uint32_t Limit=N==4?~0u:(1u<<(N*8))-1,Masks[]={0,1,(1u<<(N*8-1))-1,1u<<(N*8-1),Limit,0x55aa&Limit,0x80,0xff00&Limit};
  for(auto Mask:Masks){auto Bytes=Prefix;Bytes.push_back(Opcode);for(unsigned I=0;I<N;I++)Bytes.push_back(Mask>>(I*8));const auto Plan=fexwasm::broker::Admit(Bytes.data(),Bytes.size());if(!Plan.Supported||Plan.Operation!=6||Plan.Width||Plan.Register||Plan.Length!=Bytes.size()||Plan.TestWidth||Plan.SetCondition!=16)return 20;
   for(unsigned L=0;L<Bytes.size();L++){if(fexwasm::broker::Admit(Bytes.data(),L).Supported)return 21;Truncated++;}
   constexpr uint64_t RIP=0x123400008000;if(!Host.MapGuest(RIP,Bytes.data(),Bytes.size()))return 22;uint64_t Insts=0;const auto* Original=Host.GenerateIR(RIP,&Insts);if(!Original||Insts!=1||Host.InstructionLength(RIP)!=Plan.Length)return 23;
   for(const auto& C:Cases){
    std::vector<unsigned char> Data(Original->GetDataSize()),List(Original->GetListSize());std::memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());std::memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());IRListView IR(Data.data(),List.data(),Data.size(),List.size());Shape S(IR);
    if(!S.Source||!S.Store||!S.PF||!S.Flags||!S.Invalidate||!S.Marker||!S.Exit)return 24;
    const auto* Load=IR.GetOp<IROp_LoadRegister>(S.Source);const auto* Flags=S.Op(S.Flags);const auto Dest=PhysicalRegister(S.Store);
    if(Load->Reg||Load->Class!=RegClass::GPR||uint32_t(Load->Header.Size)!=8||Dest.AsRegClass()!=RegClass::GPRFixed||Dest.Reg||uint32_t(S.Op(S.Store)->Size)!=8||
       (Width<4?(Flags->Op!=OP_TESTNZ||uint32_t(Flags->Size)!=Width):(Flags->Op!=(Opcode==0x25?OP_ANDWITHFLAGS:OP_SUBWITHFLAGS)||uint32_t(Flags->Size)!=Width)))return 25;
    C.Mutate(S);fexwasm::BackendConfig Cfg;Cfg.BrokerMemory=true;Cfg.BrokerOperation=6;Cfg.BrokerWidth=0;Cfg.BrokerNextRIP=RIP+Plan.Length;Cfg.SharedMemory=true;Cfg.ThreadBaseGlobal=true;Cfg.MemPages=Cfg.MemMaxPages=fexwasm::broker::Pages;Cfg.RegArgs=0;Cfg.CallsViaDispatcher=false;
    if(!strcmp(C.Name,"wrong-next"))Cfg.BrokerNextRIP++;
    if(!strcmp(C.Name,"NOP-profile"))Cfg.BrokerNoEffects=true;
    if(!strcmp(C.Name,"unshared-profile"))Cfg.SharedMemory=false;
    const auto R=fexwasm::Compile(IR,RIP,Cfg);const bool Expected=!strcmp(C.Name,"valid"),OK=Expected?(R.Error.empty()&&!R.Module.empty()):(!R.Error.empty()&&R.Module.empty());Checked++;Valid+=Expected;Unexpected+=!OK;
    printf("accumulator opcode%02x width%u mask%08x %s: %s%s\n",Opcode,Width*8,Mask,C.Name,R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
   }Host.Release();
  }
 }
 printf("checked %u actual accumulator-logical IR copies; valid %u; unexpected %u; raw truncations %u\n",Checked,Valid,Unexpected,Truncated);return Unexpected?1:0;
}
struct BitShape {
 const IRListView& IR;
 Ref Source{},Index{},Mask{},Shift{},Bit{},Read{},Merge{},Carry{},Store{},Marker{},Exit{};
 BitShape(const IRListView& View,unsigned Base,unsigned IndexRegister):IR(View){
  for(auto [Block,Header]:IR.GetBlocks())for(auto [Node,H]:IR.GetCode(Block))switch(H->Op){
   case OP_LOADREGISTER:{const auto R=H->C<IROp_LoadRegister>()->Reg;if(R==Base)Source=Node;if(R==IndexRegister)Index=Node;break;}
   case OP_AND:Mask=Node;break;case OP_LSHR:Shift=Node;break;case OP_BFE:Bit=Node;break;
   case OP_LOADNZCV:Read=Node;break;case OP_BFI:Merge=Node;break;case OP_XOR:Carry=Node;break;
   case OP_STORENZCV:Store=Node;break;case OP_GUESTOPCODE:Marker=Node;break;case OP_EXITFUNCTION:Exit=Node;break;default:break;
  }
 }
 IROp_Header* Op(Ref N){return IR.GetOp<IROp_Header>(N);}
 void Before(Ref N,Ref Target){N->Unlink(IR.GetListData());Target->prepend(IR.GetListData(),N);}
 void After(Ref N,Ref Target){N->Unlink(IR.GetListData());Target->append(IR.GetListData(),N);}
};
static int CheckBitTest(fexwasm::FexHost& Host){
 struct Mutation{const char* Name;std::function<void(BitShape&)> Change;std::function<bool(const BitShape&)> Applicable{};};
 const Mutation Cases[]={
  {"valid",[](BitShape&){}},
  {"profile-width",[](BitShape&){}},{"profile-operation",[](BitShape&){}},{"profile-wire-width",[](BitShape&){}},
  {"profile-base",[](BitShape&){}},{"profile-index",[](BitShape&){}},{"profile-bit",[](BitShape&){}},
  {"profile-index-domain",[](BitShape&){}},{"profile-bit-domain",[](BitShape&){}},{"profile-flow",[](BitShape&){}},
  {"profile-target",[](BitShape&){}},{"profile-NOP",[](BitShape&){}},{"profile-TEST",[](BitShape&){}},
  {"profile-SETcc",[](BitShape&){}},{"profile-next",[](BitShape&){}},{"profile-shared",[](BitShape&){}},
  {"source-register",[](BitShape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Reg^=1;}},
  {"source-class",[](BitShape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Class=RegClass::FPR;}},
  {"source-width",[](BitShape& S){S.Op(S.Source)->Size=OpSize::i32Bit;}},
  {"source-after-bit",[](BitShape& S){S.After(S.Source,S.Bit);}},
  {"index-register",[](BitShape& S){S.IR.GetOp<IROp_LoadRegister>(S.Index)->Reg^=1;},[](const BitShape& S){return S.Index&&S.Index!=S.Source;}},
  {"word-mask",[](BitShape& S){S.IR.GetOp<IROp_InlineConstant>(S.Op(S.Mask)->Args[1])->Constant=14;},[](const BitShape& S){return S.Mask!=nullptr;}},
  {"word-mask-width",[](BitShape& S){S.Op(S.Mask)->Size=OpSize::i32Bit;},[](const BitShape& S){return S.Mask!=nullptr;}},
  {"word-mask-source",[](BitShape& S){S.Op(S.Mask)->Args[0]=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;},[](const BitShape& S){return S.Mask!=nullptr;}},
  {"word-mask-before-index",[](BitShape& S){S.Before(S.Mask,S.Index);},[](const BitShape& S){return S.Mask!=nullptr;}},
  {"word-mask-op",[](BitShape& S){S.Op(S.Mask)->Op=OP_OR;},[](const BitShape& S){return S.Mask!=nullptr;}},
  {"shift-op",[](BitShape& S){S.Op(S.Shift)->Op=OP_ASHR;},[](const BitShape& S){return S.Shift!=nullptr;}},
  {"shift-width",[](BitShape& S){S.Op(S.Shift)->Size=OpSize::i128Bit;},[](const BitShape& S){return S.Shift!=nullptr;}},
  {"shift-value",[](BitShape& S){S.Op(S.Shift)->Args[0]=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;},[](const BitShape& S){return S.Shift!=nullptr;}},
  {"shift-index",[](BitShape& S){S.Op(S.Shift)->Args[1]=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;},[](const BitShape& S){return S.Shift!=nullptr;}},
  {"shift-before-source",[](BitShape& S){S.Before(S.Shift,S.Source);},[](const BitShape& S){return S.Shift!=nullptr;}},
  {"bit-width",[](BitShape& S){S.IR.GetOp<IROp_Bfe>(S.Bit)->Width=2;}},
  {"bit-offset",[](BitShape& S){S.IR.GetOp<IROp_Bfe>(S.Bit)->lsb^=1;}},
  {"bit-source",[](BitShape& S){S.IR.GetOp<IROp_Bfe>(S.Bit)->Src=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;}},
  {"bit-size",[](BitShape& S){S.Op(S.Bit)->Size=OpSize::i32Bit;}},
  {"bit-before-source",[](BitShape& S){S.Before(S.Bit,S.Source);}},
  {"NZCV-width",[](BitShape& S){S.Op(S.Read)->Size=OpSize::i64Bit;}},
  {"NZCV-before-bit",[](BitShape& S){S.Before(S.Read,S.Bit);}},
  {"merge-width",[](BitShape& S){S.IR.GetOp<IROp_Bfi>(S.Merge)->Width=2;}},
  {"merge-offset",[](BitShape& S){S.IR.GetOp<IROp_Bfi>(S.Merge)->lsb=28;}},
  {"merge-old-NZCV",[](BitShape& S){S.IR.GetOp<IROp_Bfi>(S.Merge)->Dest=S.IR.WrapNode(S.Bit);}},
  {"merge-bit",[](BitShape& S){S.IR.GetOp<IROp_Bfi>(S.Merge)->Src=S.IR.WrapNode(S.Source);}},
  {"merge-size",[](BitShape& S){S.Op(S.Merge)->Size=OpSize::i64Bit;}},
  {"merge-before-NZCV",[](BitShape& S){S.Before(S.Merge,S.Read);}},
  {"carry-mask",[](BitShape& S){S.IR.GetOp<IROp_InlineConstant>(S.Op(S.Carry)->Args[1])->Constant=0x10000000;}},
  {"carry-source",[](BitShape& S){S.Op(S.Carry)->Args[0]=S.IR.WrapNode(S.Read);}},
  {"carry-width",[](BitShape& S){S.Op(S.Carry)->Size=OpSize::i64Bit;}},
  {"carry-op",[](BitShape& S){S.Op(S.Carry)->Op=OP_OR;}},
  {"carry-before-merge",[](BitShape& S){S.Before(S.Carry,S.Merge);}},
  {"store-source",[](BitShape& S){S.Op(S.Store)->Args[0]=S.IR.WrapNode(S.Merge);}},
  {"store-width",[](BitShape& S){S.Op(S.Store)->Size=OpSize::i64Bit;}},
  {"store-before-carry",[](BitShape& S){S.Before(S.Store,S.Carry);}},
  {"extra-GPR-write",[](BitShape& S){S.Op(S.Marker)->Op=OP_STOREREGISTER;}},
  {"extra-memory-read",[](BitShape& S){S.Op(S.Marker)->Op=OP_LOADMEM;}},
  {"extra-memory-write",[](BitShape& S){S.Op(S.Marker)->Op=OP_STOREMEM;}},
  {"extra-context-read",[](BitShape& S){S.Op(S.Marker)->Op=OP_LOADCONTEXT;}},
  {"extra-context-write",[](BitShape& S){S.Op(S.Marker)->Op=OP_STORECONTEXT;}},
  {"extra-PF-read",[](BitShape& S){S.Op(S.Marker)->Op=OP_LOADPF;}},
  {"extra-PF-write",[](BitShape& S){S.Op(S.Marker)->Op=OP_STOREPF;}},
  {"extra-AF-read",[](BitShape& S){S.Op(S.Marker)->Op=OP_LOADAF;}},
  {"extra-AF-write",[](BitShape& S){S.Op(S.Marker)->Op=OP_STOREAF;}},
  {"extra-syscall",[](BitShape& S){S.Op(S.Marker)->Op=OP_SYSCALL;}},
  {"extra-atomic",[](BitShape& S){S.Op(S.Marker)->Op=OP_ATOMICFETCHADD;}},
  {"extra-invalidation",[](BitShape& S){S.Op(S.Marker)->Op=OP_INVALIDATEFLAGS;}},
  {"variable-exit",[](BitShape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP=S.IR.WrapNode(S.Source);}},
  {"call-exit",[](BitShape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->Hint=BranchHint::Call;}},
  {"early-exit",[](BitShape& S){S.Before(S.Exit,S.Store);}},
  {"store-after-exit",[](BitShape& S){S.After(S.Store,S.Exit);}}
 };
 std::vector<std::vector<unsigned char>> Prefixes={{},{0x66}};for(unsigned R=0x40;R<=0x4f;R++)Prefixes.push_back({(unsigned char)R});for(unsigned R=0x40;R<=0x4f;R++)Prefixes.push_back({0x66,(unsigned char)R});
 unsigned Checked=0,Valid=0,Unexpected=0,Truncated=0;
 for(const auto& Prefix:Prefixes)for(unsigned Kind=0;Kind<2;Kind++)for(unsigned RM=0;RM<8;RM++)for(unsigned N=0;N<(Kind?12u:8u);N++){
  const unsigned Immediates[]={0,1,7,15,16,31,32,63,64,127,128,255};auto Bytes=Prefix;Bytes.push_back(15);Bytes.push_back(Kind?0xba:0xa3);Bytes.push_back(0xc0+((Kind?4:N)<<3)+RM);if(Kind)Bytes.push_back(Immediates[N]);
  const auto Plan=fexwasm::broker::Admit(Bytes.data(),Bytes.size());if(!Plan.Supported||Plan.Operation!=6||Plan.Width||Plan.Length!=Bytes.size()||!Plan.BitWidth||Plan.TestWidth||Plan.SetCondition!=16)return 30;
  for(unsigned L=0;L<Bytes.size();L++){if(fexwasm::broker::Admit(Bytes.data(),L).Supported)return 31;Truncated++;}
  constexpr uint64_t RIP=0x123400008000;if(!Host.MapGuest(RIP,Bytes.data(),Bytes.size()))return 32;uint64_t Insts=0;const auto* Original=Host.GenerateIR(RIP,&Insts);if(!Original||Insts!=1||Host.InstructionLength(RIP)!=Plan.Length)return 33;
  for(const auto& C:Cases){
   std::vector<unsigned char> Data(Original->GetDataSize()),List(Original->GetListSize());std::memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());std::memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());IRListView IR(Data.data(),List.data(),Data.size(),List.size());BitShape S(IR,Plan.Register,Plan.BitRegister);
   if(!S.Source||!S.Bit||!S.Read||!S.Merge||!S.Carry||!S.Store||!S.Marker||!S.Exit||(!Kind&&(!S.Index||!S.Shift)))return 34;if(C.Applicable&&!C.Applicable(S))continue;C.Change(S);
   fexwasm::BackendConfig Cfg;Cfg.BrokerMemory=true;Cfg.BrokerOperation=6;Cfg.BrokerTargetRegister=Plan.Register;Cfg.BrokerBitWidth=Plan.BitWidth;Cfg.BrokerBitRegister=Plan.BitRegister;Cfg.BrokerBitIndex=Plan.BitIndex;Cfg.BrokerNextRIP=RIP+Plan.Length;Cfg.SharedMemory=true;Cfg.ThreadBaseGlobal=true;Cfg.MemPages=Cfg.MemMaxPages=fexwasm::broker::Pages;Cfg.RegArgs=0;Cfg.CallsViaDispatcher=false;
   if(!strcmp(C.Name,"profile-width"))Cfg.BrokerBitWidth=1;if(!strcmp(C.Name,"profile-operation"))Cfg.BrokerOperation=0;if(!strcmp(C.Name,"profile-wire-width"))Cfg.BrokerWidth=1;
   if(!strcmp(C.Name,"profile-base"))Cfg.BrokerTargetRegister^=1;if(!strcmp(C.Name,"profile-index"))Cfg.BrokerBitRegister=Kind?0:Plan.BitRegister^1;if(!strcmp(C.Name,"profile-bit"))Cfg.BrokerBitIndex^=1;
   if(!strcmp(C.Name,"profile-index-domain"))Cfg.BrokerBitRegister=17;if(!strcmp(C.Name,"profile-bit-domain"))Cfg.BrokerBitIndex=Plan.BitWidth*8;if(!strcmp(C.Name,"profile-flow"))Cfg.BrokerFlow=1;
   if(!strcmp(C.Name,"profile-target"))Cfg.BrokerTarget=RIP;if(!strcmp(C.Name,"profile-NOP"))Cfg.BrokerNoEffects=true;if(!strcmp(C.Name,"profile-TEST"))Cfg.BrokerTestWidth=1;
   if(!strcmp(C.Name,"profile-SETcc"))Cfg.BrokerSetCondition=0;if(!strcmp(C.Name,"profile-next"))Cfg.BrokerNextRIP++;if(!strcmp(C.Name,"profile-shared"))Cfg.SharedMemory=false;
   const auto R=fexwasm::Compile(IR,RIP,Cfg);const bool Expected=!strcmp(C.Name,"valid"),OK=Expected?(R.Error.empty()&&!R.Module.empty()):(!R.Error.empty()&&R.Module.empty());Checked++;Valid+=Expected;Unexpected+=!OK;
   printf("BT width%u kind%u base%u index%u %s: %s%s\n",Plan.BitWidth*8,Kind,Plan.Register,Kind?Plan.BitIndex:Plan.BitRegister,C.Name,R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
  }Host.Release();
 }
 printf("checked %u actual register-BT IR copies; valid %u; unexpected %u; raw truncations %u\n",Checked,Valid,Unexpected,Truncated);return Unexpected?1:0;
}
int main(){
 const Case Cases[]={
  {"valid",[](Shape&){}},
  {"profile-width",[](Shape&){}},{"profile-wire-width",[](Shape&){}},{"profile-operation",[](Shape&){}},
  {"profile-shift",[](Shape&){}},{"profile-mask",[](Shape&){}},{"profile-mask-domain",[](Shape&){}},
  {"profile-register",[](Shape&){}},{"profile-flow",[](Shape&){}},{"profile-target",[](Shape&){}},
  {"profile-fallthrough",[](Shape&){}},{"profile-no-effects",[](Shape&){}},
  {"wrong-source-register",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Reg^=1;}},
  {"wrong-source-class",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Class=RegClass::FPR;}},
  {"wrong-source-width",[](Shape& S){S.Op(S.Source)->Size=OpSize::i32Bit;}},
  {"source-after-flags",[](Shape& S){S.After(S.Source,S.Flags);}},
  {"wrong-extract-width",[](Shape& S){S.Op(S.Extract)->Size=OpSize::i64Bit;},[](const Shape& S){return S.Extract!=nullptr;}},
  {"wrong-extract-shift",[](Shape& S){S.IR.GetOp<IROp_InlineConstant>(S.Op(S.Extract)->Args[1])->Constant=7;},[](const Shape& S){return S.Extract!=nullptr;}},
  {"extract-before-source",[](Shape& S){S.Before(S.Extract,S.Source);},[](const Shape& S){return S.Extract!=nullptr;}},
  {"extract-after-flags",[](Shape& S){S.After(S.Extract,S.Flags);},[](const Shape& S){return S.Extract!=nullptr;}},
  {"wrong-AND-mask",[](Shape& S){S.IR.GetOp<IROp_InlineConstant>(S.Op(S.And)->Args[1])->Constant^=1;},[](const Shape& S){return S.And!=nullptr;}},
  {"wrong-AND-source",[](Shape& S){S.Op(S.And)->Args[0]=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;},[](const Shape& S){return S.And!=nullptr;}},
  {"wrong-AND-width",[](Shape& S){S.Op(S.And)->Size=OpSize::i128Bit;},[](const Shape& S){return S.And!=nullptr;}},
  {"nonlogical-result",[](Shape& S){S.Op(S.And)->Op=OP_OR;},[](const Shape& S){return S.And!=nullptr;}},
  {"wrong-flag-producer",[](Shape& S){S.Op(S.Flags)->Op=OP_ADDWITHFLAGS;}},
  {"wrong-flag-width",[](Shape& S){S.Op(S.Flags)->Size=OpSize::i128Bit;}},
  {"wrong-sub-zero",[](Shape& S){S.IR.GetOp<IROp_InlineConstant>(S.Op(S.Flags)->Args[1])->Constant=1;},[](const Shape& S){const auto O=S.IR.GetOp<IROp_Header>(S.Flags)->Op;return O==OP_SUBNZCV||O==OP_SUBWITHFLAGS;}},
  {"flags-before-source",[](Shape& S){S.Before(S.Flags,S.Source);}},
  {"wrong-invalidation-mask",[](Shape& S){S.IR.GetOp<IROp_InvalidateFlags>(S.Invalidate)->Flags=1;}},
  {"wrong-invalidation-width",[](Shape& S){S.Op(S.Invalidate)->Size=OpSize::i32Bit;}},
  {"invalidation-before-flags",[](Shape& S){S.Before(S.Invalidate,S.Flags);}},
  {"invalidation-after-PF",[](Shape& S){S.After(S.Invalidate,S.PF);}},
  {"wrong-PF-value",[](Shape& S){S.Op(S.PF)->Args[0]=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;}},
  {"wrong-PF-width",[](Shape& S){S.Op(S.PF)->Size=OpSize::i32Bit;}},
  {"PF-before-flags",[](Shape& S){S.Before(S.PF,S.Flags);}},
  {"wrong-carry-mask",[](Shape& S){S.IR.GetOp<IROp_InlineConstant>(S.Op(S.Carry)->Args[1])->Constant=0x10000000;},[](const Shape& S){return S.Carry!=nullptr;}},
  {"wrong-carry-width",[](Shape& S){S.Op(S.Carry)->Size=OpSize::i64Bit;},[](const Shape& S){return S.Carry!=nullptr;}},
  {"stale-NZCV-read",[](Shape& S){S.Before(S.ReadNZCV,S.Flags);},[](const Shape& S){return S.ReadNZCV!=nullptr;}},
  {"carry-before-read",[](Shape& S){S.Before(S.Carry,S.ReadNZCV);},[](const Shape& S){return S.Carry!=nullptr;}},
  {"NZCV-store-before-carry",[](Shape& S){S.Before(S.StoreNZCV,S.Carry);},[](const Shape& S){return S.Carry!=nullptr;}},
  {"wrong-NZCV-store-width",[](Shape& S){S.Op(S.StoreNZCV)->Size=OpSize::i64Bit;},[](const Shape& S){return S.StoreNZCV!=nullptr;}},
  {"extra-memory-read",[](Shape& S){S.Op(S.Marker)->Op=OP_LOADMEM;}},
  {"extra-memory-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREMEM;}},
  {"extra-GPR-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREREGISTER;}},
  {"extra-context-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STORECONTEXT;}},
  {"extra-AF-write",[](Shape& S){S.Op(S.PF)->Op=OP_STOREAF;}},
  {"extra-flag-read",[](Shape& S){S.Op(S.Marker)->Op=OP_LOADPF;}},
  {"extra-syscall",[](Shape& S){S.Op(S.Marker)->Op=OP_SYSCALL;}},
  {"early-exit",[](Shape& S){S.Before(S.Exit,S.Flags);}},
  {"PF-after-exit",[](Shape& S){S.After(S.PF,S.Exit);}},
  {"call-exit",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->Hint=BranchHint::Call;}},
  {"variable-exit",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP=S.IR.WrapNode(S.Source);}}
 };
 const std::vector<std::vector<unsigned char>> Prefixes={{0xf6,0xc4},{0xf6,0xc7},{0x40,0xf6,0xc4},{0x41,0xf6,0xc4},{0xa8},{0x66,0xa8},{0x66,0xf7,0xc0},{0x66,0x41,0xf7,0xc4},{0x66,0x41,0xa9},{0xf7,0xc0},{0x41,0xf7,0xc4},{0x41,0xa9},{0x48,0xf7,0xc0},{0x49,0xf7,0xc4},{0x49,0xa9},{0x66,0x49,0xa9}};
 fexwasm::FexHost::Options HO;HO.MaxInstructions=1;HO.DebugGuestInstructions=true;HO.Multiblock=false;fexwasm::FexHost Host(HO);unsigned Checked=0,Valid=0,Unexpected=0;
 for(const auto& Prefix:Prefixes)for(unsigned MaskIndex=0;MaskIndex<5;MaskIndex++){
  const bool Byte=Prefix.back()==0xa8||(Prefix.size()>1&&Prefix[Prefix.size()-2]==0xf6);
  bool Word=false,RexW=false;for(auto B:Prefix){Word|=B==0x66;RexW|=B>=0x48&&B<=0x4f;}
  const unsigned Width=Byte?1:RexW?8:Word?2:4,ImmWidth=Width==8?4:Width;
  const uint32_t Masks[]={0,1,(1u<<(ImmWidth*8-1))-1,1u<<(ImmWidth*8-1),ImmWidth==4?~0u:(1u<<(ImmWidth*8))-1};
  auto Bytes=Prefix;for(unsigned I=0;I<ImmWidth;I++)Bytes.push_back(Masks[MaskIndex]>>(I*8));
  const auto Plan=fexwasm::broker::Admit(Bytes.data(),Bytes.size());if(!Plan.Supported||Plan.Operation!=6||Plan.TestWidth!=Width||Plan.Length!=Bytes.size())return 2;
  constexpr uint64_t RIP=0x123400008000;if(!Host.MapGuest(RIP,Bytes.data(),Bytes.size()))return 3;uint64_t Instructions=0;const auto* Original=Host.GenerateIR(RIP,&Instructions);if(!Original||Instructions!=1||Host.InstructionLength(RIP)!=Plan.Length)return 4;
  for(const auto& C:Cases){
   std::vector<unsigned char> Data(Original->GetDataSize()),List(Original->GetListSize());std::memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());std::memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());IRListView IR(Data.data(),List.data(),Data.size(),List.size());Shape S(IR);
   if(!S.Source||!S.Flags||!S.Invalidate||!S.PF||!S.Marker||!S.Exit)return 5;if(C.Applicable&&!C.Applicable(S))continue;C.Mutate(S);
   fexwasm::BackendConfig Cfg;Cfg.BrokerMemory=true;Cfg.BrokerOperation=6;Cfg.BrokerWidth=0;Cfg.BrokerTestWidth=Plan.TestWidth;Cfg.BrokerTestShift=Plan.TestShift;Cfg.BrokerTestMask=Plan.TestMask;Cfg.BrokerTargetRegister=Plan.Register;Cfg.BrokerNextRIP=RIP+Plan.Length;Cfg.SharedMemory=true;Cfg.ThreadBaseGlobal=true;Cfg.MemPages=Cfg.MemMaxPages=fexwasm::broker::Pages;Cfg.RegArgs=0;Cfg.CallsViaDispatcher=false;
   if(!std::strcmp(C.Name,"profile-width"))Cfg.BrokerTestWidth=3;
   if(!std::strcmp(C.Name,"profile-wire-width"))Cfg.BrokerWidth=1;
   if(!std::strcmp(C.Name,"profile-operation"))Cfg.BrokerOperation=0;
   if(!std::strcmp(C.Name,"profile-shift"))Cfg.BrokerTestShift=1;
   if(!std::strcmp(C.Name,"profile-mask"))Cfg.BrokerTestMask^=1;
   if(!std::strcmp(C.Name,"profile-mask-domain"))Cfg.BrokerTestMask=1ull<<63;
   if(!std::strcmp(C.Name,"profile-register"))Cfg.BrokerTargetRegister=16;
   if(!std::strcmp(C.Name,"profile-flow"))Cfg.BrokerFlow=1;
   if(!std::strcmp(C.Name,"profile-target"))Cfg.BrokerTarget=RIP;
   if(!std::strcmp(C.Name,"profile-fallthrough"))Cfg.BrokerNextRIP++;
   if(!std::strcmp(C.Name,"profile-no-effects"))Cfg.BrokerNoEffects=true;
   const auto R=fexwasm::Compile(IR,RIP,Cfg);const bool Expected=!std::strcmp(C.Name,"valid"),OK=Expected?(R.Error.empty()&&!R.Module.empty()):(!R.Error.empty()&&R.Module.empty());Checked++;Valid+=Expected;Unexpected+=!OK;printf("%s width%u mask%u: %s%s\n",C.Name,Width*8,MaskIndex,R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
  }Host.Release();
 }
 printf("checked %u actual immediate-TEST IR copies; valid %u; unexpected %u\n",Checked,Valid,Unexpected);const int Logical=CheckAccumulatorLogical(Host),Bit=CheckBitTest(Host);return Unexpected||Logical||Bit?1:0;
}
