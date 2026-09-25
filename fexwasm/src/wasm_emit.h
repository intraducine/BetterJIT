// Minimal WebAssembly binary encoder for the FEX IR -> wasm backend.
#pragma once
#include <cstdint>
#include <string_view>
#include <vector>

namespace fexwasm {

enum ValType : uint8_t { I32 = 0x7f, I64 = 0x7e, F32 = 0x7d, F64 = 0x7c, V128 = 0x7b };

namespace op {
constexpr uint8_t unreachable = 0x00, block = 0x02, loop = 0x03, if_ = 0x04, else_ = 0x05, end = 0x0b, br = 0x0c, br_if = 0x0d,
                  br_table = 0x0e, return_ = 0x0f, call = 0x10, call_indirect = 0x11, drop = 0x1a, select = 0x1b, local_get = 0x20, local_set = 0x21,
                  local_tee = 0x22, i32_load = 0x28, i64_load = 0x29, f32_load = 0x2a, f64_load = 0x2b, i32_load8_s = 0x2c,
                  i32_load8_u = 0x2d, i32_load16_s = 0x2e, i32_load16_u = 0x2f, i64_load8_s = 0x30, i64_load8_u = 0x31,
                  i64_load16_s = 0x32, i64_load16_u = 0x33, i64_load32_s = 0x34, i64_load32_u = 0x35, i32_store = 0x36,
                  i64_store = 0x37, i32_store8 = 0x3a, i32_store16 = 0x3b, i64_store8 = 0x3c, i64_store16 = 0x3d, i64_store32 = 0x3e,
                  i32_const = 0x41, i64_const = 0x42, i32_eqz = 0x45, i32_eq = 0x46, i32_ne = 0x47, i32_lt_s = 0x48, i32_lt_u = 0x49,
                  i32_gt_s = 0x4a, i32_gt_u = 0x4b, i32_le_s = 0x4c, i32_le_u = 0x4d, i32_ge_s = 0x4e, i32_ge_u = 0x4f, i64_eqz = 0x50,
                  i64_eq = 0x51, i64_ne = 0x52, i64_lt_s = 0x53, i64_lt_u = 0x54, i64_gt_s = 0x55, i64_gt_u = 0x56, i64_le_s = 0x57,
                  i64_le_u = 0x58, i64_ge_s = 0x59, i64_ge_u = 0x5a, i32_clz = 0x67, i32_ctz = 0x68, i32_popcnt = 0x69,
                  i32_add = 0x6a, i32_sub = 0x6b, i32_mul = 0x6c, i32_div_s = 0x6d, i32_div_u = 0x6e, i32_rem_s = 0x6f,
                  i32_rem_u = 0x70, i32_and = 0x71, i32_or = 0x72, i32_xor = 0x73, i32_shl = 0x74, i32_shr_s = 0x75, i32_shr_u = 0x76,
                  i32_rotl = 0x77, i32_rotr = 0x78, i64_clz = 0x79, i64_ctz = 0x7a, i64_popcnt = 0x7b, i64_add = 0x7c, i64_sub = 0x7d,
                  i64_mul = 0x7e, i64_div_s = 0x7f, i64_div_u = 0x80, i64_rem_s = 0x81, i64_rem_u = 0x82, i64_and = 0x83,
                  i64_or = 0x84, i64_xor = 0x85, i64_shl = 0x86, i64_shr_s = 0x87, i64_shr_u = 0x88, i64_rotl = 0x89,
                  i64_rotr = 0x8a, i32_wrap_i64 = 0xa7, i64_extend_i32_s = 0xac, i64_extend_i32_u = 0xad, i32_extend8_s = 0xc0,
                  i32_extend16_s = 0xc1, i64_extend8_s = 0xc2, i64_extend16_s = 0xc3, i64_extend32_s = 0xc4, prefix_fc = 0xfc,
                  prefix_fd = 0xfd;
// 0xfc-prefixed
constexpr uint32_t memory_copy = 10, memory_fill = 11;
} // namespace op

struct Buf {
  std::vector<uint8_t> b;

  void u8(uint8_t v) {
    b.push_back(v);
  }
  void u32(uint32_t v) {
    do {
      uint8_t c = v & 0x7f;
      v >>= 7;
      if (v) {
        c |= 0x80;
      }
      b.push_back(c);
    } while (v);
  }
  void s32(int32_t v) {
    s64(v);
  }
  void s64(int64_t v) {
    for (;;) {
      uint8_t c = v & 0x7f;
      v >>= 7;
      if ((v == 0 && !(c & 0x40)) || (v == -1 && (c & 0x40))) {
        b.push_back(c);
        return;
      }
      b.push_back(c | 0x80);
    }
  }
  void append(const Buf& o) {
    b.insert(b.end(), o.b.begin(), o.b.end());
  }
  void str(std::string_view s) {
    u32(uint32_t(s.size()));
    b.insert(b.end(), s.begin(), s.end());
  }
  void section(uint8_t id, const Buf& body) {
    u8(id);
    u32(uint32_t(body.b.size()));
    append(body);
  }
  size_t size() const {
    return b.size();
  }

  // Instruction helpers.
  void i32c(int32_t v) {
    u8(op::i32_const);
    s32(v);
  }
  void i64c(int64_t v) {
    u8(op::i64_const);
    s64(v);
  }
  void f64c(double v) {
    u8(0x44);
    uint64_t Bits;
    static_assert(sizeof(Bits) == sizeof(v));
    __builtin_memcpy(&Bits, &v, 8);
    for (int i = 0; i < 8; i++) {
      u8(uint8_t(Bits >> (8 * i)));
    }
  }
  void get(uint32_t l) {
    u8(op::local_get);
    u32(l);
  }
  void set(uint32_t l) {
    u8(op::local_set);
    u32(l);
  }
  void tee(uint32_t l) {
    u8(op::local_tee);
    u32(l);
  }
  void mem(uint8_t opcode, uint32_t align, uint32_t offset) {
    u8(opcode);
    u32(align);
    u32(offset);
  }
  void fc(uint32_t sub) {
    u8(op::prefix_fc);
    u32(sub);
  }
};

} // namespace fexwasm
