// SPDX-License-Identifier: GPL-3.0-or-later
// Strict register SETcc proofs against copies of actual FEX frontend IR.
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
 const IRListView& IR; Ref Source{},Condition{},PF{},Merge{},Store{},Marker{},Exit{};
 explicit Shape(const IRListView& View):IR(View){
  for(auto [Block,Header]:IR.GetBlocks())for(auto [Node,H]:IR.GetCode(Block))switch(H->Op){
  case OP_LOADREGISTER:Source=Node;break;case OP_NZCVSELECT:case OP_PARITY:Condition=Node;break;
  case OP_LOADPF:PF=Node;break;case OP_BFI:Merge=Node;break;case OP_STOREREGISTER:Store=Node;break;
  case OP_GUESTOPCODE:Marker=Node;break;case OP_EXITFUNCTION:Exit=Node;break;default:break;}
 }
 IROp_Header* Op(Ref N){return IR.GetOp<IROp_Header>(N);}
 void Before(Ref N,Ref T){N->Unlink(IR.GetListData());T->prepend(IR.GetListData(),N);}
 void After(Ref N,Ref T){N->Unlink(IR.GetListData());T->append(IR.GetListData(),N);}
 bool Parity()const{return PF!=nullptr;}
};
struct Case{const char* Name;std::function<void(Shape&)> Mutate;int Kind=0;};
int main(){
 const Case Cases[]={
  {"valid",[](Shape&){}},
  {"profile-condition",[](Shape&){}},{"profile-wire-width",[](Shape&){}},{"profile-operation",[](Shape&){}},
  {"profile-register",[](Shape&){}},{"profile-shift",[](Shape&){}},{"profile-flow",[](Shape&){}},
  {"profile-target",[](Shape&){}},{"profile-next",[](Shape&){}},{"profile-no-effects",[](Shape&){}},
  {"profile-TEST",[](Shape&){}},
  {"wrong-load-register",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Reg^=1;}},
  {"wrong-load-class",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Class=RegClass::FPR;}},
  {"wrong-load-width",[](Shape& S){S.Op(S.Source)->Size=OpSize::i32Bit;}},
  {"wrong-condition-width",[](Shape& S){S.Op(S.Condition)->Size=OpSize::i128Bit;}},
  {"wrong-condition",[](Shape& S){S.IR.GetOp<IROp_NZCVSelect>(S.Condition)->Cond=CondClass::AL;},1},
  {"wrong-true-value",[](Shape& S){const auto V=S.IR.GetOp<IROp_NZCVSelect>(S.Condition)->TrueVal;S.IR.GetOp<IROp_InlineConstant>(V)->Constant=2;},1},
  {"wrong-false-value",[](Shape& S){const auto V=S.IR.GetOp<IROp_NZCVSelect>(S.Condition)->FalseVal;S.IR.GetOp<IROp_InlineConstant>(V)->Constant=1;},1},
  {"condition-constant-after-use",[](Shape& S){const auto V=S.IR.GetOp<IROp_NZCVSelect>(S.Condition)->TrueVal;S.After(S.IR.GetNode(V),S.Condition);},1},
  {"wrong-PF-width",[](Shape& S){S.Op(S.PF)->Size=OpSize::i32Bit;},2},
  {"wrong-parity-source",[](Shape& S){S.IR.GetOp<IROp_Parity>(S.Condition)->Raw=S.IR.WrapNode(S.Source);},2},
  {"wrong-parity-mask",[](Shape& S){S.IR.GetOp<IROp_Parity>(S.Condition)->Mask=false;},2},
  {"wrong-parity-invert",[](Shape& S){auto P=S.IR.GetOp<IROp_Parity>(S.Condition);P->Invert=!P->Invert;},2},
  {"PF-after-condition",[](Shape& S){S.After(S.PF,S.Condition);},2},
  {"source-before-condition",[](Shape& S){S.Before(S.Source,S.Condition);}},
  {"condition-after-merge",[](Shape& S){S.After(S.Condition,S.Merge);}},
  {"merge-before-source",[](Shape& S){S.Before(S.Merge,S.Source);}},
  {"wrong-merge-width",[](Shape& S){S.Op(S.Merge)->Size=OpSize::i32Bit;}},
  {"wrong-byte-width",[](Shape& S){S.IR.GetOp<IROp_Bfi>(S.Merge)->Width=16;}},
  {"wrong-byte-shift",[](Shape& S){S.IR.GetOp<IROp_Bfi>(S.Merge)->lsb^=8;}},
  {"wrong-old-destination",[](Shape& S){S.IR.GetOp<IROp_Bfi>(S.Merge)->Dest=S.IR.WrapNode(S.Condition);}},
  {"wrong-merge-value",[](Shape& S){S.IR.GetOp<IROp_Bfi>(S.Merge)->Src=S.IR.WrapNode(S.Source);}},
  {"wrong-store-value",[](Shape& S){S.IR.GetOp<IROp_StoreRegister>(S.Store)->Value=S.IR.WrapNode(S.Source);}},
  {"wrong-store-register",[](Shape& S){const auto R=PhysicalRegister(S.Store);S.Store->Reg=PhysicalRegister(RegClass::GPRFixed,R.Reg^1).Raw;}},
  {"wrong-store-class",[](Shape& S){const auto R=PhysicalRegister(S.Store);S.Store->Reg=PhysicalRegister(RegClass::FPRFixed,R.Reg).Raw;}},
  {"wrong-store-width",[](Shape& S){S.Op(S.Store)->Size=OpSize::i32Bit;}},
  {"store-before-merge",[](Shape& S){S.Before(S.Store,S.Merge);}},
  {"early-exit",[](Shape& S){S.Before(S.Exit,S.Store);}},
  {"effect-after-exit",[](Shape& S){S.After(S.Source,S.Exit);}},
  {"variable-exit",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP=S.IR.WrapNode(S.Source);}},
  {"call-exit",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->Hint=BranchHint::Call;}},
  {"extra-memory-read",[](Shape& S){S.Op(S.Marker)->Op=OP_LOADMEM;}},
  {"extra-memory-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREMEM;}},
  {"extra-context-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STORECONTEXT;}},
  {"extra-flag-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STORENZCV;}},
  {"extra-AF-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREAF;}},
  {"extra-PF-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREPF;}},
  {"extra-GPR-read",[](Shape& S){S.Op(S.Marker)->Op=OP_LOADREGISTER;}},
  {"extra-GPR-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREREGISTER;}},
  {"extra-syscall",[](Shape& S){S.Op(S.Marker)->Op=OP_SYSCALL;}}
 };
 fexwasm::FexHost::Options HO;HO.MaxInstructions=1;HO.DebugGuestInstructions=true;HO.Multiblock=false;fexwasm::FexHost Host(HO);
 unsigned Checked=0,Valid=0,Unexpected=0,RawRefused=0;
 for(unsigned CC=0;CC<16;CC++)for(unsigned Form=0;Form<8;Form++){
  const std::vector<std::vector<unsigned char>> Prefixes={{},{},{0x40},{0x41},{0x4f},{0x66,0x44},{0x66},{0x66,0x4f}};
  const unsigned char ModRM[]={0xc0,0xc4,0xc4,0xc4,0xfc,0xe4,0xfc,0xff};
  auto Bytes=Prefixes[Form];Bytes.insert(Bytes.end(),{0x0f,(unsigned char)(0x90+CC),ModRM[Form]});
  const auto Plan=fexwasm::broker::Admit(Bytes.data(),Bytes.size());if(!Plan.Supported||Plan.Operation!=6||Plan.SetCondition!=CC||Plan.Length!=Bytes.size())return 2;
  constexpr uint64_t RIP=0x123400008000;if(!Host.MapGuest(RIP,Bytes.data(),Bytes.size()))return 3;
  uint64_t Instructions=0;const auto* Original=Host.GenerateIR(RIP,&Instructions);if(!Original||Instructions!=1||Host.InstructionLength(RIP)!=Plan.Length)return 4;
  for(const auto& C:Cases){
   std::vector<unsigned char> Data(Original->GetDataSize()),List(Original->GetListSize());std::memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());std::memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());IRListView IR(Data.data(),List.data(),Data.size(),List.size());Shape S(IR);
   if(!S.Source||!S.Condition||!S.Merge||!S.Store||!S.Marker||!S.Exit)return 5;
   if((C.Kind==1&&S.Parity())||(C.Kind==2&&!S.Parity()))continue;C.Mutate(S);
   fexwasm::BackendConfig Cfg;Cfg.BrokerMemory=true;Cfg.BrokerOperation=6;Cfg.BrokerSetCondition=Plan.SetCondition;Cfg.BrokerSetShift=Plan.SetShift;Cfg.BrokerTargetRegister=Plan.Register;Cfg.BrokerNextRIP=RIP+Plan.Length;Cfg.SharedMemory=true;Cfg.ThreadBaseGlobal=true;Cfg.MemPages=Cfg.MemMaxPages=fexwasm::broker::Pages;Cfg.RegArgs=0;Cfg.CallsViaDispatcher=false;
   if(!strcmp(C.Name,"profile-condition"))Cfg.BrokerSetCondition=17;
   if(!strcmp(C.Name,"profile-wire-width"))Cfg.BrokerWidth=1;
   if(!strcmp(C.Name,"profile-operation"))Cfg.BrokerOperation=0;
   if(!strcmp(C.Name,"profile-register"))Cfg.BrokerTargetRegister=16;
   if(!strcmp(C.Name,"profile-shift"))Cfg.BrokerSetShift=1;
   if(!strcmp(C.Name,"profile-flow"))Cfg.BrokerFlow=1;
   if(!strcmp(C.Name,"profile-target"))Cfg.BrokerTarget=RIP;
   if(!strcmp(C.Name,"profile-next"))Cfg.BrokerNextRIP++;
   if(!strcmp(C.Name,"profile-no-effects"))Cfg.BrokerNoEffects=true;
   if(!strcmp(C.Name,"profile-TEST"))Cfg.BrokerTestWidth=1;
   const auto R=fexwasm::Compile(IR,RIP,Cfg);const bool Expected=!strcmp(C.Name,"valid"),OK=Expected?(R.Error.empty()&&!R.Module.empty()):(!R.Error.empty()&&R.Module.empty());Checked++;Valid+=Expected;Unexpected+=!OK;
   printf("%s cc%u form%u: %s%s\n",C.Name,CC,Form,R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
  }Host.Release();
 }
 // Independently verify the whole bounded prefix/ignored-ModRM grammar and
 // refuse every memory ModRM, truncation and excluded prefix before FEX.
 for(unsigned CC=0;CC<16;CC++)for(unsigned Word=0;Word<2;Word++)for(unsigned Rex=0;Rex<17;Rex++)for(unsigned M=0;M<256;M++){
  std::vector<unsigned char> B;if(Word)B.push_back(0x66);if(Rex)B.push_back(0x3f+Rex);B.insert(B.end(),{0x0f,(unsigned char)(0x90+CC),(unsigned char)M});
  const auto A=fexwasm::broker::Admit(B.data(),B.size());const bool Supported=M>=0xc0;
  const unsigned Low=M&7,Register=!Rex&&Low>=4?Low-4:Low+((Rex&&(Rex-1)&1)?8:0),Shift=!Rex&&Low>=4?8:0;
  if(A.Supported!=Supported||(Supported&&(A.SetCondition!=CC||A.Register!=Register||A.SetShift!=Shift||A.Length!=B.size())))return 6;
  if(!Supported)RawRefused++;
  for(unsigned N=0;N<B.size();N++)if(fexwasm::broker::Admit(B.data(),N).Supported)return 7;
 }
 for(const auto& P:std::vector<std::vector<unsigned char>>{{0x67},{0x64},{0x65},{0xf0},{0xf2},{0xf3},{0x2e},{0x66,0x66},{0x40,0x66},{0x41,0x66},{0x40,0x41}}){auto B=P;B.insert(B.end(),{0x0f,0x94,0xc4});if(fexwasm::broker::Admit(B.data(),B.size()).Supported)return 8;RawRefused++;}
 printf("checked %u actual SETcc IR copies; valid %u; unexpected %u; raw refused %u\n",Checked,Valid,Unexpected,RawRefused);return Unexpected?1:0;
}
