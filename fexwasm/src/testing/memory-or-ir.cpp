// SPDX-License-Identifier: GPL-3.0-or-later
// Mutate copies of actual single-instruction FEX OR IR. No native guest JIT.
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
  Ref Load {}, Result {}, Source {}, Flags {}, Zero {}, Invalidate {}, Store {}, PF {}, Marker {}, Exit {};
  explicit Shape(const IRListView& View) : IR(View) {
    for (auto [Block, Header] : IR.GetBlocks()) for (auto [Node, H] : IR.GetCode(Block)) switch (H->Op) {
    case OP_GUESTOPCODE: Marker=Node; break;
    case OP_LOADMEM: case OP_LOADMEMTSO: Load=Node; break;
    case OP_OR: Result=Node; Source=IR.GetNode(H->Args[1]); break;
    case OP_SUBWITHFLAGS: Flags=Node; Zero=IR.GetNode(H->Args[1]); break;
    case OP_INVALIDATEFLAGS: Invalidate=Node; break;
    case OP_STOREMEM: case OP_STOREMEMTSO: Store=Node; break;
    case OP_STOREPF: PF=Node; break;
    case OP_EXITFUNCTION: Exit=Node; break;
    default: break;
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
    {"profile-width",[](Shape&){}},
    {"profile-flow",[](Shape&){}},
    {"profile-target",[](Shape&){}},
    {"profile-register",[](Shape&){}},
    {"profile-source",[](Shape&){}},
    {"profile-fallthrough",[](Shape&){}},
    {"profile-no-effects",[](Shape&){}},
    {"source-after-load",[](Shape& S){S.After(S.Source,S.Load);}},
    {"wrong-source-register",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Reg^=1;}},
    {"wrong-source-class",[](Shape& S){S.IR.GetOp<IROp_LoadRegister>(S.Source)->Class=RegClass::FPR;}},
    {"wrong-source-width",[](Shape& S){S.Op(S.Source)->Size=OpSize::i32Bit;}},
    {"reversed-or",[](Shape& S){std::swap(S.Op(S.Result)->Args[0],S.Op(S.Result)->Args[1]);}},
    {"arithmetic-add-result",[](Shape& S){S.Op(S.Result)->Op=OP_ADDWITHFLAGS;}},
    {"and-result",[](Shape& S){S.Op(S.Result)->Op=OP_AND;}},
    {"wrong-or-width",[](Shape& S){S.Op(S.Result)->Size=OpSize::i16Bit;}},
    {"or-before-load",[](Shape& S){S.Before(S.Result,S.Load);}},
    {"flags-before-or",[](Shape& S){S.Before(S.Flags,S.Result);}},
    {"wrong-flag-input",[](Shape& S){S.Op(S.Flags)->Args[0]=S.IR.WrapNode(S.Load);}},
    {"nonzero-flag-rhs",[](Shape& S){S.IR.GetOp<IROp_InlineConstant>(S.Zero)->Constant=1;}},
    {"nonconstant-flag-rhs",[](Shape& S){S.Op(S.Flags)->Args[1]=S.IR.WrapNode(S.Source);}},
    {"reversed-sub-flags",[](Shape& S){std::swap(S.Op(S.Flags)->Args[0],S.Op(S.Flags)->Args[1]);}},
    {"wrong-flag-width",[](Shape& S){S.Op(S.Flags)->Size=OpSize::i16Bit;}},
    {"zero-after-flags",[](Shape& S){S.After(S.Zero,S.Flags);}},
    {"arithmetic-add-flags",[](Shape& S){S.Op(S.Flags)->Op=OP_ADDWITHFLAGS;}},
    {"wrong-invalidation-mask",[](Shape& S){S.IR.GetOp<IROp_InvalidateFlags>(S.Invalidate)->Flags=1;}},
    {"wrong-invalidation-width",[](Shape& S){S.Op(S.Invalidate)->Size=OpSize::i32Bit;}},
    {"invalidation-before-or",[](Shape& S){S.Before(S.Invalidate,S.Result);}},
    {"invalidation-after-flags",[](Shape& S){S.After(S.Invalidate,S.Flags);}},
    {"pf-linked-to-or",[](Shape& S){S.Op(S.PF)->Args[0]=S.IR.WrapNode(S.Result);}},
    {"pf-linked-to-load",[](Shape& S){S.Op(S.PF)->Args[0]=S.IR.WrapNode(S.Load);}},
    {"pf-before-flags",[](Shape& S){S.Before(S.PF,S.Flags);}},
    {"wrong-pf-width",[](Shape& S){S.Op(S.PF)->Size=OpSize::i32Bit;}},
    {"store-linked-to-flags",[](Shape& S){S.IR.GetOp<IROp_StoreMem>(S.Store)->Value=S.IR.WrapNode(S.Flags);}},
    {"store-linked-to-old",[](Shape& S){S.IR.GetOp<IROp_StoreMem>(S.Store)->Value=S.IR.WrapNode(S.Load);}},
    {"store-before-flags",[](Shape& S){S.Before(S.Store,S.Flags);}},
    {"wrong-load-width",[](Shape& S){S.Op(S.Load)->Size=OpSize::i16Bit;}},
    {"wrong-store-width",[](Shape& S){S.Op(S.Store)->Size=OpSize::i16Bit;}},
    {"wrong-load-class",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->Class=RegClass::FPR;}},
    {"wrong-store-class",[](Shape& S){S.IR.GetOp<IROp_StoreMem>(S.Store)->Class=RegClass::FPR;}},
    {"wrong-load-align",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->Align=OpSize::i16Bit;}},
    {"wrong-store-align",[](Shape& S){S.IR.GetOp<IROp_StoreMem>(S.Store)->Align=OpSize::i16Bit;}},
    {"wrong-load-offset-kind",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->OffsetType=MemOffsetType::UXTW;}},
    {"wrong-store-offset-kind",[](Shape& S){S.IR.GetOp<IROp_StoreMem>(S.Store)->OffsetType=MemOffsetType::UXTW;}},
    {"wrong-load-scale",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->OffsetScale=3;}},
    {"wrong-store-scale",[](Shape& S){S.IR.GetOp<IROp_StoreMem>(S.Store)->OffsetScale=3;}},
    {"wrong-store-address",[](Shape& S){S.IR.GetOp<IROp_StoreMem>(S.Store)->Addr=S.IR.WrapNode(S.Source);},
      [](const Shape& S){return S.IR.GetOp<IROp_StoreMem>(S.Store)->Addr!=S.IR.WrapNode(S.Source);}},
    {"missing-address",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr=OrderedNodeWrapper {};S.IR.GetOp<IROp_StoreMem>(S.Store)->Addr=OrderedNodeWrapper {};}},
    {"load-address-after-load",[](Shape& S){S.After(S.IR.GetNode(S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr),S.Load);}},
    {"load-offset-after-load",[](Shape& S){S.After(S.IR.GetNode(S.IR.GetOp<IROp_LoadMem>(S.Load)->Offset),S.Load);},
      [](const Shape& S){return !S.IR.GetOp<IROp_LoadMem>(S.Load)->Offset.IsInvalid();}},
    {"regenerated-store-address-after-store",[](Shape& S){S.After(S.IR.GetNode(S.IR.GetOp<IROp_StoreMem>(S.Store)->Addr),S.Store);}},
    {"address-child-after-parent",[](Shape& S){const auto A=S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr;S.After(S.IR.GetNode(S.IR.GetOp<IROp_Header>(A)->Args[0]),S.IR.GetNode(A));},
      [](const Shape& S){const auto* H=S.IR.GetOp<IROp_Header>(S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr);return H->Op==OP_ADDSHIFT||H->Op==OP_ADD;}},
    {"wrong-address-shift",[](Shape& S){S.IR.GetOp<IROp_AddShift>(S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr)->Shift=ShiftType::ASR;},
      [](const Shape& S){return S.IR.GetOp<IROp_Header>(S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr)->Op==OP_ADDSHIFT;}},
    {"extra-nzcv-read",[](Shape& S){S.Op(S.Marker)->Op=OP_LOADNZCV;}},
    {"extra-af-store",[](Shape& S){S.Op(S.PF)->Op=OP_STOREAF;}},
    {"extra-nzcv-store",[](Shape& S){S.Op(S.PF)->Op=OP_STORENZCV;}},
    {"extra-register-store",[](Shape& S){S.Op(S.Marker)->Op=OP_STOREREGISTER;}},
    {"extra-context-write",[](Shape& S){S.Op(S.Marker)->Op=OP_STORECONTEXT;}},
    {"extra-syscall",[](Shape& S){S.Op(S.Marker)->Op=OP_SYSCALL;}},
    {"early-exit",[](Shape& S){S.Before(S.Exit,S.Load);}},
    {"store-after-exit",[](Shape& S){S.After(S.Store,S.Exit);}},
    {"pf-after-exit",[](Shape& S){S.After(S.PF,S.Exit);}},
    {"call-exit",[](Shape& S){S.IR.GetOp<IROp_ExitFunction>(S.Exit)->Hint=BranchHint::Call;}}
  };
  const std::vector<std::vector<unsigned char>> Forms = {{9,0x10},{0x48,9,0x10},{0x48,9,0},{9,0},{0x48,9,0x0c,0x88},{9,0x0c,0x88},{0x4f,9,0x54,0xac,0x80},{0x47,9,0x54,0xac,0x80},{0x48,9,0x15,0,0,0,0},{9,0x15,0,0,0,0},{0x48,9,0x20},{9,0x20},{0x4a,9,0x14,0xa0},{0x42,9,0x14,0xa0},{0x48,9,0x0c,0x89},{9,0x0c,0x89},{0x49,9,0x15,0,0,0,0},{0x41,9,0x15,0,0,0,0},{0x48,9,0x14,0xc8},{9,0x14,0xc8},{0x48,9,0x14,0x48},{9,0x14,0x48},{0x48,9,4,0x25,0,0,1,0},{9,4,0x25,0,0,1,0},{0x48,9,0x74,0x24,0x88},{9,0x74,0x24,0x88}};
  fexwasm::FexHost::Options HO; HO.MaxInstructions=1; HO.DebugGuestInstructions=true; HO.Multiblock=false;
  fexwasm::FexHost Host(HO); unsigned Checked=0, Valid=0, Unexpected=0;
  for (const auto& Bytes : Forms) {
    const uint64_t RIP=0x123400008000;
    if (!Host.MapGuest(RIP,Bytes.data(),Bytes.size())) return 2;
    uint64_t Instructions=0; const auto* Original=Host.GenerateIR(RIP,&Instructions);
    if (!Original||Instructions!=1) return 3;
    for (const auto& C : Cases) {
      std::vector<unsigned char> Data(Original->GetDataSize()),List(Original->GetListSize());
      std::memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());
      std::memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());
      IRListView IR(Data.data(),List.data(),Data.size(),List.size()); Shape S(IR);
      if (!S.Load||!S.Result||!S.Source||!S.Flags||!S.Zero||!S.Invalidate||!S.Store||!S.PF||!S.Marker||!S.Exit) return 4;
      if (C.Applicable&&!C.Applicable(S)) continue; C.Mutate(S);
      const auto Plan=fexwasm::broker::Admit(Bytes.data(),Bytes.size());if(!Plan.Supported||Plan.Operation!=16||Plan.Length!=Host.InstructionLength(RIP))return 5;
      fexwasm::BackendConfig Cfg; Cfg.BrokerMemory=true; Cfg.BrokerOperation=16; Cfg.BrokerWidth=Plan.Width; Cfg.BrokerTargetRegister=Plan.Register;
      Cfg.BrokerNextRIP=RIP+Plan.Length; Cfg.SharedMemory=true; Cfg.ThreadBaseGlobal=true;
      Cfg.MemPages=Cfg.MemMaxPages=fexwasm::broker::Pages; Cfg.RegArgs=0; Cfg.CallsViaDispatcher=false;
      if(!std::strcmp(C.Name,"profile-width"))Cfg.BrokerWidth=1;
      if(!std::strcmp(C.Name,"profile-flow"))Cfg.BrokerFlow=1;
      if(!std::strcmp(C.Name,"profile-target"))Cfg.BrokerTarget=RIP;
      if(!std::strcmp(C.Name,"profile-register"))Cfg.BrokerTargetRegister=16;
      if(!std::strcmp(C.Name,"profile-source"))Cfg.BrokerTargetRegister^=1;
      if(!std::strcmp(C.Name,"profile-fallthrough"))Cfg.BrokerNextRIP++;
      if(!std::strcmp(C.Name,"profile-no-effects"))Cfg.BrokerNoEffects=true;
      const auto R=fexwasm::Compile(IR,RIP,Cfg); const bool Expected=std::strcmp(C.Name,"valid")==0;
      const bool OK=Expected ? (R.Error.empty()&&!R.Module.empty()) : (!R.Error.empty()&&R.Module.empty()); Checked++;Valid+=Expected;Unexpected+=!OK;
      printf("%s width%u: %s%s\n",C.Name,Cfg.BrokerWidth*8,R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
    }
    Host.Release();
  }
  printf("checked %u actual OR memory IR copies; valid %u; unexpected %u\n",Checked,Valid,Unexpected);return Unexpected?1:0;
}
