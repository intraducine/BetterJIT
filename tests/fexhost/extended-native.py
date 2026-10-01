#!/usr/bin/env python3
"""Run the exact bundled SSE2 images directly on an x86-64 Linux test host.
Not FEX validation, Apple execution or an iOS native-JIT mechanism.
"""
import base64, ctypes, hashlib, json, mmap, pathlib, platform, random, re, struct, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
if platform.system()!='Linux' or platform.machine() not in ('x86_64','AMD64'):
    print('SKIP: direct x86 execution requires an x86-64 Linux test host.');raise SystemExit(0)
source=(ROOT/'Examples/FEXHost/ExtendedGuest.swift').read_text()
images={abi:base64.b64decode(re.search(r'static let '+abi+r' = "([^"]+)"',source)[1]) for abi in ('sysv','win64')}
source_hash=re.search(r'static let sourceSHA256 = "([0-9a-f]+)"',source)[1]
assert hashlib.sha256((ROOT/'Examples/FEXHost/Guest/extended.c').read_bytes()).hexdigest()==source_hash, 'SSE2 source changed without regeneration'
for abi,image in images.items():
    expected=re.search(r'static let '+abi+r'SHA256 = "([0-9a-f]+)"',source)[1]
    assert hashlib.sha256(image).hexdigest()==expected, 'SSE2 image hash mismatch'
entries={abi:{k:int(v,16) for k,v in re.findall(r'"(\w+)": (0x[0-9a-f]+)',re.search(r'static let '+abi+r'Entries:.*?= \[([^\n]+)\]',source)[1])} for abi in images}
rows=json.loads(subprocess.check_output([str(ROOT/'.build/extended-tests'),'--vectors']))
with tempfile.TemporaryDirectory(prefix='betterjit-abi-') as tmp:
    tmp=pathlib.Path(tmp)
    (tmp/'bridge.c').write_text('typedef unsigned long long u64; typedef u64 (__attribute__((ms_abi))*Fn)(void*,u64); u64 bridge(void* f,void* p,u64 n){return ((Fn)f)(p,n);}\n')
    subprocess.run(['clang','-shared','-fPIC',str(tmp/'bridge.c'),'-o',str(tmp/'bridge.so')],check=True)
    bridge=ctypes.CDLL(str(tmp/'bridge.so')).bridge
    bridge.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_uint64];bridge.restype=ctypes.c_uint64
    mapped={};base={}
    for abi,data in images.items():
        m=mmap.mmap(-1,len(data),prot=mmap.PROT_READ|mmap.PROT_WRITE|mmap.PROT_EXEC);m.write(data)
        mapped[abi]=m;base[abi]=ctypes.addressof(ctypes.c_char.from_buffer(m))
    def call(abi,entry,input,n,output,expected):
        b=ctypes.create_string_buffer(input,len(input));ptr=ctypes.addressof(b)+19
        addr=base[abi]+entry-0x400000
        value=bridge(addr,ptr,n) if abi=='win64' else ctypes.CFUNCTYPE(ctypes.c_uint64,ctypes.c_void_p,ctypes.c_uint64)(addr)(ptr,n)
        assert value==expected,(abi,hex(entry),value,expected)
        assert b.raw==output,(abi,hex(entry),'guard/memory mismatch')
    def guarded(data):return bytes([0xa5])*19+data+bytes([0x5a])*17
    count=0
    for r in rows:
        call(r['abi'],r['entry'],base64.b64decode(r['input']),int(r['iterations']),base64.b64decode(r['memory']),int(r['expected']));count+=1
    rng=random.Random(0xbed17)
    for abi in images:
        for _ in range(32):
            x=[rng.getrandbits(32) for _ in range(4)];a=[1,0xffffffff,0x80000000,0x12345678]
            mixed=[((v+c)&0xffffffff)^(v>>7) for v,c in zip(x,a)];y=[mixed[i] for i in [2,0,3,1]]
            rot=[((v<<3)|(v>>29))&0xffffffff for v in y]
            call(abi,entries[abi]['vector_words'],guarded(struct.pack('<4I',*x)+bytes([0xcc])*16),0,guarded(struct.pack('<8I',*(y+rot))),1);count+=1
            signed=[rng.randrange(-32768,32768) for _ in range(16)];packed=[max(0,min(255,x)) for x in signed]
            output=bytes(packed+[min(255,x+17) for x in packed])
            call(abi,entries[abi]['vector_saturation'],guarded(struct.pack('<16h',*signed)),0,guarded(output),1);count+=1
    print(f'PASS: {count} direct SSE2 fixture/guard checks, including SysV and Win64. Not FEX or iOS.')
