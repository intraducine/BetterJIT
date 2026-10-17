// SPDX-License-Identifier: GPL-3.0-or-later
// First broker profile: explicit x86 instruction admission, not an IR-node guess.
#pragma once
#include <cstddef>
#include <cstdint>

namespace fexwasm::broker {
constexpr uint32_t MemoryABI = 1, CheckpointABI = 1, StepABI = 4, Coverage = 28;
constexpr uint32_t Pages = 33, ThreadBase = 0x10000, Scratch = 0x1f0000;
constexpr uint32_t StepMagic = 0x31534a42, HeaderBytes = 96;
struct Admission {
  bool Supported = false;
  uint32_t Operation = 0, Width = 0; // 0 register-only, 1 read, 2 write
  uint32_t Flow = 0; // 0 fallthrough, 1 jump, 2 conditional, 3 direct call, 4 return, 5 register jump, 6 register call
  bool NoEffects = false; // NOP: only instruction markers and constant fallthrough IR
  uint32_t Length = 0; // independently decoded bounded length, checked against FEX
  uint32_t Register = 16; // selected GPR for a bounded jump, stack, ADD destination or TEST source
  uint32_t TestWidth = 0, TestShift = 0; // internal immediate-TEST proof, no wire operation change
  uint64_t TestMask = 0;
  uint32_t SetCondition = 16, SetShift = 0; // register SETcc proof; 16 means absent
  uint32_t BitWidth = 0, BitRegister = 16, BitIndex = 0; // BT; register 16 selects imm8
  uint32_t LogicalWidth = 0, LogicalKind = 0; // group-1 /1 OR, /4 AND, /6 XOR
  uint64_t LogicalMask = 0; // decoded, width-masked signed immediate
  bool WordCompare = false; // 16-bit CMP; no operand writes
  uint32_t CompareKind = 0; // 0 mem/imm, 1 mem/reg, 2 reg/mem, 3 reg/reg, 4 reg/imm
  uint32_t CompareLeftRegister = 16, CompareRightRegister = 16;
  uint32_t CompareImmediate = 0; // imm16 or sign-extended imm8, masked to16 bits
  int32_t CompareBase = -1, CompareIndex = -1;
  uint32_t CompareScale = 1;
  int64_t CompareDisplacement = 0;
  bool CompareRIPRelative = false;
  uint32_t ConditionCode = 16, ConditionalMoveWidth = 0, ConditionSourceRegister = 16;
  uint32_t UnaryKind = 0, UnaryWidth = 0, UnaryShift = 0; // NEG/NOT/INC/DEC = 1/2/3/4
  uint32_t VectorKind = 0, VectorWidth = 0, VectorSourceRegister = 16; // GPR->XMM, XMM->GPR, copy, zero-high MOVQ, scalar merge = 1..5
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
// Legacy register movement only. One mandatory prefix precedes at most one
// REX; REX.R/B select slots, REX.W selects only MOVD/MOVQ's GPR width.
inline Admission AdmitVectorMove(const uint8_t* Bytes, size_t Size) {
  if (!Bytes || !Size) return {};
  size_t I=0; uint8_t Prefix=0, Rex=0;
  if (Bytes[I]==0x66 || Bytes[I]==0xf2 || Bytes[I]==0xf3) Prefix=Bytes[I++];
  if (I<Size && Bytes[I]>=0x40 && Bytes[I]<=0x4f) Rex=Bytes[I++];
  if (Size-I<3 || Bytes[I++]!=0x0f) return {};
  const auto Op=Bytes[I++], M=Bytes[I++]; if (M<0xc0) return {};
  const uint32_t R=(M>>3&7)+((Rex&4)?8:0), RM=(M&7)+((Rex&1)?8:0);
  uint32_t Kind=0, Width=16; bool Reverse=false;
  if (Prefix==0x66 && (Op==0x6e || Op==0x7e)) {Kind=Op==0x6e?1:2;Width=Rex&8?8:4;Reverse=Op==0x7e;}
  else if (((!Prefix || Prefix==0x66) && (Op==0x28 || Op==0x29 || Op==0x10 || Op==0x11)) ||
           ((Prefix==0x66 || Prefix==0xf3) && (Op==0x6f || Op==0x7f))) {Kind=3;Reverse=Op==0x29 || Op==0x11 || Op==0x7f;}
  else if ((Prefix==0xf3 && Op==0x7e) || (Prefix==0x66 && Op==0xd6)) {Kind=4;Width=8;Reverse=Op==0xd6;}
  else if ((Prefix==0xf2 || Prefix==0xf3) && (Op==0x10 || Op==0x11)) {Kind=5;Width=Prefix==0xf3?4:8;Reverse=Op==0x11;}
  if (!Kind) return {};
  Admission A {true,6,0,0,false,uint32_t(I),Reverse?RM:R};
  A.VectorKind=Kind;A.VectorWidth=Width;A.VectorSourceRegister=Reverse?R:RM;return A;
}
// FEX supplies/validates the complete instruction length separately. This only
// admits an explicit semantic family; unsupported prefixes/opcodes never run.
inline Admission Admit(const uint8_t* Bytes, size_t Size) {
  if (!Bytes || !Size) return {};
  const auto Vector = AdmitVectorMove(Bytes, Size);
  if (Vector.Supported) return Vector;
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
  if (I == 1 && ((Op >= 0x70 && Op <= 0x7f) ||
      (Op == 0x0f && I < Size && (Bytes[I] >= 0x80 && Bytes[I] <= 0x8f)))) {
    Admission A {true, 7, 0, 2}; A.ConditionCode = (Op == 0x0f ? Bytes[I] : Op) & 15; return A;
  }
  const uint32_t Width = Rex & 8 ? 8 : Word ? 2 : 4;
  if (!Segment && !Lock && (Op==0xf6 || Op==0xf7 || Op==0xfe || Op==0xff) && I<Size && (Bytes[I]&0xc0)==0xc0) {
    const uint32_t Group=Bytes[I]>>3&7;const bool Byte=Op==0xf6 || Op==0xfe;
    const uint32_t Kind=(Op==0xf6 || Op==0xf7)?(Group==3?1:Group==2?2:0):(Group<=1?Group+3:0);
    if (Kind) {
      const uint32_t Low=Bytes[I]&7,Shift=Byte&&!Rex&&Low>=4?8:0;
      Admission A {true,6,0,0,false,uint32_t(I+1),Shift?Low-4:Low+((Rex&1)?8:0)};
      A.UnaryKind=Kind;A.UnaryWidth=Byte?1:Width;A.UnaryShift=Shift;return A;
    }
  }

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
    Admission A {true, 6, 0, 0, false, uint32_t(I + ImmediateBytes), 0};
    if (Word && !(Rex & 8) && (Op & 1)) {
      A.LogicalWidth = 2; A.LogicalKind = Op == 0x0d ? 1 : Op == 0x25 ? 4 : 6;
      A.LogicalMask = uint32_t(Bytes[I]) | uint32_t(Bytes[I + 1]) << 8;
    }
    return A;
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
  if (Word && !Segment && !Lock && !(Rex & 8) && (Op == 0x81 || Op == 0x83) && I < Size && (Bytes[I] & 0xc0) == 0xc0) {
    const auto Group = Bytes[I] >> 3 & 7;
    if (Group == 1 || Group == 4 || Group == 6) {
      const size_t N = Op == 0x83 ? 1 : 2;
      if (N > Size - (I + 1)) return {};
      const uint32_t Raw = Op == 0x83 ? uint16_t(int16_t(int8_t(Bytes[I + 1]))) : uint32_t(Bytes[I + 1]) | uint32_t(Bytes[I + 2]) << 8;
      Admission A {true, 6, 0, 0, false, uint32_t(I + 1 + N), uint32_t((Bytes[I] & 7) + ((Rex & 1) ? 8 : 0))};
      A.LogicalWidth = 2; A.LogicalKind = Group; A.LogicalMask = Raw; return A;
    }
  }
  if (Word && !Segment && !Lock && !(Rex & 8) && (Op == 0x81 || Op == 0x83 || Op == 0x39 || Op == 0x3b || Op == 0x3d)) {
    Admission A; A.Supported = A.WordCompare = true;
    if (Op == 0x3d) {
      if (Size - I < 2) return {};
      A.Operation = 6; A.Register = A.CompareLeftRegister = 0; A.CompareKind = 4;
      A.CompareImmediate = uint32_t(Bytes[I]) | uint32_t(Bytes[I + 1]) << 8; A.Length = I + 2; return A;
    }
    if (I >= Size) return {};
    const uint8_t M = Bytes[I++], Mod = M >> 6, RM = M & 7;
    const bool Immediate = Op == 0x81 || Op == 0x83;
    if (Immediate && (M & 0x38) != 0x38) return {};
    const auto R = uint32_t((M >> 3 & 7) + ((Rex & 4) ? 8 : 0));
    const size_t ImmediateBytes = Immediate ? (Op == 0x83 ? 1 : 2) : 0;
    if (Mod == 3) {
      const auto Operand = uint32_t(RM + ((Rex & 1) ? 8 : 0));
      A.Operation = 6; A.CompareKind = Immediate ? 4 : 3;
      A.CompareLeftRegister = Immediate || Op == 0x39 ? Operand : R;
      A.CompareRightRegister = Immediate ? 16 : Op == 0x39 ? R : Operand;
      A.Register = A.CompareLeftRegister;
    } else {
      A.Operation = 8; A.Width = 2; A.CompareKind = Immediate ? 0 : Op == 0x39 ? 1 : 2;
      if (!Immediate) (Op == 0x39 ? A.CompareRightRegister : A.CompareLeftRegister) = R;
      size_t Displacement = Mod == 1 ? 1 : Mod == 2 ? 4 : 0;
      if (RM == 4) {
        if (I >= Size) return {};
        const uint8_t SIB = Bytes[I++], LowBase = SIB & 7, LowIndex = SIB >> 3 & 7;
        A.CompareScale = 1u << (SIB >> 6);
        if (LowIndex != 4 || (Rex & 2)) A.CompareIndex = LowIndex + ((Rex & 2) ? 8 : 0);
        if (LowBase == 5 && Mod == 0) {
          if (Rex & 1) return {}; // pinned frontend no-base SIB/REX.B exclusion
          Displacement = 4;
        } else A.CompareBase = LowBase + ((Rex & 1) ? 8 : 0);
      } else if (Mod == 0 && RM == 5) { Displacement = 4; A.CompareRIPRelative = true; }
      else A.CompareBase = RM + ((Rex & 1) ? 8 : 0);
      if (Displacement + ImmediateBytes > Size - I) return {};
      if (Displacement == 1) A.CompareDisplacement = int8_t(Bytes[I]);
      if (Displacement == 4) {
        uint32_t Raw = 0; for (unsigned J = 0; J < 4; J++) Raw |= uint32_t(Bytes[I + J]) << (J * 8);
        A.CompareDisplacement = int32_t(Raw);
      }
      I += Displacement;
    }
    if (ImmediateBytes > Size - I) return {};
    if (Immediate) A.CompareImmediate = Op == 0x83 ? uint16_t(int16_t(int8_t(Bytes[I]))) : uint32_t(Bytes[I]) | uint32_t(Bytes[I + 1]) << 8;
    A.Length = I + ImmediateBytes; return A;
  }
  if (!Word && !Segment && !Lock) {
    // Each admitted arithmetic family has an explicit register, read-only or
    // read/write effect contract; no guest operand uses a direct memory path.
    if ((Op == 0x8d) && I < Size && (Bytes[I] & 0xc0) != 0xc0) return {true, 0, 0};
    if (Op == 0x3c || Op == 0x3d) return {true, 6, 0};
    if (I < Size) {
      const bool Register = (Bytes[I] & 0xc0) == 0xc0;
      const uint8_t Group = Bytes[I] >> 3 & 7;
      if (Register && Op == 0xff && Group == 2)
        return {true, 9, 8, 6, false, uint32_t(I + 1), uint32_t((Bytes[I] & 7) + ((Rex & 1) ? 8 : 0))};
      if (Register && Op == 0xff && Group == 4)
        return {true, 12, 0, 5, false, uint32_t(I + 1), uint32_t((Bytes[I] & 7) + ((Rex & 1) ? 8 : 0))};
      // Non-LOCK ADD r/m32,r32 and r/m64,r64 only. A dedicated broker
      // transaction links the complete FEX load/add/store and preserves flags.
      if (!Register && Op == 0x01) return {true, 11, Width};
      // Register-destination ADD/SUB and non-LOCK memory-destination OR, 32/64
      // bits. Decode the complete encoding and selected GPR independently.
      if (!Register && (Op == 0x03 || Op == 0x2b || Op == 0x09)) {
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
        return {true, Op == 0x03 ? 15u : Op == 0x2b ? 18u : 16u, Width, 0, false, uint32_t(End + Displacement), uint32_t((M >> 3 & 7) + ((Rex & 4) ? 8 : 0))};
      }
      if (Op == 0x84 || Op == 0x85 || Op == 0x38 || Op == 0x39 || Op == 0x3a || Op == 0x3b)
        return {true, Register ? 6u : 8u, Register ? 0u : ((Op & 1) ? Width : 1u)};
      if ((Op == 0x80 || Op == 0x81 || Op == 0x83) && (Bytes[I] & 0x38) == 0x38)
        return {true, Register ? 6u : 8u, Register ? 0u : (Op == 0x80 ? 1u : Width)};
      // Group-1 logical immediates, 32/64-bit GPR destination only. REX.R/X
      // do not extend the opcode group; REX.B selects the destination. Decode
      // the full immediate independently and prove FEX's complete dataflow.
      if (Register && (Op == 0x81 || Op == 0x83) && (Group == 1 || Group == 4 || Group == 6)) {
        const size_t N = Op == 0x83 ? 1 : 4;
        if (N > Size - (I + 1)) return {};
        uint32_t Raw = 0;
        for (size_t J = 0; J < N; J++) Raw |= uint32_t(Bytes[I + 1 + J]) << (J * 8);
        const uint64_t Mask = N == 1 ? uint64_t(int64_t(int8_t(Raw))) : uint64_t(int64_t(int32_t(Raw)));
        Admission A {true, 6, 0, 0, false, uint32_t(I + 1 + N), uint32_t((Bytes[I] & 7) + ((Rex & 1) ? 8 : 0))};
        A.LogicalWidth = Width; A.LogicalKind = Group;
        A.LogicalMask = Width == 4 ? uint32_t(Mask) : Mask;
        return A;
      }
      if (Register && ((Op == 0x01 || Op == 0x03 || Op == 0x29 || Op == 0x2b || Op == 0x31 || Op == 0x33 || Op == 0x21 || Op == 0x23 || Op == 0x09 || Op == 0x0b) ||
          ((Op == 0x81 || Op == 0x83) && ((Bytes[I] >> 3 & 7) == 0 || (Bytes[I] >> 3 & 7) == 5)))) return {true, 6, 0};
      if (Op == 0x0f && Bytes[I] >= 0x40 && Bytes[I] <= 0x4f && I + 1 < Size && (Bytes[I+1] & 0xc0) == 0xc0) {
        Admission A {true, 6, 0, 0, false, uint32_t(I + 2), uint32_t((Bytes[I+1] >> 3 & 7) + ((Rex & 4) ? 8 : 0))};
        A.ConditionCode = Bytes[I] & 15; A.ConditionalMoveWidth = Width;
        A.ConditionSourceRegister = (Bytes[I+1] & 7) + ((Rex & 1) ? 8 : 0); return A;
      }
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
