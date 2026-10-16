// SPDX-License-Identifier: GPL-3.0-or-later
// Native x86-64 oracle: execute each supplied NOP and compare all GPRs and
// complete RFLAGS. Executable host test bytes are never guest FEX/JIT evidence.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

uint64_t fex_nop_before[16],fex_nop_after[16],fex_nop_stack;
uint64_t fex_nop_flags_before,fex_nop_flags_after;
uint32_t fex_nop_fa,fex_nop_fb,fex_nop_df;
void *fex_nop_code;
extern void fex_nop_run(void),fex_nop_resume(void);
static int hex(char c) {return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:-1;}
int main(int argc,char **argv) {
  const uint64_t addresses[]={0,UINT64_C(0x123456780000),UINT64_C(0x0100000000000000),UINT64_MAX};
  const uint32_t seeds[][2]={{0,0},{0x7f,1},{0xffffffff,1},{0x80000000,0x80000000},{0x7fffffff,1},{0x80000000,1}};
  uint64_t executions=0;unsigned flags[6]={0};
  if(argc<2)return 1;
  uint8_t *code=mmap(NULL,4096,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  if(code==MAP_FAILED)return 2;
  fex_nop_code=code;
  for(int form=1;form<argc;form++) {
    const size_t length=strlen(argv[form])/2;
    if(!length||length>15||strlen(argv[form])!=length*2)return 3;
    if(mprotect(code,4096,PROT_READ|PROT_WRITE))return 4;
    for(size_t i=0;i<length;i++) {
      int hi=hex(argv[form][i*2]),lo=hex(argv[form][i*2+1]);if(hi<0||lo<0)return 5;
      code[i]=(uint8_t)((hi<<4)|lo);
    }
    // An indirect jump through an inline pointer avoids touching any GPR or
    // the arbitrary test RSP before the assembly trampoline restores it.
    const uint8_t jump[]={0xff,0x25,0,0,0,0};void *resume=(void *)fex_nop_resume;
    memcpy(code+length,jump,sizeof(jump));memcpy(code+length+sizeof(jump),&resume,sizeof(resume));
    if(mprotect(code,4096,PROT_READ|PROT_EXEC))return 6;
    for(unsigned address=0;address<4;address++)for(unsigned seed=0;seed<6;seed++)for(unsigned df=0;df<2;df++) {
      for(unsigned reg=0;reg<16;reg++)fex_nop_before[reg]=addresses[address]+reg*8;
      memset(fex_nop_after,0,sizeof(fex_nop_after));fex_nop_fa=seeds[seed][0];fex_nop_fb=seeds[seed][1];fex_nop_df=df;
      fex_nop_run();
      if(memcmp(fex_nop_before,fex_nop_after,sizeof(fex_nop_before))||fex_nop_flags_before!=fex_nop_flags_after) {
        fprintf(stderr,"Native NOP changed state: %s, address %u, seed %u, DF %u\n",argv[form],address,seed,df);return 7;
      }
      flags[seed]=(unsigned)fex_nop_flags_after&0x8d5;executions++;
    }
  }
  if(munmap(code,4096))return 8;
  printf("{\"forms\":%d,\"executions\":%"PRIu64",\"addresses\":[\"0x0\",\"0x123456780000\",\"0x100000000000000\",\"0xffffffffffffffff\"],\"flags\":[",argc-1,executions);
  for(unsigned i=0;i<6;i++)printf("%s%u",i?",":"",flags[i]);
  puts("],\"registersUnchanged\":16,\"fullRFLAGSUnchanged\":true,\"directionFlagStates\":[0,1]}");
  return 0;
}
