// The rest of the libc that Box2D and its benchmark scenes need in the guest:
// string functions, an arena allocator (box2d_driver.c resets it per run) and
// output that goes nowhere.
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>

void *memcpy(void *d, const void *s, size_t n);
int memcmp(const void *a, const void *b, size_t n) {
    const unsigned char *x = a, *y = b;
    for (size_t i = 0; i < n; i++)
        if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
}
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
int strcmp(const char *a, const char *b) {
    while (*a && *a == *b) a++, b++;
    return (unsigned char)*a - (unsigned char)*b;
}
int strncmp(const char *a, const char *b, size_t n) {
    for (; n && *a && *a == *b; n--) a++, b++;
    return n ? (unsigned char)*a - (unsigned char)*b : 0;
}
char *strncpy(char *d, const char *s, size_t n) {
    size_t i = 0;
    for (; i < n && s[i]; i++) d[i] = s[i];
    for (; i < n; i++) d[i] = 0;
    return d;
}
int abs(int x) { return x < 0 ? -x : x; }

// Arena: 64 MB, 64-byte aligned blocks with an 8-byte size header; free is a
// no-op. box2d_arena_reset() starts over (the driver calls it per run).
#define ARENA_BYTES (16u << 20)
static _Alignas(64) unsigned char arena[ARENA_BYTES];
static size_t arena_top;
void box2d_arena_reset(void) { arena_top = 0; }
void *aligned_alloc(size_t a, size_t n) {
    if (a < 16) a = 16;
    size_t p = (arena_top + 8 + a - 1) & ~(a - 1);
    if (p + n > ARENA_BYTES) __builtin_trap(); // out of memory: fail loudly
    ((uint64_t *)(arena + p))[-1] = n;
    arena_top = p + n;
    return arena + p;
}
void *malloc(size_t n) { return aligned_alloc(16, n); }
void *calloc(size_t n, size_t s) {
    unsigned char *p = malloc(n * s);
    if (p) for (size_t i = 0; i < n * s; i++) p[i] = 0;
    return p;
}
void free(void *p) { (void)p; }
#ifdef _WIN32
void *_aligned_malloc(size_t n, size_t a) { return aligned_alloc(a, n); }
void _aligned_free(void *p) { (void)p; }
#endif
void *realloc(void *p, size_t n) {
    void *q = malloc(n);
    if (p && q) {
        size_t old = ((uint64_t *)p)[-1];
        memcpy(q, p, old < n ? old : n);
    }
    return q;
}
int posix_memalign(void **p, size_t a, size_t n) { *p = aligned_alloc(a, n); return *p ? 0 : 12; }
void abort(void) { __builtin_trap(); }

typedef struct FILE FILE;
FILE *stderr, *stdout;
int printf(const char *f, ...) { (void)f; return 0; }
int fprintf(FILE *s, const char *f, ...) { (void)s; (void)f; return 0; }
int vfprintf(FILE *s, const char *f, va_list a) { (void)s; (void)f; (void)a; return 0; }
int vsnprintf(char *b, size_t n, const char *f, va_list a) { (void)f; (void)a; if (n) b[0] = 0; return 0; }
int snprintf(char *b, size_t n, const char *f, ...) { (void)f; if (n) b[0] = 0; return 0; }
int puts(const char *s) { (void)s; return 0; }

FILE *fopen(const char *p, const char *m) { (void)p; (void)m; return 0; }
int fclose(FILE *f) { (void)f; return 0; }
size_t fwrite(const void *p, size_t s, size_t n, FILE *f) { (void)p; (void)s; (void)n; (void)f; return 0; }
size_t fread(void *p, size_t s, size_t n, FILE *f) { (void)p; (void)s; (void)n; (void)f; return 0; }
int fseek(FILE *f, long o, int w) { (void)f; (void)o; (void)w; return -1; }
long ftell(FILE *f) { (void)f; return -1; }
int fflush(FILE *f) { (void)f; return 0; }

// roundf (half away from zero, sign kept) and floorf/ceilf: SSE2 has no
// rounding instruction, so the compiler calls these.
float roundf(float x) {
    if (!(__builtin_fabsf(x) < 8388608.0f)) return x; // integral already, or NaN
    float t = (float)(int)x;
    if (__builtin_fabsf(x - t) >= 0.5f) t += x < 0 ? -1.0f : 1.0f;
    return __builtin_copysignf(t, x);
}
float floorf(float x) {
    if (!(__builtin_fabsf(x) < 8388608.0f)) return x;
    float t = (float)(int)x;
    return __builtin_copysignf(t > x ? t - 1.0f : t, x);
}
float ceilf(float x) {
    if (!(__builtin_fabsf(x) < 8388608.0f)) return x;
    float t = (float)(int)x;
    return __builtin_copysignf(t < x ? t + 1.0f : t, x);
}
