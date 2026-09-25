// fextest: runs one of FEX's ASM unit tests (unittests/ASM, assembled with
// nasm, config from Scripts/json_asm_config_parse.py) through
// FEX IR -> wasm -> JavaScriptCore and checks the expected register values.
//
//   fextest <test.bin> <test.config.bin> [-v]
//
// Prints one line: PASS, FAIL <regs>, SKIP <why>, UNSUP <op> or ERROR <why>.
// Exit codes: 0 pass, 1 fail, 2 skip, 3 unsupported op, 4 error.
//
// FEX's harness loads the code at 0x10000 and maps data at fixed low
// addresses (0xe0000000, ...). Here guest addresses live in the 4 GB window at
// WINDOW (macOS keeps the low 4 GB unmapped), and the wasm address is the low
// 32 bits, so data addresses in the tests land where they expect. Registers
// that hold a code address therefore carry WINDOW in their upper bits; the
// comparison accepts `expected + WINDOW` for those.
#include "backend.h"
#include "fexhost.h"

#include <FEXCore/Core/CoreState.h>
#include <FEXCore/Core/X86Enums.h>

#include <JavaScriptCore/JavaScriptCore.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <unistd.h>
#include <vector>

using FEXCore::Core::CPUState;

namespace {
constexpr uint64_t WINDOW = 0x5000'0000'0000ull;
constexpr uint32_t CODE = 0x1'0000;
constexpr uint32_t MEM_PAGES = 65536; // the full 4 GB
constexpr uint32_t BREAK_RIP = 4;

fexwasm::FexHost* Host;
fexwasm::BackendConfig Cfg;
std::unordered_set<uint64_t> ReturnAddrs; // Cfg.ReturnAddrs
std::unordered_set<uint64_t> ExitReturnAddrs; // Cfg.ExitReturnAddrs
std::unordered_set<uint64_t> CallTargetSet; // Cfg.CallTargetSet
std::string LastError;
bool Verbose;

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
    if (LastError.empty()) {
      LastError = std::string("js: ") + Buf;
    }
    return nullptr;
  }
  return R;
}

JSValueRef JSTranslate(JSContextRef C, JSObjectRef, JSObjectRef, size_t, const JSValueRef Argv[], JSValueRef* Exc) {
  const uint64_t RIP = WINDOW | uint32_t(JSValueToNumber(C, Argv[0], Exc));
  auto* IR = Host->GenerateIR(RIP);
  if (!IR) {
    LastError = "no IR";
    return JSValueMakeNull(C);
  }
  auto R = fexwasm::Compile(*IR, RIP, Cfg);
  Host->Release();
  if (!R.Error.empty()) {
    LastError = "backend: " + R.Error;
    return JSValueMakeNull(C);
  }
  if (Verbose) {
    fprintf(stderr, "unit %#llx: %zu bytes\n", (unsigned long long)RIP, R.Module.size());
  }
  JSObjectRef Arr = JSObjectMakeTypedArray(C, kJSTypedArrayTypeUint8Array, R.Module.size(), Exc);
  memcpy(JSObjectGetTypedArrayBytesPtr(C, Arr, Exc), R.Module.data(), R.Module.size());
  return Arr;
}

JSValueRef JSTranslateRegion(JSContextRef C, JSObjectRef, JSObjectRef, size_t, const JSValueRef Argv[], JSValueRef* Exc) {
  JSObjectRef A = JSValueToObject(C, Argv[0], Exc);
  const size_t N = JSObjectGetTypedArrayLength(C, A, Exc);
  const uint32_t* P = static_cast<const uint32_t*>(JSObjectGetTypedArrayBytesPtr(C, A, Exc));
  std::vector<uint64_t> RIPs;
  for (size_t i = 0; i < N; i++) {
    RIPs.push_back(WINDOW | P[i]);
  }
  auto R = fexwasm::CompileRegion(RIPs, Cfg);
  if (!R.Error.empty()) {
    if (R.Error.find("unsupported") != std::string::npos) {
      LastError = "backend: " + R.Error;
    }
    return JSValueMakeNull(C);
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
JSValueRef JSNow(JSContextRef C, JSObjectRef, JSObjectRef, size_t, const JSValueRef[], JSValueRef*) {
  return JSValueMakeNumber(C, std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count());
}
void SetFn(JSGlobalContextRef C, const char* Name, JSObjectCallAsFunctionCallback Fn) {
  JSStringRef N = JSStringCreateWithUTF8CString(Name);
  JSObjectSetProperty(C, JSContextGetGlobalObject(C), N, JSObjectMakeFunctionWithCallback(C, N, Fn), kJSPropertyAttributeNone, nullptr);
  JSStringRelease(N);
}

// The binary config written by Scripts/json_config_parse.py.
struct Config {
  uint64_t Match, Ignore, StackSize, EntryPoint;
  uint32_t ABI, Mode, HostFeatures;
  uint32_t RegionOff, RegionCount, RegOff, RegCount, MemOff, MemCount, EnvOff, EnvCount;
};
static_assert(sizeof(Config) == 76 || sizeof(Config) == 80);

template<typename T>
T At(const std::string& S, size_t Off) {
  T V;
  memcpy(&V, S.data() + Off, sizeof(T));
  return V;
}

int Result(int Code, const std::string& Line) {
  printf("%s\n", Line.c_str());
  fflush(stdout);
  _exit(Code); // skip JSC / FEX teardown
}
} // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <test.bin> <test.config.bin> [-v]\n", argv[0]);
    return 4;
  }
  Verbose = argc > 3 && !strcmp(argv[3], "-v");
  alarm(10); // a translation bug can loop forever
  const std::string Code = ReadFile(argv[1]), Raw = ReadFile(argv[2]);
  if (Code.empty() || Raw.size() < 76) {
    return Result(4, "ERROR missing test files");
  }
  Config C {};
  memcpy(&C, Raw.data(), 76);
  if (C.Mode != 1) {
    return Result(2, "SKIP 32-bit");
  }
  // HostFeatures bits (json_config_parse.py) that FEX's harness gates on the
  // host: RAND, SHA, CLZERO, LINUX, AES256, AFP. (AVX is supported.)
  constexpr uint32_t Gated = 1u << 3 | 1u << 4 | 1u << 5 | 1u << 9 | 1u << 10 | 1u << 11;
  if (C.HostFeatures & Gated) {
    char B[64];
    snprintf(B, sizeof(B), "SKIP features %#x", C.HostFeatures & Gated);
    return Result(2, B);
  }

  // Memory regions the test maps: keep the backend's scratch words, CPUState
  // and dispatch table clear of them (in wasm-address space).
  std::vector<std::pair<uint32_t, uint64_t>> Regions = {{0xe000'0000, 0x10000}, {0xe800'0000 - 0x4000, 0x8000}, {CODE, Code.size()}};
  for (uint32_t i = 0; i < C.RegionCount; i++) {
    Regions.push_back({uint32_t(At<uint64_t>(Raw, C.RegionOff + i * 16)), At<uint64_t>(Raw, C.RegionOff + i * 16 + 8)});
  }
  auto Free = [&](uint32_t Base, uint32_t Len) {
    for (auto& [A, L] : Regions) {
      if (L >= 0x1'0000'0000ull || (uint64_t(A) < uint64_t(Base) + Len && uint64_t(Base) < uint64_t(A) + L)) {
        return false;
      }
    }
    return true;
  };
  uint32_t Sys = 0;
  for (uint32_t Try : {0u, 0x0400'0000u, 0x3000'0000u, 0x9000'0000u}) {
    if (Free(Try, 0x4'0000) && Free(Try + 0x10'0000, (64u << Cfg.DispatchBits) + 0x2'0000)) {
      Sys = Try;
      break;
    }
    Sys = UINT32_MAX;
  }
  if (Sys == UINT32_MAX) {
    return Result(2, "SKIP no room for the backend's state");
  }
  const uint32_t CTX = Sys + 0x100;

  // Env entries (NUL-terminated key, value): FEX options the test asks for.
  bool ReducedX87 = false;
  for (uint32_t i = 0, Off = C.EnvOff; i < C.EnvCount; i++) {
    const std::string Key = Raw.c_str() + Off;
    const std::string Value = Raw.c_str() + Off + Key.size() + 1;
    Off += uint32_t(Key.size() + Value.size() + 2);
    if (Key == "FEX_X87REDUCEDPRECISION") {
      ReducedX87 = Value == "1";
    }
  }
  const char* FlagsEnv = getenv("FEXWASM_ABIFLAGS");
  const bool ABIFlags = FlagsEnv && atoi(FlagsEnv) != 0; // off unless FEXWASM_ABIFLAGS=1
  const bool CrossFlags = !getenv("FEXWASM_NOCROSSFLAGS");
  fexwasm::FexHost FH({.TSO = false, .Multiblock = true, .AVX = true, .X87ReducedPrecision = ReducedX87, .ABILocalFlags = ABIFlags,
                       .CrossUnitFlags = CrossFlags});
  Host = &FH;
  if (!FH.MapGuest(WINDOW + CODE, Code.data(), Code.size())) {
    return Result(4, "ERROR cannot map code");
  }
  Cfg.CtxAddr = CTX;
  Cfg.NZCVAddr = CTX + offsetof(CPUState, flags) + FEXCore::X86State::RFLAG_NZCV_LOC;
  Cfg.FlagSpillAddr = Sys + 0x40;
  Cfg.DepthAddr = Sys + 0x60;
  Cfg.FaultAddr = Sys + 0x68;
  Cfg.BreakRIP = BREAK_RIP;
  Cfg.RoundModeAddr = Sys + 0x70;
  Cfg.CRCTableAddr = Sys + 0x8000;
  Cfg.CPUIDAddr = Sys + 0x9000;
  const std::vector<uint8_t> CPUID = FH.CPUIDTable(&Cfg.CPUIDCount);
  Cfg.XCR0 = FH.XCR0();
  Cfg.DispatchBase = Sys + 0x10'0000;
  Cfg.CallSiteBase = Sys + 0x20'0000;
  Cfg.MemPages = MEM_PAGES;
  Cfg.NamedConstants = FH.NamedConstants();
  if (!getenv("FEXWASM_NOINLINE")) {
    Cfg.FetchIR = [&FH](uint64_t RIP) { return FH.GenerateIR(RIP); };
  }
  Cfg.IndexedConstantPointers = FH.IndexedConstantPointers();

  JSGlobalContextRef J = JSGlobalContextCreate(nullptr);
  SetFn(J, "__translate", JSTranslate);
  SetFn(J, "__translateRegion", JSTranslateRegion);
  Cfg.HotAddr = Sys + 0x78;
  Cfg.StopAddr = Sys + 0x58;
  Cfg.CallerAddr = Sys + 0x74;
  Cfg.ZeroAddr = Sys + 0x7C;
  Cfg.DepthAddr = Sys + 0x60;
  Cfg.ReturnAddrs = &ReturnAddrs;
  Cfg.ExitReturnAddrs = &ExitReturnAddrs;
  Cfg.CallTargetSet = &CallTargetSet;
  Cfg.SlotTagBase = Sys + 0x1'0000; // u32 RIP per table slot (the call inline cache)
  Cfg.SlotTagCount = 0x8000;
  Cfg.UnitCounterBase = Sys + 0x3'0000; // u32 entry counts of units
  Cfg.UnitCounterBits = 12;
  if (const char* T = getenv("FEXWASM_HOT")) {
    Cfg.HotThreshold = uint32_t(atoi(T));
  }
  if (const char* R = getenv("FEXWASM_REGARGS")) {
    Cfg.RegArgs = uint32_t(atoi(R));
  }
  if (const char* F = getenv("FEXWASM_ABIFLAGS")) {
    Cfg.ABILocalFlags = atoi(F) != 0;
  }
  { // guest calling convention for register liveness (FEXWASM_ABI=none|sysv|win64)
    const char* A = getenv("FEXWASM_ABI");
    const std::string Abi = A ? A : "none";
    Cfg.ABI = Abi == "sysv" ? fexwasm::BackendConfig::GuestABI::SysV
              : Abi == "win64" ? fexwasm::BackendConfig::GuestABI::Win64 : fexwasm::BackendConfig::GuestABI::None;
  }
  if (getenv("FEXWASM_JS_DISPATCH")) { // JS can't thread register arguments
    Cfg.RegArgs = 0;
  }
  SetFn(J, "__now", JSNow);
  SetFn(J, "__dispatcher", JSDispatcher);
  DispatcherBytes = fexwasm::BuildDispatcher(Cfg, CPUID);
  const char* Here = getenv("FEXWASM_DIR");
  Eval(J, ReadFile((std::string(Here ? Here : ".") + "/js/runtime.js").c_str()));
  if (!Eval(J, "var mem = new WebAssembly.Memory({ initial: " + std::to_string(MEM_PAGES) + " });"
               "var rt = FexRuntime.createRuntime({ mem, translate: __translate, translateRegion: __translateRegion, now: __now, "
               "hotAddr: " + std::to_string(Cfg.HotAddr) + ", hotThreshold: " + std::to_string(Cfg.HotThreshold) + ", slotTagBase: " +
                 std::to_string(Cfg.SlotTagBase) + ", slotTagCount: " + std::to_string(Cfg.SlotTagCount) + ", dispatchBase: " +
                 std::to_string(Cfg.DispatchBase) + ", dispatchBits: " + std::to_string(Cfg.DispatchBits) +
                 (getenv("FEXWASM_JS_DISPATCH") ? " });" : ", dispatcher: __dispatcher() });"))) {
    return Result(4, "ERROR " + LastError);
  }
  JSValueRef View = Eval(J, "new Uint8Array(mem.buffer)");
  uint8_t* Mem = static_cast<uint8_t*>(JSObjectGetTypedArrayBytesPtr(J, JSValueToObject(J, View, nullptr), nullptr));
  if (Cfg.HotThreshold && Cfg.FetchIR) {
    Cfg.TableSlot = [Mem](uint64_t RIP) -> uint32_t {
      const uint32_t Mask = (1u << Cfg.DispatchBits) - 1;
      for (uint32_t H = (uint32_t(RIP) * 0x9E3779B1u) >> (32 - Cfg.DispatchBits);; H = (H + 1) & Mask) {
        const uint32_t* E = reinterpret_cast<const uint32_t*>(Mem + Cfg.DispatchBase + 64 * H);
        if (E[0] == 0) {
          return 0;
        }
        if (E[0] == uint32_t(RIP)) {
          return E[1];
        }
      }
    };
    if (CrossFlags) {
      Cfg.FlagsDeadAt = [&FH](uint64_t RIP) { return FH.FlagsDeadAtEntry(RIP); };
    }
    Cfg.Successors = [Mem](uint64_t RIP) {
      std::vector<uint64_t> T;
      const uint32_t Mask = (1u << Cfg.DispatchBits) - 1;
      for (uint32_t H = (uint32_t(RIP) * 0x9E3779B1u) >> (32 - Cfg.DispatchBits);; H = (H + 1) & Mask) {
        const uint32_t* E = reinterpret_cast<const uint32_t*>(Mem + Cfg.DispatchBase + 64 * H);
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
    Cfg.CallTargets = [Mem](uint64_t RetAddr) {
      std::vector<uint64_t> T;
      const uint32_t Mask = (1u << Cfg.CallSiteBits) - 1;
      for (uint32_t H = (uint32_t(RetAddr) * 0x9E3779B1u) >> (32 - Cfg.CallSiteBits);; H = (H + 1) & Mask) {
        const uint32_t* E = reinterpret_cast<const uint32_t*>(Mem + Cfg.CallSiteBase + 32 * H);
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

  memcpy(Mem + CODE, Code.data(), Code.size());
  for (uint32_t i = 0, Off = C.MemOff; i < C.MemCount; i++) {
    const uint64_t Addr = At<uint64_t>(Raw, Off);
    const uint32_t Len = At<uint32_t>(Raw, Off + 8);
    memcpy(Mem + uint32_t(Addr), Raw.data() + Off + 12, Len);
    Off += 12 + Len;
  }

  auto* S = reinterpret_cast<CPUState*>(Mem + CTX);
  const CPUState Default {};
  memcpy(S, &Default, sizeof(CPUState));
  // FEX's harness starts with every GPR zero (the XMM registers hold
  // CPUState's garbage pattern).
  memset(S->gregs, 0, sizeof(S->gregs));
  S->rip = WINDOW + CODE;

  Eval(J, "rt.run(" + std::to_string(CODE) + ", " + std::to_string(BREAK_RIP) + ")");
  if (!LastError.empty()) {
    if (LastError.rfind("backend: ", 0) == 0) {
      return Result(3, "UNSUP " + LastError.substr(9));
    }
    return Result(4, "ERROR " + LastError);
  }
  const uint64_t Fault = *reinterpret_cast<uint64_t*>(Mem + Cfg.FaultAddr);
  const uint32_t Rip32 = uint32_t(S->rip);
  // hlt is Break{SIGSEGV, GP, si_code 0x80} with RIP left on the hlt.
  if ((Fault & 0xff) != 11 || Rip32 < CODE || Rip32 >= CODE + Code.size() || uint8_t(Code[Rip32 - CODE]) != 0xF4) {
    char B[128];
    snprintf(B, sizeof(B), "FAIL fault=%#llx rip=%#x (not a hlt)", (unsigned long long)Fault, Rip32);
    return Result(1, B);
  }

  // RegData: index = bit number (0 RIP, 1-16 GPRs, 17-32 XMM, 33 gs, 34 fs, 35-42 MM).
  std::string Bad;
  bool Windowed = false;
  for (uint32_t i = 0, Off = C.RegOff; i < C.RegCount; i++) {
    const uint32_t Count = At<uint32_t>(Raw, Off);
    const uint64_t Key = At<uint64_t>(Raw, Off + 4);
    const uint32_t Idx = __builtin_ctzll(Key);
    size_t StateOff;
    std::string Name;
    if (Idx == 0) {
      StateOff = offsetof(CPUState, rip), Name = "RIP";
    } else if (Idx < 17) {
      using namespace FEXCore::X86State;
      static constexpr uint32_t Order[16] = {REG_RAX, REG_RBX, REG_RCX, REG_RDX, REG_RSI, REG_RDI, REG_RBP, REG_RSP,
                                             REG_R8,  REG_R9,  REG_R10, REG_R11, REG_R12, REG_R13, REG_R14, REG_R15};
      static constexpr const char* Names[16] = {"RAX", "RBX", "RCX", "RDX", "RSI", "RDI", "RBP", "RSP",
                                                "R8",  "R9",  "R10", "R11", "R12", "R13", "R14", "R15"};
      StateOff = offsetof(CPUState, gregs) + 8 * Order[Idx - 1], Name = Names[Idx - 1];
    } else if (Idx < 33) {
      StateOff = offsetof(CPUState, xmm) + 16 * (Idx - 17), Name = "XMM" + std::to_string(Idx - 17);
    } else if (Idx == 33) {
      StateOff = offsetof(CPUState, gs_cached), Name = "GS";
    } else if (Idx == 34) {
      StateOff = offsetof(CPUState, fs_cached), Name = "FS";
    } else {
      StateOff = offsetof(CPUState, mm) + 16 * (Idx - 35), Name = "MM" + std::to_string(Idx - 35);
    }
    for (uint32_t j = 0; j < Count; j++) {
      const uint64_t Want = At<uint64_t>(Raw, Off + 12 + 8 * j);
      uint64_t Got;
      if (Idx >= 17 && Idx < 33 && j >= 2) { // YMM upper half
        Got = S->avx_high[Idx - 17][j - 2];
      } else {
        memcpy(&Got, reinterpret_cast<uint8_t*>(S) + StateOff + 8 * j, 8);
      }
      if (Got == Want) {
        continue;
      }
      if (Got - WINDOW == Want) {
        Windowed = true;
        continue;
      }
      char B[96];
      snprintf(B, sizeof(B), " %s[%u]=%#llx(want %#llx)", Name.c_str(), j, (unsigned long long)Got, (unsigned long long)Want);
      Bad += B;
    }
    Off += 12 + 8 * Count;
  }
  if (!Bad.empty()) {
    return Result(1, "FAIL" + Bad);
  }
  return Result(0, Windowed ? "PASS (window-relative)" : "PASS");
}
