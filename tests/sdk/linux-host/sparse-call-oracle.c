// SPDX-License-Identifier: GPL-3.0-or-later
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#define BEFORE "addl %%ebx,%%eax; pushfq; pop %[before]; mov %%rsp,%[initial]; "
#define CALLEE "mov (%%rsp),%[word]; mov %%rsp,%[inside]; ret; "
#define AFTER "pushfq; pop %[after]; mov %%rsp,%[final]; "
#define RUN(code) __asm__ volatile(code : [before]"=&r"(before),[after]"=&r"(after), \
  [initial]"=&r"(initial),[inside]"=&r"(inside),[final]"=&r"(final),[word]"=&r"(word), \
  [expected]"=&r"(expected),[target]"=&r"(target),"+a"(a):"b"(b):"cc","memory")
int main(void) {
  const uint32_t inputs[][2]={{0,0},{0x7f,1},{0xffffffff,1},{0x80000000,0x80000000}};
  const char* names[]={"forward","backward","zero","indirect"};int comma=0;puts("[");
  for(unsigned mode=0;mode<4;mode++)for(unsigned i=0;i<4;i++) {
    uint32_t a=inputs[i][0],b=inputs[i][1];uint64_t before,after,initial,inside,final,word,expected,target;
    if(mode==0){RUN(BEFORE "lea 2f(%%rip),%[expected]; call 1f; 2: " AFTER "jmp 3f; 1: " CALLEE "3:");}
    else if(mode==1){RUN("jmp 0f; 1: " CALLEE "0: " BEFORE "lea 2f(%%rip),%[expected]; call 1b; 2: " AFTER);}
    // The zero-displacement CALL lands on its own return PC. POP observes its
    // push without creating an intentional repeated-RET loop in the oracle.
    else if(mode==2) {RUN(BEFORE "lea 1f(%%rip),%[expected]; call 1f; 1: mov %%rsp,%[inside]; pop %[word]; " AFTER);}
    else {RUN(BEFORE "lea 2f(%%rip),%[expected]; lea 1f(%%rip),%[target]; call *%[target]; 2: " AFTER "jmp 3f; 1: " CALLEE "3:");}
    printf("%s{\"mode\":\"%s\",\"a\":%u,\"b\":%u,\"flags\":%u,\"flagsAfter\":%u,"
      "\"callStackDelta\":%"PRId64",\"finalStackDelta\":%"PRId64",\"returnMatches\":%s}",
      comma?",\n":"",names[mode],inputs[i][0],b,(unsigned)before&0x8d5,(unsigned)after&0x8d5,
      (int64_t)(inside-initial),(int64_t)(final-initial),word==expected?"true":"false");comma=1;
  }puts("\n]");return 0;
}
