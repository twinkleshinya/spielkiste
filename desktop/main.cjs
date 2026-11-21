const { app, BrowserWindow, utilityProcess, dialog, shell, ipcMain } = require('electron');
const {createFolderPicker}=require('./folder-picker.cjs');
const path = require('node:path');
const fs = require('node:fs');
app.setName('Spielkiste');
const userData=path.join(app.getPath('appData'),'Spielkiste');
fs.mkdirSync(userData,{recursive:true});
app.setPath('userData',userData);
let backend, window, quitting = false;
const smoke = process.argv.includes('--spielkiste-smoke');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });
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
    const origin = `http://127.0.0.1:${message.port}`;
    ipcMain.handle('spielkiste:choose-folder',createFolderPicker({getWindow:()=>window,origin,showOpenDialog:(...args)=>dialog.showOpenDialog(...args)}));
    window = new BrowserWindow({ title:'Spielkiste', width:1440, height:960, minWidth:1050, minHeight:720,
      icon:path.join(root,'src/ui/public/assets/spielkiste.ico'), show:false,
      webPreferences:{ preload:path.join(__dirname,'preload.cjs'), nodeIntegration:false, contextIsolation:true, sandbox:true } });
    window.webContents.setWindowOpenHandler(({url}) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return {action:'deny'}; });
    window.webContents.on('will-navigate', (event,url) => { if (!url.startsWith(`${origin}/`)) event.preventDefault(); });
    window.once('ready-to-show', () => { if (!smoke) window.show(); });
    await window.loadURL(`${origin}/sfx?new=1`);
    if (smoke) {
      const snapshot = await window.webContents.executeJavaScript(`({title:document.title,ready:!!document.getElementById('create-form')})`);
      fs.writeFileSync(path.join(workspace,'desktop-smoke.json'), JSON.stringify({ ...snapshot, port:message.port, workspace, runtime, packaged:app.isPackaged }));
      if (process.env.SPIELKISTE_SMOKE_HOLD !== '1') { quitting=true; backend.kill(); app.exit(snapshot.ready?0:2); }
    }
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting=true; backend?.kill(); });
