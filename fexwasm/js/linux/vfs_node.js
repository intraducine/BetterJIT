// Guest files on the Mac: guest paths map to host directories through a mount
// table; symlinks resolve in the guest's namespace (an absolute link target
// is a guest path). Used by js/linux/kernel.js in the kernel worker.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { E, O, S_IF } = require('./abi.js');
const { KError } = require('./kernel.js');

function hostErr(e) {
  const code = e && e.code && E[e.code.slice(1)];
  return new KError(code || E.IO);
}
const wrap = (fn) => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof KError) throw e;
    throw hostErr(e);
  }
};

const SOCKET_MARK = 'fexwasm:socket';

class NodeVfs {
  // mounts: [[guestPrefix, hostDir], ...]
  constructor(mounts) {
    this.mounts = mounts.map(([g, h]) => [g === '/' ? '/' : g.replace(/\/+$/, ''), path.resolve(h)]).sort((a, b) => b[0].length - a[0].length);
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fexwasm-'));
  }
  host(g) {
    for (const [m, h] of this.mounts) {
      if (m === '/') return path.join(h, g);
      if (g === m || g.startsWith(m + '/')) return h + g.slice(m.length);
    }
    throw new KError(E.NOENT);
  }
  // A host path back to the guest (for absolute link targets that point into a mount).
  guestOf(h) {
    for (const [m, hd] of this.mounts) {
      if (h === hd || h.startsWith(hd + '/')) return (m === '/' ? '' : m) + h.slice(hd.length) || '/';
    }
    return null;
  }
  // Resolves symlinks in the guest namespace; the last component only if follow.
  resolve(g, follow) {
    let parts = g.split('/').filter((x) => x && x !== '.');
    let out = [];
    for (let hops = 0, i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '..') { out.pop(); continue; }
      const cur = '/' + [...out, part].join('/');
      const last = i === parts.length - 1;
      if (last && !follow) { out.push(part); break; }
      if (this.isMountPoint(cur)) { out.push(part); continue; }
      let st;
      try {
        st = fs.lstatSync(this.host(cur));
      } catch (e) {
        out.push(part); // missing: the caller's operation reports it
        continue;
      }
      if (!st.isSymbolicLink()) { out.push(part); continue; }
      let target = fs.readlinkSync(this.host(cur));
      if (target === SOCKET_MARK) { out.push(part); continue; }
      if (++hops > 40) throw new KError(E.LOOP);
      if (target.startsWith('/')) {
        const g2 = this.guestOf(target);
        if (g2 !== null) target = g2;
        out = [];
      }
      parts = [...target.split('/').filter((x) => x && x !== '.'), ...parts.slice(i + 1)];
      i = -1;
    }
    return '/' + out.join('/');
  }
  isMountPoint(g) { return this.mounts.some(([m]) => m === g); }
  hostPath(g, follow) { return this.host(this.resolve(g, follow)); }

  stat(g, follow = true) {
    const r = this.resolve(g, follow);
    const h = this.host(r);
    let st = wrap(() => fs.lstatSync(h, { bigint: true }));
    if (st.isSymbolicLink()) {
      if (fs.readlinkSync(h) === SOCKET_MARK) return this.conv(st, true);
      if (follow) st = wrap(() => fs.statSync(h, { bigint: true }));
    }
    return this.conv(st, false);
  }
  conv(st, socket) {
    let mode = Number(st.mode);
    if (socket) mode = S_IF.SOCK | 0o777;
    return {
      dev: st.dev, ino: st.ino, mode, nlink: st.nlink, uid: Number(st.uid), gid: Number(st.gid), rdev: st.rdev, size: st.size,
      blksize: 4096n, blocks: st.blocks, atimeNs: st.atimeNs, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs,
    };
  }
  open(g, flags, mode) {
    const r = this.resolve(g, !(flags & O.NOFOLLOW));
    const h = this.host(r);
    const C = fs.constants;
    let f = (flags & O.ACCMODE) === O.WRONLY ? C.O_WRONLY : (flags & O.ACCMODE) === O.RDWR ? C.O_RDWR : C.O_RDONLY;
    if (flags & O.CREAT) f |= C.O_CREAT;
    if (flags & O.EXCL) f |= C.O_EXCL;
    if (flags & O.TRUNC) f |= C.O_TRUNC;
    if (flags & O.APPEND) f |= C.O_APPEND;
    if (flags & O.NOFOLLOW) f |= C.O_NOFOLLOW;
    const fd = wrap(() => fs.openSync(h, f, mode & 0o7777));
    const st = fs.fstatSync(fd, { bigint: true });
    const isDir = st.isDirectory();
    if ((flags & O.DIRECTORY) && !isDir) {
      fs.closeSync(fd);
      throw new KError(E.NOTDIR);
    }
    if (isDir && (flags & O.ACCMODE) !== 0) {
      fs.closeSync(fd);
      throw new KError(E.ISDIR);
    }
    return { fd, isDir, key: `${st.dev}:${st.ino}`, path: r };
  }
  pread(fd, buf, pos) { return wrap(() => fs.readSync(fd, buf, 0, buf.length, pos)); }
  pwrite(fd, buf, pos) { return wrap(() => fs.writeSync(fd, buf, 0, buf.length, pos)); }
  fstat(fd) { return this.conv(wrap(() => fs.fstatSync(fd, { bigint: true })), false); }
  close(fd) { try { fs.closeSync(fd); } catch (e) { /* already closed */ } }
  readdir(g) {
    const r = this.resolve(g, true);
    const ents = wrap(() => fs.readdirSync(this.host(r), { withFileTypes: true }));
    const out = ents.map((d) => ({ name: d.name, ino: 1n, type: d.isDirectory() ? 4 : d.isSymbolicLink() ? 10 : d.isFile() ? 8 : d.isSocket() ? 12 : d.isFIFO() ? 1 : 0 }));
    // mount points below this directory
    for (const [m] of this.mounts) {
      if (m === '/' || m === r) continue;
      const parent = m.slice(0, m.lastIndexOf('/')) || '/';
      const name = m.slice(m.lastIndexOf('/') + 1);
      if (parent === r && !out.some((e) => e.name === name)) out.push({ name, ino: 1n, type: 4 });
    }
    return out;
  }
  readlink(g) {
    const r = this.resolve(g, false);
    let t = wrap(() => fs.readlinkSync(this.host(r)));
    if (t === SOCKET_MARK) throw new KError(E.INVAL);
    if (t.startsWith('/')) t = this.guestOf(t) ?? t;
    return t;
  }
  readFile(g) { return new Uint8Array(wrap(() => fs.readFileSync(this.hostPath(g, true)))); }
  mkdir(g, mode) { wrap(() => fs.mkdirSync(this.hostPath(g, false), mode & 0o7777)); }
  rmdir(g) { wrap(() => fs.rmdirSync(this.hostPath(g, false))); }
  unlink(g) {
    const r = this.resolve(g, false);
    const h = this.host(r);
    if (wrap(() => fs.lstatSync(h)).isDirectory()) throw new KError(E.ISDIR);
    wrap(() => fs.unlinkSync(h));
  }
  rename(a, b) { wrap(() => fs.renameSync(this.hostPath(a, false), this.hostPath(b, false))); }
  link(a, b) { wrap(() => fs.linkSync(this.hostPath(a, true), this.hostPath(b, false))); }
  symlink(target, g) { wrap(() => fs.symlinkSync(target, this.hostPath(g, false))); }
  chmod(g, mode) { wrap(() => fs.chmodSync(this.hostPath(g, true), mode & 0o7777)); }
  truncate(g, n) { wrap(() => fs.truncateSync(this.hostPath(g, true), n)); }
  ftruncate(fd, n) { wrap(() => fs.ftruncateSync(fd, n)); }
  utimes(g, at, mt) {
    const h = this.hostPath(g, true);
    const st = wrap(() => fs.statSync(h));
    wrap(() => fs.utimesSync(h, at ?? st.atimeMs / 1000, mt ?? st.mtimeMs / 1000));
  }
  tmpfile() {
    const h = path.join(this.tmpDir, 'memfd-' + Math.random().toString(36).slice(2));
    const fd = fs.openSync(h, 'w+');
    fs.unlinkSync(h);
    return { fd };
  }
  // A bound AF_UNIX socket's file: a host symlink to a marker, so that it
  // persists (and reads back as a socket) the way a real one does.
  mksock(g) {
    const h = this.host(this.resolve(g, false));
    let exists = true;
    try { fs.lstatSync(h); } catch (e) { exists = false; }
    if (exists) throw new KError(E.ADDRINUSE);
    wrap(() => fs.symlinkSync(SOCKET_MARK, h));
  }
}

module.exports = { NodeVfs };
