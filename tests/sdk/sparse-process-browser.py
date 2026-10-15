#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Real Chromium compiled fork/exec/wait; quiescence, retained contexts, no physical retirement."""
import argparse,base64,hashlib,struct,http.server,json,pathlib,socket,subprocess,tempfile,threading,time,urllib.parse,urllib.request
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[2]
def expected(arg):
 if arg is None:return 64,'','usage: rot13 TEXT\n'
 if len(arg.encode())>255:return 65,'','input too long\n'
 return 0,''.join(chr(ord(c)+(13 if c.lower()<'n'else-13))if 'a'<=c.lower()<='z'else c for c in arg)+'\n',''
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--translator',required=True);p.add_argument('--chromium',default='/usr/bin/chromium');p.add_argument('--fixture',type=pathlib.Path);p.add_argument('--output',type=pathlib.Path);a=p.parse_args();a.fixture=a.fixture or ROOT/'Examples/FEXHost/Guest/sparse-pipeline.json'
 fixture=json.loads(a.fixture.read_text());elf=base64.b64decode(fixture['elf']);cat=base64.b64decode(json.loads((ROOT/'Examples/FEXHost/Guest/sparse-cat.json').read_text())['elf']);events=[]
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
    elif path=='/fs/file':
     name=urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('p',[''])[0]
     if name not in ['/test/pipeline','/test/cat']:self.reply(b'',status=404)
     else:self.reply(elf if name=='/test/pipeline'else self.server.child,'application/octet-stream')
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
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.sequence=0;server.input=b'';server.child=cat;threading.Thread(target=server.serve_forever,daemon=True).start();records=[]
 cases=[]
 for name,data,argument,code in [('empty',b'','/test/cat',0),('text','A compiled parent and child. é🙂\n'.encode(),'/test/cat',0),('boundary',b'x'*4095+'\ufeffsplit\n'.encode(),'/test/cat',0),('leading-bom','\ufeffHello pipeline\n'.encode(),'/test/cat',0),('large',(b'line: parent fork exec child 0123\n'*9000)[:256*1024],'/test/cat',0),('missing',b'abc','/test/absent',71),('argument',b'abc',None,64)]:
  out=data if code==0 else data[:1]if code==71 else b''
  cases.append({'id':name,'argument':argument,'argv':['/test/pipeline']+([argument]if argument else[]),'input':data,'expected':(code,out.decode(),'')})

 try:
  for _ in range(200):
   try:cfg=json.loads(request('/xlat/config?space=1'));break
   except Exception:time.sleep(.025)
  else:raise RuntimeError('Native translator did not start')
  with sync_playwright()as pw:
   browser=pw.chromium.launch(executable_path=a.chromium,headless=True,args=['--no-sandbox'])
   try:
    for case in cases:
     arg=case['argument'];events.clear();server.sequence=0;server.input=case['input'];page=browser.new_page();argv=case['argv'];url='http://127.0.0.1:'+str(server.server_port)+'/linux/web/sparse.html?'+urllib.parse.urlencode({'argv':json.dumps(argv),'env':'{}','stdin':'1','processes':'1','executables':json.dumps(['/test/cat'])})
     try:
      page.goto(url)
      deadline=time.monotonic()+60
      while not any(e['kind']in['exit','failure','unsupported']for e in events):
       if time.monotonic()>deadline:raise RuntimeError('Browser command timed out: '+page.locator('#out').inner_text())
       page.wait_for_timeout(20)
      errors=[e for e in events if e['kind']in['failure','unsupported']];assert not errors,errors
      code=next(e['code']for e in events if e['kind']=='exit');stdout=''.join(e['text']for e in events if e['kind']=='stdout');stderr=''.join(e['text']for e in events if e['kind']=='stderr');assert(code,stdout,stderr)==case['expected'],(case['id'],code,len(stdout),stderr)
      line=next(e['text']for e in events if e['kind']=='log'and e['text'].startswith('[sparse-processes]'));report=json.loads(line[len('[sparse-processes] '):]);assert report['broker']['threads']==0 and report['guestBacking']['ownedPayloadBytes']==0 and report['guestAccessQuiescenceAcknowledged']and not report['workerRetirementAcknowledged']and report['internalContextsRetainedUntilSessionTeardown']
      assert report['stdin']['providedBytes']==len(case['input'])and report['stdin']['consumedBytes']==(len(case['input'])if code==0 else 1 if code==71 else 0)
      records.append({'id':case['id'],'argument':arg,'exitCode':code,'stdout':stdout[:64],'stdoutBytes':len(stdout.encode()),'stdoutSHA256':hashlib.sha256(stdout.encode()).hexdigest(),'stderr':stderr,'runtime':report})
     finally:page.close();request('/xlat/drop?space=1')
    # Negative fixture only: unsupported child entry must roll back with a
    # typed refusal, never a manufactured child exit/wait success.
    bad=bytearray(cat);entry=struct.unpack_from('<Q',bad,24)[0];phoff=struct.unpack_from('<Q',bad,32)[0];phnum=struct.unpack_from('<H',bad,56)[0]
    for i in range(phnum):
     at=phoff+i*56;kind,flags,offset,va,pa,filesz,memsz,align=struct.unpack_from('<IIQQQQQQ',bad,at)
     if kind==1 and va<=entry<va+filesz:bad[offset+entry-va]=0xcc;break
    else:raise RuntimeError('No executable entry in negative fixture')
    events.clear();server.sequence=0;server.input=b'abc';server.child=bytes(bad);page=browser.new_page()
    try:
     page.goto('http://127.0.0.1:'+str(server.server_port)+'/linux/web/sparse.html?'+urllib.parse.urlencode({'argv':json.dumps(['/test/pipeline','/test/cat']),'env':'{}','stdin':'1','processes':'1','executables':json.dumps(['/test/cat'])}))
     deadline=time.monotonic()+15
     while not any(e['kind']in['unsupported','failure','exit']for e in events):
      if time.monotonic()>deadline:raise RuntimeError('Unsupported child refusal deadline')
      page.wait_for_timeout(20)
     assert any(e['kind']=='unsupported'for e in events)and not any(e['kind']=='exit'for e in events),events
     unsupportedChild=[e for e in events if e['kind']in['unsupported','failure','exit']]
    finally:page.close();server.child=cat;request('/xlat/drop?space=1');request('/xlat/drop?space=2')
    events.clear();server.sequence=0;server.input=b'prefix';page=browser.new_page()
    try:
     page.goto('http://127.0.0.1:'+str(server.server_port)+'/linux/web/sparse.html?'+urllib.parse.urlencode({'argv':json.dumps(['/test/pipeline','/test/cat']),'env':'{}','stdin':'1'}))
     deadline=time.monotonic()+15
     while not any(e['kind']in['unsupported','failure','exit']for e in events):
      if time.monotonic()>deadline:raise RuntimeError('Single-process refusal control deadline')
      page.wait_for_timeout(20)
     assert any(e['kind']=='unsupported'for e in events)and not any(e['kind']=='exit'for e in events),events
     legacyControl=[e for e in events if e['kind']in['unsupported','failure','exit']]
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
  out={'evidence':'Actual Chromium: compiler-produced parent read/fork, child exec of compiler cat, parent wait and guest exits through live FEX. Explicit guest-access quiescence before guest backing closes; all internal contexts and occupied slots retained until session teardown. No physical Worker termination acknowledgement, dense Wine, Swift/WebKit/device or resident RAM claim.','cfg':cfg,'fixtureSHA256':fixture['elfSHA256'],'records':records,'unsupportedChildEntryControl':unsupportedChild,'singleProcessRefusalControl':legacyControl,'syntheticMissingIsolationControl':unsupported}
  text=json.dumps(out,indent=2);print(text)
  if a.output:a.output.write_text(text+'\n')
 finally:
  server.shutdown();server.server_close();native.terminate()
  try:native.wait(timeout=3)
  except subprocess.TimeoutExpired:native.kill();native.wait(timeout=3)
if __name__=='__main__':main()
