// CoreMark as one translation unit: k_coremark(n) runs n iterations and
// returns an FNV hash of everything CoreMark printed (CRCs included).
#define main coremark_main
#include "core_portme.c"
#include "core_list_join.c"
#include "core_main.c"
#include "core_matrix.c"
#include "core_state.c"
#include "core_util.c"
#undef main
#include "ee_printf.c"
extern ee_u32 cm_hash, cm_out_len;
// n's bits 24-26 select CoreMark's algorithms (list 1, matrix 2, state 4; 0 = all).
uint32_t k_coremark(int n) {
  seed5_volatile = (n >> 24) & 7;
  n &= 0xffffff;
  seed4_volatile = n;
  cm_hash = 2166136261u;
  cm_out_len = 0;
  coremark_main();
  return cm_hash;
}
