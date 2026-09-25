#include "storage_check.h"
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

// Present in libsystem; its header (libproc.h) is not in the iOS SDK.
extern int proc_pid_rusage(int pid, int flavor, rusage_info_t *buffer);

static double now_us(void) { return (double)clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000.0; }
static int cmp_d(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y; }

static void rand_reads(int fd, size_t bytes, int n, double *p50, double *avg, double *p99) {
    enum { IO = 16384 };
    void *buf; posix_memalign(&buf, IO, IO);
    double *lat = malloc(sizeof(double) * n), sum = 0;
    uint32_t x = 2463534242u, pages = (uint32_t)(bytes / IO);
    for (int i = 0; i < n; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        double t = now_us();
        pread(fd, buf, IO, (off_t)(x % pages) * IO);
        lat[i] = now_us() - t; sum += lat[i];
    }
    qsort(lat, n, sizeof(double), cmp_d);
    *p50 = lat[n / 2]; *avg = sum / n; *p99 = lat[n * 99 / 100];
    free(lat); free(buf);
}

static double seq_read(int fd, size_t bytes) {
    size_t chunk = 4u << 20; void *buf; posix_memalign(&buf, 16384, chunk);
    double t = now_us();
    for (size_t off = 0; off < bytes; off += chunk) pread(fd, buf, chunk, (off_t)off);
    double us = now_us() - t; free(buf);
    return (double)bytes / 1048576.0 / (us / 1e6);
}

int sh_storage_check(const char *path, size_t bytes, sh_storage_t *out) {
    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return -1;
    fcntl(fd, F_NOCACHE, 1);
    size_t chunk = 4u << 20; uint32_t *buf; posix_memalign((void **)&buf, 16384, chunk);
    uint32_t x = 1;
    for (size_t i = 0; i < chunk / 4; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; buf[i] = x; }
    double t = now_us();
    for (size_t off = 0; off < bytes; off += chunk) { buf[0] = (uint32_t)off; pwrite(fd, buf, chunk, (off_t)off); }
    fcntl(fd, F_FULLFSYNC);
    out->flashWriteMBps = (double)bytes / 1048576.0 / ((now_us() - t) / 1e6);
    free(buf);

    rand_reads(fd, bytes, 2000, &out->flashRandUsP50, &out->flashRandUsAvg, &out->flashRandUsP99);
    out->flashSeqReadMBps = seq_read(fd, bytes);

    fcntl(fd, F_NOCACHE, 0);
    seq_read(fd, bytes);                                   // populate the page cache
    out->cacheSeqReadMBps = seq_read(fd, bytes);
    rand_reads(fd, bytes, 2000, &out->cacheRandUsP50, &out->cacheRandUsAvg, &out->cacheRandUsP99);

    char *a = malloc(16384), *b = malloc(16384); memset(a, 1, 16384); memset(b, 2, 16384);
    t = now_us();
    for (int i = 0; i < 10000; i++) { memcpy(b, a, 16384); a[i & 16383] = (char)i; }
    out->ramMemcpy16kUs = (now_us() - t) / 10000;
    free(a); free(b);
    close(fd);
    unlink(path);
    return 0;
}

void sh_disk_counters(uint64_t *phys, uint64_t *logical) {
    struct rusage_info_v4 ri;
    if (proc_pid_rusage(getpid(), RUSAGE_INFO_V4, (rusage_info_t *)&ri) == 0) { *phys = ri.ri_diskio_byteswritten; *logical = ri.ri_logical_writes; }
    else { *phys = *logical = UINT64_MAX; }
}

uint64_t sh_doorbell_load(const char *path, double seconds, int mode) {
    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return 0;
    ftruncate(fd, 65536);
    volatile uint64_t *p = mmap(NULL, 65536, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    uint64_t iters = 0, v = 0;
    double end = now_us() + seconds * 1e6;
    while (now_us() < end) {
        for (int k = 0; k < 1000; k++, iters++) {
            if (mode == 0) p[512] = ++v;
            else { ++v; pwrite(fd, &v, 8, 4096); }
        }
    }
    munmap((void *)p, 65536);
    close(fd);
    unlink(path);
    return iters;
}
