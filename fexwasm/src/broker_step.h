// SPDX-License-Identifier: GPL-3.0-or-later
// First broker profile: explicit x86 instruction admission, not an IR-node guess.
#pragma once
#include <cstddef>
#include <cstdint>

namespace fexwasm::broker {
constexpr uint32_t MemoryABI = 1, CheckpointABI = 1, StepABI = 4, Coverage = 22;
constexpr uint32_t Pages = 33, ThreadBase = 0x10000, Scratch = 0x1f0000;
constexpr uint32_t StepMagic = 0x31534a42, HeaderBytes = 96;
struct Admission {
  bool Supported = false;
  uint32_t Operation = 0, Width = 0; // 0 register-only, 1 read, 2 write
  uint32_t Flow = 0; // 0 fallthrough, 1 jump, 2 conditional, 3 direct call, 4 checked return, 5 register jump
  bool NoEffects = false; // NOP: only instruction markers and constant fallthrough IR
  uint32_t Length = 0; // independently decoded bounded length, checked against FEX
  uint32_t Register = 16; // selected GPR for a bounded jump, stack, ADD destination or TEST source
  uint32_t TestWidth = 0, TestShift = 0; // internal immediate-TEST proof, no wire operation change
  uint64_t TestMask = 0;
  uint32_t SetCondition = 16, SetShift = 0; // register SETcc proof; 16 means absent
  uint32_t BitWidth = 0, BitRegister = 16, BitIndex = 0; // BT; register 16 selects imm8
};
// Bounded architectural NOP encodings. Legacy prefixes may repeat, followed
// by at most one REX. REP/LOCK and a REX before a legacy prefix are excluded.
// ModRM/SIB/displacement bytes describe encoding length, never a memory read.
inline Admission AdmitNOP(const uint8_t* Bytes, size_t Size) {
  if (!Bytes || !Size) return {};
  if (Size > 15) Size = 15;
  size_t I = 0;
  while (I < Size) {
    const uint8_t B = Bytes[I];
    if (B != 0x66 && B != 0x67 && B != 0x26 && B != 0x2e &&
        B != 0x36 && B != 0x3e && B != 0x64 && B != 0x65) break;
    I++;
  }
  uint8_t Rex = 0;
  if (I < Size && Bytes[I] >= 0x40 && Bytes[I] <= 0x4f) Rex = Bytes[I++];
  if (I >= Size) return {};
  if (Bytes[I] == 0x90) {
    // REX.B changes XCHG (E/R)AX,(E/R)AX into a genuine exchange with R8.
    if (Rex & 1) return {};
    return {true, 0, 0, 0, true, uint32_t(I + 1)};
  }
  if (I + 2 >= Size || Bytes[I++] != 0x0f || Bytes[I++] != 0x1f) return {};
  const uint8_t ModRM = Bytes[I++], Mod = ModRM >> 6, RM = ModRM & 7;
  if (ModRM & 0x38) return {}; // 0F 1F /0 only; no reserved opcode extensions
  size_t Displacement = Mod == 1 ? 1 : Mod == 2 ? 4 : 0;
  if (Mod != 3 && RM == 4) {
    if (I >= Size) return {};
    if ((Bytes[I++] & 7) == 5 && Mod == 0) Displacement = 4;
  } else if (Mod == 0 && RM == 5) Displacement = 4;
  if (Displacement > Size - I) return {};
  return {true, 0, 0, 0, true, uint32_t(I + Displacement)};
}
// FEX supplies/validates the complete instruction length separately. This only
// admits an explicit semantic family; unsupported prefixes/opcodes never run.
inline Admission Admit(const uint8_t* Bytes, size_t Size) {
  if (!Bytes || !Size) return {};
  const auto NOP = AdmitNOP(Bytes, Size);
  if (NOP.Supported) return NOP;
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
  if (!Segment && !Lock && Op == 0x0f && I + 1 < Size && Bytes[I] >= 0x90 && Bytes[I] <= 0x9f && (Bytes[I + 1] & 0xc0) == 0xc0) {
    // SETcc ignores operand size, REX.W/R/X and ModRM.reg. Any REX selects
    // low bytes instead of AH..BH; REX.B extends that low-byte register.
    const uint32_t Low = Bytes[I + 1] & 7;
    Admission A {true, 6, 0, 0, false, uint32_t(I + 2), !Rex && Low >= 4 ? Low - 4 : Low + ((Rex & 1) ? 8 : 0)};
    A.SetCondition = Bytes[I] & 15; A.SetShift = !Rex && Low >= 4 ? 8 : 0; return A;
  }
  if (!Word && !Segment && !Lock && Op >= 0x50 && Op <= 0x5f)
    return {true, Op < 0x58 ? 13u : 14u, 8, 0, false, uint32_t(I), uint32_t((Op & 7) + ((Rex & 1) ? 8 : 0))};
  // Accumulator sign extension: CBW/CWDE/CDQE and CWD/CDQ/CQO. Optional
  // operand-size and REX prefixes select width; REX.W takes precedence.
  // FEX's SBFE/BFI lowering must still pass the register-only effect check.
  if (!Segment && !Lock && (Op == 0x98 || Op == 0x99)) return {true, 0, 0};
  if (I == 1 && Op == 0xe8) return {true, 9, 8, 3};
  if (I == 1 && Op == 0xc3) return {true, 10, 8, 4};
  if (I == 1 && (Op == 0xeb || Op == 0xe9)) return {true, 7, 0, 1};
  if (I == 1 && ((Op >= 0x72 && Op <= 0x79) ||
      (Op == 0x0f && I < Size && (Bytes[I] >= 0x82 && Bytes[I] <= 0x89)))) return {true, 7, 0, 2};
  const uint32_t Width = Rex & 8 ? 8 : Word ? 2 : 4;
  if (!Segment && !Lock && Op == 0x0f && I + 1 < Size && (Bytes[I] == 0xa3 || Bytes[I] == 0xba)) {
    // BT only: the base is a register and the bit index is a register or
    // imm8 modulo the operand width. BTS/BTR/BTC and memory stay excluded.
    const bool Immediate = Bytes[I++] == 0xba;
    const uint8_t M = Bytes[I++];
    if ((M & 0xc0) != 0xc0 || (Immediate && (M & 0x38) != 0x20) || (Immediate && I >= Size)) return {};
    Admission A {true, 6, 0, 0, false, uint32_t(I + Immediate), uint32_t((M & 7) + ((Rex & 1) ? 8 : 0))};
    A.BitWidth = Width;
    if (Immediate) A.BitIndex = Bytes[I] & (Width * 8 - 1);
    else A.BitRegister = (M >> 3 & 7) + ((Rex & 4) ? 8 : 0);
    return A;
  }
  if (!Segment && !Lock && (Op == 0xd0 || Op == 0xd1 || Op == 0xd2 || Op == 0xd3 || Op == 0xc0 || Op == 0xc1)) {
    // Register SHL/SHR/SAR at all scalar widths, count one/CL/imm8 only.
    // Byte opcodes ignore operand size; any REX replaces AH..BH with low
    // bytes, and REX.B extends that low-byte register. /6 remains excluded.
    if (I >= Size || (Bytes[I] & 0xc0) != 0xc0) return {};
    const uint32_t Group = Bytes[I] >> 3 & 7, Low = Bytes[I] & 7;
    if (Group != 4 && Group != 5 && Group != 7) return {};
    const size_t End = I + 1 + (Op == 0xc0 || Op == 0xc1);
    if (End > Size) return {};
    return {true, 6, 0, 0, false, uint32_t(End), !(Op & 1) && !Rex && Low >= 4 ? Low - 4 : Low + ((Rex & 1) ? 8 : 0)};
  }
  if (!Segment && !Lock && (Op == 0x24 || Op == 0x25 || Op == 0x0c || Op == 0x0d || Op == 0x34 || Op == 0x35)) {
    // Implicit AL/AX/EAX/RAX logical immediate forms reuse the register-only
    // FLAGS contract of group-1 AND. REX.B/R/X do not select another GPR;
    // byte opcodes ignore operand size, while REX.W takes precedence over 66.
    const size_t ImmediateBytes = !(Op & 1) ? 1 : Width == 8 ? 4 : Width;
    if (ImmediateBytes > Size - I) return {};
    return {true, 6, 0, 0, false, uint32_t(I + ImmediateBytes), 0};
  }
  if (!Word && !Segment && !Lock && Op == 0xf7 && I < Size && (Bytes[I] & 0xf8) == 0xf0)
    return {true, 17, Width, 0, false, uint32_t(I + 1), uint32_t((Bytes[I] & 7) + ((Rex & 1) ? 8 : 0))};
  if (!Segment && !Lock && (Op == 0xa8 || Op == 0xa9 || Op == 0xf6 || Op == 0xf7)) {
    // Immediate TEST never writes its register operand. F6/F7 admit /0 and
    // register ModRM only; the vendor's /1 alias and all memory forms stay out.
    const uint32_t TestWidth = Op == 0xa8 || Op == 0xf6 ? 1 : Width;
    uint32_t Register = 0, Shift = 0;
    if (Op == 0xf6 || Op == 0xf7) {
      if (I >= Size || (Bytes[I] & 0xf8) != 0xc0) return {};
      const uint32_t Low = Bytes[I++] & 7;
      if (TestWidth == 1 && !Rex && Low >= 4) { Register = Low - 4; Shift = 8; }
      else Register = Low + ((Rex & 1) ? 8 : 0);
    }
    const size_t ImmediateBytes = TestWidth == 8 ? 4 : TestWidth;
    if (ImmediateBytes > Size - I) return {};
    uint64_t Mask = 0;
    for (size_t N = 0; N < ImmediateBytes; N++) Mask |= uint64_t(Bytes[I + N]) << (N * 8);
    if (TestWidth == 8) Mask = uint64_t(int64_t(int32_t(Mask)));
    Admission A {true, 6, 0, 0, false, uint32_t(I + ImmediateBytes), Register};
    A.TestWidth = TestWidth; A.TestShift = Shift; A.TestMask = Mask; return A;
  }
  if (!Word && !Segment && !Lock) {
    // Each admitted arithmetic family has an explicit register, read-only or
    // read/write effect contract; no guest operand uses a direct memory path.
    if ((Op == 0x8d) && I < Size && (Bytes[I] & 0xc0) != 0xc0) return {true, 0, 0};
    if (Op == 0x3c || Op == 0x3d) return {true, 6, 0};
    if (I < Size) {
      const bool Register = (Bytes[I] & 0xc0) == 0xc0;
      const uint8_t Group = Bytes[I] >> 3 & 7;
      if (Register && Op == 0xff && Group == 4)
        return {true, 12, 0, 5, false, uint32_t(I + 1), uint32_t((Bytes[I] & 7) + ((Rex & 1) ? 8 : 0))};
      // Non-LOCK ADD r/m32,r32 and r/m64,r64 only. A dedicated broker
      // transaction links the complete FEX load/add/store and preserves flags.
      if (!Register && Op == 0x01) return {true, 11, Width};
      // Register-destination ADD and non-LOCK memory-destination OR, 32/64
      // bits. Decode the complete encoding and selected GPR independently.
      if (!Register && (Op == 0x03 || Op == 0x09)) {
        const uint8_t M = Bytes[I], Mod = M >> 6, RM = M & 7;
        size_t End = I + 1, Displacement = Mod == 1 ? 1 : Mod == 2 ? 4 : 0;
        if (RM == 4) {
          if (End >= Size) return {};
          if ((Bytes[End++] & 7) == 5 && Mod == 0) {
            // Pinned FEX incorrectly retains R13 for this no-base SIB when
            // REX.B is set. Refuse that encoding before lowering.
            if (Rex & 1) return {};
            Displacement = 4;
          }
        } else if (Mod == 0 && RM == 5) Displacement = 4;
        if (Displacement > Size - End) return {};
        return {true, Op == 0x03 ? 15u : 16u, Width, 0, false, uint32_t(End + Displacement), uint32_t((M >> 3 & 7) + ((Rex & 4) ? 8 : 0))};
      }
      if (Op == 0x84 || Op == 0x85 || Op == 0x38 || Op == 0x39 || Op == 0x3a || Op == 0x3b)
        return {true, Register ? 6u : 8u, Register ? 0u : ((Op & 1) ? Width : 1u)};
      if ((Op == 0x80 || Op == 0x81 || Op == 0x83) && (Bytes[I] & 0x38) == 0x38)
        return {true, Register ? 6u : 8u, Register ? 0u : (Op == 0x80 ? 1u : Width)};
      // Group-1 /4 AND, 32/64-bit GPR destination only. FEX decodes the
      // sign-extended imm8 (83) or imm32 (81); the existing flags/effect
      // allowlist must still validate the complete single instruction.
      if (Register && (Op == 0x81 || Op == 0x83) && (Bytes[I] & 0x38) == 0x20)
        return {true, 6, 0};
      if (Register && ((Op == 0x01 || Op == 0x03 || Op == 0x29 || Op == 0x2b || Op == 0x31 || Op == 0x33 || Op == 0x21 || Op == 0x23 || Op == 0x09 || Op == 0x0b) ||
          ((Op == 0x81 || Op == 0x83) && ((Bytes[I] >> 3 & 7) == 0 || (Bytes[I] >> 3 & 7) == 5)))) return {true, 6, 0};
      if (Op == 0x0f && Bytes[I] >= 0x42 && Bytes[I] <= 0x47 && I + 1 < Size && (Bytes[I+1] & 0xc0) == 0xc0)
        return {true, 6, 0}; // unsigned/equality CMOV, 32/64-bit GPRs only
    }
  }
  if (Lock && Op != 0x0f) return {};
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
