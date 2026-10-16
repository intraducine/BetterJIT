// FEX IR -> WebAssembly backend.
#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <unordered_set>
#include <vector>

namespace FEXCore::IR {
class IRListView;
}

namespace fexwasm {

struct BackendConfig {
  // Wasm linear-memory address of the guest FEXCore::Core::CPUState.
  uint32_t CtxAddr = 0x10000;
  // Wasm address of the saved guest NZCV word (arm64 layout: N=31 Z=30 C=29 V=28).
  uint32_t NZCVAddr = 0x10000 - 16;
  // Lazy flag state carried between units: u32 kind at +0, u64 operands at +8
  // and +16. Kind 0 means NZCVAddr holds the flags; otherwise they are derived
  // from the operands (see MaterializeFlags).
  uint32_t FlagSpillAddr = 0x10000 - 64;
  // Minimum pages the imported memory must have, and (shared memory) its
  // declared maximum (0: MemPages).
  uint32_t MemPages = 1;
  uint32_t MemMaxPages = 0;
  // Experimental broker step. Guest accesses never use direct Wasm offsets;
  // run() returns a typed status and writes the full next RIP to CPUState.
  bool BrokerMemory = false;
  bool BrokerNoEffects = false; // raw NOP admission requires marker/constant-exit IR only
  uint32_t BrokerOperation = 0, BrokerWidth = 0;
  uint64_t BrokerNextRIP = 0;
  uint64_t BrokerTarget = 0;
  uint32_t BrokerFlow = 0; // fallthrough/jump/conditional/direct-call/checked-return
  // FEX's named vector constant pool (NAMED_VECTOR_CONST_POOL_MAX x 16 bytes)
  // and indexed constant tables, as FEX's CPUBackend installs them; folded into
  // v128.const at compile time.
  const uint8_t* NamedConstants = nullptr;
  const uint64_t* IndexedConstantPointers = nullptr;
  // Guest RIP -> function-table index hash (open addressing, 64-byte entries
  // of {u32 rip, u32 index, u32 count, u32 0, u32 successors[12]}; rip 0 =
  // empty) used by the wasm dispatcher. It counts each unit's runs and, until
  // the unit is hot, records the RIPs it exits to; at HotThreshold runs it
  // stores the RIP at HotAddr and returns it (see js/runtime.js regions).
  uint32_t DispatchBase = 0x20000;
  uint32_t DispatchBits = 14;
  uint32_t HotAddr = 0x78;
  uint32_t ZeroAddr = 0x7C; // a u32 that is always 0 (see SharedState::SysBase)
  // Threads: the per-thread state (CPUState, dispatcher tables, the Sys area)
  // sits at an offset each thread passes in as the imported i32 global e.tb;
  // every Sys address above is relative to it. Modules are shared between
  // threads, instances are per thread. Off: the base is 0 (ZeroAddr).
  bool ThreadBaseGlobal = false;
  // Threads share the guest memory: import it as shared (maximum MemPages).
  bool SharedMemory = false;
  // u32: the stop RIP of the innermost running dispatch (a guest call waiting
  // for its return address). Regions never jump internally to it.
  uint32_t StopAddr = 0x58;
  // u32 (async runtimes; 0: off): a dispatch that misses sets it to 1 and
  // calls e.hot(rip), which installs the unit while the wasm stack waits
  // (JSPI) and sets it to 2, so the dispatch goes on with the callers' frames
  // intact; else (0) the dispatch returns the RIP, unwinding them, and each
  // of their return addresses becomes a unit of its own (the rest of that
  // function, translated again).
  uint32_t MissAddr = 0;
  // The running dispatches of a thread (0: off), so that a guest return to
  // any of their stops, not just the innermost's, gets there: a guest that
  // switches stacks (Wine's user mode callbacks, NtCallbackReturn; C++
  // exceptions, RtlRestoreContext) goes on nested in dispatches whose calls
  // it left, which then pile up to MaxCallDepth. At ShadowBase: u32 count,
  // u16 filter[256] at +0x100 (per hash of a stop, how many wait for it),
  // entries {u32 stop, u32 rsp} at +0x400. A unit stores the stack pointer
  // its call's return comes back with at StopRSPAddr before it dispatches.
  uint32_t ShadowBase = 0;
  uint32_t StopRSPAddr = 0x64;
  static constexpr uint32_t ShadowMax = 512;
  // Profiling (0: off): u32, the entry RIP of the unit running, stored at its
  // entry and again when a call returns into it (a sampler reads it).
  uint32_t ProfAddr = 0;
  uint32_t HotThreshold = 0; // 0: no profiling
  // Guest calls become wasm calls into the dispatcher (import e.dispatch) that
  // run the callee until it returns to the call's return address; the caller
  // then continues in its own unit. DepthAddr holds the nesting depth; past
  // MaxCallDepth calls fall back to exiting the unit.
  bool CallsViaDispatcher = true;
  // The first RegArgs guest GPRs (RAX, RCX, RDX, RBX, RSP, RBP, RSI, RDI in
  // FEX order) travel as wasm values: run(g0..) -> (rip, g0..), and the
  // dispatcher threads them from unit to unit; the rest of the state is in
  // CPUState. The dispatcher's enter(rip, stop) loads and stores them for JS.
  // 0: all state in memory, run() -> rip (needed for the JS dispatcher).
  uint32_t RegArgs = 8;
  // Which GPRs those are, as a bit mask (bit n = GPR n, FEX order), when not
  // the first RegArgs. JSC passes 8 wasm arguments in registers, so 7 GPRs
  // plus the depth parameter keep a guest call off the stack.
  uint32_t RegArgMask = 0;
  // The GPR in each register-argument position.
  std::vector<uint32_t> RegArgList() const {
    std::vector<uint32_t> L;
    for (uint32_t R = 0; R < 16; R++) {
      if (RegArgMask ? (RegArgMask >> R & 1) : R < RegArgs) {
        L.push_back(R);
      }
    }
    return L;
  }
  // Treat the flags as dead across guest calls and returns, as the x86-64
  // calling conventions (SysV, Windows) say: the lazy flag state isn't
  // spilled at calls, returns and call exits, nor reloaded after a call.
  // Only hand-written code that passes flags through call/ret breaks.
  bool ABILocalFlags = false;
  // Guest calling convention for register liveness at calls and returns.
  // With one, a function's entry loads, a call's reloads and a return's
  // stores only cover what that convention says can be read: arguments and
  // callee-saved registers at a call, results and callee-saved registers at
  // a return. None: every register is live at every call and return.
  enum class GuestABI : uint8_t { None, SysV, Win64 };
  GuestABI ABI = GuestABI::None;
  // Optional: every call's return address the backend has compiled (it adds
  // them). A region leaves out units that are only return points: returns
  // always leave a region, so nothing inside could branch to them.
  std::unordered_set<uint64_t>* ReturnAddrs = nullptr;
  // The subset whose call ends its unit (no return block), so the code after
  // it runs as its own unit, entered from the dispatcher.
  std::unordered_set<uint64_t>* ExitReturnAddrs = nullptr;
  // Optional: what a compile adds to the three sets above and below, as
  // (0 ReturnAddrs | 1 ExitReturnAddrs | 2 CallTargetSet, value), so a cached
  // translation can replay it. (Kind | LEARNED_ABS: the value is an absolute
  // constant of the code, not an address relative to it; see Relocs.)
  std::vector<std::pair<uint8_t, uint64_t>>* Learned = nullptr;
  // Constant call targets seen so far (function entries): with ABILocalFlags
  // a unit or region starting at one doesn't load the flags.
  std::unordered_set<uint64_t>* CallTargetSet = nullptr;
  // Call inline cache: a call to a RIP that already has a table slot (the
  // dispatcher entry's index; TableSlot returns 0 if none) calls that slot
  // with call_indirect directly when SlotTagBase[slot] (u32, kept by the
  // runtime) still holds the RIP, and takes the dispatcher otherwise. The
  // units then import the table as e.tbl.
  std::function<uint32_t(uint64_t)> TableSlot;
  uint32_t SlotTagBase = 0;
  uint32_t SlotTagCount = 0;
  // Relocatable units: what a unit takes from its code's address (RIPs, the
  // call inline caches' slots) comes from imports, so that one module runs
  // the same code mapped at other addresses (see CompileResult::ICTargets).
  bool Relocs = false;
  // Units (not regions) count their entries at UnitCounterBase + 4 * hash(RIP)
  // (1 << UnitCounterBits u32s) and call e.hot(rip) at HotThreshold. 0: off.
  uint32_t UnitCounterBase = 0;
  uint32_t UnitCounterBits = 14;
  uint32_t DepthAddr = 0x60;
  uint32_t MaxCallDepth = 256;
  // Break (hlt, int3, ud2, ...): the fault {u8 signal, u8 trapno, u8 si_code,
  // u8 0, u16 error code} is written at FaultAddr and run() returns BreakRIP.
  uint32_t FaultAddr = 0x68;
  uint32_t BreakRIP = 4;
  // u32 x86 rounding control (RC | FTZ << 2) as SetRoundingMode writes it;
  // conversions that use the "host" rounding mode read it.
  uint32_t RoundModeAddr = 0x70;
  // CPUID results: CPUIDCount entries of {u32 function, leaf, eax, ebx, ecx,
  // edx}; leaf 0xFFFFFFFF matches any leaf. Unknown functions return zeros.
  uint32_t CPUIDAddr = 0;
  uint32_t CPUIDCount = 0;
  uint64_t XCR0 = 0x7; // xgetbv(0): x87 | SSE | AVX
  // 256-entry CRC32C table, written by the dispatcher module's data segment.
  uint32_t CRCTableAddr = 0x8000;
  // Inlining of guest calls with a constant target: FetchIR returns the IR of
  // the unit at a RIP (valid until Compile returns) or null.
  std::function<const FEXCore::IR::IRListView*(uint64_t)> FetchIR;
  // Targets observed at the indirect call site with this return address (the
  // dispatcher records them at CallSiteBase), for speculative inlining.
  std::function<std::vector<uint64_t>(uint64_t)> CallTargets;
  // RIPs the unit at a RIP was seen exiting to (the dispatcher's profile at
  // DispatchBase), for region forming.
  std::function<std::vector<uint64_t>(uint64_t)> Successors;
  // Optional: the unit at a RIP reads no flag before writing it, so a jump
  // there needn't spill the lazy flag state (FexHost::FlagsDeadAtEntry).
  std::function<bool(uint64_t)> FlagsDeadAt;
  // Call-site table: 1 << CallSiteBits 32-byte entries of {u32 return
  // address, u32 calling unit, u32 calls, u32 0, u32 targets[4]}, filled by
  // the dispatcher when profiling. Units store their entry RIP at CallerAddr
  // before each guest call; a call site that reaches CallHotThreshold calls
  // makes its calling unit hot (HotAddr), so it gets recompiled with the
  // targets inlined.
  uint32_t CallSiteBase = 0x12'0000;
  uint32_t CallSiteBits = 12;
  uint32_t CallerAddr = 0x74;
  uint32_t CallHotThreshold = 1000;
  // Linux processes: a syscall leaves the whole guest state in CPUState for
  // e.syscall (clone copies it, signal frames save it). A syscall that
  // returns must leave the registers alone; to change them or the RIP
  // (rt_sigreturn, execve, signal delivery) e.syscall throws to the run
  // loop, which restarts from CPUState.
  bool SyscallFullState = false;
  // Debugging: the dispatcher stores each RIP it dispatches in CPUState.rip.
  bool TrackRIP = false;
  // Opt-in diagnostic area in each thread's Sys block: u64 full address,
  // guest RIP, (IR opcode << 32 | width), FS base, GS base, linear address.
  // Zero disables tracing; this does not change guest address semantics.
  uint32_t MemoryTraceAddr = 0;
  // x86 memory ordering for FEX's LoadMemTSO / StoreMemTSO (FEX leaves
  // stack accesses plain): 0 none, 1 a fence after each load and before each
  // store, 3 loads + fence and stores as seq-cst atomic stores (JSC: swpal).
  uint32_t TSOMode = 0;
  uint32_t InlineDepth = 2;
  uint32_t InlineMaxNodes = 600; // callee size limit, in IR nodes
  // Regions: wasm size budget, and a tighter callee limit inside them.
  uint32_t RegionMaxBytes = 48 * 1024;
  uint32_t RegionInlineMaxNodes = 600;
  // Units (the first tier, mostly cold code): a tighter callee limit.
  uint32_t UnitInlineMaxNodes = 60;
};

constexpr uint8_t LEARNED_ABS = 0x80;

struct CompileResult {
  // Imports e.mem and e.dispatch; exports "run": () -> i32 (low 32 bits of the next guest RIP).
  std::vector<uint8_t> Module;
  std::string Error;           // non-empty when an IR op is not supported yet
  uint32_t Blocks = 0;
  uint32_t RegionUnits = 0;    // CompileRegion: how many of the RIPs it kept
  std::vector<uint64_t> RegionRIPs; // and which (the first is the entry)
  // Compile: RIPs the unit's code can go to by a constant jump or call, or
  // come back to after a call (for translating a program ahead of time).
  std::vector<uint64_t> StaticSuccessors;
  // Constants in the guest window (the entry's upper 32 bits): addresses the
  // code takes, such as function pointers.
  std::vector<uint64_t> AddressConstants;
  // With BackendConfig::Relocs, the module imports e.d (i64: how far the
  // code has moved from where it was compiled for) and a global e.s<i> per
  // call inline cache: the table slot of ICTargets[i] (a RIP; relative to
  // the code, or absolute) moved by e.d. Relocatable: it may run moved (else
  // e.d must be 0).
  std::vector<std::pair<uint64_t, bool>> ICTargets;
  bool Relocatable = false;
};

// Guest addresses live in one 4 GB-aligned window; their low 32 bits are the
// wasm address, so address arithmetic stays in i64 and is wrapped at the access.
CompileResult Compile(const FEXCore::IR::IRListView& IR, uint64_t EntryRIP, const BackendConfig& Cfg);

// A region: the units at RIPs (entered at RIPs[0]) compiled into one function
// whose jumps between them are internal branches. Needs Cfg.FetchIR.
CompileResult CompileRegion(const std::vector<uint64_t>& RIPs, const BackendConfig& Cfg);

// Arm64-layout NZCV for a spilled lazy flag state (for hosts that need the bits).
uint32_t MaterializeFlags(uint32_t Kind, uint64_t A, uint64_t B, uint32_t NZCV);

// The dispatcher module: imports e.mem and e.tbl (funcref table of unit run()
// functions) and exports dispatch(rip, stop) -> rip. It runs units until
// `stop`, or returns a RIP that has no translation yet.
// Its data segments install the CRC32C table and CPUIDTable (the CPUIDAddr
// entries, see BackendConfig) when it is instantiated.
std::vector<uint8_t> BuildDispatcher(const BackendConfig& Cfg, const std::vector<uint8_t>& CPUIDTable = {});

} // namespace fexwasm
