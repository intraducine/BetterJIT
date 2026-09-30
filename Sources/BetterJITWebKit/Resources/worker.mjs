// SPDX-License-Identifier: GPL-3.0-or-later
import { Engine, capabilities, Fault } from './engine.mjs';
import { MappedLane, encodeCopiedBinaryPayload, decodeCopiedBinaryResponse } from './mapped-lane.mjs';
import { runDiagnostic } from './diagnostics.mjs';

let session = null, queued = 0, queuedBytes = 0, tail = Promise.resolve(), nextService = 0;
const pending = new Map(), activeIDs = new Set();
const sizeOf = value => new TextEncoder().encode(JSON.stringify(value)).length;
let mappedLane = null, mappedActive = false, binaryServices = new Set();

const mappedFault = () => new Fault('mappedTransport', 'Mapped data transport failed validation.');

function hostCall(operation, payload) {
  return new Promise((resolve, reject) => {
    if (pending.size >= engine.limits.maximumPendingRequests) { reject(new Fault('backpressure', 'Too many native calls.')); return; }
    let wirePayload = payload, lease = null;
    const binary = binaryServices.has(operation);
    try {
      if (binary) {
        const encoded = mappedActive && mappedLane
          ? mappedLane.encodeBinaryRequest(payload)
          : encodeCopiedBinaryPayload(payload);
        wirePayload = encoded.payload; lease = encoded.lease;
      } else if (mappedActive && mappedLane) {
        const encoded = mappedLane.encodeRequest(payload);
        wirePayload = encoded.payload; lease = encoded.lease;
      }
    } catch { reject(mappedFault()); return; }
    const id = 'service-' + (++nextService);
    let finished = false;
    const release = () => { if (lease && mappedLane) mappedLane.release(lease); };
    const finish = (fn, value) => {
      if (finished) return;
      finished = true; pending.delete(id); clearTimeout(deadline);
      try {
        if (fn === resolve) {
          if (binary) value = mappedActive && mappedLane
            ? mappedLane.decodeBinaryResponse(value, lease)
            : decodeCopiedBinaryResponse(value);
          else if (mappedActive && mappedLane) value = mappedLane.decodeResponse(value, lease);
        }
        fn(value);
      } catch { reject(mappedFault()); }
      finally { release(); }
    };
    const deadline = setTimeout(() => finish(reject, new Fault('timeout', 'Native service timed out.')), engine.limits.timeoutSeconds * 1000);
    pending.set(id, {
      resolve: value => finish(resolve, value),
      reject: error => finish(reject, error),
      deadline,
    });
    try { postMessage({ v: 1, session, id, kind: 'service', operation, payload: wirePayload }); }
    catch { finish(reject, new Fault('transport', 'Native service message could not be sent.')); }
  });
}

const engine = new Engine({ hostCall });

async function configureMapped(request, result) {
  const mode = request?.mappedTransport?.mode;
  if (mode !== 'preferred' && mode !== 'required') return;
  const threshold = request?.mappedTransport?.thresholdBytes;
  try {
    mappedLane = await MappedLane.create(session, threshold);
    result.mappedTransport = mappedLane.candidate();
  } catch (error) {
    mappedLane = null; mappedActive = false;
    const message = error instanceof Error && typeof error.message === 'string'
      ? error.message.slice(0, 192)
      : 'OPFS setup failed.';
    result.mappedTransport = { candidate: 0, version: 1, reason: message };
  }
}

async function confirmMapped(payload) {
  const requested = payload?.active === 1;
  if (requested && mappedLane) {
    mappedActive = true;
    return { active: 1, version: 1 };
  }
  mappedActive = false;
  if (mappedLane) { await mappedLane.close(true); mappedLane = null; }
  return { active: 0, version: 1 };
}

self.onmessage = async ({ data: m }) => {
  if (!m || m.v !== 1 || typeof m.session !== 'string' || m.session.length > 128 || typeof m.id !== 'string' || m.id.length > 128) return;
  if (session === null && m.kind === 'request' && m.operation === 'configure') session = m.session;
  if (m.session !== session) return;
  if (m.kind === 'shutdown') {
    const lane = mappedLane; mappedLane = null; mappedActive = false;
    try { if (lane) await lane.close(true); } catch {}
    engine.close();
    postMessage({ v: 1, session, id: m.id, kind: 'shutdownAck', payload: null });
    self.close();
    return;
  }
  if (m.kind === 'serviceResponse') {
    const p = pending.get(m.id); if (!p) return;
    if (m.error) p.reject(new Fault(m.error.code, m.error.message)); else p.resolve(m.payload);
    return;
  }
  if (m.kind !== 'request') return;
  const respond = (payload, error) => postMessage({ v: 1, session, id: m.id, kind: 'response', payload, error });
  let size;
  try { size = sizeOf(m); } catch { respond(null, { code: 'protocolValue', message: 'Message is not JSON.' }); return; }
  const budget = engine.limits?.maximumPendingBytes ?? 65536;
  if (activeIDs.has(m.id)) {
    engine.close();
    postMessage({ v: 1, session, id: '', kind: 'fatal', payload: null, error: { code: 'protocolValue', message: 'Duplicate in-flight request ID.' } });
    return;
  }
  if (queued >= (engine.limits?.maximumPendingRequests ?? 1) || size > budget - queuedBytes) {
    respond(null, { code: 'backpressure', message: 'Worker command count/byte budget reached.' }); return;
  }
  queued++; queuedBytes += size; activeIDs.add(m.id);
  // Service replies bypass this queue; otherwise JSPI suspensions deadlock it.
  tail = tail.then(async () => {
    try {
      let result;
      if (m.operation === 'mapped.confirm') result = await confirmMapped(m.payload ?? {});
      else if (m.operation === 'diagnostic.run') {
        try {
          result = await runDiagnostic(m.payload?.name, m.payload?.args ?? {}, { hostCall, mappedActive });
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0,512) : 'Diagnostic execution failed.';
          throw new Fault('diagnostic', message);
        }
      } else {
        result = await engine.command(m.operation, m.payload ?? {});
        if (m.operation === 'configure') {
          const names = m.payload?.binaryServices ?? [];
          if (!Array.isArray(names) || names.length > 128 ||
              names.some(name => typeof name !== 'string' || !m.payload.services?.includes(name))) {
            throw new Fault('invalidConfiguration', 'Invalid binary service allowlist.');
          }
          binaryServices = new Set(names);
          result.extensions = [...result.extensions, 'fex.runtimeStatistics', 'diagnostics.v1', 'binaryServices.v1'];
          if (Array.isArray(m.payload?.services) && m.payload.services.includes('fex')) {
            result.extensions.push('fex.linuxSyscallSubset');
          }
          await configureMapped(m.payload ?? {}, result);
        }
        // Snapshot only after the serialized command completes. Ordinary statistics
        // stay unchanged; this is additive WebKit-worker diagnostic information.
        if (m.operation === 'statistics' && engine.fex) {
          const s = engine.fex.runtime.stats;
          result.fex = { schema: 1, units: s.units, regions: s.regions,
            regionUnits: s.regionUnits, flushes: s.flushes };
        }
        if (m.operation === 'statistics' && mappedLane) result.mappedTransport = mappedLane.statistics();
      }
      respond(result, null);
    }
    catch (e) { if (e.code === 'timeout') engine.close(); respond(null, { code: e.code || 'execution', message: e instanceof Fault ? e.message.slice(0,1024) : 'Guest execution failed.' }); }
    finally { queued--; queuedBytes -= size; activeIDs.delete(m.id); }
  });
};
postMessage({ v: 1, id: '', kind: 'ready', payload: capabilities() });
