// SPDX-License-Identifier: GPL-3.0-or-later
// Native Linux x86-64 compact register PUSH/POP oracle. Host RSP is restored
// with a RIP-relative MOV before any stack access after an arbitrary POP RSP.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
uint64_t betterjit_stack_before[16],betterjit_stack_after[16],betterjit_stack_saved_rsp,betterjit_stack_value,betterjit_stack_top,betterjit_stack_flags_before,betterjit_stack_flags_after;
static unsigned char storage[12288] __attribute__((aligned(4096)));
#define SNAP(name) \
 "mov %rax,betterjit_stack_" name "+0(%rip); " \
 "mov %rcx,betterjit_stack_" name "+8(%rip); " \
 "mov %rdx,betterjit_stack_" name "+16(%rip); " \
 "mov %rbx,betterjit_stack_" name "+24(%rip); " \
 "mov %rsp,betterjit_stack_" name "+32(%rip); " \
 "mov %rbp,betterjit_stack_" name "+40(%rip); " \
 "mov %rsi,betterjit_stack_" name "+48(%rip); " \
 "mov %rdi,betterjit_stack_" name "+56(%rip); " \
 "mov %r8,betterjit_stack_" name "+64(%rip); " \
 "mov %r9,betterjit_stack_" name "+72(%rip); " \
 "mov %r10,betterjit_stack_" name "+80(%rip); " \
 "mov %r11,betterjit_stack_" name "+88(%rip); " \
 "mov %r12,betterjit_stack_" name "+96(%rip); " \
 "mov %r13,betterjit_stack_" name "+104(%rip); " \
 "mov %r14,betterjit_stack_" name "+112(%rip); " \
 "mov %r15,betterjit_stack_" name "+120(%rip); "
#define START(name) \
 ".text; .globl " #name "; " #name ": push %rbx; push %rbp; push %r12; push %r13; push %r14; push %r15; " \
 "mov %rsp,betterjit_stack_saved_rsp(%rip); mov %rsi,betterjit_stack_value(%rip); mov %rdx,betterjit_stack_top(%rip); " \
 "mov %edi,%eax; addl $1,%eax; pushfq; popq betterjit_stack_flags_before(%rip); " \
 "mov $0x10,%rax; mov $0x11,%rcx; mov $0x12,%rdx; mov $0x13,%rbx; mov $0x15,%rbp; mov $0x16,%rsi; mov $0x17,%rdi; " \
 "mov $0x18,%r8; mov $0x19,%r9; mov $0x1a,%r10; mov $0x1b,%r11; mov $0x1c,%r12; mov $0x1d,%r13; mov $0x1e,%r14; mov $0x1f,%r15; " \
 "mov betterjit_stack_top(%rip),%rsp; "
#define END \
 "mov betterjit_stack_saved_rsp(%rip),%rsp; pushfq; popq betterjit_stack_flags_after(%rip); " \
 "pop %r15; pop %r14; pop %r13; pop %r12; pop %rbp; pop %rbx; ret; "
#define OP(name,prepare,instruction) __asm__(START(name) prepare SNAP("before") instruction SNAP("after") END);extern void name(unsigned,uint64_t,void*);
OP(push_0,"mov betterjit_stack_value(%rip),%rax; ","push %rax; ")
OP(push_1,"mov betterjit_stack_value(%rip),%rcx; ","push %rcx; ")
OP(push_2,"mov betterjit_stack_value(%rip),%rdx; ","push %rdx; ")
OP(push_3,"mov betterjit_stack_value(%rip),%rbx; ","push %rbx; ")
OP(push_4,"","push %rsp; ")
OP(push_5,"mov betterjit_stack_value(%rip),%rbp; ","push %rbp; ")
OP(push_6,"mov betterjit_stack_value(%rip),%rsi; ","push %rsi; ")
OP(push_7,"mov betterjit_stack_value(%rip),%rdi; ","push %rdi; ")
OP(push_8,"mov betterjit_stack_value(%rip),%r8; ","push %r8; ")
OP(push_9,"mov betterjit_stack_value(%rip),%r9; ","push %r9; ")
OP(push_10,"mov betterjit_stack_value(%rip),%r10; ","push %r10; ")
OP(push_11,"mov betterjit_stack_value(%rip),%r11; ","push %r11; ")
OP(push_12,"mov betterjit_stack_value(%rip),%r12; ","push %r12; ")
OP(push_13,"mov betterjit_stack_value(%rip),%r13; ","push %r13; ")
OP(push_14,"mov betterjit_stack_value(%rip),%r14; ","push %r14; ")
OP(push_15,"mov betterjit_stack_value(%rip),%r15; ","push %r15; ")
OP(pop_0,"","pop %rax; ")
OP(pop_1,"","pop %rcx; ")
OP(pop_2,"","pop %rdx; ")
OP(pop_3,"","pop %rbx; ")
OP(pop_4,"","pop %rsp; ")
OP(pop_5,"","pop %rbp; ")
OP(pop_6,"","pop %rsi; ")
OP(pop_7,"","pop %rdi; ")
OP(pop_8,"","pop %r8; ")
OP(pop_9,"","pop %r9; ")
OP(pop_10,"","pop %r10; ")
OP(pop_11,"","pop %r11; ")
OP(pop_12,"","pop %r12; ")
OP(pop_13,"","pop %r13; ")
OP(pop_14,"","pop %r14; ")
OP(pop_15,"","pop %r15; ")
int main(void){
 void (*const functions[2][16])(unsigned,uint64_t,void*)={
 {push_0,push_1,push_2,push_3,push_4,push_5,push_6,push_7,push_8,push_9,push_10,push_11,push_12,push_13,push_14,push_15},
 {pop_0,pop_1,pop_2,pop_3,pop_4,pop_5,pop_6,pop_7,pop_8,pop_9,pop_10,pop_11,pop_12,pop_13,pop_14,pop_15}};
 const unsigned seeds[]={0,0x7fffffff,0xffffffff,0x80000000};const uint64_t values[]={0,UINT64_MAX,0x123456789abcdef0,0x800000000000};int comma=0;puts("[");
 for(unsigned kind=0;kind<2;kind++)for(unsigned reg=0;reg<16;reg++)for(unsigned seed=0;seed<4;seed++)for(unsigned v=0;v<4;v++){
  unsigned char before[sizeof(storage)],expected[sizeof(storage)];unsigned char* top=storage+4093;memset(storage,0xa5,sizeof(storage));if(kind)memcpy(top,&values[v],8);memcpy(before,storage,sizeof(storage));
  functions[kind][reg](seeds[seed],values[v],top);int preserved=1;
  for(unsigned j=0;j<16;j++)if(j!=4&&(!kind||j!=reg))preserved&=betterjit_stack_before[j]==betterjit_stack_after[j];
  const uint64_t expectedSP=kind?(reg==4?values[v]:betterjit_stack_before[4]+8):betterjit_stack_before[4]-8;
  const uint64_t expectedData=kind?values[v]:betterjit_stack_before[reg];uint64_t data;if(kind)data=betterjit_stack_after[reg];else memcpy(&data,top-8,8);
  memcpy(expected,before,sizeof(expected));if(!kind)memcpy(expected+(top-storage)-8,&expectedData,8);
  printf("%s{\"kind\":\"%s\",\"register\":%u,\"seed\":%u,\"value\":\"0x%"PRIx64"\",\"flagsBefore\":%u,\"flagsAfter\":%u,\"otherGPRsPreserved\":%s,\"stackPointerCorrect\":%s,\"dataCorrect\":%s,\"memoryCorrect\":%s}",
   comma?",\n":"",kind?"pop":"push",reg,seeds[seed],values[v],(unsigned)betterjit_stack_flags_before&0x8d5,(unsigned)betterjit_stack_flags_after&0x8d5,
   preserved?"true":"false",betterjit_stack_after[4]==expectedSP?"true":"false",data==expectedData?"true":"false",memcmp(expected,storage,sizeof(storage))==0?"true":"false");comma=1;
 }puts("\n]");return 0;
}
