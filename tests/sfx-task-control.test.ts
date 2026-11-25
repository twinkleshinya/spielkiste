import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {creativeContext} from '../src/sfx/CreativeBrief.js';
import {SfxService} from '../src/sfx/SfxService.js';
import {usagePhase,modelJson} from '../src/sfx/ModelUsage.js';
import {editorHarness} from './sfx-edit-preview-ui.test.js';
import {handleSfxRequest} from '../src/ui/sfx-routes.js';
import {modelGatewayError} from '../src/sfx/ModelGatewayError.js';
import {taskCheckpoint,TaskControl} from '../src/sfx/TaskControl.js';
import {runFfmpeg} from '../src/sfx/FfmpegBinaries.js';

export function testCreativeContextNeverSerializesProject(){
 const context=creativeContext({style:'暗黑奇幻',soundRequirements:'吼叫点加风声',assets:[{path:'private-library.wav',data:'x'.repeat(1000000)}],events:[{secret:'private-event'}],workflow:{private:'private-workflow'},signal:{},progress:()=>{}} as any);
 assert.ok(context.length<10000,'creative context contains only explicit brief fields, never a whole project/library');
 assert.doesNotMatch(context,/private-library|private-event|private-workflow/);
 assert.match(context,/吼叫点加风声/);
 const message=modelGatewayError('Gemini',{error:{code:'context_length_exceeded',message:'Bearer secret-fixture'}},400).message;
 assert.match(message,/上下文容量/);assert.doesNotMatch(message,/secret-fixture/);
 assert.match(modelGatewayError('Gemini',{},401).message,/授权/);
}
export async function testTaskPauseResumeAndTerminate(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-controls-'));const service=new SfxService(root);
 let finishFirst!:()=>void,entered!:()=>void,second=0;
 const first=new Promise<void>(r=>finishFirst=r),started=new Promise<void>(r=>entered=r);
 const run=await service.store.createRun({videoPath:'v.mp4',libraryPath:root});
 try{
  (service as any).launch(run,async()=>{await usagePhase('first',async()=>{entered();await first;});await usagePhase('second',async()=>{second++;});run.status='ready';await service.store.save(run);});
  await started;
  assert.equal(typeof (service as any).controlTask,'function','service exposes real task controls');
  await (service as any).controlTask(run.id,'pause');finishFirst();
  for(let n=0;n<100&&String((await service.status(run.id)).status)!=='paused';n++)await new Promise(r=>setTimeout(r,5));
  assert.equal((await service.status(run.id)).status,'paused');assert.equal(second,0,'no subsequent phase starts while stopped');
  assert.equal((await service.store.readRun(run.id)).status,'paused','pause is saved to disk');
  await (service as any).controlTask(run.id,'resume');
  assert.equal((await service.waitForIdle(run.id)).status,'ready');assert.equal(second,1);
  const finalizing=await service.store.createRun({videoPath:'v.mp4',libraryPath:root});
  let finalStarted!:()=>void,finishFinal!:()=>void;
  const finalStep=new Promise<void>(r=>finishFinal=r),atFinal=new Promise<void>(r=>finalStarted=r);
  (service as any).launch(finalizing,async()=>{finalizing.status='ready';finalizing.progress='保存版本';finalStarted();await finalStep;await taskCheckpoint();await service.store.save(finalizing);});
  await atFinal;await service.controlTask(finalizing.id,'pause');finishFinal();
  for(let n=0;n<100&&(await service.status(finalizing.id)).status!=='paused';n++)await new Promise(r=>setTimeout(r,5));
  await service.controlTask(finalizing.id,'resume');assert.equal((await service.waitForIdle(finalizing.id)).status,'ready','pause during final save must restore ready state');
  const mediaControl=new TaskControl(async()=>{});
  const media=mediaControl.run(()=>runFfmpeg(['-v','error','-re','-f','lavfi','-i','sine=frequency=110','-f','null','-']));
  const rejected=assert.rejects(media);
  await new Promise(r=>setTimeout(r,150));await mediaControl.terminate();await rejected;
  const cancel=await service.store.createRun({videoPath:'v.mp4',libraryPath:root});let requestStarted!:()=>void;
  const request=new Promise<void>(r=>requestStarted=r);const original=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{requestStarted();return await new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true});});};
  try{
   (service as any).launch(cancel,async()=>{await modelJson('http://fixture.test',{},'video-timing','gemini-test');cancel.status='ready';});
   await request;await (service as any).controlTask(cancel.id,'terminate');
   assert.equal((await service.waitForIdle(cancel.id)).status,'cancelled','termination aborts in-flight request and never reports ready');
   assert.equal((await service.store.readRun(run.id)).status,'ready','other projects stay untouched');
   await assert.rejects((service as any).controlTask(cancel.id,'resume'),/终止/);
  }finally{globalThis.fetch=original;}
 }finally{finishFirst();await service.waitForIdle(run.id);await fs.rm(root,{recursive:true,force:true});}
}
export async function testTaskControlUi(){
 const ui=await editorHarness();
 assert.equal(typeof ui.$('pause-task').onclick,'function','pause handler exists');
 assert.equal(typeof ui.$('resume-task').onclick,'function');assert.equal(typeof ui.$('terminate-task').onclick,'function');
 const calls:Array<{url:string;body:any}>=[];
 let finishStatus!:(value:any)=>void;
 const resumed=new Promise(resolve=>{finishStatus=resolve;});
 ui.context.fetch=async(url:string,options?:any)=>{
  const body=options?.body?JSON.parse(options.body):undefined;calls.push({url,body});
  let data:any={};
  if(url.endsWith('/control'))data={runId:'task-fixture',status:body.action==='terminate'?'cancelled':body.action==='pause'?'paused':'analyzing'};
  if(url.endsWith('/status'))data=await resumed;
  return {ok:true,json:async()=>data};
 };
 ui.exec('renderTaskControls("task-fixture",{status:"analyzing"})');
 await ui.$('pause-task').onclick();assert.equal(calls.at(-1)?.body.action,'pause');
 assert.equal(ui.$('resume-task').hidden,false);
 const pending=ui.$('resume-task').onclick();
 for(let n=0;n<30&&!calls.some(c=>c.url.endsWith('/status'));n++)await new Promise(r=>setTimeout(r,5));
 assert.equal(ui.$('terminate-task').disabled,false,'resume must release controls while polling');
 await ui.$('terminate-task').onclick();assert.equal(calls.at(-1)?.body.action,'terminate');
 finishStatus({status:'cancelled'});await pending;
 ui.exec('resetToNewProject()');assert.equal(ui.$('task-controls').hidden,true);
 await testTaskControlApi();
}

async function testTaskControlApi(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-control-api-')),service=new SfxService(root);
 const server=http.createServer((req,res)=>{void handleSfxRequest(req,res,new URL(req.url!,`http://${req.headers.host}`),service);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const run=await service.store.createRun({videoPath:'v.mp4',libraryPath:root});
 let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>entered=r),step=new Promise<void>(r=>release=r);
 (service as any).launch(run,async()=>{await usagePhase('fixture-step',async()=>{entered();await step;});run.status='ready';});
 const post=(action:string)=>fetch(`${base}/api/sfx/runs/${run.id}/control`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});
 try{
  await started;
  assert.equal((await post('invalid')).status,400);
  assert.equal((await post('pause')).status,202);release();
  for(let n=0;n<100&&(await service.status(run.id)).status!=='paused';n++)await new Promise(r=>setTimeout(r,5));
  assert.equal((await service.status(run.id)).status,'paused');
  assert.equal((await post('resume')).status,202);await service.waitForIdle(run.id);
  const failed=await service.store.createRun({videoPath:'v.mp4',libraryPath:root});
  failed.status='failed';failed.parentRunId=run.id;failed.workflow!.options.description='在吼叫时加入风声';failed.workflow!.operation='augment';await service.store.save(failed);
  let retried:any;
  service.addDescribedEvent=async(id,body)=>{retried={id,body};return {runId:'retry-child'};};
  assert.equal((await service.controlTask(failed.id,'resume')).runId,'retry-child');
  assert.equal(retried.id,run.id);assert.equal(retried.body.description,'在吼叫时加入风声');
 }finally{release();await service.waitForIdle(run.id);await new Promise<void>(r=>server.close(()=>r()));await fs.rm(root,{recursive:true,force:true});}
}
