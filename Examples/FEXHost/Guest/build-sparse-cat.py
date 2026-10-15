#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build an unmodified freestanding C stdin-copy command with ordinary Linux CC."""
import argparse,base64,hashlib,importlib.util,json,os,pathlib,platform,shlex,subprocess,tempfile
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('compiled_recipe',HERE/'build-sparse-rot13.py');recipe=importlib.util.module_from_spec(spec);spec.loader.exec_module(recipe)
def inputs():
 return [('empty',b'',[],False),('text','Hello, BetterJIT stdin!\né🙂\n'.encode(),[],False),('split-utf8',b'x'*4095+'é🙂\n'.encode(),[],False),('large',(b'line: BetterJIT stdin 0123456789\n'*9000)[:256*1024],[],False),('argument',b'unconsumed',['unexpected'],False),('closed-stdin',b'',[],True)]
def native(d):
 if platform.system()!='Linux'or platform.machine()not in ['x86_64','AMD64']:raise RuntimeError('Native cat oracle requires Linux x86-64')
 records=[]
 with tempfile.TemporaryDirectory(prefix='betterjit-cat-')as td:
  file=pathlib.Path(td)/'cat';file.write_bytes(base64.b64decode(d['elf']));file.chmod(0o700)
  for name,data,args,closed in inputs():
   p=subprocess.run([str(file),*args],input=data,capture_output=True,timeout=5,preexec_fn=(lambda:os.close(0))if closed else None);code=74 if closed else 64 if args else 0;out=b''if code else data
   assert(p.returncode,p.stdout,p.stderr)==(code,out,b''),(name,p.returncode,p.stdout[:100],p.stderr)
   records.append({'id':name,'inputBytes':len(data),'inputSHA256':recipe.digest(data),'exitCode':code,'stdoutBytes':len(out),'stdoutSHA256':recipe.digest(p.stdout),'stderrBytes':len(p.stderr)})
 return records
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=pathlib.Path);p.add_argument('--verify',type=pathlib.Path);p.add_argument('--native-check',action='store_true');p.add_argument('--cc',default=os.environ.get('CC','cc'));a=p.parse_args()
 d=json.loads(a.verify.read_text())if a.verify else recipe.build(shlex.split(a.cc),HERE/'sparse-cat.c');elf=base64.b64decode(d['elf'],validate=True)
 if d['schema']!=1 or d['source']!='sparse-cat.c'or d['sourceSHA256']!=recipe.digest((HERE/'sparse-cat.c').read_bytes())or d['elfSHA256']!=recipe.digest(elf)or d['flags']!=recipe.FLAGS:raise ValueError('Compiled stdin fixture source/recipe/payload mismatch')
 if a.native_check:d['nativeOracle']=native(d)
 if a.output:a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(d,indent=2)+'\n')
 print(json.dumps({k:v for k,v in d.items()if k!='elf'},indent=2))
if __name__=='__main__':main()
