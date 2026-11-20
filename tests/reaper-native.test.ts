import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {ReaperExporter} from "../src/sfx/ReaperExporter.js";
import {applyReaperRenderSettings,normalizeReaperSettings,renderDitherFlags,renderPostProcessDisabledFlags,type ReaperProjectConverter} from "../src/sfx/ReaperNative.js";
import {fixtureRun,writeReaperFixtures} from "./sfx-reaper-export.test.js";

export async function testReaperNativePipeline() {
  assert.deepEqual(normalizeReaperSettings({}),{audioFormat:"preserve",sampleRate:0,channelMode:"preserve",dither:"auto",noiseShaping:false});
  assert.equal(renderDitherFlags({audioFormat:"wav16",dither:"auto",noiseShaping:false}),1);
  assert.equal(renderDitherFlags({audioFormat:"wav24",dither:"auto",noiseShaping:false}),0);
  assert.equal(renderDitherFlags({audioFormat:"wav16",dither:"on",noiseShaping:true}),3);
  assert.equal(renderDitherFlags({audioFormat:"wav16",dither:"off",noiseShaping:true}),0);
  assert.equal(applyReaperRenderSettings('REAPER_PROJECT\n  RENDER_DITHER 0\n  RENDER_NORMALIZE 0\n  RENDER_TAILFLAG 4\n>',normalizeReaperSettings({audioFormat:"wav16",dither:"auto",noiseShaping:true})).match(/RENDER_DITHER 3/)?.[0],"RENDER_DITHER 3");
  assert.match(applyReaperRenderSettings('REAPER_PROJECT\n  RENDER_DITHER 0\n  RENDER_NORMALIZE 0\n>',normalizeReaperSettings({audioFormat:"wav16"})),new RegExp(`RENDER_NORMALIZE ${renderPostProcessDisabledFlags}`));
  for(const invalid of [{sampleRate:12345},{audioFormat:"mp3"},{channelMode:"invalid"},{dither:"bad"},{noiseShaping:"yes"}])assert.throws(()=>normalizeReaperSettings(invalid as never));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-native-pipeline-"));
  try {
    const run=fixtureRun(root);await writeReaperFixtures(run);
    const templatePath=path.join(root,"template.rpp"),outputPath=path.join(root,"工程 with spaces","project.rpp");
    await fs.writeFile(templatePath,'<REAPER_PROJECT 0.1 "7.33/win64" 1\n>\n');
    const converter:ReaperProjectConverter={convertProject:async request=>{
      const imported=await fs.readFile(request.importPath,"utf8");
      assert.match(imported,/Audio\/Originals\//,"all originals are imported before conversion");
      assert.match(imported,/SOFFS 0\.4/);assert.match(imported,/POSITION 1\.25/);
      assert.deepEqual(request.settings,{audioFormat:"wav24",sampleRate:44100,channelMode:"mono",dither:"on",noiseShaping:true});
      for(const file of request.media.filter(f=>f.kind==="audio"))assert.deepEqual(await fs.readFile(path.join(path.dirname(outputPath),file.relativePath)),await fs.readFile(file.originalPath));
      await fs.copyFile(request.importPath,request.outputPath);
      return {engine:"reaper",version:"7.33/test",resampleMode:"r8brain free",steps:["import-originals","convert-full-sources","relink-and-save"],files:request.media};
    }};
    const exported=await new ReaperExporter(converter,path.join(root,"workbench","reaper-exports")).exportRun(run,{templatePath,outputPath,audioFormat:"wav24",sampleRate:44100,channelMode:"mono",dither:"on",noiseShaping:true});
    assert.equal(exported.manifest.conversion?.engine,"reaper");
    assert.equal(exported.manifest.settings.sampleRate,44100);
    assert.equal(exported.manifest.settings.dither,"on");
    assert.equal(exported.manifest.settings.noiseShaping,true);
    const renderedProject=await fs.readFile(outputPath,"utf8");
    assert.match(renderedProject,/RENDER_DITHER 3/);
    assert.match(renderedProject,/RENDER_NORMALIZE 262144/);
    assert.match(renderedProject,/RENDER_TAILFLAG 0/);
    assert.equal(exported.manifest.tracks.find(t=>t.placementId==="p-boss")!.source!.sourceOffset,.4);
    assert.ok(!run.placements.some(p=>p.sourceOffset<0));
    const before=await fs.readFile(outputPath);
    const failure:ReaperProjectConverter={convertProject:async()=>{throw new Error("REAPER conversion failed");}};
    await assert.rejects(new ReaperExporter(failure,path.join(root,"workbench","reaper-exports")).exportRun(run,{templatePath,outputPath,audioFormat:"wav32f",sampleRate:48000}),/REAPER conversion failed/);
    assert.deepEqual(await fs.readFile(outputPath),before,"a failed native run cannot overwrite an existing completed project");
  } finally {await fs.rm(root,{recursive:true,force:true});}
}
