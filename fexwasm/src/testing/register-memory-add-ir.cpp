// SPDX-License-Identifier: GPL-3.0-or-later
// Strict IR regression: mutate copies of actual FEX single-instruction
// IR, then require the production broker compiler to reject malformed ADD/SUB proofs.
// No native guest JIT and no guest code execution occur in this diagnostic.
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
  const IRListView& IR;
  Ref Load {}, Add {}, Store {}, Source {}, AF {}, PF {}, NZCV {}, ReadNZCV {}, Auxiliary {}, Carry {}, Marker {}, Exit {};
  explicit Shape(const IRListView& View) : IR(View) {
    for (auto [Block, Header] : IR.GetBlocks()) for (auto [Node, H] : IR.GetCode(Block)) {
      switch (H->Op) {
      case OP_GUESTOPCODE: Marker=Node; break;
      case OP_EXITFUNCTION: Exit=Node; break;
      case OP_LOADMEM: case OP_LOADMEMTSO: Load=Node; break;
      case OP_SUBWITHFLAGS: case OP_ADDWITHFLAGS: Add=Node; Source=IR.GetNode(H->Args[0]); break;
      case OP_STOREREGISTER: Store=Node; break;
      case OP_STOREAF: AF=Node; Auxiliary=IR.GetNode(H->Args[0]); break;
      case OP_STOREPF: PF=Node; break;
      case OP_LOADNZCV: ReadNZCV=Node; break;
      case OP_STORENZCV: NZCV=Node; Carry=IR.GetNode(H->Args[0]); break;
      default: break;
      }
    }
  }
  IROp_Header* Op(Ref N) { return IR.GetOp<IROp_Header>(N); }
  void Before(Ref N, Ref Target) { N->Unlink(IR.GetListData()); Target->prepend(IR.GetListData(),N); }
  void After(Ref N, Ref Target) { N->Unlink(IR.GetListData()); Target->append(IR.GetListData(),N); }
};
struct Case { const char* Name; std::function<void(Shape&)> Mutate; std::function<bool(const Shape&)> Applicable {}; };
int main() {
  const Case Cases[] = {
    {"valid",[](Shape&){}},
    {"wrong-operation-plan",[](Shape&){}},
    {"profile-width",[](Shape&){}},
    {"profile-register",[](Shape&){}},
    {"profile-flow",[](Shape&){}},
    {"profile-target",[](Shape&){}},
    {"profile-next",[](Shape&){}},
    {"profile-no-effects",[](Shape&){}},
    {"profile-TEST-shift",[](Shape&){}},
    {"profile-TEST-mask",[](Shape&){}},
    {"profile-SETcc-shift",[](Shape&){}},
    {"profile-BT-register",[](Shape&){}},
    {"profile-BT-index",[](Shape&){}},
    {"profile-TEST",[](Shape&){}},
    {"profile-SETcc",[](Shape&){}},
    {"profile-BT",[](Shape&){}},
    {"wrong-arithmetic-kind",[](Shape& S){S.Op(S.Add)->Op=S.Op(S.Add)->Op==OP_ADDWITHFLAGS?OP_SUBWITHFLAGS:OP_ADDWITHFLAGS;}},
    {"extra-nzcv-store",[](Shape& S){S.Op(S.Marker)->Op=OP_STORENZCV;}},
    {"extra-context-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STORECONTEXT;}},
    {"destination-after-add",[](Shape& S){S.After(S.Source,S.Add);}},
    {"reversed-add-inputs",[](Shape& S){std::swap(S.Op(S.Add)->Args[0],S.Op(S.Add)->Args[1]);}},
    {"wrong-destination-register",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Reg^=1;}},
    {"wrong-stored-register",[](Shape& S){const auto R=PhysicalRegister(S.Store);S.Store->Reg=PhysicalRegister(RegClass::GPRFixed,R.Reg^1).Raw;}},
    {"wrong-memory-alignment",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->Align=OpSize::i16Bit;}},
    {"wrong-store-class",[](Shape& S){const auto R=PhysicalRegister(S.Store);S.Store->Reg=PhysicalRegister(RegClass::FPRFixed,R.Reg).Raw;}},
    {"wrong-memory-class",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->Class=RegClass::FPR;}},
    {"wrong-offset-kind",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->OffsetType=MemOffsetType::UXTW;}},
    {"wrong-offset-scale",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->OffsetScale=3;}},
    {"extra-memory-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREMEM;}},
    {"extra-syscall",[](Shape& S){S.Op(S.Marker)->Op=OP_SYSCALL;}},
    {"call-exit",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->Hint=BranchHint::Call;}},
    {"stale-nzcv-read-before-add",[](Shape& S){S.Before(S.ReadNZCV,S.Add);},[](const Shape& S){return bool(S.ReadNZCV);}},
    {"carry-xor-before-nzcv-producer",[](Shape& S){S.Before(S.Carry,S.ReadNZCV);},[](const Shape& S){return bool(S.ReadNZCV);}},
    {"nzcv-store-before-carry-producer",[](Shape& S){S.Before(S.NZCV,S.Carry);},[](const Shape& S){return bool(S.ReadNZCV);}},
    {"pf-store-before-add-producer",[](Shape& S){S.Before(S.PF,S.Add);}},
    {"af-store-before-xor-producer",[](Shape& S){S.Before(S.AF,S.Auxiliary);}},
    {"af-store-before-add",[](Shape& S){S.Before(S.AF,S.Add);}},
    {"early-exit-before-load",[](Shape& S){S.Before(S.Exit,S.Load);}},
    {"early-exit-before-add",[](Shape& S){S.Before(S.Exit,S.Add);}},
    {"early-exit-before-linked-store",[](Shape& S){S.Before(S.Exit,S.Store);}},
    {"af-store-after-exit",[](Shape& S){S.After(S.AF,S.Exit);}},
    {"pf-store-after-exit",[](Shape& S){S.After(S.PF,S.Exit);}},
    {"nzcv-store-after-exit",[](Shape& S){S.After(S.NZCV,S.Exit);},[](const Shape& S){return bool(S.ReadNZCV);}},
    {"add-before-memory-load",[](Shape& S){S.Before(S.Add,S.Load);}},
    {"store-before-add",[](Shape& S){S.Before(S.Store,S.Add);}},
    {"address-producer-after-memory-load",[](Shape& S){S.Before(S.IR.GetNode(S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr),S.Add);}},
    {"offset-producer-after-memory-load",[](Shape& S){S.Before(S.IR.GetNode(S.IR.GetOp<IROp_LoadMem>(S.Load)->Offset),S.Add);},
      [](const Shape& S){return !S.IR.GetOp<IROp_LoadMem>(S.Load)->Offset.IsInvalid();}},
    {"address-child-after-parent",[](Shape& S){const auto A=S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr;S.Before(S.IR.GetNode(S.IR.GetOp<IROp_Header>(A)->Args[0]),S.Load);},
      [](const Shape& S){const auto* H=S.IR.GetOp<IROp_Header>(S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr);return H->Op==OP_ADDSHIFT||H->Op==OP_ADD;}},
    {"wrong-stored-value",[](Shape& S){S.Op(S.Store)->Args[0]=S.IR.WrapNode(S.Load);}},
    {"wrong-load-width",[](Shape& S){S.Op(S.Load)->Size=OpSize::i16Bit;}},
    {"wrong-store-width",[](Shape& S){S.Op(S.Store)->Size=OpSize::i16Bit;}},
    {"wrong-add-width",[](Shape& S){S.Op(S.Add)->Size=OpSize::i16Bit;}},
    {"wrong-source-width",[](Shape& S){S.Op(S.Source)->Size=OpSize::i32Bit;}},
    {"wrong-nzcv-read-width",[](Shape& S){S.Op(S.ReadNZCV)->Size=OpSize::i64Bit;},[](const Shape& S){return bool(S.ReadNZCV);}},
    {"wrong-carry-xor-width",[](Shape& S){S.Op(S.Carry)->Size=OpSize::i64Bit;},[](const Shape& S){return bool(S.ReadNZCV);}},
    {"wrong-nzcv-store-width",[](Shape& S){S.Op(S.NZCV)->Size=OpSize::i64Bit;},[](const Shape& S){return bool(S.ReadNZCV);}},
    {"wrong-af-xor-width",[](Shape& S){S.Op(S.Auxiliary)->Size=OpSize::i32Bit;}},
    {"wrong-af-store-width",[](Shape& S){S.Op(S.AF)->Size=OpSize::i32Bit;}},
    {"wrong-pf-store-width",[](Shape& S){S.Op(S.PF)->Size=OpSize::i32Bit;}},
    {"wrong-af-value",[](Shape& S){S.Op(S.AF)->Args[0]=S.IR.WrapNode(S.Add);}},
    {"wrong-pf-value",[](Shape& S){S.Op(S.PF)->Args[0]=S.IR.WrapNode(S.Load);}},
    {"wrong-carry-inversion",[](Shape& S){S.IR.GetOp<IROp_InlineConstant>(S.Op(S.Carry)->Args[1])->Constant=0x10000000;},[](const Shape& S){return bool(S.ReadNZCV);}},
    {"extra-nzcv-read",[](Shape& S){S.Op(S.Marker)->Op=OP_LOADNZCV;S.Op(S.Marker)->Size=OpSize::i32Bit;}}
  };
  const std::vector<std::vector<unsigned char>> Forms = {{3,0x10},{0x48,3,0x10},{0x48,3,0},{3,0},{0x48,3,0x0c,0x88},{3,0x0c,0x88},{0x4f,3,0x54,0xac,0x80},{0x47,3,0x54,0xac,0x80},{0x48,3,0x15,0,0,0,0},{3,0x15,0,0,0,0},{0x48,3,0x20},{3,0x20},{0x4a,3,0x14,0xa0},{0x42,3,0x14,0xa0},{0x48,3,0x0c,0x89},{3,0x0c,0x89},{0x49,3,0x15,0,0,0,0},{0x41,3,0x15,0,0,0,0},{0x48,3,0x14,0xc8},{3,0x14,0xc8},{0x48,3,0x14,0x48},{3,0x14,0x48},{0x48,3,4,0x25,0,0,1,0},{3,4,0x25,0,0,1,0}};
  fexwasm::FexHost::Options HO; HO.MaxInstructions=1; HO.DebugGuestInstructions=true; HO.Multiblock=false;
  fexwasm::FexHost Host(HO); unsigned Checked=0, Unexpected=0;
  for (bool Subtract : {false,true}) for (auto Bytes : Forms) {
    if (Subtract) Bytes[Bytes[0]>=0x40&&Bytes[0]<=0x4f?1:0]=0x2b;
    const uint64_t RIP=0x123400008000;
    if (!Host.MapGuest(RIP,Bytes.data(),Bytes.size())) return 2;
    uint64_t Instructions=0; const auto* Original=Host.GenerateIR(RIP,&Instructions);
    if (!Original||Instructions!=1) return 3;
    for (const auto& C : Cases) {
      std::vector<unsigned char> Data(Original->GetDataSize()),List(Original->GetListSize());
      std::memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());
      std::memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());
      IRListView IR(Data.data(),List.data(),Data.size(),List.size()); Shape S(IR);
      if (!S.Load||!S.Add||!S.Store||!S.AF||!S.PF||(!Subtract&&(!S.NZCV||!S.ReadNZCV))||!S.Marker||!S.Exit) return 4;
      if (C.Applicable&&!C.Applicable(S)) continue;
      C.Mutate(S);
      fexwasm::BackendConfig Cfg; Cfg.BrokerMemory=true; const auto Plan=fexwasm::broker::Admit(Bytes.data(),Bytes.size());if(!Plan.Supported||Plan.Operation!=(Subtract?18u:15u))return 5;Cfg.BrokerOperation=Plan.Operation;Cfg.BrokerWidth=Plan.Width;Cfg.BrokerTargetRegister=Plan.Register;
      Cfg.BrokerNextRIP=RIP+Host.InstructionLength(RIP); Cfg.SharedMemory=true; Cfg.ThreadBaseGlobal=true;
      Cfg.MemPages=Cfg.MemMaxPages=fexwasm::broker::Pages; Cfg.RegArgs=0; Cfg.CallsViaDispatcher=false;
      if (!strcmp(C.Name,"wrong-operation-plan")) Cfg.BrokerOperation=Subtract?15:18;
      if (!strcmp(C.Name,"profile-width")) Cfg.BrokerWidth=2;
      if (!strcmp(C.Name,"profile-register")) Cfg.BrokerTargetRegister=16;
      if (!strcmp(C.Name,"profile-flow")) Cfg.BrokerFlow=1;
      if (!strcmp(C.Name,"profile-target")) Cfg.BrokerTarget=RIP;
      if (!strcmp(C.Name,"profile-next")) Cfg.BrokerNextRIP++;
      if (!strcmp(C.Name,"profile-no-effects")) Cfg.BrokerNoEffects=true;
      if (!strcmp(C.Name,"profile-TEST-shift")) Cfg.BrokerTestShift=1;
      if (!strcmp(C.Name,"profile-TEST-mask")) Cfg.BrokerTestMask=1;
      if (!strcmp(C.Name,"profile-SETcc-shift")) Cfg.BrokerSetShift=1;
      if (!strcmp(C.Name,"profile-BT-register")) Cfg.BrokerBitRegister=0;
      if (!strcmp(C.Name,"profile-BT-index")) Cfg.BrokerBitIndex=1;
      if (!strcmp(C.Name,"profile-TEST")) Cfg.BrokerTestWidth=4;
      if (!strcmp(C.Name,"profile-SETcc")) Cfg.BrokerSetCondition=0;
      if (!strcmp(C.Name,"profile-BT")) Cfg.BrokerBitWidth=4;
      const auto R=fexwasm::Compile(IR,RIP,Cfg); const bool Expected=std::strcmp(C.Name,"valid")==0;
      const bool OK=Expected ? (R.Error.empty() && !R.Module.empty()) : (!R.Error.empty() && R.Module.empty()); Checked++; Unexpected+=!OK;
      printf("%s %s width%u %s: %s%s\n",Subtract?"SUB":"ADD",C.Name,Cfg.BrokerWidth*8,Bytes.size()>3?"address-form":"base",R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
    }
    Host.Release();
  }
  unsigned RawChecked=0,RawRefused=0;
  for (unsigned Rex=0;Rex<17;Rex++) for (unsigned Opcode : {3u,0x2bu}) for (unsigned M=0;M<256;M++) {
    const unsigned Mod=M>>6,RM=M&7;
    for (unsigned SIB=0;SIB<(Mod!=3&&RM==4?256u:1u);SIB++) {
      std::vector<unsigned char> Bytes;if(Rex)Bytes.push_back(0x3f+Rex);Bytes.push_back(Opcode);Bytes.push_back(M);
      unsigned Displacement=Mod==1?1:Mod==2?4:0;
      if(Mod!=3&&RM==4){Bytes.push_back(SIB);if(Mod==0&&(SIB&7)==5)Displacement=4;}
      else if(Mod==0&&RM==5)Displacement=4;
      for(unsigned I=0;I<Displacement;I++)Bytes.push_back(I?0xff:0x80);
      const bool Refused=Mod==0&&RM==4&&(SIB&7)==5&&Rex&&((0x3f+Rex)&1);
      const auto A=fexwasm::broker::Admit(Bytes.data(),Bytes.size());RawChecked++;RawRefused+=Refused;
      const unsigned ExpectedOperation=Mod==3?6u:Opcode==3?15u:18u;
      if(Refused){if(A.Supported)return 6;}
      else if(!A.Supported||A.Operation!=ExpectedOperation)return 6;
      else if(Mod!=3&&(A.Length!=Bytes.size()||A.Width!=((Rex&&((0x3f+Rex)&8))?8u:4u)||
          A.Register!=((M>>3&7)+((Rex&&((0x3f+Rex)&4))?8:0))))return 6;
    }
  }
  printf("checked %u actual register-memory ADD/SUB IR copies; unexpected %u; raw encodings %u; raw exclusions %u\n",Checked,Unexpected,RawChecked,RawRefused); return Unexpected?1:0;
}
