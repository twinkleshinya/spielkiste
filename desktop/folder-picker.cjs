// Only the workbench's own top-level page may request a native folder dialog.
function createFolderPicker({getWindow,origin,showOpenDialog}) {
  return async (event,input={}) => {
    const owner=getWindow();
    if(!owner||owner.isDestroyed()||event.sender!==owner.webContents||event.senderFrame!==owner.webContents.mainFrame)throw new Error('只允许当前工作台选择文件夹。');
    const url=new URL(event.senderFrame.url);
    if(url.origin!==origin||url.pathname!=='/sfx')throw new Error('只允许当前工作台选择文件夹。');
    const initialPath=typeof input?.initialPath==='string'?input.initialPath.trim().replace(/^"|"$/g,''):'';
    const title=typeof input?.description==='string'?input.description.slice(0,200):'选择素材库文件夹';
    const result=await showOpenDialog(owner,{title,properties:['openDirectory'],...(initialPath?{defaultPath:initialPath}:{})});
    return result.canceled?null:result.filePaths[0]||null;
  };
}
module.exports={createFolderPicker};
