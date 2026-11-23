/** Maintained reference-v6 method. These values are executed, snapshotted and shown in the workbench. */
export const SFX_WORKFLOW = {
  id: "reference-v6", version: "1.0.7", name: "⑥版标准音效流程", model: "gemini-4-argon",
  referenceRunId: "0bb00d13-d84e-4812-9eca-9ed78b79bef9",
  timing: {fps:5,windowSeconds:6,hopSeconds:5.6,reviewFps:12,reviewSeconds:3,reviewHopSeconds:2.8,contactFps:30,maxVideoSeconds:300},
  candidates: {searchLimit:40,measuredFamilies:8,alternatives:5,durationSimilarity:.8,bandSimilarity:.985,envelopeSimilarity:.965,centroidDifference:220},
  libraryPreference:{baseWeight:1,defaultWeight:3,minWeight:1,maxWeight:10,maxPaths:12,bonusPerStep:.04,maxBonus:4,overlap:"max",relevanceFirst:true},
  keywordPreference:{defaultWeight:3,minWeight:1,maxWeight:10,maxKeywords:12,match:"literal-name-tokens",overlap:"max",sharedPreferenceBudget:true,relevanceFirst:true},
  selection: {scope:"selective",ambiguousEvents:12,maxAudioAssets:160,effectSampleSeconds:6,musicSampleSeconds:24},
  editing: {fadeInSeconds:.005,fadeOutSeconds:.08,vocalReleaseSeconds:.35,movementReleaseSeconds:.18,maxModelExtensionSeconds:.5,maxModelReleaseSeconds:.4},
  mix: {addedReverb:false,preservePitch:true,preserveSpeed:true,originalGainDb:-60,originalMuted:true,targetLufs:-20,truePeakDb:-1.5,loudnessRange:11,
    density:{foregroundConcurrencyReview:6,consecutiveBossGapSeconds:.75,bossSecondaryLayers:1},
    perspective:{minConfidence:.65,distanceDb:{near:0,mid:-4,far:-10},importanceScale:{key:.8,support:1,detail:1.2}},
    levels:{musicBase:-37,musicIntensity:4,ambience:-40,detail:-36,vocal:-23,warning:-22,foreground:-23,charge:-28,ui:-32,whoosh:-29,foley:-34},
    duck:{music:.36,ambience:.5,detail:.56,attackSeconds:.08,holdSeconds:.12,releaseSeconds:.5},limiter:.84},
  output:{sampleRate:48000,channels:2,audioCodec:"pcm_s24le",videoCodec:"libx264",previewAudioCodec:"aac"}
} as const;

export const WORKFLOW_STAGES = [
  {id:"timing",name:"Gemini 画面点位",detail:"全片概览、重叠分段、查漏及接触复核；逐点记录声源距离与声音主次"},
  {id:"retrieval",name:"本地名称与声音意图匹配",detail:"动作阶段只作参考，素材只来自指定目录"},
  {id:"diversity",name:"有差异的备选",detail:"合并编号变体和声学相近录音，不凑满数量"},
  {id:"selection",name:"Gemini 关键选材",detail:"复核关键动作、UI、音乐及最多12个普通疑难事件"},
  {id:"source",name:"源音频段落复核",detail:"角色发声按动作、声音主体与短释放选择，不变速变调"},
  {id:"mix",name:"自动混音",detail:"按画面距离衰减，预警与关键动作优先，细节退后，平滑避让与短淡入淡出；无新增混响"},
  {id:"delivery",name:"生成与检查",detail:"带音效视频、可编辑清单、实际配置、处理依据与检查报告"}
] as const;

export function workflowSnapshot(presetId:"reference-v6"|"custom",options:{analysisMode:string;selectionScope:string;musicEnabled:boolean;aiSelection:boolean;autoMix:boolean;originalGainDb:number;audioOutputMode?:"all"|"sfx"|"music"}) {
  return {presetId,version:SFX_WORKFLOW.version,name:presetId==="reference-v6"?SFX_WORKFLOW.name:"自定义流程",requestedModel:presetId==="reference-v6"?SFX_WORKFLOW.model:(process.env.SFX_CCSWITCH_MODEL?.trim()||SFX_WORKFLOW.model),
    operation:"create" as "create"|"reselect"|"automix"|"edit"|"reidentify"|"augment"|"reanalyze",timing:"fresh" as "fresh"|"reused",selection:"fresh" as "fresh"|"reused",source:"fresh" as "fresh"|"reused",referenceRunId:SFX_WORKFLOW.referenceRunId,
    config:structuredClone(SFX_WORKFLOW),options:{...options,audioOutputMode:options.audioOutputMode||"all"}};
}
