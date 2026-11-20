import {spawn} from 'node:child_process';
async function run(args){await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Build failed (${code})`)));});}
await run(['node_modules/typescript/bin/tsc','-p','tsconfig.json']);
await run(['dist/tests/run-tests.js']);
await run(['scripts/prepare-desktop.mjs']);
await run(['node_modules/electron-builder/cli.js','--config','electron-builder.cjs','--win',...(process.argv.includes('--dir')?['--dir']:[])]);
const {ToolCodeGit}=await import('./tool-git.mjs');
const result=await new ToolCodeGit(process.cwd()).checkpoint({message:'Spielkiste: verified desktop release'});
console.log('Tool source Git:',JSON.stringify(result));
if(result.status!=='synced')process.exitCode=2;
