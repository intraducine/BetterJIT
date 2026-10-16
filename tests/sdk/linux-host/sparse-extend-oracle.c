// SPDX-License-Identifier: GPL-3.0-or-later
// Independent native x86-64 result and arithmetic-flag preservation oracle.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>

#define RUN(bytes) __asm__ volatile("mov %[fa],%%ecx; add %[fb],%%ecx; pushfq; pop %[before]; " \
  bytes "; pushfq; pop %[after]" : [before]"=&r"(before),[after]"=&r"(after), \
  "+a"(a),"+d"(d) : "b"(input),[fa]"r"(seeds[seed][0]),[fb]"r"(seeds[seed][1]) : "rcx","cc","memory")

int main(void) {
  const uint64_t values[]={0,0x7f,0x80,0x7fff,0x8000,0x7fffffff,0x80000000,0xffffffff,
    UINT64_MAX,UINT64_C(0x8000000000000000),UINT64_C(0x1234567887654380)};
  const uint32_t seeds[][2]={{0,0},{0x7f,1},{0xffffffff,1},{0x80000000,0x80000000},{0x7fffffff,1},{0x80000000,1}};
  enum { NumSeeds=sizeof(seeds)/sizeof(seeds[0]) };
  int comma=0;puts("[");
  for(unsigned op=0;op<17;op++)for(unsigned i=0;i<sizeof(values)/sizeof(values[0]);i++) {
    uint64_t resultA=0,resultD=0;unsigned flags[NumSeeds][2];const uint64_t input=values[i];
    for(unsigned seed=0;seed<NumSeeds;seed++) {
      uint64_t a=op<6?input:UINT64_C(0x1122334455667788),d=UINT64_C(0xaabbccddeeff0123),before,after;
      switch(op) {
      case 0: RUN(".byte 0x66,0x98"); break; // CBW
      case 1: RUN(".byte 0x98"); break; // CWDE
      case 2: RUN(".byte 0x48,0x98"); break; // CDQE
      case 3: RUN(".byte 0x66,0x99"); break; // CWD
      case 4: RUN(".byte 0x99"); break; // CDQ
      case 5: RUN(".byte 0x48,0x99"); break; // CQO
      case 6: RUN(".byte 0x66,0x0f,0xbe,0xc3"); break;
      case 7: RUN(".byte 0x0f,0xbe,0xc3"); break;
      case 8: RUN(".byte 0x48,0x0f,0xbe,0xc3"); break;
      case 9: RUN(".byte 0x0f,0xbf,0xc3"); break;
      case 10: RUN(".byte 0x48,0x0f,0xbf,0xc3"); break;
      case 11: RUN(".byte 0x48,0x63,0xc3"); break;
      case 12: RUN(".byte 0x66,0x0f,0xb6,0xc3"); break;
      case 13: RUN(".byte 0x0f,0xb6,0xc3"); break;
      case 14: RUN(".byte 0x48,0x0f,0xb6,0xc3"); break;
      case 15: RUN(".byte 0x0f,0xb7,0xc3"); break;
      default: RUN(".byte 0x48,0x0f,0xb7,0xc3"); break;
      }
      if(seed&&(a!=resultA||d!=resultD))return 1;
      resultA=a;resultD=d;flags[seed][0]=(unsigned)before&0x8d5;flags[seed][1]=(unsigned)after&0x8d5;
      if(flags[seed][0]!=flags[seed][1])return 1;
    }
    printf("%s{\"op\":%u,\"input\":\"0x%"PRIx64"\",\"rax\":\"0x%"PRIx64"\",\"rdx\":\"0x%"PRIx64"\",\"flags\":[",
      comma?",\n":"",op,input,resultA,resultD);
    for(unsigned seed=0;seed<NumSeeds;seed++)printf("%s[%u,%u]",seed?",":"",flags[seed][0],flags[seed][1]);
    printf("]}");comma=1;
  }
  puts("\n]");return 0;
}
