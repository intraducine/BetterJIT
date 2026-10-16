// SPDX-License-Identifier: GPL-3.0-or-later
// Compile copied actual FEX IR; reject unsupported ShiftFlags widths/profiles.
// This diagnostic executes neither guest code nor a native guest JIT.
#include "backend.h"
#include "broker_step.h"
#include "fexhost.h"
#include "Interface/IR/IR.h"
#include "Interface/IR/IntrusiveIRList.h"
#include "Interface/IR/RegisterAllocationData.h"
#include <cstdio>
#include <cstring>
#include <vector>
using namespace FEXCore::IR;
static int CheckSmall(fexwasm::FexHost& Host){
 std::vector<std::vector<unsigned char>> Prefixes={{},{0x66}};for(unsigned R=0x40;R<=0x4f;R++)Prefixes.push_back({(unsigned char)R});for(unsigned R=0x40;R<=0x4f;R++)Prefixes.push_back({0x66,(unsigned char)R});
 const char* Names[]={"valid","PF-header32","operand-width0","operand-width24","operand-width128","rotate-flags","read-profile","syscall","memory-read","memory-write","context-write","wrong-next"};
 unsigned Checked=0,Valid=0,Unexpected=0,Truncated=0;
 for(const auto& Prefix:Prefixes)for(bool Byte:{true,false}){
  unsigned Rex=0;bool Word=false;for(auto B:Prefix){Word|=B==0x66;if(B>=0x40&&B<=0x4f)Rex=B;}
  const unsigned Width=Byte?1:Rex&8?8:Word?2:4;if(Width>=4)continue;
  for(unsigned Group:{4u,5u,7u})for(unsigned RM=0;RM<8;RM++)for(unsigned Form=0;Form<14;Form++){
   const unsigned Counts[]={0,1,4,7,8,9,15,16,17,31,32,255};auto Bytes=Prefix;Bytes.push_back(Byte?(Form==0?0xd2:Form==1?0xd0:0xc0):(Form==0?0xd3:Form==1?0xd1:0xc1));Bytes.push_back(0xc0|(Group<<3)|RM);if(Form>=2)Bytes.push_back(Counts[Form-2]);
   const auto Plan=fexwasm::broker::Admit(Bytes.data(),Bytes.size());const unsigned Root=Byte&&!Rex&&RM>=4?RM-4:RM+((Rex&1)?8:0),Shift=Byte&&!Rex&&RM>=4?8:0;
   if(!Plan.Supported||Plan.Operation!=6||Plan.Width||Plan.Register!=Root||Plan.Length!=Bytes.size())return 20;
   for(unsigned N=0;N<Bytes.size();N++){if(fexwasm::broker::Admit(Bytes.data(),N).Supported)return 21;Truncated++;}
   constexpr uint64_t RIP=0x123400008000;if(!Host.MapGuest(RIP,Bytes.data(),Bytes.size()))return 22;uint64_t Instructions=0;const auto* Original=Host.GenerateIR(RIP,&Instructions);if(!Original||Instructions!=1||Host.InstructionLength(RIP)!=Bytes.size())return 23;
   for(unsigned C=0;C<sizeof(Names)/sizeof(Names[0]);C++){
    std::vector<unsigned char> Data(Original->GetDataSize()),List(Original->GetListSize());std::memcpy(Data.data(),reinterpret_cast<const void*>(Original->GetData()),Data.size());std::memcpy(List.data(),reinterpret_cast<const void*>(Original->GetListData()),List.size());IRListView IR(Data.data(),List.data(),Data.size(),List.size());IROp_ShiftFlags* Flags=nullptr;IROp_Header* Marker=nullptr;unsigned Stores=0,Merges=0;
    for(auto [Block,Header]:IR.GetBlocks())for(auto [Node,H]:IR.GetCode(Block)){
     if(H->Op==OP_SHIFTFLAGS){if(Flags)return 24;Flags=IR.GetOp<IROp_ShiftFlags>(Node);}
     if(H->Op==OP_GUESTOPCODE)Marker=IR.GetOp<IROp_Header>(Node);
     if(H->Op==OP_STOREREGISTER){const auto R=PhysicalRegister(Node);if(R.AsRegClass()!=RegClass::GPRFixed||R.Reg!=Root||uint32_t(H->Size)!=8)return 25;Stores++;}
     if(H->Op==OP_BFI){const auto B=H->C<IROp_Bfi>();if(uint32_t(H->Size)==8&&B->Width==Width*8&&B->lsb==Shift)Merges++;}
    }
    if(!Marker||Stores!=1||Merges!=1||(Form==0&&!Flags)||(Flags&&(uint32_t(Flags->Header.Size)!=8||uint32_t(Flags->Size)!=Width)))return 26;
    if(C>=1&&C<=5&&!Flags)continue;
    fexwasm::BackendConfig Cfg;Cfg.BrokerMemory=true;Cfg.BrokerOperation=6;Cfg.BrokerWidth=0;Cfg.BrokerNextRIP=RIP+Bytes.size();Cfg.SharedMemory=true;Cfg.ThreadBaseGlobal=true;Cfg.MemPages=Cfg.MemMaxPages=fexwasm::broker::Pages;Cfg.RegArgs=0;Cfg.CallsViaDispatcher=false;
    switch(C){case 1:Flags->Header.Size=OpSize::i32Bit;break;case 2:Flags->Size=static_cast<OpSize>(0);break;case 3:Flags->Size=static_cast<OpSize>(3);break;case 4:Flags->Size=OpSize::i128Bit;break;case 5:Flags->Shift=ShiftType::ROR;break;case 6:Cfg.BrokerOperation=1;break;case 7:Marker->Op=OP_SYSCALL;break;case 8:Marker->Op=OP_LOADMEM;break;case 9:Marker->Op=OP_STOREMEM;break;case 10:Marker->Op=OP_STORECONTEXT;break;case 11:Cfg.BrokerNextRIP++;break;default:break;}
    const auto R=fexwasm::Compile(IR,RIP,Cfg);const bool Expected=C==0,OK=Expected?(R.Error.empty()&&!R.Module.empty()):(!R.Error.empty()&&R.Module.empty());Checked++;Valid+=Expected;Unexpected+=!OK;
    printf("small-shift %s width%u group%u RM%u form%u: %s%s\n",Names[C],Width*8,Group,RM,Form,R.Error.empty()?"ACCEPTED":R.Error.c_str(),OK?"":" [UNEXPECTED]");
   }Host.Release();
  }
 }
 printf("checked %u actual small-shift IR copies; valid %u; unexpected %u; raw truncations %u\n",Checked,Valid,Unexpected,Truncated);return Unexpected?1:0;
}
int main() {
  fexwasm::FexHost::Options HO; HO.MaxInstructions=1; HO.DebugGuestInstructions=true; HO.Multiblock=false;
  fexwasm::FexHost Host(HO); unsigned Checked=0,Unexpected=0;
  const char* Names[]={"valid","PF-header-width32","operand-width0","operand-width24","operand-width128","rotate-flags","non-flags-profile","unknown-effect"};
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
      case 2: Flags->Size=static_cast<OpSize>(0); break;
      case 3: Flags->Size=static_cast<OpSize>(3); break;
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
  printf("checked %u actual shift-IR copies; unexpected %u\n",Checked,Unexpected);const int Small=CheckSmall(Host);return Unexpected?1:Small;
}
