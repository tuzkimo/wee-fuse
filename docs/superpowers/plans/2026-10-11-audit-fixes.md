# 审计整改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落实 2026-10-11 审计报告的 9 条整理项：删零消费者导出、收窄 Android 权限与 CSP、去掉重复的计划计算与重复的选图实现、合并已漂移的参数守卫。

**Architecture:** 全部是「删减 / 收编 / 收窄」，不引入新框架、不加依赖。core 侧只新增两个**被生产消费**的纯函数（`boardPageRange`、`requireLongSide`/`requireMaxColors`）；services 侧把两个选图实现合并成一个共享模块；Tauri 侧改配置与清单。

**Tech Stack:** Vue 3 + TypeScript（strict，禁 `any`）、Pinia、vue-router、Vitest + happy-dom、Tauri 2（Rust + Android Gradle）、core 零依赖纯计算层。

**Spec:** [`docs/superpowers/specs/2026-10-11-audit-fixes-design.md`](../specs/2026-10-11-audit-fixes-design.md)

## Global Constraints

- `src/core/**` 不得 import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，不得引用 DOM 全局（闸门 `src/__tests__/coreBoundary.test.ts`）。
- TypeScript strict，禁止 `any`；`noUnusedLocals` / `noUnusedParameters` 打开（删函数后要同步删 import）。
- 除本计划明确批准删除的用例（Task 1）外，**不放宽、不删弱任何断言**。
- 每个任务结束跑：`npm run test`、`npm run build`（含 `vue-tsc`）；两条都要绿。
- 提交信息用 Conventional Commits + 中文：`refactor(core): …` / `chore(tauri): …`。
- 真机项（Task 7 的 fs scope / INTERNET、Task 8 的 CSP）在 CI 里**零判别力**，必须走人工清单。

## Review Focus

- **CSP 写错 ⇒ 真机白屏**：`connect-src` 少了 `ipc: http://ipc.localhost` 会让 `invoke` 全挂。Task 8 必须真机开一次首页 + 分享 + 保存，CI 只能证明配置语法合法。
- **删 `fs:scope` 后分享摄入是否还能读 `content://`**：源码层证明移动端 URL 分支绕过 scope，但这是**读第三方源码**得出的结论；Task 7 必须真机分享一张图验证。
- **release 去 `INTERNET` 后 `tauri android dev` 是否还能连 dev server**：debug 清单必须真的被合并进去。Task 7 必须 `npx tauri android dev` 起一次。
- **删零消费者导出时误删仍被动态/字符串引用的东西**：Task 1 删每个符号前再 grep 一次整仓（含 `.vue` / 配置 / 文档）。
- **删 `Decoder.outputSize` 丢掉尺寸口径守卫**：Task 2 如实登记；`decoders.test.ts` 的实参顺序断言仍在。

---

### Task 1: 删除零生产消费者的导出与对应用例

**Files:**
- Modify: `src/core/color/space.ts`（删 `labToRgb`）
- Modify: `src/core/color/__tests__/space.test.ts`
- Modify: `src/core/quantize/nearest.ts`（删 `nearestCellColor`；改 `nearestIndexOf` JSDoc 里指向它的段落）
- Modify: `src/core/quantize/__tests__/nearest.test.ts`
- Modify: `src/core/pattern/build.ts`（删 `buildPatternFromImage`）
- Modify: `src/core/pattern/__tests__/build.test.ts`
- Modify: `src/core/pattern/edit.ts`（删 `buildReplaceCommand`）
- Modify: `src/core/pattern/__tests__/edit.test.ts`
- Modify: `src/services/imageSource.ts`（删 `probeSourceSize`；同时删 `probeImageSize` 这个已无用的 import）
- Modify: `src/services/__tests__/imageSource.test.ts`
- Modify: `src/services/platform/guards.ts`（删 `SavableBlob` 接口，把 `requireSavableBlob` 的返回类型内联）
- Modify: `docs/开发约定详解.md`（「公开 API ≠ 被使用的 API」段落）
- Test: 上述四个测试文件

**Interfaces:**
- Produces: 无（纯删除；`requireSavableBlob(blob: unknown, filename: unknown): { blob: Blob; filename: string }` 形状不变，只去掉具名接口）。

- [ ] **Step 1: 删源码，先让用例红**

按上表删掉 6 个导出。注意：
- `src/services/imageSource.ts` 顶部 `import { decodeImageElement, probeImageSize } from "./probe";` 改成只留 `decodeImageElement`（否则 `noUnusedLocals` 报错）。
- `src/services/platform/guards.ts` 删掉 `export interface SavableBlob {...}`，并把 `requireSavableBlob` 的返回类型写成内联 `{ readonly blob: Blob; readonly filename: string }`。
- `src/core/quantize/nearest.ts` 的 `nearestIndexOf` JSDoc 里那句「本文件另有 sRGB 入参的姊妹 API `nearestCellColor`…」要改写成不再指向已删符号（保留 Lab/sRGB 混淆这条教训的说明即可）。
- `src/core/pattern/build.ts` 的 D1 历史注释里提到 `nearestCellColor`——**保留**（文档政策允许迁移留痕，属当时的证据）。

Run: `npm run build`
Expected: 报错指向仍 import 被删符号的测试文件。

- [ ] **Step 2: 删/改用例**

- `space.test.ts`：删 `labToRgb` 的 import 与整个 `describe("labToRgb", …)`；头部注释里提到 `labToRgb` 的句子改掉。
- `nearest.test.ts`：删 import 里的 `nearestCellColor`；删 `describe("nearestCellColor", …)`（选最近色）；**改写**下面三条仍在验证真实行为的断言为 `nearestIndexOf`（逐字等价替换）：
  - 「逐格映射用 ΔE76」：`nearestCellColor(0, 34, 34, metricLabs)` → `nearestIndexOf(rgbToLab(0, 34, 34), metricLabs, "de76")`
  - 「逐格映射读到 g 通道」：`nearestCellColor(200, 220, 10, candidates)` → `nearestIndexOf(rgbToLab(200, 220, 10), candidates, "de76")`
  - 「越界但有限…夹取」：`nearestCellColor(300, 0, 0, labs)` → `nearestIndexOf(rgbToLab(300, 0, 0), labs, "de76")`（期望值不变）
  - 删 `it("nearestCellColor 的 NaN 分量在 rgbToLab 处就被拦下")`（同一行为已由 `nearestIndexOf` 的 NaN 用例覆盖）
  - 相应补 `rgbToLab` 的 import。
- `build.test.ts`：删 `buildPatternFromImage` 的 import 与 `describe("buildPatternFromImage", …)`。
- `edit.test.ts`：删 import 里的 `buildReplaceCommand`；删两个 `describe("buildReplaceCommand…")`；删只针对它的一行 `label` 断言与 `expect(() => buildReplaceCommand(p, 1, 70_000, …))`（`buildPaintCommand` 的 `目标色号` 守卫由 `describe("buildPaintCommand（追加：目标色号越界必须响亮失败）")` 覆盖，无需补）。
- `imageSource.test.ts`：删 import 里的 `probeSourceSize` 与该用例。

- [ ] **Step 3: 跑测试与构建**

Run: `npm run test && npm run build`
Expected: 两条都通过（测试数比 1465 少）。

- [ ] **Step 4: 更新约定文档**

`docs/开发约定详解.md` 的「公开 API ≠ 被使用的 API」段落里，把 `nearestCellColor` / `buildPatternFromImage` / `buildReplaceCommand` 从「已写明保留」的清单中移除，并按该文档「允许迁移留痕」的口径注明「2026-10-11 起已删除（零生产消费者）」。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: 删除零生产消费者的公开导出及其用例"
```

---

### Task 2: 移除 `Decoder.outputSize` 字段

**Files:**
- Modify: `src/core/image/decode.ts`
- Modify: `src/services/decoders.ts`
- Modify: `src/services/pipeline.ts`（注释里引用该字段的两处）
- Modify: `src/services/__tests__/decoders.test.ts`
- Modify: `src/services/__tests__/pipeline.test.ts`
- Modify: `src/components/param/__tests__/ParamPanel.test.ts`
- Modify: `docs/开发约定详解.md`

**Interfaces:**
- Produces: `Decoder` 只剩 `readonly name: string` 与 `decode(source, request): Promise<RgbaImage>`。两条路径改用 `name` 区分。

- [ ] **Step 1: 删字段，让编译红**

- `core/image/decode.ts`：删掉 `readonly outputSize: "target" | "native";` 及其 JSDoc；`DecodeRequest` JSDoc 里对 `outputSize === "target"` 的引用改成「快路径解码器 / 保底路径解码器」的说法。
- `services/decoders.ts`：删掉 `createFastDecoder` 里的 `outputSize: "target",` 与 `createExactDecoder` 里的 `outputSize: "native",`。
- `services/pipeline.ts`：把注释里「`outputSize === "native"`」等引用改成路径名（保底 / 快）。

Run: `npm run build`
Expected: `vue-tsc` 在 `pipeline.test.ts` / `ParamPanel.test.ts` 的对象字面量上报 excess property，并在 `decoders.test.ts` 报 `outputSize` 不存在。

- [ ] **Step 2: 改用例**

- `pipeline.test.ts`：
  - `fakeDecoder` / `fastMustNotBeUsed` / `transparentDecoder` / `oddball` 四个内联 `Decoder` 删掉 `outputSize: …` 一行。
  - `makeStub(label: string, outputSize: …)` → `makeStub(label: string, kind: "target" | "native")`；对象里删 `outputSize,`；`outputSize === "native"` → `kind === "native"`。调用点（`makeStub("exact", "native")` 等）不变。
  - `forbidden(label: string, outputSize: …)` → `forbidden(label: string)`；所有调用点 `forbidden("fast", "target")` / `forbidden("exact", "native")` 改成只传 label。
- `ParamPanel.test.ts`：`solid` / `fastForbidden` 两个桩删掉 `outputSize: …` 一行。
- `decoders.test.ts`：删掉 `expect(decoder.outputSize).toBe("target")` 与 `expect(decoder.outputSize).toBe("native")` 两行；把该 describe 的注释改成「尺寸口径由本文件的实参顺序断言与尺寸断言守；`outputSize` 字段已于 2026-10-11 删除」。

- [ ] **Step 3: 跑测试与构建**

Run: `npm run test && npm run build`
Expected: 通过。

- [ ] **Step 4: 更新约定文档**

`docs/开发约定详解.md` 里把 `Decoder.outputSize` 从「已写明保留」改为「2026-10-11 已删除；两条路径靠 `name` 区分」。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(core): 移除无生产读取者的 Decoder.outputSize 字段"
```

---

### Task 3: 合并 longSide / maxColors 参数守卫

**Files:**
- Modify: `src/core/pattern/types.ts`（新增两个导出）
- Create: `src/core/pattern/__tests__/guards.test.ts`
- Modify: `src/core/pattern/build.ts`（删私有 `requireMaxColors`，改调共享）
- Modify: `src/core/project/types.ts`
- Modify: `src/core/project/file.ts`
- Modify: `src/stores/draft.ts`（保留「校验在写操作之前」的调用位置，只把实现换成共享函数）
- Modify: `docs/开发约定详解.md`（用色数「四份内联副本」的账目）

**Interfaces:**
- Produces（都在 `@/core/pattern/types`）：
  - `requireLongSide(value: number): number` —— 合法返回原值，否则抛 `长边豆数必须是 ${MIN_LONG_SIDE}–${MAX_LONG_SIDE} 的整数（当前 ${String(value)}）`
  - `requireMaxColors(value: number, paletteSize: number): MaxColors` —— 合法返回原值，否则抛 `用色档位非法：${String(value)}（只允许 1..${paletteSize} 的整数）`

- [ ] **Step 1: 写失败测试**

新建 `src/core/pattern/__tests__/guards.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { requireLongSide, requireMaxColors } from "../types";

describe("requireLongSide", () => {
  it("边界 1 / 116 合法且原样返回", () => {
    expect(requireLongSide(1)).toBe(1);
    expect(requireLongSide(116)).toBe(116);
  });
  it("0 / 117 / 小数 / NaN 抛同一条中文消息", () => {
    for (const bad of [0, 117, 2.5, Number.NaN]) {
      expect(() => requireLongSide(bad)).toThrow(
        `长边豆数必须是 1–116 的整数（当前 ${String(bad)}）`,
      );
    }
  });
});

describe("requireMaxColors", () => {
  it("1..色卡色数 合法，等于色卡色数即「不限」", () => {
    expect(requireMaxColors(16, 221)).toBe(16);
    expect(requireMaxColors(221, 221)).toBe(221);
  });
  it("0 / 222 / 小数 / 非 number 抛同一条中文消息", () => {
    for (const bad of [0, 222, 2.5, Number.NaN]) {
      expect(() => requireMaxColors(bad, 221)).toThrow(
        `用色档位非法：${String(bad)}（只允许 1..221 的整数）`,
      );
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/pattern/__tests__/guards.test.ts`
Expected: FAIL —— `requireLongSide is not a function`。

- [ ] **Step 3: 实现并替换四处调用**

在 `src/core/pattern/types.ts` 末尾加这两个函数（用同文件的 `MIN_LONG_SIDE` / `MAX_LONG_SIDE`）。然后：
- `core/pattern/build.ts`：删私有 `requireMaxColors`，改 `import { requireMaxColors, … } from "./types"`，调用点 `requireMaxColors(options.maxColors, palette.colors.length)`。
- `core/project/types.ts`：改用共享 `requireMaxColors(maxColorsRaw, fullPalette.colors.length)` 与 `requireLongSide(longSide)`。
- `core/project/file.ts`：同样；`长边豆数非法：X` 这条旧消息随之统一。
- `stores/draft.ts`：`requireLongSide` / `requireMaxColors` 的实现改成转发共享函数（`requireMaxColors(next, getBuiltinPalette().colors.length)`），调用点与「写操作之前」的顺序不变。

- [ ] **Step 4: 跑全量测试与构建**

Run: `npm run test && npm run build`
Expected: 通过（既有用例对长边只断言 `/长边/`，对用色断言 `/用色档位非法/`）。

- [ ] **Step 5: 更新约定文档**

`docs/开发约定详解.md` 的「用色数」与「入口校验」段落：把「共四份内联副本」改为「唯一实现 `core/pattern/types.ts` 的 `requireMaxColors` / `requireLongSide`，四处调用」；几何类守卫（finite / point / rect / size）按既有裁决保持内联，注明不动。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): 合并 longSide 与 maxColors 守卫，消除文案漂移"
```

---

### Task 4: `ExportPanel` 每页只建一次计划

**Files:**
- Modify: `src/core/render/layout.ts`（新增 `boardPageRange`，`planBoardPage` 改用它）
- Modify: `src/core/render/__tests__/layout.test.ts`（新增用例）
- Modify: `src/services/sheetExport.ts`（新增 `renderBoardPageBlobFromPlan`；`renderBoardPageBlob` 转发；删 `boardPageTile`）
- Modify: `src/services/__tests__/sheetExport.test.ts`（新增一条 `renderBoardPageBlobFromPlan` 用例）
- Modify: `src/components/editor/ExportPanel.vue`
- Modify: `src/components/editor/__tests__/ExportPanel.test.ts`（只改注释里对 `boardPageTile` 的引用）

**Interfaces:**
- Consumes: `planBoardPage` 现有签名。
- Produces:
  - `@/core/render/layout` 的 `BoardPageRange { originCol; originRow; cols; rows; boardRow; boardCol; boardIndex; boardTotal }` 与 `boardPageRange(width: number, height: number, boardSize: number, index: number): BoardPageRange`（含现有 `页索引 … 越界` 守卫）。
  - `@/services/sheetExport` 的 `renderBoardPageBlobFromPlan(input: BoardPageRenderInput, plan: BoardPagePlan, pageUsages: readonly ColorUsage[]): Promise<Blob>`。

- [ ] **Step 1: 写失败测试**

在 `src/core/render/__tests__/layout.test.ts` 加：

```ts
import { boardPageRange, planBoardPage } from "../layout";

it("boardPageRange：116×116 / 29 板 / 第 15 页（0 起）落在 r4c4 的右下", () => {
  expect(boardPageRange(116, 116, 29, 15)).toEqual({
    originCol: 87, originRow: 87, cols: 29, rows: 29,
    boardRow: 3, boardCol: 3, boardIndex: 15, boardTotal: 16,
  });
});

it("boardPageRange：页索引越界抛错（不取模）", () => {
  expect(() => boardPageRange(116, 116, 29, 16)).toThrow(/页索引 16 越界/);
});

it("planBoardPage 的页身份逐字段等于 boardPageRange", () => {
  const range = boardPageRange(116, 116, 29, 15);
  const plan = planBoardPage(makePattern(116, 116), makePalette(), makeUsages(), {
    boardSize: 29, paper: "a4", index: 15, projectName: "测试工程",
  });
  expect({ originCol: plan.originCol, originRow: plan.originRow, cols: plan.cols, rows: plan.rows,
    boardRow: plan.boardRow, boardCol: plan.boardCol, boardIndex: plan.boardIndex, boardTotal: plan.boardTotal })
    .toEqual(range);
});
```

在 `src/services/__tests__/sheetExport.test.ts` 的 `renderBoardPageBlob` describe 里加：

```ts
it("renderBoardPageBlobFromPlan 用的就是传进来的 plan 的画布尺寸", async () => {
  const pattern = makePattern(58, 58, undefined);
  const plan = planBoardPage(pattern, makePalette(), makeUsages(), {
    boardSize: 29, paper: "a4", index: 0, projectName: "测试工程",
  });
  await renderBoardPageBlobFromPlan(
    { pattern, palette: makePalette(), usages: makeUsages(), projectName: "测试工程", boardSize: 29, paper: "a4", pageIndex: 0 },
    plan,
    makeUsages(),
  );
  expect(exporter.createCanvasStrict).toHaveBeenCalledWith(plan.canvasWidth, plan.canvasHeight);
});
```

（`makePattern` / `makePalette` / `makeUsages` 是该文件既有夹具；`planBoardPage` 从 `@/core/render/layout` import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/render/__tests__/layout.test.ts src/services/__tests__/sheetExport.test.ts`
Expected: FAIL（`boardPageRange` / `renderBoardPageBlobFromPlan` 未定义）。

- [ ] **Step 3: 实现**

- `layout.ts`：把 `planBoardPage` 里现算 `boardCols/boardRows/total/boardRow/boardCol/originCol/originRow/cols` 那段连同守卫抽成 `boardPageRange`；`planBoardPage` 调它并展开。行为必须逐位不变。
- `sheetExport.ts`：`renderBoardPageBlob(input, pageUsages = input.usages)` 变成「先 `planBoardPage`，再调 `renderBoardPageBlobFromPlan`」；新函数只做 `renderWithPlan(plan.canvasWidth, plan.canvasHeight, target => drawBoardPage(target, input.pattern, input.palette, pageUsages, plan, sheetMeta(input)))`。删除 `boardPageTile`（改完零消费者）。
- `ExportPanel.vue`：`showPreview` 与 `saveAll` 里，每页改为
  ```ts
  const range = boardPageRange(snapshot.pattern.width, snapshot.pattern.height, snapshot.boardSize, index);
  const pageUsages = usagesInRange(snapshot.pattern, snapshot.palette, range);
  const plan = planBoardPage(snapshot.pattern, snapshot.palette, pageUsages, {
    boardSize: snapshot.boardSize, paper: snapshot.paper, index, projectName: snapshot.projectName,
  });
  // saveAll 里还要 filename（showPreview 不需要）：
  const filename = exportFilename(snapshot.projectName, "打印", { rowIndex: plan.boardRow, colIndex: plan.boardCol });
  const blob = await renderBoardPageBlobFromPlan(boardRenderInput(snapshot, index), plan, pageUsages);
  ```
  删掉 `pageUsages()` / `pageFilename()` 两个局部函数与 `boardPageTile` 的 import；补 `boardPageRange` / `planBoardPage` 的 import。**快照语义不变**（`filename` 仍在第一个 `await` 之前算好）。

- [ ] **Step 4: 跑测试与构建**

Run: `npm run test && npm run build`
Expected: 通过（`ExportPanel.test.ts` 走真 `sheetExport`，行为不变）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(export): 打印页每页只建一次版面计划"
```

---

### Task 5: 抽出共享的隐藏文件选择器

**Files:**
- Create: `src/services/platform/hiddenFileInput.ts`
- Modify: `src/services/platform/tauriDriver.ts`（改为**转发导出**，避免动 `tauriDriver.test.ts` 的 import）
- Modify: `src/services/platform/browserPlatform.ts`（删本地选择器，改调共享）
- Test: `src/services/platform/__tests__/tauriDriver.test.ts`（应无需改动，但必须跑绿）、`browserPlatform.test.ts`

**Interfaces:**
- Produces: `@/services/platform/hiddenFileInput` 导出 `PICKER_RETURN_GRACE_MS` 与 `pickWithHiddenInput(capture: "environment" | null): Promise<File | null>`；`tauriDriver.ts` 原样再导出这两个名字。
- 行为：`change` 选中非 `File`（非法环境）⇒ reject `图片选择器返回了非文件对象`；`change` 空列表 / `cancel` / blur→focus 宽限期 ⇒ resolve `null`。

- [ ] **Step 1: 先让浏览器用例红（把非 File 契约钉在浏览器侧）**

在 `browserPlatform.test.ts` 增加一条**兜底出口**用例（照抄 `tauriDriver.test.ts` 的 `spyOnSetTimeout` 手法：`vi.spyOn(globalThis, "setTimeout")` 只记录、手工 `fire`，不用假时钟）：`blur` → `focus` 后，浏览器实现应排上 `PICKER_RETURN_GRACE_MS` 定时器、触发后 resolve `null`。

Run: `npx vitest run src/services/platform/__tests__/browserPlatform.test.ts`
Expected: FAIL —— 当前浏览器实现没有 focus 监听，promise 不结算。

- [ ] **Step 2: 抽出模块**

把 `tauriDriver.ts` 里的 `PICKER_RETURN_GRACE_MS`、`pickWithHiddenInput` 整段（含 detach / finish / onBlur / onFocus / click 兜错）移到 `hiddenFileInput.ts`，并加入非 `File` 守卫：`change` 里取 `input.files?.[0] ?? null`，非 null 且 `!(picked instanceof File)` 时以 `图片选择器返回了非文件对象` reject 并给节点做 cleanup。常量 `PICKER_NOT_A_FILE_MESSAGE` 也搬进来（`browserPlatform.ts` 里同名常量随之删除）。
`tauriDriver.ts` 改成 `export { PICKER_RETURN_GRACE_MS, pickWithHiddenInput } from "./hiddenFileInput";`，删掉本地的实现，更新文件头注释（它仍是全仓唯一含 `@tauri-apps/` 的文件）。

- [ ] **Step 3: 浏览器实现改调共享**

`browserPlatform.ts` 的 `imagePicking.pickFromAlbum` 体改成 `return pickWithHiddenInput(null);`，删掉本地的 input 装配、`cleanup` / `finish` / `fail` / `onChange` / `onCancel` 与 `PICKER_NOT_A_FILE_MESSAGE` 常量；补 import。

- [ ] **Step 4: 跑平台相关测试与构建**

Run: `npx vitest run src/services/platform && npm run test && npm run build`
Expected: 全绿。特别是 `browserPlatform.test.ts` 的「非 File ⇒ reject」与「change 空列表 ⇒ null」两条仍通过（共享实现里有同样的三个出口），`tauriDriver.test.ts` 的四处出口不受影响（转发导出）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(platform): 浏览器与壳共用同一个隐藏文件选择器"
```

---

### Task 6: 开发期 lab 路由按 DEV 门控

**Files:**
- Modify: `src/router/index.ts`
- Test: `src/router/__tests__/index.test.ts`（应无需改动）

**Interfaces:**
- Produces: 生产构建里 `/lab/decode`、`/lab/canvas`、`/lab/shell` 不存在；`import.meta.env.DEV` 为真（vitest）时三条都在。

- [ ] **Step 1: 门控路由**

把 `router/index.ts` 的 `routes` 改成先声明核心路由数组，再把三条 lab 路由在 `if (import.meta.env.DEV) { routes.push(...) }` 里追加；三条 lab 路由的 `path` / `name` / `component` 逐字不变。

- [ ] **Step 2: 跑路由测试与构建**

Run: `npm run test && npm run build`
Expected: `src/router/__tests__/index.test.ts` 仍绿（vitest 的 `import.meta.env.DEV` 为真）；构建产物里不再有 `DecodeLabPage` / `CanvasLabPage` / `ShellProbePage` / `preview` / `gridDelta` 的 chunk。

- [ ] **Step 3: 核对生产包真的瘦了**

Run: `npm run build` 后 `ls dist/assets`（或看构建输出）
Expected: 不再列出 `CanvasLabPage-*.js` / `DecodeLabPage-*.js` / `ShellProbePage-*.js`。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(router): 开发期探针页只在 DEV 构建注册"
```

---

### Task 7: 收窄 Android 权限（release 去 INTERNET、去掉多余 fs:scope）

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/AndroidManifest.xml`
- Create: `src-tauri/gen/android/app/src/debug/AndroidManifest.xml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `docs/开发约定详解.md`（平台壳那节补一条维护口径）

**Interfaces:**
- Produces: release 清单无 `INTERNET`、无 `fs:scope` allow 块；debug 清单声明 `INTERNET`。

- [ ] **Step 1: 改清单与能力**

- `app/src/main/AndroidManifest.xml`：删掉 `<uses-permission android:name="android.permission.INTERNET" />`。
- 新建 `app/src/debug/AndroidManifest.xml`：
  ```xml
  <?xml version="1.0" encoding="utf-8"?>
  <manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <!-- dev server 走 http://localhost:1420，只有 debug 需要联网。 -->
      <uses-permission android:name="android.permission.INTERNET" />
  </manifest>
  ```
- `capabilities/default.json`：删掉整个 `fs:scope` 对象（连同它前面的逗号），只保留 `fs:allow-read-file`。理由写进文件里现有的 description 或注释（mobile 的 `content://` 分支绕过 scope，见 spec §第 3 条）。

- [ ] **Step 2: 静态校验（能跑的部分）**

Run: `cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-linux-android`
Expected: 通过（清单/能力文件不参与 cargo check，但保证没碰坏 Rust）。

Run: `npx tauri android build --apk --debug`
Expected: 成功；产物 debug APK 的合并清单里仍有 `INTERNET`。

- [ ] **Step 3: 人工验证（必须，CI 零判别力）**

1. `npx tauri android dev`：App 能连上 dev server 并正常打开（证明 debug 清单被合并）。
2. 装机后从相册/别的 App 分享一张图进 App：能进入选区页（证明去掉 `fs:scope` 后 `content://` 读取仍可用）。
3. 把两条结果记进 `docs/superpowers/notes/` 的本轮构建记录（无记录则新建）。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(tauri): release 去掉 INTERNET 权限并收窄 fs scope"
```

---

### Task 8: 给 WebView 加 CSP

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `docs/superpowers/specs/2026-10-11-audit-fixes-design.md`（把该条标记为「已落地 + 真机结果」）

**Interfaces:**
- Produces: `app.security.csp` 为字符串，保留 Tauri IPC 与 `data:` / `blob:` 图片。

- [ ] **Step 1: 设 CSP**

`src-tauri/tauri.conf.json` 的 `app.security` 改成：

```json
"security": {
  "csp": "default-src 'self'; script-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'"
}
```

（`connect-src` 必须含 `ipc: http://ipc.localhost`，否则 `invoke` 全挂；`img-src` 必须含 `data:`（缩略图）与 `blob:`（施工图 object URL）。）

- [ ] **Step 2: 构建**

Run: `npm run build && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 通过。

- [ ] **Step 3: 人工验证（必须，CI 零判别力）**

真机跑一次：打开首页（图纸库列表能加载，证明 IPC 与 IndexedDB 不受 CSP 影响）→ 打开一条工程的「查看施工图」（`blob:` 图能显示）→ 点「保存」（相册写入成功）→ 分享一张图进来（App 内交互正常）。任何一步白屏就回退 CSP 并记录原因。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(tauri): 为 WebView 配置内容安全策略"
```

---

## Self-Review

- **Spec 覆盖**：#1→Task 1；#2→Task 2；#3→Task 7；#4→Task 6；#5→Task 4；#6→Task 7；#7→Task 3；#8→Task 1（随 `labToRgb` 删除消解）；#9→Task 5。九条全覆盖。
- **类型/命名一致性**：`boardPageRange` / `BoardPageRange` / `renderBoardPageBlobFromPlan` / `requireLongSide` / `requireMaxColors` / `pickWithHiddenInput` 在各任务内名字与签名一致；`planBoardPage` 的既有字段名未改。
- **Review Focus 的验收落点**：CSP→Task 8 Step 3；fs scope→Task 7 Step 3；INTERNET→Task 7 Step 3；误删→Task 1 Step 1 的 grep；`outputSize` 守卫损失→Task 2 Step 2 的注释登记。
- **比例**：Task 2 是价值最低、改动面最广的一条（约 20 处用例编辑，换掉一个只被用例消费的字段）。若评审认为不值，可**单独删掉 Task 2**，其余任务互不依赖。

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-10-11-audit-fixes.md`。

**推荐执行方式：Subagent-driven** —— 8 个任务里 Task 1/2 的删除面广、Task 7/8 有真机风险，逐任务一个实现者 + 一个审查者能在真机验证前拦住错误删除与错误配置；任务之间基本独立，不需要串行等待。
