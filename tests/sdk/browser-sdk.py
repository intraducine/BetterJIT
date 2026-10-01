#!/usr/bin/env python3
"""Real Chromium execution of the SDK engine and worker, without network.

Only resource URLs are rewritten to data URLs. Browser callbacks are NOT native
Swift callbacks. Recorded FEX units are replay, NOT fresh native translation.
Apple-host execution is covered separately by the macOS integration tests.
"""
from pathlib import Path
import argparse
import base64
import json
import struct
import subprocess
import select
import atexit
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[2]


def text(name):
    return (ROOT / 'Sources/BetterJITWebKit/Resources' / name).read_text()


def data_url(source):
    return 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()


def fixture(directory):
    path = ROOT / 'WasmProbe/Web' / directory
    def b64(name): return base64.b64encode((path / name).read_bytes()).decode()
    units = {}
    raw = (path / 'units.bin').read_bytes()
    off = 4
    for i in range(struct.unpack_from('<I', raw)[0]):
        rip, size = struct.unpack_from('<II', raw, off)
        off += 8
        if size > len(raw) - off:
            raise ValueError('Truncated recorded FEX module')
        units[str(rip)] = base64.b64encode(struct.pack('<I', i + 1) + raw[off:off+size]).decode()
        off += size
    if off != len(raw):
        raise ValueError('Trailing recorded FEX data')
    return {'config': json.loads((path / 'config.json').read_text()), 'units': units,
            'image': b64('image.bin'), 'state': b64('state.bin'), 'dispatcher': b64('dispatcher.wasm')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium', help='Installed Chromium, otherwise use Playwright Chromium')
    parser.add_argument('--research-fixtures', action='store_true')
    parser.add_argument('--c-guest', action='store_true', help='Run Examples/CGuest/build.sh first')
    parser.add_argument('--native-service', action='store_true', help='With --c-guest: build and call a real Swift NativeService through a test-only stdio adapter')
    args = parser.parse_args()
    if args.native_service and not args.c_guest:
        parser.error('--native-service requires --c-guest')
    source = text('engine.mjs').replace("'./fex-runtime.js'", json.dumps(data_url(text('fex-runtime.js'))))
    source = source.replace("'./wasm-module.mjs'", json.dumps(data_url(text('wasm-module.mjs'))))
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        page = browser.new_page()
        native = None
        if args.native_service:
            package = ROOT/'tests/sdk/native-service'
            subprocess.run(['swift','build','-j','2','--package-path',str(package)],check=True,timeout=120)
            binary = subprocess.check_output(['swift','build','--package-path',str(package),'--show-bin-path'],text=True).strip()
            native = subprocess.Popen([str(Path(binary)/'NativeServiceHost')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1)
            def stop_native():
                if native.poll() is None:
                    native.terminate()
                    try: native.wait(timeout=3)
                    except subprocess.TimeoutExpired: native.kill(); native.wait(timeout=3)
            atexit.register(stop_native)
            def native_service(service,payload):
                native.stdin.write(json.dumps({'service':service,'payload':payload})+'\n'); native.stdin.flush()
                if not select.select([native.stdout],[],[],5)[0]: raise RuntimeError('Native test service timed out')
                answer=json.loads(native.stdout.readline())
                if 'error' in answer: raise RuntimeError('Native test service rejected request')
                return answer['result']
            page.expose_function('nativeServiceCall',native_service)
        page.evaluate('''async ({engine,fixtures}) => {
          window.sdk = await import(engine); window.fixtures = await import(fixtures);
        }''', {'engine': data_url(source), 'fixtures': data_url((ROOT/'tests/sdk/fixtures.mjs').read_text())})
        result = page.evaluate('''async () => {
          const {Engine,encodeBytes,capabilities} = sdk, {moduleBytes,limits} = fixtures;
          if (!capabilities().jspi) throw Error('Current JSPI is required for this test');
          let calls = 0;
          const engine = new Engine({hostCall: async (service,payload) => {
            if (service !== 'host.1' || payload !== 'AQID') throw Error('wrong callback payload');
            calls++; return 'BAUG';
          }});
          await engine.command('configure',{limits,services:['host.1']});
          const bytes = moduleBytes({params:[],results:[0x7f],memory:true,call:true,code:[0x41,1,0x41,0,0x41,3,0x41,8,0x41,4,0x10,0]});
          await engine.command('load',{module:'native',bytes:encodeBytes(bytes)});
          await engine.command('write',{offset:0,bytes:'AQID'});
          const value = await engine.command('invoke',{module:'native',export:'run',arguments:[],results:['i32']});
          if (value[0].value !== '3' || calls !== 1 || await engine.command('read',{offset:8,count:3}) !== 'BAUG') throw Error('callback reply mismatch');
          const denied = new Engine({hostCall:async()=>{throw Error('must not enter callback');}});
          await denied.command('configure',{limits,services:[]});
          await denied.command('load',{module:'native',bytes:encodeBytes(bytes)});
          let rejected = false;
          try { await denied.command('invoke',{module:'native',export:'run',arguments:[],results:['i32']}); }
          catch(e) { rejected = e.code === 'serviceDenied'; }
          if (!rejected) throw Error('missing capability denial');
          engine.close(); denied.close();
          return {jspi:true,browserServiceRoundTrip:true,deniedService:true};
        }''')
        print(json.dumps(result, sort_keys=True), flush=True)
        worker_source = text('worker.mjs').replace("'./engine.mjs'", json.dumps(data_url(source)))
        worker_result = page.evaluate('''async workerSource => {
          const worker=new Worker('data:text/javascript,'+encodeURIComponent(workerSource),{type:'module'}), waiting=new Map();
          const session='browser-protocol-check'; let count=0, services=0;
          const ready=new Promise((resolve,reject)=>{
            const deadline=setTimeout(()=>reject(Error('Worker startup timed out')),5000);
            worker.onerror=e=>{clearTimeout(deadline);reject(Error(e.message));};
            worker.onmessage=({data:m})=>{
              if(m.kind==='ready'){clearTimeout(deadline);resolve();return;}
              if(m.kind==='service'){
                services++;setTimeout(()=>worker.postMessage({v:1,session,id:m.id,kind:'serviceResponse',payload:'BAUG'}),10);
              } else if(m.kind==='response'){
                const p=waiting.get(m.id);if(!p)return;waiting.delete(m.id);clearTimeout(p.deadline);
                m.error?p.reject(Error(m.error.code)):p.resolve(m.payload);
              }
            };
          });
          const request=(operation,payload)=>new Promise((resolve,reject)=>{
            const id=String(++count),deadline=setTimeout(()=>{waiting.delete(id);reject(Error('request timeout: '+operation));},5000);
            waiting.set(id,{resolve,reject,deadline});worker.postMessage({v:1,session,id,kind:'request',operation,payload});
          });
          try {
            await ready;await request('configure',{limits:fixtures.limits,services:['host.1']});
            const bytes=fixtures.moduleBytes({params:[],results:[0x7f],memory:true,call:true,code:[0x41,1,0x41,0,0x41,3,0x41,8,0x41,4,0x10,0]});
            await request('load',{module:'native',bytes:sdk.encodeBytes(bytes)});
            await request('write',{offset:0,bytes:'AQID'});
            const [value,read]=await Promise.all([request('invoke',{module:'native',export:'run',arguments:[],results:['i32']}),request('read',{offset:8,count:3})]);
            if(value[0].value!=='3'||read!=='BAUG'||services!==1)throw Error('serialized service protocol mismatch');
            const loop=fixtures.moduleBytes({params:[],results:[],code:[0x03,0x40,0x0c,0,0x0b]});
            await request('load',{module:'loop',bytes:sdk.encodeBytes(loop)});
            worker.postMessage({v:1,session,id:'loop',kind:'request',operation:'invoke',payload:{module:'loop',export:'run',arguments:[],results:[]}});
            await new Promise(resolve=>setTimeout(resolve,50));worker.terminate();
            return {workerProtocol:true,serviceRepliesBypassQueue:true,busyWorkerTerminated:true};
          } finally {worker.terminate();for(const p of waiting.values())clearTimeout(p.deadline);}
        }''', worker_source)
        print(json.dumps(worker_result, sort_keys=True), flush=True)
        if args.c_guest:
            result = page.evaluate('''async ({bytes,rows,native}) => {
              const e=new sdk.Engine({hostCall:async(service,payload)=>{
                if(native)return nativeServiceCall(service,payload);
                if(service!=='host.1')throw Error('wrong service');
                const b=sdk.decodeBytes(payload,4);if(b.length!==4)throw Error('bad C request');
                const value=new DataView(b.buffer).getUint32(0,true),out=new Uint8Array(4);
                new DataView(out.buffer).setUint32(0,value*2,true);return sdk.encodeBytes(out);
              }});
              await e.command('configure',{limits:fixtures.limits,services:['host.1']});
              await e.command('load',{module:'c',bytes});
              for(const [seed,count,want] of rows){
                const out=await e.command('invoke',{module:'c',export:'checksum',arguments:[{type:'i32',value:String(Number(seed)|0)},{type:'i32',value:count}],results:['i64']});
                if(BigInt.asUintN(64,BigInt(out[0].value))!==BigInt(want))throw Error('C/native differential mismatch');
              }
              const serviceInputs=[0,1,21,0x7fffffff,0x80000000,0xffffffff];
              for(const input of serviceInputs){
                const answer=await e.command('invoke',{module:'c',export:'host_double',arguments:[{type:'i32',value:String(input|0)}],results:['i32']});
                if(answer[0].value!==String((input*2)|0))throw Error('C service ABI mismatch');
              }
              const stats=await e.command('statistics');e.close();return {cReferenceVectors:rows.length,cServiceCases:serviceInputs.length,cServiceAnswer:42,actualSwiftNativeService:native,statistics:stats};
            }''', {'bytes': base64.b64encode((ROOT/'.build/c-guest/guest.wasm').read_bytes()).decode(),
                   'native':args.native_service, 'rows': [line.split() for line in (ROOT/'.build/c-guest/reference.txt').read_text().splitlines()]})
            print(json.dumps(result, sort_keys=True), flush=True)
        if args.research_fixtures:
            for directory in ['fex','fexw64']:
                results = page.evaluate('''async f => {
                  const {Engine} = sdk;let requests=0;
                  const e=new Engine({hostCall:async(service,p)=>{
                    if(service!=='fex')throw Error('wrong service');requests++;
                    if(p.method==='config')return f.config;
                    if(p.method==='unit')return f.units[String(p.rip)]||'';
                    if(p.method==='region')return '';
                    if(['image','state','dispatcher'].includes(p.method))return f[p.method];
                    throw Error('unexpected request');
                  }});
                  await e.command('configure',{limits:{...fixtures.limits,timeoutSeconds:60},services:['fex']});
                  await e.command('fex.open');const results=[];
                  // The saved Box2D dumps omit units reached without their saved regions.
                  // Exercise every non-Box2D kernel rather than treating missing code as a pass.
                  for(const k of f.config.kernels.filter(k=>!k.name.startsWith('box2d'))){
                    let result; try { result=await e.command('fex.call',{entry:k.entry,arguments:[String(k.n)]}); } catch(error) { throw Error(k.name+': '+error.message); }
                    if(Number(BigInt(result)&0xffffffffn)!==k.chk)throw Error(k.name+' checksum mismatch');results.push(k.name);
                  }
                  const stats=await e.command('statistics');e.close();return {kernels:results,serviceRequests:requests,statistics:stats,liveNativeTranslation:false};
                }''', fixture(directory))
                print(directory, json.dumps(results, sort_keys=True), flush=True)
        browser.close()
        if native is not None: stop_native()
if __name__ == '__main__': main()
