# 按色号批量换色实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本项目既有的执行约定（见 `docs/开发约定详解.md`「开发流程」）：写任务简报 → **子代理**实现 →
> 控制者自己复核每一条承重声明 → **全新子代理**做任务级审查 → 修复轮，每轮以一次定向复审收尾。

**Goal:** 编辑页的已用色列表变成多选开关，选中的色号在画布上高亮它们占的全部格子；有选中时用「换成…」挑一个目标色，把这批格子一次改完、一步撤销（目标也可以是橡皮 = 批量擦除）。

**Architecture:** 判定「哪些格子要改」放进 core 的纯函数（`indicesWithValues`，与 `patternBackgroundIndices` 同口径），store 只做入口校验 + 复用既有的 `buildPaintCommand` / `EditHistory` / `publishChange` 入账；选中集合是 **UI 状态**，由 `EditorPage` 的 `ref` 持有，面板与画布各收 props、各发事件（不落 store、不进历史、不落盘）；选择器的顶部新增「已用色」快捷组，把「点已用色行 = 设当前画笔色」这条被拿走的路径补回来。

**Tech Stack:** TypeScript（严格模式）、Vue 3、Pinia、Vitest。零新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-11-batch-recolor-design.md`

## Global Constraints

- **只改本计划列出的文件**；不改依赖、不改 `package.json` / lockfile、不动无关代码。
- **既有断言的改写只允许规格 §8 点名的那两条**（`PalettePanel.test.ts` 里以「点行 = 换当前色」为前提的两条）。改写时判别核心一条不丢：emit 的必须是**全色卡下标**（不是 `usages` 里的位置、不是色号）、点行**不**展开选择器。其余既有断言一律不许放宽、删除或改弱。
- **选中集合每次都是新数组，绝不原地 `push`**：画布的重绘判据是浅比较，原地改会得到「不报错、只是高亮不刷新」。
- **`EMPTY` 是合法目标**（批量擦除），不是合法源（`usages` 不含空格）。
- `src/core/**` 零依赖、与框架无关：不得 import `vue` / `pinia` / `@tauri-apps/*`、不得引用 DOM 全局（闸门 `src/__tests__/coreBoundary.test.ts`）。
- TypeScript 严格模式，禁止 `any`；公开 API 的入口校验写在任何写操作之前，非法输入**响亮失败**。
- 换色**只能有一个目标色**（多个源色号一起归到一个目标），不做「每个源色各配一个目标」。
- 提交信息：Conventional Commits + 中文描述。
- 每个任务结束跑 `npm run test`；分支收尾跑 `npm run build`。
- 测试文件放对应目录的 `__tests__/` 下，沿用该文件既有的 import 风格与夹具风格。

## Review Focus

规格没写、但真实使用中最可能咬人的五类输入，各自在拥有那段代码的任务里有测试：

1. **选中的色号在选中期间被改光**（那一行从 `usages` 里消失）：期望操作条的计数与「实际会被改的量」一致，不为 0 颗的色号充数（→ 任务 4）。
2. **空选中 / 目标色等于源色**：期望不产生空的撤销记录、不置脏、不消耗撤销额度（→ 任务 2、4）。
3. **同一个色号在选择器里出现两次**（顶部「已用色」组 + 色卡网格）：期望既有网格钩子 `data-code` / `data-used` 的唯一性不被破坏（`get` 仍只命中一个）（→ 任务 3）。
4. **换一个选中集合**：期望画布高亮跟着换（浅比较那条的守卫）（→ 任务 5、6）。
5. **源色越界 / 目标越界 / 换图后残留选择**：期望前者响亮失败，后者被清空（→ 任务 2、6）。

---

### Task 1: core 按色号收集格子下标 `indicesWithValues`

**Files:**
- Modify: `src/core/pattern/edit.ts`（追加导出，紧跟 `buildPaintCommand` 之后）
- Test: `src/core/pattern/__tests__/edit.test.ts`（追加一个 `describe`）

**Interfaces:**
- Consumes: `EMPTY`（`./types`）。
- Produces: `export function indicesWithValues(cells: Uint16Array, values: readonly number[]): number[]`
  - 返回值**落在** `values` 里的格子下标（行优先、升序）。
  - `values` 里出现非整数 / 负数 / `> EMPTY` 的值 → 抛错（口径同 `buildPaintCommand` 的 `to`：越界值会被 `Uint16Array` 静默截断，不能静默放行）；`values` 不是数组 → 抛错。
  - 空 `values` → 空数组。图纸里没有的色号 → 空数组（**不是**抛错）。
  - `EMPTY` 是合法取值（匹配空格格），本层不拦。

- [ ] **Step 1: 写失败测试**

```ts
// src/core/pattern/__tests__/edit.test.ts（追加）
import { indicesWithValues } from "../edit"; // 与文件头既有的 import 合并

describe("indicesWithValues：值落在给定集合里的格子下标", () => {
  it("多色号取并集，行优先升序", () => {
    const cells = Uint16Array.from([1, 2, 3, 2, 1]);
    expect(indicesWithValues(cells, [1, 2])).toEqual([0, 1, 3, 4]);
  });

  it("色卡里存在但图纸里没有的色号 → 空数组（不是抛错）", () => {
    expect(indicesWithValues(Uint16Array.from([1, 1]), [7])).toEqual([]);
  });

  it("空集合 → 空数组", () => {
    expect(indicesWithValues(Uint16Array.from([1, 2]), [])).toEqual([]);
  });

  it("EMPTY 是合法取值（匹配空格格）", () => {
    expect(indicesWithValues(Uint16Array.from([1, EMPTY, 1]), [EMPTY])).toEqual([1]);
  });

  it("非法入口响亮失败", () => {
    const cells = Uint16Array.from([1, 2]);
    expect(() => indicesWithValues(cells, [NaN])).toThrow(/色号/);
    expect(() => indicesWithValues(cells, [-1])).toThrow(/色号/);
    expect(() => indicesWithValues(cells, [1.5])).toThrow(/色号/);
    expect(() => indicesWithValues(cells, [EMPTY + 1])).toThrow(/色号/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/pattern/__tests__/edit.test.ts`
Expected: FAIL —— `indicesWithValues is not a function` / 导入报错。

- [ ] **Step 3: 实现 `indicesWithValues`**

实现要点（签名与用例已经定死，只剩这几处选择）：`Set` 存 `values` 做 O(1) 命中；一次正向遍历 `cells`、命中就 `push` 下标（天然升序，不要遍历 `values` 再 `indexOf`）；校验在**遍历之前**逐个 `values` 做完。**别**在这一层守色卡色数（core 不知道色卡），也别守 `cells` 的长度。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/pattern/__tests__/edit.test.ts`
Expected: PASS（既有用例一条不红）。

- [ ] **Step 5: 提交**

```bash
git add src/core/pattern/edit.ts src/core/pattern/__tests__/edit.test.ts
git commit -m "feat(core): 按色号收集格子下标（indicesWithValues）"
```

---

### Task 2: store 动作 `recolor`

**Files:**
- Modify: `src/stores/editor.ts`（新增动作 + return 列表）
- Test: `src/stores/__tests__/editor.test.ts`（新增 `describe`；两处一致性文字改动）

**Interfaces:**
- Consumes: `indicesWithValues`（任务 1）、既有的 `buildPaintCommand` / `publishChange` / `requireLoadedPattern` / `colorCount` / `EMPTY`。
- Produces: `recolor(sources: readonly number[], to: number): void`
  - 语义：把图纸里值落在 `sources` 里的**全部**格子改成 `to`，**一条命令 = 一步撤销**。
  - 校验（在任何写操作之前）：`sources` 必须是数组、每个元素是 `0..colorCount-1` 的整数（口径同 `setCurrentColor`）；`to` 必须是 `0..colorCount-1` 的整数**或 `EMPTY`**。错误消息里带实际值。
  - 命令为 `null`（源集合空 / 目标等于所有源 / 图纸里没有这些色号）时什么都不做：不入栈、不动 `revision`、不置脏。

- [ ] **Step 1: 写失败测试**

```ts
// src/stores/__tests__/editor.test.ts（新增）
describe("recolor：按色号批量换色", () => {
  it("一次 recolor = 一条命令，撤销一次整批还原", () => {
    const { editor, pattern, session } = seedEditor(); // 该文件既有夹具
    const before = [...pattern.cells];
    editor.recolor([/* 图里用量最大的那个色号 */], /* 另一个色号 */);

    expect(editor.canUndo).toBe(true);
    expect(editor.revision).toBe(1);
    expect(session.dirty).toBe(true);
    editor.undo();
    expect([...pattern.cells]).toEqual(before);
  });

  it("目标可以是 EMPTY（批量擦除）", () => { /* recolor([x], EMPTY) → 那些格全为 EMPTY */ });

  it("空源集合 / 图纸里没有的色号 ⇒ 不置脏、不动 revision、不消耗撤销额度", () => {
    const { editor, session } = seedEditor();
    editor.recolor([], 1);
    editor.recolor([/* 未使用的色号 */], 1);
    expect(session.dirty).toBe(false);
    expect(editor.revision).toBe(0);
    expect(editor.canUndo).toBe(false);
  });

  it("源色越界 / 目标越界 ⇒ 抛错，且不动图纸与状态", () => { /* -1 / 1.5 / colorCount / NaN，消息带实际值 */ });

  it("源集合本身不是数组 ⇒ 抛错", () => { /* 传 null 用 as never 之类的显式断言，不改签名 */ });
});
```

`seedEditor()` 的夹具与「图里有哪些色号」按该文件既有写法取（既有的 `makePattern()` / `COLOR_COUNT` 就在文件里），**不要**新造第二份夹具。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/editor.test.ts`
Expected: FAIL —— `editor.recolor is not a function`。

- [ ] **Step 3: 实现 `recolor`**

放在 `eraseCells` 之后。形状与 `eraseCells` 完全一致：`requireLoadedPattern()` → 两道入口校验 → `buildPaintCommand(current.cells, indicesWithValues(current.cells, sources), to, "换色")` → `null` 就返回 → `publishChange(history.value.commit(current.cells, command))`。**不新写判定、不新写入账。**

- [ ] **Step 4: 跑测试确认通过 + 更新两处会过期的文字**

Run: `npx vitest run src/stores/__tests__/editor.test.ts`
Expected: PASS。

同时更新该文件里两处「五个动作」的计数（置脏动作从五个变六个）：
文件头注释第 23 行 `只有 paint / applyRect / eraseCells / undo / redo 会置脏`、以及
`describe("只有改 cells 的五个动作会置脏")`。`recolor` 要进那份**正向**清单（该 `describe` 里的
反向清单不必加它——它不在「不置脏」那组）。

- [ ] **Step 5: 提交**

```bash
git add src/stores/editor.ts src/stores/__tests__/editor.test.ts
git commit -m "feat(editor): store 新增按色号批量换色动作"
```

---

### Task 3: 选择器「已用色」组与换色模式

**Files:**
- Modify: `src/components/editor/PalettePicker.vue`
- Test: `src/components/editor/__tests__/PalettePicker.test.ts`（含 `mountPicker` 默认 props 补一个 `mode`）

**Interfaces:**
- Produces（供任务 4 消费）：
  - prop `mode: "brush" | "recolor"`（**必填**，调用方必须声明用途，不给缺省值）。
  - emit `pick: [number]` 语义不变（`mode="recolor"` 时点橡皮项 emit 的是 `EMPTY`）；emit `close: []` 不变。
  - 新 DOM 钩子：顶部组的每一项 `data-testid="picker-used"` + `data-used-code="<色号>"`；橡皮项 `data-testid="picker-eraser"`。
  - **顶部组不带 `data-code` / `data-used`**（那两个属性是色卡网格的钩子，两处都带会让既有的「已用色标记」用例一次命中两个元素）。

- [ ] **Step 1: 写失败测试**

```ts
describe("顶部「已用色」组", () => {
  it("按 usedIndices 的顺序列出色号，点一下 emit 该色的全色卡下标", async () => {
    const wrapper = mountPicker({ palette: SCRAMBLED, usedIndices: [2, 0] });
    const items = wrapper.findAll("[data-testid='picker-used']");
    expect(items.map((el) => el.attributes("data-used-code"))).toEqual(["M1", "B1"]); // 顺序 = usedIndices，不是色卡顺序
    await items[0].trigger("click");
    expect(wrapper.emitted("pick")?.at(-1)).toEqual([2]);
  });

  it("usedIndices 为空时这一组不渲染", () => {
    expect(mountPicker({ palette: SCRAMBLED, usedIndices: [] }).find("[data-testid='picker-used']").exists()).toBe(false);
  });

  it("[判别核心] 顶部组不占用色卡网格的 data-code / data-used 钩子", () => {
    const wrapper = mountPicker({ palette: SCRAMBLED, usedIndices: [0, 2] });
    expect(wrapper.findAll("[data-code='M1']")).toHaveLength(1); // 网格里那一个
    expect(wrapper.findAll("[data-used='1']")).toHaveLength(2);  // 既有的标记数口径不变
  });
});

describe("换色模式", () => {
  it("mode=brush 时不渲染橡皮项；mode=recolor 时渲染，点它 emit EMPTY", async () => {
    expect(mountPicker({ mode: "brush" }).find("[data-testid='picker-eraser']").exists()).toBe(false);
    const wrapper = mountPicker({ mode: "recolor" });
    await wrapper.get("[data-testid='picker-eraser']").trigger("click");
    expect(wrapper.emitted("pick")?.at(-1)).toEqual([EMPTY]);
  });
});
```

`mountPicker` 的默认 props 补 `mode: "brush"`（**一处**，既有的 12 条用例因此照旧）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/editor/__tests__/PalettePicker.test.ts`
Expected: FAIL —— 顶部组与橡皮项都不存在。

- [ ] **Step 3: 实现**

`usedIndices` 已经是既有 prop，顶部组直接由它映射到 `palette.colors[i]`（**不要**再算一次 `code → 下标`，也不要在本层排序）。橡皮项只在 `mode === "recolor"` 时渲染，文案「橡皮（空格）」。分组网格、色值、标记一律不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/editor/__tests__/PalettePicker.test.ts`
Expected: PASS（既有 12 条一条不红）。

- [ ] **Step 5: 提交**

```bash
git add src/components/editor/PalettePicker.vue src/components/editor/__tests__/PalettePicker.test.ts
git commit -m "feat(editor): 选择器顶部加已用色快捷组与换色模式"
```

---

### Task 4: 面板的行改多选 + 操作条

**Files:**
- Modify: `src/components/editor/PalettePanel.vue`
- Test: `src/components/editor/__tests__/PalettePanel.test.ts`（**改写两条**冲突用例 + 新增）

**Interfaces:**
- Consumes: 任务 3 的 `mode` / 顶部组 / 橡皮项；`rows`（既有的 `code → 全色卡下标` 权威映射）。
- Produces（供任务 5、6 消费）：
  - prop `selected: readonly number[]`（**必填**，值是**全色卡下标**；顶部「已用色」组在换色模式下也 服从 mode：pick 就是目标色，与色卡网格同义）。
  - emit `update:selected: [readonly number[]]`（切换选中时发**新数组**）。
  - emit `recolor: [sources: readonly number[], to: number]`；`sources` 是**有效选中**（只含仍在 `usages` 里的色号）的全色卡下标，`to` 可以是 `EMPTY`。
  - 新 DOM 钩子：行的 `data-selected="1"`；操作条 `data-testid="select-bar"` + `select-bar-recolor` + `select-bar-clear`。

- [ ] **Step 1: 改写两条与新规格直接冲突的用例 + 写新增失败用例**

改写（人类伙伴已确认，见规格 §8；判别核心一条不丢）：

```ts
// 原「点某一行 emit 的是全色卡下标」→ 改成断言 update:selected 的载荷
it("点行 emit 的选中集合是全色卡下标（不是它在 usages 里的位置、也不是色号）", async () => {
  const wrapper = mountPanel();
  await wrapper.findAll("[data-testid='palette-row']")[1].trigger("click");
  expect(wrapper.emitted("update:selected")?.at(-1)).toEqual([[0]]);
  expect(indexOf(palette, "M1")).toBe(206);
  await wrapper.findAll("[data-testid='palette-row']")[0].trigger("click");
  expect(wrapper.emitted("update:selected")?.at(-1)).toEqual([[206]]);
});

// 原「点行只换当前色，不会顺手展开选择器」→ 改成三件事一起断言
it("点行只切换选中：不改当前色、不展开选择器", async () => {
  const wrapper = mountPanel();
  expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
  await wrapper.findAll("[data-testid='palette-row']")[0].trigger("click");
  expect(wrapper.emitted("update:selected")?.at(-1)).toEqual([[206]]);
  expect(wrapper.emitted("update:currentColor")).toBeUndefined();
  expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
});
```

新增：

```ts
describe("选中与操作条", () => {
  it("已选中的行带 data-selected，未选中的不带", () => { /* selected: [206] → 只有 M1 那行有 */ });
  it("再点一次取消选中（载荷里去掉它）", () => { /* selected: [206] + 点 M1 → update:selected [[]] */ });
  it("没有有效选中时操作条不渲染", () => { /* selected: [] 与 selected: [某未用色号] 两种都不渲染 */ });
  it("[Review Focus 1] 操作条按有效选中计数：选中集合里混着一个已从 usages 消失的色号", () => {
    // selected: [206, 0]，而 usages 只有 M1(9 颗) ⇒ 文案是「已选 1 个色号 · 共 9 颗」，不是 2 个
  });
  it("[Review Focus 2] 选中集合里全是已消失的色号 ⇒ 操作条不渲染（点不到换色）", () => {});
  it("[取消选择] emit 空数组", async () => { /* 点 select-bar-clear → update:selected [[]] */ });
  it("[换成…] 打开选择器且是换色模式（橡皮项在），点目标色 emit 有效源集合 + 目标值并收起", async () => {
    // selected: [206] → 点 select-bar-recolor → picker 出现且 picker-eraser 存在
    // → 点网格里的 A1（下标 0）→ recolor [[206], 0]，picker 收起
  });
  it("[换成…] 后点橡皮 ⇒ recolor 的目标是 EMPTY", async () => { /* recolor [[206], EMPTY] */ });
  it("[换成…] 后点顶部已用色组 ⇒ 目标就是那个色号，不是 update:currentColor", async () => {
    // selected: [0]（A1）、usages 里还有 M1(206) → 换色模式下点顶部 M1 → recolor [[0], 206]
  });
  it("有选中时点当前色槽进的仍是画笔模式：点目标色只 emit update:currentColor，选中与操作条都保留", async () => {
    // 反向守卫：色槽被接成换色入口、或换完把选中清掉，这条必红
  });
  it("进入换色模式后点关闭：既不 emit recolor 也不 emit update:currentColor", async () => {});
  it("画笔模式（点当前色槽）下点目标色仍只 emit update:currentColor", async () => {
    // 反向守卫：把两种用途接成同一条路，这条必红
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/editor/__tests__/PalettePanel.test.ts`
Expected: 改写的两条 PASS（旧实现下会是新的红线？不会——它们断言的是新事件，故先 FAIL）；新增的 FAIL。

- [ ] **Step 3: 实现**

- `selected` 做 `Set`；行点击 → 切换 → `emit("update:selected", 新数组)`。**新数组**，顺序按 `usages` 顺序（`rows` 过滤一遍即可）。
- `selectedRows = rows.filter(...)`；操作条在 `selectedRows.length > 0` 时渲染，位置在 **`PalettePicker` 之后、色号列表之前**（不能插到当前色槽与选择器之间：C8 修复 ③b 钉的「选择器是当前色槽的下一个兄弟」那条用例会红，它是有意保留的守卫）。
- 内部新增 `pickMode: "brush" | "recolor"`：点当前色槽 → `"brush"`；点 `[换成…]` → `"recolor"`。`onPick(value)` 按 `pickMode` 分流，两种情况都 `picking = false`。
- 行上**保留**既有的 `data-current` 标记。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/editor/__tests__/PalettePanel.test.ts`
Expected: PASS（`mountPanel` 的默认 props 补 `selected: []`，一处；端到端那条与「选择器是下一个兄弟」那条**不动**且仍绿）。

- [ ] **Step 5: 提交**

```bash
git add src/components/editor/PalettePanel.vue src/components/editor/__tests__/PalettePanel.test.ts
git commit -m "feat(editor): 已用色行改多选，加换色操作条"
```

---

### Task 5: 画布高亮选中的色号

**Files:**
- Modify: `src/components/editor/PatternCanvas.vue`
- Test: `src/components/editor/__tests__/PatternCanvas.test.ts`（含替身的 `fillRect` 记录方式）

**Interfaces:**
- Consumes: 任务 4 的选中集合（**色号**，不是格子下标——画布自己扫 `cells`，动态集合语义由既有的 `revision` 重绘通道覆盖，页面不要预先算下标清单）。
- Produces: prop `selected: readonly number[]`（**必填**）；模块级常量 `SELECT_HIGHLIGHT = "rgba(37, 99, 235, 0.45)"`（与框选同族）。

- [ ] **Step 1: 让替身能记录填充样式（既有替身改一处）+ 写失败测试**

`getContext` 替身里把 `fillStyle` 改成带 getter/setter 的属性、`fillRect` 记录 `{x, y, w, h, fillStyle}`（同时**保留** `ops.push("fillRect")`，既有按 `ops` 计数的用例不受影响）。

```ts
it("选中的色号在可见范围内被高亮填充，未选中的不被填充", () => {
  // 3×1 图纸、比例固定、无网格无编号（showGrid: false, showLabels: false），cells = [1, 2, 1]
  // mount 时 selected: [1]
  const hits = fills.filter((f) => f.fillStyle === "rgba(37, 99, 235, 0.45)");
  expect(hits.map((f) => [f.x, f.y, f.w, f.h])).toEqual([[0, 0, cellPx, cellPx], [2 * cellPx, 0, cellPx, cellPx]]);
});

it("[Review Focus 4] 换一个选中集合会重绘", async () => {
  // 同一实例 setProps({ selected: [2] }) ⇒ 高亮落在中间那格、原来两格不再有高亮
});

it("selected 为空时不产生任何高亮填充", () => { /* hits 为空 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/editor/__tests__/PatternCanvas.test.ts`
Expected: FAIL —— 没有任何 `fillStyle` 等于高亮色的填充。

- [ ] **Step 3: 实现 `drawSelected` + 挂进绘制顺序 + 挂进 watch**

- `drawSelected(ctx, range, cellPx)`：照 `drawPending` 的形状写（同一个可见范围过滤），判定用 `new Set(props.selected)`；在 `drawPending` 之前或之后调用都行（都在叠加层，互不遮挡地叠着），顺序自取。
- `watch([...])` 的源里**加上** `() => props.selected`（漏了它：换选中集合画面不动，且没有报错）。
- **浅比较的前提**：调用方每次都换新数组（Global Constraints）。这一条要在本文件的 JSDoc 里写明一句。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/editor/__tests__/PatternCanvas.test.ts`
Expected: PASS（`CanvasProps` 与该文件的 mount 辅助补 `selected: []`，一处；既有 900 行用例一条不红）。

- [ ] **Step 5: 提交**

```bash
git add src/components/editor/PatternCanvas.vue src/components/editor/__tests__/PatternCanvas.test.ts
git commit -m "feat(editor): 画布高亮选中的色号"
```

---

### Task 6: 编辑页接线

**Files:**
- Modify: `src/views/EditorPage.vue`
- Test: `src/views/__tests__/EditorPage.test.ts`

**Interfaces:**
- Consumes: 任务 2 的 `editor.recolor`、任务 4 的面板事件、任务 5 的画布 prop。
- Produces（页面内部，不导出）：`selectedColors: Ref<readonly number[]>`；`onRecolor(sources, to)`。

- [ ] **Step 1: 写失败测试（真组件端到端）**

```ts
describe("按色号批量换色（端到端）", () => {
  it("点行选中 → 换成另一个色 ⇒ 那批格子真的变了、选中被清空、用量表跟着更新", async () => {
    // 用既有的 mountPage() 夹具（真 EditorPage / PalettePanel / PatternCanvas，只有平台边界是桩——
    // 该文件既有的 canvas 2D 上下文桩、toDataURL 等）
    // 1) 先涂出一个只有 1 颗的色号（既有用例已有这一步的写法）
    // 2) 点它的行 → select-bar 出现，文案含「1 个色号」
    // 3) 点 select-bar-recolor → 点网格里目标色的色块
    // 4) 断言：pattern.cells 里那颗确实变成目标色；select-bar 消失；palette-row 少一行 / 颗数变了
  });

  it("[Review Focus 5] 载入另一份图纸后选中被清空", async () => {
    // 选中 → 切路由 id 触发 activate → select-bar 不存在，且 update:selected 不会带到新会话
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/EditorPage.test.ts`
Expected: FAIL —— 新增的两条红。

- [ ] **Step 3: 实现接线**

- `const selectedColors = ref<readonly number[]>([])`；给 `PatternCanvas` 传 `:selected="selectedColors"`；给 `PalettePanel` 传 `:selected="selectedColors"` 并接 `@update:selected="selectedColors = $event"`、`@recolor="onRecolor"`。
- `function onRecolor(sources: readonly number[], to: number): void { editor.recolor(sources, to); selectedColors.value = []; }` —— **页面用面板发来的 `sources`**，不用自己那份 ref（面板交出的就是操作条计数用的那份，避免 UI 与实际改动不一致）。
- 清空时机：`activate()` 里 `beginSession` 之后、以及 `reset()` 那条路（页面卸载）；两处各一行 `selectedColors.value = []`。
- 页面**不**持有 `picking` / `pickMode`（仍旧由面板自持，C8 的裁决 R-3 不变）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/EditorPage.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/views/EditorPage.vue src/views/__tests__/EditorPage.test.ts
git commit -m "feat(editor): 编辑页接上按色号批量换色"
```

---

### Task 7: 文档收录与全量验证

**Files:**
- Modify: `docs/开发文档索引.md`（「逐阶段文档」表加一行）
- Modify: `docs/开发约定详解.md`（记下被本批推翻的那条先例，照「导出下载（2026-10-10 C8 起…）」那一节的写法）

**Interfaces:**
- Consumes: 本次的规格与计划两份文件（已入库）。

- [ ] **Step 1: 索引加一行**

| 阶段 | 设计规格 | 实现计划 | 构建记录 | 延后项唯一真源 |
|---|---|---|---|---|
| 按色号批量换色 | 规格链接 | 计划链接 | —（记录在批次收尾时写） | 规格 §10（延后项） |

- [ ] **Step 2: `开发约定详解.md` 记下先例的推翻**

新起一节（放「导出下载」那节附近）：标题写「按色号批量换色（2026-10-11 起）」；内容三句——去背景规格 §3 的「不做按色号全图删除同类色」**部分兑现**；当时的拒绝理由是「无预览、会误伤主体同色区域」，本批的**预览 + 一步撤销**接住了这条风险；人类伙伴 2026-10-11 头脑风暴中的裁定。**不要**改写去背景规格的正文（那是当时的证据）。

- [ ] **Step 3: 全量验证**

Run: `npm run test`
Expected: 全绿（含 `src/__tests__/coreBoundary.test.ts` 闸门）。

Run: `npm run build`
Expected: `vue-tsc` 无错、Vite 构建成功（`selected` / `mode` 这两个新必填 prop 的调用点都补齐了——漏一处就是类型错）。

- [ ] **Step 4: 提交**

```bash
git add docs/开发文档索引.md docs/开发约定详解.md
git commit -m "docs: 收录按色号批量换色的规格与计划"
```

---

## 完成后的自查

- 规格 §8 点名的两条既有断言已按例外条款改写，判别核心（全色卡下标 / 不展开选择器）仍在；
- 规格 §5.2 的兄弟顺序不变式（选择器紧跟当前色槽）没有被操作条挤掉；
- `indicesWithValues` / `recolor` / `selected` / `mode` / `recolor` 事件这五个名字在 7 个任务里逐字一致；
- 真机人工验收项（规格 §9 的高亮可见性、触控目标大小）留给批次收尾：真机上小格子下高亮是否够醒目、选择器顶部那组的触控目标是否 ≥44px。
