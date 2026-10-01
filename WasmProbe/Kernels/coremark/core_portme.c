#include "coremark.h"
volatile ee_s32 seed1_volatile = 0x0;
volatile ee_s32 seed2_volatile = 0x0;
volatile ee_s32 seed3_volatile = 0x66;
volatile ee_s32 seed4_volatile = 1;
volatile ee_s32 seed5_volatile = 0;
ee_u32 default_num_contexts = 1;
ee_u32 cm_hash;
static CORETIMETYPE start_time_val, stop_time_val, fake_clock;
#define EE_TICKS_PER_SEC 1000
void start_time(void) { start_time_val = fake_clock += 1000; }
void stop_time(void) { stop_time_val = fake_clock += 20000; }
CORE_TICKS get_time(void) { return (CORE_TICKS)(stop_time_val - start_time_val); }
secs_ret time_in_secs(CORE_TICKS ticks) { return ((secs_ret)ticks) / (secs_ret)EE_TICKS_PER_SEC; }
void portable_init(core_portable *p, int *argc, char *argv[]) { p->portable_id = 1; }
void portable_fini(core_portable *p) { p->portable_id = 0; }
char cm_out[4096];
ee_u32 cm_out_len;
void uart_send_char(char c) {
  cm_hash = (cm_hash ^ (ee_u8)c) * 16777619u;
  if (cm_out_len < sizeof(cm_out) - 1) cm_out[cm_out_len++] = c;
}
