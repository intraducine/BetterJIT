/* SPDX-License-Identifier: GPL-3.0-or-later */
#include <stdint.h>
uint64_t checksum(uint32_t seed, uint32_t count) {
    uint64_t value = seed;
    for (uint32_t i = 0; i < count; ++i) {
        value ^= value >> 11;
        value = value * UINT64_C(6364136223846793005) + i + 1;
    }
    return value;
}
#if defined(__wasm32__)
#include "betterjit.h"
uint32_t host_double(uint32_t input) {
    uint32_t output = 0;
    if (betterjit_call(1, &input, sizeof(input), &output, sizeof(output)) != 4)
        __builtin_trap();
    return output;
}
#endif
