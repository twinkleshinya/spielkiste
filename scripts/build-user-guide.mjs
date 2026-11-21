import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const markdown=await fs.readFile(path.join(root,'docs/Spielkiste-团队使用说明.md'),'utf8');
const escape=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const inline=text=>escape(text).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
const lines=markdown.split(/\r?\n/),output=[],contents=[];
let list='',table=false;
const close=()=>{if(list){output.push(`</${list}>`);list='';}if(table){output.push('</tbody></table></div>');table=false;}};
for(let i=0;i<lines.length;i++){
 const line=lines[i];
 if(!line.trim()){close();continue;}
 const heading=/^(#{1,3}) (.*)$/.exec(line);
 if(heading){close();const level=heading[1].length,id=`section-${i}`;output.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`);if(level===2)contents.push(`<a href="#${id}">${escape(heading[2])}</a>`);continue;}
 const picture=/^!\[(.*?)\]\((.*?)\)$/.exec(line);
 if(picture){close();if(!picture[2].startsWith('spielkiste-guide-assets/'))throw new Error('Unexpected guide asset');const bytes=await fs.readFile(path.join(root,'docs',picture[2]));output.push(`<figure><a href="data:image/jpeg;base64,${bytes.toString('base64')}" target="_blank"><img src="data:image/jpeg;base64,${bytes.toString('base64')}" alt="${escape(picture[1])}" loading="lazy"></a><figcaption>${escape(picture[1])}</figcaption></figure>`);continue;}
 if(line.startsWith('|')){const cells=line.split('|').slice(1,-1).map(x=>x.trim());if(cells.every(x=>/^:?-+:?$/.test(x)))continue;if(!table){close();output.push('<div class="table-scroll"><table><thead><tr>'+cells.map(x=>`<th>${inline(x)}</th>`).join('')+'</tr></thead><tbody>');table=true;}else output.push('<tr>'+cells.map(x=>`<td>${inline(x)}</td>`).join('')+'</tr>');continue;}
 const item=/^(\d+\.|-) (.*)$/.exec(line);
 if(item){const kind=item[1]==='-'?'ul':'ol';if(list!==kind){close();output.push(`<${kind}>`);list=kind;}output.push(`<li>${inline(item[2])}</li>`);continue;}
 close();output.push(`<p>${inline(line)}</p>`);
}
close();
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spielkiste 使用指南</title><style>
:root{color-scheme:light;--ink:#29372e;--accent:#a45730;--muted:#647469;--bg:#edf0e9}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.85 "Microsoft YaHei","Segoe UI",sans-serif}aside{position:fixed;inset:0 auto 0 0;width:250px;padding:36px 24px;background:#e2e8dd;border-right:1px solid #d3dacd;overflow:auto}aside strong{font-size:25px}aside small{display:block;color:var(--muted);margin:6px 0 24px}nav a{display:block;color:var(--ink);text-decoration:none;padding:8px 0;font-size:14px}nav a:hover{color:var(--accent)}main{max-width:1080px;margin:0 auto 0 max(270px,calc((100vw - 780px)/2));padding:40px 48px 80px;background:#fff;min-height:100vh}h1{font-size:36px;line-height:1.3;margin:0 0 24px}h2{font-size:25px;margin:60px 0 20px;padding-top:15px;border-top:2px solid #e2e8dd;scroll-margin-top:12px}h3{font-size:19px;margin:28px 0 12px;color:var(--accent)}p{margin:14px 0}li{padding:4px 0}code{background:#f1f3ed;border-radius:4px;padding:2px 5px;font:0.9em Consolas,monospace;overflow-wrap:anywhere}strong{font-weight:700}figure{margin:25px 0}figure a{display:block}img{display:block;width:100%;height:auto;border:1px solid #d9e0d4;border-radius:9px}figcaption{font-size:13px;color:var(--muted);line-height:1.6;margin-top:9px}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px;margin:18px 0}th,td{text-align:left;vertical-align:top;border:1px solid #dce2d7;padding:12px}th{background:#edf1e8}td:first-child{min-width:125px;font-weight:600}footer{margin-top:44px;color:var(--muted);font-size:13px}.print{margin-top:25px;border:1px solid #bac7b3;background:white;color:var(--ink);border-radius:6px;padding:8px 14px;cursor:pointer}@media(max-width:1000px){aside{position:static;width:auto;padding:24px}nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 15px}main{margin:0;padding:28px 22px}h1{font-size:29px}}@media print{aside{display:none}main{margin:0;padding:0;max-width:none}body{font-size:10pt;background:white}h2,h3{break-after:avoid}figure,tr{break-inside:avoid}a{color:inherit;text-decoration:none}img{max-height:170mm;object-fit:contain}h2{margin-top:30px}.table-scroll{overflow:visible}}
</style></head><body><aside><strong>Spiel<span style="color:var(--accent)">kiste</span></strong><small>使用指南 · 2026.11.21<br>离线可读 · 截图内置</small><nav>${contents.join('')}</nav><button class="print" onclick="window.print()">打印 / 保存为 PDF</button></aside><main>${output.join('\n')}<footer>Spielkiste · 用户操作指南 · 界面及功能以当前安装版本为准。</footer></main></body></html>`;
await fs.writeFile(path.join(root,'docs/Spielkiste-使用指南.html'),html);
console.log(`User guide built: ${contents.length} sections, ${output.filter(x=>x.startsWith('<figure')).length} screenshots, ${Buffer.byteLength(html)} bytes`);
