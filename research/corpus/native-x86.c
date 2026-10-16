// SPDX-License-Identifier: GPL-3.0-or-later
#define _GNU_SOURCE
#include "state.h"
#include <errno.h>
#include <setjmp.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <ucontext.h>
#include <unistd.h>
uint64_t corpus_entry=CORPUS_CODE;
uint32_t corpus_mxcsr=0x1f80;
extern void corpus_enter(void);
static corpus_state observed;
static sigjmp_buf resume;
static unsigned char alternate[65536];
static volatile sig_atomic_t stopped_signal,stopped_code,stopped_trap,fp_valid;
static void capture(int sig,siginfo_t* info,void* opaque) {
  __asm__ volatile("cld");
  const ucontext_t* u=opaque;const greg_t* g=u->uc_mcontext.gregs;
  const unsigned order[16]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
  for(unsigned r=0;r<16;r++)observed.gpr[r]=(uint64_t)g[order[r]];
  observed.rip=(uint64_t)g[REG_RIP];observed.rflags=(uint64_t)g[REG_EFL];
  const struct _libc_fpstate* fp=u->uc_mcontext.fpregs;
  if(fp){fp_valid=1;observed.mxcsr=fp->mxcsr;observed.fcw=fp->cwd;observed.fsw=fp->swd;observed.ftw=fp->ftw;
    for(unsigned r=0;r<16;r++)for(unsigned q=0;q<2;q++){uint64_t n=0;memcpy(&n,((const unsigned char*)&fp->_xmm[r])+8*q,8);observed.xmm[r][q]=n;}
    const unsigned top=(fp->swd>>11)&7;
    for(unsigned r=0;r<8;r++){uint64_t n=0;memcpy(&n,&fp->_st[r],8);observed.mm[(top+r)&7][0]=n;observed.mm[(top+r)&7][1]=fp->_st[r].exponent;}}
  stopped_signal=sig;stopped_code=info->si_code;stopped_trap=(sig_atomic_t)g[REG_TRAPNO];siglongjmp(resume,1);
}
static void* map_at(uint64_t at) {
  void* p=mmap((void*)(uintptr_t)at,CORPUS_MAP_BYTES,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  if(p==MAP_FAILED||p!=(void*)(uintptr_t)at){if(p!=MAP_FAILED)munmap(p,CORPUS_MAP_BYTES);return NULL;}return p;
}
int main(int argc,char** argv) {
  if(argc!=4)return 2;
  const size_t halt=(size_t)strtoull(argv[2],NULL,0),writable=(size_t)strtoull(argv[3],NULL,0);
  unsigned char* code=map_at(CORPUS_CODE);unsigned char* stack=map_at(CORPUS_STACK);
  if(!code||!stack){puts("{\"status\":\"skip\",\"reason\":\"requested synthetic guest address unavailable\"}");return 77;}
  FILE* file=fopen(argv[1],"rb");if(!file)return 2;
  const size_t count=fread(code,1,CORPUS_MAP_BYTES,file);int extra=fgetc(file);fclose(file);
  if(!count||extra!=EOF||halt>=count||code[halt]!=0xf4)return 2;
  const long page=sysconf(_SC_PAGESIZE);size_t executable=writable?writable:(count+(size_t)page-1)&~((size_t)page-1);
  if(executable>(size_t)CORPUS_MAP_BYTES||executable<(halt+1)||mprotect(code,executable,PROT_READ|PROT_EXEC))return 2;
  stack_t alt={.ss_sp=alternate,.ss_size=sizeof(alternate)};if(sigaltstack(&alt,NULL))return 2;
  struct sigaction action={0};action.sa_sigaction=capture;action.sa_flags=SA_SIGINFO|SA_ONSTACK;sigemptyset(&action.sa_mask);
  for(unsigned i=0;i<4;i++){const int signals[]={SIGSEGV,SIGILL,SIGBUS,SIGFPE};if(sigaction(signals[i],&action,NULL))return 2;}
  struct rlimit cpu={3,4};setrlimit(RLIMIT_CPU,&cpu);
  if(!sigsetjmp(resume,1))corpus_enter();
  if(stopped_signal!=SIGSEGV||stopped_trap!=13||!fp_valid||observed.rip!=CORPUS_CODE+halt){fprintf(stderr,"Unexpected native fixture fault: signal=%d code=%d trap=%d rip=0x%"PRIx64"\n",stopped_signal,stopped_code,stopped_trap,observed.rip);return 1;}
  corpus_print(&observed,code,stack,"linux-x86-64-hlt-oracle",0);munmap(code,CORPUS_MAP_BYTES);munmap(stack,CORPUS_MAP_BYTES);return 0;
}
