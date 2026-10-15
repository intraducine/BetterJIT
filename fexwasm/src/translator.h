// The translator an app embeds: FEX's frontend and the wasm backend behind a
// small C API, set up like tools/fexrun.cpp. The page's runtime (js/runtime.js
// in async mode) asks it for units and regions as the guest runs; the app
// serves those requests (WasmProbe: its 127.0.0.1 HTTP server).
//
// Not thread-safe: call it from one thread (or serialize).
#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct fexwasm_translator fexwasm_translator;

// Bytes owned by the translator, valid until the next call on it.
typedef struct {
  const uint8_t* data;
  size_t size;
} fexwasm_bytes;

// A translator for the guest image `image` (size bytes) at guest address
// `base` (its 4 GB window holds the guest; wasm addresses are the low 32
// bits). `options`: space-separated key=value, all optional:
//   abi=sysv|win64|none   guest calling convention (default sysv)
//   tso=0|3               x86 memory ordering (default 0)
//   tb=<hex>              thread base: modules import it as e.tb (threads)
//   shared=1              import the memory as shared (threads)
//   hot=<n>               region hot threshold (default 100, 0 = no regions)
//   instmeta=1            retain guest instruction markers independently of memtrace
//   maxinst=1             diagnostic single-instruction units; no regions, inlining,
//                         register arguments or ABI state pruning. Still direct
//                         guest memory and the legacy i32 RIP result ABI.
//   guestmem=direct|broker1  broker1 requires Linux, uses only fexwasm_step,
//                         immutable private code and admitted MOV/NOP steps,
//                         aligned 32/64-bit locked CAS/XADD and spilled futex
//                         syscall boundaries; no legacy dispatcher or regions
//   x87=80|64             x87 in 80-bit soft float, or on doubles (FEX's reduced precision)
//   depth=<n>             guest calls nested as wasm calls before they go through the dispatcher (256)
//   cache=<dir>           keep translated units in files there, for later runs (and share
//                         them between processes in any case)
//   linux=1               one Linux process: no image (image may be null;
//                         code comes from fexwasm_map_code), guest addresses
//                         below 4 GB, threads (tb, shared, memory of up to
//                         4 GB), and syscalls that leave the whole guest
//                         state in CPUState (BackendConfig::SyscallFullState);
//                         and abi=none x87=64 depth=64 unless given
fexwasm_translator* fexwasm_create(const uint8_t* image, size_t size, uint64_t base, const char* options);
void fexwasm_destroy(fexwasm_translator* T);

// Guest code as the process maps it executable, replacing what was mapped
// there, and its removal (munmap, or no longer executable). Translations
// made from the old bytes are forgotten here; the page drops its own.
void fexwasm_map_code(fexwasm_translator* T, uint64_t addr, const uint8_t* bytes, size_t size);
// ...with how to translate it: abi 1, compiled code that keeps the Win64
// calling convention (registers and flags as the ABI has them at calls and
// returns: a game's own code, DXMT's), 0 the translator's defaults (Wine's
// unix side and hand-written thunks: abi=none, flags live).
void fexwasm_map_code_abi(fexwasm_translator* T, uint64_t addr, const uint8_t* bytes, size_t size, uint32_t abi);
void fexwasm_unmap_code(fexwasm_translator* T, uint64_t addr, uint64_t size);
// New bytes for code already mapped, written in place (a packer's, a JIT's).
void fexwasm_patch_code(fexwasm_translator* T, uint64_t addr, const uint8_t* bytes, size_t size);

// The runtime settings the page needs (memory layout, dispatcher tables), JSON.
const char* fexwasm_config_json(fexwasm_translator* T);
// The dispatcher module, and a default CPUState to start guest threads from.
fexwasm_bytes fexwasm_dispatcher(fexwasm_translator* T);
fexwasm_bytes fexwasm_state(fexwasm_translator* T);

// The unit at a guest RIP (low 32 bits): u32 table slot, then the module.
// Every thread installs a unit at the same slot, so the modules' call inline
// caches agree. size 0 if FEX can't translate it.
fexwasm_bytes fexwasm_unit(fexwasm_translator* T, uint32_t rip32);

// Experimental broker1: full u64 RIP; 80-byte little-endian BJS1 header then
// Wasm. Header: magic, memory/checkpoint/step/coverage versions, typed status,
// operation, width (u32 each); RIP/next RIP/module hash (u64); module bytes,
// instruction length (u32); original instruction bytes padded to 16 bytes.
// Unsupported results have status 2, no module and no executable fallback.
fexwasm_bytes fexwasm_step(fexwasm_translator* T, uint64_t rip);

// A region, with the dispatcher's profile from the page (all little-endian
// u32): n, n RIPs (the first is the entry); m, m x (RIP, k, k successors);
// c, c x (return address, k, k call targets). The module, or size 0.
fexwasm_bytes fexwasm_region(fexwasm_translator* T, const uint8_t* request, size_t size);

// Totals so far, JSON: units, regions, milliseconds in FEX and the backend.
const char* fexwasm_stats_json(fexwasm_translator* T);

#ifdef __cplusplus
}
#endif
