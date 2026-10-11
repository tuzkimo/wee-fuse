# 审计整改设计（2026-10-11）

> 来源：2026-10-11 对全仓的 ponytail-audit 报告（会话内）。本文件只记录**决定**与**被证伪的原判断**，
> 不重复审计正文。执行计划见 [`../plans/2026-10-11-audit-fixes.md`](../plans/2026-10-11-audit-fixes.md)。

## 背景

审计跑绿：`npm run build` 通过、`npx vitest run` 1465 条全过。没有发现会算错、丢数据或在上限负载下崩的缺陷。
以下是 9 条整理项，人类伙伴 2026-10-11 裁定「全部修」，并**明确批准删除**第 1 条涉及的既有测试用例。

## 逐条决定

| # | 审计项 | 决定 | 备注 |
|---|---|---|---|
| 1 | 零生产消费者的导出（`labToRgb` / `nearestCellColor` / `buildPatternFromImage` / `buildReplaceCommand` / `probeSourceSize` / `SavableBlob`） | **删除函数与对应用例** | 人类伙伴批准删测试 |
| 2 | `Decoder.outputSize` 字段无生产读取者 | **删除字段**，改由解码器 `name` 区分两条路径 | 会削弱 `decoders.test.ts` 的三条尺寸口径守卫之一，已如实登记 |
| 3 | `fs:scope` 授权 `**` 过宽 | **删除 `fs:scope` allow 块**（保留 `fs:allow-read-file`） | **审计原判断被证伪**，见下 |
| 4 | 三个 `/lab/*` 探针页与其服务模块进生产包 | 路由用 `import.meta.env.DEV` 门控 | 源码与用例保留，供换设备重测 |
| 5 | `ExportPanel` 每页重复建计划 ~3 次 | 每页只建一次：新增 `boardPageRange` + `renderBoardPageBlobFromPlan` | 顺带删除零消费者的 `boardPageTile` |
| 6 | 未使用的 `INTERNET` 权限 | release 清单去掉；新增 debug 清单保留（dev server 需要） | `gen/android` 入库，注意 `tauri init` 会覆盖 |
| 7 | 六份入口守卫副本、长边文案已漂移 | 只合并**参数类**守卫（`longSide` / `maxColors`）到 `core/pattern/types.ts` | 几何类守卫按既有裁决保持内联，不动 |
| 8 | `labToRgb(NaN)` 静默产 NaN | 由第 1 条删除该函数自然消解，**不单独修** | — |
| 9 | 浏览器选图与壳选图是两份实现 | 抽出 `hiddenFileInput.ts`，两份共用 | 顺带把「非 File 抛错」契约收进共享实现 |

## 第 3 条：审计原判断被证伪（重要）

审计说「把 `fs:scope` 从 `**` 收窄到 `content://**`」。读 `tauri-plugin-fs 2.6.0` 源码后证伪：

- `SafeFilePath::Url`（`content://` 会解析成它）在移动端**直接**走 `webview.fs().open(...)`，
  **完全不经 `resolve_path` / scope 检查**（`src/commands.rs` 的 `resolve_file` 移动端分支、
  `src/android.rs` 的 `resolve_content_uri`）。
- scope 只作用于 `SafeFilePath::Path`（普通文件路径），而本应用**从不**读普通路径。

所以 `content://**` 这个 glob 永远不会被匹配，收窄到它等于没改。正确的最小改动是**删掉 `fs:scope` allow 块**：
应用只读分享进来的 `content://` URI，普通路径读取能力本就不需要，删掉即净收窄。设备验证项：分享一张图进 App 仍能摄入。

## 全局约束（执行计划继承）

- `src/core/**` 零依赖、无 DOM 全局；`npm run build`（含 `vue-tsc`）与 `npm run test` 每条任务后都要绿。
- 除第 1 条经批准的删除外，**不放宽、不删弱任何断言**；确有冲突的断言先经人类伙伴确认。
- 提交信息 Conventional Commits + 中文描述。
- 真机项（CSP、fs scope、INTERNET）在计划里明确标为人工验证，CI 不覆盖。
