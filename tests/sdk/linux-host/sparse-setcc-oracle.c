// SPDX-License-Identifier: GPL-3.0-or-later
// Native x86 SETcc, all 32 condition-flag combinations, independently varying AF/DF.
// Generated literal opcodes: no executable allocation or generated native code.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#define MASK UINT64_C(0xcd5)
#define RUN(instruction,prepare,observe) __asm__ volatile( \
 "pushfq; pop %[original]; push %[seed]; popfq; " prepare instruction "; " observe "; pushfq; pop %[flags]; push %[original]; popfq" \
 : [original] "=&r"(original), [flags] "=&r"(flags), [observed] "=&r"(observed), "+a"(value) \
 : [seed] "r"(seed) : "r11", "r12", "cc", "memory")
static int execute(unsigned cc,unsigned form,uint64_t mask,uint64_t input,uint64_t* outFlags,uint64_t* outValue) {
 uint64_t current,original,flags,observed,value=input;
 __asm__ volatile("pushfq; pop %0" : "=r"(current) :: "memory");
 const uint64_t seed=(current&~MASK)|mask;
 // SPL holds arbitrary data briefly. MOV restores the real RSP before PUSHFQ;
 // POPFQ restores the original DF and arithmetic flags before returning to C.
 switch(cc*7+form) {
 case 0: RUN(".byte 0xf, 0x90, 0xc0","","movq %%rax,%[observed]"); break;
 case 1: RUN(".byte 0xf, 0x90, 0xc4","","movq %%rax,%[observed]"); break;
 case 2: RUN(".byte 0x40, 0xf, 0x90, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 3: RUN(".byte 0x41, 0xf, 0x90, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 4: RUN(".byte 0x4f, 0xf, 0x90, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 5: RUN(".byte 0x66, 0x44, 0xf, 0x90, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 6: RUN(".byte 0x66, 0xf, 0x90, 0xfc","","movq %%rax,%[observed]"); break;
 case 7: RUN(".byte 0xf, 0x91, 0xc0","","movq %%rax,%[observed]"); break;
 case 8: RUN(".byte 0xf, 0x91, 0xc4","","movq %%rax,%[observed]"); break;
 case 9: RUN(".byte 0x40, 0xf, 0x91, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 10: RUN(".byte 0x41, 0xf, 0x91, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 11: RUN(".byte 0x4f, 0xf, 0x91, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 12: RUN(".byte 0x66, 0x44, 0xf, 0x91, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 13: RUN(".byte 0x66, 0xf, 0x91, 0xfc","","movq %%rax,%[observed]"); break;
 case 14: RUN(".byte 0xf, 0x92, 0xc0","","movq %%rax,%[observed]"); break;
 case 15: RUN(".byte 0xf, 0x92, 0xc4","","movq %%rax,%[observed]"); break;
 case 16: RUN(".byte 0x40, 0xf, 0x92, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 17: RUN(".byte 0x41, 0xf, 0x92, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 18: RUN(".byte 0x4f, 0xf, 0x92, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 19: RUN(".byte 0x66, 0x44, 0xf, 0x92, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 20: RUN(".byte 0x66, 0xf, 0x92, 0xfc","","movq %%rax,%[observed]"); break;
 case 21: RUN(".byte 0xf, 0x93, 0xc0","","movq %%rax,%[observed]"); break;
 case 22: RUN(".byte 0xf, 0x93, 0xc4","","movq %%rax,%[observed]"); break;
 case 23: RUN(".byte 0x40, 0xf, 0x93, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 24: RUN(".byte 0x41, 0xf, 0x93, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 25: RUN(".byte 0x4f, 0xf, 0x93, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 26: RUN(".byte 0x66, 0x44, 0xf, 0x93, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 27: RUN(".byte 0x66, 0xf, 0x93, 0xfc","","movq %%rax,%[observed]"); break;
 case 28: RUN(".byte 0xf, 0x94, 0xc0","","movq %%rax,%[observed]"); break;
 case 29: RUN(".byte 0xf, 0x94, 0xc4","","movq %%rax,%[observed]"); break;
 case 30: RUN(".byte 0x40, 0xf, 0x94, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 31: RUN(".byte 0x41, 0xf, 0x94, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 32: RUN(".byte 0x4f, 0xf, 0x94, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 33: RUN(".byte 0x66, 0x44, 0xf, 0x94, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 34: RUN(".byte 0x66, 0xf, 0x94, 0xfc","","movq %%rax,%[observed]"); break;
 case 35: RUN(".byte 0xf, 0x95, 0xc0","","movq %%rax,%[observed]"); break;
 case 36: RUN(".byte 0xf, 0x95, 0xc4","","movq %%rax,%[observed]"); break;
 case 37: RUN(".byte 0x40, 0xf, 0x95, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 38: RUN(".byte 0x41, 0xf, 0x95, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 39: RUN(".byte 0x4f, 0xf, 0x95, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 40: RUN(".byte 0x66, 0x44, 0xf, 0x95, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 41: RUN(".byte 0x66, 0xf, 0x95, 0xfc","","movq %%rax,%[observed]"); break;
 case 42: RUN(".byte 0xf, 0x96, 0xc0","","movq %%rax,%[observed]"); break;
 case 43: RUN(".byte 0xf, 0x96, 0xc4","","movq %%rax,%[observed]"); break;
 case 44: RUN(".byte 0x40, 0xf, 0x96, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 45: RUN(".byte 0x41, 0xf, 0x96, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 46: RUN(".byte 0x4f, 0xf, 0x96, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 47: RUN(".byte 0x66, 0x44, 0xf, 0x96, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 48: RUN(".byte 0x66, 0xf, 0x96, 0xfc","","movq %%rax,%[observed]"); break;
 case 49: RUN(".byte 0xf, 0x97, 0xc0","","movq %%rax,%[observed]"); break;
 case 50: RUN(".byte 0xf, 0x97, 0xc4","","movq %%rax,%[observed]"); break;
 case 51: RUN(".byte 0x40, 0xf, 0x97, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 52: RUN(".byte 0x41, 0xf, 0x97, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 53: RUN(".byte 0x4f, 0xf, 0x97, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 54: RUN(".byte 0x66, 0x44, 0xf, 0x97, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 55: RUN(".byte 0x66, 0xf, 0x97, 0xfc","","movq %%rax,%[observed]"); break;
 case 56: RUN(".byte 0xf, 0x98, 0xc0","","movq %%rax,%[observed]"); break;
 case 57: RUN(".byte 0xf, 0x98, 0xc4","","movq %%rax,%[observed]"); break;
 case 58: RUN(".byte 0x40, 0xf, 0x98, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 59: RUN(".byte 0x41, 0xf, 0x98, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 60: RUN(".byte 0x4f, 0xf, 0x98, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 61: RUN(".byte 0x66, 0x44, 0xf, 0x98, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 62: RUN(".byte 0x66, 0xf, 0x98, 0xfc","","movq %%rax,%[observed]"); break;
 case 63: RUN(".byte 0xf, 0x99, 0xc0","","movq %%rax,%[observed]"); break;
 case 64: RUN(".byte 0xf, 0x99, 0xc4","","movq %%rax,%[observed]"); break;
 case 65: RUN(".byte 0x40, 0xf, 0x99, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 66: RUN(".byte 0x41, 0xf, 0x99, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 67: RUN(".byte 0x4f, 0xf, 0x99, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 68: RUN(".byte 0x66, 0x44, 0xf, 0x99, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 69: RUN(".byte 0x66, 0xf, 0x99, 0xfc","","movq %%rax,%[observed]"); break;
 case 70: RUN(".byte 0xf, 0x9a, 0xc0","","movq %%rax,%[observed]"); break;
 case 71: RUN(".byte 0xf, 0x9a, 0xc4","","movq %%rax,%[observed]"); break;
 case 72: RUN(".byte 0x40, 0xf, 0x9a, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 73: RUN(".byte 0x41, 0xf, 0x9a, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 74: RUN(".byte 0x4f, 0xf, 0x9a, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 75: RUN(".byte 0x66, 0x44, 0xf, 0x9a, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 76: RUN(".byte 0x66, 0xf, 0x9a, 0xfc","","movq %%rax,%[observed]"); break;
 case 77: RUN(".byte 0xf, 0x9b, 0xc0","","movq %%rax,%[observed]"); break;
 case 78: RUN(".byte 0xf, 0x9b, 0xc4","","movq %%rax,%[observed]"); break;
 case 79: RUN(".byte 0x40, 0xf, 0x9b, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 80: RUN(".byte 0x41, 0xf, 0x9b, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 81: RUN(".byte 0x4f, 0xf, 0x9b, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 82: RUN(".byte 0x66, 0x44, 0xf, 0x9b, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 83: RUN(".byte 0x66, 0xf, 0x9b, 0xfc","","movq %%rax,%[observed]"); break;
 case 84: RUN(".byte 0xf, 0x9c, 0xc0","","movq %%rax,%[observed]"); break;
 case 85: RUN(".byte 0xf, 0x9c, 0xc4","","movq %%rax,%[observed]"); break;
 case 86: RUN(".byte 0x40, 0xf, 0x9c, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 87: RUN(".byte 0x41, 0xf, 0x9c, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 88: RUN(".byte 0x4f, 0xf, 0x9c, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 89: RUN(".byte 0x66, 0x44, 0xf, 0x9c, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 90: RUN(".byte 0x66, 0xf, 0x9c, 0xfc","","movq %%rax,%[observed]"); break;
 case 91: RUN(".byte 0xf, 0x9d, 0xc0","","movq %%rax,%[observed]"); break;
 case 92: RUN(".byte 0xf, 0x9d, 0xc4","","movq %%rax,%[observed]"); break;
 case 93: RUN(".byte 0x40, 0xf, 0x9d, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 94: RUN(".byte 0x41, 0xf, 0x9d, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 95: RUN(".byte 0x4f, 0xf, 0x9d, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 96: RUN(".byte 0x66, 0x44, 0xf, 0x9d, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 97: RUN(".byte 0x66, 0xf, 0x9d, 0xfc","","movq %%rax,%[observed]"); break;
 case 98: RUN(".byte 0xf, 0x9e, 0xc0","","movq %%rax,%[observed]"); break;
 case 99: RUN(".byte 0xf, 0x9e, 0xc4","","movq %%rax,%[observed]"); break;
 case 100: RUN(".byte 0x40, 0xf, 0x9e, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 101: RUN(".byte 0x41, 0xf, 0x9e, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 102: RUN(".byte 0x4f, 0xf, 0x9e, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 103: RUN(".byte 0x66, 0x44, 0xf, 0x9e, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 104: RUN(".byte 0x66, 0xf, 0x9e, 0xfc","","movq %%rax,%[observed]"); break;
 case 105: RUN(".byte 0xf, 0x9f, 0xc0","","movq %%rax,%[observed]"); break;
 case 106: RUN(".byte 0xf, 0x9f, 0xc4","","movq %%rax,%[observed]"); break;
 case 107: RUN(".byte 0x40, 0xf, 0x9f, 0xc4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 108: RUN(".byte 0x41, 0xf, 0x9f, 0xc4","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 109: RUN(".byte 0x4f, 0xf, 0x9f, 0xfc","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
 case 110: RUN(".byte 0x66, 0x44, 0xf, 0x9f, 0xe4","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
 case 111: RUN(".byte 0x66, 0xf, 0x9f, 0xfc","","movq %%rax,%[observed]"); break;
 default:return 2;
 }
 *outFlags=flags&MASK; *outValue=observed; return 0;
}
int main(void) {
 const uint64_t inputs[]={0,UINT64_MAX,UINT64_C(0x1122334455667788),UINT64_C(0xfedcba9800008000)};
 unsigned first=1;
 printf("{\"inputs\":[");
 for(unsigned i=0;i<4;i++)printf("%s\"0x%016" PRIx64 "\"",i?",":"",inputs[i]);
 printf("],\"rows\":[\n");
 for(unsigned cc=0;cc<16;cc++)for(unsigned bits=0;bits<128;bits++)for(unsigned form=0;form<7;form++){
  const unsigned positions[]={0,2,6,7,11,4,10};uint64_t mask=0;
  for(unsigned b=0;b<7;b++)mask|=(uint64_t)((bits>>b)&1)<<positions[b];
  uint64_t values[4],flags=0;
  for(unsigned i=0;i<4;i++){
   if(execute(cc,form,mask,inputs[i],&flags,&values[i])||flags!=mask)return 3;
   const unsigned shift=form==1||form==6?8:0;
   if((values[i]&~(UINT64_C(255)<<shift))!=(inputs[i]&~(UINT64_C(255)<<shift))||((values[i]>>shift)&255)>1)return 4;
  }
  printf("%s[%u,%" PRIu64 ",%u,%" PRIu64 ",[",first?"":",\n",cc,mask,form,flags);first=0;
  for(unsigned i=0;i<4;i++)printf("%s\"0x%016" PRIx64 "\"",i?",":"",values[i]);
  printf("]]");
 }
 printf("\n]}\n");return 0;
}
