import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {parseWindowsRoots} from '../src/ui/LocalFolders.js';

export function testWindowsFolderRootsMergeMappedAndNetworkPaths() {
  const roots = parseWindowsRoots([
    'C:\\',
    'z:\\',
    '\\\\server\\Audio',
    '\\\\SERVER\\Audio',
    '  \\\\as01\\shared\\SFX  ',
    'not-a-path',
    ''
  ]);
  assert.deepEqual(roots, ['C:\\', 'Z:\\', '\\\\server\\Audio', '\\\\as01\\shared']);
}

export async function testNativeFolderSelection() {
  const source=await fs.readFile('src/ui/public/sfx-folders.js','utf8');
  const calls:any[]=[];
  let selected:string|null='\\\\server\\音频部\\素材库';
  const context=vm.createContext({window:{spielkisteDesktop:{chooseFolder:async(input:any)=>{calls.push(input);return selected;}}}});
  vm.runInContext(source.replaceAll('export function ', 'function '),context);
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
