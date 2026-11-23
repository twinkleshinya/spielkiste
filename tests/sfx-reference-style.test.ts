import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CreateRunSchema,IndexSchema,EventSchema} from '../src/sfx/models.js';
import {normalizeKeywordPreferences,keywordPreferenceResolver} from '../src/sfx/LibraryPreferences.js';
import {AudioLibraryIndexer} from '../src/sfx/AudioLibraryIndexer.js';
import {StyleResearcher} from '../src/sfx/StyleResearch.js';
import {SfxRunStore,exportTimeline} from '../src/sfx/SfxRunStore.js';
import {GeminiAudioSelector,type SelectionTask} from '../src/sfx/GeminiAudioSelector.js';
import {SfxService} from '../src/sfx/SfxService.js';
import vm from 'node:vm';
import http from 'node:http';
import {handleSfxRequest} from '../src/ui/sfx-routes.js';
import {editorHarness} from './sfx-edit-preview-ui.test.js';
import {styleBlendOptions,creativeContext} from '../src/sfx/CreativeBrief.js';
import {collectStyleReferences} from '../src/sfx/StyleResearch.js';

const rule={keyword:'卡赞',weight:5,scope:'boss',purpose:'reference'};
const profile={version:1,style:'卡赞',researchedAt:'2026-11-22',model:'gemini-test',basis:'document-research',summary:'厚重粗粝的暗黑近战',references:[{title:'The First Berserker: Khazan',url:'https://example.org/khazan',excerpt:'资料中的作品定位'}],palette:['岩石','金属'],avoid:['轻薄啾声'],actionGuidance:['蓄力与重击清楚，次要细节克制'],searchTerms:['stone'],limitations:'设计推导，未试听原声'};
const event=(actor='boss')=>EventSchema.parse({id:'e',start:0,end:1,type:'impact',query:'impact',description:'砸地',category:'impact',source:'vision',confidence:.9,candidates:[],requiresHumanReview:false,actor});
const asset=(id:string,name:string)=>({id,path:`E:/Library/${name}`,relativePath:name,fileName:name,size:1,mtimeMs:1,tags:[],usable:true,duration:2});

export async function testReferenceStyleResearchAndPropagation(){
  const parsed=CreateRunSchema.parse({videoPath:'test.mp4',libraryPath:'library',keywordPreferences:[rule]});
  assert.deepEqual((parsed as any).referenceWorks,['卡赞'],'legacy works migrate into the style area');
  assert.deepEqual(parsed.keywordPreferences,[],'works must leave material keywords');
  const cleared=CreateRunSchema.parse({videoPath:'test.mp4',libraryPath:'library',referenceWorks:[],keywordPreferences:[rule]});assert.deepEqual(cleared.referenceWorks,[]);assert.deepEqual(cleared.keywordPreferences,[]);
  const normalized=normalizeKeywordPreferences([rule] as any);
  assert.equal((normalized[0] as any).purpose,'reference');
  assert.equal(keywordPreferenceResolver(normalized,event())(asset('literal','卡赞_impact.wav')),undefined,'work names must not become filename preferences');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-reference-'));let calls=0;
  try{
    const researcher=new StyleResearcher(path.join(root,'styles'),async name=>{assert.equal(name,'卡赞');return profile.references;},async prompt=>{calls++;assert.match(prompt,/指定作品|参考作品/);return profile;});
    assert.equal(typeof (researcher as any).researchWorks,'function');
    const refs=await (researcher as any).researchWorks(['卡赞'],'gemini-test','high');
    await (researcher as any).researchWorks(['卡赞'],'gemini-test','high');assert.equal(calls,1,'work research must use its cache');
    assert.equal(refs[0].profile.summary,profile.summary);assert.equal(refs[0].scope,undefined);assert.equal(refs[0].weight,undefined);
    assert.deepEqual(await (researcher as any).researchWorks([],'gemini-test','high'),[]);
    const lib=IndexSchema.parse({version:1,root:'E:/Library',generatedAt:'now',warnings:[],assets:[asset('generic','impact_wood.wav'),asset('style','impact_stone.wav'),asset('irrelevant','stone_bird.wav')],keywordPreferences:normalized,referenceStyles:refs});
    const search=new AudioLibraryIndexer();assert.equal(search.search(lib,'impact',5,event())[0].asset.id,'style','researched terms boost fitting action candidates');
    assert.deepEqual(search.search({...lib,referenceStyles:[{...refs[0],weight:10,scope:'boss'}]},'impact',5,event('player')),search.search(lib,'impact',5,event('player')),'historical work weight/scope must not affect matching');
    assert.equal(search.search(lib,'impact',5,event('player'))[0].asset.id,'style','reference works guide the overall style without actor weights');
    assert.ok(search.search(lib,'impact',5,event())[0].score>search.search({...lib,referenceStyles:[]},'impact',5,event())[0].score,'style must actually influence ranking');
    assert.ok(!search.search(lib,'impact',5,event()).some(r=>r.asset.id==='irrelevant'),'style cannot replace action relevance');
    const store=new SfxRunStore(path.join(root,'runs')),run=await store.createRun({videoPath:'test.mp4',libraryPath:'library',referenceWorks:['卡赞'],keywordPreferences:normalized});
    (run as any).referenceStyles=refs;await store.save(run);const saved=await store.readRun(run.id);assert.deepEqual((saved as any).referenceStyles,refs);assert.deepEqual(saved.referenceWorks,['卡赞']);assert.deepEqual(saved.keywordPreferences,undefined);
    await exportTimeline(saved,store.directory(saved.id));assert.deepEqual(JSON.parse(await fs.readFile(path.join(store.directory(saved.id),'placements.json'),'utf8')).referenceStyles,refs);
    const ev=event();ev.candidates=[{assetId:'style',score:4,reason:'impact'}];let sent:SelectionTask[]=[];
    const selector=new GeminiAudioSelector({model:'test',describe:async()=>({assets:[{assetId:'style',summary:'厚重石头冲击',tags:['stone'],energy:.8,hasMusic:false,hasSpeech:false}]}),choose:async tasks=>{sent=tasks;return {choices:tasks.map(t=>({taskId:t.taskId,assetId:'style',reason:'符合参考作品的粗粝重击',confidence:.9}))};}},{sample:async()=>({assetId:'style',data:'test',format:'wav',segments:[{start:0,end:2}]})});
    await selector.select([ev],lib,{outputDir:root,cacheDir:path.join(root,'audio-cache')});assert.deepEqual((sent[0].creativeBrief as any).referenceStyles,refs,'Gemini must receive actual researched profile and scope');
  }finally{await fs.rm(root,{recursive:true,force:true});}
}

export async function testReferenceStyleReanalysisInput(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-reference-reanalysis-'));
  try{
    const service=new SfxService(root),run=await service.store.createRun({videoPath:'demo.mp4',libraryPath:'library'});run.status='ready';run.referenceWorks=['卡赞'];run.referenceStyles=[{keyword:'卡赞',profile:profile as any}];await service.store.save(run);
    const edited=await service.update(run.id,{revision:run.revision,events:run.events,placements:run.placements,originalGainDb:run.originalGainDb,keywordPreferences:[{keyword:'金属',weight:3,scope:'all'}]});assert.deepEqual(edited.referenceWorks,['卡赞']);assert.deepEqual(edited.referenceStyles,run.referenceStyles,'editing material preferences must retain work research');
    let captured:any;(service as any).create=async(input:any)=>{captured=input;return {runId:'new'}};
    await service.reanalyze(run.id,{mode:'brief',referenceWorks:['卡赞'],keywordPreferences:[{keyword:'金属',weight:3,scope:'all'}]});assert.deepEqual(captured.referenceWorks,['卡赞']);assert.equal(captured.keywordPreferences[0].keyword,'金属');
    await service.reanalyze(run.id,{mode:'brief',referenceWorks:[],keywordPreferences:[]});assert.deepEqual(captured.referenceWorks,[],'clearing references must be respected');
  }finally{await fs.rm(root,{recursive:true,force:true});}
}

export async function testReferenceStyleTitleResolution(){
  const before=globalThis.fetch;const urls:string[]=[];
  globalThis.fetch=async(input:any)=>{const url=String(input);urls.push(url);return {ok:true,json:async()=>({query:{pages:{'1':{pageid:1,title:'The First Berserker: Khazan',extract:'Game reference information. '.repeat(20)}}}})} as Response;};
  try{const refs=await collectStyleReferences('卡赞',undefined,'work');assert.equal(refs[0].title,'The First Berserker: Khazan');assert.equal(urls.length,1);assert.equal(new URL(urls[0]).searchParams.get('titles'),'The First Berserker: Khazan','short title must resolve the actual work, not a generic fantasy search');}
  finally{globalThis.fetch=before;}
}

export async function testReferenceStyleKeywordUi(){
  const fields=['.preference-keyword','.preference-scope','.preference-weight','.preference-remove'];let changes=0;
  const row=()=>{const values=new Map(fields.map(key=>[key,{value:'',placeholder:'',disabled:false}]));return {className:'',innerHTML:'',querySelector:(key:string)=>values.get(key),addEventListener(){},remove(){}};};
  const container={children:[] as any[],append(value:any){this.children.push(value);},replaceChildren(){this.children=[];},querySelectorAll(){return [];}},add:any={};
  const source=await fs.readFile('src/ui/public/sfx-library-preferences.js','utf8');const context=vm.createContext({document:{getElementById:()=>add,createElement:row},container,options:{isBusy:()=>false,onChange:()=>changes++}});
  vm.runInContext(source.replace(/export /g,'')+';globalThis.ui=createKeywordPreferences(container,options);',context);
  const ui=context.ui;ui.load([rule,{keyword:'metal',weight:3,scope:'all'}]);assert.equal(container.children.length,1,'legacy works must not appear as material keyword rows');assert.deepEqual(JSON.parse(JSON.stringify(ui.read())),[{keyword:'metal',weight:3,scope:'all'}]);
  assert.doesNotMatch(container.children[0].innerHTML,/preference-purpose|作品名称/);
  const editor=await editorHarness();editor.$('reference-works').value='卡赞';editor.$('sound-style').value='暗黑奇幻';
  await editor.$('analyze').onclick({preventDefault(){}});
  assert.deepEqual(editor.calls.find(c=>c.url==='/api/sfx/runs')!.body.referenceWorks,['卡赞']);
  const legacy=editor.getRun();(legacy as any).keywordPreferences=[rule,{keyword:'metal',weight:3,scope:'all'}];editor.context.fixture=legacy;
  editor.exec('run=fixture;loadProjectInputs()');assert.equal(editor.$('reference-works').value,'卡赞');
  assert.equal(editor.exec('keywordPreferences.read().length'),1);
  assert.deepEqual(editor.getRun().placements,legacy.placements,'migration must preserve saved audio');
  editor.$('reference-works').value='';await editor.$('reanalyze-brief').onclick({preventDefault(){}});assert.deepEqual(editor.calls.find(c=>c.url.endsWith('/reanalyze'))!.body.referenceWorks,[],'clearing works must be sent explicitly');
  const remembered=await editorHarness(new Map([['sfx-last-input',JSON.stringify({keywordPreferences:[rule]})]]));remembered.exec('resetToNewProject()');assert.equal(remembered.$('reference-works').value,'','new projects never inherit legacy references');
}


export async function testStyleConflictNeedsUserClarification(){
  const module=await import('../src/sfx/StyleResearch.js') as any;
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-style-conflict-'));
  let checks=0;const brief={style:'修仙',referenceWorks:['卡赞'],styleProfile:{...profile,style:'修仙'},referenceStyles:[{keyword:'卡赞',profile}]};
  try{
    const researcher=new module.StyleResearcher(root,async()=>profile.references,async(prompt:string)=>{
      checks++;assert.match(prompt,/最多.*3/);assert.match(prompt,/用户.*声音要求/);assert.match(prompt,/音色、材质、动态、空间、音乐、节奏全部六个维度/);
      const clarified=prompt.includes('以卡赞为整体风格，只参考修仙的空灵感');
      return {conflicts:[{left:'修仙',right:'卡赞',aspect:'timbre',resolvedByRequirements:clarified}],suggestions:[{title:'暗黑骨架与空灵尾音',requirements:'以卡赞为整体风格，只参考修仙的空灵感'}]};
    });
    assert.equal(styleBlendOptions([{},...Array.from({length:5},(_,i)=>({title:`方向${i}`,requirements:`声音要求${i}`}))]).length,3);
    assert.equal(typeof researcher.checkCompatibility,'function','style conflict gate must exist');
    const first=await researcher.checkCompatibility(brief,'gemini-test','high');assert.equal(first.conflicts[0].resolvedByRequirements,false);assert.equal(first.suggestions.length,1);assert.match(first.suggestions[0].requirements,/卡赞/);
    assert.doesNotMatch(creativeContext({...brief,styleCompatibility:first} as any),/暗黑骨架与空灵尾音/,'unchosen options cannot enter generation context');
    await researcher.checkCompatibility(brief,'gemini-test','high');assert.equal(checks,1,'identical check must reuse cache');
    const vague=await researcher.checkCompatibility({...brief,soundRequirements:'大声一点'},'gemini-test','high');assert.equal(vague.conflicts[0].resolvedByRequirements,false);
    const resolved=await researcher.checkCompatibility({...brief,soundRequirements:'以卡赞为整体风格，只参考修仙的空灵感'},'gemini-test','high');assert.equal(resolved.conflicts[0].resolvedByRequirements,true);assert.deepEqual(resolved.suggestions,[]);assert.equal(checks,3);
    await researcher.checkCompatibility({...brief,styleProfile:{...profile,style:'修仙',summary:'更新后的风格'}},'gemini-test','high');assert.equal(checks,4,'changed research invalidates compatibility cache');
    const alone=await researcher.checkCompatibility({styleProfile:profile},'gemini-test','high');assert.deepEqual(alone.conflicts,[]);assert.equal(checks,4);
    const duplicate=await researcher.checkCompatibility({styleProfile:profile,referenceStyles:[{keyword:'卡赞',profile}]},'gemini-test','high');assert.deepEqual(duplicate.conflicts,[]);assert.equal(checks,4,'same reference entered twice cannot conflict with itself');
    const failed=new module.StyleResearcher(path.join(root,'failed'),async()=>profile.references,async()=>{throw new Error('gateway failed')});
    await assert.rejects(failed.checkCompatibility(brief,'gemini-test','high'),/gateway failed/,'failed check cannot silently pass');
    const service=new SfxService(path.join(root,'output'));let submitted=0;
    service.styles=researcher;(service.store as any).createRun=async()=>{submitted++;throw new Error('must not create run')};
    const video=path.join(root,'test.mp4'),library=path.join(root,'library');await fs.writeFile(video,'fake video');await fs.mkdir(library);
    (researcher as any).research=async(name:string)=>({...profile,style:name});
    const check=service.checkStyleDirection.bind(service);(service as any).checkStyleDirection=(input:any)=>check(input,{model:'gemini-test'});
    await assert.rejects(check(brief,{model:'gemini-test'}),(e:any)=>e.code==='STYLE_CONFLICT'&&e.suggestions.length===1);
    const approved=await check({...brief,soundRequirements:'以卡赞为整体风格，只参考修仙的空灵感'},{model:'gemini-test'});assert.equal(approved.styleCompatibility!.conflicts[0].resolvedByRequirements,true);
    await assert.rejects(service.create({videoPath:video,libraryPath:library,style:'修仙',referenceWorks:['卡赞'],workflowPreset:'custom',analysisMode:'scene',reusePreserved:false}),/冲突/);assert.equal(submitted,0,'conflicts must stop before creating/scanning a run');
  }finally{await fs.rm(root,{recursive:true,force:true});}
}

export async function testStyleConflictBrowserClarification(){
  const ui=await editorHarness();ui.$('sound-style').value='修仙';ui.$('reference-works').value='卡赞';ui.$('sound-requirements').value='保留关键蓄力';
  const suggestions=Array.from({length:4},(_,i)=>({title:`混合方式${i+1}`,requirements:`明确混合方向${i+1}`}));let requests:any[]=[];
  ui.context.fetch=async(url:string,options:any)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:false,status:409,json:async()=>({error:'声音方向存在冲突，请确认混合方式或补充声音要求。',code:'STYLE_CONFLICT',conflicts:[{left:'修仙',right:'卡赞',aspect:'timbre',resolvedByRequirements:false}],suggestions})};};
  await ui.$('analyze').onclick({preventDefault(){}});
  assert.equal(ui.$('style-conflict-panel').hidden,false);assert.match(ui.$('style-conflict').textContent,/冲突/);
  const choices=ui.$('style-conflict-options').children;
  assert.equal(choices.length,3,'show at most three blend options');
  assert.equal(ui.$('style-conflict-custom').value,'','custom requirements start blank');
  assert.equal(choices.some((n:any)=>n.children[0].checked),false,'no default selection');
  assert.equal(ui.$('sound-requirements').value,'保留关键蓄力');
  await ui.$('apply-style-conflict').onclick({preventDefault(){}});assert.equal(requests.length,1,'blank confirmation cannot bypass conflict');
  choices[0].children[0].onchange();assert.equal(requests.length,1,'selection never starts a request');
  let checkedBody:any;ui.context.fetch=async(url:string,options:any)=>{checkedBody=JSON.parse(options.body);requests.push({url,body:checkedBody});return {ok:true,json:async()=>({styleCompatibility:{conflicts:[]}})};};
  await ui.$('apply-style-conflict').onclick({preventDefault(){}});
  assert.equal(requests.at(-1).url,'/api/sfx/styles/check');assert.match(checkedBody.soundRequirements,/保留关键蓄力/);assert.match(checkedBody.soundRequirements,/明确混合方向1/);
  assert.equal(ui.$('style-conflict-panel').hidden,true);assert.equal(ui.$('sound-requirements').value,checkedBody.soundRequirements);
  assert.equal(requests.filter(r=>r.url==='/api/sfx/runs').length,1,'confirmation only checks, never generates');assert.equal(ui.$('workspace').hidden,false,'existing preview is retained');assert.equal(ui.isDirty(),false);
  ui.exec(`handleRequestError({code:'STYLE_CONFLICT',message:'冲突',suggestions:[{title:'另一种',requirements:'新的混合方向'}]})`);
  ui.$('style-conflict-options').children[0].children[0].onchange();await ui.$('apply-style-conflict').onclick({preventDefault(){}});
  assert.match(checkedBody.soundRequirements,/保留关键蓄力/);assert.match(checkedBody.soundRequirements,/新的混合方向/);assert.doesNotMatch(checkedBody.soundRequirements,/明确混合方向1/,'changing blend replaces prior confirmed blend without discarding original requirements');
  ui.exec(`handleRequestError({code:'STYLE_CONFLICT',message:'冲突',suggestions:[]})`);
  ui.$('style-conflict-custom').value='按我的要求重新定义声音方向';
  await ui.$('apply-style-conflict').onclick({preventDefault(){}});assert.match(checkedBody.soundRequirements,/按我的要求/);
  ui.exec(`handleRequestError({code:'STYLE_CONFLICT',message:'冲突',suggestions:[]})`);ui.$('style-conflict-custom').value='仅仅小声';
  ui.context.fetch=async()=>({ok:false,status:409,json:async()=>({code:'STYLE_CONFLICT',error:'仍有冲突'})});
  await ui.$('apply-style-conflict').onclick({preventDefault(){}});assert.equal(ui.$('style-conflict-panel').hidden,false);assert.equal(ui.$('style-conflict-custom').value,'仅仅小声','failed recheck retains custom input');
}

export async function testStyleConflictApiResponse(){
  const service={checkStyleDirection:async(input:any)=>{
    assert.equal(input.soundRequirements,'音量大一点');
    const e:any=new Error('「修仙」与「卡赞」的音色存在冲突。请在“声音要求”中补充具体要求后重试。');
    const {SfxError}=await import('../src/sfx/models.js');throw Object.assign(new SfxError(e.message,409),{code:'STYLE_CONFLICT',conflicts:[{left:'修仙',right:'卡赞',aspect:'timbre',resolvedByRequirements:false}],suggestions:Array.from({length:4},(_,i)=>({title:`方式${i}`,requirements:`具体方向${i}`}))});
  }};
  const server=http.createServer((req,res)=>{void handleSfxRequest(req,res,new URL(req.url!,'http://localhost'),service as any);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/sfx/styles/check`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({style:'修仙',referenceWorks:['卡赞'],soundRequirements:'音量大一点',approved:true})});
    assert.equal(response.status,409);const body=await response.json() as any;assert.equal(body.code,'STYLE_CONFLICT');assert.equal(body.conflicts.length,1);assert.equal(body.suggestions.length,3);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
