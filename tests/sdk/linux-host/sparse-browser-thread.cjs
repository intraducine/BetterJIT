// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the production browser worker with real Node workers. Parent port stays
// open after guest completion: quiescence must not pretend physical retirement.
const {parentPort,workerData:d}=require('worker_threads'),fs=require('fs'),path=require('path'),vm=require('vm');
const base=path.join(d.resources,'linux/web');globalThis.self=globalThis;globalThis.onmessage=null;
globalThis.importScripts=(...names)=>{for(const name of names)vm.runInThisContext(fs.readFileSync(path.resolve(base,name),'utf8'));};
globalThis.postMessage=m=>parentPort.postMessage(m);parentPort.on('message',data=>globalThis.onmessage?.({data}));
vm.runInThisContext(fs.readFileSync(path.join(base,'sparse_thread.js'),'utf8'));
