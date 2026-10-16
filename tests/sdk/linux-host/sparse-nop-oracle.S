// SPDX-License-Identifier: GPL-3.0-or-later
// Preserve the host ABI while testing a NOP with all sixteen guest GPR values,
// including an unmapped/noncanonical RSP. The trampoline uses only RIP-relative
// MOV/JMP while the test stack pointer is installed; no tested operand is read.
.text
.globl fex_nop_run
.type fex_nop_run,@function
fex_nop_run:
  push %rbx
  push %rbp
  push %r12
  push %r13
  push %r14
  push %r15
  mov %rsp,fex_nop_stack(%rip)
  cld
  cmpl $0,fex_nop_df(%rip)
  je 1f
  std
1:
  mov fex_nop_fa(%rip),%eax
  add fex_nop_fb(%rip),%eax
  pushfq
  popq fex_nop_flags_before(%rip)
  mov fex_nop_before+0(%rip),%rax
  mov fex_nop_before+8(%rip),%rcx
  mov fex_nop_before+16(%rip),%rdx
  mov fex_nop_before+24(%rip),%rbx
  mov fex_nop_before+40(%rip),%rbp
  mov fex_nop_before+48(%rip),%rsi
  mov fex_nop_before+56(%rip),%rdi
  mov fex_nop_before+64(%rip),%r8
  mov fex_nop_before+72(%rip),%r9
  mov fex_nop_before+80(%rip),%r10
  mov fex_nop_before+88(%rip),%r11
  mov fex_nop_before+96(%rip),%r12
  mov fex_nop_before+104(%rip),%r13
  mov fex_nop_before+112(%rip),%r14
  mov fex_nop_before+120(%rip),%r15
  mov fex_nop_before+32(%rip),%rsp
  jmp *fex_nop_code(%rip)
.globl fex_nop_resume
.type fex_nop_resume,@function
fex_nop_resume:
  mov %rax,fex_nop_after+0(%rip)
  mov %rcx,fex_nop_after+8(%rip)
  mov %rdx,fex_nop_after+16(%rip)
  mov %rbx,fex_nop_after+24(%rip)
  mov %rsp,fex_nop_after+32(%rip)
  mov %rbp,fex_nop_after+40(%rip)
  mov %rsi,fex_nop_after+48(%rip)
  mov %rdi,fex_nop_after+56(%rip)
  mov %r8,fex_nop_after+64(%rip)
  mov %r9,fex_nop_after+72(%rip)
  mov %r10,fex_nop_after+80(%rip)
  mov %r11,fex_nop_after+88(%rip)
  mov %r12,fex_nop_after+96(%rip)
  mov %r13,fex_nop_after+104(%rip)
  mov %r14,fex_nop_after+112(%rip)
  mov %r15,fex_nop_after+120(%rip)
  mov fex_nop_stack(%rip),%rsp
  pushfq
  popq fex_nop_flags_after(%rip)
  cld
  pop %r15
  pop %r14
  pop %r13
  pop %r12
  pop %rbp
  pop %rbx
  ret
.size fex_nop_run,.-fex_nop_run
.section .note.GNU-stack,"",@progbits
