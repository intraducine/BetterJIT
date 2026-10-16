// SPDX-License-Identifier: GPL-3.0-or-later
// Mutations of actual pinned FEX IR, never a hand-written substitute lowering.
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
 const IRListView& IR;std::vector<Ref> Loads,Handles,Extracts,Stores;Ref Divide{},Marker{},Exit{};
 explicit Shape(const IRListView& V):IR(V){for(auto [Block,Header]:IR.GetBlocks())for(auto [N,H]:IR.GetCode(Block))switch(H->Op){
  case OP_LOADREGISTER:Loads.push_back(N);break;case OP_ALLOCATEGPR:Handles.push_back(N);break;case OP_BFE:Extracts.push_back(N);break;case OP_STOREREGISTER:Stores.push_back(N);break;
  case OP_UDIV:Divide=N;break;case OP_GUESTOPCODE:Marker=N;break;case OP_EXITFUNCTION:Exit=N;break;default:break;}}
 IROp_Header* Op(Ref N){return IR.GetOp<IROp_Header>(N);}
 void Before(Ref N,Ref T){N->Unlink(IR.GetListData());T->prepend(IR.GetListData(),N);}
 void After(Ref N,Ref T){N->Unlink(IR.GetListData());T->append(IR.GetListData(),N);}
};
struct Case{const char* Name;std::function<void(Shape&)> Mutate;bool WordOnly=false;};
int main(){
 const Case Cases[]={
  {"valid",[](Shape&){}},{"profile-width",[](Shape&){}},{"profile-source",[](Shape&){}},{"profile-flow",[](Shape&){}},{"profile-next",[](Shape&){}},
  {"profile-target",[](Shape&){}},{"profile-no-effects",[](Shape&){}},{"profile-TEST",[](Shape&){}},{"profile-SETcc",[](Shape&){}},{"profile-BT",[](Shape&){}},
  {"wrong-read-register",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Loads[0])->Reg=16;}},
  {"wrong-read-class",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Loads[0])->Class=RegClass::FPR;}},
  {"wrong-read-width",[](Shape& S){S.Op(S.Loads[0])->Size=OpSize::i32Bit;}},
  {"read-after-division",[](Shape& S){S.After(S.Loads[0],S.Divide);}},
  {"wrong-handle-width",[](Shape& S){S.Op(S.Handles[0])->Size=OpSize::i32Bit;}},
  {"wrong-handle-pair",[](Shape& S){S.IR.GetOp<IROp_AllocateGPR>(S.Handles[0])->ForPair=false;}},
  {"handle-after-division",[](Shape& S){S.After(S.Handles[0],S.Divide);}},
  {"signed-division",[](Shape& S){S.Op(S.Divide)->Op=OP_DIV;}},
  {"wrong-divide-width",[](Shape& S){S.Op(S.Divide)->Size=OpSize::i16Bit;}},
  {"wrong-low",[](Shape& S){S.IR.GetOp<IROp_UDiv>(S.Divide)->Lower=S.IR.WrapNode(S.Handles[0]);}},
  {"wrong-high",[](Shape& S){S.IR.GetOp<IROp_UDiv>(S.Divide)->Upper=S.IR.WrapNode(S.Handles[0]);}},
  {"wrong-divisor",[](Shape& S){S.IR.GetOp<IROp_UDiv>(S.Divide)->Divisor=S.IR.WrapNode(S.Handles[0]);}},
  {"rebound-quotient",[](Shape& S){S.IR.GetOp<IROp_UDiv>(S.Divide)->OutQuotient=S.IR.WrapNode(S.Handles[1]);}},
  {"rebound-remainder",[](Shape& S){S.IR.GetOp<IROp_UDiv>(S.Divide)->OutRemainder=S.IR.WrapNode(S.Handles[0]);}},
  {"wrong-extract-size",[](Shape& S){S.Op(S.Extracts[0])->Size=OpSize::i64Bit;},true},
  {"wrong-extract-width",[](Shape& S){S.IR.GetOp<IROp_Bfe>(S.Extracts[0])->Width=31;},true},
  {"wrong-extract-lsb",[](Shape& S){S.IR.GetOp<IROp_Bfe>(S.Extracts[0])->lsb=1;},true},
  {"wrong-extract-source",[](Shape& S){S.IR.GetOp<IROp_Bfe>(S.Extracts[0])->Src=S.IR.WrapNode(S.Handles[1]);},true},
  {"extract-before-division",[](Shape& S){S.Before(S.Extracts[0],S.Divide);},true},
  {"store-before-extract",[](Shape& S){S.Before(S.Stores[0],S.Extracts[0]);},true},
  {"wrong-store-value",[](Shape& S){S.IR.GetOp<IROp_StoreRegister>(S.Stores[0])->Value=S.IR.WrapNode(S.Loads[0]);}},
  {"wrong-store-register",[](Shape& S){S.Stores[0]->Reg=PhysicalRegister(RegClass::GPRFixed,1).Raw;}},
  {"wrong-store-class",[](Shape& S){S.Stores[0]->Reg=PhysicalRegister(RegClass::FPRFixed,2).Raw;}},
  {"wrong-store-width",[](Shape& S){S.Op(S.Stores[0])->Size=OpSize::i32Bit;}},
  {"store-before-division",[](Shape& S){S.Before(S.Stores[0],S.Divide);}},
  {"early-exit",[](Shape& S){S.Before(S.Exit,S.Stores[0]);}},
  {"effect-after-exit",[](Shape& S){S.After(S.Loads[0],S.Exit);}},
  {"variable-exit",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->NewRIP=S.IR.WrapNode(S.Loads[0]);}},
  {"call-exit",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->Hint=BranchHint::Call;}},
  {"extra-memory-read",[](Shape& S){S.Op(S.Marker)->Op=OP_LOADMEM;}},
  {"extra-memory-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREMEM;}},
  {"extra-context-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STORECONTEXT;}},
  {"extra-flag-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STORENZCV;}},
  {"extra-AF-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREAF;}},
  {"extra-PF-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREPF;}},
  {"extra-division",[](Shape& S){S.Op(S.Marker)->Op=OP_UDIV;}},
  {"extra-handle",[](Shape& S){S.Op(S.Marker)->Op=OP_ALLOCATEGPR;}},
  {"extra-GPR-read",[](Shape& S){S.Op(S.Marker)->Op=OP_LOADREGISTER;}},
  {"extra-GPR-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREREGISTER;}},
  {"extra-syscall",[](Shape& S){S.Op(S.Marker)->Op=OP_SYSCALL;}}
 };
 fexwasm::FexHost::Options O;O.MaxInstructions=1;O.DebugGuestInstructions=true;O.Multiblock=false;fexwasm::FexHost Host(O);
 unsigned Checked=0,Valid=0,Unexpected=0,RawRefused=0;
 for(unsigned Rex=0;Rex<17;Rex++)for(unsigned RM=0;RM<8;RM++){
  std::vector<unsigned char> Bytes;if(Rex)Bytes.push_back(0x3f+Rex);Bytes.insert(Bytes.end(),{0xf7,(unsigned char)(0xf0+RM)});
  const auto P=fexwasm::broker::Admit(Bytes.data(),Bytes.size());if(!P.Supported||P.Operation!=17||P.Length!=Bytes.size())return 2;
  constexpr uint64_t RIP=0x123400008000;if(!Host.MapGuest(RIP,Bytes.data(),Bytes.size()))return 3;
  uint64_t Instructions=0;const auto* Original=Host.GenerateIR(RIP,&Instructions);if(!Original||Instructions!=1||Host.InstructionLength(RIP)!=P.Length)return 4;
  for(const auto& C:Cases){if(C.WordOnly&&P.Width!=4)continue;
   std::vector<unsigned char> Data(Original->GetDataSize()),List(Original->GetListSize());std::memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());std::memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());IRListView IR(Data.data(),List.data(),Data.size(),List.size());Shape S(IR);
   if(S.Loads.size()<2||S.Handles.size()!=2||S.Stores.size()!=2||!S.Divide||!S.Marker||!S.Exit)return 5;C.Mutate(S);
   fexwasm::BackendConfig Cfg;Cfg.BrokerMemory=true;Cfg.BrokerOperation=17;Cfg.BrokerWidth=P.Width;Cfg.BrokerTargetRegister=P.Register;Cfg.BrokerNextRIP=RIP+P.Length;Cfg.SharedMemory=true;Cfg.ThreadBaseGlobal=true;Cfg.MemPages=Cfg.MemMaxPages=33;Cfg.RegArgs=0;Cfg.CallsViaDispatcher=false;
   if(!strcmp(C.Name,"profile-width"))Cfg.BrokerWidth=1;if(!strcmp(C.Name,"profile-source"))Cfg.BrokerTargetRegister=16;
   if(!strcmp(C.Name,"profile-flow"))Cfg.BrokerFlow=1;if(!strcmp(C.Name,"profile-target"))Cfg.BrokerTarget=RIP;
   if(!strcmp(C.Name,"profile-next"))Cfg.BrokerNextRIP++;if(!strcmp(C.Name,"profile-no-effects"))Cfg.BrokerNoEffects=true;
   if(!strcmp(C.Name,"profile-TEST"))Cfg.BrokerTestWidth=4;if(!strcmp(C.Name,"profile-SETcc"))Cfg.BrokerSetCondition=0;if(!strcmp(C.Name,"profile-BT"))Cfg.BrokerBitWidth=4;
   const auto R=fexwasm::Compile(IR,RIP,Cfg);const bool Expected=!strcmp(C.Name,"valid"),OK=Expected?(R.Error.empty()&&!R.Module.empty()):(!R.Error.empty()&&R.Module.empty());Checked++;Valid+=Expected;Unexpected+=!OK;
   printf("%s rex%u rm%u: %s%s\n",C.Name,Rex,RM,R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
  }Host.Release();Host.DiscardIR(RIP);
 }
 for(unsigned Rex=0;Rex<17;Rex++)for(unsigned M=0;M<256;M++){
  std::vector<unsigned char> B;if(Rex)B.push_back(0x3f+Rex);B.insert(B.end(),{0xf7,(unsigned char)M});
  const auto A=fexwasm::broker::Admit(B.data(),B.size());const bool Supported=(M&0xf8)==0xf0;
  if(A.Supported!=Supported||(Supported&&(A.Operation!=17||A.Width!=((Rex&&((Rex-1)&8))?8u:4u)||A.Register!=((M&7)+((Rex&&((Rex-1)&1))?8:0))||A.Length!=B.size())))return 6;
  if(!Supported)RawRefused++;for(unsigned N=0;N<B.size();N++)if(fexwasm::broker::Admit(B.data(),N).Supported)return 7;
 }
 for(const auto& Prefix:std::vector<std::vector<unsigned char>>{{0x66},{0x67},{0x64},{0x65},{0xf0},{0xf2},{0xf3},{0x2e},{0x66,0x48},{0x40,0x41},{0x40,0x66}}){auto B=Prefix;B.insert(B.end(),{0xf7,0xf1});if(fexwasm::broker::Admit(B.data(),B.size()).Supported)return 8;RawRefused++;}
 printf("checked %u actual DIV IR copies; valid %u; unexpected %u; raw refused %u\n",Checked,Valid,Unexpected,RawRefused);return Unexpected?1:0;
}
