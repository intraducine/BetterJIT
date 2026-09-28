#!/usr/bin/env python3
"""Run the exact generated guest x86 on an x86-64 Linux host, NOT through FEX.

Checks the compiler-produced SysV/Win64 images against the independent Swift
oracles, including stack arguments and all guard bytes. Only our own fixed test
code is mapped executable; this is not an iOS implementation technique.
"""
import base64, ctypes, hashlib, json, mmap, pathlib, platform, re, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
def main():
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64','amd64'):
        print('SKIP: direct x86 fixture execution requires x86-64 Linux.');return
    source=(ROOT/'Examples/FEXHost/GuestImage.swift').read_text()
    source_hash=json.loads(re.search(r'static let sourceSHA256 = ("[^"\n]+")',source)[1])
    assert hashlib.sha256((ROOT/'Examples/FEXHost/Guest/kernels.c').read_bytes()).hexdigest()==source_hash, 'Guest source changed without regeneration'
    vectors=json.loads(subprocess.check_output([str(ROOT/'.build/fexhost-tests'),'--vectors']))
    argtypes=', '.join(['unsigned long long']*16)
    arguments=', '.join('a['+str(i)+']' for i in range(16))
    bridge=f'''typedef unsigned long long U;
    typedef U (__attribute__((ms_abi)) *WIN)({argtypes});
    typedef U (__attribute__((sysv_abi)) *SYS)({argtypes});
    U invoke(void *p, int win, U *a) {{return win ? ((WIN)p)({arguments}) : ((SYS)p)({arguments});}}
    '''
    with tempfile.TemporaryDirectory() as directory:
        d=pathlib.Path(directory);(d/'bridge.c').write_text(bridge)
        subprocess.run(['clang','-O2','-shared','-fPIC',str(d/'bridge.c'),'-o',str(d/'bridge.so')],check=True)
        lib=ctypes.CDLL(str(d/'bridge.so'));lib.invoke.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.POINTER(ctypes.c_uint64)];lib.invoke.restype=ctypes.c_uint64
        count=0
        for abi in ('sysv','win64'):
            image=base64.b64decode(json.loads(re.search(r'static let '+abi+r' = ("[^"\n]+")',source)[1]))
            digest=json.loads(re.search(r'static let '+abi+r'SHA256 = ("[^"\n]+")',source)[1])
            assert hashlib.sha256(image).hexdigest()==digest
            memory=mmap.mmap(-1,len(image),prot=mmap.PROT_READ|mmap.PROT_WRITE|mmap.PROT_EXEC)
            memory.write(image);address=ctypes.addressof(ctypes.c_char.from_buffer(memory))
            try:
                for v in vectors:
                    if v['abi'] != abi:continue
                    args=[int(s) for s in v['arguments']];buffer=None
                    if v['input']:
                        raw=base64.b64decode(v['input']);buffer=ctypes.create_string_buffer(raw,len(raw));args[0]=ctypes.addressof(buffer)+19
                    values=(ctypes.c_uint64*16)(*(args+[0]*(16-len(args))))
                    result=lib.invoke(address+v['entry']-0x400000,int(abi=='win64'),values)
                    assert result==int(v['expected']),(abi,v['id'],result,v['expected'])
                    if buffer is not None:assert buffer.raw==base64.b64decode(v['memory']),(abi,v['id'],'memory/guard mismatch')
                    count+=1
            finally: memory.close()
        print(f'PASS: {count} compiler-produced x86 executions match independent Swift expectations (both ABIs); not FEX/device measurements.')
if __name__=='__main__':main()
