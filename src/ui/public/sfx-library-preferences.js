export function createLibraryPreferences(container,{chooseFolder,isBusy,onChange}) {
  let serial=0;
  const add=document.getElementById("add-library-preference");
  function row(value={path:"",weight:3}) {
    if(container.children.length>=12)return;
    const entry=document.createElement("div");entry.className="library-preference";
    const key=`library-preference-${++serial}`;
    entry.innerHTML=`<label>优先素材目录<div class="input-action"><input id="${key}" class="preference-path" placeholder="选择优先使用的资源目录"><button type="button" class="secondary preference-browse library-action-button">选择目录</button></div></label><label class="preference-weight-label">权重<input class="preference-weight" type="number" min="1" max="10" step="0.5" aria-label="路径权重"></label><button type="button" class="danger-text preference-remove">移除</button>`;
    entry.querySelector(".preference-path").value=value.path||"";entry.querySelector(".preference-weight").value=value.weight??3;
    entry.querySelector(".preference-browse").onclick=()=>{if(!isBusy())void chooseFolder(key,"选择优先使用的音效目录").catch(e=>onChange(e));};
    entry.querySelector(".preference-remove").onclick=()=>{if(!isBusy()){entry.remove();add.disabled=false;onChange();}};
    entry.addEventListener("input",()=>onChange());container.append(entry);add.disabled=container.children.length>=12;
  }
  add.onclick=()=>{if(!isBusy()){row();onChange();}};
  return {
    read:()=>[...container.children].map(entry=>({path:entry.querySelector(".preference-path").value.trim().replace(/^"|"$/g,""),weight:Number(entry.querySelector(".preference-weight").value)})).filter(p=>p.path),
    load:values=>{container.replaceChildren();for(const value of (values||[]).slice(0,12))row(value);add.disabled=container.children.length>=12;},
    setBusy:value=>{for(const input of container.querySelectorAll("input,button"))input.disabled=value;add.disabled=value||container.children.length>=12;}
  };
}

export function createKeywordPreferences(container,{isBusy,onChange}) {
  const add=document.getElementById("add-keyword-preference");
  function row(value={keyword:"",weight:3,scope:"all"}) {
    if(container.children.length>=12)return;
    const entry=document.createElement("div");entry.className="keyword-preference";
    entry.innerHTML='<label>素材关键词<input class="preference-keyword" placeholder="例如 金属、脚步（每行一个）" maxlength="120" aria-label="优先素材关键词"></label><label>适用范围<select class="preference-scope" aria-label="关键词适用对象"><option value="all">全部声音</option><option value="boss">仅 Boss / 怪物</option><option value="player">仅玩家 / 角色</option><option value="ui">仅 UI</option><option value="ambience">仅环境</option><option value="music">仅音乐</option></select></label><label class="preference-weight-label">权重<input class="preference-weight" type="number" min="1" max="10" step="0.5" aria-label="关键词权重"></label><button type="button" class="danger-text preference-remove">移除</button>';
    entry.querySelector(".preference-keyword").value=value.keyword||"";
    entry.querySelector(".preference-weight").value=value.weight??3;
    entry.querySelector(".preference-scope").value=value.scope||"all";
    entry.querySelector(".preference-remove").onclick=()=>{if(!isBusy()){entry.remove();add.disabled=false;onChange();}};
    entry.addEventListener("input",()=>onChange());
    entry.addEventListener("change",event=>{if(event.target.tagName==="SELECT"){onChange();}});
    container.append(entry);add.disabled=container.children.length>=12;
  }
  add.onclick=()=>{if(!isBusy()){row();onChange();}};
  return {
    read:()=>[...container.children].map(entry=>({keyword:entry.querySelector(".preference-keyword").value.trim(),weight:Number(entry.querySelector(".preference-weight").value),scope:entry.querySelector(".preference-scope").value})).filter(p=>p.keyword),
    load:values=>{container.replaceChildren();for(const value of (values||[]).filter(p=>p.purpose!=="reference").slice(0,12))row(value);add.disabled=container.children.length>=12;},
    setBusy:value=>{for(const input of container.querySelectorAll("input,select,button"))input.disabled=value;add.disabled=value||container.children.length>=12;}
  };
}

export function createLibraryExclusions(container,{chooseFolder,isBusy,onChange}) {
  const add=document.getElementById("add-library-exclusion");let serial=0;
  function row(value="") {
    if(container.children.length>=12)return;
    const entry=document.createElement("div");entry.className="exclusion-row";
    const key=`library-exclusion-${++serial}`;
    entry.innerHTML=`<label>排除目录<div class="input-action"><input id="${key}" class="exclusion-path" placeholder="该目录及子目录中的素材不参与选材"><button type="button" class="secondary exclusion-browse library-action-button">选择目录</button></div></label><button type="button" class="danger-text exclusion-remove">移除</button>`;
    entry.querySelector(".exclusion-path").value=value;
    entry.querySelector(".exclusion-browse").onclick=()=>{if(!isBusy())void chooseFolder(key,"选择需要排除的音效目录").then(()=>onChange()).catch(error=>onChange(error));};
    entry.querySelector(".exclusion-remove").onclick=()=>{if(!isBusy()){entry.remove();add.disabled=false;onChange();}};
    entry.addEventListener("input",()=>onChange());container.append(entry);add.disabled=container.children.length>=12;
  }
  add.onclick=()=>{if(!isBusy()){row();onChange();}};
  return {
    read:()=>[...container.children].map(entry=>entry.querySelector(".exclusion-path").value.trim().replace(/^"|"$/g,"")).filter(Boolean),
    load:values=>{container.replaceChildren();for(const value of (values||[]).slice(0,12))row(value);add.disabled=container.children.length>=12;},
    setBusy:value=>{for(const input of container.querySelectorAll("input,button"))input.disabled=value;add.disabled=value||container.children.length>=12;}
  };
}

export function createKeywordExclusions(container,{isBusy,onChange}) {
  const add=document.getElementById("add-keyword-exclusion");
  function row(value="") {
    if(container.children.length>=50)return;
    const entry=document.createElement("div");entry.className="exclusion-row";
    entry.innerHTML='<label>禁用关键词<input class="exclusion-keyword" maxlength="120" placeholder="例如 bird、chirp、测试（每行一个）"></label><button type="button" class="danger-text exclusion-remove">移除</button>';
    entry.querySelector(".exclusion-keyword").value=value;
    entry.querySelector(".exclusion-remove").onclick=()=>{if(!isBusy()){entry.remove();add.disabled=false;onChange();}};
    entry.addEventListener("input",()=>onChange());container.append(entry);add.disabled=container.children.length>=50;
  }
  add.onclick=()=>{if(!isBusy()){row();onChange();}};
  return {
    read:()=>[...container.children].map(entry=>entry.querySelector(".exclusion-keyword").value.trim()).filter(Boolean),
    load:values=>{container.replaceChildren();for(const value of (values||[]).slice(0,50))row(value);add.disabled=container.children.length>=50;},
    setBusy:value=>{for(const input of container.querySelectorAll("input,button"))input.disabled=value;add.disabled=value||container.children.length>=50;}
  };
}
