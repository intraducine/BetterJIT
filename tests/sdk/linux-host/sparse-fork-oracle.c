// SPDX-License-Identifier: GPL-3.0-or-later
// Independent native Linux x86-64 fork/wait oracle, never translated by FEX.
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
struct shared {int value,child_private,mask;};
int main(void){
 struct sigaction action={.sa_handler=SIG_DFL};assert(sigemptyset(&action.sa_mask)==0);assert(sigaction(SIGCHLD,&action,0)==0);
 sigset_t set;assert(sigemptyset(&set)==0);assert(sigaddset(&set,SIGCHLD)==0);assert(sigprocmask(SIG_UNBLOCK,&set,0)==0);assert(sigemptyset(&set)==0);assert(sigaddset(&set,SIGUSR1)==0);assert(sigprocmask(SIG_BLOCK,&set,0)==0);
 struct shared *s=mmap(0,4096,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);assert(s!=MAP_FAILED);int private_value=73;
 long pid=syscall(SYS_fork);assert(pid>=0);if(pid==0){private_value=43;s->child_private=private_value;s->value=85;sigset_t mask;assert(sigprocmask(SIG_SETMASK,0,&mask)==0);s->mask=sigismember(&mask,SIGUSR1);syscall(SYS_exit,23);__builtin_unreachable();}
 int status=0;assert(syscall(SYS_wait4,pid,&status,0,0)==pid);assert(status==0x1700);assert(private_value==73&&s->child_private==43&&s->value==85&&s->mask==1);errno=0;assert(syscall(SYS_wait4,pid,&status,0,0)==-1&&errno==ECHILD);
 pid=syscall(SYS_fork);assert(pid>=0);if(!pid){syscall(SYS_exit,23);__builtin_unreachable();}errno=0;assert(syscall(SYS_wait4,pid,(void*)1,0,0)==-1&&errno==EFAULT);errno=0;assert(syscall(SYS_wait4,pid,&status,WNOHANG,0)==-1&&errno==ECHILD);
 sigset_t pending;assert(sigpending(&pending)==0);assert(sigismember(&pending,SIGCHLD)==0);
 puts("{\"supported\":true,\"privateIsolation\":true,\"sharedVisibility\":true,\"inheritedMask\":true,\"status\":5888,\"repeatWaitErrno\":10,\"badStatusErrno\":14,\"badStatusReaps\":true,\"defaultUnblockedSIGCHLD\":true}");assert(munmap(s,4096)==0);return 0;
}
