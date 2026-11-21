import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CreateRunSchema} from '../src/sfx/models.js';
import {SfxRunStore} from '../src/sfx/SfxRunStore.js';

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
