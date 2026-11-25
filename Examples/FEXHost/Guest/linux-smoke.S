// SPDX-License-Identifier: GPL-3.0-or-later
// The Apple build is a direct x86-64 reference for the Linux fixture.
#ifdef __APPLE__
#define ENTRY _main
#define MMAP 0x20000c5
#define MPROTECT 0x200004a
#define MUNMAP 0x2000049
#define WRITE 0x2000004
#define EXIT 0x2000001
#define MAP_FLAGS 0x1002
#else
#define ENTRY _start
#define MMAP 9
#define MPROTECT 10
#define MUNMAP 11
#define WRITE 1
#define EXIT 60
#define MAP_FLAGS 0x22
#endif

.macro check_syscall
#ifdef __APPLE__
    jc failure
#else
    cmpq $-4095, %rax
    jae failure
#endif
.endm

.text
.globl ENTRY
ENTRY:
    andq $-16, %rsp
    subq $32, %rsp                 // Win64 shadow space for both calls.

    movl $1, %ebx
    xorl %edi, %edi
    movl $4096, %esi
    movl $3, %edx                  // Read/write.
    movl $MAP_FLAGS, %r10d
    movq $-1, %r8
    xorl %r9d, %r9d
    movl $MMAP, %eax
    syscall
    check_syscall
    movq %rax, %r12

    movabsq $0x00c3d00148c88948, %rax // mov rax, rcx; add rax, rdx; ret.
    movq %rax, (%r12)
    movl $5, %edx                  // Read/execute.
    call protect
    movl $2, %ebx
    call run_code
    cmpq $42, %rax
    jne failure

    movl $3, %ebx
    movl $3, %edx
    call protect
    movb $0x29, 4(%r12)            // Replace add with sub at the same address.
    movl $5, %edx
    call protect
    movl $4, %ebx
    call run_code
    cmpq $-2, %rax
    jne failure

    movl $5, %ebx
    movq %r12, %rdi
    movl $4096, %esi
    movl $MUNMAP, %eax
    syscall
    check_syscall

    movl $1, %edi
    leaq success(%rip), %rsi
    movl $success_end-success, %edx
    movl $WRITE, %eax
    syscall
    check_syscall
    xorl %edi, %edi
    jmp exit

protect:
    movq %r12, %rdi
    movl $4096, %esi
    movl $MPROTECT, %eax
    syscall
    check_syscall
    ret

run_code:
    movl $20, %ecx
    movl $22, %edx
    jmp *%r12

failure:
    movl %ebx, %edi
exit:
    movl $EXIT, %eax
    syscall

success:
    .ascii "BetterJIT Linux OK\nWin64 dynamic code OK\n"
success_end:
