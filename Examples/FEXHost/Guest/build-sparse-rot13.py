#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Compile a freestanding C ROT13 command using an ordinary Linux x86-64 C compiler.

The only assembly is syscall wrappers and a three-instruction process entry shim.
No generated x86 instructions or ELF headers are rewritten.
"""
import argparse,base64,hashlib,json,os,pathlib,platform,shlex,subprocess,tempfile
HERE=pathlib.Path(__file__).resolve().parent
FLAGS=['-O1','-ffreestanding','-fno-stack-protector','-fno-asynchronous-unwind-tables','-fno-unwind-tables','-fno-ident','-nostdlib','-static','-no-pie','-Wl,--build-id=none','-Wl,-s']
def digest(b):return hashlib.sha256(b).hexdigest()
def load(path):
 d=json.loads(path.read_text());b=base64.b64decode(d['elf'],validate=True)
 if d['schema']!=1 or d['sourceSHA256']!=digest((HERE/'sparse-rot13.c').read_bytes())or d['elfSHA256']!=digest(b)or d['flags']!=FLAGS:raise ValueError('Compiled fixture source/recipe/payload mismatch')
 return d,b
def build(cc,source=HERE/'sparse-rot13.c'):
 with tempfile.TemporaryDirectory(prefix='betterjit-rot13-')as td:
  out=pathlib.Path(td)/'rot13';subprocess.run([*cc,*FLAGS,str(source),'-o',str(out)],check=True);b=out.read_bytes()
 return {'schema':1,'source':source.name,'sourceSHA256':digest(source.read_bytes()),'compiler':subprocess.check_output([*cc,'--version'],text=True).splitlines()[0],'flags':FLAGS,'elfSHA256':digest(b),'elf':base64.b64encode(b).decode()}
def native(d):
 if platform.system()!='Linux'or platform.machine()not in ['x86_64','AMD64']:raise RuntimeError('Native compiled oracle requires Linux x86-64')
 records=[]
 with tempfile.TemporaryDirectory(prefix='betterjit-rot13-native-')as td:
  file=pathlib.Path(td)/'rot13';file.write_bytes(base64.b64decode(d['elf']));file.chmod(0o700)
  for args,out,err,code in [(['Hello, BetterJIT 2026!'],'Uryyb, OrggreWVG 2026!\n','',0),([''],'\n','',0),(['AaNnZz09- é🙂'],'NnAaMm09- é🙂\n','',0),([], '', 'usage: rot13 TEXT\n',64),(['x'*256],'','input too long\n',65)]:
   p=subprocess.run([str(file),*args],capture_output=True,timeout=5);assert(p.returncode,p.stdout,p.stderr)==(code,out.encode(),err.encode()),(args,p.returncode,p.stdout,p.stderr);records.append({'arguments':args,'exitCode':p.returncode,'stdout':p.stdout.decode(),'stderr':p.stderr.decode()})
 return records
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=pathlib.Path);p.add_argument('--verify',type=pathlib.Path);p.add_argument('--native-check',action='store_true');p.add_argument('--cc',default=os.environ.get('CC','cc'));a=p.parse_args()
 if a.verify:d,_=load(a.verify)
 else:d=build(shlex.split(a.cc))
 if a.native_check:d['nativeOracle']=native(d)
 if a.output:a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(d,indent=2)+'\n')
 print(json.dumps({k:v for k,v in d.items()if k!='elf'},indent=2))
if __name__=='__main__':main()
