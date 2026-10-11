#!/usr/bin/env python3
"""Prepare a stock, signed Alpine/musl Wine candidate without private build inputs.

Requires Docker with Linux/amd64 support. No guest programs or package scripts are
executed on the host. This prepares inputs, not BetterJIT compatibility evidence.
"""
import argparse, hashlib, json, pathlib, shutil, subprocess, tarfile, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
DEFAULT_IMAGE='alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412'
WINE='10.7-r0'
CONTAINER_SCRIPT=r'''
set -eu
mkdir -p /guest-root
apk --root /guest-root --initdb --no-scripts --keys-dir /etc/apk/keys --repositories-file /etc/apk/repositories add musl busybox wine=10.7-r0
mkdir -p /guest-root/opt/wine/bin /guest-root/home/user /guest-root/tmp /guest-root/proc /guest-root/dev /guest-root/sys
for name in wine wine64 wineserver; do
  if test -e /guest-root/usr/bin/$name || test -L /guest-root/usr/bin/$name; then ln -s /usr/bin/$name /guest-root/opt/wine/bin/$name; fi
done
# Keep Alpine's complete installed-package provenance and license identifiers.
cp /guest-root/lib/apk/db/installed /output/installed-packages.txt
apk --root /guest-root info -v > /output/package-versions.txt
tar -czf /output/wine-root-input.tar.gz -C /guest-root .
'''
def extract_input_archive(archive, out):
    links={}; modes={}; total=0; devices=[]
    # Convert symlinks to the runtime's portable manifest. Never create
    # host symlinks or extract an archive member outside the output root.
    with tarfile.open(archive,'r:gz') as tar:
        for member in tar:
            parts=pathlib.PurePosixPath(member.name).parts
            if pathlib.PurePosixPath(member.name).is_absolute() or '..' in parts:
                raise ValueError('Invalid archive path')
            relative=pathlib.PurePosixPath(*[x for x in parts if x not in ('.','')])
            if str(relative)=='.': continue
            guest='/'+relative.as_posix()
            dest=out.joinpath(*relative.parts)
            modes[guest]=member.mode
            if member.isdir(): dest.mkdir(parents=True,exist_ok=True)
            elif member.issym(): links[guest]=member.linkname
            elif member.isreg():
                total+=member.size
                if total>8*1024**3: raise ValueError('Wine root exceeds 8 GiB')
                dest.parent.mkdir(parents=True,exist_ok=True)
                with tar.extractfile(member) as src, open(dest,'wb') as dst: shutil.copyfileobj(src,dst,1024*1024)
            elif member.islnk():
                # Alpine APK payloads normally use symlinks, but retain
                # hard links as equivalent guest-root absolute links.
                link=pathlib.PurePosixPath(member.linkname)
                if link.is_absolute() or '..' in link.parts: raise ValueError('Invalid archive hard-link path')
                links[guest]='/'+link.as_posix()
            elif member.ischr() and guest in {'/dev/null','/dev/zero','/dev/random','/dev/urandom'}:
                # These devices are implemented by the guest kernel, not host files.
                devices.append(guest); modes.pop(guest,None)
            else: raise ValueError(f'Unsupported archive member: {member.name} (type {member.type!r})')
    return links,modes,total,devices

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--image',default=DEFAULT_IMAGE,help='Use alpine@sha256:<digest> from an earlier provenance file for replay')
    p.add_argument('--output',type=pathlib.Path,default=ROOT/'.build/device-linuxroot')
    a=p.parse_args()
    out=a.output.resolve()
    if out.exists(): raise SystemExit(f'Output already exists; retained unchanged: {out}')
    if not shutil.which('docker'): raise SystemExit('BLOCKED: Docker (Linux/amd64) is required to prepare the signed Alpine Wine root. Existing root was not changed.')
    subprocess.run(['docker','pull','--platform','linux/amd64',a.image],check=True)
    inspected=json.loads(subprocess.check_output(['docker','image','inspect',a.image],text=True))[0]
    # Execute only the package manager in an isolated disposable container. Wine
    # package lifecycle scripts are disabled; Wine is attempted by the device app.
    with tempfile.TemporaryDirectory(prefix='betterjit-wine-') as temp:
        work=pathlib.Path(temp)
        try:
            subprocess.run(['docker','run','--rm','--platform','linux/amd64',
                            '--mount',f'type=bind,src={work},dst=/output',a.image,
                            'sh','-c',CONTAINER_SCRIPT],check=True)
        except subprocess.CalledProcessError as error:
            raise SystemExit(f'BLOCKED: signed Alpine Wine package acquisition failed (container exit {error.returncode}); no root produced, existing files retained.')
        archive=work/'wine-root-input.tar.gz'
        links={}; modes={}; total=0
        out.mkdir(parents=True)
        try:
            links,modes,total,devices=extract_input_archive(archive,out)
            versions=(work/'package-versions.txt').read_text()
            (out/'.symlinks.json').write_text(json.dumps(links,indent=2,sort_keys=True)+'\n')
            (out/'.modes.json').write_text(json.dumps(modes,indent=2,sort_keys=True)+'\n')
            provenance={
                'schema':1,'candidate':'Stock Alpine Wine; not device-validated or patched for DXMT',
                'wineVersion':WINE,'baseImageRequested':a.image,'baseImageDigests':inspected.get('RepoDigests',[]),
                'baseImageID':inspected['Id'],'rootArchiveSHA256':hashlib.sha256(archive.read_bytes()).hexdigest(),
                'packageVersions':versions.splitlines(),
                'packagesSource':'https://dl-cdn.alpinelinux.org/alpine/v3.22/',
                'winePackageSource':'https://gitlab.alpinelinux.org/alpine/aports/-/tree/cb88bb7c5f6a0e878f4e7d2ce0f934116bcab490/community/wine',
                'wineUpstreamSource':'https://dl.winehq.org/wine/source/10.x/wine-10.7.tar.xz',
                'signatureVerification':'Alpine apk signed repository/package verification; no allow-untrusted',
                'packageScriptsExecuted':False,'guestExecuted':False,'virtualDeviceEntriesOmitted':devices}
            (out/'.betterjit-linux-root.json').write_text(json.dumps(provenance,indent=2,sort_keys=True)+'\n')
            notes=out/'usr/share/betterjit-root-provenance';notes.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(work/'installed-packages.txt',notes/'installed-packages.txt')
            shutil.copyfile(work/'package-versions.txt',notes/'package-versions.txt')
            (notes/'README.txt').write_text('Stock Alpine Wine input candidate. Package source/versions/licenses are recorded here and in .betterjit-linux-root.json. Preserve package notices and corresponding source when redistributing. No DXMT/wasmdrv patch, device compatibility, or native-FEX speed ratio is claimed.\n')
        except BaseException:
            shutil.rmtree(out);raise
    print(f'Prepared Wine input candidate: {out} ({total/1024**2:.0f} MiB installed)')
    print('Pinned Wine version; base image digest and all installed dependency versions recorded for replay.')
if __name__=='__main__': main()
