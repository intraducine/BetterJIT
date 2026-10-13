// SPDX-License-Identifier: GPL-3.0-or-later
// Node host adapter for the same manifest-based, read-only root used by the app.
const fs=require('fs'), path=require('path');
function rootIndex(root,overlay={}) {
  const modes=JSON.parse(fs.readFileSync(path.join(root,'.modes.json'),'utf8'));
  const links=JSON.parse(fs.readFileSync(path.join(root,'.symlinks.json'),'utf8'));
  const rows=new Map();
  function walk(host,guest) {
    if(['/tmp','/.modes.json','/.symlinks.json','/.betterjit-linux-root.json'].includes(guest)) return;
    const stat=fs.lstatSync(host); if(stat.isSymbolicLink()) throw Error('Use a staged root with portable symlink manifests.');
    rows.set(guest,[guest,stat.isDirectory()?'d':'f',modes[guest]??(stat.mode&0o7777),stat.size,stat.mtimeMs]);
    if(stat.isDirectory()) for(const name of fs.readdirSync(host)) walk(path.join(host,name),guest==='/'?'/'+name:guest+'/'+name);
  }
  walk(root,'/');
  for(const [guest,target] of Object.entries(links)) rows.set(guest,[guest,'l',0o777,Buffer.byteLength(target),0,target]);
  for(const [guest,bytes] of Object.entries(overlay)) {
    let parent=path.posix.dirname(guest);
    while(parent!=='/') { if(!rows.has(parent))rows.set(parent,[parent,'d',0o755,0,0]);parent=path.posix.dirname(parent); }
    rows.set(guest,[guest,'f',0o755,bytes.length,0]);
  }
  for(const guest of ['/tmp','/proc','/dev','/sys','/home','/home/user','/test']) if(!rows.has(guest))rows.set(guest,[guest,'d',0o755,0,0]);
  return [...rows.values()];
}
function readSource(root,overlay,guest,offset=0,length) {
  if(Object.hasOwn(overlay,guest)) {
    const bytes=overlay[guest]; return bytes.subarray(offset,length===undefined?undefined:offset+length);
  }
  const target=path.resolve(root,'.'+guest),base=path.resolve(root);
  if(!target.startsWith(base+path.sep))throw Error('Guest file escapes root.');
  const real=fs.realpathSync(target); if(!real.startsWith(base+path.sep))throw Error('Guest file resolves outside root.');
  const fd=fs.openSync(real,'r');
  try {
    const size=fs.fstatSync(fd).size,n=Math.max(0,Math.min(length??size,size-offset));
    const bytes=Buffer.alloc(n);let got=0;
    while(got<n){const read=fs.readSync(fd,bytes,got,n-got,offset+got);if(!read)throw Error('Short root file read.');got+=read;}
    return bytes;
  } finally { fs.closeSync(fd); }
}
module.exports={rootIndex,readSource};
