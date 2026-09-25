// fexrun: runs x86-64 guest functions through FEX IR -> wasm -> JavaScriptCore,
// in-process on macOS, and compares them against the same C compiled natively.
//
//   fexrun <guest.bin> <guest.syms> [kernel[=n] ...]
#include "backend.h"
#include "fexhost.h"

#include <FEXCore/Core/CoreState.h>
#include <FEXCore/Core/X86Enums.h>

extern "C" {
#include "kernels.h" // WasmProbe/Kernels (build.sh adds the path)
uint32_t k_calls(int n);  // guest/src/calls.c, compiled natively too
uint32_t k_switch(int n);
uint32_t k_vcall(int n);
uint32_t k_fib(int n);
uint32_t k_rswitch(int n);
uint32_t k_walk(int n);
uint32_t k_box2d(int n); // guest/box2d, compiled natively too
uint32_t k_box2d_tumbler(int n);
uint32_t k_box2d_joints(int n);
uint32_t k_box2d_rain(int n);
uint32_t k_box2d_mt4(int n); // Box2D's scheduler with 3 threads (none in fexrun: tasks run inline)
uint32_t k_box2d_joints_mt4(int n);
uint32_t k_coremark(int n); // guest/coremark, compiled natively too
extern char cm_out[];
}

#include <JavaScriptCore/JavaScriptCore.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

using FEXCore::Core::CPUState;

namespace {
constexpr uint64_t WINDOW = 0x5000'0000'0000ull;   // guest address window; wasm address = low 32 bits
constexpr uint64_t IMAGE_BASE = WINDOW + 0x40'0000; // guest/build_guest.sh links here
constexpr uint32_t MEM_PAGES = 4096;               // 256 MB of wasm memory
constexpr uint32_t CTX = 0x100;                    // CPUState: low, so offsets fit arm64 load/store immediates
constexpr uint32_t STACK_TOP = 0x0F00'0000;
constexpr uint32_t HALT = 0x0020'0000;             // guest return address that stops the dispatcher

fexwasm::FexHost* Host;
std::map<uint32_t, std::vector<uint8_t>> Units; // every translated unit, for --dump
fexwasm::BackendConfig Cfg;
uint32_t ThreadBase = 0; // FEXWASM_TB=<hex>: the (only) thread's Sys area offset
bool GuestWin64 = false;  // FEXWASM_GUEST=win64: kernels take the Win64 ABI (guest/build_guest_win64.sh)
std::unordered_set<uint64_t> ReturnAddrs; // Cfg.ReturnAddrs
std::unordered_set<uint64_t> ExitReturnAddrs; // Cfg.ExitReturnAddrs
std::unordered_set<uint64_t> CallTargetSet; // Cfg.CallTargetSet
uint8_t* Mem;
struct TStats {
  uint64_t Units = 0, GuestInsts = 0, IRms = 0, Errors = 0, Regions = 0, UnitBytes = 0, RegionBytes = 0;
  double GenMs = 0, EmitMs = 0, FetchMs = 0; // FetchMs: FEX IR for inlining and regions (inside EmitMs)
  uint64_t Fetches = 0;
} TS;

double NowMs() {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

std::string ReadFile(const char* Path) {
  std::ifstream F(Path, std::ios::binary);
  std::stringstream S;
  S << F.rdbuf();
  return S.str();
}

JSValueRef Eval(JSContextRef C, const std::string& Src) {
  JSStringRef S = JSStringCreateWithUTF8CString(Src.c_str());
  JSValueRef Exc = nullptr;
  JSValueRef R = JSEvaluateScript(C, S, nullptr, nullptr, 1, &Exc);
  JSStringRelease(S);
  if (Exc) {
    JSStringRef E = JSValueToStringCopy(C, Exc, nullptr);
    char Buf[2048];
    JSStringGetUTF8CString(E, Buf, sizeof(Buf));
    JSStringRelease(E);
    fprintf(stderr, "JS exception: %s\n", Buf);
    return nullptr;
  }
  return R;
}

// __translate(rip32) -> Uint8Array | null
// FEXWASM_DUMPDIR=dir writes every module as dir/{unit,region}_<rip>.wasm.
static void DumpModule(const char* Kind, uint32_t Rip32, const std::vector<uint8_t>& M) {
  static const char* Dir = getenv("FEXWASM_DUMPDIR");
  if (!Dir) {
    return;
  }
  char Path[1024];
  snprintf(Path, sizeof(Path), "%s/%s_%x.wasm", Dir, Kind, Rip32);
  if (FILE* F = fopen(Path, "wb")) {
    fwrite(M.data(), 1, M.size(), F);
    fclose(F);
  }
}

// Translates the unit at RIP into Units; false on failure.
bool TranslateUnit(uint64_t RIP, fexwasm::CompileResult* Out = nullptr) {
  const uint32_t Rip32 = uint32_t(RIP);
  double T0 = NowMs();
  uint64_t Insts = 0;
  auto* IR = Host->GenerateIR(RIP, &Insts);
  double T1 = NowMs();
  if (!IR) {
    fprintf(stderr, "no IR at %#llx\n", (unsigned long long)RIP);
    TS.Errors++;
    return false;
  }
  auto R = fexwasm::Compile(*IR, RIP, Cfg);
  Host->Release();
  double T2 = NowMs();
  TS.GenMs += T1 - T0;
  TS.EmitMs += T2 - T1;
  if (!R.Error.empty()) {
    fprintf(stderr, "backend: %s (unit %#llx)\n", R.Error.c_str(), (unsigned long long)RIP);
    TS.Errors++;
    return false;
  }
  TS.Units++;
  TS.GuestInsts += Insts;
  TS.UnitBytes += R.Module.size();
  Units[Rip32] = R.Module;
  DumpModule("unit", Rip32, R.Module);
  if (Out) {
    *Out = std::move(R);
  }
  return true;
}

// Ahead of time: every unit reachable from Seeds by constant jumps and
// calls, call returns and taken addresses of code symbols (FuncsPath: a
// symbol list), for threads that run code the profiled run never reached.
// Other indirect targets (jump tables) are not followed.
void TranslateAhead(const char* FuncsPath, std::vector<uint64_t> Work) {
  std::unordered_set<uint64_t> Funcs;
  {
    std::ifstream F(FuncsPath);
    std::string Name, Addr;
    while (F >> Name >> Addr) {
      Funcs.insert(strtoull(Addr.c_str(), nullptr, 16));
    }
  }
  if (Work.empty()) {
    Work.assign(Funcs.begin(), Funcs.end());
  }
  std::unordered_set<uint64_t> Seen;
  size_t Failed = 0;
  const double T0 = NowMs();
  while (!Work.empty()) {
    const uint64_t RIP = Work.back();
    Work.pop_back();
    if ((RIP >> 32) != (WINDOW >> 32) || !Seen.insert(RIP).second) {
      continue;
    }
    fexwasm::CompileResult R;
    if (!TranslateUnit(RIP, &R)) {
      Failed++;
      continue;
    }
    Work.insert(Work.end(), R.StaticSuccessors.begin(), R.StaticSuccessors.end());
    for (uint64_t A : R.AddressConstants) {
      if (Funcs.count(A)) {
        Work.push_back(A);
      }
    }
  }
  fprintf(stderr, "ahead of time: %zu units (%zu failed) in %.0f ms\n", Units.size(), Failed, NowMs() - T0);
}

JSValueRef JSTranslate(JSContextRef C, JSObjectRef, JSObjectRef, size_t Argc, const JSValueRef Argv[], JSValueRef* Exc) {
  const uint32_t Rip32 = uint32_t(JSValueToNumber(C, Argv[0], Exc));
  if (!TranslateUnit(WINDOW | Rip32)) {
    return JSValueMakeNull(C);
  }
  const auto& Module = Units[Rip32];
  JSObjectRef Arr = JSObjectMakeTypedArray(C, kJSTypedArrayTypeUint8Array, Module.size(), Exc);
  memcpy(JSObjectGetTypedArrayBytesPtr(C, Arr, Exc), Module.data(), Module.size());
  return Arr;
}

// __translateRegion(Uint32Array of rip32s) -> Uint8Array | null
std::map<std::vector<uint32_t>, std::vector<uint8_t>> Regions; // for --dump
JSValueRef JSTranslateRegion(JSContextRef C, JSObjectRef, JSObjectRef, size_t, const JSValueRef Argv[], JSValueRef* Exc) {
  JSObjectRef A = JSValueToObject(C, Argv[0], Exc);
  const size_t N = JSObjectGetTypedArrayLength(C, A, Exc);
  const uint32_t* P = static_cast<const uint32_t*>(JSObjectGetTypedArrayBytesPtr(C, A, Exc));
  std::vector<uint32_t> Rip32s(P, P + N);
  std::vector<uint64_t> RIPs;
  for (uint32_t R : Rip32s) {
    RIPs.push_back(WINDOW | R);
  }
  if (const char* Only = getenv("FEXWASM_REGION_ONLY")) { // comma-separated entry RIPs
    bool Allowed = false;
    for (const char* P = Only; *P;) {
      char* End;
      Allowed |= strtoul(P, &End, 16) == Rip32s[0];
      P = *End == ',' ? End + 1 : End;
      if (End == P && *P != ',') {
        break;
      }
    }
    if (!Allowed) {
      return JSValueMakeNull(C);
    }
  }
  double T0 = NowMs();
  auto R = fexwasm::CompileRegion(RIPs, Cfg);
  TS.EmitMs += NowMs() - T0;
  if (!R.Error.empty()) {
    fprintf(stderr, "region: %s\n", R.Error.c_str());
    return JSValueMakeNull(C);
  }
  TS.Regions++;
  TS.RegionBytes += R.Module.size();
  Regions[Rip32s] = R.Module;
  DumpModule("region", Rip32s[0], R.Module);
  if (getenv("FEXWASM_DEBUG")) {
    std::string L;
    for (uint64_t U : R.RegionRIPs) {
      char B[16];
      snprintf(B, sizeof(B), " %x", uint32_t(U));
      L += B;
    }
    fprintf(stderr, "[region] %u of %zu units, %zu bytes:%s\n", R.RegionUnits, Rip32s.size(), R.Module.size(), L.c_str());
  }
  JSObjectRef Arr = JSObjectMakeTypedArray(C, kJSTypedArrayTypeUint8Array, R.Module.size(), Exc);
  memcpy(JSObjectGetTypedArrayBytesPtr(C, Arr, Exc), R.Module.data(), R.Module.size());
  return Arr;
}

std::vector<uint8_t> DispatcherBytes;
JSValueRef JSDispatcher(JSContextRef C, JSObjectRef, JSObjectRef, size_t, const JSValueRef[], JSValueRef* Exc) {
  JSObjectRef Arr = JSObjectMakeTypedArray(C, kJSTypedArrayTypeUint8Array, DispatcherBytes.size(), Exc);
  memcpy(JSObjectGetTypedArrayBytesPtr(C, Arr, Exc), DispatcherBytes.data(), DispatcherBytes.size());
  return Arr;
}

JSValueRef JSLog(JSContextRef C, JSObjectRef, JSObjectRef, size_t Argc, const JSValueRef Argv[], JSValueRef*) {
  if (Argc) {
    JSStringRef S = JSValueToStringCopy(C, Argv[0], nullptr);
    char Buf[1024];
    JSStringGetUTF8CString(S, Buf, sizeof(Buf));
    JSStringRelease(S);
    fprintf(stderr, "[js] %s\n", Buf);
  }
  return JSValueMakeUndefined(C);
}

JSValueRef JSNow(JSContextRef C, JSObjectRef, JSObjectRef, size_t, const JSValueRef[], JSValueRef*) {
  return JSValueMakeNumber(C, NowMs());
}

void SetFn(JSGlobalContextRef C, const char* Name, JSObjectCallAsFunctionCallback Fn) {
  JSStringRef N = JSStringCreateWithUTF8CString(Name);
  JSObjectSetProperty(C, JSContextGetGlobalObject(C), N, JSObjectMakeFunctionWithCallback(C, N, Fn), kJSPropertyAttributeNone, nullptr);
  JSStringRelease(N);
}

CPUState* State() {
  return reinterpret_cast<CPUState*>(Mem + ThreadBase + CTX);
}

// Calls a guest function f(n) through the translated code; returns RAX.
uint64_t CallGuest(JSGlobalContextRef C, uint64_t Fn, uint64_t Arg, uint64_t* Dispatches) {
  // Fresh architectural state with FEX's defaults (DF encoded as 1, cleared
  // flags with the inverted-carry convention, mxcsr, ...).
  auto* S = State();
  const CPUState Default {};
  memcpy(S, &Default, sizeof(CPUState));
  // SysV: the argument in RDI. Win64: in RCX, with the caller's 32-byte shadow
  // space above the return address.
  S->gregs[GuestWin64 ? FEXCore::X86State::REG_RCX : FEXCore::X86State::REG_RDI] = Arg;
  const uint32_t Ret = GuestWin64 ? STACK_TOP - 0x48 : STACK_TOP - 8;
  uint64_t SP = WINDOW + Ret;
  *reinterpret_cast<uint64_t*>(Mem + Ret) = WINDOW + HALT;
  S->gregs[FEXCore::X86State::REG_RSP] = SP;
  char Src[128];
  snprintf(Src, sizeof(Src), "rt.run(%u, %u)", uint32_t(Fn), HALT);
  JSValueRef R = Eval(C, Src);
  (void)R;
  *Dispatches = uint64_t(JSValueToNumber(C, Eval(C, "rt.stats.misses + rt.stats.jsDispatches"), nullptr));
  return S->gregs[FEXCore::X86State::REG_RAX];
}
} // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <guest.bin> <guest.syms> [kernel[=n] ...]\n", argv[0]);
    return 1;
  }
  std::string Image = ReadFile(argv[1]);
  std::map<std::string, uint64_t> Syms;
  {
    std::ifstream F(argv[2]);
    std::string Name, Addr;
    while (F >> Name >> Addr) {
      Syms[Name] = strtoull(Addr.c_str(), nullptr, 16);
    }
  }

  const char* TSOEnv = getenv("FEXWASM_TSO");
  const char* FlagsEnv = getenv("FEXWASM_ABIFLAGS");
  const bool ABIFlags = !FlagsEnv || atoi(FlagsEnv) != 0; // on unless FEXWASM_ABIFLAGS=0
  const bool CrossFlags = !getenv("FEXWASM_NOCROSSFLAGS");
  fexwasm::FexHost FH({.TSO = TSOEnv != nullptr, .Multiblock = true, .ABILocalFlags = ABIFlags, .CrossUnitFlags = CrossFlags});
  if (CrossFlags) {
    Cfg.FlagsDeadAt = [&FH](uint64_t RIP) { return FH.FlagsDeadAtEntry(RIP); };
  }
  Cfg.TSOMode = TSOEnv ? uint32_t(atoi(TSOEnv)) : 0;
  Cfg.ReturnAddrs = &ReturnAddrs;
  Cfg.ExitReturnAddrs = &ExitReturnAddrs;
  Cfg.CallTargetSet = &CallTargetSet;
  Cfg.SlotTagBase = 0x14'0000; // u32 RIP per table slot (the call inline cache)
  Cfg.SlotTagCount = 0x1'0000;
  Cfg.UnitCounterBase = 0x18'0000; // u32 entry counts of units
  Cfg.UnitCounterBits = 14;
  Cfg.ABILocalFlags = ABIFlags;
  if (const char* R = getenv("FEXWASM_REGARGS")) {
    Cfg.RegArgs = uint32_t(atoi(R));
  }
  if (const char* M = getenv("FEXWASM_REGMASK")) { // e.g. 0xDF: all of RAX..RDI but RBP
    Cfg.RegArgMask = uint32_t(strtoul(M, nullptr, 16));
    Cfg.RegArgs = uint32_t(__builtin_popcount(Cfg.RegArgMask));
  }
  if (const char* F = getenv("FEXWASM_ABIFLAGS")) {
    Cfg.ABILocalFlags = atoi(F) != 0;
  }
  GuestWin64 = getenv("FEXWASM_GUEST") && std::string(getenv("FEXWASM_GUEST")) == "win64";
  { // guest calling convention for register liveness (FEXWASM_ABI=none|sysv|win64)
    const char* A = getenv("FEXWASM_ABI");
    const std::string Abi = A ? A : GuestWin64 ? "win64" : "sysv";
    Cfg.ABI = Abi == "sysv" ? fexwasm::BackendConfig::GuestABI::SysV
              : Abi == "win64" ? fexwasm::BackendConfig::GuestABI::Win64 : fexwasm::BackendConfig::GuestABI::None;
  }
  Cfg.ThreadBaseGlobal = getenv("FEXWASM_TB") != nullptr; // thread base as the imported e.tb
  ThreadBase = Cfg.ThreadBaseGlobal ? uint32_t(strtoul(getenv("FEXWASM_TB"), nullptr, 16)) : 0;
  Cfg.SharedMemory = getenv("FEXWASM_SHARED") != nullptr; // modules for threads (with FEXWASM_TB)
  if (getenv("FEXWASM_JS_DISPATCH")) { // JS can't thread register arguments
    Cfg.RegArgs = 0;
  }
  Host = &FH;
  if (!FH.MapGuest(IMAGE_BASE, Image.data(), Image.size())) {
    return 1;
  }
  Cfg.CtxAddr = CTX;
  // NZCV lives where FEX spills it: the 32-bit word at flags[RFLAG_NZCV_LOC].
  Cfg.NZCVAddr = CTX + offsetof(CPUState, flags) + FEXCore::X86State::RFLAG_NZCV_LOC;
  Cfg.MemPages = MEM_PAGES;
  Cfg.FlagSpillAddr = 0x40;
  Cfg.NamedConstants = FH.NamedConstants();
  if (!getenv("FEXWASM_NOINLINE")) {
    Cfg.FetchIR = [&FH](uint64_t RIP) {
      const double T0 = NowMs();
      auto* R = FH.GenerateIR(RIP);
      TS.FetchMs += NowMs() - T0;
      TS.Fetches++;
      return R;
    };
  }
  if (const char* V = getenv("FEXWASM_INLINE_MAX")) {
    Cfg.InlineMaxNodes = uint32_t(atoi(V));
  }
  if (const char* V = getenv("FEXWASM_REGION_INLINE_MAX")) {
    Cfg.RegionInlineMaxNodes = uint32_t(atoi(V));
  }
  if (const char* V = getenv("FEXWASM_UNIT_INLINE_MAX")) {
    Cfg.UnitInlineMaxNodes = uint32_t(atoi(V));
  }
  if (const char* V = getenv("FEXWASM_REGION_BYTES")) {
    Cfg.RegionMaxBytes = uint32_t(atoi(V));
  }
  if (const char* V = getenv("FEXWASM_INLINE_DEPTH")) {
    Cfg.InlineDepth = uint32_t(atoi(V));
  }
  Cfg.IndexedConstantPointers = FH.IndexedConstantPointers();

  JSGlobalContextRef C = JSGlobalContextCreate(nullptr);
  SetFn(C, "__translate", JSTranslate);
  SetFn(C, "__translateRegion", JSTranslateRegion);
  SetFn(C, "__log", JSLog);
  if (!getenv("FEXWASM_NOREGIONS")) {
    Cfg.HotThreshold = getenv("FEXWASM_HOT") ? uint32_t(atoi(getenv("FEXWASM_HOT"))) : 100;
  }
  SetFn(C, "__now", JSNow);
  SetFn(C, "__dispatcher", JSDispatcher);
  const bool UseWasmDispatch = !getenv("FEXWASM_JS_DISPATCH");
  DispatcherBytes = fexwasm::BuildDispatcher(Cfg);
  Eval(C, std::string("var getenv_debug = ") + (getenv("FEXWASM_DEBUG") ? "true;" : "false;"));
  Eval(C, ReadFile("js/runtime.js"));
  Eval(C, "var mem = new WebAssembly.Memory({ initial: " + std::to_string(MEM_PAGES) +
             (Cfg.SharedMemory ? ", maximum: " + std::to_string(MEM_PAGES) + ", shared: true" : std::string()) + " });"
          "var rt = FexRuntime.createRuntime({ mem, translate: __translate, translateRegion: __translateRegion, now: __now, "
          "log: getenv_debug ? __log : undefined, "
          "hotAddr: " + std::to_string(Cfg.HotAddr) + ", hotThreshold: " + std::to_string(Cfg.HotThreshold) +
          ", unitCounterBase: " + std::to_string(Cfg.UnitCounterBase) + ", unitCounterBits: " + std::to_string(Cfg.UnitCounterBits) +
          (getenv("FEXWASM_CODE_BUDGET") ? ", codeBudget: " + std::string(getenv("FEXWASM_CODE_BUDGET")) : std::string()) + (Cfg.ThreadBaseGlobal ? ", threadBase: " + std::to_string(ThreadBase) : std::string()) + ", slotTagBase: " +
                 std::to_string(Cfg.SlotTagBase) + ", slotTagCount: " + std::to_string(Cfg.SlotTagCount) + ", dispatchBase: " +
          std::to_string(Cfg.DispatchBase) + ", dispatchBits: " + std::to_string(Cfg.DispatchBits) +
          (UseWasmDispatch ? ", dispatcher: __dispatcher() });" : " });"));
  // JSObjectGetArrayBufferBytesPtr returns null for a wasm memory's buffer, but
  // a typed-array view over it exposes the (stable, never grown) pointer.
  JSValueRef View = Eval(C, "var memU8 = new Uint8Array(mem.buffer); memU8");
  Mem = static_cast<uint8_t*>(JSObjectGetTypedArrayBytesPtr(C, JSValueToObject(C, View, nullptr), nullptr));
  if (Cfg.HotThreshold && !getenv("FEXWASM_NOINLINE") && !getenv("FEXWASM_NOINDIRECT")) {
    if (!getenv("FEXWASM_NOIC")) Cfg.TableSlot = [](uint64_t RIP) -> uint32_t {
      const uint32_t Mask = (1u << Cfg.DispatchBits) - 1;
      for (uint32_t H = (uint32_t(RIP) * 0x9E3779B1u) >> (32 - Cfg.DispatchBits);; H = (H + 1) & Mask) {
        const uint32_t* E = reinterpret_cast<const uint32_t*>(Mem + ThreadBase + Cfg.DispatchBase + 64 * H);
        if (E[0] == 0) {
          return 0;
        }
        if (E[0] == uint32_t(RIP)) {
          return E[1];
        }
      }
    };
    Cfg.Successors = [](uint64_t RIP) {
      std::vector<uint64_t> T;
      const uint32_t Mask = (1u << Cfg.DispatchBits) - 1;
      for (uint32_t H = (uint32_t(RIP) * 0x9E3779B1u) >> (32 - Cfg.DispatchBits);; H = (H + 1) & Mask) {
        const uint32_t* E = reinterpret_cast<const uint32_t*>(Mem + ThreadBase + Cfg.DispatchBase + 64 * H);
        if (E[0] == 0) {
          break;
        }
        if (E[0] == uint32_t(RIP)) {
          for (int i = 4; i < 16 && E[i]; i++) {
            T.push_back(WINDOW | E[i]);
          }
          break;
        }
      }
      return T;
    };
    Cfg.CallTargets = [](uint64_t RetAddr) {
      std::vector<uint64_t> T;
      const uint32_t Mask = (1u << Cfg.CallSiteBits) - 1;
      for (uint32_t H = (uint32_t(RetAddr) * 0x9E3779B1u) >> (32 - Cfg.CallSiteBits);; H = (H + 1) & Mask) {
        const uint32_t* E = reinterpret_cast<const uint32_t*>(Mem + ThreadBase + Cfg.CallSiteBase + 32 * H);
        if (E[0] == 0) {
          break;
        }
        if (E[0] == uint32_t(RetAddr)) {
          for (int i = 4; i < 8 && E[i]; i++) {
            T.push_back(WINDOW | E[i]);
          }
          break;
        }
      }
      return T;
    };
  }
  memcpy(Mem + uint32_t(IMAGE_BASE), Image.data(), Image.size());

  struct K {
    const char* Name;
    uint32_t (*Native)(int);
    int N;
  };
  const K All[] = {
    {"intmix", k_intmix, 10'000'000}, {"sieve", k_sieve, 1},        {"qsort", k_qsort, 1},     {"hash", k_hash, 4},
    {"interp", k_interp, 2'000'000},  {"ptrchase", k_ptrchase, 1'000'000}, {"memcpy", k_memcpy, 20}, {"crc32", k_crc32, 1},
    {"tree", k_tree, 200'000},        {"matmul", k_matmul, 4},     {"nbody", k_nbody, 300'000},
    {"calls", k_calls, 10'000'000},   {"switch", k_switch, 10'000'000},
    {"vcall", k_vcall, 10'000'000},   {"fib", k_fib, 200},             {"rswitch", k_rswitch, 10'000'000},
    {"walk", k_walk, 2000},           {"coremark", k_coremark, 2000},
    {"box2d", k_box2d, 30},           {"box2d_tumbler", k_box2d_tumbler, 60}, {"box2d_joints", k_box2d_joints, 20},
    {"box2d_rain", k_box2d_rain, 100},    {"box2d_mt4", k_box2d_mt4, 30}, {"box2d_joints_mt4", k_box2d_joints_mt4, 20},
  };
  std::vector<std::pair<std::string, int>> Want;
  std::string DumpDir;
  for (int i = 3; i < argc; i++) {
    std::string A = argv[i];
    if (A == "--dump" && i + 1 < argc) {
      DumpDir = argv[++i];
      continue;
    }
    auto Eq = A.find('=');
    Want.push_back({A.substr(0, Eq), Eq == std::string::npos ? 0 : atoi(A.c_str() + Eq + 1)});
  }
  if (Want.empty()) {
    for (auto& k : All) {
      Want.push_back({k.Name, 0});
    }
  }

  // FEXWASM_AOT=<guest>.funcs: translate ahead from the kernels to run (or,
  // with FEXWASM_AOT_ALL, from every code symbol).
  if (const char* Funcs = getenv("FEXWASM_AOT")) {
    std::vector<uint64_t> Seeds;
    for (auto& [Name, NArg] : Want) {
      auto It = Syms.find("k_" + Name);
      if (It != Syms.end() && !getenv("FEXWASM_AOT_ALL")) {
        Seeds.push_back(It->second);
      }
    }
    TranslateAhead(Funcs, Seeds);
  }
  std::string KernelJSON;
  printf("%-9s %10s %12s %12s %8s %6s %10s %s\n", "kernel", "n", "native ms", "wasm ms", "ratio", "match", "dispatch", "notes");
  for (auto& [Name, NArg] : Want) {
    const K* Kk = nullptr;
    for (auto& k : All) {
      if (Name == k.Name) {
        Kk = &k;
      }
    }
    auto SymIt = Syms.find("k_" + Name);
    if (!Kk || SymIt == Syms.end()) {
      printf("%-9s unknown\n", Name.c_str());
      continue;
    }
    const int N = NArg ? NArg : Kk->N;
    const uint64_t Fn = SymIt->second;

    // warm-up: a tenth of the work (kernels may carry flags in bits 24+)
    const int WarmN = std::max(1, (N & 0xFFFFFF) / 10) | (N & ~0xFFFFFF);
    Kk->Native(WarmN);
    double T = NowMs();
    uint32_t NativeChk = Kk->Native(N);
    double NativeMs = NowMs() - T;

    // Warm-up (translation + tier-up), then a timed run. Guest state carries
    // over between calls exactly as it does natively (same call sequence).
    uint64_t D = 0;
    TS = {};
    CallGuest(C, Fn, WarmN, &D); // warm-up long enough to profile and recompile
    double Tw = NowMs();
    uint32_t WasmChk = uint32_t(CallGuest(C, Fn, N, &D));
    double WasmMs = NowMs() - Tw;
    char Notes[200];
    const int Flushes = int(JSValueToNumber(C, Eval(C, "rt.stats.flushes"), nullptr));
    snprintf(Notes, sizeof(Notes), "units=%llu regions=%llu insts=%llu fex=%.1fms emit=%.1fms (fetch %llu: %.1fms) flushes=%d B/inst=%.0f+%.0f%s",
             (unsigned long long)TS.Units, (unsigned long long)TS.Regions, (unsigned long long)TS.GuestInsts, TS.GenMs, TS.EmitMs,
             (unsigned long long)TS.Fetches, TS.FetchMs, Flushes,
             TS.GuestInsts ? double(TS.UnitBytes) / double(TS.GuestInsts) : 0.0, TS.GuestInsts ? double(TS.RegionBytes) / double(TS.GuestInsts) : 0.0,
             TS.Errors ? " ERRORS" : "");
    printf("%-9s %10d %12.1f %12.1f %8.2f %6s %10llu %s\n", Name.c_str(), N, NativeMs, WasmMs, WasmMs / NativeMs,
           WasmChk == NativeChk ? "yes" : "NO", (unsigned long long)D, Notes);
    if (WasmChk != NativeChk) {
      printf("          native chk=%u wasm chk=%u\n", NativeChk, WasmChk);
      auto Out = Syms.find("cm_out");
      if (Out != Syms.end() && getenv("FEXWASM_DEBUG")) {
        printf("guest output:\n%.*s\n", 2000, reinterpret_cast<const char*>(Mem + uint32_t(Out->second)));
        printf("native output:\n%.*s\n", 2000, cm_out);
      }
    }
    if (getenv("FEXWASM_PROFILE")) {
      // Hottest units by dispatcher entries (counts include both runs), with
      // the nearest symbol at or below each RIP.
      std::vector<std::pair<uint32_t, uint32_t>> Hot;
      for (uint32_t H = 0; H < (1u << Cfg.DispatchBits); H++) {
        const uint32_t* E = reinterpret_cast<const uint32_t*>(Mem + ThreadBase + Cfg.DispatchBase + 64 * H);
        if (E[0]) {
          Hot.push_back({E[2], E[0]});
          const_cast<uint32_t*>(E)[2] = 0;
        }
      }
      std::sort(Hot.rbegin(), Hot.rend());
      for (size_t i = 0; i < Hot.size() && i < 12; i++) {
        std::string Sym = "?";
        uint64_t Best = 0;
        for (auto& [Nm, A] : Syms) {
          if (uint32_t(A) <= Hot[i].second && A > Best) {
            Best = A;
            Sym = Nm + "+0x" + ([&] { char B[16]; snprintf(B, sizeof(B), "%x", Hot[i].second - uint32_t(A)); return std::string(B); })();
          }
        }
        printf("    %10u  %#x  %s\n", Hot[i].first, Hot[i].second, Sym.c_str());
      }
    }
    char Row[256];
    snprintf(Row, sizeof(Row), "%s{\"name\":\"%s\",\"entry\":%u,\"n\":%d,\"chk\":%u,\"macNativeMs\":%.2f,\"macWasmMs\":%.2f}",
             KernelJSON.empty() ? "" : ",", Name.c_str(), uint32_t(Fn), N, WasmChk, NativeMs, WasmMs);
    KernelJSON += Row;
    fflush(stdout);
  }
  // FEXWASM_RECOMPILE=n: compile every region (and unit) formed above n more
  // times, to time and profile the backend on its own.
  if (const char* R = getenv("FEXWASM_RECOMPILE")) {
    const int Reps = atoi(R);
    std::vector<uint32_t> UnitRips;
    for (auto& [Rip, Bytes] : Units) {
      UnitRips.push_back(Rip);
    }
    const auto SavedRegions = Regions;
    double UnitMs = 0, RegionMs = 0;
    size_t UnitBytes = 0, RegionBytes = 0;
    for (int Rep = 0; Rep < Reps; Rep++) {
      double T0 = NowMs();
      for (uint32_t Rip : UnitRips) {
        fexwasm::CompileResult Rr;
        if (TranslateUnit(WINDOW | Rip, &Rr)) {
          UnitBytes += Rr.Module.size();
        }
      }
      double T1 = NowMs();
      for (auto& [Rips, Bytes] : SavedRegions) {
        std::vector<uint64_t> V;
        for (uint32_t Rx : Rips) {
          V.push_back(WINDOW | Rx);
        }
        RegionBytes += fexwasm::CompileRegion(V, Cfg).Module.size();
      }
      UnitMs += T1 - T0;
      RegionMs += NowMs() - T1;
    }
    fprintf(stderr, "recompile x%d: %zu units %.1f ms each pass (%.1f us/unit, %zu B), %zu regions %.1f ms (%.1f us/region, %zu B)\n", Reps,
            UnitRips.size(), UnitMs / Reps, 1000 * UnitMs / Reps / std::max<size_t>(1, UnitRips.size()), UnitBytes / std::max(1, Reps),
            SavedRegions.size(), RegionMs / Reps, 1000 * RegionMs / Reps / std::max<size_t>(1, SavedRegions.size()),
            RegionBytes / std::max(1, Reps));
  }
  if (!DumpDir.empty()) {
    // units.bin: u32 count, then per unit: u32 rip32, u32 length, bytes.
    std::ofstream U(DumpDir + "/units.bin", std::ios::binary);
    auto Put32 = [&](uint32_t V) { U.write(reinterpret_cast<const char*>(&V), 4); };
    Put32(uint32_t(Units.size()));
    for (auto& [Rip, Bytes] : Units) {
      Put32(Rip);
      Put32(uint32_t(Bytes.size()));
      U.write(reinterpret_cast<const char*>(Bytes.data()), std::streamsize(Bytes.size()));
    }
    // regions.bin: u32 count, then per region: u32 n, n x u32 rip32, u32 length, bytes.
    {
      std::ofstream RF(DumpDir + "/regions.bin", std::ios::binary);
      auto Put = [&](uint32_t V) { RF.write(reinterpret_cast<const char*>(&V), 4); };
      Put(uint32_t(Regions.size()));
      for (auto& [Rips, Bytes] : Regions) {
        Put(uint32_t(Rips.size()));
        for (uint32_t R : Rips) {
          Put(R);
        }
        Put(uint32_t(Bytes.size()));
        RF.write(reinterpret_cast<const char*>(Bytes.data()), std::streamsize(Bytes.size()));
      }
    }
    const CPUState Default {};
    std::ofstream(DumpDir + "/state.bin", std::ios::binary).write(reinterpret_cast<const char*>(&Default), sizeof(Default));
    std::ofstream(DumpDir + "/image.bin", std::ios::binary).write(Image.data(), std::streamsize(Image.size()));
    std::ofstream(DumpDir + "/dispatcher.wasm", std::ios::binary)
      .write(reinterpret_cast<const char*>(DispatcherBytes.data()), std::streamsize(DispatcherBytes.size()));
    char Cfgs[512];
    snprintf(Cfgs, sizeof(Cfgs),
             "{\"memPages\":%u,\"ctx\":%u,\"stateSize\":%zu,\"imageLow\":%u,\"stackTop\":%u,\"halt\":%u,"
             "\"windowHi\":%u,\"gregsOff\":%zu,\"units\":%zu,\"dispatchBase\":%u,\"dispatchBits\":%u,\"hotAddr\":%u,\"hotThreshold\":%u,"
             "\"slotTagBase\":%u,\"slotTagCount\":%u,\"threadBase\":%d,\"shared\":%s,\"guestAbi\":\"%s\",\"kernels\":[",
             MEM_PAGES, CTX, sizeof(CPUState), uint32_t(IMAGE_BASE), STACK_TOP, HALT, uint32_t(WINDOW >> 32),
             offsetof(CPUState, gregs), Units.size(), Cfg.DispatchBase, Cfg.DispatchBits, Cfg.HotAddr, Cfg.HotThreshold, Cfg.SlotTagBase,
             Cfg.SlotTagCount, Cfg.ThreadBaseGlobal ? int(ThreadBase) : -1, Cfg.SharedMemory ? "true" : "false", GuestWin64 ? "win64" : "sysv");
    std::ofstream(DumpDir + "/config.json") << Cfgs << KernelJSON << "]}\n";
    printf("dumped %zu units to %s\n", Units.size(), DumpDir.c_str());
  }
  JSGlobalContextRelease(C);
  return 0;
}
