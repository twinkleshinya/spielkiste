import {AsyncLocalStorage} from 'node:async_hooks';

const context=new AsyncLocalStorage<TaskControl>();
export class TaskCancelledError extends Error {constructor(){super('本次任务已终止，原版本保持不变');}}
/** Cooperative pause at a safe boundary; cancellation aborts current model/media I/O. */
export class TaskControl {
 readonly controller=new AbortController();
 paused=false;waiting=false;
 private wake?:()=>void;
 constructor(private onState:(state:'pausing'|'paused'|'running'|'cancelled')=>Promise<void>){}
 async pause(){this.controller.signal.throwIfAborted();if(this.paused)return;this.paused=true;await this.onState('pausing');}
 async resume(){this.controller.signal.throwIfAborted();if(!this.paused)return;this.paused=false;await this.onState('running');this.wake?.();}
 async terminate(){this.paused=false;this.controller.abort(new TaskCancelledError());this.wake?.();}
 async checkpoint(){
  this.controller.signal.throwIfAborted();
  while(this.paused){
   // Install the waiter before yielding to disk I/O, so resume cannot be lost.
   const wake=new Promise<void>(resolve=>{this.wake=resolve;});this.waiting=true;
   await this.onState('paused');
   if(this.paused&&!this.controller.signal.aborted)await wake;
   this.waiting=false;this.wake=undefined;this.controller.signal.throwIfAborted();
  }
 }
 run<T>(work:()=>Promise<T>){return context.run(this,work);}
}
export async function taskCheckpoint(){await context.getStore()?.checkpoint();}
export function taskSignal(signal?:AbortSignal){const current=context.getStore()?.controller.signal;return current&&signal?AbortSignal.any([signal,current]):current||signal;}
