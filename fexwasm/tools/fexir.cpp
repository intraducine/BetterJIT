// fexir: print FEX's IR for guest code (frontend + opcode dispatcher + passes,
// no arm64 JIT), and optionally the size of the wasm the backend makes of it.
//
//   fexir <raw-x86-64.bin> <load-address-hex> [entry-hex ...]
#include "backend.h"
#include "fexhost.h"

#include <FEXCore/fextl/sstream.h>

#include "Interface/IR/IR.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>

int main(int argc, char** argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <raw.bin> <load-addr-hex> [entry-hex ...]\n", argv[0]);
    return 1;
  }
  std::ifstream F(argv[1], std::ios::binary);
  std::stringstream S;
  S << F.rdbuf();
  std::string Code = S.str();
  const uint64_t Load = strtoull(argv[2], nullptr, 16);

  fexwasm::FexHost::Options HO;
  HO.TSO = getenv("FEXWASM_TSO") != nullptr;
  fexwasm::FexHost Host(HO);
  if (!Host.MapGuest(Load, Code.data(), Code.size())) {
    return 1;
  }
  fexwasm::BackendConfig Cfg;
  for (int i = 3; i < argc || i == 3; i++) {
    const uint64_t RIP = i < argc ? strtoull(argv[i], nullptr, 16) : Load;
    uint64_t Insts = 0;
    auto* IR = Host.GenerateIR(RIP, &Insts);
    if (!IR) {
      printf("; 0x%llx: no IR\n", (unsigned long long)RIP);
    } else {
      fextl::stringstream Out;
      FEXCore::IR::Dump(&Out, IR);
      auto W = fexwasm::Compile(*IR, RIP, Cfg);
      printf("; ---- unit 0x%llx: %llu x86 instructions -> %s\n%s\n", (unsigned long long)RIP, (unsigned long long)Insts,
             W.Error.empty() ? (std::to_string(W.Module.size()) + " bytes of wasm, " + std::to_string(W.Blocks) + " blocks").c_str()
                             : W.Error.c_str(),
             Out.str().c_str());
      Host.Release();
    }
    if (i >= argc) {
      break;
    }
  }
  return 0;
}
