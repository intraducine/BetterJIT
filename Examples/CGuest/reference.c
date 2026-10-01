/* SPDX-License-Identifier: GPL-3.0-or-later */
#include <stdint.h>
#include <stdio.h>
#include <inttypes.h>
uint64_t checksum(uint32_t, uint32_t);
int main(void) {
    uint32_t seed = UINT32_C(0x9e3779b9);
    for (unsigned i = 0; i < 256; ++i) {
        seed = seed * UINT32_C(1664525) + UINT32_C(1013904223);
        uint32_t count = i * 7;
        printf("%" PRIu32 " %" PRIu32 " %" PRIu64 "\n", seed, count, checksum(seed, count));
    }
    return 0;
}
