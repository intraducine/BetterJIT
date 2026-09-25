#pragma once
#include <stdint.h>
#include <stddef.h>

typedef struct {
    double flashWriteMBps, flashSeqReadMBps, flashRandUsP50, flashRandUsAvg, flashRandUsP99;
    double cacheSeqReadMBps, cacheRandUsP50, cacheRandUsAvg, cacheRandUsP99, ramMemcpy16kUs;
} sh_storage_t;

// Raw flash (F_NOCACHE) vs page-cache numbers for a `bytes`-sized file at `path`.
int sh_storage_check(const char *path, size_t bytes, sh_storage_t *out);
// This process's disk counters (physical bytes written, logical bytes written).
void sh_disk_counters(uint64_t *phys, uint64_t *logical);
// Keeps re-dirtying one word of a MAP_SHARED mapping (mode 0) or pwrite()s 8
// bytes (mode 1) to `path` for `seconds`; returns iterations.
uint64_t sh_doorbell_load(const char *path, double seconds, int mode);
