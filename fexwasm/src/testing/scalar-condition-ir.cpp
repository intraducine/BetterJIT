// SPDX-License-Identifier: GPL-3.0-or-later
// Copied actual frontend IR diagnostics for the scalar/condition batch.
#include "backend.h"
#include "broker_step.h"
#include "fexhost.h"
#include <FEXCore/fextl/sstream.h>
#include "Interface/IR/IR.h"
#include "Interface/IR/IntrusiveIRList.h"
#include "Interface/IR/RegisterAllocationData.h"
#include <functional>
#include <cstdio>
#include <cstring>
#include <vector>

using namespace FEXCore::IR;
struct CallShape {
  const IRListView& IR;
  Ref Target{}, SP{}, Push{}, Store{}, Exit{}, Marker{};
  CallShape(const IRListView& V,unsigned Register):IR(V) {
    for (auto [Block,Header]:IR.GetBlocks()) for (auto [N,H]:IR.GetCode(Block)) switch(H->Op) {
    case OP_LOADREGISTER:
      if(H->C<IROp_LoadRegister>()->Reg==Register)Target=N;
      if(H->C<IROp_LoadRegister>()->Reg==4)SP=N;
      break;
    case OP_PUSH:Push=N;break;case OP_STOREREGISTER:Store=N;break;
    case OP_EXITFUNCTION:Exit=N;break;case OP_GUESTOPCODE:Marker=N;break;default:break;
    }
  }
  IROp_Header* Op(Ref N){return IR.GetOp<IROp_Header>(N);}
  void Before(Ref N,Ref TargetNode){N->Unlink(IR.GetListData());TargetNode->prepend(IR.GetListData(),N);}
  void After(Ref N,Ref TargetNode){N->Unlink(IR.GetListData());TargetNode->append(IR.GetListData(),N);}
};
static fexwasm::BackendConfig CallConfig(const fexwasm::broker::Admission& P,uint64_t RIP) {
  fexwasm::BackendConfig C;C.BrokerMemory=true;C.BrokerOperation=P.Operation;C.BrokerWidth=P.Width;C.BrokerFlow=P.Flow;C.BrokerTargetRegister=P.Register;C.BrokerNextRIP=RIP+P.Length;
  C.SharedMemory=true;C.ThreadBaseGlobal=true;C.MemPages=C.MemMaxPages=fexwasm::broker::Pages;C.RegArgs=0;C.CallsViaDispatcher=false;return C;
}
static int CallControls(fexwasm::FexHost& Host) {
  struct Case {const char* Name;std::function<void(CallShape&,fexwasm::BackendConfig&)> Change;bool Separate=false;};
  const Case Cases[]={
    {"valid",[](auto&,auto&){}},
    {"operation",[](auto&,auto& C){C.BrokerOperation=6;}},
    {"width",[](auto&,auto& C){C.BrokerWidth=4;}},
    {"flow",[](auto&,auto& C){C.BrokerFlow=5;}},
    {"target-metadata",[](auto&,auto& C){C.BrokerTarget=0x123400008100;}},
    {"selected-register",[](auto&,auto& C){C.BrokerTargetRegister^=1;}},
    {"next-PC",[](auto&,auto& C){C.BrokerNextRIP++;}},
    {"word-profile",[](auto&,auto& C){C.BrokerWordCompare=true;}},
    {"test-profile",[](auto&,auto& C){C.BrokerTestWidth=4;}},
    {"not-shared",[](auto&,auto& C){C.SharedMemory=false;}},
    {"NOP-profile",[](auto&,auto& C){C.BrokerNoEffects=true;}},
    {"target-register",[](auto& S,auto&){S.IR.template GetOp<IROp_LoadRegister>(S.Target)->Reg^=1;}},
    {"target-class",[](auto& S,auto&){S.IR.template GetOp<IROp_LoadRegister>(S.Target)->Class=RegClass::FPR;}},
    {"target-width",[](auto& S,auto&){S.Op(S.Target)->Size=OpSize::i32Bit;}},
    {"stack-register",[](auto& S,auto&){S.IR.template GetOp<IROp_LoadRegister>(S.SP)->Reg^=1;}},
    {"stack-width",[](auto& S,auto&){S.Op(S.SP)->Size=OpSize::i32Bit;}},
    {"target-after-push",[](auto& S,auto&){S.After(S.Target,S.Push);}},
    {"stack-after-push",[](auto& S,auto&){S.After(S.SP,S.Push);}},
    {"return-PC",[](auto& S,auto&){auto W=S.IR.template GetOp<IROp_Push>(S.Push)->Value;auto H=S.IR.template GetOp<IROp_Header>(W);if(H->Op==OP_ENTRYPOINTOFFSET)S.IR.template GetOp<IROp_EntrypointOffset>(W)->Offset++;else S.IR.template GetOp<IROp_InlineEntrypointOffset>(W)->Offset++;}},
    {"push-address",[](auto& S,auto&){S.IR.template GetOp<IROp_Push>(S.Push)->Addr=S.IR.WrapNode(S.Target);},true},
    {"push-width",[](auto& S,auto&){S.Op(S.Push)->Size=OpSize::i32Bit;}},
    {"push-value-width",[](auto& S,auto&){S.IR.template GetOp<IROp_Push>(S.Push)->ValueSize=OpSize::i32Bit;}},
    {"store-register",[](auto& S,auto&){S.Store->Reg=PhysicalRegister(RegClass::GPRFixed,0).Raw;}},
    {"store-source",[](auto& S,auto&){S.IR.template GetOp<IROp_StoreRegister>(S.Store)->Value=S.IR.WrapNode(S.Target);}},
    {"store-before-push",[](auto& S,auto&){S.Before(S.Store,S.Push);}},
    {"store-after-exit",[](auto& S,auto&){S.After(S.Store,S.Exit);}},
    {"exit-target",[](auto& S,auto&){S.IR.template GetOp<IROp_ExitFunction>(S.Exit)->NewRIP=S.IR.WrapNode(S.SP);},true},
    {"exit-hint",[](auto& S,auto&){S.IR.template GetOp<IROp_ExitFunction>(S.Exit)->Hint=BranchHint::None;}},
    {"exit-return-PC",[](auto& S,auto&){S.IR.template GetOp<IROp_ExitFunction>(S.Exit)->CallReturnAddress=S.IR.WrapNode(S.SP);}},
    {"exit-return-block",[](auto& S,auto&){S.IR.template GetOp<IROp_ExitFunction>(S.Exit)->CallReturnBlock=S.IR.WrapNode(S.SP);}},
    {"exit-width",[](auto& S,auto&){S.Op(S.Exit)->Size=OpSize::i32Bit;}},
    {"extra-effect",[](auto& S,auto&){S.Op(S.Marker)->Op=OP_SYSCALL;}},
  };
  constexpr uint64_t RIP=0x123400008000;
  unsigned Checked=0,Unexpected=0,Aliases=0,Refused=0;
  for(unsigned Rex=0;Rex<=16;Rex++)for(unsigned Low=0;Low<8;Low++) {
    std::vector<uint8_t> Code;if(Rex)Code.push_back(0x3f+Rex);Code.insert(Code.end(),{0xff,uint8_t(0xd0+Low)});
    const auto P=fexwasm::broker::Admit(Code.data(),Code.size());const unsigned Register=Low+(Rex&&((0x3f+Rex)&1)?8:0);
    if(!P.Supported||P.Operation!=9||P.Width!=8||P.Flow!=6||P.Register!=Register||P.Length!=Code.size())return 1;
    for(unsigned N=0;N<Code.size();N++){if(fexwasm::broker::Admit(Code.data(),N).Supported)return 1;Refused++;}
    Host.MapGuest(RIP,Code.data(),Code.size());uint64_t Count=0;const auto* Original=Host.GenerateIR(RIP,&Count);
    if(!Original||Count!=1)return 1;Aliases++;
    for(const auto& C:Cases) {
      if(C.Separate&&Register==4)continue;
      std::vector<uint8_t> Data(Original->GetDataSize()),List(Original->GetListSize());
      memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());
      IRListView IR(Data.data(),List.data(),Data.size(),List.size());CallShape S(IR,Register);auto Cfg=CallConfig(P,RIP);C.Change(S,Cfg);
      const auto Result=fexwasm::Compile(IR,RIP,Cfg);const bool Valid=!strcmp(C.Name,"valid"),OK=Valid?(Result.Error.empty()&&!Result.Module.empty()):(!Result.Error.empty()&&Result.Module.empty());
      Checked++;Unexpected+=!OK;
      printf("register-CALL r%u rex%u %s: %s%s\n",Register,Rex,C.Name,Result.Error.empty()?"ACCEPTED":Result.Error.c_str(),OK?"":" [UNEXPECTED]");
    }
    Host.Release();Host.DiscardIR(RIP);
  }
  for(unsigned Prefix:{0x66u,0x67u,0x64u,0x65u,0xf0u,0xf2u,0xf3u}) {
    const uint8_t B[]={uint8_t(Prefix),0xff,0xd0};if(fexwasm::broker::Admit(B,sizeof(B)).Supported)return 1;Refused++;
  }
  for(unsigned ModRM=0;ModRM<256;ModRM++)if((ModRM&0xf8)!=0xd0) {
    const uint8_t B[]={0xff,uint8_t(ModRM)};const auto P=fexwasm::broker::Admit(B,sizeof(B));
    if(P.Supported&&P.Operation==9)return 1;Refused++;
  }
  printf("checked %u actual register-CALL IR copies across %u aliases; raw refusals %u; unexpected %u\n",Checked,Aliases,Refused,Unexpected);
  return Unexpected?1:0;
}

struct ScalarShape {
  const IRListView& IR;
  Ref Find(IROps Kind) const {for(auto [B,BH]:IR.GetBlocks())for(auto [N,H]:IR.GetCode(B))if(H->Op==Kind)return N;return {};}
  IROp_Header* Op(Ref N) const {return IR.GetOp<IROp_Header>(N);}
  void Before(Ref N,Ref T) {N->Unlink(IR.GetListData());T->prepend(IR.GetListData(),N);}
};
static fexwasm::BackendConfig ScalarConfig(const fexwasm::broker::Admission& P,uint64_t RIP,const std::vector<uint8_t>& Code) {
  auto C=CallConfig(P,RIP);C.BrokerNextRIP=RIP+Code.size();
  C.BrokerWordCompare=P.WordCompare;C.BrokerCompareKind=P.CompareKind;C.BrokerCompareImmediate=P.CompareImmediate;
  C.BrokerCompareLeftRegister=P.CompareLeftRegister;C.BrokerCompareRightRegister=P.CompareRightRegister;
  C.BrokerCompareBase=P.CompareBase;C.BrokerCompareIndex=P.CompareIndex;C.BrokerCompareScale=P.CompareScale;C.BrokerCompareDisplacement=P.CompareDisplacement;C.BrokerCompareRIPRelative=P.CompareRIPRelative;
  C.BrokerLogicalWidth=P.LogicalWidth;C.BrokerLogicalKind=P.LogicalKind;C.BrokerLogicalMask=P.LogicalMask;
  C.BrokerConditionCode=P.ConditionCode;C.BrokerConditionalMoveWidth=P.ConditionalMoveWidth;C.BrokerConditionSourceRegister=P.ConditionSourceRegister;
  if(P.Flow==2) {const auto N=Code.size();uint32_t Raw=0;for(unsigned J=0;J<(N==2?1u:4u);J++)Raw|=uint32_t(Code[(N==2?1:2)+J])<<(8*J);C.BrokerTarget=C.BrokerNextRIP+(N==2?int64_t(int8_t(Raw)):int64_t(int32_t(Raw)));}
  return C;
}
static int ScalarControls(fexwasm::FexHost& Host) {
  struct Case {const char* Name;std::function<bool(ScalarShape&,fexwasm::BackendConfig&)> Change;};
  const Case Cases[]={
    {"valid",[](auto&,auto&){return true;}},
    {"operation",[](auto&,auto& C){C.BrokerOperation^=1;return true;}},
    {"width",[](auto&,auto& C){C.BrokerWidth^=4;return true;}},
    {"next-PC",[](auto&,auto& C){C.BrokerNextRIP++;return true;}},
    {"flow",[](auto&,auto& C){C.BrokerFlow^=1;return true;}},
    {"NOP-profile",[](auto&,auto& C){C.BrokerNoEffects=true;return true;}},
    {"unshared",[](auto&,auto& C){C.SharedMemory=false;return true;}},
    {"extra-effect",[](auto& S,auto&){const auto N=S.Find(OP_GUESTOPCODE);if(!N)return false;S.Op(N)->Op=OP_SYSCALL;return true;}},
    {"CMP-kind",[](auto&,auto& C){if(!C.BrokerWordCompare)return false;C.BrokerCompareKind=(C.BrokerCompareKind+1)%5;return true;}},
    {"CMP-left-register",[](auto&,auto& C){if(!C.BrokerWordCompare)return false;C.BrokerCompareLeftRegister^=1;return true;}},
    {"CMP-right-register",[](auto&,auto& C){if(!C.BrokerWordCompare)return false;C.BrokerCompareRightRegister^=1;return true;}},
    {"CMP-immediate",[](auto&,auto& C){if(!C.BrokerWordCompare)return false;C.BrokerCompareImmediate^=1;return true;}},
    {"CMP-address",[](auto&,auto& C){if(!C.BrokerWordCompare)return false;C.BrokerCompareDisplacement++;return true;}},
    {"logical-mask",[](auto&,auto& C){if(!C.BrokerLogicalWidth)return false;C.BrokerLogicalMask^=1;return true;}},
    {"logical-width",[](auto&,auto& C){if(!C.BrokerLogicalWidth)return false;C.BrokerLogicalWidth=4;return true;}},
    {"logical-kind",[](auto&,auto& C){if(!C.BrokerLogicalWidth)return false;C.BrokerLogicalKind=C.BrokerLogicalKind==1?6:1;return true;}},
    {"condition-code",[](auto&,auto& C){if(C.BrokerConditionCode==16)return false;C.BrokerConditionCode^=1;return true;}},
    {"condition-source",[](auto&,auto& C){if(!C.BrokerConditionalMoveWidth)return false;C.BrokerConditionSourceRegister^=1;return true;}},
    {"condition-width",[](auto&,auto& C){if(!C.BrokerConditionalMoveWidth)return false;C.BrokerConditionalMoveWidth^=12;return true;}},
    {"target-register",[](auto&,auto& C){if(C.BrokerTargetRegister==16)return false;C.BrokerTargetRegister^=1;return true;}},
    {"branch-target",[](auto&,auto& C){if(C.BrokerFlow!=2)return false;C.BrokerTarget++;return true;}},
    {"register-width",[](auto& S,auto&){const auto N=S.Find(OP_LOADREGISTER);if(!N)return false;S.Op(N)->Size=OpSize::i32Bit;return true;}},
    {"register-class",[](auto& S,auto&){const auto N=S.Find(OP_LOADREGISTER);if(!N)return false;S.IR.template GetOp<IROp_LoadRegister>(N)->Class=RegClass::FPR;return true;}},
    {"register-selection",[](auto& S,auto&){const auto N=S.Find(OP_LOADREGISTER);if(!N)return false;S.IR.template GetOp<IROp_LoadRegister>(N)->Reg^=1;return true;}},
    {"word-NZCV-width",[](auto& S,auto&){const auto N=S.Find(OP_SUBNZCV);if(!N)return false;S.Op(N)->Size=OpSize::i32Bit;return true;}},
    {"word-NZCV-operand",[](auto& S,auto&){const auto N=S.Find(OP_SUBNZCV);if(!N||S.Op(N)->Args[0]==S.Op(N)->Args[1])return false;S.Op(N)->Args[0]=S.Op(N)->Args[1];return true;}},
    {"word-PF-width",[](auto& S,auto&){const auto N=S.Find(OP_SUB);if(!N)return false;S.Op(N)->Size=OpSize::i64Bit;return true;}},
    {"word-PF-operand",[](auto& S,auto&){const auto N=S.Find(OP_SUB);if(!N||S.Op(N)->Args[0]==S.Op(N)->Args[1])return false;S.Op(N)->Args[1]=S.Op(N)->Args[0];return true;}},
    {"word-AF-dataflow",[](auto& S,auto&){const auto N=S.Find(OP_STOREAF),PF=S.Find(OP_STOREPF);if(!N||!PF)return false;S.Op(N)->Args[0]=S.Op(PF)->Args[0];return true;}},
    {"load-width",[](auto& S,auto&){auto N=S.Find(OP_LOADMEM);if(!N)N=S.Find(OP_LOADMEMTSO);if(!N)return false;S.Op(N)->Size=OpSize::i32Bit;return true;}},
    {"load-scale3",[](auto& S,auto&){auto N=S.Find(OP_LOADMEM);if(!N)N=S.Find(OP_LOADMEMTSO);if(!N)return false;S.IR.template GetOp<IROp_LoadMem>(N)->OffsetScale=3;return true;}},
    {"logical-test-width",[](auto& S,auto& C){if(!C.BrokerLogicalWidth)return false;S.Op(S.Find(OP_TESTNZ))->Size=OpSize::i32Bit;return true;}},
    {"logical-PF-width",[](auto& S,auto& C){if(!C.BrokerLogicalWidth)return false;S.Op(S.Find(OP_STOREPF))->Size=OpSize::i32Bit;return true;}},
    {"logical-AF-invalidation",[](auto& S,auto& C){if(!C.BrokerLogicalWidth)return false;S.IR.template GetOp<IROp_InvalidateFlags>(S.Find(OP_INVALIDATEFLAGS))->Flags=0;return true;}},
    {"logical-result-width",[](auto& S,auto& C){if(!C.BrokerLogicalWidth)return false;Ref N{};for(auto K:{OP_OR,OP_AND,OP_XOR}){const auto R=S.Find(K);if(R&&uint32_t(S.Op(R)->Size)==8)N=R;}if(!N)return false;S.Op(N)->Size=OpSize::i32Bit;return true;}},
    {"select-condition",[](auto& S,auto&){const auto N=S.Find(OP_NZCVSELECT);if(!N)return false;auto* V=S.IR.template GetOp<IROp_NZCVSelect>(N);V->Cond=V->Cond==CondClass::EQ?CondClass::NEQ:CondClass::EQ;return true;}},
    {"select-dataflow",[](auto& S,auto&){const auto N=S.Find(OP_NZCVSELECT);if(!N)return false;auto* V=S.IR.template GetOp<IROp_NZCVSelect>(N);if(V->TrueVal==V->FalseVal)return false;std::swap(V->TrueVal,V->FalseVal);return true;}},
    {"select-width",[](auto& S,auto&){const auto N=S.Find(OP_NZCVSELECT);if(!N)return false;S.Op(N)->Size=S.Op(N)->Size==OpSize::i32Bit?OpSize::i64Bit:OpSize::i32Bit;return true;}},
    {"branch-condition",[](auto& S,auto&){const auto N=S.Find(OP_CONDJUMP);if(!N)return false;auto* V=S.IR.template GetOp<IROp_CondJump>(N);V->Cond=V->Cond==CondClass::EQ?CondClass::NEQ:CondClass::EQ;return true;}},
    {"branch-target-order",[](auto& S,auto& C){const auto N=S.Find(OP_CONDJUMP);if(!N||C.BrokerTarget==C.BrokerNextRIP)return false;auto* V=S.IR.template GetOp<IROp_CondJump>(N);std::swap(V->TrueBlock,V->FalseBlock);return true;}},
    {"branch-flag-source",[](auto& S,auto&){const auto N=S.Find(OP_CONDJUMP);if(!N)return false;auto* V=S.IR.template GetOp<IROp_CondJump>(N);V->FromNZCV=!V->FromNZCV;return true;}},
    {"parity-inversion",[](auto& S,auto&){const auto N=S.Find(OP_PARITY);if(!N)return false;auto* V=S.IR.template GetOp<IROp_Parity>(N);V->Invert=!V->Invert;return true;}},
    {"parity-mask",[](auto& S,auto&){const auto N=S.Find(OP_PARITY);if(!N)return false;S.IR.template GetOp<IROp_Parity>(N)->Mask=true;return true;}},
    {"saved-flags-dataflow",[](auto& S,auto& C){if(!C.BrokerConditionalMoveWidth||(C.BrokerConditionCode!=10&&C.BrokerConditionCode!=11))return false;S.Op(S.Find(OP_STORENZCV))->Args[0]=S.IR.WrapNode(S.Find(OP_PARITY));return true;}},
    {"saved-flags-order",[](auto& S,auto& C){if(!C.BrokerConditionalMoveWidth||(C.BrokerConditionCode!=10&&C.BrokerConditionCode!=11))return false;S.Before(S.Find(OP_STORENZCV),S.Find(OP_NZCVSELECT));return true;}},
    {"destination-register",[](auto& S,auto&){const auto N=S.Find(OP_STOREREGISTER);if(!N)return false;auto R=PhysicalRegister(N);N->Reg=PhysicalRegister(RegClass::GPRFixed,R.Reg^1).Raw;return true;}},
    {"destination-order",[](auto& S,auto&){const auto N=S.Find(OP_STOREREGISTER),Source=S.Find(OP_LOADREGISTER);if(!N||!Source)return false;S.Before(N,Source);return true;}},
    {"exit-width",[](auto& S,auto&){const auto N=S.Find(OP_EXITFUNCTION);if(!N)return false;S.Op(N)->Size=OpSize::i32Bit;return true;}},
  };
  constexpr uint64_t RIP=0x123400008000;std::vector<std::vector<uint8_t>> Codes;
  for(unsigned R=0;R<16;R++){
    const auto Prefix=[&](unsigned Bits){std::vector<uint8_t> V={0x66};if(Bits)V.push_back(0x40|Bits);return V;};
    for(unsigned Op:{0x39u,0x3bu})for(bool Same:{false,true}){const unsigned S=Same?R:(R+1)%16;auto V=Prefix((R>=8?1:0)|(S>=8?4:0));V.insert(V.end(),{uint8_t(Op),uint8_t(0xc0|(S&7)<<3|(R&7))});Codes.push_back(V);}
    for(unsigned Op:{0x39u,0x3bu}){auto V=Prefix(R>=8?4:0);V.insert(V.end(),{uint8_t(Op),uint8_t(0x40|(R&7)<<3),0x40});Codes.push_back(V);}
    for(unsigned Op:{0x81u,0x83u})for(unsigned Mask:{0u,1u,16u,0x80u,0xffffu}){auto V=Prefix(R>=8?1:0);V.insert(V.end(),{uint8_t(Op),uint8_t(0xf8|(R&7)),uint8_t(Mask)});if(Op==0x81)V.push_back(Mask>>8);Codes.push_back(V);}
    for(unsigned Kind:{1u,4u,6u})for(unsigned Mask:{0u,1u,0xffffu})for(unsigned Op:{0x81u,0x83u}){auto V=Prefix((R>=8?1:0)|6);V.insert(V.end(),{uint8_t(Op),uint8_t(0xc0|Kind<<3|(R&7)),uint8_t(Mask)});if(Op==0x81)V.push_back(Mask>>8);Codes.push_back(V);}
    for(unsigned CC=0;CC<16;CC++)for(unsigned Width:{4u,8u})for(bool Same:{false,true}){const unsigned S=Same?R:(R+1)%16;std::vector<uint8_t> V;const auto Rex=(Width==8?8:0)|(R>=8?4:0)|(S>=8?1:0);if(Rex)V.push_back(0x40|Rex);V.insert(V.end(),{0x0f,uint8_t(0x40+CC),uint8_t(0xc0|(R&7)<<3|(S&7))});Codes.push_back(V);}
  }
  for(unsigned CC=0;CC<16;CC++)for(unsigned Disp:{0u,1u,0x80u}){Codes.push_back({uint8_t(0x70+CC),uint8_t(Disp)});Codes.push_back({0x0f,uint8_t(0x80+CC),uint8_t(Disp),0,0,0});}
  for(unsigned Op:{0x0du,0x25u,0x35u,0x3du})for(unsigned Mask:{0u,1u,16u,0x8000u,0xffffu})Codes.push_back({0x66,uint8_t(Op),uint8_t(Mask),uint8_t(Mask>>8)});
  unsigned Checked=0,Unexpected=0,Valid=0;
  for(const auto& Code:Codes){const auto P=fexwasm::broker::Admit(Code.data(),Code.size());if(!P.Supported)return 1;
    Host.MapGuest(RIP,Code.data(),Code.size());uint64_t Count=0;const auto* Original=Host.GenerateIR(RIP,&Count);if(!Original||Count!=1||Host.InstructionLength(RIP)!=Code.size())return 1;
    for(const auto& C:Cases){std::vector<uint8_t> Data(Original->GetDataSize()),List(Original->GetListSize());memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());
      IRListView IR(Data.data(),List.data(),Data.size(),List.size());ScalarShape S{IR};auto Cfg=ScalarConfig(P,RIP,Code);if(!C.Change(S,Cfg))continue;
      const auto Result=fexwasm::Compile(IR,RIP,Cfg);const bool Expected=!strcmp(C.Name,"valid"),OK=Expected?(Result.Error.empty()&&!Result.Module.empty()):(!Result.Error.empty()&&Result.Module.empty());
      Checked++;Valid+=Expected;Unexpected+=!OK;
      if(!OK){printf("[UNEXPECTED] scalar ");for(auto B:Code)printf("%02x",unsigned(B));printf(" %s: %s\n",C.Name,Result.Error.empty()?"ACCEPTED":Result.Error.c_str());}
    }Host.Release();Host.DiscardIR(RIP);
  }
  printf("checked %u actual scalar/condition IR copies, %u valid decoded controls; unexpected %u\n",Checked,Valid,Unexpected);return Unexpected?1:0;
}

int main(int argc, char** argv) {
  if (argc == 2 && !strcmp(argv[1], "--call")) {
    fexwasm::FexHost::Options O;O.Multiblock=false;O.MaxInstructions=1;O.DebugGuestInstructions=true;fexwasm::FexHost Host(O);return CallControls(Host);
  }
  if (argc == 1) {
    fexwasm::FexHost::Options O;O.Multiblock=false;O.MaxInstructions=1;O.DebugGuestInstructions=true;fexwasm::FexHost Host(O);
    const int Calls=CallControls(Host),Scalars=ScalarControls(Host);return Calls||Scalars?1:0;
  }
  if (argc != 2 || strcmp(argv[1], "--dump")) return 2;
  fexwasm::FexHost::Options O;
  O.Multiblock = false; O.MaxInstructions = 1; O.DebugGuestInstructions = true;
  fexwasm::FexHost Host(O);
  constexpr uint64_t RIP = 0x123400008000;
  std::vector<std::vector<uint8_t>> Codes = {
    {0xff,0xd0}, {0xff,0xd4}, {0x41,0xff,0xd0}, {0x4f,0xff,0xd7},
    {0x74,0}, {0x7a,0}, {0x0f,0x44,0xc0}, {0x48,0x0f,0x44,0xc0}, {0x0f,0x4a,0xc0},
    {0x66,0x83,0xc8,0}, {0x66,0x83,0xe0,0xff}, {0x66,0x83,0xf0,0},
    {0x66,0x83,0xf8,0}, {0x66,0x83,0xf8,16}, {0x66,0x81,0xf9,0x34,0x12},
    {0x66,0x3d,0x34,0x12}, {0x66,0x39,0xc8}, {0x66,0x39,0xc0},
    {0x66,0x39,0x48,6}, {0x66,0x3b,0x48,6},
    {0x66,0x83,0xc8,1}, {0x66,0x83,0xe0,1}, {0x66,0x83,0xf0,1},
    {0x66,0x83,0xf0,0xff}, {0x66,0x81,0xe0,0,0},
  };
  for (unsigned CC=0; CC<16; CC++) {
    Codes.push_back({uint8_t(0x70+CC), 0x40});
    Codes.push_back({0x0f, uint8_t(0x40+CC), 0xc1});
    Codes.push_back({0x48, 0x0f, uint8_t(0x40+CC), 0xc1});
  }
  for (const auto& Code : Codes) {
    printf("\n==="); for (auto B : Code) printf(" %02x", unsigned(B)); printf(" ===\n");
    if (!Host.MapGuest(RIP, Code.data(), Code.size())) return 1;
    uint64_t Count=0;
    const auto* IR=Host.GenerateIR(RIP, &Count);
    if (!IR || Count!=1) return 1;
    fextl::stringstream Out; FEXCore::IR::Dump(&Out, IR);
    printf("%s\n", Out.str().c_str());
    Host.Release(); Host.DiscardIR(RIP);
  }
}
