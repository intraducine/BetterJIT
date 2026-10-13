// SPDX-License-Identifier: GPL-3.0-or-later
const path=require('path'),{fork}=require('child_process');
function runIsolatedGuest(spec,{entry=path.join(__dirname,'case.cjs'),graceSeconds=5}={}) {
 return new Promise((resolve,reject)=>{
  const child=fork(entry,[],{detached:true,serialization:'advanced',stdio:['ignore','ignore','pipe','ipc']});
  let last={},errors='',finished=false;
  const timeout=(spec.timeout??90)+graceSeconds;
  function finish(error,result,force=false) {
   if(finished)return;finished=true;clearTimeout(timer);
   if(force) {
    // A deadline or unexpected exit must stop the whole owned session.
    // Normal results have already awaited teardown. Killing their vanished
    // group races process exit on Darwin (EPERM) and must not replace a result.
    try { process.kill(-child.pid,'SIGKILL'); }
    catch(e) { if(e.code!=='ESRCH') { child.kill('SIGKILL'); error.cleanupError=String(e); } }
   }
   if(error){Object.assign(error,last);reject(error);}else resolve(result);
  }
  const timer=setTimeout(()=>finish(Error(`Guest supervisor deadline ${timeout}s exceeded; terminating owned process group.\n${errors.slice(-2048)}`),null,true),timeout*1000);
  child.stderr.on('data',bytes=>errors=(errors+bytes).slice(-8192));
  child.on('error',error=>finish(error));
  child.on('exit',(code,signal)=>finish(Error(`Guest runner exited before a result: ${code??signal}\n${errors}`),null,true));
  child.on('message',message=>{
   if(message.progress)last=message.progress;
   else if(message.error){last={...last,...message.error};finish(Error(message.error.message));}
   else if(message.result)finish(null,message.result);
  });
  child.send(spec);
 });
}
module.exports={runIsolatedGuest};
