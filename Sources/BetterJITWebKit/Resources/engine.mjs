// SPDX-License-Identifier: GPL-3.0-or-later
// Host-independent engine. Used by WKWebView workers and Node/browser embedders.
export class Fault extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const requireThat = (ok, code, message) => { if (!ok) throw new Fault(code, message); };
const integer = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
export function decodeBytes(text, maximum) {
  requireThat(typeof text === 'string' && text.length <= 4 * Math.ceil(maximum / 3) &&
    text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text), 'messageTooLarge', 'Invalid or oversized base64.');
  const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
  requireThat(bytes.length <= maximum, 'messageTooLarge', 'Decoded message is too large.');
  return bytes;
}
export function encodeBytes(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
}
export function validateLimits(l) {
  requireThat(l && integer(l.initialMemoryPages, 1, 65536) && integer(l.maximumMemoryPages, l.initialMemoryPages, 65536) &&
    integer(l.maximumModuleBytes, 8, 16 * 1024 * 1024) && integer(l.maximumModules, 1, 4096) &&
    integer(l.maximumTransferBytes, 1, 4 * 1024 * 1024) && integer(l.maximumPendingRequests, 1, 128) &&
    Number.isFinite(l.timeoutSeconds) && l.timeoutSeconds >= .01 && l.timeoutSeconds <= 600,
    'invalidConfiguration', 'Invalid runtime limits.');
  return Object.freeze({ ...l });
}
export function capabilities() {
  return { protocolVersion: 1, wasm: typeof WebAssembly === 'object',
    jspi: typeof globalThis.WebAssembly?.Suspending === 'function' && typeof globalThis.WebAssembly?.promising === 'function',
    sharedMemory: globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function',
    opfs: typeof globalThis.navigator?.storage?.getDirectory === 'function' };
}
function name(value) {
  requireThat(typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 128 &&
    !/[\x00-\x1f]/.test(value), 'invalidName', 'Invalid module or export identifier.');
  return value;
}
function inputValue({ type, value } = {}) {
  requireThat(typeof value === 'string' && value.length <= 64, 'invalidValue', 'Expected a tagged numeric string.');
  if (type === 'i32' || type === 'i64') {
    requireThat(/^(0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(value), 'invalidValue', 'Noncanonical integer.');
    const n = BigInt(value), bits = type === 'i32' ? 32 : 64;
    requireThat(BigInt.asIntN(bits, n) === n, 'invalidValue', 'Integer out of range.');
    return type === 'i32' ? Number(n) : n;
  }
  requireThat((type === 'f32' || type === 'f64') && value.trim() === value && value.length > 0,
    'invalidValue', 'Unsupported numeric type.');
  const n = Number(value);
  requireThat(Number.isFinite(n) && (type !== 'f32' || Number.isFinite(Math.fround(n))), 'invalidValue', 'Nonfinite float.');
  return n;
}
function outputValue(value, type) {
  if (type === 'i64') {
    requireThat(typeof value === 'bigint', 'signature', 'Expected i64 result.');
  } else {
    requireThat(['i32', 'f32', 'f64'].includes(type) && typeof value === 'number' && Number.isFinite(value), 'signature', 'Expected finite numeric result.');
    if (type === 'i32') requireThat(integer(value, -2147483648, 2147483647), 'signature', 'Expected i32 result.');
  }
  return { type, value: Object.is(value, -0) ? '-0.0' : String(value) };
}
// WebAssembly reflection does not expose unexported memories. Reject private
// linear memories before compilation so modules must use the budgeted import.
export function validateMemoryOwnership(bytes) {
  requireThat(bytes.length >= 8 && bytes.slice(0, 8).every((v, i) => v === [0,97,115,109,1,0,0,0][i]), 'invalidModule', 'Expected Wasm v1.');
  let p = 8;
  const u32 = () => {
    let n = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      requireThat(p < bytes.length, 'invalidModule', 'Truncated LEB128.');
      const b = bytes[p++];
      requireThat(shift < 28 || (b & 0xf0) === 0, 'invalidModule', 'Oversized LEB128.');
      n += (b & 127) * 2 ** shift;
      if (!(b & 128)) return n;
    }
    throw new Fault('invalidModule', 'Malformed LEB128.');
  };
  while (p < bytes.length) {
    const section = bytes[p++], length = u32(), end = p + length;
    requireThat(end <= bytes.length, 'invalidModule', 'Section extends beyond module.');
    if (section === 5) {
      const count = u32();
      requireThat(p <= end && count === 0, 'memoryOwnership', 'Import betterjit.memory instead of defining a private memory.');
    }
    p = end;
  }
}

export class Engine {
  constructor({ hostCall = async () => { throw new Fault('serviceDenied', 'No native service installed.'); } } = {}) {
    this.hostCall = hostCall; this.modules = new Map(); this.closed = false; this.limits = null; this.fex = null;
  }
  range(offset, length, maximum = this.limits.maximumTransferBytes) {
    requireThat(integer(offset, 0, 0xffffffff) && integer(length, 0, maximum) &&
      offset <= this.memory.buffer.byteLength && length <= this.memory.buffer.byteLength - offset,
      'bounds', 'Memory transfer outside the accessible range.');
    return new Uint8Array(this.memory.buffer, offset, length);
  }
  async command(operation, p = {}) {
    requireThat(!this.closed, 'closed', 'Runtime is closed.');
    if (operation === 'configure') {
      requireThat(!this.limits, 'invalidState', 'Runtime is already configured.');
      requireThat(capabilities().wasm, 'unsupported', 'WebAssembly is unavailable.');
      const limits = validateLimits(p.limits);
      requireThat(Array.isArray(p.services) && p.services.length <= 128 && p.services.every(s => typeof s === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(s)), 'invalidConfiguration', 'Invalid service allowlist.');
      this.services = new Set(p.services);
      this.memory = new WebAssembly.Memory({ initial: limits.initialMemoryPages, maximum: limits.maximumMemoryPages });
      this.limits = limits;
      return capabilities();
    }
    requireThat(this.limits, 'invalidState', 'Configure before use.');
    switch (operation) {
      case 'load': {
        requireThat(!this.fex, 'invalidState', 'Use a separate session for Wasm modules and FEX guests.');
        const id = name(p.module);
        requireThat(!this.modules.has(id), 'duplicateModule', 'Module identifier is already loaded.');
        requireThat(this.modules.size < this.limits.maximumModules, 'moduleLimit', 'Unload modules or create a new session.');
        const bytes = decodeBytes(p.bytes, this.limits.maximumModuleBytes);
        validateMemoryOwnership(bytes);
        const module = await WebAssembly.compile(bytes);
        const imports = WebAssembly.Module.imports(module);
        for (const i of imports) requireThat(i.module === 'betterjit' &&
          ((i.name === 'memory' && i.kind === 'memory') || (i.name === 'call' && i.kind === 'function')),
          'importDenied', 'Only betterjit.memory and betterjit.call are allowed.');
        requireThat(imports.filter(i => i.kind === 'memory').length <= 1, 'importDenied', 'Only one memory is supported.');
        const functions = { memory: this.memory };
        if (imports.some(i => i.name === 'call')) {
          requireThat(capabilities().jspi, 'unsupported', 'Native calls require JSPI on this WebKit version.');
          functions.call = new WebAssembly.Suspending(async (service, offset, count, reply, capacity) => {
            const key = 'host.' + (service >>> 0);
            requireThat(this.services.has(key), 'serviceDenied', 'The application did not register this service.');
            const payload = encodeBytes(this.range(offset >>> 0, count >>> 0));
            this.range(reply >>> 0, capacity >>> 0);
            const result = decodeBytes(await this.hostCall(key, payload), this.limits.maximumTransferBytes);
            requireThat(result.length <= (capacity >>> 0), 'bounds', 'Native response does not fit the guest buffer.');
            this.range(reply >>> 0, result.length).set(result);
            return result.length;
          });
        }
        const instance = await WebAssembly.instantiate(module, { betterjit: functions });
        this.modules.set(id, instance);
        return WebAssembly.Module.exports(module).map(x => ({ name: x.name, kind: x.kind }));
      }
      case 'unload':
        requireThat(this.modules.delete(name(p.module)), 'unknownModule', 'Module is not loaded.'); return null;
      case 'invoke': {
        const ex = this.modules.get(name(p.module))?.exports;
        requireThat(ex && Object.hasOwn(ex, name(p.export)) && typeof ex[p.export] === 'function', 'unknownExport', 'Function is not exported by that module.');
        requireThat(Array.isArray(p.arguments) && p.arguments.length <= 64 && Array.isArray(p.results) && p.results.length <= 16, 'signature', 'Invalid call arity.');
        let fn = ex[p.export];
        if (capabilities().jspi) fn = WebAssembly.promising(fn);
        const result = await fn(...p.arguments.map(inputValue));
        const values = result === undefined ? [] : Array.isArray(result) ? result : [result];
        requireThat(values.length === p.results.length, 'signature', 'Result count does not match.');
        return values.map((v, i) => outputValue(v, p.results[i]));
      }
      case 'read': return encodeBytes(this.range(p.offset, p.count));
      case 'write': { const bytes = decodeBytes(p.bytes, this.limits.maximumTransferBytes); this.range(p.offset, bytes.length).set(bytes); return null; }
      case 'fex.open': return this.openFEX();
      case 'fex.call': return this.callFEX(p);
      default: throw new Fault('unknownOperation', 'Unknown execution operation.');
    }
  }
  async openFEX() {
    requireThat(!this.fex && this.modules.size === 0, 'invalidState', 'FEX needs a fresh dedicated session.');
    requireThat(this.services.has('fex'), 'serviceDenied', 'Install a FEX translation service first.');
    requireThat(capabilities().jspi, 'unsupported', 'Live FEX execution requires JSPI.');
    const request = async (method, data = {}) => this.hostCall('fex', { method, ...data });
    const cfg = await request('config');
    requireThat(cfg && integer(cfg.memPages, 1, this.limits.maximumMemoryPages) && cfg.shared === false,
      'unsupported', 'FEX v1 requires an unshared memory within the configured budget.');
    const memoryBytes = cfg.memPages * 65536;
    for (const k of ['ctx', 'stateSize', 'imageLow', 'stackTop', 'halt', 'gregsOff']) {
      requireThat(integer(cfg[k], 0, memoryBytes), 'invalidBackend', 'Invalid FEX memory layout.');
    }
    requireThat(integer(cfg.windowHi, 0, 0xffffffff) && ['sysv','win64'].includes(cfg.guestAbi) && cfg.threadBase === -1 &&
      cfg.stackTop >= 0x48 && cfg.ctx + cfg.stateSize <= memoryBytes && cfg.ctx + cfg.gregsOff + 16 * 8 <= memoryBytes,
      'invalidBackend', 'Unsupported FEX address window or ABI.');
    const image = decodeBytes(await request('image'), this.limits.maximumModuleBytes);
    const state = decodeBytes(await request('state'), this.limits.maximumModuleBytes);
    const dispatcher = decodeBytes(await request('dispatcher'), this.limits.maximumModuleBytes);
    requireThat(image.length <= memoryBytes - cfg.imageLow && state.length === cfg.stateSize, 'invalidBackend', 'Invalid image or CPU state size.');
    // Imported from the existing FEX research runtime, not an Iridium component.
    await import('./fex-runtime.js');
    const memory = new WebAssembly.Memory({ initial: cfg.memPages, maximum: this.limits.maximumMemoryPages });
    new Uint8Array(memory.buffer).set(image, cfg.imageLow);
    const unit = async rip => {
      const data = decodeBytes(await request('unit', { rip: rip >>> 0 }), this.limits.maximumModuleBytes + 4);
      if (data.length === 0) return null;
      requireThat(data.length >= 12, 'invalidBackend', 'Truncated FEX unit.');
      const slot = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
      requireThat(slot > 0 && slot < 1048576, 'invalidBackend', 'FEX table slot out of range.');
      return { module: await WebAssembly.compile(data.subarray(4)), bytes: data.length - 4, slot };
    };
    const region = async (rips, profile) => {
      const words = [rips.length, ...rips, rips.length];
      for (const r of rips) { const s = profile.successors(r); words.push(r, s.length, ...s); }
      const sites = profile.callSites(); words.push(sites.length);
      for (const [ret, targets] of sites) words.push(ret, targets.length, ...targets);
      const bytes = new Uint8Array(words.length * 4), view = new DataView(bytes.buffer);
      words.forEach((word, i) => view.setUint32(i * 4, word, true));
      requireThat(bytes.length <= this.limits.maximumTransferBytes, 'messageTooLarge', 'FEX profile too large.');
      const data = decodeBytes(await request('region', { profile: encodeBytes(bytes) }), this.limits.maximumModuleBytes);
      return data.length ? { module: await WebAssembly.compile(data), bytes: data.length } : null;
    };
    const runtime = globalThis.FexRuntime.createRuntime({ ...cfg, threadBase: undefined, mem: memory,
      now: () => performance.now(), dispatcher, translateAsync: unit, translateRegionAsync: region,
      codeBudget: this.limits.maximumModuleBytes * Math.min(this.limits.maximumModules, 8) });
    this.memory = memory; this.fex = { cfg, state, runtime };
    return { guestABI: cfg.guestAbi, memoryPages: cfg.memPages };
  }
  async callFEX(p) {
    requireThat(this.fex && integer(p.entry, 0, 0xffffffff) && typeof p.argument === 'string' && /^(0|[1-9][0-9]*)$/.test(p.argument), 'invalidCall', 'Invalid FEX call.');
    const arg = BigInt(p.argument);
    requireThat(arg < (1n << 64n), 'invalidCall', 'Guest argument is larger than u64.');
    const { cfg, state, runtime } = this.fex;
    const u8 = new Uint8Array(this.memory.buffer), dv = new DataView(u8.buffer);
    const G = cfg.ctx + cfg.gregsOff, W = BigInt(cfg.windowHi) << 32n;
    u8.set(state, cfg.ctx);
    const ret = cfg.stackTop - (cfg.guestAbi === 'win64' ? 0x48 : 8);
    dv.setBigUint64(G + (cfg.guestAbi === 'win64' ? 1 : 7) * 8, arg, true);
    dv.setBigUint64(ret, W + BigInt(cfg.halt), true);
    dv.setBigUint64(G + 4 * 8, W + BigInt(ret), true);
    await runtime.runAsync(p.entry, cfg.halt);
    return dv.getBigUint64(G, true).toString();
  }
  close() { this.closed = true; this.modules.clear(); this.fex = null; this.memory = null; }
}
