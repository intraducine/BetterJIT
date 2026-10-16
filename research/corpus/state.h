// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic corpus measurement protocol. Contains architectural state only.
#pragma once
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#define CORPUS_CODE UINT64_C(0x400400000)
#define CORPUS_STACK UINT64_C(0x4006f0000)
#define CORPUS_SP UINT64_C(0x4006ffff0)
#define CORPUS_MAP_BYTES 65536u
typedef struct {
  uint64_t rip,rflags,gpr[16],xmm[16][2],mm[8][2];
  uint32_t mxcsr;
  uint16_t fcw,fsw,ftw;
} corpus_state;
static void corpus_hex(const unsigned char* p,size_t n) {
  static const char digits[]="0123456789abcdef";
  for(size_t i=0;i<n;i++){putchar(digits[p[i]>>4]);putchar(digits[p[i]&15]);}
}
static void corpus_print(const corpus_state* s,const unsigned char* code,const unsigned char* stack,const char* method,unsigned blocks) {
  printf("{\"schema\":1,\"method\":\"%s\",\"termination\":\"hlt\",\"blocks\":%u,\"state\":{\"RIP\":\"0x%016" PRIx64 "\",\"RFLAGS\":\"0x%016" PRIx64 "\",\"GPR\":[",method,blocks,s->rip,s->rflags);
  for(unsigned r=0;r<16;r++)printf("%s\"0x%016" PRIx64 "\"",r?",":"",s->gpr[r]);
  printf("],\"XMM\":[");for(unsigned r=0;r<16;r++)printf("%s[\"0x%016" PRIx64 "\",\"0x%016" PRIx64 "\"]",r?",":"",s->xmm[r][0],s->xmm[r][1]);
  printf("],\"MM\":[");for(unsigned r=0;r<8;r++)printf("%s[\"0x%016" PRIx64 "\",\"0x%04x\"]",r?",":"",s->mm[r][0],(unsigned)s->mm[r][1]&65535);
  printf("],\"MXCSR\":%u,\"FCW\":%u,\"FSW\":%u,\"FTW\":%u},\"codeHex\":\"",s->mxcsr,s->fcw,s->fsw,s->ftw);
  corpus_hex(code,CORPUS_MAP_BYTES);printf("\",\"stackHex\":\"");corpus_hex(stack,CORPUS_MAP_BYTES);puts("\"}");
}
