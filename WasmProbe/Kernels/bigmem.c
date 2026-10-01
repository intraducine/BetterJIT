// Demand-paged guest memory for the WebView: a 64-bit guest address space far
// larger than the wasm memory. Translation is an in-wasm page table (one load
// + compare per access); only a non-present entry calls the JS pager
// (import e.fault), which maps the page into a resident frame from a backing
// store (OPFS file, or the app process's RAM through a shared file).
#include <stdint.h>

#define EXPORT(name) __attribute__((export_name(#name)))
#define PAGE_SHIFT 14
#define PAGE_SIZE (1u << PAGE_SHIFT)
#define FRAME_BASE (16u << 20)

static uint32_t *g_pt;          // page -> host address of its frame, 0 = not present
static uint32_t g_npages;
static uint64_t g_base;
uint8_t frame_dirty[1u << 17];  // up to 2 GB of resident frames

__attribute__((import_module("e"), import_name("fault")))
extern void pager_fault(uint32_t page);

EXPORT(dirty_addr) uint32_t dirty_addr(void) { return (uint32_t)(uintptr_t)frame_dirty; }
EXPORT(setup) void setup(uint32_t pt_addr, uint32_t npages, uint64_t base) {
    g_pt = (uint32_t *)(uintptr_t)pt_addr; g_npages = npages; g_base = base;
}

static inline uint8_t *xlate(uint64_t va, int write) {
    uint64_t page = (va - g_base) >> PAGE_SHIFT;
    if (__builtin_expect(page >= g_npages, 0)) __builtin_trap();
    uint32_t e = g_pt[page];
    if (__builtin_expect(e == 0, 0)) { pager_fault((uint32_t)page); e = g_pt[page]; }
    if (write) frame_dirty[(e - FRAME_BASE) >> PAGE_SHIFT] = 1;
    return (uint8_t *)(uintptr_t)(e + (uint32_t)(va & (PAGE_SIZE - 1)));
}

static inline uint64_t xs(uint64_t *s) { uint64_t x = *s; x ^= x << 13; x ^= x >> 7; x ^= x << 17; return *s = x; }

// n accesses; hotPct% of them fall in [base, base+hot), the rest anywhere in
// [base, base+span). One in four accesses is a write. Returns a checksum.
EXPORT(work) uint64_t work(uint32_t n, uint64_t seed, uint64_t base, uint64_t hot, uint64_t span, uint32_t hotPct) {
    uint64_t acc = 0, s = seed | 1;
    for (uint32_t i = 0; i < n; i++) {
        uint64_t r = xs(&s);
        uint64_t off = ((r & 0xffff) % 100 < hotPct) ? (r >> 16) % hot : (r >> 16) % span;
        uint64_t va = base + (off & ~7ull);
        if ((r >> 60) == 0 || (r >> 60) == 7 || (r >> 60) == 9 || (r >> 60) == 13) {
            *(uint64_t *)xlate(va, 1) = acc ^ va;
        } else {
            acc += *(uint64_t *)xlate(va, 0) + (acc >> 7);
        }
    }
    return acc;
}

// One distinct word per guest page across npages: every page is touched once.
static inline uint64_t mix(uint32_t p, uint32_t salt) { return ((uint64_t)p * 0x9E3779B97F4A7C15ull) ^ salt; }
static inline uint64_t page_va(uint64_t base, uint32_t p) { return base + (uint64_t)p * PAGE_SIZE + ((p * 8u) & (PAGE_SIZE - 8)); }
EXPORT(seqfill) uint32_t seqfill(uint64_t base, uint32_t npages, uint32_t salt) {
    for (uint32_t p = 0; p < npages; p++) *(uint64_t *)xlate(page_va(base, p), 1) = mix(p, salt);
    return npages;
}
EXPORT(seqcheck) uint32_t seqcheck(uint64_t base, uint32_t npages, uint32_t salt) {
    uint32_t bad = 0;
    for (uint32_t p = 0; p < npages; p++) bad += *(uint64_t *)xlate(page_va(base, p), 0) != mix(p, salt);
    return bad;
}

// Same workload on a flat array starting at `flat` (span must fit in memory).
EXPORT(work_direct) uint64_t work_direct(uint32_t n, uint64_t seed, uint32_t flat, uint64_t base, uint64_t hot, uint64_t span, uint32_t hotPct) {
    uint64_t acc = 0, s = seed | 1;
    for (uint32_t i = 0; i < n; i++) {
        uint64_t r = xs(&s);
        uint64_t off = ((r & 0xffff) % 100 < hotPct) ? (r >> 16) % hot : (r >> 16) % span;
        uint64_t va = base + (off & ~7ull);
        uint64_t *p = (uint64_t *)(uintptr_t)(flat + (uint32_t)(off & ~7ull));
        if ((r >> 60) == 0 || (r >> 60) == 7 || (r >> 60) == 9 || (r >> 60) == 13) *p = acc ^ va;
        else acc += *p + (acc >> 7);
    }
    return acc;
}
