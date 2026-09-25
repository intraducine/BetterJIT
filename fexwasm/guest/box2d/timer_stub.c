// Single-threaded stand-ins for Box2D's timer.c (clocks, mutexes, semaphores,
// threads): the guest has no OS, and the benchmark runs without a task system.
#include "core.h"
#include "box2d/base.h"

uint64_t b2GetTicks( void ) { return 0; }
float b2GetMilliseconds( uint64_t ticks ) { (void)ticks; return 0.0f; }
float b2GetMillisecondsAndReset( uint64_t* ticks ) { *ticks = 0; return 0.0f; }
void b2Yield( void ) {}

struct b2Mutex { int unused; };
static b2Mutex g_mutex;
b2Mutex* b2CreateMutex( void ) { return &g_mutex; }
void b2DestroyMutex( b2Mutex* m ) { (void)m; }
void b2LockMutex( b2Mutex* m ) { (void)m; }
void b2UnlockMutex( b2Mutex* m ) { (void)m; }

struct b2Semaphore { int count; };
static b2Semaphore g_semaphore;
b2Semaphore* b2CreateSemaphore( int initCount ) { g_semaphore.count = initCount; return &g_semaphore; }
void b2DestroySemaphore( b2Semaphore* s ) { (void)s; }
void b2WaitSemaphore( b2Semaphore* s ) { s->count--; }
void b2SignalSemaphore( b2Semaphore* s ) { s->count++; }

b2Thread* b2CreateThread( b2ThreadFunction* function, void* context, const char* name )
{
	(void)name;
	function( context ); // runs to completion: there is only one thread
	return NULL;
}
void b2JoinThread( b2Thread* t ) { (void)t; }
