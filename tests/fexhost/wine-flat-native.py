#!/usr/bin/env python3
"""Check the adapted Wine FS sequence on native x86 Linux, not FEX/device evidence."""
import argparse, pathlib, re, subprocess, tempfile

def check_mapped_entry(source, work):
    # Compile the actual patched Wine function with mapping/status stubs.
    # This isolates the observed metadata regression; it is not Wine execution.
    wine = (source / 'dlls/ntdll/unix/virtual.c').read_text()
    function = re.search(r'NTSTATUS virtual_map_builtin_module\([\s\S]*?\n\}', wine)
    if not function: raise SystemExit('Wine builtin mapping function is missing')
    stubs = r'''
#include <stdint.h>
#include <stdlib.h>
#include <stdarg.h>
typedef uint32_t NTSTATUS;
typedef uintptr_t HANDLE, SIZE_T, ULONG_PTR;
typedef uint64_t mem_size_t;
typedef uint16_t WCHAR, WORD;
typedef int BOOL;
typedef struct { void *TransferAddress; } SECTION_IMAGE_INFORMATION;
struct pe_image_info { int wine_builtin; unsigned dll_charact; uintptr_t base, entry_point; };
#define TRUE 1
#define SECTION_MAP_READ 1
#define STATUS_INVALID_PARAMETER 0xc000000dU
#define STATUS_DLL_NOT_FOUND 0xc0000135U
#define STATUS_IMAGE_ALREADY_LOADED 0x4000000eU
#define STATUS_IMAGE_NOT_AT_BASE 0x40000003U
#define IMAGE_DLLCHARACTERISTICS_PREFER_NATIVE 1
static NTSTATUS mapping_status;
static uintptr_t mapped_base;
static void ignore_trace(const char *format, ...) {}
#define WARN_(channel) ignore_trace
#define TRACE_(channel) ignore_trace
static const char *debugstr_w(const WCHAR *s) { return "mapping fixture"; }
static void NtClose(HANDLE h) {}
static NTSTATUS get_mapping_info(HANDLE h, unsigned access, unsigned *flags,
                                mem_size_t *full_size, HANDLE *shared, struct pe_image_info **out)
{
    *out = calloc(1, sizeof(**out) + sizeof(WCHAR));
    (*out)->wine_builtin = 1;
    (*out)->base = 0x140000000ULL;
    (*out)->entry_point = 0x1e220;
    *shared = 0;
    return 0;
}
static NTSTATUS virtual_map_image(HANDLE h, void **module, SIZE_T *size, HANDLE shared,
                                 ULONG_PTR low, ULONG_PTR high, unsigned alloc, WORD machine,
                                 struct pe_image_info *info, WCHAR *filename, BOOL builtin)
{
    *module = mapping_status & 0x80000000U ? NULL : (void *)mapped_base;
    *size = 0x1c1000;
    return mapping_status;
}
static void virtual_fill_image_information(struct pe_image_info *image, SECTION_IMAGE_INFORMATION *info)
{ info->TransferAddress = (void *)(image->base + image->entry_point); }
'''
    main = r'''
int main(void)
{
    void *module;
    SIZE_T size;
    SECTION_IMAGE_INFORMATION info;
    const NTSTATUS statuses[] = {STATUS_IMAGE_NOT_AT_BASE, 0, 0xc0000018U};
    const uintptr_t bases[] = {0x10000, 0x140000000ULL, 0};
    const uintptr_t entries[] = {0x2e220, 0x14001e220ULL, 0x14001e220ULL};
    for (int i = 0; i < 3; ++i)
    {
        mapping_status = statuses[i]; mapped_base = bases[i];
        if (virtual_map_builtin_module(1, &module, &size, &info, 0, 0, 0x8664, 0) != statuses[i]) return 1;
        if ((uintptr_t)info.TransferAddress != entries[i]) return 2;
    }
    return 0;
}
'''
    src, out = work / 'mapped-entry.c', work / 'mapped-entry'
    src.write_text(stubs + '\n' + function[0] + '\n' + main)
    subprocess.run(['cc', '-std=c11', str(src), '-o', str(out)], check=True)
    result = subprocess.run([str(out)], timeout=5)
    if result.returncode:
        raise SystemExit(f'Wine mapped entry metadata contract failed: {result.returncode}')
    print('PASS Wine mapping function with stubs: actual relocated entry, preferred-base entry, error status retained.')

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
        check_mapped_entry(a.source, pathlib.Path(temp))
        src = pathlib.Path(temp) / 'fs.c'
        for selector in (0, 1):
            cstring = lambda s: '"' + s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'
            src.write_text(match[1] + '\n__asm__(' + cstring(ASM) + '\nBETTERJIT_LOAD_NULL_FS("0x0(%r8)")\n'
                           + cstring(AFTER.replace('SELECTOR', str(selector))) + ');\n')
            out = a.output if selector == 0 else pathlib.Path(temp) / 'non-null.elf'
            # Shared guest spaces must place this checker away from the
            # running shell. Its RIP-relative assembly needs no relocator.
            subprocess.run(['cc', '-nostdlib', '-static-pie', '-fPIE', '-Wl,--build-id=none',
                            str(src), '-o', str(out)], check=True)
            result = subprocess.run([str(out.resolve())], capture_output=True, timeout=5)
            if selector == 0:
                if result.returncode != 0 or result.stdout != b'BetterJIT Wine FS reset OK\n':
                    raise SystemExit(f'FS reset/register/flags contract failed: {result.returncode} {result.stdout!r}')
            elif result.returncode != -4:
                raise SystemExit(f'Non-null selector was not rejected with SIGILL: {result.returncode}')
    print('PASS native Wine FS reset: base cleared, registers/flags preserved; non-null selector SIGILL.')

if __name__ == '__main__': main()
