// SPDX-License-Identifier: GPL-3.0-or-later
// Force both immediate encodings; an assembler may otherwise shorten 81 to 83.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>

#define AND(bytes) __asm__ volatile("movb $0x80,%%cl; addb %%cl,%%cl; " bytes "; pushfq; pop %0" \
  : "=&r"(flags), "+a"(value) : : "rcx", "cc", "memory")

int main(void) {
  const uint64_t values[] = {0, 1, 0x7f, 0x80, 0xffffffff, UINT64_MAX,
                            UINT64_C(0x8000000080000080), UINT64_C(0x123456789abcdef)};
  int comma = 0;
  puts("[");
  for (unsigned op = 0; op < 16; op++) {
    for (unsigned i = 0; i < sizeof(values) / sizeof(values[0]); i++) {
      uint64_t value = values[i], flags;
      switch (op) {
      case 0: AND(".byte 0x83,0xe0,0xf0"); break;
      case 1: AND(".byte 0x48,0x83,0xe0,0xf0"); break;
      case 2: AND(".byte 0x83,0xe0,0x80"); break;
      case 3: AND(".byte 0x48,0x83,0xe0,0x80"); break;
      case 4: AND(".byte 0x83,0xe0,0x7f"); break;
      case 5: AND(".byte 0x48,0x83,0xe0,0x7f"); break;
      case 6: AND(".byte 0x83,0xe0,0x00"); break;
      case 7: AND(".byte 0x48,0x83,0xe0,0x00"); break;
      case 8: AND(".byte 0x81,0xe0,0xf0,0xff,0xff,0xff"); break;
      case 9: AND(".byte 0x48,0x81,0xe0,0xf0,0xff,0xff,0xff"); break;
      case 10: AND(".byte 0x81,0xe0,0x00,0x00,0x00,0x80"); break;
      case 11: AND(".byte 0x48,0x81,0xe0,0x00,0x00,0x00,0x80"); break;
      case 12: AND(".byte 0x81,0xe0,0xff,0xff,0xff,0x7f"); break;
      case 13: AND(".byte 0x48,0x81,0xe0,0xff,0xff,0xff,0x7f"); break;
      case 14: AND(".byte 0x81,0xe0,0x00,0x00,0x00,0x00"); break;
      default: AND(".byte 0x48,0x81,0xe0,0x00,0x00,0x00,0x00"); break;
      }
      // CF/PF/ZF/SF/OF are defined. AND leaves AF undefined.
      printf("%s{\"op\":%u,\"input\":\"0x%" PRIx64 "\",\"result\":\"0x%" PRIx64
             "\",\"flags\":%u}", comma ? ",\n" : "", op, values[i], value, (unsigned)flags & 0x8c5);
      comma = 1;
    }
  }
  puts("\n]");
  return 0;
}
