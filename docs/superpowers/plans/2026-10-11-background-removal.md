# 去背景（事前 + 事后）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 参数页的「去除背景」开关在量化前把背景格置为空格，编辑页的「去背景」工具点一下把连通背景整片置为空格、一步可撤销。

**Architecture:** 两条路共用 `src/core/pattern/background.ts` 里的一份四连通泛洪（每个种子以自己的 Lab 为基准，ΔE76 ≤ 容差就吃）。事前在 `services/pipeline.ts` 的 `rotateGrid` 之后把 `SampledGrid.filled` 置 0——`buildPattern` 本来就只处理 `filled !== 0` 的格，用色名额自动让给主体；事后在编辑页把命中格交给既有的 `buildPaintCommand(cells, indices, EMPTY, "去背景")` + `EditHistory`。

**Tech Stack:** TypeScript（严格模式）、Vue 3、Pinia、Vitest。零新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-11-background-removal-design.md`

## Global Constraints

- 落盘字段 `ProjectParams.removeBackground` **可选**，缺字段按 `false` 读；运行期 `RuntimeParams.removeBackground` **必填**。
- 事故方向偏好：**宁少勿多**——容差取紧（`BACKGROUND_TOLERANCE = 10`，ΔE76）、四连通（不是八连通）、每个种子以自己的 Lab 为基准（不是逐格相邻比较）。
- `src/core/**` 零依赖、与框架无关：不得 import `vue` / `pinia` / `@tauri-apps/*`、不得引用 DOM 全局（闸门 `src/__tests__/coreBoundary.test.ts`）。
- TypeScript 严格模式，禁止 `any`；公开 API 必须校验到「非法输入响亮失败」，校验写在任何写操作之前。
- 不改无关文件；不加依赖；不改 `package.json` / lockfile。
- 提交信息：Conventional Commits + 中文描述。
- 每个任务结束跑：`npm run test`；分支收尾跑 `npm run build`。
- 测试文件一律放对应目录的 `__tests__/` 下，沿用既有文件的 import 风格（`@/` 别名或相对路径，与该文件既有写法一致）。

## Review Focus

规格没写、但真实使用中最可能咬人的五类输入，各自在对应任务里有测试：

1. **渐变背景的跨度超出容差**：期望是「吃不够、残留一圈」，不是「吃过头」（→ 任务 1、2）。
2. **主体与背景同色且连通**：会被一起吃，这是设计接受的行为；期望**一步撤销完整还原**（→ 任务 7、8、10）。
3. **点在空格 / 图纸外 / 已经是空格的格子**：期望无操作——不产生撤销记录、不标未保存（→ 任务 8、9、10）。
4. **旧工程（落盘参数缺 `removeBackground`）**：期望正常打开、行为与今天完全一致（→ 任务 4）。
5. **事前开关 + 用色数设为「不限」**（= 色卡色数、跳过分簇那条路）：期望正常产出、背景照样被排除（→ 任务 3）。

---

### Task 1: core 泛洪 `floodBackground`

**Files:**
- Create: `src/core/pattern/background.ts`
- Test: `src/core/pattern/__tests__/background.test.ts`

**Interfaces:**
- Consumes: `colorDistance(target, other, "de76")` 与 `Lab`（`@/core/color/distance`、`@/core/color/space`）。
- Produces:
  - `export const BACKGROUND_TOLERANCE = 10;`
  - `export function floodBackground(width: number, height: number, labs: Float32Array, eatable: Uint8Array, seeds: readonly number[], tolerance: number): number[]`
    - `labs` 长度 `width*height*3`（逐格 Lab），`eatable[i] === 1` 才可吃，返回被吃掉的格子下标（行优先、升序不保证）。

- [ ] **Step 1: 写失败测试**

```ts
// src/core/pattern/__tests__/background.test.ts
import { describe, expect, it } from "vitest";
import { rgbToLab, type Lab } from "@/core/color/space";
import { BACKGROUND_TOLERANCE, floodBackground } from "../background";

const RED: Lab = rgbToLab(255, 0, 0);
const NEAR_RED: Lab = rgbToLab(240, 10, 10); // 与 RED 的 ΔE76 远小于 10
const BLUE: Lab = rgbToLab(0, 0, 255);

/** 造一个 width×height 的网格：`colorAt(x, y)` 返回该格颜色；`eatableAt` 缺省全可吃。 */
function make(
  width: number,
  height: number,
  colorAt: (x: number, y: number) => Lab,
  eatableAt: (x: number, y: number) => boolean = () => true,
) {
  const labs = new Float32Array(width * height * 3);
  const eatable = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const lab = colorAt(x, y);
      labs[i * 3] = lab[0];
      labs[i * 3 + 1] = lab[1];
      labs[i * 3 + 2] = lab[2];
      eatable[i] = eatableAt(x, y) ? 1 : 0;
    }
  }
  return { labs, eatable };
}

describe("floodBackground", () => {
  it("纯色背景整片被吃", () => {
    const { labs, eatable } = make(5, 5, () => RED);
    const eaten = floodBackground(5, 5, labs, eatable, [0], BACKGROUND_TOLERANCE);
    expect([...eaten].sort((a, b) => a - b)).toEqual([...Array(25).keys()]);
  });

  it("与种子色差大于容差的块挡住泛洪，不越界", () => {
    // 5×5：x < 2 红，x >= 2 蓝
    const { labs, eatable } = make(5, 5, (x) => (x < 2 ? RED : BLUE));
    const eaten = floodBackground(5, 5, labs, eatable, [0], BACKGROUND_TOLERANCE);
    expect(eaten.length).toBe(10); // 左两列
    expect(eaten.some((i) => i % 5 >= 2)).toBe(false);
  });

  it("[宁少勿多] 渐变链不吃穿：只吃与种子色差在容差内的格", () => {
    // 4 格：红 → 与红差一点的近红 → 蓝 → 蓝。相邻差小，但首尾差大。
    const { labs, eatable } = make(4, 1, (x) => (x <= 1 ? NEAR_RED : BLUE));
    const eaten = floodBackground(4, 1, labs, eatable, [0], BACKGROUND_TOLERANCE);
    expect(eaten.length).toBe(2); // 只吃前两格
  });

  it("多个种子各以自己的颜色为基准", () => {
    // 6×1：前三红、后三蓝；两个种子
    const { labs, eatable } = make(6, 1, (x) => (x < 3 ? RED : BLUE));
    const eaten = floodBackground(6, 1, labs, eatable, [0, 5], BACKGROUND_TOLERANCE);
    expect(eaten.length).toBe(6);
  });

  it("对角可达但四连通不可达的格不被吃", () => {
    // 3×3：只有 (0,0) 与 (1,1) 是红，其余蓝
    const { labs, eatable } = make(3, 3, (x, y) => (x === y && x <= 1 ? RED : BLUE));
    const eaten = floodBackground(3, 3, labs, eatable, [0], BACKGROUND_TOLERANCE);
    expect(eaten).toEqual([0]);
  });

  it("不可吃的格既不被吃、也不被穿越", () => {
    // 3×1：中间格不可吃（模拟空格），两侧红
    const { labs, eatable } = make(3, 1, () => RED, (x) => x !== 1);
    const eaten = floodBackground(3, 1, labs, eatable, [0], BACKGROUND_TOLERANCE);
    expect(eaten).toEqual([0]);
  });

  it("种子本身不可吃时跳过该种子", () => {
    const { labs, eatable } = make(3, 1, () => RED, (x) => x !== 0);
    expect(floodBackground(3, 1, labs, eatable, [0], BACKGROUND_TOLERANCE)).toEqual([]);
  });

  it("0×0 返回空数组", () => {
    expect(floodBackground(0, 0, new Float32Array(0), new Uint8Array(0), [], BACKGROUND_TOLERANCE)).toEqual([]);
  });

  it("非法入口响亮失败", () => {
    const { labs, eatable } = make(2, 2, () => RED);
    expect(() => floodBackground(2, 2, labs, eatable, [0], NaN)).toThrow(/容差/);
    expect(() => floodBackground(2, 2, labs, eatable, [0], -1)).toThrow(/容差/);
    expect(() => floodBackground(2, 2, new Float32Array(3), eatable, [0], 10)).toThrow(/长度/);
    expect(() => floodBackground(2, 2, labs, new Uint8Array(3), [0], 10)).toThrow(/长度/);
    expect(() => floodBackground(2.5, 2, labs, eatable, [0], 10)).toThrow(/尺寸/);
    expect(() => floodBackground(2, 2, labs, eatable, [4], 10)).toThrow(/种子/);
    expect(() => floodBackground(2, 2, labs, eatable, [1.5], 10)).toThrow(/种子/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/pattern/__tests__/background.test.ts`
Expected: FAIL —— `Failed to resolve import "../background"`。

- [ ] **Step 3: 实现 `src/core/pattern/background.ts`**

导出 `BACKGROUND_TOLERANCE` 与 `floodBackground`。算法（签名与用例没定下来的部分）：

- 入口校验顺序：`width` / `height` 是 ≥ 0 的整数（否则抛「尺寸非法」）→ `width === 0 || height === 0` 时返回 `[]` → `labs.length === width*height*3` 与 `eatable.length === width*height`（否则抛「长度」）→ `tolerance` 有限且 ≥ 0（否则抛「容差」）→ 每个种子是 `0..cellCount-1` 的整数（否则抛「种子」）。
- 用 `owner: Int32Array(cellCount).fill(-1)` 当「已访问」标记（`-1` = 未入队）**和**「该格从哪个种子扩散来」的记录；队列用普通 `number[]`（116² 上限下不需要优先队列）。
- 种子自己 `owner[seed] = seed` 并入队（`eatable[seed] === 0` 时跳过该种子）。
- 出队格 `i` 的四个邻居用 `x = i % width`、`y = (i - x) / width` 算，`x === 0` 时不看 `-1`、`x === width-1` 时不看 `+1`（**不许**用 `i-1` / `i+1` 直接跨界）。
- 邻居 `j`：`owner[j] === -1`（未访问）、`eatable[j] === 1`、且 `colorDistance(labs[j], labs[owner[i]], "de76") <= tolerance` 三条同时成立才 `owner[j] = owner[i]` 并入队。**先到先得**：已入队的格不改 owner。
- BFS 结束后，把 `owner[i] !== -1 && i` 不是种子 的格与种子一起作为结果——实现上直接收集「所有 `owner !== -1` 的下标」，种子的颜色差为 0、天然成立。
- 距离比较用 `colorDistance`（`@/core/color/distance`）的 `"de76"`，与逐格映射同口径。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/pattern/__tests__/background.test.ts`
Expected: PASS（9 个用例全绿）。

- [ ] **Step 5: 跑分层闸门与全量测试**

Run: `npx vitest run src/__tests__/coreBoundary.test.ts && npm run test`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add src/core/pattern/background.ts src/core/pattern/__tests__/background.test.ts
git commit -m "feat(core): 新增四连通去背景泛洪（每种子独立基准、ΔE76 容差）"
```

---

### Task 2: core 事前掩码 `maskBackground`

**Files:**
- Modify: `src/core/pattern/background.ts`
- Test: `src/core/pattern/__tests__/background.test.ts`（追加 `describe("maskBackground")`）

**Interfaces:**
- Consumes: Task 1 的 `floodBackground`；`rgbToLab`；`SampledGrid`（`@/core/image/types`）。
- Produces: `export function maskBackground(grid: SampledGrid, tolerance: number): void` —— 就地把背景格的 `filled` 置 0，`rgb` 与尺寸不动。

- [ ] **Step 1: 写失败测试**

```ts
describe("maskBackground", () => {
  /** 造一个 grid：rgb 由 colorAt 决定，filled 由 filledAt 决定。 */
  function makeGrid(
    width: number,
    height: number,
    colorAt: (x: number, y: number) => [number, number, number],
    filledAt: (x: number, y: number) => boolean = () => true,
  ): SampledGrid {
    const rgb = new Float32Array(width * height * 3);
    const filled = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const c = colorAt(x, y);
        rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
        filled[i] = filledAt(x, y) ? 1 : 0;
      }
    }
    return { width, height, rgb, filled };
  }

  it("从四个角泛洪，把纯色背景置为空格", () => {
    const grid = makeGrid(6, 6, (x, y) => (x >= 1 && x <= 4 && y >= 1 && y <= 4 ? [0, 0, 255] : [255, 0, 0]));
    maskBackground(grid, BACKGROUND_TOLERANCE);
    const solid = [...grid.filled].filter((v) => v === 1).length;
    expect(solid).toBe(16); // 中央 4×4 蓝色主体保留
  });

  it("四角颜色彼此不同（渐变）时各吃各的，接缝残留", () => {
    // 6×6：左上红、右上绿、左下蓝、右下黑，四块各 3×3；每块纯色
    const grid = makeGrid(6, 6, (x, y) => {
      if (y < 3) return x < 3 ? [255, 0, 0] : [0, 255, 0];
      return x < 3 ? [0, 0, 255] : [0, 0, 0];
    });
    maskBackground(grid, BACKGROUND_TOLERANCE);
    expect([...grid.filled]).toEqual(new Array(36).fill(0)); // 四块各自与自己的角同色 → 全被吃
  });

  it("角上的空格不当种子，其余角照常工作", () => {
    const grid = makeGrid(
      6, 6,
      (x, y) => (x >= 1 && x <= 4 && y >= 1 && y <= 4 ? [0, 0, 255] : [255, 0, 0]),
      (x, y) => !(x === 0 && y === 0),
    );
    maskBackground(grid, BACKGROUND_TOLERANCE);
    expect(grid.filled[0]).toBe(0);
    expect(grid.filled[grid.width - 1]).toBe(0); // 右上角作为种子也被吃
  });

  it("不改 rgb 与尺寸", () => {
    const grid = makeGrid(3, 3, () => [255, 0, 0]);
    const before = Float32Array.from(grid.rgb);
    maskBackground(grid, BACKGROUND_TOLERANCE);
    expect(grid.rgb).toEqual(before);
    expect(grid.width).toBe(3);
  });
});
```

在文件顶部补 `import type { SampledGrid } from "@/core/image/types";` 与 `maskBackground` 的 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/pattern/__tests__/background.test.ts -t maskBackground`
Expected: FAIL —— `maskBackground is not a function`。

- [ ] **Step 3: 实现 `maskBackground`**

在 `background.ts` 里实现：

- 种子 = `[(0,0), (width-1,0), (0,height-1), (width-1,height-1)]` 四格中 `filled === 1` 的那些（格坐标，不是像素角；`width` 或 `height` 为 1 时同一个下标会重复出现——重复无害，BFS 的 `owner` 天然去重）。`width === 0 || height === 0` 时直接返回（空图没有背景可去）。
- `labs`：`Float32Array(cellCount*3)`，逐格 `rgbToLab(grid.rgb[i*3], grid.rgb[i*3+1], grid.rgb[i*3+2])`。
- `eatable`：直接传 `grid.filled`。
- 调 `floodBackground` **收集下标后**再统一写 `grid.filled[i] = 0`（不要在 BFS 过程中边吃边改，那会让「可吃位」与「已访问」两套判定耦合）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/pattern/__tests__/background.test.ts`
Expected: PASS（13 个用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/core/pattern/background.ts src/core/pattern/__tests__/background.test.ts
git commit -m "feat(core): 从四个角自动排除背景（maskBackground，就地清 filled）"
```

---

### Task 3: 流水线接上开关（事前）

**Files:**
- Modify: `src/services/pipeline.ts`（`GenerateRequest` 加字段；`resampleToGrid` / `rotateGrid` 之后、`buildPattern` 之前调 `maskBackground`）
- Test: `src/services/__tests__/pipeline.test.ts`（追加 `describe("removeBackground")`）

**Interfaces:**
- Consumes: Task 2 的 `maskBackground`、`BACKGROUND_TOLERANCE`。
- Produces: `GenerateRequest.removeBackground?: boolean`。

- [ ] **Step 1: 写失败测试**

在 `pipeline.test.ts` 追加。夹具：外圈纯灰背景、内部左半红、右半绿。**边框宽度必须与一格同量级**
（224px / 4 格 = 56px，故取 48px）——否则角上那一格的平均色由内部主体主导，`cells[0]` 就不是背景色号，
断言会假失败。

```ts
/** 外圈 `border` 像素为背景色，内部左半 a 色、右半 b 色。 */
function framed(size: number, bg: [number, number, number], a: [number, number, number], b: [number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(size * size * 4);
  const border = 48;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inner = x >= border && x < size - border && y >= border && y < size - border;
      const color = inner ? (x < size / 2 ? a : b) : bg;
      data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

const framedImage = framed(224, [128, 128, 128], [255, 0, 0], [0, 255, 0]);
/** 纯灰整图：全部都是背景，用来验「整图被吃空」这一支。 */
const solidGray: RgbaImage = (() => {
  const data = new Uint8ClampedArray(224 * 224 * 4);
  for (let i = 0; i < 224 * 224; i++) {
    data[i * 4] = 128; data[i * 4 + 1] = 128; data[i * 4 + 2] = 128; data[i * 4 + 3] = 255;
  }
  return { width: 224, height: 224, data };
})();
const framedDeps: GenerateDeps = {
  exactDecoder: { name: "fake-framed", async decode() { return framedImage; } },
  fastDecoder: fastMustNotBeUsed,
};

describe("removeBackground（事前排除）", () => {
  it("不传开关时行为不变：四边是背景色号，不是空格", async () => {
    const pattern = await generatePattern(
      { source, sourceSize, crop, rotation: 0, longSide: 4, maxColors: 16 },
      framedDeps,
    );
    expect(pattern.cells[0]).not.toBe(EMPTY);
  });

  it("开关为 true 时四边背景格变空格，中央主体保留色号", async () => {
    const pattern = await generatePattern(
      { source, sourceSize, crop, rotation: 0, longSide: 4, maxColors: 16, removeBackground: true },
      framedDeps,
    );
    expect(pattern.cells[0]).toBe(EMPTY); // 左上角（4×4 里第一格 98% 的面积落在 48px 外圈里）
    expect(pattern.cells[pattern.cells.length - 1]).toBe(EMPTY);
    expect(pattern.cells[1 * 4 + 1]).not.toBe(EMPTY); // 中央 2×2 是主体
  });

  it("用色名额真的让给主体：maxColors=2 时红与绿都出现，不勾则不同时出现", async () => {
    const without = await generatePattern(
      { source, sourceSize, crop, rotation: 0, longSide: 4, maxColors: 2 },
      framedDeps,
    );
    const with_ = await generatePattern(
      { source, sourceSize, crop, rotation: 0, longSide: 4, maxColors: 2, removeBackground: true },
      framedDeps,
    );
    const has = (p: typeof without, index: number) => [...p.cells].includes(index);
    expect(has(with_, 2) && has(with_, 3)).toBe(true); // A3 红、A4 绿
    expect(has(without, 2) && has(without, 3)).toBe(false);
  });

  it("用色数为「不限」（= 色卡色数）时同样排除背景", async () => {
    const pattern = await generatePattern(
      { source, sourceSize, crop, rotation: 0, longSide: 4, maxColors: palette.colors.length, removeBackground: true },
      framedDeps,
    );
    expect(pattern.cells[0]).toBe(EMPTY);
  });

  it("[整图被吃空] 全是背景的图产出一张全空图纸，不抛错", async () => {
    const pattern = await generatePattern(
      { source, sourceSize, crop, rotation: 0, longSide: 4, maxColors: 16, removeBackground: true },
      { ...framedDeps, exactDecoder: { name: "fake-gray", async decode() { return solidGray; } } },
    );
    expect(pattern.width).toBe(4);
    expect([...pattern.cells].every((value) => value === EMPTY)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/services/__tests__/pipeline.test.ts -t removeBackground`
Expected: FAIL —— 后三个用例断言不成立（背景格不是 `EMPTY`）；`removeBackground` 参数目前被 `GenerateRequest` 拒绝（`vue-tsc` 层面报错，vitest 运行时静默忽略）。

- [ ] **Step 3: 实现**

- `GenerateRequest` 加可选字段，并写清为什么是可选：`readonly removeBackground?: boolean;`（缺省 = 老行为，不可能静默产错；`pipeline.test.ts` 有 22 处内联请求字面量，必填会换来 22 行无信息改动）。
- 在 `const rotated = rotateGrid(sampled, rotation);` 之后、`buildPattern(...)` 之前插入：

```ts
  // 事前排除背景：maskBackground 就地清 filled，buildPattern 只处理 filled !== 0 的格，
  // 于是直方图、聚类与用色名额都自动跳过背景。rotation === 0 时 rotateGrid 返回入参本身，
  // 就地改 filled 会同时改到 sampled——两者都是本函数局部的，改后无人再读，安全。
  if (request.removeBackground === true) {
    maskBackground(rotated, BACKGROUND_TOLERANCE);
  }
```

- `generatePattern` 的解构那一行不用改（`request.removeBackground === true` 直接读 `request`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/services/__tests__/pipeline.test.ts`
Expected: PASS（含既有用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/services/pipeline.ts src/services/__tests__/pipeline.test.ts
git commit -m "feat(pipeline): 生成时可选排除背景（量化前置 filled，用色名额让给主体）"
```

---

### Task 4: 落盘参数与运行期参数贯通

**Files:**
- Modify: `src/core/project/types.ts`（`ProjectParams` 加字段；`validateProjectDocument` 归一化）
- Modify: `src/core/project/file.ts`（`toProjectDocument` 写入；`fromProjectDocument` 返回）
- Modify: `src/stores/project.ts`（`RuntimeParams` 加必填字段；`save()` 传值）
- Modify: `src/stores/__tests__/project.test.ts`（`PARAMS` 常量补字段）
- Modify: `src/views/__tests__/EditResultPage.test.ts`（`RUNTIME_PARAMS` 常量补字段）
- Test: `src/core/project/__tests__/file.test.ts`

**Interfaces:**
- Produces: `ProjectParams.removeBackground?: boolean`；`RuntimeParams.removeBackground: boolean`；`fromProjectDocument(...).params.removeBackground: boolean`（缺字段时为 `false`）。

- [ ] **Step 1: 写失败测试**

在 `file.test.ts` 追加：

```ts
describe("removeBackground 落盘", () => {
  it("toProjectDocument 把 true / false 原样写入 params", () => {
    expect(toProjectDocument(pattern, palette, { ...docParams, removeBackground: true }).params.removeBackground).toBe(true);
    expect(toProjectDocument(pattern, palette, { ...docParams, removeBackground: false }).params.removeBackground).toBe(false);
    expect(toProjectDocument(pattern, palette, docParams).params.removeBackground).toBeUndefined();
  });

  it("[旧工程] 落盘参数缺 removeBackground 时按 false 读，不报错", () => {
    const doc = toProjectDocument(pattern, palette, docParams);
    const { params: legacy } = doc;
    const stripped = { ...doc, params: { longSide: legacy.longSide, maxColors: legacy.maxColors, crop: legacy.crop } };
    expect(fromProjectDocument(stripped, palette).params.removeBackground).toBe(false);
  });

  it("[旧工程] 字段不是布尔值时响亮失败", () => {
    const doc = toProjectDocument(pattern, palette, docParams);
    const bad = { ...doc, params: { ...doc.params, removeBackground: "true" } };
    expect(() => fromProjectDocument(bad, palette)).toThrow(/removeBackground/);
  });

  it("true 往返仍是 true", () => {
    const doc = toProjectDocument(pattern, palette, { ...docParams, removeBackground: true });
    expect(fromProjectDocument(doc, palette).params.removeBackground).toBe(true);
  });
});
```

（`pattern` / `palette` / `docParams` 用该文件既有的夹具名；若名字不同，按既有夹具改。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/project/__tests__/file.test.ts -t removeBackground`
Expected: FAIL —— 写入/读取都不带这个字段。

- [ ] **Step 3: 实现**

- `core/project/types.ts`：`ProjectParams` 加 `readonly removeBackground?: boolean;`，注释写明「可选是**旧工程兼容**的唯一安全选择——按必填处理会让库里所有已有工程打不开；缺省语义就是老行为（不去背景）」。`validateProjectDocument` 在 `requireMaxColors` 之后加：

```ts
  const removeBackground = params.removeBackground;
  if (removeBackground !== undefined && typeof removeBackground !== "boolean") {
    throw new Error(`removeBackground 必须是布尔值（当前 ${String(removeBackground)}）`);
  }
```

并在返回的 `params` 里带上 `removeBackground`。

- `core/project/file.ts`：`toProjectDocument` 返回的 `params` 里加 `removeBackground: params.removeBackground`（缺省就是 `undefined`）；`fromProjectDocument` 返回的 `params` 里加 `removeBackground: checked.params.removeBackground ?? false`（读取类型标注改成 `removeBackground: boolean`）。
- `stores/project.ts`：`RuntimeParams` 加 `readonly removeBackground: boolean;`；`save()` 的 `toProjectDocument(...)` 参数对象补 `removeBackground: params.value.removeBackground`。
- 两处测试夹具常量补 `removeBackground: false`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/project/__tests__/file.test.ts src/stores/__tests__/project.test.ts src/views/__tests__/EditResultPage.test.ts && npm run test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/core/project/types.ts src/core/project/file.ts src/stores/project.ts \
  src/core/project/__tests__/file.test.ts src/stores/__tests__/project.test.ts src/views/__tests__/EditResultPage.test.ts
git commit -m "feat(project): 生成参数落盘 removeBackground（缺字段按关读，兼容旧工程）"
```

---

### Task 5: 草稿参数 + 参数面板勾选框 + 生成页接线

**Files:**
- Modify: `src/stores/draft.ts`（`DraftParams` 加字段；ref + setter + `reset` + `adoptProject` 播种 + `return`）
- Modify: `src/components/param/ParamPanel.vue`（props + `update:removeBackground` 事件 + 勾选框）
- Modify: `src/views/SetupPage.vue`（props 传入、事件写 store、`generatePattern` 请求带上、`session.adopt` 与 `toProjectDocument` 带上）
- Test: `src/stores/__tests__/draft.test.ts`、`src/components/param/__tests__/ParamPanel.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `ProjectParams.removeBackground`、`RuntimeParams.removeBackground`；Task 3 的 `GenerateRequest.removeBackground`。
- Produces: `draft.removeBackground: Ref<boolean>` 与 `draft.setRemoveBackground(next: boolean): void`；`ParamPanel` 的 prop `removeBackground: boolean` 与事件 `"update:removeBackground": [boolean]`。

- [ ] **Step 1: 写失败测试**

`draft.test.ts` 追加：

```ts
describe("removeBackground", () => {
  it("缺省为 false", () => {
    expect(useDraft().removeBackground).toBe(false);
  });

  it("setRemoveBackground(true) 让 already-generated 失效（它与 longSide 同级，影响产物）", () => {
    const draft = useDraft();
    draft.markGenerated();
    draft.setRemoveBackground(true);
    expect(draft.removeBackground).toBe(true);
    expect(draft.generated).toBe(false);
  });

  it("adoptProject 按 DraftParams 播种，非法值响亮失败且不留下半截草稿", () => {
    const draft = useDraft();
    draft.adoptProject({
      source: { blob: new Blob([new Uint8Array([1])]), type: "image/png", name: "a.png" },
      params: {
        longSide: 58, maxColors: 16, crop: { x: 0, y: 0, width: 8, height: 8 }, rotation: 0,
        removeBackground: true,
      },
      meta: { id: "p1", name: "旧图", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(draft.removeBackground).toBe(true);
  });

  it("reset 回到 false", () => {
    const draft = useDraft();
    draft.setRemoveBackground(true);
    draft.reset();
    expect(draft.removeBackground).toBe(false);
  });
});
```

`ParamPanel.test.ts` 追加：

```ts
describe("去除背景勾选框", () => {
  it("渲染当前值，点击上报翻转后的值", async () => {
    const wrapper = mountPanel({ removeBackground: false });
    const box = wrapper.get('[data-testid="remove-background"]');
    expect((box.element as HTMLInputElement).checked).toBe(false);
    await box.setValue(true);
    expect(wrapper.emitted("update:removeBackground")?.[0]).toEqual([true]);
  });

  it("没有白边时不做任何本地猜测：值只由 props 决定", async () => {
    const wrapper = mountPanel({ removeBackground: true });
    expect((wrapper.get('[data-testid="remove-background"]').element as HTMLInputElement).checked).toBe(true);
  });
});
```

（`mountPanel` 用该文件既有的 mount 帮助函数与 props 默认值；缺 `removeBackground` 时按 `false` 传入。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/draft.test.ts src/components/param/__tests__/ParamPanel.test.ts -t removeBackground`
Expected: FAIL —— `draft.removeBackground` 不存在、`[data-testid="remove-background"]` 找不到。

- [ ] **Step 3: 实现**

- `stores/draft.ts`：
  - `DraftParams` 加 `readonly removeBackground: boolean;`（注释：与 `longSide` / `maxColors` 同级，属**影响产物**的参数，不是视图状态）。
  - 照 `maxColors` 的三处位置逐一补齐：`const removeBackground = ref(false)`、`setRemoveBackground(next: boolean)`（非布尔响亮失败，然后 `generated.value = false`）、`reset()` 里回 `false`、`adoptProject` 里 `removeBackground.value = input.params.removeBackground`（校验在写操作之前：`typeof !== "boolean"` 抛错）、`return` 里导出 ref 与 setter。
- `components/param/ParamPanel.vue`：props 加 `removeBackground: boolean`；emits 加 `"update:removeBackground": [boolean]`；在「用几种颜色」那一块之后加一个勾选框（沿用页面既有 `min-h-12` / `text-lg` 样式与 `data-testid` 命名）：

```html
<label class="block text-lg text-slate-800">
  <input
    type="checkbox"
    data-testid="remove-background"
    class="mr-2 h-5 w-5 align-middle"
    :checked="removeBackground"
    :disabled="busy"
    @change="emit('update:removeBackground', ($event.target as HTMLInputElement).checked)"
  />
  去除背景（纯色 / 渐变背景会被当作不拼豆，用色名额留给主体）
</label>
```

- `views/SetupPage.vue`：给 `<ParamPanel>` 传 `:remove-background="draft.removeBackground"` 并接 `@update:remove-background="draft.setRemoveBackground"`；`generatePattern` 的请求对象加 `removeBackground: draft.removeBackground`；`session.adopt(...)` 的运行期参数与 `toProjectDocument(...)` 的落盘参数各加 `removeBackground: draft.removeBackground`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/draft.test.ts src/components/param/__tests__/ParamPanel.test.ts src/views/__tests__/SetupPage.test.ts && npm run test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/stores/draft.ts src/components/param/ParamPanel.vue src/views/SetupPage.vue \
  src/stores/__tests__/draft.test.ts src/components/param/__tests__/ParamPanel.test.ts
git commit -m "feat(param): 参数页新增去除背景开关并贯通生成与落盘"
```

---

### Task 6: 「重做」也要带上开关

**Files:**
- Modify: `src/services/rerunDraft.ts`
- Test: `src/services/__tests__/rerunDraft.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `draft.setRemoveBackground` / `DraftParams.removeBackground`、Task 4 的 `RuntimeParams.removeBackground`。

- [ ] **Step 1: 写失败测试**

在 `rerunDraft.test.ts` 追加：

```ts
it("重做把会话里的 removeBackground 一并播种进草稿", () => {
  const draft = useDraft();
  const session = useProjectSession();
  adoptSession({ removeBackground: true }); // 用该文件既有的会话夹具，参数里打开开关
  expect(seedRerunDraft(draft, session)).toBe(true);
  expect(draft.removeBackground).toBe(true);
});

it("重做把关闭的开关也照搬（不是一律置真）", () => {
  const draft = useDraft();
  const session = useProjectSession();
  adoptSession({ removeBackground: false });
  expect(seedRerunDraft(draft, session)).toBe(true);
  expect(draft.removeBackground).toBe(false);
});
```

（`adoptSession` 用该文件既有的「造一个已保存会话」帮助函数；没有就把 `false` 那条写成一个内联的 `session.adopt(...)`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/services/__tests__/rerunDraft.test.ts -t removeBackground`
Expected: FAIL —— `draft.removeBackground` 播种后仍是 `false`（`seedRerunDraft` 没传该字段）。

- [ ] **Step 3: 实现**

`seedRerunDraft` 的 `draft.adoptProject({ params: { ... } })` 里补 `removeBackground: params.removeBackground`（`params` 是 `session.params`，Task 4 起一定有这个字段）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/services/__tests__/rerunDraft.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/services/rerunDraft.ts src/services/__tests__/rerunDraft.test.ts
git commit -m "fix(draft): 重做重新生成时带上去除背景开关"
```

---

### Task 7: core 事后掩码 `patternBackgroundIndices`

**Files:**
- Modify: `src/core/pattern/background.ts`
- Test: `src/core/pattern/__tests__/background.test.ts`（追加 `describe("patternBackgroundIndices")`）

**Interfaces:**
- Consumes: Task 1 的 `floodBackground`；`Pattern` / `EMPTY`（`@/core/pattern/types`）；`Lab`。
- Produces: `export function patternBackgroundIndices(pattern: Pattern, labs: readonly Lab[], seed: { x: number; y: number }, tolerance: number): number[]` —— 返回该点连通背景的格子下标（行优先 `y * width + x`）；种子落在图纸外、非整数、或该格已是 `EMPTY` 时返回 `[]`。

- [ ] **Step 1: 写失败测试**

```ts
describe("patternBackgroundIndices", () => {
  /** 3×3 图纸：`indexAt(x,y)` 给色号（默认全 0、中心 1），labs 是与色号一一对应的 Lab 表。 */
  function makePattern(indexAt: (x: number, y: number) => number = () => 0): Pattern {
    const cells = new Uint16Array(9);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) cells[y * 3 + x] = indexAt(x, y);
    return { width: 3, height: 3, paletteId: "fake", cells };
  }
  const LABS: readonly Lab[] = [RED, BLUE];

  it("同色连通区域整片返回，含种子自己", () => {
    const indices = patternBackgroundIndices(makePattern(), LABS, { x: 1, y: 1 }, BACKGROUND_TOLERANCE);
    expect([...indices].sort((a, b) => a - b)).toEqual([...Array(9).keys()]);
  });

  it("色差大于容差的区域不被吃", () => {
    const pattern = makePattern((x, y) => (x === 1 && y === 1 ? 1 : 0));
    expect(patternBackgroundIndices(pattern, LABS, { x: 0, y: 0 }, BACKGROUND_TOLERANCE)).toEqual([0]);
  });

  it("[主体不会被穿越] 空格既不被吃、也挡住泛洪", () => {
    // 中间一列是空格，左列与右列同为色号 0
    const pattern = makePattern((x) => (x === 1 ? EMPTY : 0));
    const indices = patternBackgroundIndices(pattern, LABS, { x: 0, y: 0 }, BACKGROUND_TOLERANCE);
    expect([...indices].sort((a, b) => a - b)).toEqual([0, 3, 6]);
  });

  it("种子落在空格 / 图纸外 / 非整数时返回空数组", () => {
    const pattern = makePattern((x) => (x === 1 ? EMPTY : 0));
    expect(patternBackgroundIndices(pattern, LABS, { x: 1, y: 0 }, BACKGROUND_TOLERANCE)).toEqual([]);
    expect(patternBackgroundIndices(pattern, LABS, { x: 3, y: 0 }, BACKGROUND_TOLERANCE)).toEqual([]);
    expect(patternBackgroundIndices(pattern, LABS, { x: -1, y: 0 }, BACKGROUND_TOLERANCE)).toEqual([]);
    expect(patternBackgroundIndices(pattern, LABS, { x: 0.5, y: 0 }, BACKGROUND_TOLERANCE)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/pattern/__tests__/background.test.ts -t patternBackgroundIndices`
Expected: FAIL —— 函数不存在。

- [ ] **Step 3: 实现**

在 `background.ts` 里实现：

- 种子坐标越界 / 非整数 → 返回 `[]`（与 `cellAt` 的「越界返回 `EMPTY`」不同：这里返回空数组，调用方据此不做任何事）。
- `seedIndex = seed.y * width + seed.x`；`cells[seedIndex] === EMPTY` → 返回 `[]`。
- `labs`（Float32Array）逐格填 `input labs[cells[i]]`——`EMPTY` 格填 `0,0,0` 且 `eatable = 0`，永不被比较。色号越界（`cells[i] >= labs.length` 或为 `EMPTY`）一律按不可吃处理，不抛错：图纸来自落盘校验，越界色号已被 `validateProjectDocument` 挡在门外。
- 调 `floodBackground(width, height, labsArray, eatable, [seedIndex], tolerance)` 返回其结果。
- JSDoc 里写明消费者：`EditorPage.onBackground`（去背景工具）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/pattern/__tests__/background.test.ts`
Expected: PASS（17 个用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/core/pattern/background.ts src/core/pattern/__tests__/background.test.ts
git commit -m "feat(core): 点选种子求连通背景下标（patternBackgroundIndices）"
```

---

### Task 8: 编辑器 store 的第 4 个工具与 `eraseCells`

**Files:**
- Modify: `src/stores/editor.ts`（`EditorTool`、`setTool`、新增 `eraseCells`、`return`）
- Test: `src/stores/__tests__/editor.test.ts`

**Interfaces:**
- Consumes: `buildPaintCommand`（`@/core/pattern/edit`，既有）、`EMPTY`、既有 `publishChange` / `history`。
- Produces: `EditorTool = "brush" | "select" | "pick" | "background"`；`editor.eraseCells(indices: readonly number[]): void`。

- [ ] **Step 1: 写失败测试**

在 `editor.test.ts` 追加：

```ts
describe("去背景工具", () => {
  it('setTool 接受 "background"', () => {
    const editor = beginSessionWith(...); // 用该文件既有的开档帮助函数
    editor.setTool("background");
    expect(editor.tool).toBe("background");
  });

  it("setTool 的错误信息列出四个工具并拒绝拼错的值", () => {
    const editor = beginSessionWith(...);
    expect(() => editor.setTool("bg" as never)).toThrow(/background/);
  });

  it("eraseCells 把一批格子置为空并按一次命令撤销", () => {
    const editor = beginSessionWith(...);
    const before = [...editor.pattern!.cells];
    editor.eraseCells([0, 1, 2]);
    expect([...editor.pattern!.cells].slice(0, 3)).toEqual([EMPTY, EMPTY, EMPTY]);
    expect(editor.canUndo).toBe(true);
    editor.undo();
    expect([...editor.pattern!.cells]).toEqual(before);
    expect(editor.canUndo).toBe(false);
  });

  it("对象全是空格时不产生撤销记录、不标脏", () => {
    const editor = beginSessionWith(...);
    editor.eraseCells([0]);           // 第一次真的改了
    const revision = editor.revision;
    editor.eraseCells([0]);           // 已经是空格
    expect(editor.revision).toBe(revision);
    expect(useProjectSession().dirty).toBe(false); // 若该文件已有清脏手法，按既有写法
  });

  it("空数组什么都不做", () => {
    const editor = beginSessionWith(...);
    const revision = editor.revision;
    editor.eraseCells([]);
    expect(editor.revision).toBe(revision);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/editor.test.ts -t 去背景`
Expected: FAIL —— `eraseCells` 不存在；`setTool("background")` 抛错。

- [ ] **Step 3: 实现**

- `EditorTool` 改成四个值的联合（注释补一句「去背景是**工具**，橡皮不是——橡皮是「当前色 = `EMPTY`」」）。
- `setTool` 的枚举守卫加 `next !== "background"`，错误信息里的允许列表同步补 `"background"`（消息里现存的 `"brush" / "select" / "pick"` 文案要一起改，否则文案与判据分叉）。
- 新增动作，与 `paint` 同形：

```ts
  /**
   * 去背景：把一批格子置为空格，一次点击一条命令（可一步撤销）。
   *
   * 判定「哪些格子是背景」在 core（`patternBackgroundIndices`），这里只负责入账——
   * 已经是空格的格由 `buildPaintCommand` 天然跳过，于是「点空格」不会留下空的撤销记录。
   */
  function eraseCells(indices: readonly number[]): void {
    const current = requireLoadedPattern();
    if (!Array.isArray(indices)) {
      throw new Error(`去背景下标必须是数组（当前 ${typeof indices}）`);
    }
    const safeIndices: readonly number[] = indices;
    const command = buildPaintCommand(current.cells, safeIndices, EMPTY, "去背景");
    if (command === null) return;
    publishChange(history.value.commit(current.cells, command));
  }
```

- `return` 里导出 `eraseCells`。
- 文件头的「13 个状态字段与 15 个动作」账目跟着更新成实际数字。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/editor.test.ts && npm run test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/stores/editor.ts src/stores/__tests__/editor.test.ts
git commit -m "feat(editor): 新增去背景工具与 eraseCells 动作（一次点击一条命令）"
```

---

### Task 9: 工具栏按钮与画布手势

**Files:**
- Modify: `src/components/editor/PatternToolbar.vue`（`TOOLS` 加一项）
- Modify: `src/components/editor/PatternCanvas.vue`（`ToolGesture` 加 `"background"`、`startToolGesture` 分支、`finishToolGesture` emit）
- Test: `src/components/editor/__tests__/PatternToolbar.test.ts`、`src/components/editor/__tests__/PatternCanvas.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `EditorTool` 四值联合。
- Produces: `PatternToolbar` 的 `data-testid="tool-background"` 按钮（点击 emit `update:tool` 为 `"background"`）；`PatternCanvas` 的新事件 `background: [CellPoint]`。

- [ ] **Step 1: 写失败测试**

`PatternToolbar.test.ts` 追加：

```ts
it("第 4 个工具「去背景」：就在橡皮之后、点击上报 background", async () => {
  const wrapper = mountToolbar({ tool: "brush" });
  await wrapper.get('[data-testid="tool-background"]').trigger("click");
  expect(wrapper.emitted("update:tool")?.[0]).toEqual(["background"]);
});

it("当前工具是去背景时该按钮为按下态", () => {
  const wrapper = mountToolbar({ tool: "background" });
  expect(wrapper.get('[data-testid="tool-background"]').attributes("aria-pressed")).toBe("true");
});
```

`PatternCanvas.test.ts` 追加：

```ts
describe('tool = "background"', () => {
  it("单指按下并抬起 emit 一次 background，不带 paint / pick", async () => {
    const { wrapper, gesture } = mountCanvasAt({ tool: "background", width: 8, height: 8 });
    await gesture.tap({ x: 1, y: 2 });
    expect(wrapper.emitted("background")).toEqual([[{ x: 1, y: 2 }]]);
    expect(wrapper.emitted("paint")).toBeUndefined();
    expect(wrapper.emitted("pick")).toBeUndefined();
  });

  it("拖动不改结果：取的是按下那一格", async () => {
    const { wrapper, gesture } = mountCanvasAt({ tool: "background", width: 8, height: 8 });
    await gesture.down({ x: 0, y: 0 });
    await gesture.move({ x: 5, y: 5 });
    await gesture.up({ x: 5, y: 5 });
    expect(wrapper.emitted("background")).toEqual([[{ x: 0, y: 0 }]]);
  });

  it("落在图纸外不 emit", async () => {
    const { wrapper, gesture } = mountCanvasAt({ tool: "background", width: 2, height: 2, cellSize: 10 });
    await gesture.tap({ x: 999, y: 999 });
    expect(wrapper.emitted("background")).toBeUndefined();
  });
});
```

（`mountToolbar` / `mountCanvasAt` / `gesture` 用两个测试文件里既有的 mount 与指针模拟帮助函数；没有现成的就按该文件既有的 `pointerdown` → `pointerup` 派发写法逐字照抄。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/editor/__tests__/PatternToolbar.test.ts src/components/editor/__tests__/PatternCanvas.test.ts -t "去背景|background"`
Expected: FAIL —— 按钮与事件都不存在。

- [ ] **Step 3: 实现**

- `PatternToolbar.vue`：`TOOLS` 数组加 `{ tool: "background", label: "去背景" }`（放末位——橡皮在这条 tool 行里跟在三个工具之后，是**色槽**按钮，不参与本数组）。
- `PatternCanvas.vue`：
  - `ToolGesture` 加 `| { kind: "background"; pointerId: number; cell: CellPoint }`。
  - `emit` 加 `background: [CellPoint]`。
  - `startToolGesture`：`props.tool === "background"` 时 `toolGesture = { kind: "background", pointerId, cell }`（与 `pick` 同形态：只在按下那一刻记格）。
  - `finishToolGesture`：`gesture.kind === "background"` 时 `emit("background", gesture.cell)`；`pick` 那一支保持不动（`switch`/`if` 的顺序要让两个 `kind` 各自落到自己的 emit，别让 `pick` 分支兜住它）。
  - 文件顶部「`tool` 不是重绘源」那段注释照旧成立，不用改。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/editor/__tests__/PatternToolbar.test.ts src/components/editor/__tests__/PatternCanvas.test.ts`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/components/editor/PatternToolbar.vue src/components/editor/PatternCanvas.vue \
  src/components/editor/__tests__/PatternToolbar.test.ts src/components/editor/__tests__/PatternCanvas.test.ts
git commit -m "feat(editor): 工具栏加去背景按钮与画布点选手势"
```

---

### Task 10: 编辑页接线与文档索引

**Files:**
- Modify: `src/views/EditorPage.vue`（`onBackground` + 模板 `@background`）
- Modify: `docs/开发文档索引.md`（「逐阶段文档」表加一行）
- Test: `src/views/__tests__/EditorPage.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `patternBackgroundIndices`、Task 1 的 `BACKGROUND_TOLERANCE`、Task 8 的 `editor.eraseCells`、Task 9 的 `background` 事件、既有 `palette` 与 `createPaletteRuntime`。

- [ ] **Step 1: 写失败测试**

在 `EditorPage.test.ts` 追加 `describe("去背景工具")`，用该文件既有的「造记录 + 载入页面」帮助函数造一张 3×3 图纸：四边色号 0、中心色号 1，色卡取内置色卡前两色，并按需让两色的 ΔE 明显大于 10。

```ts
it("点边缘把连通背景整片吃掉，中心主体保留", async () => {
  const wrapper = await mountEditorWith(cellsAt);
  await clickTool(wrapper, "background");
  await tapCell(wrapper, { x: 0, y: 0 });
  expect(useEditor().pattern!.cells[0]).toBe(EMPTY);
  expect(useEditor().pattern!.cells[4]).not.toBe(EMPTY);
  expect(useEditor().pattern!.cells[1]).toBe(EMPTY);
});

it("点中心只吃掉中心那一格所属的连通区域", async () => {
  const wrapper = await mountEditorWith(cellsAt);
  await clickTool(wrapper, "background");
  await tapCell(wrapper, { x: 1, y: 1 });
  expect(useEditor().pattern!.cells[4]).toBe(EMPTY);
  expect(useEditor().pattern!.cells[0]).not.toBe(EMPTY);
});

it("[可一步撤销] 撤销一次回到点击之前，且不再有可撤销内容", async () => {
  const wrapper = await mountEditorWith(cellsAt);
  const before = [...useEditor().pattern!.cells];
  await clickTool(wrapper, "background");
  await tapCell(wrapper, { x: 0, y: 0 });
  await clickUndo(wrapper);
  expect([...useEditor().pattern!.cells]).toEqual(before);
  expect(useEditor().canUndo).toBe(false);
});

it("点空格不标脏、不留撤销记录", async () => {
  const wrapper = await mountEditorWith((x, y) => (x === 0 && y === 0 ? EMPTY : 0));
  await clickTool(wrapper, "background");
  await tapCell(wrapper, { x: 0, y: 0 });
  expect(useProjectSession().dirty).toBe(false);
  expect(useEditor().canUndo).toBe(false);
});
```

（`mountEditorWith` / `clickTool` / `tapCell` / `clickUndo` 是占位名：优先用该文件既有的载入与点击帮助函数，逐字照抄其交互手法。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/EditorPage.test.ts -t 去背景`
Expected: FAIL —— 点下去什么都不发生（页面没接 `background` 事件）。

- [ ] **Step 3: 实现**

- `EditorPage.vue`：import `BACKGROUND_TOLERANCE, patternBackgroundIndices` 与 `createPaletteRuntime`；加处理函数（与 `onPick` / `onSelect` 同级）：

```ts
/**
 * 去背景：点一下 → 求连通背景下标 → 交给 store 入账。
 *
 * **判定在 core、入账在 store**，本页只做两件事之间的搬运：色卡的 Lab 表用页面已经持有的
 * `palette` 生成（store 按设计不持有色卡），单词点击一条命令、一步可撤销。
 */
function onBackground(point: CellPoint): void {
  const pattern = editor.pattern;
  if (pattern === null) return;
  const indices = patternBackgroundIndices(
    pattern,
    createPaletteRuntime(palette).labs,
    point,
    BACKGROUND_TOLERANCE,
  );
  editor.eraseCells(indices);
}
```

- 模板里给 `<PatternCanvas>` 接上 `@background="onBackground"`（与既有 `@pick` / `@select` 同处）。
- 文件头那段解释性注释补一句：出口多了一条「点一下去背景」，判定不在本页。
- `docs/开发文档索引.md` 的「逐阶段文档」表加一行：`| 去背景（事前 + 事后） | [规格](superpowers/specs/2026-10-11-background-removal-design.md) | [计划](superpowers/plans/2026-10-11-background-removal.md) | — | 规格 §10（延后项） |`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/EditorPage.test.ts && npm run test`
Expected: 全绿。

- [ ] **Step 5: 全量验证**

Run: `npm run build && npm run test`
Expected: `vue-tsc` 无报错、构建成功、测试全绿。

- [ ] **Step 6: 提交**

```bash
git add src/views/EditorPage.vue src/views/__tests__/EditorPage.test.ts docs/开发文档索引.md
git commit -m "feat(editor): 编辑页接上去背景工具（点选连通背景，一步可撤销）"
```

---

## 完成后的自查

- [ ] 规格 §2 的三条目标各有一个端到端用例：任务 3（事前用色名额）、任务 10（事后点选与撤销）、任务 10 的「点空格无操作」。
- [ ] 规格 §10 的延后项一条都没被顺手做掉（没有容差滑条、没有按色号全删、没有羽化）。
- [ ] `git grep -n "removeBackground"` 的每一处都能对上规格 §6.2 的清单（draft / setup / param / rerun / file / types / project store）。
