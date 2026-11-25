import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const exec=promisify(execFile);
const root=path.resolve('.output/desktop-acceptance',String(Date.now())),workspace=path.join(root,'workspace'),release=process.env.SPIELKISTE_TEST_EXE?path.dirname(path.resolve(process.env.SPIELKISTE_TEST_EXE)):path.resolve('.output/desktop-release/win-unpacked');
await fs.mkdir(workspace,{recursive:true});await fs.rm(path.join(workspace,'desktop-smoke.json'),{force:true});
const launchEnv={...process.env,SPIELKISTE_DATA_DIR:workspace,SPIELKISTE_SMOKE_HOLD:'1'};
const executable=process.env.SPIELKISTE_TEST_EXE||path.join(release,'Spielkiste.exe');
const child=spawn(executable,['--spielkiste-smoke','--remote-debugging-port=0'],{windowsHide:true,stdio:'ignore',env:launchEnv});
const report={started:new Date().toISOString(),checks:[]};
let boot;
try{
 for(let i=0;i<240;i++){try{boot=JSON.parse(await fs.readFile(path.join(workspace,'desktop-smoke.json'),'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,500));}}
 assert.ok(boot?.ready,'packaged desktop UI starts');assert.equal(boot.packaged,true);assert.equal(boot.nativeFolderPicker,true,'native folder picker is exposed by the sandboxed preload');report.checks.push('packaged UI, backend startup and native folder picker bridge');report.port=boot.port;
 const base=`http://127.0.0.1:${boot.port}`;
 async function api(url,body){const response=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(`${url}: ${JSON.stringify(value)}`);return value;}
 async function wait(id){for(let i=0;i<360;i++){const status=await api(`/api/sfx/runs/${id}/status`);if(status.status==='failed')throw new Error(status.error);if(status.status==='ready')return api(`/api/sfx/runs/${id}`);await new Promise(resolve=>setTimeout(resolve,500));}throw new Error('render timeout');}
 const health=await api('/api/sfx/health');for(const capability of ['described-event-inline-feedback','generation-without-fixed-deadlines','completion-after-final-save'])assert.ok(health.capabilities.includes(capability),capability);report.checks.push('latest described-event feedback, unlimited generation and final-save status');
 for(const route of ['/sfx','/sfx.js','/sfx-git.js','/sfx-clip-edit.js','/sfx-asset-exclusions.js','/WorkflowPolicy.js','/assets/spielkiste.ico','/api/sfx/workflow/guide','/api/sfx/workflow/bundle'])assert.equal((await fetch(base+route)).status,200,route);
 report.checks.push('static resources, icon, internal workflow resources');
 assert.deepEqual(await api('/api/sfx/projects'),[]);assert.equal((await api('/api/sfx/git-config')).configured,false);report.checks.push('fresh user contains no private projects or Git settings');
 const runtime=boot.runtime,ffmpeg=path.join(runtime,'ffmpeg.exe'),ffprobe=path.join(runtime,'ffprobe.exe'),git=path.join(runtime,'git/cmd/git.exe');
 const tools={};for(const [name,binary,args] of [['ffmpeg',ffmpeg,['-version']],['ffprobe',ffprobe,['-version']],['git',git,['--version']]])tools[name]=(await exec(binary,args,{windowsHide:true})).stdout.split(/\r?\n/)[0];report.tools=tools;report.checks.push('bundled FFmpeg, FFprobe, Git execute');
 const library=path.join(root,'中文音效库');await fs.mkdir(library,{recursive:true});const video=path.join(root,'中文测试视频.mp4'),audio=path.join(library,'boss_charge_cast.wav');
 await exec(ffmpeg,['-y','-f','lavfi','-i','color=c=0x536353:s=640x360:r=24:d=3','-f','lavfi','-i','sine=frequency=220:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',video],{windowsHide:true});
 await exec(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=110:duration=1.4','-ac','2','-ar','48000','-c:a','pcm_s24le',audio],{windowsHide:true});
 const indexJob=await api('/api/sfx/library-index',{paths:[library]});let indexStatus;
 for(let i=0;i<90;i++){indexStatus=await api(`/api/sfx/library-index/${indexJob.id}`);if(indexStatus.status!=='indexing')break;await new Promise(resolve=>setTimeout(resolve,500));}
 assert.equal(indexStatus.status,'ready',indexStatus.error);assert.equal(indexStatus.libraries[0].count,1);
 const indexes=await fs.readdir(path.join(workspace,'.output/sfx/indexes'));assert.ok(indexes.some(file=>file.endsWith('.json')));report.checks.push('persistent library scan index and manual refresh API');
 const created=await api('/api/sfx/runs',{name:'',videoPath:video,libraryPath:library,analysisMode:'scene',workflowPreset:'custom',aiSelection:false,autoMix:false,autoRender:false,musicEnabled:false,reusePreserved:false});
 await wait(created.runId);const run=JSON.parse(await fs.readFile(path.join(workspace,'.output/sfx/runs',created.runId,'run.json'),'utf8'));assert.equal(run.assets.length,1);assert.equal(run.name,'中文测试视频');assert.equal((await api('/api/sfx/projects')).find(project=>project.projectId===run.projectId)?.name,'中文测试视频');report.checks.push('blank project name uses Unicode video filename in saved projects, lazy local library indexing, analysis API');
 const event={id:'charge',start:0.5,end:1.8,type:'charge',description:'Boss 蓄力',query:'charge cast',actor:'boss',category:'foley',confidence:1,source:'manual',candidates:[],requiresHumanReview:false};
 const placement={id:'charge-sound',eventId:'charge',assetId:run.assets[0].id,start:0.5,duration:1.25,sourceOffset:0.05,gainDb:-12,fadeIn:0.02,fadeOut:0.1,category:'foley',enabled:true};
 const edited=await api(`/api/sfx/runs/${run.id}/edit-preview`,{revision:run.revision,events:[event],placements:[placement],originalGainDb:-60,originalMuted:true,musicEnabled:false});
 const preview=await wait(edited.runId);assert.ok(preview.render);for(const [key,value] of Object.entries(placement))assert.deepEqual(preview.placements[0][key],value,key);report.checks.push('explicit edit preview renders with saved placement and fades');
 if(process.argv.includes('--multiwindow')) {
  assert.equal(boot.newProjectWindow,true);
  const debugPort=Number((await fs.readFile(path.join(workspace,'.desktop-state/DevToolsActivePort'),'utf8')).split('\n')[0]);
  const targets=()=>fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json()).then(rows=>rows.filter(t=>t.type==='page'&&t.url.startsWith(base+'/sfx')));
  const target=(await targets())[0],socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let sequence=0;const waiting=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);const call=waiting.get(message.id);if(call){waiting.delete(message.id);message.error?call.reject(new Error(JSON.stringify(message.error))):call.resolve(message.result);}});
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;waiting.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result?.value;};
  try {
   await cdp('Page.navigate',{url:base+`/sfx?run=${preview.id}`});
   let opened=false;for(let n=0;n<120;n++){opened=await evaluate(`document.getElementById('project-title')?.textContent?.length>0`);if(opened)break;await new Promise(r=>setTimeout(r,250));}assert.ok(opened,'actual project editor loads');
   const layout=await evaluate(`(async()=>{const list=document.getElementById('event-list'),editor=document.getElementById('event-editor'),panel=document.querySelector('.inspector');for(let n=0;n<40;n++){const row=document.createElement('div');row.style.height='65px';row.textContent='滚动检查';list.append(row);}const spacer=document.createElement('div');spacer.style.height='1600px';editor.append(spacer);document.querySelector('.workspace-grid').scrollIntoView({block:'start'});await new Promise(r=>requestAnimationFrame(r));list.scrollTop=120;editor.scrollTop=0;const before={left:list.scrollTop,page:scrollY};editor.scrollTop=200;await new Promise(r=>requestAnimationFrame(r));const right={left:list.scrollTop,page:scrollY,editor:editor.scrollTop};list.scrollTop=240;await new Promise(r=>requestAnimationFrame(r));const after={left:list.scrollTop,page:scrollY,editor:editor.scrollTop};return {before,right,after,contain:getComputedStyle(editor).overscrollBehaviorY,height:editor.clientHeight,overflow:editor.scrollHeight,panelHeight:panel.clientHeight};})()`);
   assert.ok(layout.right.editor>0,'right editor actually scrolls');assert.equal(layout.right.left,layout.before.left,'right scroll leaves sound list fixed');assert.equal(layout.right.page,layout.before.page,'right scroll leaves page fixed');assert.ok(layout.after.left>layout.right.left);assert.equal(layout.after.editor,layout.right.editor,'sound list scroll leaves editor fixed');assert.equal(layout.contain,'contain');report.layout=layout;report.checks.push('real Chromium layout: independent sound list and placement editor scrolling');
   await evaluate('window.spielkisteDesktop.newWindow()');assert.equal((await targets()).length,2,'button opens another project window');
   const second=spawn(executable,['--spielkiste-smoke'],{windowsHide:true,stdio:'ignore',env:launchEnv});second.on('error',()=>{});
   // Portable launchers unpack their bundled runtime before delivering the
   // second-instance event; allow that startup work on slower Windows disks.
   let count=0;for(let n=0;n<480;n++){count=(await targets()).length;if(count===3)break;await new Promise(r=>setTimeout(r,250));}assert.equal(count,3,'relaunching EXE opens a third window');
   const pages=await targets();assert.ok(pages.every(p=>new URL(p.url).origin===base),'all windows share one backend');
   await cdp('Page.close');assert.equal((await api('/api/sfx/health')).ok,true,'closing first editor keeps backend alive');assert.equal((await targets()).length,2,'other editors remain open');report.checks.push('EXE relaunch and new-window button share backend; closing one editor preserves other windows');
  }finally{socket.close();}
 }
 const probe=JSON.parse((await exec(ffprobe,['-v','error','-show_format','-show_streams','-of','json',preview.render.video],{windowsHide:true})).stdout);assert.ok(probe.streams.some(s=>s.codec_type==='video'));assert.ok(probe.streams.some(s=>s.codec_type==='audio'));report.preview={duration:probe.format.duration,video:preview.render.video};
 const ranged=await fetch(base+`/api/sfx/runs/${preview.id}/media/preview`,{headers:{range:'bytes=0-1023'}});assert.equal(ranged.status,206);report.rangeStatus=ranged.status;
 const projectId=preview.projectId;
 const namedVersion=await api(`/api/sfx/projects/${projectId}/save-version`,{name:'验收命名版本',runId:preview.id});
 assert.notEqual(namedVersion.runId,preview.id);
 const namedRun=await api(`/api/sfx/runs/${namedVersion.runId}`);
 assert.deepEqual(namedRun.placements,preview.placements);assert.deepEqual(namedRun.events,preview.events);
 assert.deepEqual(await fs.readFile(namedRun.render.video),await fs.readFile(preview.render.video));
 const versions=await api(`/api/sfx/projects/${projectId}/versions`);
 assert.equal(versions.find(version=>version.runId===namedRun.id)?.name,'验收命名版本');
 report.checks.push('named local version saves placements, events and identical preview without overwriting parent');
 await api(`/api/sfx/projects/${projectId}/rename`,{name:'验收已重命名'});
 const saved=await api(`/api/sfx/projects/${projectId}/save-as`,{name:'验收副本'});assert.notEqual(saved.projectId,projectId);
 const restored=await api(`/api/sfx/projects/${projectId}/restore`,{runId:run.id});assert.equal((await wait(restored.runId)).placements.length,0);report.checks.push('local rename, save-as and historical rollback without remote');
 const muted=await api(`/api/sfx/runs/${preview.id}/edit-preview`,{revision:preview.revision,events:[{...event,muted:true}],placements:[placement],originalGainDb:-60,originalMuted:true,musicEnabled:false});assert.ok((await wait(muted.runId)).render);report.checks.push('muted event creates valid silent preview');
 const exported=await api(`/api/sfx/runs/${preview.id}/export/reaper`,{outputPath:path.join(root,'REAPER验收','Boss'),channelMode:'preserve',audioFormat:'preserve',sampleRate:0});assert.match(exported.outputPath,/\.rpp$/i);const rpp=await fs.readFile(exported.outputPath,'utf8');const references=[...rpp.matchAll(/^\s*FILE "([^"]+)"/gm)].map(m=>m[1]);assert.ok(references.length>=2);for(const ref of references){assert.equal(path.isAbsolute(ref),false);await fs.access(path.join(path.dirname(exported.outputPath),ref));}report.checks.push('portable REAPER video and audio tracks, .rpp extension and bundled template');
 if(process.argv.includes('--native-reaper'))for(const channelMode of ['stereo','mono']){
  const native=await api(`/api/sfx/runs/${preview.id}/export/reaper`,{outputPath:path.join(root,`REAPER-${channelMode}`,'Boss'),channelMode,audioFormat:'wav24',sampleRate:44100});
  const audioFiles=native.manifest.media.filter(file=>file.kind==='audio');assert.ok(audioFiles.length);
  for(const file of audioFiles){const meta=JSON.parse((await exec(ffprobe,['-v','error','-show_streams','-of','json',path.join(path.dirname(native.outputPath),file.relativePath)],{windowsHide:true})).stdout).streams[0];assert.equal(meta.channels,channelMode==='mono'?1:2);assert.equal(Number(meta.sample_rate),44100);assert.equal(meta.bits_per_sample,24);}
  report.checks.push(`native REAPER ${channelMode}, WAV 24-bit 44100 Hz verified by FFprobe`);
 }
 const ai=await api('/api/sfx/ai-config');report.ai={configured:ai.configured,ready:ai.ready,model:ai.model,source:ai.source};
 if(process.argv.includes('--ai')){const test=await api('/api/sfx/ai-config/test',{});assert.equal(test.ok,true);assert.equal(test.model,ai.model);report.ai.test={ok:test.ok,model:test.model,capabilities:test.capabilities,elapsedMs:test.elapsedMs};report.checks.push('actual configured Gemini image and audio connection');}
 report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;throw error;}
finally{report.finished=new Date().toISOString();await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.resolve('.output/desktop-acceptance/latest.json'),JSON.stringify({...report,root},null,2));if(process.platform==='win32'){for(const pid of new Set([boot?.processId,child.pid].filter(Boolean))){try{await exec('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true});}catch{}}}else child.kill();console.log(JSON.stringify(report,null,2));}
