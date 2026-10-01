// SPDX-License-Identifier: GPL-3.0-or-later
const session = location.hash.slice(1);
const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
let stopped = false, shutdownTimer = null;
const emit = message => { if (!stopped) window.webkit.messageHandlers.betterjit.postMessage({ ...message, session }); };
const finishWorker = () => {
  if (shutdownTimer !== null) { clearTimeout(shutdownTimer); shutdownTimer = null; }
  worker.terminate(); worker.onmessage = worker.onerror = null;
};
worker.onmessage = ({ data }) => {
  if (data?.kind === 'shutdownAck') { finishWorker(); return; }
  emit(data);
};
worker.onerror = () => emit({ v: 1, id: '', kind: 'fatal', payload: null,
  error: { code: 'worker', message: 'The execution worker failed.' } });
window.BetterJIT = Object.freeze({
  receive(text) { const m = JSON.parse(text); if (!stopped && m.v === 1 && m.session === session) worker.postMessage(m); },
  stop() {
    if (stopped) return;
    stopped = true;
    try { worker.postMessage({ v: 1, session, id: 'shutdown', kind: 'shutdown', payload: null }); }
    catch { finishWorker(); return; }
    // Give the worker a bounded window to close/remove its OPFS lane. Native
    // still owns the mapped fd until WebKitTransport tears down afterward.
    shutdownTimer = setTimeout(finishWorker, 150);
  }
});
window.addEventListener('pagehide', () => window.BetterJIT.stop(), { once: true });
