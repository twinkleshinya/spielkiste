# Spielkiste

## Spielkiste

Windows 桌面版：运行 `Spielkiste-0.1.0-Setup.exe` 安装，内置 Node、FFmpeg、FFprobe 和 Git。简明说明见 [使用说明](docs/Spielkiste-团队使用说明.md)。每次启动默认新建项目，个人记录和授权不随安装包分发。

源码版：安装 Node.js 22+、FFmpeg/FFprobe 后双击 `Spielkiste.bat`。打包用 `npm run desktop:dist`，先运行回归再构建安装包，成功后将工具代码自动提交推送到 `tool-git.json` 中的仓库。源码版启动时自动监听代码修改，类型检查通过后记录和同步；`npm run tool:history` 查看历史，`npm run tool:restore -- 提交号` 生成恢复提交。网络失败保留本机记录并重试。

项目与代码分离：项目默认本地保存和回退。右上角 Git 设置支持自定义仓库和 GitHub 浏览器登录；只有点击“上传项目到 Git”才上传到 `spielkiste-projects` 分支，可选附带视频、预览和已用素材（单文件最多 95 MB）。其他电脑可下载带媒体项目继续编辑；原素材库与密钥不上传。

点击右上角 **AI 连接**：自动读取当前 CC Switch/Codex 配置，或手动填写管理员提供的 API Base URL、Gemini 模型、授权和图片接口类型。**保存并测试**会验证合成图片与测试音，两个输入通道都通过后才能开始新的自动分析；凭据保存在本机用户目录，不进入项目或 Git。

选择视频和本机音效库，点击 **分析并生成视频**。固定流程：Gemini 全片/分段/查漏/接触点分析 → 本地名称与声音意图检索 → 不同音色备选 → Gemini 复核关键和疑难候选 → 发声段落剪辑 → 按远近及主次自动混音。素材只来自指定目录，原视频声音静音，原速原调，无新增混响。

修改、替换、静音或删除音效先暂存在本机，点击“更新视频预览”后统一生成新版本；刷新可恢复暂存内容，也可撤销暂存修改。桌面版项目自动保存到 `%APPDATA%\Spielkiste\workspace`（源码版在 `.output`） 并保留历史版本，已保留预览可离线重开。可导出 MP4、WAV、贴片 JSON/CSV，以及带视频轨、分类文件夹和独立音效轨的 REAPER 工程。分享请复制整个工程文件夹；转格式/采样率/声道使用本机 REAPER。

- 优先目录和关键词只调整合适候选的排序，不改变音量。
- 排除目录包含子目录；文件名或路径含禁用关键词的素材不参与新选材（忽略大小写）。优先权重和 Gemini 均不能覆盖排除规则，已用音效保持原样。
- Gemini 会接收视频抽帧及候选音频片段；音视频文件、项目和授权不会自动上传 Git。
- 工具内模型设置不改变其他对话或全局 CC Switch 设置。
- `npm run test:onboarding` 检查首次配置；`npm test` 运行完整回归，需要可启动的 FFmpeg/FFprobe。自动检查不代替最终听感验收。

这是一个 TypeScript / Node.js 的 multi-agent orchestration MVP，用于从本地视频素材、项目需求和参考资料生成游戏音频外包需求文档，并通过已有 Feishu-Skill / `feishu-tool` CLI 写入飞书。

当前优先完成 P0/P1：本地视频扫描、`ffprobe` metadata、关键帧缩略图、参考包、技能/PV 可编辑分析框架、音频风格画像、设计清单、QA、排期、默认模板、Markdown 输出、飞书 dry-run blocks，以及在 `feishu-tool` 可用时创建/写入文档。

已加入可选 MOSS-Audio 增强：上传已有声音参考后，可生成 `audio_reference_analysis.json`，用于沉淀“保留方向 / 避让方向 / 声音调色盘 / 混音注意事项”。未安装 MOSS-Audio 时不会阻塞主流程，会输出可人工补充的分析框架。

## 架构

```text
src/
  cli.ts
  index.ts
  orchestrator/
  agents/
  adapters/
    FeishuAdapter.ts
    FfmpegAdapter.ts
    MossAudioAdapter.ts
    ModelAdapter.ts
    FileAdapter.ts
  schemas/
  prompts/
  templates/
  renderers/
  utils/
examples/
tests/
.output/
```

每次运行都会写入：

```text
.output/runs/{runId}/
  config.json
  agents/{AgentName}/input.json
  agents/{AgentName}/{agent_output}.json
  document_model.json
  final_document.md
  feishu_blocks.json
  run_manifest.json
  final_summary.json
```

这些 JSON 可以人工修改后执行 `resume`，下游 agent 会读取已有结果继续。

## 安装

```bash
npm install
```

需要本地可用：

- Node.js 22+
- `ffprobe` / `ffmpeg`
- 可选：官方 `lark-cli`（推荐）或旧版 Feishu-Skill 提供的 `feishu-tool`

`npm run dev -- ...` 会先编译 TypeScript，再运行 `dist/src/cli.js`，因此在受限环境里也不依赖运行时转译服务。

`.env` 不应提交。可参考 `.env.example`：

```bash
FEISHU_AUTH_TYPE=tenant
MODEL_PROVIDER=local
```

MOSS-Audio 是可选能力。如果已经部署好 MOSS-Audio，可以在 `.env` 中选择一种方式配置：

```bash
# 方式 1：命令模板，工具会替换 {{audioPath}} 和 {{prompt}}
MOSS_AUDIO_COMMAND=python F:\MOSS-Audio\infer_cli.py --audio-path {{audioPath}} --prompt {{prompt}}

# 方式 2：脚本模式，脚本需支持 --audio-path / --prompt / 可选 --model-path
MOSS_AUDIO_PYTHON=python
MOSS_AUDIO_SCRIPT=F:\MOSS-Audio\infer_cli.py
MOSS_AUDIO_MODEL_PATH=F:\MOSS-Audio\weights\MOSS-Audio-4B-Instruct
```

不配置时也可以上传声音参考，工具会在文档中生成“待 MOSS/人工补强”的风格分析区域。

任务/成员能力通常需要：

```bash
FEISHU_AUTH_TYPE=user
```

官方飞书 CLI 安装：

```bash
npm install -g @larksuite/cli --registry=https://registry.npmmirror.com
npx skills add larksuite/cli -y -g
lark-cli config init --new
lark-cli auth login --recommend
lark-cli auth status
lark-cli doctor
```

## Windows 一键打开

普通使用者不需要手动运行 `npm run ui`。在 Windows 上直接双击项目根目录的：

```text
start-ui.bat
```

它会自动检查 Node.js / npm、首次安装依赖、编译 TypeScript、启动本地 UI 服务，并打开浏览器页面。

如需放到桌面，运行：

```bash
npm run shortcut
```

会在桌面创建 `Spielkiste.lnk` 快捷方式，目标为 `Spielkiste.bat`。把整个项目文件夹复制到别的电脑后，也可以在那台电脑上重新运行一次 `npm run shortcut`。

分发给其他电脑时，最少需要 Windows 10/11、Node.js LTS；如果要读取视频 metadata，需要 ffmpeg/ffprobe；如果要读写飞书，需要安装并登录 lark-cli。

## 命令清单

启动图形界面：

```bash
npm run ui
```

然后打开：

```text
http://localhost:4317
```

界面支持拖拽或选择文件上传。上传后会归拢到你在界面中创建的外包文件夹，默认类似：

```text
outsourcing_projects/{外包文件夹名}/videos
outsourcing_projects/{外包文件夹名}/images
outsourcing_projects/{外包文件夹名}/requirements
outsourcing_projects/{外包文件夹名}/references
outsourcing_projects/{外包文件夹名}/styles
outsourcing_projects/{外包文件夹名}/audio_references
```

需求说明、参考资料、风格说明都支持上传本地文件，也可以粘贴飞书文档 token。声音参考可以上传 wav/mp3/ogg/flac/m4a/mp4 等文件，并勾选“启用 MOSS-Audio 声音参考分析”。飞书内容仍通过 `FeishuAdapter` 调用已有 `feishu-tool` 读取。

内置模板：

- `技能音效`：`https://leiting.feishu.cn/sheets/Dfv1sUOxthaBmrtlZJrcicdTnRd`
- `界面音效`：`https://leiting.feishu.cn/wiki/EbmJw5LT7idcrzkCTEhcQw66nWg`
- `PV音效`：`https://leiting.feishu.cn/docx/Epf0dfxdDoTuHgxmIvachU1fnLc`

界面会根据模板类型显示不同的填写项：

- `技能音效`：角色/职业/技能组、技能设计重点、音效数量、命名前缀、发包/初版/验收时间。
- `界面音效`：系统/界面名称、系统说明、功能/动效清单、界面音效设计要点、音效数量、命名前缀、发包/初版/验收时间。
- `PV音效`：PV 名称、PV 剧情/画面说明、关键点位、是否有对白/语音、音乐/氛围关系、音效数量、命名前缀、发包/验收时间。

运行时会优先用官方 `lark-cli` 读取模板原文；读取成功后会保存到本次 run 的 `template_raw.md`，并生成 `template_analysis.json` 分析模板需要填充的字段。若 `lark-cli` 未认证或无权限，会按所选模板回退到对应的业务模板画像，而不是普通默认模板：

- `技能音效`：重点生成参考风格与避让说明、技能视频清单、cast/charge/release/hit/damage/movement/loop/end 拆解、技能音效设计清单、命名、验收和排期。
- `界面音效`：重点生成系统说明、界面流程、功能/动效清单、设计要点、需求详细说明、参考风格/保留/避让、验收和反馈节点。
- `PV音效`：重点生成 PV 说明、音效设计要点、关键点位参考说明、镜头/关键点位音频设计清单、音频风格与混音关系、交付验收。

声音参考分析会被填入模板的参考风格区域，并同步影响音频风格画像和设计清单。

初始化：

```bash
npm run dev -- init
```

扫描视频：

```bash
npm run dev -- ingest --input ./videos --project "ProjectName"
```

注册模板：

```bash
npm run dev -- template:add --name "技能外包模板" --source feishu --doc-token xxx
npm run dev -- template:add --name "PV外包模板" --source local --path ./templates/pv.md
```

列出模板：

```bash
npm run dev -- template:list
```

完整运行：

```bash
npm run dev -- run \
  --input ./videos \
  --project "ProjectName" \
  --requirement "./examples/requirement.md" \
  --references "./examples/references" \
  --style "./examples/audio_style.md" \
  --audio-reference "./examples/reference_audio.wav" \
  --moss-audio \
  --template "技能外包模板" \
  --folder-token "xxx"
```

dry-run：

```bash
npm run dev -- run --input ./videos --project "ProjectName" --dry-run
```

resume：

```bash
npm run dev -- resume --run-id "xxx"
```

只跑指定 agent：

```bash
npm run dev -- run --input ./videos --project "ProjectName" --only VideoIngestionAgent,ReferenceCollectorAgent,AudioStyleProfilerAgent --dry-run
```

## Agent 列表

- `VideoIngestionAgent`：递归读取 `mp4/mov/mkv/webm`，提取 metadata、缩略图和初步类型。
- `ReferenceCollectorAgent`：读取本地 markdown/txt/json 和飞书参考文档，整理 reference pack。
- `RequirementUnderstandingAgent`：判断项目类型并生成拆解规则。
- `VideoContentAnalysisAgent`：生成技能/PV/通用时间轴；未配置视觉模型时输出人工补充框架。
- `AudioReferenceAnalysisAgent`：可选调用 MOSS-Audio 分析已有声音参考，输出保留/避让/混音/材质说明。
- `AudioStyleProfilerAgent`：把风格词转为可制作的声音语言。
- `AudioDesignPlanAgent`：生成每个事件/段落的资产设计方案。
- `AssetNamingAgent`：生成命名规范。
- `QualityGateAgent`：生成交付和验收标准。
- `SchedulePlanningAgent`：生成排期；`FEISHU_AUTH_TYPE=user` 且 `feishu-tool` 可用时尝试创建任务。
- `TemplateManagerAgent`：注册、列出、选择模板。
- `ReviewAndPolishAgent`：总编审稿并汇总风险。
- `FeishuDocumentAgent`：通过 `FeishuAdapter` dry-run 或写入飞书。

## Spielkiste

`npm run sfx` 启动本机 `/sfx`。默认“⑥版标准音效流程”：上传视频或填写路径，选择本机音效库（音乐库可独立选择），生成带音效预览和可编辑清单。素材库直接读取，无需全库上传。

工作台右上角的“AI 连接”用于配置本工具专用的 Gemini 网关。它会自动发现本机 CC Switch/Codex 配置，也允许填写配置文件路径或手动网关，支持“测试连接”；凭据只保存到用户级目录 `%LOCALAPPDATA%\\Spielkiste\\ai-config.json`，不会写入项目、预览、REAPER 工程或 Git。标准生成在连接测试通过前会直接提示修复，不会先扫描完整素材库再失败。

Gemini全片/分段/查漏/接触点分析 → 名称与声音意图检索 → 有差异备选 → Gemini关键及疑难候选判断 → 发声段落复核 → 短fade与自动混音 → 视频及配置/质量报告。原视频音轨数字静音，原速原调，无额外混响，保留源素材空间尾音。

项目技能只作为仓库内部维护，不在工作台展示。完整复盘与配置：[reference-v6.md](.agents/skills/video-sfx-workflow/references/reference-v6.md)。历史版本不覆盖，手动锁定保持。

### 团队 Git 与项目版本

Spielkiste 使用双层存储：工具代码、启动脚本、测试和文档进入 Git；本机项目索引、视频、音效素材库、预览 MP4/WAV、索引缓存、`.output/` 和 CC Switch/Codex 授权留在每台电脑本机。每次打开工作台默认进入空白新建项目，不会自动加载这台电脑最近打开的项目；从“已保存项目”选择，或使用带 `?run=<版本ID>` 的历史链接，才会打开旧版本。用户点击“手动同步到 Git”后，才把当前项目目录中的轻量版本摘要提交到 Git。工作台的“已保存项目”按稳定 `projectId` 聚合为一条，版本历史仍可打开；重命名不创建音效版本，另存为创建新项目，回退会创建新的恢复版本并保留旧版本。

普通生成、编辑、静音、删除、回退和另存为只保存本机项目版本，不会自动执行 `git add`、`git commit` 或 `git push`。即使项目没有上传 Git，也可以从工作台打开历史版本或回退。

在工作台点击“手动同步到 Git”后，才会提交当前项目的轻量元数据，并尝试推送到 `origin`。视频、音频素材库、预览 MP4/WAV、索引缓存、`.output/`、`.env` 和 CC Switch/Codex 授权始终留在本机。Git 适配器只暂存 `projects/` 管理的元数据文件，保留团队成员其他未提交文件。

项目状态显示“仅保存在本机”“已提交到本机 Git”“Git 已同步”或“待同步/Git 不可用”。

新成员准备环境：

```powershell
git clone <团队仓库地址>
cd <仓库目录>
# 首次会自动安装依赖；无需复制 .env
.\Spielkiste.bat
```

当前仓库还没有配置远程地址。`https://github.com/dashboard` 是 GitHub 仪表盘，不是具体仓库地址。登录 GitHub 并创建或选择仓库后，执行 `git remote add origin <具体仓库地址>` 和 `git push -u origin master`，或在工作台使用“手动同步到 Git”。不要把 `.env`、API key、公司网关配置或大型媒体加入仓库。

配置 v1.0.2：点击“保留本版音效”后，同视频内容和素材库优先打开原版；编辑保存自动另存副本。搜索、重复点击已选素材、无修改保存和播放预览不会重裁已确认音效。仅自动混音保留源区间及fade；需要换声音时使用“重新选材 · 会换音效”。选材请求包含事件和每层声音意图，持续蓄力的脉冲/脆裂冲突会标记待试听，名称仍为参考。

```powershell
node .agents/skills/video-sfx-workflow/scripts/run.mjs --video "E:\demo.mp4" --library "E:\SoundLibrary"
```

测试包括标准默认值/模型隔离、源区间、名称例外、不同备选、淡入淡出、角色优先、混音幂等、报告诚实性、来源约束及API。音效判断和主观听感仍需试听验收；自动检查不等于最终质量保证。

## 验证

```bash
npm run typecheck
npm test
```

## FeishuAdapter 说明

项目不会重写飞书 SDK，只通过 `FeishuAdapter` 封装 CLI。现在优先使用官方 `lark-cli`，旧版 `feishu-tool` 仅作为兜底。当前 adapter 方法包含：

- `checkAvailability()`
- `getConfig()`
- `createDocument()`
- `getDocumentBlocks()`
- `batchCreateBlocks()`
- `batchUpdateBlockText()`
- `createTable()`
- `uploadImageToBlock()`
- `searchDocuments()`
- `createTasks()`
- `getUsers()`

如果 `feishu-tool` 不可用，工具仍会输出本地 `final_document.md` 和 `feishu_blocks.json`。

