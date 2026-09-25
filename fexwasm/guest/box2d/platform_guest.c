// Box2D's platform layer (timer.c) for the freestanding x86-64 guest, on the
// runtime's syscalls: threads (1000 create, 1001 exit), futex (202) and
// sched_yield (24). Mutexes and semaphores are futex-based. Without thread
// support (syscall 1000 fails) a thread counts as exited right away, without
// running: Box2D's scheduler then runs every task on the calling thread.
#include "core.h"
#include "box2d/base.h"
#include <stdint.h>

static intptr_t sys3(intptr_t n, intptr_t a, intptr_t b, intptr_t c) { // (long is 32-bit on Win64)
    intptr_t r;
    __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
    return r;
}
static void futex_wait(volatile int *addr, int val) { sys3(202, (intptr_t)addr, 0, val); }
static void futex_wake(volatile int *addr, int count) { sys3(202, (intptr_t)addr, 1, count); }

uint64_t b2GetTicks( void ) { return 0; }
float b2GetMilliseconds( uint64_t ticks ) { (void)ticks; return 0.0f; }
float b2GetMillisecondsAndReset( uint64_t* ticks ) { *ticks = 0; return 0.0f; }
void b2Yield( void ) { sys3(24, 0, 0, 0); }

// Mutex: 0 free, 1 locked, 2 locked with waiters.
struct b2Mutex { volatile int state; };
#define MAX_OBJECTS 64
static b2Mutex mutexes[MAX_OBJECTS];
static volatile int mutexCount;
b2Mutex* b2CreateMutex( void ) {
    b2Mutex* m = &mutexes[__atomic_fetch_add(&mutexCount, 1, __ATOMIC_SEQ_CST) % MAX_OBJECTS];
    m->state = 0;
    return m;
}
void b2DestroyMutex( b2Mutex* m ) { (void)m; }
void b2LockMutex( b2Mutex* m ) {
    int c = 0;
    if (__atomic_compare_exchange_n(&m->state, &c, 1, 0, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) return;
    if (c != 2) c = __atomic_exchange_n(&m->state, 2, __ATOMIC_ACQUIRE);
    while (c != 0) {
        futex_wait(&m->state, 2);
        c = __atomic_exchange_n(&m->state, 2, __ATOMIC_ACQUIRE);
    }
}
void b2UnlockMutex( b2Mutex* m ) {
    if (__atomic_exchange_n(&m->state, 0, __ATOMIC_RELEASE) == 2) futex_wake(&m->state, 1);
}

struct b2Semaphore { volatile int count; };
static b2Semaphore semaphores[MAX_OBJECTS];
static volatile int semaphoreCount;
b2Semaphore* b2CreateSemaphore( int initCount ) {
    b2Semaphore* s = &semaphores[__atomic_fetch_add(&semaphoreCount, 1, __ATOMIC_SEQ_CST) % MAX_OBJECTS];
    s->count = initCount;
    return s;
}
void b2DestroySemaphore( b2Semaphore* s ) { (void)s; }
void b2WaitSemaphore( b2Semaphore* s ) {
    for (;;) {
        int c = __atomic_load_n(&s->count, __ATOMIC_ACQUIRE);
        if (c > 0) {
            if (__atomic_compare_exchange_n(&s->count, &c, c - 1, 0, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) return;
            continue;
        }
        futex_wait(&s->count, c);
    }
}
void b2SignalSemaphore( b2Semaphore* s ) {
    __atomic_fetch_add(&s->count, 1, __ATOMIC_RELEASE);
    futex_wake(&s->count, 1);
}

// Threads: stacks from a static pool; a thread runs thread_entry(t).
#define MAX_THREADS 16
#define STACK_BYTES (256 * 1024)
struct b2Thread { b2ThreadFunction* fn; void* ctx; volatile int done; int slot; };
static b2Thread threads[MAX_THREADS];
static _Alignas(64) unsigned char stacks[MAX_THREADS][STACK_BYTES];
static volatile int slotUsed[MAX_THREADS];

static void thread_entry(b2Thread* t) {
    t->fn(t->ctx);
    __atomic_store_n(&t->done, 1, __ATOMIC_SEQ_CST);
    futex_wake(&t->done, 1 << 30);
    sys3(1001, 0, 0, 0); // thread exit: doesn't return
    __builtin_trap();
}

b2Thread* b2CreateThread( b2ThreadFunction* function, void* context, const char* name ) {
    (void)name;
    for (int i = 0; i < MAX_THREADS; i++) {
        int zero = 0;
        if (!__atomic_compare_exchange_n(&slotUsed[i], &zero, 1, 0, __ATOMIC_SEQ_CST, __ATOMIC_RELAXED)) continue;
        b2Thread* t = &threads[i];
        t->fn = function;
        t->ctx = context;
        t->done = 0;
        t->slot = i;
        // The stack top, 16-byte aligned, less a (zero) return address slot.
        uintptr_t top = ((uintptr_t)(stacks[i] + STACK_BYTES) & ~(uintptr_t)15) - 8;
        *(uintptr_t*)top = 0;
        if (sys3(1000, (intptr_t)thread_entry, (intptr_t)t, (intptr_t)top) < 0) t->done = 1; // no threads
        return t;
    }
    __builtin_trap();
}
void b2JoinThread( b2Thread* t ) {
    while (!__atomic_load_n(&t->done, __ATOMIC_ACQUIRE)) futex_wait(&t->done, 0);
    __atomic_store_n(&slotUsed[t->slot], 0, __ATOMIC_RELEASE);
}
