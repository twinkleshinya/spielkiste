import {promises as fs,constants} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";

export type ReaperChannelMode="preserve"|"mono"|"stereo";
export type ReaperMediaFile={
  kind:"audio"|"video";originalPath:string;relativePath:string;converted:boolean;method:string;
  sourceChannels?:number;channels?:number;sampleRate?:number;codec?:string;originalRelativePath?:string;
};
function safeName(value:string) {return value.replace(/[<>:"/\\|?*\x00-\x1f]/g,"_").slice(0,70)||"media";}

/** Copy complete originals. Native REAPER conversion is a later, separate step. */
export class ReaperMediaPackager {
  readonly files:ReaperMediaFile[]=[];
  private packaged=new Map<string,ReaperMediaFile>();
  constructor(private directory:string) {}
  async add(source:string,kind:"audio"|"video",known?:{channels?:number;sampleRate?:number}):Promise<ReaperMediaFile> {
    const originalPath=await fs.realpath(source),key=`${kind}:${process.platform==="win32"?originalPath.toLowerCase():originalPath}`;
    const previous=this.packaged.get(key);if(previous)return previous;
    const stat=await fs.stat(originalPath);if(!stat.isFile())throw new Error(`不是可读取的媒体文件：${source}`);
    const fingerprint=createHash("sha256").update(`${key}:${stat.size}:${stat.mtimeMs}:copy`).digest("hex").slice(0,16),parsed=path.parse(originalPath);
    const relativePath=`${kind==="audio"?"Audio/Originals":"Video"}/${safeName(parsed.name)}_${fingerprint}${parsed.ext}`;
    const destination=path.join(this.directory,relativePath);await fs.mkdir(path.dirname(destination),{recursive:true});
    const temporary=`${destination}.${randomUUID()}.tmp`;
    try {
      try {await fs.access(destination);}catch {await fs.copyFile(originalPath,temporary,constants.COPYFILE_EXCL);await fs.rename(temporary,destination);}
    }finally {await fs.rm(temporary,{force:true});}
    const file:ReaperMediaFile={kind,originalPath,relativePath,converted:false,method:"byte-copy",sourceChannels:known?.channels,channels:known?.channels,sampleRate:known?.sampleRate};
    this.files.push(file);this.packaged.set(key,file);return file;
  }
}
