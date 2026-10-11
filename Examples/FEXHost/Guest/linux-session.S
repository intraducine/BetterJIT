# SPDX-License-Identifier: GPL-3.0-or-later
# Static, libc-free x86-64 workload for the real BetterJITLinux process path.
# Any failed syscall or mismatch exits 1. Success writes one exact marker.
.global _start
.section .text
_start:
    mov $257, %eax
    mov $-100, %edi
    lea input_path(%rip), %rsi
    xor %edx, %edx
    xor %r10d, %r10d
    syscall
    test %rax, %rax
    js failed
    mov %eax, %r12d
    mov %eax, %edi
    xor %eax, %eax
    lea scratch(%rip), %rsi
    mov $data_end-data, %edx
    syscall
    cmp $data_end-data, %rax
    jne failed
    lea scratch(%rip), %rsi
    lea data(%rip), %rdi
    mov $data_end-data, %ecx
compare:
    mov (%rsi), %al
    cmp (%rdi), %al
    jne failed
    inc %rsi
    inc %rdi
    dec %ecx
    jnz compare
    mov $3, %eax
    mov %r12d, %edi
    syscall
    test %rax, %rax
    jne failed

    # anonymous mmap, read/write sentinel, mprotect read-only, then munmap
    mov $9, %eax
    xor %edi, %edi
    mov $4096, %esi
    mov $3, %edx
    mov $34, %r10d
    mov $-1, %r8
    xor %r9d, %r9d
    syscall
    test %rax, %rax
    js failed
    mov %rax, %r12
    movl $0x12345678, (%r12)
    mov $10, %eax
    mov %r12, %rdi
    mov $4096, %esi
    mov $1, %edx
    syscall
    test %rax, %rax
    jne failed
    cmpl $0x12345678, (%r12)
    jne failed
    mov $11, %eax
    mov %r12, %rdi
    mov $4096, %esi
    syscall
    test %rax, %rax
    jne failed

    mov $228, %eax
    mov $1, %edi
    lea scratch(%rip), %rsi
    syscall
    test %rax, %rax
    jne failed
    mov $318, %eax
    lea scratch(%rip), %rdi
    mov $16, %esi
    xor %edx, %edx
    syscall
    cmp $16, %rax
    jne failed

    # A real cloned Linux thread writes shared state. Parent waits via futex.
    # CLONE_VM|FS|FILES|SIGHAND|THREAD|SYSVSEM, independent stack, no libc/TLS.
    mov $56, %eax
    mov $0x50f00, %edi
    lea child_stack_end(%rip), %rsi
    xor %edx, %edx
    xor %r10d, %r10d
    xor %r8d, %r8d
    syscall
    test %rax, %rax
    js failed
    jz child
wait_child:
    cmpl $42, child_value(%rip)
    je success
    mov $202, %eax
    lea child_value(%rip), %rdi
    mov $128, %esi
    xor %edx, %edx
    lea wait_limit(%rip), %r10
    syscall
    test %rax, %rax
    jz wait_child
    cmp $-11, %rax
    je wait_child
    jmp failed
child:
    movl $42, child_value(%rip)
    mov $202, %eax
    lea child_value(%rip), %rdi
    mov $129, %esi
    mov $1, %edx
    syscall
    mov $60, %eax
    xor %edi, %edi
    syscall
success:
    mov $1, %eax
    mov $1, %edi
    lea message(%rip), %rsi
    mov $message_end-message, %edx
    syscall
    cmp $message_end-message, %rax
    jne failed
    mov $231, %eax
    xor %edi, %edi
    syscall
failed:
    mov $231, %eax
    mov $1, %edi
    syscall
.section .rodata
input_path: .asciz "session-input.txt"
data: .ascii "BetterJIT data\n"
data_end:
message: .ascii "BetterJIT Linux services OK\n"
message_end:
.balign 8
wait_limit: .quad 2, 0
.section .bss
.balign 16
scratch: .skip 128
child_value: .skip 4
.balign 16
child_stack: .skip 16384
child_stack_end:
.section .note.GNU-stack,"",@progbits
