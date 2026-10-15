// SPDX-License-Identifier: GPL-3.0-or-later
// Independent Linux x86-64 syscall oracle. Never translated by FEX.
#define _GNU_SOURCE
#include <assert.h>
#include <inttypes.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
extern void clone_probe(void *child_stack, void *parent_stack);
__asm__(
".text\n.globl clone_probe\n.type clone_probe,@function\nclone_probe:\n"
"mov %rsi,%rsp\nmov %rdi,%rsi\nmov $0x10f00,%edi\nxor %edx,%edx\n"
"xor %r10d,%r10d\nxor %r8d,%r8d\nmov $56,%eax\nsyscall\n"
"mov %rax,-8(%rsp)\n"
// Read the actual inherited blocked mask using rt_sigprocmask(NULL, old, 8).
"xor %edi,%edi\nxor %esi,%esi\nlea -16(%rsp),%rdx\nmov $8,%r10d\nmov $14,%eax\nsyscall\n"
"mov -8(%rsp),%rdi\nmov $60,%eax\nsyscall\nud2\n.size clone_probe,.-clone_probe\n");
int main(void) {
  const size_t page=4096;
  uint8_t *memory=mmap(NULL,3*page,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);
  assert(memory!=MAP_FAILED);
  uint64_t *parent=(uint64_t *)(memory+page),*child=(uint64_t *)(memory+3*page);
  parent[-1]=child[-1]=UINT64_MAX;
  sigset_t set;assert(sigemptyset(&set)==0);assert(sigaddset(&set,SIGUSR1)==0);assert(sigprocmask(SIG_BLOCK,&set,NULL)==0);
  const pid_t pid=fork();assert(pid>=0);
  if(!pid){clone_probe(child,parent);_exit(99);}
  int status;assert(waitpid(pid,&status,0)==pid);assert(WIFEXITED(status));
  assert(parent[-1]>0&&parent[-1]<INT32_MAX);assert(child[-1]==0);
  const uint64_t mask=UINT64_C(1)<<(SIGUSR1-1);assert((parent[-2]&mask)&&(child[-2]&mask));
  assert((uintptr_t)parent>UINT32_MAX&&(uintptr_t)child>UINT32_MAX);
  printf("{\"supported\":true,\"flags\":69376,\"parentGetsChildTid\":true,\"childReturn\":0,\"separateHighStacks\":true,\"inheritedBlockedMask\":true,\"observedProcessWaitCode\":%d}\n",WEXITSTATUS(status));
  assert(munmap(memory,3*page)==0);return 0;
}
