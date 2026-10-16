// SPDX-License-Identifier: GPL-3.0-or-later
// Native register BT: modulo index, carry, and complete operand preservation.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#define RUN(insn) __asm__ volatile( \
  "cmpl $0,%[seed]; jne 1f; movl $0x80000000,%%r9d; addl %%r9d,%%r9d; jmp 3f; " \
  "1: cmpl $1,%[seed]; jne 2f; movq $0,%%r9; subq $1,%%r9; jmp 3f; " \
  "2: movl $0x7fffffff,%%r9d; addl $1,%%r9d; 3: pushfq; pop %[before]; " \
  insn "; pushfq; pop %[after]" \
  : [before] "=&r"(before), [after] "=&r"(after), "+a"(value), "+c"(index) \
  : [seed] "r"(seed) : "r9", "cc", "memory")
#define IMMEDIATES(prefix) \
  case 0: RUN(prefix "0x00"); break; case 1: RUN(prefix "0x01"); break; \
  case 7: RUN(prefix "0x07"); break; case 15: RUN(prefix "0x0f"); break; \
  case 16: RUN(prefix "0x10"); break; case 31: RUN(prefix "0x1f"); break; \
  case 32: RUN(prefix "0x20"); break; case 63: RUN(prefix "0x3f"); break; \
  case 64: RUN(prefix "0x40"); break; case 127: RUN(prefix "0x7f"); break; \
  case 128: RUN(prefix "0x80"); break; case 255: RUN(prefix "0xff"); break; \
  default: return 2
static int execute(unsigned width, unsigned kind, uint64_t originalIndex, unsigned seed, uint64_t originalValue, int comma) {
  uint64_t value=originalValue,index=originalIndex,before=0,after=0;
  switch(width*4+kind) {
  case 8: RUN("btw %%cx,%%ax"); break;
  case 16: RUN("btl %%ecx,%%eax"); break;
  case 32: RUN("btq %%rcx,%%rax"); break;
  case 9: switch(index) { IMMEDIATES(".byte 0x66,0x0f,0xba,0xe0,"); } break;
  case 17: switch(index) { IMMEDIATES(".byte 0x0f,0xba,0xe0,"); } break;
  case 33: switch(index) { IMMEDIATES(".byte 0x48,0x0f,0xba,0xe0,"); } break;
  case 10: RUN("btw %%ax,%%ax"); break;
  case 18: RUN("btl %%eax,%%eax"); break;
  case 34: RUN("btq %%rax,%%rax"); break;
  default: return 2;
  }
  const uint64_t selected=kind==2?originalValue:originalIndex;
  const unsigned cf=(originalValue>>(selected&(width*8-1)))&1;
  if(value!=originalValue||index!=originalIndex||(after&1)!=cf||((after^before)&0x440))return 3;
  printf("%s[%u,%u,\"0x%" PRIx64 "\",%u,\"0x%" PRIx64 "\",\"0x%" PRIx64 "\",\"0x%" PRIx64 "\",%u,%u]",
    comma?",":"",width,kind,originalIndex,seed,originalValue,value,index,(unsigned)(before&0xcd5),(unsigned)(after&0xcd5));
  return 0;
}
int main(void) {
  const uint64_t values[]={0,1,UINT64_MAX,0x8000,0x80000000,0x8000000000000000ull,0x0123456789abcdefull,0xfedcba9876543210ull};
  const uint64_t extra[]={64,65,127,128,255,0x1000000000000000ull,UINT64_MAX,0x8000000000000001ull,0x12345678ffffffc0ull};
  const uint64_t immediates[]={0,1,7,15,16,31,32,63,64,127,128,255};
  unsigned rows=0;printf("[");
  for(unsigned width=2;width<=8;width*=2)for(unsigned seed=0;seed<3;seed++)for(unsigned v=0;v<8;v++) {
    for(uint64_t index=0;index<64;index++) { int e=execute(width,0,index,seed,values[v],rows++);if(e)return e; }
    for(unsigned n=0;n<sizeof(extra)/sizeof(*extra);n++) { int e=execute(width,0,extra[n],seed,values[v],rows++);if(e)return e; }
    for(unsigned n=0;n<sizeof(immediates)/sizeof(*immediates);n++) { int e=execute(width,1,immediates[n],seed,values[v],rows++);if(e)return e; }
    int e=execute(width,2,values[v],seed,values[v],rows++);if(e)return e;
  }
  puts("]");return 0;
}
