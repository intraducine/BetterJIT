// The windows the guest's display driver shows (Wine's wasmdrv.c, through
// the kernel's host.display messages), composed into one RGBA picture of
// the screen: a debug view for the page and screenshots on Node (the app's
// compositor takes over on the phone).
//   const c = new Compositor(1024, 768); c.message(msg); c.compose() -> Uint8ClampedArray
(function (G) {
'use strict';

const SWP_NOZORDER = 0x4;
const HWND_TOP = 0, HWND_BOTTOM = 1, HWND_TOPMOST = -1, HWND_NOTOPMOST = -2;

class Compositor {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.windows = new Map(); // hwnd -> {v: [x, y, w, h], visible, sw, sh, px (RGBA), topmost}
    this.z = []; // hwnds, bottom first
    this.frame = 0; // changes with what is shown
  }
  win(hwnd) {
    let w = this.windows.get(hwnd);
    if (!w) {
      w = { v: [0, 0, 0, 0], visible: false, sw: 0, sh: 0, px: null, topmost: false };
      this.windows.set(hwnd, w);
      this.z.push(hwnd);
    }
    return w;
  }
  message(m) {
    this.frame++;
    if (m.op === 'present') {
      const w = this.win(m.hwnd);
      if (w.sw !== m.sw || w.sh !== m.sh) {
        w.sw = m.sw;
        w.sh = m.sh;
        w.px = new Uint8ClampedArray(m.sw * m.sh * 4);
      }
      // BGRX -> RGBA
      const src = new Uint32Array(m.px.buffer, m.px.byteOffset, m.w * m.h), dst = new Uint32Array(w.px.buffer);
      for (let r = 0; r < m.h; r++) {
        let s = r * m.w, d = (m.y + r) * m.sw + m.x;
        for (let c = 0; c < m.w; c++, s++, d++) {
          const v = src[s];
          dst[d] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff);
        }
      }
    } else if (m.op === 'frame') {
      const w = this.win(m.hwnd);
      w.v = m.v;
      w.visible = m.visible;
      if (!(m.swp & SWP_NOZORDER)) this.restack(m.hwnd, m.after);
    } else if (m.op === 'destroy') {
      this.windows.delete(m.hwnd);
      this.z = this.z.filter((h) => h !== m.hwnd);
    }
  }
  // Z-order: hwnd goes on top, at the bottom, or just below `after`.
  restack(hwnd, after) {
    this.z = this.z.filter((h) => h !== hwnd);
    const w = this.windows.get(hwnd);
    if (after === HWND_TOPMOST) w.topmost = true;
    else if (after === HWND_NOTOPMOST) w.topmost = false;
    if (after === HWND_BOTTOM) { this.z.unshift(hwnd); return; }
    const i = after > 1 ? this.z.indexOf(after) : -1;
    if (i >= 0) this.z.splice(i, 0, hwnd); // (below it)
    else this.z.push(hwnd);
  }
  // The screen, RGBA (topmost windows over the rest).
  compose(into) {
    const W = this.width, H = this.height;
    const out = into || new Uint8ClampedArray(W * H * 4);
    const o32 = new Uint32Array(out.buffer, out.byteOffset, W * H);
    o32.fill(0xff808000); // teal, as Wine's desktop
    const order = this.z.filter((h) => !this.windows.get(h).topmost).concat(this.z.filter((h) => this.windows.get(h).topmost));
    for (const h of order) {
      const w = this.windows.get(h);
      if (!w.visible || !w.px) continue;
      const [x, y, vw, vh] = w.v, p32 = new Uint32Array(w.px.buffer);
      const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + Math.min(vw, w.sw)), y1 = Math.min(H, y + Math.min(vh, w.sh));
      for (let yy = y0; yy < y1; yy++) {
        const s = (yy - y) * w.sw - x, d = yy * W;
        for (let xx = x0; xx < x1; xx++) o32[d + xx] = p32[s + xx];
      }
    }
    return out;
  }
}

// A PNG of RGBA pixels (deflate: a zlib-like deflateSync(bytes)).
function png(rgba, width, height, deflateSync, crc32) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const chunk = (type, data) => {
    const b = new Uint8Array(12 + data.length), dv = new DataView(b.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
    b.set(data, 8);
    dv.setUint32(8 + data.length, crc32(b.subarray(4, 8 + data.length)) >>> 0);
    return b;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

G.FexCompositor = { Compositor, png };
if (typeof module !== 'undefined') module.exports = G.FexCompositor;
})(typeof globalThis !== 'undefined' ? globalThis : self);
