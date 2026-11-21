const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('spielkisteDesktop',Object.freeze({
  chooseFolder:input=>ipcRenderer.invoke('spielkiste:choose-folder',input)
}));
