#include "fexhost.h"

#include <FEXCore/Config/Config.h>
#include <FEXCore/Core/Context.h>
#include <FEXCore/Core/CoreState.h>
#include <FEXCore/Core/HostFeatures.h>
#include <FEXCore/Core/SignalDelegator.h>
#include <FEXCore/Debug/InternalThreadState.h>
#include <FEXCore/HLE/SyscallHandler.h>
#include <FEXCore/Utils/Allocator.h>
#include <FEXCore/Utils/AllocatorHooks.h>
#include <FEXCore/Utils/LogManager.h>

#include "Interface/Context/Context.h"
#include "Interface/Core/CPUBackend.h"
#include "Interface/Core/Frontend.h"
#include "Interface/Core/LookupCache.h"
#include "Interface/Core/OpcodeDispatcher.h"
#include "Interface/Core/JIT/Relocations.h"
#include "Interface/IR/IR.h"
#include "Interface/IR/PassManager.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif
#include <map>
#include <memory>
#include <optional>
#include <vector>
#include <pthread.h>
#include <sys/mman.h>
#include <xxhash.h>

// rpmalloc diagnostic that Core.cpp references; rpmalloc is not linked in this build.
extern "C" {
struct rpm_cas_snapshot;
int rpm_cas_snapshot_take(struct rpm_cas_snapshot*) {
  return 0;
}
}

namespace FEXCore::Frontend {
extern const uint8_t* (*GuestCodeSource)(uint64_t RIP); // Frontend.cpp (fexwasm addition)
}

namespace FEXCore::IR {
extern bool ABILocalFlags; // RedundantFlagCalculationElimination.cpp (fexwasm additions)
extern std::function<void(uint64_t, uint32_t)> NoteEntryFlags;
extern std::function<bool(uint64_t)> FlagsDeadAtEntry;
}

namespace fexwasm {
namespace {
// FEX's decoder hook and the flag hooks are globals: they go to the host
// that is generating IR (hosts are used from one thread).
FexHost* Current = nullptr;

class NullSignalDelegator final : public FEXCore::SignalDelegator {};

class NullSyscallHandler final : public FEXCore::HLE::SyscallHandler {
public:
  NullSyscallHandler() {
    OSABI = FEXCore::HLE::SyscallOSABI::OS_LINUX64; // syscall number and arguments come from RAX, RDI, RSI, RDX, R10, R8, R9
  }
  uint64_t HandleSyscall(FEXCore::Core::CpuStateFrame*, FEXCore::HLE::SyscallArguments*) override {
    return 0;
  }
  FEXCore::HLE::ExecutableRangeInfo QueryGuestExecutableRange(FEXCore::Core::InternalThreadState*, uint64_t Address) override {
    // The frontend reads host-owned buffers, not native memory at guest
    // addresses. Unknown bytes must stop decoding through its NOEXEC path.
    const auto* Mapping = Current ? Current->MappingAt(Address) : nullptr;
    return Mapping ? FEXCore::HLE::ExecutableRangeInfo {Mapping->Base, Mapping->Size, false}
                   : FEXCore::HLE::ExecutableRangeInfo {0, 0, false};
  }
  std::optional<FEXCore::ExecutableFileSectionInfo> LookupExecutableFileSection(FEXCore::Core::InternalThreadState*, uint64_t) override {
    return std::nullopt;
  }
};

#if TARGET_OS_IPHONE
#include <libkern/OSCacheControl.h>
// FEX's code-cache paths reference it (the compiler runtime provides it on
// macOS); nothing executes FEX's own JIT here.
extern "C" void __clear_cache(void* Start, void* End) {
  sys_icache_invalidate(Start, size_t(static_cast<char*>(End) - static_cast<char*>(Start)));
}
#endif

#if defined(__APPLE__) && !TARGET_OS_IPHONE
// macOS only grants writable+executable memory with MAP_JIT. (Nothing here
// runs FEX's JIT; this keeps any executable allocation FEX makes working in
// the Mac tools. On iOS nothing executable is allocated.)
void* JitAwareMmap(void* Addr, size_t Size, int Prot, int Flags, int FD, off_t Off) {
  if (Prot & PROT_EXEC) {
    Flags |= MAP_JIT;
  }
  return ::mmap(Addr, Size, Prot, Flags, FD, Off);
}
#endif

// Never compiles anything: constructing a CPUBackend is how FEX installs its
// named / indexed vector constant tables into the thread's frame.
class ConstantsOnlyBackend final : public FEXCore::CPU::CPUBackend {
public:
  using CPUBackend::CPUBackend;
  CompiledCode CompileCode(uint64_t, uint64_t, bool, const FEXCore::IR::IRListView*, FEXCore::Core::DebugData*, bool) override {
    return {};
  }
  fextl::vector<FEXCore::CPU::Relocation> TakeRelocations(uint64_t) override {
    return {};
  }
};

void MsgHandler(LogMan::DebugLevels Level, const char* Message) {
  if (Level <= LogMan::ERROR && !strstr(Message, "ml606") && !strstr(Message, "ml599")) {
    fprintf(stderr, "[fex:%s] %s\n", LogMan::DebugLevelStr(Level), Message);
  }
}
void AssertHandler(const char* Message) {
  fprintf(stderr, "[fex:ASSERT] %s\n", Message);
  abort();
}
} // namespace

// A unit's IR copied out of FEX's per-thread buffer (IR nodes are offsets from
// the two buffer bases, so a byte copy is a valid IR list).
struct OwnedIR {
  std::vector<uint8_t> Data, List;
  std::optional<FEXCore::IR::IRListView> View;
  uint64_t GuestInstructions = 0;
  uint32_t InstructionLength = 0;
  std::vector<FexHost::CodeDep> Deps; // the code it was decoded from
  std::vector<std::pair<uint64_t, uint64_t>> Blocks; // (FEXWASM_COVERAGE: its guest blocks, entry and size)
};

// FEXWASM_COVERAGE=1 (debugging): the guest blocks of every IR a translation
// uses (a unit's own, and each callee it inlines), to see how much guest code
// is translated more than once (fexwasm_coverage).
namespace {
const bool Coverage = getenv("FEXWASM_COVERAGE") != nullptr;
std::vector<std::pair<uint64_t, uint64_t>> CoverageBlocks;
} // namespace
extern "C" const char* fexwasm_coverage() {
  static std::string Out;
  auto B = CoverageBlocks;
  uint64_t Total = 0, Distinct = 0, End = 0;
  std::sort(B.begin(), B.end());
  for (const auto& [E, S] : B) {
    Total += S;
    const uint64_t Lo = std::max(E, End), Hi = E + S;
    if (Hi > Lo) {
      Distinct += Hi - Lo;
      End = Hi;
    }
  }
  char T[160];
  snprintf(T, sizeof(T), "{\"irs\":%zu,\"guestBytes\":%llu,\"distinctGuestBytes\":%llu}", B.size(), (unsigned long long)Total,
           (unsigned long long)Distinct);
  Out = T;
  return Out.c_str();
}

struct FexHost::Impl {
  bool DebugGuestInstructions = false;
  uint64_t MaxInstructions = 0;
  bool CrossUnitFlags = false;
  std::map<uint64_t, std::unique_ptr<OwnedIR>> Cache;
  NullSignalDelegator Signals;
  NullSyscallHandler Syscalls;
  fextl::unique_ptr<FEXCore::Context::Context> CTX;
  FEXCore::Core::InternalThreadState* Thread {};
  FEXCore::Core::CPUState::gdt_segment GDT[32] {};
  std::optional<FEXCore::IR::IRListView> View;
};

FexHost::FexHost(const Options& Opts)
  : P(std::make_unique<Impl>()) {
  P->DebugGuestInstructions = Opts.DebugGuestInstructions;
  P->MaxInstructions = Opts.MaxInstructions;
  P->CrossUnitFlags = Opts.CrossUnitFlags;
#if defined(__APPLE__) && !TARGET_OS_IPHONE
  FEXCore::Allocator::mmap = JitAwareMmap;
  pthread_jit_write_protect_np(0);
#endif
  LogMan::Throw::InstallHandler(AssertHandler);
  LogMan::Msg::InstallHandler(MsgHandler);
  FEXCore::Config::Initialize();
  FEXCore::Config::Load();
  FEXCore::Config::Set(FEXCore::Config::CONFIG_IS64BIT_MODE, "1");
  FEXCore::Config::Set(FEXCore::Config::CONFIG_DISABLETELEMETRY, "1");
  FEXCore::Config::Set(FEXCore::Config::CONFIG_MULTIBLOCK, Opts.Multiblock ? "1" : "0");
  FEXCore::Config::Set(FEXCore::Config::CONFIG_TSOENABLED, Opts.TSO ? "1" : "0");
  FEXCore::Config::Set(FEXCore::Config::CONFIG_X87REDUCEDPRECISION, Opts.X87ReducedPrecision ? "1" : "0");
  FEXCore::IR::ABILocalFlags = Opts.ABILocalFlags;
  // The hooks are process-global; eligibility belongs to the current host,
  // including when differently configured translators are interleaved.
  FEXCore::IR::NoteEntryFlags = [](uint64_t RIP, uint32_t Flags) {
    if (Current && Current->P->CrossUnitFlags) Current->EntryFlags[RIP] = Flags;
  };
  FEXCore::IR::FlagsDeadAtEntry = [](uint64_t RIP) {
    return Current && Current->P->CrossUnitFlags && Current->FlagsDeadAtEntry(RIP);
  };

  // Host features chosen for the wasm target: no SVE/AVX/flag-manipulation
  // extensions, so the IR stays as plain as FEX allows.
  FEXCore::HostFeatures HF {};
  HF.DCacheLineSize = 64;
  HF.ICacheLineSize = 64;
  HF.SupportsAtomics = true;
  HF.SupportsRCPC = true;
  HF.SupportsAVX = Opts.AVX;
  HF.SupportsCRC = true; // CRC32C through a table (and so SSE4.2 in CPUID)
  // CPUID's per-core data (brand string, hybrid flags) comes from MIDRs.
  for (int i = 0; i < 16; i++) {
    HF.CPUMIDRs.push_back(0x610F'0230); // Apple Firestorm
  }

  P->CTX = FEXCore::Context::Context::CreateNewContext(HF);
  P->CTX->SetSignalDelegator(&P->Signals);
  P->CTX->SetSyscallHandler(&P->Syscalls);
  auto* CI = static_cast<FEXCore::Context::ContextImpl*>(P->CTX.get());

  // A thread with FEX's frontend, opcode dispatcher and IR passes, but none of
  // the arm64 dispatcher / JIT core that InitCore / InitializeCompiler set up.
  // No register-allocation pass: wasm locals replace host registers.
  void* Mem = FEXCore::Allocator::aligned_alloc(alignof(FEXCore::Core::InternalThreadState), sizeof(FEXCore::Core::InternalThreadState));
  auto* T = ::new (Mem) FEXCore::Core::InternalThreadState {.CTX = CI};
  T->CurrentFrame->Thread = T;
  T->OpDispatcher = fextl::make_unique<FEXCore::IR::OpDispatchBuilder>(CI, T);
  T->OpDispatcher->SetMultiblock(Opts.Multiblock);
  T->LookupCache = fextl::make_unique<FEXCore::LookupCache>(CI);
  T->FrontendDecoder = fextl::make_unique<FEXCore::Frontend::Decoder>(T);
  T->PassManager = fextl::make_unique<FEXCore::IR::PassManager>();
  T->PassManager->AddDefaultPasses(CI);
  T->PassManager->AddDefaultValidationPasses();
  T->PassManager->RegisterSyscallHandler(&P->Syscalls);
  T->PassManager->Finalize();
  T->CPUBackend = fextl::make_unique<ConstantsOnlyBackend>(*CI, T);
  P->Thread = T;

  // 64-bit code segment, as CodeSizeValidation sets up.
  auto Frame = T->CurrentFrame;
  Frame->State.segment_arrays[FEXCore::Core::CPUState::SEGMENT_ARRAY_INDEX_GDT] = &P->GDT[0];
  Frame->State.segment_arrays[FEXCore::Core::CPUState::SEGMENT_ARRAY_INDEX_LDT] = &P->GDT[0];
  Frame->State.cs_idx = FEXCore::Core::CPUState::DEFAULT_USER_CS << 3;
  auto Seg = FEXCore::Core::CPUState::GetSegmentFromIndex(Frame->State, Frame->State.cs_idx);
  FEXCore::Core::CPUState::SetGDTBase(Seg, 0);
  FEXCore::Core::CPUState::SetGDTLimit(Seg, 0xF'FFFFU);
  Seg->L = 1;
  Seg->D = 0;
  Frame->State.cs_cached = FEXCore::Core::CPUState::CalculateGDTBase(*Seg);
}

FexHost::~FexHost() {
  if (Current == this) {
    Current = nullptr;
  }
}

namespace {
const uint8_t* CurrentGuestCode(uint64_t RIP) {
  return Current ? Current->GuestCode(RIP) : nullptr;
}
} // namespace

const uint8_t* FexHost::GuestCode(uint64_t RIP) {
  auto It = Code.upper_bound(RIP);
  if (It == Code.begin()) {
    return nullptr;
  }
  --It;
  const uint64_t Off = RIP - It->first;
  if (Off >= It->second.size() - 64) {
    return nullptr;
  }
  if (Recording) {
    Note(Deps.at(It->first));
  }
  return It->second.data() + Off;
}

void FexHost::Note(const CodeDep& D) {
  for (const auto& X : *Recording) {
    if (X == D) {
      return;
    }
  }
  Recording->push_back(D);
}

const FexHost::CodeDep* FexHost::MappingAt(uint64_t RIP) const {
  auto It = Deps.upper_bound(RIP);
  if (It == Deps.begin()) {
    return nullptr;
  }
  --It;
  return RIP - It->first < It->second.Size ? &It->second : nullptr;
}

bool FexHost::DepsMatch(const std::vector<CodeDep>& Want, int64_t Delta) const {
  for (const auto& D : Want) {
    auto It = Deps.find(D.Base + uint64_t(Delta));
    if (It == Deps.end() || It->second.Size != D.Size || It->second.Hash != D.Hash) {
      return false;
    }
  }
  return true;
}

void FexHost::UnmapGuest(uint64_t Address, uint64_t Size) {
  const uint64_t End = Address + Size;
  // Trim or split the buffers that overlap [Address, End).
  std::vector<std::pair<uint64_t, std::vector<uint8_t>>> Keep;
  std::map<uint64_t, uint8_t> KeepAbi; // (a piece keeps its mapping's ABI)
  for (auto It = Code.begin(); It != Code.end();) {
    const uint64_t B = It->first, E = B + (It->second.size() - 64);
    if (E <= Address || B >= End) {
      ++It;
      continue;
    }
    if (B < Address) {
      std::vector<uint8_t> V(It->second.begin(), It->second.begin() + (Address - B));
      V.resize(V.size() + 64, 0);
      Keep.emplace_back(B, std::move(V));
    }
    if (E > End) {
      std::vector<uint8_t> V(It->second.begin() + (End - B), It->second.begin() + (E - B));
      V.resize(V.size() + 64, 0);
      Keep.emplace_back(End, std::move(V));
    }
    for (const auto& [KB, KV] : Keep) KeepAbi.emplace(KB, Deps[It->first].Abi);
    Deps.erase(It->first);
    It = Code.erase(It);
  }
  for (auto& [B, V] : Keep) {
    const uint64_t Size = V.size() - 64;
    Deps[B] = CodeDep {B, Size, XXH3_64bits(V.data(), Size), KeepAbi[B]};
    Code.emplace(B, std::move(V));
  }
  // IR decoded from there (a unit starting a little before can reach in too).
  const uint64_t From = Address > 4096 ? Address - 4096 : 0;
  for (auto It = P->Cache.lower_bound(From); It != P->Cache.end() && It->first < End;) {
    EntryFlags.erase(It->first);
    It = P->Cache.erase(It);
  }
}

void FexHost::PatchGuest(uint64_t Address, const void* Data, size_t Size) {
  const uint64_t End = Address + Size;
  for (auto& [B, V] : Code) {
    const uint64_t E = B + (V.size() - 64);
    if (E <= Address || B >= End) continue;
    const uint64_t From = std::max(B, Address), To = std::min(E, End);
    memcpy(V.data() + (From - B), static_cast<const uint8_t*>(Data) + (From - Address), To - From);
    Deps[B] = CodeDep {B, E - B, XXH3_64bits(V.data(), E - B), Deps[B].Abi};
  }
  const uint64_t From = Address > 4096 ? Address - 4096 : 0;
  for (auto It = P->Cache.lower_bound(From); It != P->Cache.end() && It->first < End;) {
    EntryFlags.erase(It->first);
    It = P->Cache.erase(It);
  }
}

void FexHost::SetLocalFlags(bool On) {
  FEXCore::IR::ABILocalFlags = On;
}

bool FexHost::MapGuest(uint64_t Address, const void* Data, size_t Size, uint8_t Abi) {
  UnmapGuest(Address, Size);
  std::vector<uint8_t> V(Size + 64, 0);
  memcpy(V.data(), Data, Size);
  Deps[Address] = CodeDep {Address, Size, XXH3_64bits(Data, Size), Abi};
  Code.emplace(Address, std::move(V));
  FEXCore::Frontend::GuestCodeSource = CurrentGuestCode;
  return true;
}

const FEXCore::IR::IRListView* FexHost::GenerateIR(uint64_t RIP, uint64_t* GuestInstructions) {
  auto It = P->Cache.find(RIP);
  if (It == P->Cache.end()) {
    if (!GuestCode(RIP)) {
      return nullptr; // (not cached: the code may be mapped later)
    }
    Current = this;
    auto* CI = static_cast<FEXCore::Context::ContextImpl*>(P->CTX.get());
    // this IR's own dependencies (FEX may be inside a translation that records too)
    std::vector<CodeDep> Mine, *Outer = Recording;
    Recording = &Mine;
    // Mapping changes can invalidate the frontend's last executable range.
    P->Thread->FrontendDecoder->ResetExecutableRangeCache();
    auto R = CI->GenerateIR(P->Thread, RIP, P->DebugGuestInstructions, P->MaxInstructions);
    Recording = Outer;
    std::unique_ptr<OwnedIR> O;
    if (R.IRView && (!P->MaxInstructions || (R.TotalInstructions && R.TotalInstructions <= P->MaxInstructions))) {
      O = std::make_unique<OwnedIR>();
      auto* D = reinterpret_cast<const uint8_t*>(R.IRView->GetData());
      auto* L = reinterpret_cast<const uint8_t*>(R.IRView->GetListData());
      O->Data.assign(D, D + R.IRView->GetDataSize());
      O->List.assign(L, L + R.IRView->GetListSize());
      O->View.emplace(O->Data.data(), O->List.data(), O->Data.size(), O->List.size());
      O->GuestInstructions = R.TotalInstructions;
      const auto* Decoded = P->Thread->FrontendDecoder->GetDecodedBlockInfo();
      if (P->MaxInstructions == 1 && R.TotalInstructions == 1 && Decoded->Blocks.size() == 1) {
        const auto& Block = Decoded->Blocks.front();
        if (Block.Entry == RIP && Block.NumInstructions == 1 && Block.DecodedInstructions[0].PC == RIP)
          O->InstructionLength = Block.DecodedInstructions[0].InstSize;
      }
      O->Deps = std::move(Mine);
      if (Coverage) {
        for (const auto& Bk : P->Thread->FrontendDecoder->GetDecodedBlockInfo()->Blocks) {
          O->Blocks.emplace_back(Bk.Entry, Bk.Size);
        }
      }
    }
    // (FEX may have failed before claiming its IR buffer, and disowning an
    // unowned one asserts: claiming an owned one again is a no-op)
    P->Thread->OpDispatcher->ReownOrClaimBuffer();
    P->Thread->OpDispatcher->DelayedDisownBuffer();
    It = P->Cache.emplace(RIP, std::move(O)).first;
  }
  if (!It->second) {
    return nullptr;
  }
  if (Recording) {
    for (const auto& D : It->second->Deps) {
      Note(D);
    }
  }
  if (GuestInstructions) {
    *GuestInstructions = It->second->GuestInstructions;
  }
  if (Coverage && GuestInstructions) { // (a unit's own IR: callees fetched to inline, or to look at, don't count)
    CoverageBlocks.insert(CoverageBlocks.end(), It->second->Blocks.begin(), It->second->Blocks.end());
    static FILE* F = getenv("FEXWASM_COVERAGE_FILE") ? fopen(getenv("FEXWASM_COVERAGE_FILE"), "w") : nullptr;
    if (F) { // (one line a unit: its entry, then its blocks as entry:size)
      fprintf(F, "%llx", (unsigned long long)RIP);
      for (const auto& [E, S] : It->second->Blocks) fprintf(F, " %llx:%llx", (unsigned long long)E, (unsigned long long)S);
      fprintf(F, "\n");
      fflush(F);
    }
  }
  return &*It->second->View;
}

const uint8_t* FexHost::NamedConstants() const {
  return reinterpret_cast<const uint8_t*>(&P->Thread->CurrentFrame->Pointers.NamedVectorConstants[0][0]);
}

uint32_t FexHost::InstructionLength(uint64_t RIP) const {
  auto It = P->Cache.find(RIP);
  return It != P->Cache.end() && It->second ? It->second->InstructionLength : 0;
}
const uint64_t* FexHost::IndexedConstantPointers() const {
  return P->Thread->CurrentFrame->Pointers.IndexedNamedVectorConstantPointers;
}

std::vector<uint8_t> FexHost::CPUIDTable(uint32_t* Count) const {
  auto* CI = static_cast<FEXCore::Context::ContextImpl*>(P->CTX.get());
  std::vector<uint8_t> T;
  auto Add = [&](uint32_t Fn, uint32_t Leaf, bool AnyLeaf) {
    // This is one fixed virtual CPU table. Brand leaves must use its CPU 0,
    // rather than indexing the 16 virtual entries by the host scheduler's ID.
    FEXCore::CPUID::FunctionResults R {};
    if (Fn >= 0x8000'0002u && Fn <= 0x8000'0004u) {
#if defined(ARCHITECTURE_x86_64)
      // The vendor x86 frontend debug configuration has no per-CPU names.
      static constexpr char Brand[48] = "BetterJIT FEX frontend debug (x86 host)";
      memcpy(&R, Brand + (Fn - 0x8000'0002u) * 16, sizeof(R));
#else
      R = CI->CPUID.RunFunctionName(Fn, Leaf, 0);
#endif
    } else {
      R = CI->CPUID.RunFunction(Fn, Leaf);
    }
    const uint32_t E[6] = {Fn, AnyLeaf ? 0xFFFF'FFFFu : Leaf, R.eax, R.ebx, R.ecx, R.edx};
    T.insert(T.end(), reinterpret_cast<const uint8_t*>(E), reinterpret_cast<const uint8_t*>(E) + sizeof(E));
  };
  // Leaves with sub-leaves get explicit entries; the rest match any leaf.
  auto Range = [&](uint32_t First, uint32_t Last) {
    for (uint32_t Fn = First; Fn <= Last; Fn++) {
      if (Fn == 4 || Fn == 7 || Fn == 0xB || Fn == 0xD || Fn == 0xF || Fn == 0x10 || Fn == 0x12 || Fn == 0x14 || Fn == 0x17 ||
          Fn == 0x18 || Fn == 0x1D || Fn == 0x1F || Fn == 0x8000'001D || Fn == 0x8000'0020 || Fn == 0x8000'0026) {
        for (uint32_t Leaf = 0; Leaf < 64; Leaf++) {
          Add(Fn, Leaf, false);
        }
        Add(Fn, 64, true);
      } else {
        Add(Fn, 0, true);
      }
    }
  };
  Range(0, CI->CPUID.RunFunction(0, 0).eax);
  Range(0x4000'0000, 0x4000'0001);
  Range(0x8000'0000, CI->CPUID.RunFunction(0x8000'0000, 0).eax);
  *Count = uint32_t(T.size() / 24);
  return T;
}

uint64_t FexHost::XCR0() const {
  auto* CI = static_cast<FEXCore::Context::ContextImpl*>(P->CTX.get());
  const auto R = CI->CPUID.RunXCRFunction(0);
  return uint64_t(R.eax) | uint64_t(R.edx) << 32;
}

void FexHost::Release() {}

} // namespace fexwasm
