#!/usr/bin/env python3
"""Generate a consumer Swift package around an existing device FEX binary.

No compiler, signing, network or repository publication is performed here.
"""
import argparse, json, os, pathlib, plistlib, shutil
ROOT=pathlib.Path(__file__).resolve().parents[1]
SOURCES=('LinkedFEXTranslator.swift','LinkedLinuxFEXBackend.swift','FEXProcess.swift')
def generate(native,sdk,out,source=ROOT):
    if out.exists(): raise ValueError('Existing adapter package retained unchanged: '+str(out))
    info=plistlib.loads((native/'CFEXWasm.xcframework/Info.plist').read_bytes())
    if not any(x.get('SupportedPlatform')=='ios' and x.get('SupportedArchitectures')==['arm64']
               and not x.get('SupportedPlatformVariant') for x in info.get('AvailableLibraries',[])):
        raise ValueError('Requires the device-arm64 CFEXWasm XCFramework; no simulator is claimed')
    if not (sdk/'Package.swift').is_file(): raise ValueError('SDK package is missing')
    sources=out/'Sources/BetterJITFEXAdapter';sources.mkdir(parents=True)
    try:
        for name in SOURCES: shutil.copyfile(source/'Backends/FEX/Swift'/name,sources/name)
        relative=lambda p:json.dumps(os.path.relpath(p,out))
        (out/'Package.swift').write_text('''// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "BetterJITFEXAdapter", platforms: [.iOS(.v17)],
    products: [.library(name: "BetterJITFEXAdapter", targets: ["BetterJITFEXAdapter"])],
    dependencies: [.package(name: "BetterJIT", path: SDK_PATH),
                   .package(name: "BetterJITFEXNative", path: NATIVE_PATH)],
    targets: [.target(name: "BetterJITFEXAdapter", dependencies: [
        .product(name: "BetterJIT", package: "BetterJIT"),
        .product(name: "BetterJITLinux", package: "BetterJIT"),
        .product(name: "BetterJITFEX", package: "BetterJIT"),
        .product(name: "CFEXWasm", package: "BetterJITFEXNative")],
        linkerSettings: [.linkedLibrary("c++")])])
'''.replace('SDK_PATH',relative(sdk)).replace('NATIVE_PATH',relative(native)))
        shutil.copyfile(source/'COPYING',out/'COPYING')
        shutil.copyfile(source/'THIRD_PARTY.md',out/'THIRD_PARTY.md')
        shutil.copytree(source/'LICENSES',out/'LICENSES')
    except BaseException: shutil.rmtree(out);raise
def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--native',type=pathlib.Path,default=ROOT/'.build/FEXNativePackage')
    p.add_argument('--sdk',type=pathlib.Path,default=ROOT)
    p.add_argument('--output',type=pathlib.Path,default=ROOT/'.build/FEXAdapterPackage')
    a=p.parse_args();generate(a.native.resolve(),a.sdk.resolve(),a.output.resolve())
    print('Generated device-only consumer adapter: '+str(a.output.resolve()))
if __name__=='__main__':main()
