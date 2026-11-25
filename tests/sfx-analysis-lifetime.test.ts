import {testAddDescribedEventApiLocatesAndPreservesExistingTimeline} from "./sfx-described-event.test.js";
import {testLocateEventApiPreservesParentAndUsesOnlyTiming} from "./sfx-event-reidentify.test.js";
import assert from "node:assert/strict";
import {mock} from "node:test";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {SfxService} from "../src/sfx/SfxService.js";
import {SfxVideoAnalyzer} from "../src/sfx/SfxVideoAnalyzer.js";

export async function testAnalysisCanProgressPastThirtyMinutes(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"spielkiste-long-analysis-"));
  const original=SfxVideoAnalyzer.prototype.analyze;
  await fs.writeFile(path.join(root,"video.mp4"),"fixture");
  let wasAborted=false;
  mock.timers.enable({apis:["Date","setTimeout","setInterval"]});
  try{
    SfxVideoAnalyzer.prototype.analyze=async(_video,_output,options={})=>{
      try{
        for(let n=1;n<=65;n++){mock.timers.tick(60000);options.progress?.(`Gemini 接触点复核 ${n}/65`);}
        wasAborted=!!options.signal?.aborted;
        options.signal?.throwIfAborted();
        return {duration:1,scenes:[],events:[],warnings:[],mode:"scene" as const};
      }finally{mock.timers.reset();}
    };
    const service=new SfxService(path.join(root,"output"));
    const {runId}=await service.create({videoPath:path.join(root,"video.mp4"),libraryPath:root,analysisMode:"scene",workflowPreset:"custom",autoRender:false,aiSelection:false,reusePreserved:false});
    const run=await service.waitForIdle(runId);
    assert.equal(wasAborted,false,"a progressing multi-request analysis must have no total deadline");
    assert.equal(run.status,"ready",run.error);
  }finally{SfxVideoAnalyzer.prototype.analyze=original;mock.timers.reset();await fs.rm(root,{recursive:true,force:true});}
}

export async function testAnalysisFailureIncludesLastStage(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"spielkiste-analysis-stage-"));
  const original=SfxVideoAnalyzer.prototype.analyze;
  await fs.writeFile(path.join(root,"video.mp4"),"fixture");
  try{
    SfxVideoAnalyzer.prototype.analyze=async(_video,_output,options={})=>{
      options.progress?.("Gemini 3/4：接触点复核 7/43");throw new Error("模型请求连接中断");
    };
    const service=new SfxService(path.join(root,"output"));
    const {runId}=await service.create({videoPath:path.join(root,"video.mp4"),libraryPath:root,analysisMode:"scene",workflowPreset:"custom",autoRender:false,aiSelection:false,reusePreserved:false});
    const run=await service.waitForIdle(runId);
    assert.equal(run.status,"failed");assert.match(run.error||"",/接触点复核 7\/43/);assert.match(run.error||"",/模型请求连接中断/);
  }finally{SfxVideoAnalyzer.prototype.analyze=original;await fs.rm(root,{recursive:true,force:true});}
}

export async function testDescribedAndReidentifyJobsHaveNoTotalDeadline(){
  await testAddDescribedEventApiLocatesAndPreservesExistingTimeline(true);
  await testLocateEventApiPreservesParentAndUsesOnlyTiming(true);
}
export async function testReadyStatusWaitsForFinalSave() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-save-state-'));
  let release!:()=>void;
  let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const saving=new Promise<void>(resolve=>{release=resolve;});
  const service=new SfxService(root);
  const run=await service.store.createRun({videoPath:path.join(root,'video.mp4'),libraryPath:root});
  try {
    (service as any).launch(run,async()=>{run.status='ready';run.progress='已生成';entered();await saving;await service.store.save(run);});
    await started;
    const pending=await service.status(run.id);
    assert.equal(pending.status,'analyzing','ready must not be advertised before final writes release the task');
    assert.match(pending.progress||'',/保存/);
    release();await service.waitForIdle(run.id);
    assert.equal((await service.status(run.id)).status,'ready');
  }finally{release();await service.waitForIdle(run.id);await fs.rm(root,{recursive:true,force:true});}
}
