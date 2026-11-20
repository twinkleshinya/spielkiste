import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ProjectGit,validateRepository,gitFailure} from '../src/sfx/ProjectGit.js';
import {SfxRunStore} from '../src/sfx/SfxRunStore.js';
const exec=promisify(execFile);
export async function testProjectGit(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'spielkiste-git-'));
 try{
  assert.throws(()=>validateRepository('https://secret@github.com/user/repo.git'),/密码/);
  assert.throws(()=>validateRepository('--upload-pack=evil'),/地址/);
  assert.equal(validateRepository('https://github.com/twinkleshinya/spielkiste.git'),'https://github.com/twinkleshinya/spielkiste.git');
  assert.ok(!gitFailure(new Error('https://secret@host/repo ghp_secret Bearer abc')).includes('secret'));
  const remote=path.join(root,'remote.git');await exec('git',['init','--bare',remote]);
  const video=path.join(root,'中文视频.mp4'),audio=path.join(root,'charge.wav'),preview=path.join(root,'preview.mp4'),mix=path.join(root,'mix.wav');
  for(const file of [video,audio,preview,mix])await fs.writeFile(file,Buffer.from(`fixture ${path.basename(file)}`));
  const store=new SfxRunStore(path.join(root,'runs'));
  const projectId=crypto.randomUUID();
  const run=await store.createRun({projectId,videoPath:video,libraryPath:root,analysisMode:'scene',name:'跨电脑测试'});
  Object.assign(run,{status:'ready',duration:2,assets:[{id:'used',path:audio,relativePath:'charge.wav',fileName:'charge.wav',size:5,mtimeMs:0,tags:[],usable:true},{id:'private',path:path.join(root,'private-secret.wav'),relativePath:'private-secret.wav',fileName:'private-secret.wav',size:9,mtimeMs:0,tags:[],usable:true}],events:[{id:'e',start:0,end:1,type:'charge',description:'蓄力',query:'charge',category:'foley',confidence:1,source:'manual',candidates:[],requiresHumanReview:false}],placements:[{id:'p',eventId:'e',assetId:'used',start:0,duration:1,sourceOffset:0,gainDb:-8,fadeIn:0.01,fadeOut:0.1,category:'foley',enabled:true}],render:{video:preview,audio:mix,revision:0}});
  const git=new ProjectGit(path.join(root,'uploader'),true);
  await git.save({repository:remote});await git.test();
  assert.deepEqual(await git.remoteProjects(),[]);
  const published=await git.publish({projectId,name:run.name,currentRunId:run.id},[run],true);
  assert.equal(published.status,'synced');assert.equal(published.mediaCount,4);
  const tracked=(await exec('git',['--git-dir',remote,'ls-tree','-r','--name-only','spielkiste-projects'])).stdout;
  assert.ok(!tracked.includes('private-secret'));assert.ok(!tracked.includes('settings.json'));assert.ok(!tracked.includes('index.json'));
  const snapshot=(await exec('git',['--git-dir',remote,'show',`spielkiste-projects:projects/${projectId}/versions/${run.id}.json`])).stdout;
  assert.ok(!snapshot.includes(root.replaceAll('\\','\\\\')),'no local source paths');
  const other=new ProjectGit(path.join(root,'downloader'),true);await other.save({repository:remote});
  const listed=await other.remoteProjects();assert.equal(listed[0].name,run.name);
  const imported=await other.download(projectId,path.join(root,'imported'));const loaded=imported.runs[0];
  assert.equal(loaded.assets.length,1);assert.deepEqual(loaded.placements,run.placements);
  assert.deepEqual(await fs.readFile(loaded.assets[0].path),await fs.readFile(audio));
  assert.deepEqual(await fs.readFile(loaded.render!.video),await fs.readFile(preview));
  // A remote advance cannot be overwritten by a stale client.
  const second=structuredClone(run);second.id=crypto.randomUUID();second.revision=1;
  await other.publish({projectId,name:run.name,currentRunId:second.id},[run,second],true);
  const retry=await git.publish({projectId,name:'更新名称',currentRunId:second.id},[run,second],true);assert.equal(retry.status,'synced');
  const offline=new ProjectGit(path.join(root,'offline'),true);await offline.save({repository:path.join(root,'does-not-exist.git')});
  await assert.rejects(()=>offline.test());assert.ok(await fs.stat(video));
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
