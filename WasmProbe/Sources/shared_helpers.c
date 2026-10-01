#include "shared_helpers.h"

void sh_fill_u32(uint32_t *p, size_t words, uint32_t seed) {
    uint32_t x = seed ? seed : 1;
    for (size_t i = 0; i < words; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; p[i] = x; }
}

uint32_t sh_fnv_u32(const uint32_t *p, size_t words) {
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < words; i++) { h ^= p[i]; h *= 16777619u; }
    return h;
}

void sh_responder(volatile uint64_t *req, volatile uint64_t *resp, volatile int *run) {
    uint64_t last = __atomic_load_n(req, __ATOMIC_ACQUIRE);
    while (__atomic_load_n(run, __ATOMIC_RELAXED)) {
        uint64_t v = __atomic_load_n(req, __ATOMIC_ACQUIRE);
        if (v != last) { __atomic_store_n(resp, v, __ATOMIC_RELEASE); last = v; }
    }
}

#include <string.h>
#define SH_PAGE 16384u

void sh_pager_server(uint8_t *base, size_t ctrl, size_t slot0, size_t slot1,
                     uint8_t *store, uint8_t *present, uint32_t npages, volatile int *run, uint64_t *served) {
    volatile uint64_t *req = (volatile uint64_t *)(base + ctrl);
    volatile uint32_t *op = (volatile uint32_t *)(base + ctrl + 8);
    volatile uint64_t *resp = (volatile uint64_t *)(base + ctrl + 64);
    uint64_t last = __atomic_load_n(req, __ATOMIC_ACQUIRE);
    while (__atomic_load_n(run, __ATOMIC_RELAXED)) {
        uint64_t s = __atomic_load_n(req, __ATOMIC_ACQUIRE);
        if (s == last) continue;
        uint32_t o = op[0], out = op[1], in = op[2];
        if ((o & 1) && out < npages) { memcpy(store + (size_t)out * SH_PAGE, base + slot0, SH_PAGE); present[out] = 1; }
        if ((o & 2) && in < npages) {
            if (present[in]) memcpy(base + slot1, store + (size_t)in * SH_PAGE, SH_PAGE);
            else memset(base + slot1, 0, SH_PAGE);
        }
        __atomic_store_n(resp, s, __ATOMIC_RELEASE);
        last = s;
        (*served)++;
    }
}
