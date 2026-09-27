// SPDX-License-Identifier: GPL-3.0-or-later
// Host-independent execution engine; the worker owns transport and cancellation.
import { Fault, requireThat, integer, inspectModule } from './wasm-module.mjs';
export { Fault } from './wasm-module.mjs';
export function decodeBytes(text, maximum) {
  requireThat(typeof text === 'string' && text.length <= 4 * Math.ceil(maximum / 3) &&
    text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text), 'messageTooLarge', 'Invalid or oversized base64.');
  let bytes;
  try { bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0)); }
  catch { throw new Fault('invalidEncoding', 'Malformed base64.'); }
  requireThat(bytes.length <= maximum && encodeBytes(bytes) === text, 'invalidEncoding', 'Noncanonical base64.');
  return bytes;
}
export function encodeBytes(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
}
export function validateLimits(input) {
  const l = { maximumResidentModuleBytes: 32 * 1024 * 1024, maximumCumulativeModuleBytes: 256 * 1024 * 1024,
    maximumTableElements: 65536, maximumPendingBytes: 64 * 1024 * 1024, maximumBatchOperations: 64, ...input };
  requireThat(input && integer(l.initialMemoryPages, 1, 65536) && integer(l.maximumMemoryPages, l.initialMemoryPages, 65536) &&
    integer(l.maximumModuleBytes, 8, 16 * 1024 * 1024) && integer(l.maximumModules, 1, 4096) &&
    integer(l.maximumTransferBytes, 1, 4 * 1024 * 1024) && integer(l.maximumPendingRequests, 1, 128) &&
    Number.isFinite(l.timeoutSeconds) && l.timeoutSeconds >= .01 && l.timeoutSeconds <= 600 &&
    integer(l.maximumResidentModuleBytes, l.maximumModuleBytes, 256 * 1024 * 1024) &&
    integer(l.maximumCumulativeModuleBytes, l.maximumResidentModuleBytes, 1024 * 1024 * 1024) &&
    integer(l.maximumTableElements, 1, 1048576) && integer(l.maximumPendingBytes, 65536, 256 * 1024 * 1024) &&
    integer(l.maximumBatchOperations, 1, 128), 'invalidConfiguration', 'Invalid runtime limits.');
  return Object.freeze(l);
}
export function capabilities() {
  return { protocolVersion: 1, extensions: ['batch','statistics','fex.integerArguments','typedSignatures','resourceBudgets'], wasm: typeof WebAssembly === 'object',
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
    requireThat(value.trim() === value && /^(0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(value), 'invalidValue', 'Noncanonical integer.');
    const n = BigInt(value), bits = type === 'i32' ? 32 : 64;
    requireThat(BigInt.asIntN(bits, n) === n, 'invalidValue', 'Integer out of range.');
    return type === 'i32' ? Number(n) : n;
  }
  requireThat((type === 'f32' || type === 'f64') && value.trim() === value && /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value),
    'invalidValue', 'Expected a finite decimal float.');
  const n = Number(value);
  requireThat(Number.isFinite(n) && (type !== 'f32' || Number.isFinite(Math.fround(n))), 'invalidValue', 'Nonfinite float.');
  return type === 'f32' ? Math.fround(n) : n;
}
function outputValue(value, type) {
  if (type === 'i64') requireThat(typeof value === 'bigint', 'signature', 'Expected i64 result.');
  else {
    requireThat(['i32','f32','f64'].includes(type) && typeof value === 'number' && Number.isFinite(value), 'signature', 'Expected finite numeric result.');
    if (type === 'i32') requireThat(integer(value, -2147483648, 2147483647), 'signature', 'Expected i32 result.');
  }
  return { type, value: Object.is(value, -0) ? '-0.0' : String(value) };
}
export function validateMemoryOwnership(bytes) { inspectModule(bytes); }

export class Engine {
  constructor({ hostCall = async () => { throw new Fault('serviceDenied', 'No native service installed.'); } } = {}) {
    this.hostCall = hostCall; this.modules = new Map(); this.closed = false; this.limits = null; this.fex = null;
    this.tail = Promise.resolve(); this.pending = 0;
    this.metrics = { loadedModules: 0, residentModuleBytes: 0, cumulativeModuleBytes: 0, reservedTableElements: 0,
      memoryBytes: 0, invocations: 0, nativeCalls: 0, nativeRequestBytes: 0, nativeResponseBytes: 0,
      compileMilliseconds: 0, invokeMilliseconds: 0 };
  }
  assertOpen() { requireThat(!this.closed, 'closed', 'Runtime is closed.'); }
  range(offset, length, maximum = this.limits.maximumTransferBytes) {
    this.assertOpen();
    requireThat(integer(offset, 0, 0xffffffff) && integer(length, 0, maximum) &&
      offset <= this.memory.buffer.byteLength && length <= this.memory.buffer.byteLength - offset,
      'bounds', 'Memory transfer outside the accessible range.');
    return new Uint8Array(this.memory.buffer, offset, length);
  }
  // Direct Node/browser embedders get the same serialization as the worker.
  command(operation, payload = {}) {
    if (this.closed) return Promise.reject(new Fault('closed', 'Runtime is closed.'));
    if (this.pending >= (this.limits?.maximumPendingRequests ?? 1)) return Promise.reject(new Fault('backpressure', 'Engine queue is full.'));
    this.pending++;
    const task = this.tail.then(async () => {
      this.assertOpen();
      try { return await this.execute(operation, payload); }
      catch (error) {
        if (error instanceof WebAssembly.RuntimeError) { this.close(); throw new Fault('wasmTrap', 'Guest execution trapped; session was closed.'); }
        throw error;
      }
    }).finally(() => { this.pending--; });
    this.tail = task.catch(() => {});
    return task;
  }
  async compile(bytes) {
    requireThat(bytes.length <= this.limits.maximumCumulativeModuleBytes - this.metrics.cumulativeModuleBytes,
      'codeBudget', 'Session compilation budget exhausted; create a new session.');
    this.metrics.cumulativeModuleBytes += bytes.length; // Failed compiles also consume a finite work budget.
    const t = performance.now();
    try { const module = await WebAssembly.compile(bytes); this.assertOpen(); return module; }
    finally { this.metrics.compileMilliseconds += performance.now() - t; }
  }
  async execute(operation, p = {}) {
    if (operation === 'configure') {
      requireThat(!this.limits, 'invalidState', 'Runtime is already configured.');
      requireThat(capabilities().wasm, 'unsupported', 'WebAssembly is unavailable.');
      const limits = validateLimits(p?.limits);
      requireThat(Array.isArray(p.services) && p.services.length <= 128 && p.services.every(s =>
        typeof s === 'string' && s.trim() === s && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(s)), 'invalidConfiguration', 'Invalid service allowlist.');
      let memory;
      try { memory = new WebAssembly.Memory({ initial: limits.initialMemoryPages, maximum: limits.maximumMemoryPages }); }
      catch { throw new Fault('allocationFailed', 'Could not allocate the configured session memory.'); }
      this.memory = memory; this.limits = limits; this.services = new Set(p.services);
      return capabilities();
    }
    requireThat(this.limits, 'invalidState', 'Configure before use.');
    switch (operation) {
      case 'load': return this.load(p);
      case 'unload': {
        const id = name(p.module), entry = this.modules.get(id);
        requireThat(entry, 'unknownModule', 'Module is not loaded.');
        this.modules.delete(id); this.metrics.residentModuleBytes -= entry.bytes;
        this.metrics.reservedTableElements -= entry.tableElements; return null;
      }
      case 'invoke': return this.invoke(this.prepareCall(p));
      case 'invokeBatch': {
        requireThat(Array.isArray(p.calls) && p.calls.length > 0 && p.calls.length <= this.limits.maximumBatchOperations,
          'invalidCall', 'Invalid batch size.');
        const calls = p.calls.map(call => this.prepareCall(call)); // Validate every signature before executing anything.
        const results = [];
        for (const call of calls) results.push(await this.invoke(call));
        return results;
      }
      case 'statistics': return { ...this.metrics, loadedModules: this.modules.size, memoryBytes: this.memory.buffer.byteLength };
      case 'read': return encodeBytes(this.range(p.offset, p.count));
      case 'write': { const bytes = decodeBytes(p.bytes, this.limits.maximumTransferBytes); this.range(p.offset, bytes.length).set(bytes); return null; }
      case 'fex.open': return this.openFEX();
      case 'fex.call': return this.callFEX(p);
      default: throw new Fault('unknownOperation', 'Unknown execution operation.');
    }
  }
  async load(p) {
    requireThat(!this.fex, 'invalidState', 'Use separate sessions for Wasm and FEX.');
    const id = name(p.module);
    requireThat(!this.modules.has(id), 'duplicateModule', 'Module identifier is already loaded.');
    requireThat(this.modules.size < this.limits.maximumModules, 'moduleLimit', 'Module count limit reached.');
    const bytes = decodeBytes(p.bytes, this.limits.maximumModuleBytes);
    const metadata = inspectModule(bytes, this.limits);
    requireThat(bytes.length <= this.limits.maximumResidentModuleBytes - this.metrics.residentModuleBytes,
      'codeBudget', 'Loaded module byte budget exhausted.');
    requireThat(metadata.tableElements <= this.limits.maximumTableElements - this.metrics.reservedTableElements,
      'tableLimit', 'Aggregate table budget exhausted.');
    const module = await this.compile(bytes), imports = WebAssembly.Module.imports(module);
    const functions = { memory: this.memory };
    if (imports.some(i => i.name === 'call')) {
      requireThat(capabilities().jspi, 'unsupported', 'Native calls require JSPI on this engine.');
      functions.call = new WebAssembly.Suspending(async (service, offset, count, reply, capacity) => {
        const key = 'host.' + (service >>> 0);
        requireThat(this.services.has(key), 'serviceDenied', 'The application did not register this service.');
        const payload = encodeBytes(this.range(offset >>> 0, count >>> 0)); this.range(reply >>> 0, capacity >>> 0);
        this.metrics.nativeCalls++; this.metrics.nativeRequestBytes += count >>> 0;
        const result = decodeBytes(await this.hostCall(key, payload), this.limits.maximumTransferBytes);
        this.assertOpen();
        requireThat(result.length <= (capacity >>> 0), 'bounds', 'Native response does not fit the guest buffer.');
        this.range(reply >>> 0, result.length).set(result); this.metrics.nativeResponseBytes += result.length;
        return result.length;
      });
    }
    const instance = await WebAssembly.instantiate(module, { betterjit: functions }); this.assertOpen();
    this.modules.set(id, { instance, ...metadata, bytes: bytes.length });
    this.metrics.residentModuleBytes += bytes.length; this.metrics.reservedTableElements += metadata.tableElements;
    return WebAssembly.Module.exports(module).map(x => ({ name: x.name, kind: x.kind }));
  }
  prepareCall(p) {
    const entry = this.modules.get(name(p?.module)), symbol = name(p?.export), signature = entry?.functions.get(symbol);
    requireThat(signature, 'unknownExport', 'Function is not exported by this module.');
    requireThat(Array.isArray(p.arguments) && p.arguments.length <= 64 && Array.isArray(p.results) && p.results.length <= 16 &&
      p.arguments.map(a => a?.type).join(',') === signature.parameters.join(',') &&
      p.results.join(',') === signature.results.join(','), 'signature', 'Argument/result types must match the Wasm export exactly.');
    return { fn: entry.instance.exports[symbol], args: p.arguments.map(inputValue), results: p.results };
  }
  async invoke(call) {
    this.assertOpen(); const t = performance.now(); this.metrics.invocations++;
    try {
      const fn = capabilities().jspi ? WebAssembly.promising(call.fn) : call.fn;
      const result = await fn(...call.args); this.assertOpen();
      const values = result === undefined ? [] : Array.isArray(result) ? result : [result];
      requireThat(values.length === call.results.length, 'signature', 'Result count does not match.');
      return values.map((v,i) => outputValue(v, call.results[i]));
    } finally { this.metrics.invokeMilliseconds += performance.now() - t; }
  }
  async openFEX() {
    requireThat(!this.fex && this.modules.size === 0, 'invalidState', 'FEX needs a fresh dedicated session.');
    requireThat(this.services.has('fex'), 'serviceDenied', 'Install a FEX translation service first.');
    requireThat(capabilities().jspi, 'unsupported', 'Live FEX execution requires JSPI.');
    const request = async (method, data = {}) => { const result = await this.hostCall('fex', { method, ...data }); this.assertOpen(); return result; };
    const cfg = await request('config');
    requireThat(cfg && integer(cfg.memPages, 1, this.limits.maximumMemoryPages) && cfg.shared === false,
      'unsupported', 'FEX v1 requires an unshared memory within the configured budget.');
    const memoryBytes = cfg.memPages * 65536;
    const area = (base, count, stride) => integer(base, 0, memoryBytes) && integer(count, 0, memoryBytes) && count <= Math.floor((memoryBytes - base) / stride);
    requireThat(this.limits.maximumTableElements >= 256 && integer(cfg.dispatchBits, 1, 20) &&
      area(cfg.dispatchBase, 2 ** cfg.dispatchBits, 64) && area(cfg.slotTagBase, cfg.slotTagCount, 4) &&
      integer(cfg.hotAddr, 0, memoryBytes - 4) && integer(cfg.hotThreshold, 0, 0x7fffffff),
      'invalidBackend', 'FEX dispatcher layout exceeds guest memory.');
    for (const [base, bits, fallbackBase, fallbackBits, stride] of [
      ['callSiteBase','callSiteBits',0x120000,12,32], ['unitCounterBase','unitCounterBits',0,14,4]]) {
      const b = cfg[base] ?? fallbackBase, n = cfg[bits] ?? fallbackBits;
      requireThat(integer(n, 1, 20) && area(b, b ? 2 ** n : 0, stride), 'invalidBackend', 'Invalid FEX profiling layout.');
    }
    for (const k of ['ctx','stateSize','imageLow','stackTop','halt','gregsOff'])
      requireThat(integer(cfg[k], 0, memoryBytes), 'invalidBackend', 'Invalid FEX memory layout.');
    requireThat(integer(cfg.windowHi, 0, 0xffffffff) && ['sysv','win64'].includes(cfg.guestAbi) && cfg.threadBase === -1 &&
      cfg.stackTop >= 0x100 && cfg.ctx + cfg.stateSize <= memoryBytes && cfg.gregsOff + 16 * 8 <= cfg.stateSize,
      'invalidBackend', 'Unsupported FEX address window or ABI.');
    const image = decodeBytes(await request('image'), this.limits.maximumModuleBytes);
    const state = decodeBytes(await request('state'), this.limits.maximumModuleBytes);
    const dispatcher = decodeBytes(await request('dispatcher'), this.limits.maximumModuleBytes);
    requireThat(image.length <= memoryBytes - cfg.imageLow && state.length === cfg.stateSize,
      'invalidBackend', 'Invalid image or CPU state size.');
    await import('./fex-runtime.js'); this.assertOpen();
    let memory;
    try { memory = new WebAssembly.Memory({ initial: cfg.memPages, maximum: this.limits.maximumMemoryPages }); }
    catch { throw new Fault('allocationFailed', 'FEX guest memory allocation failed.'); }
    new Uint8Array(memory.buffer).set(image, cfg.imageLow);
    const unit = async rip => {
      const data = decodeBytes(await request('unit', { rip: rip >>> 0 }), this.limits.maximumModuleBytes + 4);
      if (data.length === 0) return null;
      requireThat(data.length >= 12, 'invalidBackend', 'Truncated FEX unit.');
      const slot = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
      requireThat(slot > 0 && slot < this.limits.maximumTableElements, 'invalidBackend', 'FEX table slot out of range.');
      return { module: await this.compile(data.subarray(4)), bytes: data.length - 4, slot };
    };
    const region = async (rips, profile) => {
      const words = [rips.length, ...rips, rips.length];
      for (const r of rips) { const s = profile.successors(r); words.push(r, s.length, ...s); }
      const sites = profile.callSites(); words.push(sites.length);
      for (const [ret, targets] of sites) words.push(ret, targets.length, ...targets);
      requireThat(words.length <= Math.floor(this.limits.maximumTransferBytes / 4), 'messageTooLarge', 'FEX profile too large.');
      const bytes = new Uint8Array(words.length * 4), view = new DataView(bytes.buffer);
      words.forEach((word,i) => view.setUint32(i * 4, word, true));
      const data = decodeBytes(await request('region', { profile: encodeBytes(bytes) }), this.limits.maximumModuleBytes);
      return data.length ? { module: await this.compile(data), bytes: data.length } : null;
    };
    // Charge the dispatcher's compile separately; createRuntime does its compilation synchronously.
    requireThat(dispatcher.length <= this.limits.maximumCumulativeModuleBytes - this.metrics.cumulativeModuleBytes,
      'codeBudget', 'FEX dispatcher exceeds the compile budget.');
    this.metrics.cumulativeModuleBytes += dispatcher.length;
    const runtime = globalThis.FexRuntime.createRuntime({ ...cfg, threadBase: undefined, mem: memory,
      now: () => performance.now(), dispatcher, translateAsync: unit, translateRegionAsync: region,
      syscall: () => { throw new Fault('unsupportedSyscall', 'No guest operating-system adapter is installed.'); },
      codeBudget: this.limits.maximumResidentModuleBytes, maximumTableElements: this.limits.maximumTableElements });
    this.memory = memory; this.fex = { cfg, state, runtime, imageBytes: image.length };
    return { guestABI: cfg.guestAbi, memoryPages: cfg.memPages };
  }
  async callFEX(p) {
    requireThat(this.fex && integer(p?.entry, 0, 0xffffffff), 'invalidCall', 'Invalid FEX entry.');
    const args = p.arguments ?? [p.argument];
    requireThat(!(p.arguments !== undefined && p.argument !== undefined) && Array.isArray(args) && args.length <= 16 &&
      args.every(a => typeof a === 'string' && a.length <= 20 && a.trim() === a && /^(0|[1-9][0-9]*)$/.test(a)), 'invalidCall', 'Expected at most 16 u64 arguments.');
    const values = args.map(BigInt); requireThat(values.every(a => a < (1n << 64n)), 'invalidCall', 'Guest argument exceeds u64.');
    const { cfg, state, runtime, imageBytes } = this.fex, win = cfg.guestAbi === 'win64';
    const registers = win ? [1,2,8,9] : [7,6,2,1,8,9], shadow = win ? 32 : 0;
    const extra = Math.max(0, values.length - registers.length), needed = 8 + shadow + extra * 8;
    const ret = Math.floor((cfg.stackTop - needed - 8) / 16) * 16 + 8;
    const overlaps = (start, length) => ret < start + length && start < cfg.stackTop;
    requireThat(ret >= 0 && !overlaps(cfg.ctx, cfg.stateSize) && !overlaps(cfg.imageLow, imageBytes), 'invalidBackend', 'FEX call stack overlaps guest state or image.');
    const u8 = new Uint8Array(this.memory.buffer), dv = new DataView(u8.buffer);
    const G = cfg.ctx + cfg.gregsOff, W = BigInt(cfg.windowHi) << 32n;
    u8.set(state, cfg.ctx); u8.fill(0, ret, cfg.stackTop);
    values.forEach((value,i) => dv.setBigUint64(i < registers.length ? G + registers[i] * 8 : ret + 8 + shadow + (i - registers.length) * 8, value, true));
    dv.setBigUint64(ret, W + BigInt(cfg.halt), true); dv.setBigUint64(G + 4 * 8, W + BigInt(ret), true);
    const t = performance.now(); this.metrics.invocations++;
    try { await runtime.runAsync(p.entry, cfg.halt); this.assertOpen(); return new DataView(this.memory.buffer).getBigUint64(G, true).toString(); }
    catch (error) { this.close(); throw new Fault('fexExecution', 'FEX execution stopped: ' + (error.code || 'backendFailure')); }
    finally { this.metrics.invokeMilliseconds += performance.now() - t; }
  }
  close() { this.closed = true; this.modules.clear(); this.fex = null; this.memory = null; }
}
