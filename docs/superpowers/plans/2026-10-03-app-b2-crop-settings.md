# 计划 B2：选区页与尺寸/色卡/档位设置页 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 B1 的临时生成入口换成真正的向导——选图 → 矩形选区（拖动 / 缩放 / 锁定比例 / 旋转 90°）→ 尺寸 / 色卡 / 档位 → 生成 → 结果预览 → 改参数重跑；平板左右分栏、手机单栏。

**架构：** 新增三个 core 纯函数模块（`core/crop/view.ts` 视图变换与含旋转的坐标映射、`core/crop/rect.ts` 选区几何、`core/pattern/board.ts` 板与豆径换算），几何全部可被 vitest 直接覆盖；`services/imageSource.ts` 新增「一次 `<img>` 解码同时产出原图尺寸与 ≤1600 预览位图」的入口；`services/pipeline.ts` 新增必填 `sourceSize` 并拒绝越界 `crop`；`stores/draft.ts` 持有向导草稿与阶段机；两个 props 进 / 事件出的组件（`CropCanvas` 画布与手势、`ParamPanel` 表单与摘要）由 `views/SetupPage.vue` 在两种断点下装配；生成走 `useProjectSession().adopt()` + `save()`，重跑覆盖同一条记录。

**技术栈：** Vue 3 + TypeScript（严格模式，禁 `any`）+ Pinia + vue-router 4 + Tailwind CSS v4 + vitest（happy-dom）。

**规格：** `docs/superpowers/specs/2026-10-03-app-b2-crop-settings-design.md`（本计划的论证依据来自规格，执行者两份都读）

---

## 全局约束

每条隐含适用于所有任务。

- `src/core/**` 不得 import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，不得引用 DOM 全局（`document` / `window` / `createImageBitmap` / `OffscreenCanvas` / `Image`）；只允许 ECMAScript 标准内置对象。撞上被禁名字时**改命名**（例如把参数改叫 `sampleWindow`），不放宽 `src/__tests__/coreBoundary.test.ts` 的规则、不加任何绕过标记。
- `src/services/**` 是唯一接触平台 API 的层。core 需要平台能力时只定义接口，实现在 services。
- TypeScript 严格模式，禁止 `any`。提交信息用 Conventional Commits + 中文描述。
- 非 bugfix 类功能必须附带单元测试，**不可删改已有测试**。本计划唯一的例外：`src/services/__tests__/pipeline.test.ts` 的**构造入参**要补 `sourceSize` 字段（断言一条不动，理由见规格 §5.2）。任何被迫放宽或删除的断言必须在报告里单独列出理由。
- 公开 API 的入口必须校验到「非法输入响亮失败」，校验写在**任何写操作之前**；清单见规格 §12。新增 `export` 若只有测试消费，必须在 JSDoc 写明为何公开。
- 关键常量（改动需同步规格文档）：`EMPTY = 0xffff`、长边豆数 1–500、用色档位 `16 | 32 | null`、生成解码目标宽度 = 长边豆数 × 4、预览解码位图长边 ≤ 1600、空格判定 alpha 加权覆盖率 ≥ 0.25、撤销栈上限 50。
- B2 新增常量：`BEAD_MM = 5`、`BOARD_COLS = 29`、`BOARD_ROWS = 29`、`MIN_CROP_SIDE = 2`、`PREVIEW_MAX_EDGE = 1600`、`RESULT_PREVIEW_MAX_EDGE = 1024`。
- **本计划里的每一个代码块都是待验证的草稿。** B1 的实测教训：9 个任务里有 7 个的实现者报告「简报给出的代码本身有缺陷」，而计划作者从未编译或运行过它们。实现者必须先按代码块跑一次、确认它描述的形态，再按自己的判断改；报告里写明与简报的**每一处偏离**。
- 变异验证必须报告「**改了哪一行、改成什么**」与**原始输出**。只报「红了几条」无法被复核，本项目已因此两次得出错误结论。
- 控制者纪律：不在子代理运行期间跑全量测试；不清理 `%TEMP%` 下本会话的目录；报告工作树状态前连读两次 `git status`。
- 实现者**不许自己派审查者**；任务级审查由控制者另派全新子代理。
- 测试环境的实测事实（决定了哪些断言可写、哪些只能是桩）：happy-dom 无 `indexedDB`（用 `fake-indexeddb/auto`）；全局 `Blob` 过不了结构化克隆；`fetch` 拒绝 `blob:` scheme（`<img>` 挂 blob URL 永不 load、`naturalWidth` 恒 0）；canvas 是桩（`getContext("2d")` 返回 `null`、`toDataURL` 返回空字节）；`ResizeObserver.observe()` 是空实现；`getBoundingClientRect()` 返回全 0；`matchMedia` **真实**按 `window.innerWidth` 求值 `min-width`；`window.devicePixelRatio` 可赋值；`PointerEvent` 与 `Element.setPointerCapture` 都有真实实现。

## 既有测试的处置（动手删 `GeneratePage` 之前必须先做完）

`src/views/__tests__/GeneratePage.test.ts` 随页面删除。它里面有 **9 条有判别力的断言**，删之前每一条都必须有明确的新家——**这是搬家，不是丢失**：

| `GeneratePage.test.ts` 原断言 | 新家 |
|---|---|
| 没选图片时点生成给提示、不跳转 | `views/__tests__/PickPage.test.ts` |
| 平台不支持解码时显示中文原因、不落盘 | `views/__tests__/PickPage.test.ts` |
| 存储未初始化时给明确错误、不允许开工 | `views/__tests__/SetupPage.test.ts`（生成前的守卫） |
| 超长文件名把默认工程名夹到 100 字 | `services/__tests__/projectStore.test.ts` 的 `defaultProjectName`（任务 2） |
| 居中裁剪的源矩形（800×600 → `100,0,600,600`） | 被「用户选框 → 源矩形」取代：`SetupPage.test.ts` 端到端 1（用**非默认**选框，判别力更强） |
| 全透明图给提示、不落盘、不跳转 | `views/__tests__/SetupPage.test.ts` |
| 长边选 116 时落盘尺寸与参数都是 116 | `SetupPage.test.ts` 端到端 2（重跑覆盖）里断言 `doc.params.longSide` 与 `doc.width/height` |
| 档位「不限」落盘是 `null`、选 16 落盘是 16 | `SetupPage.test.ts`（三档各一条落盘断言） |
| 高比宽大时（600×800）裁到另一根轴 | `core/crop/__tests__/*` 的换轴用例 + `SetupPage.test.ts` 端到端 1 的 `rotation: 1` |

**在任务 14 删除这两个文件之前，控制者要逐条确认上表的新断言已经存在且绿。**

## 文件结构

**新增（生产代码）**

| 文件 | 职责 |
|---|---|
| `src/core/pattern/board.ts` | 板 / 豆径常量与豆数 → 厘米 / 板数换算、厘米格式化 |
| `src/core/crop/view.ts` | 视图变换（适配 / 缩放档位 / 平移夹取）与屏幕 ↔ 原图坐标映射（含旋转） |
| `src/core/crop/rect.ts` | 选区几何：比例锁、手柄缩放、平移夹取、可解析性判定、初始选区 |
| `src/stores/draft.ts` | 向导草稿与阶段机（`stage` / `generated` / `busy` / `error`） |
| `src/components/crop/CropCanvas.vue` | canvas 绘制（按 DPR 缩放）+ 指针手势；props 进、事件出 |
| `src/components/param/ParamPanel.vue` | 长边 / 档位 / 色卡卡片 / 尺寸摘要 / 生成按钮；props 进、事件出 |
| `src/views/PickPage.vue` | `/new`：选图、失败提示、「继续上次的选区」 |
| `src/views/SetupPage.vue` | `/new/setup`：装配两个组件、三个阶段、生成与落盘、断点布局、入口守卫 |

**新增（测试）**：`src/core/pattern/__tests__/board.test.ts`、`src/core/crop/__tests__/view.test.ts`、`src/core/crop/__tests__/rect.test.ts`、`src/services/__tests__/projectStore.test.ts`、`src/services/__tests__/imageSourcePreview.test.ts`、`src/stores/__tests__/draft.test.ts`、`src/components/crop/__tests__/CropCanvas.test.ts`、`src/components/param/__tests__/ParamPanel.test.ts`、`src/views/__tests__/PickPage.test.ts`、`src/views/__tests__/SetupPage.test.ts`。

**修改**：`src/services/imageSource.ts`、`src/services/pipeline.ts`、`src/services/projectStore.ts`、`src/services/patternThumbnail.ts`（JSDoc）、`src/core/pattern/stats.ts`（JSDoc）、`src/services/__tests__/pipeline.test.ts`（构造入参）、`src/views/LibraryPage.vue`、`src/views/EditorPage.vue`、`src/views/__tests__/LibraryPage.test.ts`、`src/views/__tests__/EditorPage.test.ts`、`src/router/index.ts`、`README.md`。

**删除**：`src/views/GeneratePage.vue`、`src/views/__tests__/GeneratePage.test.ts`（**项目红线项：删文件必须先获人类伙伴批准，本计划已获批准**，见规格 §3 表格末行）。

---

## 任务 1：板与豆径常量（`core/pattern/board.ts`）

**文件：**
- 创建：`src/core/pattern/board.ts`
- 测试：`src/core/pattern/__tests__/board.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/core/pattern/__tests__/board.test.ts
import { describe, expect, it } from "vitest";
import { BEAD_MM, BOARD_COLS, BOARD_ROWS, beadsToCm, boardCount, formatCm } from "../board";

/**
 * 这一组数字是**产品规格**，不是算法（规格 §14「主规格 R5 的状态更新」）：
 * 2026-10-03 由人类伙伴核对实物确认——5mm 豆、29×29 格/板。
 * 断言常量本身的价值是「改坏它必须有人发现」，与 MARD 色卡的五个锚点同性质。
 */
describe("板与豆径常量", () => {
  it("已核对实物的规格：5mm 豆、29×29 格/板", () => {
    expect(BEAD_MM).toBe(5);
    expect(BOARD_COLS).toBe(29);
    expect(BOARD_ROWS).toBe(29);
  });
});

describe("beadsToCm", () => {
  it("58 颗 5mm 豆 = 29 厘米", () => {
    expect(beadsToCm(58)).toBe(29);
  });

  it("1 颗豆 = 0.5 厘米", () => {
    expect(beadsToCm(1)).toBe(0.5);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "豆数 %s 非法时抛错",
    (bad) => {
      expect(() => beadsToCm(bad)).toThrow(/豆数/);
    },
  );
});

describe("boardCount", () => {
  it("29 颗正好一块板", () => {
    expect(boardCount(29, 29)).toEqual({ cols: 1, rows: 1, total: 1 });
  });

  // 这条专打 `Math.round` 实现：30/29 = 1.034 → round 得 1、ceil 得 2。
  it("30 颗要两块板（用 ceil 而不是 round）", () => {
    expect(boardCount(30, 29)).toEqual({ cols: 2, rows: 1, total: 2 });
  });

  it("58×58 要 2×2 = 4 块板", () => {
    expect(boardCount(58, 58)).toEqual({ cols: 2, rows: 2, total: 4 });
  });

  it("59×59 要 3×3 = 9 块板", () => {
    expect(boardCount(59, 59)).toEqual({ cols: 3, rows: 3, total: 9 });
  });

  it("非正方形图纸按各自方向算", () => {
    expect(boardCount(29, 30)).toEqual({ cols: 1, rows: 2, total: 2 });
    expect(boardCount(30, 29)).toEqual({ cols: 2, rows: 1, total: 2 });
  });

  it.each([
    [0, 10],
    [10, 0],
    [1.5, 10],
    [10, 1.5],
    [Number.NaN, 10],
  ])("图纸尺寸 %s×%s 非法时抛错", (width, height) => {
    expect(() => boardCount(width, height)).toThrow(/图纸/);
  });
});

describe("formatCm", () => {
  it("保留一位小数", () => {
    expect(formatCm(29)).toBe("29.0");
    expect(formatCm(0.5)).toBe("0.5");
  });

  // 刻意避开 22.25 这类二进制恰好等值的中点：toFixed 在中点上的取舍依赖浮点表示，
  // 断言它会写成一条「只在特定实现下成立」的脆用例。
  it("按一位小数四舍五入", () => {
    expect(formatCm(22.24)).toBe("22.2");
    expect(formatCm(22.26)).toBe("22.3");
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("非法厘米 %s 抛错", (bad) => {
    expect(() => formatCm(bad)).toThrow(/厘米/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/pattern/__tests__/board.test.ts`
预期：FAIL，报错形如 `Failed to resolve import "../board"`（文件还不存在）。

- [ ] **步骤 3：编写最少实现代码**

```ts
// src/core/pattern/board.ts

/**
 * 单颗豆的直径（毫米）。
 *
 * **2026-10-03 由人类伙伴核对实物确认**：5mm 豆。主规格 §12 的 R5 因此闭环。
 * 这是产品参数而不是算法常数——改它会让界面上的「成品厘米」全部失真，
 * 所以它有一组直接断言常量本身的用例（与 MARD 色卡的锚点同性质）。
 */
export const BEAD_MM = 5;

/** 一块拼豆板的列数 / 行数。2026-10-03 已核对实物：29×29 格。 */
export const BOARD_COLS = 29;
export const BOARD_ROWS = 29;

/**
 * 豆数 → 成品厘米（按单排紧密排列算，不含板间距）。
 *
 * 豆数必须是**整数且 ≥1**：与 `MIN_LONG_SIDE` 同口径——「0 颗豆的图纸」不存在，
 * 而非有限值（`NaN`）若不拦会一路传成界面上的 `NaN 厘米`。
 */
export function beadsToCm(beads: number): number {
  if (!Number.isInteger(beads) || beads < 1) {
    throw new Error(`豆数必须是 ≥1 的整数（当前 ${String(beads)}）`);
  }
  return (beads * BEAD_MM) / 10;
}

export interface BoardCount {
  readonly cols: number;
  readonly rows: number;
  readonly total: number;
}

/**
 * 拼出 `width × height` 颗豆需要几块板。
 *
 * 一律 `Math.ceil`：多出 1 颗豆就真的要多一块板（30 颗 → 2 块），
 * 用 `round` 会在 30–43 这一段系统性少报一块板。
 *
 * 这是**所需板的张数**，不是拼法分区——真正的分片导出是计划 B4。
 */
export function boardCount(width: number, height: number): BoardCount {
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(`图纸宽度必须是 ≥1 的整数（当前 ${String(width)}）`);
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new Error(`图纸高度必须是 ≥1 的整数（当前 ${String(height)}）`);
  }
  const cols = Math.ceil(width / BOARD_COLS);
  const rows = Math.ceil(height / BOARD_ROWS);
  return { cols, rows, total: cols * rows };
}

/**
 * 厘米 → 一位小数的展示串。
 *
 * 只在 core 里做是因为它是纯函数（可被 CI 断言），中文文案留在视图层。
 * 非有限值与负数抛错：负的成品长度没有意义，静默显示「-29.0 厘米」属静默失败。
 */
export function formatCm(cm: number): string {
  if (!Number.isFinite(cm) || cm < 0) {
    throw new Error(`厘米数必须是非负的有限数字（当前 ${String(cm)}）`);
  }
  return cm.toFixed(1);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/core/pattern/__tests__/board.test.ts`
预期：PASS（14 个用例左右全绿）。

- [ ] **步骤 5：确认边界闸门仍然绿**

运行：`npm run test -- src/__tests__/coreBoundary.test.ts`
预期：PASS。新模块没有任何 DOM 全局与框架 import。

- [ ] **步骤 6：Commit**

```bash
git add src/core/pattern/board.ts src/core/pattern/__tests__/board.test.ts
git commit -m "feat(core): 板与豆径常量及豆数换算"
```

---

## 任务 2：工程命名契约与存储单例适配器（`services/projectStore.ts`）

**文件：**
- 修改：`src/services/projectStore.ts`（新增 `defaultProjectName`；`setProjectStore` / `getProjectStore` 不动）
- 测试：`src/services/__tests__/projectStore.test.ts`（新建）

- [ ] **步骤 1：编写失败的测试**

```ts
// src/services/__tests__/projectStore.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import {
  defaultProjectName,
  getProjectStore,
  normalizeProjectName,
  setProjectStore,
} from "@/services/projectStore";

/**
 * 这份用例覆盖 `services/projectStore.ts` **自己**的两个契约面：
 * ① 模块级单例适配器（B1-4 明确推后到 B2 —— 现在生成流程会真实消费它们）；
 * ② `defaultProjectName`（B1 时叫 `GeneratePage.defaultName`，随该页删除而迁到这里，
 *    原用例在 `GeneratePage.test.ts` 里，见计划开头的「既有测试的处置」）。
 */

afterEach(() => {
  setProjectStore(null);
});

describe("setProjectStore / getProjectStore", () => {
  it("未注入时抛错，而不是静默返回一个假实现", () => {
    setProjectStore(null);
    expect(() => getProjectStore()).toThrow(/尚未初始化/);
  });

  it("注入后拿到的是同一个实例", async () => {
    const store = await createMemoryProjectStore();
    setProjectStore(store);
    expect(getProjectStore()).toBe(store);
  });

  it("setProjectStore(null) 能复位（测试之间不串味）", async () => {
    setProjectStore(await createMemoryProjectStore());
    setProjectStore(null);
    expect(() => getProjectStore()).toThrow(/尚未初始化/);
  });
});

describe("defaultProjectName", () => {
  it("去掉扩展名", () => {
    expect(defaultProjectName("小猫照片.png")).toBe("小猫照片");
    expect(defaultProjectName("a.b.jpg")).toBe("a.b");
  });

  it("没有扩展名时原样返回", () => {
    expect(defaultProjectName("小猫照片")).toBe("小猫照片");
  });

  it("只有扩展名、空串、纯空白都回落到中性名", () => {
    expect(defaultProjectName(".png")).toBe("新图纸");
    expect(defaultProjectName("")).toBe("新图纸");
    expect(defaultProjectName("   ")).toBe("新图纸");
  });

  // 长度断言用**字面量 100**：写成 `PROJECT_NAME_MAX` 的话，常量被改坏时两边一起变、断言恒绿。
  it("超长文件名夹到 100 字（否则 put 抛错，而那条记录根本没进库、用户无出路）", () => {
    const name = defaultProjectName(`${"あ".repeat(150)}.png`);
    expect(name).toHaveLength(100);
  });

  it("派生的名字必定能过 normalizeProjectName（不抛）", () => {
    const raw = ["小猫照片.png", "", "   ", ".png", `${"x".repeat(200)}.jpg`, "  a  "];
    for (const fileName of raw) {
      expect(() => normalizeProjectName(defaultProjectName(fileName))).not.toThrow();
    }
  });

  it("非字符串抛错，不猜", () => {
    expect(() => defaultProjectName(undefined)).toThrow(/文件名/);
    expect(() => defaultProjectName(42)).toThrow(/文件名/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/services/__tests__/projectStore.test.ts`
预期：FAIL，`defaultProjectName is not a function`（适配器那三条应当已经 PASS，因为它们覆盖的是 B1 既有实现——**如实记录这一现象**，它说明本任务的新增面只有 `defaultProjectName`）。

- [ ] **步骤 3：编写最少实现代码**

在 `src/services/projectStore.ts` 的 `normalizeProjectName` 之后追加：

```ts
/**
 * 从文件名派生默认工程名：去扩展名 → trim → 空则回落「新图纸」→ **夹到 `PROJECT_NAME_MAX`**。
 *
 * **为什么必须夹**（B1-6 的实测教训）：相册里的长标题 / 长时间戳文件名超过 100 字很常见，
 * 不夹就会让 `put` → `normalizeProjectName` 抛「工程名称不能超过 100 个字符」——而记录根本
 * 没进库，图纸库里连那一行都不存在，唯一的改名入口对不存在的记录也不存在。这是一条
 * **响亮失败但用户无出路**的死路，必须在源头截断。
 *
 * **为何公开**：它是「新建工程」这一动作的默认名来源，被 `SetupPage` 的生产代码消费
 * （迁自 B1 的 `GeneratePage.defaultName`，该页已被 B2 替换并删除）。
 *
 * 非法输入（非字符串）抛错：静默返回「新图纸」会把「调用方传错了东西」伪装成正常结果。
 */
export function defaultProjectName(fileName: unknown): string {
  if (typeof fileName !== "string") {
    throw new Error(`文件名必须是字符串（当前 ${String(fileName)}）`);
  }
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  return base.length === 0 ? "新图纸" : base.slice(0, PROJECT_NAME_MAX);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/services/__tests__/projectStore.test.ts`
预期：PASS（10 个用例）。

- [ ] **步骤 5：做一次变异，证明断言有效**

把 `defaultProjectName` 的 `base.slice(0, PROJECT_NAME_MAX)` 改成 `base`，运行同一命令。
预期：**1 条红**（「超长文件名夹到 100 字」）。把改动还原。

再把 `boardCount` 那类 `ceil` 的教训同样用在 `normalizeProjectName` 那条属性用例上：把
`defaultProjectName(".png")` 的回落分支删掉（让空串直接 `return base`），运行同一命令。
预期：**2 条红**（「只有扩展名…回落」与「派生的名字必定能过 normalizeProjectName」）。还原。

报告里写清「改了哪一行、改成什么、红了几条、原始输出」。

- [ ] **步骤 6：Commit**

```bash
git add src/services/projectStore.ts src/services/__tests__/projectStore.test.ts
git commit -m "feat(app): 默认工程名迁入存储契约并补单例适配器用例"
```

---

## 任务 3：视图变换与坐标映射（`core/crop/view.ts`）

**这个任务是全计划风险最高的一处**：屏幕 → 原图 → `crop` 的整条链错了**不会报错**，只会产出一张位置不对的图纸（B1 构建记录 §5 的 R9 已证明越界裁剪甚至是静默填透明）。所以它的每一层都必须是纯函数、且被逐条钉死。

**文件：**
- 创建：`src/core/crop/view.ts`
- 测试：`src/core/crop/__tests__/view.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/core/crop/__tests__/view.test.ts
import { describe, expect, it } from "vitest";
import {
  clampView,
  fitTransform,
  orientedToScreen,
  orientedToSource,
  screenToOriented,
  screenToSource,
  sourceRectToOriented,
  sourceRectToScreen,
  sourceToOriented,
  withZoom,
} from "../view";

/**
 * 源图一律用 **800×600**（非正方形）：正方形源图会让换轴错误完全不可见
 * （规格 §4.1 的构造性免疫警告）。矩形一律用**非居中**的，居中会让符号错误互相抵消。
 */
const SOURCE = { width: 800, height: 600 };

describe("旋转换算（规格 §4.1 的表）", () => {
  it("rotation 0 是恒等", () => {
    expect(sourceToOriented({ x: 30, y: 70 }, 0, SOURCE)).toEqual({ x: 30, y: 70 });
    expect(orientedToSource({ x: 30, y: 70 }, 0, SOURCE)).toEqual({ x: 30, y: 70 });
  });

  // 边界自证：只断言「某个内部点映射到某个数」的话，多套公式都可能蒙对；
  // 用图像四角能把公式的**方向**钉死（顺时针 vs 逆时针）。
  it("rotation 1 把源图左上送到显示空间右上，左下送到左上", () => {
    expect(sourceToOriented({ x: 0, y: 0 }, 1, SOURCE)).toEqual({ x: 600, y: 0 });
    expect(sourceToOriented({ x: 0, y: 600 }, 1, SOURCE)).toEqual({ x: 0, y: 0 });
    expect(sourceToOriented({ x: 800, y: 600 }, 1, SOURCE)).toEqual({ x: 0, y: 800 });
  });

  it("rotation 2 是中心对称", () => {
    expect(sourceToOriented({ x: 0, y: 0 }, 2, SOURCE)).toEqual({ x: 800, y: 600 });
    expect(sourceToOriented({ x: 30, y: 70 }, 2, SOURCE)).toEqual({ x: 770, y: 530 });
  });

  it("rotation 3 把源图左上送到显示空间左下", () => {
    expect(sourceToOriented({ x: 0, y: 0 }, 3, SOURCE)).toEqual({ x: 0, y: 800 });
    expect(sourceToOriented({ x: 800, y: 0 }, 3, SOURCE)).toEqual({ x: 0, y: 0 });
  });

  it("四个角度下都是双向恒等（往返回到原点）", () => {
    for (const rotation of [0, 1, 2, 3] as const) {
      const point = { x: 137, y: 42 };
      expect(orientedToSource(sourceToOriented(point, rotation, SOURCE), rotation, SOURCE)).toEqual(point);
    }
  });

  it("轴对齐矩形在显示空间仍是轴对齐矩形，且 1/3 下换轴", () => {
    const rect = { x: 100, y: 100, width: 200, height: 100 };
    expect(sourceRectToOriented(rect, 0, SOURCE)).toEqual({ x: 100, y: 100, width: 200, height: 100 });
    expect(sourceRectToOriented(rect, 1, SOURCE)).toEqual({ x: 400, y: 100, width: 100, height: 200 });
    expect(sourceRectToOriented(rect, 2, SOURCE)).toEqual({ x: 500, y: 400, width: 200, height: 100 });
    expect(sourceRectToOriented(rect, 3, SOURCE)).toEqual({ x: 100, y: 500, width: 100, height: 200 });
  });

  it("旋转不改变矩形的面积", () => {
    const rect = { x: 13, y: 29, width: 210, height: 90 };
    for (const rotation of [0, 1, 2, 3] as const) {
      const oriented = sourceRectToOriented(rect, rotation, SOURCE);
      expect(oriented.width * oriented.height).toBe(rect.width * rect.height);
    }
  });
});

describe("适配与缩放档位", () => {
  it("fit 取 contain 比例并居中（长边贴住视口）", () => {
    expect(fitTransform({ width: 400, height: 400 }, { width: 800, height: 600 })).toEqual({
      scale: 0.5,
      offsetX: 0,
      offsetY: 50,
    });
  });

  it("换到 2× 时以视口中心为锚，并把平移夹进图像范围", () => {
    const base = fitTransform({ width: 400, height: 400 }, { width: 800, height: 600 });
    expect(withZoom(base, { width: 400, height: 400 }, { width: 800, height: 600 }, 2)).toEqual({
      scale: 1,
      offsetX: -200,
      offsetY: -100,
    });
  });

  it("换到 4× 同理", () => {
    const base = fitTransform({ width: 400, height: 400 }, { width: 800, height: 600 });
    expect(withZoom(base, { width: 400, height: 400 }, { width: 800, height: 600 }, 4)).toEqual({
      scale: 2,
      offsetX: -600,
      offsetY: -400,
    });
  });

  // 「切回去等于适配态」是锚点公式正确性的最便宜证据：锚点写错时它会漂。
  it("从 4× 切回 fit 得到与直接适配完全相同的变换", () => {
    const viewport = { width: 400, height: 400 };
    const oriented = { width: 800, height: 600 };
    const base = fitTransform(viewport, oriented);
    const zoomed = withZoom(base, viewport, oriented, 4);
    expect(withZoom(base, viewport, oriented, "fit")).toEqual(base);
    expect(zoomed.scale).toBe(2);
  });
});

describe("平移夹取", () => {
  it("图像比视口小的方向居中锁定", () => {
    expect(clampView({ scale: 0.5, offsetX: 100, offsetY: 100 }, { width: 400, height: 400 }, { width: 200, height: 200 })).toEqual({
      scale: 0.5,
      offsetX: 150,
      offsetY: 150,
    });
  });

  it("图像比视口大的方向夹到「始终铺满视口」，不留空白", () => {
    expect(clampView({ scale: 1, offsetX: 100, offsetY: -500 }, { width: 400, height: 400 }, { width: 800, height: 800 })).toEqual({
      scale: 1,
      offsetX: 0,
      offsetY: -400,
    });
  });
});

describe("屏幕 ↔ 原图的组合映射", () => {
  const viewport = { width: 400, height: 400 };
  // rotation 1 下显示空间是 600×800 → fit 比例 0.5、水平居中偏移 50。
  const view = fitTransform(viewport, { width: 600, height: 800 });

  it("显示空间左上角对应原图左下角", () => {
    expect(view).toEqual({ scale: 0.5, offsetX: 50, offsetY: 0 });
    expect(screenToSource({ x: 50, y: 0 }, view, 1, SOURCE)).toEqual({ x: 0, y: 600 });
  });

  it("显示空间右下角对应原图右上角", () => {
    expect(screenToSource({ x: 350, y: 400 }, view, 1, SOURCE)).toEqual({ x: 800, y: 0 });
  });

  it("屏幕点 → 原图 → 屏幕是往返恒等（三个层都要参与）", () => {
    const screen = { x: 123, y: 271 };
    const back = orientedToScreen(sourceToOriented(screenToSource(screen, view, 1, SOURCE), 1, SOURCE), view);
    expect(back.x).toBeCloseTo(screen.x, 10);
    expect(back.y).toBeCloseTo(screen.y, 10);
  });

  it("矩形在屏幕上仍是矩形，尺寸按 scale 缩放", () => {
    expect(
      sourceRectToScreen({ x: 100, y: 100, width: 200, height: 100 }, view, 1, SOURCE),
    ).toEqual({ x: 250, y: 50, width: 50, height: 100 });
  });

  it("screenToOriented 是 orientedToScreen 的逆", () => {
    expect(screenToOriented({ x: 250, y: 50 }, view)).toEqual({ x: 400, y: 100 });
  });
});

describe("入口校验（规格 §12）", () => {
  it("视口是 0 或负数时抛错", () => {
    expect(() => fitTransform({ width: 0, height: 400 }, { width: 800, height: 600 })).toThrow(/视口宽度/);
    expect(() => fitTransform({ width: 400, height: -1 }, { width: 800, height: 600 })).toThrow(/视口高度/);
  });

  // 这条专打「把视口尺寸也要求成整数」的实现：浏览器缩放下 getBoundingClientRect 返回小数，
  // 要求整数会在生产环境抛错，而 CI 里若只用整数视口就永远发现不了。
  it("视口尺寸允许小数（CSS 像素），只有图像尺寸必须整数", () => {
    const view = fitTransform({ width: 400.5, height: 400.25 }, { width: 800, height: 600 });
    expect(view.scale).toBeCloseTo(0.500625, 10);
    expect(() => fitTransform({ width: 400.5, height: 400.25 }, { width: 800.5, height: 600 })).toThrow(/显示空间图像宽/);
  });

  it("非法档位抛错", () => {
    const base = fitTransform({ width: 400, height: 400 }, { width: 800, height: 600 });
    // 类型挡不住外部传入（props / 反序列化），所以运行期必须校验。
    expect(() =>
      withZoom(base, { width: 400, height: 400 }, { width: 800, height: 600 }, 3 as unknown as 2),
    ).toThrow(/缩放档位/);
  });

  it("非法旋转角与非有限坐标抛错", () => {
    expect(() => sourceToOriented({ x: 0, y: 0 }, 4 as unknown as 0, SOURCE)).toThrow(/旋转角度/);
    expect(() => sourceToOriented({ x: Number.NaN, y: 0 }, 0, SOURCE)).toThrow(/源坐标 x/);
    expect(() => screenToOriented({ x: 0, y: Number.POSITIVE_INFINITY }, { scale: 1, offsetX: 0, offsetY: 0 })).toThrow(/屏幕坐标 y/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/crop/__tests__/view.test.ts`
预期：FAIL，`Failed to resolve import "../view"`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// src/core/crop/view.ts
import { rotatedSize } from "../image/rotate";
import type { Rect, Rotation } from "../image/types";

/**
 * 屏幕 ↔ 原图坐标的三层映射，以及视图的适配 / 缩放 / 平移。
 *
 * **为什么整块放在 core**：① happy-dom 的 canvas 是桩、`getBoundingClientRect()` 返回全 0，
 * 视图层的任何行为在 CI 里都测不到；把「算」与「画」分开，算的部分就能被逐条钉死
 * （规格 §10.2）。② 计划 B3 编辑器的缩放平移要复用这套数学——两套实现必然漂移。
 *
 * **旋转的公式只有一处**（`sourceToOriented` / `orientedToSource`，规格 §4.1 的表），
 * 其它所有映射都由它派生：矩形的换轴走「映射两个对角再归一化」，于是不存在第二份换轴规则。
 *
 * 坐标一律用**连续坐标**（不是像素下标）：旋转 1 下源图左上 `(0,0)` 映射到 `(H, 0)`，
 * 边界的右/下边缘落在 `H` / `W` 上，而不是 `H-1` / `W-1`。
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 缩放档位：适配，或适配的整数倍。 */
export type ZoomLevel = "fit" | 2 | 4;

/** `screen = offset + oriented × scale`。 */
export interface ViewTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

// ---------------------------------------------------------------------------
// 入口校验（规格 §12）
//
// 刻意**内联在本文件**，不抽共享校验模块：规格 §13 第 8 条（沿用引擎分支的 L4）已经定过
// 「共享校验模块明确不修，保持内联就地校验这一种风格」。`rect.ts` 里那份守卫是同一口径的
// 第二份，两处的措辞与边界必须一致；出现第三处时再回头讨论抽模块。
// ---------------------------------------------------------------------------

function requireFinite(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what}必须是有限数字（当前 ${String(value)}）`);
  }
  return value;
}

function requirePoint(point: Point, what: string): Point {
  requireFinite(point.x, `${what} x`);
  requireFinite(point.y, `${what} y`);
  return point;
}

/** 视口尺寸是 **CSS 像素**：允许小数（`getBoundingClientRect` 在缩放下就返回小数），只要求有限且 > 0。 */
function requireViewport(viewport: Size): Size {
  const width = requireFinite(viewport.width, "视口宽度");
  const height = requireFinite(viewport.height, "视口高度");
  if (width <= 0) throw new Error(`视口宽度必须大于 0（当前 ${width}）`);
  if (height <= 0) throw new Error(`视口高度必须大于 0（当前 ${height}）`);
  return viewport;
}

/** 图像尺寸必须**整数且 ≥1**（`AGENTS.md`「入口校验」的网格 / 尺寸类口径）。小数宽高会与长度校验互相放过。 */
function requireImageSize(size: Size, what: string): Size {
  if (!Number.isInteger(size.width) || size.width < 1) {
    throw new Error(`${what}宽必须是 ≥1 的整数（当前 ${String(size.width)}）`);
  }
  if (!Number.isInteger(size.height) || size.height < 1) {
    throw new Error(`${what}高必须是 ≥1 的整数（当前 ${String(size.height)}）`);
  }
  return size;
}

function requireRotation(rotation: Rotation): Rotation {
  if (rotation !== 0 && rotation !== 1 && rotation !== 2 && rotation !== 3) {
    throw new Error(`旋转角度非法：${String(rotation)}（必须是 0–3 的整数）`);
  }
  return rotation;
}

function requireZoom(zoom: ZoomLevel): ZoomLevel {
  if (zoom !== "fit" && zoom !== 2 && zoom !== 4) {
    throw new Error(`缩放档位非法：${String(zoom)}（只允许 "fit" / 2 / 4）`);
  }
  return zoom;
}

function requireView(view: ViewTransform): ViewTransform {
  requireFinite(view.offsetX, "视图偏移 x");
  requireFinite(view.offsetY, "视图偏移 y");
  const scale = requireFinite(view.scale, "视图比例");
  if (scale <= 0) throw new Error(`视图比例必须大于 0（当前 ${scale}）`);
  return view;
}

// ---------------------------------------------------------------------------
// 第一层：旋转（源图未旋转坐标 ↔ 显示空间）
// ---------------------------------------------------------------------------

/** 源图坐标 → 显示空间坐标（顺时针 `rotation × 90°`）。 */
export function sourceToOriented(point: Point, rotation: Rotation, source: Size): Point {
  requirePoint(point, "源坐标");
  requireRotation(rotation);
  requireImageSize(source, "源图");
  const { width: w, height: h } = source;
  switch (rotation) {
    case 0:
      return { x: point.x, y: point.y };
    case 1:
      return { x: h - point.y, y: point.x };
    case 2:
      return { x: w - point.x, y: h - point.y };
    default:
      return { x: point.y, y: w - point.x };
  }
}

/** 显示空间坐标 → 源图坐标。四个角度下都是 `sourceToOriented` 的逆。 */
export function orientedToSource(point: Point, rotation: Rotation, source: Size): Point {
  requirePoint(point, "显示空间坐标");
  requireRotation(rotation);
  requireImageSize(source, "源图");
  const { width: w, height: h } = source;
  switch (rotation) {
    case 0:
      return { x: point.x, y: point.y };
    case 1:
      return { x: point.y, y: h - point.x };
    case 2:
      return { x: w - point.x, y: h - point.y };
    default:
      return { x: w - point.y, y: point.x };
  }
}

/**
 * 轴对齐矩形 → 显示空间的轴对齐矩形。
 *
 * 90° 整数倍旋转把轴对齐矩形映成轴对齐矩形，所以只需映射两个对角再归一化——
 * 这样「换轴规则」也只存在于上面那一个函数里。
 */
export function sourceRectToOriented(rect: Rect, rotation: Rotation, source: Size): Rect {
  const a = sourceToOriented({ x: rect.x, y: rect.y }, rotation, source);
  const b = sourceToOriented({ x: rect.x + rect.width, y: rect.y + rect.height }, rotation, source);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

// ---------------------------------------------------------------------------
// 第二层：视图（显示空间 ↔ 屏幕 CSS 像素）
// ---------------------------------------------------------------------------

/** contain 适配：图像完整放进视口并居中。 */
export function fitTransform(viewport: Size, oriented: Size): ViewTransform {
  requireViewport(viewport);
  requireImageSize(oriented, "显示空间图像");
  const scale = Math.min(viewport.width / oriented.width, viewport.height / oriented.height);
  return {
    scale,
    offsetX: (viewport.width - oriented.width * scale) / 2,
    offsetY: (viewport.height - oriented.height * scale) / 2,
  };
}

/**
 * 以 `base` 为基准套用缩放档位，**锚点是视口中心**（换档前后中心处的显示空间坐标不变）。
 *
 * `base` 必须是 `fitTransform` 的结果：调用方每次都从适配态重算，而不是在上一档上连乘——
 * 连乘会把每次夹取造成的偏移误差累积起来，切回 `"fit"` 时回不到原位。
 */
export function withZoom(base: ViewTransform, viewport: Size, oriented: Size, zoom: ZoomLevel): ViewTransform {
  requireViewport(viewport);
  requireImageSize(oriented, "显示空间图像");
  requireZoom(zoom);
  requireView(base);
  const scale = base.scale * (zoom === "fit" ? 1 : zoom);
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const ratio = scale / base.scale;
  return clampView(
    {
      scale,
      offsetX: centerX - (centerX - base.offsetX) * ratio,
      offsetY: centerY - (centerY - base.offsetY) * ratio,
    },
    viewport,
    oriented,
  );
}

/**
 * 夹取平移：图像**始终铺满视口**（不留空白）。
 *
 * 某个方向上图像比视口小（只可能出现在极小图像上）时，该方向**居中锁定**——
 * 否则用户可以把它拖到只剩空白。
 */
export function clampView(view: ViewTransform, viewport: Size, oriented: Size): ViewTransform {
  requireViewport(viewport);
  requireImageSize(oriented, "显示空间图像");
  requireView(view);
  const clampAxis = (offset: number, scaled: number, extent: number): number =>
    scaled <= extent ? (extent - scaled) / 2 : Math.min(0, Math.max(extent - scaled, offset));
  return {
    scale: view.scale,
    offsetX: clampAxis(view.offsetX, oriented.width * view.scale, viewport.width),
    offsetY: clampAxis(view.offsetY, oriented.height * view.scale, viewport.height),
  };
}

export function orientedToScreen(point: Point, view: ViewTransform): Point {
  requirePoint(point, "显示空间坐标");
  requireView(view);
  return { x: view.offsetX + point.x * view.scale, y: view.offsetY + point.y * view.scale };
}

export function screenToOriented(point: Point, view: ViewTransform): Point {
  requirePoint(point, "屏幕坐标");
  requireView(view);
  return { x: (point.x - view.offsetX) / view.scale, y: (point.y - view.offsetY) / view.scale };
}

// ---------------------------------------------------------------------------
// 第三层：组合（屏幕 ↔ 源图）
// ---------------------------------------------------------------------------

/** 屏幕 CSS 像素 → 原图未旋转坐标。手势的入口就是它。 */
export function screenToSource(point: Point, view: ViewTransform, rotation: Rotation, source: Size): Point {
  return orientedToSource(screenToOriented(point, view), rotation, source);
}

/** 原图未旋转坐标下的矩形 → 屏幕矩形（画遮罩与选框用）。 */
export function sourceRectToScreen(rect: Rect, view: ViewTransform, rotation: Rotation, source: Size): Rect {
  const oriented = sourceRectToOriented(rect, rotation, source);
  const corner = orientedToScreen({ x: oriented.x, y: oriented.y }, view);
  return {
    x: corner.x,
    y: corner.y,
    width: oriented.width * view.scale,
    height: oriented.height * view.scale,
  };
}

/** 显示空间的图像尺寸（`rotatedSize` 的转发，避免调用方各写一份换轴规则）。 */
export function orientedSizeOf(source: Size, rotation: Rotation): Size {
  requireImageSize(source, "源图");
  requireRotation(rotation);
  return rotatedSize(source.width, source.height, rotation);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/core/crop/__tests__/view.test.ts`
预期：PASS（约 22 个用例）。

- [ ] **步骤 5：逐条跑变异，报告精确形态**

对下面每一处做一次「改一行 → 跑 → 记录红了几条 → 还原」。每一条都要在报告里写清**改了哪一行、改成什么、原始输出**：

| 变异 | 期望 |
|---|---|
| `sourceToOriented` 的 `case 1` 改成 `return { x: point.y, y: point.x }` | rotation 1 的四角/往返/矩形用例转红 |
| `orientedToSource` 的 `case 3` 改成 `return { x: point.x, y: point.y }` | rotation 3 与「屏幕↔原图」用例转红 |
| `clampView` 的 `Math.min(0, Math.max(...))` 改成 `Math.max(0, Math.min(...))` | 平移夹取两条转红 |
| `withZoom` 的锚点从视口中心改成 `(0, 0)` | 「切回 fit 等于适配态」与 2×/4× 两条转红 |
| `fitTransform` 的 `Math.min` 改成 `Math.max` | 适配与依赖它的组合用例大面积转红 |
| `requireViewport` 改成也要求整数 | 「视口尺寸允许小数」转红 |

- [ ] **步骤 6：Commit**

```bash
git add src/core/crop/view.ts src/core/crop/__tests__/view.test.ts
git commit -m "feat(core): 选区视图变换与含旋转的坐标映射"
```

---

## 任务 4：选区几何（`core/crop/rect.ts`）

**文件：**
- 创建：`src/core/crop/rect.ts`
- 测试：`src/core/crop/__tests__/rect.test.ts`
- 依赖：`Size` / `Point` 两个类型**从 `./view` 引入**，不要在本文件重定义（重定义会让两处类型各自演化）。

- [ ] **步骤 1：编写失败的测试**

```ts
// src/core/crop/__tests__/rect.test.ts
import { describe, expect, it } from "vitest";
import {
  MIN_CROP_SIDE,
  applyAspect,
  centerSquare,
  clampRectToSource,
  isCropResolvable,
  moveRect,
  resizeByHandle,
} from "../rect";

const SOURCE = { width: 800, height: 600 };

describe("centerSquare：初始选区与 B1 的临时入口行为等价", () => {
  it("横图：居中正方，边长取短边", () => {
    expect(centerSquare({ width: 800, height: 600 })).toEqual({ x: 100, y: 0, width: 600, height: 600 });
  });

  it("竖图：换到另一根轴上（不是把 x/y 写死）", () => {
    expect(centerSquare({ width: 600, height: 800 })).toEqual({ x: 0, y: 100, width: 600, height: 600 });
  });

  it("奇偶不齐时与 B1 的 Math.round 口径一致", () => {
    expect(centerSquare({ width: 801, height: 600 })).toEqual({ x: 101, y: 0, width: 600, height: 600 });
  });
});

describe("clampRectToSource", () => {
  it("负原点被推回 0", () => {
    expect(clampRectToSource({ x: -50, y: -50, width: 200, height: 100 }, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
  });

  it("右边与下边越界时整体推回", () => {
    expect(clampRectToSource({ x: 700, y: 550, width: 200, height: 100 }, SOURCE)).toEqual({
      x: 600,
      y: 500,
      width: 200,
      height: 100,
    });
  });

  it("比源图还大时缩到整张图", () => {
    expect(clampRectToSource({ x: 0, y: 0, width: 900, height: 700 }, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("小于最小边长时抬到最小值", () => {
    expect(clampRectToSource({ x: 0, y: 0, width: 1, height: 1 }, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: MIN_CROP_SIDE,
      height: MIN_CROP_SIDE,
    });
  });

  it("源图本身比最小边长还小时取整张图（不产出比源图还大的选区）", () => {
    expect(clampRectToSource({ x: 5, y: 5, width: 1, height: 1 }, { width: 1, height: 1 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});

describe("moveRect", () => {
  it("平移后仍被夹在源图内", () => {
    expect(moveRect({ x: 100, y: 100, width: 200, height: 100 }, -150, 0, SOURCE)).toEqual({
      x: 0,
      y: 100,
      width: 200,
      height: 100,
    });
  });

  it("平移不改变尺寸", () => {
    const moved = moveRect({ x: 100, y: 100, width: 200, height: 100 }, 30, 40, SOURCE);
    expect(moved.width).toBe(200);
    expect(moved.height).toBe(100);
    expect(moved.x).toBe(130);
    expect(moved.y).toBe(140);
  });
});

describe("applyAspect", () => {
  it("自由比例只做夹取", () => {
    expect(applyAspect({ x: -10, y: -10, width: 100, height: 100 }, "free", 0, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it("1:1 取内接正方形（只缩不放），锚在中心", () => {
    expect(applyAspect({ x: 0, y: 0, width: 400, height: 100 }, "1:1", 0, SOURCE)).toEqual({
      x: 150,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it("4:3 在 rotation 0 下约束源图同为 4:3", () => {
    expect(applyAspect({ x: 0, y: 0, width: 400, height: 400 }, "4:3", 0, SOURCE)).toEqual({
      x: 0,
      y: 50,
      width: 400,
      height: 300,
    });
  });

  // 这两条是本任务最重要的判别力：旋转 1 下显示空间的比例要**换轴**到源图（3:4），
  // 不换轴的实现会给出 {66.67, 0, 266.67, 200} —— 两者数值明显不同。
  it("4:3 在 rotation 1 下约束的是源图的 3:4（换轴）", () => {
    expect(applyAspect({ x: 0, y: 0, width: 400, height: 200 }, "4:3", 1, SOURCE)).toEqual({
      x: 125,
      y: 0,
      width: 150,
      height: 200,
    });
  });

  it("同一个输入在 rotation 0 下给出另一种形状（证明上面那条在测换轴，而不是恒等）", () => {
    const atZero = applyAspect({ x: 0, y: 0, width: 400, height: 200 }, "4:3", 0, SOURCE);
    expect(atZero.width).toBeCloseTo(266.6667, 3);
    expect(atZero.height).toBe(200);
  });

  it("9:16 是竖版比例", () => {
    const locked = applyAspect({ x: 0, y: 0, width: 400, height: 400 }, "9:16", 0, SOURCE);
    expect(locked.width / locked.height).toBeCloseTo(9 / 16, 10);
    expect(locked.width).toBeCloseTo(225, 10);
    expect(locked.height).toBe(400);
  });

  // 如实记录的取舍：贴边 / 极小源图上，最小边长与「不越界」优先于比例锁。
  it("源图小到装不下比例时，最小边长优先（比例允许失真）", () => {
    const locked = applyAspect({ x: 0, y: 0, width: 3, height: 3 }, "9:16", 0, { width: 3, height: 3 });
    expect(locked.width).toBe(MIN_CROP_SIDE);
    expect(locked.height).toBe(3);
  });
});

describe("resizeByHandle", () => {
  const BASE = { x: 100, y: 100, width: 200, height: 200 };

  it("拖右下角：左上角固定", () => {
    expect(resizeByHandle(BASE, "se", { x: 400, y: 350 }, "free", 0, SOURCE)).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 250,
    });
  });

  it("拖左上角：右下角固定", () => {
    const result = resizeByHandle(BASE, "nw", { x: 50, y: 50 }, "free", 0, SOURCE);
    expect(result).toEqual({ x: 50, y: 50, width: 250, height: 250 });
    // 对角锚点必须逐位不动——这是「对角固定」的定义，也是把锚点写反时唯一会红的断言。
    expect(result.x + result.width).toBe(BASE.x + BASE.width);
    expect(result.y + result.height).toBe(BASE.y + BASE.height);
  });

  it("拖过源图边界时停在边上，锚点仍然不动", () => {
    const result = resizeByHandle(BASE, "nw", { x: -50, y: -50 }, "free", 0, SOURCE);
    expect(result).toEqual({ x: 0, y: 0, width: 300, height: 300 });
    expect(result.x + result.width).toBe(BASE.x + BASE.width);
  });

  it("指针远在源图之外时最多长到整张图", () => {
    expect(resizeByHandle({ x: 0, y: 0, width: 100, height: 100 }, "se", { x: 9999, y: 9999 }, "free", 0, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("拖到几乎零尺寸时抬到最小边长", () => {
    expect(resizeByHandle(BASE, "se", { x: 101, y: 101 }, "free", 0, SOURCE)).toEqual({
      x: 100,
      y: 100,
      width: MIN_CROP_SIDE,
      height: MIN_CROP_SIDE,
    });
  });

  it("锁 1:1 时拖出的矩形是正方形（锚点不动）", () => {
    expect(resizeByHandle({ x: 0, y: 0, width: 100, height: 100 }, "se", { x: 300, y: 150 }, "1:1", 0, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 150,
    });
  });

  // 同一条拖动在 rotation 1 与 0 下必须给出**换轴**的两个结果。
  it("锁 4:3 时在 rotation 1 下换轴（与 rotation 0 的结果宽高互换）", () => {
    expect(resizeByHandle({ x: 0, y: 0, width: 200, height: 100 }, "se", { x: 400, y: 400 }, "4:3", 1, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 400,
    });
    expect(resizeByHandle({ x: 0, y: 0, width: 200, height: 100 }, "se", { x: 400, y: 400 }, "4:3", 0, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
  });
});

describe("isCropResolvable", () => {
  it("rotation 0 的边界：恰好等于通过，少 1 像素拦下", () => {
    expect(isCropResolvable({ x: 0, y: 0, width: 58, height: 58 }, { width: 58, height: 58 }, 0)).toBe(true);
    expect(isCropResolvable({ x: 0, y: 0, width: 57, height: 58 }, { width: 58, height: 58 }, 0)).toBe(false);
  });

  // crop 在源坐标、grid 在**旋转后**坐标：rotation 1 下这两个方向要换着比。
  // 忽略 rotation 的实现会把下面第一条判成 false（100 >= 40 通过、40 >= 100 不通过）。
  it("rotation 1 下 crop 与 grid 换轴比较：源坐标恰好通过的那组必须判为可解析", () => {
    expect(isCropResolvable({ x: 0, y: 0, width: 100, height: 40 }, { width: 40, height: 100 }, 1)).toBe(true);
  });

  it("rotation 1 下少 1 像素就不可解析", () => {
    expect(isCropResolvable({ x: 0, y: 0, width: 99, height: 40 }, { width: 40, height: 100 }, 1)).toBe(false);
  });

  it("rotation 3 与 rotation 1 同口径", () => {
    expect(isCropResolvable({ x: 0, y: 0, width: 100, height: 40 }, { width: 40, height: 100 }, 3)).toBe(true);
  });
});

describe("入口校验（规格 §12）", () => {
  it("矩形的非有限分量与 < 1 的宽高抛错", () => {
    expect(() => clampRectToSource({ x: Number.NaN, y: 0, width: 10, height: 10 }, SOURCE)).toThrow(/选区/);
    expect(() => clampRectToSource({ x: 0, y: 0, width: 0, height: 10 }, SOURCE)).toThrow(/选区/);
  });

  it("源图尺寸必须是整数且 ≥1", () => {
    expect(() => clampRectToSource({ x: 0, y: 0, width: 10, height: 10 }, { width: 0.5, height: 10 })).toThrow(/源图/);
  });

  it("非法手柄 / 比例 / 旋转抛错", () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(() => resizeByHandle(rect, "center" as unknown as "se", { x: 1, y: 1 }, "free", 0, SOURCE)).toThrow(/手柄/);
    expect(() => applyAspect(rect, "16:9" as unknown as "4:3", 0, SOURCE)).toThrow(/比例/);
    expect(() => isCropResolvable(rect, { width: 10, height: 10 }, 5 as unknown as 0)).toThrow(/旋转角度/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/crop/__tests__/rect.test.ts`
预期：FAIL，`Failed to resolve import "../rect"`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// src/core/crop/rect.ts
import { rotatedSize } from "../image/rotate";
import type { Rect, Rotation } from "../image/types";
import type { Point, Size } from "./view";

/**
 * 选区几何：全部作用在**原图未旋转坐标**上（`crop` 的唯一存在形式，规格 §4.1）。
 *
 * 显示空间的形状与源坐标的形状在 `rotation` 为 1 / 3 时**换轴**——比例锁与可解析性判定
 * 都必须走 `rotatedSize`，不能直接比源坐标的两个数（R25 记的正是这一类错误）。
 *
 * 这里**不做**坐标映射（那是 `view.ts` 的职责），也不碰解码与重采样（那是 `services/`）。
 */

/** 选区的交互最小边长（源图像素）。它不是质量门槛，只保证选区还抓得住手柄。 */
export const MIN_CROP_SIDE = 2;

/** 比例锁。比例定义在**显示空间**（用户看到的形状）。 */
export type AspectLock = "free" | "1:1" | "4:3" | "9:16";

/** 四个角手柄。 */
export type CropHandle = "nw" | "ne" | "sw" | "se";

const ASPECT_RATIOS: Readonly<Record<Exclude<AspectLock, "free">, number>> = {
  "1:1": 1,
  "4:3": 4 / 3,
  "9:16": 9 / 16,
};

// 入口校验：与 `view.ts` 同一口径（规格 §12）。刻意内联不抽模块——规格 §13 第 8 条。
function requireFinite(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what}必须是有限数字（当前 ${String(value)}）`);
  }
  return value;
}

function requirePoint(point: Point, what: string): Point {
  requireFinite(point.x, `${what} x`);
  requireFinite(point.y, `${what} y`);
  return point;
}

function requireSize(size: Size, what: string): Size {
  if (!Number.isInteger(size.width) || size.width < 1) {
    throw new Error(`${what}宽必须是 ≥1 的整数（当前 ${String(size.width)}）`);
  }
  if (!Number.isInteger(size.height) || size.height < 1) {
    throw new Error(`${what}高必须是 ≥1 的整数（当前 ${String(size.height)}）`);
  }
  return size;
}

function requireRect(rect: Rect, what: string): Rect {
  requireFinite(rect.x, `${what} x`);
  requireFinite(rect.y, `${what} y`);
  requireFinite(rect.width, `${what}宽度`);
  requireFinite(rect.height, `${what}高度`);
  if (rect.width < 1) throw new Error(`${what}宽度必须 ≥1（当前 ${rect.width}）`);
  if (rect.height < 1) throw new Error(`${what}高度必须 ≥1（当前 ${rect.height}）`);
  return rect;
}

function requireRotation(rotation: Rotation): Rotation {
  if (rotation !== 0 && rotation !== 1 && rotation !== 2 && rotation !== 3) {
    throw new Error(`旋转角度非法：${String(rotation)}（必须是 0–3 的整数）`);
  }
  return rotation;
}

function requireAspect(aspect: AspectLock): AspectLock {
  if (aspect !== "free" && aspect !== "1:1" && aspect !== "4:3" && aspect !== "9:16") {
    throw new Error(`比例锁非法：${String(aspect)}`);
  }
  return aspect;
}

function requireHandle(handle: CropHandle): CropHandle {
  if (handle !== "nw" && handle !== "ne" && handle !== "sw" && handle !== "se") {
    throw new Error(`手柄名非法：${String(handle)}`);
  }
  return handle;
}

/**
 * 初始选区：居中正方、边长取短边。
 *
 * 与 B1 临时入口的行为**逐位等价**（`Math.round((长 − 短) / 2)` 的居中口径），
 * 这样「换掉临时入口」不会顺带改变用户看到的初始选区。
 */
export function centerSquare(source: Size): Rect {
  requireSize(source, "源图");
  const side = Math.min(source.width, source.height);
  return {
    x: Math.round((source.width - side) / 2),
    y: Math.round((source.height - side) / 2),
    width: side,
    height: side,
  };
}

/**
 * 把选区夹进源图：**先定尺寸、再定位置**。
 *
 * 尺寸被夹到 `[MIN_CROP_SIDE, 源图对应边]`（源图本身比最小边长还小时取源图边长），
 * 位置被夹到 `[0, 源图对应边 − 尺寸]`。顺序不能反：先定位再定尺寸会算出负的可用空间。
 */
export function clampRectToSource(rect: Rect, source: Size): Rect {
  requireRect(rect, "选区");
  requireSize(source, "源图");
  const width = Math.min(Math.max(rect.width, MIN_CROP_SIDE), source.width);
  const height = Math.min(Math.max(rect.height, MIN_CROP_SIDE), source.height);
  return {
    x: Math.min(Math.max(rect.x, 0), source.width - width),
    y: Math.min(Math.max(rect.y, 0), source.height - height),
    width,
    height,
  };
}

/** 平移选区（`dx` / `dy` 是源图像素增量），越界被夹取。 */
export function moveRect(rect: Rect, dx: number, dy: number, source: Size): Rect {
  requireFinite(dx, "水平位移");
  requireFinite(dy, "垂直位移");
  return clampRectToSource({ ...rect, x: rect.x + dx, y: rect.y + dy }, source);
}

/**
 * 套用比例锁：以**当前选区中心为锚**，取「能放进当前选区的、符合目标比例的最大矩形」（只缩不放）。
 *
 * 比例定义在显示空间，所以先在 `rotation` 下算出朝向后的尺寸、按比例收缩、再换回源坐标
 * （`rotatedSize` 对 1 / 3 是自逆，所以同一个函数正好做两次换算）。
 *
 * **取舍**：输入先被夹取一次（否则末尾的夹取会破坏比例）；而在贴边或极小源图上，
 * 最小边长与「不越界」优先于比例锁——宁可比例略有偏差，也不产出越界的 `crop`。
 */
export function applyAspect(rect: Rect, aspect: AspectLock, rotation: Rotation, source: Size): Rect {
  requireAspect(aspect);
  requireRotation(rotation);
  const base = clampRectToSource(rect, source);
  if (aspect === "free") return base;
  const ratio = ASPECT_RATIOS[aspect];
  const oriented = rotatedSize(base.width, base.height, rotation);
  const width = oriented.width / oriented.height > ratio ? oriented.height * ratio : oriented.width;
  const height = oriented.width / oriented.height > ratio ? oriented.height : oriented.width / ratio;
  const back = rotatedSize(width, height, rotation);
  const centerX = base.x + base.width / 2;
  const centerY = base.y + base.height / 2;
  return clampRectToSource(
    { x: centerX - back.width / 2, y: centerY - back.height / 2, width: back.width, height: back.height },
    source,
  );
}

/**
 * 按角手柄缩放：**对角固定**。
 *
 * 顺序：先把指针夹进源图（越界的拖动应该是「停在边上」而不是「长出去再被夹回」）→
 * 从锚点算原始宽高 → 有比例锁时按显示空间比例内接收缩 → 从锚点朝指针一侧展开 → 夹取。
 */
export function resizeByHandle(
  rect: Rect,
  handle: CropHandle,
  pointer: Point,
  aspect: AspectLock,
  rotation: Rotation,
  source: Size,
): Rect {
  requireHandle(handle);
  requirePoint(pointer, "指针");
  requireAspect(aspect);
  requireRotation(rotation);
  const base = clampRectToSource(rect, source);
  const p = {
    x: Math.min(Math.max(pointer.x, 0), source.width),
    y: Math.min(Math.max(pointer.y, 0), source.height),
  };
  const anchor: Point = {
    nw: { x: base.x + base.width, y: base.y + base.height },
    ne: { x: base.x, y: base.y + base.height },
    sw: { x: base.x + base.width, y: base.y },
    se: { x: base.x, y: base.y },
  }[handle];

  let width = Math.abs(p.x - anchor.x);
  let height = Math.abs(p.y - anchor.y);
  if (aspect !== "free") {
    const ratio = ASPECT_RATIOS[aspect];
    // 先抬到最小边长再算比例：否则「按下没动」会得到 0 / 0 = NaN 的朝向尺寸。
    const oriented = rotatedSize(Math.max(width, MIN_CROP_SIDE), Math.max(height, MIN_CROP_SIDE), rotation);
    const tooWide = oriented.width / oriented.height > ratio;
    const scaled = rotatedSize(
      tooWide ? oriented.height * ratio : oriented.width,
      tooWide ? oriented.height : oriented.width / ratio,
      rotation,
    );
    width = scaled.width;
    height = scaled.height;
  }

  return clampRectToSource(
    {
      x: p.x < anchor.x ? anchor.x - width : anchor.x,
      y: p.y < anchor.y ? anchor.y - height : anchor.y,
      width,
      height,
    },
    source,
  );
}

/**
 * 选区是否「每格至少一个源像素」（主规格 §8「选区过小（不足 1 颗豆）」的落地口径）。
 *
 * `grid` 是**显示空间**的豆数（`computeGridSize` 的入参朝向），而 `crop` 在源坐标——
 * 1 / 3 下两者换轴，所以必须先把 `crop` 换算过去再比。忽略 `rotation` 的实现会在那两个角度上
 * **把结论判反**。
 */
export function isCropResolvable(crop: Rect, grid: Size, rotation: Rotation): boolean {
  requireRect(crop, "选区");
  requireSize(grid, "网格");
  requireRotation(rotation);
  const oriented = rotatedSize(crop.width, crop.height, rotation);
  return oriented.width >= grid.width && oriented.height >= grid.height;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/core/crop/__tests__/rect.test.ts`
预期：PASS（约 27 个用例）。

- [ ] **步骤 5：逐条跑变异，报告精确形态**

| 变异 | 期望 |
|---|---|
| `clampRectToSource` 里尺寸与位置的夹取顺序对调 | 越界/超大两条转红 |
| `applyAspect` 去掉 `rotatedSize`（直接比源坐标） | rotation 1 的换轴两条转红 |
| `resizeByHandle` 的 `anchor` 表里 `nw` 与 `se` 互换 | 四角用例中的两条转红 |
| `resizeByHandle` 的 `p.x < anchor.x` 写成 `>` | 拖左上/右上两条转红 |
| `isCropResolvable` 改成直接比源坐标 | rotation 1 / 3 的两条转红 |
| `centerSquare` 的 `Math.round` 改成 `Math.floor` | 奇偶不齐那条转红 |

- [ ] **步骤 6：Commit**

```bash
git add src/core/crop/rect.ts src/core/crop/__tests__/rect.test.ts
git commit -m "feat(core): 选区几何——比例锁、手柄缩放与可解析性判定"
```

---

## 任务 5：预览解码入口（`services/imageSource.ts`）

**文件：**
- 修改：`src/services/imageSource.ts`
- 测试：`src/services/__tests__/imageSourcePreview.test.ts`（新建；既有 `imageSource.test.ts` **不动**）

- [ ] **步骤 1：编写失败的测试**

```ts
// src/services/__tests__/imageSourcePreview.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_MAX_EDGE, loadImageSource } from "@/services/imageSource";

/**
 * 预览解码的成功路径在 happy-dom 里**不可能达成**（`fetch` 拒绝 `blob:`，`<img>` 永不 load、
 * `naturalWidth` 恒 0，见 B1 构建记录 §4 第 4 条），所以这里只替换**平台边界**
 * （`Image` / `URL` / `document.createElement`），断言落在外部可观察量上：
 * 原图尺寸的读数、预览画布的尺寸、交给 `drawImage` 的参数。
 * 真实解码由浏览器人工流程覆盖（规格 §10.2）。
 */

interface FakeCanvas {
  width: number;
  height: number;
  readonly ctx: { drawImage: ReturnType<typeof vi.fn>; imageSmoothingEnabled: boolean; imageSmoothingQuality: string };
}

function stubCanvas(contextAvailable = true): FakeCanvas[] {
  const canvases: FakeCanvas[] = [];
  class FakeCanvasImpl implements FakeCanvas {
    width = 0;
    height = 0;
    readonly ctx = {
      drawImage: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
    };
    getContext(kind: string): FakeCanvas["ctx"] | null {
      return kind === "2d" && contextAvailable ? this.ctx : null;
    }
  }
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      expect(tag).toBe("canvas");
      const canvas = new FakeCanvasImpl();
      canvases.push(canvas);
      return canvas;
    },
  });
  return canvases;
}

function stubImage(naturalWidth: number, naturalHeight: number, decodeError?: string): void {
  class FakeImage {
    readonly naturalWidth = naturalWidth;
    readonly naturalHeight = naturalHeight;
    src = "";
    readonly decode = vi.fn(async () => {
      if (decodeError !== undefined) throw new Error(decodeError);
    });
  }
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  });
}

const FILE = new File([new Uint8Array([1, 2, 3, 4])], "小猫照片.png", { type: "image/png" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadImageSource", () => {
  it("4000×3000 的原图缩到长边 1600，并交出原图尺寸与来源信息", async () => {
    stubImage(4000, 3000);
    const canvases = stubCanvas();

    const loaded = await loadImageSource(FILE);

    expect(loaded.sourceSize).toEqual({ width: 4000, height: 3000 });
    expect(loaded.blob).toBe(FILE);
    expect(loaded.type).toBe("image/png");
    expect(loaded.name).toBe("小猫照片.png");
    expect(canvases).toHaveLength(1);
    expect(canvases[0]?.width).toBe(1600);
    expect(canvases[0]?.height).toBe(1200);
    // 参数顺序写全：把 (0,0) 或目标尺寸写错都会红。
    expect(canvases[0]?.ctx.drawImage.mock.calls[0]?.slice(1)).toEqual([0, 0, 1600, 1200]);
    expect(canvases[0]?.ctx.imageSmoothingQuality).toBe("high");
    expect(loaded.preview).toBe(canvases[0]);
  });

  // 这条专打「无条件按 PREVIEW_MAX_EDGE 缩放」的实现：800×600 被"放大"到 1600×1200
  // 会白烧内存，还引入一次没有任何信息的重采样。
  it("原图长边小于上限时只缩不放", async () => {
    stubImage(800, 600);
    const canvases = stubCanvas();

    const loaded = await loadImageSource(FILE);

    expect(canvases[0]?.width).toBe(800);
    expect(canvases[0]?.height).toBe(600);
    expect(canvases[0]?.ctx.drawImage.mock.calls[0]?.slice(1)).toEqual([0, 0, 800, 600]);
    expect(loaded.sourceSize).toEqual({ width: 800, height: 600 });
  });

  it("长边恰好等于上限时不缩放", async () => {
    stubImage(PREVIEW_MAX_EDGE, 800);
    const canvases = stubCanvas();

    await loadImageSource(FILE);

    expect(canvases[0]?.width).toBe(PREVIEW_MAX_EDGE);
    expect(canvases[0]?.height).toBe(800);
  });

  it("长边超过上限 1 像素时缩到上限", async () => {
    stubImage(PREVIEW_MAX_EDGE + 1, 800);
    const canvases = stubCanvas();

    await loadImageSource(FILE);

    expect(canvases[0]?.width).toBe(PREVIEW_MAX_EDGE);
    expect(canvases[0]?.height).toBe(800);
  });

  it("解码失败时抛出带中文前缀的原因，不静默返回空预览", async () => {
    stubImage(0, 0, "unsupported");
    stubCanvas();

    await expect(loadImageSource(FILE)).rejects.toThrow(/图片解码失败（unsupported）/);
  });

  it("解码成功但尺寸为 0（happy-dom 的典型症状）时明确报错", async () => {
    stubImage(0, 0);
    stubCanvas();

    await expect(loadImageSource(FILE)).rejects.toThrow(/图片尺寸为 0/);
  });

  it("拿不到 2D 上下文时抛错（没有预览就没法选选区）", async () => {
    stubImage(800, 600);
    stubCanvas(false);

    await expect(loadImageSource(FILE)).rejects.toThrow(/2D 绘图上下文/);
  });

  it("空文件直接拒绝（与 fileFromInput 同口径，不等到解码）", async () => {
    stubImage(800, 600);
    stubCanvas();

    await expect(loadImageSource(new File([], "empty.png", { type: "image/png" }))).rejects.toThrow(
      /这个文件是空的/,
    );
  });

  it("用完即释放 object URL（否则每选一张图就泄一个 blob URL）", async () => {
    stubImage(800, 600);
    stubCanvas();
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: revoke });

    await loadImageSource(FILE);

    expect(revoke).toHaveBeenCalledWith("blob:fake");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/services/__tests__/imageSourcePreview.test.ts`
预期：FAIL，`loadImageSource is not a function`。

- [ ] **步骤 3：编写最少实现代码**

在 `src/services/imageSource.ts` 里追加（`fileFromInput` 与 `probeSourceSize` 保持不动）：

```ts
/** 预览位图的长边上限（像素）。主规格 §5① 规定的预览解码口径，`AGENTS.md` 的关键常量。 */
export const PREVIEW_MAX_EDGE = 1600;

export interface LoadedImageSource {
  readonly blob: Blob;
  readonly type: string;
  readonly name: string;
  /** 原图像素尺寸（未经任何缩放），用于把屏幕坐标换算回原图坐标。 */
  readonly sourceSize: { readonly width: number; readonly height: number };
  /**
   * 长边 ≤ `PREVIEW_MAX_EDGE` 的预览位图（**只缩不放**）。
   *
   * 选区页此后每帧只画这张小画布，**不直接画 `<img>`**：直接画意味着拖动时浏览器每帧都要
   * 重采样 4000×3000 的原图，那是拖拽掉帧的直接原因。
   */
  readonly preview: HTMLCanvasElement;
}

/**
 * 一次 `<img>` 解码，同时拿到**原图尺寸**与**预览位图**。
 *
 * 走 `<img>` 而不是 `createImageBitmap` 的理由与 `probe.ts` 相同：解码帧由元素持有、
 * 不落 JS 堆，且这条路要的恰好就是「尺寸 + 一张能画的位图」。全程没有把原图像素读进 JS 堆
 * ——生成阶段的解码在 `services/decoders.ts`，它只裁选区（主规格 §5①）。
 *
 * 失败一律抛中文原因：选不出选区时用户必须知道为什么，而不是面对一块空白。
 */
export async function loadImageSource(file: File): Promise<LoadedImageSource> {
  if (typeof file?.size !== "number") throw new Error("需要一个图片文件");
  if (file.size === 0) throw new Error("这个文件是空的，请换一张图片");

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    // 老 WebView 上 `img.decode` 可能根本不存在，格式不支持或文件损坏则是 EncodingError。
    // 与 `probe.ts` 同一处置：包一层中文前缀，不让页面只剩一句英文。
    try {
      await img.decode();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`图片解码失败（${detail === "" ? "无错误详情" : detail}）`);
    }
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (width === 0 || height === 0) {
      throw new Error("图片尺寸为 0，可能是不支持的格式或文件已损坏");
    }

    const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(width, height));
    const previewWidth = Math.max(1, Math.round(width * scale));
    const previewHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = previewWidth;
    canvas.height = previewHeight;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("无法获取 2D 绘图上下文，无法准备预览图");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, previewWidth, previewHeight);

    return { blob: file, type: file.type, name: file.name, sourceSize: { width, height }, preview: canvas };
  } finally {
    URL.revokeObjectURL(url);
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/services/__tests__/imageSourcePreview.test.ts src/services/__tests__/imageSource.test.ts`
预期：两个文件全 PASS（既有 `imageSource.test.ts` 一条不动）。

- [ ] **步骤 5：逐条跑变异，报告精确形态**

| 变异 | 期望 |
|---|---|
| `Math.min(1, PREVIEW_MAX_EDGE / 长边)` 去掉 `Math.min(1, …)` | 「只缩不放」与两条边界用例转红 |
| `Math.round` 改成 `Math.floor` | 1601 那条转红 |
| `finally` 里的 `revokeObjectURL` 删掉 | 「用完即释放」转红 |
| `drawImage(img, 0, 0, w, h)` 改成 `drawImage(img, 0, 0)` | 尺寸断言转红（画布尺寸与绘制尺寸脱钩） |

- [ ] **步骤 6：Commit**

```bash
git add src/services/imageSource.ts src/services/__tests__/imageSourcePreview.test.ts
git commit -m "feat(services): 一次解码同时产出原图尺寸与预览位图"
```

---

## 任务 6：`generatePattern` 新增 `sourceSize`，越界一律拒绝

**这是 B1-12 / B1-13 的裁决落地，也是全计划里唯一会动既有测试文件的任务——先读完再动手。**

**文件：**
- 修改：`src/services/pipeline.ts`
- 修改：`src/services/__tests__/pipeline.test.ts`（**只加 `sourceSize` 字段与新的 describe，既有断言一条不动、不放宽**）

- [ ] **步骤 1：先看清既有测试的形态（不许跳过）**

运行：`grep -n "generatePattern(" -A 8 src/services/__tests__/pipeline.test.ts`

要点（控制者已核对过，实现者必须自己再看一遍）：

- 文件里所有请求都是内联字面量 `{ source, crop, rotation, longSide, maxColors }`，约 15 处，**都要补 `sourceSize`**。
- 现有裁剪框最大是 `4096 × 1024`，还有 `x: 3, y: 5` 的原点，所以取一个足够大的源图尺寸（**`8192 × 8192`**）能覆盖全部既有用例。
- **有一条硬约束**：既有 3 条用例（`width: 0` / `Infinity` / `NaN`）断言的是 `/裁剪区域尺寸非法/`，那条消息来自 `computeGridSize` / `chooseDecoderPath`。**新的越界校验必须放在它们之后、取解码器之前**——放在最上面会把错误消息换掉，等于改坏了既有测试。

- [ ] **步骤 2：编写失败的测试**

在 `src/services/__tests__/pipeline.test.ts` 末尾追加（沿用文件里既有的 `makeStub` / `forbidden` / `palette` / `source` 助手，不新造一套）：

```ts
describe("generatePattern 的原图范围校验（B1-12 / B1-13：拒绝，不夹取）", () => {
  const SOURCE_SIZE = { width: 800, height: 600 };

  it("左/上越界时抛错，解码器一次都不被调用", async () => {
    for (const badCrop of [
      { x: -1, y: 0, width: 100, height: 100 },
      { x: 0, y: -1, width: 100, height: 100 },
    ]) {
      const exact = makeStub("exact", "native");
      await expect(
        generatePattern(
          { source, sourceSize: SOURCE_SIZE, crop: badCrop, rotation: 0, longSide: 4, maxColors: 16 },
          { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
        ),
      ).rejects.toThrow(/超出原图范围/);
      expect(exact.requests).toHaveLength(0);
    }
  });

  it("右/下越界时抛错（x + width 恰好超出 1 像素也要拦）", async () => {
    for (const badCrop of [
      { x: 701, y: 0, width: 100, height: 100 },
      { x: 0, y: 501, width: 100, height: 100 },
    ]) {
      const exact = makeStub("exact", "native");
      await expect(
        generatePattern(
          { source, sourceSize: SOURCE_SIZE, crop: badCrop, rotation: 0, longSide: 4, maxColors: 16 },
          { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
        ),
      ).rejects.toThrow(/超出原图范围/);
      expect(exact.requests).toHaveLength(0);
    }
  });

  // 这条是上一条的对照：不写它的话，「凡是 crop 都拒绝」也能让上面全绿。
  it("恰好贴边不算越界（x + width == 源图宽、y + height == 源图高）", async () => {
    const exact = makeStub("exact", "native");
    const pattern = await generatePattern(
      {
        source,
        sourceSize: SOURCE_SIZE,
        crop: { x: 600, y: 500, width: 200, height: 100 },
        rotation: 0,
        longSide: 4,
        maxColors: 16,
      },
      { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
    );
    // 200×100 的裁剪、长边 4 → 网格 4×2
    expect(pattern.width).toBe(4);
    expect(pattern.height).toBe(2);
  });

  // NaN 的越界判定是「比较全为假」——四条不等式一条都拦不住它，所以必须单独查有限性。
  it("裁剪框原点非有限时抛错（四条不等式拦不住 NaN）", async () => {
    const exact = makeStub("exact", "native");
    await expect(
      generatePattern(
        {
          source,
          sourceSize: SOURCE_SIZE,
          crop: { x: Number.NaN, y: 0, width: 100, height: 100 },
          rotation: 0,
          longSide: 4,
          maxColors: 16,
        },
        { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
      ),
    ).rejects.toThrow(/原点必须是有限数字/);
  });

  it("源图尺寸非整数或 < 1 时抛错", async () => {
    const exact = makeStub("exact", "native");
    for (const badSize of [{ width: 1.5, height: 600 }, { width: 0, height: 600 }]) {
      await expect(
        generatePattern(
          {
            source,
            sourceSize: badSize,
            crop: { x: 0, y: 0, width: 100, height: 100 },
            rotation: 0,
            longSide: 4,
            maxColors: 16,
          },
          { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
        ),
      ).rejects.toThrow(/原图宽度/);
    }
  });
});
```

- [ ] **步骤 3：给既有 15 处调用点补字段**

在文件顶部（`const crop = …` 附近）加：

```ts
/** 既有用例的裁剪框最大到 4096×1024，原点最大到 (3, 5)——取一个足够大的源图覆盖它们。 */
const sourceSize = { width: 8192, height: 8192 };
```

然后给每个 `generatePattern({ … })` 的请求字面量补上 `sourceSize,`（对象字面量的任意位置都可以，建议紧跟 `source`）。**只加字段，不改任何断言。**

**还有一处必须同步，否则任务 6 一落地 `npm run build` 就红**：`src/views/GeneratePage.vue` 也调用 `generatePattern`，
而它要到任务 14 才删。给它补上 `sourceSize: size`（该页已经 `await probeSourceSize(picked.file)` 拿到了尺寸，
就在同一个 `run()` 里）。**这是临时的兼容改动，文件删除时一并消失**——不这么做，任务 6 到任务 13 之间
`vue-tsc` 一直报「缺少属性 sourceSize」，等于把 CI 的红灯藏起来八个任务。

- [ ] **步骤 3b：确认构建仍然通过**

运行：`npm run build`
预期：exit 0（含 `vue-tsc --noEmit`）。

- [ ] **步骤 4：运行测试验证失败**

运行：`npm run test -- src/services/__tests__/pipeline.test.ts`
预期：新增的 5 条 FAIL（`sourceSize` 还没有被校验，越界裁剪会被静默接受），既有用例 PASS（`sourceSize` 是多余字段，TS 会先报「对象字面量只能指定已知属性」——所以这一步的失败形态取决于是否已改类型：**先改类型再跑**，见步骤 5 的第 1 段）。

- [ ] **步骤 5：编写最少实现代码**

`src/services/pipeline.ts` 的 `GenerateRequest` 加字段：

```ts
export interface GenerateRequest {
  readonly source: Blob;
  /**
   * 原图像素尺寸。**必填**：用来拒绝越界的 `crop`（B1-12 / B1-13 的裁决）。
   *
   * 拒绝而不是夹取，理由是两条路都会静默产出错误结果：B1 构建记录 §5 的真实 Chromium 实测
   * 证明越界源矩形**不抛错**、只是把越界区域填透明（产物是一张「带透明边、看起来正常」的图纸）；
   * 而静默夹取会产出一张**与用户选区不一致**的图纸。UI 侧由 `clampRectToSource` 保证
   * 越界不可能发生，这里是第二道防线。
   */
  readonly sourceSize: { readonly width: number; readonly height: number };
  readonly crop: Rect;
  readonly rotation: Rotation;
  readonly longSide: number;
  readonly maxColors: MaxColors;
}
```

在 `generatePattern` 顶部（`rotation` 校验之前）加源图尺寸校验：

```ts
  const { crop, rotation, longSide, maxColors, sourceSize } = request;

  // 源图尺寸：整数且 ≥1（AGENTS.md「入口校验」的网格 / 尺寸类口径）。放在最前面是因为
  // 下面的越界判定要用它，而一个 NaN 宽高会让四条不等式全部为假、静默放行。
  if (!Number.isInteger(sourceSize.width) || sourceSize.width < 1) {
    throw new Error(`原图宽度必须是 ≥1 的整数（当前 ${String(sourceSize.width)}）`);
  }
  if (!Number.isInteger(sourceSize.height) || sourceSize.height < 1) {
    throw new Error(`原图高度必须是 ≥1 的整数（当前 ${String(sourceSize.height)}）`);
  }
```

在 `computeDecodeSize(...)` 之后、`chooseDecoderPath(...)` **之前**插入越界校验：

```ts
  // 越界校验必须放在 computeGridSize / computeDecodeSize 之后：那两处对「非有限 / < 1」的
  // 裁剪尺寸已经有了自己的响亮失败（消息是「裁剪区域尺寸非法」），既有用例断言的就是它。
  // 这里只负责它们拦不住的那一类：**有限但不落在原图里**的裁剪框。
  if (!Number.isFinite(crop.x) || !Number.isFinite(crop.y)) {
    throw new Error(
      `裁剪框原点必须是有限数字（当前 x=${String(crop.x)} y=${String(crop.y)}）`,
    );
  }
  if (
    crop.x < 0 ||
    crop.y < 0 ||
    crop.x + crop.width > sourceSize.width ||
    crop.y + crop.height > sourceSize.height
  ) {
    throw new Error(
      `裁剪框超出原图范围：原图 ${sourceSize.width}×${sourceSize.height}，` +
        `裁剪框 x=${crop.x} y=${crop.y} ${crop.width}×${crop.height}`,
    );
  }
```

- [ ] **步骤 6：运行测试验证通过**

运行：`npm run test -- src/services/__tests__/pipeline.test.ts`
预期：PASS，**既有用例条数一条不少**（报告里给出改动前后的用例总数）。

- [ ] **步骤 7：逐条跑变异，报告精确形态**

| 变异 | 期望 |
|---|---|
| 把越界校验里 `crop.x + crop.width > sourceSize.width` 改成 `>=` | 「恰好贴边不算越界」转红 |
| 删掉原点有限性那一条 `if` | 「NaN 原点」转红（另三条越界用例仍绿——这正是它必须单独存在的原因） |
| 把越界校验挪到 `rotation` 校验之前 | 既有 3 条 `/裁剪区域尺寸非法/` 用例转红（证明顺序真的被约束住了） |
| `sourceSize.width` 的整数校验改成 `Number.isFinite` | 「源图尺寸非整数」转红 |

- [ ] **步骤 8：Commit**

```bash
git add src/services/pipeline.ts src/services/__tests__/pipeline.test.ts
git commit -m "feat(services): 生成入口校验原图范围，越界裁剪拒绝而非夹取"
```

---

## 任务 7：向导草稿与阶段机（`stores/draft.ts`）

**文件：**
- 创建：`src/stores/draft.ts`
- 测试：`src/stores/__tests__/draft.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/stores/__tests__/draft.test.ts
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useDraft } from "@/stores/draft";

const SOURCE = { blob: new Blob([new Uint8Array([1, 2, 3])]), type: "image/png", name: "小猫.png" };

function fakePreview(): HTMLCanvasElement {
  return { width: 800, height: 600 } as unknown as HTMLCanvasElement;
}

function seedImage() {
  const draft = useDraft();
  draft.adoptImage({ source: SOURCE, sourceSize: { width: 800, height: 600 }, preview: fakePreview() });
  return draft;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("adoptImage：新图进来时的初始态", () => {
  it("选区是居中正方（与 B1 临时入口行为等价），阶段回到选区、未生成", () => {
    const draft = seedImage();
    expect(draft.crop).toEqual({ x: 100, y: 0, width: 600, height: 600 });
    expect(draft.stage).toBe("crop");
    expect(draft.generated).toBe(false);
    expect(draft.rotation).toBe(0);
    expect(draft.aspect).toBe("free");
    expect(draft.zoom).toBe("fit");
  });

  it("默认参数是 58 颗 / 32 色（字面量断言，常量被改坏时它会红）", () => {
    const draft = seedImage();
    expect(draft.longSide).toBe(58);
    expect(draft.maxColors).toBe(32);
  });

  it("换一张图会清掉上一次的 rerunOf 与错误", () => {
    const draft = seedImage();
    draft.adoptProject({
      source: SOURCE,
      params: { longSide: 116, maxColors: null, crop: { x: 0, y: 0, width: 10, height: 10 }, rotation: 2 },
      meta: { id: "p1", name: "旧图", createdAt: "2026-10-01T00:00:00.000Z" },
    });
    expect(draft.rerunOf?.id).toBe("p1");
    draft.adoptImage({ source: SOURCE, sourceSize: { width: 800, height: 600 }, preview: fakePreview() });
    expect(draft.rerunOf).toBeNull();
    expect(draft.error).toBe("");
    expect(draft.maxColors).toBe(32);
  });
});

describe("generated 的失效规则", () => {
  it("改选区 / 旋转 / 比例 / 长边 / 档位都会让「已生成」失效", () => {
    const draft = seedImage();
    draft.markGenerated();
    expect(draft.generated).toBe(true);

    draft.setCrop({ x: 0, y: 0, width: 100, height: 100 });
    expect(draft.generated).toBe(false);
    draft.markGenerated();
    draft.setRotation(1);
    expect(draft.generated).toBe(false);
    draft.markGenerated();
    draft.setAspect("1:1");
    expect(draft.generated).toBe(false);
    draft.markGenerated();
    draft.setLongSide(116);
    expect(draft.generated).toBe(false);
    draft.markGenerated();
    draft.setMaxColors(null);
    expect(draft.generated).toBe(false);
  });

  // 视图不是图纸参数：缩放与平移改了，产物一个像素都不会变。
  it("改缩放档位与平移**不**让「已生成」失效（它们不影响产物）", () => {
    const draft = seedImage();
    draft.markGenerated();
    draft.setZoom(4);
    draft.setPan({ x: -10, y: -20 });
    expect(draft.generated).toBe(true);
  });

  it("markGenerated 同时进入结果阶段", () => {
    const draft = seedImage();
    draft.markGenerated();
    expect(draft.stage).toBe("result");
  });
});

describe("离开 SetupPage 时的生死规则（规格 §9）", () => {
  it("已生成且此后无改动 → 清空草稿", () => {
    const draft = seedImage();
    draft.markGenerated();
    draft.onLeaveSetup();
    expect(draft.source).toBeNull();
    expect(draft.preview).toBeNull();
    expect(draft.crop).toBeNull();
  });

  it("中途退出 → 只释放预览，选区与参数都留着", () => {
    const draft = seedImage();
    draft.setLongSide(116);
    draft.setCrop({ x: 10, y: 20, width: 100, height: 100 });
    draft.onLeaveSetup();

    expect(draft.preview).toBeNull();
    expect(draft.source).toBe(SOURCE);
    expect(draft.crop).toEqual({ x: 10, y: 20, width: 100, height: 100 });
    expect(draft.longSide).toBe(116);
  });

  it("生成后又改了参数再离开 → 按「中途退出」处理（草稿留着）", () => {
    const draft = seedImage();
    draft.markGenerated();
    draft.setLongSide(29);
    draft.onLeaveSetup();
    expect(draft.source).toBe(SOURCE);
    expect(draft.preview).toBeNull();
  });
});

describe("adoptProject：从已有工程改参数重跑", () => {
  it("播种旋转 / 长边 / 档位与覆盖目标；原图尺寸到齐后才落下选区", () => {
    const draft = useDraft();
    draft.adoptProject({
      source: SOURCE,
      params: { longSide: 116, maxColors: null, crop: { x: 3, y: 5, width: 400, height: 200 }, rotation: 3 },
      meta: { id: "p1", name: "小猫", createdAt: "2026-10-01T00:00:00.000Z" },
    });

    // 原图尺寸还没解码出来：此刻**没有**选区，而不是一个用 NaN 算出来的选区。
    expect(draft.sourceSize).toBeNull();
    expect(draft.crop).toBeNull();

    draft.setSourceSize({ width: 800, height: 600 });

    expect(draft.sourceSize).toEqual({ width: 800, height: 600 });
    expect(draft.crop).toEqual({ x: 3, y: 5, width: 400, height: 200 });
    expect(draft.rotation).toBe(3);
    expect(draft.longSide).toBe(116);
    expect(draft.maxColors).toBeNull();
    expect(draft.rerunOf).toEqual({ id: "p1", name: "小猫", createdAt: "2026-10-01T00:00:00.000Z" });
    // 预览不在编辑器里解码：交给 SetupPage 挂载时补（规格 §7）。
    expect(draft.preview).toBeNull();
    expect(draft.stage).toBe("crop");
    expect(draft.generated).toBe(false);
  });

  it("越界的旧参数被夹进源图，而不是把 NaN 传进流水线", () => {
    const draft = useDraft();
    draft.adoptProject({
      source: SOURCE,
      params: { longSide: 58, maxColors: 32, crop: { x: -50, y: 900, width: 1200, height: 100 }, rotation: 0 },
      meta: { id: "p2", name: "手改坏的文件", createdAt: "2026-10-01T00:00:00.000Z" },
    });
    draft.setSourceSize({ width: 800, height: 600 });

    expect(draft.crop).toEqual({ x: 0, y: 500, width: 800, height: 100 });
  });
});

describe("入口校验（规格 §12）", () => {
  it("长边必须 1–500 的整数", () => {
    const draft = seedImage();
    for (const bad of [0, 501, 1.5, Number.NaN]) {
      expect(() => draft.setLongSide(bad)).toThrow(/长边/);
    }
  });

  it("档位只允许 16 / 32 / null", () => {
    const draft = seedImage();
    expect(() => draft.setMaxColors(8 as unknown as 16)).toThrow(/档位/);
    expect(() => draft.setMaxColors(Number.NaN as unknown as 16)).toThrow(/档位/);
  });

  it("旋转 / 比例 / 档位 / 平移的非法值抛错", () => {
    const draft = seedImage();
    expect(() => draft.setRotation(4 as unknown as 0)).toThrow(/旋转角度/);
    expect(() => draft.setAspect("16:9" as unknown as "4:3")).toThrow(/比例锁/);
    expect(() => draft.setZoom(3 as unknown as 2)).toThrow(/缩放档位/);
    expect(() => draft.setPan({ x: Number.NaN, y: 0 })).toThrow(/平移/);
  });

  it("setCrop 把越界矩形夹回来（守住 crop 的合法不变量）", () => {
    const draft = seedImage();
    draft.setCrop({ x: 700, y: 500, width: 400, height: 400 });
    expect(draft.crop).toEqual({ x: 400, y: 200, width: 400, height: 400 });
  });

  it("setSourceSize 要求整数且 ≥1（小数会让长度校验互相放过）", () => {
    const draft = useDraft();
    expect(() => draft.setSourceSize({ width: 0, height: 600 })).toThrow(/原图宽度/);
    expect(() => draft.setSourceSize({ width: 800.5, height: 600 })).toThrow(/原图宽度/);
    expect(() => draft.setSourceSize({ width: 800, height: Number.NaN })).toThrow(/原图高度/);
  });

  it("setPreview 把画布挂上（重跑路径由 SetupPage 解码后调用）", () => {
    const draft = useDraft();
    const canvas = fakePreview();
    draft.setPreview(canvas);
    expect(draft.preview).toBe(canvas);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/stores/__tests__/draft.test.ts`
预期：FAIL，`Failed to resolve import "@/stores/draft"`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// src/stores/draft.ts
import { defineStore } from "pinia";
import { markRaw, ref } from "vue";
import { centerSquare, clampRectToSource, type AspectLock } from "@/core/crop/rect";
import type { Size, ZoomLevel } from "@/core/crop/view";
import type { Rect, Rotation } from "@/core/image/types";
import {
  MAX_LONG_SIDE,
  MIN_LONG_SIDE,
  type MaxColors,
} from "@/core/pattern/types";

/**
 * 选图与选区阶段的草稿 + 阶段机。
 *
 * **不 import 解码器、不 import `indexedDB`**：解码在 `services/`，落盘在 `useProjectSession`。
 * 这个 store 只回答两件事：用户现在走到哪一步，以及手上这份选区与参数是什么。
 *
 * `generated` 的语义是「本次生成成功、且此后没有改过**会影响产物**的东西」——缩放与平移
 * 改了不影响产物，所以它们不使之失效（这条规则有用例钉住，别顺手统一处理）。
 */

export type Stage = "crop" | "params" | "result";

export interface DraftSource {
  readonly blob: Blob;
  readonly type: string;
  readonly name: string;
}

/** 就地重跑时要沿用的那条记录（id / 名称 / createdAt 不变，`updatedAt` 由 save 刷新）。 */
export interface RerunTarget {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface DraftParams {
  readonly longSide: number;
  readonly maxColors: MaxColors;
  readonly crop: Rect;
  readonly rotation: Rotation;
}

const DEFAULT_LONG_SIDE = 58;
const DEFAULT_MAX_COLORS: MaxColors = 32;
const ZOOM_LEVELS: readonly ZoomLevel[] = ["fit", 2, 4];
const ASPECTS: readonly AspectLock[] = ["free", "1:1", "4:3", "9:16"];

export const useDraft = defineStore("draft", () => {
  const source = ref<DraftSource | null>(null);
  const sourceSize = ref<Size | null>(null);
  // `markRaw` 在这里其实是防御性的：Vue 不代理 DOM 节点这类非普通对象，所以它不会被深度代理。
  // 保留它是为了让「不要把画布塞进响应式代理」这条意图写在代码里。**不要为它写用例**——
  // 那条断言在本环境里恒真，属于「断言存在 ≠ 断言有效」。
  const preview = ref<HTMLCanvasElement | null>(null);
  const rerunOf = ref<RerunTarget | null>(null);

  const crop = ref<Rect | null>(null);
  /** `adoptProject` 带来的裁剪框：原图尺寸还没解码出来，先存着，`setSourceSize` 到时再夹取。 */
  const pendingCrop = ref<Rect | null>(null);
  const rotation = ref<Rotation>(0);
  const aspect = ref<AspectLock>("free");
  const zoom = ref<ZoomLevel>("fit");
  const pan = ref<{ x: number; y: number }>({ x: 0, y: 0 });

  const longSide = ref(DEFAULT_LONG_SIDE);
  const maxColors = ref<MaxColors>(DEFAULT_MAX_COLORS);

  const stage = ref<Stage>("crop");
  const generated = ref(false);
  const busy = ref(false);
  const error = ref("");

  function requireSourceSize(): Size {
    if (sourceSize.value === null) throw new Error("还没有选图，拿不到原图尺寸");
    return sourceSize.value;
  }

  function requireLongSide(next: number): number {
    if (!Number.isInteger(next) || next < MIN_LONG_SIDE || next > MAX_LONG_SIDE) {
      throw new Error(`长边豆数必须是 ${MIN_LONG_SIDE}–${MAX_LONG_SIDE} 的整数（当前 ${String(next)}）`);
    }
    return next;
  }

  function requireMaxColors(next: MaxColors): MaxColors {
    if (next !== 16 && next !== 32 && next !== null) {
      throw new Error(`用色档位非法：${String(next)}（只允许 16 / 32 / null）`);
    }
    return next;
  }

  function requireRotation(next: Rotation): Rotation {
    if (next !== 0 && next !== 1 && next !== 2 && next !== 3) {
      throw new Error(`旋转角度非法：${String(next)}（必须是 0–3 的整数）`);
    }
    return next;
  }

  /** 选了一张新图：选区回到居中正方，参数回落默认值。 */
  function adoptImage(input: {
    readonly source: DraftSource;
    readonly sourceSize: Size;
    readonly preview: HTMLCanvasElement;
  }): void {
    source.value = input.source;
    sourceSize.value = input.sourceSize;
    preview.value = markRaw(input.preview);
    rerunOf.value = null;
    pendingCrop.value = null;
    crop.value = centerSquare(input.sourceSize);
    rotation.value = 0;
    aspect.value = "free";
    zoom.value = "fit";
    pan.value = { x: 0, y: 0 };
    longSide.value = DEFAULT_LONG_SIDE;
    maxColors.value = DEFAULT_MAX_COLORS;
    stage.value = "crop";
    generated.value = false;
    busy.value = false;
    error.value = "";
  }

  /**
   * 从已有工程进来（规格 §7）：参数原样播种，**原图尺寸与预览留空**——它们要等 `SetupPage`
   * 把 `source.blob` 解码出来才知道（`adoptProject` 的调用方是编辑器，手里只有 Blob）。
   * 解码只发生在 `SetupPage` 一处，不在编辑器里再来一份（本项目的头号缺陷形态就是
   * 「两端各自正确、错在接线」）。
   *
   * 因此这里的 `crop` 先存进 `pendingCrop`，等 `setSourceSize` 到了再夹取——**顺序不能反**：
   * 没有原图尺寸时夹取算不出边界。
   */
  function adoptProject(input: {
    readonly source: DraftSource;
    readonly params: DraftParams;
    readonly meta: RerunTarget;
  }): void {
    source.value = input.source;
    sourceSize.value = null;
    preview.value = null;
    rerunOf.value = { id: input.meta.id, name: input.meta.name, createdAt: input.meta.createdAt };
    pendingCrop.value = input.params.crop;
    crop.value = null;
    rotation.value = requireRotation(input.params.rotation);
    aspect.value = "free";
    zoom.value = "fit";
    pan.value = { x: 0, y: 0 };
    longSide.value = requireLongSide(input.params.longSide);
    maxColors.value = requireMaxColors(input.params.maxColors);
    stage.value = "crop";
    generated.value = false;
    busy.value = false;
    error.value = "";
  }

  /**
   * 原图尺寸就位（新图来自 `loadImageSource` 的返回值；重跑来自 `SetupPage` 的解码）。
   *
   * 这是**唯一**落下初始选区的时机：新图用居中正方，重跑用 `pendingCrop`（经夹取）。
   * 已经有选区时不覆盖——否则用户在选区页上每触发一次尺寸刷新都会被重置。
   */
  function setSourceSize(next: Size): void {
    if (!Number.isInteger(next.width) || next.width < 1) {
      throw new Error(`原图宽度必须是 ≥1 的整数（当前 ${String(next.width)}）`);
    }
    if (!Number.isInteger(next.height) || next.height < 1) {
      throw new Error(`原图高度必须是 ≥1 的整数（当前 ${String(next.height)}）`);
    }
    sourceSize.value = next;
    if (crop.value === null) {
      crop.value = clampRectToSource(pendingCrop.value ?? centerSquare(next), next);
      pendingCrop.value = null;
    }
  }

  function setPreview(next: HTMLCanvasElement): void {
    preview.value = markRaw(next);
  }

  function setCrop(next: Rect): void {
    crop.value = clampRectToSource(next, requireSourceSize());
    generated.value = false;
  }

  function setRotation(next: Rotation): void {
    rotation.value = requireRotation(next);
    generated.value = false;
  }

  function setAspect(next: AspectLock): void {
    if (!ASPECTS.includes(next)) throw new Error(`比例锁非法：${String(next)}`);
    aspect.value = next;
    generated.value = false;
  }

  function setLongSide(next: number): void {
    longSide.value = requireLongSide(next);
    generated.value = false;
  }

  function setMaxColors(next: MaxColors): void {
    maxColors.value = requireMaxColors(next);
    generated.value = false;
  }

  /** 视图改动不影响产物，**不**让 `generated` 失效。 */
  function setZoom(next: ZoomLevel): void {
    if (!ZOOM_LEVELS.includes(next)) throw new Error(`缩放档位非法：${String(next)}（只允许 "fit" / 2 / 4）`);
    zoom.value = next;
  }

  function setPan(next: { x: number; y: number }): void {
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) {
      throw new Error(`视图平移必须是有限数字（当前 ${String(next.x)}, ${String(next.y)}）`);
    }
    pan.value = { x: next.x, y: next.y };
  }

  function setStage(next: Stage): void {
    stage.value = next;
  }

  function setBusy(next: boolean): void {
    busy.value = next;
  }

  function setError(message: string): void {
    error.value = message;
  }

  function markGenerated(): void {
    generated.value = true;
    stage.value = "result";
  }

  /** 离开 SetupPage 时释放预览画布（它是 ≤1600 的位图，长期挂着不值）。 */
  function releasePreview(): void {
    preview.value = null;
  }

  /**
   * 离开 SetupPage 时的生死规则（规格 §9）：已生成且此后无改动 → 整份草稿作废
   * （图纸已在库里，重跑走编辑器的入口）；中途退出 → 只释放预览，选区与参数留着，
   * 于是 `/new` 上的「继续上次的选区」还能用。
   */
  function onLeaveSetup(): void {
    if (generated.value) {
      reset();
      return;
    }
    releasePreview();
  }

  function reset(): void {
    source.value = null;
    sourceSize.value = null;
    preview.value = null;
    rerunOf.value = null;
    pendingCrop.value = null;
    crop.value = null;
    rotation.value = 0;
    aspect.value = "free";
    zoom.value = "fit";
    pan.value = { x: 0, y: 0 };
    longSide.value = DEFAULT_LONG_SIDE;
    maxColors.value = DEFAULT_MAX_COLORS;
    stage.value = "crop";
    generated.value = false;
    busy.value = false;
    error.value = "";
  }

  return {
    source, sourceSize, preview, rerunOf,
    crop, rotation, aspect, zoom, pan,
    longSide, maxColors,
    stage, generated, busy, error,
    adoptImage, adoptProject, setSourceSize, setPreview,
    setCrop, setRotation, setAspect, setLongSide, setMaxColors, setZoom, setPan,
    setStage, setBusy, setError, markGenerated, releasePreview, onLeaveSetup, reset,
  };
});
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/stores/__tests__/draft.test.ts`
预期：PASS（约 16 个用例）。

- [ ] **步骤 5：逐条跑变异，报告精确形态**

| 变异 | 期望 |
|---|---|
| `setZoom` / `setPan` 里加上 `generated.value = false` | 「改缩放与平移不让已生成失效」转红 |
| `onLeaveSetup` 的两个分支对调 | §9 的两条转红 |
| `adoptImage` 不清 `rerunOf` | 「换一张图会清掉 rerunOf」转红 |
| `setCrop` 去掉 `clampRectToSource` | 「setCrop 把越界矩形夹回来」转红 |

- [ ] **步骤 6：Commit**

```bash
git add src/stores/draft.ts src/stores/__tests__/draft.test.ts
git commit -m "feat(stores): 向导草稿与阶段机"
```

---

## 任务 8：选区画布与手势（`components/crop/CropCanvas.vue`）

**文件：**
- 创建：`src/components/crop/CropCanvas.vue`
- 测试：`src/components/crop/__tests__/CropCanvas.test.ts`

**组件契约（props 进、事件出，不读 store）：**

```
props:  preview: HTMLCanvasElement, sourceSize: Size, crop: Rect, rotation: Rotation,
        aspect: AspectLock, zoom: ZoomLevel, pan: { x: number; y: number }
emits:  "update:crop"(Rect) / "update:pan"({ x, y })
```

**视图变换的组装方式（三层，全部来自 `core/crop/view.ts`）：**

```
base   = fitTransform(viewport, orientedSizeOf(sourceSize, rotation))
zoomed = withZoom(base, viewport, oriented, zoom)          // 锚点 = 视口中心
view   = clampView(zoomed + pan, viewport, oriented)       // pan 是叠加在锚定视图上的增量
```

`pan` 只在 `zoom !== "fit"` 时有效果：适配态下图像恰好铺满一个方向，`clampView` 会把平移夹回 0。
因此**切换档位时由 store 把 `pan` 归零**（`setZoom` 里做），这样「以视口中心为锚」成立。

- [ ] **步骤 1：编写失败的测试**

```ts
// src/components/crop/__tests__/CropCanvas.test.ts
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import CropCanvas from "@/components/crop/CropCanvas.vue";

/**
 * 手势用例断言的是**最终发出的 crop / pan**，不是 canvas 的绘制调用——绘制是「我怎么画的」，
 * 不是「用户得到了什么」。画布本身在 happy-dom 里是桩（`getContext("2d")` 返回 null），
 * 所以像素级断言在这里一律恒真，绝不写（B1-2 的教训）。
 *
 * 场景固定为：源图 800×600、容器 400×400（`getBoundingClientRect` 被桩成全 0 之外的值）、
 * dpr = 1、rotation = 0 → 适配比例 0.5、水平偏移 0、垂直偏移 50。
 */

const SOURCE = { width: 800, height: 600 };

/** 假画布：`getContext` 返回一个只记录调用的桩，`drawImage` 的参数不被断言。 */
function fakePreview(): HTMLCanvasElement {
  const ctx = { drawImage: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill: vi.fn(), fillStyle: "", strokeStyle: "", lineWidth: 0, imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
  return {
    width: 800,
    height: 600,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

/** 假 ResizeObserver：happy-dom 的实现在 `observe()` 里什么都不做（实测），这里换成可断言的桩。 */
function stubResizeObserver(): { observed: unknown[] } {
  const observed: unknown[] = [];
  class FakeResizeObserver {
    constructor(_callback: unknown) {}
    observe(target: unknown): void {
      observed.push(target);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return { observed };
}

function stubContainer(width = 400, height = 400): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect);
}

/** 派发一次指针事件；happy-dom 有真实的 `PointerEvent`。 */
async function pointer(wrapper: ReturnType<typeof mount>, type: string, x: number, y: number): Promise<void> {
  const canvas = wrapper.get("canvas");
  canvas.element.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true, cancelable: true }),
  );
  await wrapper.vm.$nextTick();
}

function mountCanvas(overrides: Partial<{ crop: unknown; zoom: unknown; pan: unknown; rotation: unknown }> = {}) {
  return mount(CropCanvas, {
    props: {
      preview: fakePreview(),
      sourceSize: SOURCE,
      crop: { x: 100, y: 100, width: 300, height: 300 },
      rotation: 0,
      aspect: "free",
      zoom: "fit",
      pan: { x: 0, y: 0 },
      ...overrides,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("画布尺寸与 DPR", () => {
  it("按 devicePixelRatio 设画布尺寸（主规格 §6.3.1）", async () => {
    stubContainer(400, 300);
    stubResizeObserver();
    window.devicePixelRatio = 2;

    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    const canvas = wrapper.get("canvas").element as HTMLCanvasElement;
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    // CSS 尺寸仍是布局尺寸，不是设备像素——否则画布会溢出容器。
    expect(canvas.style.width).toBe("400px");
    expect(canvas.style.height).toBe("300px");
  });

  it("注册了 ResizeObserver 以跟随容器尺寸变化", async () => {
    stubContainer();
    const observer = stubResizeObserver();

    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    // 只断言「注册了 observe」：happy-dom 的 ResizeObserver 是空实现，声称测到重算行为是假的。
    // 观察对象必须是**容器**（画布是 h-full w-full，按自己的盒子设属性会循环放大）。
    expect(observer.observed).toHaveLength(1);
    expect(observer.observed[0]).toBe(wrapper.get("[data-testid='crop-surface']").element);
  });
});

describe("手势 → 选区", () => {
  it("拖右下角把选区缩到指针处（对角固定）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    // 适配比例 0.5、偏移 (0,50)：选区 {100,100,300,300} 在屏幕上是 x 50–200、y 100–250，
    // 右下角手柄中心在 (200,250)。
    await pointer(wrapper, "pointerdown", 200, 250);
    await pointer(wrapper, "pointermove", 250, 250);

    // 屏幕 (250,250) → 原图 (500,400)；从锚点 (100,100) 拉到那里 → 400×300
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 100, y: 100, width: 400, height: 300 }]);
  });

  it("拖左上角时右下角不动", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    await pointer(wrapper, "pointerdown", 50, 100);
    await pointer(wrapper, "pointermove", 100, 150);

    // 屏幕 (100,150) → 原图 (200,200)；锚点是右下角 (400,400) → {200,200,200,200}
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 200, y: 200, width: 200, height: 200 }]);
  });

  it("在选区内拖动是平移选区，尺寸不变", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    await pointer(wrapper, "pointerdown", 100, 150);
    await pointer(wrapper, "pointermove", 120, 180);

    // 屏幕位移 (20,30) → 原图位移 (40,60)
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 140, y: 160, width: 300, height: 300 }]);
  });

  it("适配视图下在选区外拖动同样是平移选区（fit 下没有可平移的量）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    await pointer(wrapper, "pointerdown", 380, 380);
    await pointer(wrapper, "pointermove", 390, 400);

    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 120, y: 140, width: 300, height: 300 }]);
    expect(wrapper.emitted("update:pan")).toBeUndefined();
  });

  it("放大档位下在选区外拖动是平移视图，且平移被夹进图像范围", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas({ zoom: 2 });

    // zoom 2 下 view = {scale 1, offsetX -200, offsetY -100}：选区在屏幕上是 x -100–200、y 0–300。
    await pointer(wrapper, "pointerdown", 350, 350);
    await pointer(wrapper, "pointermove", 340, 330);
    expect(wrapper.emitted("update:pan")?.at(-1)).toEqual([{ x: -10, y: -20 }]);

    // 一路拖到远超左边界：夹到图像的左边缘（offsetX 只能到 -400），所以 pan 停在 -200。
    await pointer(wrapper, "pointerdown", 350, 350);
    await pointer(wrapper, "pointermove", -150, 350);
    expect(wrapper.emitted("update:pan")?.at(-1)).toEqual([{ x: -200, y: 0 }]);
    expect(wrapper.emitted("update:crop")).toBeUndefined();
  });

  it("抬起后继续移动不再产生新的选区（手势结束）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    await pointer(wrapper, "pointerdown", 200, 250);
    await pointer(wrapper, "pointermove", 250, 250);
    const afterDrag = wrapper.emitted("update:crop")?.length;
    await pointer(wrapper, "pointerup", 250, 250);
    await pointer(wrapper, "pointermove", 300, 300);

    expect(wrapper.emitted("update:crop")?.length).toBe(afterDrag);
  });

  it("旋转 1 时手势按显示空间换算回原图坐标（不是直接拿屏幕位移当原图位移）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    // rotation 1 → 显示空间 600×800 → 适配比例 0.5、水平偏移 50、垂直偏移 0
    const wrapper = mountCanvas({ rotation: 1, crop: { x: 100, y: 100, width: 300, height: 300 } });

    // 源图选区 {100,100,300,300} → 显示空间 {200,100,300,300}（顺时针 90° 把源图左上 (100,100)
    // 送到 (500,100)）→ 屏幕 x 150–300、y 50–200，右下角手柄中心在 (300,200)。
    await pointer(wrapper, "pointerdown", 300, 200);
    // 拖到屏幕 (250,250) → 显示空间 (400,500) → 逆旋转回原图 (oy, H − ox) = (500, 200)
    await pointer(wrapper, "pointermove", 250, 250);

    const emitted = wrapper.emitted("update:crop")?.at(-1)?.[0] as { x: number; y: number; width: number; height: number };
    // 锚点是原图左上 (100,100)，指针落在源坐标 (500,200) → 400×100
    expect(emitted).toEqual({ x: 100, y: 100, width: 400, height: 100 });
  });
});
```

> **上面最后一条用例的期望值是实现前手算的**，实现者要按自己跑出来的数复核：如果手算错了，
> 先判断是**代码错了还是用例错了**，再改；改用例必须在报告里给出「为什么原期望不成立」的推导。
> 这一条的价值在于它同时覆盖「逆旋转」与「夹取」两件事，不要为了让测试变绿而把它简化掉。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/components/crop/__tests__/CropCanvas.test.ts`
预期：FAIL，`Failed to resolve import "@/components/crop/CropCanvas.vue"`。

- [ ] **步骤 3：编写组件**

```vue
<script setup lang="ts">
// src/components/crop/CropCanvas.vue
//
// 选区画布：只负责「画」与「收手势」。几何一律来自 core/crop/*，本文件不自己算坐标
// （屏幕 → 原图的整条链错了不会报错，只会产出一张位置不对的图纸）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  applyAspect,
  clampRectToSource,
  moveRect,
  resizeByHandle,
  type AspectLock,
  type CropHandle,
} from "@/core/crop/rect";
import {
  clampView,
  fitTransform,
  orientedSizeOf,
  screenToSource,
  sourceRectToScreen,
  withZoom,
  type Size,
  type ViewTransform,
  type ZoomLevel,
} from "@/core/crop/view";
import type { Rect, Rotation } from "@/core/image/types";

/** 手柄命中区的 CSS 尺寸（触控目标 ≥44px，主规格 §6.4）。 */
const HANDLE_HIT_SIZE = 48;
/** 手柄视觉方块的 CSS 尺寸。 */
const HANDLE_DRAW_SIZE = 20;

const props = defineProps<{
  preview: HTMLCanvasElement;
  sourceSize: Size;
  crop: Rect;
  rotation: Rotation;
  aspect: AspectLock;
  zoom: ZoomLevel;
  pan: { x: number; y: number };
}>();

const emit = defineEmits<{
  "update:crop": [Rect];
  "update:pan": [{ x: number; y: number }];
}>();

const container = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const viewport = ref<Size>({ width: 0, height: 0 });

const oriented = computed(() => orientedSizeOf(props.sourceSize, props.rotation));

/** 当前视图：适配 → 缩放档位 → 叠加平移 → 夹取。 */
const view = computed<ViewTransform>(() => {
  const size = viewport.value;
  if (size.width <= 0 || size.height <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  const base = fitTransform(size, oriented.value);
  const zoomed = withZoom(base, size, oriented.value, props.zoom);
  return clampView(
    { ...zoomed, offsetX: zoomed.offsetX + props.pan.x, offsetY: zoomed.offsetY + props.pan.y },
    size,
    oriented.value,
  );
});

/** 画布上指针位置的 CSS 坐标（相对容器左上角）。 */
function localPoint(event: PointerEvent): { x: number; y: number } {
  const element = container.value;
  if (element === null) return { x: event.clientX, y: event.clientY };
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function handleCenters(screenCrop: Rect): { handle: CropHandle; x: number; y: number }[] {
  return [
    { handle: "nw", x: screenCrop.x, y: screenCrop.y },
    { handle: "ne", x: screenCrop.x + screenCrop.width, y: screenCrop.y },
    { handle: "sw", x: screenCrop.x, y: screenCrop.y + screenCrop.height },
    { handle: "se", x: screenCrop.x + screenCrop.width, y: screenCrop.y + screenCrop.height },
  ];
}

function inside(rect: Rect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

// ---------------------------------------------------------------------------
// 手势
// ---------------------------------------------------------------------------

type Gesture = { mode: "resize"; handle: CropHandle } | { mode: "move" } | { mode: "pan" };

const gesture = ref<Gesture | null>(null);
/** 手势开始时的快照：每次 move 都从它重算，避免误差累积。 */
let startCrop: Rect = { x: 0, y: 0, width: 1, height: 1 };
let startPoint = { x: 0, y: 0 };
let startPan = { x: 0, y: 0 };

function onPointerDown(event: PointerEvent): void {
  const point = localPoint(event);
  const screenCrop = sourceRectToScreen(props.crop, view.value, props.rotation, props.sourceSize);
  const hit = handleCenters(screenCrop).find(
    (item) => Math.abs(item.x - point.x) <= HANDLE_HIT_SIZE / 2 && Math.abs(item.y - point.y) <= HANDLE_HIT_SIZE / 2,
  );

  if (hit !== undefined) {
    gesture.value = { mode: "resize", handle: hit.handle };
  } else if (inside(screenCrop, point)) {
    gesture.value = { mode: "move" };
  } else {
    // 适配视图下没有可平移的量，拖空白就是拖选框本身（规格 §4.3）。
    gesture.value = props.zoom === "fit" ? { mode: "move" } : { mode: "pan" };
  }

  startCrop = props.crop;
  startPoint = point;
  startPan = props.pan;
  (event.target as Element | null)?.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  const current = gesture.value;
  if (current === null) return;
  const point = localPoint(event);

  if (current.mode === "pan") {
    const size = viewport.value;
    const base = fitTransform(size, oriented.value);
    const zoomed = withZoom(base, size, oriented.value, props.zoom);
    const next = clampView(
      {
        ...zoomed,
        offsetX: zoomed.offsetX + startPan.x + (point.x - startPoint.x),
        offsetY: zoomed.offsetY + startPan.y + (point.y - startPoint.y),
      },
      size,
      oriented.value,
    );
    emit("update:pan", { x: next.offsetX - zoomed.offsetX, y: next.offsetY - zoomed.offsetY });
    return;
  }

  const source = screenToSource(point, view.value, props.rotation, props.sourceSize);
  if (current.mode === "resize") {
    emit("update:crop", resizeByHandle(startCrop, current.handle, source, props.aspect, props.rotation, props.sourceSize));
    return;
  }
  const from = screenToSource(startPoint, view.value, props.rotation, props.sourceSize);
  emit("update:crop", moveRect(startCrop, source.x - from.x, source.y - from.y, props.sourceSize));
}

function onPointerUp(event: PointerEvent): void {
  if (gesture.value === null) return;
  gesture.value = null;
  (event.target as Element | null)?.releasePointerCapture?.(event.pointerId);
}

/** 比例锁由父级改 props 之后，把当前选区收进新比例。 */
watch(
  () => props.aspect,
  (next) => {
    emit("update:crop", clampRectToSource(applyAspect(props.crop, next, props.rotation, props.sourceSize), props.sourceSize));
  },
);

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

/**
 * 量**容器**而不是画布自己：画布是 `h-full w-full`，若按它自己的 CSS 盒设 `width/height`
 * 属性，属性会反过来撑大它的盒子，形成每帧放大的循环（这是 canvas 尺寸最经典的一类 bug）。
 */
function resizeCanvas(): void {
  const element = canvas.value;
  const box = container.value;
  if (element === null || box === null) return;
  const rect = box.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  element.width = Math.max(1, Math.round(rect.width * dpr));
  element.height = Math.max(1, Math.round(rect.height * dpr));
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
  viewport.value = { width: rect.width, height: rect.height };
  draw();
}

function draw(): void {
  const element = canvas.value;
  if (element === null) return;
  const ctx = element.getContext("2d");
  if (ctx === null) return;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const size = viewport.value;
  if (size.width <= 0 || size.height <= 0) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);

  const current = view.value;
  const image = sourceRectToScreen({ x: 0, y: 0, ...oriented.value }, current, 0, oriented.value);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(props.preview, image.x, image.y, image.width, image.height);

  const screenCrop = sourceRectToScreen(props.crop, current, props.rotation, props.sourceSize);
  // 选框外压一层半透明遮罩
  ctx.fillStyle = "rgba(15, 23, 42, 0.45)";
  ctx.fillRect(0, 0, size.width, screenCrop.y);
  ctx.fillRect(0, screenCrop.y + screenCrop.height, size.width, size.height - screenCrop.y - screenCrop.height);
  ctx.fillRect(0, screenCrop.y, screenCrop.x, screenCrop.height);
  ctx.fillRect(screenCrop.x + screenCrop.width, screenCrop.y, size.width - screenCrop.x - screenCrop.width, screenCrop.height);

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.strokeRect(screenCrop.x, screenCrop.y, screenCrop.width, screenCrop.height);
  ctx.fillStyle = "#ffffff";
  for (const center of handleCenters(screenCrop)) {
    ctx.fillRect(center.x - HANDLE_DRAW_SIZE / 2, center.y - HANDLE_DRAW_SIZE / 2, HANDLE_DRAW_SIZE, HANDLE_DRAW_SIZE);
  }
}

let observer: ResizeObserver | null = null;

onMounted(() => {
  resizeCanvas();
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(() => resizeCanvas());
    if (container.value !== null) observer.observe(container.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

watch([() => props.preview, () => props.crop, () => props.rotation, () => props.zoom, () => props.pan], () => draw(), {
  deep: true,
});
</script>

<template>
  <div ref="container" data-testid="crop-surface" class="h-full w-full">
    <canvas
      ref="canvas"
      data-testid="crop-canvas"
      class="block h-full w-full touch-none select-none"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    />
  </div>
</template>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/components/crop/__tests__/CropCanvas.test.ts`
预期：PASS（9 个用例）。**若最后一条旋转用例的期望值与你算出来的不同，先在报告里写出推导**，不要直接改数字。

- [ ] **步骤 5：跑变异，报告精确形态**

| 变异 | 期望 |
|---|---|
| `onPointerDown` 里手柄判定与「选区内部」判定顺序对调 | 「拖右下角」转红（变成 move） |
| `props.zoom === "fit"` 改成 `"fit" === "never"` | 「适配视图下选区外拖动是平移选区」转红 |
| `moveRect(startCrop, source.x - from.x, …)` 改成 `moveRect(props.crop, …)` | 「平移选区」转红（每帧相对上一帧累加，数值会翻倍） |
| pan 分支去掉 `clampView` | 「平移被夹进图像范围」转红 |
| `resizeCanvas` 里 `element.style.width` 不设 | DPR 那条转红（CSS 尺寸会退回设备像素） |

- [ ] **步骤 6：Commit**

```bash
git add src/components/crop/CropCanvas.vue src/components/crop/__tests__/CropCanvas.test.ts
git commit -m "feat(app): 选区画布与指针手势"
```

---

## 任务 9：参数面板与尺寸摘要（`components/param/ParamPanel.vue`）

**文件：**
- 创建：`src/components/param/ParamPanel.vue`
- 测试：`src/components/param/__tests__/ParamPanel.test.ts`

**组件契约：**

```
props:  longSide: number, maxColors: MaxColors, crop: Rect, rotation: Rotation,
        paletteName: string, paletteAccuracy: string, busy: boolean,
        generateBlockedReason: string          // 父级给出的额外阻拦原因（选区太小 / 存储不可用…），空串=没有
emits:  "update:longSide"(number) / "update:maxColors"(MaxColors) / "generate"()
```

输入框自己持有文本（用户可以随便打字），**只在解析出合法整数时才 emit**；不合法时显示原因并禁用生成。
摘要里的豆数必须用 `computeGridSize(rotatedSize(crop, rotation), longSide)`——与 `pipeline.ts` 同一个函数，
这是「UI 显示 58×44、生成出来 44×58」那道守卫的组件侧。

- [ ] **步骤 1：编写失败的测试**

```ts
// src/components/param/__tests__/ParamPanel.test.ts
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ParamPanel from "@/components/param/ParamPanel.vue";

/** 600×600 的裁剪 + 长边 58 → 58×58 颗、29.0×29.0 厘米、2×2=4 块板。 */
function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(ParamPanel, {
    props: {
      longSide: 58,
      maxColors: 32,
      crop: { x: 0, y: 0, width: 600, height: 600 },
      rotation: 0,
      paletteName: "MARD 221 色",
      paletteAccuracy: "屏幕色仅供参考，以实物为准",
      busy: false,
      generateBlockedReason: "",
      ...overrides,
    },
  });
}

describe("尺寸摘要", () => {
  it("按裁剪与长边算出豆数 / 厘米 / 板数", () => {
    const wrapper = mountPanel();
    const text = wrapper.get("[data-testid='summary']").text();
    expect(text).toContain("58 × 58 颗");
    expect(text).toContain("约 29.0 × 29.0 厘米");
    expect(text).toContain("需要 2 × 2 = 4 块板");
  });

  // 非正方形裁剪：短边按比例四舍五入（400×200 的长边 10 → 10×5）。
  it("非正方形裁剪按比例算短边", () => {
    const wrapper = mountPanel({ crop: { x: 0, y: 0, width: 400, height: 200 }, longSide: 10 });
    expect(wrapper.get("[data-testid='summary']").text()).toContain("10 × 5 颗");
  });

  // 这条专打「摘要不传 rotation」的实现：rotation 1 下显示空间换轴，摘要必须跟着换。
  it("旋转 90° 后豆数换轴（与生成结果同一函数）", () => {
    const crop = { x: 0, y: 0, width: 400, height: 200 };
    const flat = mountPanel({ crop, longSide: 10, rotation: 0 });
    const rotated = mountPanel({ crop, longSide: 10, rotation: 1 });
    expect(flat.get("[data-testid='summary']").text()).toContain("10 × 5 颗");
    expect(rotated.get("[data-testid='summary']").text()).toContain("5 × 10 颗");
  });
});

describe("长边输入", () => {
  it("合法输入才 emit，并同步摘要", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='long-side']").setValue("116");

    expect(wrapper.emitted("update:longSide")?.at(-1)).toEqual([116]);
    expect(wrapper.get("[data-testid='summary']").text()).toContain("116 × 116 颗");
  });

  it("快捷值按钮直接 emit", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='preset-29']").trigger("click");
    expect(wrapper.emitted("update:longSide")?.at(-1)).toEqual([29]);
  });

  it.each(["0", "501", "2.5", ""])("非法输入 %s 不 emit，给出原因并禁用生成", async (bad) => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='long-side']").setValue(bad);

    expect(wrapper.emitted("update:longSide")).toBeUndefined();
    expect(wrapper.get("[data-testid='blocked-reason']").text()).toContain("1–500");
    expect(wrapper.get("[data-testid='generate']").attributes("disabled")).toBeDefined();
  });

  it("超过 300 颗时提示导出会分片，但不阻止生成", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='long-side']").setValue("400");

    expect(wrapper.get("[data-testid='split-hint']").text()).toContain("分片");
    expect(wrapper.get("[data-testid='generate']").attributes("disabled")).toBeUndefined();
  });
});

describe("档位与色卡", () => {
  it("切到 16 色时 emit 的是数字 16", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='max-colors']").setValue("16");
    expect(wrapper.emitted("update:maxColors")?.at(-1)).toEqual([16]);
  });

  it("切到「不限」时 emit 的是 null（不是空串、不是 0）", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='max-colors']").setValue("");
    expect(wrapper.emitted("update:maxColors")?.at(-1)).toEqual([null]);
  });

  it("色卡卡片显示名称与精度声明（主规格 §11：声明必须出现在色卡 UI 上）", () => {
    const wrapper = mountPanel();
    const card = wrapper.get("[data-testid='palette-card']").text();
    expect(card).toContain("MARD 221 色");
    expect(card).toContain("屏幕色仅供参考，以实物为准");
  });
});

describe("生成按钮", () => {
  it("点按 emit generate", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='generate']").trigger("click");
    expect(wrapper.emitted("generate")).toHaveLength(1);
  });

  it("busy 期间禁用（禁止并发生成）", () => {
    const wrapper = mountPanel({ busy: true });
    expect(wrapper.get("[data-testid='generate']").attributes("disabled")).toBeDefined();
  });

  it("父级给出的阻拦原因会显示出来并禁用生成（选区太小等）", () => {
    const wrapper = mountPanel({ generateBlockedReason: "选区 50 × 50 像素要拼 58 × 58 颗豆" });
    expect(wrapper.get("[data-testid='blocked-reason']").text()).toContain("选区 50 × 50");
    expect(wrapper.get("[data-testid='generate']").attributes("disabled")).toBeDefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/components/param/__tests__/ParamPanel.test.ts`
预期：FAIL，`Failed to resolve import "@/components/param/ParamPanel.vue"`。

- [ ] **步骤 3：编写组件**

```vue
<script setup lang="ts">
// src/components/param/ParamPanel.vue
//
// 参数面板：长边 / 档位 / 色卡 / 尺寸摘要 / 生成按钮。props 进、事件出，不读 store。
// 摘要的豆数用 `computeGridSize`——与 services/pipeline.ts 是**同一个函数**，不是同一份算法抄两遍。
import { computed, ref, watch } from "vue";
import { rotatedSize } from "@/core/image/rotate";
import type { Rect, Rotation } from "@/core/image/types";
import { boardCount, beadsToCm, formatCm } from "@/core/pattern/board";
import { computeGridSize } from "@/core/pattern/build";
import { MAX_LONG_SIDE, MIN_LONG_SIDE, type MaxColors } from "@/core/pattern/types";

/** 常用的长边快捷值（B1 的临时入口用的就是 58 / 116）。 */
const LONG_SIDE_PRESETS = [29, 58, 116] as const;
/** 超过这个豆数就提示「导出会分片」，不阻止（主规格 §8）。 */
const SPLIT_HINT_LONG_SIDE = 300;

const MAX_COLOR_CHOICES = [
  { value: "16", label: "简单（16 色）" },
  { value: "32", label: "标准（32 色）" },
  { value: "", label: "精细（颜色不限）" },
] as const;

const props = defineProps<{
  longSide: number;
  maxColors: MaxColors;
  crop: Rect;
  rotation: Rotation;
  paletteName: string;
  paletteAccuracy: string;
  busy: boolean;
  /** 父级给出的额外阻拦原因（选区太小、存储不可用…）；空串表示没有。 */
  generateBlockedReason: string;
}>();

const emit = defineEmits<{
  "update:longSide": [number];
  "update:maxColors": [MaxColors];
  generate: [];
}>();

const draft = ref(String(props.longSide));

// 父级改值（从已有工程播种、或点了快捷值）时同步回输入框。
watch(
  () => props.longSide,
  (next) => {
    draft.value = String(next);
  },
);

const parsed = computed<number | null>(() => {
  const value = Number(draft.value);
  return Number.isInteger(value) && value >= MIN_LONG_SIDE && value <= MAX_LONG_SIDE ? value : null;
});

const longSideError = computed(() =>
  parsed.value === null ? `长边豆数要填 ${MIN_LONG_SIDE}–${MAX_LONG_SIDE} 之间的整数` : "",
);

function onLongSideInput(): void {
  if (parsed.value !== null) emit("update:longSide", parsed.value);
}

function pickPreset(value: number): void {
  draft.value = String(value);
  emit("update:longSide", value);
}

const summary = computed(() => {
  const value = parsed.value;
  if (value === null) return null;
  const oriented = rotatedSize(props.crop.width, props.crop.height, props.rotation);
  const grid = computeGridSize(oriented.width, oriented.height, value);
  const boards = boardCount(grid.width, grid.height);
  return {
    size: `${grid.width} × ${grid.height} 颗`,
    cm: `约 ${formatCm(beadsToCm(grid.width))} × ${formatCm(beadsToCm(grid.height))} 厘米`,
    boards: `需要 ${boards.cols} × ${boards.rows} = ${boards.total} 块板`,
  };
});

const splitHint = computed(() =>
  parsed.value !== null && parsed.value > SPLIT_HINT_LONG_SIDE
    ? `长边超过 ${SPLIT_HINT_LONG_SIDE} 颗，导出时会分片成多张图。`
    : "",
);

const blockedReason = computed(() => longSideError.value || props.generateBlockedReason);
const disabled = computed(() => props.busy || blockedReason.value !== "");

function onMaxColorsChange(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value;
  emit("update:maxColors", raw === "16" ? 16 : raw === "32" ? 32 : null);
}
</script>

<template>
  <section class="space-y-6">
    <label class="block text-lg text-slate-800">
      长边豆数
      <input
        v-model="draft"
        data-testid="long-side"
        type="number"
        inputmode="numeric"
        :min="MIN_LONG_SIDE"
        :max="MAX_LONG_SIDE"
        class="mt-2 block min-h-12 w-full rounded border border-slate-300 px-3 text-lg"
        @input="onLongSideInput"
      />
    </label>

    <div class="flex flex-wrap gap-3">
      <button
        v-for="n in LONG_SIDE_PRESETS"
        :key="n"
        :data-testid="`preset-${n}`"
        class="min-h-12 rounded border border-slate-300 px-4 text-base"
        @click="pickPreset(n)"
      >
        {{ n }} 颗
      </button>
    </div>

    <p v-if="splitHint" data-testid="split-hint" class="rounded bg-amber-50 p-3 text-base text-amber-800">
      {{ splitHint }}
    </p>

    <label class="block text-lg text-slate-800">
      用几种颜色
      <select
        data-testid="max-colors"
        class="mt-2 block min-h-12 w-full rounded border border-slate-300 px-3 text-lg"
        :value="maxColors === null ? '' : String(maxColors)"
        @change="onMaxColorsChange"
      >
        <option v-for="choice in MAX_COLOR_CHOICES" :key="choice.value" :value="choice.value">
          {{ choice.label }}
        </option>
      </select>
    </label>

    <div data-testid="palette-card" class="rounded border border-slate-200 bg-white p-4">
      <p class="text-lg font-semibold text-slate-900">{{ paletteName }}</p>
      <p class="mt-1 text-base text-slate-500">{{ paletteAccuracy }}</p>
    </div>

    <dl v-if="summary" data-testid="summary" class="space-y-1 rounded bg-slate-100 p-4 text-lg text-slate-800">
      <div>{{ summary.size }}</div>
      <div>{{ summary.cm }}</div>
      <div>{{ summary.boards }}</div>
    </dl>

    <button
      data-testid="generate"
      class="min-h-14 w-full rounded bg-slate-900 px-8 text-lg text-white disabled:opacity-50"
      :disabled="disabled"
      @click="emit('generate')"
    >
      {{ busy ? "正在生成…" : "生成图纸" }}
    </button>

    <p v-if="blockedReason" data-testid="blocked-reason" class="rounded bg-amber-50 p-3 text-base text-amber-800">
      {{ blockedReason }}
    </p>
  </section>
</template>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/components/param/__tests__/ParamPanel.test.ts`
预期：PASS（14 个用例）。

- [ ] **步骤 5：跑变异，报告精确形态**

| 变异 | 期望 |
|---|---|
| 摘要里不传 `rotation`（直接比 `crop.width/height`） | 「旋转 90° 后豆数换轴」转红 |
| `parsed` 里的范围校验改成只查 `< 1` | 501 / 2.5 两条转红 |
| `onMaxColorsChange` 的 `""` 分支改成 `0` | 「切到不限时 emit null」转红 |
| `disabled` 去掉 `blockedReason` | 「父级阻拦原因会禁用生成」与三条非法输入转红 |

- [ ] **步骤 6：Commit**

```bash
git add src/components/param/ParamPanel.vue src/components/param/__tests__/ParamPanel.test.ts
git commit -m "feat(app): 参数面板与尺寸摘要"
```

---

## 任务 10：选图页与路由（`views/PickPage.vue`、`router/index.ts`）

**文件：**
- 创建：`src/views/PickPage.vue`
- 测试：`src/views/__tests__/PickPage.test.ts`（新建）
- 修改：`src/router/index.ts`（`/new` 指向 `PickPage`，路由名 `generate` → `pick`；`/new/setup` 由任务 11 加）
- 修改：`src/views/LibraryPage.vue` 一行（新建按钮的 `name: "generate"` → `name: "pick"`）与其测试里对应的断言

> 同步 `LibraryPage.test.ts` 里那条断言属于**必要同步而不是放宽**：断言的语义（「点新建会进选图页」）
> 不变，只是目标路由名改了。报告里要写明改了哪一行。

- [ ] **步骤 1：编写失败的测试**

```ts
// src/views/__tests__/PickPage.test.ts
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraft } from "@/stores/draft";
import PickPage from "@/views/PickPage.vue";

const push = vi.fn();
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }));

/**
 * 成功路径靠**平台边界桩**跑通（真 `loadImageSource`、真 store、真几何）：
 * 换掉 `Image` / `URL` / `document.createElement`，断言落在「draft 落下什么」与「跳去哪」两个
 * 外部可观察量上。happy-dom 自己解码不了 blob URL（B1 构建记录 §4 第 4 条），这不是取巧。
 */
function stubPlatform(options: { width?: number; height?: number; decodeError?: string } = {}): void {
  const width = options.width ?? 800;
  const height = options.height ?? 600;
  class FakeImage {
    readonly naturalWidth = width;
    readonly naturalHeight = height;
    src = "";
    readonly decode = vi.fn(async () => {
      if (options.decodeError !== undefined) throw new Error(options.decodeError);
    });
  }
  const ctx = { drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() });
  stubCanvasFactory(() => ctx);
}

/**
 * 只把 `"canvas"` 换成假画布，其余 tag 走 happy-dom 的原实现。
 *
 * **不能整替 `document`**：`@vue/test-utils` 挂载组件本身就要用 `document.createElement`，
 * 整替之后用例会在挂载那一步就崩，而崩的原因与被测行为毫无关系。
 * `createElement` 的重载签名很严，实现体需要 `as typeof document.createElement` 转一次。
 */
function stubCanvasFactory(makeCtx: () => unknown): void {
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) =>
    tag === "canvas"
      ? ({ width: 0, height: 0, getContext: makeCtx } as unknown as HTMLElement)
      : original(tag, options)) as typeof document.createElement);
}

/** 造一个真 `<input type="file">` 并塞进选中的文件（照 imageSource.test.ts 的写法）。 */
async function pickFile(wrapper: ReturnType<typeof mount>, file: File): Promise<void> {
  const input = wrapper.get("[data-testid='file-input']").element as HTMLInputElement;
  const list = new FileList() as unknown as File[];
  list.push(file);
  input.files = list as unknown as FileList;
  await wrapper.get("[data-testid='pick-file']").trigger("click");
}

const FILE = new File([new Uint8Array([1, 2, 3, 4])], "小猫照片.png", { type: "image/png" });

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  push.mockClear();
});

describe("PickPage", () => {
  it("没选文件就点选图：给出提示，不跳转，草稿不动", async () => {
    stubPlatform();
    const wrapper = mount(PickPage);

    await wrapper.get("[data-testid='pick-file']").trigger("click");

    expect(wrapper.get("[data-testid='pick-error']").text()).toContain("请先选一张图片");
    expect(push).not.toHaveBeenCalled();
    expect(useDraft().source).toBeNull();
  });

  it("选好图后落进草稿（含原图尺寸与居中正方选区）并跳到选区页", async () => {
    stubPlatform({ width: 800, height: 600 });
    const wrapper = mount(PickPage);

    await pickFile(wrapper, FILE);

    const draft = useDraft();
    expect(draft.sourceSize).toEqual({ width: 800, height: 600 });
    expect(draft.source?.name).toBe("小猫照片.png");
    expect(draft.preview).not.toBeNull();
    expect(draft.crop).toEqual({ x: 100, y: 0, width: 600, height: 600 });
    expect(push).toHaveBeenCalledWith({ name: "setup" });
  });

  it("解码失败时把中文原因显示出来，不跳转、不留半截草稿", async () => {
    stubPlatform({ decodeError: "unsupported" });
    const wrapper = mount(PickPage);

    await pickFile(wrapper, FILE);

    expect(wrapper.get("[data-testid='pick-error']").text()).toContain("图片解码失败");
    expect(push).not.toHaveBeenCalled();
    expect(useDraft().source).toBeNull();
  });

  it("空文件被挡在解码之前（原因与 fileFromInput 同口径）", async () => {
    stubPlatform();
    const wrapper = mount(PickPage);

    await pickFile(wrapper, new File([], "empty.png", { type: "image/png" }));

    expect(wrapper.get("[data-testid='pick-error']").text()).toContain("这个文件是空的");
    expect(push).not.toHaveBeenCalled();
  });

  it("草稿里还有上次的图时，给一个「继续上次的选区」入口", async () => {
    stubPlatform();
    const draft = useDraft();
    draft.adoptImage({
      source: { blob: FILE, type: "image/png", name: "上次.png" },
      sourceSize: { width: 800, height: 600 },
      preview: { width: 800, height: 600 } as unknown as HTMLCanvasElement,
    });

    const wrapper = mount(PickPage);
    await wrapper.get("[data-testid='resume-draft']").trigger("click");

    expect(push).toHaveBeenCalledWith({ name: "setup" });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/views/__tests__/PickPage.test.ts`
预期：FAIL，`Failed to resolve import "@/views/PickPage.vue"`。

- [ ] **步骤 3：编写页面与路由**

```vue
<script setup lang="ts">
// src/views/PickPage.vue
//
// `/new`：向导第一步——选图。B2 只做浏览器文件选择；相机 / 系统相册 / 系统分享 target 是
// 真机能力（浏览器里无法验证），按 B1 规格 §2 的约定留到引入 Tauri 壳的那一轮。
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { fileFromInput, loadImageSource } from "@/services/imageSource";
import { useDraft } from "@/stores/draft";

const router = useRouter();
const draft = useDraft();
const fileInput = ref<HTMLInputElement | null>(null);
const error = ref("");
const busy = ref(false);

/** 草稿里还留着上次中途退出的图（选区页的 `onLeaveSetup` 只释放预览、保留 source）。 */
const canResume = computed(() => draft.source !== null);

async function pick(): Promise<void> {
  error.value = "";
  const picked = fileFromInput(fileInput.value);
  if (!picked.ok) {
    error.value = picked.reason;
    return;
  }

  busy.value = true;
  try {
    const loaded = await loadImageSource(picked.file);
    draft.adoptImage({
      source: { blob: loaded.blob, type: loaded.type, name: loaded.name },
      sourceSize: loaded.sourceSize,
      preview: loaded.preview,
    });
    await router.push({ name: "setup" });
  } catch (e) {
    // 失败时不落任何草稿：留下「有 source 没 preview」的半截状态会让选区页拿到空画布。
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function resume(): void {
  void router.push({ name: "setup" });
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <h1 class="text-3xl font-bold text-slate-900">新建图纸</h1>
    <p class="mt-2 text-lg text-slate-600">先选一张照片，下一步框出想拼的那块。</p>

    <section class="mt-6 space-y-6">
      <label class="block text-lg text-slate-800">
        选一张图片
        <input
          ref="fileInput"
          data-testid="file-input"
          type="file"
          accept="image/*"
          class="mt-2 block text-base"
        />
      </label>

      <button
        data-testid="pick-file"
        class="min-h-14 rounded bg-slate-900 px-8 text-lg text-white disabled:opacity-50"
        :disabled="busy"
        @click="pick"
      >
        {{ busy ? "正在读取…" : "下一步" }}
      </button>

      <button
        v-if="canResume"
        data-testid="resume-draft"
        class="ml-4 min-h-14 rounded border border-slate-300 px-8 text-lg"
        @click="resume"
      >
        继续上次的选区
      </button>
    </section>

    <p v-if="error" data-testid="pick-error" class="mt-4 rounded bg-amber-50 p-4 text-lg text-amber-800">
      {{ error }}
    </p>
  </main>
</template>
```

`src/router/index.ts` 改成：

```ts
import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: () => import("@/views/LibraryPage.vue") },
    // B2：向导第一步是选图（替换 B1 的临时生成入口 GeneratePage）。
    { path: "/new", name: "pick", component: () => import("@/views/PickPage.vue") },
    // B1 只到「载入并显示只读参数」；图纸预览与编辑是计划 B3。
    { path: "/edit/:id", name: "editor", component: () => import("@/views/EditorPage.vue") },
    { path: "/lab/decode", name: "decode-lab", component: () => import("@/views/DecodeLabPage.vue") },
  ],
});
```

`src/views/LibraryPage.vue` 的「新建图纸」按钮：`@click="router.push({ name: 'generate' })"` →
`@click="router.push({ name: 'pick' })"`；`src/views/__tests__/LibraryPage.test.ts` 里对应的 `push` 断言同步改成 `{ name: "pick" }`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/views/__tests__/PickPage.test.ts src/views/__tests__/LibraryPage.test.ts`
预期：两个文件全 PASS。

- [ ] **步骤 5：跑变异，报告精确形态**

| 变异 | 期望 |
|---|---|
| `pick()` 的 catch 里补一句 `draft.adoptImage(…)` 造半截草稿 | 「解码失败…不留半截草稿」转红 |
| `loadImageSource` 的返回值不传 `sourceSize` 给 `adoptImage` | 「落进草稿」转红 |
| 路由 `/new` 的名字改回 `generate` | LibraryPage 那条同步后的断言转红 |

- [ ] **步骤 6：Commit**

```bash
git add src/views/PickPage.vue src/views/__tests__/PickPage.test.ts src/router/index.ts src/views/LibraryPage.vue src/views/__tests__/LibraryPage.test.ts
git commit -m "feat(app): 选图页与向导路由"
```

---

## 任务 11：选区/参数/结果装配页（`views/SetupPage.vue`）

**这是 B2 的主交付物**：三个阶段、两种断点布局、生成与落盘、重跑覆盖、结果预览。

**文件：**
- 创建：`src/views/SetupPage.vue`
- 测试：`src/views/__tests__/SetupPage.test.ts`
- 修改：`src/router/index.ts`（加 `/new/setup`）
- 修改：`src/services/patternThumbnail.ts`（新增 `RESULT_PREVIEW_MAX_EDGE = 1024`，并把 JSDoc 改成两个消费者的口径）
- 修改：`src/core/pattern/stats.ts`（补「为何公开」JSDoc：B2 起在结果页被生产消费）

- [ ] **步骤 1：编写失败的测试**

```ts
// src/views/__tests__/SetupPage.test.ts
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { setProjectStore } from "@/services/projectStore";
import { useDraft } from "@/stores/draft";
import SetupPage from "@/views/SetupPage.vue";

const push = vi.fn();
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }));

const FILE = new File([new Uint8Array([1, 2, 3, 4])], "小猫照片.png", { type: "image/png" });

/** 假 2D 上下文：`drawImage` 记参数，`getImageData` 交回调用方指定的像素。 */
function makeCtx(pixels: Uint8ClampedArray) {
  return {
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
      width,
      height,
      data: pixels.length === width * height * 4 ? pixels : new Uint8ClampedArray(width * height * 4),
    })),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
  };
}

/**
 * 平台边界桩：真流水线、真几何、真 store、真 `toProjectDocument`。
 * `createImageBitmap` 的调用参数（源矩形）就是端到端用例 1 的断言对象。
 */
function stubPlatform(options: { alpha?: number } = {}) {
  const alpha = options.alpha ?? 255;
  const createBitmap = vi.fn(async (_source: Blob, sx: number, sy: number, sw: number, sh: number) => ({
    width: sw,
    height: sh,
    close: vi.fn(),
    region: [sx, sy, sw, sh],
  }));
  class FakeOffscreenCanvas {
    readonly width: number;
    readonly height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i += 1) {
        pixels[i * 4] = 200;
        pixels[i * 4 + 1] = 60;
        pixels[i * 4 + 2] = 60;
        pixels[i * 4 + 3] = alpha;
      }
      this.ctx = makeCtx(pixels);
    }
    readonly ctx: ReturnType<typeof makeCtx>;
    getContext(kind: string): ReturnType<typeof makeCtx> | null {
      return kind === "2d" ? this.ctx : null;
    }
  }
  class FakeImage {
    readonly naturalWidth = 800;
    readonly naturalHeight = 600;
    src = "";
    readonly decode = vi.fn(async () => {});
  }
  vi.stubGlobal("createImageBitmap", createBitmap);
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() });
  // 「重跑路径」那条用例会走真的 `loadImageSource`，它需要一个能拿到 2D 上下文的画布。
  // 只换 `"canvas"`，其余 tag 放行——`@vue/test-utils` 挂载组件还要用真 `document.createElement`。
  stubCanvasFactory(() => makeCtx(new Uint8ClampedArray(0)));
  return { createBitmap };
}

/** 见任务 10 的同名助手注释：只换 canvas，不整替 document。 */
function stubCanvasFactory(makeCtx: () => unknown): void {
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) =>
    tag === "canvas"
      ? ({ width: 0, height: 0, getContext: makeCtx } as unknown as HTMLElement)
      : original(tag, options)) as typeof document.createElement);
}

function fakePreview(): HTMLCanvasElement {
  return { width: 800, height: 600, getContext: () => makeCtx(new Uint8ClampedArray(0)) } as unknown as HTMLCanvasElement;
}

/** 选好图并落一份已知选区：端到端用例的固定起点。 */
function seedDraft(crop = { x: 200, y: 100, width: 400, height: 300 }) {
  const draft = useDraft();
  draft.adoptImage({
    source: { blob: FILE, type: "image/png", name: "小猫照片.png" },
    sourceSize: { width: 800, height: 600 },
    preview: fakePreview(),
  });
  draft.setCrop(crop);
  return draft;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  setProjectStore(await createMemoryProjectStore());
  window.innerWidth = 1024;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  push.mockClear();
  setProjectStore(null);
});

describe("入口守卫与准备阶段", () => {
  it("草稿里没有图时重定向回选图页，而不是拿 null 算几何", async () => {
    stubPlatform();
    mount(SetupPage);
    await flushPromises();

    expect(push).toHaveBeenCalledWith({ name: "pick" });
  });

  it("重跑路径（有 source 无预览）在挂载时解码并补上原图尺寸，选区按旧参数还原", async () => {
    stubPlatform();
    const draft = useDraft();
    draft.adoptProject({
      source: { blob: FILE, type: "image/png", name: "旧图.png" },
      params: { longSide: 116, maxColors: null, crop: { x: 3, y: 5, width: 400, height: 200 }, rotation: 3 },
      meta: { id: "p1", name: "小猫", createdAt: "2026-10-01T00:00:00.000Z" },
    });

    const wrapper = mount(SetupPage);
    await flushPromises();

    expect(draft.sourceSize).toEqual({ width: 800, height: 600 });
    expect(draft.preview).not.toBeNull();
    expect(draft.crop).toEqual({ x: 3, y: 5, width: 400, height: 200 });
    expect(wrapper.find("[data-testid='crop-canvas']").exists()).toBe(true);
  });
});

describe("断点布局", () => {
  it("平板（≥768px）同时显示选区与参数两栏", async () => {
    stubPlatform();
    seedDraft();
    window.innerWidth = 1024;

    const wrapper = mount(SetupPage);
    await flushPromises();

    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(true);
  });

  it("手机（<768px）只显示当前阶段，点下一步才进参数", async () => {
    stubPlatform();
    seedDraft();
    window.innerWidth = 500;

    const wrapper = mount(SetupPage);
    await flushPromises();

    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(false);

    await wrapper.get("[data-testid='to-params']").trigger("click");
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(false);
  });
});

describe("端到端 1：屏幕 → 原图 → 落盘（承重）", () => {
  it("用户选的选框就是交给解码器的源矩形，参数按落盘字段搬位，摘要豆数与成品一致", async () => {
    const { createBitmap } = stubPlatform();
    const draft = seedDraft({ x: 200, y: 100, width: 400, height: 300 });
    draft.setRotation(1);
    draft.setLongSide(58);

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    // ① 交给平台的源矩形 = 用户选的选框（旋转**不**改动 crop）
    expect(createBitmap.mock.calls[0]?.slice(0, 5)).toEqual([FILE, 200, 100, 400, 300]);

    // ② 落盘字段搬位正确（crop.w/h/rotate）
    const store = (await import("@/services/projectStore")).getProjectStore();
    const metas = await store.list();
    expect(metas).toHaveLength(1);
    const record = await store.get(metas[0]!.id);
    expect(record?.doc.params).toEqual({
      longSide: 58,
      maxColors: 32,
      crop: { x: 200, y: 100, w: 400, h: 300, rotate: 1 },
    });

    // ③ 摘要豆数 = 成品尺寸：rotation 1 → 朝向 300×400 → 长边 58 → 44×58
    expect(record?.doc.width).toBe(44);
    expect(record?.doc.height).toBe(58);
    expect(wrapper.get("[data-testid='summary']").text()).toContain("44 × 58 颗");
  });
});

describe("端到端 2：就地重跑覆盖同一条记录", () => {
  it("id / 名称 / createdAt 不变，updatedAt 变，参数是新的", async () => {
    stubPlatform();
    const draft = seedDraft();
    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    const store = (await import("@/services/projectStore")).getProjectStore();
    const first = (await store.list())[0]!;

    draft.setLongSide(116);
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    const metas = await store.list();
    expect(metas).toHaveLength(1);
    const second = metas[0]!;
    expect(second.id).toBe(first.id);
    expect(second.name).toBe(first.name);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt >= first.updatedAt).toBe(true);
    expect((await store.get(second.id))?.doc.params.longSide).toBe(116);
  });

  it("档位三档落盘分别是 16 / 32 / null（B1 的三条断言在这里的新家）", async () => {
    stubPlatform();
    const draft = seedDraft();
    const wrapper = mount(SetupPage);
    await flushPromises();
    const store = (await import("@/services/projectStore")).getProjectStore();

    for (const [choice, expected] of [["16", 16], ["32", 32], ["", null]] as const) {
      await wrapper.get("[data-testid='max-colors']").setValue(choice);
      await wrapper.get("[data-testid='generate']").trigger("click");
      await flushPromises();
      const id = (await store.list())[0]!.id;
      expect((await store.get(id))?.doc.params.maxColors).toBe(expected);
    }
  });
});

describe("生成前的门槛与失败路径", () => {
  it("选区太小（每格分不到一个源像素）时阻止生成并给可操作的原因", async () => {
    const { createBitmap } = stubPlatform();
    seedDraft({ x: 0, y: 0, width: 50, height: 50 });

    const wrapper = mount(SetupPage);
    await flushPromises();

    expect(wrapper.get("[data-testid='blocked-reason']").text()).toContain("选区 50 × 50 像素");
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(createBitmap).not.toHaveBeenCalled();
    expect(await (await import("@/services/projectStore")).getProjectStore().list()).toHaveLength(0);
  });

  it("整图全透明时提示「没有可拼的像素」，不落盘", async () => {
    stubPlatform({ alpha: 0 });
    seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-testid='setup-error']").text()).toContain("没有可拼的像素");
    const store = (await import("@/services/projectStore")).getProjectStore();
    expect(await store.list()).toHaveLength(0);
  });

  it("选区大于源图时流水线响亮拒绝（第二道防线真的在）", async () => {
    stubPlatform();
    const draft = seedDraft();
    // 绕过 store 的夹取，直接把越界 crop 塞进去：模拟「组件有 bug」这一情形。
    (draft as unknown as { crop: { value: unknown } }).crop.value = { x: 700, y: 500, width: 400, height: 400 };

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-testid='setup-error']").text()).toContain("超出原图范围");
  });
});

describe("结果阶段", () => {
  it("生成后显示豆图预览、用色数与「已更新这张图纸」", async () => {
    stubPlatform();
    seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-testid='result-pane']").text()).toContain("已更新这张图纸");
    expect(wrapper.find("[data-testid='result-preview']").exists()).toBe(true);
    expect(wrapper.get("[data-testid='result-stats']").text()).toContain("实际用了");
  });

  it("离开页面时草稿按 §9 的规则处理（已生成 → 清空）", async () => {
    stubPlatform();
    const draft = seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();
    wrapper.unmount();

    expect(draft.source).toBeNull();
    expect(draft.preview).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/views/__tests__/SetupPage.test.ts`
预期：FAIL，`Failed to resolve import "@/views/SetupPage.vue"`。

- [ ] **步骤 3：给 `services/patternThumbnail.ts` 加结果预览上限**

```ts
/**
 * 结果页预览的长边上限（像素）。
 *
 * 比列表封面（512）大：500×500 的图纸在 512 下每格只有 1px，看不出轮廓；1024 给它 2px。
 * 代价（1024² 画布 + PNG 编码）记在规格 §14 的 B2-R4，属真机人工量的项。
 */
export const RESULT_PREVIEW_MAX_EDGE = 1024;
```

并把该函数 JSDoc 的第一句改成两个消费者的口径：列表封面（`THUMBNAIL_MAX_EDGE`）与生成结果预览
（`RESULT_PREVIEW_MAX_EDGE`），说明「最近邻 + 空格透明」对两者都成立。

- [ ] **步骤 4：编写页面**

```vue
<script setup lang="ts">
// src/views/SetupPage.vue
//
// `/new/setup`：选区 → 参数 → 结果，三个阶段一个页面。断点**只决定布局**（平板左右分栏 /
// 手机单栏分步），行为不分叉——这是设计评审时选定的路线 2（规格 §4.5）。
//
// 生成即落盘，重跑覆盖同一条记录：走 `useProjectSession().adopt()` + `save()`，
// 它是 B1 规格 §4.4 那个会话模型的第一个生产消费者。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { isCropResolvable } from "@/core/crop/rect";
import { orientedSizeOf } from "@/core/crop/view";
import { computeGridSize } from "@/core/pattern/build";
import { patternStats } from "@/core/pattern/stats";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import CropCanvas from "@/components/crop/CropCanvas.vue";
import ParamPanel from "@/components/param/ParamPanel.vue";
import { createDomBitmapPlatform, createExactDecoder, createFastDecoder } from "@/services/decoders";
import { loadImageSource } from "@/services/imageSource";
import { getBuiltinPalette } from "@/services/palette";
import { RESULT_PREVIEW_MAX_EDGE, renderPatternThumbnail } from "@/services/patternThumbnail";
import { generatePattern } from "@/services/pipeline";
import { defaultProjectName, getProjectStore, type ProjectMeta } from "@/services/projectStore";
import { useDraft } from "@/stores/draft";
import { useProjectSession } from "@/stores/project";

const router = useRouter();
const draft = useDraft();
const session = useProjectSession();

const storeError = ref("");
const preparing = ref(false);
const isWide = ref(false);
let media: MediaQueryList | null = null;

/** 工具条的选项常量：**不在模板里写 `as` 断言或 `as const`**，那在模板表达式里不可靠。 */
const ASPECT_OPTIONS: readonly { readonly value: AspectLock; readonly label: string }[] = [
  { value: "free", label: "自由" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "9:16", label: "9:16" },
];
const ZOOM_OPTIONS: readonly ZoomLevel[] = ["fit", 2, 4];

const palette = getBuiltinPalette();

/** 三个阶段各自的可见性：平板两栏常驻（结果阶段左栏换成结果、**右栏参数仍在**，可直接重跑），
 *  手机一次只显示一屏。 */
const showCanvas = computed(() => draft.stage === "crop" && draft.preview !== null);
const showParams = computed(() => (isWide.value ? true : draft.stage === "params"));
const showResult = computed(() => draft.stage === "result" && session.pattern !== null);

const grid = computed(() => {
  if (draft.sourceSize === null || draft.crop === null) return null;
  const oriented = orientedSizeOf(draft.sourceSize, draft.rotation);
  return computeGridSize(oriented.width, oriented.height, draft.longSide);
});

/** 生成按钮的额外阻拦原因（空串 = 没有）。长边是否非法由面板自己判断。 */
const blockedReason = computed(() => {
  if (draft.sourceSize === null || draft.crop === null || grid.value === null) return "还没有选好图";
  if (!isCropResolvable(draft.crop, grid.value, draft.rotation)) {
    const oriented = orientedSizeOf(draft.sourceSize, draft.rotation);
    return `选区 ${Math.round(oriented.width)} × ${Math.round(oriented.height)} 像素要拼 ${grid.value.width} × ${grid.value.height} 颗豆，请放大选区或减小长边`;
  }
  if (storeError.value !== "") return storeError.value;
  return "";
});

const resultImage = computed(() =>
  session.pattern === null ? "" : renderPatternThumbnail(session.pattern, palette, RESULT_PREVIEW_MAX_EDGE),
);

const resultStats = computed(() =>
  session.pattern === null ? null : patternStats(session.pattern, palette),
);

function onMediaChange(event: MediaQueryListEvent): void {
  isWide.value = event.matches;
}

onMounted(async () => {
  // 存储未注入时不静默禁用：这一页唯一的写操作就是落盘，说清原因比让用户白跑一遍强。
  try {
    getProjectStore();
  } catch (e) {
    storeError.value = e instanceof Error ? e.message : String(e);
  }

  media = window.matchMedia("(min-width: 768px)");
  isWide.value = media.matches;
  media.addEventListener("change", onMediaChange);

  if (draft.source === null) {
    await router.push({ name: "pick" });
    return;
  }

  // 重跑路径：草稿里有原图但预览要现解码（编辑器里不重复这段逻辑，见规格 §7）。
  if (draft.preview === null) {
    preparing.value = true;
    try {
      const loaded = await loadImageSource(
        new File([draft.source.blob], draft.source.name, { type: draft.source.type }),
      );
      draft.setSourceSize(loaded.sourceSize);
      draft.setPreview(loaded.preview);
    } catch (e) {
      draft.setError(e instanceof Error ? e.message : String(e));
    } finally {
      preparing.value = false;
    }
  }
});

onBeforeUnmount(() => {
  media?.removeEventListener("change", onMediaChange);
  media = null;
  // 规格 §9：已生成且此后无改动 → 整份草稿作废；中途退出 → 只释放预览，选区与参数留着。
  draft.onLeaveSetup();
});

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function generate(): Promise<void> {
  const source = draft.source;
  const sourceSize = draft.sourceSize;
  const crop = draft.crop;
  if (source === null || sourceSize === null || crop === null) {
    draft.setError("还没有选好图");
    return;
  }

  draft.setError("");
  draft.setBusy(true);
  try {
    const platform = createDomBitmapPlatform();
    const pattern = await generatePattern(
      {
        source: source.blob,
        sourceSize,
        crop,
        rotation: draft.rotation,
        longSide: draft.longSide,
        maxColors: draft.maxColors,
      },
      {
        exactDecoder: createExactDecoder(platform),
        fastDecoder: createFastDecoder(platform),
        palette,
      },
    );

    // 全透明 / 整图低于空格判定阈值 → 一个实心格都没有。进库只会在图纸库里留下一张点开
    // 什么都没有的工程，所以在写任何东西之前就响亮拒绝（B1 的既有处置，迁到这里）。
    if (!pattern.cells.some((value) => value !== EMPTY)) {
      draft.setError("这张图没有可拼的像素，换一张试试");
      return;
    }

    const thumbnail = renderPatternThumbnail(pattern, palette);
    const now = new Date().toISOString();
    const target = draft.rerunOf;
    const meta: ProjectMeta = {
      id: target?.id ?? createId(),
      name: target?.name ?? defaultProjectName(source.name),
      createdAt: target?.createdAt ?? now,
      updatedAt: now,
      thumbnail,
      // width / height / colorCount 由存储层从 doc 派生（put 会覆盖），这里刻意不自己算一份。
      width: 0,
      height: 0,
      colorCount: 0,
    };

    session.adopt(
      pattern,
      {
        longSide: draft.longSide,
        maxColors: draft.maxColors,
        crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
        rotation: draft.rotation,
      },
      meta,
      { blob: source.blob, type: source.type },
      toProjectDocument(pattern, palette, {
        longSide: draft.longSide,
        maxColors: draft.maxColors,
        crop: { x: crop.x, y: crop.y, w: crop.width, h: crop.height, rotate: draft.rotation },
      }),
    );

    const saved = await session.save();
    draft.markGenerated();
    if (!saved) {
      // 保存失败不丢态：图纸还在内存里，结果照常显示，给用户一条重试的路（主规格 §8）。
      draft.setError(`图纸已生成，但保存失败：${session.error}`);
    }
  } catch (e) {
    draft.setError(e instanceof Error ? e.message : String(e));
  } finally {
    draft.setBusy(false);
  }
}

async function retrySave(): Promise<void> {
  if (await session.save()) draft.setError("");
}

function rotate(): void {
  draft.setRotation(((draft.rotation + 1) % 4) as 0 | 1 | 2 | 3);
}

function resetCrop(): void {
  if (draft.sourceSize === null) return;
  draft.setAspect("free");
  draft.setCrop({
    x: Math.round((draft.sourceSize.width - Math.min(draft.sourceSize.width, draft.sourceSize.height)) / 2),
    y: Math.round((draft.sourceSize.height - Math.min(draft.sourceSize.width, draft.sourceSize.height)) / 2),
    width: Math.min(draft.sourceSize.width, draft.sourceSize.height),
    height: Math.min(draft.sourceSize.width, draft.sourceSize.height),
  });
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-6">
    <header class="flex flex-wrap items-center justify-between gap-4">
      <h1 class="text-2xl font-bold text-slate-900">
        {{ draft.stage === "result" ? "生成结果" : "框出想拼的那块" }}
      </h1>
      <button class="min-h-12 rounded border border-slate-300 px-4 text-base" @click="router.push({ name: 'home' })">
        回图纸库
      </button>
    </header>

    <p v-if="storeError" class="mt-4 rounded bg-red-50 p-4 text-lg text-red-700">
      工程存储不可用：{{ storeError }}
    </p>
    <p v-if="preparing" class="mt-4 text-lg text-slate-500">正在准备预览…</p>

    <div :class="isWide ? 'mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]' : 'mt-6 space-y-6'">
      <section v-if="showCanvas" data-testid="crop-pane" class="rounded bg-white p-3 shadow">
        <div class="h-[55vh] min-h-64">
          <CropCanvas
            v-if="draft.preview !== null && draft.crop !== null && draft.sourceSize !== null"
            :preview="draft.preview"
            :source-size="draft.sourceSize"
            :crop="draft.crop"
            :rotation="draft.rotation"
            :aspect="draft.aspect"
            :zoom="draft.zoom"
            :pan="draft.pan"
            @update:crop="draft.setCrop($event)"
            @update:pan="draft.setPan($event)"
          />
        </div>

        <div class="mt-3 flex flex-wrap gap-2">
          <button
            v-for="option in ASPECT_OPTIONS"
            :key="option.value"
            :data-testid="`aspect-${option.value}`"
            class="min-h-12 rounded border px-4 text-base"
            :class="draft.aspect === option.value ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300'"
            @click="draft.setAspect(option.value)"
          >
            {{ option.label }}
          </button>
          <button data-testid="rotate" class="min-h-12 rounded border border-slate-300 px-4 text-base" @click="rotate">
            旋转 90°
          </button>
          <button
            v-for="level in ZOOM_OPTIONS"
            :key="String(level)"
            :data-testid="`zoom-${String(level)}`"
            class="min-h-12 rounded border px-4 text-base"
            :class="draft.zoom === level ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300'"
            @click="draft.setZoom(level)"
          >
            {{ level === "fit" ? "适配" : `${level}×` }}
          </button>
          <button data-testid="reset-crop" class="min-h-12 rounded border border-slate-300 px-4 text-base" @click="resetCrop">
            重置选区
          </button>
        </div>
      </section>

      <section v-if="showResult" data-testid="result-pane" class="rounded bg-white p-4 shadow">
        <img v-if="resultImage" data-testid="result-preview" :src="resultImage" alt="" class="w-full rounded bg-slate-100" />
        <p class="mt-3 text-lg font-semibold text-slate-900">已更新这张图纸</p>
        <p v-if="resultStats" data-testid="result-stats" class="mt-1 text-base text-slate-600">
          实际用了 {{ resultStats.colorCount }} 种颜色，共 {{ resultStats.total }} 颗豆
        </p>
        <div class="mt-4 flex flex-wrap gap-3">
          <button
            v-if="!isWide"
            data-testid="back-to-params"
            class="min-h-12 rounded border border-slate-300 px-4 text-base"
            @click="draft.setStage('params')"
          >
            改参数
          </button>
          <button
            data-testid="open-editor"
            class="min-h-12 rounded bg-slate-900 px-4 text-base text-white"
            @click="router.push({ name: 'editor', params: { id: session.record?.meta.id ?? '' } })"
          >
            去编辑
          </button>
        </div>
      </section>

      <section v-if="showParams" data-testid="param-pane" class="rounded bg-white p-4 shadow">
        <ParamPanel
          v-if="draft.crop !== null"
          :long-side="draft.longSide"
          :max-colors="draft.maxColors"
          :crop="draft.crop"
          :rotation="draft.rotation"
          :palette-name="palette.name"
          :palette-accuracy="palette.accuracy"
          :busy="draft.busy"
          :generate-blocked-reason="blockedReason"
          @update:long-side="draft.setLongSide($event)"
          @update:max-colors="draft.setMaxColors($event)"
          @generate="generate"
        />
      </section>
    </div>

    <div v-if="!isWide" class="mt-6 flex gap-3">
      <button
        v-if="draft.stage === 'crop'"
        data-testid="to-params"
        class="min-h-14 flex-1 rounded bg-slate-900 text-lg text-white"
        @click="draft.setStage('params')"
      >
        下一步
      </button>
      <button
        v-if="draft.stage === 'params'"
        data-testid="back-to-crop"
        class="min-h-14 rounded border border-slate-300 px-6 text-lg"
        @click="draft.setStage('crop')"
      >
        上一步
      </button>
    </div>

    <p v-if="draft.error" data-testid="setup-error" class="mt-4 rounded bg-amber-50 p-4 text-lg text-amber-800">
      {{ draft.error }}
    </p>
    <button
      v-if="draft.error.includes('保存失败')"
      data-testid="retry-save"
      class="mt-3 min-h-12 rounded border border-slate-300 px-4 text-base"
      @click="retrySave"
    >
      重试保存
    </button>
  </main>
</template>
```

`src/router/index.ts` 加一行：

```ts
    { path: "/new/setup", name: "setup", component: () => import("@/views/SetupPage.vue") },
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npm run test -- src/views/__tests__/SetupPage.test.ts`
预期：PASS（12 个用例）。若端到端 1 的 44×58 与你的推算不同，**先写出推算过程再决定改代码还是改期望**。

- [ ] **步骤 6：跑变异，报告精确形态**

| 变异 | 期望 |
|---|---|
| `generate()` 里 `crop` 换成 `{ x: 0, y: 0, ...crop }` | 端到端 1 转红（源矩形与落盘 crop 同时变） |
| `session.adopt` 的 `meta.id` 每次都用 `createId()` | 端到端 2 转红（id 变了） |
| 去掉 `pattern.cells.some(...)` 的全空格检查 | 「全透明图不落盘」转红 |
| `showParams` 的断点分支去掉 `isWide` | 手机断点那条转红 |
| `blockedReason` 里去掉 `isCropResolvable` | 「选区太小」转红 |

- [ ] **步骤 7：Commit**

```bash
git add src/views/SetupPage.vue src/views/__tests__/SetupPage.test.ts src/router/index.ts src/services/patternThumbnail.ts src/core/pattern/stats.ts
git commit -m "feat(app): 选区/参数/结果装配页，生成即落盘并支持就地重跑"
```

---

## 任务 12：编辑器里的「改参数重新生成」入口（`views/EditorPage.vue`）

**文件：**
- 修改：`src/views/EditorPage.vue`
- 修改：`src/views/__tests__/EditorPage.test.ts`（**追加**用例，既有断言不动）

- [ ] **步骤 1：编写失败的测试**

在 `EditorPage.test.ts` 末尾追加（沿用该文件既有的存储注入与夹具写法；夹具必须带上 `source`）：

```ts
describe("改参数重新生成（B2 规格 §7）", () => {
  it("原图已保存时给出入口，点它把参数播种进草稿并跳到选区页", async () => {
    // 夹具：source 非 null、params 已落盘（沿用本文件既有夹具 + source）
    // …（按本文件既有的 makeRecord / setProjectStore 写法构造，然后：）
    const wrapper = mount(EditorPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get("[data-testid='rerun']").trigger("click");

    const draft = useDraft();
    expect(draft.rerunOf).toEqual({ id: record.meta.id, name: record.meta.name, createdAt: record.meta.createdAt });
    expect(draft.longSide).toBe(record.doc.params.longSide);
    expect(draft.maxColors).toBe(record.doc.params.maxColors);
    expect(draft.rotation).toBe(record.doc.params.crop.rotate);
    // 原图尺寸要等 SetupPage 解码，所以此刻草稿里还没有 sourceSize / crop
    expect(draft.sourceSize).toBeNull();
    expect(draft.crop).toBeNull();
    expect(push).toHaveBeenCalledWith({ name: "setup" });
  });

  it("没有保存原图的工程不给出入口（维持既有的琥珀提示）", async () => {
    // 夹具：source = null
    const wrapper = mount(EditorPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.find("[data-testid='rerun']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='rerun-unavailable']").text()).toContain("没有保存原图");
  });
});
```

> 该文件的既有夹具可能没有 `source` 字段，或没有 mock `vue-router`。实现者按文件现状补齐**夹具**即可——
> 夹具改动不算改断言，但要在报告里列出来（B1 的教训：夹具改了却没说，会让「哪些断言真的被跑过」无从判断）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/views/__tests__/EditorPage.test.ts`
预期：新增两条 FAIL（`rerun` 按钮不存在），既有用例 PASS。

- [ ] **步骤 3：实现**

在 `EditorPage.vue` 的 `<script setup>` 里加：

```ts
import { useRouter } from "vue-router";
import { useDraft } from "@/stores/draft";

const router = useRouter();
const draft = useDraft();

/**
 * 把当前工程的参数播种进向导草稿，然后交给 `SetupPage`。
 *
 * **只播种、不解码**：原图尺寸与预览位图在 `SetupPage` 挂载时统一解码——同一段解码逻辑
 * 出现在两处正是本项目最贵的缺陷形态（「两端各自正确、错在接线」）。
 */
function rerun(): void {
  const record = session.record;
  if (record === null || record.source === null || session.params === null) return;
  draft.adoptProject({
    source: { blob: record.source.blob, type: record.source.type, name: record.meta.name },
    params: {
      longSide: session.params.longSide,
      maxColors: session.params.maxColors,
      crop: session.params.crop,
      rotation: session.params.rotation,
    },
    meta: { id: record.meta.id, name: record.meta.name, createdAt: record.meta.createdAt },
  });
  void router.push({ name: "setup" });
}
```

模板里、`data-testid="rerun-available"` 那段之后加：

```html
      <button
        v-if="session.record.source"
        data-testid="rerun"
        class="mt-3 min-h-14 rounded bg-slate-900 px-6 text-lg text-white"
        @click="rerun"
      >
        改参数重新生成
      </button>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/views/__tests__/EditorPage.test.ts`
预期：PASS。

- [ ] **步骤 5：跑变异，报告精确形态**

| 变异 | 期望 |
|---|---|
| `rerun()` 里把 `params.rotation` 写成 `0` | 播种那条转红（rotation 取自 `crop.rotate`） |
| `meta` 传成新 id | 播种那条转红 |
| `v-if` 改成永远渲染 | 「没有原图不给出入口」转红 |

- [ ] **步骤 6：Commit**

```bash
git add src/views/EditorPage.vue src/views/__tests__/EditorPage.test.ts
git commit -m "feat(app): 编辑器加改参数重新生成的入口"
```

---

## 任务 13：图纸库的错误语义拆分（`views/LibraryPage.vue`）

**闭合 B1-7 与 B1-17。**

**文件：**
- 修改：`src/views/LibraryPage.vue`
- 修改：`src/views/__tests__/LibraryPage.test.ts`（追加用例；既有断言按语义同步，不放宽）

- [ ] **步骤 1：编写失败的测试**

在 `LibraryPage.test.ts` 末尾追加：

```ts
describe("存储失败的两种语义（B2 规格 §8）", () => {
  it("未注入存储：给出「不允许本地保存」并禁用新建", async () => {
    setProjectStore(null);
    const wrapper = mount(LibraryPage);
    await flushPromises();

    expect(wrapper.get("[data-testid='store-unavailable']").text()).toContain("不允许本地保存");
    expect(wrapper.get("[data-testid='new-project']").attributes("disabled")).toBeDefined();
  });

  it("库打不开（list 抛错）：显示原因并**禁用新建**——否则用户会白走一遍选图与生成", async () => {
    setProjectStore({
      list: async () => {
        throw new Error("库打不开");
      },
      get: async () => null,
      put: async () => {},
      remove: async () => {},
      rename: async () => {
        throw new Error("unused");
      },
      estimateUsage: async () => null,
    });

    const wrapper = mount(LibraryPage);
    await flushPromises();

    expect(wrapper.get("[data-testid='store-unavailable']").text()).toContain("库打不开");
    expect(wrapper.get("[data-testid='new-project']").attributes("disabled")).toBeDefined();
  });

  // 这条正是 B1-17：只有占用读不出来时，列表与新建都必须照常。
  it("只有 estimateUsage 失败：列表正常、占用行消失、新建**不**禁用", async () => {
    const store = await createMemoryProjectStore();
    await store.put(makeRecord("p1", "小猫"));
    setProjectStore({
      ...store,
      list: store.list.bind(store),
      get: store.get.bind(store),
      put: store.put.bind(store),
      remove: store.remove.bind(store),
      rename: store.rename.bind(store),
      estimateUsage: async () => {
        throw new Error("读不到占用");
      },
    });

    const wrapper = mount(LibraryPage);
    await flushPromises();

    expect(wrapper.findAll("[data-testid='project-card']")).toHaveLength(1);
    expect(wrapper.text()).not.toContain("已用");
    expect(wrapper.get("[data-testid='new-project']").attributes("disabled")).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/views/__tests__/LibraryPage.test.ts`
预期：「库打不开」与「只有 estimateUsage 失败」两条 FAIL（现状把两种失败混在一起、且共用一个 `try`）。

- [ ] **步骤 3：实现**

`LibraryPage.vue` 的 `refresh()` 改成：

```ts
async function refresh(): Promise<void> {
  error.value = "";
  storeUnavailable.value = false;

  // ① 未注入：装配错误（main.ts 在挂载前注入，生产不可达）。真实失败都发生在首次使用。
  let store: ProjectStore;
  try {
    store = getProjectStore();
  } catch (e) {
    storeUnavailable.value = true;
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }

  // ② 库打不开（隐私模式 / 配额 / 陈旧库缺 object store）：**也禁用新建**。
  //    不禁用的话用户会一路走到生成页的 put 才看到原始报错，白跑一遍选图 + 选区 + 生成
  //    （B1-7 的实测教训）。
  try {
    projects.value = await store.list();
  } catch (e) {
    storeUnavailable.value = true;
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }

  // ③ 占用读不出来只是少一行字：单独一个 try，不影响列表与新建（闭合 B1-17）。
  try {
    usage.value = await store.estimateUsage();
  } catch {
    usage.value = null;
  }
}
```

模板把「未注入」与「库打不开」两种文案都绑到同一个 `store-unavailable` 块上：

```html
    <p v-if="storeUnavailable" data-testid="store-unavailable" class="mt-4 rounded bg-red-50 p-4 text-lg text-red-700">
      本地图纸库现在打不开（{{ error }}）。在它恢复之前，新建图纸也没法保存，所以先别开工；
      隐私模式下请换用普通窗口。
    </p>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/views/__tests__/LibraryPage.test.ts`
预期：PASS。既有那条「未注入」用例若断言了旧文案，按语义同步（判别力不变：仍然是「给原因 + 禁用新建」）。

- [ ] **步骤 5：跑变异，报告精确形态**

| 变异 | 期望 |
|---|---|
| 把 ② 的 `storeUnavailable.value = true` 删掉 | 「库打不开…禁用新建」转红 |
| 把 ③ 合并回 ② 的 try | 「只有 estimateUsage 失败」转红 |

- [ ] **步骤 6：Commit**

```bash
git add src/views/LibraryPage.vue src/views/__tests__/LibraryPage.test.ts
git commit -m "fix(app): 区分存储未注入与库打不开，占用失败不再拖累列表"
```

---

## 任务 14：删除临时入口、回写文档、全量验证

**这是收尾任务，也是唯一允许删文件的任务（已获人类伙伴批准，见规格 §3）。**

**文件：**
- 删除：`src/views/GeneratePage.vue`、`src/views/__tests__/GeneratePage.test.ts`
- 修改：`README.md`（进度、延后项表、目录结构、文档链接）
- 修改：`docs/superpowers/specs/2026-10-03-app-b2-crop-settings-design.md`（状态：待实现 → 已实现）
- 修改：`docs/superpowers/specs/2026-10-03-app-skeleton-design.md`（§1 的拆分表里给 B2 标「已实现」并链到 B2 规格/构建记录）

- [ ] **步骤 1：逐条核对断言迁移表（不许跳过）**

计划开头那张表里 9 条断言，逐条跑一次命令确认新家存在且绿：

```bash
npm run test -- src/services/__tests__/projectStore.test.ts      # defaultProjectName 夹 100 字
npm run test -- src/views/__tests__/PickPage.test.ts             # 没选图提示 / 解码失败提示
npm run test -- src/views/__tests__/SetupPage.test.ts            # 存储不可用、全空格、长边、三档落盘、源矩形
npm run test -- src/core/crop/__tests__/rect.test.ts             # 换轴
npm run test -- src/core/crop/__tests__/view.test.ts             # 换轴
```

**任何一条找不到新家，就不许删 `GeneratePage.test.ts`**——先补上再删。

- [ ] **步骤 2：删除文件**

```bash
git rm src/views/GeneratePage.vue src/views/__tests__/GeneratePage.test.ts
```

- [ ] **步骤 3：确认没有别处引用它**

```bash
grep -rn "GeneratePage" src/ docs/ README.md
```
预期：只剩文档里「B1 的临时入口已被 B2 替换」这类历史叙述，`src/` 零命中。若有引用（例如路由表残留），一并清掉。

- [ ] **步骤 4：回写 README**

- 「当前进度」：把 `/new` 那段从「临时入口」改写成选图 + 选区（拖动 / 缩放 / 锁比例 / 旋转 / 缩放档位）+ 参数 + 结果预览，`/new/setup`；说明生成即落盘、重跑覆盖同一条记录、平板分栏 / 手机单栏。
- 「已知限制与延后项」：B1-4 / B1-7 / B1-9 / B1-12 / B1-13 / B1-17 逐条标注**已在 B2 闭环**（不删行，保留历史）+ 新增 B2 自己的延后项（捏合缩放、生成进度与取消、选区页撤销、`probeSourceSize` 无消费者）。
- 「目录结构」：补 `src/core/crop/`、`src/components/`、`src/stores/draft.ts`。
- 「文档」：补 B2 规格与本计划的链接。
- 测试计数：**回原始清单重数**（`npm run test` 输出里的文件数 / 用例数），不引用任何汇总行。

- [ ] **步骤 5：全量验证**

```bash
npm run test          # 全量，新增 + 既有全绿；记录文件数与用例数
TZ=UTC npm run test   # 与 CI 同环境
npm run build         # vue-tsc --noEmit + Vite 构建
npm run dev           # 浏览器人工走一遍（见步骤 6）
```

- [ ] **步骤 6：浏览器人工清单（单测覆盖不到的部分，逐条过）**

1. 选一张 4000×3000 的真实照片 → 选区页出现预览，不卡。
2. 拖四角手柄、拖选框、锁 1:1 / 4:3 / 9:16（含旋转 90° 后再锁，确认框的形状是**屏幕上看到的比例**）。
3. 旋转 90°：确认选框跟着图像内容转（选中的内容不变）。
4. 缩放档位 适配 / 2× / 4×：切档位时画面不跳；2× / 4× 下能拖动平移，且拖到边界就停住（不出现空白）。
5. 长边改 58 / 300 / 400：>300 出现分片提示；改完摘要立即更新。
6. 生成 → 结果预览出现，尺寸与摘要一致；改长边再生成 → 确认**没有新增第二条记录**（回图纸库只有一条）。
7. 去编辑 → 点「改参数重新生成」→ 回到选区页，**旧选区被还原**；再生成 → 仍是同一条记录。
8. 浏览器窗口从宽拖到窄（断点切换）：阶段状态不丢（选区 / 参数 / 结果都还在）。
9. DPR 检查：在 200% 缩放的窗口里看预览是否发虚。
10. 把长边改成 400 生成一次 400×300 的图纸，记录耗时（对照主规格 §10 的 3s 预算）。

- [ ] **步骤 7：Commit**

```bash
git add -A
git commit -m "chore(app): 删除 B1 临时生成入口，回写 README 与规格状态"
```

---

## 自检记录（计划作者已执行）

**1. 规格覆盖度**：逐节对照 `2026-10-03-app-b2-crop-settings-design.md`——

| 规格章节 | 落在哪个任务 |
|---|---|
| §3 模块边界表 | 任务 1–13 逐文件对应；删除项在任务 14 |
| §4.1 坐标系与旋转 | 任务 3（映射与公式）+ 任务 4（换轴）+ 任务 8（手势换算） |
| §4.2 比例锁 | 任务 4（`applyAspect`）+ 任务 8（`watch` 把当前选区收进新比例） |
| §4.3 手势优先级 / §4.4 缩放平移 | 任务 8 |
| §4.5 布局与断点 | 任务 11（`matchMedia` + 两栏/单栏） |
| §4.6 参数面板与摘要 | 任务 9（摘要、快捷值、分片提示、色卡声明） |
| §4.7 可解析性门槛 | 任务 4（判定）+ 任务 11（生成前阻拦与文案） |
| §5.1 预览解码 | 任务 5 |
| §5.2 `sourceSize` 与越界拒绝 | 任务 6 |
| §5.3 §8 口径修正 | 任务 5（实现里没有「强制缩略图路径」分支）+ 任务 14（规格状态回写） |
| §6.1–6.4 生成 / 落盘 / 结果 / 并发 | 任务 11 |
| §7 编辑器重跑入口 | 任务 12 |
| §8 图纸库错误语义 | 任务 13 |
| §9 状态模型 | 任务 7 |
| §10 测试（含变异清单、端到端四条） | 任务 1–13 各自的步骤 1 与「跑变异」；端到端 1/2 在任务 11，3 在任务 6，4 在任务 13 |
| §12 入口校验清单 | 任务 1（board）、3（view）、4（rect）、5（loadImageSource）、6（pipeline）、7（draft）、2（defaultProjectName） |
| §13 明确不修 | 不作为任务，任务 14 在 README 里如实列出 |
| §14 待验证风险 | 任务 14 步骤 6 的人工清单覆盖 B2-R1…R5；B2-R6 由任务 6 的越界拒绝用例覆盖（拒绝而不是夹取） |

**2. 占位符扫描**：全文无「待定 / TODO / 后续实现 / 类似任务 N / 添加适当的错误处理」。每一处代码步骤都给了可执行代码；
任务 12 的测试夹具标注了「沿用本文件既有夹具 + source」并说明**必须在报告里列出夹具改动**——这是本文件里唯一的
「按现状适配」指引，不是空泛的占位符。

**3. 类型一致性**：`Size` / `Point` / `ZoomLevel` / `ViewTransform` 定义在 `core/crop/view.ts`，`rect.ts` 从它引入（不重复定义）；
`AspectLock` / `CropHandle` / `MIN_CROP_SIDE` 定义在 `core/crop/rect.ts`；`Rect` / `Rotation` 一律用 `core/image/types.ts` 的既有类型，
不新造 `CropRect`；`draft.ts` 的 `DraftParams.crop` 是 `Rect`（`width`/`height`），落盘时才在 `SetupPage` 里搬成 `w`/`h`/`rotate`
（搬位定义在 `core/project/file.ts`，与 B1 规格 §5.3 一致，**不许在别处再写一份**）。

**4. 自检时抓到的三处自身缺陷（已修，留档以说明「计划作者的代码块不可信」这条纪律对本文档同样适用）**：

| 缺陷 | 后果（若照抄） | 修法 |
|---|---|---|
| `showParams` 写成 `isWide ? stage !== "result" : …` | 结果阶段平板右栏参数消失，与规格 §4.5「右栏保留参数、可直接重新生成」冲突，且端到端 1 的摘要断言会红 | 改成 `isWide ? true : …` |
| 工具条里用 `v-for="level in ['fit', 2, 4] as const"` 与 `option.value as AspectLock` | 模板表达式里的 TS 断言不可靠，`vue-tsc` 可能直接报错 | 选项抽成 script 里的 `ASPECT_OPTIONS` / `ZOOM_OPTIONS` 常量 |
| 自检段落把 `MIN_CROP_SIDE` 拼成 `MIN_CROP_ISDE` | 照抄即编译失败 | 已改正 |

> 计划是人写的，**编译器和测试才是判据**。实现时发现计划里的标识符、签名、期望值与实际不符，
> 按代码与测试的实际形态写，并在报告里记一笔——但**先判断是代码错了还是计划错了**，不要为了让测试变绿而改期望。


