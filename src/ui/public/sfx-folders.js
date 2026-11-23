/** Full paths come from the desktop bridge or the trusted local server. */

export function chooseLocalFolder(initialPath="",description="选择文件夹") {
  if(typeof window!=="undefined"&&typeof window.spielkisteDesktop?.chooseFolder==="function")return window.spielkisteDesktop.chooseFolder({initialPath,description});
  // Browser mode used to launch a hidden PowerShell/COM helper. On some
  // Windows shells the helper stays alive without a visible dialog, leaving
  // the page polling forever. Use the local directory API directly instead:
  // it never uploads or scans audio and works for drives and reachable UNC
  // shares while keeping the interaction inside the workbench.
  return typeof document!=="undefined" ? browseLocalFoldersInPage(initialPath,description) : pickFolderViaLocalServer(initialPath,description);
}

async function browseLocalFoldersInPage(initialPath,description) {
  const dialog=document.createElement('dialog');dialog.className='folder-picker folder-browser';
  dialog.innerHTML=`<div class="folder-heading"><h3></h3><button type="button" data-close class="text-button">关闭</button></div><div class="folder-toolbar"><button type="button" data-up class="secondary">上一级</button><code data-current></code></div><p class="subtle" data-status>正在读取可访问的磁盘和共享文件夹…</p><div class="folder-list" data-list></div><div class="folder-actions"><button type="button" data-cancel class="secondary">取消</button><button type="button" data-choose>选择当前文件夹</button></div>`;
  dialog.querySelector('h3').textContent=description||'选择文件夹';
  const current=dialog.querySelector('[data-current]'),status=dialog.querySelector('[data-status]'),list=dialog.querySelector('[data-list]'),up=dialog.querySelector('[data-up]');
  let currentPath=(initialPath||'').trim().replace(/^"|"$/g,'');let settled=false,controller;
  const finish=value=>{if(settled)return;settled=true;controller?.abort();dialog.close();dialog.remove();resolve(value);};
  let resolve;
  const promise=new Promise(r=>{resolve=r;});
  const load=async(nextPath=currentPath)=>{
    controller?.abort();controller=new AbortController();currentPath=nextPath;current.textContent=currentPath||'此电脑（所有可访问磁盘）';up.disabled=!currentPath;list.replaceChildren();status.textContent='正在读取文件夹…';
    try{
      const query=currentPath?`?path=${encodeURIComponent(currentPath)}`:'';
      const response=await fetch(`/api/sfx/local-folders${query}`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'无法读取此目录');
      for(const folder of result.folders||[]){const row=document.createElement('button');row.type='button';row.className='folder-entry secondary';row.textContent=folder.name||folder.path;row.title=folder.path;row.onclick=()=>load(folder.path);list.append(row);}
      status.textContent=result.folders?.length?`找到 ${result.folders.length} 个可进入的文件夹`:'此目录没有可进入的子文件夹';
    }catch(error){if(controller.signal.aborted||settled)return;status.textContent=`${error.message||error}。可以直接关闭并粘贴完整路径。`;}
  };
  dialog.querySelector('[data-close]').onclick=()=>finish(null);dialog.querySelector('[data-cancel]').onclick=()=>finish(null);dialog.addEventListener('cancel',e=>{e.preventDefault();finish(null);});dialog.addEventListener('close',()=>finish(null));
  up.onclick=()=>{if(!currentPath)return;const trimmed=currentPath.replace(/[\\\/]$/,'');const parent=trimmed.includes('\\')?trimmed.slice(0,trimmed.lastIndexOf('\\')):trimmed.includes('/')?trimmed.slice(0,trimmed.lastIndexOf('/')):'';load(parent||'');};
  dialog.querySelector('[data-choose]').onclick=()=>finish(currentPath||null);
  document.body.append(dialog);dialog.showModal();await load();return promise;
}

/**
 * The local web server launches the Windows Common Item Dialog and returns
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
    const reason=String(error?.message||error).replace(/[。；;]+$/,'');
    throw new Error(`系统文件夹选择未完成：${reason}。可从资源管理器复制完整路径后粘贴到输入框。`);
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
