// The guest file system on the Mac: guest paths -> host directories, shared
// by tools/linuxrun.js (Node) and tools/webserve.js (the page's /fs routes).
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const BUILD = path.join(REPO, 'build');

// extra: [[guest, host], ...] that take precedence over the defaults.
function mounts(extra) {
  const root = path.join(BUILD, 'linuxroot');
  for (const d of ['root', 'tmp', 'home/user']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const out = [...(extra || [])];
  const defaults = [
    ['/', path.join(root, 'root')],
    ['/lib', path.join(BUILD, 'sysroot-x86_64', 'lib')],
    ['/opt/wine', path.join(BUILD, 'wine-install', 'opt', 'wine')],
    ['/tmp', path.join(root, 'tmp')],
    ['/home', path.join(root, 'home')],
    ['/test', path.join(BUILD, 'test')],
  ];
  for (const d of defaults) if (!out.some(([g]) => g === d[0])) out.push(d);
  // mount points (and /proc, /dev, /sys) exist as directories in the root
  const rootHost = out.find(([g]) => g === '/')[1];
  for (const g of [...out.map(([g]) => g), '/proc', '/dev', '/sys', '/usr/bin', '/bin']) {
    if (g !== '/') fs.mkdirSync(path.join(rootHost, g), { recursive: true });
  }
  return out;
}

// Guest path of host path h, and host path of guest path g.
function guestOf(MOUNTS, h) {
  for (const [g, hd] of [...MOUNTS].sort((a, b) => b[1].length - a[1].length)) {
    if (h === hd || h.startsWith(hd + '/')) return (g === '/' ? '' : g) + h.slice(hd.length) || '/';
  }
  return null;
}
function hostOf(MOUNTS, g) {
  for (const [m, h] of [...MOUNTS].sort((a, b) => b[0].length - a[0].length)) {
    if (m === '/') return path.join(h, g);
    if (g === m || g.startsWith(m + '/')) return h + g.slice(m.length);
  }
  return null;
}
// The guest file system as js/linux/vfs_web.js takes it: [[path, type, mode,
// size, mtimeMs, target?], ...] for every mount (deeper mounts win).
function index(MOUNTS) {
  const entries = new Map();
  const walk = (h, g) => {
    let st;
    try { st = fs.lstatSync(h); } catch (e) { return; }
    if (st.isSymbolicLink()) {
      let t = fs.readlinkSync(h);
      if (t === 'fexwasm:socket') return; // a socket from an earlier run
      if (t.startsWith('/')) t = guestOf(MOUNTS, t) ?? t;
      entries.set(g, [g, 'l', 0o777, t.length, st.mtimeMs, t]);
    } else if (st.isDirectory()) {
      entries.set(g, [g, 'd', st.mode & 0o7777, 0, st.mtimeMs]);
      if (g === '/tmp') return; // starts empty
      for (const name of fs.readdirSync(h)) walk(path.join(h, name), (g === '/' ? '' : g) + '/' + name);
    } else if (st.isFile()) {
      entries.set(g, [g, 'f', st.mode & 0o7777, st.size, st.mtimeMs]);
    }
  };
  for (const [g, h] of [...MOUNTS].sort((a, b) => a[0].length - b[0].length)) {
    for (const k of [...entries.keys()]) if (g !== '/' && (k === g || k.startsWith(g + '/'))) entries.delete(k);
    walk(h, g);
  }
  return { entries: [...entries.values()], uid: process.getuid(), gid: process.getgid() };
}

module.exports = { mounts, index, guestOf, hostOf, REPO, BUILD };
