// SPDX-License-Identifier: GPL-3.0-or-later
// Mutate copies of actual immediate-TEST FEX IR. No native guest JIT.
#include "backend.h"
#include "broker_step.h"
#include "fexhost.h"
#include "Interface/IR/IR.h"
#include "Interface/IR/IntrusiveIRList.h"
#include <cstdio>
#include <cstring>
#include <functional>
#include <vector>
using namespace FEXCore::IR;
struct Shape {
  const IRListView& IR;
  Ref Source {}, Extract {}, And {}, Flags {}, Invalidate {}, PF {}, ReadNZCV {}, Carry {}, StoreNZCV {}, Marker {}, Exit {};
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
 printf("checked %u actual immediate-TEST IR copies; valid %u; unexpected %u\n",Checked,Valid,Unexpected);return Unexpected?1:0;
}
