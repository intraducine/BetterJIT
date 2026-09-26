// SPDX-License-Identifier: GPL-3.0-or-later
const session = location.hash.slice(1);
const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
const emit = message => window.webkit.messageHandlers.betterjit.postMessage({ ...message, session });
worker.onmessage = ({ data }) => emit(data);
worker.onerror = event => emit({ v: 1, id: '', kind: 'fatal', payload: null,
  error: { code: 'worker', message: String(event.message).slice(0, 1024) } });
window.BetterJIT = Object.freeze({
  receive(text) { const m = JSON.parse(text); if (m.v === 1 && m.session === session) worker.postMessage(m); },
  stop() { worker.terminate(); }
});
