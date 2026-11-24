import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {CreateRunSchema} from "../src/sfx/models.js";
import {SfxRunStore} from "../src/sfx/SfxRunStore.js";

export async function testBlankProjectNameUsesVideoFilename() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-project-name-"));
  try {
    const store=new SfxRunStore(root);
    const cases:Array<{name?:string;videoPath:string;expected:string}>=[
      {name:"",videoPath:"C:\\Videos\\猩猩Boss大招.mp4",expected:"猩猩Boss大招"},
      {name:"   ",videoPath:"E:\\视频\\Boss.技能.v2.MP4",expected:"Boss.技能.v2"},
      {videoPath:"\\\\server\\share\\测试 视频.mov",expected:"测试 视频"},
      {name:"",videoPath:"/videos/测试片段.webm",expected:"测试片段"},
      {name:"",videoPath:"relative/video.mkv",expected:"video"},
      {name:"",videoPath:`C:\\Videos\\${"长".repeat(150)}.mp4`,expected:"长".repeat(120)},
      {name:"  自定义项目名  ",videoPath:"C:\\Videos\\clip.mp4",expected:"自定义项目名"}
    ];
    for(const item of cases) {
      const {expected,...input}=item;
      const request={...input,libraryPath:root};
      assert.equal(CreateRunSchema.parse(request).name,expected,"request normalization uses the video filename when the name is blank or omitted");
      const run=await store.createRun(request);
      assert.equal(run.name,expected);
      assert.equal((await new SfxRunStore(root).readRun(run.id)).name,expected,"the resolved name survives restart");
      assert.equal((await store.list()).find(project=>project.id===run.id)?.name,expected,"saved projects show the resolved name");
    }
  } finally {await fs.rm(root,{recursive:true,force:true});}
}
