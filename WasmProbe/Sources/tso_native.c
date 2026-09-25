#include "tso_native.h"
#include <pthread.h>
#include <time.h>

static uint64_t g_shared[16] __attribute__((aligned(128)));
static uint64_t g_private[8][32] __attribute__((aligned(128)));   // 256 bytes apart per thread

struct job { int variant, stores; long iters; uint64_t *priv; double ns; };

#define LOOP(LOAD, STORE)                                                          \
    for (long i = 0; i < j->iters; i++) {                                          \
        uint64_t a, b, c, d;                                                       \
        __asm__ volatile(LOAD("%0", "[%4]") LOAD("%1", "[%5]") LOAD("%2", "[%6]") LOAD("%3", "[%7]") \
                         : "=&r"(a), "=&r"(b), "=&r"(c), "=&r"(d)                   \
                         : "r"(&g_shared[0]), "r"(&g_shared[1]), "r"(&g_shared[2]), "r"(&g_shared[3]) \
                         : "memory");                                              \
        acc += a + b + c + d;                                                      \
        if (j->stores) {                                                           \
            __asm__ volatile(STORE("%0", "[%1]") STORE("%0", "[%2]")               \
                             : : "r"(acc), "r"(&j->priv[0]), "r"(&j->priv[1]) : "memory"); \
        }                                                                          \
    }

#define L_PLAIN(r, m) "ldr " r ", " m "\n"
#define S_PLAIN(r, m) "str " r ", " m "\n"
#define L_RCPC(r, m) ".arch_extension rcpc\n ldapr " r ", " m "\n"
#define S_REL(r, m) "stlr " r ", " m "\n"
#define L_HALF(r, m) "ldr " r ", " m "\n dmb ishld\n"
#define S_FULL(r, m) "dmb ish\n str " r ", " m "\n"
#define L_FULL(r, m) "ldr " r ", " m "\n dmb ish\n"

static void *run(void *p) {
    struct job *j = p;
    uint64_t acc = 0;
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    __asm__ volatile(".arch_extension rcpc");
    switch (j->variant) {
    case 0: LOOP(L_PLAIN, S_PLAIN); break;
    case 1: LOOP(L_RCPC, S_REL); break;
    case 2: LOOP(L_HALF, S_FULL); break;
    default: LOOP(L_FULL, S_FULL); break;
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    j->ns = ((t1.tv_sec - t0.tv_sec) * 1e9 + (t1.tv_nsec - t0.tv_nsec)) / (double)j->iters;
    j->priv[4] = acc;
    return 0;
}

double tso_native_bench(int Variant, int WithStores, int Threads, long Iters) {
    pthread_t t[8];
    struct job jobs[8];
    if (Threads > 8) Threads = 8;
    for (int i = 0; i < Threads; i++) {
        jobs[i] = (struct job){Variant, WithStores, Iters, g_private[i], 0};
        pthread_create(&t[i], 0, run, &jobs[i]);
    }
    double worst = 0;
    for (int i = 0; i < Threads; i++) {
        pthread_join(t[i], 0);
        if (jobs[i].ns > worst) worst = jobs[i].ns;
    }
    return worst;
}
