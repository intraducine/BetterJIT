// SPDX-License-Identifier: GPL-3.0-or-later
// Actual pinned FEX unary IR, copied before any compiler mutation control.
#include "backend.h"
#include "broker_step.h"
#include "fexhost.h"
#include <FEXCore/fextl/sstream.h>
#include "Interface/IR/IR.h"
#include "Interface/IR/IntrusiveIRList.h"
#include "Interface/IR/RegisterAllocationData.h"
#include <cstdio>
#include <cstring>
#include <vector>
#include <functional>
using namespace FEXCore::IR;
struct UnaryShape {
  const IRListView& IR;
  Ref Find(IROps Op)const{for(auto [B,BH]:IR.GetBlocks())for(auto [N,H]:IR.GetCode(B))if(H->Op==Op)return N;return {};}
  Ref Result(const fexwasm::BackendConfig& C)const{return Find(C.BrokerUnaryKind==2?(C.BrokerUnaryWidth<4?OP_XOR:OP_NOT):C.BrokerUnaryWidth<4?(C.BrokerUnaryKind==3?OP_ADD:OP_SUB):(C.BrokerUnaryKind==3?OP_ADDWITHFLAGS:OP_SUBWITHFLAGS));}
  Ref Flags(const fexwasm::BackendConfig& C)const{return Find(C.BrokerUnaryWidth<4?(C.BrokerUnaryKind==3?OP_ADDNZCV:OP_SUBNZCV):(C.BrokerUnaryKind==3?OP_ADDWITHFLAGS:OP_SUBWITHFLAGS));}
  Ref Merge(bool Carry)const{for(auto [B,BH]:IR.GetBlocks())for(auto [N,H]:IR.GetCode(B))if(H->Op==OP_BFI&&uint32_t(H->Size)==(Carry?4u:8u))return N;return {};}
  IROp_Header* Op(Ref N)const{return IR.GetOp<IROp_Header>(N);}
  bool ChangeConstant(OrderedNodeWrapper W)const{if(W.IsInvalid())return false;auto* H=IR.GetOp<IROp_Header>(W);if(H->Op==OP_INLINECONSTANT){IR.GetOp<IROp_InlineConstant>(W)->Constant^=1;return true;}if(H->Op==OP_CONSTANT){IR.GetOp<IROp_Constant>(W)->Constant^=1;return true;}return false;}
  void Before(Ref N,Ref T){N->Unlink(IR.GetListData());T->prepend(IR.GetListData(),N);}
};
static fexwasm::BackendConfig UnaryConfig(const fexwasm::broker::Admission& P,uint64_t RIP){
 fexwasm::BackendConfig C;C.BrokerMemory=true;C.BrokerOperation=P.Operation;C.BrokerWidth=P.Width;C.BrokerNextRIP=RIP+P.Length;C.BrokerTargetRegister=P.Register;C.BrokerUnaryKind=P.UnaryKind;C.BrokerUnaryWidth=P.UnaryWidth;C.BrokerUnaryShift=P.UnaryShift;C.SharedMemory=true;C.ThreadBaseGlobal=true;C.MemPages=C.MemMaxPages=fexwasm::broker::Pages;C.RegArgs=0;C.CallsViaDispatcher=false;return C;
}
static int Controls(fexwasm::FexHost& Host){
 struct Case{const char* Name;std::function<bool(UnaryShape&,fexwasm::BackendConfig&)> Change;};
 const Case Cases[]={
  {"valid",[](auto&,auto&){return true;}},
  {"kind",[](auto&,auto& C){C.BrokerUnaryKind=C.BrokerUnaryKind%4+1;return true;}},
  {"kind-absent",[](auto&,auto& C){C.BrokerUnaryKind=0;return true;}},
  {"operand-width",[](auto&,auto& C){C.BrokerUnaryWidth=C.BrokerUnaryWidth==1?2:1;return true;}},
  {"operand-shift",[](auto&,auto& C){C.BrokerUnaryShift^=8;return true;}},
  {"selected-register",[](auto&,auto& C){C.BrokerTargetRegister^=1;return true;}},
  {"operation",[](auto&,auto& C){C.BrokerOperation=0;return true;}},
  {"wire-width",[](auto&,auto& C){C.BrokerWidth=1;return true;}},
  {"flow",[](auto&,auto& C){C.BrokerFlow=1;return true;}},
  {"target",[](auto&,auto& C){C.BrokerTarget=0x123400008100;return true;}},
  {"next-PC",[](auto&,auto& C){C.BrokerNextRIP++;return true;}},
  {"NOP-profile",[](auto&,auto& C){C.BrokerNoEffects=true;return true;}},
  {"word-profile",[](auto&,auto& C){C.BrokerWordCompare=true;return true;}},
  {"logical-profile",[](auto&,auto& C){C.BrokerLogicalWidth=2;return true;}},
  {"condition-profile",[](auto&,auto& C){C.BrokerConditionCode=0;return true;}},
  {"TEST-profile",[](auto&,auto& C){C.BrokerTestWidth=1;return true;}},
  {"unshared",[](auto&,auto& C){C.SharedMemory=false;return true;}},
  {"register-width",[](auto& S,auto&){S.Op(S.Find(OP_LOADREGISTER))->Size=OpSize::i32Bit;return true;}},
  {"register-class",[](auto& S,auto&){S.IR.template GetOp<IROp_LoadRegister>(S.Find(OP_LOADREGISTER))->Class=RegClass::FPR;return true;}},
  {"register-selection",[](auto& S,auto&){S.IR.template GetOp<IROp_LoadRegister>(S.Find(OP_LOADREGISTER))->Reg^=1;return true;}},
  {"result-op",[](auto& S,auto& C){S.Op(S.Result(C))->Op=OP_OR;return true;}},
  {"result-width",[](auto& S,auto& C){auto* H=S.Op(S.Result(C));H->Size=H->Size==OpSize::i32Bit?OpSize::i64Bit:OpSize::i32Bit;return true;}},
  {"result-dataflow",[](auto& S,auto& C){S.Op(S.Result(C))->Args[0]=S.IR.template GetOp<IROp_ExitFunction>(S.Find(OP_EXITFUNCTION))->NewRIP;return true;}},
  {"constant-operand",[](auto& S,auto& C){auto* R=S.Op(S.Result(C));return S.ChangeConstant(R->Args[0])||(GetArgs(R->Op)>1&&S.ChangeConstant(R->Args[1]));}},
  {"flags-op",[](auto& S,auto& C){if(C.BrokerUnaryKind==2)return false;S.Op(S.Flags(C))->Op=OP_TESTNZ;return true;}},
  {"flags-width",[](auto& S,auto& C){if(C.BrokerUnaryKind==2)return false;auto* F=S.Op(S.Flags(C));F->Size=F->Size==OpSize::i32Bit?OpSize::i64Bit:OpSize::i32Bit;return true;}},
  {"flags-dataflow",[](auto& S,auto& C){if(C.BrokerUnaryKind==2)return false;S.Op(S.Flags(C))->Args[1]=S.IR.template GetOp<IROp_ExitFunction>(S.Find(OP_EXITFUNCTION))->NewRIP;return true;}},
  {"AF-dataflow",[](auto& S,auto& C){const auto N=S.Find(OP_STOREAF);if(!N)return false;S.Op(N)->Args[0]=S.IR.WrapNode(S.Result(C));return true;}},
  {"PF-dataflow",[](auto& S,auto&){const auto N=S.Find(OP_STOREPF);if(!N)return false;S.Op(N)->Args[0]=S.IR.WrapNode(S.Find(OP_LOADREGISTER));return true;}},
  {"AF-width",[](auto& S,auto&){const auto N=S.Find(OP_STOREAF);if(!N)return false;S.Op(N)->Size=OpSize::i32Bit;return true;}},
  {"PF-width",[](auto& S,auto&){const auto N=S.Find(OP_STOREPF);if(!N)return false;S.Op(N)->Size=OpSize::i32Bit;return true;}},
  {"byte-extraction",[](auto& S,auto&){const auto N=S.Find(OP_LSHR);if(!N)return false;return S.ChangeConstant(S.Op(N)->Args[1]);}},
  {"masked-width",[](auto& S,auto&){const auto N=S.Find(OP_BFE);if(!N)return false;S.IR.template GetOp<IROp_Bfe>(N)->Width--;return true;}},
  {"masked-shift",[](auto& S,auto&){const auto N=S.Find(OP_BFE);if(!N)return false;S.IR.template GetOp<IROp_Bfe>(N)->lsb^=8;return true;}},
  {"merge-width",[](auto& S,auto&){const auto N=S.Merge(false);if(!N)return false;S.IR.template GetOp<IROp_Bfi>(N)->Width--;return true;}},
  {"merge-shift",[](auto& S,auto&){const auto N=S.Merge(false);if(!N)return false;S.IR.template GetOp<IROp_Bfi>(N)->lsb^=8;return true;}},
  {"merge-destination",[](auto& S,auto& C){const auto N=S.Merge(false);if(!N)return false;S.IR.template GetOp<IROp_Bfi>(N)->Dest=S.IR.WrapNode(S.Result(C));return true;}},
  {"carry-save-condition",[](auto& S,auto&){const auto N=S.Find(OP_NZCVSELECT);if(!N)return false;S.IR.template GetOp<IROp_NZCVSelect>(N)->Cond=CondClass::ULT;return true;}},
  {"carry-save-true",[](auto& S,auto&){const auto N=S.Find(OP_NZCVSELECT);if(!N)return false;return S.ChangeConstant(S.IR.template GetOp<IROp_NZCVSelect>(N)->TrueVal);}},
  {"carry-save-false",[](auto& S,auto&){const auto N=S.Find(OP_NZCVSELECT);if(!N)return false;return S.ChangeConstant(S.IR.template GetOp<IROp_NZCVSelect>(N)->FalseVal);}},
  {"carry-width",[](auto& S,auto&){const auto N=S.Merge(true);if(!N)return false;S.IR.template GetOp<IROp_Bfi>(N)->Width=2;return true;}},
  {"carry-shift",[](auto& S,auto&){const auto N=S.Merge(true);if(!N)return false;S.IR.template GetOp<IROp_Bfi>(N)->lsb=30;return true;}},
  {"carry-source",[](auto& S,auto&){const auto N=S.Merge(true);if(!N)return false;S.IR.template GetOp<IROp_Bfi>(N)->Src=S.IR.WrapNode(S.Find(OP_LOADREGISTER));return true;}},
  {"NZCV-store",[](auto& S,auto&){const auto N=S.Find(OP_STORENZCV);if(!N)return false;S.Op(N)->Args[0]=S.IR.WrapNode(S.Find(OP_LOADNZCV));return true;}},
  {"carry-save-order",[](auto& S,auto& C){const auto N=S.Find(OP_NZCVSELECT);if(!N)return false;S.Before(S.Flags(C),N);return true;}},
  {"destination-register",[](auto& S,auto&){const auto N=S.Find(OP_STOREREGISTER);auto R=PhysicalRegister(N);N->Reg=PhysicalRegister(RegClass::GPRFixed,R.Reg^1).Raw;return true;}},
  {"destination-source",[](auto& S,auto&){S.Op(S.Find(OP_STOREREGISTER))->Args[0]=S.IR.WrapNode(S.Find(OP_LOADREGISTER));return true;}},
  {"destination-order",[](auto& S,auto& C){S.Before(S.Find(OP_STOREREGISTER),S.Result(C));return true;}},
  {"exit-width",[](auto& S,auto&){S.Op(S.Find(OP_EXITFUNCTION))->Size=OpSize::i32Bit;return true;}},
  {"extra-effect",[](auto& S,auto&){S.Op(S.Find(OP_GUESTOPCODE))->Op=OP_SYSCALL;return true;}},
 };
 constexpr uint64_t RIP=0x123400008000;unsigned Checked=0,Unexpected=0,Aliases=0,Truncations=0,RawRefusals=0;
 for(unsigned Kind=1;Kind<=4;Kind++)for(bool Byte:{false,true})for(bool Word:{false,true})for(unsigned Rex=0;Rex<=16;Rex++)for(unsigned RM=0;RM<8;RM++){
  const unsigned R=Rex?0x3f+Rex:0,Group=Kind<=2?(Kind==1?3:2):Kind-3,Opcode=Kind<=2?(Byte?0xf6:0xf7):(Byte?0xfe:0xff),Shift=Byte&&!R&&RM>=4?8:0,Width=Byte?1:R&8?8:Word?2:4,Register=Shift?RM-4:RM+(R&1?8:0);
  std::vector<uint8_t> Code;if(Word)Code.push_back(0x66);if(R)Code.push_back(R);Code.insert(Code.end(),{uint8_t(Opcode),uint8_t(0xc0|Group<<3|RM)});
  const auto P=fexwasm::broker::Admit(Code.data(),Code.size());if(!P.Supported||P.Operation!=6||P.Width||P.UnaryKind!=Kind||P.UnaryWidth!=Width||P.UnaryShift!=Shift||P.Register!=Register||P.Length!=Code.size())return 1;
  for(unsigned N=0;N<Code.size();N++){if(fexwasm::broker::Admit(Code.data(),N).Supported)return 2;Truncations++;}
  Host.MapGuest(RIP,Code.data(),Code.size());uint64_t Count=0;const auto* Original=Host.GenerateIR(RIP,&Count);if(!Original||Count!=1||Host.InstructionLength(RIP)!=Code.size())return 3;Aliases++;
  for(const auto& C:Cases){std::vector<uint8_t> Data(Original->GetDataSize()),List(Original->GetListSize());memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());IRListView IR(Data.data(),List.data(),Data.size(),List.size());UnaryShape S{IR};auto Cfg=UnaryConfig(P,RIP);if(!C.Change(S,Cfg))continue;
   const auto Result=fexwasm::Compile(IR,RIP,Cfg);const bool Valid=!strcmp(C.Name,"valid"),OK=Valid?(Result.Error.empty()&&!Result.Module.empty()):(!Result.Error.empty()&&Result.Module.empty());Checked++;Unexpected+=!OK;
   if(!OK){printf("[UNEXPECTED] ");for(auto B:Code)printf("%02x",unsigned(B));printf(" %s: %s\n",C.Name,Result.Error.empty()?"ACCEPTED":Result.Error.c_str());}
  }Host.Release();Host.DiscardIR(RIP);
 }
 for(unsigned Opcode:{0xf6u,0xf7u,0xfeu,0xffu})for(unsigned ModRM=0;ModRM<192;ModRM++){
  const unsigned G=ModRM>>3&7;if((Opcode>=0xfe&&G>1)||(Opcode<0xfe&&G!=2&&G!=3))continue;const uint8_t B[]={uint8_t(Opcode),uint8_t(ModRM),0,0,0,0,0,0,0,0};const auto P=fexwasm::broker::Admit(B,sizeof(B));if(P.Supported)return 4;RawRefusals++;
 }
 printf("checked %u actual unary IR copies across %u aliases; truncations %u; memory refusals %u; unexpected %u\n",Checked,Aliases,Truncations,RawRefusals,Unexpected);return Unexpected?1:0;
}

int main(int argc,char** argv) {
  if(argc!=1&&(argc!=2||strcmp(argv[1],"--dump")))return 2;
  fexwasm::FexHost::Options O;O.Multiblock=false;O.MaxInstructions=1;O.DebugGuestInstructions=true;fexwasm::FexHost Host(O);
  if(argc==1)return Controls(Host);
  constexpr uint64_t RIP=0x123400008000;
  for(unsigned Kind=0;Kind<4;Kind++)for(unsigned Form=0;Form<8;Form++){
    const bool Byte=Form<3;const unsigned Group=Kind<2?(Kind==0?3:2):Kind-2,Op=Kind<2?(Byte?0xf6:0xf7):(Byte?0xfe:0xff);
    std::vector<uint8_t> Code;if(Form==3||Form==7)Code.push_back(0x66);
    if(Form==2)Code.push_back(0x40);if(Form==4)Code.push_back(0x41);if(Form==5)Code.push_back(0x49);if(Form==6||Form==7)Code.push_back(0x48);
    Code.push_back(Op);Code.push_back(0xc0|(Group<<3)|(Form==1||Form==2||Form==4||Form==5?4:0));
    printf("\n=== kind%u form%u",Kind,Form);for(auto B:Code)printf(" %02x",unsigned(B));printf(" ===\n");
    Host.MapGuest(RIP,Code.data(),Code.size());uint64_t Count=0;const auto* IR=Host.GenerateIR(RIP,&Count);if(!IR||Count!=1||Host.InstructionLength(RIP)!=Code.size())return 1;
    fextl::stringstream Out;FEXCore::IR::Dump(&Out,IR);printf("%s\n",Out.str().c_str());Host.Release();Host.DiscardIR(RIP);
  }
}
