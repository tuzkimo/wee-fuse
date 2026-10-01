# 一起拼豆（WeeFuse）

拼豆辅助 App：把图片转成可照着拼的拼豆图纸。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 目标平台

Android 平板优先。开发调试用浏览器与桌面端。

## 开发

```bash
npm ci
npm run dev      # http://localhost:1420
npm run test
npm run build
```

## 当前进度

第一阶段「图片转图纸」的**引擎**已完成：色彩空间与色差、MARD 221 色卡、面积平均重采样、
颜色量化、图纸构建与编辑撤销，全部为 `src/core/` 下的纯 TypeScript 模块，由单元测试覆盖。

解码实验台：`npm run dev` 后访问 `/lab/decode`，可对比两条解码路径的画质。

下一步：应用层（选区 → 尺寸 → 编辑器 → 导出 → 图纸库）与 Tauri Android 壳。

实测（2026-10-01，Node 24.19.0 / npm 11.5.2，Windows 桌面 CPU，均在 `vitest run` 进程内测量）：

- **引擎构建耗时**：58×58 图纸约 **4–5 ms**、200×200 图纸约 **11–20 ms**。
  区间来自两次独立测量（实现者 4 / 11 ms、控制者 5.2 / 19.5 ms，各取多次运行）——单次数字受机器负载影响，写区间比写单一值诚实。
  规格 §10 的预算是 < 1 s / < 3 s，纯算法耗时留有约两个数量级余量；真机上的解码耗时另算。
- **最坏档位（规格 §2.1「精细 · 不限」）**：上面的数字是 `maxColors: 32`。`maxColors: null`
  不聚类、直接在全色卡里逐格取最近色，候选从 ≤32 变成 **221**（内置 MARD221），逐格 ΔE76
  调用量约 **7 倍**：200×200 实测约 **80 ms**（最终审查者，硬边噪声图）、本轮复测
  **88–137 ms**（两次独立测量，7 次均值 96.5 / 101.3 ms；同进程同尺寸 `maxColors: 32` 为
  51–59 ms，比值 ≈ 1.8–2.3×——比值比绝对值更可移植，本轮机器整体比上面那组慢约 3–5 倍）。
  仍在规格 §10 的 3 s 预算内，余量约一个数量级；这条只是把「不限」这个**用户可见档位**
  的真实代价记下来，避免按 32 档的数字外推。
- **全量测试**：**22 文件 / 312 用例**全绿；`npm run test` 冷启动约 9.4 s（vitest 内部 5.87 s），
  热复跑约 2.6 s。
- **构建**：`npm run build`（`vue-tsc --noEmit` + Vite）约 2.6 s，其中 Vite 构建 578 ms。
- **干净安装**：`npm ci` 安装 206 个包、约 5 s。

## 目录结构

- `src/core/` — 与框架无关的纯计算引擎（不得引用 Vue / Tauri / DOM 全局）
  - `color/`：Lab 转换与色差（ΔE76 / CIEDE2000）
  - `palette/`：色卡类型、内置 MARD 221 色卡与带校验的载入
  - `image/`：解码契约与类型、面积平均重采样、90° 旋转
  - `quantize/`：直方图、中位切割聚类、最近色查找
  - `pattern/`：图纸构建、用量统计、增量编辑、撤销栈
- `src/services/` — 唯一接触平台 API 的层（图片解码、尺寸探测、网格差异、预览渲染、生成流水线）
- `src/views/` — 页面（`HomePage.vue`、`DecodeLabPage.vue` 解码实验台）
- `docs/superpowers/specs/` — 设计规格
- `docs/superpowers/plans/` — 实现计划

## 已知限制与延后项

以下是实现与审查过程中**判定为可接受、明确不修**的项（任务 9 分诊的产物；编号为控制者进度账本
`.superpowers/sdd/2026-09-30-engine/progress.md` 里的「延后的 Minor」序号）。每条都写清「是什么」与
「为什么接受」，避免后来者把它们当成待办或以为已被测试保护。

| # | 是什么 | 为什么接受 |
|---|---|---|
| L1 | 中位切割里「两个盒子 Lab 跨度完全相等时先切哪个」没有断言（任务 7）。 | 只影响同跨度时先细分哪个盒子，**不影响像素守恒与簇的 represent 语义**；要钉它只能构造浮点恰好相等的跨度，脆且无产品含义。规格未对该 tie-break 作要求，留待规格决定后再钉。 |
| L2 | 任务 7 报告 §1 的「三个源文件与简报 IDENTICAL」只对提交 `18b47dc` 成立，对后续 HEAD 不成立（任务 7）。 | 属**历史报告的措辞瑕疵**，且该报告 §1.1 已自行 supersede。改写历史报告会破坏「报告是当时的证据」这一性质，故仅在账本留档。 |
| L3 | 有限巨权重（≥1.8e308）在同一桶累加会溢出成 `Infinity`，代表色变 `NaN` 而 `count` 非 0，`count === 0` 守卫拦不住（任务 7）。 | **当前不可达**：权重在本应用里是像素计数或覆盖率分数，量级 ≤ 1e6。为它加逐像素溢出检查属防御性膨胀。真需要时的最便宜修法是建完直方图后做一次 `Number.isFinite(total)` 检查（每次构建一次，而非每像素一次）。 |
| L4 | `computeGridSize` 与 `chooseDecoderPath` 的非法尺寸错误信息口径不同（前者不带实参值）；任务 8 报告 §6.2 称「非法裁剪在解码前抛错 — 全部已断言」，而流水线层那条用例只传了 `width: 0`（任务 8）。 | 错误信息措辞与**报告措辞**问题，行为正确且有单测覆盖（`build.test.ts` 的 `computeGridSize` 四条 + `pipeline.test.ts` 的两条）。改措辞不影响任何调用方。 |
| L5 | `rotate.test.ts` 的三项残留：模块级共享 fixture `original` 被多条用例复用；`:25` 有一个简报原文带来的多余 `as number`；导出 `rotationSwapsAxes` 暂无下游消费者（任务 5）。 | fixture **只读**（共享安全，且已被后续用例当基线）；多余 cast 是简报原文（改了反而偏离「不可删改已有测试」的约束）；`rotationSwapsAxes` 是 `rotatedSize` 的实现细节也是公开契约，留着比删掉更便宜。 |
| L6 | `resample.test.ts` 放大属性用例里的 `rawTooLong: 0` 是**构造性恒真**：`cellCount > srcSize` 时逐格原始区间长度必然 ≤ 1，该计数永远为 0（任务 4）。 | 它确实不可能因实现改坏而变红，但**同一条用例里的逐格 `JSON.stringify` 比较已经把「放大器每格只取一个源像素」钉死**，所以它不会让人误以为某处无人保护。删除它属于「删改已有测试」，收益是纯粹的美观。 |
| L7 | `scripts/fetch-mard-palette.mjs` 没有单元测试（脚本在 `src/` 外，不在 vitest 收集范围内，属简报设计）（任务 3）。 | 脚本产出的正确性由 `src/core/palette/__tests__/mard221.test.ts` 兜住（221 条 / 唯一 / 九色系 / 五锚点），且脚本自身有**写前闸门**：数量、锚点色值、九大色系任一不过就非零退出且不写文件。为它单开一套测试环境不划算。 |
| L8 | 抓取脚本的色系集合 `[A-HM]` 硬编码在三处（正则、`SERIES_ORDER`、测试的 `SERIES_SIZES`）（任务 3）。 | MARD 若新增色系，会以「数量 ≠ 221」**响亮失败**而非静默出错，这正是期望行为；代价只是人工同步。任务 9 已把脚本内部的同源副本从 4 处减到 3 处（`sortColors` 改用模块级 `SERIES_ORDER`）。 |
| L9 | 锚点闸门不校验各色系的条数，也没有全量基线 diff（任务 3）。 | 五个锚点已能拦住「整体错位」与「局部单点错位」两类静默损坏（实测：污染 B3 后 exit 1 且不落盘）。更彻底的方向是**基线快照 + 可审阅 diff**，属独立课题，不是加锚点能替代的。 |
| L10 | `vite.config.ts` 不在任何类型检查范围内（根 `tsconfig.json` 的 `include` 不含它；`tsconfig.node.json` 的 `composite` 因从无 `tsc -b` 而未生效）（任务 1）。 | 任务 9 实测补了一条更硬的理由：账本里建议的稳妥做法 `vue-tsc --noEmit -p tsconfig.node.json` **本身也会在仓库根写出 `tsconfig.node.tsbuildinfo`**（144 KB，实测，脚本退出码 0），而 `.gitignore` 不含 `*.tsbuildinfo` → 这个「稳妥做法」并没有避开 `tsc -b` 的 emit 副作用，只是把它换了个名字。要让该文件进 CI 必须先解决产物落地问题，属配置变更，不在收尾任务范围内。风险：该文件日后若加入逻辑，类型错误不会在 CI 暴露。 |
| L11 | 边界闸门（`src/__tests__/coreBoundary.test.ts`）对**形参名** `window`（及清单里其他被禁名）在函数体/表达式中的引用会**误报**（任务 1 / 1b，E/F 探针确认）。 | 已文档化（测试文件头规则 3 与 `CLAUDE.md` / `AGENTS.md`），且给出处置约定：**改命名**（例如参数改叫 `sampleWindow`），不放宽规则、不加绕过标记。触发概率低：`grep` 扫实现计划全文，为 `src/core/**` 规定的字面代码里**零处**使用 `window` 标识符。正确修法需走 TypeScript AST（有把 `@types/node` 拉进程序、削弱 Node 全局闸门的风险），或引入会制造新漏报的启发式，两者都比问题本身贵。 |

## 文档

- [第一阶段设计规格](docs/superpowers/specs/2026-09-30-image-to-pattern-design.md)

## License

[MIT](LICENSE)
