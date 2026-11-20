const form = document.querySelector("#runForm");
const statusBox = document.querySelector("#status");
const runButton = document.querySelector("#runButton");
const preview = document.querySelector("#markdownPreview");
const selectedRun = document.querySelector("#selectedRun");
const toggleAdvanced = document.querySelector("#toggleAdvanced");
const advancedPanel = document.querySelector("#advancedPanel");
const pickParentRoot = document.querySelector("#pickParentRoot");
const selectedPathPreview = document.querySelector("#selectedPathPreview");

let outputDirectoryHandle = null;
let outputProjectHandle = null;

const uploadState = {
  sessionId: "",
  folders: null,
  files: {
    videos: [],
    images: [],
    requirements: [],
    skillDocuments: [],
    references: [],
    styles: [],
    audioReferences: []
  }
};

toggleAdvanced.addEventListener("click", () => {
  advancedPanel.hidden = !advancedPanel.hidden;
  toggleAdvanced.textContent = advancedPanel.hidden ? "高级设置" : "收起高级设置";
});

pickParentRoot.addEventListener("click", async () => {
  pickParentRoot.disabled = true;
  try {
    resetOutputSelection();
    if (window.showDirectoryPicker) {
      statusBox.textContent = "请选择外包文档文件夹路径...";
      outputDirectoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      document.querySelector("#parentRoot").value = `已选择：${outputDirectoryHandle.name}`;
      await updateSelectedPathPreview();
      statusBox.textContent = `已选择文件夹：${outputDirectoryHandle.name}\n最终会在这里创建/使用子文件夹：${value("#folderName")}`;
      return;
    }
    statusBox.textContent = "当前浏览器不支持直接选择文件夹，正在打开 Windows 文件夹选择窗口...";
    const picked = await pickFolderViaServer();
    if (picked?.path) {
      document.querySelector("#parentRoot").value = picked.path;
      await updateSelectedPathPreview();
      statusBox.textContent = `已选择外包文档文件夹路径：${picked.path}\n最终会在这个路径下创建/使用子文件夹：${value("#folderName")}`;
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      statusBox.textContent = "已取消选择文件夹。";
    } else {
      statusBox.textContent = [
        error.message,
        "浏览器不允许选择磁盘根目录或包含系统文件的目录。",
        "请先在资源管理器中新建一个普通空文件夹，例如 F:\\jiangxy2\\外包文档输出，然后选择它。",
        "也可以直接把绝对路径粘贴到输入框。"
      ].join("\n");
    }
  } finally {
    pickParentRoot.disabled = false;
  }
});

document.querySelector("#parentRoot").addEventListener("input", () => {
  resetOutputSelection();
  void updateSelectedPathPreview();
});

["#projectName", "#vendorName", "#demandType", "#demandName"].forEach((selector) => {
  document.querySelector(selector).addEventListener("input", updateFolderName);
  document.querySelector(selector).addEventListener("change", updateFolderName);
});

document.querySelector("#folderName").addEventListener("input", (event) => {
  event.target.dataset.touched = "true";
  outputProjectHandle = null;
  uploadState.sessionId = "";
  uploadState.folders = null;
  void updateSelectedPathPreview();
});

document.querySelector("#template").addEventListener("change", (event) => {
  event.target.dataset.touched = "true";
  syncDemandTypeFromTemplate();
  updateTemplateFieldsVisibility();
});

updateFolderName();
updateTemplateFieldsVisibility();
void updateSelectedPathPreview();

document.querySelectorAll("[data-pick]").forEach((button) => {
  button.addEventListener("click", () => document.querySelector(`#${button.dataset.pick}`).click());
});

document.querySelectorAll(".file-input").forEach((input) => {
  input.addEventListener("change", async () => {
    const kind = input.closest(".dropzone").dataset.kind;
    await uploadFiles(kind, [...input.files]);
    input.value = "";
  });
});

document.querySelectorAll(".dropzone").forEach((zone) => {
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", async (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    await uploadFiles(zone.dataset.kind, [...event.dataTransfer.files]);
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  runButton.disabled = true;
  statusBox.textContent = "运行中...";
  try {
    await ensureUploadSession();
    const payload = {
      projectName: value("#projectName"),
      input: value("#input") || uploadState.folders?.videos,
      requirement: firstUploadedPath("requirements") || value("#requirement"),
      skillDocumentFiles: uploadState.files.skillDocuments.map((record) => record.serverPath).filter(Boolean),
      skillDocumentFeishuDocs: tokenList("#skillDocumentFeishuDocs"),
      references: uploadState.files.references.length ? uploadState.folders.references : value("#references"),
      style: firstUploadedPath("styles") || value("#style"),
      audioReferenceFiles: uploadState.files.audioReferences.map((record) => record.serverPath).filter(Boolean),
      enableMossAudioAnalysis: document.querySelector("#enableMossAudio").checked,
      templateFields: collectTemplateFields(),
      requirementFeishuDocs: tokenList("#requirementFeishuDocs"),
      referenceFeishuDocs: tokenList("#referenceFeishuDocs"),
      styleFeishuDocs: tokenList("#styleFeishuDocs"),
      template: value("#template") || "技能音效",
      folderToken: value("#folderToken") || undefined,
      docToken: value("#docToken") || undefined,
      dryRun: document.querySelector("#dryRun").checked,
      schedule: {
        startDate: value("#startDate") || undefined,
        dueDate: value("#dueDate") || undefined,
        outsourcingPeople: Number(value("#people")) || 1,
        deliveryRounds: 3,
        reviewNodes: []
      }
    };
    const job = await postJson("/api/run", payload);
    await pollJob(job.id);
  } catch (error) {
    statusBox.textContent = error.message;
  } finally {
    runButton.disabled = false;
  }
});

function value(selector) {
  return document.querySelector(selector).value.trim();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function ensureUploadSession() {
  if (uploadState.sessionId) return uploadState;
  if (!outputDirectoryHandle && !value("#parentRoot") && !value("#uploadRoot")) {
    throw new Error("请先选择或填写“外包文档文件夹路径”。");
  }
  const response = await postJson("/api/upload-session", {
    targetRoot: value("#uploadRoot") || undefined,
    parentRoot: serverParentRoot(),
    folderName: value("#folderName") || `${safeName(value("#projectName"))}_audio_outsource`
  });
  uploadState.sessionId = response.sessionId;
  uploadState.folders = response.folders;
  return uploadState;
}

async function uploadFiles(kind, files) {
  if (!files.length) return;
  await ensureUploadSession();
  for (const file of files) {
    const record = createUploadRecord(kind, file);
    const row = record.row;
    const relativePath = file.webkitRelativePath || file.name;
    const data = await uploadFileWithProgress(
      `/api/upload?sessionId=${encodeURIComponent(uploadState.sessionId)}&kind=${encodeURIComponent(kind)}&targetRoot=${encodeURIComponent(value("#uploadRoot"))}&parentRoot=${encodeURIComponent(serverParentRoot())}&folderName=${encodeURIComponent(value("#folderName") || `${safeName(value("#projectName"))}_audio_outsource`)}`,
      file,
      relativePath,
      (percent) => updateUploadRow(row, percent)
    );
    record.serverPath = data.path;
    record.browserFolder = outputDirectoryHandle ? `${outputDirectoryHandle.name}/${value("#folderName")}/${kind}/${relativePath}` : "";
    uploadState.folders = data.folders;
    try {
      await withTimeout(writeUploadedFileToBrowserFolder(kind, file, relativePath), 15000, "写入所选文件夹超时，已保留服务端归档副本。");
    } catch (error) {
      row.querySelector("span").textContent += `；本地所选目录同步提示：${error.message}`;
    }
    updateUploadRow(row, 100, "上传成功");
  }
  renderZoneFiles(kind);
}

function createUploadRecord(kind, file) {
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    fileName: file.name,
    relativePath: file.webkitRelativePath || file.name,
    sizeBytes: file.size,
    serverPath: "",
    browserFolder: "",
    row: null
  };
  const row = document.createElement("div");
  row.className = "uploaded-file-row";
  row.dataset.uploadId = record.id;
  row.innerHTML = `
    <strong>${labelKind(kind)} / ${file.name}</strong>
    <button class="mini-danger" type="button">删除</button>
    <div class="progress"><i></i></div>
    <span>${formatBytes(file.size)}，等待上传</span>
  `;
  row.querySelector("button").addEventListener("click", () => deleteUploadRecord(record.id));
  record.row = row;
  uploadState.files[kind].push(record);
  getZoneFilesBox(kind).append(row);
  return record;
}

function updateUploadRow(row, percent, label = "上传中") {
  row.querySelector(".progress > i").style.width = `${Math.max(0, Math.min(100, percent))}%`;
  const span = row.querySelector("span");
  span.textContent = `${label}：${Math.round(percent)}%`;
}

function renderZoneFiles(kind) {
  for (const record of uploadState.files[kind]) {
    const row = record.row;
    if (!row) continue;
    row.querySelector("span").textContent = `上传成功，${formatBytes(record.sizeBytes)}`;
  }
}

async function deleteUploadRecord(recordId) {
  for (const [kind, records] of Object.entries(uploadState.files)) {
    const index = records.findIndex((record) => record.id === recordId);
    if (index < 0) continue;
    const [record] = records.splice(index, 1);
    record.row?.remove();
    if (record.serverPath) {
      postJson("/api/delete-upload", { filePath: record.serverPath }).catch(() => undefined);
    }
    await deleteBrowserFolderFile(record).catch(() => undefined);
    return;
  }
}

function uploadFileWithProgress(url, file, relativePath, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("x-relative-path", encodeURIComponent(relativePath));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress((event.loaded / event.total) * 100);
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText || "{}");
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new Error(data.error || `上传失败：${file.name}`));
        }
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => reject(new Error(`上传失败：${file.name}`));
    xhr.send(file);
  });
}

function firstUploadedPath(kind) {
  return uploadState.files[kind]?.[0]?.serverPath || "";
}

function labelKind(kind) {
  return {
    videos: "视频",
    images: "图片",
    requirements: "需求",
    skillDocuments: "技能文档",
    references: "参考",
    styles: "风格",
    audioReferences: "声音参考"
  }[kind];
}

function tokenList(selector) {
  return value(selector)
    .split(/[\s,，;；]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeName(input) {
  return (
    input
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "") || "ProjectName"
  );
}

function updateFolderName() {
  const folderInput = document.querySelector("#folderName");
  if (folderInput.dataset.touched) return;
  const project = value("#projectName") || "M71";
  const vendor = value("#vendorName") || "声影创境";
  const demandType = value("#demandType") || "技能音效";
  const demandName = value("#demandName") || "需求名称";
  folderInput.value = `雷霆数娱《${project}》${vendor}_${demandType}（${demandName}）`;
  const template = document.querySelector("#template");
  if (!template.dataset.touched) {
    template.value = demandType === "技能音效" ? "技能音效" : demandType === "PV音效" ? "PV音效" : "界面音效";
  }
  updateTemplateFieldsVisibility();
  outputProjectHandle = null;
  void updateSelectedPathPreview();
}

function syncDemandTypeFromTemplate() {
  const template = value("#template");
  const demandType = document.querySelector("#demandType");
  if (template === "技能音效") demandType.value = "技能音效";
  if (template === "界面音效") demandType.value = "界面音效";
  if (template === "PV音效") demandType.value = "PV音效";
}

function templateKind() {
  const template = value("#template");
  const demandType = value("#demandType");
  if (template.includes("PV") || demandType.includes("PV")) return "pv";
  if (template.includes("界面") || demandType.includes("界面")) return "ui";
  if (template.includes("技能") || demandType.includes("技能")) return "skill";
  return "default";
}

function updateTemplateFieldsVisibility() {
  const kind = templateKind();
  document.body.dataset.templateMode = kind;
  document.querySelectorAll("[data-template-group]").forEach((group) => {
    group.hidden = group.dataset.templateGroup !== kind;
  });
  document.querySelectorAll("[data-skill-only]").forEach((element) => {
    element.hidden = kind !== "skill";
  });
  document.querySelectorAll("[data-hide-when-skill]").forEach((element) => {
    element.hidden = kind === "skill";
  });
  const hint = document.querySelector("#templateFieldHint");
  if (hint) {
    hint.textContent =
      kind === "skill"
        ? "技能模板：保留原飞书表格样式，填写日期并从技能文档提取技能编号/名称"
        : kind === "ui"
          ? "界面模板：填写系统说明、功能/动效清单、界面反馈重点"
          : kind === "pv"
            ? "PV模板：填写剧情说明、关键点位、对白和音乐关系"
            : "默认模板";
  }
}

function collectTemplateFields() {
  const fields = {
    demandName: value("#demandName"),
    vendorName: value("#vendorName")
  };
  document.querySelectorAll("[data-template-field]").forEach((input) => {
    if (!input.closest("[data-template-group]")?.hidden || !input.closest("[data-template-group]")) {
      fields[input.dataset.templateField] = input.value.trim();
    }
  });
  return Object.fromEntries(Object.entries(fields).filter(([, item]) => item));
}

function serverParentRoot() {
  return outputDirectoryHandle ? ".output/browser_upload_archive" : value("#parentRoot");
}

async function pickFolderViaServer() {
  const picker = await postJson("/api/pick-folder", {
    initialPath: value("#parentRoot") || ".",
    description: "选择外包文档文件夹路径"
  });
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    const response = await fetch(`/api/pick-folder/${encodeURIComponent(picker.id)}`);
    const data = await response.json();
    if (data.status === "success") return data;
    if (data.status === "cancelled") throw new Error("已取消选择文件夹。");
    if (data.status === "failed") throw new Error(data.error || "选择文件夹失败。");
  }
  throw new Error("选择文件夹超时，请直接把路径粘贴到输入框。");
}

async function updateSelectedPathPreview() {
  if (!selectedPathPreview) return;
  if (outputDirectoryHandle) {
    selectedPathPreview.textContent = `已选择文件夹：${outputDirectoryHandle.name}；最终写入：${outputDirectoryHandle.name}/${value("#folderName") || "外包文件夹"}。浏览器安全限制不会暴露完整磁盘路径，如需显示 F:\\... 请直接粘贴完整路径。`;
    return;
  }
  if (!value("#parentRoot")) {
    selectedPathPreview.textContent = "尚未选择外包文档文件夹路径。";
    return;
  }
  try {
    const params = new URLSearchParams({
      parentRoot: value("#parentRoot"),
      folderName: value("#folderName") || "外包文件夹"
    });
    const response = await fetch(`/api/path-preview?${params.toString()}`);
    const data = await response.json();
    selectedPathPreview.textContent = `已选择位置：${data.projectRoot}`;
  } catch {
    selectedPathPreview.textContent = `将使用：${value("#parentRoot")}\\${value("#folderName") || "外包文件夹"}`;
  }
}

function resetOutputSelection() {
  outputDirectoryHandle = null;
  outputProjectHandle = null;
  uploadState.sessionId = "";
  uploadState.folders = null;
}

async function ensureBrowserProjectFolder() {
  if (!outputDirectoryHandle) return null;
  if (outputProjectHandle) return outputProjectHandle;
  outputProjectHandle = await outputDirectoryHandle.getDirectoryHandle(value("#folderName") || "audio_outsource", { create: true });
  for (const folder of ["videos", "images", "requirements", "skillDocuments", "references", "styles", "audioReferences", "outputs"]) {
    await outputProjectHandle.getDirectoryHandle(folder, { create: true });
  }
  return outputProjectHandle;
}

async function writeUploadedFileToBrowserFolder(kind, file, relativePath) {
  const projectHandle = await ensureBrowserProjectFolder();
  if (!projectHandle) return;
  const folderHandle = await projectHandle.getDirectoryHandle(kind, { create: true });
  await writeFileByRelativePath(folderHandle, relativePath || file.name, file);
}

async function deleteBrowserFolderFile(record) {
  const projectHandle = await ensureBrowserProjectFolder();
  if (!projectHandle) return;
  const folderHandle = await projectHandle.getDirectoryHandle(record.kind, { create: false });
  const parts = record.relativePath
    .split(/[\\/]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const fileName = parts.pop();
  let dir = folderHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: false });
  }
  if (fileName && dir.removeEntry) {
    await dir.removeEntry(fileName);
  }
}

async function writeFileByRelativePath(rootHandle, relativePath, fileOrText) {
  const parts = relativePath
    .split(/[\\/]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const fileName = parts.pop() || "upload.bin";
  let dir = rootHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(fileOrText);
  await writable.close();
}

async function pollJob(jobId) {
  for (;;) {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await response.json();
    statusBox.textContent = formatJob(job);
    if (job.status === "success") {
      if (job.runId) await showRun(job.runId);
      if (job.feishuUrl) {
        window.open(job.feishuUrl, "_blank", "noopener");
      }
      if (job.runId) {
        void saveFinalOutputsToBrowserFolder(job.runId).catch((error) => {
          statusBox.textContent += `\n本地所选目录同步失败：${error.message}`;
        });
      }
      return;
    }
    if (job.status === "failed") throw new Error(job.error || "运行失败");
    await sleep(1000);
  }
}

async function showRun(runId) {
  const response = await fetch(`/api/runs/${runId}`);
  const run = await response.json();
  selectedRun.textContent = runId;
  preview.textContent = run.markdown || "没有可预览的 Markdown。";
}

async function saveFinalOutputsToBrowserFolder(runId) {
  const projectHandle = await ensureBrowserProjectFolder();
  if (!projectHandle) return;
  const response = await fetch(`/api/runs/${runId}`);
  const run = await response.json();
  const outputs = await projectHandle.getDirectoryHandle("outputs", { create: true });
  await writeTextFile(outputs, "final_document.md", run.markdown || "");
  await writeTextFile(outputs, "run_summary.json", JSON.stringify(run.summary || {}, null, 2));
  statusBox.textContent += `\n已同步最终文档到：${outputDirectoryHandle.name}/${value("#folderName")}/outputs`;
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    })
  ]);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function getZoneFilesBox(kind) {
  return document.querySelector(`[data-files-for="${kind}"]`);
}

async function writeTextFile(dirHandle, fileName, text) {
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
}

function formatJob(job) {
  return [
    `状态：${job.status}`,
    job.runId ? `runId：${job.runId}` : "",
    job.runDir ? `runDir：${job.runDir}` : "",
    job.markdownPath ? `markdown：${job.markdownPath}` : "",
    job.feishuUrl ? `飞书文档：${job.feishuUrl}` : "",
    job.error ? `错误：${job.error}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
