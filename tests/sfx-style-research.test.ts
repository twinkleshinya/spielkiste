import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export async function testStyleResearchCacheAndEvidence() {
  const module=await import('../src/sfx/StyleResearch.js') as any;
  assert.equal(typeof module.StyleResearcher,'function');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'spielkiste-style-'));let reads=0,calls=0;
  const profile={summary:'东方幻想动作声音',palette:['气流','金属'],avoid:['电子激光'],actionGuidance:['蓄力持续而非碎点击'],searchTerms:['magic','sword'],limitations:'文献推导，未试听原声'};
  const sources=async()=>{reads++;return [{title:'参考作品',url:'https://example.org/game',excerpt:'游戏题材与法术战斗公开资料'},{title:'参考影视',url:'https://example.org/film',excerpt:'公开制作资料'}];};
  const model=async(prompt:string)=>{calls++;assert.ok(prompt.includes('参考作品'));return profile;};
  try {
    const researcher=new module.StyleResearcher(root,sources,model);
    const first=await researcher.research('测试修仙','gemini-test','high');assert.equal(first.basis,'document-research');assert.equal(first.references.length,2);
    await researcher.research('测试修仙','gemini-test','high');assert.equal(reads,1);assert.equal(calls,1);
    await researcher.research('测试修仙','gemini-test','high',undefined,true);assert.equal(calls,2);
    const failedRoot=path.join(root,'failed');await fs.mkdir(failedRoot);const failed=new module.StyleResearcher(failedRoot,async()=>[],model);
    await assert.rejects(failed.research('未知','gemini-test','high'),/资料|参考/);
    assert.equal((await failed.list()).some((profile:any)=>profile.style==='未知'),false,'failed research must not create a researched profile');
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
