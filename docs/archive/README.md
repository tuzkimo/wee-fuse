# 归档区：已执行完的阶段文档

**这里是历史证据，不是当前口径。** 新会话不必读它；要知道现在的规则看
[`../开发约定详解.md`](../开发约定详解.md)，要知道用户视角的功能看 [`../../README.md`](../../README.md)。

## 为什么单独放一层

2026-10-13 从 `docs/superpowers/` 整体搬来（`git mv`，历史保留）。搬的理由与实测数字：
这 49 个文件（47 份 md + 4 张屏稿）占 **3.13 MB / 5.4 万行**，其中 `plans/` 一个目录
**43,754 行里 71% 是源码副本**（`plans/*` 是当时的实现计划，执行完即过期）。它们此前与「当前口径」
混在同一个目录下，任何按目录遍历去了解项目的读法都会掉进来。

**搬动只改了路径**：`plans` / `specs` / `notes` 三个目录互为兄弟、相对深度与搬前一致，
所以它们**之间**的相对链接（`../specs/...`）一条都不用改——体检结果：全 `docs/` 115 条链接里
18 条断，其中 **17 条是搬动前就有的深度写错**（写成 `superpowers/specs/...` 而少了 `../`），
**只有 1 条是本次造成的**（指向已删的 `docs/开发文档索引.md`）。

**历史正文里的路径不逐处改**（包括那 17 条旧的深度错误）：按「只加更正注记，不改历史正文」的
口径，本文件是唯一允许随搬动一起改 path 的文件。

## 归来的新计划写到哪

计划仍按 superpowers 的默认落盘位置写到 `docs/superpowers/plans/`：**执行完的**才搬到这里。规矩见根
`AGENTS.md` 的「superpowers 落盘约定」。

## 逐阶段文档（延后项账本）

| 阶段 | 设计规格 | 实现计划 | 构建记录 | 延后项唯一真源 |
|---|---|---|---|---|
| 第一阶段：图像引擎 | [规格](specs/2026-09-30-image-to-pattern-design.md) | [计划](plans/2026-09-30-engine.md) | [记录](notes/2026-10-01-engine-build-log.md) | 记录 §9（`L1–L11`） |
| 计划 B1：应用层骨架 | [规格](specs/2026-10-03-app-skeleton-design.md) | [计划](plans/2026-10-03-app-b1-skeleton.md) | [记录](notes/2026-10-03-app-b1-build-log.md) | 记录 §8（`B1-1…B1-20`） |
| 计划 B2：选区与参数页 | [规格](specs/2026-10-03-app-b2-crop-settings-design.md) | [计划](plans/2026-10-03-app-b2-crop-settings.md) | [记录](notes/2026-10-03-app-b2-build-log.md) | 记录 §8（`B2-1…B2-57`） |
| 计划 B3：编辑器 | [规格](specs/2026-10-04-app-b3-editor-design.md) | [计划](plans/2026-10-04-app-b3-editor.md) | [记录](notes/2026-10-04-app-b3-build-log.md) | 记录 §8（`B3-1…B3-42`） |
| 计划 B4：导出 | [规格](specs/2026-10-05-app-b4-export-design.md) | [计划](plans/2026-10-05-app-b4-export.md) | [记录](notes/2026-10-05-app-b4-build-log.md) | 记录 §8（`B4-1…B4-35`） |
| 计划 B5：Tauri Android 壳 | [规格](specs/2026-10-06-app-b5-tauri-shell-design.md) | [计划](plans/2026-10-06-app-b5-tauri-shell.md) | [记录](notes/2026-10-06-app-b5-build-log.md) | 记录 §6 / §7（`B5-1…B5-26`） |
| 文档重构（README 瘦身） | [规格](specs/2026-10-07-readme-and-dev-notes-restructure-design.md) | — | — | — |
| 计划 B6：上限收敛与导出体验 | [规格](specs/2026-10-08-app-b6-cap-and-export-design.md) | [计划](plans/2026-10-08-app-b6-cap-and-export.md) | [记录](notes/2026-10-08-app-b6-build-log.md) | 记录 §5（`B6-1…B6-13`） |
| C7：施工图改版与出口收敛 | [规格](specs/2026-10-09-c7-sheet-style-and-exports-design.md) | [计划](plans/2026-10-09-c7-sheet-style-and-exports.md) | — | — |
| C8：出口与交互重做、看图 / 打印改造、图面版式放大 | [规格](specs/2026-10-10-c8-exits-viewer-and-layout-design.md) | [计划](plans/2026-10-10-c8-exits-viewer-and-layout.md) | [记录](notes/2026-10-10-c8-build-log.md) | 记录 §6（16 条，按 6.1–6.4 分组） |
| 去背景（事前 + 事后） | [规格](specs/2026-10-11-background-removal-design.md) | [计划](plans/2026-10-11-background-removal.md) | — | 规格 §10（延后项） |
| 按色号批量换色 | [规格](specs/2026-10-11-batch-recolor-design.md) | [计划](plans/2026-10-11-batch-recolor.md) | [记录](notes/2026-10-11-batch-recolor-build-log.md) | 规格 §10（延后项） |
| D1：像素风 UI 重设计 | [规格](specs/2026-10-12-pixel-ui-design.md) | [计划](plans/2026-10-12-pixel-ui.md) | — | 规格 §13 |
| D1 实机修复轮：像素风 UI 真机反馈修复 | [规格](specs/2026-10-12-pixel-ui-design.md)（同上，只在其中加更正注记） | [计划](plans/2026-10-12-pixel-ui-realdevice-fixes.md) | [记录](notes/2026-10-12-pixel-ui-realdevice-fixes-build-log.md) | 记录 §4（仍未验证清单） |
| 编辑页填充与工具改造（空格可填 / 橡皮入口 / 拖动工具 / 纸底） | [规格](specs/2026-10-13-editor-fill-and-tools-design.md) | [计划](plans/2026-10-13-editor-fill-and-tools.md) | [记录](notes/2026-10-13-editor-fill-and-tools-build-log.md) | 规格 §9 + 记录 §4 |
| 生图页 / 结果页预览改造（版式断点 · 网格块预览 · 实时预览） | [规格](specs/2026-10-13-setup-preview-and-layout-design.md) | [计划](plans/2026-10-13-setup-preview-and-layout.md) | [记录](notes/2026-10-13-setup-preview-build-log.md) | 规格 §9 + 记录 §4 |

**引用延后项时一律引「延后项唯一真源」那一列。** 四行没有构建记录（文档重构、C7、去背景、D1），
它们的真源是规格的某一节——这一列的口径自 2026-10-07 起就不统一，据实保留。

**改写历史构建记录必须先经人类伙伴明确批准**，默认口径是「只加更正注记，不改历史正文」
（报告是**当时的**证据）。这份 README 是唯一允许随搬动一起改 path 的文件。

## 两条读这份归档前要知道的事

1. **文档里提到 `.superpowers/sdd/<日期>-<主题>/` 的地方找不到是预期内的**：那些是本机草稿路径，
   从未入库。持久证据就是这里的 `notes/`。
2. **归档里的规格是「当时要做什么」，不是「现在是什么」**：`specs/2026-10-12-pixel-ui-design.md`
   一个文件就有 24 处「更正」，`specs/2026-10-08-app-b6-cap-and-export-design.md` 的常量表半数行
   已被 C7 取代。要当前口径一律看 `../开发约定详解.md`。
