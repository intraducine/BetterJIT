#!/usr/bin/env python3
"""Exercise actual SDK Wasm/FEX execution in an installed Chromium, without network.
Only module URL resolution changes: production relative imports become data URLs.
This is not WKWebView/iOS or live native FEX translation validation.
"""
from pathlib import Path
import argparse
import base64
import json
import struct
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[2]

def text(name):
    return (ROOT / 'Sources/BetterJITWebKit/Resources' / name).read_text()

def data_url(text):
    return 'data:text/javascript;base64,' + base64.b64encode(text.encode()).decode()

def fixture(directory):
    path = ROOT / 'WasmProbe/Web' / directory
    def b64(name): return base64.b64encode((path / name).read_bytes()).decode()
    units = {}; raw = (path / 'units.bin').read_bytes(); off = 4
    for i in range(struct.unpack_from('<I', raw)[0]):
        rip, size = struct.unpack_from('<II', raw, off); off += 8
        units[str(rip)] = base64.b64encode(struct.pack('<I', i + 1) + raw[off:off+size]).decode(); off += size
    return {'config': json.loads((path / 'config.json').read_text()), 'units': units,
            'image': b64('image.bin'), 'state': b64('state.bin'), 'dispatcher': b64('dispatcher.wasm')}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium', help='Installed Chromium, otherwise use Playwright Chromium')
    parser.add_argument('--research-fixtures', action='store_true')
    args = parser.parse_args()
    # The bytes are unchanged except for a local module URL: no networking,
    # service mocking inside the engine, fake JIT APIs or skipped JSPI assertions.
    source = text('engine.mjs').replace("'./fex-runtime.js'", json.dumps(data_url(text('fex-runtime.js'))))
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        page = browser.new_page()
        page.evaluate('''async ({engine,fixtures}) => {
          window.sdk = await import(engine); window.fixtures = await import(fixtures);
        }''', {'engine': data_url(source), 'fixtures': data_url((ROOT/'tests/sdk/fixtures.mjs').read_text())})
        result = page.evaluate('''async () => {
          const {Engine,encodeBytes,capabilities} = sdk, {moduleBytes,limits} = fixtures;
          if (!capabilities().jspi) throw Error('Current JSPI is required for this test');
          let calls = 0;
          const engine = new Engine({hostCall: async (service,payload) => {
            if (service !== 'host.1' || payload !== 'AQID') throw Error('wrong native payload');
            calls++; return 'BAUG';
          }});
          await engine.command('configure',{limits,services:['host.1']});
          const bytes = moduleBytes({params:[],results:[0x7f],memory:true,call:true,code:[0x41,1,0x41,0,0x41,3,0x41,8,0x41,4,0x10,0]});
          await engine.command('load',{module:'native',bytes:encodeBytes(bytes)});
          await engine.command('write',{offset:0,bytes:'AQID'});
          const value = await engine.command('invoke',{module:'native',export:'run',arguments:[],results:['i32']});
          if (value[0].value !== '3' || calls !== 1 || await engine.command('read',{offset:8,count:3}) !== 'BAUG') throw Error('native reply mismatch');
          const denied = new Engine({hostCall:async()=>{throw Error('must not enter native callback');}});
          await denied.command('configure',{limits,services:[]});
          await denied.command('load',{module:'native',bytes:encodeBytes(bytes)});
          let rejected = false;
          try { await denied.command('invoke',{module:'native',export:'run',arguments:[],results:['i32']}); }
          catch(e) { rejected = e.code === 'serviceDenied'; }
          if (!rejected) throw Error('missing capability denial');
          engine.close(); denied.close();
          return {jspi:true,nativeRoundTrip:true,deniedNativeService:true};
        }''')
        print(json.dumps(result, sort_keys=True))
        worker_source = text('worker.mjs').replace("'./engine.mjs'", json.dumps(data_url(source)))
        worker_result = page.evaluate('''async workerSource => {
          const url='data:text/javascript,'+encodeURIComponent(workerSource);
          const worker=new Worker(url,{type:'module'}), waiting=new Map();
          const session='browser-protocol-check'; let count=0, services=0, terminated=false;
          const ready=new Promise((resolve,reject)=>{
            const deadline=setTimeout(()=>reject(Error('Worker startup timed out')),5000);
            worker.onerror=e=>{clearTimeout(deadline);reject(Error(e.message));};
            worker.onmessage=({data:m})=>{
              if(m.kind==='ready'){clearTimeout(deadline);resolve();return;}
              if(m.kind==='service'){
                services++;
                setTimeout(()=>worker.postMessage({v:1,session,id:m.id,kind:'serviceResponse',payload:'BAUG'}),10);
              } else if(m.kind==='response'){
                const p=waiting.get(m.id);if(!p)return;waiting.delete(m.id);clearTimeout(p.deadline);
                m.error?p.reject(Error(m.error.code)):p.resolve(m.payload);
              }
            };
          });
          const request=(operation,payload)=>new Promise((resolve,reject)=>{
            const id=String(++count);
            const deadline=setTimeout(()=>{waiting.delete(id);reject(Error('request timeout: '+operation));},5000);
            waiting.set(id,{resolve,reject,deadline});worker.postMessage({v:1,session,id,kind:'request',operation,payload});
          });
          try {
            await ready;await request('configure',{limits:fixtures.limits,services:['host.1']});
            const bytes=fixtures.moduleBytes({params:[],results:[0x7f],memory:true,call:true,code:[0x41,1,0x41,0,0x41,3,0x41,8,0x41,4,0x10,0]});
            await request('load',{module:'native',bytes:sdk.encodeBytes(bytes)});
            await request('write',{offset:0,bytes:'AQID'});
            const [value,read]=await Promise.all([
              request('invoke',{module:'native',export:'run',arguments:[],results:['i32']}),
              request('read',{offset:8,count:3})]);
            if(value[0].value!=='3'||read!=='BAUG'||services!==1)throw Error('serialized service protocol mismatch');
            // Infinite guest work must not block the page from terminating the worker.
            const loop=fixtures.moduleBytes({params:[],results:[],code:[0x03,0x40,0x0c,0,0x0b]});
            await request('load',{module:'loop',bytes:sdk.encodeBytes(loop)});
            worker.postMessage({v:1,session,id:'loop',kind:'request',operation:'invoke',payload:{module:'loop',export:'run',arguments:[],results:[]}});
            await new Promise(resolve=>setTimeout(resolve,50));worker.terminate();terminated=true;
            return {workerProtocol:true,serviceRepliesBypassQueue:true,busyWorkerTerminated:true};
          } finally {
            if(!terminated)worker.terminate();
            for(const p of waiting.values())clearTimeout(p.deadline);
          }
        }''', worker_source)
        print(json.dumps(worker_result, sort_keys=True))
        if args.research_fixtures:
            for directory in ['fex','fexw64']:
                results = page.evaluate('''async f => {
                  const {Engine} = sdk; let requests=0;
                  const e = new Engine({hostCall:async(service,p)=>{
                    if (service !== 'fex') throw Error('wrong service'); requests++;
                    if (p.method==='config') return f.config;
                    if (p.method==='unit') return f.units[String(p.rip)] || '';
                    if (p.method==='region') return ''; // Saved regions are not assumed to match live profiles.
                    if (['image','state','dispatcher'].includes(p.method)) return f[p.method];
                    throw Error('unexpected request');
                  }});
                  await e.command('configure',{limits:{...fixtures.limits,timeoutSeconds:60},services:['fex']});
                  await e.command('fex.open');
                  const results=[];
                  for (const name of ['intmix','hash','matmul','calls','coremark']) {
                    const k=f.config.kernels.find(k=>k.name===name);
                    const result=await e.command('fex.call',{entry:k.entry,argument:String(k.n)});
                    if (Number(BigInt(result)&0xffffffffn)!==k.chk) throw Error(name+' checksum mismatch');
                    results.push(name);
                  }
                  e.close();return {kernels:results,serviceRequests:requests};
                }''', fixture(directory))
                print(directory, json.dumps(results, sort_keys=True))
        browser.close()
if __name__ == '__main__': main()
