// SPDX-License-Identifier: GPL-3.0-or-later
import { Engine, capabilities, Fault } from './engine.mjs';
let session = null, queued = 0, tail = Promise.resolve(), nextService = 0;
const pending = new Map();
const engine = new Engine({ hostCall: (operation, payload) => new Promise((resolve, reject) => {
  const id = 'service-' + (++nextService);
  pending.set(id, { resolve, reject });
  postMessage({ v: 1, session, id, kind: 'service', operation, payload });
}) });
self.onmessage = ({ data: m }) => {
  if (!m || m.v !== 1 || typeof m.session !== 'string' || typeof m.id !== 'string') return;
  if (session === null && m.kind === 'request' && m.operation === 'configure') session = m.session;
  if (m.session !== session) return;
  if (m.kind === 'serviceResponse') {
    const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(new Fault(m.error.code, m.error.message)); else p.resolve(m.payload);
    return;
  }
  if (m.kind !== 'request') return;
  const respond = (payload, error) => postMessage({ v: 1, session, id: m.id, kind: 'response', payload, error });
  if (queued >= (engine.limits?.maximumPendingRequests ?? 1)) {
    respond(null, { code: 'backpressure', message: 'Worker command queue is full.' }); return;
  }
  queued++;
  // Native replies bypass this queue, while guest calls and memory edits serialize.
  tail = tail.then(async () => {
    try { respond(await engine.command(m.operation, m.payload ?? {}), null); }
    catch (e) { respond(null, { code: e.code || 'execution', message: String(e.message || e).slice(0, 1024) }); }
    finally { queued--; }
  });
};
postMessage({ v: 1, id: '', kind: 'ready', payload: capabilities() });
