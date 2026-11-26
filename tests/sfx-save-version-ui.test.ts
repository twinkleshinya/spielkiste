import assert from 'node:assert/strict';
import {editorHarness} from './sfx-edit-preview-ui.test.js';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {SfxService} from '../src/sfx/SfxService.js';
import {handleSfxRequest} from '../src/ui/sfx-routes.js';
import {fixtureRun} from './sfx-reaper-export.test.js';

export async function testNamedVersionDialog(){
 const html=await fs.readFile(path.resolve('src/ui/public/sfx.html'),'utf8');
 for(const id of ['save-version-dialog','save-version-form','save-version-name','save-version-message','save-version-cancel','save-version-submit'])assert.ok(html.includes(`id="${id}"`),`real page must contain ${id}`);
 const ui=await editorHarness();
 ui.context.window.prompt=()=>{throw new Error('prompt unsupported');};
 ui.exec(`run.projectId='33333333-3333-4333-8333-333333333333';`);
 const before=ui.getRun();
 await ui.$('preserve').onclick();
 assert.equal(ui.$('save-version-dialog').open,true,'save must open an in-app naming dialog without window.prompt');
 assert.equal(ui.$('save-version-name').value,'','user supplies the version name');
 assert.equal(ui.calls.some(c=>c.url.endsWith('/save-version')),false,'opening the naming dialog must not save yet');
 ui.$('save-version-name').value='   ';
 await ui.$('save-version-form').onsubmit({preventDefault(){}});
 assert.equal(ui.calls.some(c=>c.url.endsWith('/save-version')),false,'blank names must not be saved');
 assert.ok(ui.$('save-version-message').textContent.includes('名称'));
 ui.$('save-version-name').value='  吼叫与风声确认版  ';
 await ui.$('save-version-form').onsubmit({preventDefault(){}});
 const saved=ui.calls.find(c=>c.url.endsWith('/save-version'));
 assert.deepEqual(saved?.body,{name:'吼叫与风声确认版',runId:before.id});
 assert.notEqual(ui.getRun().id,before.id);
 assert.equal(ui.getRun().name,'吼叫与风声确认版');
 assert.equal(ui.$('save-version-dialog').open,false);
 assert.ok(ui.$('version-history').children.some((o:any)=>o.textContent?.includes('吼叫与风声确认版')));
 assert.deepEqual(ui.getRun().placements,before.placements);
 assert.equal(ui.calls.some(c=>/\/(edit-preview|render|reanalyze|reselect)$/.test(c.url)),false,'save a snapshot without re-rendering or reselecting');
}

export async function testNamedVersionFailureCanRetryAndCancel(){
 const ui=await editorHarness();
 ui.exec(`run.projectId='33333333-3333-4333-8333-333333333333';`);
 const before=ui.getRun();
 await ui.$('preserve').onclick();
 ui.$('save-version-name').value='保留的版本名';
 ui.failSaveVersion();
 await ui.$('save-version-form').onsubmit({preventDefault(){}});
 assert.equal(ui.$('save-version-dialog').open,true);
 assert.equal(ui.$('save-version-name').value,'保留的版本名');
 assert.ok(ui.$('save-version-message').textContent.includes('test save failure'));
 assert.equal(ui.$('save-version-submit').disabled,false);
 assert.deepEqual(ui.getRun().placements,before.placements);
 assert.equal(ui.getRun().id,before.id);
 ui.failSaveVersion(false);
 await ui.$('save-version-form').onsubmit({preventDefault(){}});
 assert.equal(ui.getRun().name,'保留的版本名');
 await ui.$('preserve').onclick();
 const count=ui.calls.length;
 ui.$('save-version-cancel').onclick();
 assert.equal(ui.$('save-version-dialog').open,false);assert.equal(ui.calls.length,count);
}

export async function testNamedVersionExplainsPendingEdits(){
 const ui=await editorHarness();
 await ui.exec(`quickEdit('placement','p-boss','mute')`);
 await ui.$('preserve').onclick();
 assert.equal(ui.calls.some(c=>c.url.endsWith('/save-version')),false);
 assert.ok(ui.$('status').textContent.includes('更新视频预览'),'pending edits need an actionable explanation');
}

export async function testNamedVersionReloadRetryDoesNotSaveTwice(){
 const ui=await editorHarness();ui.exec(`run.projectId='33333333-3333-4333-8333-333333333333';`);
 const fetch=ui.context.fetch;let failRead=true;
 ui.context.fetch=async(url:string,options:any)=>{
  if(failRead&&url.endsWith('/status'))throw new Error('test reload failure');
  return fetch(url,options);
 };
 await ui.$('preserve').onclick();ui.$('save-version-name').value='已保存待打开';
 await ui.$('save-version-form').onsubmit({preventDefault(){}});
 assert.equal(ui.$('save-version-dialog').open,true);assert.match(ui.$('save-version-message').textContent,/版本已保存/);
 assert.equal(ui.$('save-version-submit').textContent,'重新打开版本');
 failRead=false;await ui.$('save-version-form').onsubmit({preventDefault(){}});
 assert.equal(ui.calls.filter(c=>c.url.endsWith('/save-version')).length,1,'reload retries must not create duplicate versions');
 assert.equal(ui.getRun().name,'已保存待打开');assert.equal(ui.$('save-version-dialog').open,false);
}

export async function testNamedVersionHttpPersistence(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'spielkiste-version-api-'));
 const service=new SfxService(path.join(root,'output'));
 const server=http.createServer((req,res)=>{void handleSfxRequest(req,res,new URL(req.url!,'http://localhost'),service);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 try{
  const source=fixtureRun(root);source.projectId=crypto.randomUUID();
  source.render={video:path.join(root,'preview.mp4'),audio:path.join(root,'preview.wav'),revision:source.revision};
  await fs.writeFile(source.render.video,'saved preview bytes');await fs.writeFile(source.render.audio,'saved mix bytes');
  await service.store.save(source);await service.projects.registerRun(source,'create');
  const before=await service.readRun(source.id);
  const post=(body:unknown)=>fetch(`${base}/api/sfx/projects/${source.projectId}/save-version`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  for(const name of ['   ','x'.repeat(121)])assert.equal((await post({name,runId:source.id})).status,400);
  assert.equal((await service.projects.listVersions(source.projectId)).length,1);
  const response=await post({name:'  吼叫确认版  ',runId:source.id});assert.equal(response.status,200,await response.clone().text());
  const saved=await response.json() as {runId:string;projectId:string};
  const reopened=await (await fetch(`${base}/api/sfx/runs/${saved.runId}`)).json();
  assert.equal(reopened.name,'吼叫确认版');assert.equal(reopened.parentRunId,source.id);assert.equal(reopened.projectId,source.projectId);
  assert.deepEqual(reopened.placements,source.placements);assert.deepEqual(reopened.events,source.events);
  assert.deepEqual(reopened.render,{...source.render,revision:source.revision+1});
  assert.deepEqual(await service.readRun(source.id),before,'saving cannot overwrite the original');
  const versions=await (await fetch(`${base}/api/sfx/projects/${source.projectId}/versions`)).json();
  assert.equal(versions.length,2);assert.ok(versions.some((v:any)=>v.runId===saved.runId&&v.name==='吼叫确认版'));
  const projects=await service.projects.listProjects();assert.equal(projects.length,1);assert.equal(projects[0].git,'local-only');
  assert.equal(projects[0].currentRunId,saved.runId);
  // Reload the stores as on a service restart, then restore the named snapshot.
  const restarted=new SfxService(path.join(root,'output'));
  assert.equal((await restarted.readRun(saved.runId)).name,'吼叫确认版');
  const restored=await restarted.restoreProjectVersion(source.projectId,saved.runId);
  assert.deepEqual((await restarted.readRun(restored.runId)).placements,source.placements);
  assert.equal(await fs.readFile(source.render.video,'utf8'),'saved preview bytes');
 }finally{
  await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});
 }
}
