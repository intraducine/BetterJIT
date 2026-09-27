// SPDX-License-Identifier: GPL-3.0-or-later
const session = location.hash.slice(1);
const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
let stopped = false;
const emit = message => { if (!stopped) window.webkit.messageHandlers.betterjit.postMessage({ ...message, session }); };
worker.onmessage = ({ data }) => emit(data);
worker.onerror = () => emit({ v: 1, id: '', kind: 'fatal', payload: null,
  error: { code: 'worker', message: 'The execution worker failed.' } });
window.BetterJIT = Object.freeze({
  receive(text) { const m = JSON.parse(text); if (!stopped && m.v === 1 && m.session === session) worker.postMessage(m); },
  stop() { if (stopped) return; stopped = true; worker.terminate(); worker.onmessage = worker.onerror = null; }
});
window.addEventListener('pagehide', () => window.BetterJIT.stop(), { once: true });
