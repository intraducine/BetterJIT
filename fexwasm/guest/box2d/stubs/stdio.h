#pragma once
#include <stddef.h>
#include <stdarg.h>
typedef struct FILE FILE;
extern FILE *stderr, *stdout;
int printf(const char *f, ...);
int fprintf(FILE *s, const char *f, ...);
int snprintf(char *b, size_t n, const char *f, ...);
int vsnprintf(char *b, size_t n, const char *f, va_list a);
int vfprintf(FILE *s, const char *f, va_list a);
int puts(const char *s);
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
FILE *fopen(const char *p, const char *m);
int fclose(FILE *f);
size_t fwrite(const void *p, size_t s, size_t n, FILE *f);
size_t fread(void *p, size_t s, size_t n, FILE *f);
int fseek(FILE *f, long o, int w);
long ftell(FILE *f);
int fflush(FILE *f);
