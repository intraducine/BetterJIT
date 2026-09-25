// Local coalescing for the wasm functions the backend emits: locals of one
// type that are never live at the same time share an index. The backend
// gives most IR values a local of their own, so big units come out with
// thousands; JavaScriptCore's baseline tier gives each local a stack slot,
// and its workers have little stack (about 170 KB for wasm frames), so a
// few nested guest calls through such units overflow it.
#pragma once
#include <cstdint>
#include <vector>

namespace fexwasm {

struct CoalesceStats {
  uint64_t Before = 0, After = 0;
};

// Body: the function's instructions (after the locals header). Types: the
// value types of the locals after the NumParams parameters. Rewrites both;
// false (and nothing changed) if the body uses something the pass doesn't
// decode.
bool CoalesceLocals(std::vector<uint8_t>& Body, uint32_t NumParams, std::vector<uint8_t>& Types, CoalesceStats* Stats = nullptr);

} // namespace fexwasm
