// SPDX-License-Identifier: GPL-3.0-or-later
// Native Linux x86-64 JMP r64 oracle. Only local labels are executed.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
uint64_t betterjit_jump_before[16],betterjit_jump_after[16],betterjit_jump_saved_rsp,betterjit_jump_flags_before,betterjit_jump_flags_after;
#define SNAP(name) \
  "mov %rax,betterjit_jump_" name "+0(%rip); " \
  "mov %rcx,betterjit_jump_" name "+8(%rip); " \
  "mov %rdx,betterjit_jump_" name "+16(%rip); " \
  "mov %rbx,betterjit_jump_" name "+24(%rip); " \
  "mov %rsp,betterjit_jump_" name "+32(%rip); " \
  "mov %rbp,betterjit_jump_" name "+40(%rip); " \
  "mov %rsi,betterjit_jump_" name "+48(%rip); " \
  "mov %rdi,betterjit_jump_" name "+56(%rip); " \
  "mov %r8,betterjit_jump_" name "+64(%rip); " \
  "mov %r9,betterjit_jump_" name "+72(%rip); " \
  "mov %r10,betterjit_jump_" name "+80(%rip); " \
  "mov %r11,betterjit_jump_" name "+88(%rip); " \
  "mov %r12,betterjit_jump_" name "+96(%rip); " \
  "mov %r13,betterjit_jump_" name "+104(%rip); " \
  "mov %r14,betterjit_jump_" name "+112(%rip); " \
  "mov %r15,betterjit_jump_" name "+120(%rip); "
#define JUMP(name,reg) \
__asm__(".text; .globl " #name "; " #name ": " \
 "push %rbx; push %rbp; push %r12; push %r13; push %r14; push %r15; " \
 "mov %rsp,betterjit_jump_saved_rsp(%rip); mov %edi,%eax; addl $1,%eax; " \
 "pushfq; popq betterjit_jump_flags_before(%rip); " \
 "mov $0x10,%rax; mov $0x11,%rcx; mov $0x12,%rdx; mov $0x13,%rbx; " \
 "mov $0x15,%rbp; mov $0x16,%rsi; mov $0x17,%rdi; " \
 "mov $0x18,%r8; mov $0x19,%r9; mov $0x1a,%r10; mov $0x1b,%r11; " \
 "mov $0x1c,%r12; mov $0x1d,%r13; mov $0x1e,%r14; mov $0x1f,%r15; " \
 "lea 1f(%rip),%" #reg "; " SNAP("before") \
 "jmp *%" #reg "; ud2; 1: " SNAP("after") \
 "mov betterjit_jump_saved_rsp(%rip),%rsp; pushfq; popq betterjit_jump_flags_after(%rip); " \
 "pop %r15; pop %r14; pop %r13; pop %r12; pop %rbp; pop %rbx; ret; "); \
extern void name(unsigned);
JUMP(jump_0,rax)
JUMP(jump_1,rcx)
JUMP(jump_2,rdx)
JUMP(jump_3,rbx)
JUMP(jump_4,rsp)
JUMP(jump_5,rbp)
JUMP(jump_6,rsi)
JUMP(jump_7,rdi)
JUMP(jump_8,r8)
JUMP(jump_9,r9)
JUMP(jump_10,r10)
JUMP(jump_11,r11)
JUMP(jump_12,r12)
JUMP(jump_13,r13)
JUMP(jump_14,r14)
JUMP(jump_15,r15)
int main(void) {
 void (*const functions[])(unsigned)={jump_0,jump_1,jump_2,jump_3,jump_4,jump_5,jump_6,jump_7,jump_8,jump_9,jump_10,jump_11,jump_12,jump_13,jump_14,jump_15};
 const unsigned seeds[]={0,0x7fffffff,0xffffffff,0x80000000};int comma=0;puts("[");
 for(unsigned reg=0;reg<16;reg++)for(unsigned i=0;i<4;i++) {
  functions[reg](seeds[i]);int same=1;
  for(unsigned j=0;j<16;j++)same&=betterjit_jump_before[j]==betterjit_jump_after[j];
  printf("%s{\"register\":%u,\"seed\":%u,\"flagsBefore\":%u,\"flagsAfter\":%u,\"allGPRsPreserved\":%s}",
   comma?",\n":"",reg,seeds[i],(unsigned)betterjit_jump_flags_before&0x8d5,(unsigned)betterjit_jump_flags_after&0x8d5,same?"true":"false");comma=1;
 }puts("\n]");return 0;
}
