// See translator.h. The configuration mirrors tools/fexrun.cpp, so a page
// running these modules sees the same layout as fexrun's dumps.
#include "translator.h"

#include "backend.h"
#include "fexhost.h"

#include <FEXCore/Core/CoreState.h>
#include <FEXCore/Core/X86Enums.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <fstream>
#include <xxhash.h>

using FEXCore::Core::CPUState;

namespace {
constexpr uint32_t MEM_PAGES = 4096; // 256 MB of wasm memory
constexpr uint32_t CTX = 0x100;
constexpr uint32_t STACK_TOP = 0x0F00'0000;
constexpr uint32_t HALT = 0x0020'0000; // guest return address that stops the dispatcher
constexpr uint32_t CPUID_ADDR = 0x9000;

double NowMs() {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

#ifndef FEXWASM_BUILD_ID
#define FEXWASM_BUILD_ID "dev"
#endif

// Shared by every translator in the process (one per guest process):
// table slots by RIP, so that any process can run any unit's call inline
// caches, and translated units by the code they came from. A unit is found
// again when its entry RIP and the code ranges FEX read for it (same place,
// same bytes) match, in any process and, through CacheDir, in a later run.
struct CachedUnit {
  uint64_t RIP = 0, Insts = 0;
  std::vector<fexwasm::FexHost::CodeDep> Deps;
  std::vector<std::pair<uint8_t, uint64_t>> Learned; // BackendConfig::Learned
  std::vector<uint8_t> Module;
  // Where the code it came from was mapped (the mapping holding RIP): the
  // same code mapped elsewhere runs the same module, displaced (e.d), with
  // its call inline caches' targets displaced too (CompileResult::ICTargets).
  uint64_t HomeBase = 0;
  bool Relocatable = false;
  std::vector<std::pair<uint64_t, bool>> ICTargets;
};
std::unordered_map<uint32_t, uint32_t> Slots;
uint32_t NextSlot = 1;
std::unordered_multimap<uint64_t, std::shared_ptr<CachedUnit>> UnitCache;
std::unordered_set<uint64_t> LoadedKeys; // keys whose disk file has been read

uint32_t SlotFor(uint32_t Rip) {
  auto [It, New] = Slots.emplace(Rip, NextSlot);
  if (New) {
    NextSlot++;
  }
  return It->second;
}

// Disk records: u64 rip, u64 insts, u32 deps, deps x (u64 base, size, hash),
// u32 learned, learned x (u8 kind, u64 value), u32 module size, module,
// u64 home base, u8 relocatable, u32 inline caches, x (u64 target, u8 relative).
template<typename V>
void Put(std::string& Out, V X) {
  Out.append(reinterpret_cast<const char*>(&X), sizeof(X));
}
std::string Serialize(const CachedUnit& U) {
  std::string Out;
  Put(Out, U.RIP);
  Put(Out, U.Insts);
  Put(Out, uint32_t(U.Deps.size()));
  for (const auto& D : U.Deps) {
    Put(Out, D.Base);
    Put(Out, D.Size);
    Put(Out, D.Hash);
  }
  Put(Out, uint32_t(U.Learned.size()));
  for (const auto& [K, V] : U.Learned) {
    Put(Out, K);
    Put(Out, V);
  }
  Put(Out, uint32_t(U.Module.size()));
  Out.append(reinterpret_cast<const char*>(U.Module.data()), U.Module.size());
  Put(Out, U.HomeBase);
  Put(Out, uint8_t(U.Relocatable));
  Put(Out, uint32_t(U.ICTargets.size()));
  for (const auto& [Target, Rel] : U.ICTargets) {
    Put(Out, Target);
    Put(Out, uint8_t(Rel));
  }
  return Out;
}
std::vector<std::shared_ptr<CachedUnit>> Deserialize(const std::string& In) {
  std::vector<std::shared_ptr<CachedUnit>> Out;
  size_t P = 0;
  bool Ok = true;
  auto Get = [&](auto& X) {
    if (P + sizeof(X) > In.size()) {
      Ok = false;
      return;
    }
    memcpy(&X, In.data() + P, sizeof(X));
    P += sizeof(X);
  };
  while (Ok && P < In.size()) {
    auto U = std::make_shared<CachedUnit>();
    uint32_t N = 0;
    Get(U->RIP);
    Get(U->Insts);
    Get(N);
    for (uint32_t I = 0; Ok && I < N; I++) {
      fexwasm::FexHost::CodeDep D {};
      Get(D.Base);
      Get(D.Size);
      Get(D.Hash);
      U->Deps.push_back(D);
    }
    Get(N);
    for (uint32_t I = 0; Ok && I < N; I++) {
      uint8_t K = 0;
      uint64_t V = 0;
      Get(K);
      Get(V);
      U->Learned.push_back({K, V});
    }
    Get(N);
    if (!Ok || P + N > In.size()) {
      break;
    }
    U->Module.assign(In.data() + P, In.data() + P + N);
    P += N;
    uint8_t Relocatable = 0;
    Get(U->HomeBase);
    Get(Relocatable);
    U->Relocatable = Relocatable;
    Get(N);
    for (uint32_t I = 0; Ok && I < N; I++) {
      uint64_t Target = 0;
      uint8_t Rel = 0;
      Get(Target);
      Get(Rel);
      U->ICTargets.push_back({Target, Rel != 0});
    }
    if (!Ok) {
      break;
    }
    Out.push_back(std::move(U));
  }
  return Out;
}
} // namespace

struct fexwasm_translator {
  std::unique_ptr<fexwasm::FexHost> Host;
  fexwasm::BackendConfig Cfg;
  uint64_t Window = 0;
  uint32_t ImageLow = 0;
  bool Linux = false;
  uint32_t ThreadBase = 0;
  std::string Abi = "sysv";
  // The defaults (options abi=, localflags=), and what the code being
  // translated keeps (its mapping's ABI: fexwasm_map_code_abi): set per unit.
  fexwasm::BackendConfig::GuestABI BaseAbi = fexwasm::BackendConfig::GuestABI::SysV;
  bool BaseLocalFlags = false;
  uint8_t CurAbi = 0;
  bool RegionAbiOnly = false;
  void UseAbi(uint8_t A) {
    CurAbi = A;
    Cfg.ABI = A == 1 ? fexwasm::BackendConfig::GuestABI::Win64 : BaseAbi;
    Cfg.ABILocalFlags = A == 1 || BaseLocalFlags;
    Host->SetLocalFlags(Cfg.ABILocalFlags);
  }
  std::unordered_set<uint64_t> ReturnAddrs, ExitReturnAddrs, CallTargetSet;
  // The unit cache: what makes this translator's output different from
  // another's (options, build), and where entries persist (cache=<dir>).
  uint64_t Fingerprint = 0;
  std::string CacheDir;
  // The page's latest profile (from region requests).
  std::unordered_map<uint32_t, std::vector<uint32_t>> Successors, CallTargets;
  std::vector<uint8_t> CPUID, Dispatcher, Out;
  std::string Json;
  struct {
    uint64_t Units = 0, Regions = 0, Failed = 0, GuestInsts = 0, UnitBytes = 0, RegionBytes = 0, CodeBytes = 0, CacheHits = 0, DiskHits = 0, Relocated = 0;
    double FexMs = 0, UnitMs = 0, RegionMs = 0;
  } Stats;

  fexwasm_bytes Give(const std::vector<uint8_t>& V) { return {V.data(), V.size()}; }
};

extern "C" {

fexwasm_translator* fexwasm_create(const uint8_t* Image, size_t Size, uint64_t Base, const char* Options) {
  auto T = std::make_unique<fexwasm_translator>();
  std::map<std::string, std::string> Opt;
  {
    std::istringstream In(Options ? Options : "");
    std::string KV;
    while (In >> KV) {
      const auto Eq = KV.find('=');
      Opt[KV.substr(0, Eq)] = Eq == std::string::npos ? "1" : KV.substr(Eq + 1);
    }
  }
  auto Get = [&](const char* K, const char* Def) { return Opt.count(K) ? Opt[K] : std::string(Def); };
  auto& Cfg = T->Cfg;
  T->Linux = Get("linux", "0") == "1";
  if (T->Linux) {
    Opt.emplace("tb", "0");
    Opt.emplace("shared", "1");
    // Wine mixes SysV (unix side), Win64 (PE side) and hand-written calling
    // conventions (the syscall thunks pass the first argument in R10), so no
    // ABI can say which registers are dead at a call or return.
    Opt.emplace("abi", "none");
    // x87 on doubles (FEX's reduced precision): x86-64 code uses x87 only for
    // long double (musl's printf and strtold), and the backend has no 80-bit
    // arithmetic yet.
    Opt.emplace("x87", "64");
    // Guest calls nest as wasm calls; region functions have big frames, and a
    // worker's stack (set by the engine) doesn't take 256 of them.
    Opt.emplace("depth", "64");
  }
  T->Abi = Get("abi", "sysv");
  Cfg.ABI = T->Abi == "win64" ? fexwasm::BackendConfig::GuestABI::Win64
            : T->Abi == "none" ? fexwasm::BackendConfig::GuestABI::None : fexwasm::BackendConfig::GuestABI::SysV;
  Cfg.TSOMode = uint32_t(std::stoul(Get("tso", "0")));
  Cfg.ThreadBaseGlobal = Opt.count("tb") != 0;
  T->ThreadBase = Cfg.ThreadBaseGlobal ? uint32_t(std::stoul(Opt["tb"], nullptr, 16)) : 0;
  Cfg.SharedMemory = Get("shared", "0") == "1";
  Cfg.HotThreshold = uint32_t(std::stoul(Get("hot", "100")));
  // (Linux threads run async: misses wait for their unit where they are; missjspi=0: they unwind)
  Cfg.MissAddr = T->Linux && Get("missjspi", "1") != "0" ? 0x5C : 0;
  Cfg.ShadowBase = T->Linux && Get("shadow", "1") != "0" ? 0x1C'0000 : 0; // (in the thread's Sys area, 2 MB)
  Cfg.ProfAddr = Get("profrip", "0") == "1" ? 0x1C'2000 : 0; // (profiling: see BackendConfig::ProfAddr)
  Cfg.MaxCallDepth = uint32_t(std::stoul(Get("depth", "256")));
  Cfg.TrackRIP = Get("trackrip", "0") == "1";

  // localflags: flags dead across calls and returns, as the ABI has them; off
  // by default, since code written by hand needn't be (UPX's decompressor, in
  // packed DLLs, returns a bit in CF). (multiblock=0, xflags=0, localflags=1:
  // for finding a miscompile, or measuring)
  T->Host = std::make_unique<fexwasm::FexHost>(fexwasm::FexHost::Options {.TSO = Cfg.TSOMode != 0,
                                                                          .Multiblock = Get("multiblock", "1") != "0",
                                                                          .X87ReducedPrecision = Get("x87", "80") == "64",
                                                                          .ABILocalFlags = Get("localflags", "0") != "0",
                                                                          .CrossUnitFlags = Get("xflags", "1") != "0"});
  auto* FH = T->Host.get();
  if (Image && !FH->MapGuest(Base, Image, Size)) {
    return nullptr;
  }
  T->Window = T->Linux ? 0 : Base & ~0xFFFF'FFFFull;
  T->ImageLow = uint32_t(Base);

  Cfg.CtxAddr = CTX;
  Cfg.NZCVAddr = CTX + offsetof(CPUState, flags) + FEXCore::X86State::RFLAG_NZCV_LOC;
  Cfg.MemPages = T->Linux ? 1 : MEM_PAGES;
  Cfg.MemMaxPages = T->Linux ? 65536 : 0;
  Cfg.SyscallFullState = T->Linux;
  Cfg.FlagSpillAddr = 0x40;
  Cfg.NamedConstants = FH->NamedConstants();
  Cfg.IndexedConstantPointers = FH->IndexedConstantPointers();
  Cfg.ABILocalFlags = Get("localflags", "0") != "0";
  T->BaseAbi = Cfg.ABI;
  T->RegionAbiOnly = Get("regionabi", T->Linux ? "1" : "0") != "0";
  T->BaseLocalFlags = Cfg.ABILocalFlags;
  Cfg.SlotTagBase = 0x14'0000;
  Cfg.SlotTagCount = 0x1'0000;
  Cfg.Relocs = T->Linux; // (processes share translations of the libraries they map at different addresses)
  Cfg.UnitCounterBase = 0x18'0000;
  Cfg.UnitCounterBits = 14;
  Cfg.CPUIDAddr = CPUID_ADDR;
  T->CPUID = FH->CPUIDTable(&Cfg.CPUIDCount);
  Cfg.XCR0 = FH->XCR0();
  Cfg.ReturnAddrs = &T->ReturnAddrs;
  Cfg.ExitReturnAddrs = &T->ExitReturnAddrs;
  Cfg.CallTargetSet = &T->CallTargetSet;
  // (a callee translated another way isn't inlined: its IR, and the calls
  // and returns in it, keep its own mapping's ABI)
  Cfg.FetchIR = [FH, T = T.get()](uint64_t RIP) -> const FEXCore::IR::IRListView* {
    const auto* H = FH->MappingAt(RIP);
    if (H && H->Abi != T->CurAbi) return nullptr;
    return FH->GenerateIR(RIP);
  };
  Cfg.FlagsDeadAt = [FH](uint64_t RIP) { return FH->FlagsDeadAtEntry(RIP); };
  auto* TP = T.get();
  const uint64_t Window = T->Window;
  {
    std::string F = std::string(FEXWASM_BUILD_ID) + "|";
    for (const auto& [K, V] : Opt) {
      if (K != "cache") {
        F += K + "=" + V + ";";
      }
    }
    T->Fingerprint = XXH3_64bits(F.data(), F.size());
    T->CacheDir = Get("cache", "");
  }
  if (Cfg.HotThreshold) {
    Cfg.TableSlot = [](uint64_t RIP) -> uint32_t {
      auto It = Slots.find(uint32_t(RIP));
      return It == Slots.end() ? 0 : It->second;
    };
    Cfg.Successors = [TP, Window](uint64_t RIP) {
      std::vector<uint64_t> V;
      if (auto It = TP->Successors.find(uint32_t(RIP)); It != TP->Successors.end()) {
        for (uint32_t S : It->second) {
          V.push_back(Window | S);
        }
      }
      return V;
    };
    Cfg.CallTargets = [TP, Window](uint64_t RetAddr) {
      std::vector<uint64_t> V;
      if (auto It = TP->CallTargets.find(uint32_t(RetAddr)); It != TP->CallTargets.end()) {
        for (uint32_t S : It->second) {
          V.push_back(Window | S);
        }
      }
      return V;
    };
  }
  T->Dispatcher = fexwasm::BuildDispatcher(Cfg, T->CPUID);
  return T.release();
}

void fexwasm_destroy(fexwasm_translator* T) {
  delete T;
}

void fexwasm_map_code(fexwasm_translator* T, uint64_t Addr, const uint8_t* Bytes, size_t Size) {
  fexwasm_map_code_abi(T, Addr, Bytes, Size, 0);
}

void fexwasm_map_code_abi(fexwasm_translator* T, uint64_t Addr, const uint8_t* Bytes, size_t Size, uint32_t Abi) {
  fexwasm_unmap_code(T, Addr, Size);
  T->Host->MapGuest(Addr, Bytes, Size, uint8_t(Abi));
  T->Stats.CodeBytes += Size;
}

void fexwasm_unmap_code(fexwasm_translator* T, uint64_t Addr, uint64_t Size) {
  T->Host->UnmapGuest(Addr, Size);
  // What the backend learned about code there no longer holds.
  for (auto* Set : {&T->ReturnAddrs, &T->ExitReturnAddrs, &T->CallTargetSet}) {
    for (auto It = Set->begin(); It != Set->end();) {
      It = *It >= Addr && *It - Addr < Size ? Set->erase(It) : std::next(It);
    }
  }
  T->Stats.CodeBytes -= std::min<uint64_t>(T->Stats.CodeBytes, Size);
}

void fexwasm_patch_code(fexwasm_translator* T, uint64_t Addr, const uint8_t* Bytes, size_t Size) {
  T->Host->PatchGuest(Addr, Bytes, Size);
  // what the backend learned about code there no longer holds
  for (auto* Set : {&T->ReturnAddrs, &T->ExitReturnAddrs, &T->CallTargetSet}) {
    for (auto It = Set->begin(); It != Set->end();) {
      It = *It >= Addr && *It - Addr < Size ? Set->erase(It) : std::next(It);
    }
  }
}

const char* fexwasm_config_json(fexwasm_translator* T) {
  const auto& Cfg = T->Cfg;
  char B[2048];
  snprintf(B, sizeof(B),
           "{\"memPages\":%u,\"ctx\":%u,\"stateSize\":%zu,\"imageLow\":%u,\"stackTop\":%u,\"halt\":%u,\"windowHi\":%u,"
           "\"gregsOff\":%zu,\"dispatchBase\":%u,\"dispatchBits\":%u,\"hotAddr\":%u,\"hotThreshold\":%u,\"slotTagBase\":%u,"
           "\"slotTagCount\":%u,\"unitCounterBase\":%u,\"unitCounterBits\":%u,\"threadBase\":%d,\"shared\":%s,\"guestAbi\":\"%s\","
           "\"tso\":%u,\"callSiteBase\":%u,\"callSiteBits\":%u,\"linux\":%s,\"memMaxPages\":%u,\"cpuidAddr\":%u,\"cpuidCount\":%u,"
           "\"flagSpillAddr\":%u,\"stopAddr\":%u,\"depthAddr\":%u,\"faultAddr\":%u,\"missAddr\":%u,\"profAddr\":%u,\"xmmOff\":%zu,\"ripOff\":%zu,"
           "\"fsOff\":%zu,\"gsOff\":%zu,\"mxcsrOff\":%zu,\"nzcvAddr\":%u}",
           Cfg.MemPages, CTX, sizeof(CPUState), T->ImageLow, STACK_TOP, HALT, uint32_t(T->Window >> 32), offsetof(CPUState, gregs),
           Cfg.DispatchBase, Cfg.DispatchBits, Cfg.HotAddr, Cfg.HotThreshold, Cfg.SlotTagBase, Cfg.SlotTagCount, Cfg.UnitCounterBase,
           Cfg.UnitCounterBits, Cfg.ThreadBaseGlobal ? int(T->ThreadBase) : -1, Cfg.SharedMemory ? "true" : "false", T->Abi.c_str(),
           Cfg.TSOMode, Cfg.CallSiteBase, Cfg.CallSiteBits, T->Linux ? "true" : "false", Cfg.MemMaxPages, Cfg.CPUIDAddr,
           Cfg.CPUIDCount, Cfg.FlagSpillAddr, Cfg.StopAddr, Cfg.DepthAddr, Cfg.FaultAddr, Cfg.MissAddr, Cfg.ProfAddr, offsetof(CPUState, xmm),
           offsetof(CPUState, rip), offsetof(CPUState, fs_cached), offsetof(CPUState, gs_cached), offsetof(CPUState, mxcsr),
           Cfg.NZCVAddr);
  T->Json = B;
  return T->Json.c_str();
}

fexwasm_bytes fexwasm_dispatcher(fexwasm_translator* T) {
  return T->Give(T->Dispatcher);
}

fexwasm_bytes fexwasm_state(fexwasm_translator* T) {
  const CPUState Default {};
  T->Out.assign(reinterpret_cast<const uint8_t*>(&Default), reinterpret_cast<const uint8_t*>(&Default) + sizeof(Default));
  return T->Give(T->Out);
}

fexwasm_bytes fexwasm_unit(fexwasm_translator* T, uint32_t Rip32) {
  const uint64_t RIP = T->Window | Rip32;
  T->Out.clear();
  const auto* Home = T->Host->MappingAt(RIP);
  if (!Home) {
    T->Stats.Failed++;
    return T->Give(T->Out);
  }
  // (the key doesn't say where the code is: the same code mapped elsewhere,
  // as a library in another process, reuses the unit, patched)
  T->UseAbi(Home->Abi);
  const uint64_t KeyIn[5] = {RIP - Home->Base, T->Fingerprint, Home->Size, Home->Hash, Home->Abi};
  const uint64_t Key = XXH3_64bits(KeyIn, sizeof(KeyIn));
  auto Emit = [&](const CachedUnit& U, int64_t Delta) {
    const uint32_t Slot = SlotFor(Rip32);
    // Linux mode: u32 slot, u64 hash of the module (the page compiles each
    // distinct module once for all its workers), i64 displacement (e.d), u32
    // count and the slots of the call inline caches (e.s<i>), the module.
    // Else: slot, module.
    std::vector<uint32_t> ICSlots;
    for (const auto& [Target, Rel] : U.ICTargets) {
      // (slot 0 is never installed: its tag never matches, so the cache just misses)
      const uint32_t S = SlotFor(uint32_t(Rel ? Target + uint64_t(Delta) : Target));
      ICSlots.push_back(S < T->Cfg.SlotTagCount ? S : 0);
    }
    const size_t Head = T->Linux ? 24 + 4 * ICSlots.size() : 4;
    T->Out.resize(Head + U.Module.size());
    uint8_t* O = T->Out.data();
    memcpy(O, &Slot, 4);
    if (T->Linux) {
      const uint64_t Hash = XXH3_64bits(U.Module.data(), U.Module.size());
      const uint32_t N = uint32_t(ICSlots.size());
      memcpy(O + 4, &Hash, 8);
      memcpy(O + 12, &Delta, 8);
      memcpy(O + 20, &N, 4);
      memcpy(O + 24, ICSlots.data(), 4 * N);
    }
    memcpy(O + Head, U.Module.data(), U.Module.size());
    T->Stats.Units++;
    T->Stats.GuestInsts += U.Insts;
    T->Stats.UnitBytes += U.Module.size();
    return T->Give(T->Out);
  };
  char Path[64];
  snprintf(Path, sizeof(Path), "/%016llx.u", (unsigned long long)Key);
  for (int Pass = 0; Pass < 2; Pass++) {
    auto [B, E] = UnitCache.equal_range(Key);
    for (auto It = B; It != E; ++It) {
      const auto& U = *It->second;
      const int64_t Delta = int64_t(Home->Base - U.HomeBase);
      if (U.RIP - U.HomeBase != RIP - Home->Base || (Delta && !U.Relocatable) || !T->Host->DepsMatch(U.Deps, Delta)) {
        continue;
      }
      // what compiling it taught the backend about this code
      for (const auto& [K, V] : U.Learned) {
        const uint8_t Kind = K & ~fexwasm::LEARNED_ABS;
        (Kind == 0 ? T->ReturnAddrs : Kind == 1 ? T->ExitReturnAddrs : T->CallTargetSet).insert(K & fexwasm::LEARNED_ABS ? V : V + Delta);
      }
      T->Stats.CacheHits++;
      T->Stats.DiskHits += Pass;
      T->Stats.Relocated += Delta != 0;
      return Emit(U, Delta);
    }
    if (Pass || T->CacheDir.empty() || !LoadedKeys.insert(Key).second) {
      break;
    }
    std::ifstream F(T->CacheDir + Path, std::ios::binary);
    if (!F) {
      break;
    }
    std::stringstream SS;
    SS << F.rdbuf();
    for (auto& U : Deserialize(SS.str())) {
      UnitCache.emplace(Key, std::move(U));
    }
  }

  auto U = std::make_shared<CachedUnit>();
  U->RIP = RIP;
  T->Host->RecordDeps(&U->Deps);
  T->Cfg.Learned = &U->Learned;
  const double T0 = NowMs();
  auto* IR = T->Host->GenerateIR(RIP, &U->Insts);
  const double T1 = NowMs();
  T->Stats.FexMs += T1 - T0;
  if (!IR) {
    T->Host->StopRecording();
    T->Cfg.Learned = nullptr;
    T->Stats.Failed++;
    fprintf(stderr, "fexwasm: no IR at %#llx\n", (unsigned long long)RIP);
    return T->Give(T->Out);
  }
  auto R = fexwasm::Compile(*IR, RIP, T->Cfg);
  T->Host->StopRecording();
  T->Cfg.Learned = nullptr;
  T->Host->Release();
  T->Stats.UnitMs += NowMs() - T1;
  if (!R.Error.empty()) {
    T->Stats.Failed++;
    fprintf(stderr, "fexwasm: %s (unit %#llx)\n", R.Error.c_str(), (unsigned long long)RIP);
    return T->Give(T->Out);
  }
  U->Module = std::move(R.Module);
  U->HomeBase = Home->Base;
  U->Relocatable = R.Relocatable;
  U->ICTargets = std::move(R.ICTargets);
  UnitCache.emplace(Key, U);
  if (!T->CacheDir.empty()) {
    std::ofstream F(T->CacheDir + Path, std::ios::binary | std::ios::app);
    const std::string Rec = Serialize(*U);
    F.write(Rec.data(), std::streamsize(Rec.size()));
  }
  return Emit(*U, 0);
}

fexwasm_bytes fexwasm_region(fexwasm_translator* T, const uint8_t* Req, size_t Size) {
  T->Out.clear();
  size_t Pos = 0;
  bool Ok = true;
  auto U32 = [&]() -> uint32_t {
    if (Pos + 4 > Size) {
      Ok = false;
      return 0;
    }
    uint32_t V;
    memcpy(&V, Req + Pos, 4);
    Pos += 4;
    return V;
  };
  std::vector<uint64_t> RIPs;
  for (uint32_t N = U32(); Ok && N--;) {
    RIPs.push_back(T->Window | U32());
  }
  for (uint32_t M = U32(); Ok && M--;) {
    const uint32_t Rip = U32();
    auto& V = T->Successors[Rip];
    V.clear();
    for (uint32_t K = U32(); Ok && K--;) {
      V.push_back(U32());
    }
  }
  for (uint32_t C = U32(); Ok && C--;) {
    const uint32_t Ret = U32();
    auto& V = T->CallTargets[Ret];
    V.clear();
    for (uint32_t K = U32(); Ok && K--;) {
      V.push_back(U32());
    }
  }
  if (!Ok || RIPs.empty()) {
    return T->Give(T->Out);
  }
  {
    const auto* Home = T->Host->MappingAt(RIPs[0]);
    // (regionabi=1: regions only for compiled code, where a game's time goes:
    // each worker compiles its own, and Wine's processes forming them for
    // their startup code took WebContent past its 2 GB)
    if (T->RegionAbiOnly && (!Home || Home->Abi != 1)) {
      return T->Give(T->Out);
    }
    T->UseAbi(Home ? Home->Abi : 0);
  }
  const double T0 = NowMs();
  auto R = fexwasm::CompileRegion(RIPs, T->Cfg);
  T->Stats.RegionMs += NowMs() - T0;
  if (!R.Error.empty()) {
    fprintf(stderr, "fexwasm region: %s\n", R.Error.c_str());
    return T->Give(T->Out);
  }
  T->Stats.Regions++;
  T->Stats.RegionBytes += R.Module.size();
  T->Out = std::move(R.Module);
  return T->Give(T->Out);
}

const char* fexwasm_stats_json(fexwasm_translator* T) {
  const auto& S = T->Stats;
  char B[512];
  snprintf(B, sizeof(B),
           "{\"units\":%llu,\"regions\":%llu,\"failed\":%llu,\"guestInsts\":%llu,\"unitBytes\":%llu,\"regionBytes\":%llu,"
           "\"fexMs\":%.1f,\"unitMs\":%.1f,\"regionMs\":%.1f,\"codeBytes\":%llu,\"cacheHits\":%llu,\"diskHits\":%llu,\"relocated\":%llu}",
           (unsigned long long)S.Units, (unsigned long long)S.Regions, (unsigned long long)S.Failed, (unsigned long long)S.GuestInsts,
           (unsigned long long)S.UnitBytes, (unsigned long long)S.RegionBytes, S.FexMs, S.UnitMs, S.RegionMs, (unsigned long long)S.CodeBytes,
           (unsigned long long)S.CacheHits, (unsigned long long)S.DiskHits, (unsigned long long)S.Relocated);
  T->Json = B;
  return T->Json.c_str();
}

} // extern "C"
