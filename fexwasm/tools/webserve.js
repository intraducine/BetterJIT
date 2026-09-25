// The guest kernel in a browser page, served from the Mac: the page and its
// workers (js/linux/web/), the kernel bundled for workers, the translator
// (a fexserve --linux it starts, behind /xlat/), the guest files (/fs/index,
// /fs/file, from the same mounts as tools/linuxrun.js) and a log the page
// posts its output to. Cross-origin isolated (SharedArrayBuffer).
//   node tools/webserve.js [--port 47400] [--xopts "cache=..."] [--log file]
// then open http://127.0.0.1:47400/js/linux/web/linux.html?argv=[...]
// (Safari runs it on JavaScriptCore, like the app's WKWebView.)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { mounts, index: linuxIndex, hostOf: linuxHostOf } = require('./linuxmounts.js');

const HERE = __dirname;
const JS = path.join(HERE, '..', 'js');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('--port', 47400));
const xport = port + 1;
const logFile = opt('--log', '/tmp/webserve.log');
const MOUNTS = mounts();

fs.writeFileSync(logFile, '');
const server = spawn(path.join(HERE, '..', 'out', 'fexserve'), ['--linux', String(xport), opt('--xopts', '')], { stdio: ['ignore', 'inherit', 'pipe'] });
server.stderr.on('data', (d) => {
  const s = d.toString();
  if (!/^fexserve on/.test(s)) fs.appendFileSync(logFile, s.split('\n').filter(Boolean).map((l) => '[fexserve] ' + l + '\n').join(''));
});
process.on('exit', () => server.kill());
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const { bundle } = require('./bundle_kernel.js');

const index = () => linuxIndex(MOUNTS);
const hostOf = (g) => linuxHostOf(MOUNTS, g);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/xlat/')) {
    const p = http.request({ host: '127.0.0.1', port: xport, path: req.url, method: req.method, headers: { 'content-length': req.headers['content-length'] || 0 } }, (pr) => {
      const chunks = [];
      pr.on('data', (c) => chunks.push(c));
      pr.on('end', () => send(res, pr.statusCode, pr.headers['content-type'] || 'application/octet-stream', Buffer.concat(chunks)));
    });
    p.on('error', (e) => send(res, 502, 'text/plain', String(e)));
    req.pipe(p);
    return;
  }
  if (u.pathname === '/log' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { fs.appendFileSync(logFile, Buffer.concat(chunks)); send(res, 200, 'text/plain', ''); });
    return;
  }
  if (u.pathname === '/shot' && req.method === 'POST') { // a PNG of the guest's screen, next to the log
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const name = (u.searchParams.get('name') || 'shot').replace(/[^\w-]/g, '');
      const file = path.join(path.dirname(logFile), `${name}.png`);
      fs.writeFileSync(file, Buffer.concat(chunks));
      fs.appendFileSync(logFile, `[webserve] saved ${file}\n`);
      send(res, 200, 'text/plain', '');
    });
    return;
  }
  if (u.pathname === '/fs/index') return send(res, 200, 'application/json', JSON.stringify(index()));
  if (u.pathname === '/fs/file') {
    const h = hostOf(u.searchParams.get('p') || '');
    try { return send(res, 200, 'application/octet-stream', fs.readFileSync(h)); } catch (e) { return send(res, 404, 'text/plain', String(e)); }
  }
  if (u.pathname === '/js/linux/web/linux-kernel.js') return send(res, 200, 'text/javascript', bundle());
  if (u.pathname.startsWith('/js/')) {
    const f = path.normalize(path.join(JS, u.pathname.slice(4)));
    if (!f.startsWith(JS)) return send(res, 403, 'text/plain', 'no');
    try { return send(res, 200, TYPES[path.extname(f)] || 'application/octet-stream', fs.readFileSync(f)); } catch (e) { return send(res, 404, 'text/plain', 'not found'); }
  }
  send(res, 404, 'text/plain', 'not found');
}).listen(port, '127.0.0.1', () => console.error(`webserve on http://127.0.0.1:${port}/js/linux/web/linux.html (log ${logFile})`));
