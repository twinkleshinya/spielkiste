import path from "node:path";
import type {SfxRun} from "./models.js";
import {isCharacterVocal} from "./ClipEdit.js";
import {similarRecordings} from "./CandidateDiversity.js";
import {SFX_WORKFLOW,WORKFLOW_STAGES} from "./WorkflowPolicy.js";
import {chargeContinuityAdvice} from "./SoundIntentReview.js";

type Check={id:string;status:"pass"|"review"|"fail";detail:string;count?:number};
export function buildWorkflowReport(run:SfxRun,usage?:{elapsedMs?:number;totals?:unknown;requests?:{phase:string;requestedModel:string;returnedModel?:string;status:number|null}[]}) {
  const assets=new Map(run.assets.map(a=>[a.id,a])),events=new Map(run.events.map(e=>[e.id,e]));
  const mutedEvents=run.events.filter(e=>e.muted);
  const enabled=run.placements.filter(p=>p.enabled&&!events.get(p.eventId)?.muted&&(p.category!=="music"||run.musicEnabled!==false));
  const roots=[run.libraryPath,...(run.musicLibraryPath?[run.musicLibraryPath]:[]),...(run.libraryPreferences||[]).map(p=>p.path)];
  const outside=enabled.filter(p=>{const a=assets.get(p.assetId);return !a||!roots.some(root=>{const relative=path.relative(path.resolve(root),path.resolve(a.path));return relative===""||relative!==".."&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);});});
  const ranges=enabled.filter(p=>{const a=assets.get(p.assetId);return !a?.usable||a.duration===undefined||p.start+p.duration>run.duration+.001||(p.loop?p.sourceOffset>=a.duration:p.sourceOffset+p.duration>a.duration+.001);});
  const fades=enabled.filter(p=>p.fadeIn<=0||p.fadeOut<=0||p.fadeIn+p.fadeOut>p.duration+.001);
  let pairs=0,duplicates=0,unmeasured=0,alternativeCount=0,layers=0;
  for(const e of run.events)for(const layer of e.layers||[]) {
    layers++;alternativeCount+=Math.max(0,layer.candidates.length-1);
    const choices=layer.candidates.map(c=>assets.get(c.assetId));unmeasured+=choices.filter(a=>!a?.acoustics).length;
    for(let i=0;i<choices.length;i++)for(let j=i+1;j<choices.length;j++){pairs++;if(choices[i]&&choices[j]&&similarRecordings(choices[i]!,choices[j]!))duplicates++;}
  }
  const action=run.events.filter(e=>!e.muted&&!["music","ambience"].includes(e.category)),covered=new Set(enabled.map(p=>p.eventId));
  const gaps=action.filter(e=>!covered.has(e.id));
  const vocal=enabled.filter(p=>isCharacterVocal(events.get(p.eventId),p,assets.get(p.assetId))&&!p.locked&&!events.get(p.eventId)?.locked);
  const vocalPending=vocal.filter(p=>p.sourceEdit?.basis!=="gemini-audio");
  const mix=run.mixReport;
  const spatial=mix?.perspective;
  const timingOk=Boolean(run.analysisReport&&/^gemini(?:-|$)/i.test(run.analysisReport.model)&&["ccswitch","gemini"].includes(run.analysisMode));
  const timingIssues=run.warnings.filter(w=>/动作查漏部分失败|部分短窗复查失败|局部接触复核失败/.test(w));
  const selectionOk=run.selectionReport?.status==="complete";
  const soundConflicts=enabled.flatMap(p=>{
    const event=events.get(p.eventId),description=run.selectionReport?.audio.find(a=>a.assetId===p.assetId);
    if(!event||!description)return [];
    const layer=event.layers?.find(l=>l.id===p.layerId);
    const advice=chargeContinuityAdvice(event,layer?.query||"",description.summary,description.tags);
    return advice.warnings.length?[`${p.start.toFixed(3)}秒 ${assets.get(p.assetId)?.fileName}：${advice.warnings.join("；")}`]:[];
  });
  const fallbackEvents=[...new Set(run.selectionReport?.decisions.filter(d=>d.basis==="fallback").flatMap(d=>d.eventIds)||[])].map(id=>events.get(id)).filter((e):e is NonNullable<typeof e>=>Boolean(e));
  const checks:Check[]=[
    ...(run.status==="failed"?[{id:"execution",status:"fail" as const,detail:`生成失败：${run.error||run.progress||"任务未完成"}`}]:[]),
    {id:"sound-intent",status:soundConflicts.length?"review":"pass",count:soundConflicts.length,detail:soundConflicts.length?soundConflicts.join("；"):"已有音频描述中未发现持续蓄力的脉冲冲突；片段描述不能代替完整试听"},
    {id:"content",status:run.events.length&&enabled.length?"pass":"review",detail:run.events.length&&enabled.length?`${run.events.length} 个点位、${enabled.length} 个启用贴片`:"尚未生成有效点位与贴片，不能视为已完成音效制作"},
    {id:"timing",status:timingOk&&!timingIssues.length?"pass":"review",count:timingIssues.length,detail:timingOk?timingIssues.length?`有 Gemini 初次点位，${timingIssues.length} 项后续复核失败，需复核；不能视为全部完成`:"有 Gemini 动作点位依据；采样帧率不等于准确率保证":"缺少完整 Gemini 点位依据"},
    {id:"sources",status:outside.length?"fail":"pass",count:outside.length,detail:outside.length?"存在指定音效/音乐目录外的已用素材":"所有启用素材来自指定目录"},
    {id:"ranges",status:ranges.length?"fail":"pass",count:ranges.length,detail:ranges.length?"源音频/视频范围或素材时长需修正":"已用素材范围有效"},
    {id:"fades",status:fades.length?fades.every(p=>p.locked||events.get(p.eventId)?.locked)?"review":"fail":"pass",count:fades.length,detail:fades.length?"部分贴片无有效淡入淡出（锁定项保留人工设置）":"启用贴片均有有效淡入淡出"},
    {id:"diversity",status:duplicates||unmeasured?"review":"pass",count:duplicates,detail:`${layers} 层、${alternativeCount} 个额外备选；${duplicates} 对近似，${unmeasured} 份未完成声学测量`},
    {id:"coverage",status:gaps.length||!action.length?"review":"pass",count:gaps.length,detail:`${action.length-gaps.length}/${action.length} 个已列动作有贴片；覆盖不等于全部动作识别正确`},
    {id:"music-ambience",status:run.events.some(e=>!e.muted&&(e.category==="music"&&!covered.has(e.id)&&run.musicEnabled!==false||e.category==="ambience"&&!covered.has(e.id)))?"review":"pass",detail:`已列音乐 ${run.events.filter(e=>e.category==="music").length} 段、环境 ${run.events.filter(e=>e.category==="ambience").length} 段；所列段落缺素材时保留复核，不强加没有画面依据的声音`},
    {id:"selection",status:selectionOk?"pass":"review",count:run.selectionReport?.fallbackLayers,detail:selectionOk?`Gemini 已完成${run.selectionReport?.scope==="selective"?"关键与疑难":"报告所列"}候选判断；其他动作保留本地规则选材`:`候选判断未完整完成${fallbackEvents.length?`：${fallbackEvents.slice(0,5).map(e=>`${e.start.toFixed(2)}秒 ${e.description}`).join("；")}`:"，请查看回退/缺失依据"}`},
    {id:"source-review",status:vocalPending.length?"review":"pass",count:vocalPending.length,detail:vocal.length?`${vocal.length-vocalPending.length}/${vocal.length} 个未锁定发声片段有 Gemini 源音频剪辑依据`:"无需要复核的未锁定角色发声片段"},
    {id:"loudness",status:mix?.measuredLufs!=null&&mix.measuredTruePeakDb!=null?Math.abs(mix.measuredLufs-mix.targetLufs)<=1&&mix.measuredTruePeakDb<=mix.truePeakDb+.2?"pass":"review":"review",detail:mix?.measuredLufs!=null?`实测 ${mix.measuredLufs} LUFS / ${mix.measuredTruePeakDb} dBTP；有效目标 ${mix.targetLufs} LUFS${spatial?.energyReserveDb?`，含距离余量 ${spatial.energyReserveDb} dB`:""}`:"尚无实际混音响度测量"},
    {id:"mix-distance",status:spatial&&spatial.knownClips+spatial.exemptClips>0&&!spatial.unknownClips?"pass":"review",count:spatial?.unknownClips,
      detail:spatial?`按可靠画面距离处理 ${spatial.knownClips} 条，其中远近减益 ${spatial.attenuatedClips} 条；${spatial.unknownClips} 条距离缺失或不确定，保留中性电平；UI/音乐/环境底床豁免 ${spatial.exemptClips} 条，锁定人工设置 ${spatial.lockedClips} 条。距离为近/中/远判断，非米数测量。`:"缺少距离混音依据；历史点位保持原样，需要新分析时再判断远近"},
    {id:"mix-density",status:mix?.peakConcurrency==null||mix.peakConcurrency>SFX_WORKFLOW.mix.density.foregroundConcurrencyReview?"review":"pass",count:mix?.peakConcurrency,
      detail:mix?.peakConcurrency==null?"尚无实际密度报告":mix.peakConcurrency>SFX_WORKFLOW.mix.density.foregroundConcurrencyReview?`前景峰值并发 ${mix.peakConcurrency}，超过${SFX_WORKFLOW.mix.density.foregroundConcurrencyReview}层；需先试听并减少装饰层，避免Boss主线被淹没`:`前景峰值并发 ${mix.peakConcurrency}，未超过密度阈值`},
    {id:"render",status:run.render&&run.render.revision===run.revision?"pass":"review",detail:run.render&&run.render.revision===run.revision?"已有与保存清单一致的预览":"预览缺失或需重新生成"},
    {id:"original-audio",status:run.originalMuted||run.originalGainDb<=-60?"pass":"review",detail:run.originalMuted?"原视频音轨数字静音，仅使用素材库音频":`原视频音轨 ${run.originalGainDb} dB${run.originalGainDb<=-60?"（历史版本近似静音）":"，可能叠加原有效果"}`}
  ];
  const stageStatus=(id:string)=>id==="timing"?timingOk?timingIssues.length?"partial":run.workflow?.timing==="reused"||run.parentRunId?"reused":"complete":"missing"
    :id==="selection"?run.selectionReport?run.workflow?.selection==="reused"||!run.workflow&&run.parentRunId?"reused":run.selectionReport.status:"missing"
    :id==="source"?run.sourceReview?run.workflow?.source==="reused"?"reused":run.sourceReview.status:(!vocal.length?"skipped":"missing")
    :id==="mix"?mix?"complete":"missing":id==="delivery"?run.render&&run.render.revision===run.revision?"complete":"pending":id==="diversity"?layers?unmeasured||duplicates?"partial":"complete":"missing":layers?"complete":"missing";
  return {version:1,runId:run.id,revision:run.revision,runStatus:run.status,error:run.error||null,progress:run.progress,generatedAt:new Date().toISOString(),profile:run.workflow||null,
    legacy:!run.workflow,baseline:run.id===SFX_WORKFLOW.referenceRunId?{reference:true,configurationReconstructed:true,note:"历史⑥版的现有报告与代码复盘，不代表重新执行新标准流程"}:undefined,
    effective:{analysisMode:run.analysisMode,timingModel:run.analysisReport?.model||null,selectionModel:run.selectionReport?.model||null,sourceModel:run.sourceReview?.model||null,reasoningEffort:run.workflow?.reasoningEffort||null,
      style:run.style,referenceWorks:run.referenceWorks,styleProfile:run.styleProfile,styleCompatibility:run.styleCompatibility,referenceStyles:run.referenceStyles||[],libraryPath:run.libraryPath,libraryPreferences:run.libraryPreferences||[],keywordPreferences:run.keywordPreferences||[],excludedLibraryPaths:run.excludedLibraryPaths||[],excludedKeywords:run.excludedKeywords||[],originalGainDb:run.originalGainDb,originalMuted:run.originalMuted===true,musicEnabled:run.musicEnabled!==false,selectionScope:run.selectionReport?.scope||run.selectionScope||null,autoMix:run.autoMix===true,addedReverb:false,preservePitch:true,preserveSpeed:true},
    usage:usage?{elapsedMs:usage.elapsedMs,totals:usage.totals,models:usage.requests?.map(r=>({phase:r.phase,requested:r.requestedModel,returned:r.returnedModel||null,status:r.status}))}:null,
    stages:WORKFLOW_STAGES.map(s=>({...s,status:stageStatus(s.id)})),
    quality:{status:checks.some(c=>c.status==="fail")?"failed":checks.some(c=>c.status==="review")?"needs-review":"checks-passed",checks,
      subjective:"自动检查通过不代表最终听感已验收。需试听预警、蓄力、吼叫、接触、UI、音乐以及裁剪边缘。"},
    counts:{events:run.events.length,mutedEvents:mutedEvents.length,placements:enabled.length,layers,alternativeCount,comparedPairs:pairs},
    artifacts:{video:"preview.mp4",audio:"preview.wav",editable:"placements.json",csv:"placements.csv",timing:"analysis-review.json",selection:"selection-report.json",source:"source-edit-report.json",mix:"mix-report.json",usage:"usage-report.json"}};
}
