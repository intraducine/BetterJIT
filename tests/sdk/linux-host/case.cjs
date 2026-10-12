// SPDX-License-Identifier: GPL-3.0-or-later
// Each live guest owns a separate OS process group, including its translator.
const {runGuest}=require('./run.cjs');
process.once('message',async spec=>{
 try {
  const result=await runGuest({...spec,onProgress:progress=>process.send({progress})});
  process.send({result},()=>process.exit(0));
 } catch(error) {
  process.send({error:{message:String(error.stack||error),stdout:error.stdout,stderr:error.stderr,
    translationLog:error.translationLog,translatorStatus:error.translatorStatus,causeDetail:error.causeDetail}},()=>process.exit(0));
 }
});
