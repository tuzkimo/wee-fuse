# 编辑页填充与工具改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让编辑页的空白格可以被填充、把橡皮的入口从工具栏搬进选色区、加一个单指拖动的工具并设为默认、给图纸矩形铺浅色纸底。

**Architecture:** 全部改动落在编辑页这一条链上——`core/pattern/background.ts` 的泛洪按种子状态分岔（唯一的核心层改动）；`stores/editor.ts` 的 `EditorTool` 加一个枚举值；`PatternCanvas` 收第三种手势并多铺一层底；两个展示组件（`PatternToolbar` / `PalettePicker`）各挪一个入口。没有新增文件，没有新依赖。

**Tech Stack:** Vue 3 + TypeScript（严格模式，禁 `any`）+ Vite + Pinia + Tailwind v4；测试 Vitest + @vue/test-utils + happy-dom。

**Spec:** `docs/superpowers/specs/2026-10-13-editor-fill-and-tools-design.md`（本计划逐条实现它的 §2 目标 1–4；引用语义时一律引它）

## Global Constraints

- `src/core/**` 是纯计算层：不得 import `vue` / `pinia` / `@tauri-apps/*`，不得引用 DOM 全局。闸门：`src/__tests__/coreBoundary.test.ts`。
- TypeScript 严格模式，禁止 `any`。
- 公开 API 必须在任何写操作之前校验到「非法输入响亮失败」。
- 不许改弱、删除或放宽已有断言；与规格直接冲突的断言**只许**按本规格 §4.2 列出的那两条反转（`PalettePicker.test.ts:157`、`PalettePanel.test.ts:398`）。
- 不重构无关代码，不修改未被本计划列出的文件。
- 提交信息 = Conventional Commits + 中文描述。每个任务一次提交，`git add` 只加该任务列出的文件。
- 验证命令：单文件 `npm run test -- <路径>`；全量 `npm run test`；类型 `npm run build`（= `vue-tsc` + Vite 构建）。每个任务的收尾步骤都要跑全量 `npm run test`。

## Review Focus

规格没有逐条写的输入类别，最可能咬到用户的前五条。每条都在下面的任务里有对应用例（括注）。

1. **孤立的单个空格**（四邻都有颜色）：填色必须只填它自己，既不能什么都不做、也不能涂满整张图。（Task 1）
2. **整张图纸全是空格**、手里拿颜色点一下：泛洪返回全部格、一次涂满，不抛错、不产生空命令。（Task 1）
3. **`pan` 工具下落在图纸外按下**、再移进图纸内：必须全程什么都不做（按下那一刻就决定），不能中途变成平移。（Task 4）
4. **手里拿颜色、点在一个已有颜色的格上**：不能把相邻的空格吃进来（反向的「墙」语义）。（Task 1，复用既有 `:195` 用例）
5. **拖动 / 平移不留下任何编辑痕迹**：不 emit `paint` / `fill`，不进历史、不置脏。（Task 4）

---

### Task 1: core —— 空格区可以填充

**Files:**
- Modify: `src/core/pattern/background.ts`（`patternBackgroundIndices` → `patternRegionIndices`；`eatable` 建法按种子分岔；删空格种子的早退）
- Modify: `src/core/pattern/__tests__/background.test.ts`
- Modify: `src/views/EditorPage.vue`（import 与调用点，`:217` 一带；`onFill` 的 JSDoc）

**Interfaces:**
- Produces: `patternRegionIndices(pattern: Pattern, labs: readonly Lab[], seed: { x: number; y: number }, tolerance: number): number[]` —— 参数与返回值与旧的 `patternBackgroundIndices` 逐字相同（没有第三个消费者，改名是纯替换）。
- Consumes: `floodBackground`（不改签名、不改实现）。

- [ ] **Step 1: 纯改名，不改语义**

`background.ts`：`export function patternBackgroundIndices(` → `export function patternRegionIndices(`，并同步它上面那段 JSDoc 的首句与结论；`EditorPage.vue` 的 import（`:13`）与调用（`:217`）；`background.test.ts` 的 import（`:11`）与全部调用点 + `describe("patternBackgroundIndices"`（`:174`）的名字——该文件里一共 11 处（include count），一个不漏。

- [ ] **Step 2: 跑一次，确认纯改名没有改变行为**

Run: `npm run test -- src/core/pattern/__tests__/background.test.ts src/views/__tests__/EditorPage.test.ts`
Expected: PASS（全绿）。

- [ ] **Step 3: 写失败用例**

在 `background.test.ts` 的 `describe("patternRegionIndices", …)`（改名后）里追加。夹具 `makePattern` 是 3×3、`LABS` 只有 `[RED, BLUE]`、色号 0 = RED，都可以直接用：

```ts
it("[空格可填] 种子是空格时返回连通的空格整片", () => {
  // 中间整列是空格、彼此连通；左右两列是色号 0
  const pattern = makePattern((x) => (x === 1 ? EMPTY : 0));
  expect([...patternRegionIndices(pattern, LABS, { x: 1, y: 0 }, 0)].sort((a, b) => a - b)).toEqual([1, 4, 7]);
});

it("空格被有色格隔开时，只返回种子那一块", () => {
  // 中间整列是色号 0（墙），左右两列是空格、彼此不连通
  const pattern = makePattern((x) => (x === 1 ? 0 : EMPTY));
  expect(patternRegionIndices(pattern, LABS, { x: 0, y: 0 }, 0)).toEqual([0, 3, 6]);
  expect(patternRegionIndices(pattern, LABS, { x: 2, y: 0 }, 0)).toEqual([2, 5, 8]);
});

it("孤立的单个空格只返回它自己", () => {
  const pattern = makePattern((x, y) => (x === 1 && y === 1 ? EMPTY : 0));
  expect(patternRegionIndices(pattern, LABS, { x: 1, y: 1 }, BACKGROUND_TOLERANCE)).toEqual([4]);
});

it("[全空格图纸] 种子是空格且整张都是空格时返回全部格", () => {
  const pattern = makePattern(() => EMPTY);
  expect([...patternRegionIndices(pattern, LABS, { x: 0, y: 0 }, 0)].sort((a, b) => a - b)).toEqual([
    ...Array(9).keys(),
  ]);
});
```

同时改两处既有用例（**注意：只改这两条，别的一律不动**）：

- `:195` 的标题与注释：断言 `toEqual([0, 3, 6])` **不动**（种子是色号 0，走的仍是旧口径），但「空格既不被吃、也挡住泛洪」这句现在**是有条件的**——改成「种子有颜色时，空格挡住泛洪（种子是空格时恰恰相反，见下面那条）」。
- `:233` 「种子落在空格 / 图纸外 / 非整数时返回空数组」拆成两条：空格的期望值从 `[]` 改成 **`[1, 4, 7]`**（中间整列连通，不是只有种子那一格），用例名改成「种子落在空格时返回空格所在的那一片」；「图纸外 / 负数 / 非整数 ⇒ `[]`」三条留在另一条用例里，断言不变。

- [ ] **Step 4: 跑一次，确认新用例红**

Run: `npm run test -- src/core/pattern/__tests__/background.test.ts`
Expected: FAIL —— 空格种子的三条用例返回 `[]` 而不是 `[1, 4, 7]` / `[0, 3, 6]` / `[4]`。

- [ ] **Step 5: 实现**

在 `patternRegionIndices` 里：

1. 删掉 `if (cells[seedIndex] === EMPTY) return [];` 这一行（以及它上面解释「返回空数组表示什么都不做」的那段 JSDoc）。
2. `eatable` 的建法按种子分岔。当前是：

```ts
for (let i = 0; i < cellCount; i++) {
  const colorIndex = cells[i];
  if (colorIndex === EMPTY || colorIndex >= labs.length) continue; // 留 0,0,0 且不可吃
  ...
  eatable[i] = 1;
}
```

改成先算 `const seedIsEmpty = cells[seedIndex] === EMPTY;`，循环体里：

```ts
if (seedIsEmpty) {
  if (colorIndex === EMPTY) eatable[i] = 1;   // 空格可吃；cellLabs 留 0,0,0
  continue;
}
if (colorIndex === EMPTY || colorIndex >= labs.length) continue;
```

`cellLabs` 与 `fill` 的其余部分逐字不动。种子的基准色是 `0,0,0`、别的空格也是 `0,0,0`，ΔE76 = 0 ≤ 任何合法容差，所以**不需要**为空格造颜色、也不需要给这条路径单独传容差。
3. 重写该函数的 JSDoc：核心结论从「空格是实心的墙」改成「**可吃的口径随种子分岔**：种子是空格 ⇒ 可吃的是连通的空格；种子有颜色 ⇒ 空格与色卡外下标都是墙」。同时改 `EditorPage.onFill` 的 JSDoc——它现在既服务「去背景」也服务「填空白」。

- [ ] **Step 6: 跑测试**

Run: `npm run test`
Expected: 全绿。特别注意这几条必须仍然绿：`background.test.ts:202` / `:219`（容差 0 / 10 的既有行为）、`EditorPage.test.ts` 的「点空格不标脏、不留撤销记录」（空格种子现在返回 `[seedIndex]`，`paintCells([i], EMPTY)` 是恒等操作，仍然不标脏）。

- [ ] **Step 7: 提交**

```bash
git add src/core/pattern/background.ts src/core/pattern/__tests__/background.test.ts src/views/EditorPage.vue
git commit -m "feat(core): 空格区可填充，泛洪按种子状态分岔"
```

---

### Task 2: `pan` 图标

**Files:**
- Modify: `src/components/ui/PixelIcon.vue`
- Test: `src/components/ui/__tests__/PixelIcon.test.ts`

**Interfaces:**
- Produces: `IconName` 联合类型新增 `"pan"`（Task 6 的工具栏按钮用它）。

- [ ] **Step 1: 写失败用例**

`PixelIcon.test.ts` 的 `describe("图标剪影（实机反馈 5）", …)` 里，把 `pan` 加进那次 pairwise 的 `names` 列表（并同步改用例名）：

```ts
const names: readonly IconName[] = ["undo", "redo", "rerun", "grid", "labels", "pan"];
```

（`pan` 与 `fill` / `eraser` 的区别由下面 Step 3 的「每枚图标都不同」那类断言间接覆盖；这条列表只要求 `pan` 与它列出的这几枚两两不同。）

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/components/ui/__tests__/PixelIcon.test.ts`
Expected: FAIL —— `ICONS["pan"]` 是 `undefined`，`coverage("pan")` 抛错。

- [ ] **Step 3: 实现**

在 `ICON_NAMES` 的 `"fill"` 之后插入 `"pan",`，并在 `ICONS` 里加（四向箭头，**逐字照抄**——12×12 栅格、整数坐标、每条的线宽都取 1 或 2，`PixelIcon.test.ts` 的既有三条格式断言会逐条检查）：

```ts
  // 「拖动 / 平移」：四向箭头。轴杆 2 单位粗，四端各三级收窄成三角箭头尖。
  pan: [
    [5, 0, 2, 1],
    [4, 1, 4, 1],
    [3, 2, 6, 1],
    [5, 3, 2, 6],
    [3, 9, 6, 1],
    [4, 10, 4, 1],
    [5, 11, 2, 1],
    [0, 5, 1, 2],
    [1, 4, 1, 4],
    [2, 3, 1, 6],
    [3, 5, 6, 2],
    [11, 5, 1, 2],
    [10, 4, 1, 4],
    [9, 3, 1, 6],
  ],
```

- [ ] **Step 4: 跑测试**

Run: `npm run test -- src/components/ui/__tests__/PixelIcon.test.ts && npm run test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/components/ui/PixelIcon.vue src/components/ui/__tests__/PixelIcon.test.ts
git commit -m "feat(ui): 增加拖动（pan）图标"
```

---

### Task 3: store —— `pan` 进入工具枚举

**Files:**
- Modify: `src/stores/editor.ts`（`EditorTool`、`setTool`）
- Test: `src/stores/__tests__/editor.test.ts`

**Interfaces:**
- Produces: `export type EditorTool = "brush" | "fill" | "pan"`；`setTool(next: EditorTool): void` 接受三者。
- **`DEFAULT_TOOL` 在本任务保持 `"brush"`**：默认值要和「工具条上真的有一颗能选回来的按钮」一起改（Task 6），否则中间几个任务里用户切到画笔之后无法切回拖动，套件里也会有一批用例无谓地红两次。

- [ ] **Step 1: 写失败用例**

`editor.test.ts` 的 `describe("工具 / 当前色 / 视图 / 显示开关", …)` 里，`:329` 那条 `setTool` 用例后面加：

```ts
it("pan 是合法工具（拖动）", () => {
  const { editor } = seedEditor();
  editor.setTool("pan");
  expect(editor.tool).toBe("pan");
});
```

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/stores/__tests__/editor.test.ts`
Expected: FAIL —— `setTool("pan")` 抛「编辑器工具非法」。

- [ ] **Step 3: 实现**

`src/stores/editor.ts`：

```ts
export type EditorTool = "brush" | "fill" | "pan";
```

`setTool` 的运行时枚举校验与错误消息：

```ts
if (next !== "brush" && next !== "fill" && next !== "pan") {
  throw new Error(`编辑器工具非法：${String(next)}（只允许 "brush" / "fill" / "pan"）`);
}
```

同时改 `EditorTool` 上面那段 JSDoc（它描述的是「画笔 / 填充」两种工具的行为，补一句拖动的语义：只改视图、不改图纸）。

- [ ] **Step 4: 跑测试**

Run: `npm run test -- src/stores/__tests__/editor.test.ts && npm run test`
Expected: 全绿（`:336` 的 `setTool("erase")` 仍然抛错，`/工具/` 正则仍匹配新消息）。

- [ ] **Step 5: 提交**

```bash
git add src/stores/editor.ts src/stores/__tests__/editor.test.ts
git commit -m "feat(editor): 工具枚举加入拖动（pan）"
```

---

### Task 4: PatternCanvas —— 拖动工具的手势

**Files:**
- Modify: `src/components/editor/PatternCanvas.vue`（`ToolGesture`、`startToolGesture`、`onPointerMove`、`finishToolGesture`）
- Test: `src/components/editor/__tests__/PatternCanvas.test.ts`

**Interfaces:**
- Consumes: `EditorTool` 里的 `"pan"`（Task 3）；`panCellView`（组件已 import）。
- Produces: 拖动工具下移动会 `emit("update:view", ViewTransform)`；抬手 `emit` 里没有 `paint` / `fill`。

- [ ] **Step 1: 写失败用例**

`PatternCanvas.test.ts` 的手势 describe 里追加（夹具：`VIEW_32 = { scale: 24, offsetX: -200, offsetY: -200 }`、图纸 32×32、视口 400×400）：

```ts
it("[拖动工具] 单指拖动 emit update:view（平移），抬手不发 paint / fill", async () => {
  const wrapper = mountCanvas({ tool: "pan" });
  await pointer(wrapper, "pointerdown", 100, 100);
  await pointer(wrapper, "pointermove", 130, 120);
  // 位移 (30, 20) 直接加到 offset 上；夹取由 panCellView 负责（-170 / -180 都在合法范围内）
  expect(wrapper.emitted("update:view")?.at(-1)).toEqual([{ scale: 24, offsetX: -170, offsetY: -180 }]);
  await pointer(wrapper, "pointerup", 130, 120);
  expect(wrapper.emitted("paint")).toBeUndefined();
  expect(wrapper.emitted("fill")).toBeUndefined();
});

it("[拖动工具] 落在图纸外按下时全程什么都不做", async () => {
  // 8×8 @ scale 24 只占左上 192×192 ⇒ (300,300) 在图纸外
  const wrapper = mountCanvas({ pattern: solidPattern(8, 8), view: VIEW_8, tool: "pan" });
  await pointer(wrapper, "pointerdown", 300, 300);
  await pointer(wrapper, "pointermove", 320, 320);
  await pointer(wrapper, "pointerup", 320, 320);
  expect(wrapper.emitted("update:view")).toBeUndefined();
  expect(wrapper.emitted("paint")).toBeUndefined();
  expect(wrapper.emitted("fill")).toBeUndefined();
});

it("[拖动工具] 拖到一半加第二根手指 → 转成双指手势（缩放生效）", async () => {
  const wrapper = mountCanvas({ tool: "pan" });
  await pointer(wrapper, "pointerdown", 100, 100);
  await pointer(wrapper, "pointermove", 120, 100);
  await pointer(wrapper, "pointerdown", 200, 100, { pointerId: 2, isPrimary: false });
  await pointer(wrapper, "pointermove", 250, 100, { pointerId: 2, isPrimary: false });
  // 两指间距从 80 拉到 130 ⇒ 缩放比 1.625 ⇒ scale 从 24 涨到 39。**只断言方向与量级**：
  // 锚点换算后的 offset 是 zoomCellView 的内部结果，精确值写死会让这条用例随那条口径漂。
  const last = wrapper.emitted("update:view")?.at(-1)?.[0] as ViewTransform;
  expect(last.scale).toBeGreaterThan(24);
  expect(wrapper.emitted("paint")).toBeUndefined();
  expect(wrapper.emitted("fill")).toBeUndefined();
});
```

（`ViewTransform` 在这个文件里已经 import 过了。）

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/components/editor/__tests__/PatternCanvas.test.ts`
Expected: FAIL —— `tool: "pan"` 时 `startToolGesture` 什么都不建，三条都收不到 `update:view`。

- [ ] **Step 3: 实现**

`src/components/editor/PatternCanvas.vue`：

1. `ToolGesture` 联合类型加第三种（放在 `fill` 之后）：

```ts
  | { kind: "pan"; pointerId: number; start: Point; startView: ViewTransform }
```

2. `startToolGesture` 在 `if (props.tool === "fill")` 分支之后加一支（**位置在 `if (cell === null) return;` 之后**，那句守卫是本任务刻意保留的：落在图纸外按下永远什么都不做）：

```ts
  if (props.tool === "pan") {
    toolGesture = { kind: "pan", pointerId, start: point, startView: props.view };
  }
```

3. `onPointerMove` 里，取到 `const gesture = toolGesture;` 之后、`if (gesture.kind === "brush")` 之前加：

```ts
  if (gesture.kind === "pan") {
    // 位移从**按下那一刻**的视图与落点算起（不是逐帧累加），避免多次 emit 的累计漂移。
    emit(
      "update:view",
      panCellView(gesture.startView, viewport.value, gridSize(), point.x - gesture.start.x, point.y - gesture.start.y),
    );
    return;
  }
```

4. `finishToolGesture` 开头加（拖动抬手不发任何命令）：

```ts
  if (gesture.kind === "pan") return;
```

5. 该文件顶部「单指工具 / 双指视图」那一段注释里的「单指落在图纸外：本次手势什么也不做（不涂画、也不平移）」后面补一句：拖动工具同样受这条守卫。

- [ ] **Step 4: 跑测试**

Run: `npm run test -- src/components/editor/__tests__/PatternCanvas.test.ts && npm run test`
Expected: 全绿（既有的双指用例、画笔 / 填充用例都不受影响）。

- [ ] **Step 5: 提交**

```bash
git add src/components/editor/PatternCanvas.vue src/components/editor/__tests__/PatternCanvas.test.ts
git commit -m "feat(editor): 拖动工具的单指平移手势"
```

---

### Task 5: 选择器 —— 橡皮在两种用途下都提供

**Files:**
- Modify: `src/components/editor/PalettePicker.vue`（删 `mode` prop 与它的 `v-if`）
- Modify: `src/components/editor/PalettePanel.vue`（删 `:mode="pickMode"`，`pickMode` 保留）
- Test: `src/components/editor/__tests__/PalettePicker.test.ts`、`src/components/editor/__tests__/PalettePanel.test.ts`

**Interfaces:**
- Produces: `PalettePicker` 的 props 只剩 `palette` / `usedIndices`；`data-testid="picker-eraser"` 恒存在，点它 `emit("pick", EMPTY)`。
- Consumes: `EMPTY`（组件已 import）。

- [ ] **Step 1: 改断言（规格 §4.2 批准的那两条反转 + 一条新增）**

`PalettePicker.test.ts:157` 那条改成：

```ts
it("[改写] 橡皮项在两种用途下都渲染，点它 emit EMPTY", async () => {
  const wrapper = mountPicker();
  await wrapper.get("[data-testid='picker-eraser']").trigger("click");
  expect(wrapper.emitted("pick")?.at(-1)).toEqual([EMPTY]);
});
```

（`mode` prop 消失后，`mountPicker` 的默认参数表里也要去掉 `mode`。先把该文件里所有 `mode: "brush"` / `mode: "recolor"` 的传参删掉。）

`PalettePanel.test.ts:398` 一带那条「画笔模式下没有 `picker-eraser`」反转成「**有**」，并在这一组补一条**跨组件**用例（选择器是面板自己渲染的，所以还是同一个 `mount`）：

```ts
it("[改写] 点当前色槽 → 点橡皮：交出的当前色是 EMPTY", async () => {
  const wrapper = mountPanel();
  await wrapper.get("[data-testid='palette-current']").trigger("click");
  await wrapper.get("[data-testid='picker-eraser']").trigger("click");
  expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([EMPTY]);
});
```

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/components/editor/__tests__/PalettePicker.test.ts src/components/editor/__tests__/PalettePanel.test.ts`
Expected: FAIL —— 画笔用途下 `picker-eraser` 不存在。

- [ ] **Step 3: 实现**

`PalettePicker.vue`：橡皮按钮上的 `v-if="mode === 'recolor'"` 整行删掉；props 里的 `mode` 及其 JSDoc 删掉；文件头注释里「`mode` 决定用途（§5.3）：`recolor` 时多一个橡皮项」改成新的事实（橡皮总是提供）。

`PalettePanel.vue`：模板里的 `:mode="pickMode"` 删掉。`pickMode` 这个 ref **保留**——`onPick` 仍靠它分岔「批量换色」与「改画笔色」；把它的 JSDoc 改成「用途只服务 `onPick` 的分岔，不再往选择器里传」。另外改两处已经过时的注释：文件头「独立的橡皮也搬到了工具栏（`PatternToolbar`）」、模板里「橡皮态只在这儿显示「橡皮」：独立的橡皮按钮在工具栏上」——两处都改成「工具栏不再有橡皮按钮，橡皮是选择器里的一个条目」。

- [ ] **Step 4: 跑测试**

Run: `npm run test -- src/components/editor/__tests__/PalettePicker.test.ts src/components/editor/__tests__/PalettePanel.test.ts && npm run test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/components/editor/PalettePicker.vue src/components/editor/PalettePanel.vue src/components/editor/__tests__/PalettePicker.test.ts src/components/editor/__tests__/PalettePanel.test.ts
git commit -m "feat(editor): 选择器在画笔用途下也提供橡皮"
```

---

### Task 6: 工具条 —— 加「拖动」按钮

**Files:**
- Modify: `src/components/editor/PatternToolbar.vue`（`TOOLS` 表加一行；文件头「十颗图标按钮」改十一颗）
- Test: `src/components/editor/__tests__/PatternToolbar.test.ts`、`src/views/__tests__/EditorPage.test.ts`（testid 封闭清单）

**Interfaces:**
- Consumes: `"pan"`（Task 3）、`PixelIcon` 的 `pan`（Task 2）。
- Produces: `data-testid="tool-pan"`、`aria-label="拖动"`、`aria-pressed` 读 `tool === "pan"`。

- [ ] **Step 1: 写失败用例**

`PatternToolbar.test.ts`：

- `TOOL_BUTTONS`（`:30`，testid → 工具值）与 `ICON_BUTTONS`（`:42`，testid → 中文名）两张表各加一行 `["tool-pan", "pan"]` / `["tool-pan", "拖动"]`——两张表都被既有用例循环消费，加一行就自动多一轮断言（「只 emit 一次且载荷是自己的工具名」、「aria-label 逐字」）；
- 「一套 DOM / 尺寸类」那一组（`:252` 的 testid 清单）加上 `"tool-pan"`；
- 按下态那组加：

```ts
it("「拖动」按钮：按下态读 tool === 'pan'", async () => {
  const wrapper = mountToolbar({ tool: "pan" });
  expect(wrapper.get("[data-testid='tool-pan']").attributes("aria-pressed")).toBe("true");
  expect(wrapper.get("[data-testid='tool-brush']").attributes("aria-pressed")).toBe("false");
});
```

`EditorPage.test.ts:1861` 的 testid 封闭清单加 `"tool-pan"`。

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/components/editor/__tests__/PatternToolbar.test.ts`
Expected: FAIL —— 没有 `tool-pan` 节点。

- [ ] **Step 3: 实现**

`PatternToolbar.vue` 的 `TOOLS` 表：

```ts
const TOOLS: readonly { readonly tool: EditorTool; readonly label: string }[] = [
  { tool: "brush", label: "画笔" },
  { tool: "fill", label: "填充" },
  { tool: "pan", label: "拖动" },
];
```

（追加在末尾：它占据原来橡皮按钮的位置，DOM 顺序不变。）同步把文件头注释里的「十颗图标按钮」「三个主工具」等计数与枚举改准。

- [ ] **Step 4: 跑测试**

Run: `npm run test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/components/editor/PatternToolbar.vue src/components/editor/__tests__/PatternToolbar.test.ts src/views/__tests__/EditorPage.test.ts
git commit -m "feat(editor): 工具条增加拖动按钮"
```

---

### Task 7: 默认工具改成拖动

**Files:**
- Modify: `src/stores/editor.ts`（`DEFAULT_TOOL`）
- Modify: `src/stores/__tests__/editor.test.ts`（三处初值断言）
- Modify: `src/views/__tests__/EditorPage.test.ts`（`dragPaint` 夹具、`:1252` 的播种值、`:156` 一带）
- Modify: `src/views/__tests__/EditorPageRouterLink.test.ts`（`:177` 一带）

**Interfaces:**
- Produces: 新会话的工具初值是 `"pan"`（`DEFAULT_TOOL` 的三个消费者——`tool` 初值、`loadPattern`、重置路径——自动跟改）。

- [ ] **Step 1: 改夹具与断言**

`EditorPage.test.ts` 的 `dragPaint`（`:308`）——它现在**不先选工具**，靠的就是「默认 = 画笔」。改成先点一次画笔按钮，再落笔：

```ts
async function dragPaint(
  wrapper: ReturnType<typeof mount>,
  from: readonly [number, number],
  to: readonly [number, number],
): Promise<void> {
  // 默认工具从本批起是「拖动」，而本夹具的名字就是「拖出一笔」——先显式握住画笔。
  await wrapper.get("[data-testid='tool-brush']").trigger("click");
  await pointerAtCell(wrapper, "pointerdown", from[0], from[1]);
  await pointerAtCell(wrapper, "pointermove", to[0], to[1]);
  await pointerAtCell(wrapper, "pointerup", to[0], to[1]);
}
```

同时把这几处的「播种值是画笔」改成「播种值是拖动」：`editor.test.ts` 的 `:156`、`:229`、`:331`，`EditorPage.test.ts:1252`（`expect(...props("tool")).toBe("brush")` → `"pan"`），`EditorPageRouterLink.test.ts:177` 一带的涂格用例（**它不走 `dragPaint`**，要自己先点 `tool-brush`）。

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/views/__tests__/EditorPage.test.ts src/stores/__tests__/editor.test.ts`
Expected: FAIL —— 三处工具初值断言仍是 `"brush"`。

- [ ] **Step 3: 实现**

`src/stores/editor.ts`：

```ts
const DEFAULT_TOOL: EditorTool = "pan";
```

并在它上面补一行注释：默认值是拖动——编辑页第一下拖动是平移，要涂色先点「画笔」；这条是 2026-10-13 人类伙伴明确要的（规格 §5.3）。

- [ ] **Step 4: 跑测试**

Run: `npm run test`
Expected: 全绿。若还有别的用例红，**逐条判断它是不是「本该先选工具」**——是就在该用例里显式点 `tool-brush` / `tool-fill`，不是就把这条红当成真缺陷查下去，**不许**把默认值改回去或把断言放宽。

- [ ] **Step 5: 提交**

```bash
git add src/stores/editor.ts src/stores/__tests__/editor.test.ts src/views/__tests__/EditorPage.test.ts src/views/__tests__/EditorPageRouterLink.test.ts
git commit -m "feat(editor): 进入编辑页默认选中拖动工具"
```

---

### Task 8: 橡皮入口搬家收尾（删工具栏橡皮 + 页面接线）

**Files:**
- Modify: `src/components/editor/PatternToolbar.vue`（删 `eraserActive` prop、`eraser` emit、橡皮按钮）
- Modify: `src/views/EditorPage.vue`（删 `onEraser`、`:eraser-active`、`@eraser`）
- Test: `src/components/editor/__tests__/PatternToolbar.test.ts`、`src/views/__tests__/EditorPage.test.ts`

**Interfaces:**
- Consumes: Task 5 已经把橡皮放进选择器（本任务之后，橡皮仍然有入口）。
- Produces: `PatternToolbar` 的 props 只剩 `canUndo` / `canRedo` / `tool` / `showGrid` / `showLabels`，emits 去掉 `eraser`。

- [ ] **Step 1: 改断言**

`PatternToolbar.test.ts`：

- 删掉 `eraserActive` 这个传参（`mountToolbar` `:24` 一带）；
- 删掉 `ICON_BUTTONS`（`:42`）里的 `["eraser", "橡皮"]`、`:252` 里的 `"eraser"`、以及 `:319–325` 那条 `data-testid="eraser"` 的行为用例（**它考的主体已经不存在**）；
- 新增：`expect(wrapper.find("[data-testid='eraser']").exists()).toBe(false);`（在「一套 DOM」那组里），把「工具栏不再有橡皮」这条钉住。

`EditorPage.test.ts`：

- `:1861` 的 testid 封闭清单去掉 `"eraser"`；
- 删掉 `:1589` 一带那条 `<工具栏「橡皮」：设当前色为 EMPTY 并切回画笔>`（**考的是 `onEraser` 自己**，主体已不存在）；
- 剩下 5 条**靠工具栏橡皮拿到 `EMPTY`** 的 **fill** 用例（`:1982`、`:1997`、`:2011`、`:2033`、`:2061`）**不许删**——它们是 `onFill` 容差语义（橡皮 10 / 颜色 0、点空格空操作、一步撤销）仅有的端到端判据。加一个夹具并改接线：

```ts
/** 从选色区拿到橡皮：点当前色槽开选择器 → 点橡皮项。 */
async function pickEraser(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.get("[data-testid='palette-current']").trigger("click");
  await wrapper.get("[data-testid='picker-eraser']").trigger("click");
}
```

把 5 处 `await wrapper.get("[data-testid='eraser']").trigger("click");` 换成 `await pickEraser(wrapper);`。**这 5 条里凡是还要走填充工具的，仍需显式点 `tool-fill`**（默认工具已经是拖动）。
- 新增一条跨组件用例（本批唯一「入口搬了家」的路径，必须有端到端判据）：

```ts
it("[入口搬家] 从选色区选橡皮：当前色变 EMPTY，且工具不变", async () => {
  const wrapper = await mountPage();
  const editor = useEditor();
  expect(editor.currentColor).toBe(0); // 播种色

  await pickEraser(wrapper);

  expect(editor.currentColor).toBe(EMPTY);
  // 不再顺手切回画笔（旧 `onEraser` 会切）：橡皮 + 填充 = 大片擦除，这条路径必须留着
  expect(editor.tool).toBe("pan");
});
```

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/components/editor/__tests__/PatternToolbar.test.ts src/views/__tests__/EditorPage.test.ts`
Expected: FAIL —— 工具栏仍有 `eraser` 节点；新的跨组件用例在 `currentColor` 上失败。

- [ ] **Step 3: 实现**

`PatternToolbar.vue`：删 props 里的 `eraserActive`、emits 里的 `eraser`、模板里那个 `<BeadButton data-testid="eraser" …>`；文件头注释里「橡皮从调色板搬进工具条」「橡皮的接收方（`EditorPage.onEraser`）」两段删掉，改成「橡皮是选择器里的一个条目（本批之前它在这条工具条上）」。

`EditorPage.vue`：模板上 `:eraser-active="editor.currentColor === EMPTY"` 与 `@eraser="onEraser"` 两行删掉；`onEraser` 函数与它的 JSDoc 整段删掉；如果 `EMPTY` 这个 import 因此没有了消费者，把 import 也一起删（用 `rg -n "EMPTY" src/views/EditorPage.vue` 核一下，`onFill` 里还在用就留着）。

- [ ] **Step 4: 跑测试**

Run: `npm run test && npm run build`
Expected: 全绿 + 类型检查通过（`vue-tsc` 会揪住漏删的 `eraserActive` 绑定）。

- [ ] **Step 5: 提交**

```bash
git add src/components/editor/PatternToolbar.vue src/views/EditorPage.vue src/components/editor/__tests__/PatternToolbar.test.ts src/views/__tests__/EditorPage.test.ts
git commit -m "refactor(editor): 橡皮入口收敛到选色区，删除工具栏橡皮"
```

---

### Task 9: 图纸矩形内的浅色纸底

**Files:**
- Modify: `src/components/ui/beadColors.ts`（新增 `PAPER_ON_DARK`）
- Modify: `src/components/ui/__tests__/beadColors.test.ts`（同源闸门）
- Modify: `src/components/editor/PatternCanvas.vue`（`draw()` 里铺底）
- Test: `src/components/editor/__tests__/PatternCanvas.test.ts`

**Interfaces:**
- Produces: `export const PAPER_ON_DARK: string`（Task 之外没有消费者；下一批「预览改成施工图中间那块」会复用它）。

- [ ] **Step 1: 写失败用例**

`beadColors.test.ts` 加一条：

```ts
it("PAPER_ON_DARK（图纸纸底）与 --color-bead-card 同源", () => {
  // 纸底借的是设计系统里「纸」那一档（§5.4）；没有同名 token，同源对象是 bead-card。
  expect(css).toContain(`--color-bead-card: ${PAPER_ON_DARK}`);
});
```

`PatternCanvas.test.ts` 加两条：

```ts
it("图纸矩形内铺纸底：空格不再透出深板底", async () => {
  const wrapper = mountCanvas(); // 32×32 @ scale 24、offset (-200, -200)
  await wrapper.vm.$nextTick();
  const paper = fills.find((fill) => fill.fillStyle === PAPER_ON_DARK);
  expect(paper).toEqual({ x: -200, y: -200, w: 768, h: 768, fillStyle: PAPER_ON_DARK });
});

it("纸底画在色块层之前（顺序反了会把豆粒盖住）", async () => {
  const wrapper = mountCanvas();
  await wrapper.vm.$nextTick();
  expect(ops.indexOf("fillRect")).toBeLessThan(ops.indexOf("drawImage"));
});
```

第二条要求先把桩里的 `drawImage` 记进 `ops`（现在它只进 `draws`）：

```ts
      drawImage: (...drawArgs: unknown[]): void => {
        ops.push("drawImage");
        draws.push({ target, args: drawArgs });
      },
```

（既有用例只按 `ops.filter(...)` 计数与比较 `indexOf` / `lastIndexOf`，插一条不影响它们。）

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/components/ui/__tests__/beadColors.test.ts src/components/editor/__tests__/PatternCanvas.test.ts`
Expected: FAIL —— `PAPER_ON_DARK` 不存在；也没有这条 `fillRect`。

- [ ] **Step 3: 实现**

`beadColors.ts`：

```ts
/**
 * 图纸矩形内的**纸底**（§5.4）：空格是透明的，没有它就会透出深色板底——去了背景的黑线图
 * 与板底糊在一起看不见。
 *
 * 借设计系统里「纸」那一档 `--color-bead-card`：它没有同名的画布常量，同源对象就是它。
 * **只铺在图纸矩形内**：画布外那一圈仍然是深色板底 + 板孔点阵（规格 §6.1 对那一圈仍逐字成立）。
 */
export const PAPER_ON_DARK = "#FFF9EE";
```

`PatternCanvas.vue` 的 `draw()`，在 `ctx.clearRect(...)` 之后、`ctx.drawImage(layer, ...)` **之前**插入：

```ts
  // 纸底：铺满图纸矩形。色块层里的空格是透明的，透出这层纸而不是深板底（§5.4）。
  ctx.fillStyle = PAPER_ON_DARK;
  ctx.fillRect(view.offsetX, view.offsetY, props.pattern.width * cellPx, props.pattern.height * cellPx);
```

同时把上面那句「空格不铺底：透明格透出容器那层深色拼豆板」改成新的事实（图纸外那一圈仍是深板底）。`import` 一行加上 `PAPER_ON_DARK`。

- [ ] **Step 4: 跑测试**

Run: `npm run test && npm run build`
Expected: 全绿 + 类型检查通过。

- [ ] **Step 5: 提交**

```bash
git add src/components/ui/beadColors.ts src/components/ui/__tests__/beadColors.test.ts src/components/editor/PatternCanvas.vue src/components/editor/__tests__/PatternCanvas.test.ts
git commit -m "feat(editor): 图纸矩形内铺浅色纸底"
```

---

## 收尾（不进任何单个任务）

- [ ] 跑全量：`npm run test && npm run build`。
- [ ] 更新 `docs/开发文档索引.md` 里本批那一行的「实现计划」列，指向本文件。
- [ ] 把规格 §8 的 6 条真机清单原样抄进构建记录，作为**仍未验证项**——本计划在 CI 里一条都验不了
      （浅色豆在纸底上的对比度、外框是否像脏痕、单指拖动的手感）。
