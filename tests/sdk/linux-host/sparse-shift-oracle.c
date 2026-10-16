// SPDX-License-Identifier: GPL-3.0-or-later
// Native x86 register shifts. Retain only architecturally defined flag bits.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#define COUNTS(X) X(0) X(1) X(2) X(7) X(8) X(15) X(16) X(31) X(32) X(33) X(63) X(64) X(65) X(127) X(128) X(129) X(255)
#define TEXT_(x) #x
#define TEXT(x) TEXT_(x)
// Seed exactly the same ADD32/SUB64 lazy states as the FEX/Wasm test. Jumps
// preserve the seeded flags; capture immediately before/after the shift.
#define RUN(instruction) __asm__ volatile( \
  "cmpl $1,%%edx; je 1f; cmpl $2,%%edx; je 2f; " \
  "movl $0x80000000,%%r9d; addl %%r9d,%%r9d; jmp 3f; " \
  "1: movq $0,%%r9; subq $1,%%r9; jmp 3f; " \
  "2: movl $1,%%r9d; addl %%r9d,%%r9d; " \
  "3: pushfq; pop %[before]; " instruction "; pushfq; pop %[after]" \
  : [before] "=&r"(before), [after] "=&r"(after), "+a"(result), "+c"(counter) \
  : "d"(seed) : "r9", "cc", "memory")
#define IMM_CASE(n) case n: RUN(".byte " IMM TEXT(n)); break;
#define FORMS(op,reg,alias) do { \
  if(form==0){RUN(op " %%cl," reg);} \
  else if(form==1){switch(count){COUNTS(IMM_CASE)}} \
  else if(form==2){RUN(op " $1," reg);} \
  else {RUN(op " %%cl," alias);} \
}while(0)
int main(void) {
  const uint64_t values[]={0,1,15,UINT64_C(0x7fffffff),UINT64_C(0x80000000),UINT64_C(0xffffffff),
    UINT64_C(0x7fffffffffffffff),UINT64_C(0x8000000000000001),UINT64_C(0x1234567880000000),UINT64_C(0xfedcba9887654321)};
#define ITEM(n) n,
  const unsigned counts[]={COUNTS(ITEM)};
#undef ITEM
  int comma=0;puts("[");
  for(unsigned kind=0;kind<3;kind++)for(unsigned width=4;width<=8;width+=4)for(unsigned form=0;form<4;form++)
  for(unsigned a=0;a<sizeof(values)/sizeof(values[0]);a++)for(unsigned seed=0;seed<3;seed++)
  for(unsigned c=0;c<(form>=2?1:sizeof(counts)/sizeof(counts[0]));c++) {
    const unsigned count=form==2?1:form==3?(unsigned)(values[a]&255):counts[c];
    uint64_t result=values[a],counter=form==3?values[a]:UINT64_C(0x1122334455667700)|count,before,after;
    const uint64_t oldCounter=counter;
    if(width==8) {
      if(kind==0) {
#define OP "shlq"
#define IMM "0x48,0xc1,0xe0,"
#define REG "%%rax"
        FORMS(OP,REG,"%%rcx");
#undef OP
#undef IMM
#undef REG
      } else if(kind==1) {
#define OP "shrq"
#define IMM "0x48,0xc1,0xe8,"
#define REG "%%rax"
        FORMS(OP,REG,"%%rcx");
#undef OP
#undef IMM
#undef REG
      } else {
#define OP "sarq"
#define IMM "0x48,0xc1,0xf8,"
#define REG "%%rax"
        FORMS(OP,REG,"%%rcx");
#undef OP
#undef IMM
#undef REG
      }
    } else {
      if(kind==0) {
#define OP "shll"
#define IMM "0xc1,0xe0,"
#define REG "%%eax"
        FORMS(OP,REG,"%%ecx");
#undef OP
#undef IMM
#undef REG
      } else if(kind==1) {
#define OP "shrl"
#define IMM "0xc1,0xe8,"
#define REG "%%eax"
        FORMS(OP,REG,"%%ecx");
#undef OP
#undef IMM
#undef REG
      } else {
#define OP "sarl"
#define IMM "0xc1,0xf8,"
#define REG "%%eax"
        FORMS(OP,REG,"%%ecx");
#undef OP
#undef IMM
#undef REG
      }
    }
    if(form!=3&&counter!=oldCounter)return 1;
    if(form==3){if(result!=values[a])return 2;result=counter;}
    const unsigned effective=count&(width==8?63:31),mask=effective==0?0x8d5:effective==1?0x8c5:0xc5;
    // columns: kind(0SHL/1SHR/2SAR), width, form(0CL/1imm8/2one/3RCXalias),
    // raw count, seed, input, full64-bit destination, flags before, flags after,
    // defined-flag mask. AF(nonzero) and OF(count>1) are deliberately absent.
    printf("%s[%u,%u,%u,%u,%u,\"0x%" PRIx64 "\",\"0x%" PRIx64 "\",%u,%u,%u]",comma?",\n":"",kind,width,form,count,seed,values[a],result,(unsigned)before&0x8d5,(unsigned)after&mask,mask);
    comma=1;
  }
  puts("\n]");return 0;
}
