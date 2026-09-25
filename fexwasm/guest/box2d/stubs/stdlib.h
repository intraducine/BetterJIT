#pragma once
#include <stddef.h>
void *malloc(size_t n);
void *calloc(size_t n, size_t s);
void *realloc(void *p, size_t n);
void free(void *p);
void *aligned_alloc(size_t a, size_t n);
#ifdef _WIN32 /* the MSVC CRT's names (core.c's default allocator on Windows) */
void *_aligned_malloc(size_t n, size_t a);
void _aligned_free(void *p);
#endif
int posix_memalign(void **p, size_t a, size_t n);
void abort(void);
int abs(int x);
// Both builds sort with the driver's det_qsort (see box2d_driver.c).
void det_qsort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *));
#define qsort det_qsort
