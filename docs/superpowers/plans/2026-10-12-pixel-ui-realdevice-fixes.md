# 实机反馈修复计划（D1 之后）

> 来源：人类伙伴在真机（手机 + 平板）跑完整个流程后的 13 条反馈（手机 1–7、平板 1–3）。
> 前一轮的规格是 `docs/superpowers/specs/2026-10-12-pixel-ui-design.md`（下称 D1 规格），
> 本文是它的**实机修复轮**；涉及规格口径的条目按「先改文档、再改实践」在 D1 规格里加更正注记。

## 一句话根因

**四条手机问题里的 1 与 4 是同一个根因：覆盖层被挂在了吸顶 / 可滚容器内部。**
`SheetViewer` / `ExportPanel` 自身写着 `fixed inset-0 z-30/40`，但它们的 DOM 祖先是
`SetupPage` 的 `preview-pane`（`position: sticky` + `overflow-y-auto`）与 `ResultPanel`。
祖先建立不了「让后代的 z-index 参与根层级比较」的层级，于是：

- 生图页那条 `fixed inset-x-0 bottom-0 z-10` 的底栏画在覆盖层之上（反馈 4 的「底栏被完成按钮遮盖」）；
- 吸顶块自身没有 z-index，后面的兄弟（色数刻度、去背景开关，都带 `absolute`）按 DOM 顺序画在它上面（反馈 1）；
- 覆盖层没占满时，触摸滑动仍落到下层页面的滚动容器上（反馈 4 的「滑动外部区域能感到生图页在上下滑动」）。

图库路径把 `SheetViewer` 挂在页面顶层 → 没有这层祖先 → 一切正常。这正是「从图库看没问题」的原因，
也确认了根因是**挂载位置**，不是 z-index 数值。

## 逐条对照

| # | 反馈 | 根因 | 改法 |
|---|---|---|---|
| 手机1 | 色数刻度、去背景选框浮在吸顶框上 | 吸顶块无 z-index，后续兄弟按 DOM 顺序盖上去 | 吸顶块 `relative z-10`（并确认其背景不透明），参数区不设 z |
| 手机2 | 「生成图纸」与底部「开始拼」重复 | `ParamPanel` 仍持有 `generate`（§11.1 封闭清单当时不许删 testid） | 删按钮；同步把 `generate` 写进 §11.1 的删除清单（**人类伙伴已明确要求**） |
| 手机3 | 结果挤在吸顶框里，没有独立全屏 | §7.3 的中栏三态把 `ResultPanel` 塞进 48vh 盒 | 手机：生成并保存成功后 `push` 到独立结果页 `/edit/:id/result`；中栏在手机上只显示裁剪预览。平板保持一屏三栏 |
| 手机4 | 施工图底栏被完成按钮盖住、页面仍在滑动；打印页同样 | 覆盖层挂在吸顶/可滚祖先内（见上） | `SheetViewer` / `ExportPanel` 改 `<Teleport to="body">`，打开时锁 `body` 滚动，层级统一（施工图 50 / 打印 60，打印在施工图之上） |
| 手机5 | 重做与撤回同形；框线与色号很难区分 | `undo`/`redo` 是镜像矩形箭头；`labels` = `grid` + 一个小方块；`rerun` 复用了 `undo` 图形 | 新增 `rerun` 图标（循环箭头）；重画 `undo`/`redo` 让剪影不同而非只镜像；`labels` 改成「格子 + 格内 A 字」 |
| 手机6 | 重做与工具按钮放一起不合逻辑，应与保存同级 | §7.4 把它留在工具条最左 | `rerun` 从工具条移到顶栏 `editor-save` 旁（次级变体，`canRerun` 为假时不渲染）；工具条只剩 撤销/恢复 + 三工具 + 五个「看的方式」 |
| 手机7 | 图纸是黑边时与深色板底难分辨 | 板底 `#2A2320` 与黑豆 `#000000` 相邻无边界 | 画布给**图纸外框**画一圈可见边（`bead-hole` 2px），并把 `bead-board` 调到略亮（`#332B26`），两者都进 D1 §6.1 表 |
| 平板1 | 除手机 1–4 不存在外，其余相同 | — | 由上面各条覆盖 |
| 平板2 | 生图页/编辑页顶栏不吸顶 | `header` 是普通流内元素 | 两页 `header` 改 `sticky top-0 z-20`（编辑页因改成定高 shell 后天然固定，见下） |
| 平板3 | 工具栏不贴编辑区底部，被右侧长色板顶下去 | `PatternToolbar` 是「画布+色板」那一行之后的兄弟节点 | 编辑器改定高 app shell：`main md:h-screen md:overflow-hidden`，左栏 `flex flex-col min-h-0`（画布 `flex-1 min-h-0` + 工具条贴底），右栏 `md:overflow-y-auto` 独立滚动 |

## 不做的事

- 不重排平板的三栏结构（反馈说平板 1–4 不存在）。
- 不改 `recolor` / 多选换色 / 落盘格式 / `core/**`（除画布外框那一处绘制，仍在 `PatternCanvas` 里，不入 core）。
- 不引入新依赖、不动 `package.json`。

## 任务拆分（每个任务一次子代理实现 + 一次任务级审查 + 修复轮）

**T1 覆盖层挂到 body 顶层**（反馈 4 的手机症状 + 打印页同症状）
- `src/components/sheet/SheetViewer.vue`、`src/components/editor/ExportPanel.vue`：根节点改 `<Teleport to="body">` 包裹，保留现有 `fixed inset-0`；打开期间锁 body 滚动（用既有的 platform/服务层？没有就先做最简的 `document.body.style.overflow = "hidden"` 并在卸载/关闭时还原——**要写清为什么不用滚动手势拦截**）。
- 层级：施工图 `z-50`、打印 `z-60`；确认「结果页 → 看施工图 → 打印」这条链上打印在施工图之上。
- 验收（真窗口，手机尺寸）：① 施工图底栏完整可见且可点；② 覆盖层打开时滑动不再带动底层页面；③ 打印页同样；④ 图库路径（`LibraryPage` → `view-sheet`）不回归；⑤ 关闭后 body 滚动恢复。

**T2 生图页手机：吸顶块层级 + 生成后跳独立结果页**（反馈 1、3）
- `preview-pane` 加 `relative z-10`；参数区不加 z。
- `generate()` 成功且 `saved === true` 且 `!isWide` ⇒ `router.push({ name: "edit-result", params: { id: meta.id } })`；保存失败仍留在本页显示结果 + 重试（那条记录不在库里，没有可跳的 id）；平板路径一字不动。
- 手机上中栏在 `stage === "result"` 时不再渲染 `ResultPanel`（只显示裁剪预览）——`showDone` prop 保留给全屏宿主，不删。
- 验收：手机 ① 滚动时参数不浮在吸顶块上；② 点开始拼 → 进独立结果页；③ 保存失败那一支仍能在原位看到结果并重试；④ 平板仍是一屏三栏。

**T3 删掉 `ParamPanel` 的「生成图纸」按钮**（反馈 2）
- 删按钮 + 其 `generate` emit/prop 接线（页面仍有顶栏与手机底栏两个入口，不丢功能）。
- 文档：D1 规格 §11.1 的删除清单加 `generate`；§9 文件表里那句「本组件不再持有它」变成事实。
- 测试：删掉断言 `generate` 的用例（属于授权删除），**其余断言一律不许改**；页面级用例确认顶栏与底栏两个入口仍在。

**T4 顶栏吸顶 + 编辑器定高 shell**（平板 2、3）
- `SetupPage`：`header` 改 `sticky top-0 z-20`（手机吸顶块 z-10 在它之下）。
- `EditorPage`：`main` 在 `md` 下定高不滚（`md:h-screen md:overflow-hidden`），头部固定，主体行 `md:flex-1 md:min-h-0`，左栏 `flex min-h-0 flex-col`（画布卡片 `flex-1 min-h-0`，工具条紧随其后），右栏 `md:min-h-0 md:overflow-y-auto`。
- 手机保持现状（页面滚动），但顶栏同样 `sticky`（反馈只在平板提到，手机同改不伤）。
- 验收（真窗口）：平板 ① 顶栏始终可见，长色板时保存按钮不用回顶；② 色板上下滚动时画布与工具条不动；③ 工具条紧贴画布底；④ 手机布局不回归（工具条与色豆条仍可达）。
- 已知限制（T4 实现实测，接受）：768–1023px 宽时左栏只有 ≈694px（视口 − `mx-8` − 250px 色板 − gap），而十一颗按钮约需 700px ⇒ 工具条折成两行（最后一颗单独一行）；这是「工具条进左栏」这一必需机制的必然结果，缩按钮或缩色板列分别属 T5 / 规格，不在 T4 范围内。

**T5 图标与工具条归位**（反馈 5、6）
- `PixelIcon`：新增 `rerun`（循环箭头）；重画 `undo` / `redo`（剪影不同，不只是镜像）；`labels` 改成「4×4 格 + 格内 A 字」；`grid` 保持井字。
- `EditorPage` 顶栏：`rerun` 移到 `editor-save` 旁（`variant="secondary"`，绝不用 `primary`；`canRerun === false` 不渲染），带中文 `aria-label="重做"`、图标 24px + 可见「重做」二字（与结果页三颗动作同口径：图形旁留短中文）。
- `PatternToolbar`：删掉 `rerun` 按钮与其 emit/prop；行内只剩 `undo`、`redo`、三工具、五个「看的方式」。
- 验收：① 逐个图标在 24px 下的 ASCII 预览互不相同（undo≠redo、grid≠labels）；② `rerun` 两个入口（顶栏、结果页）都还能用；③ 既有 `aria-label` 断言全绿。

**T6 画布外框**（反馈 7）
- `PatternCanvas` 在图纸边界画一圈 2px 外框（颜色取 `bead-hole`，随板底一起变亮）；`src/style.css` 的 `--color-bead-board` 改 `#332B26`、必要时 `--color-bead-hole` 同步微调；`beadColors.ts` 的 `BOARD` 常量与守卫 (h1) 的对照表同步。
- 验收：黑边图纸在板底上能看出边界（真窗口截图对比）；深色底只出现在白名单五处（守卫 (e) 绿）。

**T7 文档回写**
- D1 规格：§6.1 的 `bead-board` / `bead-hole` 值、§7.3（手机生成后跳结果页、48vh 只适用生成前、删生成按钮）、§7.4（重做位置、编辑器 shell、画布外框）、§7.6/§7.8（覆盖层 teleport + 锁滚动）、§11.1（`generate` 入删除清单）逐条加**更正注记**（只加不改原文）。
- `docs/开发文档索引.md` 补本计划的链接。

## 收尾

- 全量 `npm run test` + `npm run build`。
- 真窗口复核：手机 390×844（T1/T2/T3/T5 的验收）与平板 1024×768（T4）。
- 真机（Android 平板）留给人类伙伴：手势条、黑边图纸、图标可辨识度。
