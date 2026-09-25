// Drives FEXCore's frontend + IR passes (no arm64 JIT) for the wasm backend.
#pragma once
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace FEXCore::IR {
class IRListView;
}

namespace fexwasm {

class FexHost {
public:
  struct Options {
    bool TSO = false;
    bool Multiblock = true;
    // AVX through FEX's 128-bit (ASIMD-style) implementation: the IR stays
    // 128-bit, the upper YMM halves live in CPUState::avx_high.
    bool AVX = true;
    // x87 on doubles (FEX's X87ReducedPrecision) instead of 80-bit soft float.
    bool X87ReducedPrecision = false;
    // Flags are dead at call and return exits (the x86-64 ABIs), so FEX's
    // dead flag pass drops what only they would read. Pairs with
    // BackendConfig::ABILocalFlags.
    bool ABILocalFlags = false;
    // A jump to a unit that writes all flags before reading any leaves them
    // dead: FEX's dead flag pass learns each unit's entry flags as it goes.
    bool CrossUnitFlags = false;
  };
  explicit FexHost(const Options& Opts);
  ~FexHost();

  // Maps guest bytes at their guest virtual address so FEX can decode them
  // (replacing whatever was mapped there).
  bool MapGuest(uint64_t Address, const void* Data, size_t Size, uint8_t Abi = 0);
  // Flags dead across calls and returns in FEX's passes (ABILocalFlags), for
  // the IR made from here on.
  void SetLocalFlags(bool On);
  // Removes guest code, and the IR generated from it.
  void UnmapGuest(uint64_t Address, uint64_t Size);
  // New bytes for code already mapped (written in place: a packer's, a JIT's):
  // the buffers keep their bounds, their hashes change (so cached units miss)
  // and IR decoded from there goes.
  void PatchGuest(uint64_t Address, const void* Data, size_t Size);

  // IR for the unit starting at RIP, generated once and cached (the view stays
  // valid for the host's lifetime), or null if FEX can't translate it.
  const FEXCore::IR::IRListView* GenerateIR(uint64_t RIP, uint64_t* GuestInstructions = nullptr);
  // With CrossUnitFlags: the unit at RIP was generated and reads no flag
  // before writing it (BackendConfig::FlagsDeadAt).
  bool FlagsDeadAtEntry(uint64_t RIP) const {
    auto It = EntryFlags.find(RIP);
    return It != EntryFlags.end() && It->second == 0;
  }
  void Release();

  // FEX's CPUID results for every function / leaf it defines, as
  // {u32 function, leaf, eax, ebx, ecx, edx} entries (BackendConfig::CPUIDAddr).
  std::vector<uint8_t> CPUIDTable(uint32_t* Count) const;
  uint64_t XCR0() const;

  // FEX's vector constant pools, as its CPUBackend installs them in the frame.
  const uint8_t* NamedConstants() const;
  const uint64_t* IndexedConstantPointers() const;

  // The guest bytes at RIP (for FEX's decoder), or null.
  const uint8_t* GuestCode(uint64_t RIP);

  // A mapped code range and its content hash: what a translation depends on.
  struct CodeDep {
    uint64_t Base, Size, Hash;
    uint8_t Abi = 0; // (how its code is translated: fexwasm_map_code_abi)
    bool operator==(const CodeDep&) const = default;
  };
  // The code range at RIP, or null.
  const CodeDep* MappingAt(uint64_t RIP) const;
  // Records every code range FEX reads (directly, or through IR it cached)
  // into *Deps until StopRecording.
  void RecordDeps(std::vector<CodeDep>* Deps) { Recording = Deps; }
  void StopRecording() { Recording = nullptr; }
  // Do these ranges hold the same bytes here?
  // Is the code each of Deps read the same now (moved by Delta)?
  bool DepsMatch(const std::vector<CodeDep>& Deps, int64_t Delta = 0) const;

private:
  std::vector<CodeDep>* Recording = nullptr;
  void Note(const CodeDep& D);
  std::map<uint64_t, CodeDep> Deps; // by base, alongside Code
  std::unordered_map<uint64_t, uint32_t> EntryFlags; // RIP -> flags live at the unit's entry (CrossUnitFlags)
  // Guest code FEX decodes, kept in host buffers (the guest isn't mapped at
  // its own addresses in this process), by guest base address. Each buffer
  // has 64 zero bytes of padding: the decoder may look past the last
  // instruction.
  std::map<uint64_t, std::vector<uint8_t>> Code;
  struct Impl;
  std::unique_ptr<Impl> P;
};

} // namespace fexwasm
