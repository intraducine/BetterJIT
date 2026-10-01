// Micro-benchmarks for control transfer costs in translated code.
#include <stdint.h>
__attribute__((noinline)) static uint32_t leaf(uint32_t x) { return x * 3 + 1; }

// n direct calls to a tiny function (call + ret each).
uint32_t k_calls(int n) {
    uint32_t s = 1;
    for (int i = 0; i < n; i++) s = leaf(s) ^ (uint32_t)i;
    return s;
}

// n switch dispatches through a jump table (indirect jump each).
uint32_t k_switch(int n) {
    uint32_t s = 7;
    for (int i = 0; i < n; i++) {
        switch ((s >> 3) & 7) {
        case 0: s = s * 5 + 1; break;
        case 1: s ^= s << 7; break;
        case 2: s += 0x9e3779b9; break;
        case 3: s = (s >> 5) | (s << 27); break;
        case 4: s -= i; break;
        case 5: s = ~s; break;
        case 6: s *= 0x2545F491; break;
        default: s += 12345; break;
        }
    }
    return s;
}

// n indirect calls through a table of four functions (C++ virtual-call style);
// the target changes every 4 calls.
typedef uint32_t (*fn_t)(uint32_t);
__attribute__((noinline)) static uint32_t v0(uint32_t x) { return x * 3 + 1; }
__attribute__((noinline)) static uint32_t v1(uint32_t x) { return x ^ (x >> 3); }
__attribute__((noinline)) static uint32_t v2(uint32_t x) { return x + 0x9e3779b9u; }
__attribute__((noinline)) static uint32_t v3(uint32_t x) { return (x << 5) | (x >> 27); }
static fn_t const vtab[4] = {v0, v1, v2, v3};
uint32_t k_vcall(int n) {
    uint32_t s = 1;
    for (int i = 0; i < n; i++) s = vtab[(i >> 2) & 3](s) ^ (uint32_t)i;
    return s;
}

// Deep recursion: n evaluations of fib(20), 21891 calls each.
__attribute__((noinline)) static uint32_t fib(uint32_t k) { return k < 2 ? k : fib(k - 1) + fib(k - 2); }
uint32_t k_fib(int n) {
    uint32_t s = 0;
    for (int i = 0; i < n; i++) s += fib(18 + (uint32_t)(i & 3));
    return s;
}

// n switch dispatches on a pseudo-random selector (unpredictable jump table).
uint32_t k_rswitch(int n) {
    uint32_t s = 7, acc = 0;
    for (int i = 0; i < n; i++) {
        s = s * 1103515245u + 12345u;
        switch ((s >> 16) & 7) {
        case 0: acc = acc * 5 + 1; break;
        case 1: acc ^= acc << 7; break;
        case 2: acc += 0x9e3779b9u; break;
        case 3: acc = (acc >> 5) | (acc << 27); break;
        case 4: acc -= (uint32_t)i; break;
        case 5: acc = ~acc; break;
        case 6: acc *= 0x2545F491u; break;
        default: acc += 12345; break;
        }
    }
    return acc;
}

// Recursive in-order walk of an implicit binary tree, written so that the
// return address of the conditional left call is also the join point of its
// if (je past the call): a return can't be told from a jump by RIP alone.
uint32_t walk_acc;
#if defined(__x86_64__) && !defined(_WIN64) // (SysV registers; Win64 builds use the C version)
void walk(uint32_t i, uint32_t n);
__asm__(".text\n"
        ".globl walk\n"
        "walk:\n"
        "  pushq %rbx\n"
        "  movl %edi, %ebx\n"
        "  leal 1(%rbx,%rbx), %edi\n"
        "  leaq 1f(%rip), %rax\n"      /* skip the call through an indirect */
        "  leaq 3f(%rip), %rcx\n"      /* jump, so 1: starts another unit */
        "  cmpl %esi, %edi\n"
        "  cmovbq %rcx, %rax\n"
        "  jmpq *%rax\n"
        "3:\n"
        "  callq walk\n"
        "1:\n"
        "  imull $31, walk_acc(%rip), %eax\n"
        "  addl %ebx, %eax\n"
        "  movl %eax, walk_acc(%rip)\n"
        "  leal 2(%rbx,%rbx), %edi\n"
        "  cmpl %esi, %edi\n"
        "  jae 2f\n"
        "  callq walk\n"
        "2:\n"
        "  popq %rbx\n"
        "  retq\n");
#else
__attribute__((noinline)) static void walk(uint32_t i, uint32_t n) {
    if (2 * i + 1 < n) walk(2 * i + 1, n);
    walk_acc = walk_acc * 31 + i;
    if (2 * i + 2 < n) walk(2 * i + 2, n);
}
#endif
uint32_t k_walk(int n) {
    walk_acc = 0;
    for (int r = 0; r < n; r++) walk(0, 1023 - (uint32_t)(r & 7));
    return walk_acc;
}
