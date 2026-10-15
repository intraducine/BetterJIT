// SPDX-License-Identifier: GPL-3.0-or-later
// First broker profile: explicit x86 instruction admission, not an IR-node guess.
#pragma once
#include <cstddef>
#include <cstdint>

namespace fexwasm::broker {
constexpr uint32_t MemoryABI = 1, CheckpointABI = 1, StepABI = 3, Coverage = 5;
constexpr uint32_t Pages = 33, ThreadBase = 0x10000, Scratch = 0x1f0000;
constexpr uint32_t StepMagic = 0x31534a42, HeaderBytes = 96;
struct Admission {
  bool Supported = false;
  uint32_t Operation = 0, Width = 0; // 0 register-only, 1 read, 2 write
  uint32_t Flow = 0; // 0 fallthrough, 1 direct jump, 2 conditional jump
};
// FEX supplies/validates the complete instruction length separately. This only
// admits an explicit semantic family; unsupported prefixes/opcodes never run.
inline Admission Admit(const uint8_t* Bytes, size_t Size) {
  if (!Bytes || !Size) return {};
  // Exact ENDBR64 encoding only: this profile does not enable/advertise CET,
  // so FEX decodes its legacy no-op semantics. Keep all other REP encodings
  // outside admission and retain the complete IR-effect check below decode.
  if (Size >= 4 && Bytes[0] == 0xf3 && Bytes[1] == 0x0f && Bytes[2] == 0x1e && Bytes[3] == 0xfa)
    return {true, 0, 0};
  size_t I = 0;
  bool Word = false, Segment = false, Lock = false;
  while (I < Size && (Bytes[I] == 0x66 || Bytes[I] == 0x64 || Bytes[I] == 0x65 || Bytes[I] == 0xf0)) {
    if (Bytes[I] == 0x66) {
      if (Word) return {};
      Word = true;
    } else if (Bytes[I] == 0xf0) {
      if (Lock) return {};
      Lock = true;
    } else {
      if (Segment) return {};
      Segment = true;
    }
    I++;
  }
  uint8_t Rex = 0;
  if (I < Size && Bytes[I] >= 0x40 && Bytes[I] <= 0x4f) Rex = Bytes[I++];
  if (I >= Size) return {};
  const uint8_t Op = Bytes[I++];
  if (I == 1 && (Op == 0xeb || Op == 0xe9)) return {true, 7, 0, 1};
  if (I == 1 && ((Op >= 0x72 && Op <= 0x77) ||
      (Op == 0x0f && I < Size && (Bytes[I] >= 0x82 && Bytes[I] <= 0x87)))) return {true, 7, 0, 2};
  const uint32_t Width = Rex & 8 ? 8 : Word ? 2 : 4;
  if (!Word && !Segment && !Lock) {
    // Flag-producing arithmetic stays register-only. CMP/TEST may perform one
    // read; that distinct effect family can never reach a direct memory path.
    if ((Op == 0x8d) && I < Size && (Bytes[I] & 0xc0) != 0xc0) return {true, 0, 0};
    if (Op == 0x3c || Op == 0x3d || Op == 0xa8 || Op == 0xa9) return {true, 6, 0};
    if (I < Size) {
      const bool Register = (Bytes[I] & 0xc0) == 0xc0;
      if (Op == 0x84 || Op == 0x85 || Op == 0x38 || Op == 0x39 || Op == 0x3a || Op == 0x3b)
        return {true, Register ? 6u : 8u, Register ? 0u : ((Op & 1) ? Width : 1u)};
      if ((Op == 0x80 || Op == 0x81 || Op == 0x83) && (Bytes[I] & 0x38) == 0x38)
        return {true, Register ? 6u : 8u, Register ? 0u : (Op == 0x80 ? 1u : Width)};
      if (Register && ((Op == 0x01 || Op == 0x03 || Op == 0x29 || Op == 0x2b || Op == 0x31 || Op == 0x33 || Op == 0x21 || Op == 0x23 || Op == 0x09 || Op == 0x0b) ||
          ((Op == 0x81 || Op == 0x83) && ((Bytes[I] >> 3 & 7) == 0 || (Bytes[I] >> 3 & 7) == 5)))) return {true, 6, 0};
      if (Op == 0x0f && Bytes[I] >= 0x42 && Bytes[I] <= 0x47 && I + 1 < Size && (Bytes[I+1] & 0xc0) == 0xc0)
        return {true, 6, 0}; // unsigned/equality CMOV, 32/64-bit GPRs only
    }
  }
  if (Lock && Op != 0x0f) return {};
  if (Op == 0x90 && I == 1) return {true, 0, 0}; // plain NOP only
  if (Op >= 0xb0 && Op <= 0xbf) return {true, 0, 0}; // MOV register, immediate
  bool Write = false, Extension = false;
  uint32_t AccessWidth = Width;
  switch (Op) {
  case 0x88: Write = true; AccessWidth = 1; break;
  case 0x89: Write = true; break;
  case 0x8a: AccessWidth = 1; break;
  case 0x8b: break;
  case 0xc6: Write = Extension = true; AccessWidth = 1; break;
  case 0xc7: Write = Extension = true; break;
  case 0x63:
    if (!(Rex & 8)) return {};
    AccessWidth = 4;
    break;
  case 0x0f:
    if (I >= Size) return {};
    {const auto Second = Bytes[I++];
    if (Lock) {
      if ((Second != 0xb1 && Second != 0xc1) || I >= Size || (Bytes[I] & 0xc0) == 0xc0 || Width == 2) return {};
      return {true, Second == 0xb1 ? 3u : 4u, Width};
    }
    if (Second == 0x05 && I == 2) return {true, 5, 0};
    switch (Second) {
    case 0xb6: case 0xbe: AccessWidth = 1; break;
    case 0xb7: case 0xbf: AccessWidth = 2; break;
    default: return {};
    }
    }
    break;
  default: return {};
  }
  if (I >= Size || (Extension && (Bytes[I] & 0x38))) return {};
  if ((Bytes[I] & 0xc0) == 0xc0) return {true, 0, 0};
  return {true, Write ? 2u : 1u, AccessWidth};
}
} // namespace fexwasm::broker
