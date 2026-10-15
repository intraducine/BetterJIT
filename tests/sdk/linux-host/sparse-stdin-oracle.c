// SPDX-License-Identifier: GPL-3.0-or-later
#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <sys/mman.h>
#include <errno.h>
#include <string.h>
#include <stdlib.h>
#include <limits.h>
static int comma;
static void check(const char *name,int empty,int mode,int64_t expected,int expected_error){
 int fds[2];if(pipe(fds))exit(10);if(!empty&&write(fds[1],"ABCDE",5)!=5)exit(11);close(fds[1]);
 size_t page=(size_t)sysconf(_SC_PAGESIZE);unsigned char *m=mmap(NULL,2*page,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);if(m==MAP_FAILED)exit(12);
 void *at=m;size_t n=5;
 if(mode==1)at=(void*)(uintptr_t)1;
 if(mode==2){at=(void*)(uintptr_t)1;n=0;}
 if(mode==3){at=(void*)(UINT64_C(1)<<63);n=0;}
 if(mode==4||mode==5){at=m+page-3;if(mode==4){if(munmap(m+page,page))exit(13);}else if(mprotect(m+page,page,PROT_READ))exit(14);}
 if(mode==6&&mprotect(m,page,PROT_READ))exit(15);
 if(mode==7){at=(void*)((UINT64_C(1)<<47)-1);n=2;}
 errno=0;long result=syscall(SYS_read,fds[0],at,n);int error=errno;
 if(expected!=LONG_MIN&&(result!=expected||error!=expected_error)){fprintf(stderr,"%s: got %ld errno%d, expected %ld errno%d\n",name,result,error,(long)expected,expected_error);exit(16);}
 unsigned char tail[8]={0};long next=0;if(mode==4||mode==5){if(result<0&&error!=EFAULT)exit(17);next=syscall(SYS_read,fds[0],tail,8);long consumed=result<0?0:result;if(consumed>3||next!=5-consumed||memcmp(tail,"ABCDE"+consumed,(size_t)next))exit(18);}
 printf("%s{\"id\":\"%s\",\"result\":%ld,\"errno\":%d,\"nextBytes\":%ld}",comma?",\n":"",name,result,error,next);comma=1;close(fds[0]);munmap(m,mode==4?page:2*page);
}
int main(void){puts("[");check("read",0,0,5,0);check("zero-unmapped",0,2,0,0);check("unmapped",0,1,-1,EFAULT);check("readonly",0,6,-1,EFAULT);check("partial-unmapped-profile-unsupported",0,4,LONG_MIN,0);check("partial-readonly-profile-unsupported",0,5,LONG_MIN,0);check("EOF-unmapped",1,1,0,0);check("EOF-readonly",1,6,0,0);check("zero-noncanonical",1,3,-1,EFAULT);check("EOF-domain-crossing",1,7,-1,EFAULT);puts("\n]");return 0;}
