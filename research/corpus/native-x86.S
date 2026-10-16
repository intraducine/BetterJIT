// SPDX-License-Identifier: GPL-3.0-or-later
.text
.globl corpus_enter
.type corpus_enter,@function
corpus_enter:
  fninit
  fldz
  fldz
  fldz
  fldz
  fldz
  fldz
  fldz
  fldz
  fninit
  ldmxcsr corpus_mxcsr(%rip)
  pxor %xmm0,%xmm0
  pxor %xmm1,%xmm1
  pxor %xmm2,%xmm2
  pxor %xmm3,%xmm3
  pxor %xmm4,%xmm4
  pxor %xmm5,%xmm5
  pxor %xmm6,%xmm6
  pxor %xmm7,%xmm7
  pxor %xmm8,%xmm8
  pxor %xmm9,%xmm9
  pxor %xmm10,%xmm10
  pxor %xmm11,%xmm11
  pxor %xmm12,%xmm12
  pxor %xmm13,%xmm13
  pxor %xmm14,%xmm14
  pxor %xmm15,%xmm15
  pushq $0x202
  popfq
  movabs $0x4006ffff0,%rsp
  mov $0,%eax
  mov $0,%ecx
  mov $0,%edx
  mov $0,%ebx
  mov $0,%ebp
  mov $0,%esi
  mov $0,%edi
  mov $0,%r8d
  mov $0,%r9d
  mov $0,%r10d
  mov $0,%r11d
  mov $0,%r12d
  mov $0,%r13d
  mov $0,%r14d
  mov $0,%r15d
  jmp *corpus_entry(%rip)
.section .note.GNU-stack,"",@progbits
