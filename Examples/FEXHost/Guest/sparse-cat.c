// SPDX-License-Identifier: GPL-3.0-or-later
/* Ordinary freestanding C stdin-to-stdout command; no libc or generated x86. */
typedef unsigned long usize;
static unsigned char bytes[4096];
static inline long read_bytes(void *p,usize n){long r;__asm__ volatile("syscall":"=a"(r):"a"(0L),"D"(0L),"S"(p),"d"(n):"rcx","r11","memory");return r;}
static inline long write_bytes(const void *p,usize n){long r;__asm__ volatile("syscall":"=a"(r):"a"(1L),"D"(1L),"S"(p),"d"(n):"rcx","r11","memory");return r;}
__attribute__((noreturn)) static inline void finish(long code){__asm__ volatile("syscall"::"a"(60L),"D"(code):"rcx","r11","memory");__builtin_unreachable();}
__attribute__((noreturn,used)) void entry(const usize *stack){
 if(stack[0]!=1)finish(64);
 for(;;){long n=read_bytes(bytes,sizeof(bytes));if(n<0)finish(74);if(!n)finish(0);if(write_bytes(bytes,(usize)n)!=n)finish(75);}
}
__asm__(".text\n.global _start\n.type _start,@function\n_start:\nmov %rsp,%rdi\nlea -8(%rsp),%rsp\njmp entry\n.size _start,.-_start\n.pushsection .note.GNU-stack,\"\",@progbits\n.popsection\n");
