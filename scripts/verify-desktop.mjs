import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const exec=promisify(execFile);
const root=path.resolve('.output/desktop-acceptance',String(Date.now())),workspace=path.join(root,'workspace'),release=process.env.SPIELKISTE_TEST_EXE?path.dirname(path.resolve(process.env.SPIELKISTE_TEST_EXE)):path.resolve('.output/desktop-release/win-unpacked');
await fs.mkdir(workspace,{recursive:true});await fs.rm(path.join(workspace,'desktop-smoke.json'),{force:true});
const child=spawn(process.env.SPIELKISTE_TEST_EXE||path.join(release,'Spielkiste.exe'),['--spielkiste-smoke'],{windowsHide:true,stdio:'ignore',env:{...process.env,SPIELKISTE_DATA_DIR:workspace,SPIELKISTE_SMOKE_HOLD:'1'}});
const report={started:new Date().toISOString(),checks:[]};
try{
 let boot;for(let i=0;i<90;i++){try{boot=JSON.parse(await fs.readFile(path.join(workspace,'desktop-smoke.json'),'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,500));}}
 assert.ok(boot?.ready,'packaged desktop UI starts');assert.equal(boot.packaged,true);assert.equal(boot.nativeFolderPicker,true,'native folder picker is exposed by the sandboxed preload');report.checks.push('packaged UI, backend startup and native folder picker bridge');report.port=boot.port;
 const base=`http://127.0.0.1:${boot.port}`;
 async function api(url,body){const response=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(`${url}: ${JSON.stringify(value)}`);return value;}
 async function wait(id){for(let i=0;i<360;i++){const status=await api(`/api/sfx/runs/${id}/status`);if(status.status==='failed')throw new Error(status.error);if(status.status==='ready')return api(`/api/sfx/runs/${id}`);await new Promise(resolve=>setTimeout(resolve,500));}throw new Error('render timeout');}
 for(const route of ['/sfx','/sfx.js','/sfx-git.js','/sfx-clip-edit.js','/sfx-asset-exclusions.js','/WorkflowPolicy.js','/assets/spielkiste.ico','/api/sfx/workflow/guide','/api/sfx/workflow/bundle'])assert.equal((await fetch(base+route)).status,200,route);
 report.checks.push('static resources, icon, internal workflow resources');
 assert.deepEqual(await api('/api/sfx/projects'),[]);assert.equal((await api('/api/sfx/git-config')).configured,false);report.checks.push('fresh user contains no private projects or Git settings');
 const runtime=path.join(release,'resources/runtime'),ffmpeg=path.join(runtime,'ffmpeg.exe'),ffprobe=path.join(runtime,'ffprobe.exe'),git=path.join(runtime,'git/cmd/git.exe');
 const tools={};for(const [name,binary,args] of [['ffmpeg',ffmpeg,['-version']],['ffprobe',ffprobe,['-version']],['git',git,['--version']]])tools[name]=(await exec(binary,args,{windowsHide:true})).stdout.split(/\r?\n/)[0];report.tools=tools;report.checks.push('bundled FFmpeg, FFprobe, Git execute');
 const library=path.join(root,'中文音效库');await fs.mkdir(library,{recursive:true});const video=path.join(root,'中文测试视频.mp4'),audio=path.join(library,'boss_charge_cast.wav');
 await exec(ffmpeg,['-y','-f','lavfi','-i','color=c=0x536353:s=640x360:r=24:d=3','-f','lavfi','-i','sine=frequency=220:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',video],{windowsHide:true});
 await exec(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=110:duration=1.4','-ac','2','-ar','48000','-c:a','pcm_s24le',audio],{windowsHide:true});
 const indexJob=await api('/api/sfx/library-index',{paths:[library]});let indexStatus;
 for(let i=0;i<90;i++){indexStatus=await api(`/api/sfx/library-index/${indexJob.id}`);if(indexStatus.status!=='indexing')break;await new Promise(resolve=>setTimeout(resolve,500));}
 assert.equal(indexStatus.status,'ready',indexStatus.error);assert.equal(indexStatus.libraries[0].count,1);
 const indexes=await fs.readdir(path.join(workspace,'.output/sfx/indexes'));assert.ok(indexes.some(file=>file.endsWith('.json')));report.checks.push('persistent library scan index and manual refresh API');
 const created=await api('/api/sfx/runs',{name:'安装包功能验收',videoPath:video,libraryPath:library,analysisMode:'scene',workflowPreset:'custom',aiSelection:false,autoMix:false,autoRender:false,musicEnabled:false,reusePreserved:false});
 await wait(created.runId);const run=JSON.parse(await fs.readFile(path.join(workspace,'.output/sfx/runs',created.runId,'run.json'),'utf8'));assert.equal(run.assets.length,1);report.checks.push('Unicode video path, lazy local library indexing, analysis API');
 const event={id:'charge',start:0.5,end:1.8,type:'charge',description:'Boss 蓄力',query:'charge cast',actor:'boss',category:'foley',confidence:1,source:'manual',candidates:[],requiresHumanReview:false};
 const placement={id:'charge-sound',eventId:'charge',assetId:run.assets[0].id,start:0.5,duration:1.25,sourceOffset:0.05,gainDb:-12,fadeIn:0.02,fadeOut:0.1,category:'foley',enabled:true};
 const edited=await api(`/api/sfx/runs/${run.id}/edit-preview`,{revision:run.revision,events:[event],placements:[placement],originalGainDb:-60,originalMuted:true,musicEnabled:false});
 const preview=await wait(edited.runId);assert.ok(preview.render);for(const [key,value] of Object.entries(placement))assert.deepEqual(preview.placements[0][key],value,key);report.checks.push('explicit edit preview renders with saved placement and fades');
 const probe=JSON.parse((await exec(ffprobe,['-v','error','-show_format','-show_streams','-of','json',preview.render.video],{windowsHide:true})).stdout);assert.ok(probe.streams.some(s=>s.codec_type==='video'));assert.ok(probe.streams.some(s=>s.codec_type==='audio'));report.preview={duration:probe.format.duration,video:preview.render.video};
 const ranged=await fetch(base+`/api/sfx/runs/${preview.id}/media/preview`,{headers:{range:'bytes=0-1023'}});assert.equal(ranged.status,206);report.rangeStatus=ranged.status;
 const projectId=preview.projectId;await api(`/api/sfx/projects/${projectId}/rename`,{name:'验收已重命名'});
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
finally{report.finished=new Date().toISOString();await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.resolve('.output/desktop-acceptance/latest.json'),JSON.stringify({...report,root},null,2));child.kill();console.log(JSON.stringify(report,null,2));}
