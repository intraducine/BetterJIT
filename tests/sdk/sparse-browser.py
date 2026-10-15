#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Real Chromium + live FEX sparse compiled command; no Swift/WebKit/device claim."""
import argparse,base64,hashlib,http.server,json,pathlib,socket,subprocess,tempfile,threading,time,urllib.parse,urllib.request
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[2]
def expected(arg):
 if arg is None:return 64,'','usage: rot13 TEXT\n'
 if len(arg.encode())>255:return 65,'','input too long\n'
 return 0,''.join(chr(ord(c)+(13 if c.lower()<'n'else-13))if 'a'<=c.lower()<='z'else c for c in arg)+'\n',''
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--translator',required=True);p.add_argument('--chromium',default='/usr/bin/chromium');p.add_argument('--program',choices=['rot13','cat'],default='rot13');p.add_argument('--fixture',type=pathlib.Path);p.add_argument('--output',type=pathlib.Path);a=p.parse_args();a.fixture=a.fixture or ROOT/('Examples/FEXHost/Guest/sparse-'+a.program+'.json')
 fixture=json.loads(a.fixture.read_text());elf=base64.b64decode(fixture['elf']);events=[]
 with socket.socket()as s:s.bind(('127.0.0.1',0));native_port=s.getsockname()[1]
 native=subprocess.Popen([a.translator,'--linux',str(native_port),'guestmem=broker1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 def request(route,data=None):return urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:'+str(native_port)+route,data=data),timeout=10).read()
 class Handler(http.server.BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def reply(self,body,kind='application/json',status=200):
   self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.send_header('Cross-Origin-Opener-Policy','same-origin');self.send_header('Cross-Origin-Embedder-Policy','require-corp');self.send_header('Cross-Origin-Resource-Policy','same-origin');self.end_headers();self.wfile.write(body)
  def do_GET(self):
   path=urllib.parse.urlsplit(self.path).path
   try:
    if path=='/test/result':self.reply(json.dumps({'done':any(e['kind']in['exit','failure','unsupported']for e in events)}).encode())
    elif path.startswith('/xlat/'):self.reply(request(self.path),'application/octet-stream')
    elif path=='/fs/file':self.reply(elf,'application/octet-stream')
    elif path=='/stdin':self.reply(self.server.input,'application/octet-stream')
    elif path.startswith('/linux/')and'..'not in path.split('/'):
     f=ROOT/'Sources/BetterJITLinux/Resources'/path[1:];self.reply(f.read_bytes(),'text/html'if f.suffix=='.html'else'text/javascript')
    else:self.reply(b'',status=404)
   except Exception as e:self.reply(str(e).encode(),'text/plain',500)
  def do_POST(self):
   data=self.rfile.read(int(self.headers.get('Content-Length','0')))
   try:
    if self.path=='/events':
     d=json.loads(data);assert d['sequence']==self.server.sequence;self.server.sequence+=1;events.extend(d['events']);self.reply(b'')
    elif self.path.startswith('/xlat/'):self.reply(request(self.path,data),'application/octet-stream')
    else:self.reply(b'',status=404)
   except Exception as e:self.reply(str(e).encode(),'text/plain',500)
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.sequence=0;server.input=b'';threading.Thread(target=server.serve_forever,daemon=True).start();records=[]
 if a.program=='rot13':cases=[{'id':str(i),'argument':arg,'argv':['/test/rot13']+([]if arg is None else[arg]),'input':b'','expected':expected(arg)}for i,arg in enumerate(['Hello, BetterJIT 2026!','','AaNnZz09- é🙂',None,'x'*256])]
 else:
  data=[b'','Hello, BetterJIT stdin!\né🙂\n'.encode(),b'x'*4095+'é🙂\n'.encode(),(b'line: BetterJIT stdin 0123456789\n'*9000)[:256*1024],b'unconsumed']
  cases=[{'id':name,'argument':None,'argv':['/test/cat']+(['unexpected']if i==4 else[]),'input':value,'expected':(64,'','')if i==4 else(0,value.decode(),'')}for i,(name,value)in enumerate(zip(['empty','text','split-utf8','large','argument'],data))]
 try:
  for _ in range(200):
   try:cfg=json.loads(request('/xlat/config?space=1'));break
   except Exception:time.sleep(.025)
  else:raise RuntimeError('Native translator did not start')
  with sync_playwright()as pw:
   browser=pw.chromium.launch(executable_path=a.chromium,headless=True,args=['--no-sandbox'])
   try:
    for case in cases:
     arg=case['argument'];events.clear();server.sequence=0;server.input=case['input'];page=browser.new_page();argv=case['argv'];url='http://127.0.0.1:'+str(server.server_port)+'/linux/web/sparse.html?'+urllib.parse.urlencode({'argv':json.dumps(argv),'env':'{}','stdin':'1'})
     try:
      page.goto(url)
      deadline=time.monotonic()+60
      while not any(e['kind']in['exit','failure','unsupported']for e in events):
       if time.monotonic()>deadline:raise RuntimeError('Browser command timed out: '+page.locator('#out').inner_text())
       page.wait_for_timeout(20)
      errors=[e for e in events if e['kind']in['failure','unsupported']];assert not errors,errors
      code=next(e['code']for e in events if e['kind']=='exit');stdout=''.join(e['text']for e in events if e['kind']=='stdout');stderr=''.join(e['text']for e in events if e['kind']=='stderr');assert(code,stdout,stderr)==case['expected'],(case['id'],code,len(stdout),stderr)
      line=next(e['text']for e in events if e['kind']=='log'and e['text'].startswith('[sparse-command]'));report=json.loads(line[len('[sparse-command] '):]);assert report['broker']['threads']==0 and report['retainedUntilSessionTeardown']and not report['workerRetirementAcknowledged']and report['backing']['ownedPayloadBytes']>0
      assert report['stdin']['providedBytes']==len(case['input'])and report['stdin']['consumedBytes']==(len(case['input'])if code==0 else 0)
      records.append({'id':case['id'],'argument':arg,'exitCode':code,'stdout':stdout if a.program=='rot13'else stdout[:64],'stdoutBytes':len(stdout.encode()),'stdoutSHA256':hashlib.sha256(stdout.encode()).hexdigest(),'stderr':stderr,'runtime':report})
     finally:page.close();request('/xlat/drop?space=1')
    events.clear();server.sequence=0;page=browser.new_page();page.add_init_script("Object.defineProperty(globalThis,'crossOriginIsolated',{value:false});")
    try:
     page.goto('http://127.0.0.1:'+str(server.server_port)+'/linux/web/sparse.html')
     deadline=time.monotonic()+5
     while not any(e['kind']=='unsupported'for e in events):
      if time.monotonic()>deadline:raise RuntimeError('Missing explicit unsupported control')
      page.wait_for_timeout(20)
     assert [e['kind']for e in events]==['unsupported'];unsupported=events.copy()
    finally:page.close()
   finally:browser.close()
  out={'evidence':'Actual Chromium workers execute an ordinary GCC-produced C ELF through fresh native FEX/Wasm, checked sparse storage and output syscalls. Single-process normal exit only; backing retained until whole-session teardown, no Worker termination acknowledgement or reuse claim. This is not Swift/WebKit/device execution.','cfg':cfg,'fixtureSHA256':fixture['elfSHA256'],'records':records,'syntheticMissingIsolationControl':unsupported}
  text=json.dumps(out,indent=2);print(text)
  if a.output:a.output.write_text(text+'\n')
 finally:
  server.shutdown();server.server_close();native.terminate()
  try:native.wait(timeout=3)
  except subprocess.TimeoutExpired:native.kill();native.wait(timeout=3)
if __name__=='__main__':main()
