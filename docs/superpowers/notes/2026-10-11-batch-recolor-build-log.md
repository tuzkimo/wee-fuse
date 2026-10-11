# 按色号批量换色构建记录

- 日期：2026-10-11
- 规格：[2026-10-11-batch-recolor-design.md](../specs/2026-10-11-batch-recolor-design.md)
- 计划：[2026-10-11-batch-recolor.md](../plans/2026-10-11-batch-recolor.md)
- 交付区间：`a4b0179..2a05645`（分支 `feat/batch-recolor`；tag `v0.14.0` 触发 `release-android`）
- 版本号：0.13.0 → **0.14.0**

## 1. 交付了什么

| # | 交付 | 关键落点 |
|---|---|---|
| 1 | core 纯函数 `indicesWithValues(cells, values)`：返回值落在 `values` 里的格子下标（行优先升序），越界 / 非整数响亮失败 | `core/pattern/edit.ts` |
| 2 | store 动作 `recolor(sources, to)`：一条命令 = 一步撤销；校验在写操作之前（源 `0..colorCount-1`、目标另允许 `EMPTY`）；空命令不置脏、不吃撤销额度 | `stores/editor.ts` |
| 3 | 选择器：顶部「已用色」快捷组（补回「点已用色行 = 设画笔色」这条被拿走的路径）+ 换色模式下多一颗「橡皮（空格）」 | `components/editor/PalettePicker.vue` |
| 4 | 面板：已用色行改**多选开关**（点行不再改画笔色）、操作条「已选 N 个色号 · 共 M 颗 + [换成…] + [取消选择]」、`pickMode` 区分画笔 / 换色两种用途 | `components/editor/PalettePanel.vue` |
| 5 | 画布：选中色号的全部格子在可见范围内高亮（自己扫 `cells`，动态集合语义挂在既有 `revision` 通道上） | `components/editor/PatternCanvas.vue` |
| 6 | 编辑页：持选中集合的页面局部 `ref`、双向接线、换色后与换图纸时清空 | `views/EditorPage.vue` |
| 7 | 文档：索引加行、约定详解记下被本批**部分兑现**的去背景先例 | `docs/开发文档索引.md`、`docs/开发约定详解.md` |

## 2. 验证读数（终态 `2a05645`）

- `npm run test`：**84 文件 / 1550 用例全绿**（批次开始时基线 1517；净增 33 条用例）。
- `npm run build`：`vue-tsc --noEmit` 无错 + Vite 构建成功；`src/__tests__/coreBoundary.test.ts` 闸门未放宽。
- 真机人工复验：高亮在实机上看得清、选择器顶部那组的触控目标够大 —— 人类伙伴 2026-10-11 确认通过。

## 3. 实现期被证伪、已写进计划的论断

计划 Task 4 说「新数组，顺序按 `usages` 顺序（`rows` 过滤一遍即可）」。实现时**推翻**：按 `rows` 过滤会静默丢掉
「仍被选中、但已在选中期间被涂光而从 `usages` 消失」的色号，与规格 §7.1 / §5.5 的动态集合语义冲突。
最终实现是**保留**这类色号（只是不计数），选择数组的顺序因此是插入序而非 `usages` 序——规格未给顺序语义，
画布按 `Set` 消费、真正驱动编辑的 `recolor` 载荷仍是 `usages` 序。这条行为已由
`PalettePanel.test.ts`「切换选中时保留已从 usages 消失的色号」钉住。

## 4. 延后项（唯一真源仍是规格 §10）

规格 §10 那五条（ΔE / 阈值自动归并、无预览的一键整图改动、框选内换色、选区保存 / 命名 / 跨会话保留、
把选中集合移进 store）本批**未做**。终审另列的三条测试覆盖建议（页面级 `:selected` 证据、e2e 区分
「用面板 sources」与「页面自算」、替身 `fillStyle` 的类型洁癖）经终审逐条裁为 SHIP-AS-IS，留待下次触碰这些
文件时顺手处理。
