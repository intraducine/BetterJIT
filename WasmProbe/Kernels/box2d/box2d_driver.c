// Box2D v3 benchmark kernel: builds a benchmark scene and steps it n times,
// single-threaded; returns the world's deterministic state hash (folded to 32
// bits). Box2D is written for cross-platform determinism, so the x86-64 SSE2
// build (translated) and the arm64 NEON build (native) must agree.
#include "box2d/box2d.h"
#include "benchmarks.h"
#include <stddef.h>
#include <stdint.h>
#include <string.h>

void box2d_arena_reset(void);

// shared/utils.c (without its platform code) and a deterministic sin/cos for
// the scene setup, identical in the guest and native builds.
#include "utils.h"
uint32_t g_randomSeed = RAND_SEED;
b2Polygon RandomPolygon(float extent) {
    b2Vec2 points[B2_MAX_POLYGON_VERTICES];
    int count = 3 + RandomInt() % 6;
    for (int i = 0; i < count; ++i) points[i] = RandomVec2(-extent, extent);
    b2Hull hull = b2ComputeHull(points, count);
    return hull.count > 0 ? b2MakePolygon(&hull, 0.0f) : b2MakeSquare(extent);
}
int GetNumberOfCores(void) { return 1; }
// qsort for sensor.c, the same in both builds (libc sorts may order equal
// keys differently): a simple insertion sort on byte blocks.
void det_qsort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *)) {
    unsigned char *a = base, tmp[256];
    if (size > sizeof(tmp)) return;
    for (size_t i = 1; i < n; i++) {
        memcpy(tmp, a + i * size, size);
        size_t j = i;
        for (; j > 0 && cmp(a + (j - 1) * size, tmp) > 0; j--) memcpy(a + j * size, a + (j - 1) * size, size);
        memcpy(a + j * size, tmp, size);
    }
}
float det_sinf(float x) { return b2ComputeCosSin(x).sine; }
float det_cosf(float x) { return b2ComputeCosSin(x).cosine; }

// Box2D's allocator (both builds): power-of-two size classes with free
// lists over a 96 MB pool, reset per run. Box2D passes the size to free.
#define POOL_BYTES (96u << 20)
static _Alignas(64) unsigned char pool[POOL_BYTES];
static size_t pool_top;
static void *free_lists[32];
static int size_class(size_t n) {
    int c = 6;
    while (((size_t)1 << c) < n) c++;
    return c;
}
static volatile int pool_lock; // worker threads allocate too
static void lock(void) {
    while (__atomic_exchange_n(&pool_lock, 1, __ATOMIC_ACQUIRE)) {
        while (__atomic_load_n(&pool_lock, __ATOMIC_RELAXED)) {}
    }
}
static void unlock(void) { __atomic_store_n(&pool_lock, 0, __ATOMIC_RELEASE); }
static void *pool_alloc(size_t size, int alignment) {
    (void)alignment; // blocks are at least 64-byte aligned
    const int c = size_class(size);
    lock();
    void *p = free_lists[c];
    if (p) {
        free_lists[c] = *(void **)p;
    } else {
        if (pool_top + ((size_t)1 << c) > POOL_BYTES) __builtin_trap(); // out of memory: fail loudly
        p = pool + pool_top;
        pool_top += (size_t)1 << c;
    }
    unlock();
    return p;
}
static void pool_free(void *mem, size_t size) {
    const int c = size_class(size);
    lock();
    *(void **)mem = free_lists[c];
    free_lists[c] = mem;
    unlock();
}

// n: steps; bits 24..27 pick the scene (0 large pyramid, 1 many pyramids,
// 2 tumbler, 3 joint grid, 4 rain), bits 28..30 the worker count (threads
// from Box2D's own scheduler; the state hash doesn't depend on it).
uint32_t k_box2d(int n) {
    const int scene = (n >> 24) & 15, workers = (n >> 28) & 7;
    n &= 0xffffff;
    box2d_arena_reset();
    pool_top = 0;
    memset(free_lists, 0, sizeof(free_lists));
    b2SetAllocator(pool_alloc, pool_free);
    g_randomSeed = RAND_SEED;
    b2WorldDef def = b2DefaultWorldDef();
    if (workers > 1) def.workerCount = workers;
    b2WorldId world = b2CreateWorld(&def);
    switch (scene) {
    case 1: CreateManyPyramids(world); break;
    case 2: CreateTumbler(world); break;
    case 3: CreateJointGrid(world); break;
    case 4: CreateRain(world); break;
    default: CreateLargePyramid(world); break;
    }
    for (int i = 0; i < n; i++) {
        if (scene == 4) StepRain(world, i);
        b2World_Step(world, 1.0f / 60.0f, 4);
    }
    const uint64_t h = b2World_GetStateHash(world);
    b2DestroyWorld(world);
    return (uint32_t)(h ^ (h >> 32));
}

// One entry point per scene (the harness finds kernels by symbol).
uint32_t k_box2d_tumbler(int n) { return k_box2d((2 << 24) | (n & 0xffffff)); }
uint32_t k_box2d_joints(int n) { return k_box2d((3 << 24) | (n & 0xffffff)); }
uint32_t k_box2d_rain(int n) { return k_box2d((4 << 24) | (n & 0xffffff)); }

// Multithreaded: 4 workers (Box2D's scheduler threads + the caller).
uint32_t k_box2d_mt4(int n) { return k_box2d((4 << 28) | (n & 0xffffff)); }
uint32_t k_box2d_joints_mt4(int n) { return k_box2d((4 << 28) | (3 << 24) | (n & 0xffffff)); }
