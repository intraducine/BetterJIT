// SPDX-License-Identifier: GPL-3.0-or-later
// Native x86 scalar/condition oracle. Literal instructions, original flags
// restored for every row. AF is excluded only for logical operations.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#define EXEC(bytes) __asm__ volatile("pushfq; pop %[original]; push %[seed]; popfq; " bytes "; pushfq; pop %[flags]; push %[original]; popfq" : [original] "=&r"(original), [flags] "=&r"(flags), "+a"(a), "+c"(b) : [seed] "r"(seed), "S"(&memory) : "cc","memory")
int main(void) {
 const uint64_t values[]={0,1,15,16,0x7fff,0x8000,0xffff,UINT64_C(0x89abcdef7654ff80)};
 uint64_t current;__asm__ volatile("pushfq; pop %0":"=r"(current)::"memory");
 int comma=0;puts("{\"compare\":[");
 for(unsigned form=0;form<8;form++)for(unsigned x=0;x<8;x++)for(unsigned y=0;y<8;y++)for(unsigned df=0;df<2;df++) {
  uint64_t a=values[x],b=values[y],memory=values[x],original,flags,seed=(current&~UINT64_C(0xcd5))|(df?UINT64_C(0xcd5):0);
  switch(form){
case 0:EXEC(".byte 0x66,0x39,0xc8");break;
case 1:EXEC(".byte 0x66,0x39,0xe");break;
case 2:EXEC(".byte 0x66,0x3b,0xe");break;
case 3:EXEC(".byte 0x66,0x83,0xf8,0x1");break;
case 4:EXEC(".byte 0x66,0x83,0xf8,0x10");break;
case 5:EXEC(".byte 0x66,0x81,0xf8,0x0,0x80");break;
case 6:EXEC(".byte 0x66,0x83,0xf8,0x80");break;
case 7:EXEC(".byte 0x66,0x3d,0x80,0xff");break;
default:return 2;}
  printf("%s[%u,%u,%u,%u,%u]",comma?",\n":"",form,x,y,df,(unsigned)flags&0xcd5);comma=1;
 }
 puts("],\"logical\":[");comma=0;
 for(unsigned form=0;form<12;form++)for(unsigned x=0;x<8;x++)for(unsigned df=0;df<2;df++) {
  uint64_t a=values[x],b=0,memory=0,original,flags,seed=(current&~UINT64_C(0xcd5))|(df?UINT64_C(0xcd5):0);
  switch(form){
case 0:EXEC(".byte 0x66,0x83,0xc8,0x0");break;
case 1:EXEC(".byte 0x66,0x83,0xc8,0x80");break;
case 2:EXEC(".byte 0x66,0x81,0xc8,0xff,0xff");break;
case 3:EXEC(".byte 0x66,0xd,0x0,0x80");break;
case 4:EXEC(".byte 0x66,0x83,0xe0,0x0");break;
case 5:EXEC(".byte 0x66,0x83,0xe0,0x80");break;
case 6:EXEC(".byte 0x66,0x81,0xe0,0xff,0xff");break;
case 7:EXEC(".byte 0x66,0x25,0x0,0x80");break;
case 8:EXEC(".byte 0x66,0x83,0xf0,0x0");break;
case 9:EXEC(".byte 0x66,0x83,0xf0,0x80");break;
case 10:EXEC(".byte 0x66,0x81,0xf0,0xff,0xff");break;
case 11:EXEC(".byte 0x66,0x35,0x0,0x80");break;
default:return 2;}
  printf("%s[%u,%u,%u,\"0x%" PRIx64 "\",%u]",comma?",\n":"",form,x,df,a,(unsigned)flags&0xcc5);comma=1;
 }
 puts("],\"producers\":[");comma=0;
 for(unsigned form=0;form<6;form++)for(unsigned x=0;x<8;x++)for(unsigned y=0;y<8;y++)for(unsigned df=0;df<2;df++) {
  uint64_t a=values[x],b=values[y],memory=0,original,flags,seed=(current&~UINT64_C(0xcd5))|(df?UINT64_C(0xcd5):0);
  switch(form){
   case 0:EXEC("addl %%ecx,%%eax");break;
   case 1:EXEC("addq %%rcx,%%rax");break;
   case 2:EXEC("subl %%ecx,%%eax");break;
   case 3:EXEC("subq %%rcx,%%rax");break;
   case 4:EXEC("testl %%ecx,%%eax");break;
   case 5:EXEC("testq %%rcx,%%rax");break;
   default:return 2;
  }
  printf("%s[%u,%u,%u,%u,%u]",comma?",\n":"",form,x,y,df,(unsigned)flags&(form>=4?0xcc5:0xcd5));comma=1;
 }
 puts("],\"conditions\":[");comma=0;
 const unsigned masks[]={1,4,64,128,2048};
 for(unsigned cc=0;cc<16;cc++)for(unsigned bits=0;bits<32;bits++)for(unsigned df=0;df<2;df++) {
  unsigned requested=df?1024:0;for(unsigned n=0;n<5;n++)if(bits>>n&1)requested|=masks[n];
  uint64_t a=UINT64_C(0x12345678aabbccdd),b=UINT64_C(0xfedcba9876543210),memory=0,original,flags,seed=(current&~UINT64_C(0xcd5))|requested;
  uint64_t r32=0,r64=0,same=0,taken=0;unsigned after[4];
  switch(cc){
case 0:
 EXEC("cmovo %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovo %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovo %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jo 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 1:
 EXEC("cmovno %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovno %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovno %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jno 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 2:
 EXEC("cmovb %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovb %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovb %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jb 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 3:
 EXEC("cmovae %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovae %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovae %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jae 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 4:
 EXEC("cmove %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmove %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmove %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("je 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 5:
 EXEC("cmovne %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovne %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovne %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jne 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 6:
 EXEC("cmovbe %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovbe %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovbe %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jbe 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 7:
 EXEC("cmova %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmova %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmova %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("ja 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 8:
 EXEC("cmovs %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovs %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovs %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("js 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 9:
 EXEC("cmovns %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovns %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovns %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jns 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 10:
 EXEC("cmovp %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovp %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovp %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jp 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 11:
 EXEC("cmovnp %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovnp %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovnp %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jnp 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 12:
 EXEC("cmovl %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovl %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovl %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jl 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 13:
 EXEC("cmovge %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovge %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovge %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jge 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 14:
 EXEC("cmovle %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovle %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovle %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jle 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
case 15:
 EXEC("cmovg %%ecx,%%eax");r32=a;after[0]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovg %%rcx,%%rax");r64=a;after[1]=flags&0xcd5;a=UINT64_C(0x12345678aabbccdd);
 EXEC("cmovg %%eax,%%eax");same=a;after[2]=flags&0xcd5;
 EXEC("jg 1f; mov $0,%%rax; jmp 2f; 1: mov $1,%%rax; 2:");taken=a;after[3]=flags&0xcd5;break;
default:return 2;}
  for(unsigned n=0;n<4;n++)if(after[n]!=requested)return 3;
  printf("%s[%u,%u,\"0x%" PRIx64 "\",\"0x%" PRIx64 "\",\"0x%" PRIx64 "\",%u]",comma?",\n":"",cc,requested,r32,r64,same,(unsigned)taken);comma=1;
 }
 puts("]}");return 0;
}
