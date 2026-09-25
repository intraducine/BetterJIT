// Guest files in a page: an in-memory tree built from an index the host
// serves (every path with its type, mode, size and time; links with their
// targets), whose file contents are fetched on first use (a synchronous
// request from the kernel worker) and then kept. Writes stay in memory.
// Same interface as js/linux/vfs_node.js.
'use strict';

const { E, O, S_IF } = require('./abi.js');
const { KError } = require('./kernel.js');

const fail = (c) => { throw new KError(c); };
const SOCKET_MARK = 'fexwasm:socket';
const BIG_FILE = 64 << 10; // (bigger: read in ranges, not held; see pread: a game reads its data once)

class WebVfs {
  // index: [[path, type 'd'|'f'|'l', mode, size, mtimeMs, target?], ...]
  // fetchFile(path) -> Uint8Array (synchronous)
  constructor(index, fetchFile, uid, gid) {
    this.nodes = new Map();
    this.fetchFile = fetchFile;
    this.uid = uid;
    this.gid = gid;
    this.nextIno = 2n;
    this.fds = new Map();
    this.nextFd = 3;
    this.removed = new Set(); // paths of the index the guest removed or moved away (see save)
    this.fetched = { files: 0, ranges: 0, bytes: 0, ms: 0 };
    this.add('/', 'd', 0o755, 0, Date.now());
    for (const [p, type, mode, size, mtime, target] of index) this.add(p, type, mode, size, mtime, target);
  }
  add(p, type, mode, size, mtimeMs, target) {
    if (this.nodes.has(p)) return this.nodes.get(p);
    const parent = p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/';
    if (parent && !this.nodes.has(parent)) this.add(parent, 'd', 0o755, 0, mtimeMs);
    const n = {
      type, mode: mode & 0o7777, size, ino: this.nextIno++, mtimeNs: BigInt(Math.floor(mtimeMs * 1e6)), target,
      data: type === 'f' && size === 0 ? new Uint8Array(0) : null, remote: type === 'f' && size > 0, children: type === 'd' ? new Set() : null, nlink: 1,
      src: p, // where its contents come from (it may be renamed before they are fetched)
    };
    this.nodes.set(p, n);
    if (parent) this.nodes.get(parent).children.add(p.slice(p.lastIndexOf('/') + 1));
    return n;
  }
  // The bytes of a file node (fetched once).
  bytes(p, n) {
    if (n.data === null && n.remote) {
      const t0 = performance.now();
      n.data = this.fetchFile(n.src || p);
      n.size = n.data.length;
      n.remote = false;
      this.fetched.files++;
      this.fetched.bytes += n.data.length;
      this.fetched.ms += performance.now() - t0;
    }
    return n.data || (n.data = new Uint8Array(0));
  }
  resolve(g, follow) {
    let parts = g.split('/').filter((x) => x && x !== '.');
    let out = [];
    for (let hops = 0, i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '..') { out.pop(); continue; }
      const cur = '/' + [...out, part].join('/');
      const last = i === parts.length - 1;
      const n = this.nodes.get(cur);
      if ((last && !follow) || !n || n.type !== 'l' || n.target === SOCKET_MARK) { out.push(part); continue; }
      if (++hops > 40) fail(E.LOOP);
      let target = n.target;
      if (target.startsWith('/')) out = [];
      parts = [...target.split('/').filter((x) => x && x !== '.'), ...parts.slice(i + 1)];
      i = -1;
    }
    return '/' + out.join('/');
  }
  node(g, follow) {
    const r = this.resolve(g, follow);
    const n = this.nodes.get(r);
    if (!n) {
      const parent = r.slice(0, r.lastIndexOf('/')) || '/';
      const pn = this.nodes.get(parent);
      fail(pn && pn.type !== 'd' ? E.NOTDIR : E.NOENT);
    }
    return [r, n];
  }
  conv(n) {
    const mode = n.type === 'd' ? S_IF.DIR : n.type === 'l' ? (n.target === SOCKET_MARK ? S_IF.SOCK : S_IF.LNK) : S_IF.REG;
    const size = n.type === 'l' ? (n.target === SOCKET_MARK ? 0 : n.target.length) : n.type === 'd' ? 4096 : n.used ?? (n.data ? n.data.length : n.size);
    return {
      dev: 0x801n, ino: n.ino, mode: mode | n.mode, nlink: n.type === 'd' ? 2 : n.nlink, uid: this.uid, gid: this.gid, rdev: 0n,
      size: BigInt(size), blksize: 4096n, blocks: BigInt(Math.ceil(size / 512)), atimeNs: n.mtimeNs, mtimeNs: n.mtimeNs, ctimeNs: n.mtimeNs,
    };
  }
  stat(g, follow = true) {
    return this.conv(this.node(g, follow)[1]);
  }
  open(g, flags, mode) {
    let r = this.resolve(g, !(flags & O.NOFOLLOW));
    let n = this.nodes.get(r);
    if (n && (flags & O.CREAT) && (flags & O.EXCL)) fail(E.EXIST);
    if (!n) {
      if (!(flags & O.CREAT)) this.node(r, true); // ENOENT / ENOTDIR
      const parent = r.slice(0, r.lastIndexOf('/')) || '/';
      const pn = this.nodes.get(parent);
      if (!pn || pn.type !== 'd') fail(pn ? E.NOTDIR : E.NOENT);
      n = this.add(r, 'f', mode, 0, Date.now());
      n.data = new Uint8Array(0);
      n.dirty = true;
    }
    if (n.type === 'l' && n.target !== SOCKET_MARK) fail(E.LOOP);
    const isDir = n.type === 'd';
    if ((flags & O.DIRECTORY) && !isDir) fail(E.NOTDIR);
    if (isDir && (flags & O.ACCMODE) !== 0) fail(E.ISDIR);
    if ((flags & O.TRUNC) && !isDir && (flags & O.ACCMODE)) { n.data = new Uint8Array(0); n.remote = false; n.size = 0; n.used = undefined; n.dirty = true; }
    const fd = this.nextFd++;
    this.fds.set(fd, { n, path: r });
    return { fd, isDir, key: `web:${n.ino}`, path: r };
  }
  file(fd) {
    const f = this.fds.get(fd);
    if (!f) fail(E.BADF);
    return f;
  }
  pread(fd, buf, pos) {
    const f = this.file(fd);
    if (f.n.type === 'd') fail(E.ISDIR);
    // a big file the guest hasn't written (a game's data): just the bytes
    // asked for, each time (holding whole files would double the memory
    // they take in the guest), when the host can (fetchFile.range)
    const n = f.n;
    if (n.data === null && n.remote && n.size > BIG_FILE && this.fetchFile.range) {
      const len = Math.max(0, Math.min(buf.length, n.size - pos));
      if (len > 0) {
        const t0 = performance.now();
        this.fetchFile.range(n.src || f.path, pos, len, buf);
        this.fetched.ranges++;
        this.fetched.bytes += len;
        this.fetched.ms += performance.now() - t0;
      }
      return len;
    }
    const d = this.bytes(f.path, f.n);
    const len = Math.max(0, Math.min(buf.length, (f.n.used ?? d.length) - pos));
    if (len > 0) buf.set(d.subarray(pos, pos + len));
    return len;
  }
  pwrite(fd, buf, pos) {
    const f = this.file(fd);
    const d = this.bytes(f.path, f.n);
    const used = f.n.used ?? d.length;
    const end = pos + buf.length;
    if (end > d.length) {
      const nd = new Uint8Array(Math.max(end, d.length * 2, 4096));
      nd.set(d.subarray(0, used));
      f.n.data = nd;
    }
    f.n.data.set(buf, pos);
    f.n.used = Math.max(used, end);
    f.n.dirty = true; // (a snapshot keeps its contents; see save)
    f.n.mtimeNs = BigInt(Date.now()) * 1000000n;
    return buf.length;
  }
  fstat(fd) {
    const f = this.file(fd);
    const st = this.conv(f.n);
    if (f.n.used !== undefined) st.size = BigInt(f.n.used);
    return st;
  }
  close(fd) { this.fds.delete(fd); }
  // (files written through pwrite keep a capacity: data.length >= used)
  contents(n) {
    const d = n.data || new Uint8Array(0);
    return n.used !== undefined ? d.subarray(0, n.used) : d;
  }
  readdir(g) {
    const [r, n] = this.node(g, true);
    if (n.type !== 'd') fail(E.NOTDIR);
    return [...n.children].map((name) => {
      const c = this.nodes.get((r === '/' ? '' : r) + '/' + name);
      return { name, ino: c.ino, type: c.type === 'd' ? 4 : c.type === 'l' ? (c.target === SOCKET_MARK ? 12 : 10) : 8 };
    });
  }
  readlink(g) {
    const [, n] = this.node(g, false);
    if (n.type !== 'l' || n.target === SOCKET_MARK) fail(E.INVAL);
    return n.target;
  }
  readFile(g) {
    const [r, n] = this.node(g, true);
    if (n.type !== 'f') fail(n.type === 'd' ? E.ISDIR : E.INVAL);
    this.bytes(r, n);
    return this.contents(n);
  }
  detach(r) {
    const n = this.nodes.get(r);
    if (n && n.src === r) this.removed.add(r);
    const parent = r.slice(0, r.lastIndexOf('/')) || '/';
    const pn = this.nodes.get(parent);
    if (pn) pn.children.delete(r.slice(r.lastIndexOf('/') + 1));
    this.nodes.delete(r);
  }
  mkdir(g, mode) {
    const r = this.resolve(g, false);
    if (this.nodes.has(r)) fail(E.EXIST);
    const parent = r.slice(0, r.lastIndexOf('/')) || '/';
    const pn = this.nodes.get(parent);
    if (!pn) fail(E.NOENT);
    if (pn.type !== 'd') fail(E.NOTDIR);
    this.add(r, 'd', mode, 0, Date.now());
  }
  rmdir(g) {
    const [r, n] = this.node(g, false);
    if (n.type !== 'd') fail(E.NOTDIR);
    if (n.children.size) fail(E.NOTEMPTY);
    this.detach(r);
  }
  unlink(g) {
    const [r, n] = this.node(g, false);
    if (n.type === 'd') fail(E.ISDIR);
    this.detach(r);
  }
  rename(a, b) {
    const [ra, na] = this.node(a, false);
    const rb = this.resolve(b, false);
    const nb = this.nodes.get(rb);
    if (nb && nb.type === 'd' && na.type !== 'd') fail(E.ISDIR);
    if (nb && nb.type === 'd' && nb.children.size) fail(E.NOTEMPTY);
    if (nb) this.detach(rb);
    const parent = rb.slice(0, rb.lastIndexOf('/')) || '/';
    const pn = this.nodes.get(parent);
    if (!pn || pn.type !== 'd') fail(E.NOENT);
    // move the node and everything below it
    const moved = [...this.nodes.keys()].filter((k) => k === ra || k.startsWith(ra + '/'));
    this.detach(ra);
    for (const k of moved) {
      const n = k === ra ? na : this.nodes.get(k);
      if (k !== ra) this.nodes.delete(k);
      this.nodes.set(rb + k.slice(ra.length), n);
    }
    pn.children.add(rb.slice(rb.lastIndexOf('/') + 1));
  }
  link(a, b) {
    const [ra, na] = this.node(a, true);
    const rb = this.resolve(b, false);
    if (this.nodes.has(rb)) fail(E.EXIST);
    this.bytes(ra, na);
    na.nlink++;
    this.nodes.set(rb, na);
    const parent = rb.slice(0, rb.lastIndexOf('/')) || '/';
    this.nodes.get(parent).children.add(rb.slice(rb.lastIndexOf('/') + 1));
  }
  symlink(target, g) {
    const r = this.resolve(g, false);
    if (this.nodes.has(r)) fail(E.EXIST);
    this.add(r, 'l', 0o777, target.length, Date.now(), target);
  }
  chmod(g, mode) { this.node(g, true)[1].mode = mode & 0o7777; }
  truncate(g, len) {
    const [r, n] = this.node(g, true);
    this.bytes(r, n);
    this.resize(n, len);
  }
  ftruncate(fd, len) {
    const f = this.file(fd);
    this.bytes(f.path, f.n);
    this.resize(f.n, len);
  }
  resize(n, len) {
    const d = this.contents(n);
    const nd = new Uint8Array(len);
    nd.set(d.subarray(0, Math.min(len, d.length)));
    n.data = nd;
    n.used = undefined;
    n.dirty = true;
  }
  utimes(g, at, mt) {
    const [, n] = this.node(g, true);
    if (mt !== null && mt !== undefined) n.mtimeNs = BigInt(Math.floor(mt * 1e9));
  }
  tmpfile() {
    const n = { type: 'f', mode: 0o600, size: 0, ino: this.nextIno++, mtimeNs: BigInt(Date.now()) * 1000000n, data: new Uint8Array(0), nlink: 0, dirty: true };
    const fd = this.nextFd++;
    this.fds.set(fd, { n, path: null });
    return { fd };
  }
  mksock(g) {
    const r = this.resolve(g, false);
    if (this.nodes.has(r)) fail(E.ADDRINUSE);
    this.add(r, 'l', 0o777, 0, Date.now(), SOCKET_MARK);
  }
}

// For a snapshot (js/linux/snapshot.js): the tree and the open files.
// Contents the guest changed go into blobs (addBlob(bytes) -> index); the
// rest is fetched again when read.
WebVfs.prototype.save = function (addBlob) {
  const ids = new Map(), nodes = [];
  const idOf = (n) => {
    let id = ids.get(n);
    if (id !== undefined) return id;
    ids.set(n, (id = nodes.length));
    const keep = n.type === 'f' && n.data && (n.dirty || !n.src);
    nodes.push({
      type: n.type, mode: n.mode, size: n.size, ino: String(n.ino), mtimeNs: String(n.mtimeNs), target: n.target, nlink: n.nlink,
      src: n.src, used: keep ? n.used : undefined, children: n.children ? [...n.children] : null,
      data: keep ? addBlob(n.data) : n.type === 'f' && n.data && n.data.length === 0 ? -2 : -1, // -2: empty; -1: fetch it
      remote: n.type === 'f' && !keep && !(n.data && n.data.length === 0),
    });
    return id;
  };
  const paths = [...this.nodes].map(([p, n]) => [p, idOf(n)]);
  const fds = [...this.fds].map(([fd, f]) => [fd, idOf(f.n), f.path]);
  return { nodes, paths, fds, nextIno: String(this.nextIno), nextFd: this.nextFd, removed: [...this.removed] };
};
// index (optional): the host's files now. The guest's changes (what it
// wrote, made, moved or removed) go over them, so files the host got since
// the snapshot (a game installed) are there too; a file on both keeps its
// inode number.
WebVfs.load = function (state, blob, fetchFile, uid, gid, index) {
  if (index) return mergeLoad(state, blob, fetchFile, uid, gid, index);
  const v = new WebVfs([], fetchFile, uid, gid);
  v.nodes.clear();
  const objs = state.nodes.map((s) => ({
    type: s.type, mode: s.mode, size: s.size, ino: BigInt(s.ino), mtimeNs: BigInt(s.mtimeNs), target: s.target, nlink: s.nlink, src: s.src,
    used: s.used, children: s.children ? new Set(s.children) : null, remote: s.remote,
    data: s.data >= 0 ? blob(s.data) : s.data === -2 ? new Uint8Array(0) : null, dirty: s.data >= 0,
  }));
  for (const [p, id] of state.paths) v.nodes.set(p, objs[id]);
  for (const [fd, id, path] of state.fds) v.fds.set(fd, { n: objs[id], path });
  v.nextIno = BigInt(state.nextIno);
  v.nextFd = state.nextFd;
  for (const p of state.removed || []) v.removed.add(p);
  return v;
};

function mergeLoad(state, blob, fetchFile, uid, gid, index) {
  const v = new WebVfs(index, fetchFile, uid, gid);
  // (new inode numbers after the snapshot's; files on both get theirs back)
  let next = BigInt(state.nextIno);
  for (const n of v.nodes.values()) n.ino = next++;
  for (const p of state.removed || []) {
    if (v.nodes.has(p)) v.detach(p);
    v.removed.add(p);
  }
  const objs = state.nodes.map((s) => ({
    type: s.type, mode: s.mode, size: s.size, ino: BigInt(s.ino), mtimeNs: BigInt(s.mtimeNs), target: s.target, nlink: s.nlink, src: s.src,
    used: s.used, children: s.children ? new Set(s.children) : null, remote: s.remote,
    data: s.data >= 0 ? blob(s.data) : s.data === -2 ? new Uint8Array(0) : null, dirty: s.data >= 0,
  }));
  const chosen = new Map(); // snapshot node id -> the node object it is now
  const paths = [...state.paths].sort((a, b) => a[0].length - b[0].length); // (parents first)
  for (const [p, id] of paths) {
    const o = objs[id], have = v.nodes.get(p);
    const guestMade = o.dirty || !o.src || o.src !== p || o.type === 'l';
    if (have && have.type === o.type && !guestMade) {
      have.ino = o.ino; // the same file
      if (have.children && o.children) for (const c of o.children) have.children.add(c);
      chosen.set(id, have);
      continue;
    }
    if (have && have.type === 'd' && o.type === 'd') { // (a directory the guest made that the host has too)
      for (const c of o.children || []) have.children.add(c);
      chosen.set(id, have);
      continue;
    }
    const parent = p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/';
    if (parent && !v.nodes.has(parent)) v.add(parent, 'd', 0o755, 0, Date.now());
    if (o.children && have && have.children) for (const c of have.children) o.children.add(c);
    v.nodes.set(p, chosen.get(id) || o);
    chosen.set(id, chosen.get(id) || o);
    if (parent) v.nodes.get(parent).children.add(p.slice(p.lastIndexOf('/') + 1));
  }
  for (const [fd, id, path] of state.fds) v.fds.set(fd, { n: chosen.get(id) || objs[id], path });
  v.nextIno = next > BigInt(state.nextIno) ? next : BigInt(state.nextIno);
  v.nextFd = state.nextFd;
  return v;
}

module.exports = { WebVfs };
