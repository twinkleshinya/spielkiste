const { app, BrowserWindow, utilityProcess, dialog, shell, ipcMain, Menu } = require('electron');
const {createFolderPicker}=require('./folder-picker.cjs');
const path = require('node:path');
const fs = require('node:fs');
app.setName('Spielkiste');
const smoke = process.argv.includes('--spielkiste-smoke');
const userData=smoke&&process.env.SPIELKISTE_DATA_DIR?path.join(process.env.SPIELKISTE_DATA_DIR,'.desktop-state'):path.join(app.getPath('appData'),'Spielkiste');
fs.mkdirSync(userData,{recursive:true});
app.setPath('userData',userData);
let backend, origin, quitting = false, requestedWindows = 0;
const windows = new Set();
// Multiple editors share one backend so active jobs and indexes remain isolated by run ID.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { void openProjectWindow().catch(fail); });
  app.whenReady().then(start).catch(fail);
}
function fail(error) {
  const message = error instanceof Error ? error.stack : String(error);
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'desktop.log'), `${new Date().toISOString()} ${message}\n`); } catch {}
  if (!smoke) dialog.showErrorBox('Spielkiste 启动失败', message);
  app.exit(1);
}
async function start() {
  app.setName('Spielkiste');
  const root = app.getAppPath();
  const workspace = process.env.SPIELKISTE_DATA_DIR || path.join(app.getPath('userData'), 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const runtime = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.join(root, '.output', 'desktop-runtime');
  const log = fs.createWriteStream(path.join(app.getPath('userData'), 'desktop.log'), { flags: 'a' });
  backend = utilityProcess.fork(path.join(root, 'desktop', 'backend.cjs'), [], {
    cwd: workspace, stdio: 'pipe', serviceName: 'Spielkiste backend',
    env: { ...process.env, PORT: '0', SPIELKISTE_RESOURCE_ROOT: root, SPIELKISTE_DESKTOP: '1',
      FFMPEG_PATH: path.join(runtime, 'ffmpeg.exe'), FFPROBE_PATH: path.join(runtime, 'ffprobe.exe'),
      SPIELKISTE_GIT: path.join(runtime, 'git', 'cmd', 'git.exe') }
  });
  backend.stdout?.pipe(log, {end:false}); backend.stderr?.pipe(log, {end:false});
  const timer = setTimeout(() => fail(new Error('本地服务启动超过 45 秒，请查看 desktop.log。')), 45000);
  backend.on('exit', code => { if (!quitting) fail(new Error(`本地服务已退出 (${code})`)); });
  backend.on('message', async message => {
    if (message.error) { clearTimeout(timer); fail(message.error); return; }
    if (!message.port) return;
    clearTimeout(timer);
    if (origin) return;
    origin = `http://127.0.0.1:${message.port}`;
    ipcMain.handle('spielkiste:choose-folder',createFolderPicker({getWindow:event=>[...windows].find(w=>!w.isDestroyed()&&w.webContents===event.sender),origin,showOpenDialog:(...args)=>dialog.showOpenDialog(...args)}));
    ipcMain.handle('spielkiste:new-window',async event=>{
      const owner=[...windows].find(w=>!w.isDestroyed()&&w.webContents===event.sender);
      if(!owner||event.senderFrame!==owner.webContents.mainFrame)throw new Error('只允许当前工作台打开窗口。');
      const url=new URL(event.senderFrame.url);
      if(url.origin!==origin||url.pathname!=='/sfx')throw new Error('只允许当前工作台打开窗口。');
      await openProjectWindow();return true;
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'文件',submenu:[{label:'新建项目窗口',accelerator:'CmdOrCtrl+N',click:()=>{void openProjectWindow().catch(fail);}},{role:'close'},{role:'quit'}]},
      {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
      {label:'视图',submenu:[{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}
    ]));
    const window=await openProjectWindow();
    const waiting=requestedWindows;requestedWindows=0;
    for(let n=0;n<waiting;n++)await openProjectWindow();
    if (smoke) {
      app.on('second-instance',()=>{setTimeout(()=>{fs.writeFileSync(path.join(workspace,'desktop-windows.json'),JSON.stringify({count:windows.size,origins:[...windows].map(w=>new URL(w.webContents.getURL()).origin)}));},1000);});
      const snapshot = await window.webContents.executeJavaScript(`({title:document.title,ready:!!document.getElementById('create-form'),nativeFolderPicker:typeof window.spielkisteDesktop?.chooseFolder==='function',newProjectWindow:typeof window.spielkisteDesktop?.newWindow==='function'})`);
      fs.writeFileSync(path.join(workspace,'desktop-smoke.json'), JSON.stringify({ ...snapshot, processId:process.pid, port:message.port, workspace, runtime, packaged:app.isPackaged }));
      if (process.env.SPIELKISTE_SMOKE_HOLD !== '1') { quitting=true; backend.kill(); app.exit(snapshot.ready?0:2); }
    }
  });
}
async function openProjectWindow() {
  if(!origin){requestedWindows++;return;}
  const root=app.getAppPath();
  const window=new BrowserWindow({title:'Spielkiste',width:1440,height:960,minWidth:1050,minHeight:720,
    icon:path.join(root,'src/ui/public/assets/spielkiste.ico'),show:false,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  windows.add(window);
  window.once('closed',()=>windows.delete(window));
  window.webContents.setWindowOpenHandler(({url})=>{if(/^https?:\/\//i.test(url))shell.openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(`${origin}/`))event.preventDefault();});
  window.once('ready-to-show',()=>{if(!smoke)window.show();});
  await window.loadURL(`${origin}/sfx?new=1`);
  return window;
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting=true; backend?.kill(); });
