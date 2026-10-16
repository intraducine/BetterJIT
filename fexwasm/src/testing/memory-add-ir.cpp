// SPDX-License-Identifier: GPL-3.0-or-later
// Strict IR regression: mutate copies of actual FEX single-instruction
// IR, then require the production broker compiler to reject malformed ADD proofs.
// No native guest JIT and no guest code execution occur in this diagnostic.
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
  Ref Load {}, Add {}, Store {}, Source {}, AF {}, PF {}, NZCV {}, ReadNZCV {}, Auxiliary {}, Carry {}, Marker {}, Exit {};
  explicit Shape(const IRListView& View) : IR(View) {
    for (auto [Block, Header] : IR.GetBlocks()) for (auto [Node, H] : IR.GetCode(Block)) {
      switch (H->Op) {
      case OP_GUESTOPCODE: Marker=Node; break;
      case OP_EXITFUNCTION: Exit=Node; break;
      case OP_LOADMEM: case OP_LOADMEMTSO: Load=Node; break;
      case OP_ADDWITHFLAGS: Add=Node; Source=IR.GetNode(H->Args[1]); break;
      case OP_STOREMEM: case OP_STOREMEMTSO: Store=Node; break;
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
    {"stale-nzcv-read-before-add",[](Shape& S){S.Before(S.ReadNZCV,S.Add);}},
    {"carry-xor-before-nzcv-producer",[](Shape& S){S.Before(S.Carry,S.ReadNZCV);}},
    {"nzcv-store-before-carry-producer",[](Shape& S){S.Before(S.NZCV,S.Carry);}},
    {"pf-store-before-add-producer",[](Shape& S){S.Before(S.PF,S.Add);}},
    {"af-store-before-xor-producer",[](Shape& S){S.Before(S.AF,S.Auxiliary);}},
    {"af-store-before-add",[](Shape& S){S.Before(S.AF,S.Add);}},
    {"early-exit-before-load",[](Shape& S){S.Before(S.Exit,S.Load);}},
    {"early-exit-before-add",[](Shape& S){S.Before(S.Exit,S.Add);}},
    {"early-exit-before-linked-store",[](Shape& S){S.Before(S.Exit,S.Store);}},
    {"af-store-after-exit",[](Shape& S){S.After(S.AF,S.Exit);}},
    {"pf-store-after-exit",[](Shape& S){S.After(S.PF,S.Exit);}},
    {"nzcv-store-after-exit",[](Shape& S){S.After(S.NZCV,S.Exit);}},
    {"add-before-memory-load",[](Shape& S){S.Before(S.Add,S.Load);}},
    {"store-before-add",[](Shape& S){S.Before(S.Store,S.Add);}},
    {"source-after-memory-load",[](Shape& S){S.Before(S.Source,S.Add);}},
    {"address-producer-after-memory-load",[](Shape& S){S.Before(S.IR.GetNode(S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr),S.Add);}},
    {"offset-producer-after-memory-load",[](Shape& S){S.Before(S.IR.GetNode(S.IR.GetOp<IROp_LoadMem>(S.Load)->Offset),S.Add);},
      [](const Shape& S){return !S.IR.GetOp<IROp_LoadMem>(S.Load)->Offset.IsInvalid();}},
    {"address-child-after-parent",[](Shape& S){const auto A=S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr;S.Before(S.IR.GetNode(S.IR.GetOp<IROp_Header>(A)->Args[0]),S.Load);},
      [](const Shape& S){const auto* H=S.IR.GetOp<IROp_Header>(S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr);return H->Op==OP_ADDSHIFT||H->Op==OP_ADD;}},
    {"wrong-stored-value",[](Shape& S){S.Op(S.Store)->Args[0]=S.IR.WrapNode(S.Load);}},
    {"wrong-store-address",[](Shape& S){S.IR.GetOp<IROp_StoreMem>(S.Store)->Addr=S.IR.WrapNode(S.Source);}},
    {"missing-load-and-store-address",[](Shape& S){S.IR.GetOp<IROp_LoadMem>(S.Load)->Addr=OrderedNodeWrapper {};S.IR.GetOp<IROp_StoreMem>(S.Store)->Addr=OrderedNodeWrapper {};}},
    {"wrong-load-width",[](Shape& S){S.Op(S.Load)->Size=OpSize::i16Bit;}},
    {"wrong-store-width",[](Shape& S){S.Op(S.Store)->Size=OpSize::i16Bit;}},
    {"wrong-add-width",[](Shape& S){S.Op(S.Add)->Size=OpSize::i16Bit;}},
    {"wrong-source-width",[](Shape& S){S.Op(S.Source)->Size=OpSize::i32Bit;}},
    {"wrong-nzcv-read-width",[](Shape& S){S.Op(S.ReadNZCV)->Size=OpSize::i64Bit;}},
    {"wrong-carry-xor-width",[](Shape& S){S.Op(S.Carry)->Size=OpSize::i64Bit;}},
    {"wrong-nzcv-store-width",[](Shape& S){S.Op(S.NZCV)->Size=OpSize::i64Bit;}},
    {"wrong-af-xor-width",[](Shape& S){S.Op(S.Auxiliary)->Size=OpSize::i32Bit;}},
    {"wrong-af-store-width",[](Shape& S){S.Op(S.AF)->Size=OpSize::i32Bit;}},
    {"wrong-pf-store-width",[](Shape& S){S.Op(S.PF)->Size=OpSize::i32Bit;}},
    {"wrong-af-value",[](Shape& S){S.Op(S.AF)->Args[0]=S.IR.WrapNode(S.Add);}},
    {"wrong-pf-value",[](Shape& S){S.Op(S.PF)->Args[0]=S.IR.WrapNode(S.Load);}},
    {"wrong-carry-inversion",[](Shape& S){S.IR.GetOp<IROp_InlineConstant>(S.Op(S.Carry)->Args[1])->Constant=0x10000000;}},
    {"extra-nzcv-read",[](Shape& S){S.Op(S.Marker)->Op=OP_LOADNZCV;S.Op(S.Marker)->Size=OpSize::i32Bit;}}
  };
  const std::vector<std::vector<unsigned char>> Forms = {{1,0x10},{0x48,1,0x10},{0x4f,1,0x54,0xac,0x80},{0x48,1,0x15,0,0,0,0}};
  fexwasm::FexHost::Options HO; HO.MaxInstructions=1; HO.DebugGuestInstructions=true; HO.Multiblock=false;
  fexwasm::FexHost Host(HO); unsigned Checked=0, Unexpected=0;
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
      if (!S.Load||!S.Add||!S.Store||!S.AF||!S.PF||!S.NZCV||!S.ReadNZCV||!S.Marker||!S.Exit) return 4;
      if (C.Applicable&&!C.Applicable(S)) continue;
      C.Mutate(S);
      fexwasm::BackendConfig Cfg; Cfg.BrokerMemory=true; Cfg.BrokerOperation=11; Cfg.BrokerWidth=(Bytes[0]&0xf8)==0x48?8:4;
      Cfg.BrokerNextRIP=RIP+Host.InstructionLength(RIP); Cfg.SharedMemory=true; Cfg.ThreadBaseGlobal=true;
      Cfg.MemPages=Cfg.MemMaxPages=fexwasm::broker::Pages; Cfg.RegArgs=0; Cfg.CallsViaDispatcher=false;
      const auto R=fexwasm::Compile(IR,RIP,Cfg); const bool Expected=std::strcmp(C.Name,"valid")==0;
      const bool OK=Expected ? (R.Error.empty() && !R.Module.empty()) : (!R.Error.empty() && R.Module.empty()); Checked++; Unexpected+=!OK;
      printf("%s width%u %s: %s%s\n",C.Name,Cfg.BrokerWidth*8,Bytes.size()>3?"address-form":"base",R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
    }
    Host.Release();
  }
  printf("checked %u actual-IR copies; unexpected %u\n",Checked,Unexpected); return Unexpected?1:0;
}
