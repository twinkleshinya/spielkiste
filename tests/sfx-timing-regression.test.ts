import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventSchema} from '../src/sfx/models.js';
import {LayerPlanner} from '../src/sfx/LayerPlanner.js';
import {analyzeTemporal,mergeWindowEvents} from '../src/sfx/TemporalAnalysis.js';
import {eventsForOutputMode} from '../src/sfx/SfxRenderer.js';
import {CcSwitchAudioProvider} from '../src/sfx/CcSwitchAudioProvider.js';
import {planEventCandidates} from '../src/sfx/CandidatePlanner.js';
import {SfxService} from '../src/sfx/SfxService.js';
import {editorHarness} from './sfx-edit-preview-ui.test.js';
import {planAutoMix} from '../src/sfx/AutoMix.js';
import {createPlacements} from '../src/sfx/PlacementEngine.js';
const cue=(extra:Record<string,unknown>={})=>EventSchema.parse({id:'step',start:1,end:1.3,type:'boss_step',actor:'boss',phase:'contact',category:'impact',description:'巨兽正常迈步，踩在泥土地面',query:'monster footstep dirt ground',confidence:.9,source:'vision',candidates:[],requiresHumanReview:true,...extra});

export function testOrdinaryStepsDoNotAddDebris(){
  for(const type of ['boss_step','monster_walk_step','boss_footstep'])assert.equal(new LayerPlanner().planLayers(cue({type})).length,1,'ordinary steps cannot add a debris impact just because the ground is mentioned');
  assert.equal(mergeWindowEvents([[cue({type:'boss_step'})],[cue({id:'other',type:'footstep',start:1.03})]]).length,1,'same foot contact cannot be doubled by step/footstep synonyms across passes');
  assert.equal(mergeWindowEvents([[cue(),cue({id:'next',start:1.15,end:1.45})]]).length,2,'rapid distinct footsteps from one pass must survive');
}

export function testChestMovementDoesNotSearchForImpact(){
  const event=cue({type:'chest_pound',phase:'motion',category:'foley',description:'巨猿结束连续捶胸，上身前倾，手臂下垂收回',query:'heavy creature arm movement'});
  const assets=['chestpound_impact.wav','monster_arm_movement.wav'].map((fileName,i)=>({id:String(i),fileName,path:fileName,relativePath:fileName,tags:[],usable:true,size:1,mtimeMs:1,duration:1}));
  planEventCandidates(event,{version:1,root:'.',generatedAt:'now',assets,warnings:[]});
  assert.equal(event.candidates[0]?.assetId,'1','a generic chest_pound type cannot override explicit noncontact recovery motion');
}

export async function testOutputModeTimingAndReviewSafety(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-mode-review-'));
  try{
    const media:any={sampleFrames:async(_v:string,start:number,end:number,fps:number)=>Array.from({length:Math.ceil((end-start)*fps)},(_,i)=>({start:start+i/fps,end:Math.min(end,start+(i+1)/fps),thumbnail:'fixture.jpg'}))};
    for(const mode of ['all','sfx'] as const){
      const director={analyzeFrames:async(_f:unknown[],prompt:string)=>{
        if(prompt.includes('描述要求提取'))return {exclusive:false,restrictions:[],requirements:[],conflicts:[]};
        if(prompt.includes('先理解完整视频'))return {context:'巨兽移动',events:[]};
        if(prompt.includes('动作覆盖查漏'))return {events:[]};
        if(prompt.includes('短窗动作复查')){
          const existing=JSON.parse(prompt.split('现有清单：')[1].split('。')[0]);
          return {replaceEventIds:existing.map((e:any)=>e.id),events:[cue({id:'new',type:'player_move',actor:'player',phase:'motion',category:'foley',start:.2,end:.4})]};
        }
        if(prompt.includes('描述逐项画面复核')){
          const existing=JSON.parse(prompt.split('待复核点位JSON：')[1].split('\n')[0]);
          return {decisions:existing.map((e:any)=>({eventId:e.id,allowed:true,reason:'可见',requirementIds:[]})),events:[],missing:[]};
        }
        if(prompt.includes('逐帧复核'))return {visible:true,start:1,end:1.3,evidence:'可见',confidence:.9};
        assert.equal(prompt.split('制作要求（').length-1,1,'creative brief must be appended once per analysis request');
        return {events:[cue({type:'boss_roar',phase:'motion',category:'other'})]};
      }};
      const result=await analyzeTemporal('fixture',3,path.join(root,mode),media,director,{audioOutputMode:mode,musicEnabled:mode==='all',style:'暗黑奇幻'});
      assert.ok(eventsForOutputMode({audioOutputMode:mode},result.events).some(e=>e.type==='boss_roar'),'an unrelated player correction must not erase the boss roar');
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
}

export async function testAudioSelectionDoesNotInventPurityScope(){
  const provider=new CcSwitchAudioProvider();
  let payload:any;
  (provider as any).request=async(content:unknown)=>{payload=content;return {choices:[]};};
  await provider.choose([]);
  const prompt=JSON.stringify(payload);
  assert.ok(prompt.includes('exclusive=true'),'purity examples must be explicitly conditional on actual exclusive scope');
  assert.ok(prompt.includes('不能把普通描述升级'),'ordinary short-roar requirements cannot become an unrequested purity ban');
}

export async function testVisualReanalysisRetainsSoundDirection(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-reanalysis-'));
  try{
    const service=new SfxService(root),run=await service.store.createRun({videoPath:'v.mp4',libraryPath:root});
    Object.assign(run,{status:'ready',soundRequirements:'短促凶猛的吼叫',style:'暗黑奇幻'});await service.store.save(run);
    let captured:any;(service as any).create=async(input:any)=>{captured=input;return {runId:'new'};};
    await service.reanalyze(run.id,{mode:'visual'});
    assert.equal(captured.soundRequirements,run.soundRequirements,'visual reanalysis must retain explicit sound requirements');
    assert.equal(captured.style,run.style);
    const ui=await editorHarness();ui.$('reanalyze-sound-requirements').value='短促凶猛的吼叫';ui.$('reanalyze-sound-style').value='暗黑奇幻';
    await ui.$('reanalyze-visual').onclick({preventDefault(){}});
    const body=ui.calls.find(c=>c.url.endsWith('/reanalyze'))!.body;
    assert.equal(body.soundRequirements,'短促凶猛的吼叫','browser must not silently clear the requested sound direction');
    assert.equal(body.style,'暗黑奇幻');
  }finally{await fs.rm(root,{recursive:true,force:true});}
}

export function testExcludedAudioDoesNotAffectMix(){
  const sfx=cue({id:'sfx',type:'boss_roar',phase:'motion',category:'other',importance:'key'}),music=cue({id:'music',type:'music_cue',category:'music',start:0,end:3});
  const assets=[{id:'sfx',fileName:'roar.wav',path:'roar.wav',relativePath:'roar.wav',size:1,mtimeMs:1,tags:[],usable:true,duration:3,rmsDb:-23,peakDb:-6},{id:'music',fileName:'music.wav',path:'music.wav',relativePath:'music.wav',size:1,mtimeMs:1,tags:[],usable:true,duration:3,rmsDb:-20,peakDb:-2}];
  sfx.candidates=[{assetId:'sfx',score:1,reason:'声音'}];music.candidates=[{assetId:'music',score:1,reason:'音乐'}];
  const placements=createPlacements([sfx,music],assets,3);
  const expected=planAutoMix({duration:3,events:[sfx,music],assets,placements:placements.filter(p=>p.category==='music')});
  const actual=planAutoMix({duration:3,events:[sfx,music],assets,placements,audioOutputMode:'music'} as any);
  assert.equal(actual.ducks.length,expected.ducks.length,'excluded effects cannot duck a music-only output');
}
