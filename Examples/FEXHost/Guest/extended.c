// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit 128-bit vectors, not auto-vectorized scalar code. SSE2 only.
typedef unsigned long long u64;
typedef unsigned char u8;
typedef unsigned int u32x4 __attribute__((vector_size(16)));
typedef short i16x8 __attribute__((vector_size(16)));
typedef unsigned char u8x16 __attribute__((vector_size(16)));
typedef float f32x4 __attribute__((vector_size(16)));
typedef double f64x2 __attribute__((vector_size(16)));
#ifdef WIN64
#define API __attribute__((ms_abi,noinline))
#else
#define API __attribute__((sysv_abi,noinline))
#endif
#define LOAD(v,p) __builtin_memcpy(&(v),(p),16)
#define STORE(p,v) __builtin_memcpy((p),&(v),16)

API u64 vector_words(u8 *p) {
    u32x4 x; LOAD(x,p);
    u32x4 y = (x + (u32x4){1,0xffffffffU,0x80000000U,0x12345678U}) ^ (x >> 7);
    y = __builtin_shufflevector(y,y,2,0,3,1);
    u32x4 rotate = (y << 3) | (y >> 29);
    STORE(p,y); STORE(p+16,rotate);
    return 1;
}
API u64 vector_saturation(u8 *p) {
    i16x8 a,b; LOAD(a,p); LOAD(b,p+16);
    // PACKUSWB converts signed words to unsigned bytes with saturation.
    __asm__("packuswb %1, %0" : "+x"(a) : "x"(b));
    u8x16 packed; __builtin_memcpy(&packed,&a,16);
    STORE(p,packed);
    u8x16 add = {17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17};
    __asm__("paddusb %1, %0" : "+x"(packed) : "x"(add));
    STORE(p+16,packed);
    return 1;
}
API u64 vector_f32(u8 *p) {
    f32x4 x; LOAD(x,p);
    x = x * (f32x4){2,2,2,2} + (f32x4){4,4,4,4};
    __typeof__(x < (f32x4){6,6,6,6}) mask = x < (f32x4){6,6,6,6};
    STORE(p,x); STORE(p+16,mask);
    return 1;
}
API u64 vector_f64(u8 *p) {
    f64x2 x; LOAD(x,p);
    x = x * (f64x2){4,4} + (f64x2){1,1};
    __typeof__(x < (f64x2){0,0}) mask = x < (f64x2){0,0};
    STORE(p,x); STORE(p+16,mask);
    return 1;
}
API u64 vector_lcg(u8 *p, u64 n) {
    u32x4 x; LOAD(x,p);
    const u32x4 add = {1,3,5,7};
    for (u64 i=0;i<n;i++) x = (x << 2) + x + add;
    STORE(p,x);
    return (u64)x[0] + x[1] + x[2] + x[3];
}
