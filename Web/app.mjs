const output = document.querySelector('pre');
const runButton = document.querySelector('#run');
let busy = false;
const handler = window.webkit?.messageHandlers?.betterjit;
async function callNative(body) {
  if (!handler) throw new Error('Native bridge unavailable');
  return handler.postMessage(body);
}
function render(record) { output.textContent += `${JSON.stringify(record)}\n`; }

async function run({large = false} = {}) {
  if (busy) throw new Error('A probe is already running');
  busy = true;
  runButton.disabled = true;
  output.textContent = '';
  const report = {schema: 1, date: new Date().toISOString(), records: []};
  let worker;
  try {
    const config = handler ? await callNative({command: 'configuration'})
      : {...await (await fetch('./fixtures.json')).json(), session: crypto.randomUUID(), nativeHost: false};
    report.session = config.session;
    worker = new Worker('./worker.mjs', {type: 'module'});
    await new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error('Worker watchdog: no completed suite after 90 seconds')), 90000);
      worker.onerror = event => { clearTimeout(watchdog); reject(new Error(event.message)); };
      worker.onmessage = async event => {
        const message = event.data;
        if (message.type === 'record') {
          report.records.push(message.record);
          render(message.record);
        } else if (message.type === 'native') {
          try { worker.postMessage({type: 'reply', id: message.id, result: await callNative(message.body)}); }
          catch (error) { worker.postMessage({type: 'reply', id: message.id, error: String(error)}); }
        } else if (message.type === 'done') { clearTimeout(watchdog); resolve(); }
      };
      worker.postMessage({type: 'start', config, large});
    });
  } catch (error) {
    const record = {stage: 'host', status: 'FAIL', error: String(error)};
    report.records.push(record);
    render(record);
  } finally {
    // A watchdog abort deliberately leaves its backing file for diagnosis.
    worker?.terminate();
    report.passed = !report.records.some(record => record.status === 'FAIL');
    report.nativeTransportVerified = report.records.some(record => record.stage === 'opfs-native-mmap' && record.status === 'PASS');
    window.betterjit.lastReport = report;
    if (handler) {
      try { await callNative({command: 'report', report}); }
      catch (error) { render({stage: 'save-report', status: 'FAIL', error: String(error)}); }
    }
    busy = false;
    runButton.disabled = false;
  }
  return report;
}
window.betterjit = {run, lastReport: null};
runButton.addEventListener('click', () => run({large: document.querySelector('#large').checked}));
document.querySelector('#export').addEventListener('click', async () => {
  if (!window.betterjit.lastReport) return;
  // iOS exposes a native Share button; standalone browser use gets a JSON file.
  if (handler) { render({stage: 'export', status: 'INFO', message: 'Use Share report in the native toolbar'}); return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(window.betterjit.lastReport, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'betterjit-report.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
