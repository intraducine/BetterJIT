#!/bin/bash
# Builds a freestanding x86-64 guest image from C: guest/out/<name>.bin is the
# flat memory image starting at 0x5000_0040_0000 (guest window 0x5000_0000_0000; wasm offset = low 32 bits), <name>.syms the symbol addresses.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
name=$1; shift
LLVM=/opt/homebrew/opt/llvm/bin
CFLAGS=(--target=x86_64-linux-gnu -O2 -ffreestanding -fpie -fno-stack-protector -fno-asynchronous-unwind-tables
  -fno-math-errno -mno-red-zone "$@")
clang "${CFLAGS[@]}" -c -o out/$name.o src/$name.c
clang "${CFLAGS[@]}" -c -o out/rt.o src/rt.c
if [[ $name == suite ]]; then # Box2D (build_box2d.sh) goes into the suite too
  ./build_box2d.sh >/dev/null
  EXTRA_OBJS=$(ls out/box2d/*.o)
fi
/opt/homebrew/bin/ld.lld -static -nostdlib --no-dynamic-linker -e 0 -Ttext=0x500000400000 --image-base=0x500000400000 \
  -z norelro -z noseparate-code -o out/$name.elf out/$name.o out/rt.o ${EXTRA_OBJS:-}
$LLVM/llvm-objcopy -O binary out/$name.elf out/$name.bin
$LLVM/llvm-nm --defined-only out/$name.elf | awk '{print $3, $1}' | sort > out/$name.syms
$LLVM/llvm-nm --defined-only out/$name.elf | awk '$2 ~ /^[tT]$/ {print $3, $1}' | sort > out/$name.funcs # code symbols
ls -la out/$name.bin; head -20 out/$name.syms
