// SPDX-License-Identifier: GPL-3.0-or-later
// Native Linux x86-64 instruction oracle, independent of FEX/Wasm.
#include <errno.h>
#include <inttypes.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static void row(const char *name, unsigned width, int cas, uint64_t initial, uint64_t operand, uint64_t desired, int comma) {
  uint64_t result = operand, flags = 0, after;
  if (width == 8) {
    uint64_t memory = initial;
    if (cas) __asm__ volatile("lock cmpxchgq %[desired], %[memory]; pushfq; popq %[flags]"
      : "+a"(result), [memory] "+m"(memory), [flags] "=r"(flags) : [desired] "r"(desired) : "cc", "memory");
    else __asm__ volatile("lock xaddq %[result], %[memory]; pushfq; popq %[flags]"
      : [result] "+r"(result), [memory] "+m"(memory), [flags] "=r"(flags) : : "cc", "memory");
    after = memory;
  } else {
    uint32_t memory = (uint32_t)initial;
    if (cas) __asm__ volatile("lock cmpxchgl %k[desired], %[memory]; pushfq; popq %[flags]"
      : "+a"(result), [memory] "+m"(memory), [flags] "=r"(flags) : [desired] "r"(desired) : "cc", "memory");
    else {
      uint32_t value = (uint32_t)operand;
      __asm__ volatile("lock xaddl %[result], %[memory]; pushfq; popq %[flags]"
        : [result] "+r"(value), [memory] "+m"(memory), [flags] "=r"(flags) : : "cc", "memory");
      result = value;
    }
    after = memory;
  }
  printf("%s{\"name\":\"%s\",\"width\":%u,\"operation\":%u,\"initial\":\"0x%016" PRIx64 "\","
         "\"operand\":\"0x%016" PRIx64 "\",\"desired\":\"0x%016" PRIx64 "\",\"register\":\"0x%016" PRIx64 "\","
         "\"memory\":\"0x%016" PRIx64 "\",\"flags\":\"0x%016" PRIx64 "\"}",
         comma ? "," : "", name, width, cas ? 3u : 4u, initial, operand, desired, result, after, flags);
}
static void fault(int signal_number) { (void)signal_number; _exit(77); }
static int mismatch_write_fault(void) {
  const long size = sysconf(_SC_PAGESIZE);
  uint64_t *memory = mmap(NULL, (size_t)size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (memory == MAP_FAILED) return 0;
  *memory = 7;
  if (mprotect(memory, (size_t)size, PROT_READ)) return 0;
  fflush(stdout);
  const pid_t child = fork();
  if (child < 0) return 0;
  if (!child) {
    struct sigaction action = {0}; action.sa_handler = fault; sigemptyset(&action.sa_mask);
    if (sigaction(SIGSEGV, &action, NULL)) _exit(78);
    uint64_t accumulator = 0, desired = 9;
    __asm__ volatile("lock cmpxchgq %[desired], %[memory]" : "+a"(accumulator), [memory] "+m"(*memory)
      : [desired] "r"(desired) : "cc", "memory");
    _exit(79);
  }
  int status = 0; pid_t reaped;
  do { reaped = waitpid(child, &status, 0); } while (reaped < 0 && errno == EINTR);
  munmap(memory, (size_t)size);
  return reaped == child && WIFEXITED(status) && WEXITSTATUS(status) == 77;
}
int main(void) {
  printf("{\"records\":[");
  row("cas64-success",8,1,7,7,9,0);
  row("cas64-mismatch",8,1,7,3,9,1);
  row("cas64-all-one",8,1,UINT64_MAX,UINT64_MAX,0,1);
  row("cas32-success-upper",4,1,7,UINT64_C(0x1234567800000007),9,1);
  row("cas32-mismatch-upper",4,1,UINT64_C(0x80000000),UINT64_C(0xffff000000000003),9,1);
  row("xadd64-wrap",8,0,UINT64_MAX,1,0,1);
  row("xadd64-overflow",8,0,UINT64_C(0x7fffffffffffffff),1,0,1);
  row("xadd32-wrap",4,0,UINT64_C(0xffffffff),1,0,1);
  row("xadd32-small",4,0,19,23,0,1);
  const int write_fault = mismatch_write_fault();
  printf("],\"failedCompareReadOnlyFault\":%s}\n", write_fault ? "true" : "false");
  return write_fault ? 0 : 1;
}
