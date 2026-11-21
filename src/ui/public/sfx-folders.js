/**
 * The full filesystem path can only be returned by the Electron desktop host.
 * A normal browser may open its native directory picker, but it deliberately
 * withholds the selected Windows path from page JavaScript. Keep that boundary
 * explicit instead of showing a fake in-page directory browser.
 */
export const BROWSER_FOLDER_SELECTION_MESSAGE = "普通网页无法把 Windows 文件夹的完整路径交给工作台。请使用 Spielkiste 桌面版打开系统文件夹窗口，或从资源管理器复制完整路径后粘贴到输入框。";

export function chooseLocalFolder(initialPath="",description="选择文件夹") {
  if(typeof window!=="undefined"&&typeof window.spielkisteDesktop?.chooseFolder==="function")return window.spielkisteDesktop.chooseFolder({initialPath,description});
  return openBrowserFolderNotice();
}

/**
 * Browser fallback: use the browser's own native picker when available only
 * to make the limitation clear, then keep the path field as the source of
 * truth. No upload or in-page directory crawl is performed here.
 */
async function openBrowserFolderNotice() {
  if(typeof window!=="undefined"&&typeof window.showDirectoryPicker==="function") {
    try {
      const handle=await window.showDirectoryPicker({mode:"read"});
      const name=handle?.name?`“${handle.name}”`:"该文件夹";
      const message=`已通过系统窗口选择${name}。${BROWSER_FOLDER_SELECTION_MESSAGE}`;
      if(typeof window.alert==="function")window.alert(message);
    }catch(error) {
      if(error?.name!=="AbortError"&&typeof window!=="undefined"&&typeof window.alert==="function")window.alert(`选择文件夹失败：${error.message||error}`);
    }
  }else if(typeof window!=="undefined"&&typeof window.alert==="function") {
    window.alert(BROWSER_FOLDER_SELECTION_MESSAGE);
  }
  return null;
}

export function searchFolderPaths(initialPath='') {
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='folder-picker';
    dialog.innerHTML=`<div class="folder-heading"><h3>搜索素材路径</h3><button type="button" data-close class="text-button">关闭</button></div><form><label>搜索范围<input data-root required placeholder="本地或共享文件夹完整路径"></label><label>路径关键词<input data-query required maxlength="120" placeholder="例如 金属、法术、环境"></label><button type="submit">搜索路径</button></form><p class="subtle">仅搜索指定目录内的文件夹名称与路径，不读取音频。大目录可缩小范围后继续搜索。</p><p role="status"></p><div class="folder-list"></div>`;
    const root=dialog.querySelector('[data-root]'),query=dialog.querySelector('[data-query]'),note=dialog.querySelector('[role=status]'),list=dialog.querySelector('.folder-list');
    root.value=initialPath;let controller,settled=false;
    const finish=value=>{if(settled)return;settled=true;controller?.abort();dialog.close();dialog.remove();resolve(value);};
    dialog.querySelector('[data-close]').onclick=()=>finish(null);dialog.addEventListener('cancel',e=>{e.preventDefault();finish(null);});dialog.addEventListener('close',()=>finish(null));
    dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();controller?.abort();const request=new AbortController();controller=request;list.replaceChildren();note.textContent='正在搜索路径…';
      try {
        const response=await fetch(`/api/sfx/search-folders?path=${encodeURIComponent(root.value)}&query=${encodeURIComponent(query.value)}`,{signal:AbortSignal.any([request.signal,AbortSignal.timeout(14000)])}),result=await response.json();
        if(!response.ok)throw new Error(result.error||'路径搜索失败');if(settled||controller!==request)return;
        for(const folder of result.folders){const row=document.createElement('button');row.type='button';row.className='folder-entry secondary';row.textContent=folder.path;row.onclick=()=>finish(folder.path);list.append(row);}
        note.textContent=`找到 ${result.folders.length} 个路径 · 已查 ${result.scanned} 个目录${result.skipped?` · ${result.skipped} 个无法读取`:''}${result.truncated?' · 已达到搜索上限，请缩小范围继续搜索':''}`;
      }catch(error){if(!settled&&controller===request)note.textContent=error.message;}
    };
    document.body.append(dialog);dialog.showModal();query.focus();
  });
}
