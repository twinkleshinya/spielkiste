import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GeminiAudioSelector} from '../src/sfx/GeminiAudioSelector.js';
import {EventSchema, type AudioAsset} from '../src/sfx/models.js';
import {createPlacements} from '../src/sfx/PlacementEngine.js';
import {clientRunPayload} from '../src/sfx/SfxRunStore.js';
import {fixtureRun} from './sfx-reaper-export.test.js';
import {editorHarness} from './sfx-edit-preview-ui.test.js';

export async function testAlternativesSurviveStrictSelection(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-alternatives-'));
 try{
 const assets:AudioAsset[]=['deep','rough','airy','dry','short'].map(id=>({id,fileName:`creature_${id}_roar.wav`,path:id,relativePath:id,size:1,mtimeMs:1,tags:[],usable:true,duration:2}));
 const candidates=assets.map(a=>({assetId:a.id,score:10,reason:'声音意图初筛'}));
 const event=EventSchema.parse({id:'voice',start:1,end:2,type:'boss_vocal',description:'低吼',query:'roar',category:'foley',source:'vision',confidence:1,requiresHumanReview:false,descriptionRequirementIds:['voice'],candidates,layers:[{id:'main',role:'foley',query:'roar',offset:0,candidates}]});
 let reject=false;
 const model={model:'test',async describe(samples:any[]){return {assets:samples.map(s=>({assetId:s.assetId,summary:'低沉吼叫',tags:[],energy:.5,hasMusic:false,hasSpeech:false}))};},async choose(tasks:any[]){return {choices:tasks.map(t=>({taskId:t.taskId,assetId:reject?null:'deep',confidence:.9,reason:'片段符合',meetsDescription:!reject}))};}};
 const index={version:1 as const,root,generatedAt:'now',assets,warnings:[],descriptionConstraints:{exclusive:true,restrictions:[],requirements:[{id:'voice',text:'低吼',requiresSound:true}],conflicts:[]}};
 const selector=new GeminiAudioSelector(model,{async sample(a){return {assetId:a.id,data:'d2F2',format:'wav',segments:[{start:0,end:2}]};}});
 await selector.select([event],index,{outputDir:root,cacheDir:path.join(root,'cache')});
 assert.equal((event.layers![0] as any).alternatives?.length,5,'strict choice must retain all five audition alternatives');
 assert.equal(createPlacements([event],assets,3)[0]?.assetId,'deep');
 reject=true;event.layers![0].candidates=candidates;
 await selector.select([event],index,{outputDir:root,cacheDir:path.join(root,'cache')});
 assert.equal(createPlacements([event],assets,3).length,0,'audition alternatives must never bypass Gemini rejection');
 assert.equal((event.layers![0] as any).alternatives.length,5);
 const run=fixtureRun(root);run.assets=assets;run.placements=[];run.events=[EventSchema.parse(event)];
 assert.equal(clientRunPayload(run).assets.length,5,'compact browser payload must include audition assets');
 }finally{await fs.rm(root,{recursive:true,force:true});}
}

export async function testAlternativeCardsKeepPreviewAndStageReplacement(){
 const ui=await editorHarness();
 ui.exec(`run.events[0].layers=[{id:'main',role:'foley',query:'roar',offset:0,candidates:[{assetId:'boss-roar',score:1,reason:'selected'}],alternatives:[{assetId:'player-charge',score:0,reason:'待试听'}]}];renderCandidates();`);
 // The DOM harness retains text nodes and buttons as ordinary objects.
 const names=JSON.stringify(ui.$('candidates').children);
 assert.ok(names.includes('player_charge.wav'),'audition alternatives must be visible next to selected clip');
 assert.equal(ui.isDirty(),false);assert.equal(ui.$('video').src,'accepted-preview.mp4');
 const before=ui.getRun().placements.filter((p:any)=>p.eventId!=='boss-event');
 await ui.exec(`chooseAsset(run.assets.find(a=>a.id==='player-charge'),'main')`);
 assert.equal(ui.isDirty(),true);assert.deepEqual(ui.getRun().placements.filter((p:any)=>p.eventId!=='boss-event'),before);
 assert.equal(ui.calls.some(c=>c.url.endsWith('/edit-preview')),false);
 assert.equal(ui.$('video').src,'accepted-preview.mp4');
}

export async function testLegacyAlternativesLoadWithoutEditing(){
 const ui=await editorHarness();
 ui.exec(`run.events[0].layers=[{id:'main',role:'foley',query:'roar',offset:0,candidates:[]}];`);
 const before=ui.getRun();
 const asset=before.assets[1];
 ui.context.searchResult={assetId:asset.id,score:5,reason:'名称参考',asset};
 ui.exec(`fetch=async()=>({ok:true,json:async()=>[searchResult]});`);
 await ui.exec(`loadEventAlternatives(run.events[0])`);
 assert.equal(ui.getRun().events[0].layers[0].alternatives[0].assetId,asset.id);
 assert.equal(ui.getRun().events[0].layers[0].candidates.length,0,'legacy metadata repair must not create automatic choices');
 assert.deepEqual(ui.getRun().placements,before.placements);
 assert.equal(ui.isDirty(),false);assert.equal(ui.$('video').src,'accepted-preview.mp4');
 await ui.$('search').onclick();
 assert.equal(ui.isDirty(),false,'manual candidate search must not edit the saved timeline');
 assert.deepEqual(ui.getRun().placements,before.placements);
}

export async function testAlternativeSearchesAreSerialized(){
 const ui=await editorHarness();
 ui.exec(`for(const e of run.events.slice(0,2))e.layers=[{id:'main',role:'foley',query:'roar',offset:0,candidates:[]}];`);
 let active=0,maxActive=0;
 ui.context.fetch=async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return {ok:true,json:async()=>[]};};
 await ui.exec(`Promise.all([loadEventAlternatives(run.events[0]),loadEventAlternatives(run.events[1])])`);
 assert.equal(maxActive,1,'fast point switching must not issue competing searches against the same project lock');
 assert.equal(ui.isDirty(),false);
}
