// SPDX-License-Identifier: GPL-3.0-or-later
// Independently executed native x86 flag oracle; no FEX or backend code.
#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
static uint64_t flags(uint64_t a,uint64_t b,int test,int wide) {
 uint64_t f;
 if(test&&wide)__asm__ volatile("testq %2,%1; pushfq; pop %0":"=r"(f):"r"(a),"r"(b):"cc");
 else if(test)__asm__ volatile("testl %k2,%k1; pushfq; pop %0":"=r"(f):"r"(a),"r"(b):"cc");
 else if(wide)__asm__ volatile("cmpq %2,%1; pushfq; pop %0":"=r"(f):"r"(a),"r"(b):"cc");
 else __asm__ volatile("cmpl %k2,%k1; pushfq; pop %0":"=r"(f):"r"(a),"r"(b):"cc");
 return f&(test?UINT64_C(0x8c5):UINT64_C(0x8d5));
}
int main(void) {
 const uint64_t values[][2]={{0,0},{1,0},{UINT64_C(0x8000000080000000),1},{UINT64_MAX,UINT64_C(0x7fffffff7fffffff)}};
 printf("[\n");int comma=0;
 for(int test=0;test<2;test++)for(int wide=0;wide<2;wide++)for(int i=0;i<4;i++) {
  printf("%s{\"test\":%s,\"width\":%d,\"a\":\"0x%" PRIx64 "\",\"b\":\"0x%" PRIx64 "\",\"mask\":%d,\"flags\":%" PRIu64 "}",comma?",\n":"",test?"true":"false",wide?8:4,values[i][0],values[i][1],test?0x8c5:0x8d5,flags(values[i][0],values[i][1],test,wide));comma=1;
 }
 puts("\n]");return 0;
}
