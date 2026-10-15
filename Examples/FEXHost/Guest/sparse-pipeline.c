// SPDX-License-Identifier: GPL-3.0-or-later
/* Ordinary C parent: consume one byte, fork, exec the copy command, wait. */
typedef unsigned long usize;
static unsigned char prefix, status[4];
static inline __attribute__((always_inline)) long call3(long nr,long a,long b,long c){long r;__asm__ volatile("syscall":"=a"(r):"a"(nr),"D"(a),"S"(b),"d"(c):"rcx","r11","memory");return r;}
static inline __attribute__((always_inline)) long wait_child(long pid){long r;register long usage __asm__("r10")=0;__asm__ volatile("syscall":"=a"(r):"a"(61L),"D"(pid),"S"(status),"d"(0L),"r"(usage):"rcx","r11","memory");return r;}
__attribute__((noreturn)) static inline __attribute__((always_inline)) void finish(long code){__asm__ volatile("syscall"::"a"(60L),"D"(code):"rcx","r11","memory");__builtin_unreachable();}
__attribute__((noreturn,used)) void entry(const usize *stack){
 if(stack[0]!=2)finish(64);
 char *path=(char *)stack[2];char *argv[2]={path,0};
 long count=call3(0,0,(long)&prefix,1);
 if(count<0)finish(74);
 if(count==1 && call3(1,1,(long)&prefix,1)!=1)finish(75);
 long child=call3(57,0,0,0);
 if(child<0)finish(72);
 if(!child){call3(59,(long)path,(long)argv,0);finish(71);}
 if(wait_child(child)!=child)finish(73);
 finish(status[1]);
}
__asm__(".text\n.global _start\n.type _start,@function\n_start:\nmov %rsp,%rdi\nlea -8(%rsp),%rsp\njmp entry\n.size _start,.-_start\n.pushsection .note.GNU-stack,\"\",@progbits\n.popsection\n");
