// SPDX-License-Identifier: GPL-3.0-or-later
// Portable admission sweeps and mutations of copied, actual FEX word-CMP IR.
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
  Ref Load{}, Source{}, Flags{}, Difference{}, Auxiliary{}, AF{}, PF{}, Marker{}, Exit{};
  Shape(const IRListView& V):IR(V){for(auto [Block,Header]:IR.GetBlocks())for(auto [N,H]:IR.GetCode(Block))switch(H->Op){
    case OP_LOADREGISTER:if(!Source)Source=N;break;
    case OP_LOADMEM:case OP_LOADMEMTSO:Load=N;break;
    case OP_SUBNZCV:Flags=N;break;case OP_SUB:Difference=N;break;case OP_NOT:Auxiliary=N;break;
    case OP_STOREAF:AF=N;break;case OP_STOREPF:PF=N;break;
    case OP_GUESTOPCODE:Marker=N;break;case OP_EXITFUNCTION:Exit=N;break;default:break;
  }}
  IROp_Header* Op(Ref N){return IR.GetOp<IROp_Header>(N);}
  void Before(Ref N,Ref Target){N->Unlink(IR.GetListData());Target->prepend(IR.GetListData(),N);}
  void After(Ref N,Ref Target){N->Unlink(IR.GetListData());Target->append(IR.GetListData(),N);}
  void Constant(OrderedNodeWrapper W,uint64_t Value){auto H=IR.GetOp<IROp_Header>(W);if(H->Op==OP_INLINECONSTANT)IR.GetOp<IROp_InlineConstant>(W)->Constant=Value;else IR.GetOp<IROp_Constant>(W)->Constant=Value;}
  uint64_t Value(OrderedNodeWrapper W){auto H=IR.GetOp<IROp_Header>(W);return H->Op==OP_INLINECONSTANT?H->C<IROp_InlineConstant>()->Constant:H->C<IROp_Constant>()->Constant;}
};
struct Case {const char* Name;std::function<void(Shape&)> Change;std::function<bool(Shape&)> Applies{};};
static fexwasm::BackendConfig Config(const fexwasm::broker::Admission& P,uint64_t RIP){
 fexwasm::BackendConfig C;C.BrokerMemory=true;C.BrokerOperation=8;C.BrokerWidth=2;C.BrokerNextRIP=RIP+P.Length;
 C.BrokerWordCompare=P.WordCompare;C.BrokerCompareImmediate=P.CompareImmediate;C.BrokerCompareBase=P.CompareBase;C.BrokerCompareIndex=P.CompareIndex;C.BrokerCompareScale=P.CompareScale;C.BrokerCompareDisplacement=P.CompareDisplacement;C.BrokerCompareRIPRelative=P.CompareRIPRelative;
 C.SharedMemory=true;C.ThreadBaseGlobal=true;C.MemPages=C.MemMaxPages=fexwasm::broker::Pages;C.RegArgs=0;C.CallsViaDispatcher=false;return C;
}
// Keep the frontend's actual instruction/effect graph and replace only its
// load-offset node. Extra data space avoids writing a larger IROp_Constant
// over the following packed operation in the copied frontend buffer.
static unsigned ScaleControls(fexwasm::FexHost& Host) {
 constexpr uint64_t RIP=0x123400008000;
 unsigned Checked=0, Unexpected=0;
 for(unsigned Opcode:{0x81,0x83})for(unsigned Mask:{0u,16u})for(unsigned Rex:{0u,0x41u})for(int Disp:{64,-64}) {
  std::vector<uint8_t> Code={0x66};if(Rex)Code.push_back(Rex);
  Code.insert(Code.end(),{uint8_t(Opcode),0x78,uint8_t(Disp),uint8_t(Mask)});if(Opcode==0x81)Code.push_back(0);
  const auto P=fexwasm::broker::Admit(Code.data(),Code.size());
  Host.MapGuest(RIP,Code.data(),Code.size());uint64_t N=0;const auto* Original=Host.GenerateIR(RIP,&N);
  if(!P.Supported||!Original||N!=1) return 1;
  for(unsigned Scale:{2u,4u,8u})for(IROps Kind:{OP_INLINECONSTANT,OP_CONSTANT,OP_ENTRYPOINTOFFSET,OP_INLINEENTRYPOINTOFFSET,OP_LOADREGISTER})for(bool Correct:{true,false}) {
   std::vector<uint8_t> Data(Original->GetDataSize()+sizeof(IROp_Constant)),List(Original->GetListSize());
   memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Original->GetDataSize());
   memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());
   IRListView IR(Data.data(),List.data(),Data.size(),List.size());Shape S(IR);auto* L=IR.GetOp<IROp_LoadMem>(S.Load);
   if(L->Offset.IsInvalid()||IR.GetOp<IROp_Header>(L->Offset)->Op!=OP_INLINECONSTANT||int64_t(S.Value(L->Offset))!=Disp) return 1;
   auto* Replacement=reinterpret_cast<IROp_Header*>(Data.data()+Original->GetDataSize());
   *Replacement=*IR.GetOp<IROp_Header>(L->Offset);Replacement->Op=Kind;
   IR.GetNode(L->Offset)->Header.Value.SetOffset(IR.GetData(),reinterpret_cast<uintptr_t>(Replacement));
   const bool Inline=Kind==OP_INLINECONSTANT;
   const int64_t Value=Inline?(Correct?Disp:Disp/int(Scale)):(Correct?Disp/int(Scale):Disp);
   if(Kind==OP_INLINECONSTANT)reinterpret_cast<IROp_InlineConstant*>(Replacement)->Constant=Value;
   if(Kind==OP_CONSTANT)reinterpret_cast<IROp_Constant*>(Replacement)->Constant=Value;
   if(Kind==OP_ENTRYPOINTOFFSET)reinterpret_cast<IROp_EntrypointOffset*>(Replacement)->Offset=uint64_t(Value)-RIP;
   if(Kind==OP_INLINEENTRYPOINTOFFSET)reinterpret_cast<IROp_InlineEntrypointOffset*>(Replacement)->Offset=uint64_t(Value)-RIP;
   auto Cfg=Config(P,RIP);L->OffsetScale=Scale;
   if(Kind==OP_LOADREGISTER) {
    auto* R=reinterpret_cast<IROp_LoadRegister*>(Replacement);R->Reg=1;R->Class=RegClass::GPR;
    Cfg.BrokerCompareDisplacement=0;Cfg.BrokerCompareIndex=1;Cfg.BrokerCompareScale=Correct?Scale:1;
   }
   const auto R=fexwasm::Compile(IR,RIP,Cfg);
   const bool OK=Correct?(R.Error.empty()&&!R.Module.empty()):(!R.Error.empty()&&R.Module.empty());
   Checked++;Unexpected+=!OK;
   printf("word-CMP scale-control opcode%02x mask%u rex%u disp%d kind%u scale%u %s: %s%s\n",Opcode,Mask,Rex,Disp,unsigned(Kind),Scale,Correct?"correct-address":"wrong-address",R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
  }
  Host.Release();Host.DiscardIR(RIP);
 }
 printf("checked %u copied actual word-CMP offset-scale controls; unexpected %u\n",Checked,Unexpected);
 return Unexpected;
}
int main(){
 unsigned ImmediateChecks=0,AddressChecks=0,Truncations=0,Checked=0,Valid=0,Unexpected=0;
 // Exhaustive immediate bit patterns for one ordinary address encoding.
 // Separate address/REX sweeps below use sampled immediate boundaries.
 for(unsigned Opcode:{0x81,0x83})for(unsigned Raw=0;Raw<(Opcode==0x83?256u:65536u);Raw++){
  std::vector<uint8_t>C={0x66,uint8_t(Opcode),0x78,6,uint8_t(Raw)};if(Opcode==0x81)C.push_back(Raw>>8);auto P=fexwasm::broker::Admit(C.data(),C.size());const unsigned Expected=Opcode==0x83&&(Raw&128)?Raw|0xff00:Raw;
  if(!P.Supported||!P.WordCompare||P.Operation!=8||P.Width!=2||P.CompareImmediate!=Expected||P.CompareBase!=0||P.CompareIndex!=-1||P.CompareScale!=1||P.CompareDisplacement!=6||P.CompareRIPRelative||P.Length!=C.size())return 10;ImmediateChecks++;
 }
 for(unsigned Rex=0;Rex<=8;Rex++)for(unsigned Opcode:{0x81,0x83})for(unsigned Mod=0;Mod<3;Mod++)for(unsigned RM=0;RM<8;RM++)for(unsigned SIB=0;SIB<(RM==4?256u:1u);SIB++)for(unsigned Mask:{0u,1u,15u,16u,0x7fu,0x80u,0x8000u,0xffffu}){
  const unsigned R=Rex?0x3f+Rex:0,Bytes=Mod==1?1:Mod==2||(Mod==0&&(RM==5||(RM==4&&(SIB&7)==5)))?4:0;
  std::vector<uint8_t>C={0x66};if(R)C.push_back(R);C.push_back(Opcode);C.push_back((Mod<<6)|0x38|RM);if(RM==4)C.push_back(SIB);for(unsigned I=0;I<Bytes;I++)C.push_back(I?0:6);C.push_back(Mask);if(Opcode==0x81)C.push_back(Mask>>8);auto P=fexwasm::broker::Admit(C.data(),C.size());
  const bool Excluded=RM==4&&Mod==0&&(SIB&7)==5&&(R&1);if(P.Supported==Excluded)return 11;
  if(!Excluded){const bool RIPRelative=RM==5&&Mod==0;const int Base=RIPRelative||(RM==4&&Mod==0&&(SIB&7)==5)?-1:int((RM==4?SIB&7:RM)+((R&1)?8:0));const int Index=RM==4&&((SIB>>3&7)!=4||(R&2))?int((SIB>>3&7)+((R&2)?8:0)):-1;const unsigned Raw=Opcode==0x83?(Mask&255):Mask,Imm=Opcode==0x83&&(Raw&128)?Raw|0xff00:Raw;
   if(!P.WordCompare||P.Operation!=8||P.Width!=2||P.CompareImmediate!=Imm||P.CompareBase!=Base||P.CompareIndex!=Index||P.CompareScale!=(RM==4?1u<<(SIB>>6):1u)||P.CompareDisplacement!=(Bytes?6:0)||P.CompareRIPRelative!=RIPRelative||P.Length!=C.size())return 12;
   for(unsigned N=0;N<C.size();N++){if(fexwasm::broker::Admit(C.data(),N).Supported)return 13;Truncations++;}
  }AddressChecks++;
 }
 const Case Cases[]={
  {"valid",[](Shape&){}},
  {"profile-disabled",[](Shape&){}},{"profile-immediate",[](Shape&){}},{"profile-immediate-domain",[](Shape&){}},
  {"profile-operation",[](Shape&){}},{"profile-width",[](Shape&){}},{"profile-target-register",[](Shape&){}},
  {"profile-base",[](Shape&){}},{"profile-index",[](Shape&){}},{"profile-scale-domain",[](Shape&){}},
  {"profile-displacement",[](Shape&){}},{"profile-displacement-domain",[](Shape&){}},{"profile-rip-relative",[](Shape&){}},
  {"profile-flow",[](Shape&){}},{"profile-target",[](Shape&){}},{"profile-next",[](Shape&){}},
  {"profile-NOP",[](Shape&){}},{"profile-TEST",[](Shape&){}},{"profile-SETcc",[](Shape&){}},{"profile-BT",[](Shape&){}},{"profile-logical",[](Shape&){}},{"profile-shared",[](Shape&){}},
  {"load-width",[](Shape& S){S.Op(S.Load)->Size=OpSize::i32Bit;}},
  {"load-class",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->Class=RegClass::FPR;}},
  {"load-alignment",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->Align=OpSize::i32Bit;}},
  {"load-offset-type",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->OffsetType=MemOffsetType::UXTW;}},
  {"load-offset-scale-domain",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->OffsetScale=3;}},
  {"load-address",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;}},
  {"address-register",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Reg^=1;},[](Shape& S){return bool(S.Source);}},
  {"address-register-width",[](Shape& S){S.Op(S.Source)->Size=OpSize::i32Bit;},[](Shape& S){return bool(S.Source);}},
  {"address-register-class",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Class=RegClass::FPR;},[](Shape& S){return bool(S.Source);}},
  {"address-after-read",[](Shape& S){S.After(S.Source,S.Load);},[](Shape& S){return bool(S.Source);}},
  {"flag-kind",[](Shape& S){S.Op(S.Flags)->Op=OP_ADDWITHFLAGS;}},
  {"flag-width",[](Shape& S){S.Op(S.Flags)->Size=OpSize::i32Bit;}},
  {"flag-source",[](Shape& S){S.Op(S.Flags)->Args[0]=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;}},
  {"flag-immediate",[](Shape& S){auto W=S.Op(S.Flags)->Args[1];S.Constant(W,S.Value(W)^1);}},
  {"flag-immediate-width",[](Shape& S){S.IR.GetOp<IROp_Header>(S.Op(S.Flags)->Args[1])->Size=OpSize::i32Bit;}},
  {"flags-before-read",[](Shape& S){S.Before(S.Flags,S.Load);}},
  {"difference-op",[](Shape& S){S.Op(S.Difference)->Op=OP_ADD;}},
  {"difference-width",[](Shape& S){S.Op(S.Difference)->Size=OpSize::i16Bit;}},
  {"difference-source",[](Shape& S){S.Op(S.Difference)->Args[0]=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;}},
  {"difference-immediate",[](Shape& S){auto W=S.Op(S.Difference)->Args[1];S.Constant(W,S.Value(W)^1);}},
  {"difference-before-flags",[](Shape& S){S.Before(S.Difference,S.Flags);}},
  {"AF-source",[](Shape& S){S.Op(S.AF)->Args[0]=S.IR.WrapNode(S.Difference);}},
  {"AF-width",[](Shape& S){S.Op(S.AF)->Size=OpSize::i32Bit;}},
  {"AF-before-flags",[](Shape& S){S.Before(S.AF,S.Flags);}},
  {"auxiliary-op",[](Shape& S){S.Op(S.Auxiliary)->Op=OP_XOR;},[](Shape& S){return bool(S.Auxiliary);}},
  {"auxiliary-source",[](Shape& S){S.Op(S.Auxiliary)->Args[0]=S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;},[](Shape& S){return bool(S.Auxiliary);}},
  {"auxiliary-width",[](Shape& S){S.Op(S.Auxiliary)->Size=OpSize::i64Bit;},[](Shape& S){return bool(S.Auxiliary);}},
  {"PF-source",[](Shape& S){S.Op(S.PF)->Args[0]=S.IR.WrapNode(S.Load);}},
  {"PF-width",[](Shape& S){S.Op(S.PF)->Size=OpSize::i32Bit;}},
  {"PF-before-AF",[](Shape& S){S.Before(S.PF,S.AF);}},
  {"extra-read",[](Shape& S){S.Op(S.Marker)->Op=OP_LOADMEM;}},
  {"extra-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREMEM;}},
  {"extra-GPR-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREREGISTER;}},
  {"extra-context-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STORECONTEXT;}},
  {"extra-NZCV-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STORENZCV;}},
  {"extra-syscall",[](Shape& S){S.Op(S.Marker)->Op=OP_SYSCALL;}},
  {"effect-after-exit",[](Shape& S){S.After(S.Marker,S.Exit);}},
  {"exit-hint",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->Hint=BranchHint::Call;}},
  {"exit-target",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP=S.IR.WrapNode(S.Load);}},
 };
 fexwasm::FexHost::Options Options;Options.MaxInstructions=1;Options.DebugGuestInstructions=true;Options.Multiblock=false;fexwasm::FexHost Host(Options);constexpr uint64_t RIP=0x123400008000;
 for(unsigned Opcode:{0x81,0x83})for(unsigned Mask:{0u,1u,15u,16u,0x7fu,0x80u,0x7fffu,0x8000u,0xffffu})for(unsigned Form=0;Form<6;Form++){
  if(Opcode==0x83&&Mask>255)continue;std::vector<uint8_t>C={0x66};if(Form==1)C.push_back(0x43);if(Form==5)C.push_back(0x41);C.push_back(Opcode);
  const std::vector<std::vector<uint8_t>> Addresses={{0x78,6},{0x7c,0xac,0x80},{0x3d,6,0,0,0},{0x3c,0x8d,0,0,1,0},{0x3c,0x80},{0x78,6}};for(auto B:Addresses[Form])C.push_back(B);C.push_back(Mask);if(Opcode==0x81)C.push_back(Mask>>8);
  auto P=fexwasm::broker::Admit(C.data(),C.size());if(!P.Supported||!P.WordCompare)return 20;Host.MapGuest(RIP,C.data(),C.size());uint64_t N=0;auto Original=Host.GenerateIR(RIP,&N);if(!Original||N!=1||Host.InstructionLength(RIP)!=C.size())return 21;
  for(const auto& T:Cases){std::vector<uint8_t>Data(Original->GetDataSize()),List(Original->GetListSize());memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());IRListView IR(Data.data(),List.data(),Data.size(),List.size());Shape S(IR);if(T.Applies&&!T.Applies(S))continue;T.Change(S);auto Cfg=Config(P,RIP);
   if(!strcmp(T.Name,"profile-disabled"))Cfg.BrokerWordCompare=false;
   if(!strcmp(T.Name,"profile-immediate"))Cfg.BrokerCompareImmediate^=1;
   if(!strcmp(T.Name,"profile-immediate-domain"))Cfg.BrokerCompareImmediate=65536;
   if(!strcmp(T.Name,"profile-operation"))Cfg.BrokerOperation=1;
   if(!strcmp(T.Name,"profile-width"))Cfg.BrokerWidth=4;
   if(!strcmp(T.Name,"profile-target-register"))Cfg.BrokerTargetRegister=0;
   if(!strcmp(T.Name,"profile-base"))Cfg.BrokerCompareBase=Cfg.BrokerCompareBase==0?1:0;
   if(!strcmp(T.Name,"profile-index"))Cfg.BrokerCompareIndex=Cfg.BrokerCompareIndex==1?2:1;
   if(!strcmp(T.Name,"profile-scale-domain"))Cfg.BrokerCompareScale=3;
   if(!strcmp(T.Name,"profile-displacement"))Cfg.BrokerCompareDisplacement++;
   if(!strcmp(T.Name,"profile-displacement-domain"))Cfg.BrokerCompareDisplacement=1ll<<32;
   if(!strcmp(T.Name,"profile-rip-relative"))Cfg.BrokerCompareRIPRelative=!Cfg.BrokerCompareRIPRelative;
   if(!strcmp(T.Name,"profile-flow"))Cfg.BrokerFlow=1;
   if(!strcmp(T.Name,"profile-target"))Cfg.BrokerTarget=RIP;
   if(!strcmp(T.Name,"profile-next"))Cfg.BrokerNextRIP++;
   if(!strcmp(T.Name,"profile-NOP"))Cfg.BrokerNoEffects=true;
   if(!strcmp(T.Name,"profile-TEST"))Cfg.BrokerTestWidth=2;
   if(!strcmp(T.Name,"profile-SETcc"))Cfg.BrokerSetCondition=0;
   if(!strcmp(T.Name,"profile-BT"))Cfg.BrokerBitWidth=2;
   if(!strcmp(T.Name,"profile-logical"))Cfg.BrokerLogicalWidth=4;
   if(!strcmp(T.Name,"profile-shared"))Cfg.SharedMemory=false;
   const auto R=fexwasm::Compile(IR,RIP,Cfg);const bool Expected=!strcmp(T.Name,"valid"),OK=Expected?(R.Error.empty()&&!R.Module.empty()):(!R.Error.empty()&&R.Module.empty());Checked++;Valid+=Expected;Unexpected+=!OK;
   printf("word-CMP opcode%02x mask%04x form%u %s: %s%s\n",Opcode,Mask,Form,T.Name,R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
  }Host.Release();Host.DiscardIR(RIP);
 }
 printf("checked %u actual word-CMP IR copies; valid %u; unexpected %u; exhaustive immediate patterns %u; sampled address encodings %u; truncations %u\n",Checked,Valid,Unexpected,ImmediateChecks,AddressChecks,Truncations);return (ScaleControls(Host)+Unexpected)?1:0;
}
