// SPDX-License-Identifier: GPL-3.0-or-later
// Mutate copied real FEX stack IR; no native guest JIT or guest execution.
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
 const IRListView& IR;bool Push;unsigned Reg;Ref SP{},Source{},Effect{},Handle{},Output{},Exit{},Marker{};std::vector<Ref> Stores;
 Shape(const IRListView& IR,bool Push,unsigned Reg):IR(IR),Push(Push),Reg(Reg){for(auto [Block,Header]:IR.GetBlocks())for(auto [Node,H]:IR.GetCode(Block))switch(H->Op){
  case OP_LOADREGISTER:if(H->C<IROp_LoadRegister>()->Reg==4)SP=Node;if(H->C<IROp_LoadRegister>()->Reg==Reg)Source=Node;break;
  case OP_PUSH:case OP_POP:Effect=Node;break;case OP_RMWHANDLE:Handle=Node;break;case OP_ALLOCATEGPR:Output=Node;break;
  case OP_STOREREGISTER:Stores.push_back(Node);break;case OP_EXITFUNCTION:Exit=Node;break;case OP_GUESTOPCODE:Marker=Node;break;default:break;
 }}
 IROp_Header* Op(Ref N){return IR.GetOp<IROp_Header>(N);}OrderedNodeWrapper W(Ref N){return IR.WrapNode(N);}
 void Before(Ref N,Ref Target){N->Unlink(IR.GetListData());Target->prepend(IR.GetListData(),N);}
 void After(Ref N,Ref Target){N->Unlink(IR.GetListData());Target->append(IR.GetListData(),N);}
};
struct Case{const char* Name;std::function<void(Shape&,fexwasm::BackendConfig&)> Change;unsigned Kind=0;bool Valid=false;};
int main(){const Case Cases[]={
 {"valid",[](auto&,auto&){},0,true},
 {"valid-reversed-POP-stores",[](auto& S,auto&){S.Before(S.Stores[1],S.Stores[0]);},3,true},
 {"SP-load-width32",[](auto& S,auto&){S.Op(S.SP)->Size=OpSize::i32Bit;}},
 {"SP-load-FPR",[](auto& S,auto&){S.IR.template GetOp<IROp_LoadRegister>(S.SP)->Class=RegClass::FPR;}},
 {"wrong-SP-register",[](auto& S,auto&){S.IR.template GetOp<IROp_LoadRegister>(S.SP)->Reg=3;}},
 {"source-after-effect",[](auto& S,auto&){S.After(S.Source,S.Effect);},1},
 {"wrong-PUSH-source",[](auto& S,auto&){S.IR.template GetOp<IROp_LoadRegister>(S.Source)->Reg=(S.Reg+1)%16;},1},
 {"effect-width32",[](auto& S,auto&){S.Op(S.Effect)->Size=OpSize::i32Bit;}},
 {"PUSH-value-width32",[](auto& S,auto&){S.IR.template GetOp<IROp_Push>(S.Effect)->ValueSize=OpSize::i32Bit;},1},
 {"PUSH-wrong-value",[](auto& S,auto&){S.IR.template GetOp<IROp_Push>(S.Effect)->Value=S.IR.template GetOp<IROp_ExitFunction>(S.Exit)->NewRIP;},1},
 {"PUSH-invalid-address",[](auto& S,auto&){S.IR.template GetOp<IROp_Push>(S.Effect)->Addr=OrderedNodeWrapper{};},1},
 {"POP-wrong-RMW-source",[](auto& S,auto&){S.IR.template GetOp<IROp_RMWHandle>(S.Handle)->Value=S.W(S.Output);},2},
 {"POP-address-not-RMW",[](auto& S,auto&){S.IR.template GetOp<IROp_Pop>(S.Effect)->InoutAddr=S.W(S.SP);},2},
 {"POP-output-aliases-handle",[](auto& S,auto&){S.IR.template GetOp<IROp_Pop>(S.Effect)->OutValue=S.W(S.Handle);},2},
 {"POP-pair-allocation",[](auto& S,auto&){S.IR.template GetOp<IROp_AllocateGPR>(S.Output)->ForPair=true;},2},
 {"POP-operand-width32",[](auto& S,auto&){S.IR.template GetOp<IROp_Pop>(S.Effect)->Size=OpSize::i32Bit;},2},
 {"POP-output-width32",[](auto& S,auto&){S.Op(S.Output)->Size=OpSize::i32Bit;},2},
 {"POP-handle-width32",[](auto& S,auto&){S.Op(S.Handle)->Size=OpSize::i32Bit;},2},
 {"RMW-after-POP",[](auto& S,auto&){S.After(S.Handle,S.Effect);},2},
 {"output-after-POP",[](auto& S,auto&){S.After(S.Output,S.Effect);},2},
 {"SP-load-after-effect",[](auto& S,auto&){S.After(S.SP,S.Effect);}},
 {"store-before-effect",[](auto& S,auto&){S.Before(S.Stores[0],S.Effect);}},
 {"store-after-exit",[](auto& S,auto&){S.After(S.Stores[0],S.Exit);}},
 {"exit-before-effect",[](auto& S,auto&){S.Before(S.Exit,S.Effect);}},
 {"exit-before-final-store",[](auto& S,auto&){S.Before(S.Exit,S.Stores.back());}},
 {"missing-store",[](auto& S,auto&){S.Stores[0]->Unlink(S.IR.GetListData());}},
 {"store-width32",[](auto& S,auto&){S.Op(S.Stores[0])->Size=OpSize::i32Bit;}},
 {"store-FPR",[](auto& S,auto&){S.Stores[0]->Reg=PhysicalRegister(RegClass::FPRFixed,0).Raw;}},
 {"store-unrelated-register",[](auto& S,auto&){S.Stores[0]->Reg=PhysicalRegister(RegClass::GPRFixed,(S.Reg+1)%16==4?6:(S.Reg+1)%16).Raw;}},
 {"store-old-SP",[](auto& S,auto&){S.IR.template GetOp<IROp_StoreRegister>(S.Stores[0])->Value=S.W(S.SP);}},
 {"exit-dynamic-SP",[](auto& S,auto&){S.IR.template GetOp<IROp_ExitFunction>(S.Exit)->NewRIP=S.W(S.SP);}},
 {"exit-call-hint",[](auto& S,auto&){S.IR.template GetOp<IROp_ExitFunction>(S.Exit)->Hint=BranchHint::Call;}},
 {"exit-return-hint",[](auto& S,auto&){S.IR.template GetOp<IROp_ExitFunction>(S.Exit)->Hint=BranchHint::Return;}},
 {"exit-call-operand",[](auto& S,auto&){S.IR.template GetOp<IROp_ExitFunction>(S.Exit)->CallReturnAddress=S.W(S.SP);}},
 {"exit-block-operand",[](auto& S,auto&){S.IR.template GetOp<IROp_ExitFunction>(S.Exit)->CallReturnBlock=S.W(S.SP);}},
 {"wrong-operation",[](auto& S,auto& C){C.BrokerOperation=S.Push?14:13;}},
 {"wrong-width",[](auto&,auto& C){C.BrokerWidth=4;}},
 {"wrong-flow",[](auto&,auto& C){C.BrokerFlow=1;}},
 {"static-target",[](auto&,auto& C){C.BrokerTarget=1;}},
 {"out-of-range-register",[](auto&,auto& C){C.BrokerTargetRegister=16;}},
 {"wrong-decoded-register",[](auto& S,auto& C){C.BrokerTargetRegister=(S.Reg+1)%16;}},
 {"unknown-effect",[](auto& S,auto&){S.Op(S.Marker)->Op=OP_SYSCALL;}}
 };
 fexwasm::FexHost::Options HO;HO.MaxInstructions=1;HO.DebugGuestInstructions=true;HO.Multiblock=false;fexwasm::FexHost Host(HO);unsigned Checked=0,Valid=0,Unexpected=0;
 for(bool Push:{true,false})for(unsigned Reg=0;Reg<16;Reg++){
  std::vector<unsigned char> Bytes;if(Reg>=8)Bytes.push_back(0x41);Bytes.push_back((Push?0x50:0x58)+(Reg&7));constexpr uint64_t RIP=0x123400008000;
  if(!Host.MapGuest(RIP,Bytes.data(),Bytes.size()))return 2;uint64_t Instructions=0;const auto* Original=Host.GenerateIR(RIP,&Instructions);if(!Original||Instructions!=1)return 3;
  for(const auto& C:Cases){if(C.Kind==1&&!Push||C.Kind==2&&Push||C.Kind==3&&(Push||Reg==4))continue;
   std::vector<unsigned char> Data(Original->GetDataSize()),List(Original->GetListSize());std::memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());std::memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());IRListView IR(Data.data(),List.data(),Data.size(),List.size());Shape S(IR,Push,Reg);
   if(!S.SP||!S.Effect||!S.Exit||!S.Marker||S.Stores.empty()||(!Push&&(!S.Handle||!S.Output)))return 4;
   fexwasm::BackendConfig Cfg;Cfg.BrokerMemory=true;Cfg.BrokerOperation=Push?13:14;Cfg.BrokerWidth=8;Cfg.BrokerTargetRegister=Reg;Cfg.BrokerNextRIP=RIP+Bytes.size();Cfg.SharedMemory=true;Cfg.ThreadBaseGlobal=true;Cfg.MemPages=Cfg.MemMaxPages=fexwasm::broker::Pages;Cfg.RegArgs=0;Cfg.CallsViaDispatcher=false;
   C.Change(S,Cfg);const auto R=fexwasm::Compile(IR,RIP,Cfg);const bool OK=C.Valid?(R.Error.empty()&&!R.Module.empty()):(!R.Error.empty()&&R.Module.empty());Checked++;Valid+=C.Valid;Unexpected+=!OK;
   printf("%s %s r%u: %s%s\n",C.Name,Push?"PUSH":"POP",Reg,R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
  }Host.Release();
 }printf("checked %u actual register-stack IR copies (%u valid); unexpected %u\n",Checked,Valid,Unexpected);return Unexpected?1:0;
}
