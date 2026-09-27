#!/usr/bin/env python3
"""Compile the real Swift FEX binding against its actual C header and a test shim.

The shim stresses shared scratch-buffer ownership and failure paths. It is NOT
FEX and cannot establish native translation or iOS ABI compatibility.
"""
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
ROOT = Path(__file__).resolve().parents[2]

def main():
    with tempfile.TemporaryDirectory(prefix='betterjit-binding-') as temp:
        root = Path(temp)
        c = root/'Sources/CFEXWasm'
        swift = root/'Sources/BindingCheck'
        (c/'include').mkdir(parents=True); swift.mkdir(parents=True)
        shutil.copyfile(ROOT/'fexwasm/src/translator.h', c/'include/translator.h')
        (c/'include/check.h').write_text('#include "translator.h"\nint check_live(void);\n')
        (c/'shim.c').write_text(r'''
#include "check.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
struct fexwasm_translator { unsigned char data[4]; };
static _Atomic int live;
int check_live(void) { return atomic_load(&live); }
fexwasm_translator* fexwasm_create(const uint8_t *image,size_t n,uint64_t base,const char* options) {
  if (!n || image[0] == 0xff) return 0;
  fexwasm_translator *p=calloc(1,sizeof(*p));if(p) atomic_fetch_add(&live,1);return p;
}
void fexwasm_destroy(fexwasm_translator* p) { if(p){atomic_fetch_sub(&live,1);free(p);} }
const char* fexwasm_config_json(fexwasm_translator* p) { return "{}"; }
fexwasm_bytes fexwasm_unit(fexwasm_translator* p,uint32_t rip) {
  memcpy(p->data,&rip,4);usleep(100);return (fexwasm_bytes){p->data,4};
}
fexwasm_bytes fexwasm_dispatcher(fexwasm_translator* p){return (fexwasm_bytes){0,5};}
fexwasm_bytes fexwasm_state(fexwasm_translator* p){return (fexwasm_bytes){0,0};}
fexwasm_bytes fexwasm_region(fexwasm_translator* p,const uint8_t* data,size_t n){return (fexwasm_bytes){0,0};}
''')
        shutil.copyfile(ROOT/'Backends/FEX/Swift/LinkedFEXTranslator.swift',swift/'LinkedFEXTranslator.swift')
        (swift/'main.swift').write_text(r'''
import Foundation
import BetterJIT
import BetterJITFEX
import CFEXWasm
final class Failures: @unchecked Sendable {
 let lock=NSLock();var values=[String]()
 func record(_ s:String){lock.lock();defer{lock.unlock()};values.append(s)}
}
let t=try LinkedFEXTranslator(image:Data([1]),guestBase:0x400000)
let failures=Failures()
DispatchQueue.concurrentPerform(iterations:200){i in
 do {
  let bytes=try t.unit(at:UInt32(i))
  let expected=Data((0..<4).map{UInt8(truncatingIfNeeded:UInt32(i) >> ($0*8))})
  if bytes != expected { failures.record("scratch-buffer race") }
 } catch { failures.record("unexpected translation error") }
}
precondition(failures.values.isEmpty)
do { _=try t.dispatcher();fatalError("invalid pointer/size accepted") } catch {}
t.close();t.close();precondition(check_live()==0)
do { _=try t.initialState();fatalError("use after close") } catch {}
do { _=try LinkedFEXTranslator(image:Data([0xff]),guestBase:0x400000);fatalError("null create accepted") } catch {}
precondition(check_live()==0)
print("PASS: 200 concurrent scratch-buffer copies, invalid C results, null creation, idempotent close; test shim, not FEX.")
''')
        (root/'Package.swift').write_text('''// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "BindingCheck", dependencies: [.package(name: "BetterJIT", path: %s)], targets: [
 .target(name:"CFEXWasm",publicHeadersPath:"include"),
 .executableTarget(name:"BindingCheck",dependencies:["CFEXWasm",.product(name:"BetterJIT",package:"BetterJIT"),.product(name:"BetterJITFEX",package:"BetterJIT")])])
''' % json.dumps(str(ROOT)))
        subprocess.run(['swift','run','-j','2','--package-path',str(root),'BindingCheck'],check=True,timeout=120)
if __name__=='__main__': main()
