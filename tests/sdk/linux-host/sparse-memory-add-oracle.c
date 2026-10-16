// SPDX-License-Identifier: GPL-3.0-or-later
// Independent native x86 ADD memory result and all six defined arithmetic flags.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#define ADD(bytes) __asm__ volatile("movb $0x80,%%cl; addb %%cl,%%cl; " bytes "; pushfq; pop %0" \
  : "=&r"(flags), "+m"(memory), "+d"(source) : "a"(&memory) : "rcx", "cc", "memory")
int main(void) {
  const uint64_t values[]={0,1,15,UINT64_C(0x7fffffff),UINT64_C(0x80000000),UINT64_C(0xffffffff),
    UINT64_C(0x7fffffffffffffff),UINT64_C(0x8000000000000000),UINT64_MAX,UINT64_C(0x123456780000)};
  int comma=0;puts("[");
  for(unsigned width=4;width<=8;width+=4)for(unsigned a=0;a<10;a++)for(unsigned b=0;b<10;b++) {
    uint64_t memory=values[a],source=values[b],flags;
    if(width==8)ADD(".byte 0x48,0x01,0x10");else ADD(".byte 0x01,0x10");
    if(source!=values[b])return 1;
    printf("%s{\"width\":%u,\"initial\":\"0x%" PRIx64 "\",\"source\":\"0x%" PRIx64
      "\",\"memory\":\"0x%" PRIx64 "\",\"flags\":%u}",comma?",\n":"",width,values[a],source,memory,(unsigned)flags&0x8d5);
    comma=1;
  }
  puts("\n]");return 0;
}
