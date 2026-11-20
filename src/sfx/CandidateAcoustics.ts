import { createHash } from "node:crypto";
import type { AudioAsset } from "./models.js";

/** Lightweight measured features from the same mono PCM excerpt sent for listening. */
export function measureCandidateAcoustics(wav: Buffer, sampledStart = 0): AudioAsset["acoustics"] | undefined {
  if (wav.toString("ascii",0,4)!=="RIFF") return;
  let offset=12, data=-1, size=0, rate=16000, channels=1, bits=16;
  while(offset+8<=wav.length) {
    const length=wav.readUInt32LE(offset+4), kind=wav.toString("ascii",offset,offset+4);
    if(kind==="fmt "&&length>=16) { channels=wav.readUInt16LE(offset+10);rate=wav.readUInt32LE(offset+12);bits=wav.readUInt16LE(offset+22); }
    if(kind==="data") { data=offset+8;size=Math.min(length,wav.length-data);break; }
    offset+=8+length+length%2;
  }
  if(data<0||channels!==1||bits!==16||rate<8000) return;
  const frames=Math.floor(size/2), block=Math.max(1,Math.round(rate*.02));
  const rms:number[]=[];
  for(let from=0;from<frames;from+=block) { let power=0; const end=Math.min(frames,from+block); for(let i=from;i<end;i++)power+=(wav.readInt16LE(data+i*2)/32768)**2; rms.push(Math.sqrt(power/(end-from))); }
  const peak=Math.max(1e-12,...rms), threshold=Math.max(.0007,peak*.025);
  const active=rms.map((r,i)=>r>threshold?i:-1).filter(i=>i>=0);
  const energyEnd=sampledStart+Math.min(frames/rate,((active.at(-1)??0)+1)*block/rate);
  const activeDuration=active.length*block/rate;
  const envelope=Array.from({length:16},(_,i)=>{
    const start=Math.floor(i*rms.length/16),end=Math.max(start+1,Math.floor((i+1)*rms.length/16));
    return rms.slice(start,end).reduce((a,b)=>a+b,0)/(end-start)/peak;
  });
  const n=512,hop=512, freqs=[80,125,200,315,500,800,1250,2000,3150,5000,6500].filter(f=>f<rate/2);
  const powers=freqs.map(()=>0), window=Array.from({length:n},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(n-1)));
  for(let from=0;from+n<=frames;from+=hop) {
    for(let k=0;k<freqs.length;k++) {
      const coeff=2*Math.cos(2*Math.PI*freqs[k]/rate);let a=0,b=0;
      for(let j=0;j<n;j++) {const s=wav.readInt16LE(data+(from+j)*2)/32768*window[j]+coeff*a-b;b=a;a=s;}
      powers[k]+=Math.max(0,a*a+b*b-coeff*a*b);
    }
  }
  const total=Math.max(1e-15,powers.reduce((a,b)=>a+b,0)), bands=powers.map(p=>p/total);
  const centroid=bands.reduce((sum,v,i)=>sum+v*freqs[i],0);
  const ratio=activeDuration/Math.max(.02,frames/rate);
  const label=`${centroid<650?"低频厚重":centroid<1900?"中频粗粝":"高频明亮"} · ${ratio<.3?"短促瞬态":ratio<.75?"起伏脉冲":"连续声体"} · 有效约 ${activeDuration.toFixed(1)} 秒`;
  return {version:1,fingerprint:createHash("sha256").update(wav.subarray(data,data+size)).digest("hex"),sampledStart,sampledDuration:frames/rate,energyEnd,activeDuration,centroid:Math.round(centroid),bands,envelope,label};
}
