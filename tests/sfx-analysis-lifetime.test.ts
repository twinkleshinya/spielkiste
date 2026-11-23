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
