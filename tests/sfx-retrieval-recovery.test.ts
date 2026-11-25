import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AudioLibraryIndexer} from '../src/sfx/AudioLibraryIndexer.js';
import {GeminiAudioSelector,type AudioSelectionModel} from '../src/sfx/GeminiAudioSelector.js';
import {EventSchema,type AudioAsset} from '../src/sfx/models.js';
import {selectReviewEvents} from '../src/sfx/SelectionPolicy.js';

const asset=(id:string,name:string):AudioAsset=>({id,fileName:name,relativePath:name,path:name,size:12,mtimeMs:1,tags:[],usable:true,duration:2});
export async function testVocalIntentRetrieval(){
 const assets=[asset('noise','light_fireball_loop.wav'),asset('voice','creature_grunt.wav'),asset('roar','monster_bellow.wav')];
 const index={version:1 as const,root:'.',generatedAt:'now',assets,warnings:[]};
 for(const query of ['light ape grunt','吼叫','低吼'])assert.notEqual(new AudioLibraryIndexer().search(index,query,3)[0]?.asset.id,'noise',query+' must prioritize vocal intention over light');
 const preferred=asset('preferred','preferred/yetuga_roar.wav');
 assert.equal(new AudioLibraryIndexer().search({...index,assets:[...assets,preferred],keywordPreferences:[{keyword:'yetuga',weight:5,scope:'all'}]},'light ape grunt',3)[0]?.asset.id,'preferred','literal grunt must not exclude a preferred equivalent roar');
 const voice=asset('vocal','vo_yetuga_roar.wav'),foley=asset('body','efx_yetuga_roar_foley.wav');
 assert.equal(new AudioLibraryIndexer().search({...index,assets:[foley,voice]},'light ape grunt',2)[0]?.asset.id,'vocal','the vocal recording should precede movement foley named after a roar');
 const event=EventSchema.parse({id:'v',start:1,end:2,type:'boss_vocalization',description:'巨猿低沉叫声',query:'light ape grunt',category:'foley',source:'vision',confidence:.9,requiresHumanReview:true,candidates:[]});
 assert.equal(selectReviewEvents([event],'selective').length,1,'vocalizations with no initial candidates still require audio review');
}
export async function testAudioRecoveryHearsUnnamedAndHonorsExclusions(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-recover-'));
 try{
 const assets=[asset('bad','light_fireball_loop.wav'),asset('good','clip_A17.wav'),asset('excluded','blocked_voice.wav')];
 const event=EventSchema.parse({id:'v',start:1,end:2,type:'boss_vocal',description:'猩猩低吼',query:'light ape grunt',category:'foley',source:'vision',confidence:.9,requiresHumanReview:true,descriptionRequirementIds:['roar'],candidates:[{assetId:'bad',score:1,reason:'name'}],layers:[{id:'v-main',role:'foley',query:'grunt',offset:0,candidates:[{assetId:'bad',score:1,reason:'name'}]}]});
 let discoveries=0;const heard:string[]=[];
 const model:AudioSelectionModel={model:'test',async describe(samples){heard.push(...samples.map(s=>s.assetId));return {assets:samples.map(s=>({assetId:s.assetId,summary:s.assetId==='good'?'低沉动物吼叫':'激光噪声',tags:[],energy:.5,hasMusic:false,hasSpeech:false}))};},async choose(tasks,_signal,samples){for(const t of tasks)for(const c of t.candidates)assert.ok(samples?.some(s=>s.assetId===c.assetId),'the final choice must receive real audio, including cached captions');return {choices:tasks.map(t=>({taskId:t.taskId,assetId:t.candidates.some(c=>c.assetId==='good')?'good':null,meetsDescription:t.candidates.some(c=>c.assetId==='good'),reason:'实际音频判断',confidence:.9}))};},async discover(tasks,catalogue){discoveries++;assert.ok(!catalogue.some(c=>c.assetId==='excluded'));return {recoveries:tasks.map(t=>({taskId:t.taskId,queries:['creature vocal'],assetIds:['excluded','good']}))};}};
 const selector=new GeminiAudioSelector(model,{async sample(a){return {assetId:a.id,data:'d2F2',format:'wav',segments:[{start:0,end:2}]};}});
 const index={version:1 as const,root:'.',generatedAt:'now',assets,warnings:[],excludedKeywords:['blocked'],descriptionConstraints:{exclusive:true,restrictions:[],requirements:[{id:'roar',text:'吼叫',requiresSound:true}],conflicts:[]}};
 const report=await selector.select([event],index,{outputDir:root,cacheDir:path.join(root,'cache')});
 assert.equal(discoveries,1);assert.ok(heard.includes('good'),'unnamed candidate must be heard before selection');assert.ok(!heard.includes('excluded'));
 assert.equal(event.layers![0].candidates[0]?.assetId,'good');assert.equal(report.selectedLayers,1);assert.equal(report.rejectedLayers,0);
 event.layers![0].candidates=[];event.candidates=[];
 await selector.select([event],index,{outputDir:root,cacheDir:path.join(root,'cache')});
 assert.equal(event.layers![0].candidates[0]?.assetId,'good','zero initial candidates must enter discovery too');
 const reject={...model,async choose(tasks:Parameters<AudioSelectionModel['choose']>[0]){return {choices:tasks.map(t=>({taskId:t.taskId,assetId:null,meetsDescription:false,reason:'实际不是吼叫',confidence:.9}))};}};
 event.layers![0].candidates=[];event.candidates=[];
 const failed=await new GeminiAudioSelector(reject,{async sample(a){return {assetId:a.id,data:'d2F2',format:'wav',segments:[{start:0,end:2}]};}}).select([event],index,{outputDir:root,cacheDir:path.join(root,'cache')});
 assert.equal(event.layers![0].candidates.length,0);assert.equal(failed.status,'partial');assert.ok(failed.warnings.some(w=>w.includes('声音尚未匹配')));
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
export async function testProjectSwitcherAtTop(){
 const html=await fs.readFile('src/ui/public/sfx.html','utf8');
 assert.ok(html.indexOf('id="saved-projects"')<html.indexOf('id="new-project-setup"'),'project switcher must precede project inputs');
}
