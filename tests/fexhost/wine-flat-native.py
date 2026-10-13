#!/usr/bin/env python3
"""Check the adapted Wine FS sequence on native x86 Linux, not FEX/device evidence."""
import argparse, pathlib, re, subprocess, tempfile

ASM = r'''
.global _start
_start:
    mov $158,%eax
    mov $0x1002,%edi
    mov $0x12345000,%esi
    syscall
    test %rax,%rax
    jne failed
    mov $158,%eax
    mov $0x1001,%edi
    lea teb(%rip),%rsi
    syscall
    test %rax,%rax
    jne failed
    lea kernel_stack(%rip),%rax
    mov %rax,teb+0x370(%rip)
    lea selector(%rip),%r8
    mov $0x12345678,%eax
    mov $0x3456,%edi
    mov $0x5678,%esi
    mov $0x789a,%ecx
    mov $0xabcd,%r11d
    stc
    pushfq
    pop %r12
    movq $0x5aa51234,-16(%rsp)
'''
AFTER = r'''
    pushfq
    pop %r13
    cmp %r12,%r13
    jne failed
    cmpq $0x5aa51234,-16(%rsp)
    jne failed
    cmp $0x12345678,%rax
    jne failed
    cmp $0x3456,%rdi
    jne failed
    cmp $0x5678,%rsi
    jne failed
    cmp $0x789a,%rcx
    jne failed
    cmp $0xabcd,%r11
    jne failed
    mov $158,%eax
    mov $0x1003,%edi
    lea fs_base(%rip),%rsi
    syscall
    test %rax,%rax
    jne failed
    cmpq $0,fs_base(%rip)
    jne failed
    mov $1,%eax
    mov $1,%edi
    lea message(%rip),%rsi
    mov $(message_end-message),%edx
    syscall
    xor %edi,%edi
    jmp exit
failed:
    mov $1,%edi
exit:
    mov $60,%eax
    syscall
.section .rodata
message: .ascii "BetterJIT Wine FS reset OK\n"
message_end:
selector: .word SELECTOR
.section .bss
.align 8
fs_base: .skip 8
.align 16
teb: .skip 0x380
kernel_stack: .skip 0x2000
'''

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=pathlib.Path, required=True)
    p.add_argument('--output', type=pathlib.Path, required=True)
    a = p.parse_args()
    wine = (a.source / 'dlls/ntdll/unix/signal_x86_64.c').read_text()
    match = re.search(r'(#define BETTERJIT_LOAD_NULL_FS\(operand\).*?)(?=\n\n)', wine, re.S)
    if not match: raise SystemExit('Adapted Wine FS macro is missing')
    a.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='wine-fs-native-') as temp:
        src = pathlib.Path(temp) / 'fs.c'
        for selector in (0, 1):
            cstring = lambda s: '"' + s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'
            src.write_text(match[1] + '\n__asm__(' + cstring(ASM) + '\nBETTERJIT_LOAD_NULL_FS("0x0(%r8)")\n'
                           + cstring(AFTER.replace('SELECTOR', str(selector))) + ');\n')
            out = a.output if selector == 0 else pathlib.Path(temp) / 'non-null.elf'
            subprocess.run(['cc', '-nostdlib', '-static', '-fno-pie', '-no-pie', '-Wl,--build-id=none',
                            str(src), '-o', str(out)], check=True)
            result = subprocess.run([str(out.resolve())], capture_output=True, timeout=5)
            if selector == 0:
                if result.returncode != 0 or result.stdout != b'BetterJIT Wine FS reset OK\n':
                    raise SystemExit(f'FS reset/register/flags contract failed: {result.returncode} {result.stdout!r}')
            elif result.returncode != -4:
                raise SystemExit(f'Non-null selector was not rejected with SIGILL: {result.returncode}')
    print('PASS native Wine FS reset: base cleared, registers/flags preserved; non-null selector SIGILL.')

if __name__ == '__main__': main()
