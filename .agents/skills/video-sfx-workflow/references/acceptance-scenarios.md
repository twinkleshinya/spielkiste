# 方法应用验收

这些情景验证技能所约束的实际工作台行为。运行 `npm test`；场景结果和端到端证据在 `.output/sfx/fixed-workflow-verification/`，不把纯文档关键字匹配视为能力测试。

| 情景 | 正确决定 / 证据 |
| --- | --- |
| .7秒张嘴动作，8秒素材含3次吼叫 | 选一次完整主体加短释放；先试听/模型复核源区间，不能由文件时长编造确定段落，也不整段8秒播放。见testSoundAwareSourceLengths、testGeminiSourceEditBoundaries |
| cast_01..05来自同一take | 合并成一个家族，选不同材质/瞬态；候选不够就少给，不凑满。见testMeaningfulFilenameAlternatives、testMeasuredCandidateSimilarity |
| 收势最合适的文件带start，另一个end音色很差 | 名称提示降权/记录，真实音频证据可覆盖，不能硬删。见testGeminiNameAdviceOverride |
| 裁剪.6秒贴片、源前后仍有声音 | 保留有效5ms/80ms或按长度缩小；人工锁定例外在报告列出。见testCroppedEdgeFades、testWorkflowExportEvidence |
| 想要⑥空间感但未要求混响 | 不添加混响、不变速变调，保留源尾音并做层级和避让；不声称源本来没有混响。见testAutoMixHierarchy、testCharacterVocalPriority及运行filter核对 |
| 只允许库音频，原片自带音效 | 标准数字静音原视频，历史原音设置保留并在报告记录，界面无混入开关。见testStandardWorkflowDefaults、testWorkflowForkProvenance |
| Gemini首次点位成功但短窗复查失败 | 阶段partial，待复核；不能标全部完成。见testWorkflowExportEvidence |
| Gemini点位完全失败 | 自动任务failed，不能镜头检测冒充。见testGeminiTimingRequired |
| 单独音乐目录 | 来源检查接受显式音乐根目录，目录外素材fail。见testWorkflowExportEvidence |
| 只重混音旧版本 | 点位/选材标reused，当次usage不含旧token，不重置自定义选项。见testWorkflowForkProvenance、testAutoMixFork |
| 用户要求上一版，工具需要验证流程 | 直接打开已认可预览，保留本版；同内容上传副本打开原run，不为验证再选一批。见testPreservedVersionReuse及⑥hash检查 |
| 旧贴片无sourceEdit字段，但已认可其1.1秒咆哮 | 纯混音保留1.1秒主体/尾音及原截取起点和fade，不能缩成.27秒。见testRemixPreservesSourceRanges |
| 看历史⑥报告 | 按已有证据只读构建，不修改原run/媒体；历史未保存scope保持未知。见testWorkflowApiResources与历史hash检查 |
| 保存已保留版本的电平编辑 | 自动另存编辑副本，原run/媒体不变；同视频仍打开原保留版。无修改保存不增加revision。见testPreservedEditCreatesChild、testPreservedNoOpAndReadOnlySearch |
| 已保存fade较长、源时长含小数 | 预览/纯混音精确保留，不按默认fade重算、不把小数裁短。见testRetainedFadesSurviveMix、真实FFmpeg testSavedPreviewRetainsMix |
| 连续蓄力被模型选成脆裂loop | 请求包含event.query、layerQuery和声体冲突；若仍选中则标待试听，不能声称选材已验收；明确需要脉冲则允许。见testSelectionReceivesSoundIntent |
| 静音整个点位，然后恢复 | 网页先暂存、不渲染，不改贴片enabled；原本单独关闭的音效不能跟着恢复。点击更新预览才批量提交。见testSfxEditsWaitForExplicitPreviewUpdate；兼容API见testQuickEditApi |
| 删除一个音效或整个点位 | 单音效删除保留点位，删点位同时删关联贴片；只在点击更新预览后渲染，无模型请求，原run/媒体不变。见testSfxEditsWaitForExplicitPreviewUpdate |
| 删除全部音效 | 点击更新预览后输出可播放的静音视频，不要求至少保留一条素材。渲染能力见testQuickEditApi |
| 工作台首次制作 | 视频/目录/名称及可选优先路径权重；固定Gemini点位与关键选材，不要求用户选择模式、音乐开关或选材范围。见simple-edit-verification浏览器证据 |
| 从候选里换用另一个素材 | 选用只暂存，不请求保存/渲染；点击更新预览一次提交全部修改，保留播放位置和其他层，模型请求为0。见testSfxEditsWaitForExplicitPreviewUpdate |
| 更新预览提交或渲染失败 | 仍显示旧预览，保留暂存修改、原run和草稿，允许重试；不假称新视频已生成。见testSfxDraftRecoveryAndPreviewFailures |
| 暂存后刷新、切换项目或撤销 | 同run/revision草稿恢复；旧revision不覆盖新修订；撤销恢复已保存内容且不渲染，新编辑取消旧撤销确认。见testSfxDraftRecoveryAndPreviewFailures、testSfxDraftCanBeDiscardedWithoutRendering |
| REAPER只输入工程名、有待更新的修改 | 自动补.rpp且不重复已有后缀；名称模式打包独立媒体工程。暂存未应用时导出提示先更新，不暗中渲染。见testReaperNamesWithoutExtension、testReaperUiAcceptsNamesAndNeverRendersEdits |
| 工作台呈现 | 不展示技能包、技能文档或下载入口；内部技能继续使用。见simple-edit-verification浏览器证据 |
| 远处Boss吼叫、捶胸，同时有脚步和碎屑 | 远处主体相对近处衰减，仍明显高于远处细节；普通脚步接触不因impact类别被保护为前景。见testDistanceMixHierarchy |
| 远处Boss投出的石头落在玩家身旁 | 起手/吼叫在远处，命中按实际近处落点；30FPS复核可纠正distance，纯校时不抹掉已有依据。见testDistanceAnalysisAndPersistence |
| 所有声源都在远景，总线自动归一 | 距离余量降低有效目标，线性总线保留远近关系，实际输出远景更轻；不是一律补到−20LUFS。见真实FFmpeg testDistanceRenderedHeadroom |
| 未知距离、置信度不足、UI或音乐 | 未知保持中性并标复核；UI/音乐/环境底床不继承Boss距离，不能编造米数。见testDistanceMixHierarchy |
| 重复混音、锁定、预览或导出距离结果 | 从源基准重算而非累计衰减；锁定保留人工值；保存预览保持电平/区间，JSON/CSV带距离依据和实际减益。见testDistanceMixHierarchy及testDistanceAnalysisAndPersistence |

维护纠错额外证据放在`.output/sfx/workflow-correction-verification/`。模型替身用于验证请求字段及回退/复核行为，不证明真实Gemini下一次一定选对。

技能元数据验证用 Python UTF-8 模式：

```powershell
python -X utf8 C:/Users/jiangxy2/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/video-sfx-workflow
```

本轮独立子代理调用没有收到工具提供的任务正文，未取得有效的“有/无skill”新上下文对照，不能声称已通过此类模型遵从性评估；此处报告的通过项仅是元数据、运行行为与浏览器/媒体证据。后续若测试环境支持，可用表中情景盲测独立执行者。

| 点击本机目录选择、取消或路径不可读 | 页面内列一级目录，取消恢复操作，失败可改路径；不会等待失效的后台系统弹窗。见testLocalFolderBrowserApi及library-priority-verification浏览器证据 |
| 总库和优先子目录/外部目录 | 相关性优先、有界路径加分，重叠取max，外部目录懒索引、来源校验接受显式指定目录；配置进入保存/导出/Gemini依据。见testLibraryPathRanking、testLibraryPreferenceIndexAndFork、testGeminiReceivesLibraryPreference |

| 描述栏或声音要求写“只要叫声” | Gemini提取同等约束，常规分析后逐窗复核，移除其他动作/环境/音乐，补定位遗漏发声；候选明确符合描述才启用，模型失败无规则兜底。见testDescriptionConstraints |
| 普通描述“猩猩举手后吼叫一声” | 逐项关联举手和吼叫点位，允许其他真实动作；没有画面证据列缺口，已定位无素材也不能标覆盖完成；空描述不增加请求。见testDescriptionConstraints |
