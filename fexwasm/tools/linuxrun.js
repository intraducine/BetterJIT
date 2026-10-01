// Runs an x86-64 Linux program (static, or dynamic against musl) under the
// guest kernel (js/linux/) with its code translated live by fexserve --linux:
//   node --experimental-wasm-jspi tools/linuxrun.js [options] <program> [args...]
// Options:
//   --mount /guest=/host   add a mount (defaults below)
//   --env K=V              environment (defaults: HOME, PATH, USER, LANG)
//   --cwd /dir             working directory
//   --xlat http://...      a running translator (default: start out/fexserve)
//   --trace                log every syscall
//   --xopts "k=v ..."      translator options (src/translator.h), e.g. hot=0
//   --timeout S            after S seconds, show what every thread is doing and stop
//   --region-after S       threads make regions (hot code compiled together) once S seconds old (default 30)
//   --screenshot file.png  a display for Wine (dlls/win32u/wasmdrv.c): the screen as it ends up
// Default mounts: / = build/linuxroot/root, /lib = the musl sysroot's lib,
// /opt/wine = build/wine-install/opt/wine, /tmp and /home under
// build/linuxroot, /test = build/test.
'use strict';

const { Worker } = require('worker_threads');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..', '..');
const BUILD = path.join(REPO, 'build');

async function main() {
  const args = process.argv.slice(2);
  const mounts = [];
  const env = {};
  let cwd = null, xlat = null, trace = false, traceExec = false, xopts = '', timeout = 0, regionAfterMs = 30000, screenshot = null;
  while (args.length && args[0].startsWith('--')) {
    const a = args.shift();
    if (a === '--mount') { const [g, h] = args.shift().split('='); mounts.push([g, h]); }
    else if (a === '--env') { const kv = args.shift(), i = kv.indexOf('='); env[kv.slice(0, i)] = kv.slice(i + 1); }
    else if (a === '--cwd') cwd = args.shift();
    else if (a === '--xlat') xlat = args.shift();
    else if (a === '--trace') trace = true;
    else if (a === '--trace-exec') traceExec = true;
    else if (a === '--xopts') xopts = args.shift();
    else if (a === '--timeout') timeout = Number(args.shift());
    else if (a === '--region-after') regionAfterMs = 1000 * Number(args.shift());
    else if (a === '--screenshot') screenshot = args.shift();
    else throw new Error('unknown option ' + a);
  }
  if (!args.length && !process.env.FEXWASM_RESTORE) {
    console.error('usage: node --experimental-wasm-jspi tools/linuxrun.js [options] <program> [args...]');
    process.exit(2);
  }
  const root = path.join(BUILD, 'linuxroot');
  for (const d of ['root', 'tmp', 'home/user']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const defaults = [
    ['/', path.join(root, 'root')],
    ['/lib', path.join(BUILD, 'sysroot-x86_64', 'lib')],
    ['/opt/wine', path.join(BUILD, 'wine-install', 'opt', 'wine')],
    ['/tmp', path.join(root, 'tmp')],
    ['/home', path.join(root, 'home')],
    ['/test', path.join(BUILD, 'test')],
  ];
  for (const d of defaults) if (!mounts.some(([g]) => g === d[0])) mounts.push(d);
  // mount points (and /proc, /dev, /sys) exist as directories in the root
  const rootHost = mounts.find(([g]) => g === '/')[1];
  for (const g of [...mounts.map(([g]) => g), '/proc', '/dev', '/sys', '/usr/bin', '/bin']) {
    if (g !== '/') fs.mkdirSync(path.join(rootHost, g), { recursive: true });
  }
  // LD_LIBRARY_PATH: musl's dynamic linker finds a library's NEEDED entries
  // (Wine's unix libraries need "ntdll.so") by search, not by the soname of
  // what is already loaded; found again this way, the loaded copy is reused.
  const envv = Object.assign({ HOME: '/home/user', USER: 'user', PATH: '/opt/wine/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8',
    LD_LIBRARY_PATH: '/opt/wine/lib/wine/x86_64-unix' }, env);

  let server = null;
  if (!xlat) {
    const port = 47300 + Math.floor(Math.random() * 500);
    xlat = `http://127.0.0.1:${port}`;
    server = spawn(path.join(HERE, '..', 'out', 'fexserve'), ['--linux', String(port), xopts], { stdio: ['ignore', 'inherit', 'pipe'] });
    server.stderr.on('data', (d) => {
      const s = d.toString();
      if (!/^fexserve on/.test(s)) process.stderr.write(s.split('\n').filter(Boolean).map((l) => '[fexserve] ' + l + '\n').join(''));
    });
    for (let i = 0; ; i++) {
      try { await fetch(xlat + '/xlat/stats?space=0'); break; } catch (e) { if (i > 100) throw e; await new Promise((r) => setTimeout(r, 20)); }
    }
  }
  const get = async (p) => { const r = await fetch(xlat + p); if (!r.ok) throw new Error(p + ' ' + r.status); return r; };
  const cfg = await (await get('/xlat/config?space=0')).json();
  const dispatcher = new Uint8Array(await (await get('/xlat/dispatcher?space=0')).arrayBuffer());
  const state = new Uint8Array(await (await get('/xlat/state?space=0')).arrayBuffer());
  await get('/xlat/drop?space=0');

  const bridge = new SharedArrayBuffer(16); // [0] call done, [1] result, [2] dump request
  const b32 = new Int32Array(bridge);
  const done = (v) => { b32[1] = v || 0; Atomics.store(b32, 0, 1); Atomics.notify(b32, 0); };
  const bootEpoch = performance.timeOrigin + performance.now() - 1e6;
  const t0 = performance.now();
  const threads = new Map();
  const threadStats = [];
  const kernel = new Worker(path.join(HERE, '..', 'js', 'linux', 'kworker.js'), {
    workerData: { cfg, state, mounts, argv: args, env: Object.entries(envv).map(([k, v]) => `${k}=${v}`), bridge, cwd: cwd || '/', trace, traceExec, bootEpoch,
      display: screenshot ? '1024x768' : null },
  });
  const { Compositor, png } = require('../js/linux/compositor.js');
  const screen = screenshot ? new Compositor(1024, 768) : null;
  const finish = (code) => {
    const ms = performance.now() - t0;
    if (screen) {
      const zlib = require('zlib');
      fs.writeFileSync(screenshot, png(screen.compose(), screen.width, screen.height, zlib.deflateSync, zlib.crc32));
      console.error(`[linuxrun] screenshot ${screenshot}: ${screen.windows.size} windows, ${screen.frame} updates`);
    }
    if (code === 124) console.error(`[linuxrun] units: ${units.stats.requests} requests, ${units.stats.compiled} modules compiled; translator ${Math.round(units.stats.fetchMs)} ms, compile waits ${Math.round(units.stats.compileMs)} ms`);
    console.error(`[linuxrun] exit ${code} after ${ms.toFixed(0)} ms`);
    for (const w of threads.values()) w.terminate();
    kernel.terminate();
    if (server) server.kill();
    process.exit(code);
  };
  // units, compiled once for all the thread workers
  require('vm').runInThisContext(fs.readFileSync(path.join(HERE, '..', 'js', 'linux', 'thread_core.js'), 'utf8'));
  const units = globalThis.FexLinuxThread.UnitCache(xlat, undefined, Number(process.env.FEXWASM_CODE_EPOCH_MB || 0) * (1 << 20)); // (code epochs: see UnitCache)
  kernel.on('message', async (m) => {
    switch (m.op) {
      case 'spawn': {
        const w = new Worker(path.join(HERE, '..', 'js', 'linux', 'thread.js'), {
          workerData: { pid: m.pid, tid: m.tid, tb: m.tb, mem: m.mem, wx: m.wx, space: m.space, slot: m.slot, ksab: m.ksab, cfg, dispatcher, xlat, traceCode: !!process.env.FEXWASM_TRACECODE, codeEpoch: units.epoch.buffer,
            bootEpoch: m.bootEpoch ?? bootEpoch,
            regionAfterMs: regionAfterMs, noRegions: !!process.env.FEXWASM_NOREGIONS },
          resourceLimits: { stackSizeMb: 8 },
        });
        threads.set(m.tid, w);
        // the slot is free again only once this worker is gone
        w.on('exit', () => {
          const k32 = new Int32Array(m.ksab);
          Atomics.store(k32, ((256 + m.slot * 128) >> 2) + 26, 0);
          if (threads.get(m.tid) === w) threads.delete(m.tid);
        });
        w.on('message', (x) => {
          if (x.op === 'unit') {
            units.get(x.space, x.rip).then((r) => w.postMessage(Object.assign({ op: 'unit', id: x.id }, r)),
              (e) => { console.error(`[linuxrun] unit 0x${x.rip.toString(16)}: ${e}`); w.postMessage({ op: 'unit', id: x.id }); });
          } else if (x.op === 'log') console.error(x.m);
          else if (x.op === 'threadStats') threadStats.push(x);
        });
        w.on('error', (e) => console.error(`[tid ${m.tid}] worker error:`, e));
        break;
      }
      case 'kill': {
        const w = threads.get(m.tid);
        if (w) { threads.delete(m.tid); w.terminate(); }
        break;
      }
      case 'code': {
        const r = await fetch(`${xlat}/xlat/code?space=${m.space}&addr=${m.addr.toString(16)}&abi=${m.abi || 0}`, { method: 'POST', body: m.bytes });
        done(r.ok ? 0 : 1);
        break;
      }
      case 'uncode':
        await fetch(`${xlat}/xlat/uncode?space=${m.space}&addr=${m.addr.toString(16)}&size=${m.size.toString(16)}`);
        done(0);
        break;
      case 'drop':
        await fetch(`${xlat}/xlat/drop?space=${m.space}`);
        done(0);
        break;
      case 'write':
        (m.fd === 2 ? process.stderr : process.stdout).write(Buffer.from(m.bytes));
        break;
      case 'display':
        if (screen) screen.message(m.msg);
        break;
      case 'input': {
        // FEXWASM_CLICKS=x.y.ms|...: taps on the display (testing input)
        const in32 = new Int32Array(m.inputSab), k32 = new Int32Array(m.ksab);
        const send = (type, x, y, flags, data) => {
          const w = Atomics.load(in32, 0), e = 2 + (((w % 256) + 256) % 256) * 5;
          in32.set([type, x, y, flags, data], e);
          Atomics.store(in32, 0, (w + 1) | 0);
          Atomics.add(k32, 0, 1);
          Atomics.notify(k32, 0);
        };
        for (const c of (process.env.FEXWASM_CLICKS || '').split('|').filter(Boolean)) {
          const [x, y, ms] = c.split('.').map(Number);
          setTimeout(() => { send(0, x, y, 1, 0); send(0, x, y, 3, 0); setTimeout(() => send(0, x, y, 5, 0), 80); console.error(`[linuxrun] tap ${x},${y}`); }, ms);
        }
        break;
      }
      case 'log':
        console.error(m.m);
        break;
      case 'exit':
        if (m.byNr) console.error(`[linuxrun] ${m.syscalls} kernel syscalls; top: ${m.byNr.map(([n, c]) => n + ':' + c).join(' ')}`);
        if (m.msByNr) console.error(`[linuxrun] kernel: handlers ${m.handlerMs} ms (top ${m.msByNr.map(([n, ms]) => n + ':' + ms).join(' ')}), shared-memory sync ${m.syncMs} ms, idle ${m.idleMs} ms`);
        (async () => {
          // the translator's work, all spaces
          const tot = await (await fetch(`${xlat}/xlat/totals`)).json();
          console.error(`[linuxrun] units: ${units.stats.requests} requests, ${units.stats.compiled} modules compiled (${(units.stats.compiledBytes / 1e6).toFixed(1)} MB); translator ${Math.round(units.stats.fetchMs)} ms, compile waits ${Math.round(units.stats.compileMs)} ms`);
          console.error(`[linuxrun] translator: ${tot.units} units ${tot.regions} regions (${tot.cacheHits} from memory, ${tot.diskHits} from disk), fex ${Math.round(tot.fexMs)} ms, units ${Math.round(tot.unitMs)} ms, regions ${Math.round(tot.regionMs)} ms; ` +
            `${tot.guestInsts} guest instructions, ${(tot.unitBytes / 1e6).toFixed(1)} MB of units (${(tot.unitBytes / tot.guestInsts).toFixed(1)} bytes each)`);
        })().finally(() => setTimeout(() => {
          const sum = { top: 0, waited: 0, redirects: 0, drops: 0, unwound: {} };
          for (const s of threadStats) {
            sum.top += s.rt.topMisses || 0; sum.waited += s.rt.waitedMisses || 0;
            sum.deep = (sum.deep || 0) + (s.stats.deepExits || 0);
            sum.redirects += s.stats.redirects || 0; sum.drops += s.stats.redirectDrops || 0;
            for (const [k, v] of Object.entries(s.rt.unwound || {})) sum.unwound[k] = (sum.unwound[k] || 0) + v;
          }
          console.error(`[linuxrun] misses: ${sum.top} unwound to the top, ${sum.waited} waited (JSPI); miss unwinds by cause ${JSON.stringify(sum.unwound)}; redirects ${sum.redirects} (${sum.drops} code drops); ${sum.deep} calls too deep`);
          for (const s of threadStats) {
            const t = s.tstats;
            console.error(`[linuxrun] tid ${s.tid}: ${s.stats.kcalls} kernel calls, ${s.stats.local} local; ${t.units} units ${t.regions} regions, fetch ${t.fetchMs.toFixed(0)} ms, compile ${t.compileMs.toFixed(0)} ms, kernel wait ${s.stats.kwaitMs.toFixed(0)} ms, alive ${s.stats.aliveMs.toFixed(0)} ms`);
          }
          const all = threadStats.reduce((a, s) => a + (s.tstats.bytes || 0), 0);
          console.error(`[linuxrun] ${threadStats.length} threads compiled ${(all / 1e6).toFixed(1)} MB of wasm; guest memory ${m.memInfo || '?'}`);
          finish(m.code);
        }, 100));
        break;
    }
  });
  kernel.on('error', (e) => { console.error('kernel worker error:', e); finish(126); });
  if (timeout) {
    setTimeout(() => {
      console.error(`[linuxrun] timeout after ${timeout} s; threads:`);
      Atomics.store(b32, 2, 1);
      setTimeout(() => finish(124), 1500);
    }, timeout * 1000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
