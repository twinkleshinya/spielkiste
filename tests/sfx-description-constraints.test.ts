import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {analyzeTemporal} from '../src/sfx/TemporalAnalysis.js';
import {EventSchema} from '../src/sfx/models.js';
import {GeminiAudioSelector} from '../src/sfx/GeminiAudioSelector.js';
import {createPlacements} from '../src/sfx/PlacementEngine.js';
import {buildWorkflowReport} from '../src/sfx/WorkflowReport.js';
import {RunSchema} from '../src/sfx/models.js';

const event=(type:string,start=1)=>EventSchema.parse({id:type,start,end:start+.4,type,actor:'boss',phase:'motion',category:'foley',description:type,query:type,confidence:.9,evidence:'可见张嘴/举手',source:'vision',candidates:[],requiresHumanReview:true});
const media:any={sampleFrames:async(_v:string,start:number,end:number,fps:number)=>Array.from({length:Math.ceil((end-start)*fps)},(_,i)=>({start:start+i/fps,end:start+(i+1)/fps,thumbnail:'fixture.jpg'}))};

export async function testDescriptionConstraints(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-description-'));
  try{
    for(const field of ['videoDescription','soundRequirements']){
      let contractCalls=0,reviewCalls=0;
      const director={analyzeFrames:async(_frames:any[],prompt:string):Promise<unknown>=>{
        if(prompt.includes('描述要求提取')){contractCalls++;return {exclusive:true,restrictions:['仅允许猩猩叫声'],requirements:[{id:'context',text:'举手仅为定位上下文',requiresSound:false},{id:'roar',text:'猩猩吼叫一声',requiresSound:true}],conflicts:[]};}
        if(prompt.includes('描述逐项画面复核')){reviewCalls++;const current=JSON.parse(prompt.split('待复核点位JSON：')[1].split('\n')[0]);return {decisions:current.map((e:any)=>({eventId:e.id,allowed:e.type==='boss_roar',reason:e.type==='boss_roar'?'允许叫声':'只允许叫声',requirementIds:e.type==='boss_roar'?['roar']:[]})),events:[{...event('boss_roar',1.6),requirementIds:['roar'],allowed:true}],missing:[]};}
        if(prompt.includes('先理解完整视频'))return {context:'猩猩',events:[{...event('music',0),category:'music'}]};
        if(prompt.includes('短窗动作复查')||prompt.includes('动作覆盖查漏'))return {events:[]};
        return {events:[event('raise_hand')]};
      }};
      const result=await analyzeTemporal('fixture',3,root,media,director,{[field]:'只要生成叫声，猩猩举手后吼叫一声'});
      assert.deepEqual(result.events.map(e=>e.type),['boss_roar'],'exclusive description must remove other actions/music and locate a missing required roar');
      assert.equal(contractCalls,1);assert.ok(reviewCalls>0);
      const report=(result.report as any).descriptionReview;
      assert.equal(report.requirements[0].status,'located');
      assert.deepEqual(report.requirements[0].eventIds,[result.events[0].id]);
    }
    const ordinary={analyzeFrames:async(_frames:any[],prompt:string):Promise<unknown>=>{
      if(prompt.includes('描述要求提取'))return {exclusive:false,restrictions:[],requirements:[{id:'raise',text:'举手'},{id:'roar',text:'吼叫'}],conflicts:[]};
      if(prompt.includes('描述逐项画面复核')){
        const current=JSON.parse(prompt.split('待复核点位JSON：')[1].split('\n')[0]);
        return {decisions:current.map((e:any)=>({eventId:e.id,allowed:true,reason:'可见',requirementIds:e.type==='raise_hand'?['raise']:[]})),events:[{...event('boss_roar',1.6),requirementIds:['roar'],allowed:true}],missing:[]};
      }
      if(prompt.includes('先理解完整视频'))return {context:'猩猩举手后吼叫',events:[]};
      if(prompt.includes('动作覆盖查漏')||prompt.includes('短窗动作复查'))return {events:[]};
      return {events:[event('raise_hand'),event('footstep',.2)]};
    }};
    const ordinaryResult=await analyzeTemporal('fixture',3,root,media,ordinary,{videoDescription:'猩猩举手后吼叫一声'});
    assert.deepEqual(ordinaryResult.events.map(e=>e.type),['footstep','raise_hand','boss_roar'],'ordinary description preserves additional actions while covering each required action/sound');
    assert.ok(ordinaryResult.report.descriptionReview?.requirements.every(r=>r.status==='located'));
    const saved=RunSchema.parse({version:1,id:'fixture',name:'描述验收',createdAt:'now',revision:0,status:'ready',progress:'',videoPath:'v',libraryPath:root,duration:3,originalGainDb:-60,originalMuted:true,analysisMode:'ccswitch',warnings:[],scenes:[],assets:[],events:ordinaryResult.events,placements:[],analysisReport:ordinaryResult.report,descriptionConstraints:ordinaryResult.report.descriptionReview?.constraints});
    assert.equal(saved.analysisReport?.descriptionReview?.requirements.length,2,'coverage evidence survives persisted schema validation');
    assert.equal(saved.events.find(e=>e.type==='boss_roar')?.descriptionAllowed,true);
    assert.equal(buildWorkflowReport(saved).quality.checks.find(c=>c.id==='description-coverage')?.status,'review','located points without playable assets cannot be reported as fulfilled');
    const emptyLinks=structuredClone(saved);
    for(const requirement of emptyLinks.analysisReport!.descriptionReview!.requirements){requirement.status='located';requirement.eventIds=[];}
    assert.equal(buildWorkflowReport(emptyLinks).quality.checks.find(c=>c.id==='description-coverage')?.status,'review','an empty requirement mapping cannot pass by claiming located');
    const conflict={analyzeFrames:async()=>({exclusive:true,restrictions:[],requirements:[],conflicts:['仅音乐与只要叫声冲突']})};
    await assert.rejects(analyzeTemporal('fixture',3,root,media,conflict,{videoDescription:'只要叫声',audioOutputMode:'music'}),/描述要求冲突/);
    let describedCalls=0;
    const plain={analyzeFrames:async(_frames:any[],prompt:string)=>{
      if(/描述要求提取|描述逐项画面复核/.test(prompt))describedCalls++;
      if(prompt.includes('先理解完整视频'))return {context:'空场景',events:[]};
      return {events:[]};
    }};
    await analyzeTemporal('fixture',3,root,media,plain,{});
    assert.equal(describedCalls,0,'empty descriptions use the original workflow without extra requests');
    const missing={analyzeFrames:async(_frames:any[],prompt:string):Promise<unknown>=>{
      if(prompt.includes('描述要求提取'))return {exclusive:false,restrictions:[],requirements:[{id:'bite',text:'猩猩啃咬角色'}],conflicts:[]};
      if(prompt.includes('描述逐项画面复核'))return {decisions:[],events:[],missing:[{requirementId:'bite',reason:'未看到啃咬动作'}]};
      return {context:'空场景',events:[]};
    }};
    const gap=await analyzeTemporal('fixture',3,root,media,missing,{videoDescription:'猩猩啃咬角色'});
    assert.equal((gap.report as any).descriptionReview.requirements[0].status,'not-visible');
    assert.ok(gap.warnings.some(w=>w.includes('猩猩啃咬角色')));
    const failed={analyzeFrames:async(_frames:any[],prompt:string):Promise<unknown>=>{
      if(prompt.includes('描述要求提取'))return {exclusive:true,restrictions:['只要叫声'],requirements:[],conflicts:[]};
      if(prompt.includes('描述逐项画面复核'))return {decisions:[],events:[],missing:[]};
      if(prompt.includes('先理解完整视频'))return {context:'猩猩',events:[]};
      return {events:[event('raise_hand')]};
    }};
    await assert.rejects(analyzeTemporal('fixture',3,root,media,failed,{soundRequirements:'只要叫声'}),/描述复核.*遗漏/,'incomplete model scope judgments must not silently admit extra sounds');
    const a={id:'wrong',fileName:'gorilla_roar_music.wav',path:'wrong.wav',relativePath:'wrong.wav',tags:[],usable:true,size:1,mtimeMs:1,duration:1};
    const roar={...event('boss_roar'),descriptionAllowed:true,descriptionRequirementIds:['roar'],candidates:[{assetId:a.id,score:1,reason:'名称规则'}]};
    const constraints={exclusive:true,restrictions:['只要叫声，不能有音乐'],requirements:[{id:'roar',text:'吼叫'}],conflicts:[]};
    const index:any={version:1,root:'.',generatedAt:'now',warnings:[],assets:[a],descriptionConstraints:constraints};
    const model:any={model:'test',describe:async()=>({assets:[{assetId:a.id,summary:'叫声混有音乐',tags:[],energy:.5,hasMusic:true,hasSpeech:false}]}),choose:async(tasks:any[])=>({choices:tasks.map(t=>({taskId:t.taskId,assetId:a.id,confidence:.9,reason:'混有音乐不符合范围',meetsDescription:false}))})};
    const clips:any={sample:async()=>({assetId:a.id,data:'d2F2',format:'wav',segments:[{start:0,end:1}]})};
    await new GeminiAudioSelector(model,clips).select([roar],index,{outputDir:root,cacheDir:path.join(root,'audio-cache')});
    assert.equal(createPlacements([roar],[a],3).length,0,'a candidate rejected by description scope cannot become an enabled clip');
    const invalid={...roar,layers:undefined,candidates:[{assetId:a.id,score:1,reason:'规则候选'}]};
    model.choose=async(tasks:any[])=>({choices:tasks.map(t=>({taskId:t.taskId,assetId:'invented-id',confidence:.9,reason:'不存在的素材',meetsDescription:true}))});
    await new GeminiAudioSelector(model,clips).select([invalid],index,{outputDir:root,cacheDir:path.join(root,'audio-cache')});
    assert.equal(createPlacements([invalid],[a],3).length,0,'an invented model asset must not restore unverified rule candidates');
    const fallback={...roar,layers:undefined,candidates:[{assetId:a.id,score:1,reason:'规则候选'}]};
    model.choose=async()=>{throw new Error('gateway offline')};
    await new GeminiAudioSelector(model,clips).select([fallback],index,{outputDir:root,cacheDir:path.join(root,'audio-cache')});
    assert.equal(createPlacements([fallback],[a],3).length,0,'strict scope must fail closed instead of silently keeping rule fallback');
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
