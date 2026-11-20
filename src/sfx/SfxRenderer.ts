import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { SfxRun, round, validateTimeline } from "./models.js";
import { MediaTools } from "./MediaTools.js";
import { exportTimeline } from "./SfxRunStore.js";
import { runFfmpeg } from "./FfmpegBinaries.js";
import { hydratePlacements } from "./HydratePlacements.js";
import { duckFilter, isForeground, planAutoMix } from "./AutoMix.js";
import { writeJson } from "./SfxRunStore.js";
import { edgeFades } from "./ClipEdit.js";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";

export class SfxRenderer {
  async renderPreview(run: SfxRun, outputDir: string,options:{preserveSavedMix?:boolean;preserveSourceEdits?:boolean;videoSource?:string;preservePlacementIds?:ReadonlySet<string>}={}) {
    const preserveSourceEdits=options.preserveSourceEdits ?? (options.preserveSavedMix||run.workflow?.operation==="automix"&&run.workflow.source==="reused");
    await hydratePlacements(run,{preserveEdits:preserveSourceEdits});
    const planned = run.autoMix ? planAutoMix(run,{preserveSourceEdits,preserveLevels:options.preserveSavedMix,preservePlacementIds:options.preservePlacementIds}) : undefined;
    if (planned) { run.placements = planned.placements; run.mixReport = planned.report; }
    for(const p of run.placements.filter(p=>!preserveSourceEdits&&!options.preservePlacementIds?.has(p.id)&&p.enabled&&!p.locked&&!run.events.find(e=>e.id===p.eventId)?.locked)) {
      const a=run.assets.find(a=>a.id===p.assetId);
      Object.assign(p,edgeFades(p.duration,p.sourceOffset>0||p.sourceOffset+p.duration<(a?.duration??Infinity)-.001,p.fadeIn,p.fadeOut));
    }
    validateTimeline(run, run.events, run.placements);
    const metadata = await new MediaTools().inspect(run.videoPath);
    await fs.mkdir(outputDir, { recursive: true });
    const mutedEvents = new Set(run.events.filter(e=>e.muted).map(e=>e.id));
    const active = run.placements.filter(p => p.enabled && !mutedEvents.has(p.eventId) && (p.category !== "music" || run.musicEnabled !== false));
    const output=SFX_WORKFLOW.output,rate=String(output.sampleRate),channels=String(output.channels);
    const sampleCount = Math.round(run.duration * output.sampleRate);
    const temp = path.join(outputDir, `.render-${randomUUID()}`);
    await fs.mkdir(temp);
    const audio = path.join(outputDir, "preview.wav"); const video = path.join(outputDir, "preview.mp4");
    try {
      // Render tracks separately to bound command length and open decoder count for large timelines.
      const tracks: string[] = [];
      const base = path.join(temp, "base.wav");
      const baseInput = metadata.hasAudio&&!run.originalMuted ? ["-i", run.videoPath, "-map", "0:a:0", "-af", `volume=${run.originalGainDb}dB,apad`] : ["-f", "lavfi", "-i", `anullsrc=r=${rate}:cl=stereo`];
      await runFfmpeg( ["-hide_banner", "-loglevel", "error", "-y", ...baseInput, "-t", String(run.duration), "-ar", rate, "-ac", channels, "-c:a", "pcm_f32le", base], { timeout: 600000 });
      tracks.push(base);
      for (let i = 0; i < active.length; i += 16) {
        const batch = active.slice(i, i + 16); const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];
        for (const p of batch) args.push(...(p.loop ? ["-stream_loop", "-1"] : []), "-ss", String(p.sourceOffset), "-t", String(p.duration), "-i", run.assets.find(a => a.id === p.assetId)!.path);
        const filters = batch.map((p, j) => {
          const fades = [p.fadeIn > 0 ? `afade=t=in:st=0:d=${p.fadeIn}` : "", p.fadeOut > 0 ? `afade=t=out:st=${Math.max(0, p.duration - p.fadeOut)}:d=${p.fadeOut}` : ""].filter(Boolean);
          // Short smooth dips keep warnings and contacts readable over a music bed.
          const duckEvents = p.category === "music" ? run.events.filter(e => !e.muted && e.category !== "music" && e.category !== "ambience" && (e.category === "impact" || /warning|预警|charge_release/.test(e.type)) && e.start >= p.start && e.start < p.start + p.duration).slice(0, 60) : [];
          const event = run.events.find(e => e.id === p.eventId);
          const duck = planned ? duckFilter(p, planned.ducks, event?.locked || isForeground(event, p, run.assets.find(a => a.id === p.assetId))) : duckEvents.length ? `volume='${duckEvents.map(e => `if(between(t,${Math.max(0, e.start - p.start - .08)},${e.start - p.start + .38}),0.55,1)`).join("*")}':eval=frame` : "";
          return `[${j}:a:0]${[`aresample=${rate}`, "aformat=channel_layouts=stereo", "asetpts=PTS-STARTPTS", `volume=${p.gainDb}dB`, duck, ...fades, `adelay=${Math.round(p.start * 1000)}:all=1`].filter(Boolean).join(",")}[a${j}]`;
        });
        // Mixed short inputs can lose continuous timestamps; bound padding and trimming by samples.
        filters.push(`${batch.map((_, j) => `[a${j}]`).join("")}amix=inputs=${batch.length}:normalize=0:duration=longest,apad=whole_len=${sampleCount},atrim=end_sample=${sampleCount},asetpts=N/SR/TB[mix]`);
        const filterFile = path.join(temp, `filter-${i}.txt`); await fs.writeFile(filterFile, filters.join(";"));
        const track = path.join(temp, `track-${i}.wav`);
        await runFfmpeg( [...args, "-filter_complex_script", filterFile, "-map", "[mix]", "-t", String(run.duration), "-ar", rate, "-ac", channels, "-c:a", "pcm_f32le", track], { timeout: 600000 });
        tracks.push(track);
      }
      // Tree reduction keeps file descriptors bounded even for hundreds of placements.
      let layer = tracks; let generation = 0;
      while (layer.length > 1) {
        const next: string[] = [];
        for (let i = 0; i < layer.length; i += 16) {
          const group = layer.slice(i, i + 16); const out = path.join(temp, `mix-${generation}-${i}.wav`);
          await runFfmpeg( ["-hide_banner", "-loglevel", "error", "-y", ...group.flatMap(f => ["-i", f]), "-filter_complex", `${group.map((_, j) => `[${j}:a]`).join("")}amix=inputs=${group.length}:normalize=0:duration=longest[mix]`, "-map", "[mix]", "-t", String(run.duration), "-c:a", "pcm_f32le", out], { timeout: 600000 });
          next.push(out);
        }
        layer = next; generation++;
      }
      const tempAudio = path.join(temp, "preview.wav"); const tempVideo = path.join(temp, "preview.mp4");
      let master = "alimiter=limit=0.95:level=0:latency=1";
      const loudness=`I=${run.mixReport?.targetLufs??SFX_WORKFLOW.mix.targetLufs}:TP=${SFX_WORKFLOW.mix.truePeakDb}:LRA=${SFX_WORKFLOW.mix.loudnessRange}`;
      if (planned) {
        const measured = await runFfmpeg(["-hide_banner", "-i", layer[0], "-af", `loudnorm=${loudness}:print_format=json`, "-f", "null", "-"], { timeout: 600000 });
        const match = measured.stderr.match(/\{\s*"input_i"[\s\S]*?\}/);
        const levels = match ? JSON.parse(match[0]) as Record<string, string> : undefined;
        const finite = levels && ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"].every(k => Number.isFinite(Number(levels[k])));
        if (finite && levels) {
          if(planned.report.perspective.knownClips>0) {
            // Fixed gain retains the near/far hierarchy and avoids loudnorm's dynamic fallback.
            const gainDb=round(Math.min(planned.report.targetLufs-Number(levels.input_i),SFX_WORKFLOW.mix.truePeakDb-Number(levels.input_tp)));
            master=`volume=${gainDb}dB,alimiter=limit=${SFX_WORKFLOW.mix.limiter}:level=0:latency=1`;
            if(run.mixReport)run.mixReport.mastering="linear-distance-headroom";
          } else {
            master = `loudnorm=${loudness}:measured_I=${levels.input_i}:measured_TP=${levels.input_tp}:measured_LRA=${levels.input_lra}:measured_thresh=${levels.input_thresh}:offset=${levels.target_offset}:linear=true,alimiter=limit=${SFX_WORKFLOW.mix.limiter}:level=0:latency=1`;
            if(run.mixReport)run.mixReport.mastering="loudnorm-two-pass";
          }
        }else if(run.mixReport)run.mixReport.mastering="peak-only";
      }
      await runFfmpeg( ["-hide_banner", "-loglevel", "error", "-y", "-i", layer[0], "-af", master, "-t", String(run.duration), "-ar", rate, "-ac", channels, "-c:a", output.audioCodec, tempAudio], { timeout: 600000 });
      if (run.mixReport && planned) {
        const measured = await runFfmpeg(["-hide_banner", "-i", tempAudio, "-af", `loudnorm=${loudness}:print_format=json`, "-f", "null", "-"], { timeout: 600000 });
        const match = measured.stderr.match(/\{\s*"input_i"[\s\S]*?\}/);
        const levels = match ? JSON.parse(match[0]) as Record<string, string> : {};
        run.mixReport.measuredLufs = Number.isFinite(Number(levels.input_i)) ? Number(levels.input_i) : null;
        run.mixReport.measuredTruePeakDb = Number.isFinite(Number(levels.input_tp)) ? Number(levels.input_tp) : null;
        await writeJson(path.join(outputDir, "mix-report.json"), run.mixReport);
      }
      let copiedVideo=false;
      if(options.videoSource) {
        try {
          await runFfmpeg(["-hide_banner","-loglevel","error","-y","-i",options.videoSource,"-i",tempAudio,"-map","0:v:0","-map","1:a:0","-t",String(run.duration),"-c:v","copy","-c:a",output.previewAudioCodec,"-b:a","192k","-movflags","+faststart",tempVideo],{timeout:600000});
          copiedVideo=true;
        } catch { /* Missing/incompatible parent preview: encode from the source video. */ }
      }
      if(!copiedVideo)await runFfmpeg( ["-hide_banner", "-loglevel", "error", "-y", "-i", run.videoPath, "-i", tempAudio, "-map", "0:v:0", "-map", "1:a:0", "-t", String(run.duration), "-c:v", output.videoCodec, "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:a", output.previewAudioCodec, "-b:a", "192k", "-movflags", "+faststart", tempVideo], { timeout: 1200000 });
      await fs.copyFile(tempAudio, audio); await fs.copyFile(tempVideo, video);
      await exportTimeline({...run,render:{audio,video,revision:run.revision}}, outputDir);
      return { audio, video, revision: run.revision };
    } catch (e) { throw new Error(`预览渲染失败，请检查 FFmpeg 和素材文件：${String(e instanceof Error ? e.message : e).slice(0, 600)}`); }
    finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
}




