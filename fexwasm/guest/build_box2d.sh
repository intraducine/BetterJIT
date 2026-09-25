#!/bin/bash
# Builds Box2D v3 (guest/box2d, MIT) as x86-64 guest objects in out/box2d/,
# for build_guest.sh to link into the suite: SSE2, no FP contraction (Box2D
# is cross-platform deterministic only without FMA), libc stubs.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out/box2d
F=(--target=x86_64-linux-gnu -O2 -ffreestanding -fpie -fno-stack-protector -fno-asynchronous-unwind-tables -fno-math-errno
  -mno-red-zone -ffp-contract=off -DNDEBUG -isystem box2d/stubs -Ibox2d/include -Ibox2d/src -Ibox2d/shared)
for f in box2d/src/*.c box2d/shared/benchmarks.c box2d/shared/human.c box2d/platform_guest.c box2d/libc_stub.c box2d/box2d_driver.c; do
  clang "${F[@]}" -c -o "out/box2d/$(basename "${f%.c}").o" "$f" &
done
wait
ls out/box2d/*.o | wc -l
