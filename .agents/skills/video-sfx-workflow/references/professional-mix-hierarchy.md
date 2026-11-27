# 专业参考与本工具的听感约束

2026-11-27 基于公开文档与演讲章节说明整理；未把阅读演讲说明等同于完整试听或看完演讲。

## 参考来源

- Audiokinetic / Harvey Scott、Damian O'Sullivan：《Mixing Helldivers 2: An Overview | Wwise Tour Shanghai 2024》。官方发布页列出 00:07:31 声音优先级、00:27:05 HDR基础、01:03:39 对白混音。用于参考先建立声音优先级，再动态让位的设计方向。https://www.youtube.com/watch?v=xpKLY69b2ZE
- Audiokinetic：《Wwise HDR User's Guide》。文档指出，HDR可能让仍高于阈值的远距离主声保持相近输出、转而压低其他声音。用于提醒总线处理不能抵消距离层次，并非要求本工具引入HDR。https://www.audiokinetic.com/download/documents/Wwise_HDR_UserGuide_en.pdf
- Epic Games：《Sound Attenuation》。按听者与实际声源位置处理距离；焦点增益与距离衰减分开处理。https://dev.epicgames.com/documentation/en-us/unreal-engine/sound-attenuation?application_version=4.27

## 落地到工作台

1. 先判断声音是否合理：主体、材质、重量、步态和接触方式。音量降低不能补救把普通迈步选成巨兽重踏的错误。
2. 先建立主线：预警、蓄势、释放、首次真实接触、吼叫；给它们留出动态与留白。
3. 普通脚步、衣物、碎屑退后；近景不等于都要响亮。普通迈步不与中景Boss主捶地同级。
4. 远近、重要度、源电平分别处理；总线不可把远景和细节重新拉到前景。实际片段峰值与尾音也要听，不仅看整文件平均值。
5. 不添加无画面依据的后续重击、撤步或装饰声。保留原速原调、自然尾音和边缘淡入淡出。
6. 已认可成片只做用户要求的局部混音修正，另存可比较版本。重新选材或重新分析需有对应请求。
7. 自动回归覆盖误标key、前缀命名、近脚步/中景重击、缺测量和真实落地例外；实片交付仍需试听。数值是本工具初始值，不称为行业规定或物理声压测量。
