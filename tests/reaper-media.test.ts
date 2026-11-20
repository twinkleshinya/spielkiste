import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {ReaperMediaPackager} from "../src/sfx/ReaperMedia.js";

export async function testReaperOriginalPackaging() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-package-original-"));
  try {
    const source=path.join(root,"金属 material.wav"),data=Buffer.from([0,1,2,255,8]);await fs.writeFile(source,data);
    const packager=new ReaperMediaPackager(path.join(root,"package"));
    const copied=await packager.add(source,"audio",{channels:2,sampleRate:48000});
    assert.match(copied.relativePath,/^Audio\/Originals\//);assert.equal(copied.converted,false);assert.equal(copied.method,"byte-copy");
    assert.deepEqual(await fs.readFile(path.join(root,"package",copied.relativePath)),data,"packaging must never convert samples");
    assert.equal((await packager.add(source,"audio")).relativePath,copied.relativePath);assert.equal(packager.files.length,1);
  }finally {await fs.rm(root,{recursive:true,force:true});}
}
export async function testReaperPackagingFailure() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-package-failed-"));
  try {
    const packager=new ReaperMediaPackager(path.join(root,"package"));
    await assert.rejects(packager.add(path.join(root,"missing.wav"),"audio"));assert.equal(packager.files.length,0);
    assert.equal(await fs.stat(path.join(root,"package")).catch(()=>null),null);
  }finally {await fs.rm(root,{recursive:true,force:true});}
}
