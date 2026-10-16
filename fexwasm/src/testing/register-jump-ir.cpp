// SPDX-License-Identifier: GPL-3.0-or-later
// Mutate copies of actual frontend JMP IR; execute no guest/native JIT code.
#include "backend.h"
#include "broker_step.h"
#include "fexhost.h"
#include "Interface/IR/IR.h"
#include "Interface/IR/IntrusiveIRList.h"
#include <cstdio>
#include <cstring>
#include <vector>
using namespace FEXCore::IR;
int main(){
 fexwasm::FexHost::Options HO;HO.MaxInstructions=1;HO.DebugGuestInstructions=true;HO.Multiblock=false;
 fexwasm::FexHost Host(HO);unsigned Checked=0,Unexpected=0;
 const char* Names[]={"valid","load-width32","load-SIMD","wrong-register","invalid-exit-SSA","call-hint","return-hint","call-return-address","call-return-block","wrong-profile","wrong-flow","wrong-width","static-target","invalid-source-register","wrong-source-register","unknown-effect","NOP-profile"};
 for(unsigned Reg=0;Reg<16;Reg++){
  std::vector<unsigned char> Bytes;if(Reg>=8)Bytes.push_back(0x41);Bytes.push_back(0xff);Bytes.push_back(0xe0+(Reg&7));constexpr uint64_t RIP=0x123400008000;
  const auto Plan=fexwasm::broker::Admit(Bytes.data(),Bytes.size());if(!Plan.Supported||Plan.Operation!=12||Plan.Register!=Reg)return 2;
  if(!Host.MapGuest(RIP,Bytes.data(),Bytes.size()))return 3;uint64_t Instructions=0;const auto* Original=Host.GenerateIR(RIP,&Instructions);if(!Original||Instructions!=1)return 4;
  for(unsigned C=0;C<sizeof(Names)/sizeof(Names[0]);C++){
   std::vector<unsigned char> Data(Original->GetDataSize()),List(Original->GetListSize());std::memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());std::memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());
   IRListView IR(Data.data(),List.data(),Data.size(),List.size());IROp_LoadRegister* Load=nullptr;IROp_ExitFunction* Exit=nullptr;IROp_Header* Marker=nullptr;OrderedNodeWrapper Value{};
   for(auto [Block,Header]:IR.GetBlocks())for(auto [Node,H]:IR.GetCode(Block)){
    if(H->Op==OP_LOADREGISTER){if(Load)return 5;Load=IR.GetOp<IROp_LoadRegister>(Node);Value=IR.WrapNode(Node);}
    if(H->Op==OP_EXITFUNCTION){if(Exit)return 6;Exit=IR.GetOp<IROp_ExitFunction>(Node);}if(H->Op==OP_GUESTOPCODE)Marker=IR.GetOp<IROp_Header>(Node);
   }
   if(!Load||!Exit||!Marker||Exit->NewRIP!=Value||Load->Reg!=Reg)return 7;
   fexwasm::BackendConfig Cfg;Cfg.BrokerMemory=true;Cfg.BrokerOperation=12;Cfg.BrokerFlow=5;Cfg.BrokerTargetRegister=Reg;Cfg.BrokerNextRIP=RIP+Bytes.size();Cfg.SharedMemory=true;Cfg.ThreadBaseGlobal=true;Cfg.MemPages=Cfg.MemMaxPages=fexwasm::broker::Pages;Cfg.RegArgs=0;Cfg.CallsViaDispatcher=false;
   switch(C){
    case 1:Load->Header.Size=OpSize::i32Bit;break;case 2:Load->Class=RegClass::FPR;break;case 3:Load->Reg=(Reg+1)%16;break;
    case 4:Exit->NewRIP=OrderedNodeWrapper{};break;case 5:Exit->Hint=BranchHint::Call;break;case 6:Exit->Hint=BranchHint::Return;break;
    case 7:Exit->CallReturnAddress=Value;break;case 8:Exit->CallReturnBlock=Value;break;
    case 9:Cfg.BrokerOperation=0;break;case 10:Cfg.BrokerFlow=1;break;case 11:Cfg.BrokerWidth=8;break;case 12:Cfg.BrokerTarget=RIP;break;
    case 13:Cfg.BrokerTargetRegister=16;break;case 14:Cfg.BrokerTargetRegister=(Reg+1)%16;break;case 15:Marker->Op=OP_SYSCALL;break;case 16:Cfg.BrokerNoEffects=true;break;default:break;
   }
   const auto R=fexwasm::Compile(IR,RIP,Cfg);const bool OK=C==0?(R.Error.empty()&&!R.Module.empty()):(!R.Error.empty()&&R.Module.empty());Checked++;Unexpected+=!OK;
   printf("%s r%u: %s%s\n",Names[C],Reg,R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
  }Host.Release();
 }printf("checked %u actual register-jump IR copies; unexpected %u\n",Checked,Unexpected);return Unexpected?1:0;
}
