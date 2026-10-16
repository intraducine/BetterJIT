// SPDX-License-Identifier: GPL-3.0-or-later
// Independent native x86 TEST: five defined logical flags, full operand preservation.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#define RUN(instruction,prepare,observe) __asm__ volatile( \
  "testl %[seed],%[seed]; jnz 1f; movl $0x80000000,%%r9d; addl %%r9d,%%r9d; jmp 2f; " \
  "1: movq $0,%%r9; subq $1,%%r9; 2: " prepare instruction "; " observe "; pushfq; pop %[flags]" \
  : [flags] "=&r"(flags), [observed] "=&r"(observed), "+a"(value) \
  : [seed] "r"(seed) : "r8", "r9", "r11", "r12", "cc", "memory")
static int execute(unsigned width,unsigned form,unsigned mask,unsigned seed,uint64_t input,uint64_t* outFlags,uint64_t* outValue) {
  uint64_t value=input,flags=0,observed=0;
  // SPL is data: restore the real host stack with MOV before PUSHFQ.
  switch(width*8+form) {
  case 8: switch(mask) {
    case 0: RUN(".byte 0xf6,0xc0,0x0","","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0xf6,0xc0,0x1","","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0xf6,0xc0,0x7f","","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0xf6,0xc0,0x80","","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0xf6,0xc0,0xff","","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0xf6,0xc0,0x55","","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0xf6,0xc0,0xaa","","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0xf6,0xc0,0xfe","","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 9: switch(mask) {
    case 0: RUN(".byte 0xf6,0xc4,0x0","","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0xf6,0xc4,0x1","","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0xf6,0xc4,0x7f","","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0xf6,0xc4,0x80","","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0xf6,0xc4,0xff","","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0xf6,0xc4,0x55","","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0xf6,0xc4,0xaa","","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0xf6,0xc4,0xfe","","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 10: switch(mask) {
    case 0: RUN(".byte 0x40,0xf6,0xc4,0x0","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
    case 1: RUN(".byte 0x40,0xf6,0xc4,0x1","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
    case 2: RUN(".byte 0x40,0xf6,0xc4,0x7f","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
    case 3: RUN(".byte 0x40,0xf6,0xc4,0x80","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
    case 4: RUN(".byte 0x40,0xf6,0xc4,0xff","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
    case 5: RUN(".byte 0x40,0xf6,0xc4,0x55","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
    case 6: RUN(".byte 0x40,0xf6,0xc4,0xaa","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
    case 7: RUN(".byte 0x40,0xf6,0xc4,0xfe","movq %%rsp,%%r11; movq %%rax,%%rsp; ","movq %%rsp,%[observed]; movq %%r11,%%rsp"); break;
    default: return 2; } break;
  case 11: switch(mask) {
    case 0: RUN(".byte 0x41,0xf6,0xc4,0x0","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 1: RUN(".byte 0x41,0xf6,0xc4,0x1","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 2: RUN(".byte 0x41,0xf6,0xc4,0x7f","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 3: RUN(".byte 0x41,0xf6,0xc4,0x80","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 4: RUN(".byte 0x41,0xf6,0xc4,0xff","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 5: RUN(".byte 0x41,0xf6,0xc4,0x55","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 6: RUN(".byte 0x41,0xf6,0xc4,0xaa","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 7: RUN(".byte 0x41,0xf6,0xc4,0xfe","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    default: return 2; } break;
  case 12: switch(mask) {
    case 0: RUN(".byte 0x41,0xa8,0x0","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0x41,0xa8,0x1","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0x41,0xa8,0x7f","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0x41,0xa8,0x80","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0x41,0xa8,0xff","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0x41,0xa8,0x55","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0x41,0xa8,0xaa","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0x41,0xa8,0xfe","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 16: switch(mask) {
    case 0: RUN(".byte 0x66,0xf7,0xc0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0x66,0xf7,0xc0,0x1,0x0","","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0x66,0xf7,0xc0,0xff,0x7f","","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0x66,0xf7,0xc0,0x0,0x80","","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0x66,0xf7,0xc0,0xff,0xff","","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0x66,0xf7,0xc0,0xaa,0x55","","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0x66,0xf7,0xc0,0x80,0x0","","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0x66,0xf7,0xc0,0x0,0xff","","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 20: switch(mask) {
    case 0: RUN(".byte 0x66,0x41,0xa9,0x0,0x0","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0x66,0x41,0xa9,0x1,0x0","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0x66,0x41,0xa9,0xff,0x7f","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0x66,0x41,0xa9,0x0,0x80","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0x66,0x41,0xa9,0xff,0xff","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0x66,0x41,0xa9,0xaa,0x55","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0x66,0x41,0xa9,0x80,0x0","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0x66,0x41,0xa9,0x0,0xff","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 32: switch(mask) {
    case 0: RUN(".byte 0xf7,0xc0,0x0,0x0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0xf7,0xc0,0x1,0x0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0xf7,0xc0,0xff,0xff,0xff,0x7f","","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0xf7,0xc0,0x0,0x0,0x0,0x80","","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0xf7,0xc0,0xff,0xff,0xff,0xff","","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0xf7,0xc0,0xaa,0x55,0xaa,0x55","","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0xf7,0xc0,0x80,0x0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0xf7,0xc0,0x0,0x0,0xff,0xff","","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 36: switch(mask) {
    case 0: RUN(".byte 0x41,0xa9,0x0,0x0,0x0,0x0","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0x41,0xa9,0x1,0x0,0x0,0x0","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0x41,0xa9,0xff,0xff,0xff,0x7f","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0x41,0xa9,0x0,0x0,0x0,0x80","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0x41,0xa9,0xff,0xff,0xff,0xff","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0x41,0xa9,0xaa,0x55,0xaa,0x55","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0x41,0xa9,0x80,0x0,0x0,0x0","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0x41,0xa9,0x0,0x0,0xff,0xff","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 64: switch(mask) {
    case 0: RUN(".byte 0x48,0xf7,0xc0,0x0,0x0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0x48,0xf7,0xc0,0x1,0x0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0x48,0xf7,0xc0,0xff,0xff,0xff,0x7f","","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0x48,0xf7,0xc0,0x0,0x0,0x0,0x80","","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0x48,0xf7,0xc0,0xff,0xff,0xff,0xff","","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0x48,0xf7,0xc0,0xaa,0x55,0xaa,0x55","","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0x48,0xf7,0xc0,0x80,0x0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0x48,0xf7,0xc0,0x0,0x0,0xff,0xff","","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 68: switch(mask) {
    case 0: RUN(".byte 0x49,0xa9,0x0,0x0,0x0,0x0","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0x49,0xa9,0x1,0x0,0x0,0x0","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0x49,0xa9,0xff,0xff,0xff,0x7f","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0x49,0xa9,0x0,0x0,0x0,0x80","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0x49,0xa9,0xff,0xff,0xff,0xff","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0x49,0xa9,0xaa,0x55,0xaa,0x55","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0x49,0xa9,0x80,0x0,0x0,0x0","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0x49,0xa9,0x0,0x0,0xff,0xff","movq %%rax,%%r8; notq %%r8; ","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 13: switch(mask) {
    case 0: RUN(".byte 0x46,0xf6,0xc0,0x0","","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0x46,0xf6,0xc0,0x1","","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0x46,0xf6,0xc0,0x7f","","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0x46,0xf6,0xc0,0x80","","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0x46,0xf6,0xc0,0xff","","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0x46,0xf6,0xc0,0x55","","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0x46,0xf6,0xc0,0xaa","","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0x46,0xf6,0xc0,0xfe","","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 21: switch(mask) {
    case 0: RUN(".byte 0x66,0x46,0xf7,0xc0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0x66,0x46,0xf7,0xc0,0x1,0x0","","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0x66,0x46,0xf7,0xc0,0xff,0x7f","","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0x66,0x46,0xf7,0xc0,0x0,0x80","","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0x66,0x46,0xf7,0xc0,0xff,0xff","","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0x66,0x46,0xf7,0xc0,0xaa,0x55","","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0x66,0x46,0xf7,0xc0,0x80,0x0","","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0x66,0x46,0xf7,0xc0,0x0,0xff","","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 19: switch(mask) {
    case 0: RUN(".byte 0x66,0x41,0xf7,0xc4,0x0,0x0","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 1: RUN(".byte 0x66,0x41,0xf7,0xc4,0x1,0x0","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 2: RUN(".byte 0x66,0x41,0xf7,0xc4,0xff,0x7f","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 3: RUN(".byte 0x66,0x41,0xf7,0xc4,0x0,0x80","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 4: RUN(".byte 0x66,0x41,0xf7,0xc4,0xff,0xff","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 5: RUN(".byte 0x66,0x41,0xf7,0xc4,0xaa,0x55","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 6: RUN(".byte 0x66,0x41,0xf7,0xc4,0x80,0x0","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 7: RUN(".byte 0x66,0x41,0xf7,0xc4,0x0,0xff","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    default: return 2; } break;
  case 37: switch(mask) {
    case 0: RUN(".byte 0x46,0xf7,0xc0,0x0,0x0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0x46,0xf7,0xc0,0x1,0x0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0x46,0xf7,0xc0,0xff,0xff,0xff,0x7f","","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0x46,0xf7,0xc0,0x0,0x0,0x0,0x80","","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0x46,0xf7,0xc0,0xff,0xff,0xff,0xff","","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0x46,0xf7,0xc0,0xaa,0x55,0xaa,0x55","","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0x46,0xf7,0xc0,0x80,0x0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0x46,0xf7,0xc0,0x0,0x0,0xff,0xff","","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 35: switch(mask) {
    case 0: RUN(".byte 0x41,0xf7,0xc4,0x0,0x0,0x0,0x0","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 1: RUN(".byte 0x41,0xf7,0xc4,0x1,0x0,0x0,0x0","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 2: RUN(".byte 0x41,0xf7,0xc4,0xff,0xff,0xff,0x7f","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 3: RUN(".byte 0x41,0xf7,0xc4,0x0,0x0,0x0,0x80","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 4: RUN(".byte 0x41,0xf7,0xc4,0xff,0xff,0xff,0xff","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 5: RUN(".byte 0x41,0xf7,0xc4,0xaa,0x55,0xaa,0x55","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 6: RUN(".byte 0x41,0xf7,0xc4,0x80,0x0,0x0,0x0","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 7: RUN(".byte 0x41,0xf7,0xc4,0x0,0x0,0xff,0xff","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    default: return 2; } break;
  case 69: switch(mask) {
    case 0: RUN(".byte 0x4e,0xf7,0xc0,0x0,0x0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 1: RUN(".byte 0x4e,0xf7,0xc0,0x1,0x0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 2: RUN(".byte 0x4e,0xf7,0xc0,0xff,0xff,0xff,0x7f","","movq %%rax,%[observed]"); break;
    case 3: RUN(".byte 0x4e,0xf7,0xc0,0x0,0x0,0x0,0x80","","movq %%rax,%[observed]"); break;
    case 4: RUN(".byte 0x4e,0xf7,0xc0,0xff,0xff,0xff,0xff","","movq %%rax,%[observed]"); break;
    case 5: RUN(".byte 0x4e,0xf7,0xc0,0xaa,0x55,0xaa,0x55","","movq %%rax,%[observed]"); break;
    case 6: RUN(".byte 0x4e,0xf7,0xc0,0x80,0x0,0x0,0x0","","movq %%rax,%[observed]"); break;
    case 7: RUN(".byte 0x4e,0xf7,0xc0,0x0,0x0,0xff,0xff","","movq %%rax,%[observed]"); break;
    default: return 2; } break;
  case 67: switch(mask) {
    case 0: RUN(".byte 0x49,0xf7,0xc4,0x0,0x0,0x0,0x0","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 1: RUN(".byte 0x49,0xf7,0xc4,0x1,0x0,0x0,0x0","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 2: RUN(".byte 0x49,0xf7,0xc4,0xff,0xff,0xff,0x7f","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 3: RUN(".byte 0x49,0xf7,0xc4,0x0,0x0,0x0,0x80","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 4: RUN(".byte 0x49,0xf7,0xc4,0xff,0xff,0xff,0xff","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 5: RUN(".byte 0x49,0xf7,0xc4,0xaa,0x55,0xaa,0x55","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 6: RUN(".byte 0x49,0xf7,0xc4,0x80,0x0,0x0,0x0","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    case 7: RUN(".byte 0x49,0xf7,0xc4,0x0,0x0,0xff,0xff","movq %%rax,%%r12; ","movq %%r12,%[observed]"); break;
    default: return 2; } break;
  default: return 3;
  }
  if(value!=input||observed!=input)return 4;
  *outFlags=flags&0x8c5;*outValue=observed;return 0;
}
int main(void) {
  const uint64_t values[]={0,1,0x80,0xff,0x8000,0xffff,0x80000000,0xffffffff,
    UINT64_C(0x8000000000000000),UINT64_C(0x1122334400000000),UINT64_C(0x1122334480000000),
    UINT64_C(0xfedcba9887654321),UINT64_MAX};
  int comma=0;puts("[");
  for(unsigned width=1;width<=8;width*=2)for(unsigned form=0;form<6;form++) {
    if(width!=1&&form!=0&&form!=3&&form!=4&&form!=5)continue;
    for(unsigned mask=0;mask<8;mask++)for(unsigned i=0;i<sizeof(values)/sizeof(values[0]);i++)for(unsigned seed=0;seed<2;seed++) {
      uint64_t flags,observed;int result=execute(width,form,mask,seed,values[i],&flags,&observed);if(result)return result;
      printf("%s[%u,%u,%u,%u,\"0x%" PRIx64 "\",\"0x%" PRIx64 "\",%u]",comma?",\n":"",width,mask,form,seed,values[i],observed,(unsigned)flags);comma=1;
    }
  }
  puts("\n]");return 0;
}
