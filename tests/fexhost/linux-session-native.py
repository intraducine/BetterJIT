#!/usr/bin/env python3
"""Check the exact bundled ELF on x86 Linux. This is NOT FEX or iPhone evidence."""
import base64, hashlib, json, pathlib, platform, re, subprocess, tempfile
root=pathlib.Path(__file__).resolve().parents[2]
source=(root/'Examples/FEXHost/LinuxSessionFixture.swift').read_text()
def literal(name):
    return json.loads(re.search(r'static let '+name+r' = ("[^"\n]+")', source)[1])
raw=base64.b64decode(re.search(r'Data\(base64Encoded: "([^"]+)"\)',source)[1])
assert hashlib.sha256(raw).hexdigest()==literal('elfSHA256')
assert hashlib.sha256((root/'Examples/FEXHost/Guest/linux-session.S').read_bytes()).hexdigest()==literal('sourceSHA256')
if platform.system()!='Linux' or platform.machine() not in ('x86_64','amd64'):
    print('SKIP direct Linux ELF execution: requires x86-64 Linux (fixture hashes checked)')
else:
    with tempfile.TemporaryDirectory() as tmp:
        path=pathlib.Path(tmp); elf=path/'session'; elf.write_bytes(raw); elf.chmod(0o700)
        # Missing and corrupt VFS data must fail, rather than printing a success marker.
        for data in (None, b'incorrect bytes\n', b'BetterJIT data\n'):
            if data is not None: (path/'session-input.txt').write_bytes(data)
            answer=subprocess.run([str(elf)],cwd=path,capture_output=True,timeout=5)
            if data==b'BetterJIT data\n':
                assert answer.returncode==0, (answer.returncode,answer.stderr)
                assert answer.stdout==b'BetterJIT Linux services OK\n',answer.stdout
            else:
                assert answer.returncode==1 and not answer.stdout,(answer.returncode,answer.stdout)
    print('PASS exact native x86 Linux fixture: file bytes, full-width GS base, mmap/mprotect/munmap, clock, random, clone/futex and exit; no FEX/device claim')
