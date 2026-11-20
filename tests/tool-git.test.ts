import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export async function testToolCodeGit(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'spielkiste-source-git-'));
 try{
  const {ToolCodeGit}=await import(/* webpackIgnore: true */new URL('../../scripts/tool-git.mjs',import.meta.url).href);
  const source=path.join(root,'source'),remote=path.join(root,'remote.git');await fs.mkdir(path.join(source,'src'),{recursive:true});
  await exec('git',['init','--bare',remote]);await exec('git',['init',source]);
  await fs.writeFile(path.join(source,'src/tool.ts'),'export const version=1;');
  await fs.writeFile(path.join(source,'private.txt'),'never publish');await fs.mkdir(path.join(source,'projects'));await fs.writeFile(path.join(source,'projects','private.json'),'secret');
  await exec('git',['add','private.txt'],{cwd:source});
  const tool=new ToolCodeGit(source,{repository:remote,allowLocal:true});
  const first=await tool.checkpoint();assert.equal(first.status,'synced');
  const names=(await exec('git',['--git-dir',remote,'ls-tree','-r','--name-only','main'])).stdout.trim();assert.equal(names,'src/tool.ts');
  assert.equal((await exec('git',['diff','--cached','--name-only'],{cwd:source})).stdout.trim(),'private.txt','unrelated staging preserved');
  await fs.writeFile(path.join(source,'src/tool.ts'),'export const version=2;');const second=await tool.checkpoint();assert.notEqual(second.commit,first.commit);
  const restored=await tool.restore(first.commit);assert.equal(restored.status,'synced');assert.notEqual(restored.commit,first.commit);
  assert.equal(await fs.readFile(path.join(source,'src/tool.ts'),'utf8'),'export const version=1;');assert.ok(await fs.stat(path.join(source,'projects/private.json')));
  assert.match(await tool.history(),/restore code from/);
  await fs.writeFile(path.join(source,'src/leak.ts'),'const key="sk-'+ 'x'.repeat(30)+'";');await assert.rejects(()=>tool.checkpoint(),/Potential credential/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
