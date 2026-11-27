import type { SfxRun } from "./models.js";
import type { AudioClipSource } from "./GeminiAudioSelector.js";
import { z } from "zod";
import { isCharacterVocal, planSourceEdit, edgeFades } from "./ClipEdit.js";
import { writeJson } from "./SfxRunStore.js";
import path from "node:path";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";
export type SourceEditTask = { placementId: string; assetId: string; fileName: string; duration: number; event: { start: number; end: number; type: string; description: string; evidence?: string }; proposed: { sourceStart: number; duration: number } };
export type SourceEditModel = {model:string;editSources(tasks:SourceEditTask[],samples:import("./GeminiAudioSelector.js").AudioSample[],signal?:AbortSignal):Promise<unknown>};
export async function reviewSourceEdits(run: SfxRun, model: SourceEditModel, clips: AudioClipSource, outputDir: string, signal?: AbortSignal) {
  const assets=new Map(run.assets.map(a=>[a.id,a])),events=new Map(run.events.map(e=>[e.id,e]));
  const report={model:model.model,status:"skipped",decisions:[] as {placementId:string;assetId:string;sourceOffset:number;duration:number;basis:"gemini-audio"|"local-bounded";reason:string}[],warnings:[] as string[]};
  const wanted=run.placements.filter(p=>{const e=events.get(p.eventId);return p.enabled&&!p.locked&&!e?.locked&&(isCharacterVocal(e,p,assets.get(p.assetId))||Boolean(e&&e.category==='impact'&&e.phase==='contact'));}).slice(0,24);
  const samples=new Map<string,Awaited<ReturnType<AudioClipSource["sample"]>>>();
  const tasks:SourceEditTask[]=[];
  for(const p of wanted) {
    signal?.throwIfAborted();
    const a=assets.get(p.assetId)!,e=events.get(p.eventId)!;
    const local=planSourceEdit(e,p.role,a,run.duration,p.start);
    Object.assign(p,{sourceOffset:local.sourceOffset,duration:local.duration,...edgeFades(local.duration,true)});
    p.sourceEdit={assetId:a.id,sourceOffset:p.sourceOffset,duration:p.duration,basis:"local-bounded",reason:local.reason};
    try {
      if(!samples.has(a.id))samples.set(a.id,await clips.sample(a,false,outputDir,signal));
      tasks.push({placementId:p.id,assetId:a.id,fileName:a.fileName,duration:a.duration!,event:{start:e.start,end:e.end,type:e.type,description:e.description,evidence:e.evidence},proposed:{sourceStart:local.sourceOffset,duration:local.duration}});
    } catch {signal?.throwIfAborted();report.warnings.push(`${a.fileName}：音频复核片段不可用，保留本地有界剪辑。`);}
  }
  const schema=z.object({edits:z.array(z.object({placementId:z.string(),assetId:z.string(),sourceStart:z.number().finite(),bodyEnd:z.number().finite(),releaseEnd:z.number().finite(),reason:z.string().min(1).max(2000),confidence:z.number().min(0).max(1)})).max(24)});
  let decisions:z.infer<typeof schema>["edits"]=[];
  if(tasks.length)try{decisions=schema.parse(await model.editSources(tasks,[...samples.values()],signal)).edits;}catch{signal?.throwIfAborted();report.warnings.push("Gemini 源音频剪辑复核失败，已保留有界剪辑和短淡入淡出；不能视为模型已确认。");}
  for(const p of wanted) {
    const e=events.get(p.eventId)!,a=assets.get(p.assetId)!, matches=decisions.filter(d=>d.placementId===p.id), d=matches.length===1?matches[0]:undefined;
    const action=e.end-p.start, sample=samples.get(a.id),contact=e.category==='impact'&&e.phase==='contact';
    const maxLength=contact?Math.max(p.duration,action+SFX_WORKFLOW.editing.maxModelExtensionSeconds):action+SFX_WORKFLOW.editing.maxModelExtensionSeconds;
    const inSample=d&&sample?.segments.some(s=>d.sourceStart>=s.start-.001&&d.releaseEnd<=s.end+.001);
    const valid=d&&d.assetId===p.assetId&&d.confidence>=.5&&d.sourceStart>=0&&d.bodyEnd>d.sourceStart&&d.releaseEnd>=d.bodyEnd&&d.releaseEnd-d.sourceStart>=.01&&d.releaseEnd-d.sourceStart<=maxLength&&d.releaseEnd-d.bodyEnd<=(contact?Math.max(p.duration,SFX_WORKFLOW.editing.maxModelReleaseSeconds):SFX_WORKFLOW.editing.maxModelReleaseSeconds)&&d.releaseEnd<=(a.duration??0)+.001&&p.start+d.releaseEnd-d.sourceStart<=run.duration+.001&&inSample;
    if(valid&&d) {
      p.sourceOffset=Math.ceil((d.sourceStart-1e-9)*1000)/1000;
      p.duration=Math.floor((d.releaseEnd-p.sourceOffset+1e-9)*1000)/1000;
      Object.assign(p,edgeFades(p.duration,true));
      p.sourceEdit={assetId:a.id,sourceOffset:p.sourceOffset,duration:p.duration,basis:"gemini-audio",reason:d.reason};
    } else report.warnings.push(`${e.start.toFixed(2)} 秒${d?"源音频裁剪区间无效":"缺少有效的模型剪辑决定"}，已保留本地有界剪辑。`);
    report.decisions.push({placementId:p.id,...p.sourceEdit!,basis:p.sourceEdit!.basis==="gemini-audio"?"gemini-audio":"local-bounded"});
  }
  report.status=!wanted.length?"skipped":report.decisions.every(d=>d.basis==="gemini-audio")?"complete":report.decisions.some(d=>d.basis==="gemini-audio")?"partial":"fallback";
  run.sourceReview = {model:report.model,status:report.status as "skipped"|"complete"|"partial"|"fallback",reviewed:report.decisions.length};
  await writeJson(path.join(outputDir,"source-edit-report.json"),report);
  return report;
}
