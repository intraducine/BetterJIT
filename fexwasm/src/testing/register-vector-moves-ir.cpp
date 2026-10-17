// SPDX-License-Identifier: GPL-3.0-or-later
// Every control copies actual pinned FEX IR before mutation.
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
struct Form {unsigned Prefix,Opcode,Kind,Width;bool Reverse;};
const Form Forms[]={
 {0x66,0x6e,1,0,false},{0x66,0x7e,2,0,true},
 {0,0x28,3,16,false},{0,0x29,3,16,true},{0,0x10,3,16,false},{0,0x11,3,16,true},
 {0x66,0x28,3,16,false},{0x66,0x29,3,16,true},{0x66,0x10,3,16,false},{0x66,0x11,3,16,true},
 {0x66,0x6f,3,16,false},{0x66,0x7f,3,16,true},{0xf3,0x6f,3,16,false},{0xf3,0x7f,3,16,true},
 {0xf3,0x7e,4,8,false},{0x66,0xd6,4,8,true},
 {0xf3,0x10,5,4,false},{0xf3,0x11,5,4,true},{0xf2,0x10,5,8,false},{0xf2,0x11,5,8,true}};
struct Shape {
 const IRListView& IR;
 Ref Find(IROps Op)const{for(auto [B,BH]:IR.GetBlocks())for(auto [N,H]:IR.GetCode(B))if(H->Op==Op)return N;return {};}
 Ref Move()const{for(auto O:{OP_VCASTFROMGPR,OP_VEXTRACTTOGPR,OP_VMOV,OP_VINSELEMENT})if(auto N=Find(O))return N;return {};}
 IROp_Header* H(Ref N)const{return IR.GetOp<IROp_Header>(N);}
 void Before(Ref N,Ref T){N->Unlink(IR.GetListData());T->prepend(IR.GetListData(),N);}
};
static fexwasm::BackendConfig Config(const fexwasm::broker::Admission& P,uint64_t RIP){
 fexwasm::BackendConfig C;C.BrokerMemory=true;C.BrokerOperation=P.Operation;C.BrokerWidth=P.Width;C.BrokerNextRIP=RIP+P.Length;C.BrokerTargetRegister=P.Register;
 C.BrokerVectorKind=P.VectorKind;C.BrokerVectorWidth=P.VectorWidth;C.BrokerVectorSourceRegister=P.VectorSourceRegister;C.SharedMemory=true;C.ThreadBaseGlobal=true;C.MemPages=C.MemMaxPages=fexwasm::broker::Pages;C.RegArgs=0;C.CallsViaDispatcher=false;return C;
}
int main(int argc,char** argv){
 const bool Dump=argc==2&&!strcmp(argv[1],"--dump");if(argc!=1&&!Dump)return 2;
 fexwasm::FexHost::Options O;O.Multiblock=false;O.MaxInstructions=1;O.DebugGuestInstructions=true;fexwasm::FexHost Host(O);constexpr uint64_t RIP=0x123400008000;
 struct Case{const char* Name;std::function<bool(Shape&,fexwasm::BackendConfig&)> Change;};
 const Case Mutations[]={
  {"kind",[](auto&,auto& C){C.BrokerVectorKind=0;return true;}},
  {"width",[](auto&,auto& C){C.BrokerVectorWidth=3;return true;}},
  {"legal-lane-width",[](auto&,auto& C){C.BrokerVectorWidth=C.BrokerVectorWidth==4?8:4;return true;}},
  {"other-kind",[](auto&,auto& C){C.BrokerVectorKind=C.BrokerVectorKind%5+1;return true;}},
  {"source",[](auto&,auto& C){C.BrokerVectorSourceRegister^=1;return true;}},
  {"destination",[](auto&,auto& C){C.BrokerTargetRegister^=1;return true;}},
  {"bad-source",[](auto&,auto& C){C.BrokerVectorSourceRegister=16;return true;}},
  {"wire-operation",[](auto&,auto& C){C.BrokerOperation=0;return true;}},
  {"wire-width",[](auto&,auto& C){C.BrokerWidth=8;return true;}},
  {"flow",[](auto&,auto& C){C.BrokerFlow=1;return true;}},
  {"target",[](auto&,auto& C){C.BrokerTarget=RIP;return true;}},
  {"next-RIP",[](auto&,auto& C){C.BrokerNextRIP++;return true;}},
  {"NOP",[](auto&,auto& C){C.BrokerNoEffects=true;return true;}},
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
  {"move-element",[](auto& S,auto&){auto N=S.Move();if(!N)return false;S.H(N)->ElementSize=OpSize::i16Bit;return true;}},
  {"move-operation",[](auto& S,auto&){auto N=S.Move();if(!N)return false;S.H(N)->Op=OP_VXOR;return true;}},
  {"move-input",[](auto& S,auto&){auto N=S.Move();if(!N)return false;S.H(N)->Args[0]=S.IR.template GetOp<IROp_ExitFunction>(S.Find(OP_EXITFUNCTION))->NewRIP;return true;}},
  {"extract-index",[](auto& S,auto&){auto N=S.Find(OP_VEXTRACTTOGPR);if(!N)return false;S.IR.template GetOp<IROp_VExtractToGPR>(N)->Index=1;return true;}},
  {"merge-destination-index",[](auto& S,auto&){auto N=S.Find(OP_VINSELEMENT);if(!N)return false;S.IR.template GetOp<IROp_VInsElement>(N)->DestIdx=1;return true;}},
  {"merge-source-index",[](auto& S,auto&){auto N=S.Find(OP_VINSELEMENT);if(!N)return false;S.IR.template GetOp<IROp_VInsElement>(N)->SrcIdx=1;return true;}},
  {"merge-swapped",[](auto& S,auto& C){auto N=S.Find(OP_VINSELEMENT);if(!N||C.BrokerVectorSourceRegister==C.BrokerTargetRegister)return false;auto* I=S.IR.template GetOp<IROp_VInsElement>(N);std::swap(I->DestVector,I->SrcVector);return true;}},
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
  const auto P=fexwasm::broker::Admit(Code.data(),Code.size());if(!P.Supported||P.Operation!=6||P.Width||P.VectorKind!=F.Kind||P.VectorWidth!=(F.Width?F.Width:R&8?8u:4u)||P.Register!=(F.Reverse?RM:Reg)||P.VectorSourceRegister!=(F.Reverse?Reg:RM)||P.Length!=Code.size())return 3;
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
 printf("checked %u actual vector movement IR copies across %u aliases; truncations %u; memory refusals %u; unexpected %u\n",Checked,Aliases,Truncations,Refusals,Unexpected);return Unexpected?1:0;
}
