// SPDX-License-Identifier: GPL-3.0-or-later
#include <stdint.h>
#include <stdio.h>
#include <inttypes.h>
#define ALU(text) __asm__ volatile(text "; pushfq; pop %0":"=&r"(f),"+a"(a):"b"(b):"cc","memory")
int main(void){
 const char *names[]={"add32","add64","sub32","sub64","xor32","xor64","and64","or64","cmp8","test8","cmp-memory64","cmp-memory8","cmp-immediate-memory64"};
 const uint64_t values[][2]={{0,0},{1,1},{0x7f,1},{0x80,0xff},{0xffffffff,1},{0x7fffffff,1},{UINT64_MAX,1},{0x7fffffffffffffff,1}};
 int comma=0;puts("[");for(int op=0;op<13;op++)for(int i=0;i<8;i++){
  uint64_t a=values[i][0],b=op==12?2:values[i][1],f;const uint64_t original=a;
  switch(op){case 0:ALU("addl %%ebx,%%eax");break;case 1:ALU("addq %%rbx,%%rax");break;case 2:ALU("subl %%ebx,%%eax");break;case 3:ALU("subq %%rbx,%%rax");break;case 4:ALU("xorl %%ebx,%%eax");break;case 5:ALU("xorq %%rbx,%%rax");break;case 6:ALU("andq %%rbx,%%rax");break;case 7:ALU("orq %%rbx,%%rax");break;case 8:ALU("cmpb %%bl,%%al");break;case 9:ALU("testb %%bl,%%al");break;
   case 10:__asm__ volatile("cmpq %2,%1;pushfq;pop %0":"=&r"(f):"m"(a),"b"(b):"cc","memory");break;
   case 11:__asm__ volatile("cmpb %b2,%1;pushfq;pop %0":"=&r"(f):"m"(*(uint8_t*)&a),"b"(b):"cc","memory");break;
   default:__asm__ volatile("cmpq $2,%1;pushfq;pop %0":"=&r"(f):"m"(a):"cc","memory");break;
  }
  const unsigned mask=(op>=4&&op<=7)||op==9?0x8c5:0x8d5;
  printf("%s{\"op\":\"%s\",\"a\":\"0x%"PRIx64"\",\"b\":\"0x%"PRIx64"\",\"result\":\"0x%"PRIx64"\",\"mask\":%u,\"flags\":%u}",comma?",\n":"",names[op],original,b,a,mask,(unsigned)f&mask);comma=1;
 }puts("\n]");return 0;
}
