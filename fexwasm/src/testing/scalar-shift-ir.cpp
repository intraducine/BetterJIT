// SPDX-License-Identifier: GPL-3.0-or-later
// Compile copied actual FEX IR; reject unsupported ShiftFlags widths/profiles.
// This diagnostic executes neither guest code nor a native guest JIT.
#include "backend.h"
#include "broker_step.h"
#include "fexhost.h"
#include "Interface/IR/IR.h"
#include "Interface/IR/IntrusiveIRList.h"
#include <cstdio>
#include <cstring>
#include <vector>
using namespace FEXCore::IR;
int main() {
  fexwasm::FexHost::Options HO; HO.MaxInstructions=1; HO.DebugGuestInstructions=true; HO.Multiblock=false;
  fexwasm::FexHost Host(HO); unsigned Checked=0,Unexpected=0;
  const char* Names[]={"valid","PF-header-width32","operand-width8","operand-width16","operand-width128","rotate-flags","non-flags-profile","unknown-effect"};
  for (unsigned Width : {4u,8u}) for (unsigned Form=0;Form<4;Form++) {
    const unsigned Groups[]={4,5,7,5}; std::vector<unsigned char> Bytes;
    if (Width==8) Bytes.push_back(0x48);
    Bytes.push_back(0xd3); Bytes.push_back(0xc0|(Groups[Form]<<3)|(Form==3?1:0));
    constexpr uint64_t RIP=0x123400008000;
    if (!Host.MapGuest(RIP,Bytes.data(),Bytes.size())) return 2;
    uint64_t Instructions=0; const auto* Original=Host.GenerateIR(RIP,&Instructions);
    if (!Original||Instructions!=1) return 3;
    for (unsigned C=0;C<sizeof(Names)/sizeof(Names[0]);C++) {
      std::vector<unsigned char> Data(Original->GetDataSize()),List(Original->GetListSize());
      std::memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());
      std::memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());
      IRListView IR(Data.data(),List.data(),Data.size(),List.size()); IROp_ShiftFlags* Flags=nullptr; IROp_Header* Marker=nullptr;
      for(auto [Block,Header]:IR.GetBlocks())for(auto [Node,H]:IR.GetCode(Block)) {
        if(H->Op==OP_SHIFTFLAGS){if(Flags)return 4;Flags=IR.GetOp<IROp_ShiftFlags>(Node);}
        if(H->Op==OP_GUESTOPCODE)Marker=IR.GetOp<IROp_Header>(Node);
      }
      if(!Flags||!Marker||uint32_t(Flags->Header.Size)!=8||uint32_t(Flags->Size)!=Width)return 5;
      fexwasm::BackendConfig Cfg; Cfg.BrokerMemory=true; Cfg.BrokerOperation=6; Cfg.BrokerWidth=0;
      Cfg.BrokerNextRIP=RIP+Host.InstructionLength(RIP); Cfg.SharedMemory=true; Cfg.ThreadBaseGlobal=true;
      Cfg.MemPages=Cfg.MemMaxPages=fexwasm::broker::Pages; Cfg.RegArgs=0; Cfg.CallsViaDispatcher=false;
      switch(C) {
      case 1: Flags->Header.Size=OpSize::i32Bit; break;
      case 2: Flags->Size=OpSize::i8Bit; break;
      case 3: Flags->Size=OpSize::i16Bit; break;
      case 4: Flags->Size=OpSize::i128Bit; break;
      case 5: Flags->Shift=ShiftType::ROR; break;
      case 6: Cfg.BrokerOperation=0; break;
      case 7: Marker->Op=OP_SYSCALL; break;
      default: break;
      }
      const auto R=fexwasm::Compile(IR,RIP,Cfg); const bool OK=C==0?(R.Error.empty()&&!R.Module.empty()):(!R.Error.empty()&&R.Module.empty());
      Checked++;Unexpected+=!OK;printf("%s width%u group%u%s: %s%s\n",Names[C],Width*8,Groups[Form],Form==3?" RCX-alias":"",R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
    }
    Host.Release();
  }
  printf("checked %u actual shift-IR copies; unexpected %u\n",Checked,Unexpected);return Unexpected?1:0;
}
