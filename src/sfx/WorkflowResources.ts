import { appResource } from "./RuntimePaths.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import {SFX_WORKFLOW,WORKFLOW_STAGES} from "./WorkflowPolicy.js";
import {SfxError} from "./models.js";

export const WORKFLOW_SKILLS=[
  {id:"video-sfx-workflow",name:"完整流程"},
  {id:"video-sfx-timing",name:"视频点位"},
  {id:"video-sfx-selection",name:"选材与剪辑"},
  {id:"video-sfx-mix-review",name:"混音与验收"}
] as const;
const skillRoot=()=>appResource(".agents/skills");
export function workflowResources() {
  return {profile:SFX_WORKFLOW,stages:WORKFLOW_STAGES,skills:WORKFLOW_SKILLS.map(s=>({...s,url:`/api/sfx/workflow/skill/${s.id}`})),guide:"/api/sfx/workflow/guide",bundle:"/api/sfx/workflow/bundle"};
}
export async function readWorkflowGuide() {return fs.readFile(path.join(skillRoot(),"video-sfx-workflow/references/reference-v6.md"),"utf8");}
export async function readWorkflowSkill(id:string) {
  if(!WORKFLOW_SKILLS.some(s=>s.id===id))throw new SfxError("技能不存在",404);
  return fs.readFile(path.join(skillRoot(),id,"SKILL.md"),"utf8");
}
function crc32(buffer:Buffer) {
  let value=0xffffffff;
  for(const byte of buffer){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}
  return (value^0xffffffff)>>>0;
}
/** Store-only ZIP of explicitly allowed skill files; no workspace enumeration or credentials. */
export async function workflowBundle() {
  const entries:{name:string;data:Buffer}[]=[];
  for(const skill of WORKFLOW_SKILLS) for(const file of ["SKILL.md","agents/openai.yaml",...(skill.id==="video-sfx-workflow"?["scripts/run.mjs","references/reference-v6.md","references/acceptance-scenarios.md"]:[])]) {
    entries.push({name:`.agents/skills/${skill.id}/${file}`,data:await fs.readFile(path.join(skillRoot(),skill.id,file))});
  }
  entries.push({name:"workflow-profile.json",data:Buffer.from(JSON.stringify(workflowResources(),null,2))});
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const entry of entries) {
    const name=Buffer.from(entry.name),crc=crc32(entry.data),header=Buffer.alloc(30),directory=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt32LE(crc,14);header.writeUInt32LE(entry.data.length,18);header.writeUInt32LE(entry.data.length,22);header.writeUInt16LE(name.length,26);
    directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(entry.data.length,20);directory.writeUInt32LE(entry.data.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
    local.push(header,name,entry.data);central.push(directory,name);offset+=header.length+name.length+entry.data.length;
  }
  const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,index,end]);
}
