#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Ordinary C fork/exec/wait parent; exact compiler output and native oracle."""
import argparse,base64,importlib.util,json,os,pathlib,platform,shlex,subprocess,tempfile
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('compiled_recipe',HERE/'build-sparse-rot13.py');recipe=importlib.util.module_from_spec(spec);spec.loader.exec_module(recipe)
def native(d):
 if platform.system()!='Linux'or platform.machine()not in['x86_64','AMD64']:raise RuntimeError('Native process oracle requires Linux x86-64')
 records=[]
 with tempfile.TemporaryDirectory(prefix='betterjit-pipeline-')as td:
  parent=pathlib.Path(td)/'parent';child=pathlib.Path(td)/'cat';parent.write_bytes(base64.b64decode(d['elf']));child.write_bytes(base64.b64decode(json.loads((HERE/'sparse-cat.json').read_text())['elf']));parent.chmod(0o700);child.chmod(0o700)
  for name,data,args,code in [('empty',b'',[str(child)],0),('text','A compiled parent and child. é🙂\n'.encode(),[str(child)],0),('boundary',b'x'*4095+'\ufeffsplit\n'.encode(),[str(child)],0),('missing',b'abc',[str(pathlib.Path(td)/'absent')],71),('argument',b'abc',[],64)]:
   p=subprocess.run([str(parent),*args],input=data,capture_output=True,timeout=5);out=data if code==0 else data[:1]if code==71 else b'';assert(p.returncode,p.stdout,p.stderr)==(code,out,b''),(name,p.returncode,p.stdout[:100],p.stderr);records.append({'id':name,'inputBytes':len(data),'exitCode':code,'stdoutBytes':len(p.stdout),'stdoutSHA256':recipe.digest(p.stdout)})
 return records
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=pathlib.Path);p.add_argument('--verify',type=pathlib.Path);p.add_argument('--cc',default=os.environ.get('CC','cc'));p.add_argument('--native-check',action='store_true');a=p.parse_args();d=json.loads(a.verify.read_text())if a.verify else recipe.build(shlex.split(a.cc),HERE/'sparse-pipeline.c');elf=base64.b64decode(d['elf'],validate=True)
 if d['schema']!=1 or d['source']!='sparse-pipeline.c'or d['sourceSHA256']!=recipe.digest((HERE/'sparse-pipeline.c').read_bytes())or d['elfSHA256']!=recipe.digest(elf)or d['flags']!=recipe.FLAGS:raise ValueError('Compiled process source/recipe/payload mismatch')
 if a.native_check:d['nativeOracle']=native(d)
 if a.output:a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(d,indent=2)+'\n')
 print(json.dumps({k:v for k,v in d.items()if k!='elf'},indent=2))
if __name__=='__main__':main()
