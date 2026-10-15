// SPDX-License-Identifier: GPL-3.0-or-later
/* Freestanding C program: transform one command-line argument and write stdout. */
typedef unsigned long usize;
static unsigned char output[256];
static inline long write_bytes(long fd,const void *p,usize n){long r;__asm__ volatile("syscall":"=a"(r):"a"(1L),"D"(fd),"S"(p),"d"(n):"rcx","r11","memory");return r;}
__attribute__((noreturn)) static inline void finish(long code){__asm__ volatile("syscall"::"a"(60L),"D"(code):"rcx","r11","memory");__builtin_unreachable();}
__attribute__((noreturn,used)) void entry(const usize *stack){
 if(stack[0]!=2) {write_bytes(2,"usage: rot13 TEXT\n",18);finish(64);}
 const unsigned char *text=(const unsigned char*)stack[2];usize n=0;
 for(;text[n]&&n<255;n++){
  unsigned char c=text[n];
  if(c>='a'&&c<='z')c=(unsigned char)(c<'n'?c+13:c-13);
  else if(c>='A'&&c<='Z')c=(unsigned char)(c<'N'?c+13:c-13);
  output[n]=c;
 }
 if(text[n]){write_bytes(2,"input too long\n",15);finish(65);}
 output[n++]='\n';finish(write_bytes(1,output,n)==(long)n?0:74);
}
__asm__(".text\n.global _start\n.type _start,@function\n_start:\nmov %rsp,%rdi\njmp entry\n.size _start,.-_start\n.section .note.GNU-stack,\"\",@progbits\n");
