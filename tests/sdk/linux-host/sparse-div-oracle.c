// SPDX-License-Identifier: GPL-3.0-or-later
// Native Linux x86 unsigned DIV success and precise #DE oracle.
#define _GNU_SOURCE
#include <inttypes.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <ucontext.h>
static sigjmp_buf recovery;
static volatile uintptr_t wanted_rip;
static volatile uint64_t fault_a,fault_d,fault_c,fault_flags;
static volatile sig_atomic_t fault_code,fault_trap,fault_error,fault_rip_exact;
static void caught(int signal,siginfo_t* info,void* raw){
 __asm__ volatile("cld":::"cc");
 ucontext_t* c=raw;(void)signal;fault_a=c->uc_mcontext.gregs[REG_RAX];fault_d=c->uc_mcontext.gregs[REG_RDX];fault_c=c->uc_mcontext.gregs[REG_RCX];fault_flags=c->uc_mcontext.gregs[REG_EFL];
 fault_code=info->si_code;fault_trap=c->uc_mcontext.gregs[REG_TRAPNO];fault_error=c->uc_mcontext.gregs[REG_ERR];fault_rip_exact=(uintptr_t)c->uc_mcontext.gregs[REG_RIP]==wanted_rip;siglongjmp(recovery,1);
}
#define RUN(instruction) __asm__ volatile("pushq %[before]; popfq; leaq 1f(%%rip),%%r11; movq %%r11,%[wanted]; 1: " instruction "; pushfq; popq %[after]; cld" : "+a"(a),"+d"(d),"+c"(c),[after]"=r"(after),[wanted]"=m"(wanted_rip) : [before]"r"(before) : "r11","cc","memory")
int main(int argc,char** argv){
 if(argc!=7)return 1;
 const int width=atoi(argv[1]),alias=atoi(argv[2]);
 if((width!=4&&width!=8)||alias<0||alias>2)return 2;
 const uint64_t low=strtoull(argv[3],0,16),high=strtoull(argv[4],0,16),divisor=strtoull(argv[5],0,16),before=(strtoull(argv[6],0,16)&0xcd5)|0x202;
 struct sigaction action={0};action.sa_sigaction=caught;action.sa_flags=SA_SIGINFO;sigemptyset(&action.sa_mask);if(sigaction(SIGFPE,&action,0))return 3;
 uint64_t a=low,d=high,c=divisor,after=0;const int fault=sigsetjmp(recovery,1);
 if(!fault){if(width==4){if(alias==0){RUN("divl %%ecx");}else if(alias==1){RUN("divl %%eax");}else{RUN("divl %%edx");}}else{if(alias==0){RUN("divq %%rcx");}else if(alias==1){RUN("divq %%rax");}else{RUN("divq %%rdx");}}}
 printf("{\"fault\":%s,\"a\":\"0x%016" PRIx64 "\",\"d\":\"0x%016" PRIx64 "\",\"c\":\"0x%016" PRIx64 "\",\"flags\":\"0x%016" PRIx64 "\",\"signalCode\":%d,\"trap\":%d,\"error\":%d,\"faultRIPExact\":%s}\n",fault?"true":"false",fault?fault_a:a,fault?fault_d:d,fault?fault_c:c,fault?fault_flags:after,fault_code,fault_trap,fault_error,fault_rip_exact?"true":"false");
 return 0;
}
