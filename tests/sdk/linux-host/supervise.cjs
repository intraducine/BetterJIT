// SPDX-License-Identifier: GPL-3.0-or-later
const path=require('path'),{fork}=require('child_process');
function runIsolatedGuest(spec,{entry=path.join(__dirname,'case.cjs'),graceSeconds=5}={}) {
 return new Promise((resolve,reject)=>{
  const child=fork(entry,[],{detached:true,serialization:'advanced',stdio:['ignore','ignore','pipe','ipc']});
  let last={},errors='',finished=false;
  const timeout=(spec.timeout??90)+graceSeconds;
  function finish(error,result) {
   if(finished)return;finished=true;clearTimeout(timer);
   // Kill only this owned session's process group, even if a worker, native
   // compiler or teardown is stuck. An in-process JS timer alone cannot bound it.
   try { process.kill(-child.pid,'SIGKILL'); } catch(e) { if(e.code!=='ESRCH')error??=e; }
   if(error){Object.assign(error,last);reject(error);}else resolve(result);
  }
  const timer=setTimeout(()=>finish(Error(`Guest supervisor deadline ${timeout}s exceeded; owned process group terminated.\n${errors.slice(-2048)}`)),timeout*1000);
  child.stderr.on('data',bytes=>errors=(errors+bytes).slice(-8192));
  child.on('error',error=>finish(error));
  child.on('exit',(code,signal)=>finish(Error(`Guest runner exited before a result: ${code??signal}\n${errors}`)));
  child.on('message',message=>{
   if(message.progress)last=message.progress;
   else if(message.error){last={...last,...message.error};finish(Error(message.error.message));}
   else if(message.result)finish(null,message.result);
  });
  child.send(spec);
 });
}
module.exports={runIsolatedGuest};
