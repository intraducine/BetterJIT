// SPDX-License-Identifier: GPL-3.0-or-later
// Freestanding x86-64 scalar fixtures. No OS, allocator, globals or SIMD.
// Rebuild with build.py; the app translates the generated x86 bytes at runtime.
typedef unsigned long long u64;
typedef unsigned char u8;
#ifdef WIN64
#define ABI __attribute__((ms_abi))
#else
#define ABI __attribute__((sysv_abi))
#endif
#define FN ABI __attribute__((noinline))
u64 FN add64(u64 a, u64 b) { return a + b; }
u64 FN weighted16(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f, u64 g, u64 h,
                   u64 i, u64 j, u64 k, u64 l, u64 m, u64 n, u64 o, u64 p) {
    return a + 2*b + 3*c + 4*d + 5*e + 6*f + 7*g + 8*h +
           9*i + 10*j + 11*k + 12*l + 13*m + 14*n + 15*o + 16*p;
}
u64 FN branch_mix(u64 n, u64 x) {
    for (u64 i = 0; i < n; ++i) {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        if (x & 1) x += i; else x ^= i;
    }
    return x;
}
u64 FN helper(u64 x, u64 i) { return ((x << 9) | (x >> 55)) ^ (i * 0x9e3779b97f4a7c15ULL); }
u64 FN nested_calls(u64 n, u64 x) {
    for (u64 i = 0; i < n; ++i) x = helper(x, i) + 0x100000001ULL;
    return x;
}
u64 FN mutate(volatile u8 *bytes, u64 n, u64 seed) {
    u64 hash = 0xcbf29ce484222325ULL;
    for (u64 i = 0; i < n; ++i) {
        u8 value = (u8)((bytes[i] ^ (u8)(seed + i)) + 3);
        bytes[i] = value;
        hash = (hash ^ value) * 0x100000001b3ULL;
    }
    return hash;
}
