// SPDX-License-Identifier: GPL-3.0-or-later
// Each proof mutation copies actual pinned FEX IR; no mock graph is constructed.
#include "backend.h"
#include "broker_step.h"
#include "fexhost.h"
#include <FEXCore/fextl/sstream.h>
#include "Interface/IR/IR.h"
#include "Interface/IR/IntrusiveIRList.h"
#include "Interface/IR/RegisterAllocationData.h"
#include <cstdio>
#include <cstring>
#include <functional>
#include <vector>
using namespace FEXCore::IR;
struct Form {unsigned Prefix,Opcode,Kind,Width;};
const Form Forms[]={{0x66,0x60,1,1},
 {0x66,0x68,2,1},
 {0x66,0x61,1,2},
 {0x66,0x69,2,2},
 {0x66,0x62,1,4},
 {0x66,0x6a,2,4},
 {0x66,0x6c,1,8},
 {0x66,0x6d,2,8},
 {0x0,0x14,1,4},
 {0x0,0x15,2,4},
 {0x66,0x14,1,8},
 {0x66,0x15,2,8},
 {0x66,0xdb,3,16},
 {0x66,0xdf,4,16},
 {0x66,0xeb,5,16},
 {0x66,0xef,6,16},
 {0x0,0x54,3,16},
 {0x0,0x55,4,16},
 {0x0,0x56,5,16},
 {0x0,0x57,6,16},
 {0x66,0x54,3,16},
 {0x66,0x55,4,16},
 {0x66,0x56,5,16},
 {0x66,0x57,6,16}};
struct Shape {
 const IRListView& IR;
 Ref Find(IROps Op)const{for(auto [B,BH]:IR.GetBlocks())for(auto [N,H]:IR.GetCode(B))if(H->Op==Op)return N;return {};}
 Ref Move()const{for(auto O:{OP_VZIP,OP_VZIP2,OP_VAND,OP_VANDN,OP_VOR,OP_VXOR,OP_LOADNAMEDVECTORCONSTANT})if(auto N=Find(O))return N;return {};}
 IROp_Header* H(Ref N)const{return IR.GetOp<IROp_Header>(N);}
 void Before(Ref N,Ref T){N->Unlink(IR.GetListData());T->prepend(IR.GetListData(),N);}
};
static fexwasm::BackendConfig Config(const fexwasm::broker::Admission& P,uint64_t RIP){
 fexwasm::BackendConfig C;C.BrokerMemory=true;C.BrokerOperation=P.Operation;C.BrokerWidth=P.Width;C.BrokerNextRIP=RIP+P.Length;C.BrokerTargetRegister=P.Register;
 C.BrokerLaneKind=P.LaneKind;C.BrokerLaneWidth=P.LaneWidth;C.BrokerLaneSourceRegister=P.LaneSourceRegister;C.SharedMemory=true;C.ThreadBaseGlobal=true;C.MemPages=C.MemMaxPages=fexwasm::broker::Pages;C.RegArgs=0;C.CallsViaDispatcher=false;return C;
}
int main(int argc,char** argv){
 const bool Dump=argc==2&&!strcmp(argv[1],"--dump");if(argc!=1&&!Dump)return 2;
 fexwasm::FexHost::Options O;O.Multiblock=false;O.MaxInstructions=1;O.DebugGuestInstructions=true;fexwasm::FexHost Host(O);constexpr uint64_t RIP=0x123400008000;
 struct Case{const char* Name;std::function<bool(Shape&,fexwasm::BackendConfig&)> Change;};
 const Case Mutations[]={
  {"kind",[](auto&,auto& C){C.BrokerLaneKind=0;return true;}},
  {"width",[](auto&,auto& C){C.BrokerLaneWidth=3;return true;}},
  {"legal-lane-width",[](auto&,auto& C){C.BrokerLaneWidth=C.BrokerLaneWidth==8?4:8;return true;}},
  {"other-kind",[](auto&,auto& C){C.BrokerLaneKind=C.BrokerLaneKind%6+1;return true;}},
  {"source",[](auto&,auto& C){C.BrokerLaneSourceRegister^=1;return true;}},
  {"destination",[](auto&,auto& C){C.BrokerTargetRegister^=1;return true;}},
  {"bad-source",[](auto&,auto& C){C.BrokerLaneSourceRegister=16;return true;}},
  {"wire-operation",[](auto&,auto& C){C.BrokerOperation=0;return true;}},
  {"wire-width",[](auto&,auto& C){C.BrokerWidth=8;return true;}},
  {"flow",[](auto&,auto& C){C.BrokerFlow=1;return true;}},
  {"target",[](auto&,auto& C){C.BrokerTarget=RIP;return true;}},
  {"next-RIP",[](auto&,auto& C){C.BrokerNextRIP++;return true;}},
  {"NOP",[](auto&,auto& C){C.BrokerNoEffects=true;return true;}},
  {"movement-profile",[](auto&,auto& C){C.BrokerVectorKind=3;return true;}},
  {"unary-profile",[](auto&,auto& C){C.BrokerUnaryKind=2;return true;}},
  {"word-profile",[](auto&,auto& C){C.BrokerWordCompare=true;return true;}},
  {"TEST-profile",[](auto&,auto& C){C.BrokerTestShift=8;return true;}},
  {"condition-profile",[](auto&,auto& C){C.BrokerConditionCode=0;return true;}},
  {"unshared",[](auto&,auto& C){C.SharedMemory=false;return true;}},
  {"load-class",[](auto& S,auto&){auto N=S.Find(OP_LOADREGISTER);if(!N)return false;auto* L=S.IR.template GetOp<IROp_LoadRegister>(N);L->Class=L->Class==RegClass::FPR?RegClass::GPR:RegClass::FPR;return true;}},
  {"load-register",[](auto& S,auto&){auto N=S.Find(OP_LOADREGISTER);if(!N)return false;S.IR.template GetOp<IROp_LoadRegister>(N)->Reg^=1;return true;}},
  {"load-width",[](auto& S,auto&){auto N=S.Find(OP_LOADREGISTER);if(!N)return false;S.H(N)->Size=OpSize::i32Bit;return true;}},
  {"load-element",[](auto& S,auto&){auto N=S.Find(OP_LOADREGISTER);if(!N)return false;S.H(N)->ElementSize=OpSize::i8Bit;return true;}},
  {"move-width",[](auto& S,auto&){auto N=S.Move();if(!N)return false;S.H(N)->Size=OpSize::i16Bit;return true;}},
  {"move-element",[](auto& S,auto&){auto N=S.Move();if(!N)return false;S.H(N)->ElementSize=S.H(N)->ElementSize==OpSize::i16Bit?OpSize::i32Bit:OpSize::i16Bit;return true;}},
  {"move-operation",[](auto& S,auto&){auto N=S.Move();if(!N)return false;S.H(N)->Op=OP_VADD;return true;}},
  {"move-input",[](auto& S,auto&){auto N=S.Move();if(S.H(N)->Op==OP_LOADNAMEDVECTORCONSTANT)return false;S.H(N)->Args[0]=S.IR.template GetOp<IROp_ExitFunction>(S.Find(OP_EXITFUNCTION))->NewRIP;return true;}},
  {"second-input",[](auto& S,auto&){auto N=S.Move();if(S.H(N)->Op==OP_LOADNAMEDVECTORCONSTANT)return false;S.H(N)->Args[1]=S.IR.template GetOp<IROp_ExitFunction>(S.Find(OP_EXITFUNCTION))->NewRIP;return true;}},
  {"swapped-operands",[](auto& S,auto& C){auto N=S.Move();if(C.BrokerLaneSourceRegister==C.BrokerTargetRegister || (C.BrokerLaneKind!=4 && C.BrokerLaneKind>2))return false;std::swap(S.H(N)->Args[0],S.H(N)->Args[1]);return true;}},
  {"wrong-zero-name",[](auto& S,auto&){auto N=S.Find(OP_LOADNAMEDVECTORCONSTANT);if(!N)return false;S.IR.template GetOp<IROp_LoadNamedVectorConstant>(N)->Constant=static_cast<NamedVectorConstant>(0);return true;}},
  {"store-class",[](auto& S,auto&){auto N=S.Find(OP_STOREREGISTER);if(!N)return false;auto P=PhysicalRegister(N);N->Reg=PhysicalRegister(P.AsRegClass()==RegClass::FPRFixed?RegClass::GPRFixed:RegClass::FPRFixed,P.Reg).Raw;return true;}},
  {"store-register",[](auto& S,auto&){auto N=S.Find(OP_STOREREGISTER);if(!N)return false;auto P=PhysicalRegister(N);N->Reg=PhysicalRegister(P.AsRegClass(),P.Reg^1).Raw;return true;}},
  {"store-width",[](auto& S,auto&){auto N=S.Find(OP_STOREREGISTER);if(!N)return false;S.H(N)->Size=OpSize::i32Bit;return true;}},
  {"store-element",[](auto& S,auto&){auto N=S.Find(OP_STOREREGISTER);if(!N)return false;S.H(N)->ElementSize=OpSize::i16Bit;return true;}},
  {"store-input",[](auto& S,auto&){auto N=S.Find(OP_STOREREGISTER);if(!N)return false;S.H(N)->Args[0]=S.IR.template GetOp<IROp_ExitFunction>(S.Find(OP_EXITFUNCTION))->NewRIP;return true;}},
  {"store-order",[](auto& S,auto&){auto N=S.Find(OP_STOREREGISTER),T=S.Find(OP_LOADREGISTER);if(!N||!T)return false;S.Before(N,T);return true;}},
  {"move-order",[](auto& S,auto&){auto N=S.Move(),T=S.Find(OP_LOADREGISTER);if(!N||!T)return false;S.Before(N,T);return true;}},
  {"exit-width",[](auto& S,auto&){S.H(S.Find(OP_EXITFUNCTION))->Size=OpSize::i32Bit;return true;}},
  {"exit-hint",[](auto& S,auto&){S.IR.template GetOp<IROp_ExitFunction>(S.Find(OP_EXITFUNCTION))->Hint=BranchHint::Return;return true;}},
  {"extra-flags",[](auto& S,auto&){S.H(S.Find(OP_GUESTOPCODE))->Op=OP_STOREPF;return true;}},
  {"extra-memory",[](auto& S,auto&){S.H(S.Find(OP_GUESTOPCODE))->Op=OP_LOADMEM;return true;}},
  {"after-exit",[](auto& S,auto&){S.H(S.Find(OP_ENDBLOCK))->Op=OP_GUESTOPCODE;return true;}}
 };
 unsigned Aliases=0,Checked=0,Unexpected=0,Truncations=0,Refusals=0;
 for(const auto F:Forms)for(unsigned Rex=0;Rex<=16;Rex++)for(unsigned M=0;M<64;M++){
  const unsigned R=Rex?0x3f+Rex:0,Reg=(M>>3)+((R&4)?8:0),RM=(M&7)+((R&1)?8:0);
  std::vector<uint8_t> Code;if(F.Prefix)Code.push_back(F.Prefix);if(R)Code.push_back(R);Code.insert(Code.end(),{0x0f,uint8_t(F.Opcode),uint8_t(0xc0|M)});
  const auto P=fexwasm::broker::Admit(Code.data(),Code.size());if(!P.Supported||P.Operation!=6||P.Width||P.LaneKind!=F.Kind||P.LaneWidth!=F.Width||P.Register!=Reg||P.LaneSourceRegister!=RM||P.Length!=Code.size())return 3;
  for(unsigned N=0;N<Code.size();N++){if(fexwasm::broker::Admit(Code.data(),N).Supported)return 4;Truncations++;}
  Host.MapGuest(RIP,Code.data(),Code.size());uint64_t Count=0;const auto* Original=Host.GenerateIR(RIP,&Count);if(!Original||Count!=1||Host.InstructionLength(RIP)!=Code.size())return 5;Aliases++;
  if(Dump && Rex==0 && M==1){printf("\n=== prefix %02x op %02x ===\n",F.Prefix,F.Opcode);fextl::stringstream Out;FEXCore::IR::Dump(&Out,Original);printf("%s",Out.str().c_str());for(auto [B,BH]:Original->GetBlocks())for(auto [N,H]:Original->GetCode(B))printf("node op%u size%u elem%u\n",unsigned(H->Op),unsigned(H->Size),unsigned(H->ElementSize));}
  auto Check=[&](const Case* C){std::vector<uint8_t> Data(Original->GetDataSize()),List(Original->GetListSize());memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());IRListView IR(Data.data(),List.data(),Data.size(),List.size());Shape S{IR};auto Cfg=Config(P,RIP);if(C&&!C->Change(S,Cfg))return;
   auto Result=fexwasm::Compile(IR,RIP,Cfg);bool OK=C?(!Result.Error.empty()&&Result.Module.empty()):(Result.Error.empty()&&!Result.Module.empty());Checked++;Unexpected+=!OK;
   if(!OK){printf("[UNEXPECTED] ");for(auto B:Code)printf("%02x",unsigned(B));printf(" %s: %s\n",C?C->Name:"valid",Result.Error.empty()?"ACCEPTED":Result.Error.c_str());}
  };
  Check(nullptr);if((Rex==0||Rex==16)&&(M==0||M==1||M==7||M==56||M==63))for(const auto& C:Mutations)Check(&C);
  Host.Release();Host.DiscardIR(RIP);
 }
 for(const auto F:Forms)for(unsigned M=0;M<192;M++){const uint8_t Code[]={uint8_t(F.Prefix),0x0f,uint8_t(F.Opcode),uint8_t(M),0,0,0,0,0,0};const auto P=fexwasm::broker::Admit(Code+(F.Prefix?0:1),sizeof(Code)-(F.Prefix?0:1));if(P.Supported)return 6;Refusals++;}
 printf("checked %u actual vector lane IR copies across %u aliases; truncations %u; memory refusals %u; unexpected %u\n",Checked,Aliases,Truncations,Refusals,Unexpected);return Unexpected?1:0;
}
