// SPDX-License-Identifier: GPL-3.0-or-later
import { Engine, capabilities, Fault } from './engine.mjs';
let session = null, queued = 0, queuedBytes = 0, tail = Promise.resolve(), nextService = 0;
const pending = new Map(), activeIDs = new Set();
const sizeOf = value => new TextEncoder().encode(JSON.stringify(value)).length;
const engine = new Engine({ hostCall: (operation, payload) => new Promise((resolve, reject) => {
  if (pending.size >= engine.limits.maximumPendingRequests) { reject(new Fault('backpressure', 'Too many native calls.')); return; }
  const id = 'service-' + (++nextService);
  const deadline = setTimeout(() => { pending.delete(id); reject(new Fault('timeout', 'Native service timed out.')); }, engine.limits.timeoutSeconds * 1000);
  pending.set(id, { resolve, reject, deadline });
  postMessage({ v: 1, session, id, kind: 'service', operation, payload });
}) });
self.onmessage = ({ data: m }) => {
  if (!m || m.v !== 1 || typeof m.session !== 'string' || m.session.length > 128 || typeof m.id !== 'string' || m.id.length > 128) return;
  if (session === null && m.kind === 'request' && m.operation === 'configure') session = m.session;
  if (m.session !== session) return;
  if (m.kind === 'serviceResponse') {
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.deadline);
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
      const result = await engine.command(m.operation, m.payload ?? {});
      // Snapshot only after the serialized command completes. Ordinary statistics
      // stay unchanged; this is additive WebKit-worker diagnostic information.
      if (m.operation === 'configure') result.extensions = [...result.extensions, 'fex.runtimeStatistics'];
      if (m.operation === 'statistics' && engine.fex) {
        const s = engine.fex.runtime.stats;
        result.fex = { schema: 1, units: s.units, regions: s.regions,
          regionUnits: s.regionUnits, flushes: s.flushes };
      }
      respond(result, null);
    }
    catch (e) { if (e.code === 'timeout') engine.close(); respond(null, { code: e.code || 'execution', message: e instanceof Fault ? e.message.slice(0,1024) : 'Guest execution failed.' }); }
    finally { queued--; queuedBytes -= size; activeIDs.delete(m.id); }
  });
};
postMessage({ v: 1, id: '', kind: 'ready', payload: capabilities() });
