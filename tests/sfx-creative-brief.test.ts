import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CreateRunSchema} from '../src/sfx/models.js';
import {SfxRunStore} from '../src/sfx/SfxRunStore.js';
import {SfxService} from '../src/sfx/SfxService.js';

export async function testCreativeBriefPersistence() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'spielkiste-brief-'));
  try {
    const input={videoPath:'demo.mp4',libraryPath:'library',videoDescription:'角色释放剑气',soundRequirements:'突出蓄力，环境轻一些',style:'修仙'};
    const parsed=CreateRunSchema.parse(input) as any;
    assert.equal(parsed.style,'修仙');
    const store=new SfxRunStore(root),run=await store.createRun(input);
    const saved=await store.readRun(run.id) as any;
    assert.equal(saved.videoDescription,input.videoDescription);assert.equal(saved.soundRequirements,input.soundRequirements);assert.equal(saved.style,'修仙');
  }finally{await fs.rm(root,{recursive:true,force:true});}
}

export async function testReanalysisUsesNewBriefAndPreservesParent() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'spielkiste-reanalysis-'));
  try {
    const video=path.join(root,'demo.mp4'), library=path.join(root,'library');
    await fs.mkdir(library); await fs.writeFile(video,'video');
    const service=new SfxService(path.join(root,'output'));
    const source=await service.store.createRun({projectId:'11111111-1111-4111-8111-111111111111',videoPath:video,libraryPath:library,name:'原始项目',videoDescription:'旧说明',soundRequirements:'旧要求',style:'修仙'});
    source.status='ready'; source.duration=1; source.scenes=[{start:0,end:1}];
    await service.store.save(source);
    let captured:any;
    (service as any).create=async (input:any)=>{captured=input;return {runId:'new-run'}};
    const result=await service.reanalyze(source.id,{mode:'brief',videoDescription:'新增：Boss在远处咆哮后砸地',soundRequirements:'突出砸地，压低细碎声',style:'暗黑奇幻'});
    assert.equal(result.runId,'new-run');
    assert.equal(captured.projectId,source.projectId);
    assert.equal(captured.parentRunId,source.id);
    assert.equal(captured.reusePreserved,false);
    assert.equal(captured.videoDescription,'新增：Boss在远处咆哮后砸地');
    assert.equal(captured.soundRequirements,'突出砸地，压低细碎声');
    assert.equal(captured.style,'暗黑奇幻');
    const visual=await service.reanalyze(source.id,{mode:'visual',videoDescription:'这段不应作为约束',soundRequirements:'保留关键动作',style:'修仙'});
    assert.equal(visual.runId,'new-run');
    assert.equal(captured.videoDescription,undefined);
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
