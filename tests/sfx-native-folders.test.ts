import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import ts from 'typescript';
import {parseNetworkShareRoots,parseWindowsRoots} from '../src/ui/LocalFolders.js';

export function testWindowsFolderRootsMergeMappedAndNetworkPaths() {
  const unc=(server:string,share:string)=>String.raw`\\${server}\${share}`;
  const roots = parseWindowsRoots([
    'C:'+'\\',
    'z:'+'\\',
    unc('server','Audio'),
    unc('SERVER','Audio'),
    '  '+unc('as01','shared')+'\\SFX  ',
    'not-a-path',
    ''
  ]);
  assert.deepEqual(roots, ['C:'+'\\', 'Z:'+'\\', unc('server','Audio'), unc('as01','shared')]);
}

export function testNetworkShareRootsParseNetUseOutput() {
  const unc=(server:string,share:string)=>String.raw`\\${server}\${share}`;
  const output = [
    'Status       Local     Remote                    Network',
    '-------------------------------------------------------------------------------',
    'OK           Z:        '+unc('as01','shared')+'             Microsoft Windows Network',
    'OK                     '+unc('server','Audio')+'             Microsoft Windows Network'
  ].join('\n');
  assert.deepEqual(parseNetworkShareRoots(output), [unc('as01','shared'), unc('server','Audio')]);
}

export async function testNativeFolderSelection() {
  const helper=await fs.readFile('scripts/Spielkiste.FolderPicker.cs','utf8');
  assert.match(helper,/EnsureVisible\(dialog\)/,'the web helper must restore a dialog hidden by launcher startup flags');
  assert.match(helper,/ShowWindow\(window,\s*1\)/,'restore the actual shell dialog, not just its owner');
  const source=await fs.readFile('src/ui/public/sfx-folders.js','utf8');
  const calls:any[]=[];
  let selected:string|null='\\\\server\\音频部\\素材库';
  const context=vm.createContext({window:{spielkisteDesktop:{chooseFolder:async(input:any)=>{calls.push(input);return selected;}}}});
  vm.runInContext(source.replaceAll('export const ', 'const ').replaceAll('export function ', 'function '),context);
  const result=await vm.runInContext('chooseLocalFolder("Z:\\\\音效库", "选择素材库")',context);
  assert.equal(result,selected,'desktop selection returns the actual network filesystem path without uploading');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{initialPath:'Z:\\音效库',description:'选择素材库'});
  selected=null;
  assert.equal(await vm.runInContext('chooseLocalFolder()',context),null,'cancel must not open a second picker');

  const require=createRequire(import.meta.url);
  const exposed:any[]=[];
  const preload=await fs.readFile('desktop/preload.cjs','utf8');
  vm.runInNewContext(preload,{require:(name:string)=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(...args:any[])=>exposed.push(args)},ipcRenderer:{invoke:async(...args:any[])=>args}};}});
  assert.equal(exposed[0][0],'spielkisteDesktop');
  assert.deepEqual(Object.keys(exposed[0][1]),['chooseFolder'],'preload exposes only the folder operation');
  assert.equal((await exposed[0][1].chooseFolder({initialPath:'Z:\\'}))[0],'spielkiste:choose-folder');
  const {createFolderPicker}=require(path.resolve('desktop/folder-picker.cjs'));
  const frame={url:'http://127.0.0.1:4320/sfx?new=1'};
  const owner={webContents:{mainFrame:frame},isDestroyed:()=>false};
  const requests:any[]=[];
  const picker=createFolderPicker({getWindow:()=>owner,origin:'http://127.0.0.1:4320',showOpenDialog:async(parent:any,options:any)=>{requests.push({parent,options});return {canceled:false,filePaths:['\\\\server\\音频部\\素材库']};}});
  const event={sender:owner.webContents,senderFrame:frame};
  assert.equal(await picker(event,{initialPath:'"\\\\server\\音频部"',description:'选择音效库'}),'\\\\server\\音频部\\素材库');
  assert.equal(requests[0].parent,owner,'dialog is attached to the workbench window');
  assert.equal(requests[0].options.defaultPath,'\\\\server\\音频部');
  assert.deepEqual(requests[0].options.properties,['openDirectory']);
  assert.equal(requests[0].options.title,'选择音效库');
  assert.equal(await picker(event,{initialPath:'Z:\\共享素材'}),'\\\\server\\音频部\\素材库');
  assert.equal(requests[1].options.defaultPath,'Z:\\共享素材');
  await assert.rejects(picker({...event,senderFrame:{url:frame.url}},{}),/工作台/,'subframes cannot invoke native dialogs');
  frame.url='https://unrelated.example/sfx';
  await assert.rejects(picker(event,{}),/工作台/);
  assert.equal(requests.length,2,'foreign senders never reach the native dialog');
  frame.url='http://127.0.0.1:4320/sfx';
  const cancelled=createFolderPicker({getWindow:()=>owner,origin:'http://127.0.0.1:4320',showOpenDialog:async()=>({canceled:true,filePaths:[]})});
  assert.equal(await cancelled(event,{}),null);
}

export async function testBrowserFolderSelectionExplainsSystemPathLimit() {
  const source=await fs.readFile('src/ui/public/sfx-folders.js','utf8');
  const alerts:string[]=[];let calls:any[]=[];let pollCount=0;
  const context=vm.createContext({window:{alert:(message:string)=>alerts.push(message)},fetch:async(url:string,options:any)=>{
    if(url==='/api/pick-folder'){calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({id:'picker-1'})};}
    pollCount++;
    return {ok:true,json:async()=>pollCount===1?{status:'success',path:'\\\\server\\共享\\素材'}:{status:'success',path:'\\\\server\\共享\\素材'}};
  },setTimeout,AbortSignal});
  vm.runInContext(source.replaceAll('export const ', 'const ').replaceAll('export function ', 'function '),context);
  const result=await vm.runInContext('chooseLocalFolder("D:\\\\素材库")',context);
  assert.equal(result,'\\\\server\\共享\\素材','browser mode returns the absolute path from the local Windows picker service');
  assert.deepEqual(calls,[{initialPath:'D:\\素材库',description:'选择文件夹'}]);
  assert.equal(alerts.length,0);
}

// Exercise the actual server functions with only the Windows process boundary
// replaced. A helper which exits without a result must never stay "running".
export async function testFolderPickerReportsHelperExit() {
  const source=await fs.readFile('src/ui/server.ts','utf8');
  const functions=source.slice(source.indexOf('async function startFolderPicker('),source.indexOf('async function openFolder('));
  const child=new EventEmitter() as EventEmitter & {unref:()=>void};child.unref=()=>{};
  let script='';
  let launchOptions:any;
  const context=vm.createContext({process:{platform:'win32',cwd:()=>process.cwd(),env:process.env},path,Date,Math,
    folderPickers:new Map(),Buffer,setTimeout,clearTimeout,appResource:(...parts:string[])=>path.resolve(...parts),
    fs:{mkdir:async()=>{},writeFile:async(_file:string,content:string)=>{script=content;},readFile:async()=>{throw new Error('ENOENT');}},
    spawn:(_command:any,_args:any,options:any)=>{launchOptions=options;setTimeout(()=>child.emit('spawn'),0);return child;}
  });
  vm.runInContext(ts.transpile(functions,{target:ts.ScriptTarget.ES2022}),context);
  const started=await vm.runInContext('startFolderPicker({initialPath:"C:\\\\",description:"选择素材"})',context);
  child.emit('exit',1,null);
  const result=await vm.runInContext(`getFolderPicker(${JSON.stringify(started.id)})`,context);
  assert.equal(result.status,'failed','a crashed helper must fail immediately, not leave the whole page waiting for two minutes');
  assert.match(result.error,/1|退出|启动/);
  assert.ok(script);
  assert.notEqual(launchOptions.detached,true,'the interactive helper must remain attached until it returns a selection');
}
