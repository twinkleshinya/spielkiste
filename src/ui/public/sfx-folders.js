/** Local directory browser: usable in the workbench without a detached desktop dialog. */
export function chooseLocalFolder(initialPath="",description="选择本机文件夹") {
  return new Promise(resolve=>{
    const dialog=document.createElement("dialog");dialog.className="folder-picker";
    dialog.innerHTML=`<div class="folder-heading"><h3></h3><button type="button" class="text-button" data-action="close" aria-label="关闭目录选择">关闭</button></div>
      <p class="subtle">直接读取本机目录，不上传音频。可浏览磁盘，也可粘贴本机或网络路径。</p>
      <form class="folder-address"><label>当前路径<input aria-label="当前目录路径" placeholder="例如 E:\\M98\\整理版 或 \\\\服务器\\共享目录"></label><button type="submit" class="secondary">转到</button></form>
      <div class="folder-navigation"><button type="button" class="secondary" data-action="roots">本机磁盘</button><button type="button" class="secondary" data-action="parent">上一级</button><span role="status" aria-live="polite"></span></div>
      <div class="folder-list"></div><p class="folder-error" role="alert" hidden></p>
      <div class="folder-footer"><span></span><button type="button" class="secondary" data-action="cancel">取消</button><button type="button" data-action="choose" disabled>选择此文件夹</button></div>`;
    const $=s=>dialog.querySelector(s),input=$("input"),list=$(".folder-list"),note=$("[role=status]"),error=$(".folder-error"),choose=$("[data-action=choose]");
    $("h3").textContent=description;
    let current="",parent=null,controller=null,settled=false;
    const finish=value=>{if(settled)return;settled=true;controller?.abort();dialog.close();dialog.remove();resolve(value);};
    dialog.addEventListener("cancel",e=>{e.preventDefault();finish(null);});
    dialog.addEventListener("close",()=>finish(null));
    for(const action of ["close","cancel"])$(`[data-action=${action}]`).onclick=()=>finish(null);
    choose.onclick=()=>{if(current)finish(current);};
    async function load(directory,offset=0) {
      controller?.abort();const request=new AbortController();controller=request;
      const timer=setTimeout(()=>request.abort(new Error("读取目录超时，请检查磁盘或网络路径。")),15000);
      choose.disabled=true;error.hidden=true;note.textContent="正在读取目录…";
      if(!offset){list.replaceChildren();input.value=directory;}
      try {
        const response=await fetch(`/api/sfx/local-folders?path=${encodeURIComponent(directory)}&offset=${offset}`,{signal:request.signal});
        const result=await response.json();if(!response.ok)throw new Error(result.error||"无法读取目录");
        if(settled||controller!==request)return;
        current=result.path;parent=result.parent;if(input.value===directory)input.value=current;
        $("[data-action=parent]").disabled=parent===null;
        choose.disabled=!current||input.value!==current;$(".folder-footer span").textContent=current||"请先选择一个磁盘";
        for(const folder of result.folders) {
          const row=document.createElement("button");row.type="button";row.className="folder-entry secondary";row.textContent=`▸ ${folder.name}`;row.title=folder.path;row.onclick=()=>load(folder.path);list.append(row);
        }
        if(result.nextOffset!==null) {const more=document.createElement("button");more.type="button";more.className="text-button";more.textContent="显示更多文件夹";more.onclick=()=>{more.remove();void load(result.path,result.nextOffset);};list.append(more);}
        note.textContent=result.folders.length?"点击文件夹进入，确认后选择此文件夹。":current?"此目录没有下级文件夹，可直接选择。":"没有可读磁盘，可以在上方输入路径。";
      }catch(e){if(!settled&&controller===request){error.hidden=false;error.textContent=request.signal.aborted?"读取目录超时，请检查磁盘或网络路径。":e.message;note.textContent="读取未完成，可输入其他路径或取消。";}}
      finally{clearTimeout(timer);}
    }
    $("form").onsubmit=e=>{e.preventDefault();void load(input.value.trim());};
    input.addEventListener("input",()=>{choose.disabled=!current||input.value!==current;});
    $("[data-action=roots]").onclick=()=>load("");$("[data-action=parent]").onclick=()=>{if(parent!==null)void load(parent);};
    document.body.append(dialog);dialog.showModal();void load(initialPath.trim().replace(/^"|"$/g,""));
  });
}
