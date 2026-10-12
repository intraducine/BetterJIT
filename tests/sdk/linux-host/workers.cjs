// SPDX-License-Identifier: GPL-3.0-or-later
class GuestWorkers {
 constructor(){this.current=new Map();this.owned=new Set();}
 add(tid,worker,release){
  this.current.set(tid,worker);this.owned.add(worker);
  worker.on('exit',()=>{
   release();
   // exec reuses the TID; an old exit must not forget its replacement.
   if(this.current.get(tid)===worker)this.current.delete(tid);
   this.owned.delete(worker);
  });
 }
 get(tid){return this.current.get(tid);}
 kill(tid){const worker=this.current.get(tid);this.current.delete(tid);worker?.terminate();}
 async close(){await Promise.all([...this.owned].map(worker=>worker.terminate()));}
}
module.exports={GuestWorkers};
