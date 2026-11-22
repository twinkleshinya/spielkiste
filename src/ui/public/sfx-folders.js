/** Full paths come from the desktop bridge or the trusted local server. */

export function chooseLocalFolder(initialPath="",description="选择文件夹") {
  if(typeof window!=="undefined"&&typeof window.spielkisteDesktop?.chooseFolder==="function")return window.spielkisteDesktop.chooseFolder({initialPath,description});
  return pickFolderViaLocalServer(initialPath,description);
}

/**
 * The local web server can launch the Windows FolderBrowserDialog and return
 * the selected absolute path. This is the browser-mode equivalent of the
 * Electron bridge; it never uploads or crawls the directory in the page.
 */
async function pickFolderViaLocalServer(initialPath,description) {
  try {
    const start=await fetch("/api/pick-folder",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({initialPath,description}),signal:AbortSignal.timeout(10000)});
    const picker=await start.json();
    if(!start.ok||!picker?.id)throw new Error(picker?.error||"本地系统选择器接口不可用");
    for(let attempt=0;attempt<240;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,500));
      const response=await fetch(`/api/pick-folder/${encodeURIComponent(picker.id)}`,{signal:AbortSignal.timeout(10000)});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||"无法读取文件夹选择结果");
      if(result.status==="success")return result.path||null;
      if(result.status==="cancelled")return null;
      if(result.status==="failed")throw new Error(result.error||"选择文件夹失败");
    }
    throw new Error("系统文件夹选择窗口等待超时，请直接从资源管理器复制完整路径并粘贴到输入框。");
  }catch(error) {
    throw new Error(`系统文件夹选择未完成：${error?.message||error}。可从资源管理器复制完整路径后粘贴到输入框。`);
  }
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
