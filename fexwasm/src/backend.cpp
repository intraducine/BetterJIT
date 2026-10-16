// FEX IR -> WebAssembly backend.
//
// One translation unit (FEX's multiblock IR for a guest entry RIP) becomes one
// wasm function `run() -> i32` returning the low 32 bits of the next guest RIP.
//
//  * Every IR block is a case of a `loop { br_table }` dispatcher, so arbitrary
//    control flow is correct; direct fallthrough is a later optimisation.
//  * FEX's statically allocated guest registers (16 GPRs, PF, AF) become wasm
//    locals, loaded from CPUState at entry and stored back at each exit.
//  * Flags are lazy: flag-setting ops record (kind, a, b) in locals; conditions
//    in the same block become direct compares, and the arm64-layout NZCV word is
//    materialised (helper function $mat) only where something reads the bits.
//
// Op semantics follow FEX's arm64 backend (FEXCore/Source/Interface/Core/JIT),
// which defines what each IR op means.
#include "backend.h"
#include "broker_step.h"
#include <optional>
#include "coalesce.h"
#include "wasm_emit.h"

#include <FEXCore/Core/CoreState.h>
#include <FEXCore/Core/X86Enums.h>

#include "Interface/IR/IR.h"
#include "Interface/IR/IntrusiveIRList.h"
#include "Interface/IR/RegisterAllocationData.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>
#include <map>
#include <cstdlib>
#include <cstddef>
#include <cstring>
#include <initializer_list>
#include <memory>
#include <unordered_map>
#include <unordered_set>

namespace fexwasm {
using namespace FEXCore::IR;
using FEXCore::Core::CPUState;

namespace {

// A debug environment switch, read once per call site (getenv scans the
// whole environment).
#define ENV_FLAG(Name) ([] { static const bool V = getenv(Name) != nullptr; return V; }())

// Maps and sets over small dense keys (node IDs, register numbers), kept in
// vectors: no hashing, and no allocation per entry (the unordered_ map
// nodes were a good part of the backend's time).
template <typename V>
class DenseMap {
public:
  struct Item {
    uint32_t first = 0;
    V second {};
    bool Used = false;
  };
  using iterator = Item*;
  using const_iterator = const Item*;
  iterator end() { return nullptr; }
  const_iterator end() const { return nullptr; }
  iterator find(uint32_t K) { return K < Items.size() && Items[K].Used ? &Items[K] : nullptr; }
  const_iterator find(uint32_t K) const { return K < Items.size() && Items[K].Used ? &Items[K] : nullptr; }
  size_t count(uint32_t K) const { return find(K) ? 1 : 0; }
  bool empty() const { return Keys.empty(); }
  V& operator[](uint32_t K) { return Slot(K).second; }
  std::pair<iterator, bool> emplace(uint32_t K, V Val) {
    const bool New = !count(K);
    Item& I = Slot(K);
    if (New) {
      I.second = std::move(Val);
    }
    return {&I, New};
  }
  void clear() {
    for (uint32_t K : Keys) {
      Items[K] = Item {};
    }
    Keys.clear();
  }

private:
  Item& Slot(uint32_t K) {
    if (K >= Items.size()) {
      Items.resize(std::max<size_t>(K + 1, Items.size() * 2));
    }
    Item& I = Items[K];
    if (!I.Used) {
      I.Used = true;
      I.first = K;
      Keys.push_back(K);
    }
    return I;
  }
  std::vector<Item> Items;
  std::vector<uint32_t> Keys;
};
class DenseSet {
public:
  size_t count(uint32_t K) const { return M.count(K); }
  bool empty() const { return M.empty(); }
  void insert(uint32_t K) { M[K] = true; }
  void clear() { M.clear(); }

private:
  DenseMap<bool> M;
};

// Lazy flag kinds. The ...K kinds are inc/dec style: N, Z and V from the
// operation, C kept from before (bit 29 of the NZCV local).
enum FlagKind : int32_t {
  FK_MAT = 0,
  FK_SUB32,
  FK_SUB64,
  FK_ADD32,
  FK_ADD64,
  FK_LOGIC32,
  FK_LOGIC64,
  FK_SUB32K,
  FK_SUB64K,
  FK_ADD32K,
  FK_ADD64K,
  // Float compares (ucomiss/comisd): arm64 fcmp flags of operands A and B,
  // kept as their bits (f32 zero-extended), and the same after FEX's axflag.
  FK_FCMP32,
  FK_FCMP64,
  FK_FCMPAX32,
  FK_FCMPAX64,
  FK_LAST = FK_FCMPAX64
};
// Or'ed into a kind: the materialised C is inverted (FEX flips the carry of
// an add at block exits to keep it in its canonical, sub-style form).
constexpr int32_t FK_CINV = 0x10;
constexpr bool KeepsCarry(FlagKind K) {
  return (K & ~FK_CINV) >= FK_SUB32K && (K & ~FK_CINV) <= FK_ADD64K;
}
constexpr bool IsFloatKind(FlagKind K) {
  return (K & ~FK_CINV) >= FK_FCMP32;
}
constexpr bool CarryInverted(FlagKind K) {
  return K & FK_CINV;
}
// The kind without inversion or kept carry (the operation itself).
constexpr FlagKind BaseKind(FlagKind K) {
  const int32_t B = K & ~FK_CINV;
  return B >= FK_SUB32K && B <= FK_ADD64K ? FlagKind(B - FK_SUB32K + FK_SUB32) : FlagKind(B);
}
// Float compare outcomes, as bits of an outcome set.
enum : uint32_t { FO_LT = 1, FO_EQ = 2, FO_GT = 4, FO_UN = 8 };
// The arm64 NZCV a float kind stands for in each outcome: fcmp gives less
// 1000, equal 0110, greater 0010, unordered 0011; axflag makes Z = Z | V,
// C = C & !V, N = V = 0.
constexpr uint32_t FloatNZCV(FlagKind K, uint32_t Outcome) {
  const int32_t B = K & ~FK_CINV;
  const bool AX = B == FK_FCMPAX32 || B == FK_FCMPAX64;
  const uint32_t Raw = Outcome == FO_LT ? 0b1000 : Outcome == FO_EQ ? 0b0110 : Outcome == FO_GT ? 0b0010 : 0b0011;
  const uint32_t N = Raw >> 3 & 1, Z = Raw >> 2 & 1, C = Raw >> 1 & 1, V = Raw & 1;
  const uint32_t Nzcv = AX ? ((Z | V) << 2 | (C & (V ^ 1)) << 1) : Raw;
  return (Nzcv ^ (K & FK_CINV ? 0b0010 : 0)) << 28;
}
// Whether an arm64 condition holds on NZCV (arm64 layout, bits 31..28).
constexpr bool CondHolds(CondClass C, uint32_t Nzcv) {
  const bool N = Nzcv >> 31 & 1, Z = Nzcv >> 30 & 1, Cf = Nzcv >> 29 & 1, V = Nzcv >> 28 & 1;
  switch (C) {
  case CondClass::EQ: return Z;
  case CondClass::NEQ: return !Z;
  case CondClass::UGE: return Cf;
  case CondClass::ULT: return !Cf;
  case CondClass::MI: return N;
  case CondClass::PL: return !N;
  case CondClass::FU:
  case CondClass::VS: return V;
  case CondClass::FNU:
  case CondClass::VC: return !V;
  case CondClass::UGT: return Cf && !Z;
  case CondClass::ULE: return !Cf || Z;
  case CondClass::FGE:
  case CondClass::SGE: return N == V;
  case CondClass::FLU:
  case CondClass::SLT: return N != V;
  case CondClass::FGT:
  case CondClass::SGT: return !Z && N == V;
  case CondClass::FLEU:
  case CondClass::SLE: return Z || N != V;
  default: return true; // AL
  }
}

constexpr uint32_t PF_REG = CPUState::PF_AS_GREG, AF_REG = CPUState::AF_AS_GREG, NUM_STATIC = 18;
// Functions a unit can call. A module contains only the ones it uses: the
// imported ones first (in this order), then local helpers, then run() last.
// Calls are emitted with a padded 5-byte function index and patched once the
// module's function index space is known.
enum FuncRef : uint32_t {
  FUNC_DISPATCH,
  FUNC_CYCLES,
  FUNC_RDRAND,
  FUNC_MAT,
  FUNC_UMULH,
  FUNC_SMULH,
  FUNC_DIV128U,
  FUNC_DIV128S,
  FUNC_PDEP,
  FUNC_PEXT,
  FUNC_CPUID,
  FUNC_F80TOF64,
  FUNC_F64TOF80,
  FUNC_I64TOF80,
  FUNC_SIN,
  FUNC_COS,
  FUNC_TAN,
  FUNC_ATAN2,
  FUNC_F2XM1,
  FUNC_FYL2X,
  FUNC_FYL2XP1,
  FUNC_FSCALE,
  FUNC_FPREM,
  FUNC_FPREM1,
  FUNC_HOT,
  FUNC_SYSCALL,
  FUNC_MEMORY,
  FUNC_RUN,
  FUNC_NUM
};
struct FuncInfo {
  const char* Import; // "e".<name>, or null for a function defined in the unit
  const char* Sig;    // params '>' results; i = i32, I = i64, v = v128
};
constexpr FuncInfo Funcs[FUNC_NUM] = {
  {"dispatch", "ii>i"}, // (rip, stop) -> rip
  {"cycles", ">I"},     // rdtsc
  {"rdrand", ">I"},
  {nullptr, "iIIi>i"},  // $mat(kind, a, b, nzcv) -> nzcv
  {nullptr, "II>I"},    // $umulh
  {nullptr, "II>I"},    // $smulh
  {nullptr, "III>II"},  // $div128u(lo, hi, divisor) -> (quotient, remainder)
  {nullptr, "III>II"},  // $div128s
  {nullptr, "II>I"},    // $pdep(input, mask)
  {nullptr, "II>I"},    // $pext(input, mask)
  {nullptr, "ii>iiii"}, // $cpuid(function, leaf) -> (eax, ebx, ecx, edx)
  {nullptr, "v>d"},     // $f80tof64: x87 80-bit (low 10 bytes) -> double
  {nullptr, "d>v"},     // $f64tof80
  {nullptr, "I>v"},     // $i64tof80 (signed)
  // x87 transcendentals on doubles (FEX's reduced precision), from the host
  {"sin", "d>d"},
  {"cos", "d>d"},
  {"tan", "d>d"},
  {"atan2", "dd>d"},
  {"f2xm1", "d>d"},
  {"fyl2x", "dd>d"},
  {"fyl2xp1", "dd>d"},
  {"fscale", "dd>d"},
  {"fprem", "dd>d"},
  {"fprem1", "dd>d"},
  {"hot", "i>"},        // a unit reached its hot threshold: the runtime may build a region
  {"syscall", "IIIIIII>I"}, // (number, 6 arguments) -> result: the guest's syscall instruction
  {"memory", ">i"},     // broker scratch request -> typed status; never a syscall
  {nullptr, ">i"},      // run
};
using CallSiteList = std::vector<std::pair<size_t, uint32_t>>;
void EmitCall(Buf& F, CallSiteList& Sites, uint32_t Ref) {
  F.u8(op::call);
  Sites.push_back({F.size(), Ref});
  for (int i = 0; i < 4; i++) {
    F.u8(0x80);
  }
  F.u8(0);
}
void PatchCalls(Buf& F, const CallSiteList& Sites, const uint32_t (&Index)[FUNC_NUM]) {
  for (auto [At, Ref] : Sites) {
    uint32_t V = Index[Ref];
    for (int i = 0; i < 5; i++, V >>= 7) {
      F.b[At + i] = uint8_t((V & 0x7f) | (i < 4 ? 0x80 : 0));
    }
  }
}

uint32_t Bits(OpSize S) {
  return uint32_t(S) * 8;
}

// Ops that read or write the guest flags (the lazy state or NZCV). Reading
// can materialise, which rewrites the state, so both count as writes.
bool TouchesFlags(const IROp_Header* IROp) {
  switch (IROp->Op) {
  case OP_SUBNZCV:
  case OP_SUBWITHFLAGS:
  case OP_ADDWITHFLAGS:
  case OP_ANDWITHFLAGS:
  case OP_TESTNZ:
  case OP_CONDSUBNZCV:
  case OP_CONDADDNZCV:
  case OP_NZCVSELECT:
  case OP_NZCVSELECTV:
  case OP_NZCVSELECTINCREMENT:
  case OP_LOADNZCV:
  case OP_STORENZCV:
  case OP_SHIFTFLAGS:
  case OP_ADDNZCV:
  case OP_ADC:
  case OP_SBB:
  case OP_ADCWITHFLAGS:
  case OP_SBBWITHFLAGS:
  case OP_ADCNZCV:
  case OP_SBBNZCV:
  case OP_ROTATEFLAGS:
  case OP_ADCZERO:
  case OP_ADCZEROWITHFLAGS:
  case OP_AXFLAG:
  case OP_CMPPAIRZ:
  case OP_TESTZ:
  case OP_FCMP: return true;
  case OP_CONDJUMP: return IROp->C<IROp_CondJump>()->FromNZCV;
  case OP_NEG: return IROp->C<IROp_Neg>()->Cond != CondClass::AL;
  default: return false;
  }
}

static void EmitNZCVOfKind(Buf& F, FlagKind K, uint32_t Fa, uint32_t Fb, uint32_t R, uint32_t Nz);
static void EmitFloatOutcomeTest(Buf& F, FlagKind K, uint32_t Fa, uint32_t Fb, uint32_t Set);

constexpr uint32_t NUM_XMM = 16;
enum class CtxKind { BlockFollowedBy, LoopHeadedBy, If, InlineReturn, RegionLoop, RegionBlock, RegionLoopHead };

// The CFG of a structured region: its units as nodes, the entry unit first.
struct RegionGraph {
  std::vector<std::vector<uint32_t>> Succ;
  std::vector<uint32_t> Rpo, RpoNum, IDom;
  std::vector<uint8_t> LoopHeader, Merge;
  std::vector<std::vector<uint32_t>> DomChildren;
  // Reverse postorder, dominators, loop headers and merge nodes; false if
  // it's irreducible or a node can't be reached from the entry. Nodes in
  // ForceMerge (indirect jump targets) get a label even with one predecessor.
  bool Analyze(const std::vector<uint8_t>& ForceMerge) {
    const uint32_t N = uint32_t(Succ.size());
    std::vector<uint8_t> Seen(N, 0);
    std::vector<uint32_t> Post;
    std::vector<std::pair<uint32_t, size_t>> Stack {{0, 0}};
    Seen[0] = 1;
    while (!Stack.empty()) {
      auto& [V, I] = Stack.back();
      if (I < Succ[V].size()) {
        const uint32_t W = Succ[V][I++];
        if (!Seen[W]) {
          Seen[W] = 1;
          Stack.push_back({W, 0});
        }
      } else {
        Post.push_back(V);
        Stack.pop_back();
      }
    }
    if (Post.size() != N) {
      return false;
    }
    Rpo.assign(Post.rbegin(), Post.rend());
    RpoNum.assign(N, 0);
    for (uint32_t I = 0; I < N; I++) {
      RpoNum[Rpo[I]] = I;
    }
    std::vector<std::vector<uint32_t>> Preds(N);
    for (uint32_t V = 0; V < N; V++) {
      for (uint32_t W : Succ[V]) {
        Preds[W].push_back(V);
      }
    }
    IDom.assign(N, UINT32_MAX);
    IDom[0] = 0;
    auto Intersect = [&](uint32_t A, uint32_t Bb) {
      while (A != Bb) {
        while (RpoNum[A] > RpoNum[Bb]) {
          A = IDom[A];
        }
        while (RpoNum[Bb] > RpoNum[A]) {
          Bb = IDom[Bb];
        }
      }
      return A;
    };
    for (bool Changed = true; Changed;) {
      Changed = false;
      for (uint32_t V : Rpo) {
        if (V == 0) {
          continue;
        }
        uint32_t New = UINT32_MAX;
        for (uint32_t P : Preds[V]) {
          if (IDom[P] != UINT32_MAX) {
            New = New == UINT32_MAX ? P : Intersect(P, New);
          }
        }
        if (New != IDom[V]) {
          IDom[V] = New;
          Changed = true;
        }
      }
    }
    auto Dominates = [&](uint32_t A, uint32_t V) {
      for (;;) {
        if (V == A) {
          return true;
        }
        if (V == 0) {
          return false;
        }
        V = IDom[V];
      }
    };
    LoopHeader.assign(N, 0);
    Merge.assign(N, 0);
    DomChildren.assign(N, {});
    for (uint32_t V : Rpo) {
      uint32_t Forward = 0;
      for (uint32_t P : Preds[V]) {
        if (RpoNum[P] >= RpoNum[V]) {
          if (!Dominates(V, P)) {
            return false;
          }
          LoopHeader[V] = 1;
        } else {
          Forward++;
        }
      }
      Merge[V] = Forward >= 2 || (ForceMerge[V] && V != 0 && Forward >= 1);
      if (V != 0) {
        DomChildren[IDom[V]].push_back(V);
      }
    }
    return true;
  }
};
struct CtxEntry {
  CtxKind Kind;
  uint32_t Label;
  uint32_t Owner; // the emitter (caller or inlined callee) the label belongs to
};

class Emitter;
// State of the one wasm function being built, shared by the unit's emitter
// and the emitters of callees inlined into it.
struct SharedState {
  Buf B;
  std::vector<ValType> Locals;
  uint32_t NumParams = 0; // run's params (the RegArgs GPRs) come before the locals
  // Guest GPRs (plus PF/AF) and XMM registers as locals.
  uint32_t G[NUM_STATIC] {};
  bool GUsed[NUM_STATIC] {}, GWritten[NUM_STATIC] {};
  uint32_t X[NUM_XMM] {};
  bool XUsed[NUM_XMM] {}, XWritten[NUM_XMM] {};
  uint32_t NZCV = 0, FK = 0, FA = 0, FB = 0, T0 = 0, T1 = 0, T2 = 0, TC = 0;
  std::vector<CtxEntry> Context;
  bool FlagsTouched = false; // does the function read or write guest flags at all
  std::string Err;
  bool FuncUsed[FUNC_NUM] {};
  CallSiteList CallSites;
  uint32_t NextOwner = 0;
  uint64_t FunctionEntry = 0; // the RIP run() starts at
  uint32_t RegionUnit = 0; // local: the region unit to run next
  std::vector<uint32_t> RegionEntries; // per region unit: its RegionUnit value
  // Structured regions: the units' CFG, the emitters, and per unit the
  // region units its indirect jumps were seen going to (sorted by RIP).
  RegionGraph* RG = nullptr;
  std::vector<Emitter*> RUnits;
  std::vector<std::vector<uint32_t>> RIndirect;
  bool IsRegion = false;
  std::vector<uint64_t> RegionUnitRIPs; // and its RIP
  bool UsesTable = false;              // the call inline cache imports the table (e.tbl)
  std::vector<size_t> RunTypeSites;    // call_indirect type immediates to patch
  uint32_t MatScratch = 0; // i64 local for inline flag materialisation
  uint32_t RegionTarget = 0; // i64 local: RIP of an indirect jump inside a region
  // i32 local holding 0, loaded from memory so JSC can't constant-fold it:
  // CPUState / system accesses use it as their base and the absolute address
  // as the offset, which JSC turns into [base + imm] (a constant 0 base costs
  // it a mov + add per access).
  uint32_t SysBase = 0;
  std::vector<std::unique_ptr<Emitter>> Inlined;
  std::vector<uint64_t> InlineStack; // entry RIPs being inlined, to stop recursion
  // Relocatable units (BackendConfig::Relocs; units only): RIPs relative to
  // the code are added to e.d, the code's displacement (read into Delta64
  // and Delta32 on entry), and the call inline caches' slots are globals
  // e.s0, e.s1, ... (targets in ICTargets).
  bool RelocOn = false;
  bool NonRelocatable = false; // a RIP it can't displace (an absolute return address)
  uint32_t Delta64 = 0, Delta32 = 0;
  std::vector<std::pair<uint64_t, bool>> ICTargets;
};

class Emitter {
public:
  Emitter(const IRListView& IR, uint64_t Entry, const BackendConfig& Cfg, SharedState& S)
    : IR(IR)
    , Entry(Entry)
    , Cfg(Cfg)
    , S(S)
    , Owner(S.NextOwner++) {}

  CompileResult Run();
  OrderedNodeWrapper BrokerAddend {}; // proven register source of a non-LOCK memory transaction
  CompileResult RunRegion(std::vector<std::unique_ptr<Emitter>>& Units);
  // A region as structured code over its units' CFG (single entry: the
  // first unit). False, with nothing emitted, if that CFG is irreducible.
  bool RunRegionStructured(std::vector<std::unique_ptr<Emitter>>& Units, CompileResult* Out);
  uint32_t RegionIndex = 0; // this unit's node in S.RG
  void RDoTree(uint32_t X);
  void RNodeWithin(uint32_t X, const std::vector<uint32_t>& Ys, size_t From);
  void RDoBranch(uint32_t From, uint32_t To);
  uint32_t RLabel(uint32_t From, uint32_t To) const { // label depth of an edge's target (a loop head or merge)
    return S.RG->RpoNum[To] <= S.RG->RpoNum[From] ? Depth(CtxKind::RegionLoopHead, To) : Depth(CtxKind::RegionBlock, To);
  }
  // Region membership (see RunRegion).
  const std::vector<uint64_t>* RegionRIPs = nullptr;
  uint32_t RegionOwner = UINT32_MAX;
  uint64_t RegionBase = 0;
  uint32_t RegionSpan = 0;
  bool RegionDense = true;

private:
  void AllocSharedLocals();
  CompileResult Finish();
  const IRListView& IR;
  const uint64_t Entry;
  const BackendConfig& Cfg;
  SharedState& S;
  const uint32_t Owner;

  Buf& B = S.B;
  std::vector<ValType>& Locals = S.Locals;
  uint32_t (&G)[NUM_STATIC] = S.G;
  bool (&GUsed)[NUM_STATIC] = S.GUsed;
  bool (&GWritten)[NUM_STATIC] = S.GWritten;
  uint32_t (&X)[NUM_XMM] = S.X;
  bool (&XUsed)[NUM_XMM] = S.XUsed;
  bool (&XWritten)[NUM_XMM] = S.XWritten;
  uint32_t &NZCV = S.NZCV, &FK = S.FK, &FA = S.FA, &FB = S.FB, &T0 = S.T0, &T1 = S.T1, &T2 = S.T2, &TC = S.TC;
  std::vector<CtxEntry>& Context = S.Context;
  bool& FlagsTouched = S.FlagsTouched;
  std::string& Err = S.Err;
  bool (&FuncUsed)[FUNC_NUM] = S.FuncUsed;
  CallSiteList& CallSites = S.CallSites;

  DenseMap<uint32_t> NodeLocal;
  std::unordered_map<uint32_t, uint32_t> BlockIndex;
  uint32_t NumBlocks = 0, CurBlock = 0;
  DenseMap<uint32_t> NodeVLocal;
  uint32_t Blk = 0;
  // Control-flow graph of the unit's IR blocks, for structured emission
  // (Ramsey, "Beyond Relooper", 2022). Irreducible graphs fall back to a
  // loop { br_table } dispatcher.
  struct BlockInfo {
    Ref Node {};
    std::vector<uint32_t> Succ;
    bool Synthetic = false; // a dispatch block for an irreducible loop: branches to Succ[Label]
    uint32_t Label = UINT32_MAX; // its i32 local
  };
  // Edges (from, to) that go through a dispatch block instead: (block, label value).
  std::map<std::pair<uint32_t, uint32_t>, std::pair<uint32_t, uint32_t>> Redirect;
  uint32_t LabelOf(uint32_t D) {
    if (Blocks[D].Label == UINT32_MAX) {
      Blocks[D].Label = NewLocal(I32);
    }
    return Blocks[D].Label;
  }
  bool AnalyzeCFG();
  bool FixIrreducible(const std::vector<uint32_t>& Nodes, uint32_t Header, int Level);
  std::vector<BlockInfo> Blocks;
  std::vector<uint32_t> Rpo, RpoNum, IDom;
  std::vector<std::vector<uint32_t>> DomChildren;
  std::vector<uint8_t> LoopHeader, Merge;
  // State bits: 0-17 static GPRs (incl. PF/AF), 18-33 XMM, 34 flags.
  static constexpr uint32_t XMM_BIT = 18, FLAGS_BIT = 34;
  std::vector<uint64_t> BlockWrites, MaybeWrittenIn;
  // Register liveness (bits as in the exit masks): per block the registers it
  // reads before writing, writes, and has live on entry.
  std::vector<uint64_t> BlockUse, BlockDef, LiveIn;
  bool LivenessOK = false; // off when context ops touch registers directly
  uint64_t ExitLive = ~0ull; // live registers at the exit being emitted
  bool ContextTouchesRegs = false;
  // Does CPUState [Off, Off + Size) overlap the GPRs, XMMs or PF/AF?
  static bool RegState(uint32_t Off, uint32_t Size) {
    auto Hit = [&](size_t Lo, size_t Bytes) { return Off < Lo + Bytes && Off + Size > Lo; };
    return Hit(offsetof(CPUState, gregs), 8 * 16) || Hit(offsetof(CPUState, xmm), 16 * 16) || Hit(offsetof(CPUState, pf_raw), 8);
  }
  static constexpr uint64_t RegBit(uint32_t R) { return 1ull << R; }
  static constexpr uint64_t XBit(uint32_t R) { return 1ull << (XMM_BIT + R); }
  uint64_t FlagBits() const { return RegBit(PF_REG) | RegBit(AF_REG) | (1ull << FLAGS_BIT); }
  // Live at a guest return: results and callee-saved registers (and the flags
  // unless ABILocalFlags).
  uint64_t ReturnLive() const {
    enum { RAX, RCX, RDX, RBX, RSP, RBP, RSI, RDI, R8, R9, R10, R11, R12, R13, R14, R15 };
    uint64_t M;
    switch (Cfg.ABI) {
    case BackendConfig::GuestABI::SysV:
      M = RegBit(RAX) | RegBit(RDX) | RegBit(RSP) | RegBit(RBX) | RegBit(RBP) | RegBit(R12) | RegBit(R13) | RegBit(R14) | RegBit(R15) | XBit(0) |
          XBit(1);
      break;
    case BackendConfig::GuestABI::Win64:
      M = RegBit(RAX) | RegBit(RSP) | RegBit(RBX) | RegBit(RBP) | RegBit(RDI) | RegBit(RSI) | RegBit(R12) | RegBit(R13) | RegBit(R14) | RegBit(R15);
      for (uint32_t X = 0; X < 4; X++) { // xmm0-3: __vectorcall returns
        M |= XBit(X);
      }
      for (uint32_t X = 6; X < 16; X++) {
        M |= XBit(X);
      }
      break;
    default: return ~0ull;
    }
    return Cfg.ABILocalFlags ? M : M | FlagBits();
  }
  // Live at a guest call: arguments and callee-saved registers.
  uint64_t CallLive() const {
    enum { RAX, RCX, RDX, RBX, RSP, RBP, RSI, RDI, R8, R9, R10, R11, R12, R13, R14, R15 };
    uint64_t M;
    switch (Cfg.ABI) {
    case BackendConfig::GuestABI::SysV:
      M = RegBit(RDI) | RegBit(RSI) | RegBit(RDX) | RegBit(RCX) | RegBit(R8) | RegBit(R9) | RegBit(RAX) /* al: vector args */ | RegBit(RSP) |
          RegBit(RBX) | RegBit(RBP) | RegBit(R12) | RegBit(R13) | RegBit(R14) | RegBit(R15);
      for (uint32_t X = 0; X < 8; X++) {
        M |= XBit(X);
      }
      break;
    case BackendConfig::GuestABI::Win64:
      M = RegBit(RCX) | RegBit(RDX) | RegBit(R8) | RegBit(R9) | RegBit(RSP) | RegBit(RBX) | RegBit(RBP) | RegBit(RDI) | RegBit(RSI) | RegBit(R12) |
          RegBit(R13) | RegBit(R14) | RegBit(R15);
      for (uint32_t X = 0; X < 16; X++) { // xmm0-5: __vectorcall arguments; 6-15 callee-saved
        M |= XBit(X);
      }
      break;
    default: return ~0ull;
    }
    return Cfg.ABILocalFlags ? M : M | FlagBits();
  }
  // Registers a guest call leaves as they were (callee-saved in the ABI):
  // after an ABI call their locals still hold the right values, so they
  // aren't reloaded. (RSP comes back as a result like the other arguments.)
  uint64_t CalleeSaved() const {
    enum { RAX, RCX, RDX, RBX, RSP, RBP, RSI, RDI, R8, R9, R10, R11, R12, R13, R14, R15 };
    switch (Cfg.ABI) {
    case BackendConfig::GuestABI::SysV: return RegBit(RBX) | RegBit(RBP) | RegBit(R12) | RegBit(R13) | RegBit(R14) | RegBit(R15);
    case BackendConfig::GuestABI::Win64: {
      uint64_t M = RegBit(RBX) | RegBit(RBP) | RegBit(RDI) | RegBit(RSI) | RegBit(R12) | RegBit(R13) | RegBit(R14) | RegBit(R15);
      for (uint32_t X = 6; X < 16; X++) {
        M |= XBit(X);
      }
      return M;
    }
    default: return 0;
    }
  }
  bool ComputeLiveness(const std::vector<uint64_t>* EntryLive = nullptr);
  std::vector<std::vector<uint32_t>> PredList;
  bool Structured = false;
  void ComputeMaybeWritten();

  // Inlining. A guest call whose target unit is small enough is emitted in
  // place: the callee's blocks run on the same locals, and its returns to the
  // call's return address branch to the caller's return block.
  std::unordered_map<uint32_t, Emitter*> InlineAt; // ExitFunction node -> callee
  uint64_t InheritedMask = 0; // state the caller may have written before the call
  bool SkipFlagSpill = false;
  static bool SkipLeavers() { static const bool V = !getenv("FEXWASM_INLINE_LEAVERS"); return V; }
  // Can the code exit other than by returning or by a call that comes back
  // into it (a jump table, a tail call)? Inlined, such an exit abandons the
  // caller's function.
  static bool LeavesOtherThanReturn(const IRListView& IR) {
    for (auto [BlockNode, BlockHeader] : IR.GetBlocks()) {
      for (auto [CodeNode, IROp] : IR.GetCode(BlockNode)) {
        if (IROp->Op == OP_EXITFUNCTION) {
          auto Op = IROp->C<IROp_ExitFunction>();
          if (Op->Hint != BranchHint::Return && Op->Hint != BranchHint::Call) {
            return true;
          }
        }
      }
    }
    return false;
  }
  bool XAbiFlags() const { return Cfg.ABILocalFlags; }
  uint32_t SelectorGlobal() const { return Cfg.ThreadBaseGlobal ? 1 : 0; } // after the imported e.tb
  static bool XNoDepth() { static const bool V = getenv("FEXWASM_X_NODEPTH"); return V; }
  static bool XNoCaller() { static const bool V = getenv("FEXWASM_X_NOCALLER"); return V; }
  uint64_t InlineRetAddr = 0; // for a callee: the return address it returns to
  uint32_t InlineLevel = 0;
  // Indirect call sites: the profiled targets inlined behind compares.
  std::unordered_map<uint32_t, std::vector<std::pair<uint64_t, Emitter*>>> IndirectInlineAt;
  // In an inlined callee, its jumps out of the unit (a jump table, a tail
  // call): the targets (seen, or the constant one) inlined behind compares,
  // returning to the same call site. Opt-in (FEXWASM_JUMPINLINE): Box2D's
  // pyramid got 5% slower with it and nothing measured got faster.
  std::unordered_map<uint32_t, std::vector<std::pair<uint64_t, Emitter*>>> JumpInlineAt;
  static bool IsLeavingExit(const IROp_ExitFunction* Op) { return Op->Hint != BranchHint::Return && Op->Hint != BranchHint::Call; }
  // Every way out other than returning has inlined targets.
  bool LeaversCovered() const {
    for (auto [BlockNode, BlockHeader] : IR.GetBlocks()) {
      for (auto [CodeNode, IROp] : IR.GetCode(BlockNode)) {
        if (IROp->Op == OP_EXITFUNCTION && IsLeavingExit(IROp->C<IROp_ExitFunction>()) && !JumpInlineAt.count(ID(CodeNode))) {
          return false;
        }
      }
    }
    return true;
  }
  bool Analyze();
  void EmitInlined(Emitter& Callee, uint32_t RetIndex);
  // SelfEntry >= 0: the call's target is in this function (its RegionUnit
  // value in a region), so it is a direct call of run.
  // AbiCall: a guest call by the calling convention (spill only what a callee
  // may read); RetLive: what the code after it may read (reloaded).
  void EmitDispatchCall(uint64_t RetAddr, int32_t SelfEntry = -1, uint64_t Target = 0, uint64_t RetLive = ~0ull, bool AbiCall = false,
                        bool TargetRel = true);

  // Ops already emitted as part of a pattern (e.g. the keep-carry sequence).
  DenseSet SkipNodes;
  // Static knowledge of the lazy flag state within the current block.
  bool FlagsKnown = false;
  FlagKind KnownKind = FK_MAT;
  // The block's ops being emitted and the current index (for look-ahead).
  const std::vector<std::pair<Ref, const IROp_Header*>>* CurOps = nullptr;
  size_t CurOpIdx = 0;
  // Is Id's value (through registers and simple arithmetic) the address of W?
  bool AddressDependsOn(OrderedNodeWrapper W, uint32_t Id, int Depth = 0) const {
    if (W.IsInvalid() || Depth > 3) {
      return false;
    }
    W = Resolve(W);
    if (ID(W) == Id) {
      return true;
    }
    auto* H = IR.GetOp<IROp_Header>(W);
    switch (H->Op) {
    case OP_ADD:
    case OP_SUB:
    case OP_OR:
    case OP_AND:
    case OP_XOR:
    case OP_LSHL:
    case OP_LSHR:
    case OP_ADDSHIFT:
    case OP_BFE:
      for (uint8_t A = 0, N = GetArgs(H->Op); A < N; A++) {
        if (AddressDependsOn(H->Args[A], Id, Depth + 1)) {
          return true;
        }
      }
      return false;
    default: return false;
    }
  }
  // TSO: a load needs no fence of its own when the next memory access that
  // other threads could see is a TSO load whose address depends on it (as
  // in pointer chasing): ARM orders that load after this one through the
  // address dependency, and its own fence then orders everything after.
  // Plain (stack) accesses in between are thread-local.
  bool NextLoadDependsOn(Ref Node) const {
    if (!CurOps || ENV_FLAG("FEXWASM_TSO_NODEP")) {
      return false;
    }
    for (size_t I = CurOpIdx + 1; I < CurOps->size(); I++) {
      const IROp_Header* Op = (*CurOps)[I].second;
      switch (Op->Op) {
      case OP_LOADMEMTSO: {
        auto L = Op->C<IROp_LoadMem>();
        return L->Class == RegClass::GPR && (AddressDependsOn(L->Addr, ID(Node)) || AddressDependsOn(L->Offset, ID(Node)));
      }
      case OP_STOREMEMTSO:
        // Mode 3 stores are swpal (or a fence and a store when misaligned),
        // fully ordered: this load comes before them and all that follows.
        if (Cfg.TSOMode == 3 && Op->C<IROp_StoreMem>()->Class == RegClass::GPR && !ENV_FLAG("FEXWASM_TSO_NOSTOREORDER")) {
          return true;
        }
        return false;
      case OP_INLINECONSTANT:
      case OP_INLINEENTRYPOINTOFFSET:
      case OP_CONSTANT:
      case OP_GUESTOPCODE:
      case OP_LOADREGISTER:
      case OP_STOREREGISTER:
      case OP_LOADMEM:  // stack and other non-TSO accesses: thread-local
      case OP_STOREMEM:
      case OP_PUSH:
      case OP_POP:
      case OP_ADD:
      case OP_SUB:
      case OP_OR:
      case OP_AND:
      case OP_XOR:
      case OP_LSHL:
      case OP_LSHR:
      case OP_ASHR:
      case OP_ADDSHIFT:
      case OP_BFE:
      case OP_BFI:
      case OP_SBFE:
      case OP_MUL:
      case OP_SUBNZCV:
      case OP_TESTNZ:
      case OP_ADDNZCV: continue;
      default: return false; // anything else: keep the fence
      }
    }
    return false;
  }
  const char* CurOpName = "";
  uint32_t CurMemoryOp = 0, CurMemorySize = 0, CurGuestOffset = 0;
  uint32_t OpsInBlock = 0;
  // Within a block: the value each GPR was last stored from, and the loads
  // that read such a value back, so peepholes can see through registers.
  DenseMap<OrderedNodeWrapper> RegStored, XRegStored;
  // LoadRegister nodes of this block that can read the register's local
  // directly: every use comes before the block next writes that register.
  DenseSet RegAliased;
  std::vector<std::pair<Ref, const IROp_Header*>> AliasOps; // FindRegAliases' scratch
  DenseMap<uint32_t> Uses, LastUse;
  void FindRegAliases(Ref BlockNode) {
    RegAliased.clear();
    auto& Ops = AliasOps;
    Ops.clear();
    for (auto [CodeNode, IROp] : IR.GetCode(BlockNode)) {
      Ops.push_back({CodeNode, IROp});
    }
    Uses.clear();
    LastUse.clear();
    for (uint32_t I = 0; I < Ops.size(); I++) {
      const IROp_Header* Op = Ops[I].second;
      for (uint8_t A = 0, N = GetArgs(Op->Op); A < N; A++) {
        if (Op->Args[A].IsInvalid()) {
          continue;
        }
        const uint32_t Id = ID(Op->Args[A]);
        Uses[Id]++;
        LastUse[Id] = I;
      }
    }
    // Backward, so each load sees the index of its register's next write.
    uint32_t NextGWrite[NUM_STATIC], NextXWrite[NUM_XMM];
    std::fill(std::begin(NextGWrite), std::end(NextGWrite), UINT32_MAX);
    std::fill(std::begin(NextXWrite), std::end(NextXWrite), UINT32_MAX);
    for (uint32_t I = uint32_t(Ops.size()); I-- > 0;) {
      if (Ops[I].second->Op == OP_STOREREGISTER) {
        auto Phys = PhysicalRegister(Ops[I].first);
        if (Phys.AsRegClass() == RegClass::GPRFixed && Phys.Reg < NUM_STATIC) {
          NextGWrite[Phys.Reg] = I;
        } else if (Phys.AsRegClass() == RegClass::FPRFixed && Phys.Reg < NUM_XMM) {
          NextXWrite[Phys.Reg] = I;
        }
        continue;
      }
      if (Ops[I].second->Op != OP_LOADREGISTER) {
        continue;
      }
      auto L = Ops[I].second->C<IROp_LoadRegister>();
      const bool Gpr = L->Class == RegClass::GPR && L->Reg < NUM_STATIC, Fpr = L->Class == RegClass::FPR && L->Reg < NUM_XMM;
      if (!Gpr && !Fpr) {
        continue;
      }
      const uint32_t Id = ID(Ops[I].first);
      if (Ops[I].first->GetUses() == 0 || Uses[Id] != Ops[I].first->GetUses()) {
        continue; // dead, or used outside this block
      }
      const uint32_t Write = Gpr ? NextGWrite[L->Reg] : NextXWrite[L->Reg];
      if (LastUse[Id] <= Write) {
        RegAliased.insert(Id);
      }
    }
  }
  DenseMap<OrderedNodeWrapper> LoadAlias;
  OrderedNodeWrapper Resolve(OrderedNodeWrapper W) const {
    for (int I = 0; I < 8 && !W.IsInvalid(); I++) {
      auto It = LoadAlias.find(ID(W));
      if (It == LoadAlias.end()) {
        break;
      }
      W = It->second;
    }
    return W;
  }
  // Per block: the flag kind statically known at its terminator (-1: none),
  // which a block with that one predecessor starts with.
  std::vector<int> ExitFlagKind;
  void NoteExitFlags() {
    if (ExitFlagKind.size() < Blocks.size()) {
      ExitFlagKind.resize(Blocks.size(), -1);
    }
    ExitFlagKind[CurBlock] = FlagsKnown ? int(KnownKind) : -1;
  }
  void Call(uint32_t Ref) {
    FuncUsed[Ref] = true;
    EmitCall(B, CallSites, Ref);
  }

  uint32_t NewLocal(ValType T) {
    Locals.push_back(T);
    return S.NumParams + uint32_t(Locals.size() - 1);
  }
  // run's result (rip) is on the stack: add the register results and return.
  void Return() {
    PushRegArgs();
    B.u8(op::return_);
  }
  // The GPRs passed as wasm values (BackendConfig::RegArgList), in order.
  const std::vector<uint32_t> ArgRegs = Cfg.RegArgList();
  bool IsArgReg(uint32_t R) const { return std::find(ArgRegs.begin(), ArgRegs.end(), R) != ArgRegs.end(); }
  // Does CPUState [Offset, Offset + Bytes) overlap the GPRs passed as values?
  bool HitsRegArgs(uint32_t Offset, uint32_t Bytes) const {
    for (uint32_t R : ArgRegs) {
      const uint32_t Lo = offsetof(CPUState, gregs) + 8 * R;
      if (Offset < Lo + 8 && Offset + Bytes > Lo) {
        return true;
      }
    }
    return false;
  }
  void PushRegArgs() {
    for (uint32_t R : ArgRegs) {
      B.get(G[R]);
    }
  }
  void PopRegArgs() { // takes the register results off the stack, leaving the rip
    for (size_t I = ArgRegs.size(); I-- > 0;) {
      B.set(G[ArgRegs[I]]);
    }
  }
  std::string SigOf(uint32_t Fn) const {
    const std::string Regs(ArgRegs.size(), 'I'), Dep = DepthParam() ? "i" : "";
    if (Fn == FUNC_RUN) {
      return Regs + Dep + ">i" + Regs;
    }
    if (Fn == FUNC_DISPATCH) {
      return "ii" + Regs + Dep + ">i" + Regs;
    }
    return Funcs[Fn].Sig;
  }
  // With register arguments, the guest call depth is run's last parameter
  // (callers pass depth + 1) instead of a counter in memory.
  bool DepthParam() const { return !ArgRegs.empty(); }
  uint32_t DepthLocal() const { return uint32_t(ArgRegs.size()); }
  void PushCallArgs() { // the register arguments and the callee's depth
    PushRegArgs();
    if (DepthParam()) {
      B.get(DepthLocal());
      B.i32c(1);
      B.u8(op::i32_add);
    }
  }
  uint32_t ID(Ref Node) const {
    return IR.GetID(Node).Value;
  }
  uint32_t ID(OrderedNodeWrapper W) const {
    return IR.GetID(IR.GetNode(W)).Value;
  }
  uint32_t LocalFor(uint32_t Id) {
    auto It = NodeLocal.find(Id);
    if (It != NodeLocal.end()) {
      return It->second;
    }
    uint32_t L = NewLocal(I64);
    NodeLocal.emplace(Id, L);
    return L;
  }
  void SetNode(Ref Node) {
    if (Node->GetUses() == 0) { // a dead result (the op ran for its side effects)
      B.u8(op::drop);
      return;
    }
    LastSetStart = B.size();
    B.set(LocalFor(ID(Node)));
    LastSetEnd = B.size();
    LastSetNode = ID(Node);
    LastSetLocal = LocalFor(ID(Node));
  }
  // Stackification: a result whose one use is the next op's first operand
  // stays on the wasm stack instead of going through a local (the op's final
  // local.set is taken back off). Baseline JSC keeps every local in memory.
  size_t LastSetStart = 0, LastSetEnd = 0;
  uint32_t LastSetNode = 0, LastSetLocal = 0;
  uint32_t StackTopLocal = 0; // where the stacked node's value goes if it isn't taken
  uint32_t StackTop = 0; // the node whose value is on top of the wasm stack
  size_t RegSetAt = 0, RegSetEnd = 0; // the last register store's local.set
  uint32_t RegSetLocal = UINT32_MAX;
  size_t TakenAt = SIZE_MAX;   // where the consumer took it (must be its first emission)
  uint32_t TakenNode = 0;      // the value taken, which mustn't be read again
  bool ReadAgain = false;
  // Or: a register store's local.tee left the register's value on the stack
  // for the next op to take if it reads that register first.
  uint32_t StackLocal = UINT32_MAX;
  size_t TeeAt = 0; // the local.tee opcode byte, turned back into local.set if not taken
  bool TakeStack(OrderedNodeWrapper W, bool Vec) {
    if (StackTop && ID(W) == StackTop) {
      TakenAt = B.size();
      TakenNode = StackTop;
      StackTop = 0;
      return true;
    }
    if (TakenNode && ID(W) == TakenNode) {
      ReadAgain = true;
    }
    if (StackLocal != UINT32_MAX) {
      auto& Map = Vec ? NodeVLocal : NodeLocal;
      auto It = Map.find(ID(W));
      if (It != Map.end() && It->second == StackLocal) {
        TakenAt = B.size();
        StackLocal = UINT32_MAX;
        return true;
      }
    }
    return false;
  }
  // Records an unsupported op; emission carries on so that one compile reports
  // every unsupported op of the unit ("; "-separated).
  void Fail(const IROp_Header* Op, const char* Why = "unsupported") {
    const std::string E = std::string(Why) + " IR op " + std::string(GetName(Op->Op)) + " size " + std::to_string(uint32_t(Op->Size));
    if (Err.find(E) == std::string::npos) {
      Err += (Err.empty() ? "" : "; ") + E;
    }
  }

  uint32_t VLocalFor(uint32_t Id) {
    auto It = NodeVLocal.find(Id);
    if (It != NodeVLocal.end()) {
      return It->second;
    }
    uint32_t L = NewLocal(V128);
    NodeVLocal.emplace(Id, L);
    return L;
  }
  void SetV(Ref Node) {
    if (Node->GetUses() == 0 && PendingScalar == UINT32_MAX) {
      B.u8(op::drop);
      return;
    }
    LastSetStart = B.size();
    B.set(VLocalFor(ID(Node)));
    LastSetEnd = B.size();
    LastSetNode = ID(Node);
    LastSetLocal = VLocalFor(ID(Node));
    if (PendingScalar != UINT32_MAX) {
      NodeScalar[ID(Node)] = {PendingScalar, PendingScalarD};
      PendingScalar = UINT32_MAX;
    }
  }
  // Scalar SSE: lane 0 of a node computed by a scalar op is also kept in an
  // f32/f64 local, and later scalar ops read it from there, so the chain of
  // scalar ops doesn't go through a lane insert (ins) per op.
  struct ScalarLocal {
    uint32_t L;
    bool D;
  };
  DenseMap<ScalarLocal> NodeScalar;
  uint32_t PendingScalar = UINT32_MAX;
  bool PendingScalarD = false;
  void Lane0F(OrderedNodeWrapper W, bool D) { // pushes lane 0 of W as f64 (D) or f32
    auto It = NodeScalar.find(ID(Resolve(W)));
    if (It != NodeScalar.end() && It->second.D == D) {
      B.get(It->second.L);
      return;
    }
    FPR(W);
    Simd(D ? 0x21 : 0x1f);
    B.u8(0);
  }
  // [vector, scalar] -> the vector with lane 0 replaced; remembers the scalar
  // for the node the next SetV stores.
  void ReplaceLane0Cached(bool D) {
    const uint32_t L = NewLocal(D ? F64 : F32);
    B.tee(L);
    if (InsertSplat) { // no vector below: the upper lanes are don't-cares
      Simd(D ? 0x14 : 0x13); // f64x2 / f32x4.splat
      InsertSplat = false;
    } else {
      Simd(D ? 0x22 : 0x20);
      B.u8(0);
    }
    PendingScalar = L;
    PendingScalarD = D;
  }
  // Pushes an FPR operand as v128.
  void FPR(OrderedNodeWrapper W) {
    if (TakeStack(W, true)) {
      return;
    }
    B.get(VLocalFor(ID(W)));
  }
  void Simd(uint32_t Sub) {
    B.u8(op::prefix_fd);
    B.u32(Sub);
  }
  void V128Const(uint64_t Lo, uint64_t Hi) {
    Simd(0x0c);
    for (int i = 0; i < 8; i++) {
      B.u8(uint8_t(Lo >> (8 * i)));
    }
    for (int i = 0; i < 8; i++) {
      B.u8(uint8_t(Hi >> (8 * i)));
    }
  }
  void FConst(bool D, double V) {
    if (D) {
      B.u8(0x44); // f64.const
      uint64_t Bits_;
      memcpy(&Bits_, &V, 8);
      for (int i = 0; i < 8; i++) {
        B.u8(uint8_t(Bits_ >> (8 * i)));
      }
    } else {
      B.u8(0x43); // f32.const
      const float F = float(V);
      uint32_t Bits_;
      memcpy(&Bits_, &F, 4);
      for (int i = 0; i < 4; i++) {
        B.u8(uint8_t(Bits_ >> (8 * i)));
      }
    }
  }
  // Rounds the value on the stack (f32 / f64, or f32x4 / f64x2 when Vec) to
  // an integral value in the guest's current rounding mode (RoundModeAddr).
  void RoundByMode(bool D, bool Vec) {
    const uint32_t V = NewLocal(Vec ? V128 : D ? F64 : F32), Mode = NewLocal(I32);
    auto Rnd = [&](int K) { // 0 nearest, 1 floor, 2 ceil, 3 trunc
      static constexpr uint8_t S32[] = {0x90, 0x8e, 0x8d, 0x8f}, S64[] = {0x9e, 0x9c, 0x9b, 0x9d};
      static constexpr uint8_t V32[] = {0x6a, 0x68, 0x67, 0x69}, V64[] = {0x94, 0x75, 0x74, 0x7a};
      B.get(V);
      if (Vec) {
        Simd(D ? V64[K] : V32[K]);
      } else {
        B.u8(D ? S64[K] : S32[K]);
      }
    };
    B.set(V);
    SysBase();
    B.mem(op::i32_load, 2, Cfg.RoundModeAddr);
    B.i32c(3);
    B.u8(op::i32_and);
    B.tee(Mode);
    B.u8(op::i32_eqz);
    B.u8(op::if_);
    B.u8(Vec ? V128 : D ? F64 : F32);
    Rnd(0);
    B.u8(op::else_);
    Rnd(1);
    Rnd(2);
    B.get(Mode);
    B.i32c(1);
    B.u8(op::i32_eq);
    B.u8(op::select);
    Rnd(3);
    B.get(Mode);
    B.i32c(3);
    B.u8(op::i32_ne);
    B.u8(op::select);
    B.u8(op::end);
  }
  void F64Splat(double V) {
    uint64_t Bits_;
    memcpy(&Bits_, &V, 8);
    V128Const(Bits_, Bits_);
  }
  // Fused multiply-add a * b + c of three v128 locals (wasm has no FMA without
  // relaxed SIMD); the result is pushed.
  //  f32x4: exact product and sum error in f64, round-to-odd, then one
  //         rounding to f32 -- correctly rounded.
  //  f64x2: Dekker two-product + two-sum; faithful (last-bit exact in all but
  //         rare double-rounding cases), plain a * b + c on overflow.
  void FusedMulAdd(bool D, uint32_t A, uint32_t Bv, uint32_t C) {
    const uint32_t P = NewLocal(V128), S = NewLocal(V128), T = NewLocal(V128), E = NewLocal(V128);
    auto TwoSumErr = [&](auto PushC) { // E = (p - (s - bb)) + (c - bb), bb = s - p
      B.get(S);
      B.get(P);
      Simd(0xf1);
      B.set(T);
      B.get(P);
      B.get(S);
      B.get(T);
      Simd(0xf1);
      Simd(0xf1);
      PushC();
      B.get(T);
      Simd(0xf1);
      Simd(0xf0);
      B.set(E);
    };
    if (!D) {
      const uint32_t Half[2] = {NewLocal(V128), NewLocal(V128)}, Cd = NewLocal(V128);
      static constexpr uint8_t HighToLow[16] = {8, 9, 10, 11, 12, 13, 14, 15, 8, 9, 10, 11, 12, 13, 14, 15};
      for (int H = 0; H < 2; H++) {
        auto Promote = [&](uint32_t L) {
          B.get(L);
          if (H) {
            B.get(L);
            Shuffle(HighToLow);
          }
          Simd(0x5f); // f64x2.promote_low_f32x4
        };
        Promote(C);
        B.set(Cd);
        Promote(A);
        Promote(Bv);
        Simd(0xf2);
        B.set(P); // exact
        B.get(P);
        B.get(Cd);
        Simd(0xf0);
        B.set(S);
        TwoSumErr([&] { B.get(Cd); });
        // Round to odd: when inexact (and finite), truncate toward zero and set the LSB.
        B.get(E);
        V128Const(0, 0);
        Simd(0x48); // f64x2.ne
        B.get(S);
        Simd(0xec); // abs
        F64Splat(__builtin_inf());
        Simd(0x49); // lt
        Simd(0x4e);
        B.set(T); // mask
        B.get(S);
        B.get(E);
        B.get(S);
        Simd(0x51);
        V128Const(0, 0);
        Simd(0xd8); // i64x2.lt_s: e and s differ in sign -> |s| > |exact|
        B.get(T);
        Simd(0x4e);
        Simd(0xce); // i64x2.add (-1)
        B.get(T);
        V128Const(1, 1);
        Simd(0x4e);
        Simd(0x50);
        Simd(0x5e); // f32x4.demote_f64x2_zero
        B.set(Half[H]);
      }
      B.get(Half[0]);
      B.get(Half[1]);
      static constexpr uint8_t Join[16] = {0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23};
      Shuffle(Join);
      return;
    }
    const uint32_t Ah = NewLocal(V128), Al = NewLocal(V128), Bh = NewLocal(V128), Bl = NewLocal(V128), Err = NewLocal(V128);
    auto Split = [&](uint32_t X, uint32_t Hi, uint32_t Lo) { // t = x * (2^27 + 1); hi = t - (t - x); lo = x - hi
      B.get(X);
      F64Splat(134217729.0);
      Simd(0xf2);
      B.set(T);
      B.get(T);
      B.get(T);
      B.get(X);
      Simd(0xf1);
      Simd(0xf1);
      B.set(Hi);
      B.get(X);
      B.get(Hi);
      Simd(0xf1);
      B.set(Lo);
    };
    B.get(A);
    B.get(Bv);
    Simd(0xf2);
    B.set(P);
    Split(A, Ah, Al);
    Split(Bv, Bh, Bl);
    // err = ((ah*bh - p) + ah*bl + al*bh) + al*bl
    B.get(Ah);
    B.get(Bh);
    Simd(0xf2);
    B.get(P);
    Simd(0xf1);
    B.get(Ah);
    B.get(Bl);
    Simd(0xf2);
    Simd(0xf0);
    B.get(Al);
    B.get(Bh);
    Simd(0xf2);
    Simd(0xf0);
    B.get(Al);
    B.get(Bl);
    Simd(0xf2);
    Simd(0xf0);
    B.set(Err);
    B.get(P);
    B.get(C);
    Simd(0xf0);
    B.set(S);
    TwoSumErr([&] { B.get(C); });
    // r = s + (e + err), unless err is not finite (overflow in the split)
    B.get(S);
    B.get(E);
    B.get(Err);
    Simd(0xf0);
    Simd(0xf0);
    B.get(S);
    B.get(Err);
    Simd(0xec);
    F64Splat(__builtin_inf());
    Simd(0x49);
    Simd(0x52);
  }
  // i32x4 of half-float bit patterns (low 16 bits of each lane) -> f32x4.
  void HalfToFloat() {
    const uint32_t H = NewLocal(V128), R = NewLocal(V128), Sign = NewLocal(V128);
    auto Splat32 = [&](uint32_t V) { V128Const(uint64_t(V) * 0x1'0000'0001ull, uint64_t(V) * 0x1'0000'0001ull); };
    B.set(H);
    B.get(H);
    Splat32(0x8000);
    Simd(0x4e);
    B.i32c(16);
    Simd(0xab); // sign << 16
    B.set(Sign);
    // normal: ((h & 0x7fff) << 13) + (112 << 23); exp 31: + (224 << 23) and quiet NaNs
    B.get(H);
    Splat32(0x7fff);
    Simd(0x4e);
    B.i32c(13);
    Simd(0xab);
    B.set(R);
    B.get(R);
    Splat32(224u << 23);
    Simd(0xae);
    B.get(H);
    Splat32(0x3ff);
    Simd(0x4e);
    V128Const(0, 0);
    Simd(0x38); // i32x4.ne: NaN
    Splat32(0x40'0000);
    Simd(0x4e);
    Simd(0x50); // inf/nan bits
    B.get(R);
    Splat32(112u << 23);
    Simd(0xae); // normal bits
    B.get(H);
    Splat32(0x7c00);
    Simd(0x4e);
    Splat32(0x7c00);
    Simd(0x37); // exp == 31
    Simd(0x52);
    // exp == 0: mantissa * 2^-24, exactly
    B.get(H);
    Splat32(0x3ff);
    Simd(0x4e);
    Simd(0xfa); // f32x4.convert_i32x4_s
    V128Const(0x3380'0000'3380'0000ull, 0x3380'0000'3380'0000ull); // 2^-24
    Simd(0xe6);
    B.set(R);
    B.get(R);
    B.get(H);
    Splat32(0x7c00);
    Simd(0x4e);
    V128Const(0, 0);
    Simd(0x38); // exp != 0
    Simd(0x52); // select(normal/infnan, denormal, exp != 0)
    B.get(Sign);
    Simd(0x50);
  }
  // f32x4 -> i32x4 of half-float bit patterns, rounded in the guest's current
  // rounding mode (RoundModeAddr: 0 nearest even, 1 down, 2 up, 3 toward zero).
  void FloatToHalf() {
    const uint32_t X = NewLocal(V128), A = NewLocal(V128), T = NewLocal(V128), Sign = NewLocal(V128);
    const uint32_t Mode = NewLocal(I32), Near = NewLocal(V128), Away = NewLocal(V128);
    auto Splat32 = [&](uint32_t V) { V128Const(uint64_t(V) * 0x1'0000'0001ull, uint64_t(V) * 0x1'0000'0001ull); };
    B.set(X);
    SysBase();
    B.mem(op::i32_load, 2, Cfg.RoundModeAddr);
    B.i32c(3);
    B.u8(op::i32_and);
    B.set(Mode);
    // Near: all lanes if round-to-nearest. Away: lanes rounded away from zero
    // in magnitude (up for positives, down for negatives).
    B.i32c(0);
    B.get(Mode);
    B.u8(op::i32_eqz);
    B.u8(op::i32_sub);
    Simd(0x11); // i32x4.splat(mode == 0 ? -1 : 0)
    B.set(Near);
    B.get(X);
    V128Const(0, 0);
    Simd(0x39); // i32x4.lt_s: negative lanes
    B.i32c(0);
    B.get(Mode);
    B.i32c(1);
    B.u8(op::i32_eq);
    B.u8(op::i32_sub);
    Simd(0x11);
    Simd(0x4e); // negative & down
    B.get(X);
    V128Const(0, 0);
    Simd(0x3f); // i32x4.ge_s: non-negative lanes
    B.i32c(0);
    B.get(Mode);
    B.i32c(2);
    B.u8(op::i32_eq);
    B.u8(op::i32_sub);
    Simd(0x11);
    Simd(0x4e); // positive & up
    Simd(0x50);
    B.set(Away);
    B.get(X);
    B.i32c(16);
    Simd(0xad); // shr_u
    Splat32(0x8000);
    Simd(0x4e);
    B.set(Sign);
    B.get(X);
    Splat32(0x7fff'ffff);
    Simd(0x4e);
    B.set(A);
    // normal: t = a - (112 << 23), plus the rounding increment, >> 13
    B.get(A);
    Splat32(112u << 23);
    Simd(0xb1);
    B.set(T);
    B.get(T);
    Splat32(0xfff); // nearest: 0xfff + lsb
    B.get(T);
    B.i32c(13);
    Simd(0xad);
    Splat32(1);
    Simd(0x4e);
    Simd(0xae);
    Splat32(0x1fff); // away: 0x1fff, else 0
    V128Const(0, 0);
    B.get(Away);
    Simd(0x52);
    B.get(Near);
    Simd(0x52);
    Simd(0xae);
    B.i32c(13);
    Simd(0xad);
    // clamp: past the largest half, infinity if rounding up in magnitude, else 0x7bff
    Splat32(0x7c00);
    Splat32(0x7bff);
    B.get(Near);
    B.get(Away);
    Simd(0x50);
    Simd(0x52);
    Simd(0xb7); // i32x4.min_u
    // below 2^-14: round(|x| * 2^24) in the same mode
    B.get(A);
    V128Const(0x4b80'0000'4b80'0000ull, 0x4b80'0000'4b80'0000ull); // 2^24
    Simd(0xe6);
    B.set(T);
    B.get(T);
    Simd(0x6a); // nearest
    B.get(T);
    Simd(0x67); // ceil
    B.get(T);
    Simd(0x69); // trunc
    B.get(Away);
    Simd(0x52);
    B.get(Near);
    Simd(0x52);
    Simd(0xf8); // trunc_sat to i32
    B.get(A);
    Splat32(0x3880'0000);
    Simd(0x40); // i32x4.ge_u: normal where |x| >= 2^-14
    Simd(0x52);
    // inf / nan
    Splat32(0x7c00);
    B.get(A);
    Splat32(0x7fffff);
    Simd(0x4e);
    V128Const(0, 0);
    Simd(0x38);
    Splat32(0x200);
    Simd(0x4e);
    Simd(0x50);
    B.get(A);
    Splat32(0x7fffff);
    Simd(0x4e);
    B.i32c(13);
    Simd(0xad);
    Simd(0x50); // 0x7c00 | quiet | payload
    B.get(A);
    Splat32(0x7f80'0000);
    Simd(0x3a); // lt_u: finite keeps the value, else inf / nan
    Simd(0x52);
    B.get(Sign);
    Simd(0x50);
  }
  // i8x16.shuffle of the two v128 on the stack; indices 0-15 pick from the
  // first operand, 16-31 from the second.
  // The 16 bytes of a vector constant node (named or indexed constant), if it is one.
  bool ConstVector(OrderedNodeWrapper W, uint8_t (&Out)[16]) const {
    auto* H = IR.GetOp<IROp_Header>(W);
    memset(Out, 0, 16);
    if (H->Op == OP_LOADNAMEDVECTORCONSTANT) {
      auto Op = H->C<IROp_LoadNamedVectorConstant>();
      if (Op->Constant == NamedVectorConstant::NAMED_VECTOR_ZERO) {
        return true;
      }
      if (!Cfg.NamedConstants || uint32_t(H->Size) > 16) {
        return false;
      }
      memcpy(Out, Cfg.NamedConstants + 16 * Op->Constant, uint32_t(H->Size));
      return true;
    }
    if (H->Op == OP_LOADNAMEDVECTORINDEXEDCONSTANT) {
      auto Op = H->C<IROp_LoadNamedVectorIndexedConstant>();
      if (!Cfg.IndexedConstantPointers || uint32_t(H->Size) > 16) {
        return false;
      }
      memcpy(Out, reinterpret_cast<const uint8_t*>(Cfg.IndexedConstantPointers[Op->Constant]) + Op->Index, uint32_t(H->Size));
      return true;
    }
    return false;
  }
  void Shuffle(const uint8_t (&Idx)[16]) {
    Simd(0x0d);
    for (uint8_t I : Idx) {
      B.u8(I);
    }
  }
  // Keeps the low `Bytes` bytes of the v128 on the stack and zeroes the rest,
  // as arm64 does when writing a D/S/H/B view of a vector register.
  void KeepLow(uint32_t Bytes, bool Result = true) {
    if (Bytes >= 16 || (Result && (CurDemand & ~((1u << Bytes) - 1) & 0xFFFF) == 0)) {
      return; // (a result whose upper bytes nothing reads)
    }
    const uint64_t Lo = Bytes >= 8 ? ~0ull : ((1ull << (Bytes * 8)) - 1);
    V128Const(Lo, 0);
    Simd(0x4e); // v128.and
  }
  void MemArg(uint32_t Align) {
    B.u32(Align);
    B.u32(0);
  }

  void SysBase() {
    B.get(S.SysBase);
  }
  void BrokerRequest(uint32_t Operation, uint32_t Width) {
    const uint32_t At = broker::Scratch;
    auto Word = [&](uint32_t Offset, uint32_t Value) {
      SysBase(); B.i32c(int32_t(Value)); B.mem(op::i32_store, 2, At + Offset);
    };
    Word(0, 0x314d4a42); Word(4, broker::MemoryABI);
    Word(16, Operation); Word(20, Width); Word(24, Operation == 12 ? 4 : Operation == 1 ? 1 : Operation == 2 ? 2 : 3);
    SysBase(); B.i64c(int64_t(Entry)); B.mem(op::i64_store, 3, At + 40);
    Call(FUNC_MEMORY);
    B.set(TC);
    B.get(TC); B.u8(op::if_); B.u8(0x40);
    // No epilogue on a fault: the kernel restores the pre-state only after
    // this typed exit has unwound the instruction's Wasm locals.
    B.get(TC); Return();
    B.u8(op::end);
  }
  // Pushes a GPR operand as i64.
  void GPR(OrderedNodeWrapper W) {
    if (W.IsInvalid()) {
      B.i64c(0);
      return;
    }
    if (TakeStack(W, false)) {
      return;
    }
    auto* H = IR.GetOp<IROp_Header>(W);
    if (H->Op == OP_INLINECONSTANT) {
      B.i64c(int64_t(H->C<IROp_InlineConstant>()->Constant));
    } else if (H->Op == OP_INLINEENTRYPOINTOFFSET) {
      uint64_t V = Entry + H->C<IROp_InlineEntrypointOffset>()->Offset;
      if (H->Size == OpSize::i32Bit) {
        V &= 0xFFFF'FFFFull;
      }
      RipConst(V, true, true, H->Size == OpSize::i32Bit);
    } else {
      B.get(LocalFor(ID(W)));
    }
  }
  // Pushes a GPR operand as i32 (low 32 bits).
  void GPR32(OrderedNodeWrapper W) {
    GPR(W);
    B.u8(op::i32_wrap_i64);
  }
  bool IsConst(OrderedNodeWrapper W, uint64_t* V = nullptr) const {
    if (W.IsInvalid()) {
      return false;
    }
    auto* H = IR.GetOp<IROp_Header>(W);
    if (H->Op == OP_INLINECONSTANT) {
      if (V) {
        *V = H->C<IROp_InlineConstant>()->Constant;
      }
      return true;
    }
    return false;
  }

  // Effective guest address (i64 on stack) of Addr + extended/scaled Offset.
  void Address(OrderedNodeWrapper Addr, OrderedNodeWrapper Offset, MemOffsetType Type, uint8_t Scale) {
    GPR(Addr);
    if (Offset.IsInvalid()) {
      return;
    }
    uint64_t C;
    if (IsConst(Offset, &C)) {
      if (C) {
        B.i64c(int64_t(C));
        B.u8(op::i64_add);
      }
      return;
    }
    GPR(Offset);
    if (Type == MemOffsetType::UXTW) {
      B.i64c(0xFFFF'FFFF);
      B.u8(op::i64_and);
    } else if (Type == MemOffsetType::SXTW) {
      B.u8(op::i64_extend32_s);
    }
    if (Scale > 1) {
      B.i64c(__builtin_ctz(Scale));
      B.u8(op::i64_shl);
    }
    B.u8(op::i64_add);
  }
  // Pushes the wasm (i32) address of Addr + Offset and returns a displacement
  // for the access's offset field. Small positive constant displacements are
  // folded there, so accesses off one base share its address computation.
  // (Guest address + displacement then does not wrap at 4 GB but goes out of
  // bounds: a guest window never ends in a mapped page.)
  uint32_t WasmAddress(OrderedNodeWrapper Addr, OrderedNodeWrapper Offset, MemOffsetType Type, uint8_t Scale) {
    uint64_t C;
    if (!Offset.IsInvalid() && IsConst(Offset, &C) && C > 0 && C < 0x10'0000 && !IsConst(Addr)) {
      GPR(Addr);
      TraceMemoryAddress(uint32_t(C));
      Wrap();
      return uint32_t(C);
    }
    Address(Addr, Offset, Type, Scale);
    TraceMemoryAddress(0);
    Wrap();
    return 0;
  }
  // Leave the i64 base on the stack. In particular, keep a folded memarg
  // displacement folded: changing it to wrapped arithmetic would change the
  // exact boundary behaviour we are trying to observe.
  void TraceMemoryAddress(uint32_t Disp, std::optional<uint32_t> Length = {},
                          std::optional<uint32_t> Source = {}, uint32_t Kind = 0) {
    if (!Cfg.MemoryTraceAddr) return;
    const uint32_t Base = NewLocal(I64), At = Cfg.MemoryTraceAddr;
    B.tee(Base);
    SysBase(); B.get(Base);
    if (Disp) { B.i64c(Disp); B.u8(op::i64_add); }
    B.mem(op::i64_store, 3, At);
    SysBase(); RipConst(Entry + CurGuestOffset, true);
    B.mem(op::i64_store, 3, At + 8);
    SysBase(); B.i64c(int64_t(uint64_t(CurMemoryOp) << 32 | CurMemorySize));
    B.mem(op::i64_store, 3, At + 16);
    for (auto [Off, CtxOff] : {std::pair<uint32_t, uint32_t>{24, uint32_t(offsetof(CPUState, fs_cached))},
                              {32, uint32_t(offsetof(CPUState, gs_cached))}}) {
      SysBase(); SysBase(); B.mem(op::i64_load, 3, Cfg.CtxAddr + CtxOff);
      B.mem(op::i64_store, 3, At + Off);
    }
    SysBase(); B.get(Base); B.i64c(0xFFFF'FFFFull); B.u8(op::i64_and);
    if (Disp) { B.i64c(Disp); B.u8(op::i64_add); }
    B.mem(op::i64_store, 3, At + 40);
    // Version 2: bulk operations retain their full byte count and both copy
    // operands. Scalar accesses clear these fields instead of leaving stale
    // bulk metadata. This private record ends before CPUState at 0x100.
    SysBase();
    if (Length) B.get(*Length); else B.i64c(CurMemorySize);
    B.mem(op::i64_store, 3, At + 48);
    SysBase();
    if (Source) B.get(*Source); else B.i64c(0);
    B.mem(op::i64_store, 3, At + 56);
    SysBase();
    if (Source) { B.get(*Source); B.i64c(0xFFFF'FFFFull); B.u8(op::i64_and); }
    else B.i64c(0);
    B.mem(op::i64_store, 3, At + 64);
    SysBase(); B.i64c(Kind); B.mem(op::i64_store, 3, At + 72);
  }
  // Is the address (after register aliases) RSP-based? Stack stores can't hit code.
  bool StackAddress(OrderedNodeWrapper W, int Depth = 0) const {
    if (W.IsInvalid() || Depth > 3) {
      return false;
    }
    W = Resolve(W);
    auto* H = IR.GetOp<IROp_Header>(W);
    if (H->Op == OP_LOADREGISTER) {
      auto L = H->C<IROp_LoadRegister>();
      return L->Class == RegClass::GPR && L->Reg == 4; // RSP
    }
    if (H->Op == OP_ADD || H->Op == OP_SUB) {
      uint64_t C;
      return IsConst(H->Args[1], &C) && StackAddress(H->Args[0], Depth + 1);
    }
    return false;
  }
  // Experiment (FEXWASM_X_SMCBARRIER): the i32 wasm address + Off on the
  // stack stays there; traps if its page's byte in a bitmap at 0xC000000 is
  // set. Measures what a self-modifying-code store barrier would cost.
  void SmcBarrier(uint32_t Off) {
    B.tee(TC);
    B.get(TC);
    if (Off) {
      B.i32c(int32_t(Off));
      B.u8(op::i32_add);
    }
    B.i32c(12);
    B.u8(op::i32_shr_u);
    B.mem(op::i32_load8_u, 0, 0x0C00'0000);
    B.u8(op::if_);
    B.u8(0x40);
    B.u8(op::unreachable);
    B.u8(op::end);
  }
  // Converts the i64 guest address on the stack into a wasm address.
  void Wrap() {
    B.u8(op::i32_wrap_i64);
  }

  void LoadGPRSized(uint32_t Size, uint32_t Off = 0) {
    switch (Size) {
    case 1: B.mem(op::i64_load8_u, 0, Off); break;
    case 2: B.mem(op::i64_load16_u, 1, Off); break;
    case 4: B.mem(op::i64_load32_u, 2, Off); break;
    default: B.mem(op::i64_load, 3, Off); break;
    }
  }
  void StoreGPRSized(uint32_t Size, uint32_t Off = 0) {
    switch (Size) {
    case 1: B.mem(op::i64_store8, 0, Off); break;
    case 2: B.mem(op::i64_store16, 1, Off); break;
    case 4: B.mem(op::i64_store32, 2, Off); break;
    default: B.mem(op::i64_store, 3, Off); break;
    }
  }
  // v128 load of `Size` bytes (zero-extended) from the i32 address on the stack.
  bool LoadFPRSized(uint32_t Size, uint32_t Off = 0) {
    switch (Size) {
    case 16: Simd(0x00); B.u32(0); B.u32(Off); break; // v128.load
    case 8: Simd(0x5d); B.u32(0); B.u32(Off); break;  // v128.load64_zero
    case 4: Simd(0x5c); B.u32(0); B.u32(Off); break;  // v128.load32_zero
    case 2: V128Const(0, 0); Simd(0x55); B.u32(0); B.u32(Off); B.u8(0); break; // v128.load16_lane
    case 1: V128Const(0, 0); Simd(0x54); B.u32(0); B.u32(Off); B.u8(0); break; // v128.load8_lane
    default: return false;
    }
    return true;
  }
  // Stores the low `Size` bytes of the v128 on the stack at the i32 address below it.
  bool StoreFPRSized(uint32_t Size, uint32_t Off = 0) {
    switch (Size) {
    case 16: Simd(0x0b); B.u32(0); B.u32(Off); break;          // v128.store
    case 8: Simd(0x5b); B.u32(0); B.u32(Off); B.u8(0); break;  // v128.store64_lane
    case 4: Simd(0x5a); B.u32(0); B.u32(Off); B.u8(0); break;
    case 2: Simd(0x59); B.u32(0); B.u32(Off); B.u8(0); break;
    case 1: Simd(0x58); B.u32(0); B.u32(Off); B.u8(0); break;
    default: return false;
    }
    return true;
  }

  // ---- lazy flags ----
  // Pushes the arm64 shifted-register operand `Src LSL/LSR/ASR/ROR Amount` as
  // i64, computed at 32 bits (zero-extended) unless Is64.
  bool Shifted(OrderedNodeWrapper Src, ShiftType Shift, uint32_t Amount, bool Is64) {
    if (Is64) {
      GPR(Src);
    } else {
      GPR32(Src);
    }
    if (Amount) {
      if (Is64) {
        B.i64c(Amount);
      } else {
        B.i32c(int32_t(Amount));
      }
      switch (Shift) {
      case ShiftType::LSL: B.u8(Is64 ? op::i64_shl : op::i32_shl); break;
      case ShiftType::LSR: B.u8(Is64 ? op::i64_shr_u : op::i32_shr_u); break;
      case ShiftType::ASR: B.u8(Is64 ? op::i64_shr_s : op::i32_shr_s); break;
      case ShiftType::ROR: B.u8(Is64 ? op::i64_rotr : op::i32_rotr); break;
      default: return false;
      }
    }
    if (!Is64) {
      B.u8(op::i64_extend_i32_u);
    }
    return true;
  }
  void Fence() {
    B.u8(0xfe);
    B.u8(0x03);
    B.u8(0x00); // atomic.fence
  }
  // 0xFE-prefixed (threads proposal) instruction with a memarg.
  void Atomic(uint32_t Sub, uint32_t Align) {
    B.u8(0xfe);
    B.u32(Sub);
    B.u32(Align);
    B.u32(0);
  }
  // NZCV = N<<31 | Z<<30 | C<<29 | V<<28 of the W-bit result in local R (i64,
  // zero-extended); the i32 carry and overflow bits are on the stack (C below V).
  void SetNZCVFromResult(uint32_t R, uint32_t W) {
    B.i32c(28);
    B.u8(op::i32_shl);
    B.set(TC); // V
    B.i32c(29);
    B.u8(op::i32_shl);
    B.get(TC);
    B.u8(op::i32_or);
    B.get(R);
    B.i64c(W - 1);
    B.u8(op::i64_shr_u);
    B.u8(op::i32_wrap_i64);
    B.i32c(31);
    B.u8(op::i32_shl);
    B.u8(op::i32_or);
    B.get(R);
    B.u8(op::i64_eqz);
    B.i32c(30);
    B.u8(op::i32_shl);
    B.u8(op::i32_or);
    B.set(NZCV);
    SetFlags(FK_MAT);
  }
  void SetFlags(FlagKind K) {
    B.i32c(K);
    B.set(FK);
    FlagsKnown = true;
    KnownKind = K;
  }
  void Materialize() {
    if (FlagsKnown && KnownKind == FK_MAT) {
      return;
    }
    if (FlagsKnown) { // the producer is known here: compute its NZCV inline
      EmitNZCVOfKind(B, KnownKind, FA, FB, S.MatScratch, NZCV);
      B.set(NZCV);
      B.i32c(FK_MAT);
      B.set(FK);
      KnownKind = FK_MAT;
      return;
    }
    static const bool Log = getenv("FEXWASM_MAT_LOG");
    if (Log) {
      const size_t NP = CurBlock < PredList.size() ? PredList[CurBlock].size() : 0;
      const uint32_t P = NP == 1 ? PredList[CurBlock][0] : UINT32_MAX;
      fprintf(stderr, "[mat] unit %#llx block %u preds %zu op %s pred %d predexit %d firstop %d\n", (unsigned long long)Entry, CurBlock, NP,
              CurOpName, int(P), P != UINT32_MAX && P < ExitFlagKind.size() ? ExitFlagKind[P] : -9, int(OpsInBlock));
    }
    B.get(FK);
    B.get(FA);
    B.get(FB);
    B.get(NZCV);
    Call(FUNC_MAT);
    B.set(NZCV);
    B.i32c(FK_MAT);
    B.set(FK);
    FlagsKnown = true;
    KnownKind = FK_MAT;
  }
  // Pushes (NZCV >> Shift) & 1.
  void NZCVBit(uint32_t Shift) {
    B.get(NZCV);
    B.i32c(int32_t(Shift));
    B.u8(op::i32_shr_u);
    B.i32c(1);
    B.u8(op::i32_and);
  }
  // Pushes i32 0/1 for an arm64-style condition on the guest flags.
  void Condition(CondClass C) {
    if (C == CondClass::AL) {
      B.i32c(1);
      return;
    }
    if (FlagsKnown && IsFloatKind(KnownKind)) { // one float compare
      uint32_t Set = 0;
      for (uint32_t O : {FO_LT, FO_EQ, FO_GT, FO_UN}) {
        Set |= CondHolds(C, FloatNZCV(KnownKind, O)) ? O : 0;
      }
      EmitFloatOutcomeTest(B, KnownKind, FA, FB, Set);
      return;
    }
    // Direct compares while the flag producer is known in this block.
    const FlagKind BK = BaseKind(KnownKind);
    const bool KeptC = KeepsCarry(KnownKind);
    const bool CarryCond = C == CondClass::UGE || C == CondClass::ULT || C == CondClass::UGT || C == CondClass::ULE;
    if (FlagsKnown && CarryInverted(KnownKind) && CarryCond) {
      goto materialise;
    }
    if (FlagsKnown && KeptC) { // carry conditions read the kept carry
      switch (C) {
      case CondClass::UGE: NZCVBit(29); return;
      case CondClass::ULT: NZCVBit(29); B.u8(op::i32_eqz); return;
      default: break;
      }
    }
    if (FlagsKnown && (BK == FK_ADD32 || BK == FK_ADD64)) {
      // Result-based conditions; the carry of a + b is r < a.
      const bool W = BK == FK_ADD32;
      auto Result = [&] {
        B.get(FA);
        B.get(FB);
        B.u8(op::i64_add);
        if (W) {
          B.u8(op::i32_wrap_i64);
        }
      };
      switch (C) {
      case CondClass::EQ: Result(); B.u8(W ? op::i32_eqz : op::i64_eqz); return;
      case CondClass::NEQ: Result(); B.u8(W ? op::i32_eqz : op::i64_eqz); B.u8(op::i32_eqz); return;
      case CondClass::MI:
      case CondClass::PL:
        Result();
        if (W) {
          B.i32c(0);
          B.u8(C == CondClass::MI ? op::i32_lt_s : op::i32_ge_s);
        } else {
          B.i64c(0);
          B.u8(C == CondClass::MI ? op::i64_lt_s : op::i64_ge_s);
        }
        return;
      case CondClass::UGE:
      case CondClass::ULT:
        if (KeptC) {
          break;
        }
        Result();
        B.get(FA);
        if (W) {
          B.u8(op::i32_wrap_i64);
        }
        B.u8(C == CondClass::UGE ? (W ? op::i32_lt_u : op::i64_lt_u) : (W ? op::i32_ge_u : op::i64_ge_u));
        return;
      default: break;
      }
    }
    if (FlagsKnown && (BK == FK_SUB32 || BK == FK_SUB64) &&
        !(KeptC && (C == CondClass::UGE || C == CondClass::ULT || C == CondClass::UGT || C == CondClass::ULE))) {
      const bool W = BK == FK_SUB32;
      auto Cmp = [&](uint8_t Op32, uint8_t Op64) {
        B.get(FA);
        if (W) {
          B.u8(op::i32_wrap_i64);
        }
        B.get(FB);
        if (W) {
          B.u8(op::i32_wrap_i64);
        }
        B.u8(W ? Op32 : Op64);
      };
      switch (C) {
      case CondClass::EQ: Cmp(op::i32_eq, op::i64_eq); return;
      case CondClass::NEQ: Cmp(op::i32_ne, op::i64_ne); return;
      case CondClass::UGE: Cmp(op::i32_ge_u, op::i64_ge_u); return;
      case CondClass::ULT: Cmp(op::i32_lt_u, op::i64_lt_u); return;
      case CondClass::UGT: Cmp(op::i32_gt_u, op::i64_gt_u); return;
      case CondClass::ULE: Cmp(op::i32_le_u, op::i64_le_u); return;
      case CondClass::SGE: Cmp(op::i32_ge_s, op::i64_ge_s); return;
      case CondClass::SLT: Cmp(op::i32_lt_s, op::i64_lt_s); return;
      case CondClass::SGT: Cmp(op::i32_gt_s, op::i64_gt_s); return;
      case CondClass::SLE: Cmp(op::i32_le_s, op::i64_le_s); return;
      default: break;
      }
    }
    if (FlagsKnown && !KeptC && (BK == FK_LOGIC32 || BK == FK_LOGIC64)) { // (an inverted carry doesn't matter here)
      const bool W = BK == FK_LOGIC32;
      auto Val = [&] {
        B.get(FA);
        if (W) {
          B.u8(op::i32_wrap_i64);
        }
      };
      switch (C) {
      case CondClass::EQ: Val(); B.u8(W ? op::i32_eqz : op::i64_eqz); return;
      case CondClass::NEQ:
        Val();
        B.u8(W ? op::i32_eqz : op::i64_eqz);
        B.u8(op::i32_eqz);
        return;
      case CondClass::MI:
        Val();
        if (W) {
          B.i32c(0);
          B.u8(op::i32_lt_s);
        } else {
          B.i64c(0);
          B.u8(op::i64_lt_s);
        }
        return;
      case CondClass::PL:
        Val();
        if (W) {
          B.i32c(0);
          B.u8(op::i32_ge_s);
        } else {
          B.i64c(0);
          B.u8(op::i64_ge_s);
        }
        return;
      default: break;
      }
    }
  materialise:
    Materialize();
    auto Not = [&] { B.u8(op::i32_eqz); };
    switch (C) {
    case CondClass::EQ: NZCVBit(30); return;
    case CondClass::NEQ: NZCVBit(30); Not(); return;
    case CondClass::UGE: NZCVBit(29); return;
    case CondClass::ULT: NZCVBit(29); Not(); return;
    case CondClass::MI: NZCVBit(31); return;
    case CondClass::PL: NZCVBit(31); Not(); return;
    case CondClass::FU:
    case CondClass::VS: NZCVBit(28); return;
    case CondClass::FNU:
    case CondClass::VC: NZCVBit(28); Not(); return;
    case CondClass::UGT: // C && !Z
      NZCVBit(29);
      NZCVBit(30);
      Not();
      B.u8(op::i32_and);
      return;
    case CondClass::ULE: // !C || Z
      NZCVBit(29);
      Not();
      NZCVBit(30);
      B.u8(op::i32_or);
      return;
    case CondClass::FGE:
    case CondClass::SGE: // N == V
      NZCVBit(31);
      NZCVBit(28);
      B.u8(op::i32_eq);
      return;
    case CondClass::FLU:
    case CondClass::SLT: // N != V
      NZCVBit(31);
      NZCVBit(28);
      B.u8(op::i32_ne);
      return;
    case CondClass::FGT:
    case CondClass::SGT: // !Z && N == V
      NZCVBit(30);
      Not();
      NZCVBit(31);
      NZCVBit(28);
      B.u8(op::i32_eq);
      B.u8(op::i32_and);
      return;
    case CondClass::FLEU:
    case CondClass::SLE: // Z || N != V
      NZCVBit(30);
      NZCVBit(31);
      NZCVBit(28);
      B.u8(op::i32_ne);
      B.u8(op::i32_or);
      return;
    default: B.i32c(0); Err = Err.empty() ? "unsupported condition" : Err; return;
    }
  }

  // Integer compare of two GPR operands for Select.
  void IntCompare(CondClass C, OpSize Size, OrderedNodeWrapper A, OrderedNodeWrapper Bw) {
    const bool W = Size != OpSize::i64Bit;
    if (W) {
      GPR32(A);
      GPR32(Bw);
    } else {
      GPR(A);
      GPR(Bw);
    }
    switch (C) {
    case CondClass::EQ: B.u8(W ? op::i32_eq : op::i64_eq); break;
    case CondClass::NEQ: B.u8(W ? op::i32_ne : op::i64_ne); break;
    case CondClass::UGE: B.u8(W ? op::i32_ge_u : op::i64_ge_u); break;
    case CondClass::ULT: B.u8(W ? op::i32_lt_u : op::i64_lt_u); break;
    case CondClass::UGT: B.u8(W ? op::i32_gt_u : op::i64_gt_u); break;
    case CondClass::ULE: B.u8(W ? op::i32_le_u : op::i64_le_u); break;
    case CondClass::SGE: B.u8(W ? op::i32_ge_s : op::i64_ge_s); break;
    case CondClass::SLT: B.u8(W ? op::i32_lt_s : op::i64_lt_s); break;
    case CondClass::SGT: B.u8(W ? op::i32_gt_s : op::i64_gt_s); break;
    case CondClass::SLE: B.u8(W ? op::i32_le_s : op::i64_le_s); break;
    default:
      B.u8(op::drop);
      B.u8(op::drop);
      B.i32c(0);
      if (Err.empty()) {
        Err = "unsupported Select condition";
      }
      break;
    }
  }

  // fcmp + condition on scalar lane 0 of two FPR operands (arm64 semantics:
  // unordered sets C and V).
  bool FloatCompare(CondClass C, OpSize Size, OrderedNodeWrapper A, OrderedNodeWrapper Bw) {
    const bool D = Size == OpSize::i64Bit;
    auto Lane = [&](OrderedNodeWrapper W) { Lane0F(W, D); };
    const uint8_t Eq = D ? 0x61 : 0x5b, Ne = D ? 0x62 : 0x5c, Gt = D ? 0x64 : 0x5e, Ge = D ? 0x66 : 0x60;
    auto Ordered = [&] { // a == a && b == b
      Lane(A);
      Lane(A);
      B.u8(Eq);
      Lane(Bw);
      Lane(Bw);
      B.u8(Eq);
      B.u8(op::i32_and);
    };
    switch (C) {
    case CondClass::EQ: Lane(A); Lane(Bw); B.u8(Eq); return true;
    case CondClass::NEQ: Lane(A); Lane(Bw); B.u8(Ne); return true;
    case CondClass::FGT: Lane(A); Lane(Bw); B.u8(Gt); return true;
    case CondClass::FGE: Lane(A); Lane(Bw); B.u8(Ge); return true;
    case CondClass::FLU: Lane(A); Lane(Bw); B.u8(Ge); B.u8(op::i32_eqz); return true;  // less or unordered
    case CondClass::FLEU: Lane(A); Lane(Bw); B.u8(Gt); B.u8(op::i32_eqz); return true; // less, equal or unordered
    case CondClass::FNU: Ordered(); return true;
    case CondClass::FU: Ordered(); B.u8(op::i32_eqz); return true;
    default: return false;
    }
  }

  // Pushes Src shifted left so an (8|16)-bit value's sign bit sits at bit 31,
  // as FEX's arm64 backend does for sub-32-bit flag computation.
  void ShiftedSmall(OrderedNodeWrapper Src, OpSize Size) {
    GPR(Src);
    B.i64c(32 - Bits(Size));
    B.u8(op::i64_shl);
    B.i64c(0xFFFF'FFFF);
    B.u8(op::i64_and);
  }
  void Mask32IfNeeded(OpSize Size) {
    if (Size != OpSize::i64Bit) {
      B.i64c(0xFFFF'FFFF);
      B.u8(op::i64_and);
    }
  }

  // Stores the guest state that may have been modified on the way to this exit.
  uint64_t ExitMask() const {
    if (!Structured) {
      return ~0ull;
    }
    return MaybeWrittenIn[CurBlock] | BlockWrites[CurBlock] | InheritedMask;
  }
  void Epilogue() {
    const size_t Start = B.size();
    struct Count {
      ~Count() {
        if (ENV_FLAG("FEXWASM_SIZESTATS")) {
          fprintf(stderr, "epilogue bytes %zu (%zu exits)\n", Bytes, N);
        }
      }
      size_t Bytes = 0, N = 0;
    };
    static Count C;
    struct Add {
      Buf& B;
      size_t Start;
      ~Add() {
        C.Bytes += B.size() - Start;
        C.N++;
      }
    } A {B, Start};
    const uint64_t Mask = ExitMask() & ExitLive;
    for (uint32_t R = 0; R < NUM_XMM; R++) {
      if (XWritten[R] && (Mask >> (XMM_BIT + R) & 1)) {
        SysBase();
        B.get(X[R]);
        Simd(0x0b); // v128.store
        B.u32(0);
        B.u32(Cfg.CtxAddr + offsetof(CPUState, xmm) + 16 * R);
      }
    }
    if (FlagsTouched && (Mask >> FLAGS_BIT & 1) && !SkipFlagSpill) { // spill the lazy flag state as is
      SysBase();
      B.get(NZCV);
      B.mem(op::i32_store, 2, Cfg.NZCVAddr);
      SysBase();
      B.get(FK);
      B.mem(op::i32_store, 2, Cfg.FlagSpillAddr);
      SysBase();
      B.get(FA);
      B.mem(op::i64_store, 3, Cfg.FlagSpillAddr + 8);
      SysBase();
      B.get(FB);
      B.mem(op::i64_store, 3, Cfg.FlagSpillAddr + 16);
    }
    for (uint32_t R = 0; R < NUM_STATIC; R++) {
      if (IsArgReg(R) || !GWritten[R] || !(Mask >> R & 1) || (SkipFlagSpill && (R == PF_REG || R == AF_REG))) {
        continue;
      }
      SysBase();
      B.get(G[R]);
      if (R == PF_REG) {
        B.mem(op::i64_store32, 2, Cfg.CtxAddr + offsetof(CPUState, pf_raw));
      } else if (R == AF_REG) {
        B.mem(op::i64_store32, 2, Cfg.CtxAddr + offsetof(CPUState, af_raw));
      } else {
        B.mem(op::i64_store, 3, Cfg.CtxAddr + offsetof(CPUState, gregs) + 8 * R);
      }
    }
  }
  // The function's own prologue: at a call target (a function entry) the
  // flags are dead under ABILocalFlags, so they aren't loaded.
  void EntryPrologue() {
    const bool Dead = Cfg.ABILocalFlags && Cfg.CallTargetSet && Cfg.CallTargetSet->count(Entry);
    SkipFlagSpill = Dead;
    Prologue(LivenessOK && !LiveIn.empty() ? LiveIn[0] : ~0ull); // only what the code may read first
    SkipFlagSpill = false;
  }
  void Prologue(uint64_t Live = ~0ull) {
    if (FlagsTouched && !SkipFlagSpill && (Live >> FLAGS_BIT & 1)) {
      SysBase();
      B.mem(op::i32_load, 2, Cfg.NZCVAddr);
      B.set(NZCV);
      SysBase();
      B.mem(op::i32_load, 2, Cfg.FlagSpillAddr);
      B.set(FK);
      SysBase();
      B.mem(op::i64_load, 3, Cfg.FlagSpillAddr + 8);
      B.set(FA);
      SysBase();
      B.mem(op::i64_load, 3, Cfg.FlagSpillAddr + 16);
      B.set(FB);
    }
    for (uint32_t R = 0; R < NUM_XMM; R++) {
      if (XUsed[R] && (Live & XBit(R))) {
        SysBase();
        Simd(0x00); // v128.load
        B.u32(0);
        B.u32(Cfg.CtxAddr + offsetof(CPUState, xmm) + 16 * R);
        B.set(X[R]);
      }
    }
    for (uint32_t R = 0; R < NUM_STATIC; R++) {
      if (IsArgReg(R) || !GUsed[R] || !(Live & RegBit(R)) || (SkipFlagSpill && (R == PF_REG || R == AF_REG))) {
        continue;
      }
      SysBase();
      if (R == PF_REG) {
        B.mem(op::i64_load32_u, 2, Cfg.CtxAddr + offsetof(CPUState, pf_raw));
      } else if (R == AF_REG) {
        B.mem(op::i64_load32_u, 2, Cfg.CtxAddr + offsetof(CPUState, af_raw));
      } else {
        B.mem(op::i64_load, 3, Cfg.CtxAddr + offsetof(CPUState, gregs) + 8 * R);
      }
      B.set(G[R]);
    }
  }
  // Irreducible units run their blocks from a loop { br_table Blk }.
  static constexpr uint32_t DISPATCH_LABEL = 0xFFFF'FFF0;
  void GoToBlock() { // Blk already set; branch back to the unit's dispatch loop.
    B.u8(op::br);
    B.u32(Depth(CtxKind::LoopHeadedBy, DISPATCH_LABEL));
  }
  // Continue in block To (a successor of From).
  void BranchToBlock(uint32_t From, uint32_t To) {
    if (Structured) {
      DoBranch(From, To);
      return;
    }
    B.i32c(int32_t(To));
    B.set(Blk);
    GoToBlock();
  }
  void EmitBody();
  uint32_t TargetIndex(OrderedNodeWrapper W) {
    return BlockIndex.at(ID(W));
  }

  void EmitOp(Ref Node, const IROp_Header* IROp);
  void EmitOpImpl(Ref Node, const IROp_Header* IROp);
  bool EmitVectorOp(Ref Node, const IROp_Header* IROp);
  // Demanded bytes of each vector value (bit i: byte i is read by someone),
  // by node ID, from a backward pass over the unit (ComputeDemand). A scalar
  // SSE op's result then skips the merge into its register's upper lanes,
  // and a movss/movsd load their zeroing, when nothing reads those lanes.
  // Empty: everything is demanded.
  std::vector<uint32_t> Demand;
  // Per xmm register, the bytes read from the entry block on (an inlined
  // call's demand at its call site).
  std::array<uint32_t, NUM_XMM> EntryDemand;
  uint32_t CurDemand = ~0u; // of the op being emitted
  void ComputeDemand();
  bool ShuffleMap(const IROp_Header* IROp, uint8_t (&Map)[16], OrderedNodeWrapper& A, OrderedNodeWrapper& Bv) const;
  uint32_t DemandOf(Ref Node) const {
    const uint32_t Id = ID(Node);
    return Id < Demand.size() ? Demand[Id] : ~0u;
  }
  // Nothing reads the node's bytes at and above Bytes.
  bool UpperDead(Ref Node, uint32_t Bytes) const {
    return !Demand.empty() && (DemandOf(Node) & ~((1u << Bytes) - 1)) == 0;
  }
  // Scalar insert of the current node: with UpperDead the vector operand isn't
  // pushed, and the result is the scalar splatted.
  bool InsertSplat = false;

  // ---- control flow ----
  bool BuildCFG();
  void EmitBlockOps(uint32_t X);
  void DoTree(uint32_t X);
  void NodeWithin(uint32_t X, const std::vector<uint32_t>& Ys, size_t From);
  void DoBranch(uint32_t From, uint32_t To);
  uint32_t Depth(CtxKind K, uint32_t Label) const {
    const uint32_t Own = K == CtxKind::RegionLoop || K == CtxKind::RegionBlock || K == CtxKind::RegionLoopHead ? RegionOwner : Owner;
    for (size_t i = Context.size(); i-- > 0;) {
      if (Context[i].Kind == K && Context[i].Label == Label && Context[i].Owner == Own) {
        return uint32_t(Context.size() - 1 - i);
      }
    }
    return UINT32_MAX;
  }
  // For a guest call exit (hint Call, constant return address, return block in
  // this unit), the index of the block where execution continues.
  bool CallReturnIndex(const IROp_ExitFunction* Op, uint32_t* Index, uint64_t* RetAddr = nullptr) const {
    if (!Cfg.CallsViaDispatcher || Op->Hint != BranchHint::Call || Op->CallReturnBlock.IsInvalid() || Op->CallReturnAddress.IsInvalid()) {
      return false;
    }
    auto* H = IR.GetOp<IROp_Header>(Op->CallReturnAddress);
    uint64_t Addr;
    if (H->Op == OP_INLINECONSTANT) {
      Addr = H->C<IROp_InlineConstant>()->Constant;
      S.NonRelocatable = true;
    } else if (H->Op == OP_INLINEENTRYPOINTOFFSET) {
      Addr = Entry + H->C<IROp_InlineEntrypointOffset>()->Offset;
    } else if (H->Op == OP_ENTRYPOINTOFFSET) {
      Addr = Entry + H->C<IROp_EntrypointOffset>()->Offset;
    } else if (H->Op == OP_CONSTANT) {
      Addr = H->C<IROp_Constant>()->Constant;
      S.NonRelocatable = true;
    } else {
      return false;
    }
    auto It = BlockIndex.find(ID(Op->CallReturnBlock));
    if (It == BlockIndex.end()) {
      return false;
    }
    *Index = It->second;
    if (RetAddr) {
      *RetAddr = Addr;
    }
    return true;
  }
  // A call's return address (also for a call that ends the unit).
  bool CallRetAddr(const IROp_ExitFunction* Op, uint64_t* Addr, bool* Rel = nullptr) const {
    return Op->Hint == BranchHint::Call && !Op->CallReturnAddress.IsInvalid() && ConstRIP(Op->CallReturnAddress, Addr, Rel);
  }
  // A constant RIP; Rel: it is relative to the code (FEX's EntrypointOffset),
  // not an absolute constant of it.
  bool ConstRIP(OrderedNodeWrapper W, uint64_t* V, bool* Rel = nullptr) const {
    auto* H = IR.GetOp<IROp_Header>(W);
    bool R = false;
    switch (H->Op) {
    case OP_INLINECONSTANT: *V = H->C<IROp_InlineConstant>()->Constant; break;
    case OP_CONSTANT: *V = H->C<IROp_Constant>()->Constant; break;
    case OP_INLINEENTRYPOINTOFFSET: *V = Entry + H->C<IROp_InlineEntrypointOffset>()->Offset; R = true; break;
    case OP_ENTRYPOINTOFFSET: *V = Entry + H->C<IROp_EntrypointOffset>()->Offset; R = true; break;
    default: return false;
    }
    if (Rel) {
      *Rel = R;
    }
    return true;
  }
  // A RIP constant; Rel (relative to the code): displaced by e.d in a
  // relocatable unit. Mask32: a 32-bit RIP (kept to 32 bits).
  void RipConst(uint64_t V, bool Wide, bool Rel = true, bool Mask32 = false) {
    if (Wide) {
      B.i64c(int64_t(V));
    } else {
      B.i32c(int32_t(uint32_t(V)));
    }
    if (S.RelocOn && Rel) {
      B.get(Wide ? S.Delta64 : S.Delta32);
      B.u8(Wide ? op::i64_add : op::i32_add);
      if (Wide && Mask32) {
        B.i64c(0xFFFF'FFFFll);
        B.u8(op::i64_and);
      }
    }
  }
  uint32_t DeltaGlobal() const { return Cfg.ThreadBaseGlobal ? 1 : 0; } // e.d, after e.tb
  // Reloads guest state after a call returned (the callee may have changed any of it).
  void ReloadState(uint64_t Live = ~0ull) {
    Prologue(Live);
    FlagsKnown = false;
  }

  void BranchTo(uint32_t Target) {
    if (Structured) {
      DoBranch(CurBlock, Target);
      return;
    }
    B.i32c(int32_t(Target));
    B.set(Blk);
    GoToBlock();
  }
  // Condition (i32) is on the stack.
  void CondBranch(uint32_t T, uint32_t F) {
    if (Structured) {
      const uint32_t X = CurBlock;
      B.u8(op::if_);
      B.u8(0x40);
      Context.push_back({CtxKind::If, 0, Owner});
      DoBranch(X, T);
      B.u8(op::else_);
      DoBranch(X, F);
      Context.pop_back();
      B.u8(op::end);
      return;
    }
    B.set(TC);
    B.i32c(int32_t(T));
    B.i32c(int32_t(F));
    B.get(TC);
    B.u8(op::select);
    B.set(Blk);
    GoToBlock();
  }
  void EmitBinary(Ref Node, const IROp_Header* IROp, uint8_t Op32, uint8_t Op64, OrderedNodeWrapper S1, OrderedNodeWrapper S2);
  Buf MatFunction();
};

void Emitter::EmitBinary(Ref Node, const IROp_Header* IROp, uint8_t Op32, uint8_t Op64, OrderedNodeWrapper S1, OrderedNodeWrapper S2) {
  if (IROp->Size == OpSize::i64Bit) {
    GPR(S1);
    GPR(S2);
    B.u8(Op64);
  } else {
    GPR32(S1);
    GPR32(S2);
    B.u8(Op32);
    B.u8(op::i64_extend_i32_u);
  }
  SetNode(Node);
}

static std::unordered_map<std::string, std::pair<size_t, size_t>>& OpBytesStats() {
  static struct Holder {
    std::unordered_map<std::string, std::pair<size_t, size_t>> M;
    ~Holder() {
      if (!ENV_FLAG("FEXWASM_SIZESTATS")) {
        return;
      }
      std::vector<std::pair<std::string, std::pair<size_t, size_t>>> V(M.begin(), M.end());
      std::sort(V.begin(), V.end(), [](auto& A, auto& B) { return A.second.first > B.second.first; });
      size_t T = 0;
      for (auto& E : V) {
        T += E.second.first;
      }
      fprintf(stderr, "op bytes total %zu\n", T);
      for (size_t i = 0; i < V.size() && i < 25; i++) {
        fprintf(stderr, "  %-28s %7zu bytes %6zu ops %5.1f/op\n", V[i].first.c_str(), V[i].second.first, V[i].second.second,
                double(V[i].second.first) / double(V[i].second.second));
      }
    }
  } H;
  return H.M;
}

void Emitter::EmitOp(Ref Node, const IROp_Header* IROp) {
  const size_t StatStart = B.size();
  struct StatAdd {
    Buf& B;
    size_t Start;
    const IROp_Header* Op;
    ~StatAdd() {
      static const bool Stats = getenv("FEXWASM_SIZESTATS");
      if (Stats) {
        auto& E = OpBytesStats()[std::string(GetName(Op->Op))];
        E.first += B.size() - Start;
        E.second++;
      }
    }
  } StatGuard {B, StatStart, IROp};
  CurOpName = GetName(IROp->Op).data();
  CurMemoryOp = uint32_t(IROp->Op); CurMemorySize = uint32_t(IROp->Size);
  OpsInBlock++;
  EmitOpImpl(Node, IROp);
}

void Emitter::EmitOpImpl(Ref Node, const IROp_Header* IROp) {
  const OpSize Size = IROp->Size;
  const bool Is64 = Size == OpSize::i64Bit;
  switch (IROp->Op) {
  case OP_IRHEADER:
  case OP_CODEBLOCK:
  case OP_BEGINBLOCK:
  case OP_ENDBLOCK:
  case OP_INVALIDATEFLAGS:
  case OP_INLINECONSTANT:
  case OP_INLINEENTRYPOINTOFFSET: break;
  case OP_GUESTOPCODE:
    CurGuestOffset = IROp->C<IROp_GuestOpcode>()->GuestEntryOffset;
    break;

  case OP_CONSTANT:
    B.i64c(int64_t(IROp->C<IROp_Constant>()->Constant));
    SetNode(Node);
    break;
  case OP_ENTRYPOINTOFFSET: {
    uint64_t V = Entry + IROp->C<IROp_EntrypointOffset>()->Offset;
    if (Size == OpSize::i32Bit) {
      V &= 0xFFFF'FFFFull;
    }
    RipConst(V, true, true, Size == OpSize::i32Bit);
    SetNode(Node);
    break;
  }
  case OP_LOADREGISTER: {
    auto Op = IROp->C<IROp_LoadRegister>();
    if (Op->Class == RegClass::FPR && Op->Reg < NUM_XMM) {
      if (auto It = XRegStored.find(Op->Reg); It != XRegStored.end()) {
        LoadAlias[ID(Node)] = It->second;
      }
      if (RegAliased.count(ID(Node))) { // reads the register's local directly
        NodeVLocal[ID(Node)] = X[Op->Reg];
        break;
      }
      B.get(X[Op->Reg]);
      SetV(Node);
      break;
    }
    if (Op->Class != RegClass::GPR || Op->Reg >= NUM_STATIC) {
      return Fail(IROp);
    }
    if (auto It = RegStored.find(Op->Reg); It != RegStored.end()) {
      LoadAlias[ID(Node)] = It->second; // the value this block last stored there
    }
    if (RegAliased.count(ID(Node))) { // reads the register's local directly
      NodeLocal[ID(Node)] = G[Op->Reg];
      break;
    }
    B.get(G[Op->Reg]);
    SetNode(Node);
    break;
  }
  case OP_STOREREGISTER: {
    auto Op = IROp->C<IROp_StoreRegister>();
    auto Phys = PhysicalRegister(Node);
    if (Phys.AsRegClass() == RegClass::FPRFixed && Phys.Reg < NUM_XMM) {
      XRegStored[Phys.Reg] = Op->Value;
      const bool Stacked = StackTop == ID(Op->Value);
      FPR(Op->Value);
      if (Stacked) {
        NodeVLocal[ID(Op->Value)] = X[Phys.Reg];
      }
      if (Node->GetUses() == 0) {
        RegSetAt = B.size();
        B.set(X[Phys.Reg]);
        RegSetEnd = B.size();
        RegSetLocal = X[Phys.Reg];
        break;
      }
      B.tee(X[Phys.Reg]);
      SetV(Node);
      break;
    }
    if (Phys.AsRegClass() != RegClass::GPRFixed || Phys.Reg >= NUM_STATIC) {
      return Fail(IROp);
    }
    RegStored[Phys.Reg] = Op->Value;
    const bool Stacked = StackTop == ID(Op->Value);
    GPR(Op->Value);
    if (Stacked) {
      NodeLocal[ID(Op->Value)] = G[Phys.Reg]; // its value is the register's now
    }
    if (Node->GetUses() == 0) {
      RegSetAt = B.size();
      B.set(G[Phys.Reg]);
      RegSetEnd = B.size();
      RegSetLocal = G[Phys.Reg];
      break;
    }
    B.tee(G[Phys.Reg]);
    SetNode(Node);
    break;
  }
  case OP_LOADPF:
    B.get(G[PF_REG]);
    SetNode(Node);
    break;
  case OP_LOADAF:
    B.get(G[AF_REG]);
    SetNode(Node);
    break;
  case OP_STOREPF:
    GPR(IROp->C<IROp_StorePF>()->Value);
    B.set(G[PF_REG]);
    break;
  case OP_STOREAF:
    GPR(IROp->C<IROp_StoreAF>()->Value);
    B.set(G[AF_REG]);
    break;
  case OP_LOADNZCV: {
    // inc/dec keep the carry: LoadNZCV -> Bfi(C) -> StoreNZCV becomes a lazy
    // ...K kind with the new carry in NZCV bit 29.
    const IROp_Header *Next = nullptr, *Next2 = nullptr;
    Ref NextNode {}, Next2Node {};
    const bool LogicKind = BaseKind(KnownKind) == FK_LOGIC32 || BaseKind(KnownKind) == FK_LOGIC64;
    if (FlagsKnown && KnownKind != FK_MAT && Node->GetUses() == 1) {
      bool Found = false;
      for (auto [CodeNode, Op] : IR.GetCode(Blocks[CurBlock].Node)) {
        if (Found && (Op->Op == OP_INLINECONSTANT || Op->Op == OP_INLINEENTRYPOINTOFFSET)) {
          continue; // operands, not code
        }
        if (Found && !Next) {
          Next = Op;
          NextNode = CodeNode;
        } else if (Next && !Next2) {
          Next2 = Op;
          Next2Node = CodeNode;
          break;
        }
        Found |= CodeNode == Node;
      }
    }
    if (Next && Next2 && Next->Op == OP_XOR && Next2->Op == OP_STORENZCV && NextNode->GetUses() == 1) {
      // LoadNZCV -> Xor(1 << 29) -> StoreNZCV: invert the carry, lazily.
      auto X = Next->C<IROp_Xor>();
      uint64_t Mask;
      if (IR.GetNode(X->Src1) == Node && IsConst(X->Src2, &Mask) && Mask == (1u << 29) &&
          IR.GetNode(Next2->C<IROp_StoreNZCV>()->Value) == NextNode) {
        SetFlags(FlagKind(KnownKind ^ FK_CINV));
        SkipNodes.insert(ID(NextNode));
        SkipNodes.insert(ID(Next2Node));
        break;
      }
    }
    if (Next && Next2 && Next->Op == OP_BFI && Next2->Op == OP_STORENZCV && NextNode->GetUses() == 1 && !LogicKind &&
        !IsFloatKind(KnownKind)) {
      auto Bf = Next->C<IROp_Bfi>();
      if (Bf->lsb == 29 && Bf->Width == 1 && IR.GetNode(Bf->Dest) == Node && IR.GetNode(Next2->C<IROp_StoreNZCV>()->Value) == NextNode) {
        GPR32(Bf->Src);
        B.i32c(1);
        B.u8(op::i32_and);
        B.i32c(29);
        B.u8(op::i32_shl);
        B.set(NZCV);
        const FlagKind BK = BaseKind(KnownKind);
        SetFlags(FlagKind(BK - FK_SUB32 + FK_SUB32K)); // the new C is the Bfi'd value itself
        SkipNodes.insert(ID(NextNode));
        SkipNodes.insert(ID(Next2Node));
        break;
      }
    }
    Materialize();
    B.get(NZCV);
    B.u8(op::i64_extend_i32_u);
    SetNode(Node);
    break;
  }
  case OP_STORENZCV:
    GPR32(IROp->C<IROp_StoreNZCV>()->Value);
    B.set(NZCV);
    SetFlags(FK_MAT);
    break;
  case OP_LOADDF:
    SysBase();
    B.mem(op::i64_load8_s, 0, Cfg.CtxAddr + offsetof(CPUState, flags) + FEXCore::X86State::RFLAG_DF_RAW_LOC);
    SetNode(Node);
    break;
  case OP_ALLOCATEGPR:
    B.i64c(0);
    SetNode(Node);
    break;
  case OP_RMWHANDLE:
    GPR(IROp->Args[0]);
    SetNode(Node);
    break;

  // ---- ALU ----
  case OP_ADD: {
    auto Op = IROp->C<IROp_Add>();
    EmitBinary(Node, IROp, op::i32_add, op::i64_add, Op->Src1, Op->Src2);
    break;
  }
  case OP_SUB: {
    auto Op = IROp->C<IROp_Sub>();
    EmitBinary(Node, IROp, op::i32_sub, op::i64_sub, Op->Src1, Op->Src2);
    break;
  }
  case OP_AND: {
    auto Op = IROp->C<IROp_And>();
    EmitBinary(Node, IROp, op::i32_and, op::i64_and, Op->Src1, Op->Src2);
    break;
  }
  case OP_OR: {
    auto Op = IROp->C<IROp_Or>();
    EmitBinary(Node, IROp, op::i32_or, op::i64_or, Op->Src1, Op->Src2);
    break;
  }
  case OP_XOR: {
    auto Op = IROp->C<IROp_Xor>();
    EmitBinary(Node, IROp, op::i32_xor, op::i64_xor, Op->Src1, Op->Src2);
    break;
  }
  case OP_LSHL: {
    auto Op = IROp->C<IROp_Lshl>();
    EmitBinary(Node, IROp, op::i32_shl, op::i64_shl, Op->Src1, Op->Src2);
    break;
  }
  case OP_LSHR: {
    auto Op = IROp->C<IROp_Lshr>();
    EmitBinary(Node, IROp, op::i32_shr_u, op::i64_shr_u, Op->Src1, Op->Src2);
    break;
  }
  case OP_ASHR: {
    auto Op = IROp->C<IROp_Ashr>();
    EmitBinary(Node, IROp, op::i32_shr_s, op::i64_shr_s, Op->Src1, Op->Src2);
    break;
  }
  case OP_ROR: {
    auto Op = IROp->C<IROp_Ror>();
    EmitBinary(Node, IROp, op::i32_rotr, op::i64_rotr, Op->Src1, Op->Src2);
    break;
  }
  case OP_MUL: {
    auto Op = IROp->C<IROp_Mul>();
    EmitBinary(Node, IROp, op::i32_mul, op::i64_mul, Op->Src1, Op->Src2);
    break;
  }
  case OP_ANDN: {
    auto Op = IROp->C<IROp_Andn>();
    if (Is64) {
      GPR(Op->Src1);
      GPR(Op->Src2);
      B.i64c(-1);
      B.u8(op::i64_xor);
      B.u8(op::i64_and);
    } else {
      GPR32(Op->Src1);
      GPR32(Op->Src2);
      B.i32c(-1);
      B.u8(op::i32_xor);
      B.u8(op::i32_and);
      B.u8(op::i64_extend_i32_u);
    }
    SetNode(Node);
    break;
  }
  case OP_NOT: {
    GPR(IROp->C<IROp_Not>()->Src);
    B.i64c(-1);
    B.u8(op::i64_xor);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_NEG: {
    auto Op = IROp->C<IROp_Neg>();
    B.i64c(0);
    GPR(Op->Src);
    B.u8(op::i64_sub);
    if (Op->Cond != CondClass::AL) { // cneg: negate only when the condition holds
      GPR(Op->Src);
      Condition(Op->Cond);
      B.u8(op::select);
    }
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_ADDSHIFT: {
    auto Op = IROp->C<IROp_AddShift>();
    GPR(Op->Src1);
    GPR(Op->Src2);
    if (!Is64) {
      B.i64c(0xFFFF'FFFF);
      B.u8(op::i64_and);
    }
    if (Op->ShiftAmount) {
      B.i64c(Op->ShiftAmount);
      switch (Op->Shift) {
      case ShiftType::LSL: B.u8(op::i64_shl); break;
      case ShiftType::LSR: B.u8(op::i64_shr_u); break;
      case ShiftType::ASR:
        if (!Is64) {
          return Fail(IROp, "32-bit ASR in");
        }
        B.u8(op::i64_shr_s);
        break;
      default: return Fail(IROp);
      }
    }
    B.u8(op::i64_add);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_BFE: {
    auto Op = IROp->C<IROp_Bfe>();
    // The low bits of a Bfi into bit 0 (a partial register write such as
    // xorb) are its source's: movzbl after xorb reads the byte directly.
    OrderedNodeWrapper Src = Op->Src;
    if (Op->lsb == 0) {
      auto* D = IR.GetOp<IROp_Header>(Resolve(Src));
      if (D->Op == OP_BFI && D->C<IROp_Bfi>()->lsb == 0 && D->C<IROp_Bfi>()->Width >= Op->Width) {
        Src = D->C<IROp_Bfi>()->Src;
      }
    }
    GPR(Src);
    if (Op->lsb) {
      B.i64c(Op->lsb);
      B.u8(op::i64_shr_u);
    }
    if (Op->Width < 64) {
      B.i64c(int64_t((1ull << Op->Width) - 1));
      B.u8(op::i64_and);
    }
    SetNode(Node);
    break;
  }
  case OP_SBFE: {
    auto Op = IROp->C<IROp_Sbfe>();
    OrderedNodeWrapper Src = Op->Src; // as Bfe: see through a Bfi into bit 0
    if (Op->lsb == 0) {
      auto* D = IR.GetOp<IROp_Header>(Resolve(Src));
      if (D->Op == OP_BFI && D->C<IROp_Bfi>()->lsb == 0 && D->C<IROp_Bfi>()->Width >= Op->Width) {
        Src = D->C<IROp_Bfi>()->Src;
      }
    }
    if (Is64) {
      GPR(Src);
      B.i64c(64 - Op->lsb - Op->Width);
      B.u8(op::i64_shl);
      B.i64c(64 - Op->Width);
      B.u8(op::i64_shr_s);
    } else {
      GPR32(Src);
      B.i32c(32 - Op->lsb - Op->Width);
      B.u8(op::i32_shl);
      B.i32c(32 - Op->Width);
      B.u8(op::i32_shr_s);
      B.u8(op::i64_extend_i32_u);
    }
    SetNode(Node);
    break;
  }
  case OP_BFI: {
    auto Op = IROp->C<IROp_Bfi>();
    const uint64_t Mask = (Op->Width >= 64 ? ~0ull : ((1ull << Op->Width) - 1)) << Op->lsb;
    GPR(Op->Dest);
    B.i64c(int64_t(~Mask));
    B.u8(op::i64_and);
    GPR(Op->Src);
    if (Op->lsb) {
      B.i64c(Op->lsb);
      B.u8(op::i64_shl);
    }
    B.i64c(int64_t(Mask));
    B.u8(op::i64_and);
    B.u8(op::i64_or);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }

  case OP_SMULL:
  case OP_UMULL: {
    const uint8_t Ext = IROp->Op == OP_SMULL ? op::i64_extend_i32_s : op::i64_extend_i32_u;
    GPR32(IROp->Args[0]);
    B.u8(Ext);
    GPR32(IROp->Args[1]);
    B.u8(Ext);
    B.u8(op::i64_mul);
    SetNode(Node);
    break;
  }
  case OP_MULH:
  case OP_UMULH: {
    const bool Signed = IROp->Op == OP_MULH;
    if (Is64) {
      GPR(IROp->Args[0]);
      GPR(IROp->Args[1]);
      Call(Signed ? FUNC_SMULH : FUNC_UMULH);
    } else {
      const uint8_t Ext = Signed ? op::i64_extend_i32_s : op::i64_extend_i32_u;
      GPR32(IROp->Args[0]);
      B.u8(Ext);
      GPR32(IROp->Args[1]);
      B.u8(Ext);
      B.u8(op::i64_mul);
      B.i64c(32);
      B.u8(Signed ? op::i64_shr_s : op::i64_shr_u);
      B.i64c(0xFFFF'FFFF);
      B.u8(op::i64_and);
    }
    SetNode(Node);
    break;
  }
  case OP_POPCOUNT:
    GPR(IROp->C<IROp_Popcount>()->Src);
    if (!Is64) {
      B.i64c(Size == OpSize::i8Bit ? 0xff : Size == OpSize::i16Bit ? 0xffff : 0xFFFF'FFFF);
      B.u8(op::i64_and);
    }
    B.u8(op::i64_popcnt);
    SetNode(Node);
    break;
  case OP_FINDLSB: // rbit + clz: trailing zeros, bit width for 0
    if (Is64) {
      GPR(IROp->C<IROp_FindLSB>()->Src);
      B.u8(op::i64_ctz);
    } else {
      GPR32(IROp->C<IROp_FindLSB>()->Src);
      B.u8(op::i32_ctz);
      B.u8(op::i64_extend_i32_u);
    }
    SetNode(Node);
    break;
  case OP_FINDMSB: { // (bits - 1) - clz, computed as a 64-bit value (0 gives -1)
    const uint32_t Bits_ = Bits(Size);
    B.i64c(Bits_ - 1);
    if (Is64) {
      GPR(IROp->C<IROp_FindMSB>()->Src);
      B.u8(op::i64_clz);
    } else {
      GPR32(IROp->C<IROp_FindMSB>()->Src);
      if (Size == OpSize::i16Bit) {
        B.i32c(16);
        B.u8(op::i32_shl);
      }
      B.u8(op::i32_clz);
      B.u8(op::i64_extend_i32_u);
    }
    B.u8(op::i64_sub);
    SetNode(Node);
    break;
  }
  case OP_FLOAT_TOGPR_ZS:
  case OP_FLOAT_TOGPR_S: {
    // fcvtzs saturates and maps NaN to 0, exactly like wasm trunc_sat.
    const auto* ZS = IROp->C<IROp_Float_ToGPR_ZS>();
    const bool SrcD = ZS->SrcElementSize == OpSize::i64Bit;
    Lane0F(ZS->Scalar, SrcD);
    if (IROp->Op == OP_FLOAT_TOGPR_S) {
      RoundByMode(SrcD, false);
    }
    B.fc(Is64 ? (SrcD ? 6 : 4) : (SrcD ? 2 : 0)); // i64/i32.trunc_sat_f64/f32_s
    if (!Is64) {
      B.u8(op::i64_extend_i32_u);
    }
    SetNode(Node);
    break;
  }

  case OP_SHIFTFLAGS: {
    // x86 shift flags: untouched when the masked count is 0; otherwise N/Z from
    // the result, C = last bit shifted out, V = sign change (not for SAR).
    auto Op = IROp->C<IROp_ShiftFlags>();
    const uint32_t W = Bits(Op->Size), EW = Op->Size == OpSize::i64Bit ? 64 : 32;
    const uint32_t PFOut = LocalFor(ID(Node));
    GPR(Op->PFInput);
    B.set(PFOut);
    GPR(Op->Src2);
    B.i64c(EW == 64 ? 0x3f : 0x1f);
    B.u8(op::i64_and);
    B.u8(op::i64_eqz);
    B.u8(op::i32_eqz);
    B.u8(op::if_);
    B.u8(0x40);
    {
      // Result as the flag-width value (sub-32-bit sizes shifted to bit 31).
      GPR(Op->Result);
      if (W < 32) {
        B.i64c(32 - W);
        B.u8(op::i64_shl);
      }
      if (W <= 32) {
        B.i64c(0xFFFF'FFFF);
        B.u8(op::i64_and);
      }
      B.set(T0);
      GPR(Op->Result);
      B.set(PFOut);
      // N | Z
      B.get(T0);
      B.i64c(W == 64 ? 63 : 31);
      B.u8(op::i64_shr_u);
      B.u8(op::i32_wrap_i64);
      B.i32c(31);
      B.u8(op::i32_shl);
      B.get(T0);
      B.u8(op::i64_eqz);
      B.i32c(30);
      B.u8(op::i32_shl);
      B.u8(op::i32_or);
      // C
      if (Op->Shift == ShiftType::LSL && W < 32) {
        GPR(Op->Result);
        B.i64c(W);
        B.u8(op::i64_shr_u);
      } else {
        GPR(Op->Src1);
        if (EW == 32) {
          B.i64c(0xFFFF'FFFF);
          B.u8(op::i64_and);
        }
        if (Op->Shift == ShiftType::LSL) { // Src1 >> (-count mod EW)
          B.i64c(0);
          GPR(Op->Src2);
          B.u8(op::i64_sub);
        } else { // Src1 >> (count - 1)
          GPR(Op->Src2);
          B.i64c(1);
          B.u8(op::i64_sub);
        }
        B.i64c(EW - 1);
        B.u8(op::i64_and);
        B.u8(op::i64_shr_u);
      }
      B.u8(op::i32_wrap_i64);
      if (Op->InvertCF) {
        B.i32c(-1);
        B.u8(op::i32_xor);
      }
      B.i32c(1);
      B.u8(op::i32_and);
      B.i32c(29);
      B.u8(op::i32_shl);
      B.u8(op::i32_or);
      // V
      if (Op->Shift != ShiftType::ASR) {
        GPR(Op->Src1);
        GPR(Op->Result);
        B.u8(op::i64_xor);
        B.i64c(W - 1);
        B.u8(op::i64_shr_u);
        B.u8(op::i32_wrap_i64);
        B.i32c(1);
        B.u8(op::i32_and);
        B.i32c(28);
        B.u8(op::i32_shl);
        B.u8(op::i32_or);
      }
      B.set(NZCV);
      B.i32c(FK_MAT);
      B.set(FK);
    }
    B.u8(op::end);
    FlagsKnown = false;
    break;
  }
  case OP_CONDSUBNZCV:
  case OP_CONDADDNZCV: {
    // ccmp/ccmn: flags of (a -/+ b) when Cond holds on the current flags,
    // otherwise the immediate FalseNZCV. Resolved at run time in the lazy state.
    const bool IsSub = IROp->Op == OP_CONDSUBNZCV;
    const auto* Op = IROp->C<IROp_CondSubNZCV>();
    Condition(Op->Cond);
    B.set(TC);
    const FlagKind K = IsSub ? (Is64 ? FK_SUB64 : FK_SUB32) : (Is64 ? FK_ADD64 : FK_ADD32);
    // Materialised right here: NZCV = c ? flags of (a op b) : FalseNZCV << 28.
    // (A lazy kind picked at run time would make the next flag reader call $mat.)
    GPR(Op->Src1);
    Mask32IfNeeded(Size);
    B.set(FA);
    GPR(Op->Src2);
    Mask32IfNeeded(Size);
    B.set(FB);
    EmitNZCVOfKind(B, K, FA, FB, T1, NZCV);
    B.i32c(int32_t(uint32_t(Op->FalseNZCV) << 28));
    B.get(TC);
    B.u8(op::select);
    B.set(NZCV);
    B.i32c(FK_MAT);
    B.set(FK);
    FlagsKnown = true;
    KnownKind = FK_MAT;
    break;
  }

  case OP_ALLOCATEGPRAFTER:
    B.i64c(0);
    SetNode(Node);
    break;
  case OP_ORLSHL:
  case OP_ORLSHR: {
    auto Op = IROp->C<IROp_Orlshl>();
    GPR(Op->Src1);
    Shifted(Op->Src2, IROp->Op == OP_ORLSHL ? ShiftType::LSL : ShiftType::LSR, Op->BitShift, Is64);
    B.u8(op::i64_or);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_XORSHIFT:
  case OP_SUBSHIFT: {
    auto Op = IROp->C<IROp_XorShift>();
    GPR(Op->Src1);
    if (!Shifted(Op->Src2, Op->Shift, Op->ShiftAmount, Is64)) {
      return Fail(IROp);
    }
    B.u8(IROp->Op == OP_XORSHIFT ? op::i64_xor : op::i64_sub);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_EXTR: {
    auto Op = IROp->C<IROp_Extr>();
    if (Is64) {
      GPR(Op->Lower);
      if (Op->LSB) {
        B.i64c(Op->LSB);
        B.u8(op::i64_shr_u);
        GPR(Op->Upper);
        B.i64c(64 - Op->LSB);
        B.u8(op::i64_shl);
        B.u8(op::i64_or);
      }
    } else {
      GPR(Op->Upper);
      B.i64c(32);
      B.u8(op::i64_shl);
      GPR(Op->Lower);
      B.i64c(0xFFFF'FFFF);
      B.u8(op::i64_and);
      B.u8(op::i64_or);
      B.i64c(Op->LSB);
      B.u8(op::i64_shr_u);
      B.i64c(0xFFFF'FFFF);
      B.u8(op::i64_and);
    }
    SetNode(Node);
    break;
  }
  case OP_PARITY: {
    // Same cascade as the arm64 backend, garbage upper bits included.
    auto Op = IROp->C<IROp_Parity>();
    GPR32(Op->Raw);
    B.tee(TC);
    B.get(TC);
    B.i32c(4);
    B.u8(op::i32_shr_u);
    B.u8(op::i32_xor);
    B.tee(TC);
    B.get(TC);
    B.i32c(2);
    B.u8(op::i32_shr_u);
    B.u8(op::i32_xor);
    B.tee(TC);
    B.get(TC);
    B.i32c(1);
    B.u8(op::i32_shr_u);
    if (Op->Invert) {
      B.i32c(-1);
      B.u8(op::i32_xor);
    }
    B.u8(op::i32_xor);
    if (Op->Mask) {
      B.i32c(1);
      B.u8(op::i32_and);
    }
    B.u8(op::i64_extend_i32_u);
    SetNode(Node);
    break;
  }
  case OP_NZCVSELECTINCREMENT: {
    auto Op = IROp->C<IROp_NZCVSelectIncrement>();
    GPR(Op->TrueVal);
    GPR(Op->FalseVal);
    B.i64c(1);
    B.u8(op::i64_add);
    Condition(Op->Cond);
    B.u8(op::select);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_FORMCONTEXTADDRESS: {
    auto Op = IROp->C<IROp_FormContextAddress>();
    GPR(Op->Index);
    B.i64c(Op->Stride);
    B.u8(op::i64_mul);
    B.i64c(Cfg.CtxAddr);
    B.u8(op::i64_add);
    SetNode(Node);
    break;
  }
  case OP_ADC:
  case OP_SBB:
  case OP_ADCWITHFLAGS:
  case OP_SBBWITHFLAGS:
  case OP_ADCNZCV:
  case OP_SBBNZCV: {
    // a + b + C, with b inverted for the subtracting forms (arm64 sbc).
    const bool Sub = IROp->Op == OP_SBB || IROp->Op == OP_SBBWITHFLAGS || IROp->Op == OP_SBBNZCV;
    const bool WantFlags = IROp->Op != OP_ADC && IROp->Op != OP_SBB;
    const bool WantResult = IROp->Op != OP_ADCNZCV && IROp->Op != OP_SBBNZCV;
    if (Size != OpSize::i32Bit && Size != OpSize::i64Bit) {
      return Fail(IROp);
    }
    const uint32_t W = Bits(Size);
    Materialize();
    GPR(IROp->Args[0]);
    Mask32IfNeeded(Size);
    B.set(T0);
    GPR(IROp->Args[1]);
    if (Sub) {
      B.i64c(-1);
      B.u8(op::i64_xor);
    }
    Mask32IfNeeded(Size);
    B.set(T1);
    B.get(T0);
    B.get(T1);
    B.u8(op::i64_add);
    NZCVBit(29);
    B.u8(op::i64_extend_i32_u);
    B.u8(op::i64_add);
    B.set(T2); // for 32 bits, the carry out is bit 32
    const uint32_t R = NewLocal(I64);
    B.get(T2);
    Mask32IfNeeded(Size);
    B.set(R);
    if (WantFlags) {
      if (W == 64) { // carry: c ? r <= a : r < a
        B.get(R);
        B.get(T0);
        B.u8(op::i64_le_u);
        B.get(R);
        B.get(T0);
        B.u8(op::i64_lt_u);
        NZCVBit(29);
        B.u8(op::select);
      } else {
        B.get(T2);
        B.i64c(32);
        B.u8(op::i64_shr_u);
        B.u8(op::i32_wrap_i64);
      }
      // overflow: ((a ^ r) & (b ^ r)) >> (W - 1)
      B.get(T0);
      B.get(R);
      B.u8(op::i64_xor);
      B.get(T1);
      B.get(R);
      B.u8(op::i64_xor);
      B.u8(op::i64_and);
      B.i64c(W - 1);
      B.u8(op::i64_shr_u);
      B.u8(op::i32_wrap_i64);
      B.i32c(1);
      B.u8(op::i32_and);
      SetNZCVFromResult(R, W);
    }
    if (WantResult) {
      B.get(R);
      SetNode(Node);
    }
    break;
  }
  case OP_ADDNZCV: {
    auto Op = IROp->C<IROp_AddNZCV>();
    if (Size < OpSize::i32Bit) {
      ShiftedSmall(Op->Src1, Size);
      B.set(FA);
      ShiftedSmall(Op->Src2, Size);
      B.set(FB);
      SetFlags(FK_ADD32);
      break;
    }
    GPR(Op->Src1);
    Mask32IfNeeded(Size);
    B.set(FA);
    GPR(Op->Src2);
    Mask32IfNeeded(Size);
    B.set(FB);
    SetFlags(Is64 ? FK_ADD64 : FK_ADD32);
    break;
  }
  case OP_ROTATEFLAGS: {
    // x86 rotate flags when the count is non-zero: C = (inverted) last bit
    // rotated in, V = MSB ^ (LSB for rol, MSB-1 for ror).
    auto Op = IROp->C<IROp_RotateFlags>();
    const uint32_t W = Bits(Op->Size);
    Materialize();
    GPR(Op->Shift);
    if (Op->Size != OpSize::i64Bit) {
      B.i64c(0xFFFF'FFFF);
      B.u8(op::i64_and);
    }
    B.u8(op::i64_eqz);
    B.u8(op::i32_eqz);
    B.u8(op::if_);
    B.u8(0x40);
    {
      B.get(NZCV);
      B.i32c(0xCFFF'FFFF);
      B.u8(op::i32_and);
      GPR(Op->Result);
      B.i64c(Op->Left ? 0 : W - 1);
      B.u8(op::i64_shr_u);
      B.u8(op::i32_wrap_i64);
      B.i32c(1);
      B.u8(op::i32_and);
      B.i32c(1);
      B.u8(op::i32_xor);
      B.i32c(29);
      B.u8(op::i32_shl);
      B.u8(op::i32_or);
      GPR(Op->Result);
      GPR(Op->Result);
      B.i64c(Op->Left ? W - 1 : 1);
      B.u8(op::i64_shr_u);
      B.u8(op::i64_xor);
      B.i64c(Op->Left ? 0 : W - 2);
      B.u8(op::i64_shr_u);
      B.u8(op::i32_wrap_i64);
      B.i32c(1);
      B.u8(op::i32_and);
      B.i32c(28);
      B.u8(op::i32_shl);
      B.u8(op::i32_or);
      B.set(NZCV);
    }
    B.u8(op::end);
    break;
  }

  case OP_UMUL: {
    auto Op = IROp->C<IROp_UMul>();
    EmitBinary(Node, IROp, op::i32_mul, op::i64_mul, Op->Src1, Op->Src2);
    break;
  }
  case OP_XORNSHIFT: {
    auto Op = IROp->C<IROp_XornShift>();
    GPR(Op->Src1);
    if (!Shifted(Op->Src2, Op->Shift, Op->ShiftAmount, Is64)) {
      return Fail(IROp);
    }
    B.i64c(-1);
    B.u8(op::i64_xor);
    B.u8(op::i64_xor);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_BFXIL: {
    // Dest with its low Width bits replaced by Src[lsb + Width - 1 : lsb].
    auto Op = IROp->C<IROp_Bfxil>();
    const uint64_t M = Op->Width >= 64 ? ~0ull : (1ull << Op->Width) - 1;
    GPR(Op->Dest);
    B.i64c(int64_t(~M));
    B.u8(op::i64_and);
    GPR(Op->Src);
    if (Op->lsb) {
      B.i64c(Op->lsb);
      B.u8(op::i64_shr_u);
    }
    B.i64c(int64_t(M));
    B.u8(op::i64_and);
    B.u8(op::i64_or);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_REV: {
    // Byte swap through a v128 shuffle (wasm has no bswap).
    GPR(IROp->C<IROp_Rev>()->Src);
    Simd(0x12); // i64x2.splat
    B.set(VLocalFor(ID(Node)));
    B.get(VLocalFor(ID(Node)));
    B.get(VLocalFor(ID(Node)));
    const uint8_t Idx64[16] = {7, 6, 5, 4, 3, 2, 1, 0, 8, 8, 8, 8, 8, 8, 8, 8};
    const uint8_t Idx32[16] = {3, 2, 1, 0, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8};
    Shuffle(Is64 ? Idx64 : Idx32);
    Simd(0x1d);
    B.u8(0);
    if (!Is64) {
      B.i64c(0xFFFF'FFFF);
      B.u8(op::i64_and);
    }
    if (Size == OpSize::i16Bit) {
      B.i64c(16);
      B.u8(op::i64_shr_u);
    }
    SetNode(Node);
    break;
  }
  case OP_RBIT: {
    // Bit reverse: swap adjacent bits, pairs, nibbles, then byte-swap.
    GPR(IROp->C<IROp_Rbit>()->Src);
    B.set(T0);
    const uint64_t Masks[3] = {0x5555'5555'5555'5555ull, 0x3333'3333'3333'3333ull, 0x0f0f'0f0f'0f0f'0f0full};
    for (uint32_t I = 0; I < 3; I++) {
      const int64_t Sh = 1 << I;
      B.get(T0);
      B.i64c(Sh);
      B.u8(op::i64_shr_u);
      B.i64c(int64_t(Masks[I]));
      B.u8(op::i64_and);
      B.get(T0);
      B.i64c(int64_t(Masks[I]));
      B.u8(op::i64_and);
      B.i64c(Sh);
      B.u8(op::i64_shl);
      B.u8(op::i64_or);
      B.set(T0);
    }
    B.get(T0);
    Simd(0x12);
    B.set(VLocalFor(ID(Node)));
    B.get(VLocalFor(ID(Node)));
    B.get(VLocalFor(ID(Node)));
    const uint8_t Idx64[16] = {7, 6, 5, 4, 3, 2, 1, 0, 8, 8, 8, 8, 8, 8, 8, 8};
    const uint8_t Idx32[16] = {3, 2, 1, 0, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8};
    Shuffle(Is64 ? Idx64 : Idx32);
    Simd(0x1d);
    B.u8(0);
    if (!Is64) {
      B.i64c(0xFFFF'FFFF);
      B.u8(op::i64_and);
    }
    SetNode(Node);
    break;
  }
  case OP_COUNTLEADINGZEROES: {
    auto Src = IROp->C<IROp_CountLeadingZeroes>()->Src;
    if (Is64) {
      GPR(Src);
      B.u8(op::i64_clz);
    } else {
      GPR32(Src);
      if (Size == OpSize::i16Bit) {
        B.i32c(16);
        B.u8(op::i32_shl);
        B.i32c(0x8000);
        B.u8(op::i32_or);
      }
      B.u8(op::i32_clz);
      B.u8(op::i64_extend_i32_u);
    }
    SetNode(Node);
    break;
  }
  case OP_FINDTRAILINGZEROES: {
    auto Src = IROp->C<IROp_FindTrailingZeroes>()->Src;
    if (Is64) {
      GPR(Src);
      B.u8(op::i64_ctz);
    } else {
      GPR32(Src);
      if (Size == OpSize::i16Bit) {
        B.i32c(0x1'0000);
        B.u8(op::i32_or);
      }
      B.u8(op::i32_ctz);
      B.u8(op::i64_extend_i32_u);
    }
    SetNode(Node);
    break;
  }
  case OP_MASKGENERATEFROMBITWIDTH: {
    // width == 0 ? ~0 : ~(~0 << (width & 63))
    auto Op = IROp->C<IROp_MaskGenerateFromBitWidth>();
    B.i64c(-1);
    B.i64c(-1);
    GPR(Op->BitWidth);
    B.u8(op::i64_shl);
    B.i64c(-1);
    B.u8(op::i64_xor);
    GPR(Op->BitWidth);
    B.u8(op::i64_eqz);
    B.u8(op::select);
    SetNode(Node);
    break;
  }
  case OP_PDEP:
  case OP_PEXT: {
    GPR(IROp->Args[0]);
    Mask32IfNeeded(Size);
    GPR(IROp->Args[1]);
    Mask32IfNeeded(Size);
    Call(IROp->Op == OP_PDEP ? FUNC_PDEP : FUNC_PEXT);
    SetNode(Node);
    break;
  }
  case OP_ADCZERO:
  case OP_ADCZEROWITHFLAGS: {
    // Src1 + (carry clear): arm64 cinc / cset + adds.
    if (Size != OpSize::i32Bit && Size != OpSize::i64Bit) {
      return Fail(IROp);
    }
    Materialize();
    GPR(IROp->Args[0]);
    Mask32IfNeeded(Size);
    if (IROp->Op == OP_ADCZERO) {
      NZCVBit(29);
      B.u8(op::i32_eqz);
      B.u8(op::i64_extend_i32_u);
      B.u8(op::i64_add);
      Mask32IfNeeded(Size);
      SetNode(Node);
      break;
    }
    B.set(FA);
    NZCVBit(29);
    B.u8(op::i32_eqz);
    B.u8(op::i64_extend_i32_u);
    B.set(FB);
    SetFlags(Is64 ? FK_ADD64 : FK_ADD32);
    B.get(FA);
    B.get(FB);
    B.u8(op::i64_add);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_AXFLAG: {
    // arm64 axflag (FEAT_FlagM2): Z = Z | V, C = C & !V, N = V = 0. (The
    // operand only feeds FEX's fallback sequence for cores without it.)
    if (FlagsKnown && (KnownKind == FK_FCMP32 || KnownKind == FK_FCMP64)) {
      SetFlags(KnownKind == FK_FCMP32 ? FK_FCMPAX32 : FK_FCMPAX64);
      break;
    }
    Materialize();
    B.get(NZCV);
    B.get(NZCV);
    B.i32c(2);
    B.u8(op::i32_shl); // V into Z's place
    B.u8(op::i32_or);
    B.i32c(1 << 30);
    B.u8(op::i32_and); // Z | V at bit 30
    B.get(NZCV);
    B.get(NZCV);
    B.i32c(1);
    B.u8(op::i32_shl); // V into C's place
    B.i32c(-1);
    B.u8(op::i32_xor);
    B.u8(op::i32_and);
    B.i32c(1 << 29);
    B.u8(op::i32_and); // C & !V at bit 29
    B.u8(op::i32_or);
    B.set(NZCV);
    B.i32c(FK_MAT);
    B.set(FK);
    FlagsKnown = true;
    KnownKind = FK_MAT;
    break;
  }
  case OP_CMPPAIRZ: {
    // Z = (lo1 == lo2 && hi1 == hi2); N, C, V kept.
    auto Op = IROp->C<IROp_CmpPairZ>();
    Materialize();
    B.get(NZCV);
    B.i32c(int32_t(~(1u << 30)));
    B.u8(op::i32_and);
    GPR(Op->Src1Lo);
    GPR(Op->Src2Lo);
    B.u8(op::i64_xor);
    GPR(Op->Src1Hi);
    GPR(Op->Src2Hi);
    B.u8(op::i64_xor);
    B.u8(op::i64_or);
    if (!Is64) {
      B.i64c(0xFFFF'FFFF);
      B.u8(op::i64_and);
    }
    B.u8(op::i64_eqz);
    B.i32c(30);
    B.u8(op::i32_shl);
    B.u8(op::i32_or);
    B.set(NZCV);
    SetFlags(FK_MAT);
    break;
  }
  case OP_TESTZ: {
    // 32-bit tst of (Src1 & Src2 & size mask), as the arm64 backend emits it.
    auto Op = IROp->C<IROp_TestZ>();
    GPR(Op->Src1);
    GPR(Op->Src2);
    B.u8(op::i64_and);
    B.i64c(Size == OpSize::i8Bit ? 0xff : Size == OpSize::i16Bit ? 0xffff : 0xFFFF'FFFF);
    B.u8(op::i64_and);
    B.set(FA);
    SetFlags(FK_LOGIC32);
    break;
  }
  case OP_FENCE:
    if (IROp->C<IROp_Fence>()->Fence != FenceType::Inst) {
      B.u8(0xfe);
      B.u8(0x03);
      B.u8(0x00); // atomic.fence
    }
    break;
  case OP_CACHELINECLEAR:
  case OP_CACHELINECLEAN:
    B.u8(0xfe);
    B.u8(0x03);
    B.u8(0x00);
    break;
  case OP_CACHELINEZERO: {
    GPR(IROp->Args[0]);
    B.i64c(~63ll);
    B.u8(op::i64_and);
    if (Cfg.MemoryTraceAddr) {
      const uint32_t Length = NewLocal(I64);
      B.i64c(64); B.set(Length);
      TraceMemoryAddress(0, Length, {}, 3);
    }
    Wrap();
    B.i32c(0);
    B.i32c(64);
    B.fc(op::memory_fill);
    B.u8(0);
    break;
  }
  case OP_PREFETCH:
  case OP_YIELD: break;
  case OP_PROCESSORID:
    B.i64c(0);
    SetNode(Node);
    break;
  case OP_CYCLECOUNTER:
    Call(FUNC_CYCLES);
    SetNode(Node);
    break;
  case OP_RDRAND:
    Call(FUNC_RDRAND);
    SetNode(Node);
    break;
  case OP_CPUID: {
    auto Op = IROp->C<IROp_CPUID>();
    GPR32(Op->Function);
    GPR32(Op->Leaf);
    Call(FUNC_CPUID);
    for (auto Out : {Op->OutEDX, Op->OutECX, Op->OutEBX, Op->OutEAX}) {
      B.u8(op::i64_extend_i32_u);
      B.set(LocalFor(ID(Out)));
    }
    break;
  }
  case OP_XGETBV: {
    auto Op = IROp->C<IROp_XGetBV>();
    GPR32(Op->Function);
    B.u8(op::i32_eqz);
    B.set(TC);
    for (int Hi = 0; Hi < 2; Hi++) {
      B.i64c(int64_t(Hi ? Cfg.XCR0 >> 32 : Cfg.XCR0 & 0xFFFF'FFFF));
      B.i64c(0);
      B.get(TC);
      B.u8(op::select);
      B.set(LocalFor(ID(Hi ? Op->OutEDX : Op->OutEAX)));
    }
    break;
  }
  case OP_CRC32: {
    // CRC32C via the table at CRCTableAddr, one byte at a time.
    auto Op = IROp->C<IROp_CRC32>();
    const uint32_t Bytes = uint32_t(Op->SrcSize);
    GPR32(Op->Src1);
    B.set(TC);
    GPR(Op->Src2);
    B.set(T0);
    for (uint32_t I = 0; I < Bytes; I++) {
      // crc = table[(crc ^ byte) & 0xff] ^ (crc >> 8)
      B.get(TC);
      B.get(T0);
      if (I) {
        B.i64c(8 * I);
        B.u8(op::i64_shr_u);
      }
      B.u8(op::i32_wrap_i64);
      B.u8(op::i32_xor);
      B.i32c(0xff);
      B.u8(op::i32_and);
      B.i32c(2);
      B.u8(op::i32_shl);
      B.mem(op::i32_load, 2, Cfg.CRCTableAddr);
      B.get(TC);
      B.i32c(8);
      B.u8(op::i32_shr_u);
      B.u8(op::i32_xor);
      B.set(TC);
    }
    B.get(TC);
    B.u8(op::i64_extend_i32_u);
    SetNode(Node);
    break;
  }
  case OP_SETROUNDINGMODE:
    SysBase();
    GPR32(IROp->C<IROp_SetRoundingMode>()->RoundMode);
    B.i32c(7);
    B.u8(op::i32_and);
    B.mem(op::i32_store, 2, Cfg.RoundModeAddr);
    break;
  case OP_GETROUNDINGMODE:
    SysBase();
    B.mem(op::i64_load32_u, 2, Cfg.RoundModeAddr);
    SetNode(Node);
    break;
  case OP_PUSHROUNDINGMODE: {
    // Returns the previous mode word; sets the rounding control.
    SysBase();
    B.mem(op::i64_load32_u, 2, Cfg.RoundModeAddr);
    B.tee(T0);
    SetNode(Node);
    SysBase();
    B.get(T0);
    B.i64c(~3ll);
    B.u8(op::i64_and);
    B.i64c(IROp->C<IROp_PushRoundingMode>()->RoundMode & 3);
    B.u8(op::i64_or);
    B.mem(op::i64_store32, 2, Cfg.RoundModeAddr);
    break;
  }
  case OP_POPROUNDINGMODE:
    SysBase();
    GPR(IROp->Args[0]);
    B.mem(op::i64_store32, 2, Cfg.RoundModeAddr);
    break;
  case OP_CASPAIR: {
    // cmpxchg8b/16b. The 16-byte form has no wasm atomic; it is a plain
    // compare-and-store (TODO: a lock for multi-threaded guests).
    auto Op = IROp->C<IROp_CASPair>();
    const uint32_t S = uint32_t(IROp->ElementSize);
    const uint32_t Lo = LocalFor(ID(Op->OutLo)), Hi = LocalFor(ID(Op->OutHi));
    GPR(Op->Addr);
    Wrap();
    B.set(TC);
    if (S == 4) {
      auto Pack = [&](OrderedNodeWrapper L, OrderedNodeWrapper H) {
        GPR(H);
        B.i64c(32);
        B.u8(op::i64_shl);
        GPR(L);
        B.i64c(0xFFFF'FFFF);
        B.u8(op::i64_and);
        B.u8(op::i64_or);
      };
      B.get(TC);
      B.i32c(7);
      B.u8(op::i32_and);
      B.u8(op::if_);
      B.u8(I64);
      B.get(TC);
      B.mem(op::i64_load, 3, 0);
      B.tee(T0);
      Pack(Op->ExpectedLo, Op->ExpectedHi);
      B.u8(op::i64_eq);
      B.u8(op::if_);
      B.u8(0x40);
      B.get(TC);
      Pack(Op->DesiredLo, Op->DesiredHi);
      B.mem(op::i64_store, 3, 0);
      B.u8(op::end);
      B.get(T0);
      B.u8(op::else_);
      B.get(TC);
      Pack(Op->ExpectedLo, Op->ExpectedHi);
      Pack(Op->DesiredLo, Op->DesiredHi);
      Atomic(0x49, 3); // i64.atomic.rmw.cmpxchg
      B.u8(op::end);
      B.tee(T0);
      B.i64c(0xFFFF'FFFF);
      B.u8(op::i64_and);
      B.set(Lo);
      B.get(T0);
      B.i64c(32);
      B.u8(op::i64_shr_u);
      B.set(Hi);
      break;
    }
    if (S != 8) {
      return Fail(IROp);
    }
    B.get(TC);
    B.mem(op::i64_load, 3, 0);
    B.set(Lo);
    B.get(TC);
    B.mem(op::i64_load, 3, 8);
    B.set(Hi);
    B.get(Lo);
    GPR(Op->ExpectedLo);
    B.u8(op::i64_eq);
    B.get(Hi);
    GPR(Op->ExpectedHi);
    B.u8(op::i64_eq);
    B.u8(op::i32_and);
    B.u8(op::if_);
    B.u8(0x40);
    B.get(TC);
    GPR(Op->DesiredLo);
    B.mem(op::i64_store, 3, 0);
    B.get(TC);
    GPR(Op->DesiredHi);
    B.mem(op::i64_store, 3, 8);
    B.u8(op::end);
    break;
  }

  case OP_VPCMPESTRX:
  case OP_VPCMPISTRX: {
    // SSE4.2 string compare, specialised on the control byte; the same result
    // as FEX's fallback: IntRes2 in bits 0-15, flags (SF ZF CF OF) in 28-31.
    const bool Explicit = IROp->Op == OP_VPCMPESTRX;
    const uint16_t Control = Explicit ? IROp->C<IROp_VPCMPESTRX>()->Control : IROp->C<IROp_VPCMPISTRX>()->Control;
    const OrderedNodeWrapper LHS = Explicit ? IROp->C<IROp_VPCMPESTRX>()->LHS : IROp->C<IROp_VPCMPISTRX>()->LHS;
    const OrderedNodeWrapper RHS = Explicit ? IROp->C<IROp_VPCMPESTRX>()->RHS : IROp->C<IROp_VPCMPISTRX>()->RHS;
    const bool Words = Control & 1, Signed = Control & 2;
    const uint32_t N = Words ? 8 : 16, E = Words ? 2 : 1;
    const uint32_t Agg = (Control >> 2) & 3, Pol = (Control >> 4) & 3;
    const uint32_t Full = (1u << N) - 1;
    const uint8_t EqOp = Words ? 0x2d : 0x23, Bitmask = Words ? 0x84 : 0x64;
    const uint32_t L = NewLocal(V128), R = NewLocal(V128), LenL = NewLocal(I32), LenR = NewLocal(I32), Acc = NewLocal(I32),
                   Tmp = NewLocal(I64);
    FPR(LHS);
    B.set(L);
    FPR(RHS);
    B.set(R);
    auto Length = [&](uint32_t Vec, OrderedNodeWrapper Reg, uint32_t Out) {
      if (Explicit) {
        // |value| saturated to N; bit 8 of the control selects 64-bit registers.
        GPR(Reg);
        if (!((Control >> 8) & 1)) {
          B.u8(op::i64_extend32_s);
        }
        B.set(Tmp);
        B.i32c(int32_t(N));
        B.i64c(0);
        B.get(Tmp);
        B.u8(op::i64_sub);
        B.get(Tmp);
        B.get(Tmp);
        B.i64c(0);
        B.u8(op::i64_lt_s);
        B.u8(op::select); // |value|
        B.u8(op::i32_wrap_i64);
        B.get(Tmp);
        B.i64c(int64_t(N));
        B.u8(op::i64_add); // value + N
        B.i64c(int64_t(2 * N));
        B.u8(op::i64_gt_u); // value < -N || value > N
        B.u8(op::select);
      } else {
        // index of the first NUL element, or N
        B.get(Vec);
        V128Const(0, 0);
        Simd(EqOp);
        Simd(Bitmask);
        B.i32c(int32_t(1u << N));
        B.u8(op::i32_or);
        B.u8(op::i32_ctz);
      }
      B.set(Out);
    };
    Length(L, Explicit ? IROp->C<IROp_VPCMPESTRX>()->RAX : OrderedNodeWrapper {}, LenL);
    Length(R, Explicit ? IROp->C<IROp_VPCMPESTRX>()->RDX : OrderedNodeWrapper {}, LenR);
    auto LowMask = [&](uint32_t LenLocal) { // (1 << len) - 1
      B.i32c(1);
      B.get(LenLocal);
      B.u8(op::i32_shl);
      B.i32c(1);
      B.u8(op::i32_sub);
    };
    auto Splat = [&](uint32_t Vec, uint32_t Lane) {
      uint8_t Idx[16];
      for (uint32_t k = 0; k < 16; k++) {
        Idx[k] = uint8_t(Lane * E + (k % E));
      }
      B.get(Vec);
      B.get(Vec);
      Shuffle(Idx);
    };
    auto IfLess = [&](uint32_t Konst, uint32_t LenLocal) { // pushes Konst < len
      B.i32c(int32_t(Konst));
      B.get(LenLocal);
      B.u8(op::i32_lt_u);
    };
    switch (Agg) {
    case 0: // equal any: bit j = rhs[j] matches some valid lhs[i]
      B.i32c(0);
      B.set(Acc);
      for (uint32_t I = 0; I < N; I++) {
        B.get(Acc);
        B.get(R);
        Splat(L, I);
        Simd(EqOp);
        Simd(Bitmask);
        B.i32c(0);
        IfLess(I, LenL);
        B.u8(op::select);
        B.u8(op::i32_or);
        B.set(Acc);
      }
      B.get(Acc);
      LowMask(LenR);
      B.u8(op::i32_and);
      B.set(Acc);
      break;
    case 1: { // ranges: bit j = lhs[2k] <= rhs[j] <= lhs[2k+1] for some valid pair
      const uint8_t Ge = Words ? (Signed ? 0x35 : 0x36) : (Signed ? 0x2b : 0x2c);
      const uint8_t Le = Words ? (Signed ? 0x33 : 0x34) : (Signed ? 0x29 : 0x2a);
      B.i32c(0);
      B.set(Acc);
      for (uint32_t K = 0; 2 * K + 1 < N; K++) {
        B.get(Acc);
        B.get(R);
        Splat(L, 2 * K);
        Simd(Ge);
        B.get(R);
        Splat(L, 2 * K + 1);
        Simd(Le);
        Simd(0x4e);
        Simd(Bitmask);
        B.i32c(0);
        IfLess(2 * K + 1, LenL);
        B.u8(op::select);
        B.u8(op::i32_or);
        B.set(Acc);
      }
      B.get(Acc);
      LowMask(LenR);
      B.u8(op::i32_and);
      B.set(Acc);
      break;
    }
    case 2: { // equal each: equal below min(len), 0 up to max(len), 1 above
      const uint32_t Mn = NewLocal(I32), Mx = NewLocal(I32);
      B.get(LenL);
      B.get(LenR);
      B.get(LenL);
      B.get(LenR);
      B.u8(op::i32_lt_u);
      B.u8(op::select);
      B.set(Mn);
      B.get(LenL);
      B.get(LenR);
      B.get(LenL);
      B.get(LenR);
      B.u8(op::i32_gt_u);
      B.u8(op::select);
      B.set(Mx);
      B.get(L);
      B.get(R);
      Simd(EqOp);
      Simd(Bitmask);
      LowMask(Mn);
      B.u8(op::i32_and);
      LowMask(Mx);
      B.i32c(-1);
      B.u8(op::i32_xor);
      B.i32c(int32_t(Full));
      B.u8(op::i32_and);
      B.u8(op::i32_or);
      B.set(Acc);
      break;
    }
    default: { // equal ordered: bit j = lhs occurs in rhs at j (a match may run off rhs's end)
      B.i32c(int32_t(Full));
      B.set(Acc);
      for (uint32_t I = 0; I < N; I++) {
        uint8_t Idx[16];
        for (uint32_t k = 0; k < 16; k++) {
          const uint32_t Src = k + I * E;
          Idx[k] = uint8_t(Src < 16 ? Src : 16);
        }
        B.get(Acc);
        B.get(R);
        V128Const(0, 0);
        Shuffle(Idx); // rhs shifted down by I elements
        Splat(L, I);
        Simd(EqOp);
        Simd(Bitmask);
        // positions j >= lenR - I compare past rhs's end: count as matching
        B.i32c(1);
        B.get(LenR);
        B.i32c(int32_t(I));
        B.u8(op::i32_sub);
        B.i32c(0);
        B.get(LenR);
        B.i32c(int32_t(I));
        B.u8(op::i32_gt_s);
        B.u8(op::select); // max(lenR - I, 0)
        B.u8(op::i32_shl);
        B.i32c(1);
        B.u8(op::i32_sub);
        B.i32c(-1);
        B.u8(op::i32_xor);
        B.u8(op::i32_or);
        B.i32c(-1);
        IfLess(I, LenL);
        B.u8(op::select); // elements past lhs's end don't constrain
        B.u8(op::i32_and);
        B.set(Acc);
      }
      // j only runs to initial = lenR == N ? lenR - 1 : lenR - lenL
      const uint32_t Init = NewLocal(I32);
      B.get(LenR);
      B.i32c(1);
      B.u8(op::i32_sub);
      B.get(LenR);
      B.get(LenL);
      B.u8(op::i32_sub);
      B.get(LenR);
      B.i32c(int32_t(N));
      B.u8(op::i32_eq);
      B.u8(op::select);
      B.set(Init);
      B.get(Acc);
      B.i32c(2);
      B.get(Init);
      B.u8(op::i32_shl);
      B.i32c(1);
      B.u8(op::i32_sub);
      B.u8(op::i32_and);
      B.i32c(0);
      B.get(Init);
      B.i32c(0);
      B.u8(op::i32_ge_s);
      B.u8(op::select);
      // no valid lhs characters: all ones
      B.i32c(int32_t(Full));
      B.get(LenL); // lenL != 0 ? result : all ones
      B.u8(op::select);
      B.set(Acc);
      break;
    }
    }
    // polarity
    if (Pol == 1) {
      B.get(Acc);
      B.i32c(int32_t(Full));
      B.u8(op::i32_xor);
      B.set(Acc);
    } else if (Pol == 3) {
      B.get(Acc);
      LowMask(LenR);
      B.u8(op::i32_xor);
      B.set(Acc);
    }
    // flags: SF = lenL < N, ZF = lenR < N, CF = result != 0, OF = result & 1
    B.get(Acc);
    B.get(LenL);
    B.i32c(int32_t(N));
    B.u8(op::i32_lt_u);
    B.i32c(31);
    B.u8(op::i32_shl);
    B.u8(op::i32_or);
    B.get(LenR);
    B.i32c(int32_t(N));
    B.u8(op::i32_lt_u);
    B.i32c(30);
    B.u8(op::i32_shl);
    B.u8(op::i32_or);
    B.get(Acc);
    B.i32c(0);
    B.u8(op::i32_ne);
    B.i32c(29);
    B.u8(op::i32_shl);
    B.u8(op::i32_or);
    B.get(Acc);
    B.i32c(1);
    B.u8(op::i32_and);
    B.i32c(28);
    B.u8(op::i32_shl);
    B.u8(op::i32_or);
    B.u8(op::i64_extend_i32_u);
    SetNode(Node);
    break;
  }

  // ---- atomics (x86 lock prefix, xchg, cmpxchg) ----
  // Wasm atomics trap on misaligned addresses, which x86 allows; those take a
  // plain read-modify-write instead.
  case OP_ATOMICFETCHADD:
  case OP_ATOMICFETCHSUB:
  case OP_ATOMICFETCHAND:
  case OP_ATOMICFETCHCLR:
  case OP_ATOMICFETCHOR:
  case OP_ATOMICFETCHXOR:
  case OP_ATOMICSWAP: {
    auto Op = IROp->C<IROp_AtomicFetchAdd>();
    if (Cfg.BrokerMemory) {
      SysBase(); GPR(Op->Addr); B.mem(op::i64_store, 3, broker::Scratch + 32);
      SysBase(); GPR(Op->Value); B.mem(op::i64_store, 3, broker::Scratch + 56);
      BrokerRequest(4, uint32_t(Size));
      SysBase(); B.mem(op::i64_load, 3, broker::Scratch + 72); SetNode(Node); break;
    }
    const uint32_t S = uint32_t(Size);
    // Sub-opcode of the i64 form for this width: base + {8: 4, 16: 5, 32: 6, 64: 1}.
    const uint32_t Base = IROp->Op == OP_ATOMICFETCHADD ? 0x1e
                          : IROp->Op == OP_ATOMICFETCHSUB ? 0x25
                          : IROp->Op == OP_ATOMICFETCHAND || IROp->Op == OP_ATOMICFETCHCLR ? 0x2c
                          : IROp->Op == OP_ATOMICFETCHOR  ? 0x33
                          : IROp->Op == OP_ATOMICFETCHXOR ? 0x3a
                                                          : 0x41;
    const uint32_t Width = S == 1 ? 4 : S == 2 ? 5 : S == 4 ? 6 : 1;
    const uint32_t Align = S == 1 ? 0 : S == 2 ? 1 : S == 4 ? 2 : 3;
    auto Value = [&] {
      GPR(Op->Value);
      if (IROp->Op == OP_ATOMICFETCHCLR) {
        B.i64c(-1);
        B.u8(op::i64_xor);
      }
    };
    GPR(Op->Addr);
    Wrap();
    B.set(TC);
    B.get(TC);
    B.i32c(int32_t(S - 1));
    B.u8(op::i32_and);
    B.u8(op::if_);
    B.u8(I64);
    {
      B.get(TC);
      LoadGPRSized(S);
      B.set(T0);
      B.get(TC);
      if (IROp->Op == OP_ATOMICSWAP) {
        Value();
      } else {
        B.get(T0);
        Value();
        B.u8(IROp->Op == OP_ATOMICFETCHADD   ? op::i64_add
             : IROp->Op == OP_ATOMICFETCHSUB ? op::i64_sub
             : IROp->Op == OP_ATOMICFETCHOR  ? op::i64_or
             : IROp->Op == OP_ATOMICFETCHXOR ? op::i64_xor
                                             : op::i64_and);
      }
      StoreGPRSized(S);
      B.get(T0);
    }
    B.u8(op::else_);
    B.get(TC);
    Value();
    Atomic(Base + Width, Align);
    B.u8(op::end);
    SetNode(Node);
    break;
  }
  case OP_ATOMICFETCHNEG: {
    // cmpxchg loop, as the arm64 backend does.
    auto Op = IROp->C<IROp_AtomicFetchNeg>();
    const uint32_t S = uint32_t(Size);
    const uint32_t Width = S == 1 ? 4 : S == 2 ? 5 : S == 4 ? 6 : 1;
    const uint32_t Align = S == 1 ? 0 : S == 2 ? 1 : S == 4 ? 2 : 3;
    GPR(Op->Addr);
    Wrap();
    B.set(TC);
    B.get(TC);
    LoadGPRSized(S);
    B.set(T0);
    B.get(TC);
    B.i32c(int32_t(S - 1));
    B.u8(op::i32_and);
    B.u8(op::if_);
    B.u8(0x40);
    B.get(TC);
    B.i64c(0);
    B.get(T0);
    B.u8(op::i64_sub);
    StoreGPRSized(S);
    B.u8(op::else_);
    B.u8(op::loop);
    B.u8(0x40);
    B.get(T0);
    B.set(T1);
    B.get(TC);
    B.get(T1);
    B.i64c(0);
    B.get(T1);
    B.u8(op::i64_sub);
    Atomic(0x48 + Width, Align); // cmpxchg
    B.tee(T0);
    B.get(T1);
    B.u8(op::i64_ne);
    B.u8(op::br_if);
    B.u32(0);
    B.u8(op::end);
    B.u8(op::end);
    B.get(T0);
    SetNode(Node);
    break;
  }
  case OP_CAS: {
    auto Op = IROp->C<IROp_CAS>();
    if (Cfg.BrokerMemory) {
      SysBase(); GPR(Op->Addr); B.mem(op::i64_store, 3, broker::Scratch + 32);
      SysBase(); GPR(Op->Expected); B.mem(op::i64_store, 3, broker::Scratch + 56);
      SysBase(); GPR(Op->Desired); B.mem(op::i64_store, 3, broker::Scratch + 64);
      BrokerRequest(3, uint32_t(Size));
      SysBase(); B.mem(op::i64_load, 3, broker::Scratch + 72); SetNode(Node); break;
    }
    const uint32_t S = uint32_t(Size);
    const uint32_t Width = S == 1 ? 4 : S == 2 ? 5 : S == 4 ? 6 : 1;
    const uint32_t Align = S == 1 ? 0 : S == 2 ? 1 : S == 4 ? 2 : 3;
    const uint64_t Mask = S == 8 ? ~0ull : (1ull << (S * 8)) - 1;
    GPR(Op->Addr);
    Wrap();
    B.set(TC);
    B.get(TC);
    B.i32c(int32_t(S - 1));
    B.u8(op::i32_and);
    B.u8(op::if_);
    B.u8(I64);
    {
      B.get(TC);
      LoadGPRSized(S);
      B.tee(T0);
      GPR(Op->Expected);
      B.i64c(int64_t(Mask));
      B.u8(op::i64_and);
      B.u8(op::i64_eq);
      B.u8(op::if_);
      B.u8(0x40);
      B.get(TC);
      GPR(Op->Desired);
      StoreGPRSized(S);
      B.u8(op::end);
      B.get(T0);
    }
    B.u8(op::else_);
    B.get(TC);
    GPR(Op->Expected);
    GPR(Op->Desired);
    Atomic(0x48 + Width, Align);
    B.u8(op::end);
    SetNode(Node);
    break;
  }

  // ---- flag producers ----
  case OP_SUBNZCV:
  case OP_SUBWITHFLAGS:
  case OP_ADDWITHFLAGS: {
    const bool IsSub = IROp->Op != OP_ADDWITHFLAGS;
    auto Src1 = IROp->Args[0], Src2 = IROp->Args[1];
    if (IROp->Op == OP_SUBNZCV && Size < OpSize::i32Bit) {
      ShiftedSmall(Src1, Size);
      B.set(FA);
      ShiftedSmall(Src2, Size);
      B.set(FB);
      SetFlags(FK_SUB32);
      break;
    }
    GPR(Src1);
    Mask32IfNeeded(Size);
    B.set(FA);
    GPR(Src2);
    Mask32IfNeeded(Size);
    B.set(FB);
    SetFlags(IsSub ? (Is64 ? FK_SUB64 : FK_SUB32) : (Is64 ? FK_ADD64 : FK_ADD32));
    if (IROp->Op != OP_SUBNZCV) {
      B.get(FA);
      B.get(FB);
      B.u8(IsSub ? op::i64_sub : op::i64_add);
      Mask32IfNeeded(Size);
      SetNode(Node);
    }
    break;
  }
  case OP_ANDWITHFLAGS:
  case OP_TESTNZ: {
    auto Src1 = IROp->Args[0], Src2 = IROp->Args[1];
    GPR(Src1);
    GPR(Src2);
    B.u8(op::i64_and);
    Mask32IfNeeded(Size);
    B.set(T0);
    if (IROp->Op == OP_ANDWITHFLAGS) {
      B.get(T0);
      SetNode(Node);
    }
    B.get(T0);
    if (Size < OpSize::i32Bit) {
      B.i64c(32 - Bits(Size));
      B.u8(op::i64_shl);
      B.i64c(0xFFFF'FFFF);
      B.u8(op::i64_and);
    }
    B.set(FA);
    SetFlags(Is64 ? FK_LOGIC64 : FK_LOGIC32);
    break;
  }
  case OP_NZCVSELECT: {
    auto Op = IROp->C<IROp_NZCVSelect>();
    GPR(Op->TrueVal);
    GPR(Op->FalseVal);
    Condition(Op->Cond);
    B.u8(op::select);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_SELECT: {
    auto Op = IROp->C<IROp_Select>();
    GPR(Op->TrueVal);
    GPR(Op->FalseVal);
    if (NodeVLocal.count(ID(Op->Cmp1))) {
      if (!FloatCompare(Op->Cond, Op->CompareSize, Op->Cmp1, Op->Cmp2)) {
        return Fail(IROp, "float Select condition in");
      }
      B.u8(op::select);
      Mask32IfNeeded(Size);
      SetNode(Node);
      break;
    }
    IntCompare(Op->Cond, Op->CompareSize, Op->Cmp1, Op->Cmp2);
    B.u8(op::select);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_UDIV:
  case OP_DIV: {
    // (Upper:Lower) / Divisor as FEX's arm64 backend computes it per size. The
    // x86 #DE cases (zero divisor, quotient overflow) trap in wasm.
    const bool Signed = IROp->Op == OP_DIV;
    auto Op = IROp->C<IROp_UDiv>(); // same layout as IROp_Div
    const uint32_t Q = LocalFor(ID(Op->OutQuotient)), R = LocalFor(ID(Op->OutRemainder));
    const uint32_t S = uint32_t(Size);
    if (S == 8 && !Op->Upper.IsInvalid()) {
      GPR(Op->Upper);
      if (Signed) { // upper is the sign extension of lower: 64-bit division
        GPR(Op->Lower);
        B.i64c(63);
        B.u8(op::i64_shr_s);
        B.u8(op::i64_eq);
      } else {
        B.u8(op::i64_eqz);
      }
      B.u8(op::if_);
      B.u8(0x40);
      GPR(Op->Lower);
      GPR(Op->Divisor);
      B.u8(Signed ? op::i64_div_s : op::i64_div_u);
      B.set(Q);
      GPR(Op->Lower);
      GPR(Op->Divisor);
      B.u8(Signed ? op::i64_rem_s : op::i64_rem_u);
      B.set(R);
      B.u8(op::else_);
      GPR(Op->Lower);
      GPR(Op->Upper);
      GPR(Op->Divisor);
      Call(Signed ? FUNC_DIV128S : FUNC_DIV128U);
      B.set(R);
      B.set(Q);
      B.u8(op::end);
      break;
    }
    if (S == 8 || (S == 4 && !Op->Upper.IsInvalid())) {
      // 64-bit division; for 32 bits the dividend is Upper:Lower.
      if (S == 4) {
        GPR(Op->Upper);
        B.i64c(32);
        B.u8(op::i64_shl);
        GPR(Op->Lower);
        B.i64c(0xFFFF'FFFF);
        B.u8(op::i64_and);
        B.u8(op::i64_or);
      } else {
        GPR(Op->Lower);
      }
      B.set(T1);
      GPR(Op->Divisor);
      if (S == 4) {
        if (Signed) {
          B.u8(op::i64_extend32_s);
        } else {
          B.i64c(0xFFFF'FFFF);
          B.u8(op::i64_and);
        }
      }
      B.set(T2);
      B.get(T1);
      B.get(T2);
      B.u8(Signed ? op::i64_div_s : op::i64_div_u);
      B.set(Q);
      B.get(T1);
      B.get(T2);
      B.u8(Signed ? op::i64_rem_s : op::i64_rem_u);
      B.set(R);
      break;
    }
    // 32-bit division: 8/16/32-bit operands, or a 16-bit Upper:Lower.
    if (!Op->Upper.IsInvalid() && S != 2) {
      return Fail(IROp);
    }
    auto Narrow = [&](OrderedNodeWrapper V) {
      GPR32(V);
      if (Signed && S == 1) {
        B.u8(op::i32_extend8_s);
      } else if (S == 2) {
        if (Signed) {
          B.u8(op::i32_extend16_s);
        } else {
          B.i32c(0xffff);
          B.u8(op::i32_and);
        }
      }
    };
    if (Op->Upper.IsInvalid()) {
      Narrow(Op->Lower);
    } else {
      GPR32(Op->Upper);
      B.i32c(16);
      B.u8(op::i32_shl);
      GPR32(Op->Lower);
      B.i32c(0xffff);
      B.u8(op::i32_and);
      B.u8(op::i32_or);
    }
    B.u8(op::i64_extend_i32_u);
    B.set(T1);
    Narrow(Op->Divisor);
    B.u8(op::i64_extend_i32_u);
    B.set(T2);
    for (int Rem = 0; Rem < 2; Rem++) {
      B.get(T1);
      B.u8(op::i32_wrap_i64);
      B.get(T2);
      B.u8(op::i32_wrap_i64);
      B.u8(Rem ? (Signed ? op::i32_rem_s : op::i32_rem_u) : (Signed ? op::i32_div_s : op::i32_div_u));
      B.u8(op::i64_extend_i32_u);
      B.set(Rem ? R : Q);
    }
    break;
  }

  // ---- context: CPUState fields other than the static registers ----
  case OP_LOADCONTEXT: {
    auto Op = IROp->C<IROp_LoadContext>();
    if (HitsRegArgs(Op->Offset, uint32_t(Size))) {
      return Fail(IROp, "register argument in context");
    }
    SysBase();
    if (Op->Class == RegClass::GPR) {
      LoadGPRSized(uint32_t(Size), Cfg.CtxAddr + Op->Offset);
      SetNode(Node);
    } else if (LoadFPRSized(uint32_t(Size), Cfg.CtxAddr + Op->Offset)) {
      SetV(Node);
    } else {
      return Fail(IROp, "FPR");
    }
    break;
  }
  case OP_STORECONTEXT: {
    auto Op = IROp->C<IROp_StoreContext>();
    if (HitsRegArgs(Op->Offset, uint32_t(Size))) {
      return Fail(IROp, "register argument in context");
    }
    SysBase();
    if (Op->Class == RegClass::GPR) {
      GPR(Op->Value);
      StoreGPRSized(uint32_t(Size), Cfg.CtxAddr + Op->Offset);
    } else {
      FPR(Op->Value);
      if (!StoreFPRSized(uint32_t(Size), Cfg.CtxAddr + Op->Offset)) {
        return Fail(IROp, "FPR");
      }
    }
    break;
  }
  case OP_LOADCONTEXTPAIR: {
    auto Op = IROp->C<IROp_LoadContextPair>();
    const uint32_t S = uint32_t(Size);
    if (HitsRegArgs(Op->Offset, 2 * S)) {
      return Fail(IROp, "register argument in context");
    }
    for (uint32_t I = 0; I < 2; I++) {
      const auto Out = I ? Op->OutValue2 : Op->OutValue1;
      SysBase();
      if (Op->Class == RegClass::GPR) {
        LoadGPRSized(S, Cfg.CtxAddr + Op->Offset + I * S);
        B.set(LocalFor(ID(Out)));
      } else if (LoadFPRSized(S, Cfg.CtxAddr + Op->Offset + I * S)) {
        B.set(VLocalFor(ID(Out)));
      } else {
        return Fail(IROp, "FPR");
      }
    }
    break;
  }
  case OP_STORECONTEXTPAIR: {
    auto Op = IROp->C<IROp_StoreContextPair>();
    const uint32_t S = uint32_t(Size);
    if (HitsRegArgs(Op->Offset, 2 * S)) {
      return Fail(IROp, "register argument in context");
    }
    for (uint32_t I = 0; I < 2; I++) {
      const auto V = I ? Op->Value2 : Op->Value1;
      SysBase();
      if (Op->Class == RegClass::GPR) {
        GPR(V);
        StoreGPRSized(S, Cfg.CtxAddr + Op->Offset + I * S);
      } else {
        FPR(V);
        if (!StoreFPRSized(S, Cfg.CtxAddr + Op->Offset + I * S)) {
          return Fail(IROp, "FPR");
        }
      }
    }
    break;
  }
  case OP_LOADCONTEXTINDEXED: {
    auto Op = IROp->C<IROp_LoadContextIndexed>();
    if (HitsRegArgs(Op->BaseOffset, 1)) {
      return Fail(IROp, "register argument in context");
    }
    GPR32(Op->Index);
    B.i32c(int32_t(Op->Stride));
    B.u8(op::i32_mul);
    if (Op->Class == RegClass::GPR) {
      LoadGPRSized(uint32_t(Size), Cfg.CtxAddr + Op->BaseOffset);
      SetNode(Node);
    } else if (LoadFPRSized(uint32_t(Size), Cfg.CtxAddr + Op->BaseOffset)) {
      SetV(Node);
    } else {
      return Fail(IROp, "FPR");
    }
    break;
  }
  case OP_STORECONTEXTINDEXED: {
    auto Op = IROp->C<IROp_StoreContextIndexed>();
    if (HitsRegArgs(Op->BaseOffset, 1)) {
      return Fail(IROp, "register argument in context");
    }
    GPR32(Op->Index);
    B.i32c(int32_t(Op->Stride));
    B.u8(op::i32_mul);
    if (Op->Class == RegClass::GPR) {
      GPR(Op->Value);
      StoreGPRSized(uint32_t(Size), Cfg.CtxAddr + Op->BaseOffset);
    } else {
      FPR(Op->Value);
      if (!StoreFPRSized(uint32_t(Size), Cfg.CtxAddr + Op->BaseOffset)) {
        return Fail(IROp, "FPR");
      }
    }
    break;
  }
  case OP_CONTEXTCLEAR: {
    auto Op = IROp->C<IROp_ContextClear>();
    if (HitsRegArgs(Op->Offset, Op->Size)) {
      return Fail(IROp, "register argument in context");
    }
    if (Cfg.MemoryTraceAddr) {
      const uint32_t Length = NewLocal(I64);
      B.i64c(Op->Size); B.set(Length);
      B.i64c(Cfg.CtxAddr + Op->Offset);
      TraceMemoryAddress(0, Length, {}, 4); B.u8(op::drop);
    }
    B.i32c(int32_t(Cfg.CtxAddr + Op->Offset));
    B.i32c(0);
    B.i32c(int32_t(Op->Size));
    B.fc(op::memory_fill);
    B.u8(0);
    break;
  }
  case OP_ALLOCATEFPR:
    V128Const(0, 0);
    SetV(Node);
    break;
  case OP_SYSCALL: {
    // The runtime's e.syscall(number, args...) -> result. It sees guest
    // memory directly; registers only through the arguments, unless
    // SyscallFullState.
    auto Op = IROp->C<IROp_Syscall>();
    if (Cfg.BrokerMemory) {
      // Preserve the syscall number until the typed step has fully unwound.
      // The kernel then handles only its admitted bounded syscall subset.
      GPR(Op->SyscallID); SetNode(Node); break;
    }
    if (Cfg.SyscallFullState) {
      // Everything this unit may have changed so far goes back to CPUState:
      // the lazy flags, XMM and GPRs held in locals, and the GPRs passed as
      // values (CPUState never has those while the unit runs).
      const uint64_t Live = ExitLive;
      ExitLive = ~0ull;
      Epilogue();
      ExitLive = Live;
      for (uint32_t R : ArgRegs) {
        SysBase();
        B.get(G[R]);
        B.mem(op::i64_store, 3, Cfg.CtxAddr + offsetof(CPUState, gregs) + 8 * R);
      }
    }
    GPR(Op->SyscallID);
    GPR(Op->Arg0);
    GPR(Op->Arg1);
    GPR(Op->Arg2);
    GPR(Op->Arg3);
    GPR(Op->Arg4);
    GPR(Op->Arg5);
    // A syscall that returns leaves the registers as they were (the IR puts
    // its result in RAX), so nothing is reloaded; one that changes them, or
    // the RIP, throws and the run loop restarts from CPUState.
    Call(FUNC_SYSCALL);
    SetNode(Node);
    break;
  }
  case OP_BREAK: {
    auto R = IROp->C<IROp_Break>()->Reason;
    SysBase();
    B.i64c(int64_t(uint64_t(R.Signal) | uint64_t(R.TrapNumber) << 8 | uint64_t(R.si_code) << 16 | uint64_t(R.ErrorRegister) << 32));
    B.mem(op::i64_store, 3, Cfg.FaultAddr);
    Epilogue();
    B.i32c(int32_t(Cfg.BreakRIP));
    Return();
    break;
  }

  // ---- memory ----
  case OP_LOADMEM:
  case OP_LOADMEMTSO: {
    auto Op = IROp->C<IROp_LoadMem>();
    if (Cfg.BrokerMemory) {
      SysBase(); Address(Op->Addr, Op->Offset, Op->OffsetType, Op->OffsetScale);
      B.mem(op::i64_store, 3, broker::Scratch + 32);
      if (Cfg.BrokerOperation == 11 || Cfg.BrokerOperation == 16) {
        SysBase(); GPR(BrokerAddend); B.mem(op::i64_store, 3, broker::Scratch + 56);
      }
      BrokerRequest(Cfg.BrokerOperation == 11 || Cfg.BrokerOperation == 16 ? Cfg.BrokerOperation : 1, uint32_t(Size));
      SysBase(); B.mem(op::i64_load, 3, broker::Scratch + 72);
      SetNode(Node);
      break;
    }
    if (Op->Class == RegClass::FPR) {
      const uint32_t Off = WasmAddress(Op->Addr, Op->Offset, Op->OffsetType, Op->OffsetScale);
      if ((uint32_t(Size) == 4 || uint32_t(Size) == 8) && !Demand.empty()) {
        // movss/movsd: a scalar load that scalar ops read directly (the lane-0
        // cache); the vector gets its zeroed upper lanes only if they're read.
        const bool D = uint32_t(Size) == 8;
        B.mem(D ? 0x2b : 0x2a, D ? 3 : 2, Off); // f64.load / f32.load
        const uint32_t L = NewLocal(D ? F64 : F32);
        if (UpperDead(Node, uint32_t(Size))) {
          B.tee(L);
          Simd(D ? 0x14 : 0x13); // splat
        } else {
          B.set(L);
          V128Const(0, 0);
          B.get(L);
          Simd(D ? 0x22 : 0x20); // replace_lane 0
          B.u8(0);
        }
        PendingScalar = L;
        PendingScalarD = D;
      } else if (!LoadFPRSized(uint32_t(Size), Off)) {
        return Fail(IROp, "FPR");
      }
      SetV(Node);
      if (IROp->Op == OP_LOADMEMTSO && Cfg.TSOMode) {
        Fence();
      }
      break;
    }
    if (Op->Class != RegClass::GPR) {
      return Fail(IROp, "class");
    }
    const uint32_t Off = WasmAddress(Op->Addr, Op->Offset, Op->OffsetType, Op->OffsetScale);
    LoadGPRSized(uint32_t(Size), Off);
    SetNode(Node);
    if (IROp->Op == OP_LOADMEMTSO && Cfg.TSOMode && !NextLoadDependsOn(Node)) {
      Fence(); // no later access moves above this load
    }
    break;
  }
  case OP_STOREMEM:
  case OP_STOREMEMTSO: {
    auto Op = IROp->C<IROp_StoreMem>();
    if (Cfg.BrokerMemory) {
      // The proven linked store has committed in the single broker RPC.
      // Its FEX arithmetic and flag nodes still execute using returned old data.
      if (Cfg.BrokerOperation == 11 || Cfg.BrokerOperation == 16) break;
      SysBase(); Address(Op->Addr, Op->Offset, Op->OffsetType, Op->OffsetScale);
      B.mem(op::i64_store, 3, broker::Scratch + 32);
      SysBase(); GPR(Op->Value); B.mem(op::i64_store, 3, broker::Scratch + 56);
      BrokerRequest(2, uint32_t(Size));
      break;
    }
    const bool TSO = IROp->Op == OP_STOREMEMTSO && Cfg.TSOMode;
    if (TSO && Cfg.TSOMode == 3 && Op->Class == RegClass::GPR) {
      // seq-cst atomic store (aligned) or fence + store (misaligned)
      const uint32_t S = uint32_t(Size);
      const uint32_t Width = S == 1 ? 4 : S == 2 ? 5 : S == 4 ? 6 : 1;
      const uint32_t Align = S == 1 ? 0 : S == 2 ? 1 : S == 4 ? 2 : 3;
      Address(Op->Addr, Op->Offset, Op->OffsetType, Op->OffsetScale);
      Wrap();
      B.set(TC);
      B.get(TC);
      B.i32c(int32_t(S - 1));
      B.u8(op::i32_and);
      B.u8(op::if_);
      B.u8(0x40);
      Fence();
      B.get(TC);
      GPR(Op->Value);
      StoreGPRSized(S);
      B.u8(op::else_);
      B.get(TC);
      GPR(Op->Value);
      Atomic(0x17 + Width, Align); // i64.atomic.store (0x18), store8 (0x1b), store16 (0x1c), store32 (0x1d)
      B.u8(op::end);
      break;
    }
    if (TSO) {
      Fence(); // earlier accesses complete before this store
    }
    if (Op->Class == RegClass::FPR) {
      const uint32_t Off = WasmAddress(Op->Addr, Op->Offset, Op->OffsetType, Op->OffsetScale);
      if (ENV_FLAG("FEXWASM_X_SMCBARRIER") && !StackAddress(Op->Addr)) {
        SmcBarrier(Off);
      }
      // movsd/movss of a scalar result: store the cached scalar directly.
      if (uint32_t(Size) == 8 || uint32_t(Size) == 4) {
        auto It = NodeScalar.find(ID(Resolve(Op->Value)));
        if (It != NodeScalar.end() && It->second.D == (uint32_t(Size) == 8)) {
          B.get(It->second.L);
          B.mem(It->second.D ? 0x39 : 0x38, It->second.D ? 3 : 2, Off); // f64.store / f32.store
          break;
        }
      }
      FPR(Op->Value);
      if (!StoreFPRSized(uint32_t(Size), Off)) {
        return Fail(IROp, "FPR");
      }
      break;
    }
    if (Op->Class != RegClass::GPR) {
      return Fail(IROp, "class");
    }
    const uint32_t Off = WasmAddress(Op->Addr, Op->Offset, Op->OffsetType, Op->OffsetScale);
    if (ENV_FLAG("FEXWASM_X_SMCBARRIER") && !StackAddress(Op->Addr)) {
      SmcBarrier(Off);
    }
    GPR(Op->Value);
    StoreGPRSized(uint32_t(Size), Off);
    break;
  }
  case OP_LOADMEMPAIR:
  case OP_STOREMEMPAIR: {
    // ldp/stp: two Size-byte values at Addr + Offset and Addr + Offset + Size.
    const bool Load = IROp->Op == OP_LOADMEMPAIR;
    const auto* L = IROp->C<IROp_LoadMemPair>();
    const auto* St = IROp->C<IROp_StoreMemPair>();
    const RegClass Class = Load ? L->Class : St->Class;
    const uint32_t S = uint32_t(Size);
    // (the offset is signed, as ldp's: a negative one, e.g. AVX's 32-byte
    // vaddps -0x20(%rdx), goes into the address, not the access's unsigned
    // offset field, where it would reach past 4 GB; see WasmAddress)
    const int32_t Disp = int32_t(Load ? L->Offset : St->Offset);
    const bool Fold = Disp >= 0 && Disp < 0x10'0000;
    const uint32_t Off = Fold ? uint32_t(Disp) : 0;
    GPR(Load ? L->Addr : St->Addr);
    if (!Fold) {
      B.i64c(int64_t(Disp));
      B.u8(op::i64_add);
    }
    Wrap();
    B.set(TC);
    for (uint32_t I = 0; I < 2; I++) {
      B.get(TC);
      if (Load) {
        const auto Out = I ? L->OutValue2 : L->OutValue1;
        if (Class == RegClass::GPR) {
          LoadGPRSized(S, Off + I * S);
          B.set(LocalFor(ID(Out)));
        } else if (LoadFPRSized(S, Off + I * S)) {
          B.set(VLocalFor(ID(Out)));
        } else {
          return Fail(IROp, "FPR");
        }
      } else {
        const auto V = I ? St->Value2 : St->Value1;
        if (Class == RegClass::GPR) {
          GPR(V);
          StoreGPRSized(S, Off + I * S);
        } else {
          FPR(V);
          if (!StoreFPRSized(S, Off + I * S)) {
            return Fail(IROp, "FPR");
          }
        }
      }
    }
    break;
  }
  case OP_ORNROR: {
    auto Op = IROp->C<IROp_Ornror>();
    GPR(Op->Src1);
    Shifted(Op->Src2, ShiftType::ROR, Op->BitShift, Is64);
    B.i64c(-1);
    B.u8(op::i64_xor);
    B.u8(op::i64_or);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_ANDSHIFT: {
    auto Op = IROp->C<IROp_AndShift>();
    GPR(Op->Src1);
    if (!Shifted(Op->Src2, Op->Shift, Op->ShiftAmount, Is64)) {
      return Fail(IROp);
    }
    B.u8(op::i64_and);
    Mask32IfNeeded(Size);
    SetNode(Node);
    break;
  }
  case OP_FCMP: {
    // Lazy: the operands' bits, compared by whatever condition reads the flags.
    auto Op = IROp->C<IROp_FCmp>();
    const bool D = Op->ElementSize == OpSize::i64Bit;
    auto Bits = [&](OrderedNodeWrapper W, uint32_t To) {
      Lane0F(W, D);
      if (D) {
        B.u8(0xbd); // i64.reinterpret_f64
      } else {
        B.u8(0xbc); // i32.reinterpret_f32
        B.u8(op::i64_extend_i32_u);
      }
      B.set(To);
    };
    Bits(Op->Scalar1, FA);
    Bits(Op->Scalar2, FB);
    SetFlags(D ? FK_FCMP64 : FK_FCMP32);
    break;
  }
  case OP_PUSH: {
    auto Op = IROp->C<IROp_Push>();
    const uint32_t VS = uint32_t(Op->ValueSize);
    if (Cfg.BrokerMemory) {
      GPR(Op->Addr); B.i64c(8); B.u8(op::i64_sub); B.set(T0);
      SysBase(); B.get(T0); B.mem(op::i64_store, 3, broker::Scratch + 32);
      SysBase(); GPR(Op->Value); B.mem(op::i64_store, 3, broker::Scratch + 56);
      BrokerRequest(2, 8);
      B.get(T0); SetNode(Node);
      break;
    }
    GPR(Op->Addr);
    B.i64c(VS);
    B.u8(op::i64_sub);
    Mask32IfNeeded(Size);
    B.tee(T0);
    Wrap();
    GPR(Op->Value);
    StoreGPRSized(VS);
    B.get(T0);
    SetNode(Node);
    break;
  }
  case OP_POP: {
    auto Op = IROp->C<IROp_Pop>();
    const uint32_t Addr = LocalFor(ID(Op->InoutAddr)), Val = LocalFor(ID(Op->OutValue));
    const uint32_t S = uint32_t(Op->Size);
    if (Cfg.BrokerMemory) {
      SysBase(); B.get(Addr); B.mem(op::i64_store, 3, broker::Scratch + 32);
      BrokerRequest(1, 8);
      SysBase(); B.mem(op::i64_load, 3, broker::Scratch + 72); B.set(Val);
      B.get(Addr); B.i64c(8); B.u8(op::i64_add); B.set(Addr);
      break;
    }
    B.get(Addr);
    Wrap();
    LoadGPRSized(S);
    B.set(Val);
    B.get(Addr);
    B.i64c(S);
    B.u8(op::i64_add);
    B.set(Addr);
    break;
  }
  case OP_MEMSET: {
    // rep stos: Length elements of Size bytes, stepping Size * Direction.
    auto Op = IROp->C<IROp_MemSet>();
    const uint32_t S = uint32_t(Op->Size);
    CurMemorySize = S;
    const uint32_t Addr = T1, Count = T2;
    GPR(Op->Addr);
    B.set(Addr);
    GPR(Op->Length);
    B.set(Count);
    uint64_t Dir = 0;
    const bool ConstDir = IsConst(Op->Direction, &Dir);
    // Fast path: forward byte fill.
    if (S == 1) {
      if (!ConstDir) {
        GPR(Op->Direction);
        B.i64c(1);
        B.u8(op::i64_eq);
        B.u8(op::if_);
        B.u8(0x40);
      }
      if (!ConstDir || Dir == 1) {
        GPR(Op->Prefix);
        B.get(Addr);
        B.u8(op::i64_add);
        TraceMemoryAddress(0, Count, {}, 1);
        Wrap();
        GPR32(Op->Value);
        B.get(Count);
        Wrap();
        B.fc(op::memory_fill);
        B.u8(0);
        B.get(Addr);
        B.get(Count);
        B.u8(op::i64_add);
        B.set(Addr);
        B.i64c(0);
        B.set(Count);
      }
      if (!ConstDir) {
        B.u8(op::end);
      }
    }
    // General loop (also finishes nothing when the fast path ran).
    B.u8(op::block);
    B.u8(0x40);
    B.u8(op::loop);
    B.u8(0x40);
    B.get(Count);
    B.u8(op::i64_eqz);
    B.u8(op::br_if);
    B.u32(1);
    GPR(Op->Prefix);
    B.get(Addr);
    B.u8(op::i64_add);
    TraceMemoryAddress(0);
    Wrap();
    GPR(Op->Value);
    StoreGPRSized(S);
    B.get(Addr);
    GPR(Op->Direction);
    B.i64c(S);
    B.u8(op::i64_mul);
    B.u8(op::i64_add);
    B.set(Addr);
    B.get(Count);
    B.i64c(1);
    B.u8(op::i64_sub);
    B.set(Count);
    B.u8(op::br);
    B.u32(0);
    B.u8(op::end);
    B.u8(op::end);
    B.get(Addr);
    SetNode(Node);
    break;
  }
  case OP_MEMCPY: {
    // rep movs: copies Length elements of Size bytes, stepping Size * Direction.
    auto Op = IROp->C<IROp_MemCpy>();
    const uint32_t S = uint32_t(Op->Size);
    CurMemorySize = S;
    const uint32_t D = LocalFor(ID(Op->OutDstAddress)), Sr = LocalFor(ID(Op->OutSrcAddress)), Count = T2;
    GPR(Op->Dest);
    B.set(T0);
    GPR(Op->Src);
    B.set(T1);
    GPR(Op->Length);
    B.set(Count);
    // Fast path: forward copy where memmove semantics equal a forward
    // element-by-element copy (no destination overlap ahead of the source).
    GPR(Op->Direction);
    B.i64c(1);
    B.u8(op::i64_eq);
    B.get(T0);
    B.get(T1);
    B.u8(op::i64_le_u);
    B.get(T0);
    B.get(T1);
    B.get(Count);
    B.i64c(S);
    B.u8(op::i64_mul);
    B.u8(op::i64_add);
    B.u8(op::i64_ge_u);
    B.u8(op::i32_or);
    B.u8(op::i32_and);
    B.u8(op::if_);
    B.u8(0x40);
    if (Cfg.MemoryTraceAddr) {
      const uint32_t Bytes = NewLocal(I64);
      B.get(Count); B.i64c(S); B.u8(op::i64_mul); B.set(Bytes);
      B.get(T0); TraceMemoryAddress(0, Bytes, T1, 2); B.u8(op::drop);
    }
    B.get(T0);
    Wrap();
    B.get(T1);
    Wrap();
    B.get(Count);
    B.i64c(S);
    B.u8(op::i64_mul);
    Wrap();
    B.fc(op::memory_copy);
    B.u8(0);
    B.u8(0);
    B.get(T0);
    B.get(Count);
    B.i64c(S);
    B.u8(op::i64_mul);
    B.u8(op::i64_add);
    B.set(T0);
    B.get(T1);
    B.get(Count);
    B.i64c(S);
    B.u8(op::i64_mul);
    B.u8(op::i64_add);
    B.set(T1);
    B.i64c(0);
    B.set(Count);
    B.u8(op::end);
    // General loop.
    B.u8(op::block);
    B.u8(0x40);
    B.u8(op::loop);
    B.u8(0x40);
    B.get(Count);
    B.u8(op::i64_eqz);
    B.u8(op::br_if);
    B.u32(1);
    B.get(T0);
    Wrap();
    B.get(T1);
    TraceMemoryAddress(0);
    Wrap();
    LoadGPRSized(S);
    if (Cfg.MemoryTraceAddr) { B.get(T0); TraceMemoryAddress(0); B.u8(op::drop); }
    StoreGPRSized(S);
    GPR(Op->Direction);
    B.i64c(S);
    B.u8(op::i64_mul);
    B.tee(Sr); // scratch: step (overwritten below)
    B.get(T0);
    B.u8(op::i64_add);
    B.set(T0);
    B.get(Sr);
    B.get(T1);
    B.u8(op::i64_add);
    B.set(T1);
    B.get(Count);
    B.i64c(1);
    B.u8(op::i64_sub);
    B.set(Count);
    B.u8(op::br);
    B.u32(0);
    B.u8(op::end);
    B.u8(op::end);
    B.get(T0);
    B.set(D);
    B.get(T1);
    B.set(Sr);
    break;
  }

  // ---- control flow ----
  case OP_JUMP:
    NoteExitFlags();
    BranchTo(TargetIndex(IROp->C<IROp_Jump>()->TargetBlock));
    break;
  case OP_CONDJUMP: {
    NoteExitFlags();
    auto Op = IROp->C<IROp_CondJump>();
    if (Op->FromNZCV) {
      Condition(Op->Cond);
    } else {
      uint64_t C = 0;
      IsConst(Op->Cmp2, &C);
      const bool W = Op->CompareSize == OpSize::i32Bit;
      switch (Op->Cond) {
      case CondClass::EQ:
      case CondClass::NEQ:
        if (W) {
          GPR32(Op->Cmp1);
          B.u8(op::i32_eqz);
        } else {
          GPR(Op->Cmp1);
          B.u8(op::i64_eqz);
        }
        if (Op->Cond == CondClass::NEQ) {
          B.u8(op::i32_eqz);
        }
        break;
      case CondClass::TSTZ:
      case CondClass::TSTNZ:
        GPR(Op->Cmp1);
        B.i64c(int64_t(C));
        B.u8(op::i64_shr_u);
        B.i64c(1);
        B.u8(op::i64_and);
        B.u8(op::i32_wrap_i64);
        if (Op->Cond == CondClass::TSTZ) {
          B.u8(op::i32_eqz);
        }
        break;
      default: return Fail(IROp, "CondJump cond");
      }
    }
    CondBranch(TargetIndex(Op->TrueBlock), TargetIndex(Op->FalseBlock));
    break;
  }
  case OP_EXITFUNCTION: {
    auto Op = IROp->C<IROp_ExitFunction>();
    if (Cfg.BrokerMemory) {
      if (Cfg.BrokerOperation == 12) {
        SysBase(); GPR(Op->NewRIP); B.mem(op::i64_store, 3, broker::Scratch + 32);
        BrokerRequest(12, 0);
        SysBase(); B.mem(op::i64_load, 3, broker::Scratch + 72); B.set(T0);
      } else if (Cfg.BrokerFlow) { GPR(Op->NewRIP); B.set(T0); }
      Epilogue();
      SysBase(); if (Cfg.BrokerFlow) B.get(T0); else B.i64c(int64_t(Cfg.BrokerNextRIP));
      B.mem(op::i64_store, 3, Cfg.CtxAddr + offsetof(CPUState, rip));
      SysBase(); if (Cfg.BrokerFlow) B.get(T0); else B.i64c(int64_t(Cfg.BrokerNextRIP));
      B.mem(op::i64_store, 3, broker::Scratch + 104);
      B.i32c(Cfg.BrokerOperation == 5 ? 3 : 0); Return();
      break;
    }
    if (auto It = InlineAt.find(ID(Node)); It != InlineAt.end()) {
      uint32_t RetIndex;
      CallReturnIndex(Op, &RetIndex);
      EmitInlined(*It->second, RetIndex);
      break;
    }
    GPR(Op->NewRIP);
    B.set(T0);
    if (auto JI = JumpInlineAt.find(ID(Node)); JI != JumpInlineAt.end()) {
      // An inlined callee jumping on (a jump table, a tail call): the inlined
      // targets it was seen going to, which return to the same call site;
      // anything else runs as a nested call until it returns there.
      B.u8(op::block);
      B.u8(0x40);
      Context.push_back({CtxKind::If, 0, Owner});
      const uint32_t JoinDepth = uint32_t(Context.size());
      for (auto& [T, Target] : JI->second) {
        B.get(T0);
        RipConst(T, true); // (the inlined code is a dependency of the unit: where it is moves with it)
        B.u8(op::i64_eq);
        B.u8(op::if_);
        B.u8(0x40);
        Context.push_back({CtxKind::If, 0, Owner});
        Target->InheritedMask = ExitMask();
        B.u8(op::block);
        B.u8(0x40);
        Context.push_back({CtxKind::InlineReturn, 0, Target->Owner});
        Target->EmitBody();
        Context.pop_back();
        B.u8(op::end);
        B.u8(op::br); // returned to the call site: on in the caller
        B.u32(Depth(CtxKind::InlineReturn, 0));
        Context.pop_back();
        B.u8(op::end);
      }
      EmitDispatchCall(InlineRetAddr);
      B.u8(op::br);
      B.u32(Depth(CtxKind::InlineReturn, 0));
      Context.pop_back();
      B.u8(op::end);
      (void)JoinDepth;
      FlagsKnown = false;
      break;
    }
    if (InlineRetAddr && Op->Hint == BranchHint::Return) {
      // An inlined callee returning to its call site continues in the caller.
      B.get(T0);
      RipConst(InlineRetAddr, true);
      B.u8(op::i64_eq);
      B.u8(op::if_);
      B.u8(0x40);
      Context.push_back({CtxKind::If, 0, Owner});
      B.u8(op::br);
      B.u32(Depth(CtxKind::InlineReturn, 0));
      Context.pop_back();
      B.u8(op::end);
    }
    if (RegionRIPs && Op->Hint != BranchHint::Return && Op->Hint != BranchHint::Call && !InlineLevel) {
      // Jumps to another unit of the region stay in the function. Returns
      // always leave: an enclosing dispatch(call) waits for its return address.
      uint64_t Target;
      // A jump to the RIP an enclosing guest call is waiting for leaves the
      // region, so that call's dispatch sees it and returns. That RIP is a
      // return address, so only jumps that may go to one check (a miss just
      // keeps the call's wasm frame around longer; the guest state is right).
      bool MayHitStop = !Cfg.ReturnAddrs;
      if (Cfg.ReturnAddrs) {
        uint64_t T;
        if (ConstRIP(Op->NewRIP, &T)) {
          MayHitStop = Cfg.ReturnAddrs->count(T) != 0;
        } else {
          for (uint64_t R : *RegionRIPs) {
            MayHitStop |= Cfg.ReturnAddrs->count(R) != 0;
          }
        }
      }
      auto NotStop = [&] { // pushes i32: T0 != stop
        if (!MayHitStop) {
          B.i32c(1);
          return;
        }
        B.get(T0);
        B.u8(op::i32_wrap_i64);
        SysBase();
        B.mem(op::i32_load, 2, Cfg.StopAddr);
        B.u8(op::i32_ne);
      };
      if (S.RG) { // structured region: branches to the units' labels
        if (ConstRIP(Op->NewRIP, &Target)) {
          auto It = std::find(RegionRIPs->begin(), RegionRIPs->end(), Target);
          if (It != RegionRIPs->end()) {
            const uint32_t Y = uint32_t(It - RegionRIPs->begin());
            if (!MayHitStop) {
              RDoBranch(RegionIndex, Y);
              break;
            }
            NotStop();
            B.u8(op::if_);
            B.u8(0x40);
            Context.push_back({CtxKind::If, 0, Owner});
            RDoBranch(RegionIndex, Y);
            Context.pop_back();
            B.u8(op::end);
          }
        } else if (!S.RIndirect[RegionIndex].empty()) {
          // An indirect jump dispatches locally over the units it was seen
          // going to (a br_table of its own, like threaded code); anything
          // else leaves the region.
          const auto& Ts = S.RIndirect[RegionIndex];
          const uint64_t Lo = (*RegionRIPs)[Ts.front()], Hi = (*RegionRIPs)[Ts.back()];
          B.u8(op::block);
          B.u8(0x40);
          Context.push_back({CtxKind::If, 0, Owner}); // $miss
          if (MayHitStop) {
            B.get(T0);
            B.u8(op::i32_wrap_i64);
            SysBase();
            B.mem(op::i32_load, 2, Cfg.StopAddr);
            B.u8(op::i32_eq);
            B.u8(op::br_if);
            B.u32(0);
          }
          if (Hi - Lo < 1024) {
            B.get(T0);
            B.i64c(int64_t(Lo));
            B.u8(op::i64_sub);
            B.tee(T1);
            B.i64c(int64_t(Hi - Lo + 1));
            B.u8(op::i64_ge_u);
            B.u8(op::br_if);
            B.u32(0);
            B.get(T1);
            B.u8(op::i32_wrap_i64);
            B.u8(op::br_table);
            B.u32(uint32_t(Hi - Lo + 1));
            size_t K = 0;
            for (uint64_t Off = 0; Off <= Hi - Lo; Off++) {
              if (K < Ts.size() && (*RegionRIPs)[Ts[K]] == Lo + Off) {
                B.u32(RLabel(RegionIndex, Ts[K]));
                K++;
              } else {
                B.u32(0);
              }
            }
            B.u32(0);
          } else {
            for (uint32_t Y : Ts) {
              B.get(T0);
              B.i64c(int64_t((*RegionRIPs)[Y]));
              B.u8(op::i64_eq);
              B.u8(op::br_if);
              B.u32(RLabel(RegionIndex, Y));
            }
          }
          Context.pop_back();
          B.u8(op::end);
        }
        Epilogue();
        B.get(T0);
        Wrap();
        Return();
        break;
      }
      if (ConstRIP(Op->NewRIP, &Target)) {
        auto It = std::find(RegionRIPs->begin(), RegionRIPs->end(), Target);
        if (It != RegionRIPs->end()) {
          NotStop();
          B.u8(op::if_);
          B.u8(0x40);
          Context.push_back({CtxKind::If, 0, Owner});
          B.i32c(RegionDense ? int32_t(Target - RegionBase) : int32_t(It - RegionRIPs->begin()));
          B.set(S.RegionUnit);
          B.u8(op::br);
          B.u32(Depth(CtxKind::RegionLoop, 0));
          Context.pop_back();
          B.u8(op::end);
          Epilogue();
          B.get(T0);
          Wrap();
          Return();
          break;
        }
      } else if (!RegionDense) {
        // unit index by binary search over the sorted RIPs; the span (K) exits
        std::vector<std::pair<uint64_t, uint32_t>> Sorted;
        for (uint32_t U = 0; U < RegionRIPs->size(); U++) {
          Sorted.push_back({(*RegionRIPs)[U], U});
        }
        std::sort(Sorted.begin(), Sorted.end());
        B.get(T0);
        B.set(S.RegionTarget);
        std::function<void(size_t, size_t)> Search = [&](size_t Lo, size_t Hi) { // pushes the i32 index
          if (Hi - Lo == 1) {
            B.i32c(int32_t(Sorted[Lo].second));
            B.i32c(int32_t(RegionSpan));
            B.get(T0);
            B.i64c(int64_t(Sorted[Lo].first));
            B.u8(op::i64_eq);
            B.u8(op::select);
            return;
          }
          const size_t Mid = (Lo + Hi) / 2;
          B.get(T0);
          B.i64c(int64_t(Sorted[Mid].first));
          B.u8(op::i64_lt_u);
          B.u8(op::if_);
          B.u8(I32);
          Search(Lo, Mid);
          B.u8(op::else_);
          Search(Mid, Hi);
          B.u8(op::end);
        };
        Search(0, Sorted.size());
        B.i32c(int32_t(RegionSpan));
        NotStop();
        B.u8(op::select); // the stop RIP goes to the exit block
        B.set(S.RegionUnit);
        B.u8(op::br);
        B.u32(Depth(CtxKind::RegionLoop, 0));
        break;
      } else {
        // offset = rip - base, or the span (-> exit block) when out of range
        B.get(T0);
        B.set(S.RegionTarget);
        B.get(T0);
        B.i64c(int64_t(RegionBase));
        B.u8(op::i64_sub);
        B.tee(T1);
        B.u8(op::i32_wrap_i64);
        B.i32c(int32_t(RegionSpan));
        B.get(T1);
        B.i64c(RegionSpan);
        B.u8(op::i64_lt_u);
        NotStop();
        B.u8(op::i32_and);
        B.u8(op::select);
        B.set(S.RegionUnit);
        B.u8(op::br);
        B.u32(Depth(CtxKind::RegionLoop, 0));
        break;
      }
    }
    uint32_t RetIndex;
    uint64_t RetAddr;
    static const int NestMode = getenv("FEXWASM_NESTMODE") ? atoi(getenv("FEXWASM_NESTMODE")) : 1;
    static const long NestLimit = getenv("FEXWASM_NEST_LIMIT") ? atol(getenv("FEXWASM_NEST_LIMIT")) : -1;
    static long NestCount = 0;
    const bool Nest = InlineRetAddr && !CallReturnIndex(Op, &RetIndex) &&
                      (((NestMode & 1) && Op->Hint == BranchHint::Return) || ((NestMode & 2) && Op->Hint != BranchHint::Return));
    if (Nest && ENV_FLAG("FEXWASM_NEST_LOG")) {
      fprintf(stderr, "[nest %ld] entry %#llx node %u ret %#llx hint %d\n", NestCount, (unsigned long long)Entry, ID(Node),
              (unsigned long long)InlineRetAddr, int(Op->Hint));
    }
    if (Nest && (NestLimit < 0 || NestCount++ < NestLimit)) {
      // Leaving an inlined callee other than by returning to its call site
      // (a jump table, a tail call, ...): run the guest from there as a
      // nested call until it returns to the call site, then carry on in the
      // caller rather than abandoning the caller's function.
      EmitDispatchCall(InlineRetAddr);
      B.u8(op::br);
      B.u32(Depth(CtxKind::InlineReturn, 0));
      break;
    }
    if (CallReturnIndex(Op, &RetIndex, &RetAddr)) {
      const uint32_t X = CurBlock;
      uint64_t Target;
      bool TargetRel = true;
      int32_t SelfEntry = -1; // a call into this function: a direct wasm call
      if (ConstRIP(Op->NewRIP, &Target, &TargetRel)) {
        S.NonRelocatable |= !TargetRel && Target == S.FunctionEntry; // (an absolute call of itself)
        if (!S.RegionEntries.empty()) {
          auto U = std::find(S.RegionUnitRIPs.begin(), S.RegionUnitRIPs.end(), Target);
          if (U != S.RegionUnitRIPs.end()) {
            SelfEntry = int32_t(S.RegionEntries[U - S.RegionUnitRIPs.begin()]);
          }
        } else if (Target == S.FunctionEntry) {
          SelfEntry = 0;
        }
      }
      auto It = IndirectInlineAt.find(ID(Node));
      if (It == IndirectInlineAt.end()) {
        EmitDispatchCall(RetAddr, SelfEntry, ConstRIP(Op->NewRIP, &Target) ? Target : 0,
                         LivenessOK ? LiveIn[RetIndex] : ~0ull, true, TargetRel);
      } else {
        // Speculatively inlined targets of an indirect call, guarded by
        // compares; anything else takes the dispatcher.
        B.u8(op::block);
        B.u8(0x40);
        Context.push_back({CtxKind::If, 0, Owner});
        const uint32_t JoinDepth = uint32_t(Context.size());
        for (auto& [T, Callee] : It->second) {
          B.get(T0);
          RipConst(T, true);
          B.u8(op::i64_eq);
          B.u8(op::if_);
          B.u8(0x40);
          Context.push_back({CtxKind::If, 0, Owner});
          Callee->InheritedMask = ExitMask();
          B.u8(op::block);
          B.u8(0x40);
          Context.push_back({CtxKind::InlineReturn, 0, Callee->Owner});
          Callee->EmitBody();
          Context.pop_back();
          B.u8(op::end);
          B.u8(op::br);
          B.u32(uint32_t(Context.size()) - JoinDepth + 0);
          Context.pop_back();
          B.u8(op::end);
        }
        EmitDispatchCall(RetAddr, -1, 0, LivenessOK ? LiveIn[RetIndex] : ~0ull, true);
        Context.pop_back();
        B.u8(op::end);
        FlagsKnown = false;
      }
      BranchToBlock(X, RetIndex);
      break;
    }
    SkipFlagSpill = XAbiFlags() && (Op->Hint == BranchHint::Return || Op->Hint == BranchHint::Call);
    if (uint64_t Target; Cfg.FlagsDeadAt && Op->Hint != BranchHint::Return && Op->Hint != BranchHint::Call &&
                         ConstRIP(Op->NewRIP, &Target) && Cfg.FlagsDeadAt(Target)) {
      SkipFlagSpill = true; // the target writes the flags before reading them
    }
    ExitLive = Op->Hint == BranchHint::Return ? ReturnLive() : Op->Hint == BranchHint::Call ? CallLive() : ~0ull;
    Epilogue();
    ExitLive = ~0ull;
    SkipFlagSpill = false;
    B.get(T0);
    Wrap();
    Return();
    break;
  }
  default:
    if (!EmitVectorOp(Node, IROp)) {
      Fail(IROp);
    }
    break;
  }
}

// SSE / vector ops. Width rules follow FEX's arm64 backend: bitwise and
// zip-style ops honour a 64-bit OpSize (D register, upper half zeroed); plain
// element-wise arithmetic always operates on the full 128 bits.
bool Emitter::EmitVectorOp(Ref Node, const IROp_Header* IROp) {
  const uint32_t OpBytes = uint32_t(IROp->Size);
  const uint32_t Elem = uint32_t(IROp->ElementSize);
  CurDemand = DemandOf(Node);
  InsertSplat = false;
  // The vector a scalar insert keeps the upper lanes of: pushed unless nothing
  // reads those lanes (then ReplaceLane0Cached splats).
  auto Upper = [&](OrderedNodeWrapper V) {
    if (Elem <= 8 && UpperDead(Node, Elem)) {
      InsertSplat = true;
    } else {
      static const bool Log = getenv("FEXWASM_DEMAND_LOG");
      if (Log) {
        fprintf(stderr, "[demand] entry %#llx level %u node %%%u demand %#x\n", (unsigned long long)Entry, InlineLevel, ID(Node),
                DemandOf(Node));
      }
      FPR(V);
    }
  };
  auto ElemIdx = [&](uint32_t E) -> int { return E == 1 ? 0 : E == 2 ? 1 : E == 4 ? 2 : E == 8 ? 3 : -1; };
  // Per element size (1,2,4,8) SIMD sub-opcodes.
  auto ByElem = [&](uint32_t E, std::initializer_list<uint32_t> Ops) -> bool {
    int I = ElemIdx(E);
    if (I < 0 || uint32_t(I) >= Ops.size() || Ops.begin()[I] == 0) {
      return false;
    }
    Simd(Ops.begin()[I]);
    return true;
  };
  auto Bin = [&](OrderedNodeWrapper A, OrderedNodeWrapper Bv) {
    FPR(A);
    FPR(Bv);
  };
  // Pushes the byte-shuffle of (A, B) that arm64 zip1/zip2/uzp1/uzp2 perform.
  auto Zip = [&](OrderedNodeWrapper Lo, OrderedNodeWrapper Up, bool Unzip, bool Second) {
    const uint32_t Lanes = OpBytes / Elem;
    uint8_t Idx[16] = {};
    for (uint32_t i = 0; i < Lanes; i++) {
      uint32_t SrcLane, FromUpper;
      if (!Unzip) {
        const uint32_t Base = Second ? Lanes / 2 : 0;
        SrcLane = Base + i / 2;
        FromUpper = i & 1;
      } else {
        const uint32_t J = 2 * i + (Second ? 1 : 0); // index into Lo:Up concatenation
        SrcLane = J % Lanes;
        FromUpper = J / Lanes;
      }
      for (uint32_t b = 0; b < Elem; b++) {
        Idx[i * Elem + b] = uint8_t((FromUpper ? 16 : 0) + SrcLane * Elem + b);
      }
    }
    Bin(Lo, Up);
    Shuffle(Idx);
    KeepLow(OpBytes);
  };
  auto ScalarF = [&](uint32_t E, uint8_t Op32, uint8_t Op64, OrderedNodeWrapper A, OrderedNodeWrapper Bv) {
    Lane0F(A, E == 8);
    Lane0F(Bv, E == 8);
    B.u8(E == 4 ? Op32 : Op64);
  };
  auto ReplaceLane0F = [&](uint32_t E) { ReplaceLane0Cached(E == 8); };

  switch (IROp->Op) {
  case OP_VAND:
  case OP_VOR:
  case OP_VXOR:
  case OP_VANDN: {
    Bin(IROp->Args[0], IROp->Args[1]);
    Simd(IROp->Op == OP_VAND ? 0x4e : IROp->Op == OP_VOR ? 0x50 : IROp->Op == OP_VXOR ? 0x51 : 0x4f);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VNOT:
    FPR(IROp->Args[0]);
    Simd(0x4d);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  case OP_VADD:
  case OP_VSUB: {
    Bin(IROp->Args[0], IROp->Args[1]);
    const bool Ok = IROp->Op == OP_VADD ? ByElem(Elem, {0x6e, 0x8e, 0xae, 0xce}) : ByElem(Elem, {0x71, 0x91, 0xb1, 0xd1});
    if (!Ok) {
      return false;
    }
    SetV(Node);
    return true;
  }
  case OP_VSHLI:
  case OP_VUSHRI:
  case OP_VSSHRI: {
    const uint8_t Shift = IROp->Op == OP_VSHLI ? IROp->C<IROp_VShlI>()->BitShift
                          : IROp->Op == OP_VUSHRI ? IROp->C<IROp_VUShrI>()->BitShift
                                                  : IROp->C<IROp_VSShrI>()->BitShift;
    const uint32_t EBits = Elem * 8;
    if (IROp->Op != OP_VSSHRI && Shift >= EBits) {
      V128Const(0, 0);
      SetV(Node);
      return true;
    }
    FPR(IROp->Args[0]);
    B.i32c(IROp->Op == OP_VSSHRI ? std::min<uint32_t>(Shift, EBits - 1) : Shift);
    bool Ok = IROp->Op == OP_VSHLI    ? ByElem(Elem, {0x6b, 0x8b, 0xab, 0xcb})
              : IROp->Op == OP_VUSHRI ? ByElem(Elem, {0x6d, 0x8d, 0xad, 0xcd})
                                      : ByElem(Elem, {0x6c, 0x8c, 0xac, 0xcc});
    if (!Ok) {
      return false;
    }
    SetV(Node);
    return true;
  }
  case OP_VZIP: Zip(IROp->Args[0], IROp->Args[1], false, false); SetV(Node); return true;
  case OP_VZIP2: Zip(IROp->Args[0], IROp->Args[1], false, true); SetV(Node); return true;
  case OP_VUNZIP: Zip(IROp->Args[0], IROp->Args[1], true, false); SetV(Node); return true;
  case OP_VUNZIP2: Zip(IROp->Args[0], IROp->Args[1], true, true); SetV(Node); return true;
  case OP_VDUPELEMENT: {
    auto Op = IROp->C<IROp_VDupElement>();
    uint8_t Idx[16];
    for (uint32_t i = 0; i < 16; i++) {
      Idx[i] = uint8_t(Op->Index * Elem + (i % Elem));
    }
    FPR(Op->Vector);
    FPR(Op->Vector);
    Shuffle(Idx);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VUMULL: {
    Bin(IROp->Args[0], IROp->Args[1]);
    if (!ByElem(Elem, {0, 0x9e, 0xbe, 0xde})) { // extmul_low_*_u, by destination element size
      return false;
    }
    SetV(Node);
    return true;
  }
  case OP_VTBL1: {
    auto Op = IROp->C<IROp_VTBL1>();
    if (uint8_t C[16]; ConstVector(Op->VectorIndices, C)) {
      // Constant indices (shufps and friends): one shuffle, which B3 turns
      // into dup/zip/ext/rev when it can. Out-of-range picks a zero lane.
      uint8_t Idx[16];
      for (uint32_t i = 0; i < 16; i++) {
        Idx[i] = C[i] < 16 ? C[i] : 16;
      }
      FPR(Op->VectorTable);
      V128Const(0, 0);
      Shuffle(Idx);
      KeepLow(OpBytes);
      SetV(Node);
      return true;
    }
    FPR(Op->VectorTable);
    FPR(Op->VectorIndices);
    Simd(0x0e); // i8x16.swizzle: out-of-range indices give 0, like tbl
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VEXTR: {
    auto Op = IROp->C<IROp_VExtr>();
    // arm64: ext(Dst, Lower=VectorUpper, Upper=VectorLower, Index * ElementSize)
    OrderedNodeWrapper Low = Op->VectorUpper, High = Op->VectorLower;
    bool HighZero = false;
    uint32_t Index = Op->Index;
    if (Index >= OpBytes) {
      Low = Op->VectorLower;
      HighZero = true;
      Index -= OpBytes;
    }
    const uint32_t From = Index * Elem;
    uint8_t Idx[16] = {};
    for (uint32_t k = 0; k < OpBytes; k++) {
      const uint32_t J = From + k; // byte of the Low:High concatenation (each OpBytes wide)
      Idx[k] = uint8_t(J < OpBytes ? J : 16 + (J - OpBytes));
    }
    FPR(Low);
    if (HighZero) {
      V128Const(0, 0);
    } else {
      FPR(High);
    }
    Shuffle(Idx);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VLOADTWOGPRS: {
    auto Op = IROp->C<IROp_VLoadTwoGPRs>();
    GPR(Op->Lower);
    Simd(0x12); // i64x2.splat
    GPR(Op->Upper);
    Simd(0x1e); // i64x2.replace_lane 1
    B.u8(1);
    SetV(Node);
    return true;
  }
  case OP_VDUPFROMGPR: {
    auto Op = IROp->C<IROp_VDupFromGPR>();
    if (Elem == 8) {
      GPR(Op->Src);
    } else {
      GPR32(Op->Src);
    }
    if (!ByElem(Elem, {0x0f, 0x10, 0x11, 0x12})) {
      return false;
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VINSGPR: {
    auto Op = IROp->C<IROp_VInsGPR>();
    if (OpBytes > 16) {
      return false;
    }
    FPR(Op->DestVector);
    if (Elem == 8) {
      GPR(Op->Src);
    } else {
      GPR32(Op->Src);
    }
    if (!ByElem(Elem, {0x17, 0x1a, 0x1c, 0x1e})) {
      return false;
    }
    B.u8(Op->DestIdx);
    SetV(Node);
    return true;
  }
  case OP_VSXTL:
  case OP_VUXTL: {
    // Widen the low half's elements to ElementSize.
    FPR(IROp->Args[0]);
    const bool Ok = IROp->Op == OP_VSXTL ? ByElem(Elem, {0, 0x87, 0xa7, 0xc7}) : ByElem(Elem, {0, 0x89, 0xa9, 0xc9});
    if (!Ok) {
      return false;
    }
    SetV(Node);
    return true;
  }
  case OP_VECTOR_FTOI: {
    // Round to integral in floating point (frintn/m/p/z/i).
    auto Op = IROp->C<IROp_Vector_FToI>();
    if (Elem != 4 && Elem != 8) {
      return false;
    }
    FPR(Op->Vector);
    const bool D = Elem == 8;
    switch (Op->Round) {
    case RoundMode::Host: RoundByMode(D, true); break;
    case RoundMode::Nearest: Simd(D ? 0x94 : 0x6a); break; // nearest (ties to even)
    case RoundMode::NegInfinity: Simd(D ? 0x75 : 0x68); break;
    case RoundMode::PosInfinity: Simd(D ? 0x74 : 0x67); break;
    case RoundMode::TowardsZero: Simd(D ? 0x7a : 0x69); break;
    default: return false;
    }
    KeepLow(Elem == OpBytes ? Elem : OpBytes); // a scalar result zeroes the rest
    SetV(Node);
    return true;
  }
  case OP_VCMPLTZ: {
    FPR(IROp->Args[0]);
    B.i32c(int32_t(Elem * 8 - 1));
    if (!ByElem(Elem, {0x6c, 0x8c, 0xac, 0xcc})) { // shr_s by (bits - 1)
      return false;
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VFADDV: {
    // Horizontal float add into lane 0, as faddp pairs: (a0 + a1) + (a2 + a3).
    const bool D = Elem == 8;
    if (Elem != 4 && Elem != 8) {
      return false;
    }
    V128Const(0, 0);
    auto Lane = [&](uint32_t I) {
      FPR(IROp->Args[0]);
      Simd(D ? 0x21 : 0x1f);
      B.u8(uint8_t(I));
    };
    const uint8_t Add = D ? 0xa0 : 0x92;
    Lane(0);
    Lane(1);
    B.u8(Add);
    if (!D) {
      Lane(2);
      Lane(3);
      B.u8(Add);
      B.u8(Add);
    }
    Simd(D ? 0x22 : 0x20);
    B.u8(0);
    SetV(Node);
    return true;
  }
  case OP_VUABDL: {
    // |a - b| of the low half's elements, widened to ElementSize.
    const auto Widen = [&](OrderedNodeWrapper W) {
      FPR(W);
      return ByElem(Elem, {0, 0x89, 0xa9, 0xc9});
    };
    if (!Widen(IROp->Args[0]) || !Widen(IROp->Args[1]) || !ByElem(Elem, {0, 0x91, 0xb1, 0xd1}) ||
        !ByElem(Elem, {0, 0x80, 0xa0, 0xc0})) {
      return false;
    }
    SetV(Node);
    return true;
  }
  case OP_VUSHRSWIDE:
  case OP_VSSHRSWIDE:
  case OP_VUSHLSWIDE: {
    // Every element shifted by the low 64 bits of ShiftScalar; logical shifts
    // of >= the element width give 0, arithmetic ones fill with the sign.
    auto Op = IROp->C<IROp_VUShrSWide>();
    const uint32_t EBits = Elem * 8;
    const bool Arith = IROp->Op == OP_VSSHRSWIDE;
    const std::initializer_list<uint32_t> Ops = IROp->Op == OP_VUSHLSWIDE ? std::initializer_list<uint32_t> {0x6b, 0x8b, 0xab, 0xcb}
                                                : Arith ? std::initializer_list<uint32_t> {0x6c, 0x8c, 0xac, 0xcc}
                                                        : std::initializer_list<uint32_t> {0x6d, 0x8d, 0xad, 0xcd};
    FPR(Op->ShiftScalar);
    Simd(0x1d); // i64x2.extract_lane 0
    B.u8(0);
    B.set(T0);
    FPR(Op->Vector);
    B.get(T0);
    B.i64c(EBits - 1);
    B.get(T0);
    B.i64c(EBits);
    B.u8(op::i64_lt_u);
    B.u8(op::select); // min(count, bits - 1)
    B.u8(op::i32_wrap_i64);
    if (!ByElem(Elem, Ops)) {
      return false;
    }
    if (!Arith) {
      V128Const(0, 0);
      B.get(T0);
      B.i64c(EBits);
      B.u8(op::i64_lt_u);
      B.u8(op::select);
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VURAVG:
    Bin(IROp->Args[0], IROp->Args[1]);
    if (!ByElem(Elem, {0x7b, 0x9b})) {
      return false;
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  case OP_VSQADD:
  case OP_VSQSUB:
  case OP_VUQADD:
  case OP_VUQSUB: {
    Bin(IROp->Args[0], IROp->Args[1]);
    const bool Ok = IROp->Op == OP_VSQADD   ? ByElem(Elem, {0x6f, 0x8f})
                    : IROp->Op == OP_VSQSUB ? ByElem(Elem, {0x72, 0x92})
                    : IROp->Op == OP_VUQADD ? ByElem(Elem, {0x70, 0x90})
                                            : ByElem(Elem, {0x73, 0x93});
    if (!Ok) {
      return false;
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VSMULL:
    Bin(IROp->Args[0], IROp->Args[1]);
    if (!ByElem(Elem, {0, 0x9c, 0xbc, 0xdc})) { // extmul_low_*_s, by destination element size
      return false;
    }
    SetV(Node);
    return true;
  case OP_VREV64: {
    uint8_t Idx[16];
    for (uint32_t i = 0; i < 16; i++) {
      const uint32_t Dword = i / 8, InDword = i % 8, E = InDword / Elem, B_ = InDword % Elem;
      Idx[i] = uint8_t(Dword * 8 + (8 / Elem - 1 - E) * Elem + B_);
    }
    FPR(IROp->Args[0]);
    FPR(IROp->Args[0]);
    Shuffle(Idx);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VABS:
    FPR(IROp->Args[0]);
    if (!ByElem(Elem, {0x60, 0x80, 0xa0, 0xc0})) {
      return false;
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  case OP_VSTOFVECTORINSERT: {
    // Vector1 with its low element (two elements for cvtpi2ps) replaced by the
    // signed integer(s) of Vector2 converted to float.
    auto Op = IROp->C<IROp_VSToFVectorInsert>();
    if (OpBytes > 16) {
      return false;
    }
    const bool D = Elem == 8;
    const uint32_t N = Op->HasTwoElements ? 2 : 1;
    FPR(Op->Vector1);
    for (uint32_t I = 0; I < N; I++) {
      FPR(Op->Vector2);
      Simd(D ? 0x1d : 0x1b); // i64x2 / i32x4.extract_lane
      B.u8(uint8_t(I));
      B.u8(D ? 0xb9 : 0xb2); // f64.convert_i64_s / f32.convert_i32_s
      Simd(D ? 0x22 : 0x20); // f64x2 / f32x4.replace_lane
      B.u8(uint8_t(I));
    }
    SetV(Node);
    return true;
  }
  case OP_VBSL: {
    auto Op = IROp->C<IROp_VBSL>();
    FPR(Op->VectorTrue);
    FPR(Op->VectorFalse);
    FPR(Op->VectorMask);
    Simd(0x52); // v128.bitselect
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VORN:
    FPR(IROp->Args[0]);
    FPR(IROp->Args[1]);
    Simd(0x4d);
    Simd(0x50);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  case OP_VBROADCASTFROMMEM: {
    auto Op = IROp->C<IROp_VBroadcastFromMem>();
    GPR(Op->Address);
    Wrap();
    if (Elem == 16) {
      Simd(0x00);
    } else if (!ByElem(Elem, {0x07, 0x08, 0x09, 0x0a})) { // v128.loadN_splat
      return false;
    }
    MemArg(0);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VLOADNONTEMPORAL: {
    auto Op = IROp->C<IROp_VLoadNonTemporal>();
    GPR(Op->Addr);
    Wrap();
    if (!LoadFPRSized(OpBytes, uint32_t(int32_t(Op->Offset)))) {
      return false;
    }
    SetV(Node);
    return true;
  }
  case OP_VSTORENONTEMPORAL: {
    auto Op = IROp->C<IROp_VStoreNonTemporal>();
    GPR(Op->Addr);
    Wrap();
    FPR(Op->Value);
    return StoreFPRSized(OpBytes, uint32_t(int32_t(Op->Offset)));
  }
  case OP_VSTORENONTEMPORALPAIR: {
    auto Op = IROp->C<IROp_VStoreNonTemporalPair>();
    for (uint32_t I = 0; I < 2; I++) {
      GPR(Op->Addr);
      Wrap();
      FPR(I ? Op->ValueHigh : Op->ValueLow);
      if (!StoreFPRSized(OpBytes, uint32_t(int32_t(Op->Offset)) + I * OpBytes)) {
        return false;
      }
    }
    return true;
  }
  case OP_VCMPEQZ:
  case OP_VCMPGTZ: {
    FPR(IROp->Args[0]);
    V128Const(0, 0);
    const bool Ok = IROp->Op == OP_VCMPEQZ ? ByElem(Elem, {0x23, 0x2d, 0x37, 0xd6}) : ByElem(Elem, {0x27, 0x31, 0x3b, 0xd9});
    if (!Ok) {
      return false;
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VNEG:
    FPR(IROp->Args[0]);
    if (!ByElem(Elem, {0x61, 0x81, 0xa1, 0xc1})) {
      return false;
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  case OP_VPOPCOUNT:
    FPR(IROp->Args[0]);
    if (Elem != 1) {
      return false;
    }
    Simd(0x62);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  case OP_VMUL:
    if (Elem == 1) { // no i8x16.mul: 16-bit products, low bytes
      for (int Hi = 0; Hi < 2; Hi++) {
        Bin(IROp->Args[0], IROp->Args[1]);
        Simd(Hi ? 0x9f : 0x9e); // i16x8.extmul_high/low_i8x16_u
      }
      const uint8_t Idx[16] = {0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30};
      Shuffle(Idx);
      KeepLow(OpBytes);
      SetV(Node);
      return true;
    }
    Bin(IROp->Args[0], IROp->Args[1]);
    if (!ByElem(Elem, {0, 0x95, 0xb5, 0xd5})) {
      return false;
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  case OP_VUMULL2:
  case OP_VSMULL2:
    Bin(IROp->Args[0], IROp->Args[1]);
    if (!(IROp->Op == OP_VUMULL2 ? ByElem(Elem, {0, 0x9f, 0xbf, 0xdf}) : ByElem(Elem, {0, 0x9d, 0xbd, 0xdd}))) {
      return false;
    }
    SetV(Node);
    return true;
  case OP_VUMULH:
  case OP_VSMULH: {
    // High half of the element products: widen, multiply, shift, narrow.
    const bool Sgn = IROp->Op == OP_VSMULH;
    if (Elem == 2) {
      for (int Hi = 0; Hi < 2; Hi++) {
        Bin(IROp->Args[0], IROp->Args[1]);
        Simd(Sgn ? (Hi ? 0xbd : 0xbc) : (Hi ? 0xbf : 0xbe));
        B.i32c(16);
        Simd(Sgn ? 0xac : 0xad);
      }
      Simd(Sgn ? 0x85 : 0x86); // narrow: the values fit, so no saturation
    } else if (Elem == 4) {
      for (int Hi = 0; Hi < 2; Hi++) {
        Bin(IROp->Args[0], IROp->Args[1]);
        Simd(Sgn ? (Hi ? 0xdd : 0xdc) : (Hi ? 0xdf : 0xde));
      }
      const uint8_t Idx[16] = {4, 5, 6, 7, 12, 13, 14, 15, 20, 21, 22, 23, 28, 29, 30, 31};
      Shuffle(Idx);
    } else {
      return false;
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VSXTL2:
  case OP_VUXTL2:
    FPR(IROp->Args[0]);
    if (!(IROp->Op == OP_VSXTL2 ? ByElem(Elem, {0, 0x88, 0xa8, 0xc8}) : ByElem(Elem, {0, 0x8a, 0xaa, 0xca}))) {
      return false;
    }
    SetV(Node);
    return true;
  case OP_VSSHLL:
  case OP_VSSHLL2: {
    auto Op = IROp->C<IROp_VSSHLL>();
    FPR(Op->Vector);
    if (!(IROp->Op == OP_VSSHLL ? ByElem(Elem, {0, 0x87, 0xa7, 0xc7}) : ByElem(Elem, {0, 0x88, 0xa8, 0xc8}))) {
      return false;
    }
    if (Op->BitShift) {
      B.i32c(Op->BitShift);
      ByElem(Elem, {0x6b, 0x8b, 0xab, 0xcb});
    }
    SetV(Node);
    return true;
  }
  case OP_VUABDL2: {
    const auto Widen = [&](OrderedNodeWrapper W) {
      FPR(W);
      return ByElem(Elem, {0, 0x8a, 0xaa, 0xca});
    };
    if (!Widen(IROp->Args[0]) || !Widen(IROp->Args[1]) || !ByElem(Elem, {0, 0x91, 0xb1, 0xd1}) ||
        !ByElem(Elem, {0, 0x80, 0xa0, 0xc0})) {
      return false;
    }
    SetV(Node);
    return true;
  }
  case OP_VTRN:
  case OP_VTRN2: {
    // trn1: even elements of each pair from (Lower, Upper); trn2: odd ones.
    const uint32_t Lanes = OpBytes / Elem, Odd = IROp->Op == OP_VTRN2;
    uint8_t Idx[16] = {};
    for (uint32_t i = 0; i < Lanes; i++) {
      const uint32_t Src = (i & ~1u) + Odd, FromUpper = i & 1;
      for (uint32_t b = 0; b < Elem; b++) {
        Idx[i * Elem + b] = uint8_t((FromUpper ? 16 : 0) + Src * Elem + b);
      }
    }
    Bin(IROp->Args[0], IROp->Args[1]);
    Shuffle(Idx);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VREV32: {
    uint8_t Idx[16];
    for (uint32_t i = 0; i < 16; i++) {
      const uint32_t Word = i / 4, InWord = i % 4, E = InWord / Elem, B_ = InWord % Elem;
      Idx[i] = uint8_t(Word * 4 + (4 / Elem - 1 - E) * Elem + B_);
    }
    FPR(IROp->Args[0]);
    FPR(IROp->Args[0]);
    Shuffle(Idx);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VADDP: {
    // addp: pairwise sums of Lower's elements, then Upper's. D form only for
    // an 8-byte OpSize (the MMX pmaddwd path uses OpSize 4 with the Q form).
    const uint32_t Width = OpBytes == 8 ? 8 : 16, Lanes = Width / Elem;
    uint8_t Even[16] = {}, OddI[16] = {};
    for (uint32_t i = 0; i < Lanes; i++) {
      const uint32_t J = 2 * i; // element index in the Lower:Upper concatenation (Lanes each)
      for (uint32_t b = 0; b < Elem; b++) {
        Even[i * Elem + b] = uint8_t((J / Lanes) * 16 + (J % Lanes) * Elem + b);
        OddI[i * Elem + b] = uint8_t(((J + 1) / Lanes) * 16 + ((J + 1) % Lanes) * Elem + b);
      }
    }
    Bin(IROp->Args[0], IROp->Args[1]);
    Shuffle(Even);
    Bin(IROp->Args[0], IROp->Args[1]);
    Shuffle(OddI);
    if (!ByElem(Elem, {0x6e, 0x8e, 0xae, 0xce})) {
      return false;
    }
    KeepLow(Width);
    SetV(Node);
    return true;
  }
  case OP_VFADDP: {
    const uint32_t Width = OpBytes == 8 ? 8 : 16, Lanes = Width / Elem;
    uint8_t Even[16] = {}, OddI[16] = {};
    for (uint32_t i = 0; i < Lanes; i++) {
      const uint32_t J = 2 * i;
      for (uint32_t b = 0; b < Elem; b++) {
        Even[i * Elem + b] = uint8_t((J / Lanes) * 16 + (J % Lanes) * Elem + b);
        OddI[i * Elem + b] = uint8_t(((J + 1) / Lanes) * 16 + ((J + 1) % Lanes) * Elem + b);
      }
    }
    Bin(IROp->Args[0], IROp->Args[1]);
    Shuffle(Even);
    Bin(IROp->Args[0], IROp->Args[1]);
    Shuffle(OddI);
    if (Elem == 4) {
      Simd(0xe4);
    } else if (Elem == 8) {
      Simd(0xf0);
    } else {
      return false;
    }
    KeepLow(Width);
    SetV(Node);
    return true;
  }
  case OP_VADDV:
  case OP_VUMAXV:
  case OP_VUMINV: {
    // Across-lanes reduction into element 0 (the rest zero): fold halves.
    const uint32_t Lanes = OpBytes / Elem;
    std::initializer_list<uint32_t> Ops = IROp->Op == OP_VADDV    ? std::initializer_list<uint32_t> {0x6e, 0x8e, 0xae, 0xce}
                                          : IROp->Op == OP_VUMAXV ? std::initializer_list<uint32_t> {0x79, 0x99, 0xb9}
                                                                  : std::initializer_list<uint32_t> {0x77, 0x97, 0xb7};
    FPR(IROp->Args[0]);
    KeepLow(OpBytes, false);
    B.set(VLocalFor(ID(Node)));
    for (uint32_t Width = Lanes / 2; Width >= 1; Width /= 2) {
      uint8_t Idx[16];
      for (uint32_t i = 0; i < 16; i++) {
        Idx[i] = uint8_t((i + Width * Elem) & 15);
      }
      B.get(VLocalFor(ID(Node)));
      B.get(VLocalFor(ID(Node)));
      B.get(VLocalFor(ID(Node)));
      Shuffle(Idx);
      if (!ByElem(Elem, Ops)) {
        return false;
      }
      B.set(VLocalFor(ID(Node)));
    }
    B.get(VLocalFor(ID(Node)));
    KeepLow(Elem);
    SetV(Node);
    return true;
  }
  case OP_VFABS:
  case OP_VFNEG:
  case OP_VFSQRT: {
    FPR(IROp->Args[0]);
    const int K = IROp->Op == OP_VFABS ? 0 : IROp->Op == OP_VFNEG ? 1 : 2;
    const uint8_t F32[] = {0xe0, 0xe1, 0xe3}, F64[] = {0xec, 0xed, 0xef};
    if (Elem == 4) {
      Simd(F32[K]);
    } else if (Elem == 8) {
      Simd(F64[K]);
    } else {
      return false;
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VFRECP:
  case OP_VFRECPPRECISION:
  case OP_VFRSQRT:
  case OP_VFRSQRTPRECISION: {
    // Exact 1/x and 1/sqrt(x), as FEX does without FEAT_RPRES.
    if (Elem != 4 && Elem != 8) {
      return false;
    }
    const bool D = Elem == 8;
    if (D) {
      V128Const(0x3FF0'0000'0000'0000ull, 0x3FF0'0000'0000'0000ull);
    } else {
      V128Const(0x3F80'0000'3F80'0000ull, 0x3F80'0000'3F80'0000ull);
    }
    FPR(IROp->Args[0]);
    if (IROp->Op == OP_VFRSQRT || IROp->Op == OP_VFRSQRTPRECISION) {
      Simd(D ? 0xef : 0xe3);
    }
    Simd(D ? 0xf3 : 0xe7);
    KeepLow(Elem == OpBytes ? Elem : OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VFRECPSCALARINSERT:
  case OP_VFRSQRTSCALARINSERT: {
    // Vector1 with element 0 = 1 / Vector2[0] (or 1 / sqrt).
    if ((Elem != 4 && Elem != 8) || OpBytes > 16) {
      return false;
    }
    const bool D = Elem == 8;
    Upper(IROp->Args[0]);
    FConst(D, 1.0);
    Lane0F(IROp->Args[1], D);
    if (IROp->Op == OP_VFRSQRTSCALARINSERT) {
      B.u8(D ? 0x9f : 0x91);
    }
    B.u8(D ? 0xa3 : 0x95);
    ReplaceLane0F(Elem);
    SetV(Node);
    return true;
  }
  case OP_VFMAX:
  case OP_VFMIN: {
    // x86 maxps/minps: the second operand unless Vector1 compares strictly
    // greater (less), so NaNs and equal zeros pick Vector2.
    if (Elem != 4 && Elem != 8) {
      return false;
    }
    const bool D = Elem == 8;
    FPR(IROp->Args[0]);
    FPR(IROp->Args[1]);
    FPR(IROp->Args[0]);
    FPR(IROp->Args[1]);
    Simd(IROp->Op == OP_VFMAX ? (D ? 0x4a : 0x44) : (D ? 0x49 : 0x43)); // gt / lt
    Simd(0x52);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VFCMPEQ:
  case OP_VFCMPNEQ:
  case OP_VFCMPLT:
  case OP_VFCMPGT:
  case OP_VFCMPLE:
  case OP_VFCMPORD:
  case OP_VFCMPUNO: {
    if (Elem != 4 && Elem != 8) {
      return false;
    }
    const bool D = Elem == 8;
    const uint8_t Eq = D ? 0x47 : 0x41, Ne = D ? 0x48 : 0x42, Lt = D ? 0x49 : 0x43, Gt = D ? 0x4a : 0x44, Le = D ? 0x4b : 0x45;
    switch (IROp->Op) {
    case OP_VFCMPEQ: Bin(IROp->Args[0], IROp->Args[1]); Simd(Eq); break;
    case OP_VFCMPNEQ: Bin(IROp->Args[0], IROp->Args[1]); Simd(Ne); break;
    case OP_VFCMPLT: Bin(IROp->Args[0], IROp->Args[1]); Simd(Lt); break;
    case OP_VFCMPGT: Bin(IROp->Args[0], IROp->Args[1]); Simd(Gt); break;
    case OP_VFCMPLE: Bin(IROp->Args[0], IROp->Args[1]); Simd(Le); break;
    default: // ordered: a == a && b == b
      FPR(IROp->Args[0]);
      FPR(IROp->Args[0]);
      Simd(Eq);
      FPR(IROp->Args[1]);
      FPR(IROp->Args[1]);
      Simd(Eq);
      Simd(0x4e);
      if (IROp->Op == OP_VFCMPUNO) {
        Simd(0x4d);
      }
      break;
    }
    KeepLow(Elem == OpBytes ? Elem : OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VFCOPYSIGN: {
    // magnitude of Vector1, sign of Vector2
    const uint64_t Sign = Elem == 8 ? 0x8000'0000'0000'0000ull : Elem == 4 ? 0x8000'0000'8000'0000ull : 0;
    if (!Sign) {
      return false;
    }
    FPR(IROp->Args[1]);
    FPR(IROp->Args[0]);
    V128Const(Sign, Sign);
    Simd(0x52);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VECTORIMM: {
    auto Op = IROp->C<IROp_VectorImm>();
    uint64_t E = uint64_t(Op->Immediate) << Op->ShiftAmount;
    uint64_t Rep = 0;
    switch (Elem) {
    case 1: Rep = 0x0101'0101'0101'0101ull * (E & 0xff); break;
    case 2: Rep = 0x0001'0001'0001'0001ull * (E & 0xffff); break;
    case 4: Rep = 0x0000'0001'0000'0001ull * (E & 0xffff'ffff); break;
    case 8: Rep = E; break;
    default: return false;
    }
    V128Const(Rep, OpBytes >= 16 ? Rep : 0);
    SetV(Node);
    return true;
  }
  case OP_VECTOR_STOF: {
    FPR(IROp->Args[0]);
    if (Elem == 4) {
      Simd(0xfa); // f32x4.convert_i32x4_s
    } else if (Elem == 8) {
      B.set(VLocalFor(ID(Node)));
      V128Const(0, 0);
      for (uint32_t I = 0; I < 2; I++) {
        B.get(VLocalFor(ID(Node)));
        Simd(0x1d);
        B.u8(uint8_t(I));
        B.u8(0xb9);
        Simd(0x22);
        B.u8(uint8_t(I));
      }
    } else {
      return false;
    }
    KeepLow(Elem == OpBytes ? Elem : OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VECTOR_FTOZS:
  case OP_VECTOR_FTOS: {
    // fcvtzs (saturating, NaN -> 0); FToS rounds to nearest first.
    FPR(IROp->Args[0]);
    if (Elem == 4) {
      if (IROp->Op == OP_VECTOR_FTOS) {
        RoundByMode(false, true);
      }
      Simd(0xf8);
    } else if (Elem == 8) {
      B.set(VLocalFor(ID(Node)));
      V128Const(0, 0);
      for (uint32_t I = 0; I < 2; I++) {
        B.get(VLocalFor(ID(Node)));
        Simd(0x21);
        B.u8(uint8_t(I));
        if (IROp->Op == OP_VECTOR_FTOS) {
          RoundByMode(true, false);
        }
        B.fc(6); // i64.trunc_sat_f64_s
        Simd(0x1e);
        B.u8(uint8_t(I));
      }
    } else {
      return false;
    }
    KeepLow(Elem == OpBytes ? Elem : OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VECTOR_FTOISIZED: {
    // frint32/64 x|z: round (host mode or toward zero) to an integral value;
    // out-of-range and NaN become the most negative integer of IntSize.
    auto Op = IROp->C<IROp_Vector_FToISized>();
    if (Elem != 4 && Elem != 8) {
      return false;
    }
    const bool D = Elem == 8;
    const double Lim = Op->IntSize == OpSize::i64Bit ? 9223372036854775808.0 : 2147483648.0;
    auto Splat = [&](double V) {
      uint64_t Bits_;
      if (D) {
        memcpy(&Bits_, &V, 8);
      } else {
        const float F = float(V);
        uint32_t B32;
        memcpy(&B32, &F, 4);
        Bits_ = uint64_t(B32) * 0x1'0000'0001ull;
      }
      V128Const(Bits_, Bits_);
    };
    const uint32_t V = NewLocal(V128), M = NewLocal(V128);
    FPR(Op->Vector);
    if (Op->HostRound) {
      RoundByMode(D, true);
    } else {
      Simd(D ? 0x7a : 0x69);
    }
    B.set(V);
    B.get(V);
    Splat(-Lim);
    Simd(D ? 0x4c : 0x46); // ge
    B.get(V);
    Splat(Lim);
    Simd(D ? 0x49 : 0x43); // lt
    Simd(0x4e);
    B.set(M);
    B.get(V);
    Splat(-Lim);
    B.get(M);
    Simd(0x52);
    KeepLow(Elem == OpBytes ? Elem : OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VECTOR_FTOF: {
    auto Op = IROp->C<IROp_Vector_FToF>();
    FPR(Op->Vector);
    if (Elem == 4 && Op->SrcElementSize == OpSize::i16Bit) { // F16C: 4 halves -> floats
      Simd(0xa9); // i32x4.extend_low_i16x8_u
      HalfToFloat();
      SetV(Node);
      return true;
    }
    if (Elem == 2 && Op->SrcElementSize == OpSize::i32Bit) { // 4 floats -> halves, upper half zero
      FloatToHalf();
      V128Const(0, 0);
      Simd(0x86); // i16x8.narrow_i32x4_u (values fit)
      SetV(Node);
      return true;
    }
    if (Elem == 8 && Op->SrcElementSize == OpSize::i32Bit) {
      Simd(0x5f); // f64x2.promote_low_f32x4
    } else if (Elem == 4 && Op->SrcElementSize == OpSize::i64Bit) {
      Simd(0x5e); // f32x4.demote_f64x2_zero
    } else {
      return false;
    }
    SetV(Node);
    return true;
  }
  case OP_VFCVTL2:
    FPR(IROp->Args[0]);
    if (Elem == 4) { // halves 4-7 -> floats
      Simd(0xaa); // i32x4.extend_high_i16x8_u
      HalfToFloat();
      SetV(Node);
      return true;
    }
    if (Elem != 8) {
      return false;
    }
    {
      const uint8_t Idx[16] = {8, 9, 10, 11, 12, 13, 14, 15, 8, 9, 10, 11, 12, 13, 14, 15};
      FPR(IROp->Args[0]);
      Shuffle(Idx);
    }
    Simd(0x5f);
    SetV(Node);
    return true;
  case OP_VFCVTN2: {
    // Lower's low half, then Upper narrowed to f32 in the high half.
    auto Op = IROp->C<IROp_VFCVTN2>();
    if (Elem == 2) { // lower's low half, then Upper's floats as halves
      FPR(Op->VectorLower);
      FPR(Op->VectorUpper);
      FloatToHalf();
      V128Const(0, 0);
      Simd(0x86);
      const uint8_t Idx[16] = {0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23};
      Shuffle(Idx);
      SetV(Node);
      return true;
    }
    if (Elem != 4) {
      return false;
    }
    FPR(Op->VectorLower);
    FPR(Op->VectorUpper);
    Simd(0x5e);
    const uint8_t Idx[16] = {0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23};
    Shuffle(Idx);
    SetV(Node);
    return true;
  }
  case OP_VECTOR_F64TOI32: {
    auto Op = IROp->C<IROp_Vector_F64ToI32>();
    FPR(Op->Vector);
    switch (Op->Round) {
    case RoundMode::Host: RoundByMode(true, true); break;
    case RoundMode::Nearest: Simd(0x94); break;
    case RoundMode::NegInfinity: Simd(0x75); break;
    case RoundMode::PosInfinity: Simd(0x74); break;
    case RoundMode::TowardsZero: Simd(0x7a); break;
    default: return false;
    }
    Simd(0xfc); // i32x4.trunc_sat_f64x2_s_zero
    SetV(Node);
    return true;
  }
  case OP_VSQXTN:
  case OP_VSQXTUN:
  case OP_VSQXTNPAIR:
  case OP_VSQXTUNPAIR:
  case OP_VSQXTN2:
  case OP_VSQXTUN2: {
    // Saturating narrow of (ElementSize-wide) elements to half width.
    const bool U = IROp->Op == OP_VSQXTUN || IROp->Op == OP_VSQXTUNPAIR || IROp->Op == OP_VSQXTUN2;
    const bool Pair = IROp->Op == OP_VSQXTNPAIR || IROp->Op == OP_VSQXTUNPAIR;
    const bool Two = IROp->Op == OP_VSQXTN2 || IROp->Op == OP_VSQXTUN2;
    const uint8_t Narrow = Elem == 1 ? (U ? 0x66 : 0x65) : Elem == 2 ? (U ? 0x86 : 0x85) : 0;
    if (!Narrow) { // ElementSize is the destination element size
      return false;
    }
    if (Pair) {
      Bin(IROp->Args[0], IROp->Args[1]);
      Simd(Narrow);
      if (OpBytes == 8) { // 64-bit sources: both results in the low 8 bytes
        const uint8_t Idx[16] = {0, 1, 2, 3, 8, 9, 10, 11, 16, 16, 16, 16, 16, 16, 16, 16};
        V128Const(0, 0);
        Shuffle(Idx);
      }
    } else if (Two) {
      FPR(IROp->Args[0]);
      FPR(IROp->Args[1]);
      V128Const(0, 0);
      Simd(Narrow);
      const uint8_t Idx[16] = {0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23};
      Shuffle(Idx);
    } else {
      FPR(IROp->Args[0]);
      V128Const(0, 0);
      Simd(Narrow);
    }
    SetV(Node);
    return true;
  }
  case OP_VUSHRNI:
  case OP_VUSHRNI2: {
    // shrn: (element >> BitShift) truncated to ElementSize, into the low half
    // (VUShrNI2: the high half, the low half from VectorLower).
    const bool Two = IROp->Op == OP_VUSHRNI2;
    auto Op1 = IROp->C<IROp_VUShrNI>();
    auto Op2 = IROp->C<IROp_VUShrNI2>();
    const uint8_t Shift = Two ? Op2->BitShift : Op1->BitShift;
    const OrderedNodeWrapper Src = Two ? Op2->VectorUpper : Op1->Vector;
    if (Elem > 4) {
      return false;
    }
    if (Two) {
      FPR(Op2->VectorLower);
    }
    FPR(Src);
    if (Shift) {
      B.i32c(Shift);
      if (!ByElem(Elem * 2, {0, 0x8d, 0xad, 0xcd})) {
        return false;
      }
    }
    if (!Two) {
      V128Const(0, 0);
    }
    uint8_t Idx[16];
    for (uint32_t i = 0; i < 16; i++) {
      const uint32_t Out = i / Elem, B_ = i % Elem;
      if (i < 8) {
        Idx[i] = uint8_t(Two ? i : Out * 2 * Elem + B_);
      } else {
        Idx[i] = uint8_t(Two ? 16 + (Out - 8 / Elem) * 2 * Elem + B_ : 16);
      }
    }
    Shuffle(Idx);
    SetV(Node);
    return true;
  }
  case OP_VUSHRAI: {
    auto Op = IROp->C<IROp_VUShraI>();
    FPR(Op->DestVector);
    FPR(Op->Vector);
    if (Op->BitShift >= Elem * 8) {
      B.u8(op::drop);
      V128Const(0, 0);
    } else {
      B.i32c(Op->BitShift);
      if (!ByElem(Elem, {0x6d, 0x8d, 0xad, 0xcd})) {
        return false;
      }
    }
    if (!ByElem(Elem, {0x6e, 0x8e, 0xae, 0xce})) {
      return false;
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VTBL2: {
    // Two-register table: indices 0-15 pick from table 1, 16-31 from table 2.
    auto Op = IROp->C<IROp_VTBL2>();
    if (uint8_t C[16]; ConstVector(Op->VectorIndices, C)) {
      bool InRange = true;
      for (uint8_t I : C) {
        InRange &= I < 32;
      }
      if (InRange) { // exactly an i8x16.shuffle of the two tables
        uint8_t Idx[16];
        memcpy(Idx, C, 16);
        FPR(Op->VectorTable1);
        FPR(Op->VectorTable2);
        Shuffle(Idx);
        KeepLow(OpBytes);
        SetV(Node);
        return true;
      }
    }
    FPR(Op->VectorTable1);
    FPR(Op->VectorIndices);
    Simd(0x0e);
    FPR(Op->VectorTable2);
    FPR(Op->VectorIndices);
    V128Const(0x1010'1010'1010'1010ull, 0x1010'1010'1010'1010ull);
    Simd(0x71); // i8x16.sub: 16-31 -> 0-15, others wrap out of range
    Simd(0x0e);
    Simd(0x50);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VTBX1: {
    // Like tbl, but out-of-range indices keep the destination byte.
    auto Op = IROp->C<IROp_VTBX1>();
    FPR(Op->VectorTable);
    FPR(Op->VectorIndices);
    Simd(0x0e);
    B.set(VLocalFor(ID(Node)));
    FPR(Op->VectorSrcDst);
    B.get(VLocalFor(ID(Node)));
    FPR(Op->VectorIndices);
    V128Const(0x0f0f'0f0f'0f0f'0f0full, 0x0f0f'0f0f'0f0f'0f0full);
    Simd(0x28); // i8x16.gt_u: index >= 16
    Simd(0x52);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VFMAXSCALARINSERT:
  case OP_VFMINSCALARINSERT: {
    // x86 maxss/minss: Vector1[0] if it compares strictly greater (less), else Vector2[0].
    if ((Elem != 4 && Elem != 8) || OpBytes > 16) {
      return false;
    }
    const bool D = Elem == 8, Max = IROp->Op == OP_VFMAXSCALARINSERT;
    Upper(IROp->Args[0]);
    auto Lane = [&](OrderedNodeWrapper W) { Lane0F(W, D); };
    Lane(IROp->Args[0]);
    Lane(IROp->Args[1]);
    Lane(IROp->Args[0]);
    Lane(IROp->Args[1]);
    B.u8(Max ? (D ? 0x64 : 0x5e) : (D ? 0x63 : 0x5d)); // gt / lt
    B.u8(op::select);
    ReplaceLane0F(Elem);
    SetV(Node);
    return true;
  }
  case OP_VFCMPSCALARINSERT: {
    auto Op = IROp->C<IROp_VFCMPScalarInsert>();
    if ((Elem != 4 && Elem != 8) || OpBytes > 16) {
      return false;
    }
    const bool D = Elem == 8;
    auto Lane = [&](OrderedNodeWrapper W) { Lane0F(W, D); };
    const uint8_t Eq = D ? 0x61 : 0x5b, Lt = D ? 0x63 : 0x5d, Le = D ? 0x65 : 0x5f;
    FPR(Op->Vector1);
    switch (Op->Op) {
    case FloatCompareOp::EQ: Lane(Op->Vector1); Lane(Op->Vector2); B.u8(Eq); break;
    case FloatCompareOp::NEQ: Lane(Op->Vector1); Lane(Op->Vector2); B.u8(Eq); B.u8(op::i32_eqz); break;
    case FloatCompareOp::LT: Lane(Op->Vector1); Lane(Op->Vector2); B.u8(Lt); break;
    case FloatCompareOp::LE: Lane(Op->Vector1); Lane(Op->Vector2); B.u8(Le); break;
    case FloatCompareOp::ORD:
    case FloatCompareOp::UNO:
      Lane(Op->Vector1);
      Lane(Op->Vector1);
      B.u8(Eq);
      Lane(Op->Vector2);
      Lane(Op->Vector2);
      B.u8(Eq);
      B.u8(op::i32_and);
      if (Op->Op == FloatCompareOp::UNO) {
        B.u8(op::i32_eqz);
      }
      break;
    default: return false;
    }
    // 0/1 -> all zeros / all ones of the element
    if (D) {
      B.u8(op::i64_extend_i32_u);
      B.set(T0);
      B.i64c(0);
      B.get(T0);
      B.u8(op::i64_sub);
      Simd(0x1e);
    } else {
      B.set(TC);
      B.i32c(0);
      B.get(TC);
      B.u8(op::i32_sub);
      Simd(0x1c);
    }
    B.u8(0);
    SetV(Node);
    return true;
  }
  case OP_VFTOFSCALARINSERT: {
    auto Op = IROp->C<IROp_VFToFScalarInsert>();
    const uint32_t Src = uint32_t(Op->SrcElementSize);
    if (OpBytes > 16 || !((Elem == 8 && Src == 4) || (Elem == 4 && Src == 8))) {
      return false; // TODO: half precision (F16C)
    }
    Upper(Op->Vector1);
    Lane0F(Op->Vector2, Src == 8);
    B.u8(Elem == 8 ? 0xbb : 0xb6); // f64.promote_f32 / f32.demote_f64
    ReplaceLane0F(Elem);
    SetV(Node);
    return true;
  }
  case OP_VFTOISCALARINSERT: {
    auto Op = IROp->C<IROp_VFToIScalarInsert>();
    if ((Elem != 4 && Elem != 8) || OpBytes > 16) {
      return false;
    }
    const bool D = Elem == 8;
    Upper(Op->Vector1);
    Lane0F(Op->Vector2, D);
    switch (Op->Round) {
    case RoundMode::Host: RoundByMode(D, false); break;
    case RoundMode::Nearest: B.u8(D ? 0x9e : 0x90); break;
    case RoundMode::NegInfinity: B.u8(D ? 0x9c : 0x8e); break;
    case RoundMode::PosInfinity: B.u8(D ? 0x9b : 0x8d); break;
    case RoundMode::TowardsZero: B.u8(D ? 0x9d : 0x8f); break;
    default: return false;
    }
    ReplaceLane0F(Elem);
    SetV(Node);
    return true;
  }
  case OP_VFMLA:
  case OP_VFMLS:
  case OP_VFNMLA:
  case OP_VFNMLS:
  case OP_VFMLASCALARINSERT:
  case OP_VFMLSSCALARINSERT:
  case OP_VFNMLASCALARINSERT:
  case OP_VFNMLSSCALARINSERT: {
    // MLA: a + v1*v2, MLS: v1*v2 - a, NMLA: a - v1*v2, NMLS: -(v1*v2) - a,
    // all fused: fma(+-v1, v2, +-a).
    const bool Ins = IROp->Op == OP_VFMLASCALARINSERT || IROp->Op == OP_VFMLSSCALARINSERT || IROp->Op == OP_VFNMLASCALARINSERT ||
                     IROp->Op == OP_VFNMLSSCALARINSERT;
    const bool NegProd = IROp->Op == OP_VFNMLA || IROp->Op == OP_VFNMLS || IROp->Op == OP_VFNMLASCALARINSERT ||
                         IROp->Op == OP_VFNMLSSCALARINSERT;
    const bool NegAdd = IROp->Op == OP_VFMLS || IROp->Op == OP_VFNMLS || IROp->Op == OP_VFMLSSCALARINSERT ||
                        IROp->Op == OP_VFNMLSSCALARINSERT;
    if ((Elem != 4 && Elem != 8) || OpBytes > 16) {
      return false;
    }
    const bool D = Elem == 8;
    const uint32_t A = Ins ? 1 : 0; // Args: [Upper,] Vector1, Vector2, Addend
    const uint32_t V1 = NewLocal(V128), V2 = NewLocal(V128), Ad = NewLocal(V128);
    FPR(IROp->Args[A]);
    if (NegProd) {
      Simd(D ? 0xed : 0xe1);
    }
    B.set(V1);
    FPR(IROp->Args[A + 1]);
    B.set(V2);
    FPR(IROp->Args[A + 2]);
    if (NegAdd) {
      Simd(D ? 0xed : 0xe1);
    }
    B.set(Ad);
    if (Ins) {
      FPR(IROp->Args[0]);
    }
    FusedMulAdd(D, V1, V2, Ad);
    if (Ins) {
      Simd(D ? 0x21 : 0x1f);
      B.u8(0);
      ReplaceLane0F(Elem);
    } else {
      KeepLow(Elem == OpBytes ? Elem : OpBytes);
    }
    SetV(Node);
    return true;
  }
  case OP_VUSHL:
  case OP_VUSHR:
  case OP_VSSHR: {
    // Per-element shift by the matching element of ShiftVector. Logical
    // shifts of >= the element width give 0, arithmetic ones the sign.
    auto Op = IROp->C<IROp_VUShl>();
    if (Elem != 4 && Elem != 8) {
      return false;
    }
    const bool W = Elem == 8;
    const uint32_t Lanes = (OpBytes == 8 ? 8 : 16) / Elem, EBits = Elem * 8;
    const uint32_t R = VLocalFor(ID(Node)), X = NewLocal(W ? I64 : I32), Amt = NewLocal(W ? I64 : I32);
    V128Const(0, 0);
    B.set(R);
    for (uint32_t I = 0; I < Lanes; I++) {
      FPR(Op->Vector);
      Simd(W ? 0x1d : 0x1b);
      B.u8(uint8_t(I));
      B.set(X);
      FPR(Op->ShiftVector);
      Simd(W ? 0x1d : 0x1b);
      B.u8(uint8_t(I));
      B.set(Amt);
      B.get(R);
      auto C = [&](int64_t V) {
        if (W) {
          B.i64c(V);
        } else {
          B.i32c(int32_t(V));
        }
      };
      if (IROp->Op == OP_VSSHR) {
        B.get(X);
        B.get(Amt);
        C(EBits - 1);
        B.get(Amt);
        C(EBits - 1);
        B.u8(W ? op::i64_lt_u : op::i32_lt_u);
        B.u8(op::select);
        B.u8(W ? op::i64_shr_s : op::i32_shr_s);
      } else {
        B.get(X);
        B.get(Amt);
        B.u8(IROp->Op == OP_VUSHL ? (W ? op::i64_shl : op::i32_shl) : (W ? op::i64_shr_u : op::i32_shr_u));
        C(0);
        B.get(Amt);
        C(EBits);
        B.u8(W ? op::i64_lt_u : op::i32_lt_u);
        B.u8(op::select);
      }
      Simd(W ? 0x1e : 0x1c);
      B.u8(uint8_t(I));
      B.set(R);
    }
    B.get(R);
    KeepLow(OpBytes == 8 ? 8 : 16);
    SetV(Node);
    return true;
  }
  case OP_VUSHLS:
  case OP_VUSHRS:
  case OP_VSSHRS: {
    // Every element shifted by the low byte of ShiftScalar (ushl/sshl semantics).
    auto Op = IROp->C<IROp_VUShlS>();
    const uint32_t EBits = Elem * 8;
    const bool Arith = IROp->Op == OP_VSSHRS;
    FPR(Op->ShiftScalar);
    Simd(0x16); // i8x16.extract_lane_u 0
    B.u8(0);
    B.set(TC);
    FPR(Op->Vector);
    B.get(TC);
    if (Arith) {
      B.i32c(int32_t(EBits - 1));
      B.get(TC);
      B.i32c(int32_t(EBits - 1));
      B.u8(op::i32_lt_u);
      B.u8(op::select);
    }
    const bool Ok = IROp->Op == OP_VUSHLS ? ByElem(Elem, {0x6b, 0x8b, 0xab, 0xcb})
                    : Arith               ? ByElem(Elem, {0x6c, 0x8c, 0xac, 0xcc})
                                          : ByElem(Elem, {0x6d, 0x8d, 0xad, 0xcd});
    if (!Ok) {
      return false;
    }
    if (!Arith) {
      V128Const(0, 0);
      B.get(TC);
      B.i32c(int32_t(EBits));
      B.u8(op::i32_lt_u);
      B.u8(op::select);
    }
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VSQSHL:
  case OP_VSRSHR: {
    // Signed saturating shift left / signed rounding shift right by an
    // immediate, computed at double width (8/16-bit elements).
    const uint8_t Shift = IROp->Op == OP_VSQSHL ? IROp->C<IROp_VSQSHL>()->BitShift : IROp->C<IROp_VSRSHR>()->BitShift;
    if (Elem == 4 && IROp->Op == OP_VSQSHL) {
      for (int Hi = 0; Hi < 2; Hi++) {
        const uint32_t W = NewLocal(V128);
        FPR(IROp->Args[0]);
        Simd(Hi ? 0xc8 : 0xc7); // i64x2.extend_high/low_i32x4_s
        B.i32c(Shift);
        Simd(0xcb); // i64x2.shl
        B.set(W);
        // clamp to [INT32_MIN, INT32_MAX]
        V128Const(0x7FFF'FFFFull, 0x7FFF'FFFFull);
        B.get(W);
        B.get(W);
        V128Const(0x7FFF'FFFFull, 0x7FFF'FFFFull);
        Simd(0xd9); // i64x2.gt_s
        Simd(0x52);
        B.set(W);
        V128Const(0xFFFF'FFFF'8000'0000ull, 0xFFFF'FFFF'8000'0000ull);
        B.get(W);
        B.get(W);
        V128Const(0xFFFF'FFFF'8000'0000ull, 0xFFFF'FFFF'8000'0000ull);
        Simd(0xd8); // i64x2.lt_s
        Simd(0x52);
      }
      const uint8_t Idx[16] = {0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 24, 25, 26, 27};
      Shuffle(Idx);
      KeepLow(OpBytes);
      SetV(Node);
      return true;
    }
    if (Elem != 1 && Elem != 2) {
      return false;
    }
    const bool Q = IROp->Op == OP_VSQSHL;
    for (int Hi = 0; Hi < 2; Hi++) {
      FPR(IROp->Args[0]);
      Simd(Elem == 1 ? (Hi ? 0x88 : 0x87) : (Hi ? 0xa8 : 0xa7)); // extend_low/high_s
      if (Q) {
        B.i32c(Shift);
        Simd(Elem == 1 ? 0x8b : 0xab);
      } else {
        if (Shift) {
          const uint64_t Round = 1ull << (Shift - 1);
          const uint64_t Rep = Elem == 1 ? Round * 0x0001'0001'0001'0001ull : Round * 0x0000'0001'0000'0001ull;
          V128Const(Rep, Rep);
          Simd(Elem == 1 ? 0x8e : 0xae);
        }
        B.i32c(Shift);
        Simd(Elem == 1 ? 0x8c : 0xac);
      }
    }
    Simd(Elem == 1 ? 0x65 : 0x85); // narrow_s (saturating)
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_VLOADVECTORMASKED:
  case OP_VSTOREVECTORMASKED: {
    // vmaskmov: elements whose mask sign bit is set are loaded (others 0) or
    // stored; masked-off elements are not accessed.
    const bool Load = IROp->Op == OP_VLOADVECTORMASKED;
    auto L = IROp->C<IROp_VLoadVectorMasked>();
    auto St = IROp->C<IROp_VStoreVectorMasked>();
    if ((Elem != 4 && Elem != 8) || OpBytes > 16) {
      return false;
    }
    const bool W = Elem == 8;
    const uint32_t Lanes = 16 / Elem;
    const uint32_t Addr = NewLocal(I32), R = VLocalFor(ID(Node));
    if (Load) {
      Address(L->Addr, L->Offset, L->OffsetType, L->OffsetScale);
    } else {
      Address(St->Addr, St->Offset, St->OffsetType, St->OffsetScale);
    }
    Wrap();
    B.set(Addr);
    if (Load) {
      V128Const(0, 0);
      B.set(R);
    }
    for (uint32_t I = 0; I < Lanes; I++) {
      FPR(Load ? L->Mask : St->Mask);
      Simd(W ? 0x1d : 0x1b);
      B.u8(uint8_t(I));
      if (W) {
        B.i64c(0);
        B.u8(op::i64_lt_s);
      } else {
        B.i32c(0);
        B.u8(op::i32_lt_s);
      }
      B.u8(op::if_);
      B.u8(0x40);
      if (Load) {
        B.get(Addr);
        B.get(R);
        Simd(W ? 0x57 : 0x56); // v128.load64/32_lane
        B.u32(0);
        B.u32(I * Elem);
        B.u8(uint8_t(I));
        B.set(R);
      } else {
        B.get(Addr);
        FPR(St->Data);
        Simd(W ? 0x5b : 0x5a); // v128.store64/32_lane
        B.u32(0);
        B.u32(I * Elem);
        B.u8(uint8_t(I));
      }
      B.u8(op::end);
    }
    if (Load) {
      B.get(R);
      SetV(Node);
    }
    return true;
  }
  case OP_VLOADVECTORGATHERMASKED:
  case OP_VLOADVECTORGATHERMASKEDQPS: {
    // AVX2 gathers, element by element as FEX's ASIMD fallback does:
    // addr = base + sext(index) * scale for each element whose mask sign bit is set.
    const bool QPS = IROp->Op == OP_VLOADVECTORGATHERMASKEDQPS;
    auto G = IROp->C<IROp_VLoadVectorGatherMasked>();
    auto GQ = IROp->C<IROp_VLoadVectorGatherMaskedQPS>();
    const OrderedNodeWrapper Incoming = QPS ? GQ->Incoming : G->Incoming, Mask = QPS ? GQ->MaskReg : G->Mask;
    const OrderedNodeWrapper Base = QPS ? GQ->AddrBase : G->AddrBase, IdxLo = QPS ? GQ->VectorIndexLow : G->VectorIndexLow;
    const OrderedNodeWrapper IdxHi = QPS ? GQ->VectorIndexHigh : G->VectorIndexHigh;
    const uint32_t IdxSize = QPS ? 8 : uint32_t(G->VectorIndexElementSize);
    const uint32_t Scale = QPS ? GQ->OffsetScale : G->OffsetScale;
    const uint32_t DataStart = QPS ? 0 : G->DataElementOffsetStart, IdxStart = QPS ? 0 : G->IndexElementOffsetStart;
    const bool Addr32 = (QPS ? GQ->AddrSize : G->AddrSize) == OpSize::i32Bit;
    const uint32_t DataElem = QPS ? 4 : Elem;
    if (OpBytes > 16 || (DataElem != 4 && DataElem != 8) || (IdxSize != 4 && IdxSize != 8)) {
      return false;
    }
    const uint32_t NumAddr = (IdxHi.IsInvalid() ? 16 : 32) / IdxSize;
    const uint32_t NumData = std::min<uint32_t>(16 / DataElem, NumAddr);
    const uint32_t R = VLocalFor(ID(Node)), A = NewLocal(I64);
    FPR(Incoming);
    B.set(R);
    for (uint32_t I = DataStart, J = IdxStart; I < NumData; I++, J++) {
      FPR(Mask);
      Simd(DataElem == 8 ? 0x1d : 0x1b);
      B.u8(uint8_t(I));
      if (DataElem == 8) {
        B.i64c(0);
        B.u8(op::i64_lt_s);
      } else {
        B.i32c(0);
        B.u8(op::i32_lt_s);
      }
      B.u8(op::if_);
      B.u8(0x40);
      const bool FromHi = J * IdxSize >= 16;
      FPR(FromHi ? IdxHi : IdxLo);
      const uint32_t Lane = FromHi ? J - 16 / IdxSize : J;
      if (IdxSize == 8) {
        Simd(0x1d);
        B.u8(uint8_t(Lane));
      } else {
        Simd(0x1b);
        B.u8(uint8_t(Lane));
        B.u8(op::i64_extend_i32_s);
      }
      if (Scale > 1) {
        B.i64c(__builtin_ctz(Scale));
        B.u8(op::i64_shl);
      }
      if (!Base.IsInvalid()) {
        GPR(Base);
        B.u8(op::i64_add);
      }
      if (Addr32) {
        B.i64c(0xFFFF'FFFF);
        B.u8(op::i64_and);
      }
      Wrap();
      B.get(R);
      Simd(DataElem == 8 ? 0x57 : 0x56);
      B.u32(0);
      B.u32(0);
      B.u8(uint8_t(I));
      B.set(R);
      B.u8(op::end);
    }
    B.get(R);
    SetV(Node);
    return true;
  }
  case OP_FLOAT_FTOF: {
    auto Op = IROp->C<IROp_Float_FToF>();
    const uint32_t Dst = uint32_t(IROp->Size), Src = uint32_t(Op->SrcElementSize);
    if (!((Dst == 8 && Src == 4) || (Dst == 4 && Src == 8))) {
      return false;
    }
    V128Const(0, 0);
    Lane0F(Op->Scalar, Src == 8);
    B.u8(Dst == 8 ? 0xbb : 0xb6); // f64.promote_f32 / f32.demote_f64
    Simd(Dst == 8 ? 0x22 : 0x20);
    B.u8(0);
    SetV(Node);
    return true;
  }
  case OP_NZCVSELECTV: {
    // fcsel on the scalar element; the rest of the register is zeroed.
    auto Op = IROp->C<IROp_NZCVSelectV>();
    FPR(Op->TrueVal);
    FPR(Op->FalseVal);
    Condition(Op->Cond);
    B.u8(op::select);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_F80CVT: { // x87 80-bit -> f64 / f32
    V128Const(0, 0);
    FPR(IROp->Args[0]);
    Call(FUNC_F80TOF64);
    if (OpBytes == 4) {
      B.u8(0xb6); // f32.demote_f64
      Simd(0x20);
    } else {
      Simd(0x22);
    }
    B.u8(0);
    SetV(Node);
    return true;
  }
  case OP_F80CVTTO: { // f32 / f64 -> x87 80-bit, exactly
    auto Op = IROp->C<IROp_F80CVTTo>();
    FPR(Op->X80Src);
    if (Op->SrcSize == OpSize::i32Bit) {
      Simd(0x1f);
      B.u8(0);
      B.u8(0xbb); // f64.promote_f32
    } else {
      Simd(0x21);
      B.u8(0);
    }
    Call(FUNC_F64TOF80);
    SetV(Node);
    return true;
  }
  case OP_F80CVTTOINT: { // fild
    auto Op = IROp->C<IROp_F80CVTToInt>();
    GPR(Op->Src);
    switch (Op->SrcSize) {
    case OpSize::i16Bit: B.u8(op::i64_extend16_s); break;
    case OpSize::i32Bit: B.u8(op::i64_extend32_s); break;
    default: break;
    }
    Call(FUNC_I64TOF80);
    SetV(Node);
    return true;
  }
  case OP_F80CVTINT: { // fist / fistp / fisttp: out of range and NaN give the integer indefinite
    auto Op = IROp->C<IROp_F80CVTInt>();
    const uint32_t Bits_ = OpBytes * 8, D = NewLocal(F64);
    FPR(Op->X80Src);
    Call(FUNC_F80TOF64);
    B.set(D);
    if (Op->Truncate) {
      B.get(D);
      B.u8(0x9d); // f64.trunc
    } else {
      // the x87 control word's rounding: 0 nearest, 1 down, 2 up, 3 toward zero
      const uint32_t RC = NewLocal(I32);
      SysBase();
      B.mem(op::i32_load16_u, 1, Cfg.CtxAddr + offsetof(CPUState, FCW));
      B.i32c(10);
      B.u8(op::i32_shr_u);
      B.i32c(3);
      B.u8(op::i32_and);
      B.set(RC);
      B.get(D);
      B.u8(0x9c); // floor
      B.get(D);
      B.u8(0x9b); // ceil
      B.get(RC);
      B.i32c(1);
      B.u8(op::i32_eq);
      B.u8(op::select);
      B.get(D);
      B.u8(0x9d); // trunc
      B.get(RC);
      B.i32c(3);
      B.u8(op::i32_ne);
      B.u8(op::select);
      B.get(D);
      B.u8(0x9e); // nearest
      B.get(RC);
      B.u8(op::select); // RC != 0 ? directed : nearest
    }
    B.set(D);
    B.get(D);
    B.fc(6); // i64.trunc_sat_f64_s
    B.i64c(int64_t(1ull << (Bits_ - 1)));
    B.get(D);
    B.f64c(-std::ldexp(1.0, int(Bits_) - 1));
    B.u8(0x66); // f64.ge
    B.get(D);
    B.f64c(std::ldexp(1.0, int(Bits_) - 1));
    B.u8(0x63); // f64.lt
    B.u8(op::i32_and);
    B.tee(TC);
    B.u8(op::select);
    // invalid: raise the x87 IE flag
    B.get(TC);
    B.u8(op::i32_eqz);
    B.u8(op::if_);
    B.u8(0x40);
    SysBase();
    B.i32c(1);
    B.mem(op::i32_store8, 0, Cfg.CtxAddr + offsetof(CPUState, flags) + FEXCore::X86State::X87FLAG_IE_LOC);
    B.u8(op::end);
    if (Bits_ < 64) {
      B.i64c(int64_t((1ull << Bits_) - 1));
      B.u8(op::i64_and);
    }
    SetNode(Node);
    return true;
  }
  case OP_F64SIN:
  case OP_F64COS:
  case OP_F64TAN:
  case OP_F64F2XM1:
  case OP_F64ATAN:
  case OP_F64FPREM:
  case OP_F64FPREM1:
  case OP_F64FYL2X:
  case OP_F64FYL2XP1:
  case OP_F64SCALE: {
    const bool Two = IROp->Op != OP_F64SIN && IROp->Op != OP_F64COS && IROp->Op != OP_F64TAN && IROp->Op != OP_F64F2XM1;
    const uint32_t Fn = IROp->Op == OP_F64SIN     ? FUNC_SIN
                        : IROp->Op == OP_F64COS   ? FUNC_COS
                        : IROp->Op == OP_F64TAN   ? FUNC_TAN
                        : IROp->Op == OP_F64F2XM1 ? FUNC_F2XM1
                        : IROp->Op == OP_F64ATAN  ? FUNC_ATAN2
                        : IROp->Op == OP_F64FPREM ? FUNC_FPREM
                        : IROp->Op == OP_F64FPREM1 ? FUNC_FPREM1
                        : IROp->Op == OP_F64FYL2X ? FUNC_FYL2X
                        : IROp->Op == OP_F64FYL2XP1 ? FUNC_FYL2XP1
                                                    : FUNC_FSCALE;
    V128Const(0, 0);
    FPR(IROp->Args[0]);
    Simd(0x21);
    B.u8(0);
    if (Two) {
      FPR(IROp->Args[1]);
      Simd(0x21);
      B.u8(0);
    }
    Call(Fn);
    Simd(0x22);
    B.u8(0);
    SetV(Node);
    return true;
  }
  case OP_F64SINCOS: {
    auto Op = IROp->C<IROp_F64SINCOS>();
    for (int Cos = 0; Cos < 2; Cos++) {
      V128Const(0, 0);
      FPR(Op->Src);
      Simd(0x21);
      B.u8(0);
      Call(Cos ? FUNC_COS : FUNC_SIN);
      Simd(0x22);
      B.u8(0);
      B.set(VLocalFor(ID(Cos ? Op->OutCos : Op->OutSin)));
    }
    return true;
  }
  case OP_VMOV:
    FPR(IROp->C<IROp_VMov>()->Source);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  case OP_VCASTFROMGPR: {
    auto Op = IROp->C<IROp_VCastFromGPR>();
    V128Const(0, 0);
    if (Elem == 8) {
      GPR(Op->Src);
      Simd(0x1e); // i64x2.replace_lane
    } else {
      GPR32(Op->Src);
      if (Elem < 4) {
        B.i32c(Elem == 1 ? 0xff : 0xffff);
        B.u8(op::i32_and);
      }
      Simd(0x1c); // i32x4.replace_lane
    }
    B.u8(0);
    SetV(Node);
    return true;
  }
  case OP_VEXTRACTTOGPR: {
    auto Op = IROp->C<IROp_VExtractToGPR>();
    FPR(Op->Vector);
    switch (OpBytes) {
    case 8: Simd(0x1d); B.u8(Op->Index); break;
    case 4: Simd(0x1b); B.u8(Op->Index); B.u8(op::i64_extend_i32_u); break;
    case 2: Simd(0x19); B.u8(Op->Index); B.u8(op::i64_extend_i32_u); break;
    case 1: Simd(0x16); B.u8(Op->Index); B.u8(op::i64_extend_i32_u); break;
    default: return false;
    }
    SetNode(Node);
    return true;
  }
  case OP_VLOADVECTORELEMENT: {
    auto Op = IROp->C<IROp_VLoadVectorElement>();
    GPR(Op->Addr);
    Wrap();
    if (Elem == 16) {
      Simd(0x00);
      MemArg(0);
    } else {
      FPR(Op->DstSrc);
      if (!ByElem(Elem, {0x54, 0x55, 0x56, 0x57})) {
        return false;
      }
      MemArg(0);
      B.u8(Op->Index);
    }
    SetV(Node);
    return true;
  }
  case OP_VSTOREVECTORELEMENT: {
    auto Op = IROp->C<IROp_VStoreVectorElement>();
    GPR(Op->Addr);
    Wrap();
    FPR(Op->Value);
    if (Elem == 16) {
      Simd(0x0b);
      MemArg(0);
    } else {
      if (!ByElem(Elem, {0x58, 0x59, 0x5a, 0x5b})) {
        return false;
      }
      MemArg(0);
      B.u8(Op->Index);
    }
    return true;
  }
  case OP_LOADNAMEDVECTORCONSTANT: {
    auto Op = IROp->C<IROp_LoadNamedVectorConstant>();
    uint64_t Lo = 0, Hi = 0;
    if (Op->Constant != NamedVectorConstant::NAMED_VECTOR_ZERO) {
      if (!Cfg.NamedConstants || OpBytes > 16) {
        return false;
      }
      memcpy(&Lo, Cfg.NamedConstants + 16 * Op->Constant, 8);
      memcpy(&Hi, Cfg.NamedConstants + 16 * Op->Constant + 8, 8);
    }
    V128Const(Lo, Hi);
    KeepLow(OpBytes);
    SetV(Node);
    return true;
  }
  case OP_LOADNAMEDVECTORINDEXEDCONSTANT: {
    auto Op = IROp->C<IROp_LoadNamedVectorIndexedConstant>();
    if (!Cfg.IndexedConstantPointers || OpBytes > 16) {
      return false;
    }
    uint8_t Bytes[16] = {};
    memcpy(Bytes, reinterpret_cast<const uint8_t*>(Cfg.IndexedConstantPointers[Op->Constant]) + Op->Index, OpBytes);
    uint64_t Lo, Hi;
    memcpy(&Lo, Bytes, 8);
    memcpy(&Hi, Bytes + 8, 8);
    V128Const(Lo, Hi);
    SetV(Node);
    return true;
  }
  case OP_VCMPEQ:
  case OP_VCMPGT: {
    if (Elem == OpBytes) {
      return false; // scalar compare form
    }
    Bin(IROp->Args[0], IROp->Args[1]);
    const bool Ok = IROp->Op == OP_VCMPEQ ? ByElem(Elem, {0x23, 0x2d, 0x37, 0xd6}) : ByElem(Elem, {0x27, 0x31, 0x3b, 0xd9});
    if (!Ok) {
      return false;
    }
    SetV(Node);
    return true;
  }
  case OP_VUMIN:
  case OP_VUMAX:
  case OP_VSMIN:
  case OP_VSMAX: {
    Bin(IROp->Args[0], IROp->Args[1]);
    bool Ok = IROp->Op == OP_VUMIN   ? ByElem(Elem, {0x77, 0x97, 0xb7})
              : IROp->Op == OP_VUMAX ? ByElem(Elem, {0x79, 0x99, 0xb9})
              : IROp->Op == OP_VSMIN ? ByElem(Elem, {0x76, 0x96, 0xb6})
                                     : ByElem(Elem, {0x78, 0x98, 0xb8});
    if (!Ok) {
      return false;
    }
    SetV(Node);
    return true;
  }
  case OP_VINSELEMENT: {
    auto Op = IROp->C<IROp_VInsElement>();
    if (OpBytes > 16) {
      return false;
    }
    if (Elem == 4 || Elem == 8) { // replace_lane(extract_lane): B3 makes it an ins, not a tbl
      const bool D = Elem == 8;
      FPR(Op->DestVector);
      FPR(Op->SrcVector);
      Simd(D ? 0x1d : 0x1b); // i64x2 / i32x4.extract_lane
      B.u8(uint8_t(Op->SrcIdx));
      Simd(D ? 0x1e : 0x1c); // i64x2 / i32x4.replace_lane
      B.u8(uint8_t(Op->DestIdx));
      SetV(Node);
      return true;
    }
    uint8_t Idx[16];
    for (uint32_t i = 0; i < 16; i++) {
      Idx[i] = uint8_t(i);
    }
    for (uint32_t b = 0; b < Elem; b++) {
      Idx[Op->DestIdx * Elem + b] = uint8_t(16 + Op->SrcIdx * Elem + b);
    }
    FPR(Op->DestVector);
    FPR(Op->SrcVector);
    Shuffle(Idx);
    SetV(Node);
    return true;
  }

  // ---- floating point ----
  case OP_VFADD:
  case OP_VFSUB:
  case OP_VFMUL:
  case OP_VFDIV: {
    if (Elem != 4 && Elem != 8) {
      return false;
    }
    const int K = IROp->Op == OP_VFADD ? 0 : IROp->Op == OP_VFSUB ? 1 : IROp->Op == OP_VFMUL ? 2 : 3;
    if (Elem == OpBytes) { // scalar: lane 0, upper zeroed
      if (UpperDead(Node, Elem)) {
        InsertSplat = true;
      } else {
        V128Const(0, 0);
      }
      const uint8_t S32[] = {0x92, 0x93, 0x94, 0x95}, S64[] = {0xa0, 0xa1, 0xa2, 0xa3};
      ScalarF(Elem, S32[K], S64[K], IROp->Args[0], IROp->Args[1]);
      ReplaceLane0F(Elem);
    } else {
      Bin(IROp->Args[0], IROp->Args[1]);
      const uint32_t V32[] = {0xe4, 0xe5, 0xe6, 0xe7}, V64[] = {0xf0, 0xf1, 0xf2, 0xf3};
      Simd(Elem == 4 ? V32[K] : V64[K]);
      KeepLow(OpBytes);
    }
    SetV(Node);
    return true;
  }
  case OP_VFADDSCALARINSERT:
  case OP_VFSUBSCALARINSERT:
  case OP_VFMULSCALARINSERT:
  case OP_VFDIVSCALARINSERT: {
    if ((Elem != 4 && Elem != 8) || OpBytes > 16) {
      return false;
    }
    const int K = IROp->Op == OP_VFADDSCALARINSERT ? 0 : IROp->Op == OP_VFSUBSCALARINSERT ? 1 : IROp->Op == OP_VFMULSCALARINSERT ? 2 : 3;
    const uint8_t S32[] = {0x92, 0x93, 0x94, 0x95}, S64[] = {0xa0, 0xa1, 0xa2, 0xa3};
    Upper(IROp->Args[0]); // upper lanes come from Vector1
    ScalarF(Elem, S32[K], S64[K], IROp->Args[0], IROp->Args[1]);
    ReplaceLane0F(Elem);
    SetV(Node);
    return true;
  }
  case OP_VFSQRTSCALARINSERT: {
    if ((Elem != 4 && Elem != 8) || OpBytes > 16) {
      return false;
    }
    Upper(IROp->Args[0]);
    Lane0F(IROp->Args[1], Elem == 8);
    B.u8(Elem == 4 ? 0x91 : 0x9f); // f32.sqrt / f64.sqrt
    ReplaceLane0F(Elem);
    SetV(Node);
    return true;
  }
  case OP_VSTOFGPRINSERT:
  case OP_FLOAT_FROMGPR_S: {
    uint32_t SrcBytes;
    OrderedNodeWrapper Src;
    if (IROp->Op == OP_VSTOFGPRINSERT) {
      auto Op = IROp->C<IROp_VSToFGPRInsert>();
      if (OpBytes > 16) {
        return false;
      }
      SrcBytes = uint32_t(Op->SrcElementSize);
      Src = Op->Src;
      Upper(Op->Vector);
    } else {
      auto Op = IROp->C<IROp_Float_FromGPR_S>();
      SrcBytes = uint32_t(Op->SrcElementSize);
      Src = Op->Src;
      if (Elem <= 8 && UpperDead(Node, Elem)) {
        InsertSplat = true;
      } else {
        V128Const(0, 0);
      }
    }
    if (SrcBytes == 8) {
      GPR(Src);
    } else {
      GPR32(Src);
    }
    if (Elem == 8) {
      B.u8(SrcBytes == 8 ? 0xb9 : 0xb7); // f64.convert_i64_s / _i32_s
    } else if (Elem == 4) {
      B.u8(SrcBytes == 8 ? 0xb4 : 0xb2); // f32.convert_i64_s / _i32_s
    } else {
      return false;
    }
    ReplaceLane0F(Elem);
    SetV(Node);
    return true;
  }
  default: return false;
  }
}

// $mat(fk, fa, fb, nzcv) -> nzcv: arm64-layout NZCV from the lazy flag state.
// Pushes the arm64-layout NZCV (i32) of a lazy flag state of kind K whose
// operands are in locals Fa, Fb (and, for the ...K kinds, whose carry is bit
// 29 of local Nz); R is a scratch i64 local.
static void EmitNZCVOfKind(Buf& F, FlagKind K, uint32_t Fa, uint32_t Fb, uint32_t R, uint32_t Nz) {
  if (IsFloatKind(K)) { // lt ? .. : eq ? .. : gt ? .. : unordered
    F.i32c(int32_t(FloatNZCV(K, FO_LT)));
    F.i32c(int32_t(FloatNZCV(K, FO_EQ)));
    F.i32c(int32_t(FloatNZCV(K, FO_GT)));
    F.i32c(int32_t(FloatNZCV(K, FO_UN)));
    EmitFloatOutcomeTest(F, K, Fa, Fb, FO_GT);
    F.u8(op::select);
    EmitFloatOutcomeTest(F, K, Fa, Fb, FO_EQ);
    F.u8(op::select);
    EmitFloatOutcomeTest(F, K, Fa, Fb, FO_LT);
    F.u8(op::select);
    return;
  }
  if (CarryInverted(K)) {
    EmitNZCVOfKind(F, FlagKind(K & ~FK_CINV), Fa, Fb, R, Nz);
    F.i32c(1 << 29);
    F.u8(op::i32_xor);
    return;
  }
  if (KeepsCarry(K)) {
    EmitNZCVOfKind(F, BaseKind(K), Fa, Fb, R, Nz);
    F.i32c(int32_t(~(1u << 29)));
    F.u8(op::i32_and);
    F.get(Nz);
    F.i32c(1 << 29);
    F.u8(op::i32_and);
    F.u8(op::i32_or);
    return;
  }
  // Pushes (x >> shift) & 1 as i32 for an i64 on the stack.
  auto BitAt = [&](uint32_t Shift) {
    F.i64c(Shift);
    F.u8(op::i64_shr_u);
    F.u8(op::i32_wrap_i64);
    F.i32c(1);
    F.u8(op::i32_and);
  };
  auto Place = [&](uint32_t Bit) {
    F.i32c(int32_t(Bit));
    F.u8(op::i32_shl);
  };
  if (K == FK_LOGIC32 || K == FK_LOGIC64) {
    F.get(Fa);
    BitAt(K == FK_LOGIC32 ? 31 : 63);
    Place(31);
    F.get(Fa);
    F.u8(op::i64_eqz);
    Place(30);
    F.u8(op::i32_or);
    return;
  }
  // For 32-bit kinds all operands are already zero-extended 32-bit values.
  const bool Sub = K == FK_SUB32 || K == FK_SUB64;
  const uint32_t W = K == FK_SUB32 || K == FK_ADD32 ? 32 : 64, Msb = W - 1;
  F.get(Fa);
  F.get(Fb);
  F.u8(Sub ? op::i64_sub : op::i64_add);
  if (W == 32) {
    F.i64c(0xFFFF'FFFF);
    F.u8(op::i64_and);
  }
  F.set(R);
  // N
  F.get(R);
  BitAt(Msb);
  Place(31);
  // Z
  F.get(R);
  F.u8(op::i64_eqz);
  Place(30);
  F.u8(op::i32_or);
  // C: sub -> a >= b (no borrow); add -> result < a (carry out)
  if (Sub) {
    F.get(Fa);
    F.get(Fb);
    F.u8(op::i64_ge_u);
  } else {
    F.get(R);
    F.get(Fa);
    F.u8(op::i64_lt_u);
  }
  Place(29);
  F.u8(op::i32_or);
  // V: sub -> (a^b)&(a^r); add -> (a^r)&(b^r)
  if (Sub) {
    F.get(Fa);
    F.get(Fb);
    F.u8(op::i64_xor);
    F.get(Fa);
    F.get(R);
    F.u8(op::i64_xor);
  } else {
    F.get(Fa);
    F.get(R);
    F.u8(op::i64_xor);
    F.get(Fb);
    F.get(R);
    F.u8(op::i64_xor);
  }
  F.u8(op::i64_and);
  BitAt(Msb);
  Place(28);
  F.u8(op::i32_or);
}

// Pushes i32 1 if the outcome of comparing the float operands (bits in
// locals Fa, Fb) of float kind K is in Set (FO_... bits).
static void EmitFloatOutcomeTest(Buf& F, FlagKind K, uint32_t Fa, uint32_t Fb, uint32_t Set) {
  const int32_t Bk = K & ~FK_CINV;
  const bool D = Bk == FK_FCMP64 || Bk == FK_FCMPAX64;
  auto Val = [&](uint32_t L) {
    F.get(L);
    if (D) {
      F.u8(0xbf); // f64.reinterpret_i64
    } else {
      F.u8(op::i32_wrap_i64);
      F.u8(0xbe); // f32.reinterpret_i32
    }
  };
  // f32 opcodes; the f64 ones are 6 higher.
  auto Cmp = [&](uint32_t A, uint32_t Bv, uint8_t Op32) {
    Val(A);
    Val(Bv);
    F.u8(uint8_t(Op32 + (D ? 6 : 0)));
  };
  constexpr uint8_t EQ = 0x5b, NE = 0x5c, LT = 0x5d, GT = 0x5e, LE = 0x5f, GE = 0x60;
  bool Negate = false;
  if (Set & FO_UN) { // the compares are false when unordered: test the complement
    if (Set == (FO_LT | FO_GT | FO_UN)) {
      Cmp(Fa, Fb, NE);
      return;
    }
    Set = ~Set & (FO_LT | FO_EQ | FO_GT);
    Negate = true;
  }
  switch (Set) {
  case 0: F.i32c(0); break;
  case FO_LT: Cmp(Fa, Fb, LT); break;
  case FO_EQ: Cmp(Fa, Fb, EQ); break;
  case FO_GT: Cmp(Fa, Fb, GT); break;
  case FO_LT | FO_EQ: Cmp(Fa, Fb, LE); break;
  case FO_GT | FO_EQ: Cmp(Fa, Fb, GE); break;
  case FO_LT | FO_GT:
    Cmp(Fa, Fb, LT);
    Cmp(Fa, Fb, GT);
    F.u8(op::i32_or);
    break;
  default: // ordered
    Cmp(Fa, Fa, EQ);
    Cmp(Fb, Fb, EQ);
    F.u8(op::i32_and);
    break;
  }
  if (Negate) {
    F.u8(op::i32_eqz);
  }
}

Buf Emitter::MatFunction() {
  Buf F;
  // locals: 4 = r64 (i64)
  F.u32(1);
  F.u32(1);
  F.u8(I64);
  const uint32_t Fk = 0, Fa = 1, Fb = 2, Nz = 3, R = 4;
  for (int32_t Kind = FK_SUB32; Kind <= (FK_LAST | FK_CINV); Kind++) {
    if ((Kind & ~FK_CINV) < FK_SUB32 || (Kind & ~FK_CINV) > FK_LAST) {
      continue;
    }
    const FlagKind K = FlagKind(Kind);
    F.get(Fk);
    F.i32c(K);
    F.u8(op::i32_eq);
    F.u8(op::if_);
    F.u8(0x40);
    EmitNZCVOfKind(F, K, Fa, Fb, R, Nz);
    F.u8(op::return_);
    F.u8(op::end);
  }
  F.get(Nz);
  F.u8(op::end);
  return F;
}

bool Emitter::BuildCFG() {
  for (auto [BlockNode, BlockHeader] : IR.GetBlocks()) {
    BlockInfo BI;
    BI.Node = BlockNode;
    for (auto [CodeNode, IROp] : IR.GetCode(BlockNode)) {
      if (IROp->Op == OP_JUMP) {
        BI.Succ = {TargetIndex(IROp->C<IROp_Jump>()->TargetBlock)};
      } else if (IROp->Op == OP_CONDJUMP) {
        auto Op = IROp->C<IROp_CondJump>();
        BI.Succ = {TargetIndex(Op->TrueBlock), TargetIndex(Op->FalseBlock)};
      } else if (IROp->Op == OP_EXITFUNCTION) {
        uint32_t Ret;
        if (CallReturnIndex(IROp->C<IROp_ExitFunction>(), &Ret)) {
          BI.Succ = {Ret};
        }
      }
    }
    Blocks.push_back(BI);
    uint64_t Use = 0, Def = 0;
    for (auto [CodeNode, IROp] : IR.GetCode(BlockNode)) {
      uint64_t Read = 0, Write = 0;
      switch (IROp->Op) {
      case OP_LOADREGISTER: {
        auto L = IROp->C<IROp_LoadRegister>();
        if (L->Class == RegClass::GPR && L->Reg < NUM_STATIC) {
          Read = RegBit(L->Reg);
        } else if (L->Class == RegClass::FPR && L->Reg < NUM_XMM) {
          Read = XBit(L->Reg);
        }
        break;
      }
      case OP_STOREREGISTER: {
        auto Phys = PhysicalRegister(CodeNode);
        if (Phys.AsRegClass() == RegClass::GPRFixed && Phys.Reg < NUM_STATIC) {
          Write = RegBit(Phys.Reg);
        } else if (Phys.AsRegClass() == RegClass::FPRFixed && Phys.Reg < NUM_XMM) {
          Write = XBit(Phys.Reg);
        }
        break;
      }
      case OP_LOADPF: Read = RegBit(PF_REG); break;
      case OP_LOADAF: Read = RegBit(AF_REG); break;
      case OP_STOREPF: Write = RegBit(PF_REG); break;
      case OP_STOREAF: Write = RegBit(AF_REG); break;
      case OP_LOADCONTEXT: ContextTouchesRegs |= RegState(IROp->C<IROp_LoadContext>()->Offset, 16); break;
      case OP_STORECONTEXT: ContextTouchesRegs |= RegState(IROp->C<IROp_StoreContext>()->Offset, 16); break;
      case OP_LOADCONTEXTPAIR: ContextTouchesRegs |= RegState(IROp->C<IROp_LoadContextPair>()->Offset, 32); break;
      case OP_STORECONTEXTPAIR: ContextTouchesRegs |= RegState(IROp->C<IROp_StoreContextPair>()->Offset, 32); break;
      case OP_LOADCONTEXTINDEXED:
      case OP_STORECONTEXTINDEXED: ContextTouchesRegs = true; break;
      case OP_CONTEXTCLEAR: ContextTouchesRegs |= RegState(IROp->C<IROp_ContextClear>()->Offset, IROp->C<IROp_ContextClear>()->Size); break;
      default: break;
      }
      if (TouchesFlags(IROp)) {
        Read |= 1ull << FLAGS_BIT; // (reads and writes alike: kept live)
      }
      Use |= Read & ~Def;
      Def |= Write;
    }
    BlockUse.push_back(Use);
    BlockDef.push_back(Def);
    uint64_t W = 0;
    for (auto [CodeNode, IROp] : IR.GetCode(BlockNode)) {
      switch (IROp->Op) {
      case OP_STOREREGISTER: {
        auto Phys = PhysicalRegister(CodeNode);
        if (Phys.AsRegClass() == RegClass::GPRFixed && Phys.Reg < NUM_STATIC) {
          W |= 1ull << Phys.Reg;
        } else if (Phys.AsRegClass() == RegClass::FPRFixed && Phys.Reg < NUM_XMM) {
          W |= 1ull << (XMM_BIT + Phys.Reg);
        }
        break;
      }
      case OP_STOREPF: W |= 1ull << PF_REG; break;
      case OP_STOREAF: W |= 1ull << AF_REG; break;
      default: break;
      }
    }
    for (auto [CodeNode, IROp] : IR.GetCode(BlockNode)) {
      if (TouchesFlags(IROp)) {
        W |= 1ull << FLAGS_BIT;
      }
    }
    BlockWrites.push_back(W);
  }
  if (AnalyzeCFG()) {
    return true;
  }
  if (ENV_FLAG("FEXWASM_NOFIXIRR")) {
    return false;
  }
  // Irreducible: give each multi-entry loop a dispatch block as its one
  // header, then try again; failing that, the unit keeps the br_table form.
  const std::vector<BlockInfo> OrigBlocks = Blocks;
  const std::vector<uint64_t> OrigWrites = BlockWrites, OrigUse = BlockUse, OrigDef = BlockDef;
  std::vector<uint32_t> All;
  for (uint32_t V = 0; V < Blocks.size(); V++) {
    All.push_back(V);
  }
  if (FixIrreducible(All, UINT32_MAX, 0) && AnalyzeCFG()) {
    if (ENV_FLAG("FEXWASM_IRREDUCIBLE_LOG")) {
      fprintf(stderr, "[irreducible] entry %#llx fixed with %zu dispatch blocks\n", (unsigned long long)Entry, Blocks.size() - OrigBlocks.size());
    }
    return true;
  }
  Blocks = OrigBlocks;
  BlockWrites = OrigWrites;
  BlockUse = OrigUse;
  BlockDef = OrigDef;
  Redirect.clear();
  return false;
}

// Makes the loops of Nodes (minus Header, whose incoming edges are back
// edges) single-entry: an SCC entered at several blocks gets a synthetic
// dispatch block that all edges into those blocks go through, setting its
// label. Recurses into each loop's body. False if it can't (the unit's entry
// block is a second loop entry).
bool Emitter::FixIrreducible(const std::vector<uint32_t>& Nodes, uint32_t Header, int Level) {
  if (Level > 16) {
    return false;
  }
  std::vector<uint8_t> In(Blocks.size(), 0);
  for (uint32_t V : Nodes) {
    if (V != Header) {
      In[V] = 1;
    }
  }
  // Tarjan's SCCs of the subgraph.
  const uint32_t N = uint32_t(Blocks.size());
  std::vector<int> Index(N, -1), Low(N, 0);
  std::vector<uint8_t> OnStack(N, 0);
  std::vector<uint32_t> Stack;
  std::vector<std::vector<uint32_t>> SCCs;
  int Next = 0;
  std::function<void(uint32_t)> Strong = [&](uint32_t V) {
    Index[V] = Low[V] = Next++;
    Stack.push_back(V);
    OnStack[V] = 1;
    for (uint32_t W : Blocks[V].Succ) {
      if (!In[W]) {
        continue;
      }
      if (Index[W] < 0) {
        Strong(W);
        Low[V] = std::min(Low[V], Low[W]);
      } else if (OnStack[W]) {
        Low[V] = std::min(Low[V], Index[W]);
      }
    }
    if (Low[V] == Index[V]) {
      std::vector<uint32_t> C;
      uint32_t W;
      do {
        W = Stack.back();
        Stack.pop_back();
        OnStack[W] = 0;
        C.push_back(W);
      } while (W != V);
      SCCs.push_back(std::move(C));
    }
  };
  for (uint32_t V : Nodes) {
    if (In[V] && Index[V] < 0) {
      Strong(V);
    }
  }
  for (auto& C : SCCs) {
    std::vector<uint8_t> InC(N, 0);
    for (uint32_t V : C) {
      InC[V] = 1;
    }
    bool Cyclic = C.size() > 1;
    for (uint32_t W : Blocks[C[0]].Succ) {
      Cyclic |= W == C[0];
    }
    if (!Cyclic) {
      continue;
    }
    // Entries: blocks of C with a predecessor outside C.
    std::vector<uint32_t> Entries;
    std::vector<std::vector<uint32_t>> Preds(Blocks.size());
    for (uint32_t P = 0; P < Blocks.size(); P++) {
      for (uint32_t W : Blocks[P].Succ) {
        if (W < Preds.size()) {
          Preds[W].push_back(P);
        }
      }
    }
    for (uint32_t V : C) {
      bool Outside = V == 0;
      for (uint32_t P : Preds[V]) {
        Outside |= !InC[P];
      }
      if (Outside) {
        Entries.push_back(V);
      }
    }
    std::sort(Entries.begin(), Entries.end());
    if (Entries.size() == 1) {
      if (!FixIrreducible(C, Entries[0], Level + 1)) {
        return false;
      }
      continue;
    }
    if (std::find(Entries.begin(), Entries.end(), 0u) != Entries.end() || Entries.empty()) {
      return false;
    }
    const uint32_t D = uint32_t(Blocks.size());
    BlockInfo DI;
    DI.Synthetic = true;
    DI.Succ = Entries;
    DI.Label = UINT32_MAX; // allocated when emitted (locals come after run's params)
    Blocks.push_back(DI);
    BlockWrites.push_back(0);
    BlockUse.push_back(0);
    BlockDef.push_back(0);
    for (uint32_t I = 0; I < Entries.size(); I++) {
      const uint32_t E = Entries[I];
      for (uint32_t P : Preds[E]) {
        if (P == D) {
          continue;
        }
        for (uint32_t& W : Blocks[P].Succ) {
          if (W == E) {
            W = D;
          }
        }
        Redirect[{P, E}] = {D, I};
      }
    }
    std::vector<uint32_t> Loop = C;
    Loop.push_back(D);
    if (!FixIrreducible(Loop, D, Level + 1)) {
      return false;
    }
  }
  return true;
}

// Reverse postorder, dominators, loop headers and merge nodes of Blocks, for
// the structured form; false if the CFG is irreducible.
bool Emitter::AnalyzeCFG() {
  const uint32_t N = uint32_t(Blocks.size());
  // Reverse postorder from the entry (block 0).
  std::vector<uint8_t> Seen(N, 0);
  std::vector<uint32_t> Post;
  std::vector<std::pair<uint32_t, size_t>> Stack {{0, 0}};
  Seen[0] = 1;
  while (!Stack.empty()) {
    auto& [V, I] = Stack.back();
    if (I < Blocks[V].Succ.size()) {
      const uint32_t W = Blocks[V].Succ[I++];
      if (!Seen[W]) {
        Seen[W] = 1;
        Stack.push_back({W, 0});
      }
    } else {
      Post.push_back(V);
      Stack.pop_back();
    }
  }
  Rpo.assign(Post.rbegin(), Post.rend());
  RpoNum.assign(N, UINT32_MAX);
  for (uint32_t i = 0; i < Rpo.size(); i++) {
    RpoNum[Rpo[i]] = i;
  }
  std::vector<std::vector<uint32_t>> Preds(N);
  for (uint32_t V = 0; V < N; V++) {
    if (RpoNum[V] == UINT32_MAX) {
      continue;
    }
    for (uint32_t W : Blocks[V].Succ) {
      Preds[W].push_back(V);
    }
  }
  // Dominators (Cooper, Harvey, Kennedy).
  IDom.assign(N, UINT32_MAX);
  IDom[0] = 0;
  auto Intersect = [&](uint32_t A, uint32_t Bb) {
    while (A != Bb) {
      while (RpoNum[A] > RpoNum[Bb]) {
        A = IDom[A];
      }
      while (RpoNum[Bb] > RpoNum[A]) {
        Bb = IDom[Bb];
      }
    }
    return A;
  };
  for (bool Changed = true; Changed;) {
    Changed = false;
    for (uint32_t V : Rpo) {
      if (V == 0) {
        continue;
      }
      uint32_t New = UINT32_MAX;
      for (uint32_t P : Preds[V]) {
        if (IDom[P] != UINT32_MAX) {
          New = New == UINT32_MAX ? P : Intersect(P, New);
        }
      }
      if (New != IDom[V]) {
        IDom[V] = New;
        Changed = true;
      }
    }
  }
  auto Dominates = [&](uint32_t A, uint32_t V) {
    for (;;) {
      if (V == A) {
        return true;
      }
      if (V == 0) {
        return false;
      }
      V = IDom[V];
    }
  };
  LoopHeader.assign(N, 0);
  Merge.assign(N, 0);
  DomChildren.assign(N, {});
  for (uint32_t V : Rpo) {
    uint32_t Forward = 0;
    for (uint32_t P : Preds[V]) {
      if (RpoNum[P] >= RpoNum[V]) { // back edge: must be a natural loop
        if (!Dominates(V, P)) {
          return false; // irreducible
        }
        LoopHeader[V] = 1;
      } else {
        Forward++;
      }
    }
    Merge[V] = Forward >= 2;
    if (V != 0) {
      DomChildren[IDom[V]].push_back(V);
    }
  }
  PredList = std::move(Preds);
  ComputeMaybeWritten();
  return true;
}

void Emitter::ComputeMaybeWritten() {
  MaybeWrittenIn.assign(Blocks.size(), 0);
  for (bool Changed = true; Changed;) {
    Changed = false;
    for (uint32_t V : Rpo) {
      uint64_t In = 0;
      for (uint32_t P : PredList[V]) {
        In |= MaybeWrittenIn[P] | BlockWrites[P];
      }
      if (In != MaybeWrittenIn[V]) {
        MaybeWrittenIn[V] = In;
        Changed = true;
      }
    }
  }
}

// The unit's code: structured (dominator tree) or, for an irreducible CFG, a
// loop { block* br_table } dispatching on Blk. Both are self-contained, so
// they nest inside regions and inlined call sites.
void Emitter::EmitBody() {
  if (Cfg.ProfAddr && InlineLevel == 0) {
    SysBase();
    RipConst(S.FunctionEntry, false);
    B.mem(op::i32_store, 2, Cfg.ProfAddr);
  }
  if (Structured) {
    DoTree(0);
    return;
  }
  Blk = NewLocal(I32);
  B.i32c(0);
  B.set(Blk);
  B.u8(op::loop);
  B.u8(0x40);
  Context.push_back({CtxKind::LoopHeadedBy, DISPATCH_LABEL, Owner});
  for (uint32_t i = 0; i < NumBlocks; i++) {
    B.u8(op::block);
    B.u8(0x40);
    Context.push_back({CtxKind::If, 0, Owner});
  }
  B.get(Blk);
  B.u8(op::br_table);
  B.u32(NumBlocks - 1);
  for (uint32_t i = 0; i + 1 < NumBlocks; i++) {
    B.u32(i);
  }
  B.u32(NumBlocks - 1);
  for (uint32_t i = 0; i < NumBlocks; i++) {
    B.u8(op::end); // closes this block's label; its code follows
    Context.pop_back();
    EmitBlockOps(i);
    if (!Err.empty()) {
      return;
    }
  }
  Context.pop_back();
  B.u8(op::end); // loop
}

void Emitter::EmitBlockOps(uint32_t X) {
  CurBlock = X;
  OpsInBlock = 0;
  FlagsKnown = false;
  RegStored.clear();
  XRegStored.clear();
  if (!Blocks[X].Synthetic && !ENV_FLAG("FEXWASM_NOREGALIAS")) {
    FindRegAliases(Blocks[X].Node);
  }
  if (Blocks[X].Synthetic) { // dispatch into an irreducible loop at Succ[Label]
    const auto& Succ = Blocks[X].Succ;
    for (uint32_t I = 0; I + 1 < Succ.size(); I++) {
      B.get(LabelOf(X));
      B.i32c(int32_t(I));
      B.u8(op::i32_eq);
      B.u8(op::if_);
      B.u8(0x40);
      Context.push_back({CtxKind::If, 0, Owner});
      DoBranch(X, Succ[I]);
      Context.pop_back();
      B.u8(op::end);
    }
    DoBranch(X, Succ.back());
    return;
  }
  if (X < PredList.size() && PredList[X].size() == 1) {
    const uint32_t P = PredList[X][0];
    if (P != X && P < ExitFlagKind.size() && ExitFlagKind[P] >= 0) {
      FlagsKnown = true;
      KnownKind = FlagKind(ExitFlagKind[P]);
    }
  }
  std::vector<std::pair<Ref, const IROp_Header*>> Ops;
  for (auto [CodeNode, IROp] : IR.GetCode(Blocks[X].Node)) {
    if (!SkipNodes.empty() && SkipNodes.count(ID(CodeNode))) {
      continue;
    }
    Ops.push_back({CodeNode, IROp});
  }
  static const bool NoStackify = getenv("FEXWASM_NOSTACKIFY");
  auto IsOperand = [](const IROp_Header* Op) { return Op->Op == OP_INLINECONSTANT || Op->Op == OP_INLINEENTRYPOINTOFFSET; };
  CurOps = &Ops;
  for (size_t I = 0; I < Ops.size(); I++) {
    auto [CodeNode, IROp] = Ops[I];
    CurOpIdx = I;
    if ((!SkipNodes.empty() && SkipNodes.count(ID(CodeNode))) || IsOperand(IROp)) {
      continue; // skipped by an earlier op's peephole, or an operand
    }
    if ((StackTop || StackLocal != UINT32_MAX) &&
        (IROp->Op == OP_JUMP || IROp->Op == OP_CONDJUMP || IROp->Op == OP_EXITFUNCTION)) {
      // Nothing took the stacked value before the terminator (which may emit
      // other blocks inline): store it now, as if never stacked.
      if (StackTop) {
        B.set(StackTopLocal);
        StackTop = 0;
      } else {
        B.b[TeeAt] = op::local_set;
        StackLocal = UINT32_MAX;
      }
    }
    // Was the previous op's result left on the stack for this one?
    const bool Trial = StackTop != 0, TeeTrial = StackLocal != UINT32_MAX;
    const size_t Start = B.size(), Sites = CallSites.size(), TypeSites = S.RunTypeSites.size();
    const bool SavedKnown = FlagsKnown;
    const FlagKind SavedKind = KnownKind;
    TakenAt = SIZE_MAX;
    TakenNode = 0;
    ReadAgain = false;
    LastSetNode = 0;
    RegSetLocal = UINT32_MAX;
    EmitOp(CodeNode, IROp);
    if (!Err.empty()) {
      return;
    }
    if ((Trial || TeeTrial) && B.size() == Start && (StackTop != 0 || StackLocal != UINT32_MAX)) {
      continue; // emitted nothing (a load that reads its register's local): still pending
    }
    if (TeeTrial && (StackLocal != UINT32_MAX || TakenAt != Start)) {
      // It didn't take the register value first: plain local.set, emit again.
      B.b.resize(Start);
      CallSites.resize(Sites);
      S.RunTypeSites.resize(TypeSites);
      FlagsKnown = SavedKnown;
      KnownKind = SavedKind;
      StackLocal = UINT32_MAX;
      B.b[TeeAt] = op::local_set;
      LastSetNode = 0;
      RegSetLocal = UINT32_MAX;
      EmitOp(CodeNode, IROp);
      if (!Err.empty()) {
        return;
      }
    }
    if (Trial && (StackTop != 0 || TakenAt != Start || ReadAgain)) {
      // It didn't take the value first: store it after all and emit again.
      B.b.resize(Start);
      CallSites.resize(Sites);
      S.RunTypeSites.resize(TypeSites);
      FlagsKnown = SavedKnown;
      KnownKind = SavedKind;
      StackTop = 0;
      TakenNode = 0;
      B.set(StackTopLocal);
      LastSetNode = 0;
      EmitOp(CodeNode, IROp);
      if (!Err.empty()) {
        return;
      }
    }
    TakenNode = 0;
    // Leave this op's result on the stack if its only use is the next op's
    // (it has to read it first; checked above).
    size_t J = I + 1; // the next op that emits code
    while (J < Ops.size() && (IsOperand(Ops[J].second) || (!SkipNodes.empty() && SkipNodes.count(ID(Ops[J].first))) ||
                              (Ops[J].second->Op == OP_LOADREGISTER && RegAliased.count(ID(Ops[J].first))))) {
      J++;
    }
    if (!Cfg.BrokerMemory && !NoStackify && RegSetLocal != UINT32_MAX && RegSetEnd == B.size() && J < Ops.size()) {
      // A register store: tee it for the next op if that reads the register
      // first (verified when it's emitted).
      switch (Ops[J].second->Op) {
      case OP_JUMP:
      case OP_CONDJUMP:
      case OP_EXITFUNCTION: break;
      default:
        B.b[RegSetAt] = op::local_tee;
        TeeAt = RegSetAt;
        StackLocal = RegSetLocal;
        continue;
      }
    }
    if (Cfg.BrokerMemory || NoStackify || LastSetNode != ID(CodeNode) || LastSetEnd != B.size() || CodeNode->GetUses() != 1 || J >= Ops.size()) {
      continue;
    }
    const IROp_Header* Next = Ops[J].second;
    switch (Next->Op) {
    case OP_JUMP:
    case OP_CONDJUMP:
    case OP_EXITFUNCTION:
    case OP_BFI: // a later Bfe/Sbfe peephole reads the Bfi's source
      continue;
    default: break;
    }
    bool Uses = false;
    for (uint8_t A = 0, NA = GetArgs(Next->Op); A < NA; A++) {
      Uses |= !Next->Args[A].IsInvalid() && ID(Next->Args[A]) == ID(CodeNode);
    }
    if (Uses) {
      B.b.resize(LastSetStart); // take the local.set back
      StackTop = ID(CodeNode);
      StackTopLocal = LastSetLocal;
    }
  }
  CurOps = nullptr;
}

void Emitter::DoTree(uint32_t X) {
  std::vector<uint32_t> Ys;
  for (uint32_t C : DomChildren[X]) {
    if (Merge[C]) {
      Ys.push_back(C);
    }
  }
  // Highest reverse-postorder number first: it ends up outermost.
  std::sort(Ys.begin(), Ys.end(), [&](uint32_t A, uint32_t Bb) { return RpoNum[A] > RpoNum[Bb]; });
  if (LoopHeader[X]) {
    B.u8(op::loop);
    B.u8(0x40);
    Context.push_back({CtxKind::LoopHeadedBy, X, Owner});
    NodeWithin(X, Ys, 0);
    Context.pop_back();
    B.u8(op::end);
  } else {
    NodeWithin(X, Ys, 0);
  }
}

void Emitter::NodeWithin(uint32_t X, const std::vector<uint32_t>& Ys, size_t From) {
  if (From == Ys.size()) {
    EmitBlockOps(X); // its terminator branches via DoBranch
    return;
  }
  const uint32_t Y = Ys[From];
  B.u8(op::block);
  B.u8(0x40);
  Context.push_back({CtxKind::BlockFollowedBy, Y, Owner});
  NodeWithin(X, Ys, From + 1);
  Context.pop_back();
  B.u8(op::end);
  DoTree(Y);
}

void Emitter::RDoTree(uint32_t X) {
  const RegionGraph& G = *S.RG;
  std::vector<uint32_t> Ys;
  for (uint32_t C : G.DomChildren[X]) {
    if (G.Merge[C]) {
      Ys.push_back(C);
    }
  }
  std::sort(Ys.begin(), Ys.end(), [&](uint32_t A, uint32_t Bb) { return G.RpoNum[A] > G.RpoNum[Bb]; });
  if (G.LoopHeader[X]) {
    B.u8(op::loop);
    B.u8(0x40);
    Context.push_back({CtxKind::RegionLoopHead, X, RegionOwner});
    RNodeWithin(X, Ys, 0);
    Context.pop_back();
    B.u8(op::end);
  } else {
    RNodeWithin(X, Ys, 0);
  }
}

void Emitter::RNodeWithin(uint32_t X, const std::vector<uint32_t>& Ys, size_t From) {
  if (From == Ys.size()) {
    S.RUnits[X]->EmitBody(); // its exits branch via RDoBranch
    return;
  }
  const uint32_t Y = Ys[From];
  B.u8(op::block);
  B.u8(0x40);
  Context.push_back({CtxKind::RegionBlock, Y, RegionOwner});
  RNodeWithin(X, Ys, From + 1);
  Context.pop_back();
  B.u8(op::end);
  RDoTree(Y);
}

void Emitter::RDoBranch(uint32_t From, uint32_t To) {
  const RegionGraph& G = *S.RG;
  if (G.RpoNum[To] <= G.RpoNum[From] || G.Merge[To]) {
    B.u8(op::br);
    B.u32(RLabel(From, To));
  } else { // only reached from here: emit it inline
    RDoTree(To);
  }
}

void Emitter::DoBranch(uint32_t From, uint32_t To) {
  if (!Redirect.empty()) {
    if (auto It = Redirect.find({From, To}); It != Redirect.end()) { // into an irreducible loop
      B.i32c(int32_t(It->second.second));
      B.set(LabelOf(It->second.first));
      To = It->second.first;
    }
  }
  if (RpoNum[To] <= RpoNum[From]) { // back edge to an enclosing loop
    B.u8(op::br);
    B.u32(Depth(CtxKind::LoopHeadedBy, To));
  } else if (Merge[To]) { // exit the block that the merge node follows
    B.u8(op::br);
    B.u32(Depth(CtxKind::BlockFollowedBy, To));
  } else { // only reached from here: emit it inline
    DoTree(To);
  }
}

// $umulh(a, b) -> high 64 bits of the unsigned 128-bit product, from 32-bit
// partial products (wasm has no 64x64->128 multiply).
static Buf UMulHFunction() {
  Buf F;
  F.u32(1);
  F.u32(3);
  F.u8(I64); // 2: p1 (a_lo*b_hi), 3: p2 (a_hi*b_lo), 4: mid
  const uint32_t A = 0, Bp = 1, P1 = 2, P2 = 3, Mid = 4;
  auto Lo = [&](uint32_t L) { F.get(L); F.i64c(0xFFFF'FFFF); F.u8(op::i64_and); };
  auto Hi = [&](uint32_t L) { F.get(L); F.i64c(32); F.u8(op::i64_shr_u); };
  Lo(A); Hi(Bp); F.u8(op::i64_mul); F.set(P1);
  Hi(A); Lo(Bp); F.u8(op::i64_mul); F.set(P2);
  // mid = (a_lo*b_lo >> 32) + lo(p1) + lo(p2)
  Lo(A); Lo(Bp); F.u8(op::i64_mul); F.i64c(32); F.u8(op::i64_shr_u);
  Lo(P1); F.u8(op::i64_add);
  Lo(P2); F.u8(op::i64_add);
  F.set(Mid);
  // hi = a_hi*b_hi + (p1 >> 32) + (p2 >> 32) + (mid >> 32)
  Hi(A); Hi(Bp); F.u8(op::i64_mul);
  Hi(P1); F.u8(op::i64_add);
  Hi(P2); F.u8(op::i64_add);
  Hi(Mid); F.u8(op::i64_add);
  F.u8(op::end);
  return F;
}

// $smulh(a, b) = umulh(a, b) - (a < 0 ? b : 0) - (b < 0 ? a : 0)
static Buf SMulHFunction(CallSiteList& Sites) {
  Buf F;
  F.u32(0);
  F.get(0);
  F.get(1);
  EmitCall(F, Sites, FUNC_UMULH);
  F.get(1);
  F.i64c(0);
  F.get(0);
  F.i64c(0);
  F.u8(op::i64_lt_s);
  F.u8(op::select);
  F.u8(op::i64_sub);
  F.get(0);
  F.i64c(0);
  F.get(1);
  F.i64c(0);
  F.u8(op::i64_lt_s);
  F.u8(op::select);
  F.u8(op::i64_sub);
  F.u8(op::end);
  return F;
}

// $div128u(lo, hi, d) -> (q, r): 128/64 restoring division. A quotient that
// does not fit 64 bits (hi >= d, including d == 0) is x86 #DE: trap.
static Buf Div128UFunction() {
  Buf F;
  const uint32_t Lo = 0, Hi = 1, D = 2, I = 3, C = 4;
  F.u32(2);
  F.u32(1);
  F.u8(I32);
  F.u32(1);
  F.u8(I64);
  F.get(Hi);
  F.u8(op::i64_eqz);
  F.u8(op::if_);
  F.u8(0x40);
  F.get(Lo);
  F.get(D);
  F.u8(op::i64_div_u);
  F.get(Lo);
  F.get(D);
  F.u8(op::i64_rem_u);
  F.u8(op::return_);
  F.u8(op::end);
  F.get(Hi);
  F.get(D);
  F.u8(op::i64_ge_u);
  F.u8(op::if_);
  F.u8(0x40);
  F.u8(op::unreachable);
  F.u8(op::end);
  F.i32c(64);
  F.set(I);
  F.u8(op::loop);
  F.u8(0x40);
  {
    F.get(Hi);
    F.i64c(63);
    F.u8(op::i64_shr_u);
    F.set(C);
    F.get(Hi);
    F.i64c(1);
    F.u8(op::i64_shl);
    F.get(Lo);
    F.i64c(63);
    F.u8(op::i64_shr_u);
    F.u8(op::i64_or);
    F.set(Hi);
    F.get(Lo);
    F.i64c(1);
    F.u8(op::i64_shl);
    F.set(Lo);
    F.get(C);
    F.u8(op::i64_eqz);
    F.u8(op::i32_eqz);
    F.get(Hi);
    F.get(D);
    F.u8(op::i64_ge_u);
    F.u8(op::i32_or);
    F.u8(op::if_);
    F.u8(0x40);
    F.get(Hi);
    F.get(D);
    F.u8(op::i64_sub);
    F.set(Hi);
    F.get(Lo);
    F.i64c(1);
    F.u8(op::i64_or);
    F.set(Lo);
    F.u8(op::end);
    F.get(I);
    F.i32c(1);
    F.u8(op::i32_sub);
    F.tee(I);
    F.u8(op::br_if);
    F.u32(0);
  }
  F.u8(op::end);
  F.get(Lo);
  F.get(Hi);
  F.u8(op::end);
  return F;
}

// $div128s(lo, hi, d) -> (q, r): signed 128/64 division via the unsigned one
// on magnitudes (quotient overflow is not detected).
static Buf Div128SFunction(CallSiteList& Sites) {
  Buf F;
  const uint32_t Lo = 0, Hi = 1, D = 2, NegN = 3, NegD = 4, Q = 5, R = 6;
  F.u32(2);
  F.u32(2);
  F.u8(I32);
  F.u32(2);
  F.u8(I64);
  // hi is the sign extension of lo: plain 64-bit division.
  F.get(Hi);
  F.get(Lo);
  F.i64c(63);
  F.u8(op::i64_shr_s);
  F.u8(op::i64_eq);
  F.u8(op::if_);
  F.u8(0x40);
  F.get(Lo);
  F.get(D);
  F.u8(op::i64_div_s);
  F.get(Lo);
  F.get(D);
  F.u8(op::i64_rem_s);
  F.u8(op::return_);
  F.u8(op::end);
  F.get(Hi);
  F.i64c(0);
  F.u8(op::i64_lt_s);
  F.tee(NegN);
  F.u8(op::if_);
  F.u8(0x40);
  // (hi:lo) = -(hi:lo)
  F.get(Hi);
  F.i64c(-1);
  F.u8(op::i64_xor);
  F.get(Lo);
  F.u8(op::i64_eqz);
  F.u8(op::i64_extend_i32_u);
  F.u8(op::i64_add);
  F.set(Hi);
  F.i64c(0);
  F.get(Lo);
  F.u8(op::i64_sub);
  F.set(Lo);
  F.u8(op::end);
  F.get(D);
  F.i64c(0);
  F.u8(op::i64_lt_s);
  F.tee(NegD);
  F.u8(op::if_);
  F.u8(0x40);
  F.i64c(0);
  F.get(D);
  F.u8(op::i64_sub);
  F.set(D);
  F.u8(op::end);
  F.get(Lo);
  F.get(Hi);
  F.get(D);
  EmitCall(F, Sites, FUNC_DIV128U);
  F.set(R);
  F.set(Q);
  F.i64c(0);
  F.get(Q);
  F.u8(op::i64_sub);
  F.get(Q);
  F.get(NegN);
  F.get(NegD);
  F.u8(op::i32_xor);
  F.u8(op::select);
  F.i64c(0);
  F.get(R);
  F.u8(op::i64_sub);
  F.get(R);
  F.get(NegN);
  F.u8(op::select);
  F.u8(op::end);
  return F;
}

// $pdep(input, mask): deposit the low bits of input at the set bits of mask.
static Buf PDepFunction() {
  Buf F;
  const uint32_t In = 0, Mask = 1, R = 2, K = 3;
  F.u32(1);
  F.u32(2);
  F.u8(I64);
  F.i64c(1);
  F.set(K);
  F.u8(op::block);
  F.u8(0x40);
  F.u8(op::loop);
  F.u8(0x40);
  F.get(Mask);
  F.u8(op::i64_eqz);
  F.u8(op::br_if);
  F.u32(1);
  F.get(In);
  F.get(K);
  F.u8(op::i64_and);
  F.u8(op::i64_eqz);
  F.u8(op::i32_eqz);
  F.u8(op::if_);
  F.u8(0x40);
  F.get(R);
  F.get(Mask);
  F.i64c(0);
  F.get(Mask);
  F.u8(op::i64_sub);
  F.u8(op::i64_and); // lowest set bit
  F.u8(op::i64_or);
  F.set(R);
  F.u8(op::end);
  F.get(K);
  F.i64c(1);
  F.u8(op::i64_shl);
  F.set(K);
  F.get(Mask);
  F.get(Mask);
  F.i64c(1);
  F.u8(op::i64_sub);
  F.u8(op::i64_and);
  F.set(Mask);
  F.u8(op::br);
  F.u32(0);
  F.u8(op::end);
  F.u8(op::end);
  F.get(R);
  F.u8(op::end);
  return F;
}

// $pext(input, mask): gather the bits of input at the set bits of mask.
static Buf PExtFunction() {
  Buf F;
  const uint32_t In = 0, Mask = 1, R = 2, K = 3;
  F.u32(1);
  F.u32(2);
  F.u8(I64);
  F.i64c(1);
  F.set(K);
  F.u8(op::block);
  F.u8(0x40);
  F.u8(op::loop);
  F.u8(0x40);
  F.get(Mask);
  F.u8(op::i64_eqz);
  F.u8(op::br_if);
  F.u32(1);
  F.get(In);
  F.get(Mask);
  F.i64c(0);
  F.get(Mask);
  F.u8(op::i64_sub);
  F.u8(op::i64_and);
  F.u8(op::i64_and);
  F.u8(op::i64_eqz);
  F.u8(op::i32_eqz);
  F.u8(op::if_);
  F.u8(0x40);
  F.get(R);
  F.get(K);
  F.u8(op::i64_or);
  F.set(R);
  F.u8(op::end);
  F.get(K);
  F.i64c(1);
  F.u8(op::i64_shl);
  F.set(K);
  F.get(Mask);
  F.get(Mask);
  F.i64c(1);
  F.u8(op::i64_sub);
  F.u8(op::i64_and);
  F.set(Mask);
  F.u8(op::br);
  F.u32(0);
  F.u8(op::end);
  F.u8(op::end);
  F.get(R);
  F.u8(op::end);
  return F;
}

// $cpuid(function, leaf): linear search of the host-built CPUID table.
static Buf CPUIDFunction(const BackendConfig& Cfg) {
  Buf F;
  const uint32_t Fn = 0, Leaf = 1, P = 2, End = 3;
  F.u32(1);
  F.u32(2);
  F.u8(I32);
  F.i32c(int32_t(Cfg.CPUIDAddr));
  F.set(P);
  F.i32c(int32_t(Cfg.CPUIDAddr + 24 * Cfg.CPUIDCount));
  F.set(End);
  F.u8(op::block);
  F.u8(0x40);
  F.u8(op::loop);
  F.u8(0x40);
  F.get(P);
  F.get(End);
  F.u8(op::i32_ge_u);
  F.u8(op::br_if);
  F.u32(1);
  F.get(P);
  F.mem(op::i32_load, 2, 0);
  F.get(Fn);
  F.u8(op::i32_eq);
  F.get(P);
  F.mem(op::i32_load, 2, 4);
  F.get(Leaf);
  F.u8(op::i32_eq);
  F.get(P);
  F.mem(op::i32_load, 2, 4);
  F.i32c(-1);
  F.u8(op::i32_eq);
  F.u8(op::i32_or);
  F.u8(op::i32_and);
  F.u8(op::if_);
  F.u8(0x40);
  for (uint32_t R = 0; R < 4; R++) {
    F.get(P);
    F.mem(op::i32_load, 2, 8 + 4 * R);
  }
  F.u8(op::return_);
  F.u8(op::end);
  F.get(P);
  F.i32c(24);
  F.u8(op::i32_add);
  F.set(P);
  F.u8(op::br);
  F.u32(0);
  F.u8(op::end);
  F.u8(op::end);
  F.i32c(0);
  F.i32c(0);
  F.i32c(0);
  F.i32c(0);
  F.u8(op::end);
  return F;
}

// Pre-pass: block numbering, static register usage, the CFG, and the callees
// to inline (analysed recursively, so their usage counts too).
bool Emitter::Analyze() {
  for (auto [BlockNode, BlockHeader] : IR.GetBlocks()) {
    BlockIndex.emplace(ID(BlockNode), NumBlocks++);
    for (auto [CodeNode, IROp] : IR.GetCode(BlockNode)) {
      if (IROp->Op == OP_EXITFUNCTION && Cfg.ReturnAddrs) {
        uint64_t Ret;
        bool RetRel = true;
        if (CallRetAddr(IROp->C<IROp_ExitFunction>(), &Ret, &RetRel)) {
          const uint8_t RetAbs = RetRel ? 0 : LEARNED_ABS;
          Cfg.ReturnAddrs->insert(Ret);
          if (Cfg.Learned) {
            Cfg.Learned->push_back({0 | RetAbs, Ret});
          }
          if (Cfg.ExitReturnAddrs && IROp->C<IROp_ExitFunction>()->CallReturnBlock.IsInvalid()) {
            Cfg.ExitReturnAddrs->insert(Ret);
            if (Cfg.Learned) {
              Cfg.Learned->push_back({1 | RetAbs, Ret});
            }
          }
          uint64_t Callee;
          bool CalleeRel = true;
          if (Cfg.CallTargetSet && ConstRIP(IROp->C<IROp_ExitFunction>()->NewRIP, &Callee, &CalleeRel)) {
            Cfg.CallTargetSet->insert(Callee);
            if (Cfg.Learned) {
              Cfg.Learned->push_back({uint8_t(2 | (CalleeRel ? 0 : LEARNED_ABS)), Callee});
            }
          }
        }
      }
      if (IROp->Op == OP_LOADREGISTER) {
        auto Op = IROp->C<IROp_LoadRegister>();
        if (Op->Class == RegClass::GPR && Op->Reg < NUM_STATIC) {
          GUsed[Op->Reg] = true;
        } else if (Op->Class == RegClass::FPR && Op->Reg < NUM_XMM) {
          XUsed[Op->Reg] = true;
        }
      } else if (IROp->Op == OP_STOREREGISTER) {
        auto Phys = PhysicalRegister(CodeNode);
        if (Phys.AsRegClass() == RegClass::GPRFixed && Phys.Reg < NUM_STATIC) {
          GUsed[Phys.Reg] = GWritten[Phys.Reg] = true;
        } else if (Phys.AsRegClass() == RegClass::FPRFixed && Phys.Reg < NUM_XMM) {
          XUsed[Phys.Reg] = XWritten[Phys.Reg] = true;
        }
      }
      FlagsTouched |= TouchesFlags(IROp);
      if (IROp->Op == OP_LOADPF) {
        GUsed[PF_REG] = true;
      } else if (IROp->Op == OP_LOADAF) {
        GUsed[AF_REG] = true;
      } else if (IROp->Op == OP_STOREPF) {
        GUsed[PF_REG] = GWritten[PF_REG] = true;
      } else if (IROp->Op == OP_STOREAF) {
        GUsed[AF_REG] = GWritten[AF_REG] = true;
      }
    }
  }
  const bool Reducible = BuildCFG(); // also fills Blocks, which both forms use
  Structured = Reducible && !ENV_FLAG("FEXWASM_BRTABLE");
  if (!Reducible && ENV_FLAG("FEXWASM_IRREDUCIBLE_LOG")) {
    fprintf(stderr, "[irreducible] entry %#llx level %u blocks %zu\n", (unsigned long long)Entry, InlineLevel, Blocks.size());
  }
  bool AnyInlined = false;
  if (InlineLevel > 0 && InlineRetAddr && Cfg.FetchIR && ENV_FLAG("FEXWASM_JUMPINLINE")) {
    for (uint32_t X = 0; X < Blocks.size(); X++) {
      if (Blocks[X].Synthetic) {
        continue;
      }
      for (auto [CodeNode, IROp] : IR.GetCode(Blocks[X].Node)) {
        if (IROp->Op != OP_EXITFUNCTION || !IsLeavingExit(IROp->C<IROp_ExitFunction>())) {
          continue;
        }
        auto Op = IROp->C<IROp_ExitFunction>();
        std::vector<uint64_t> Ts;
        uint64_t T;
        if (ConstRIP(Op->NewRIP, &T)) {
          Ts.push_back(T);
        } else if (Cfg.Successors) {
          for (uint64_t Sx : Cfg.Successors(Entry)) {
            if (!Cfg.ReturnAddrs || !Cfg.ReturnAddrs->count(Sx)) {
              Ts.push_back(Sx);
            }
          }
        }
        std::vector<std::pair<uint64_t, Emitter*>> List;
        for (uint64_t Tx : Ts) {
          if (Tx == Entry || std::find(S.InlineStack.begin(), S.InlineStack.end(), Tx) != S.InlineStack.end()) {
            continue;
          }
          const IRListView* CIR = Cfg.FetchIR(Tx);
          if (!CIR || CIR->GetSSACount() > Cfg.InlineMaxNodes || LeavesOtherThanReturn(*CIR)) {
            continue;
          }
          auto Child = std::make_unique<Emitter>(*CIR, Tx, Cfg, S);
          Child->InlineLevel = InlineLevel + 1;
          Child->InlineRetAddr = InlineRetAddr; // it returns where this callee returns
          S.InlineStack.push_back(Entry);
          const bool Ok = Child->Analyze();
          S.InlineStack.pop_back();
          if (!Ok) {
            continue;
          }
          for (uint32_t Y = 0; Y < Child->Blocks.size(); Y++) {
            BlockWrites[X] |= Child->BlockWrites[Y];
          }
          List.push_back({Tx, Child.get()});
          S.Inlined.push_back(std::move(Child));
        }
        if (!List.empty()) {
          JumpInlineAt[ID(CodeNode)] = std::move(List);
          AnyInlined = true;
        }
      }
    }
  }
  if (!Cfg.FetchIR || InlineLevel >= Cfg.InlineDepth) {
    if (AnyInlined && Structured) {
      ComputeMaybeWritten();
    }
    ComputeDemand();
    return true;
  }
  for (uint32_t X = 0; X < Blocks.size(); X++) {
    if (Blocks[X].Synthetic) {
      continue;
    }
    for (auto [CodeNode, IROp] : IR.GetCode(Blocks[X].Node)) {
      if (IROp->Op != OP_EXITFUNCTION) {
        continue;
      }
      auto Op = IROp->C<IROp_ExitFunction>();
      uint32_t RetIndex;
      uint64_t RetAddr, Target;
      if (Cfg.CallTargets && CallReturnIndex(Op, &RetIndex, &RetAddr) && !ConstRIP(Op->NewRIP, &Target)) {
        // Indirect call: inline the targets seen at this site so far.
        std::vector<std::pair<uint64_t, Emitter*>> List;
        for (uint64_t T : Cfg.CallTargets(RetAddr)) {
          if (std::find(S.InlineStack.begin(), S.InlineStack.end(), T) != S.InlineStack.end() || T == Entry) {
            continue;
          }
          const IRListView* CIR = Cfg.FetchIR(T);
          if (!CIR || CIR->GetSSACount() > Cfg.InlineMaxNodes) {
            continue;
          }
          auto Child = std::make_unique<Emitter>(*CIR, T, Cfg, S);
          Child->InlineLevel = InlineLevel + 1;
          Child->InlineRetAddr = RetAddr;
          S.InlineStack.push_back(Entry);
          const bool Ok = Child->Analyze();
          S.InlineStack.pop_back();
          if (!Ok) {
            continue;
          }
          for (uint32_t Y = 0; Y < Child->Blocks.size(); Y++) {
            BlockWrites[X] |= Child->BlockWrites[Y];
          }
          List.push_back({T, Child.get()});
          S.Inlined.push_back(std::move(Child));
          AnyInlined = true;
        }
        if (!List.empty()) {
          IndirectInlineAt[ID(CodeNode)] = std::move(List);
        }
        continue;
      }
      if (!CallReturnIndex(Op, &RetIndex, &RetAddr) || !ConstRIP(Op->NewRIP, &Target) ||
          std::find(S.InlineStack.begin(), S.InlineStack.end(), Target) != S.InlineStack.end() || Target == Entry) {
        continue;
      }
      const IRListView* CIR = Cfg.FetchIR(Target);
      if (!CIR || CIR->GetSSACount() > Cfg.InlineMaxNodes) {
        continue;
      }
      const bool Leaves = SkipLeavers() && LeavesOtherThanReturn(*CIR);
      if (Leaves && (!Cfg.Successors || !ENV_FLAG("FEXWASM_JUMPINLINE"))) {
        continue;
      }
      auto Child = std::make_unique<Emitter>(*CIR, Target, Cfg, S);
      Child->InlineLevel = InlineLevel + 1;
      Child->InlineRetAddr = RetAddr;
      S.InlineStack.push_back(Entry);
      const bool Ok = Child->Analyze();
      S.InlineStack.pop_back();
      if (!Ok || (Leaves && !Child->LeaversCovered())) { // (a leaver needs its jumps' targets inlined)
        continue;
      }
      uint64_t ChildWrites = 0;
      for (uint32_t Y = 0; Y < Child->Blocks.size(); Y++) {
        ChildWrites |= Child->BlockWrites[Y];
      }
      BlockWrites[X] |= ChildWrites;
      InlineAt[ID(CodeNode)] = Child.get();
      S.Inlined.push_back(std::move(Child));
      AnyInlined = true;
    }
  }
  if (AnyInlined && Structured) {
    ComputeMaybeWritten();
  }
  ComputeDemand();
  return true;
}

// The byte shuffle a permuting vector op performs (as EmitVectorOp lowers
// it): Map[i] = source byte of result byte i, 0-15 from A, 16-31 from Bv,
// 0xFF for a zero byte. False when it isn't a fixed shuffle.
bool Emitter::ShuffleMap(const IROp_Header* IROp, uint8_t (&Map)[16], OrderedNodeWrapper& A, OrderedNodeWrapper& Bv) const {
  const uint32_t OpBytes = uint32_t(IROp->Size), Elem = uint32_t(IROp->ElementSize);
  memset(Map, 0xFF, 16);
  A = IROp->Args[0];
  Bv = IROp->Args[1];
  auto Put = [&](uint32_t Lane, uint32_t FromB, uint32_t SrcLane) {
    for (uint32_t b = 0; b < Elem; b++) {
      Map[Lane * Elem + b] = uint8_t((FromB ? 16 : 0) + SrcLane * Elem + b);
    }
  };
  switch (IROp->Op) {
  case OP_VZIP:
  case OP_VZIP2:
  case OP_VUNZIP:
  case OP_VUNZIP2:
  case OP_VTRN:
  case OP_VTRN2: {
    if (Elem == 0 || Elem > 8 || OpBytes % Elem) {
      return false;
    }
    const uint32_t Lanes = OpBytes / Elem;
    const bool Second = IROp->Op == OP_VZIP2 || IROp->Op == OP_VUNZIP2 || IROp->Op == OP_VTRN2;
    for (uint32_t i = 0; i < Lanes; i++) {
      if (IROp->Op == OP_VZIP || IROp->Op == OP_VZIP2) {
        Put(i, i & 1, (Second ? Lanes / 2 : 0) + i / 2);
      } else if (IROp->Op == OP_VUNZIP || IROp->Op == OP_VUNZIP2) {
        const uint32_t J = 2 * i + (Second ? 1 : 0);
        Put(i, J / Lanes, J % Lanes);
      } else {
        Put(i, i & 1, (i & ~1u) + (Second ? 1 : 0));
      }
    }
    return true;
  }
  case OP_VREV64:
  case OP_VREV32: {
    const uint32_t Chunk = IROp->Op == OP_VREV64 ? 8 : 4;
    if (Elem == 0 || Elem >= Chunk) {
      return false;
    }
    Bv = OrderedNodeWrapper {};
    for (uint32_t i = 0; i < OpBytes && i < 16; i++) {
      const uint32_t C = i / Chunk, In = i % Chunk, E = In / Elem, B_ = In % Elem;
      Map[i] = uint8_t(C * Chunk + (Chunk / Elem - 1 - E) * Elem + B_);
    }
    return true;
  }
  case OP_VTBL1: {
    auto Op = IROp->C<IROp_VTBL1>();
    uint8_t C[16];
    if (!ConstVector(Op->VectorIndices, C)) {
      return false;
    }
    A = Op->VectorTable;
    Bv = OrderedNodeWrapper {};
    for (uint32_t i = 0; i < OpBytes && i < 16; i++) {
      Map[i] = C[i] < 16 ? C[i] : 0xFF;
    }
    return true;
  }
  case OP_VTBL2: {
    auto Op = IROp->C<IROp_VTBL2>();
    uint8_t C[16];
    if (!ConstVector(Op->VectorIndices, C)) {
      return false;
    }
    A = Op->VectorTable1;
    Bv = Op->VectorTable2;
    for (uint32_t i = 0; i < OpBytes && i < 16; i++) {
      Map[i] = C[i] < 32 ? C[i] : 0xFF;
    }
    return true;
  }
  case OP_VEXTR: {
    auto Op = IROp->C<IROp_VExtr>();
    if (OpBytes > 16 || Elem == 0) {
      return false;
    }
    // As EmitVectorOp: bytes Index * Elem.. of VectorUpper:VectorLower.
    A = Op->VectorUpper;
    Bv = Op->VectorLower;
    uint32_t Index = Op->Index;
    bool HighZero = false;
    if (Index >= OpBytes) {
      A = Op->VectorLower;
      Bv = OrderedNodeWrapper {};
      HighZero = true;
      Index -= OpBytes;
    }
    const uint32_t From = Index * Elem;
    for (uint32_t k = 0; k < OpBytes; k++) {
      const uint32_t J = From + k;
      Map[k] = J < OpBytes ? uint8_t(J) : HighZero ? 0xFF : uint8_t(16 + (J - OpBytes));
    }
    return true;
  }
  default: return false;
  }
}

// Which bytes of each vector value something reads: backward over the unit's
// blocks, through the xmm registers (per-register byte masks), to a fixpoint.
// Exits read the registers they store, by the same ABI rules as liveness
// (all of them where there's no ABI, at inlined calls and at jumps). Ops
// without a rule here read all of their operands.
void Emitter::ComputeDemand() {
  constexpr uint32_t ALL = ~0u;
  Demand.clear();
  EntryDemand.fill(ALL);
  static const bool Off = getenv("FEXWASM_NODEMAND");
  if (ContextTouchesRegs || Off || std::none_of(std::begin(XUsed), std::end(XUsed), [](bool U) { return U; })) {
    return; // (no xmm register: nothing to gain)
  }
  const uint32_t N = uint32_t(Blocks.size());
  Demand.assign(IR.GetSSACount(), 0);
  using Lanes = std::array<uint32_t, NUM_XMM>;
  std::vector<Lanes> In(N, Lanes {});
  auto Bytes = [](uint32_t n) { return n >= 32 ? ALL : (1u << n) - 1; };
  auto ElemMask = [&](uint32_t Index, uint32_t E) { return Bytes(E) << (Index * E); };
  auto Round = [&](uint32_t M, uint32_t E) { // widen to whole elements
    if (E == 0 || E > 16) {
      return M ? ALL : 0u;
    }
    uint32_t R = 0;
    for (uint32_t I = 0; I * E < 32; I++) {
      if (M & ElemMask(I, E)) {
        R |= ElemMask(I, E);
      }
    }
    return R;
  };
  auto XmmLive = [&](uint64_t Mask, Lanes& L) {
    for (uint32_t R = 0; R < NUM_XMM; R++) {
      if (Mask & XBit(R)) {
        L[R] = ALL;
      }
    }
  };
  bool Changed = true;
  auto Add = [&](OrderedNodeWrapper W, uint32_t M) {
    if (W.IsInvalid() || !M) {
      return;
    }
    uint32_t& D = Demand[ID(W)];
    if ((D | M) != D) {
      D |= M;
      Changed = true;
    }
  };
  std::vector<std::vector<std::pair<Ref, const IROp_Header*>>> BlockOps(N);
  for (uint32_t X = 0; X < N; X++) {
    if (!Blocks[X].Synthetic) {
      for (auto [CodeNode, IROp] : IR.GetCode(Blocks[X].Node)) {
        BlockOps[X].push_back({CodeNode, IROp});
      }
    }
  }
  while (Changed) {
    Changed = false;
    for (uint32_t X = N; X-- > 0;) {
      if (Blocks[X].Synthetic) {
        continue;
      }
      const auto& Ops = BlockOps[X];
      Lanes L {};
      bool Exit = false;
      for (auto& [CodeNode, IROp] : Ops) {
        if (IROp->Op == OP_BREAK) {
          Exit = true;
          L.fill(ALL);
        } else if (IROp->Op == OP_EXITFUNCTION) {
          Exit = true;
          auto Op = IROp->C<IROp_ExitFunction>();
          auto In1 = InlineAt.find(ID(CodeNode));
          auto In2 = IndirectInlineAt.find(ID(CodeNode));
          if (In1 != InlineAt.end()) { // the inlined callee reads our registers
            L = In1->second->EntryDemand;
          } else if (In2 != IndirectInlineAt.end()) { // or one of them, or the dispatcher's callee
            XmmLive(CallLive(), L);
            for (auto& [T, Callee] : In2->second) {
              for (uint32_t R = 0; R < NUM_XMM; R++) {
                L[R] |= Callee->EntryDemand[R];
              }
            }
          } else if (Op->Hint == BranchHint::Return) {
            XmmLive(ReturnLive(), L);
          } else if (Op->Hint == BranchHint::Call) {
            XmmLive(CallLive(), L);
          } else {
            L.fill(ALL);
          }
        }
      }
      if (!Exit) {
        for (uint32_t Sx : Blocks[X].Succ) {
          for (uint32_t R = 0; R < NUM_XMM; R++) {
            L[R] |= In[Sx][R];
          }
        }
      }
      for (size_t I = Ops.size(); I-- > 0;) {
        const Ref Node = Ops[I].first;
        const IROp_Header* IROp = Ops[I].second;
        const uint32_t D = Demand[ID(Node)], E = uint32_t(IROp->ElementSize), Sz = uint32_t(IROp->Size);
        const uint32_t E0 = Bytes(E);
        auto AllArgs = [&] {
          for (uint8_t A = 0, NA = GetArgs(IROp->Op); A < NA; A++) {
            Add(IROp->Args[A], ALL);
          }
        };
        switch (IROp->Op) {
        case OP_LOADREGISTER: {
          auto Op = IROp->C<IROp_LoadRegister>();
          if (Op->Class == RegClass::FPR && Op->Reg < NUM_XMM) {
            L[Op->Reg] |= D & Bytes(Sz);
          }
          break;
        }
        case OP_STOREREGISTER: {
          auto Phys = PhysicalRegister(Node);
          if (Phys.AsRegClass() == RegClass::FPRFixed && Phys.Reg < NUM_XMM) {
            Add(IROp->Args[0], L[Phys.Reg] & Bytes(Sz));
            L[Phys.Reg] &= ~Bytes(Sz);
          } else {
            AllArgs();
          }
          break;
        }
        case OP_STOREMEM:
        case OP_STOREMEMTSO: {
          auto Op = IROp->C<IROp_StoreMem>();
          Add(Op->Value, Op->Class == RegClass::FPR ? Bytes(Sz) : ALL);
          Add(Op->Addr, ALL);
          Add(Op->Offset, ALL);
          break;
        }
        case OP_FCMP: {
          auto Op = IROp->C<IROp_FCmp>();
          Add(Op->Scalar1, Bytes(uint32_t(Op->ElementSize)));
          Add(Op->Scalar2, Bytes(uint32_t(Op->ElementSize)));
          break;
        }
        case OP_FLOAT_TOGPR_ZS:
        case OP_FLOAT_TOGPR_S: {
          auto Op = IROp->C<IROp_Float_ToGPR_ZS>();
          Add(Op->Scalar, Bytes(uint32_t(Op->SrcElementSize)));
          break;
        }
        case OP_VEXTRACTTOGPR: {
          auto Op = IROp->C<IROp_VExtractToGPR>();
          Add(Op->Vector, ElemMask(Op->Index, E));
          break;
        }
        case OP_VDUPELEMENT: {
          auto Op = IROp->C<IROp_VDupElement>();
          Add(Op->Vector, D ? ElemMask(Op->Index, E) : 0);
          break;
        }
        case OP_VINSELEMENT: {
          auto Op = IROp->C<IROp_VInsElement>();
          Add(Op->DestVector, D & ~ElemMask(Op->DestIdx, E));
          Add(Op->SrcVector, D & ElemMask(Op->DestIdx, E) ? ElemMask(Op->SrcIdx, E) : 0);
          break;
        }
        case OP_VMOV: Add(IROp->Args[0], D & Bytes(Sz)); break;
        case OP_VZIP:
        case OP_VZIP2:
        case OP_VUNZIP:
        case OP_VUNZIP2:
        case OP_VTRN:
        case OP_VTRN2:
        case OP_VREV64:
        case OP_VREV32:
        case OP_VTBL1:
        case OP_VTBL2:
        case OP_VEXTR: {
          // Byte shuffles: Map[i] is the byte of A (0-15) or B (16-31) that
          // result byte i comes from, 0xFF for none.
          uint8_t Map[16];
          OrderedNodeWrapper A = IROp->Args[0], Bv = IROp->Args[1];
          if (Sz > 16 || !ShuffleMap(IROp, Map, A, Bv)) {
            AllArgs();
            break;
          }
          uint32_t DA = 0, DB = 0;
          for (uint32_t i = 0; i < 16; i++) {
            if ((D >> i & 1) && Map[i] != 0xFF) {
              (Map[i] < 16 ? DA : DB) |= 1u << (Map[i] & 15);
            }
          }
          if (IROp->Op == OP_VTBL1 || IROp->Op == OP_VTBL2) {
            Add(IROp->Op == OP_VTBL1 ? IROp->C<IROp_VTBL1>()->VectorIndices : IROp->C<IROp_VTBL2>()->VectorIndices, ALL);
          }
          Add(A, DA);
          Add(Bv, DB);
          break;
        }
        case OP_VFADD:
        case OP_VFSUB:
        case OP_VFMUL:
        case OP_VFDIV:
        case OP_VFMIN:
        case OP_VFMAX:
        case OP_VADD:
        case OP_VSUB:
        case OP_VAND:
        case OP_VOR:
        case OP_VXOR:
        case OP_VANDN:
        case OP_VFCMPEQ:
        case OP_VFCMPNEQ:
        case OP_VFCMPLT:
        case OP_VFCMPGT:
        case OP_VFCMPLE:
        case OP_VFCMPORD:
        case OP_VFCMPUNO:
        case OP_VCMPEQ:
        case OP_VCMPGT:
          if (E == 0 || E > 16) {
            AllArgs();
          } else {
            Add(IROp->Args[0], Round(D, E));
            Add(IROp->Args[1], Round(D, E));
          }
          break;
        case OP_VFNEG:
        case OP_VFABS:
        case OP_VFSQRT:
        case OP_VNOT:
          if (E == 0 || E > 16) {
            AllArgs();
          } else {
            Add(IROp->Args[0], Round(D, E));
          }
          break;
        case OP_VFADDSCALARINSERT:
        case OP_VFSUBSCALARINSERT:
        case OP_VFMULSCALARINSERT:
        case OP_VFDIVSCALARINSERT:
        case OP_VFMINSCALARINSERT:
        case OP_VFMAXSCALARINSERT:
        case OP_VFCMPSCALARINSERT:
          // lane 0 = op(Vector1[0], Vector2[0]); the rest from Vector1
          Add(IROp->Args[0], (D & ~E0) | (D & E0 ? E0 : 0));
          Add(IROp->Args[1], D & E0 ? E0 : 0);
          break;
        case OP_VFSQRTSCALARINSERT:
        case OP_VFRECPSCALARINSERT:
        case OP_VFRSQRTSCALARINSERT:
        case OP_VFTOISCALARINSERT:
          Add(IROp->Args[0], D & ~E0);
          Add(IROp->Args[1], D & E0 ? E0 : 0);
          break;
        case OP_VFTOFSCALARINSERT: {
          auto Op = IROp->C<IROp_VFToFScalarInsert>();
          Add(Op->Vector1, D & ~E0);
          Add(Op->Vector2, D & E0 ? Bytes(uint32_t(Op->SrcElementSize)) : 0);
          break;
        }
        case OP_VSTOFGPRINSERT: {
          auto Op = IROp->C<IROp_VSToFGPRInsert>();
          Add(Op->Vector, D & ~E0);
          Add(Op->Src, ALL);
          break;
        }
        default: AllArgs(); break;
        }
      }
      for (uint32_t R = 0; R < NUM_XMM; R++) {
        if (In[X][R] != L[R]) {
          In[X][R] = L[R];
          Changed = true;
        }
      }
    }
  }
  if (N) {
    EntryDemand = In[0];
  }
}

// Backward liveness over the unit's blocks, for what gets loaded at entry and
// reloaded after calls. At a way out of the function a register only needs a
// good local if the exit stores it (it may have been written): the rest are
// still right in memory. Of those, a guest return keeps its results and the
// callee-saved registers live, a guest call its arguments and the
// callee-saved registers (see BackendConfig::ABI), anything else all of them.
// Inlined calls keep everything live. In a structured region, a jump to
// another unit needs what that unit's entry needs (EntryLive, per unit).
bool Emitter::ComputeLiveness(const std::vector<uint64_t>* EntryLive) {
  LivenessOK = !Cfg.BrokerMemory && Structured && InlineLevel == 0 && !ContextTouchesRegs && !ENV_FLAG("FEXWASM_NOLIVENESS");
  if (!LivenessOK) {
    return false;
  }
  const uint32_t N = uint32_t(Blocks.size());
  std::vector<uint64_t> Fixed(N, 0); // live-out from the block's own exit
  std::vector<uint8_t> HasFixed(N, 0);
  for (uint32_t X = 0; X < N; X++) {
    if (Blocks[X].Synthetic) {
      continue;
    }
    const uint64_t Stored = MaybeWrittenIn[X] | BlockWrites[X] | InheritedMask; // what an exit here writes back
    for (auto [CodeNode, IROp] : IR.GetCode(Blocks[X].Node)) {
      if (IROp->Op == OP_BREAK) {
        Fixed[X] = Stored;
        HasFixed[X] = 1;
      } else if (IROp->Op == OP_EXITFUNCTION) {
        auto Op = IROp->C<IROp_ExitFunction>();
        HasFixed[X] = 1;
        uint64_t T;
        if (InlineAt.count(ID(CodeNode)) || IndirectInlineAt.count(ID(CodeNode))) {
          Fixed[X] = ~0ull; // inlined: the callee reads our locals
        } else if (Op->Hint == BranchHint::Return) {
          Fixed[X] = ReturnLive() & Stored;
        } else if (Op->Hint == BranchHint::Call) {
          Fixed[X] = CallLive() & Stored;
        } else if (S.RG && EntryLive) {
          // A jump: to a unit of this region, or out (all it may have written).
          Fixed[X] = Stored;
          if (ConstRIP(Op->NewRIP, &T)) {
            auto It = std::find(RegionRIPs->begin(), RegionRIPs->end(), T);
            if (It != RegionRIPs->end()) {
              const bool Stop = !Cfg.ReturnAddrs || Cfg.ReturnAddrs->count(T); // the stop check can leave
              Fixed[X] = (*EntryLive)[It - RegionRIPs->begin()] | (Stop ? Stored : 0);
            }
          } else {
            for (uint32_t Y : S.RIndirect[RegionIndex]) {
              Fixed[X] |= (*EntryLive)[Y];
            }
          }
        } else {
          Fixed[X] = Stored;
        }
      }
    }
  }
  LiveIn.assign(N, 0);
  for (bool Changed = true; Changed;) {
    Changed = false;
    for (size_t I = Rpo.size(); I-- > 0;) {
      const uint32_t X = Rpo[I];
      uint64_t Out = HasFixed[X] ? Fixed[X] : 0;
      if (!HasFixed[X]) {
        for (uint32_t Sx : Blocks[X].Succ) {
          Out |= LiveIn[Sx];
        }
      }
      const uint64_t In = BlockUse[X] | (Out & ~BlockDef[X]);
      if (In != LiveIn[X]) {
        LiveIn[X] = In;
        Changed = true;
      }
    }
  }
  return true;
}

// A guest call through the dispatcher (target RIP in T0): spill the state,
// run the callee until it returns to RetAddr, reload the state. Falls through
// when the call returned; otherwise the function returns the RIP to its own
// dispatcher. A call to the function's own entry (recursion) calls run()
// directly and only falls back to the dispatcher if that did not return.
void Emitter::EmitDispatchCall(uint64_t RetAddr, int32_t SelfEntry, uint64_t Target, uint64_t RetLive, bool AbiCall, bool TargetRel) {
  const bool Self = SelfEntry >= 0;
  SkipFlagSpill = XAbiFlags();
  ExitLive = AbiCall ? CallLive() : ~0ull;
  // Stored from their locals here, so those locals are good after the call.
  const uint64_t StoredHere = ExitMask() & ExitLive;
  Epilogue();
  ExitLive = ~0ull;
  SkipFlagSpill = false;
  // The stack pointer the return must come back with (the return address
  // popped): a return to RetAddr with any other isn't this call's, but one
  // made after the guest switched stacks under this frame (Wine's user mode
  // callbacks: NtCallbackReturn), and this frame is stale.
  const bool CheckRSP = IsArgReg(4) && !ENV_FLAG("FEXWASM_NORSPCHECK");
  uint32_t CallRSP = 0;
  if (CheckRSP) {
    CallRSP = NewLocal(I64);
    B.get(G[4]);
    B.i64c(8);
    B.u8(op::i64_add);
    B.set(CallRSP);
  }
  // (the dispatcher records it with the stop: see BackendConfig::ShadowBase)
  auto DispatchCall = [&] {
    if (CheckRSP && Cfg.ShadowBase) {
      SysBase();
      B.get(CallRSP);
      B.u8(op::i32_wrap_i64);
      B.mem(op::i32_store, 2, Cfg.StopRSPAddr);
    }
    Call(FUNC_DISPATCH);
  };
  const bool Depth = !XNoDepth();
  const bool MemDepth = Depth && !DepthParam();
  if (Depth) {
    if (DepthParam()) {
      B.get(DepthLocal());
    } else {
      SysBase();
      B.mem(op::i32_load, 2, Cfg.DepthAddr);
    }
    B.i32c(int32_t(Cfg.MaxCallDepth));
    B.u8(op::i32_lt_u);
    B.u8(op::if_);
    B.u8(0x40);
    Context.push_back({CtxKind::If, 0, Owner});
  }
  if (MemDepth) {
    SysBase();
    SysBase();
    B.mem(op::i32_load, 2, Cfg.DepthAddr);
    B.i32c(1);
    B.u8(op::i32_add);
    B.mem(op::i32_store, 2, Cfg.DepthAddr);
  }
  if (Cfg.HotThreshold && !S.IsRegion && S.RegionEntries.empty() && !XNoCaller()) { // profiling: who is calling (regions are done)
    SysBase();
    RipConst(S.FunctionEntry, false);
    B.mem(op::i32_store, 2, Cfg.CallerAddr);
  }
  if (Self) {
    if (!S.RegionEntries.empty()) { // a region's run starts at the unit in global 0
      B.i32c(SelfEntry);
      B.u8(0x24); // global.set (the region's entry selector)
      B.u32(SelectorGlobal());
    }
    PushCallArgs();
    Call(FUNC_RUN);
    PopRegArgs();
    B.tee(TC);
    RipConst(RetAddr, false);
    B.u8(op::i32_ne);
    B.u8(op::if_);
    B.u8(0x40);
    B.get(TC);
    RipConst(RetAddr, false);
    PushCallArgs();
    DispatchCall();
    PopRegArgs();
    B.set(TC);
    B.u8(op::end);
  } else if (const uint32_t Slot = Target && Cfg.TableSlot && Cfg.SlotTagBase ? Cfg.TableSlot(Target) : 0;
             Slot && Slot < Cfg.SlotTagCount) {
    // Inline cache: call the target's table slot directly while it still
    // holds the target; the dispatcher finishes the call if the callee left
    // for somewhere else, and takes over when the tag doesn't match.
    S.UsesTable = true;
    // (relocatable: the slot is global e.s<i>, set when the unit is instantiated)
    const uint32_t SlotGlobal = DeltaGlobal() + 1 + uint32_t(S.ICTargets.size());
    if (S.RelocOn) {
      S.ICTargets.push_back({Target, TargetRel});
    }
    SysBase();
    if (S.RelocOn) {
      B.u8(0x23); // global.get e.s<i>
      B.u32(SlotGlobal);
      B.i32c(2);
      B.u8(op::i32_shl);
      B.u8(op::i32_add);
      B.mem(op::i32_load, 2, Cfg.SlotTagBase);
    } else {
      B.mem(op::i32_load, 2, Cfg.SlotTagBase + 4 * Slot);
    }
    RipConst(Target, false, TargetRel);
    B.u8(op::i32_eq);
    B.u8(op::if_);
    B.u8(0x40);
    PushCallArgs();
    if (S.RelocOn) {
      B.u8(0x23);
      B.u32(SlotGlobal);
    } else {
      B.i32c(int32_t(Slot));
    }
    B.u8(0x11); // call_indirect run's type (patched in Finish), table 0
    S.RunTypeSites.push_back(B.size());
    for (int i = 0; i < 4; i++) {
      B.u8(0x80);
    }
    B.u8(0);
    B.u8(0);
    PopRegArgs();
    B.tee(TC);
    RipConst(RetAddr, false);
    B.u8(op::i32_ne);
    B.u8(op::if_);
    B.u8(0x40);
    B.get(TC);
    RipConst(RetAddr, false);
    PushCallArgs();
    DispatchCall();
    PopRegArgs();
    B.set(TC);
    B.u8(op::end);
    B.u8(op::else_);
    B.get(T0);
    Wrap();
    RipConst(RetAddr, false);
    PushCallArgs();
    DispatchCall();
    PopRegArgs();
    B.set(TC);
    B.u8(op::end);
  } else {
    B.get(T0);
    Wrap();
    RipConst(RetAddr, false);
    PushCallArgs();
    DispatchCall();
    PopRegArgs();
    B.set(TC);
  }
  if (MemDepth) {
    SysBase();
    SysBase();
    B.mem(op::i32_load, 2, Cfg.DepthAddr);
    B.i32c(1);
    B.u8(op::i32_sub);
    B.mem(op::i32_store, 2, Cfg.DepthAddr);
  }
  // Anything but the return address: the callee left for code that is not
  // translated yet, so unwind to the runtime with it. (The return address
  // with another stack pointer: see CallRSP; unwind too.)
  B.get(TC);
  RipConst(RetAddr, false);
  B.u8(op::i32_ne);
  if (CheckRSP) {
    B.get(G[4]);
    B.get(CallRSP);
    B.u8(op::i64_ne);
    B.u8(op::i32_or);
  }
  B.u8(op::if_);
  B.u8(0x40);
  B.get(TC);
  Return();
  B.u8(op::end);
  SkipFlagSpill = XAbiFlags();
  if (Cfg.ProfAddr) { // (back in this unit: see ProfAddr)
    SysBase();
    RipConst(S.FunctionEntry, false);
    B.mem(op::i32_store, 2, Cfg.ProfAddr);
  }
  // Callee-saved registers the call's epilogue stored come back unchanged:
  // their locals are still right. (The others were never in a local here.)
  static const bool NoKeep = getenv("FEXWASM_NOKEEPSAVED");
  ReloadState(AbiCall && !NoKeep ? RetLive & ~(CalleeSaved() & StoredHere) : RetLive);
  SkipFlagSpill = false;
  if (XAbiFlags()) {
    // The flags are dead after the call: define them anew so that the old
    // values aren't kept alive across it.
    if (FlagsTouched) {
      B.i32c(0);
      B.set(NZCV);
      B.i32c(FK_MAT);
      B.set(FK);
      B.i64c(0);
      B.set(FA);
      B.i64c(0);
      B.set(FB);
    }
    for (uint32_t R : {PF_REG, AF_REG}) {
      if (GUsed[R]) {
        B.i64c(0);
        B.set(G[R]);
      }
    }
  }
  if (Depth) { // too deep: exit to the dispatcher with the call instead
    B.u8(op::else_);
    static const bool CountDeep = ENV_FLAG("FEXWASM_COUNTDEEP"); // (debugging: u32 at Sys 0x6C counts these)
    if (CountDeep) {
      SysBase();
      SysBase();
      B.mem(op::i32_load, 2, 0x6C);
      B.i32c(1);
      B.u8(op::i32_add);
      B.mem(op::i32_store, 2, 0x6C);
    }
    B.get(T0);
    Wrap();
    Return();
    Context.pop_back();
    B.u8(op::end);
  }
}

// Emits an inlined callee at its call site: its returns to the call's return
// address leave the InlineReturn block, and the caller carries on in RetIndex.
void Emitter::EmitInlined(Emitter& Callee, uint32_t RetIndex) {
  const uint32_t X = CurBlock;
  Callee.InheritedMask = ExitMask();
  B.u8(op::block);
  B.u8(0x40);
  Context.push_back({CtxKind::InlineReturn, 0, Callee.Owner});
  Callee.EmitBody();
  Context.pop_back();
  B.u8(op::end);
  FlagsKnown = false;
  BranchToBlock(X, RetIndex);
}

// The function's shared locals. It has no params, so indices start at 0.
void Emitter::AllocSharedLocals() {
  S.NumParams = uint32_t(ArgRegs.size()) + (DepthParam() ? 1 : 0);
  for (uint32_t R = 0; R < NUM_STATIC; R++) {
    auto It = std::find(ArgRegs.begin(), ArgRegs.end(), R);
    G[R] = It != ArgRegs.end() ? uint32_t(It - ArgRegs.begin()) : NewLocal(I64);
  }
  for (uint32_t R = 0; R < NUM_XMM; R++) {
    X[R] = NewLocal(V128);
  }
  NZCV = NewLocal(I32);
  FK = NewLocal(I32);
  FA = NewLocal(I64);
  FB = NewLocal(I64);
  T0 = NewLocal(I64);
  T1 = NewLocal(I64);
  T2 = NewLocal(I64);
  TC = NewLocal(I32);
  S.RegionUnit = NewLocal(I32);
  S.MatScratch = NewLocal(I64);
  S.RegionTarget = NewLocal(I64);
  S.SysBase = NewLocal(I32);
  if (Cfg.ThreadBaseGlobal) {
    B.u8(0x23); // global.get e.tb (global 0)
    B.u32(0);
  } else {
    B.i32c(0);
    B.mem(op::i32_load, 2, Cfg.ZeroAddr);
  }
  B.set(S.SysBase);
  if (S.RelocOn) {
    S.Delta64 = NewLocal(I64);
    S.Delta32 = NewLocal(I32);
    B.u8(0x23); // global.get e.d
    B.u32(DeltaGlobal());
    B.tee(S.Delta64);
    B.u8(op::i32_wrap_i64);
    B.set(S.Delta32);
  }
}

// $f80tof64(v): x87 extended (u64 mantissa in bytes 0-7, sign/exponent in 8-9)
// to double: the mantissa converted with one rounding, then scaled by powers
// of two chosen so the intermediate never underflows early.
static Buf F80ToF64Function() {
  Buf F;
  const uint32_t V = 0, Mant = 1, SE = 2, K = 3, R = 4;
  F.u32(3);
  F.u32(1);
  F.u8(I64);
  F.u32(2);
  F.u8(I32);
  F.u32(1);
  F.u8(F64);
  auto Pow2 = [&](auto PushExp) { // f64 2^e for e in [-1022, 1023]
    PushExp();
    F.i32c(1023);
    F.u8(op::i32_add);
    F.u8(op::i64_extend_i32_u);
    F.i64c(52);
    F.u8(op::i64_shl);
    F.u8(0xbf); // f64.reinterpret_i64
  };
  F.get(V);
  F.u8(op::prefix_fd);
  F.u32(0x1d);
  F.u8(0);
  F.set(Mant);
  F.get(V);
  F.u8(op::prefix_fd);
  F.u32(0x19); // i16x8.extract_lane_u 4
  F.u8(4);
  F.set(SE);
  // inf / nan
  F.get(SE);
  F.i32c(0x7fff);
  F.u8(op::i32_and);
  F.i32c(0x7fff);
  F.u8(op::i32_eq);
  F.u8(op::if_);
  F.u8(0x40);
  F.get(SE);
  F.u8(op::i64_extend_i32_u);
  F.i64c(15);
  F.u8(op::i64_shr_u);
  F.i64c(63);
  F.u8(op::i64_shl);
  F.i64c(0x7ff0'0000'0000'0000ll);
  F.u8(op::i64_or);
  F.get(Mant);
  F.i64c(11);
  F.u8(op::i64_shr_u);
  F.i64c(0x000f'ffff'ffff'ffffll);
  F.u8(op::i64_and);
  F.u8(op::i64_or);
  F.get(Mant);
  F.i64c(1);
  F.u8(op::i64_shl);
  F.u8(op::i64_eqz);
  F.u8(op::i32_eqz);
  F.u8(op::i64_extend_i32_u);
  F.i64c(51);
  F.u8(op::i64_shl);
  F.u8(op::i64_or); // quiet NaNs
  F.u8(0xbf);
  F.u8(op::return_);
  F.u8(op::end);
  // k = exp - 16383 - 63 (exp 0: denormal, as exp 1), clamped
  F.get(SE);
  F.i32c(0x7fff);
  F.u8(op::i32_and);
  F.tee(K);
  F.i32c(1);
  F.get(K);
  F.u8(op::select);
  F.i32c(16383 + 63);
  F.u8(op::i32_sub);
  F.tee(K);
  F.i32c(-3000);
  F.get(K);
  F.i32c(-3000);
  F.u8(op::i32_gt_s);
  F.u8(op::select);
  F.tee(K);
  F.i32c(3000);
  F.get(K);
  F.i32c(3000);
  F.u8(op::i32_lt_s);
  F.u8(op::select);
  F.set(K);
  F.get(Mant);
  F.u8(0xba); // f64.convert_i64_u (one rounding)
  F.set(R);
  // three steps of at most 2^(+-1022)
  for (int Step = 0; Step < 3; Step++) {
    F.get(R);
    Pow2([&] {
      F.get(K);
      F.i32c(-1022);
      F.get(K);
      F.i32c(-1022);
      F.u8(op::i32_gt_s);
      F.u8(op::select);
      F.tee(SE); // SE is free now: the step exponent (the sign is re-read from V)
      F.i32c(1023);
      F.get(SE);
      F.i32c(1023);
      F.u8(op::i32_lt_s);
      F.u8(op::select);
      F.tee(SE);
    });
    F.u8(0xa2); // f64.mul
    F.set(R);
    F.get(K);
    F.get(SE);
    F.u8(op::i32_sub);
    F.set(K);
  }
  // sign
  F.get(R);
  F.get(V);
  F.u8(op::prefix_fd);
  F.u32(0x19);
  F.u8(4);
  F.i32c(0x8000);
  F.u8(op::i32_and);
  F.u8(op::i32_eqz);
  F.u8(op::if_);
  F.u8(F64);
  F.f64c(1.0);
  F.u8(op::else_);
  F.f64c(-1.0);
  F.u8(op::end);
  F.u8(0xa6); // f64.copysign
  F.u8(op::end);
  return F;
}

// $f64tof80(x): exact.
static Buf F64ToF80Function() {
  Buf F;
  const uint32_t X = 0, Bits = 1, E = 2, Frac = 3, Mant = 4, Exp = 5;
  F.u32(1);
  F.u32(5);
  F.u8(I64);
  F.get(X);
  F.u8(0xbd); // i64.reinterpret_f64
  F.set(Bits);
  F.get(Bits);
  F.i64c(52);
  F.u8(op::i64_shr_u);
  F.i64c(0x7ff);
  F.u8(op::i64_and);
  F.set(E);
  F.get(Bits);
  F.i64c(0x000f'ffff'ffff'ffffll);
  F.u8(op::i64_and);
  F.set(Frac);
  // normal: 1.f << 11, exp - 1023 + 16383
  F.get(Frac);
  F.i64c(11);
  F.u8(op::i64_shl);
  F.i64c(int64_t(0x8000'0000'0000'0000ull));
  F.u8(op::i64_or);
  F.set(Mant);
  F.get(E);
  F.i64c(16383 - 1023);
  F.u8(op::i64_add);
  F.set(Exp);
  // inf / nan
  F.get(E);
  F.i64c(0x7ff);
  F.u8(op::i64_eq);
  F.u8(op::if_);
  F.u8(0x40);
  F.i64c(0x7fff);
  F.set(Exp);
  F.u8(op::end);
  // zero / denormal: normalise the fraction
  F.get(E);
  F.u8(op::i64_eqz);
  F.u8(op::if_);
  F.u8(0x40);
  F.get(Frac);
  F.get(Frac);
  F.u8(op::i64_clz);
  F.u8(op::i64_shl);
  F.set(Mant);
  F.i64c(15372);
  F.get(Frac);
  F.u8(op::i64_clz);
  F.u8(op::i64_sub);
  F.i64c(0);
  F.get(Frac);
  F.u8(op::i64_eqz);
  F.u8(op::i32_eqz);
  F.u8(op::select);
  F.set(Exp);
  F.u8(op::end);
  F.i64c(0);
  F.u8(op::prefix_fd);
  F.u32(0x12); // i64x2.splat 0
  F.get(Mant);
  F.u8(op::prefix_fd);
  F.u32(0x1e);
  F.u8(0);
  F.get(Bits);
  F.i64c(63);
  F.u8(op::i64_shr_u);
  F.i64c(15);
  F.u8(op::i64_shl);
  F.get(Exp);
  F.u8(op::i64_or);
  F.u8(op::prefix_fd);
  F.u32(0x1e); // i64x2.replace_lane 1 (only the low 16 bits are meaningful)
  F.u8(1);
  F.u8(op::end);
  return F;
}

// $i64tof80(x): exact.
static Buf I64ToF80Function() {
  Buf F;
  const uint32_t X = 0, Abs = 1, Lz = 2;
  F.u32(1);
  F.u32(2);
  F.u8(I64);
  F.i64c(0);
  F.get(X);
  F.u8(op::i64_sub);
  F.get(X);
  F.get(X);
  F.i64c(0);
  F.u8(op::i64_lt_s);
  F.u8(op::select);
  F.set(Abs);
  F.get(Abs);
  F.u8(op::i64_clz);
  F.set(Lz);
  F.i64c(0);
  F.u8(op::prefix_fd);
  F.u32(0x12);
  F.get(Abs);
  F.get(Lz);
  F.u8(op::i64_shl);
  F.u8(op::prefix_fd);
  F.u32(0x1e);
  F.u8(0);
  // sign << 15 | (16383 + 63 - lz), or 0 for zero
  F.get(X);
  F.i64c(63);
  F.u8(op::i64_shr_u);
  F.i64c(15);
  F.u8(op::i64_shl);
  F.i64c(16383 + 63);
  F.get(Lz);
  F.u8(op::i64_sub);
  F.u8(op::i64_or);
  F.i64c(0);
  F.get(Abs);
  F.u8(op::i64_eqz);
  F.u8(op::i32_eqz);
  F.u8(op::select);
  F.u8(op::prefix_fd);
  F.u32(0x1e);
  F.u8(1);
  F.u8(op::end);
  return F;
}

CompileResult Emitter::Run() {
  CompileResult Out;
  S.FunctionEntry = Entry;
  S.InlineStack.push_back(Entry);
  Analyze();
  ComputeLiveness();
  AllocSharedLocals();
  EntryPrologue();
  if (Cfg.HotThreshold && Cfg.UnitCounterBase) {
    // Tier 1 counts its own entries (however it is entered: dispatcher, call
    // inline cache, recursion) in a counter picked by its RIP.
    const uint32_t Addr = Cfg.UnitCounterBase + 4 * ((uint32_t(Entry) * 0x9E3779B1u) >> (32 - Cfg.UnitCounterBits));
    SysBase();
    SysBase();
    B.mem(op::i32_load, 2, Addr); // (a relocated unit keeps its counter: any will do)
    B.i32c(1);
    B.u8(op::i32_add);
    B.tee(TC);
    B.mem(op::i32_store, 2, Addr);
    B.get(TC);
    B.i32c(int32_t(Cfg.HotThreshold));
    B.u8(op::i32_eq);
    B.u8(op::if_);
    B.u8(0x40);
    RipConst(Entry, false);
    Call(FUNC_HOT);
    B.u8(op::end);
  }
  EmitBody();
  if (!Err.empty()) {
    Out.Error = Err;
    return Out;
  }
  B.u8(op::unreachable);
  B.u8(op::end); // function
  Out = Finish();
  Out.Blocks = NumBlocks;
  // Static successors, including those of inlined callees.
  auto Collect = [&](Emitter& E) {
    for (auto [BlockNode, BlockHeader] : E.IR.GetBlocks()) {
      for (auto [CodeNode, IROp] : E.IR.GetCode(BlockNode)) {
        if (IROp->Op == OP_CONSTANT || IROp->Op == OP_ENTRYPOINTOFFSET || IROp->Op == OP_INLINECONSTANT ||
            IROp->Op == OP_INLINEENTRYPOINTOFFSET) {
          uint64_t V;
          if (E.ConstRIP(E.IR.WrapNode(CodeNode), &V) && (V >> 32) == (Entry >> 32)) {
            Out.AddressConstants.push_back(V);
          }
          continue;
        }
        if (IROp->Op != OP_EXITFUNCTION) {
          continue;
        }
        auto Op = IROp->C<IROp_ExitFunction>();
        uint64_t T;
        if (E.ConstRIP(Op->NewRIP, &T)) {
          Out.StaticSuccessors.push_back(T);
        }
        if (E.CallRetAddr(Op, &T)) {
          Out.StaticSuccessors.push_back(T);
        }
      }
    }
  };
  Collect(*this);
  for (auto& C : S.Inlined) {
    Collect(*C);
  }
  return Out;
}

// A region: several units in one function, entered at the first. Units
// branch to each other through the loop's br_table instead of returning to
// the dispatcher, so guest state stays in locals across the whole region.
CompileResult Emitter::RunRegion(std::vector<std::unique_ptr<Emitter>>& Units) {
  CompileResult Out;
  const uint32_t RegionOwner = S.NextOwner++;
  S.FunctionEntry = Units[0]->Entry;
  uint64_t Mask = 0;
  for (auto& U : Units) {
    U->RegionOwner = RegionOwner;
    S.InlineStack = {U->Entry};
    U->Analyze();
    for (uint64_t W : U->BlockWrites) {
      Mask |= W;
    }
  }
  for (auto& U : Units) {
    U->InheritedMask = Mask;
  }
  AllocSharedLocals();
  Prologue();
  const uint32_t K = uint32_t(Units.size());
  // The loop's br_table is indexed by (RIP - MinRIP): one table jump per
  // transition, direct or indirect. Offsets that are not unit entries go to
  // the exit block at the bottom.
  uint64_t MinRIP = UINT64_MAX, MaxRIP = 0;
  for (auto& U : Units) {
    MinRIP = std::min(MinRIP, U->Entry);
    MaxRIP = std::max(MaxRIP, U->Entry);
  }
  // Compact regions index the loop's br_table by (RIP - MinRIP), so an
  // indirect jump is one table branch. Spread-out ones index it by unit
  // number, and indirect jumps binary-search the sorted unit RIPs.
  const bool Dense = MaxRIP - MinRIP < 0x1000;
  const uint32_t Span = Dense ? uint32_t(MaxRIP - MinRIP) + 1 : K;
  for (auto& U : Units) {
    U->RegionBase = MinRIP;
    U->RegionSpan = Span;
    U->RegionDense = Dense;
  }
  // The entry unit comes from the module's global 0, which the per-unit entry
  // thunks set (see Finish), so any unit of the region can start it.
  for (uint32_t I = 0; I < K; I++) {
    S.RegionEntries.push_back(Dense ? uint32_t(Units[I]->Entry - MinRIP) : I);
    S.RegionUnitRIPs.push_back(Units[I]->Entry);
  }
  B.u8(0x23); // global.get (the region's entry selector)
  B.u32(SelectorGlobal());
  B.set(S.RegionUnit);
  B.u8(op::loop);
  B.u8(0x40);
  Context.push_back({CtxKind::RegionLoop, 0, RegionOwner});
  B.u8(op::block); // exit
  B.u8(0x40);
  Context.push_back({CtxKind::If, 0, RegionOwner});
  for (uint32_t I = K; I-- > 0;) {
    B.u8(op::block);
    B.u8(0x40);
    Context.push_back({CtxKind::If, 0, RegionOwner});
  }
  B.get(S.RegionUnit);
  B.u8(op::br_table);
  B.u32(Span);
  for (uint32_t Off = 0; Off < Span; Off++) {
    uint32_t Label = K; // exit
    for (uint32_t I = 0; I < K; I++) {
      if ((Dense ? uint32_t(Units[I]->Entry - MinRIP) : I) == Off) {
        Label = I;
      }
    }
    B.u32(Label);
  }
  B.u32(K);
  for (uint32_t I = 0; I < K; I++) {
    B.u8(op::end);
    Context.pop_back();
    Units[I]->EmitBody();
    if (!Err.empty()) {
      Out.Error = Err;
      return Out;
    }
  }
  B.u8(op::end); // exit block: an indirect jump that left the region
  Context.pop_back();
  Units[0]->CurBlock = 0;
  Units[0]->Epilogue();
  B.get(S.RegionTarget);
  B.u8(op::i32_wrap_i64);
  Return();
  Context.pop_back();
  B.u8(op::end); // loop
  B.u8(op::unreachable);
  B.u8(op::end); // function
  return Finish();
}

CompileResult Emitter::Finish() {
  CompileResult Out;
  // Assemble the module.
  FuncUsed[FUNC_RUN] = true;
  Buf Bodies[FUNC_NUM];
  CallSiteList BodySites[FUNC_NUM];
  // Helpers can call other helpers: build bodies until no new function is used.
  for (bool Changed = true; Changed;) {
    Changed = false;
    for (uint32_t Fn = 0; Fn < FUNC_RUN; Fn++) {
      if (!FuncUsed[Fn] || Funcs[Fn].Import || Bodies[Fn].size()) {
        continue;
      }
      switch (Fn) {
      case FUNC_MAT: Bodies[Fn] = MatFunction(); break;
      case FUNC_UMULH: Bodies[Fn] = UMulHFunction(); break;
      case FUNC_SMULH: Bodies[Fn] = SMulHFunction(BodySites[Fn]); break;
      case FUNC_DIV128U: Bodies[Fn] = Div128UFunction(); break;
      case FUNC_DIV128S: Bodies[Fn] = Div128SFunction(BodySites[Fn]); break;
      case FUNC_PDEP: Bodies[Fn] = PDepFunction(); break;
      case FUNC_PEXT: Bodies[Fn] = PExtFunction(); break;
      case FUNC_CPUID: Bodies[Fn] = CPUIDFunction(Cfg); break;
      case FUNC_F80TOF64: Bodies[Fn] = F80ToF64Function(); break;
      case FUNC_F64TOF80: Bodies[Fn] = F64ToF80Function(); break;
      case FUNC_I64TOF80: Bodies[Fn] = I64ToF80Function(); break;
      default: break;
      }
      for (auto& Site : BodySites[Fn]) {
        if (!FuncUsed[Site.second]) {
          FuncUsed[Site.second] = Changed = true;
        }
      }
    }
  }
  // Function index space: used imports, then used local functions (run last).
  uint32_t Index[FUNC_NUM] {}, NumFuncs = 0, NumImports = 0;
  for (int Pass = 0; Pass < 2; Pass++) {
    for (uint32_t Fn = 0; Fn < FUNC_NUM; Fn++) {
      if (FuncUsed[Fn] && (Funcs[Fn].Import != nullptr) == (Pass == 0)) {
        Index[Fn] = NumFuncs++;
        NumImports += Pass == 0;
      }
    }
  }
  // Types, one per distinct signature.
  std::vector<std::string> Sigs;
  uint32_t TypeOf[FUNC_NUM] {};
  for (uint32_t Fn = 0; Fn < FUNC_NUM; Fn++) {
    if (!FuncUsed[Fn]) {
      continue;
    }
    const std::string Sig = SigOf(Fn);
    auto It = std::find(Sigs.begin(), Sigs.end(), Sig);
    TypeOf[Fn] = uint32_t(It - Sigs.begin());
    if (It == Sigs.end()) {
      Sigs.push_back(Sig);
    }
  }
  PatchCalls(B, CallSites, Index);
  for (size_t At : S.RunTypeSites) {
    uint32_t V = TypeOf[FUNC_RUN];
    for (int i = 0; i < 5; i++, V >>= 7) {
      B.b[At + i] = uint8_t((V & 0x7f) | (i < 4 ? 0x80 : 0));
    }
  }
  for (uint32_t Fn = 0; Fn < FUNC_NUM; Fn++) {
    PatchCalls(Bodies[Fn], BodySites[Fn], Index);
  }

  Buf M;
  const uint8_t Header[] = {0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00};
  M.b.assign(Header, Header + sizeof(Header));
  {
    Buf T;
    T.u32(uint32_t(Sigs.size()));
    for (const std::string& Sig : Sigs) {
      const size_t Arrow = Sig.find('>');
      T.u8(0x60);
      for (int Part = 0; Part < 2; Part++) {
        const std::string Types = Part == 0 ? Sig.substr(0, Arrow) : Sig.substr(Arrow + 1);
        T.u32(uint32_t(Types.size()));
        for (char C : Types) {
          T.u8(C == 'i' ? I32 : C == 'I' ? I64 : C == 'v' ? V128 : F64);
        }
      }
    }
    M.section(1, T);
  }
  {
    Buf I;
    I.u32(1 + NumImports + (S.UsesTable ? 1 : 0) + (Cfg.ThreadBaseGlobal ? 1 : 0) + (S.RelocOn ? 1 + uint32_t(S.ICTargets.size()) : 0));
    I.str("e");
    I.str("mem");
    I.u8(0x02);
    I.u8(Cfg.SharedMemory ? 0x03 : 0x00); // shared: min and max
    I.u32(Cfg.MemPages);
    if (Cfg.SharedMemory) {
      I.u32(Cfg.MemMaxPages ? Cfg.MemMaxPages : Cfg.MemPages);
    }
    if (Cfg.ThreadBaseGlobal) {
      I.str("e");
      I.str("tb");
      I.u8(0x03); // global
      I.u8(I32);
      I.u8(0); // immutable
    }
    if (S.RelocOn) { // e.d (i64), then e.s0, e.s1, ... (i32): see SharedState::RelocOn
      I.str("e");
      I.str("d");
      I.u8(0x03);
      I.u8(I64);
      I.u8(0);
      for (size_t K = 0; K < S.ICTargets.size(); K++) {
        I.str("e");
        I.str("s" + std::to_string(K));
        I.u8(0x03);
        I.u8(I32);
        I.u8(0);
      }
    }
    if (S.UsesTable) {
      I.str("e");
      I.str("tbl");
      I.u8(0x01); // table
      I.u8(0x70); // funcref
      I.u8(0x00);
      I.u32(1);
    }
    for (uint32_t Fn = 0; Fn < FUNC_NUM; Fn++) {
      if (FuncUsed[Fn] && Funcs[Fn].Import) {
        I.str("e");
        I.str(Funcs[Fn].Import);
        I.u8(0x00);
        I.u32(TypeOf[Fn]);
      }
    }
    M.section(2, I);
  }
  // Regions: one entry thunk per unit, `() { global0 = entry; return run() }`,
  // exported as run (unit 0) and e1, e2, ...
  const uint32_t NumThunks = uint32_t(S.RegionEntries.size());
  {
    Buf F;
    F.u32(NumFuncs - NumImports + NumThunks);
    for (uint32_t Fn = 0; Fn < FUNC_NUM; Fn++) {
      if (FuncUsed[Fn] && !Funcs[Fn].Import) {
        F.u32(TypeOf[Fn]);
      }
    }
    for (uint32_t I = 0; I < NumThunks; I++) {
      F.u32(TypeOf[FUNC_RUN]);
    }
    M.section(3, F);
  }
  if (NumThunks) {
    Buf G;
    G.u32(1);
    G.u8(I32);
    G.u8(1); // mutable
    G.i32c(0);
    G.u8(op::end);
    M.section(6, G);
  }
  {
    Buf E;
    E.u32(NumThunks ? NumThunks : 1);
    E.str("run");
    E.u8(0x00);
    E.u32(NumThunks ? NumFuncs : Index[FUNC_RUN]);
    for (uint32_t I = 1; I < NumThunks; I++) { // u<rip>: the entry thunk of that unit
      char Name[24];
      snprintf(Name, sizeof(Name), "u%x", uint32_t(S.RegionUnitRIPs[I]));
      E.str(Name);
      E.u8(0x00);
      E.u32(NumFuncs + I);
    }
    M.section(7, E);
  }
  {
    Buf Run;
    // Locals that are never live together share an index (JavaScriptCore's
    // baseline tier gives every local a stack slot; worker stacks are small).
    static const bool NoCoalesce = ENV_FLAG("FEXWASM_NOCOALESCE");
    if (!NoCoalesce) {
      std::vector<uint8_t> Types(Locals.begin(), Locals.end());
      static CoalesceStats CS;
      if (CoalesceLocals(B.b, S.NumParams, Types, &CS)) {
        Locals.clear();
        for (uint8_t T : Types) {
          Locals.push_back(ValType(T));
        }
      }
      struct Report {
        ~Report() {
          if (ENV_FLAG("FEXWASM_SIZESTATS")) {
            fprintf(stderr, "locals %llu -> %llu after coalescing\n", (unsigned long long)CS.Before, (unsigned long long)CS.After);
          }
        }
      };
      static Report Rep;
    }
    // Locals grouped into runs of the same type.
    std::vector<std::pair<uint32_t, ValType>> Runs;
    for (ValType T : Locals) {
      if (!Runs.empty() && Runs.back().second == T) {
        Runs.back().first++;
      } else {
        Runs.push_back({1, T});
      }
    }
    Run.u32(uint32_t(Runs.size()));
    for (auto& [N, T] : Runs) {
      Run.u32(N);
      Run.u8(T);
    }
    Run.append(B);
    Bodies[FUNC_RUN] = std::move(Run);
    Buf C;
    C.u32(NumFuncs - NumImports + NumThunks);
    for (uint32_t Fn = 0; Fn < FUNC_NUM; Fn++) {
      if (FuncUsed[Fn] && !Funcs[Fn].Import) {
        C.u32(uint32_t(Bodies[Fn].size()));
        C.append(Bodies[Fn]);
      }
    }
    for (uint32_t I = 0; I < NumThunks; I++) {
      Buf T;
      T.u32(0);
      T.i32c(int32_t(S.RegionEntries[I]));
      T.u8(0x24); // global.set (entry selector)
      T.u32(SelectorGlobal());
      for (uint32_t R = 0; R < S.NumParams; R++) {
        T.get(R);
      }
      T.u8(ENV_FLAG("FEXWASM_THUNK_CALL") ? op::call : 0x12); // return_call
      T.u32(Index[FUNC_RUN]);
      T.u8(op::end);
      C.u32(uint32_t(T.size()));
      C.append(T);
    }
    Out.Relocatable = S.RelocOn && !S.NonRelocatable;
    Out.ICTargets = S.ICTargets;
    M.section(10, C);
  }
  {
    // name section: profilers show run as u<entry> (a unit) or r<entry> (a
    // region) instead of an anonymous wasm-function[N].
    static const char* const HelperNames[FUNC_NUM] = {"dispatch", "cycles", "rdrand", "mat", "umulh", "smulh", "div128u", "div128s",
                                                      "pdep", "pext", "cpuid", "f80tof64", "f64tof80", "i64tof80", "sin", "cos", "tan",
                                                      "atan2", "f2xm1", "fyl2x", "fyl2xp1", "fscale", "fprem", "fprem1", "hot", "syscall", "memory", "run"};
    static_assert(FUNC_NUM == 28, "HelperNames");
    Buf Names;
    uint32_t Count = 0;
    Buf List;
    for (uint32_t Fn = 0; Fn < FUNC_NUM; Fn++) {
      if (!FuncUsed[Fn]) {
        continue;
      }
      char Name[40];
      if (Fn == FUNC_RUN) {
        if (Cfg.BrokerMemory) snprintf(Name, sizeof(Name), "u%llx", (unsigned long long)S.FunctionEntry);
        else snprintf(Name, sizeof(Name), "%c%x", NumThunks || S.IsRegion ? 'r' : 'u', uint32_t(S.FunctionEntry));
      } else {
        snprintf(Name, sizeof(Name), "%s", HelperNames[Fn]);
      }
      List.u32(Index[Fn]);
      List.str(Name);
      Count++;
    }
    for (uint32_t I = 0; I < NumThunks; I++) {
      char Name[40];
      snprintf(Name, sizeof(Name), "t%x", uint32_t(S.RegionUnitRIPs[I]));
      List.u32(NumFuncs + I);
      List.str(Name);
      Count++;
    }
    Names.u32(Count);
    Names.append(List);
    Buf Sub;
    Sub.str("name");
    Sub.u8(1); // function names
    Sub.u32(uint32_t(Names.size()));
    Sub.append(Names);
    M.section(0, Sub);
  }
  Out.Module = std::move(M.b);
  return Out;
}

} // namespace

uint32_t MaterializeFlags(uint32_t Kind, uint64_t A, uint64_t Bv, uint32_t NZCV) {
  auto Pack = [](bool N, bool Z, bool C, bool V) { return uint32_t(N) << 31 | uint32_t(Z) << 30 | uint32_t(C) << 29 | uint32_t(V) << 28; };
  switch (Kind) {
  case FK_SUB32: {
    const uint32_t a = uint32_t(A), b = uint32_t(Bv), r = a - b;
    return Pack(r >> 31, r == 0, a >= b, ((a ^ b) & (a ^ r)) >> 31);
  }
  case FK_SUB64: {
    const uint64_t r = A - Bv;
    return Pack(r >> 63, r == 0, A >= Bv, ((A ^ Bv) & (A ^ r)) >> 63);
  }
  case FK_ADD32: {
    const uint32_t a = uint32_t(A), b = uint32_t(Bv), r = a + b;
    return Pack(r >> 31, r == 0, r < a, ((a ^ r) & (b ^ r)) >> 31);
  }
  case FK_ADD64: {
    const uint64_t r = A + Bv;
    return Pack(r >> 63, r == 0, r < A, ((A ^ r) & (Bv ^ r)) >> 63);
  }
  case FK_LOGIC32: return Pack(uint32_t(A) >> 31, uint32_t(A) == 0, false, false);
  case FK_LOGIC64: return Pack(A >> 63, A == 0, false, false);
  case FK_SUB32K:
  case FK_SUB64K:
  case FK_ADD32K:
  case FK_ADD64K: return (MaterializeFlags(BaseKind(FlagKind(Kind)), A, Bv, NZCV) & ~(1u << 29)) | (NZCV & (1u << 29));
  default:
    if (IsFloatKind(FlagKind(Kind))) {
      const int32_t Bk = Kind & ~FK_CINV;
      double a, b;
      if (Bk == FK_FCMP64 || Bk == FK_FCMPAX64) {
        memcpy(&a, &A, 8);
        memcpy(&b, &Bv, 8);
      } else {
        float fa, fb;
        const uint32_t A32 = uint32_t(A), B32 = uint32_t(Bv);
        memcpy(&fa, &A32, 4);
        memcpy(&fb, &B32, 4);
        a = fa;
        b = fb;
      }
      return FloatNZCV(FlagKind(Kind), a < b ? FO_LT : a == b ? FO_EQ : a > b ? FO_GT : FO_UN);
    }
    if (Kind & FK_CINV) {
      return MaterializeFlags(Kind & ~FK_CINV, A, Bv, NZCV) ^ (1u << 29);
    }
    return NZCV;
  }
}

std::vector<uint8_t> BuildDispatcher(const BackendConfig& Cfg, const std::vector<uint8_t>& CPUIDTable) {
  // dispatch(rip, stop, g0..gN-1) -> (rip, g0..gN-1): the register arguments
  // (see BackendConfig::RegArgs) pass through from unit to unit.
  // With register arguments the guest call depth rides along as the last
  // parameter of dispatch and run.
  const std::vector<uint32_t> ArgRegs = Cfg.RegArgList();
  const uint32_t N = uint32_t(ArgRegs.size()), DP = N ? 1 : 0, Rip = 0, Stop = 1, G0 = 2, Dep = G0 + N, H = Dep + DP, E = H + 1, Idx = H + 2,
                 Cnt = H + 3, K = H + 4, Sl = H + 5, OldStop = H + 6, TB = H + 7, SR = H + 8, Pushed = H + 9, SI = H + 10;
  // The shadow stack (BackendConfig::ShadowBase) needs RSP among the register arguments.
  const auto RspAt = std::find(ArgRegs.begin(), ArgRegs.end(), 4u);
  const uint32_t Shadow = RspAt != ArgRegs.end() ? Cfg.ShadowBase : 0, RspArg = G0 + uint32_t(RspAt - ArgRegs.begin());
  // TB: this thread's base for every Sys address (the imported e.tb, or 0).
  auto ThreadBase = [&](Buf& F, uint32_t Local) {
    if (Cfg.ThreadBaseGlobal) {
      F.u8(0x23); // global.get e.tb
      F.u32(0);
    } else {
      F.i32c(0);
    }
    F.set(Local);
  };
  const uint32_t Mask = (1u << Cfg.DispatchBits) - 1, Base = Cfg.DispatchBase;
  const bool Profile = Cfg.HotThreshold != 0;
  // dispatch profiles call sites too (see CallSiteBase); dispatchnp, for
  // region code, only units.
  // TB + 2 * (the filter's bucket for the RIP in local L), into SI
  auto FilterAt = [&](Buf& F, uint32_t L) {
    F.get(TB);
    F.get(L);
    F.i32c(int32_t(0x9E3779B1u));
    F.u8(op::i32_mul);
    F.i32c(24);
    F.u8(op::i32_shr_u);
    F.i32c(1);
    F.u8(op::i32_shl);
    F.u8(op::i32_add);
    F.set(SI);
  };
  // Before a return: this dispatch's entry comes off the shadow stack.
  auto ShadowPop = [&](Buf& F) {
    if (!Shadow) {
      return;
    }
    F.get(Pushed);
    F.u8(op::if_);
    F.u8(0x40);
    F.get(TB);
    F.get(TB);
    F.mem(op::i32_load, 2, Shadow);
    F.i32c(1);
    F.u8(op::i32_sub);
    F.mem(op::i32_store, 2, Shadow);
    FilterAt(F, Stop);
    F.get(SI);
    F.get(SI);
    F.mem(op::i32_load16_u, 1, Shadow + 0x100);
    F.i32c(1);
    F.u8(op::i32_sub);
    F.mem(op::i32_store16, 1, Shadow + 0x100);
    F.u8(op::end);
  };
  auto Body = [&](bool CallProfile) {
  Buf F;
  F.u32(1);
  F.u32(11);
  F.u8(I32);
  ThreadBase(F, TB);
  // Publish this dispatch's stop RIP; the previous one is restored on return.
  F.get(TB);
  F.mem(op::i32_load, 2, Cfg.StopAddr);
  F.set(OldStop);
  F.get(TB);
  F.get(Stop);
  F.mem(op::i32_store, 2, Cfg.StopAddr);
  if (Shadow) {
    // The stack pointer the stop comes back with (0: unknown), taken; with
    // one, this dispatch goes on the shadow stack.
    F.get(TB);
    F.mem(op::i32_load, 2, Cfg.StopRSPAddr);
    F.set(SR);
    F.get(TB);
    F.i32c(0);
    F.mem(op::i32_store, 2, Cfg.StopRSPAddr);
    F.get(SR);
    F.i32c(0);
    F.u8(op::i32_ne);
    F.get(TB);
    F.mem(op::i32_load, 2, Shadow);
    F.tee(K);
    F.i32c(int32_t(BackendConfig::ShadowMax));
    F.u8(op::i32_lt_u);
    F.u8(op::i32_and);
    F.u8(op::if_);
    F.u8(0x40);
    F.get(TB);
    F.get(K);
    F.i32c(3);
    F.u8(op::i32_shl);
    F.u8(op::i32_add);
    F.tee(SI);
    F.get(Stop);
    F.mem(op::i32_store, 2, Shadow + 0x400);
    F.get(SI);
    F.get(SR);
    F.mem(op::i32_store, 2, Shadow + 0x404);
    F.get(TB);
    F.get(K);
    F.i32c(1);
    F.u8(op::i32_add);
    F.mem(op::i32_store, 2, Shadow);
    FilterAt(F, Stop);
    F.get(SI);
    F.get(SI);
    F.mem(op::i32_load16_u, 1, Shadow + 0x100);
    F.i32c(1);
    F.u8(op::i32_add);
    F.mem(op::i32_store16, 1, Shadow + 0x100);
    F.i32c(1);
    F.set(Pushed);
    F.u8(op::end);
  }
  if (Profile && CallProfile) {
    // Call-site profile: per return address, the calling unit, a call count
    // (a hot site makes its caller hot) and up to four targets.
    const uint32_t CMask = (1u << Cfg.CallSiteBits) - 1, CBase = Cfg.CallSiteBase;
    F.get(Stop);
    F.i32c(int32_t(0x9E3779B1u));
    F.u8(op::i32_mul);
    F.i32c(int32_t(32 - Cfg.CallSiteBits));
    F.u8(op::i32_shr_u);
    F.set(H);
    // The table only ever fills: a call whose site isn't found within 32
    // probes goes unprofiled ($skip), instead of probing a full table forever.
    F.u8(op::block); // $skip
    F.u8(0x40);
    F.i32c(32);
    F.set(K);
    F.u8(op::block); // $have
    F.u8(0x40);
    F.u8(op::loop);
    F.u8(0x40);
    F.get(K);
    F.i32c(1);
    F.u8(op::i32_sub);
    F.tee(K);
    F.u8(op::i32_eqz);
    F.u8(op::br_if);
    F.u32(2); // -> $skip
    F.get(H);
    F.i32c(5);
    F.u8(op::i32_shl);
    F.get(TB);
    F.u8(op::i32_add);
    F.tee(E);
    F.mem(op::i32_load, 2, CBase);
    F.tee(Sl);
    F.get(Stop);
    F.u8(op::i32_eq);
    F.u8(op::br_if);
    F.u32(1);
    F.get(Sl);
    F.u8(op::i32_eqz);
    F.u8(op::if_);
    F.u8(0x40);
    F.get(E);
    F.get(Stop);
    F.mem(op::i32_store, 2, CBase);
    F.get(E);
    F.get(TB);
    F.mem(op::i32_load, 2, Cfg.CallerAddr);
    F.mem(op::i32_store, 2, CBase + 4);
    F.u8(op::br);
    F.u32(2);
    F.u8(op::end);
    F.get(H);
    F.i32c(1);
    F.u8(op::i32_add);
    F.i32c(int32_t(CMask));
    F.u8(op::i32_and);
    F.set(H);
    F.u8(op::br);
    F.u32(0);
    F.u8(op::end);
    F.u8(op::end);
    // calls++; at the threshold the calling unit is hot
    F.get(E);
    F.get(E);
    F.mem(op::i32_load, 2, CBase + 8);
    F.i32c(1);
    F.u8(op::i32_add);
    F.tee(Cnt);
    F.mem(op::i32_store, 2, CBase + 8);
    F.get(Cnt);
    F.i32c(int32_t(Cfg.CallHotThreshold));
    F.u8(op::i32_eq);
    F.u8(op::if_);
    F.u8(0x40);
    F.get(E);
    F.mem(op::i32_load, 2, CBase + 4);
    F.u8(op::call);
    F.u32(0); // import e.hot: the calling unit
    F.u8(op::end);
    F.u8(op::block);
    F.u8(0x40);
    for (uint32_t Slot = 0; Slot < 4; Slot++) {
      F.get(E);
      F.mem(op::i32_load, 2, CBase + 16 + 4 * Slot);
      F.tee(Sl);
      F.get(Rip);
      F.u8(op::i32_eq);
      F.u8(op::br_if);
      F.u32(0);
      F.get(Sl);
      F.u8(op::i32_eqz);
      F.u8(op::if_);
      F.u8(0x40);
      F.get(E);
      F.get(Rip);
      F.mem(op::i32_store, 2, CBase + 16 + 4 * Slot);
      F.u8(op::br);
      F.u32(1);
      F.u8(op::end);
    }
    F.u8(op::end);
    F.u8(op::end); // $skip
  }
  F.u8(op::loop); // $L
  F.u8(0x40);
  if (Cfg.TrackRIP) { // debugging: CPUState.rip follows every dispatch
    F.get(TB);
    F.get(Rip);
    F.u8(op::i64_extend_i32_u);
    F.mem(op::i64_store, 3, Cfg.CtxAddr + offsetof(CPUState, rip));
  }
  {
    // if (rip == stop) return rip
    F.get(Rip);
    F.get(Stop);
    F.u8(op::i32_eq);
    F.u8(op::if_);
    F.u8(0x40);
    ShadowPop(F);
    F.get(TB);
    F.get(OldStop);
    F.mem(op::i32_store, 2, Cfg.StopAddr);
    F.get(Rip);
    for (uint32_t R = 0; R < N; R++) {
      F.get(G0 + R);
    }
    F.u8(op::return_);
    F.u8(op::end);
    if (Shadow) {
      // The stop of a dispatch further out, with its stack pointer: the guest
      // returned past this one's call (see ShadowBase), so return to it.
      FilterAt(F, Rip);
      F.get(SI);
      F.mem(op::i32_load16_u, 1, Shadow + 0x100);
      F.u8(op::if_);
      F.u8(0x40);
      F.get(TB);
      F.mem(op::i32_load, 2, Shadow);
      F.set(K);
      F.u8(op::block); // $none
      F.u8(0x40);
      F.u8(op::loop);
      F.u8(0x40);
      F.get(K);
      F.u8(op::i32_eqz);
      F.u8(op::br_if);
      F.u32(1); // -> $none
      F.get(K);
      F.i32c(1);
      F.u8(op::i32_sub);
      F.tee(K);
      F.i32c(3);
      F.u8(op::i32_shl);
      F.get(TB);
      F.u8(op::i32_add);
      F.tee(SI);
      F.mem(op::i32_load, 2, Shadow + 0x400);
      F.get(Rip);
      F.u8(op::i32_eq);
      F.get(SI);
      F.mem(op::i32_load, 2, Shadow + 0x404);
      F.get(RspArg);
      F.u8(op::i32_wrap_i64);
      F.u8(op::i32_eq);
      F.u8(op::i32_and);
      F.u8(op::if_);
      F.u8(0x40);
      ShadowPop(F);
      F.get(TB);
      F.get(OldStop);
      F.mem(op::i32_store, 2, Cfg.StopAddr);
      F.get(Rip);
      for (uint32_t R = 0; R < N; R++) {
        F.get(G0 + R);
      }
      F.u8(op::return_);
      F.u8(op::end);
      F.u8(op::br);
      F.u32(0); // -> loop
      F.u8(op::end);
      F.u8(op::end);
      F.u8(op::end);
    }
    // h = (rip * golden) >> (32 - bits)
    F.get(Rip);
    F.i32c(int32_t(0x9E3779B1u));
    F.u8(op::i32_mul);
    F.i32c(int32_t(32 - Cfg.DispatchBits));
    F.u8(op::i32_shr_u);
    F.set(H);
    F.u8(op::block); // $found
    F.u8(0x40);
    F.u8(op::loop); // $probe
    F.u8(0x40);
    F.get(H);
    F.i32c(6);
    F.u8(op::i32_shl);
    F.get(TB);
    F.u8(op::i32_add);
    F.set(E);
    // hit
    F.get(E);
    F.mem(op::i32_load, 2, Base);
    F.get(Rip);
    F.u8(op::i32_eq);
    F.u8(op::if_);
    F.u8(0x40);
    F.get(E);
    F.mem(op::i32_load, 2, Base + 4);
    F.set(Idx);
    F.u8(op::br);
    F.u32(2); // -> $found
    F.u8(op::end);
    // empty slot: not translated yet
    F.get(E);
    F.mem(op::i32_load, 2, Base);
    F.u8(op::i32_eqz);
    F.u8(op::if_);
    F.u8(0x40);
    if (Cfg.MissAddr) {
      // the runtime installs it while this waits (see MissAddr): look again
      F.get(TB);
      F.i32c(1);
      F.mem(op::i32_store, 2, Cfg.MissAddr);
      F.get(Rip);
      F.u8(op::call);
      F.u32(0); // import e.hot
      F.get(TB);
      F.mem(op::i32_load, 2, Cfg.MissAddr);
      F.get(TB);
      F.i32c(0);
      F.mem(op::i32_store, 2, Cfg.MissAddr);
      F.i32c(2);
      F.u8(op::i32_eq);
      F.u8(op::if_);
      F.u8(0x40);
      F.u8(op::br);
      F.u32(4); // -> $L
      F.u8(op::end);
    }
    ShadowPop(F);
    F.get(TB);
    F.get(OldStop);
    F.mem(op::i32_store, 2, Cfg.StopAddr);
    F.get(Rip);
    for (uint32_t R = 0; R < N; R++) {
      F.get(G0 + R);
    }
    F.u8(op::return_);
    F.u8(op::end);
    F.get(H);
    F.i32c(1);
    F.u8(op::i32_add);
    F.i32c(int32_t(Mask));
    F.u8(op::i32_and);
    F.set(H);
    F.u8(op::br);
    F.u32(0); // -> $probe
    F.u8(op::end);
    F.u8(op::end);
    if (Profile) {
      // count++; at the threshold hand the RIP to the runtime to build a region.
      F.get(E);
      F.get(E);
      F.mem(op::i32_load, 2, Base + 8);
      F.i32c(1);
      F.u8(op::i32_add);
      F.tee(Cnt);
      F.mem(op::i32_store, 2, Base + 8);
      F.get(Cnt);
      F.i32c(int32_t(Cfg.HotThreshold));
      F.u8(op::i32_eq);
      F.u8(op::if_);
      F.u8(0x40);
      // The runtime compiles a region for it right away (import e.hot) and
      // patches the table, so this lookup is redone for the new function.
      F.get(Rip);
      F.u8(op::call);
      F.u32(0); // import e.hot
      F.get(E);
      F.mem(op::i32_load, 2, Base + 4);
      F.set(Idx);
      F.u8(op::end);
    }
    // rip = table[idx]()
    for (uint32_t R = 0; R < N; R++) {
      F.get(G0 + R);
    }
    if (DP) {
      F.get(Dep);
    }
    F.get(Idx);
    F.u8(op::call_indirect);
    F.u32(0); // type 0: run
    F.u32(0); // table 0
    for (uint32_t R = N; R-- > 0;) {
      F.set(G0 + R);
    }
    F.set(Rip);
    if (Profile) {
      // While the unit is not hot yet, remember the RIPs it exits to.
      F.get(Cnt);
      F.i32c(int32_t(Cfg.HotThreshold));
      F.u8(op::i32_lt_u);
      F.u8(op::if_);
      F.u8(0x40);
      F.i32c(0);
      F.set(K);
      F.u8(op::block);
      F.u8(0x40);
      F.u8(op::loop);
      F.u8(0x40);
      F.get(K);
      F.i32c(48);
      F.u8(op::i32_ge_u);
      F.u8(op::br_if);
      F.u32(1);
      F.get(E);
      F.get(K);
      F.u8(op::i32_add);
      F.mem(op::i32_load, 2, Base + 16);
      F.tee(Sl);
      F.get(Rip);
      F.u8(op::i32_eq);
      F.u8(op::br_if);
      F.u32(1);
      F.get(Sl);
      F.u8(op::i32_eqz);
      F.u8(op::if_);
      F.u8(0x40);
      F.get(E);
      F.get(K);
      F.u8(op::i32_add);
      F.get(Rip);
      F.mem(op::i32_store, 2, Base + 16);
      F.u8(op::br);
      F.u32(2);
      F.u8(op::end);
      F.get(K);
      F.i32c(4);
      F.u8(op::i32_add);
      F.set(K);
      F.u8(op::br);
      F.u32(0);
      F.u8(op::end);
      F.u8(op::end);
      F.u8(op::end);
    }
    F.u8(op::br);
    F.u32(0); // -> $L
  }
  F.u8(op::end);
  F.u8(op::unreachable);
  F.u8(op::end);
  return F;
  };
  const Buf F = Body(true), Fnp = Body(false);

  Buf M;
  const uint8_t Header[] = {0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00};
  M.b.assign(Header, Header + sizeof(Header));
  Buf T;
  T.u32(4);
  T.u8(0x60); // 0: run, (g.., depth) -> (i32, g..)
  T.u32(N + DP);
  for (uint32_t R = 0; R < N; R++) {
    T.u8(I64);
  }
  if (DP) {
    T.u8(I32);
  }
  T.u32(1 + N);
  T.u8(I32);
  for (uint32_t R = 0; R < N; R++) {
    T.u8(I64);
  }
  T.u8(0x60); // 1: dispatch, (i32 rip, i32 stop, g.., depth) -> (i32, g..)
  T.u32(2 + N + DP);
  T.u8(I32);
  T.u8(I32);
  for (uint32_t R = 0; R < N; R++) {
    T.u8(I64);
  }
  if (DP) {
    T.u8(I32);
  }
  T.u32(1 + N);
  T.u8(I32);
  for (uint32_t R = 0; R < N; R++) {
    T.u8(I64);
  }
  T.u8(0x60); // 2: (i32) -> ()
  T.u32(1);
  T.u8(I32);
  T.u32(0);
  T.u8(0x60); // 3: enter, (i32 rip, i32 stop) -> i32
  T.u32(2);
  T.u8(I32);
  T.u8(I32);
  T.u32(1);
  T.u8(I32);
  M.section(1, T);
  Buf I;
  I.u32(3 + (Cfg.ThreadBaseGlobal ? 1 : 0));
  if (Cfg.ThreadBaseGlobal) {
    I.str("e");
    I.str("tb"); // global 0: this thread's base
    I.u8(0x03);
    I.u8(I32);
    I.u8(0);
  }
  I.str("e");
  I.str("hot"); // function 0: the runtime's region compiler
  I.u8(0x00);
  I.u32(2);
  I.str("e");
  I.str("mem");
  I.u8(0x02);
  I.u8(Cfg.SharedMemory ? 0x03 : 0x00);
  I.u32(Cfg.MemPages);
  if (Cfg.SharedMemory) {
    I.u32(Cfg.MemMaxPages ? Cfg.MemMaxPages : Cfg.MemPages);
  }
  I.str("e");
  I.str("tbl");
  I.u8(0x01);
  I.u8(0x70);
  I.u8(0x00);
  I.u32(1);
  M.section(2, I);
  Buf Fs;
  Fs.u32(3);
  Fs.u32(1);
  Fs.u32(3);
  Fs.u32(1);
  M.section(3, Fs);
  Buf Ex;
  Ex.u32(3);
  Ex.str("dispatch");
  Ex.u8(0x00);
  Ex.u32(1);
  Ex.str("enter");
  Ex.u8(0x00);
  Ex.u32(2);
  Ex.str("dispatchnp");
  Ex.u8(0x00);
  Ex.u32(3);
  M.section(7, Ex);
  // enter(rip, stop) for the runtime: dispatch with the register arguments
  // loaded from and stored back to CPUState.
  Buf En;
  const uint32_t EnTB = 2 + N;
  En.u32(2);
  En.u32(N);
  En.u8(I64);
  En.u32(1);
  En.u8(I32);
  ThreadBase(En, EnTB);
  if (Cfg.ShadowBase) {
    // (nothing runs below the runtime's entry: the shadow stack starts empty,
    // whatever an exception unwinding the last one left there)
    En.get(EnTB);
    En.i32c(0);
    En.mem(op::i32_store, 2, Cfg.ShadowBase);
    En.get(EnTB);
    En.i32c(0);
    En.mem(op::i32_store, 2, Cfg.StopRSPAddr);
    for (uint32_t O = 0; O < 512; O += 8) {
      En.get(EnTB);
      En.i64c(0);
      En.mem(op::i64_store, 3, Cfg.ShadowBase + 0x100 + O);
    }
  }
  En.get(0);
  En.get(1);
  for (uint32_t R = 0; R < N; R++) {
    En.get(EnTB);
    En.mem(op::i64_load, 3, Cfg.CtxAddr + offsetof(CPUState, gregs) + 8 * ArgRegs[R]);
  }
  if (DP) {
    En.i32c(0); // depth
  }
  En.u8(op::call);
  En.u32(1);
  for (uint32_t R = N; R-- > 0;) {
    En.set(2 + R);
  }
  for (uint32_t R = 0; R < N; R++) {
    En.get(EnTB);
    En.get(2 + R);
    En.mem(op::i64_store, 3, Cfg.CtxAddr + offsetof(CPUState, gregs) + 8 * ArgRegs[R]);
  }
  En.u8(op::end);
  Buf C;
  C.u32(3);
  C.u32(uint32_t(F.size()));
  C.append(F);
  C.u32(uint32_t(En.size()));
  C.append(En);
  C.u32(uint32_t(Fnp.size()));
  C.append(Fnp);
  M.section(10, C);
  Buf NameSection; // after the data segments, for profilers
  {
    Buf Names;
    Names.u32(4);
    const char* const N[] = {"hot", "dispatch", "enter", "dispatchnp"};
    for (uint32_t I = 0; I < 4; I++) {
      Names.u32(I);
      Names.str(N[I]);
    }
    NameSection.str("name");
    NameSection.u8(1);
    NameSection.u32(uint32_t(Names.size()));
    NameSection.append(Names);
  }
  // Data segments: the CRC32C table and the host's CPUID table.
  std::vector<std::pair<uint32_t, std::vector<uint8_t>>> Segs;
  if (Cfg.CRCTableAddr) {
    std::vector<uint8_t> T(1024);
    for (uint32_t N = 0; N < 256; N++) {
      uint32_t C = N;
      for (int K = 0; K < 8; K++) {
        C = (C >> 1) ^ (0x82F6'3B78u & (0u - (C & 1)));
      }
      memcpy(&T[4 * N], &C, 4);
    }
    Segs.push_back({Cfg.CRCTableAddr, std::move(T)});
  }
  if (Cfg.CPUIDAddr && !CPUIDTable.empty()) {
    Segs.push_back({Cfg.CPUIDAddr, CPUIDTable});
  }
  if (!Segs.empty()) {
    Buf D;
    D.u32(uint32_t(Segs.size()));
    for (auto& [Addr, Bytes] : Segs) {
      D.u32(0); // active, memory 0
      D.i32c(int32_t(Addr));
      D.u8(op::end);
      D.u32(uint32_t(Bytes.size()));
      D.b.insert(D.b.end(), Bytes.begin(), Bytes.end());
    }
    M.section(11, D);
  }
  M.section(0, NameSection);
  return M.b;
}

// The immediate-TEST subprofile remains OP6/width0 on the wire. Prove the
// decoded operand/mask and the pinned frontend's four logical flag shapes;
// no operand, memory or context store may borrow the generic FLAGS profile.
static CompileResult CheckBrokerImmediateTest(const IRListView& IR, uint64_t EntryRIP, const BackendConfig& Cfg) {
  auto Reject = [](const char* Why) { CompileResult R; R.Error = std::string("broker immediate TEST ") + Why; return R; };
  const uint32_t Width = Cfg.BrokerTestWidth;
  if ((Width != 1 && Width != 2 && Width != 4 && Width != 8) || Cfg.BrokerOperation != 6 || Cfg.BrokerWidth ||
      Cfg.BrokerFlow || Cfg.BrokerTarget || Cfg.BrokerNoEffects || Cfg.BrokerTargetRegister >= 16 ||
      (Cfg.BrokerTestShift && (Cfg.BrokerTestShift != 8 || Width != 1))) return Reject("profile");
  const uint64_t WidthMask = Width == 8 ? ~0ull : (1ull << (Width * 8)) - 1;
  if ((Cfg.BrokerTestMask & ~WidthMask) || (Width == 8 && uint64_t(int64_t(int32_t(Cfg.BrokerTestMask))) != Cfg.BrokerTestMask)) return Reject("mask width");
  OrderedNodeWrapper Source {}, Extract {}, And {}, Flags {}, Invalidate {}, PF {}, ReadNZCV {}, Carry {}, StoreNZCV {}, Exit {};
  std::unordered_map<uint32_t, uint32_t> Order; uint32_t Position = 0;
  for (auto [Block, Header] : IR.GetBlocks()) for (auto [Node, H] : IR.GetCode(Block)) {
    const auto W = IR.WrapNode(Node); Order.emplace(IR.GetID(Node).Value, ++Position);
    if (!Exit.IsInvalid() && H->Op != OP_ENDBLOCK) return Reject("effect after exit");
    auto Once = [&](OrderedNodeWrapper& Slot) { if (!Slot.IsInvalid()) return false; Slot = W; return true; };
    switch (H->Op) {
    case OP_IRHEADER: case OP_CODEBLOCK: case OP_BEGINBLOCK: case OP_ENDBLOCK:
    case OP_GUESTOPCODE: case OP_INLINECONSTANT: case OP_CONSTANT: case OP_INLINEENTRYPOINTOFFSET: case OP_ENTRYPOINTOFFSET: break;
    case OP_LOADREGISTER:
      if (!Once(Source) || H->C<IROp_LoadRegister>()->Class != RegClass::GPR ||
          H->C<IROp_LoadRegister>()->Reg != Cfg.BrokerTargetRegister || uint32_t(H->Size) != 8) return Reject("source");
      break;
    case OP_LSHR: if (!Once(Extract)) return Reject("extraction count"); break;
    case OP_AND: if (!Once(And)) return Reject("AND count"); break;
    case OP_ANDWITHFLAGS: if (!Once(And) || !Once(Flags)) return Reject("flag count"); break;
    case OP_SUBWITHFLAGS: case OP_SUBNZCV: case OP_TESTNZ: if (!Once(Flags)) return Reject("flag count"); break;
    case OP_INVALIDATEFLAGS:
      if (!Once(Invalidate) || uint32_t(H->Size) || H->C<IROp_InvalidateFlags>()->Flags != (1u << FEXCore::X86State::RFLAG_AF_RAW_LOC)) return Reject("AF invalidation");
      break;
    case OP_STOREPF: if (!Once(PF) || uint32_t(H->Size) != 8) return Reject("PF store"); break;
    case OP_LOADNZCV: if (!Once(ReadNZCV) || uint32_t(H->Size) != 4) return Reject("NZCV read"); break;
    case OP_XOR: if (!Once(Carry) || uint32_t(H->Size) != 4) return Reject("carry normalization"); break;
    case OP_STORENZCV: if (!Once(StoreNZCV) || uint32_t(H->Size) != 4) return Reject("NZCV store"); break;
    case OP_EXITFUNCTION: if (!Once(Exit)) return Reject("exit count"); break;
    default: return Reject("uncovered effect");
    }
  }
  auto Before = [&](OrderedNodeWrapper A, OrderedNodeWrapper B) {
    if (A.IsInvalid() || B.IsInvalid()) return false;
    const auto X = Order.find(IR.GetID(IR.GetNode(A)).Value), Y = Order.find(IR.GetID(IR.GetNode(B)).Value);
    return X != Order.end() && Y != Order.end() && X->second < Y->second;
  };
  auto Constant = [&](OrderedNodeWrapper W, uint64_t Expected, OrderedNodeWrapper Use) {
    if (!Before(W, Use)) return false;
    const auto* H = IR.GetOp<IROp_Header>(W); if (uint32_t(H->Size) != 8) return false;
    return (H->Op == OP_INLINECONSTANT && H->C<IROp_InlineConstant>()->Constant == Expected) ||
           (H->Op == OP_CONSTANT && H->C<IROp_Constant>()->Constant == Expected);
  };
  if (Source.IsInvalid() || Flags.IsInvalid() || Invalidate.IsInvalid() || PF.IsInvalid() || Exit.IsInvalid() ||
      !Before(Flags, Invalidate) || !Before(Invalidate, PF) || !Before(PF, Exit)) return Reject("ordered effects");
  OrderedNodeWrapper Value = Source;
  if (Cfg.BrokerTestShift) {
    if (Extract.IsInvalid()) return Reject("missing high byte");
    const auto* E = IR.GetOp<IROp_Header>(Extract);
    if (uint32_t(E->Size) != 4 || E->Args[0] != Source || !Before(Source, Extract) || !Constant(E->Args[1], 8, Extract)) return Reject("high byte");
    Value = Extract;
  } else if (!Extract.IsInvalid()) return Reject("unexpected high byte");
  const auto* F = IR.GetOp<IROp_Header>(Flags); OrderedNodeWrapper Parity {};
  const bool All = Cfg.BrokerTestMask == WidthMask;
  const bool Small = !All && Width < 4 && !(Cfg.BrokerTestMask & (1ull << (Width * 8 - 1)));
  const bool NormalizeCarry = !Small && (!All || Width < 4);
  if (!All) {
    if (And.IsInvalid()) return Reject("missing AND");
    const auto* A = IR.GetOp<IROp_Header>(And);
    if (A->Op != (Small ? OP_AND : OP_ANDWITHFLAGS) || uint32_t(A->Size) != (Small ? 4u : Width) ||
        A->Args[0] != Value || !Before(Value, And) || !Constant(A->Args[1], Cfg.BrokerTestMask, And)) return Reject("AND dataflow");
    Parity = And;
    if (Small) {
      if (F->Op != OP_SUBNZCV || uint32_t(F->Size) != 4 || F->Args[0] != And ||
          !Before(And, Flags) || !Constant(F->Args[1], 0, Flags)) return Reject("small logical flags");
    } else if (Flags != And) return Reject("logical flag producer");
  } else {
    if (!And.IsInvalid() || !Before(Value, Flags)) return Reject("all-ones dataflow");
    if (Width < 4) {
      if (F->Op != OP_TESTNZ || uint32_t(F->Size) != Width || F->Args[0] != Value || F->Args[1] != Value) return Reject("small all-ones flags");
      Parity = Value; // raw PF may retain bits above the architectural width
    } else {
      if (F->Op != OP_SUBWITHFLAGS || uint32_t(F->Size) != Width || F->Args[0] != Value || !Constant(F->Args[1], 0, Flags)) return Reject("all-ones flags");
      Parity = Flags;
    }
  }
  if (IR.GetOp<IROp_Header>(PF)->Args[0] != Parity || !Before(Parity, PF)) return Reject("parity dataflow");
  if (NormalizeCarry) {
    if (ReadNZCV.IsInvalid() || Carry.IsInvalid() || StoreNZCV.IsInvalid() || !Before(Invalidate, ReadNZCV) || !Before(ReadNZCV, Carry) ||
        !Before(Carry, StoreNZCV) || !Before(StoreNZCV, PF) || IR.GetOp<IROp_Header>(Carry)->Args[0] != ReadNZCV ||
        !Constant(IR.GetOp<IROp_Header>(Carry)->Args[1], 0x20000000, Carry) || IR.GetOp<IROp_Header>(StoreNZCV)->Args[0] != Carry) return Reject("carry dataflow");
  } else if (!ReadNZCV.IsInvalid() || !Carry.IsInvalid() || !StoreNZCV.IsInvalid()) return Reject("unexpected carry normalization");
  const auto* X = IR.GetOp<IROp_ExitFunction>(Exit);
  if (X->Hint != BranchHint::None || !X->CallReturnAddress.IsInvalid() || !X->CallReturnBlock.IsInvalid() || !Before(X->NewRIP, Exit)) return Reject("exit metadata");
  const auto* PC = IR.GetOp<IROp_Header>(X->NewRIP); uint64_t Next;
  switch (PC->Op) {
  case OP_INLINEENTRYPOINTOFFSET: Next = EntryRIP + PC->C<IROp_InlineEntrypointOffset>()->Offset; break;
  case OP_ENTRYPOINTOFFSET: Next = EntryRIP + PC->C<IROp_EntrypointOffset>()->Offset; break;
  case OP_INLINECONSTANT: Next = PC->C<IROp_InlineConstant>()->Constant; break;
  case OP_CONSTANT: Next = PC->C<IROp_Constant>()->Constant; break;
  default: return Reject("exit PC");
  }
  if (Next != Cfg.BrokerNextRIP) return Reject("fallthrough");
  return {};
}

CompileResult Compile(const IRListView& IR, uint64_t EntryRIP, const BackendConfig& Cfg) {
  OrderedNodeWrapper BrokerAddend {};
  if (Cfg.BrokerMemory) {
    if (Cfg.BrokerTestWidth || Cfg.BrokerTestMask || Cfg.BrokerTestShift) {
      auto Test = CheckBrokerImmediateTest(IR, EntryRIP, Cfg); if (!Test.Error.empty()) return Test;
    }
    if (Cfg.RegArgs || Cfg.RegArgMask || Cfg.Relocs || !Cfg.SharedMemory || !Cfg.ThreadBaseGlobal ||
        Cfg.MemPages != broker::Pages || Cfg.MemMaxPages != broker::Pages || Cfg.CallsViaDispatcher || Cfg.FetchIR ||
        Cfg.HotThreshold || Cfg.ABILocalFlags || Cfg.ABI != BackendConfig::GuestABI::None || Cfg.FlagsDeadAt ||
        (Cfg.BrokerNoEffects && (Cfg.BrokerOperation || Cfg.BrokerWidth || Cfg.BrokerFlow))) {
      CompileResult R; R.Error = "invalid broker backend contract"; return R;
    }
    // Admission of raw scalar/flag/branch semantics and this complete IR allowlist both
    // precede execution. No unknown memory or architectural side-effect path
    // can reach a legacy direct-access emitter.
    uint32_t Reads = 0, Writes = 0, Atomics = 0, Syscalls = 0, Exits = 0, Blocks = 0, Branches = 0;
    bool SawFallthrough = false, SawTarget = false;
    OrderedNodeWrapper ReturnValue {}, JumpValue {};
    auto ConstantPC = [&](OrderedNodeWrapper W, uint64_t& Value) {
      if (W.IsInvalid()) return false;
      const auto* H = IR.GetOp<IROp_Header>(W);
      switch (H->Op) {
      case OP_INLINEENTRYPOINTOFFSET: Value = EntryRIP + H->C<IROp_InlineEntrypointOffset>()->Offset; return true;
      case OP_ENTRYPOINTOFFSET: Value = EntryRIP + H->C<IROp_EntrypointOffset>()->Offset; return true;
      case OP_INLINECONSTANT: Value = H->C<IROp_InlineConstant>()->Constant; return true;
      case OP_CONSTANT: Value = H->C<IROp_Constant>()->Constant; return true;
      default: return false;
      }
    };
    auto Reject = [](const IROp_Header* H) {
      CompileResult R; R.Error = "broker unsupported IR " + std::string(GetName(H->Op)); return R;
    };
    if (Cfg.BrokerOperation == 12 && (Cfg.BrokerWidth || Cfg.BrokerFlow != 5 || Cfg.BrokerTarget || Cfg.BrokerTargetRegister >= 16)) {
      CompileResult R; R.Error = "invalid broker register jump contract"; return R;
    }
    if (Cfg.BrokerOperation == 13 || Cfg.BrokerOperation == 14) {
      if (Cfg.BrokerWidth != 8 || Cfg.BrokerFlow || Cfg.BrokerTarget || Cfg.BrokerTargetRegister >= 16) {
        CompileResult R; R.Error = "invalid broker register stack contract"; return R;
      }
      // Prove the complete ordered dataflow, including old-RSP PUSH and the
      // POP RSP overwrite. Other POP destinations have two legal store orders.
      const bool Push = Cfg.BrokerOperation == 13;
      OrderedNodeWrapper SP {}, Value {}, Handle {}, Output {}, Effect {};
      uint32_t Loads = 0, SPStores = 0, ValueStores = 0, ExitCount = 0;
      for (auto [Block, Header] : IR.GetBlocks()) for (auto [Node, H] : IR.GetCode(Block)) {
        if (ExitCount && H->Op != OP_ENDBLOCK) return Reject(H);
        switch (H->Op) {
        case OP_IRHEADER: case OP_CODEBLOCK: case OP_BEGINBLOCK: case OP_ENDBLOCK:
        case OP_GUESTOPCODE: case OP_INLINECONSTANT: case OP_INLINEENTRYPOINTOFFSET:
        case OP_CONSTANT: case OP_ENTRYPOINTOFFSET: break;
        case OP_LOADREGISTER: {
          const auto* O = H->C<IROp_LoadRegister>();
          if (!Effect.IsInvalid() || O->Class != RegClass::GPR || uint32_t(H->Size) != 8 ||
              (O->Reg != 4 && (!Push || O->Reg != Cfg.BrokerTargetRegister))) return Reject(H);
          const auto W = IR.WrapNode(Node);
          if (O->Reg == 4) { if (!SP.IsInvalid()) return Reject(H); SP = W; }
          if (Push && O->Reg == Cfg.BrokerTargetRegister) { if (!Value.IsInvalid()) return Reject(H); Value = W; }
          Loads++; break;
        }
        case OP_PUSH: {
          const auto* O = H->C<IROp_Push>();
          if (!Push || !Effect.IsInvalid() || SP.IsInvalid() || Value.IsInvalid() || uint32_t(H->Size) != 8 ||
              uint32_t(O->ValueSize) != 8 || O->Addr != SP || O->Value != Value) return Reject(H);
          Effect = IR.WrapNode(Node); break;
        }
        case OP_RMWHANDLE:
          if (Push || SP.IsInvalid() || !Handle.IsInvalid() || !Effect.IsInvalid() || uint32_t(H->Size) != 8 || H->C<IROp_RMWHandle>()->Value != SP) return Reject(H);
          Handle = IR.WrapNode(Node); break;
        case OP_ALLOCATEGPR:
          if (Push || !Output.IsInvalid() || !Effect.IsInvalid() || uint32_t(H->Size) != 8 || H->C<IROp_AllocateGPR>()->ForPair) return Reject(H);
          Output = IR.WrapNode(Node); break;
        case OP_POP: {
          const auto* O = H->C<IROp_Pop>();
          if (Push || !Effect.IsInvalid() || Handle.IsInvalid() || Output.IsInvalid() || uint32_t(H->Size) != 8 || uint32_t(O->Size) != 8 ||
              O->InoutAddr != Handle || O->OutValue != Output) return Reject(H);
          Effect = IR.WrapNode(Node); break;
        }
        case OP_STOREREGISTER: {
          const auto R = PhysicalRegister(Node); const auto V = H->C<IROp_StoreRegister>()->Value;
          if (Effect.IsInvalid() || R.AsRegClass() != RegClass::GPRFixed || uint32_t(H->Size) != 8) return Reject(H);
          if (Push) { if (R.Reg != 4 || V != Effect || ++SPStores != 1) return Reject(H); }
          else if (R.Reg == Cfg.BrokerTargetRegister) { if (V != Output || ++ValueStores != 1) return Reject(H); }
          else if (R.Reg == 4 && Cfg.BrokerTargetRegister != 4) { if (V != Handle || ++SPStores != 1) return Reject(H); }
          else return Reject(H);
          break;
        }
        case OP_EXITFUNCTION: {
          const auto* O = H->C<IROp_ExitFunction>(); uint64_t Next;
          if (Effect.IsInvalid() || O->Hint != BranchHint::None || !O->CallReturnAddress.IsInvalid() || !O->CallReturnBlock.IsInvalid() ||
              !ConstantPC(O->NewRIP, Next) || Next != Cfg.BrokerNextRIP) return Reject(H);
          ExitCount++; break;
        }
        default: return Reject(H);
        }
      }
      if (ExitCount != 1 || Loads != (Push && Cfg.BrokerTargetRegister != 4 ? 2u : 1u) ||
          SPStores != (Push || Cfg.BrokerTargetRegister != 4) || ValueStores != !Push) {
        CompileResult R; R.Error = "broker register stack dataflow mismatch"; return R;
      }
    }
    if (Cfg.BrokerOperation == 15) {
      if ((Cfg.BrokerWidth != 4 && Cfg.BrokerWidth != 8) || Cfg.BrokerFlow || Cfg.BrokerTarget || Cfg.BrokerTargetRegister >= 16) {
        CompileResult R; R.Error = "invalid broker register memory ADD contract"; return R;
      }
      OrderedNodeWrapper Load {}, Add {}, Source {}, Store {}, AF {}, PF {}, NZCV {}, ReadNZCV {}, StoreAF {}, StorePF {}, StoreNZCV {}, Exit {};
      std::unordered_map<uint32_t, uint32_t> Order; uint32_t Position = 0;
      for (auto [Block, Header] : IR.GetBlocks()) for (auto [Node, H] : IR.GetCode(Block)) {
        const auto W = IR.WrapNode(Node); Order.emplace(IR.GetID(Node).Value, ++Position);
        if (H->Op == OP_LOADMEM || H->Op == OP_LOADMEMTSO) {
          if (!Load.IsInvalid()) return Reject(H); Load = W;
        } else if (H->Op == OP_ADDWITHFLAGS) {
          if (!Add.IsInvalid() || Load.IsInvalid() || H->Args[1] != Load) return Reject(H);
          Add = W; Source = H->Args[0];
        } else if (H->Op == OP_STOREREGISTER) {
          const auto R = PhysicalRegister(Node);
          if (!Store.IsInvalid() || R.AsRegClass() != RegClass::GPRFixed || R.Reg != Cfg.BrokerTargetRegister ||
              uint32_t(H->Size) != 8 || H->C<IROp_StoreRegister>()->Value != Add) return Reject(H);
          Store = W;
        } else if (H->Op == OP_LOADNZCV) {
          if (!ReadNZCV.IsInvalid() || uint32_t(H->Size) != 4) return Reject(H); ReadNZCV = W;
        } else if (H->Op == OP_STOREAF || H->Op == OP_STOREPF || H->Op == OP_STORENZCV) {
          auto& V = H->Op == OP_STOREAF ? AF : H->Op == OP_STOREPF ? PF : NZCV;
          auto& S = H->Op == OP_STOREAF ? StoreAF : H->Op == OP_STOREPF ? StorePF : StoreNZCV;
          if (!S.IsInvalid() || uint32_t(H->Size) != (H->Op == OP_STORENZCV ? 4u : 8u)) return Reject(H);
          V = H->Args[0]; S = W;
        } else if (H->Op == OP_EXITFUNCTION) {
          const auto* O = H->C<IROp_ExitFunction>(); uint64_t Next;
          if (!Exit.IsInvalid() || O->Hint != BranchHint::None || !O->CallReturnAddress.IsInvalid() || !O->CallReturnBlock.IsInvalid() ||
              !ConstantPC(O->NewRIP, Next) || Next != Cfg.BrokerNextRIP) return Reject(H);
          Exit = W;
        }
      }
      if (Load.IsInvalid() || Add.IsInvalid() || Source.IsInvalid() || Store.IsInvalid() || AF.IsInvalid() || PF != Add || NZCV.IsInvalid() || ReadNZCV.IsInvalid() || Exit.IsInvalid()) {
        CompileResult R; R.Error = "broker register memory ADD pattern required"; return R;
      }
      auto Before = [&](OrderedNodeWrapper A, OrderedNodeWrapper B) {
        if (A.IsInvalid() || B.IsInvalid()) return false;
        const auto X = Order.find(IR.GetID(IR.GetNode(A)).Value), Y = Order.find(IR.GetID(IR.GetNode(B)).Value);
        return X != Order.end() && Y != Order.end() && X->second < Y->second;
      };
      const auto* D = IR.GetOp<IROp_Header>(Source); const auto* Auxiliary = IR.GetOp<IROp_Header>(AF); const auto* Carry = IR.GetOp<IROp_Header>(NZCV);
      uint64_t InvertCarry;
      if (D->Op != OP_LOADREGISTER || D->C<IROp_LoadRegister>()->Class != RegClass::GPR || D->C<IROp_LoadRegister>()->Reg != Cfg.BrokerTargetRegister || uint32_t(D->Size) != 8 ||
          uint32_t(IR.GetOp<IROp_Header>(Add)->Size) != Cfg.BrokerWidth || !Before(Source, Add) || !Before(Load, Add) || !Before(Add, Store) ||
          Auxiliary->Op != OP_XOR || uint32_t(Auxiliary->Size) != 8 || Auxiliary->Args[0] != Source || Auxiliary->Args[1] != Load ||
          !Before(Source, AF) || !Before(Load, AF) || !Before(AF, StoreAF) || !Before(Add, StoreAF) || !Before(Add, StorePF) ||
          !Before(Add, ReadNZCV) || Carry->Op != OP_XOR || uint32_t(Carry->Size) != 4 || Carry->Args[0] != ReadNZCV ||
          !Before(ReadNZCV, NZCV) || !Before(NZCV, StoreNZCV) || !ConstantPC(Carry->Args[1], InvertCarry) || InvertCarry != 0x20000000 ||
          !Before(Store, Exit) || !Before(StoreAF, Exit) || !Before(StorePF, Exit) || !Before(StoreNZCV, Exit)) {
        CompileResult R; R.Error = "broker register memory ADD dataflow required"; return R;
      }
      std::function<bool(OrderedNodeWrapper, unsigned)> ReadyAddress = [&](OrderedNodeWrapper A, unsigned Depth) {
        if (A.IsInvalid()) return true;
        if (Depth > 4 || !Before(A, Load)) return false;
        const auto* H = IR.GetOp<IROp_Header>(A); if (uint32_t(H->Size) != 8) return false;
        switch (H->Op) {
        case OP_LOADREGISTER: return H->C<IROp_LoadRegister>()->Class == RegClass::GPR && H->C<IROp_LoadRegister>()->Reg < 16;
        case OP_CONSTANT: case OP_INLINECONSTANT: case OP_ENTRYPOINTOFFSET: case OP_INLINEENTRYPOINTOFFSET: return true;
        case OP_ADDSHIFT:
          if (H->C<IROp_AddShift>()->Shift != ShiftType::LSL || H->C<IROp_AddShift>()->ShiftAmount > 3) return false;
          [[fallthrough]];
        case OP_ADD: return Before(H->Args[0], A) && Before(H->Args[1], A) && ReadyAddress(H->Args[0], Depth + 1) && ReadyAddress(H->Args[1], Depth + 1);
        default: return false;
        }
      };
      const auto* L = IR.GetOp<IROp_LoadMem>(Load);
      if (L->Class != RegClass::GPR || uint32_t(L->Header.Size) != Cfg.BrokerWidth || uint32_t(L->Align) != Cfg.BrokerWidth ||
          L->OffsetType != MemOffsetType::SXTX || (L->OffsetScale != 1 && L->OffsetScale != 2 && L->OffsetScale != 4 && L->OffsetScale != 8) ||
          L->Addr.IsInvalid() || !ReadyAddress(L->Addr, 0) || !ReadyAddress(L->Offset, 0)) return Reject(&L->Header);
    }
    if (Cfg.BrokerOperation == 16) {
      if ((Cfg.BrokerWidth != 4 && Cfg.BrokerWidth != 8) || Cfg.BrokerFlow || Cfg.BrokerTarget || Cfg.BrokerTargetRegister >= 16) {
        CompileResult R; R.Error = "invalid broker OR memory contract"; return R;
      }
      // Logical flags are a separate proof: OR(old,source), invalidate AF,
      // SUB-with-flags(result,0), StorePF(result). No arithmetic AF/carry
      // normalization or other flag producer belongs to this family.
      OrderedNodeWrapper Load {}, Result {}, Flags {}, Invalidate {}, Store {}, PF {}, Exit {};
      std::unordered_map<uint32_t, uint32_t> Order; uint32_t Position = 0;
      for (auto [Block, Header] : IR.GetBlocks()) for (auto [Node, H] : IR.GetCode(Block)) {
        const auto W = IR.WrapNode(Node); Order.emplace(IR.GetID(Node).Value, ++Position);
        if (!Exit.IsInvalid() && H->Op != OP_ENDBLOCK) return Reject(H);
        if (H->Op == OP_LOADMEM || H->Op == OP_LOADMEMTSO) {
          if (!Load.IsInvalid()) return Reject(H); Load = W;
        } else if (H->Op == OP_OR) {
          if (!Result.IsInvalid() || Load.IsInvalid() || H->Args[0] != Load) return Reject(H);
          Result = W; BrokerAddend = H->Args[1];
        } else if (H->Op == OP_SUBWITHFLAGS) {
          if (!Flags.IsInvalid() || Result.IsInvalid() || H->Args[0] != Result) return Reject(H); Flags = W;
        } else if (H->Op == OP_INVALIDATEFLAGS) {
          if (!Invalidate.IsInvalid() || uint32_t(H->Size) || H->C<IROp_InvalidateFlags>()->Flags != (1u << FEXCore::X86State::RFLAG_AF_RAW_LOC)) return Reject(H);
          Invalidate = W;
        } else if (H->Op == OP_STOREMEM || H->Op == OP_STOREMEMTSO) {
          if (!Store.IsInvalid() || Result.IsInvalid() || H->C<IROp_StoreMem>()->Value != Result) return Reject(H); Store = W;
        } else if (H->Op == OP_STOREPF) {
          if (!PF.IsInvalid() || Flags.IsInvalid() || uint32_t(H->Size) != 8 || H->Args[0] != Flags) return Reject(H); PF = W;
        } else if (H->Op == OP_EXITFUNCTION) {
          const auto* O = H->C<IROp_ExitFunction>(); uint64_t Next;
          if (O->Hint != BranchHint::None || !O->CallReturnAddress.IsInvalid() || !O->CallReturnBlock.IsInvalid() ||
              !ConstantPC(O->NewRIP, Next) || Next != Cfg.BrokerNextRIP) return Reject(H); Exit = W;
        }
      }
      auto Before = [&](OrderedNodeWrapper A, OrderedNodeWrapper B) {
        if (A.IsInvalid() || B.IsInvalid()) return false;
        const auto X = Order.find(IR.GetID(IR.GetNode(A)).Value), Y = Order.find(IR.GetID(IR.GetNode(B)).Value);
        return X != Order.end() && Y != Order.end() && X->second < Y->second;
      };
      uint64_t Zero;
      if (Load.IsInvalid() || Result.IsInvalid() || Flags.IsInvalid() || Invalidate.IsInvalid() || Store.IsInvalid() || PF.IsInvalid() || Exit.IsInvalid() || BrokerAddend.IsInvalid() ||
          !Before(BrokerAddend, Load) || !Before(Load, Result) || !Before(Result, Invalidate) || !Before(Invalidate, Flags) ||
          !Before(Flags, Store) || !Before(Flags, PF) || !Before(Store, Exit) || !Before(PF, Exit) ||
          uint32_t(IR.GetOp<IROp_Header>(Result)->Size) != Cfg.BrokerWidth || uint32_t(IR.GetOp<IROp_Header>(Flags)->Size) != Cfg.BrokerWidth ||
          !Before(IR.GetOp<IROp_Header>(Flags)->Args[1], Flags) || !ConstantPC(IR.GetOp<IROp_Header>(Flags)->Args[1], Zero) || Zero) {
        CompileResult R; R.Error = "broker OR logical flag dataflow required"; return R;
      }
      const auto* Source = IR.GetOp<IROp_Header>(BrokerAddend);
      if (Source->Op != OP_LOADREGISTER || Source->C<IROp_LoadRegister>()->Class != RegClass::GPR ||
          Source->C<IROp_LoadRegister>()->Reg != Cfg.BrokerTargetRegister || uint32_t(Source->Size) != 8) return Reject(Source);
      std::function<bool(OrderedNodeWrapper, OrderedNodeWrapper, unsigned)> SameAddress = [&](OrderedNodeWrapper A, OrderedNodeWrapper B, unsigned Depth) {
        if (A == B) return true;
        if (A.IsInvalid() || B.IsInvalid() || Depth > 4) return false;
        const auto* X = IR.GetOp<IROp_Header>(A); const auto* Y = IR.GetOp<IROp_Header>(B);
        if (X->Op != Y->Op || X->Size != Y->Size) return false;
        switch (X->Op) {
        case OP_LOADREGISTER: return X->C<IROp_LoadRegister>()->Class == Y->C<IROp_LoadRegister>()->Class && X->C<IROp_LoadRegister>()->Reg == Y->C<IROp_LoadRegister>()->Reg;
        case OP_INLINECONSTANT: return X->C<IROp_InlineConstant>()->Constant == Y->C<IROp_InlineConstant>()->Constant;
        case OP_CONSTANT: return X->C<IROp_Constant>()->Constant == Y->C<IROp_Constant>()->Constant;
        case OP_ENTRYPOINTOFFSET: return X->C<IROp_EntrypointOffset>()->Offset == Y->C<IROp_EntrypointOffset>()->Offset;
        case OP_INLINEENTRYPOINTOFFSET: return X->C<IROp_InlineEntrypointOffset>()->Offset == Y->C<IROp_InlineEntrypointOffset>()->Offset;
        case OP_ADDSHIFT:
          if (X->C<IROp_AddShift>()->Shift != Y->C<IROp_AddShift>()->Shift || X->C<IROp_AddShift>()->ShiftAmount != Y->C<IROp_AddShift>()->ShiftAmount) return false;
          [[fallthrough]];
        case OP_ADD: return SameAddress(X->Args[0], Y->Args[0], Depth + 1) && SameAddress(X->Args[1], Y->Args[1], Depth + 1);
        default: return false;
        }
      };
      std::function<bool(OrderedNodeWrapper, OrderedNodeWrapper, unsigned)> ReadyAddress = [&](OrderedNodeWrapper A, OrderedNodeWrapper Effect, unsigned Depth) {
        if (A.IsInvalid()) return true;
        if (Depth > 4 || !Before(A, Effect)) return false;
        const auto* H = IR.GetOp<IROp_Header>(A); if (uint32_t(H->Size) != 8) return false;
        switch (H->Op) {
        case OP_LOADREGISTER: return H->C<IROp_LoadRegister>()->Class == RegClass::GPR && H->C<IROp_LoadRegister>()->Reg < 16;
        case OP_CONSTANT: case OP_INLINECONSTANT: case OP_ENTRYPOINTOFFSET: case OP_INLINEENTRYPOINTOFFSET: return true;
        case OP_ADDSHIFT:
          if (H->C<IROp_AddShift>()->Shift != ShiftType::LSL || H->C<IROp_AddShift>()->ShiftAmount > 3) return false;
          [[fallthrough]];
        case OP_ADD: return Before(H->Args[0], A) && Before(H->Args[1], A) && ReadyAddress(H->Args[0], Effect, Depth + 1) && ReadyAddress(H->Args[1], Effect, Depth + 1);
        default: return false;
        }
      };
      const auto* L = IR.GetOp<IROp_LoadMem>(Load); const auto* W = IR.GetOp<IROp_StoreMem>(Store);
      if (L->Class != RegClass::GPR || W->Class != RegClass::GPR || uint32_t(L->Header.Size) != Cfg.BrokerWidth || uint32_t(W->Header.Size) != Cfg.BrokerWidth ||
          uint32_t(L->Align) != Cfg.BrokerWidth || W->Align != L->Align || L->OffsetType != MemOffsetType::SXTX || W->OffsetType != L->OffsetType ||
          (L->OffsetScale != 1 && L->OffsetScale != 2 && L->OffsetScale != 4 && L->OffsetScale != 8) || W->OffsetScale != L->OffsetScale ||
          L->Addr.IsInvalid() || !ReadyAddress(L->Addr, Load, 0) || !ReadyAddress(L->Offset, Load, 0) ||
          !ReadyAddress(W->Addr, Store, 0) || !ReadyAddress(W->Offset, Store, 0) ||
          !SameAddress(L->Addr, W->Addr, 0) || !SameAddress(L->Offset, W->Offset, 0)) return Reject(&W->Header);
    }
    if (Cfg.BrokerOperation == 11) {
      // Fuse only a proven single load + ADD-with-flags + same-address store.
      // FEX may regenerate equivalent SIB/RIP-relative address SSA nodes.
      OrderedNodeWrapper Load {}, Add {}, Store {}, AF {}, PF {}, NZCV {}, LoadNZCV {}, StoreAF {}, StorePF {}, StoreNZCV {}, Exit {};
      std::vector<OrderedNodeWrapper> AvailableRegisters;
      std::unordered_map<uint32_t, uint32_t> Order; uint32_t Position = 0;
      for (auto [Block, Header] : IR.GetBlocks()) for (auto [Node, H] : IR.GetCode(Block)) {
        Order.emplace(IR.GetID(Node).Value, ++Position);
        if (H->Op == OP_LOADREGISTER && Load.IsInvalid()) AvailableRegisters.push_back(IR.WrapNode(Node));
        if (H->Op == OP_LOADMEM || H->Op == OP_LOADMEMTSO) {
          if (!Load.IsInvalid()) return Reject(H);
          Load = IR.WrapNode(Node);
        } else if (H->Op == OP_ADDWITHFLAGS) {
          if (Load.IsInvalid() || !Add.IsInvalid() || H->Args[0] != Load ||
              std::find(AvailableRegisters.begin(), AvailableRegisters.end(), H->Args[1]) == AvailableRegisters.end()) return Reject(H);
          Add = IR.WrapNode(Node); BrokerAddend = H->Args[1];
        } else if (H->Op == OP_STOREMEM || H->Op == OP_STOREMEMTSO) {
          if (Add.IsInvalid() || !Store.IsInvalid() || H->C<IROp_StoreMem>()->Value != Add) return Reject(H);
          Store = IR.WrapNode(Node);
        } else if (H->Op == OP_LOADNZCV) {
          if (!LoadNZCV.IsInvalid() || Add.IsInvalid() || uint32_t(H->Size) != 4) return Reject(H);
          LoadNZCV = IR.WrapNode(Node);
        } else if (H->Op == OP_STOREAF || H->Op == OP_STOREPF || H->Op == OP_STORENZCV) {
          auto& Value = H->Op == OP_STOREAF ? AF : H->Op == OP_STOREPF ? PF : NZCV;
          if (!Value.IsInvalid()) return Reject(H);
          Value = H->Args[0];
          auto& Write = H->Op == OP_STOREAF ? StoreAF : H->Op == OP_STOREPF ? StorePF : StoreNZCV;
          Write = IR.WrapNode(Node);
          if (uint32_t(H->Size) != (H->Op == OP_STORENZCV ? 4u : 8u)) return Reject(H);
        } else if (H->Op == OP_EXITFUNCTION) {
          if (!Exit.IsInvalid()) return Reject(H);
          Exit = IR.WrapNode(Node);
        }
      }
      if (Load.IsInvalid() || Add.IsInvalid() || Store.IsInvalid() || AF.IsInvalid() || PF != Add || NZCV.IsInvalid() || Cfg.BrokerFlow || (Cfg.BrokerWidth != 4 && Cfg.BrokerWidth != 8)) {
        CompileResult R; R.Error = "broker ADD memory pattern required"; return R;
      }
      const auto* Auxiliary = IR.GetOp<IROp_Header>(AF); const auto* Carry = IR.GetOp<IROp_Header>(NZCV);
      auto Before = [&](OrderedNodeWrapper A, OrderedNodeWrapper B) {
        if (A.IsInvalid() || B.IsInvalid()) return false;
        const auto X = Order.find(IR.GetID(IR.GetNode(A)).Value), Y = Order.find(IR.GetID(IR.GetNode(B)).Value);
        return X != Order.end() && Y != Order.end() && X->second < Y->second;
      };
      uint64_t InvertCarry;
      if (Auxiliary->Op != OP_XOR || uint32_t(Auxiliary->Size) != 8 || Auxiliary->Args[0] != Load || Auxiliary->Args[1] != BrokerAddend ||
          Carry->Op != OP_XOR || uint32_t(Carry->Size) != 4 || Carry->Args[0] != LoadNZCV ||
          !Before(Load, AF) || !Before(AF, StoreAF) || !Before(Add, StoreAF) || !Before(Add, StorePF) || !Before(Add, LoadNZCV) ||
          !Before(LoadNZCV, NZCV) || !Before(NZCV, StoreNZCV) ||
          !Before(Store, Exit) || !Before(StoreAF, Exit) || !Before(StorePF, Exit) || !Before(StoreNZCV, Exit) ||
          !ConstantPC(Carry->Args[1], InvertCarry) || InvertCarry != 0x20000000) {
        CompileResult R; R.Error = "broker ADD flag pattern required"; return R;
      }
      std::function<bool(OrderedNodeWrapper, OrderedNodeWrapper, unsigned)> SameAddress = [&](OrderedNodeWrapper A, OrderedNodeWrapper B, unsigned Depth) {
        if (A == B) return true;
        if (A.IsInvalid() || B.IsInvalid() || Depth > 4) return false;
        const auto* X = IR.GetOp<IROp_Header>(A); const auto* Y = IR.GetOp<IROp_Header>(B);
        if (X->Op != Y->Op || X->Size != Y->Size) return false;
        switch (X->Op) {
        case OP_LOADREGISTER: return X->C<IROp_LoadRegister>()->Class == Y->C<IROp_LoadRegister>()->Class && X->C<IROp_LoadRegister>()->Reg == Y->C<IROp_LoadRegister>()->Reg;
        case OP_INLINECONSTANT: return X->C<IROp_InlineConstant>()->Constant == Y->C<IROp_InlineConstant>()->Constant;
        case OP_CONSTANT: return X->C<IROp_Constant>()->Constant == Y->C<IROp_Constant>()->Constant;
        case OP_ENTRYPOINTOFFSET: return X->C<IROp_EntrypointOffset>()->Offset == Y->C<IROp_EntrypointOffset>()->Offset;
        case OP_INLINEENTRYPOINTOFFSET: return X->C<IROp_InlineEntrypointOffset>()->Offset == Y->C<IROp_InlineEntrypointOffset>()->Offset;
        case OP_ADDSHIFT:
          if (X->C<IROp_AddShift>()->Shift != Y->C<IROp_AddShift>()->Shift || X->C<IROp_AddShift>()->ShiftAmount != Y->C<IROp_AddShift>()->ShiftAmount) return false;
          [[fallthrough]];
        case OP_ADD: return SameAddress(X->Args[0], Y->Args[0], Depth + 1) && SameAddress(X->Args[1], Y->Args[1], Depth + 1);
        default: return false;
        }
      };
      const auto* L = IR.GetOp<IROp_LoadMem>(Load); const auto* W = IR.GetOp<IROp_StoreMem>(Store);
      const auto* Source = IR.GetOp<IROp_LoadRegister>(BrokerAddend);
      std::function<bool(OrderedNodeWrapper, unsigned)> ReadyAddress = [&](OrderedNodeWrapper A, unsigned Depth) {
        if (A.IsInvalid()) return true; // absent displacement
        if (Depth > 4 || !Before(A, Load)) return false;
        const auto* H = IR.GetOp<IROp_Header>(A);
        if (uint32_t(H->Size) != 8) return false;
        switch (H->Op) {
        case OP_LOADREGISTER: case OP_CONSTANT: case OP_INLINECONSTANT:
        case OP_ENTRYPOINTOFFSET: case OP_INLINEENTRYPOINTOFFSET: return true;
        case OP_ADD: case OP_ADDSHIFT: return Before(H->Args[0], A) && Before(H->Args[1], A) && ReadyAddress(H->Args[0], Depth + 1) && ReadyAddress(H->Args[1], Depth + 1);
        default: return false;
        }
      };
      if (L->Class != RegClass::GPR || W->Class != RegClass::GPR || Source->Class != RegClass::GPR || Source->Reg >= 16 ||
          uint32_t(Source->Header.Size) != 8 || uint32_t(L->Header.Size) != Cfg.BrokerWidth || uint32_t(W->Header.Size) != Cfg.BrokerWidth ||
          uint32_t(IR.GetOp<IROp_Header>(Add)->Size) != Cfg.BrokerWidth || L->Align != W->Align || L->OffsetType != W->OffsetType || L->OffsetScale != W->OffsetScale ||
          L->Addr.IsInvalid() || !ReadyAddress(L->Addr, 0) || !ReadyAddress(L->Offset, 0) ||
          !SameAddress(L->Addr, W->Addr, 0) || !SameAddress(L->Offset, W->Offset, 0)) return Reject(&W->Header);
    }
    for (auto [Block, Header] : IR.GetBlocks()) { Blocks++; for (auto [Node, H] : IR.GetCode(Block)) {
      if (Cfg.BrokerOperation == 12) {
        switch (H->Op) {
        case OP_IRHEADER: case OP_CODEBLOCK: case OP_BEGINBLOCK: case OP_ENDBLOCK:
        case OP_GUESTOPCODE: case OP_LOADREGISTER: case OP_EXITFUNCTION: break;
        default: return Reject(H);
        }
      }
      // A NOP must have no architectural effects, including otherwise-allowed
      // register/flag operations or address arithmetic. Validate FEX's actual
      // IR instead of synthesizing a module from the raw NOP bytes.
      if (Cfg.BrokerNoEffects) {
        switch (H->Op) {
        case OP_IRHEADER: case OP_CODEBLOCK: case OP_BEGINBLOCK: case OP_ENDBLOCK:
        case OP_GUESTOPCODE: case OP_INLINECONSTANT: case OP_INLINEENTRYPOINTOFFSET:
        case OP_CONSTANT: case OP_ENTRYPOINTOFFSET: case OP_EXITFUNCTION: break;
        default: return Reject(H);
        }
      }
      if (Cfg.BrokerOperation == 15) {
        switch (H->Op) {
        case OP_IRHEADER: case OP_CODEBLOCK: case OP_BEGINBLOCK: case OP_ENDBLOCK:
        case OP_GUESTOPCODE: case OP_INLINECONSTANT: case OP_INLINEENTRYPOINTOFFSET:
        case OP_CONSTANT: case OP_ENTRYPOINTOFFSET: case OP_LOADREGISTER:
        case OP_ADD: case OP_ADDSHIFT: case OP_XOR: case OP_ADDWITHFLAGS:
        case OP_LOADMEM: case OP_LOADMEMTSO: case OP_STOREREGISTER:
        case OP_LOADNZCV: case OP_STORENZCV: case OP_STOREAF: case OP_STOREPF:
        case OP_EXITFUNCTION: break;
        default: return Reject(H);
        }
      }
      if (Cfg.BrokerOperation == 16) {
        switch (H->Op) {
        case OP_IRHEADER: case OP_CODEBLOCK: case OP_BEGINBLOCK: case OP_ENDBLOCK:
        case OP_GUESTOPCODE: case OP_INLINECONSTANT: case OP_INLINEENTRYPOINTOFFSET:
        case OP_CONSTANT: case OP_ENTRYPOINTOFFSET: case OP_LOADREGISTER:
        case OP_ADD: case OP_ADDSHIFT: case OP_OR: case OP_SUBWITHFLAGS:
        case OP_INVALIDATEFLAGS: case OP_STOREPF:
        case OP_LOADMEM: case OP_LOADMEMTSO: case OP_STOREMEM: case OP_STOREMEMTSO:
        case OP_EXITFUNCTION: break;
        default: return Reject(H);
        }
      }
      if (Cfg.BrokerOperation == 11) {
        switch (H->Op) {
        case OP_IRHEADER: case OP_CODEBLOCK: case OP_BEGINBLOCK: case OP_ENDBLOCK:
        case OP_GUESTOPCODE: case OP_INLINECONSTANT: case OP_INLINEENTRYPOINTOFFSET:
        case OP_CONSTANT: case OP_ENTRYPOINTOFFSET: case OP_LOADREGISTER:
        case OP_ADD: case OP_ADDSHIFT: case OP_XOR: case OP_ADDWITHFLAGS:
        case OP_LOADMEM: case OP_LOADMEMTSO: case OP_STOREMEM: case OP_STOREMEMTSO:
        case OP_LOADNZCV: case OP_STORENZCV: case OP_STOREAF: case OP_STOREPF:
        case OP_EXITFUNCTION: break;
        default: return Reject(H);
        }
      }
      switch (H->Op) {
      case OP_IRHEADER: case OP_CODEBLOCK: case OP_BEGINBLOCK: case OP_ENDBLOCK:
      case OP_GUESTOPCODE: case OP_INLINECONSTANT: case OP_INLINEENTRYPOINTOFFSET:
      case OP_CONSTANT: case OP_ENTRYPOINTOFFSET:
      case OP_ADD: case OP_SUB: case OP_AND: case OP_OR: case OP_XOR: case OP_NOT:
      case OP_LSHL: case OP_LSHR: case OP_ASHR: case OP_ADDSHIFT:
      case OP_BFE: case OP_SBFE: case OP_BFI: case OP_ORLSHL: break;
      case OP_ALLOCATEGPR: case OP_RMWHANDLE:
        if ((Cfg.BrokerOperation != 10 && Cfg.BrokerOperation != 14) || uint32_t(H->Size) != 8) return Reject(H);
        break;
      case OP_PUSH: {
        const auto* O = H->C<IROp_Push>(); uint64_t Value;
        if ((Cfg.BrokerOperation != 9 && Cfg.BrokerOperation != 13) || uint32_t(H->Size) != 8 || uint32_t(O->ValueSize) != 8 ||
            (Cfg.BrokerOperation == 9 && (!ConstantPC(O->Value, Value) || Value != Cfg.BrokerNextRIP))) return Reject(H);
        Writes++; break;
      }
      case OP_POP: {
        const auto* O = H->C<IROp_Pop>();
        if ((Cfg.BrokerOperation != 10 && Cfg.BrokerOperation != 14) || uint32_t(H->Size) != 8) return Reject(H);
        ReturnValue = O->OutValue; Reads++; break;
      }
      case OP_LOADPF: case OP_LOADAF: case OP_STOREPF: case OP_STOREAF:
      case OP_LOADNZCV: case OP_STORENZCV: case OP_SUBWITHFLAGS: case OP_ADDWITHFLAGS:
      case OP_NZCVSELECT: case OP_LOADDF:
        if (Cfg.BrokerOperation == 16 && (H->Op == OP_STOREPF || H->Op == OP_SUBWITHFLAGS)) break;
        if ((Cfg.BrokerOperation == 11 || Cfg.BrokerOperation == 15) && (H->Op == OP_STOREPF || H->Op == OP_STOREAF || H->Op == OP_LOADNZCV || H->Op == OP_STORENZCV || H->Op == OP_ADDWITHFLAGS)) break;
        if (Cfg.BrokerOperation < 3 || Cfg.BrokerOperation >= 9) return Reject(H);
        break;
      case OP_INVALIDATEFLAGS:
        if ((Cfg.BrokerOperation != 6 && Cfg.BrokerOperation != 8 && Cfg.BrokerOperation != 16) || H->C<IROp_InvalidateFlags>()->Flags != (1u << FEXCore::X86State::RFLAG_AF_RAW_LOC)) return Reject(H);
        break;
      case OP_SHIFTFLAGS: {
        const auto* O = H->C<IROp_ShiftFlags>();
        if (Cfg.BrokerOperation != 6 || uint32_t(H->Size) != 8 || (uint32_t(O->Size) != 4 && uint32_t(O->Size) != 8) ||
            (O->Shift != ShiftType::LSL && O->Shift != ShiftType::LSR && O->Shift != ShiftType::ASR)) return Reject(H);
        break;
      }
      case OP_ANDWITHFLAGS: case OP_SUBNZCV: case OP_TESTNZ:
        if ((Cfg.BrokerOperation != 6 && Cfg.BrokerOperation != 8) || (uint32_t(H->Size) != 1 && uint32_t(H->Size) != 2 && uint32_t(H->Size) != 4 && uint32_t(H->Size) != 8)) return Reject(H);
        break;
      case OP_PARITY: case OP_ORNROR: case OP_ORLSHR: case OP_ANDSHIFT: case OP_ROR: case OP_EXTR:
        if (Cfg.BrokerOperation < 5 || Cfg.BrokerOperation >= 9) return Reject(H);
        break;
      case OP_LOADREGISTER: {
        auto O = H->C<IROp_LoadRegister>();
        if (Cfg.BrokerOperation == 12) {
          if (!JumpValue.IsInvalid() || O->Class != RegClass::GPR || O->Reg != Cfg.BrokerTargetRegister || uint32_t(H->Size) != 8) return Reject(H);
          JumpValue = IR.WrapNode(Node);
        }
        if (O->Class != RegClass::GPR || O->Reg >= (Cfg.BrokerOperation >= 3 ? NUM_STATIC : 16) ||
            ((Cfg.BrokerOperation == 9 || Cfg.BrokerOperation == 10) && (O->Reg != 4 || uint32_t(H->Size) != 8)) ||
            ((Cfg.BrokerOperation == 11 || Cfg.BrokerOperation == 15 || Cfg.BrokerOperation == 16) && (O->Reg >= 16 || uint32_t(H->Size) != 8))) return Reject(H);
        break;
      }
      case OP_STOREREGISTER: {
        auto R = PhysicalRegister(Node);
        if (Cfg.BrokerOperation == 11 || Cfg.BrokerOperation == 16 || R.AsRegClass() != RegClass::GPRFixed || R.Reg >= (Cfg.BrokerOperation >= 3 ? NUM_STATIC : 16) ||
            (Cfg.BrokerOperation >= 9 && Cfg.BrokerOperation != 13 && Cfg.BrokerOperation != 14 && Cfg.BrokerOperation != 15 && (R.Reg != 4 || uint32_t(H->Size) != 8))) return Reject(H);
        break;
      }
      case OP_LOADCONTEXT: {
        auto O = H->C<IROp_LoadContext>();
        if (O->Class != RegClass::GPR ||
            !((uint32_t(H->Size) == 8 && (O->Offset == offsetof(CPUState, fs_cached) || O->Offset == offsetof(CPUState, gs_cached))) ||
              (Cfg.BrokerOperation == 5 && (O->Offset == offsetof(CPUState, rip) ||
                (O->Offset >= offsetof(CPUState, flags) && O->Offset + uint32_t(H->Size) <= offsetof(CPUState, flags) + sizeof(CPUState::flags))))))
          return Reject(H);
        break;
      }
      case OP_STORECONTEXT: {
        auto O = H->C<IROp_StoreContext>();
        if (Cfg.BrokerOperation != 5 || O->Class != RegClass::GPR || O->Offset != offsetof(CPUState, rip) || uint32_t(H->Size) != 8)
          return Reject(H);
        break;
      }
      case OP_CAS: case OP_ATOMICFETCHADD:
        if (Cfg.BrokerOperation != (H->Op == OP_CAS ? 3u : 4u) || uint32_t(H->Size) != Cfg.BrokerWidth) return Reject(H);
        Atomics++; break;
      case OP_SYSCALL:
        if (Cfg.BrokerOperation != 5) return Reject(H);
        Syscalls++; break;
      case OP_CONDJUMP: {
        auto O = H->C<IROp_CondJump>();
        if (Cfg.BrokerFlow != 2 || Cfg.BrokerOperation != 7 ||
            (O->Cond != CondClass::EQ && O->Cond != CondClass::NEQ && O->Cond != CondClass::ULT && O->Cond != CondClass::UGE && O->Cond != CondClass::UGT && O->Cond != CondClass::ULE && O->Cond != CondClass::MI && O->Cond != CondClass::PL)) return Reject(H);
        if (!O->FromNZCV) {
          const auto* C = IR.GetOp<IROp_Header>(O->Cmp2);
          if (!((C->Op == OP_INLINECONSTANT && C->C<IROp_InlineConstant>()->Constant == 0) ||
                (C->Op == OP_CONSTANT && C->C<IROp_Constant>()->Constant == 0))) return Reject(H);
        }
        Branches++; break;
      }
      case OP_LOADMEM: case OP_LOADMEMTSO:
        if (H->C<IROp_LoadMem>()->Class != RegClass::GPR || (Cfg.BrokerOperation != 1 && Cfg.BrokerOperation != 8 && Cfg.BrokerOperation != 11 && Cfg.BrokerOperation != 15 && Cfg.BrokerOperation != 16) || uint32_t(H->Size) != Cfg.BrokerWidth)
          return Reject(H);
        Reads++; break;
      case OP_STOREMEM: case OP_STOREMEMTSO:
        if (H->C<IROp_StoreMem>()->Class != RegClass::GPR || (Cfg.BrokerOperation != 2 && Cfg.BrokerOperation != 11 && Cfg.BrokerOperation != 16) || uint32_t(H->Size) != Cfg.BrokerWidth)
          return Reject(H);
        Writes++; break;
      case OP_EXITFUNCTION: {
        auto O = H->C<IROp_ExitFunction>();
        if (Cfg.BrokerOperation == 12) {
          if (JumpValue.IsInvalid() || O->NewRIP != JumpValue || O->Hint != BranchHint::None ||
              !O->CallReturnAddress.IsInvalid() || !O->CallReturnBlock.IsInvalid()) return Reject(H);
          SawTarget = true; Exits++; break;
        }
        if (Cfg.BrokerOperation == 10) {
          if (Cfg.BrokerFlow != 4 || O->Hint != BranchHint::Return || ReturnValue.IsInvalid() || O->NewRIP != ReturnValue)
            return Reject(H);
          SawTarget = true; Exits++; break;
        }
        if (Cfg.BrokerOperation == 9) {
          if (Cfg.BrokerFlow != 3 || (O->Hint != BranchHint::Call &&
              !(Cfg.BrokerTarget == Cfg.BrokerNextRIP && O->Hint == BranchHint::None))) return Reject(H);
        } else if (O->Hint == BranchHint::Call || O->Hint == BranchHint::Return) return Reject(H);
        const auto* Target = IR.GetOp<IROp_Header>(O->NewRIP);
        if (Cfg.BrokerOperation == 5 && Target->Op == OP_LOADCONTEXT &&
            Target->C<IROp_LoadContext>()->Offset == offsetof(CPUState, rip)) { Exits++; break; }
        uint64_t Next;
        switch (Target->Op) {
        case OP_INLINEENTRYPOINTOFFSET: Next = EntryRIP + Target->C<IROp_InlineEntrypointOffset>()->Offset; break;
        case OP_ENTRYPOINTOFFSET: Next = EntryRIP + Target->C<IROp_EntrypointOffset>()->Offset; break;
        case OP_INLINECONSTANT: Next = Target->C<IROp_InlineConstant>()->Constant; break;
        case OP_CONSTANT: Next = Target->C<IROp_Constant>()->Constant; break;
        default: return Reject(H);
        }
        const bool Fallthrough = Next == Cfg.BrokerNextRIP && Cfg.BrokerFlow != 1 && Cfg.BrokerFlow != 3;
        const bool TargetMatch = Cfg.BrokerFlow && Next == Cfg.BrokerTarget;
        if (!Fallthrough && !TargetMatch) return Reject(H);
        SawFallthrough |= Fallthrough; SawTarget |= TargetMatch;
        Exits++; break;
      }
      default: return Reject(H);
      }
    }}
    if (Blocks != (Cfg.BrokerFlow == 2 ? 3u : 1u) || Exits != (Cfg.BrokerFlow == 2 ? 2u : 1u) ||
        Branches != (Cfg.BrokerFlow == 2) || (Cfg.BrokerFlow && !SawTarget) ||
        (Cfg.BrokerFlow == 2 && !SawFallthrough) || Reads != (Cfg.BrokerOperation == 1 || Cfg.BrokerOperation == 8 || Cfg.BrokerOperation == 10 || Cfg.BrokerOperation == 11 || Cfg.BrokerOperation == 14 || Cfg.BrokerOperation == 15 || Cfg.BrokerOperation == 16) || Writes != (Cfg.BrokerOperation == 2 || Cfg.BrokerOperation == 9 || Cfg.BrokerOperation == 11 || Cfg.BrokerOperation == 13 || Cfg.BrokerOperation == 16) ||
        Atomics != (Cfg.BrokerOperation == 3 || Cfg.BrokerOperation == 4) || Syscalls != (Cfg.BrokerOperation == 5)) {
      CompileResult R; R.Error = "broker instruction effect count mismatch"; return R;
    }
  }
  SharedState S;
  S.RelocOn = Cfg.Relocs;
  BackendConfig UCfg = Cfg; // units: most stay cold, so they inline only small callees
  UCfg.InlineMaxNodes = std::min(Cfg.InlineMaxNodes, Cfg.UnitInlineMaxNodes);
  Emitter E(IR, EntryRIP, UCfg, S);
  E.BrokerAddend = BrokerAddend;
  return E.Run();
}

// The units of a region candidate (first = entry) that its entry can reach
// through jumps (a direct one to its target, an indirect one to where it was
// seen going, minus pure return points when the unit also returns). Returns
// always leave a region, so return points would be dead weight.
static bool UnitReturns(const IRListView& IR) {
  for (auto [BlockNode, BlockHeader] : IR.GetBlocks()) {
    for (auto [CodeNode, IROp] : IR.GetCode(BlockNode)) {
      if (IROp->Op == OP_EXITFUNCTION && IROp->C<IROp_ExitFunction>()->Hint == BranchHint::Return) {
        return true;
      }
    }
  }
  return false;
}
static std::vector<uint64_t> RegionReachable(const std::vector<uint64_t>& RIPs, const BackendConfig& Cfg) {
  if (!Cfg.ReturnAddrs || ENV_FLAG("FEXWASM_REGION_KEEPALL")) {
    return RIPs;
  }
  std::vector<bool> Seen(RIPs.size());
  std::vector<size_t> Work {0};
  Seen[0] = true;
  auto Visit = [&](uint64_t T) {
    auto It = std::find(RIPs.begin(), RIPs.end(), T);
    if (It != RIPs.end() && !Seen[It - RIPs.begin()]) {
      Seen[It - RIPs.begin()] = true;
      Work.push_back(size_t(It - RIPs.begin()));
    }
  };
  while (!Work.empty()) {
    const size_t U = Work.back();
    Work.pop_back();
    const IRListView* IR = Cfg.FetchIR(RIPs[U]);
    if (!IR) {
      continue;
    }
    for (auto [BlockNode, BlockHeader] : IR->GetBlocks()) {
      for (auto [CodeNode, IROp] : IR->GetCode(BlockNode)) {
        if (IROp->Op != OP_EXITFUNCTION) {
          continue;
        }
        auto Op = IROp->C<IROp_ExitFunction>();
        // Calls don't pull the callee in: a region is one guest function's
        // units, and a call to another function inside it would re-enter the
        // whole (big) region function.
        if (Op->Hint == BranchHint::Return || (Op->Hint == BranchHint::Call && !ENV_FLAG("FEXWASM_REGION_CALLS"))) {
          continue;
        }
        auto* H = IR->GetOp<IROp_Header>(Op->NewRIP);
        uint64_t T;
        if (H->Op == OP_INLINECONSTANT) {
          T = H->C<IROp_InlineConstant>()->Constant;
        } else if (H->Op == OP_CONSTANT) {
          T = H->C<IROp_Constant>()->Constant;
        } else if (H->Op == OP_INLINEENTRYPOINTOFFSET) {
          T = RIPs[U] + H->C<IROp_InlineEntrypointOffset>()->Offset;
        } else if (H->Op == OP_ENTRYPOINTOFFSET) {
          T = RIPs[U] + H->C<IROp_EntrypointOffset>()->Offset;
        } else { // indirect: where it was seen going, unless that may be a return
          const std::vector<uint64_t> Seen = Cfg.Successors ? Cfg.Successors(RIPs[U]) : RIPs;
          const bool Returns = UnitReturns(*IR);
          for (uint64_t R : Seen) {
            if (!Returns || !Cfg.ReturnAddrs->count(R)) {
              Visit(R);
            }
          }
          if (!Returns) {
            // The profile only saw the runs the dispatcher made; a jump table
            // stays in its function, so candidates close by count as targets
            // too (except code after a call that ends its unit).
            for (uint64_t R : RIPs) {
              const uint64_t Dist = R > RIPs[U] ? R - RIPs[U] : RIPs[U] - R;
              if (Dist < 0x1000 && !(Cfg.ExitReturnAddrs && Cfg.ExitReturnAddrs->count(R))) {
                Visit(R);
              }
            }
          }
          continue;
        }
        Visit(T);
      }
    }
  }
  std::vector<uint64_t> Out;
  for (size_t I = 0; I < RIPs.size(); I++) {
    if (Seen[I]) {
      Out.push_back(RIPs[I]);
    }
  }
  return Out;
}

bool Emitter::RunRegionStructured(std::vector<std::unique_ptr<Emitter>>& Units, CompileResult* Out) {
  const uint32_t K = uint32_t(Units.size());
  std::vector<uint64_t> RIPs;
  for (auto& U : Units) {
    RIPs.push_back(U->Entry);
  }
  auto IndexOf = [&](uint64_t T) -> int {
    auto It = std::find(RIPs.begin(), RIPs.end(), T);
    return It == RIPs.end() ? -1 : int(It - RIPs.begin());
  };
  // The units' CFG from their exits: direct jumps to region units, and for
  // indirect jumps the region units they were seen (or are likely) to reach.
  auto G = std::make_unique<RegionGraph>();
  G->Succ.assign(K, {});
  std::vector<std::vector<uint32_t>> Indirect(K);
  std::vector<uint8_t> ForceMerge(K, 0);
  for (uint32_t X = 0; X < K; X++) {
    const IRListView& IR = Units[X]->IR;
    const bool Returns = UnitReturns(IR);
    for (auto [BlockNode, BlockHeader] : IR.GetBlocks()) {
      for (auto [CodeNode, IROp] : IR.GetCode(BlockNode)) {
        if (IROp->Op != OP_EXITFUNCTION) {
          continue;
        }
        auto Op = IROp->C<IROp_ExitFunction>();
        if (Op->Hint == BranchHint::Return || Op->Hint == BranchHint::Call) {
          continue;
        }
        uint64_t T;
        if (Units[X]->ConstRIP(Op->NewRIP, &T)) {
          if (const int Y = IndexOf(T); Y >= 0) {
            G->Succ[X].push_back(uint32_t(Y));
          }
          continue;
        }
        if (!Indirect[X].empty()) {
          continue; // one target set per unit
        }
        const std::vector<uint64_t> Seen = Cfg.Successors ? Cfg.Successors(RIPs[X]) : std::vector<uint64_t> {};
        for (uint32_t Y = 0; Y < K; Y++) {
          const bool WasSeen = std::find(Seen.begin(), Seen.end(), RIPs[Y]) != Seen.end();
          const uint64_t Dist = RIPs[Y] > RIPs[X] ? RIPs[Y] - RIPs[X] : RIPs[X] - RIPs[Y];
          const bool Ret = Cfg.ReturnAddrs && Cfg.ReturnAddrs->count(RIPs[Y]);
          const bool ExitRet = Cfg.ExitReturnAddrs && Cfg.ExitReturnAddrs->count(RIPs[Y]);
          if ((WasSeen && (!Returns || !Ret)) || (!Returns && Dist < 0x1000 && !ExitRet)) {
            Indirect[X].push_back(Y);
          }
        }
        std::sort(Indirect[X].begin(), Indirect[X].end(), [&](uint32_t A, uint32_t Bb) { return RIPs[A] < RIPs[Bb]; });
        for (uint32_t Y : Indirect[X]) {
          G->Succ[X].push_back(Y);
          ForceMerge[Y] = 1;
        }
      }
    }
  }
  if (!G->Analyze(ForceMerge)) {
    return false;
  }
  const uint32_t RegionOwnerId = S.NextOwner++;
  S.FunctionEntry = Units[0]->Entry;
  S.IsRegion = true;
  uint64_t Mask = 0;
  for (uint32_t X = 0; X < K; X++) {
    auto& U = Units[X];
    U->RegionOwner = RegionOwnerId;
    U->RegionIndex = X;
    S.InlineStack = {U->Entry};
    U->Analyze();
    for (uint64_t W : U->BlockWrites) {
      Mask |= W;
    }
  }
  (void)Mask;
  // What each unit may find written on entry: from its region predecessors
  // (the entry unit starts clean).
  std::vector<uint64_t> AllW(K, 0), MWIn(K, 0);
  for (uint32_t X = 0; X < K; X++) {
    for (uint64_t W : Units[X]->BlockWrites) {
      AllW[X] |= W;
    }
  }
  for (bool Changed = true; Changed;) {
    Changed = false;
    for (uint32_t X = 0; X < K; X++) {
      for (uint32_t Y : G->Succ[X]) {
        const uint64_t In = MWIn[Y] | MWIn[X] | AllW[X];
        if (In != MWIn[Y]) {
          MWIn[Y] = In;
          Changed = true;
        }
      }
    }
  }
  for (uint32_t X = 0; X < K; X++) {
    Units[X]->InheritedMask = MWIn[X];
    S.RUnits.push_back(Units[X].get());
  }
  S.RIndirect = std::move(Indirect);
  S.RG = G.get();
  // Liveness across the units: each unit's entry needs what its jumps into
  // other units need, to a fixpoint.
  std::vector<uint64_t> EntryLive(K, 0);
  for (bool Changed = true; Changed;) {
    Changed = false;
    for (uint32_t X = 0; X < K; X++) {
      const uint64_t In = Units[X]->ComputeLiveness(&EntryLive) ? Units[X]->LiveIn[0] : ~0ull;
      if (In != EntryLive[X]) {
        EntryLive[X] = In;
        Changed = true;
      }
    }
  }
  AllocSharedLocals();
  EntryPrologue();
  RDoTree(0);
  if (!Err.empty()) {
    Out->Error = Err;
    S.RG = nullptr;
    return true;
  }
  B.u8(op::unreachable);
  B.u8(op::end); // function
  *Out = Finish();
  S.RG = nullptr;
  return true;
}

CompileResult CompileRegion(const std::vector<uint64_t>& RIPs, const BackendConfig& Cfg) {
  CompileResult Out;
  if (RIPs.empty() || !Cfg.FetchIR) {
    Out.Error = "empty region";
    return Out;
  }
  // Big functions stay in JSC's baseline tier (and take long to optimise), so
  // a region over the size budget is retried with its first half of units.
  BackendConfig RCfg = Cfg;
  RCfg.InlineMaxNodes = std::min(Cfg.InlineMaxNodes, Cfg.RegionInlineMaxNodes);
  const std::vector<uint64_t> Kept = RegionReachable(RIPs, Cfg);
  for (size_t N = Kept.size(); N >= 1; N = (N + 1) / 2) {
    const std::vector<uint64_t> Sub(Kept.begin(), Kept.begin() + N);
    SharedState S;
    std::vector<std::unique_ptr<Emitter>> Units;
    for (uint64_t RIP : Sub) {
      const IRListView* IR = RCfg.FetchIR(RIP);
      if (!IR) {
        Out.Error = "no IR for region unit";
        return Out;
      }
      Units.push_back(std::make_unique<Emitter>(*IR, RIP, RCfg, S));
      Units.back()->RegionRIPs = &Sub;
    }
    if (ENV_FLAG("FEXWASM_REGION_LOOP") || !Units[0]->RunRegionStructured(Units, &Out)) {
      if (ENV_FLAG("FEXWASM_REGION_LOG")) {
        fprintf(stderr, "[region] %#llx: %zu units as a br_table loop\n", (unsigned long long)Sub[0], Sub.size());
      }
      Out = Units[0]->RunRegion(Units);
    }
    Out.RegionUnits = uint32_t(N);
    Out.RegionRIPs = Sub;
    if (!Out.Error.empty() || Out.Module.size() <= Cfg.RegionMaxBytes || N == 1) {
      return Out;
    }
  }
  return Out;
}

} // namespace fexwasm
