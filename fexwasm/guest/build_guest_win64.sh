#!/bin/bash
# The suite (kernels, CoreMark, Box2D) built for the Win64 ABI, the calling
# convention of the Windows games Wine runs: clang's x86_64-w64-windows-gnu
# target, linked by lld-link as a PE at the same base as the ELF suite and
# laid out as a flat image (headers at the base, each section at its RVA).
#   out/suite_w64.bin, .syms, .funcs (like build_guest.sh)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out/w64
LLVM=/opt/homebrew/opt/llvm/bin
F=(--target=x86_64-w64-windows-gnu -O2 -ffreestanding -fno-stack-protector -fno-asynchronous-unwind-tables -fno-math-errno
  -mno-stack-arg-probe -ffp-contract=off -DNDEBUG)
B=(-isystem box2d/stubs -Ibox2d/include -Ibox2d/src -Ibox2d/shared)
clang "${F[@]}" -c -o out/w64/suite.o src/suite.c &
clang "${F[@]}" -c -o out/w64/rt.o src/rt.c &
for f in box2d/src/*.c box2d/shared/benchmarks.c box2d/shared/human.c box2d/platform_guest.c box2d/libc_stub.c box2d/box2d_driver.c; do
  clang "${F[@]}" "${B[@]}" -c -o "out/w64/b2_$(basename "${f%.c}").o" "$f" &
done
wait
/opt/homebrew/bin/lld-link /nologo /nodefaultlib /noentry /dll /base:0x500000400000 /fixed /dynamicbase:no /highentropyva:no \
  /debug:symtab /out:out/suite_w64.dll out/w64/*.o
python3 - <<'PY'
import struct
d = open('out/suite_w64.dll', 'rb').read()
pe = struct.unpack_from('<I', d, 0x3c)[0]
nsec = struct.unpack_from('<H', d, pe + 6)[0]
optsz = struct.unpack_from('<H', d, pe + 20)[0]
opt = pe + 24
base = struct.unpack_from('<Q', d, opt + 24)[0]
hdrs = struct.unpack_from('<I', d, opt + 60)[0]
img = bytearray(d[:hdrs])
for i in range(nsec):
    s = opt + optsz + 40 * i
    name = d[s:s + 8].rstrip(b'\0').decode()
    vsize, rva, rawsize, rawptr = struct.unpack_from('<IIII', d, s + 8)
    end = rva + max(vsize, rawsize)
    if len(img) < end:
        img.extend(b'\0' * (end - len(img)))
    img[rva:rva + min(rawsize, vsize or rawsize)] = d[rawptr:rawptr + min(rawsize, vsize or rawsize)]
open('out/suite_w64.bin', 'wb').write(bytes(img).rstrip(b'\0')) # (the zero tail is .bss)
print('base %#x, %d bytes' % (base, len(img)))
PY
$LLVM/llvm-nm --defined-only out/suite_w64.dll | awk '{print $3, $1}' | sort > out/suite_w64.syms
$LLVM/llvm-nm --defined-only out/suite_w64.dll | awk '$2 ~ /^[tT]$/ {print $3, $1}' | sort > out/suite_w64.funcs
grep -c . out/suite_w64.syms
