# B4 导出（施工图 / 用量表 / 分享图 / 降级链 / 分片） 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在编辑器页内交付「导出」面板：把**当前内存里的图纸**渲染成施工图（超限自动分片，格像素 ≥32 时才画格内色号）、
全图用量表、分享图三类 PNG，逐张由用户手势保存，全部布局与坐标只由 `core/render/layout.ts` 一份算出来。

**架构：** 布局是纯计算（`core/render/layout.ts` 出 plan，含所有像素位置），绘制是纯函数（`sheet.ts` / `share.ts`
吃一个**注入的结构化 `RenderTarget2D`**，自己做零算术），平台能力集中在 `services/exporter.ts`（建画布 / toBlob / 下载 /
文件名）。分片只体现在 plan 的 `originCol` / `originRow` 上——`cellBox()` 是格子坐标到输出像素的**唯一**映射，
并由一条源码级闸门 + 一条跨计划不变量断言钉住。

**技术栈：** Vue 3 + TypeScript 严格模式 + Pinia + Tailwind v4 + vitest（happy-dom）。无新依赖。

**规格：** [docs/superpowers/specs/2026-10-05-app-b4-export-design.md](../specs/2026-10-05-app-b4-export-design.md)
（执行者**必须**与契约 `.superpowers/sdd/2026-10-05-app-b4-export/CONTRACT.md` 一起读：规格定行为，契约定名字与逐字口径）

---

## 全局约束

- `src/core/**` 是零依赖纯计算层：不得 import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，不得引用 DOM 全局
  （`CanvasRenderingContext2D` 在禁用清单里——core 自己声明 `RenderTarget2D`，由 services 注入真 ctx）。
- 每个渲染器 / 布局文件都必须**显式** `import { describe, expect, it } from "vitest"`（测试文件）或只用相对 import（实现文件）。
- TypeScript 严格模式，**禁止 `any`**；`Array.isArray` 的窄化必须用显式类型的局部量收回（`stores/editor.ts:327` 的先例）。
- **公开 API 的入口必须校验到「非法输入响亮失败」**，校验内联在本文件、写在任何写操作之前，不抽共享校验模块。
- 错误消息与 UI 文案**逐字**按契约 §3 / §4；`toThrow` 在 vitest 是**子串**匹配，别在报告里说成「精确匹配」。
- 不许删改既有测试的断言；新用例只加。改动既有注释时，若那句话因此失实，必须同时改。
- 提交信息用 Conventional Commits + 中文（例：`feat(render): 施工图布局与唯一坐标映射`）。
- 每个任务收尾都要跑：`npm run test`、`$env:TZ="UTC"; npm run test`、`npm run build`。
- 常量值一律从契约 §2 / 规格 §5.1 照抄，**不许在实现里另写字面量 29**（用 `TILE_STEP`，它来自 `BOARD_COLS`）。

---

## 文件结构（先锁分解，再派任务）

| 文件 | 职责 | 任务 |
|---|---|---|
| `src/core/render/types.ts` | `RenderTarget2D` + 纯类型（无逻辑） | 1 |
| `src/core/render/layout.ts` | 常量、`planSheets` / `planLegend` / `planShare` / `cellBox` / `countTileBeads` / `labelInk` | 1 |
| `src/core/render/sheet.ts` | `drawSheetTile` / `drawLegend`（吃注入 target，零算术） | 2 |
| `src/core/render/share.ts` | `drawShare` | 2 |
| `src/services/exporter.ts` | 建画布（严格回读）、ctx、`toBlob`、下载、文件名 | 3 |
| `src/components/editor/ExportPanel.vue` | 展示 + 事件出 | 4 |
| `src/components/editor/PatternToolbar.vue` | 加「导出」按钮 + `export` 事件（不改既有语义） | 4 |
| `src/views/EditorPage.vue` | 装配：`exporting`、plan computed、逐项状态、调 exporter | 4 |
| `src/views/CanvasLabPage.vue` | `/lab/canvas` 探针页（R2 真机实测装置） | 5 |
| `src/router/index.ts` | 加 `/lab/canvas` | 5 |
| 文档（README / AGENTS / CLAUDE / 主规格注记 / B3 两条 Minor / `buildPatternFromImage` JSDoc / 构建记录） | 收尾回写 | 6 |

**为什么这样切**：任务 1 是唯一承载「分片坐标」的层，主规格把分片自述为「本功能最易出 bug 的地方」——
它单独成一个任务，且必须有闸门与跨计划断言；任务 2 的两个渲染器共用同一个桩与同一条「零算术」约束，拆开会让
`helpers.ts` 与闸门用例被写两遍；任务 4 的面板与页面装配不可分开审（面板的 props 契约与页面给的实参是同一个东西）。

---

## 任务 0：装配裁定（开工前必读，不产出代码）

这些是**跨片段接口**的裁决，写在这里是为了让每个任务的实现者不必猜。与契约冲突时以契约为准，并**报告控制者**。

| # | 裁定 | 代价（如果错了） |
|---|---|---|
| R-1 | `SheetTilePlan.cellPx` **只给 `cellBox` 用**；`sheet.ts` / `share.ts` 里出现标识符 `cellPx` 就是缺陷（闸门会红）。渲染器要的线宽 / 字号一律从 plan 的派生字段取（`lineWidths` / `labelFontPx` / `tickFontPx`） | 后人顺手在渲染器里算一次坐标，分片就出现第二份数学 |
| R-2 | 渲染器读格子值一律 `cellAt(pattern, col, row)`（既有 core 导出）。**不许**自己写 `row * width + col`（闸门第 2 条会红） | 行优先 stride 写错 ⇒ 分片接缝错行，只在真机上看得出来 |
| R-3 | `plan` 是**纯数据**（不含函数 / 闭包），`tile` 必须来自 `plan.tiles`（渲染器入口用 `includes` 判定），否则抛第 3 节的消息 | 用 A 计划的 tile 配 B 计划的 plan 会把坐标静默映射到另一片 |
| R-4 | 面板的图纸来源恒为 `editor.pattern`；plan 是 `computed` 并**显式依赖 `editor.revision`**；`revision` 一变，所有「已生成」状态复位、预览丢弃。**不做**「面板打开时禁止编辑」 | 导出到旧图纸，且 UI 上看不出来 |
| R-5 | 逐项导出是**用户手势**：点一次 → 渲染一张 → 立刻下载 → 显示预览。**不做**连续多下载、不做 zip、不做 Web Share | 无法验证「到底存下了几片」，是项目明令消灭的静默失败形态 |
| R-6 | 导出**不乘 DPR**、**不经过 `renderPatternThumbnail`**（512 上限）；生成时间由调用方传字符串 | 产物随设备变化 / 得到一张「看起来正常」的低分辨率图 |
| R-7 | `/lab/canvas` 是开发期实验台：只在路由里存在，不进任何用户入口；页面自标「CI 不测」 | 后人把它当功能页维护 |
| R-8 | 收尾文档任务里对 `AGENTS.md` 与 `CLAUDE.md` 的改动**必须逐字相同地写进两份**（并行镜像） | 两份文档漂移，正是 B3 收尾修过的那条 |
| R-9 | **每次导出前**（`canvasToBlob` 之前）施工图与用量图必须调 `assertCanvasPainted(canvas)`；**分享图不调**（它按设计透明，没有"必定不透明"的点）。面板不调用它 ⇒ 它成为零消费者导出 | 超限画布得到一张「看起来正常」的白图，用户以为图纸本来就这样 |
| R-10 | 「逐张渲染后即时释放画布」落在**面板**（`canvas.width = 0; canvas.height = 0;` 写在 `finally` 里），**不新增函数名**；服务层不提供释放函数 | 抽出一个只有一个调用点的函数（本项目禁止的抽象）；或内存峰值变成 N 张画布 |
| R-11 | 探针页实测 `N ≠ 4096` 时**不并进收尾任务**：改常量要同时动 `layout.ts` + `layout.test.ts` + `AGENTS.md` + `CLAUDE.md` 四处，属**独立的小修复轮**（`N < 4096` 时优先级最高） | 在代码冻结后把一次未经审查的常量改动塞进纯文档任务，且四处只改一处 ⇒ 文档与实现漂移 |

---

## 任务 1：`core/render/types.ts` + `layout.ts`（唯一坐标来源）

**文件：**
- 创建：`src/core/render/types.ts`、`src/core/render/layout.ts`
- 测试：`src/core/render/__tests__/layout.test.ts`、`src/core/render/__tests__/layoutGate.test.ts`

**这个任务为什么单独成任务**：主规格把分片自述为「本功能最易出 bug 的地方」，而全部风险都压在这一层。
交付物是**可独立测试的纯函数**：`planSheets` / `planLegend` / `planShare` / `cellBox` / `countTileBeads` /
`labelInk`，外加两道词法闸门与一条跨计划不变量断言。

- [ ] **步骤 1：写类型文件 `src/core/render/types.ts`**

```ts
/**
 * B4 导出的纯类型：绘制目标接口 + 几何结构。
 *
 * **为什么 core 自己声明 `RenderTarget2D` 而不是用 `CanvasRenderingContext2D`**：后者在分层边界闸门
 * （`src/__tests__/coreBoundary.test.ts` 的 `FORBIDDEN_GLOBALS`）里是禁用全局——core 不得引用 DOM 全局。
 * 按 `AGENTS.md` 的口径「在 core 定义接口，在 services 注入实现」：`services/exporter.ts` 把真 ctx 传进来
 * （结构上满足本接口），测试用普通对象桩。代价如实记录：这是 core 里第一份不是纯数据的类型。
 */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 刻度：全局格号 + 它在**片内**的像素位置（位置由 layout 算好，渲染器不自算）。 */
export interface ColTick {
  readonly col: number;
  readonly x: number;
}
export interface RowTick {
  readonly row: number;
  readonly y: number;
}

/** 拼豆板边界：板序号（1 起）+ 全局格号 + 片内像素位置。 */
export interface ColBoardEdge {
  readonly board: number;
  readonly col: number;
  readonly x: number;
}
export interface RowBoardEdge {
  readonly board: number;
  readonly row: number;
  readonly y: number;
}

/** 网格线：像素位置 + 档位（thin = 每格、major = 每 5 格、board = 每 29 格）。 */
export interface GridLine {
  readonly at: number;
  readonly kind: "thin" | "major" | "board";
}

export interface LineWidths {
  readonly thin: number;
  readonly major: number;
  readonly board: number;
}

/**
 * 绘制目标：B4 的渲染器真正会调用的那一小撮 2D 方法。
 *
 * 属性用可写字段（而不是 setter 方法）是为了与真实 ctx 的结构对齐：`CanvasRenderingContext2D` 的
 * `fillStyle` 等是可变属性，写成只读属性会让真 ctx 不再结构兼容。
 */
export interface RenderTarget2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: "left" | "center" | "right";
  textBaseline: "top" | "middle" | "bottom";
  imageSmoothingEnabled: boolean;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  save(): void;
  restore(): void;
}
```

- [ ] **步骤 2：写失败的用例 `src/core/render/__tests__/layout.test.ts`**

先写**布局与几何**的用例（渲染器用例在任务 2）。文件头必须显式 import vitest。

```ts
import { describe, expect, it } from "vitest";
import { BOARD_COLS } from "../../pattern/board";
import { EMPTY, type Pattern } from "../../pattern/types";
import type { Palette } from "../../palette/types";
import {
  EXPORT_CELL_PX_FLOOR,
  EXPORT_CELL_PX_TARGET,
  EXPORT_MAX_EDGE,
  LEGEND_ROW_H,
  SHEET_INFO_BAR_H,
  SHEET_LABEL_MIN_CELL_PX,
  SHEET_MARGIN,
  SHEET_RULER_LEFT,
  SHEET_RULER_TOP,
  SHARE_CELL_PX_MAX,
  SHARE_CELL_PX_MIN,
  SHARE_MAX_EDGE,
  TICK_EVERY,
  TILE_STEP,
  cellBox,
  countTileBeads,
  labelInk,
  planLegend,
  planShare,
  planSheets,
  rgbCss,
  shareCellBox,
} from "../layout";

/**
 * 布局只用 `palette.id` / 色号 / rgb；不需要真色卡（真色卡在 services 层，core 测试不许 import services）。
 */
function makePalette(count = 4): Palette {
  return {
    id: "test-palette",
    name: "测试色卡",
    source: "test",
    accuracy: "屏幕色仅供参考，以实物为准",
    colors: Array.from({ length: count }, (_, i) => ({
      code: `A${i + 1}`,
      name: `色 ${i + 1}`,
      rgb: [i * 20, i * 30, i * 40] as const,
    })),
  };
}

function makePattern(width: number, height: number, fill = 0): Pattern {
  const cells = new Uint16Array(width * height);
  cells.fill(fill);
  return { width, height, paletteId: "test-palette", cells };
}

describe("B4 布局常量", () => {
  it("常量值就是规格 §5.1 定的那一组（改坏即红）", () => {
    expect(EXPORT_MAX_EDGE).toBe(4096);
    expect(EXPORT_CELL_PX_TARGET).toBe(40);
    expect(SHEET_LABEL_MIN_CELL_PX).toBe(32);
    expect(EXPORT_CELL_PX_FLOOR).toBe(8);
    expect(SHARE_MAX_EDGE).toBe(2048);
    expect(SHARE_CELL_PX_MIN).toBe(4);
    expect(SHARE_CELL_PX_MAX).toBe(64);
    expect(TICK_EVERY).toBe(5);
    expect(LEGEND_ROW_H).toBe(30);
    expect(SHEET_MARGIN).toBe(24);
    expect(SHEET_RULER_LEFT).toBe(64);
    expect(SHEET_RULER_TOP).toBe(44);
    expect(SHEET_INFO_BAR_H).toBe(108);
    // 分片步长必须来自 board.ts，不是另一份字面量 29
    expect(TILE_STEP).toBe(BOARD_COLS);
    expect(TILE_STEP).toBe(29);
  });
});

describe("planSheets：单张", () => {
  it("58×58 是 1 张、40 px/格、含色号", () => {
    const plan = planSheets(makePattern(58, 58), makePalette());
    expect(plan.kind).toBe("sheet");
    expect(plan.tiles).toHaveLength(1);
    expect(plan.cellPx).toBe(40);
    expect(plan.labels).toBe(true);
    expect(plan.tileCols).toBe(58);
    expect(plan.tileRows).toBe(58);
    expect(plan.warnings).toEqual([]);
    const tile = plan.tiles[0]!;
    expect(tile.canvasWidth).toBe(2432);
    expect(tile.canvasHeight).toBe(2564);
    expect(tile.grid).toEqual({ x: 88, y: 176, width: 2320, height: 2320 });
    expect(tile.index).toBe(0);
    expect(tile.rowIndex).toBe(0);
    expect(tile.colIndex).toBe(0);
  });

  it("116×116 仍是 1 张，格像素被两轴取小压到 33", () => {
    const plan = planSheets(makePattern(116, 116), makePalette());
    expect(plan.tiles).toHaveLength(1);
    expect(plan.cellPx).toBe(33);
    expect(plan.labels).toBe(true);
    expect(plan.tiles[0]!.canvasWidth).toBe(3940);
    expect(plan.tiles[0]!.canvasHeight).toBe(4072);
  });
});

describe("planSheets：分片", () => {
  it("200×200 分成 4 张，逐格恰好被一片覆盖（无重叠无缺口）", () => {
    const plan = planSheets(makePattern(200, 200), makePalette());
    expect(plan.tiles).toHaveLength(4);
    for (const tile of plan.tiles) {
      expect(tile.cols).toBeLessThanOrEqual(plan.tileCols);
      expect(tile.rows).toBeLessThanOrEqual(plan.tileRows);
      expect(tile.originCol % TILE_STEP).toBe(0);
      expect(tile.originRow % TILE_STEP).toBe(0);
    }
    const coverage = new Uint8Array(200 * 200);
    for (const tile of plan.tiles) {
      for (let row = tile.originRow; row < tile.originRow + tile.rows; row += 1) {
        for (let col = tile.originCol; col < tile.originCol + tile.cols; col += 1) {
          coverage[row * 200 + col] += 1;
        }
      }
    }
    expect(coverage.every((n) => n === 1)).toBe(true);
  });

  it("500×500 分成 25 张、每片 116 格、33 px/格", () => {
    const plan = planSheets(makePattern(500, 500), makePalette());
    expect(plan.tiles).toHaveLength(25);
    expect(plan.tileCols).toBe(116);
    expect(plan.tileRows).toBe(116);
    expect(plan.cellPx).toBe(33);
    expect(plan.tiles.map((t) => t.index)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(plan.tiles[5]!.rowIndex).toBe(1);
    expect(plan.tiles[5]!.colIndex).toBe(0);
    expect(plan.tiles[24]!.rowIndex).toBe(4);
    expect(plan.tiles[24]!.colIndex).toBe(4);
  });

  it("末片取剩余格数（200 的第二列片是 84 格）", () => {
    const plan = planSheets(makePattern(200, 200), makePalette());
    const right = plan.tiles[1]!;
    expect(right.originCol).toBe(116);
    expect(right.cols).toBe(84);
    expect(right.canvasWidth).toBe(2 * SHEET_MARGIN + SHEET_RULER_LEFT + 84 * plan.cellPx);
  });
});

describe("planSheets：色号阈值与降级链", () => {
  it("maxEdge = 1200 时 cellPx 恰好 32 且仍画色号", () => {
    const plan = planSheets(makePattern(500, 500), makePalette(), { maxEdge: 1200 });
    expect(plan.cellPx).toBe(32);
    expect(plan.labels).toBe(true);
    expect(plan.tiles).toHaveLength(324);
  });

  it("maxEdge = 1143 时 cellPx = 31、省略色号、给出结构化 warning", () => {
    const plan = planSheets(makePattern(500, 500), makePalette(), { maxEdge: 1143 });
    expect(plan.cellPx).toBe(31);
    expect(plan.labels).toBe(false);
    expect(plan.warnings).toEqual([{ code: "labels-omitted", maxEdge: 1143, cellPx: 31 }]);
  });

  it("降级链全部失败时响亮拒绝（maxEdge = 320）", () => {
    expect(() => planSheets(makePattern(500, 500), makePalette(), { maxEdge: 320 })).toThrow(
      "连 8 px/格 都放不下",
    );
  });

  it("maxEdge 非法（NaN / 小数 / 0 / 负数）一律抛", () => {
    for (const bad of [Number.NaN, 4096.5, 0, -1]) {
      expect(() => planSheets(makePattern(4, 4), makePalette(), { maxEdge: bad })).toThrow(
        "画布上限必须是 ≥1 的整数",
      );
    }
  });

  it("图纸 / 色卡的入口守卫", () => {
    expect(() => planSheets(makePattern(4, 4), { ...makePalette(), id: "other" })).toThrow(
      "与传入的色卡 other 不一致",
    );
    const broken = makePattern(4, 4);
    const short = { ...broken, cells: new Uint16Array(15) };
    expect(() => planSheets(short, makePalette())).toThrow("需要 16 格，实际 15 格");
  });
});

describe("cellBox：唯一映射", () => {
  const plan = planSheets(makePattern(200, 200), makePalette());
  const first = plan.tiles[0]!;
  const fourth = plan.tiles[3]!;

  it("片内四角逐位正确", () => {
    expect(cellBox(first, 0, 0)).toEqual({ x: 88, y: 176, width: 33, height: 33 });
    expect(cellBox(first, 115, 115)).toEqual({ x: 88 + 115 * 33, y: 176 + 115 * 33, width: 33, height: 33 });
    expect(cellBox(fourth, 116, 116)).toEqual({ x: 88, y: 176, width: 33, height: 33 });
    expect(cellBox(fourth, 199, 199)).toEqual({ x: 88 + 83 * 33, y: 176 + 83 * 33, width: 33, height: 33 });
  });

  it("跨计划不变量：同一格在单张与分片计划里落到同一片内像素", () => {
    const single = planSheets(makePattern(116, 116), makePalette());
    const tiled = planSheets(makePattern(500, 500), makePalette());
    // 前提：两次计划的 cellPx 相同（不同就无从比较——测试自己先钉住这个前提）
    expect(single.cellPx).toBe(33);
    expect(tiled.cellPx).toBe(33);
    for (const [col, row] of [[0, 0], [7, 13], [115, 115]] as const) {
      expect(cellBox(tiled.tiles[0]!, col, row)).toEqual(cellBox(single.tiles[0]!, col, row));
    }
  });

  it("越界与非安全整数一律抛（不静默取整、不夹取）", () => {
    expect(() => cellBox(first, 116, 0)).toThrow("列 116 不在本片范围 0–115 内");
    expect(() => cellBox(first, 0, 116)).toThrow("行 116 不在本片范围 0–115 内");
    expect(() => cellBox(first, -1, 0)).toThrow("列 -1 不在本片范围 0–115 内");
    expect(() => cellBox(first, 1.5, 0)).toThrow("格子列号必须是安全整数");
    expect(() => cellBox(first, 0, 2 ** 53)).toThrow("格子行号必须是安全整数");
  });
});

describe("countTileBeads", () => {
  it("只数本片的实心格（空格不计）", () => {
    const pattern = makePattern(58, 58, 0);
    pattern.cells[0] = EMPTY;
    pattern.cells[1] = EMPTY;
    const plan = planSheets(pattern, makePalette());
    expect(countTileBeads(pattern, plan.tiles[0]!)).toBe(58 * 58 - 2);
  });

  it("片范围超出图纸时响亮拒绝（否则 cellAt 会静默返回 EMPTY、数出一个偏小的数）", () => {
    const pattern = makePattern(10, 10);
    const plan = planSheets(pattern, makePalette());
    const broken = { ...plan.tiles[0]!, cols: 20 };
    expect(() => countTileBeads(pattern, broken)).toThrow("超出图纸");
  });
});

describe("labelInk 与 rgbCss", () => {
  it("白底黑字、黑底白字（L* 距黑 / 白谁近用谁）", () => {
    expect(labelInk([255, 255, 255])).toBe("rgb(0, 0, 0)");
    expect(labelInk([0, 0, 0])).toBe("rgb(255, 255, 255)");
  });

  it("分量非有限时抛（复用 rgbToLab 的既有守卫，本函数不写第二份）", () => {
    expect(() => labelInk([Number.NaN, 0, 0])).toThrow();
  });

  it("rgbCss 是输出层唯一的颜色序列化口径", () => {
    expect(rgbCss([255, 0, 0])).toBe("rgb(255, 0, 0)");
    expect(rgbCss([0, 0, 0])).toBe("rgb(0, 0, 0)");
    // 越界的**有限**值夹到 0–255（与 rgbToLab 的既有口径一致）
    expect(rgbCss([300, -5, 12.6])).toBe("rgb(255, 0, 13)");
    // 非有限即抛，不静默产出一个 "rgb(NaN, …)"
    expect(() => rgbCss([Number.NaN, 0, 0])).toThrow("颜色分量必须是有限数字");
  });
});

describe("网格线、刻度与板边界", () => {
  it("线按全局坐标分档：每格细、每 5 格主、每 29 格板（board 优先）", () => {
    const tile = planSheets(makePattern(58, 58), makePalette()).tiles[0]!;
    expect(tile.vLines).toHaveLength(59);
    expect(tile.vLines[0]).toEqual({ at: 88, kind: "board" });
    expect(tile.vLines[1]).toEqual({ at: 88 + 40, kind: "thin" });
    expect(tile.vLines[5]).toEqual({ at: 88 + 5 * 40, kind: "major" });
    expect(tile.vLines[29]).toEqual({ at: 88 + 29 * 40, kind: "board" });
    expect(tile.hLines).toHaveLength(59);
    expect(tile.lineWidths).toEqual({ thin: 1, major: 2, board: 3 });
  });

  it("刻度每 5 格一个、位置与全局列号一致；板边界带板序号", () => {
    const tile = planSheets(makePattern(58, 58), makePalette()).tiles[0]!;
    expect(tile.colTicks.map((t) => t.col)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(tile.colTicks[1]).toEqual({ col: 5, x: 88 + 5 * 40 });
    expect(tile.rowTicks.map((t) => t.row)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(tile.colBoards).toEqual([
      { board: 1, col: 0, x: 88 },
      { board: 2, col: 29, x: 88 + 29 * 40 },
    ]);
  });

  it("分片时刻度与板边界仍取全局坐标，不是片内相对坐标", () => {
    const plan = planSheets(makePattern(500, 500), makePalette());
    const second = plan.tiles[1]!; // 第 0 行第 1 列片：列 116–231
    expect(second.originCol).toBe(116);
    expect(second.colTicks[0]).toEqual({ col: 120, x: 88 + (120 - 116) * 33 });
    expect(second.colBoards[0]).toEqual({ board: 5, col: 116, x: 88 });
  });
});

describe("planLegend", () => {
  const usages = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ code: `A${i + 1}`, name: `色 ${i + 1}`, count: i + 1 }));

  it("221 色在 4096 上限下排成 13 列 17 行", () => {
    const plan = planLegend(usages(221));
    expect(plan.kind).toBe("legend");
    expect(plan.itemCols).toBe(13);
    expect(plan.itemRows).toBe(17);
    expect(plan.canvasWidth).toBe(2 * SHEET_MARGIN + 13 * 300);
    expect(plan.canvasHeight).toBe(2 * SHEET_MARGIN + SHEET_INFO_BAR_H + 17 * LEGEND_ROW_H + 44);
  });

  it("空用量表只有信息条与合计（0 行）", () => {
    const plan = planLegend([]);
    expect(plan.itemRows).toBe(0);
    expect(plan.canvasHeight).toBe(2 * SHEET_MARGIN + SHEET_INFO_BAR_H + 44);
  });

  it("项非法或色号重复一律抛", () => {
    expect(() => planLegend([{ code: "", name: "x", count: 1 }])).toThrow("用量表第 0 项的 code 非法");
    expect(() => planLegend([{ code: "A1", name: "x", count: -1 }])).toThrow("用量表第 0 项的 count 非法");
    expect(() =>
      planLegend([
        { code: "A1", name: "x", count: 1 },
        { code: "A1", name: "y", count: 2 },
      ]),
    ).toThrow("用量表里的色号重复：A1");
  });

  it("上限太小放不下时响亮拒绝", () => {
    expect(() => planLegend(usages(221), { maxEdge: 256 })).toThrow("太小，无法生成用量表");
  });
});

describe("planShare 与 shareCellBox", () => {
  it("长边夹到上限；小图纸不放大超过 64 px/格", () => {
    const big = planShare(makePattern(500, 500));
    expect(big.kind).toBe("share");
    expect(big.cellPx).toBe(4);
    expect(big.cols).toBe(500);
    expect(big.rows).toBe(500);
    expect(big.canvasWidth).toBe(2000);
    expect(big.canvasHeight).toBe(2000);
    expect(planShare(makePattern(58, 44)).cellPx).toBe(35);
    expect(planShare(makePattern(58, 44)).canvasWidth).toBe(58 * 35);
    expect(planShare(makePattern(58, 44)).canvasHeight).toBe(44 * 35);
    expect(planShare(makePattern(8, 8)).cellPx).toBe(SHARE_CELL_PX_MAX);
    expect(planShare(makePattern(8, 8)).canvasWidth).toBe(512);
  });

  it("shareCellBox 是分享图格像素的唯一来源（无条件边距）", () => {
    const plan = planShare(makePattern(500, 500));
    expect(shareCellBox(plan, 0, 0)).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(shareCellBox(plan, 499, 499)).toEqual({ x: 1996, y: 1996, width: 4, height: 4 });
    expect(shareCellBox(plan, 7, 3)).toEqual({ x: 28, y: 12, width: 4, height: 4 });
  });

  it("shareCellBox 的守卫与 cellBox 同口径", () => {
    const plan = planShare(makePattern(8, 8));
    expect(() => shareCellBox(plan, 8, 0)).toThrow("列 8 不在分享图范围 0–7 内");
    expect(() => shareCellBox(plan, 0, 8)).toThrow("行 8 不在分享图范围 0–7 内");
    expect(() => shareCellBox(plan, -1, 0)).toThrow("列 -1 不在分享图范围 0–7 内");
    expect(() => shareCellBox(plan, 0.5, 0)).toThrow("格子列号必须是安全整数");
    expect(() => shareCellBox(plan, 0, 2 ** 53)).toThrow("格子行号必须是安全整数");
  });

  it("上限连 4 px/格 都放不下时抛", () => {
    expect(() => planShare(makePattern(500, 500), { maxEdge: 64 })).toThrow("太小，无法生成分享图");
  });
});
```

- [ ] **步骤 3：运行测试，确认失败**

运行：`npx vitest run src/core/render/__tests__/layout.test.ts`
预期：FAIL——`Failed to resolve import "../layout"`（模块还不存在）。

- [ ] **步骤 4：写实现 `src/core/render/layout.ts`**

```ts
import { rgbToLab } from "../color/space";
import { BOARD_COLS } from "../pattern/board";
import { cellAt } from "../pattern/edit";
import type { ColorUsage } from "../pattern/stats";
import { EMPTY, type Pattern } from "../pattern/types";
import type { Palette } from "../palette/types";
import type {
  ColBoardEdge,
  ColTick,
  GridLine,
  LineWidths,
  PixelRect,
  RowBoardEdge,
  RowTick,
} from "./types";

/**
 * B4 导出的**唯一几何来源**：画布尺寸、格像素、色号阈值、分片、格子→像素映射、刻度与板边界位置。
 *
 * **为什么全部位置都在这里算完**：主规格 §7.3 把分片自述为「本功能最易出 bug 的地方（坐标偏移、接缝错行、
 * 图例重复）」。唯一能结构性消灭它的做法是让渲染器**没有坐标可算**——`sheet.ts` / `share.ts` 只按 plan 给的
 * 像素位置调用 `fillRect` / `lineTo`，连格子中心都不自己推。这条由 `__tests__/layoutGate.test.ts` 的词法闸门
 * 守着（渲染器里出现 `cellPx` 即红）。
 *
 * **只有一层坐标**：格坐标是全图全局的 `(col, row)`；分片只体现在 tile 的 `originCol` / `originRow` 上。
 * `cellBox(tile, col, row)` 是两者之间唯一的映射，且满足承重不变量：**只要两次计划的 `cellPx` 相同，
 * 同一格在单张计划与任一分片计划里得到的片内像素逐位相等**（分片只是"换个原点"，不是另一套数学）。
 *
 * **为什么 `maxEdge` 是入参而不是只读常量**：平台上限（主规格 R2）只能真机实测，而「上限很小」这一整类
 * 降级分支在 CI 里必须能被判别——把上限做成入参，就能用合成值（如 1143、320）确定性地走过每一条分支。
 */

/** 产物画布单边上限。**4096 是主规格 §7.3 所给区间的保守下界**，探针页 `/lab/canvas` 实测后调整。 */
export const EXPORT_MAX_EDGE = 4096;
/** 施工图的目标格像素（色号可读、文件不至于过大）。 */
export const EXPORT_CELL_PX_TARGET = 40;
/**
 * 格内色号阈值，同时是默认降级下限（主规格 §7.2 的 32px）。
 *
 * **命名刻意避开 `core/pattern/view.ts` 的 `CELL_LABEL_MIN_CELL_PX`（= 28）**：那是屏幕上「这格是什么色号」
 * 的即时提示阈值，这里是纸面输出阈值，两处语义不同。同名不同义的量传错不会报错——本项目已为此记过账。
 */
export const SHEET_LABEL_MIN_CELL_PX = 32;
/** 最终兜底格像素（主规格 §7.3）。走到这里意味着 `labels = false`。 */
export const EXPORT_CELL_PX_FLOOR = 8;
/** 四周边距。 */
export const SHEET_MARGIN = 24;
/** 左刻度带宽（行号 + 板号）。 */
export const SHEET_RULER_LEFT = 64;
/** 上刻度带高（列号 + 板号）。 */
export const SHEET_RULER_TOP = 44;
/** 顶部信息条高（两行）。 */
export const SHEET_INFO_BAR_H = 108;
/** 页脚高（片范围）。 */
export const SHEET_FOOTER_H = 44;
/** 用量表每项宽。 */
export const LEGEND_ITEM_W = 300;
/** 用量表每行高。 */
export const LEGEND_ROW_H = 30;
/** 用量表列数上限护栏（当前 4096 上限下实际列数是 13）。 */
export const LEGEND_COLS_MAX = 15;
/** 三档线宽：每格 / 每 5 格 / 每 29 格。 */
export const SHEET_LINE_WIDTHS: LineWidths = { thin: 1, major: 2, board: 3 };
/** 刻度数字最小字号。 */
export const SHEET_TICK_FONT_MIN = 12;
/** 分享图长边上限（手机内存与文件体积；分享图是「看轮廓」的图，不需逐格可辨）。 */
export const SHARE_MAX_EDGE = 2048;
export const SHARE_CELL_PX_MIN = 4;
export const SHARE_CELL_PX_MAX = 64;
/** 坐标刻度间隔（格）。 */
export const TICK_EVERY = 5;
/**
 * 分片步长 = 一块拼豆板的格数。**取自 `board.ts`，不写第二份字面量 29**——图纸分区与界面上
 * 「需要几块板」必须是同一组数字。
 */
export const TILE_STEP = BOARD_COLS;

/**
 * 格内色号字号比例（0.38 × cellPx）。
 *
 * **刻意不与 `core/pattern/view.ts` 共享**：那里是屏幕即时提示、这里是纸面输出，两处阈值（28 / 32）
 * 本就不同；共享一个比例常量会把「改一处观感影响两处语义」变成静默耦合。真要合并，必须同时改两处用例。
 */
const LABEL_FONT_RATIO = 0.38;
/** 刻度数字字号比例（0.3 × cellPx，下限 `SHEET_TICK_FONT_MIN`）。 */
const TICK_FONT_RATIO = 0.3;

/** 一张施工图分片。字段与契约 §2 逐字一致；**plan 是纯数据**（不含函数 / 闭包）。 */
export interface SheetTilePlan {
  readonly index: number;
  readonly rowIndex: number;
  readonly colIndex: number;
  readonly originCol: number;
  readonly originRow: number;
  readonly cols: number;
  readonly rows: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly grid: PixelRect;
  readonly vLines: readonly GridLine[];
  readonly hLines: readonly GridLine[];
  readonly colTicks: readonly ColTick[];
  readonly rowTicks: readonly RowTick[];
  readonly colBoards: readonly ColBoardEdge[];
  readonly rowBoards: readonly RowBoardEdge[];
  readonly lineWidths: LineWidths;
  readonly labelFontPx: number;
  readonly tickFontPx: number;
  /** **只给 `cellBox` 用**；渲染器读它就是缺陷（词法闸门会红）。 */
  readonly cellPx: number;
}

export interface SheetPlan {
  readonly kind: "sheet";
  readonly cellPx: number;
  readonly labels: boolean;
  readonly tileCols: number;
  readonly tileRows: number;
  readonly tiles: readonly SheetTilePlan[];
  readonly warnings: readonly ExportWarning[];
}

/** 结构化提示：core 只出事实，中文文案在视图层（与 `formatCm` 的既有分工一致）。 */
export type ExportWarning = {
  readonly code: "labels-omitted";
  readonly maxEdge: number;
  readonly cellPx: number;
};

export interface LegendPlan {
  readonly kind: "legend";
  readonly itemCols: number;
  readonly itemRows: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly itemWidth: number;
  readonly rowHeight: number;
  readonly headerY: number;
  readonly tableTop: number;
  readonly totalY: number;
  readonly footerY: number;
}

export interface SharePlan {
  readonly kind: "share";
  readonly cellPx: number;
  readonly cols: number;
  readonly rows: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export interface PlanOptions {
  /** 产物画布单边上限；缺省取 `EXPORT_MAX_EDGE`（`planShare` 取 `SHARE_MAX_EDGE`）。 */
  readonly maxEdge?: number;
}

function requirePositiveInteger(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${what}必须是 ≥1 的整数（当前 ${String(value)}）`);
  }
  return value;
}

function requireSafeInteger(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${what}必须是安全整数（当前 ${String(value)}）`);
  }
  return value;
}

function requirePattern(pattern: Pattern): Pattern {
  if (!Number.isInteger(pattern.width) || pattern.width < 1) {
    throw new Error(`图纸宽度必须是 ≥1 的整数（当前 ${String(pattern.width)}）`);
  }
  if (!Number.isInteger(pattern.height) || pattern.height < 1) {
    throw new Error(`图纸高度必须是 ≥1 的整数（当前 ${String(pattern.height)}）`);
  }
  if (pattern.cells.length !== pattern.width * pattern.height) {
    throw new Error(
      `图纸数据与尺寸不一致：${pattern.width}×${pattern.height} 需要 ${pattern.width * pattern.height} 格，实际 ${pattern.cells.length} 格`,
    );
  }
  return pattern;
}

function requirePalette(pattern: Pattern, palette: Palette): Palette {
  if (pattern.paletteId !== palette.id) {
    throw new Error(`图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${palette.id} 不一致`);
  }
  return palette;
}

function requireMaxEdge(options: PlanOptions | undefined, fallback: number): number {
  return requirePositiveInteger(options?.maxEdge ?? fallback, "画布上限");
}

/** 网格线档位：板边界优先于 5 格主刻度（145 这类重叠位置必须算板边界）。 */
function kindOf(index: number): GridLine["kind"] {
  if (index % TILE_STEP === 0) return "board";
  if (index % TICK_EVERY === 0) return "major";
  return "thin";
}

function makeTile(input: {
  index: number; rowIndex: number; colIndex: number;
  originCol: number; originRow: number; cols: number; rows: number;
  cellPx: number; labelFontPx: number; tickFontPx: number;
}): SheetTilePlan {
  const { index, rowIndex, colIndex, originCol, originRow, cols, rows, cellPx } = input;
  const grid: PixelRect = {
    x: SHEET_MARGIN + SHEET_RULER_LEFT,
    y: SHEET_MARGIN + SHEET_INFO_BAR_H + SHEET_RULER_TOP,
    width: cols * cellPx,
    height: rows * cellPx,
  };
  const vLines: GridLine[] = [];
  for (let col = originCol; col <= originCol + cols; col += 1) {
    vLines.push({ at: grid.x + (col - originCol) * cellPx, kind: kindOf(col) });
  }
  const hLines: GridLine[] = [];
  for (let row = originRow; row <= originRow + rows; row += 1) {
    hLines.push({ at: grid.y + (row - originRow) * cellPx, kind: kindOf(row) });
  }
  const colTicks: ColTick[] = [];
  for (let col = originCol; col < originCol + cols; col += 1) {
    if (col % TICK_EVERY === 0) colTicks.push({ col, x: grid.x + (col - originCol) * cellPx });
  }
  const rowTicks: RowTick[] = [];
  for (let row = originRow; row < originRow + rows; row += 1) {
    if (row % TICK_EVERY === 0) rowTicks.push({ row, y: grid.y + (row - originRow) * cellPx });
  }
  const colBoards: ColBoardEdge[] = [];
  for (let col = originCol; col < originCol + cols; col += 1) {
    if (col % TILE_STEP === 0) {
      colBoards.push({ board: col / TILE_STEP + 1, col, x: grid.x + (col - originCol) * cellPx });
    }
  }
  const rowBoards: RowBoardEdge[] = [];
  for (let row = originRow; row < originRow + rows; row += 1) {
    if (row % TILE_STEP === 0) {
      rowBoards.push({ board: row / TILE_STEP + 1, row, y: grid.y + (row - originRow) * cellPx });
    }
  }
  return {
    index, rowIndex, colIndex, originCol, originRow, cols, rows,
    canvasWidth: 2 * SHEET_MARGIN + SHEET_RULER_LEFT + cols * cellPx,
    canvasHeight: 2 * SHEET_MARGIN + SHEET_INFO_BAR_H + SHEET_RULER_TOP + rows * cellPx + SHEET_FOOTER_H,
    grid, vLines, hLines, colTicks, rowTicks, colBoards, rowBoards,
    lineWidths: SHEET_LINE_WIDTHS, labelFontPx: input.labelFontPx, tickFontPx: input.tickFontPx, cellPx,
  };
}

/**
 * 施工图分片计划。
 *
 * 算法与它的收敛性证明见规格 §5.2：先按「色号可读的最小格像素」定每片几块板，再由两轴取小定格像素，
 * 最后划片。**不含循环依赖、不需要迭代试错**——任何一张产物的两边都 ≤ `maxEdge`。
 */
export function planSheets(pattern: Pattern, palette: Palette, options?: PlanOptions): SheetPlan {
  requirePattern(pattern);
  requirePalette(pattern, palette);
  const maxEdge = requireMaxEdge(options, EXPORT_MAX_EDGE);

  const innerW = maxEdge - 2 * SHEET_MARGIN - SHEET_RULER_LEFT;
  const innerH = maxEdge - 2 * SHEET_MARGIN - SHEET_INFO_BAR_H - SHEET_RULER_TOP - SHEET_FOOTER_H;
  if (innerW < 1 || innerH < 1) {
    throw new Error(`画布上限 ${maxEdge} px 太小，无法生成施工图`);
  }

  const kc = Math.floor(innerW / (TILE_STEP * SHEET_LABEL_MIN_CELL_PX));
  const kr = Math.floor(innerH / (TILE_STEP * SHEET_LABEL_MIN_CELL_PX));
  const labels = kc >= 1 && kr >= 1;
  const tileCols = Math.min(pattern.width, TILE_STEP * Math.max(kc, 1));
  const tileRows = Math.min(pattern.height, TILE_STEP * Math.max(kr, 1));

  const rawCellPx = Math.min(Math.floor(innerW / tileCols), Math.floor(innerH / tileRows));
  if (!labels && rawCellPx < EXPORT_CELL_PX_FLOOR) {
    throw new Error(`画布上限 ${maxEdge} px 连 ${EXPORT_CELL_PX_FLOOR} px/格 都放不下`);
  }
  const lo = labels ? SHEET_LABEL_MIN_CELL_PX : EXPORT_CELL_PX_FLOOR;
  const hi = labels ? EXPORT_CELL_PX_TARGET : SHEET_LABEL_MIN_CELL_PX - 1;
  const cellPx = Math.min(Math.max(rawCellPx, lo), hi);
  const labelFontPx = Math.max(1, Math.round(cellPx * LABEL_FONT_RATIO));
  const tickFontPx = Math.max(SHEET_TICK_FONT_MIN, Math.round(cellPx * TICK_FONT_RATIO));

  const tiles: SheetTilePlan[] = [];
  let rowIndex = 0;
  for (let originRow = 0; originRow < pattern.height; originRow += tileRows) {
    let colIndex = 0;
    for (let originCol = 0; originCol < pattern.width; originCol += tileCols) {
      tiles.push(
        makeTile({
          index: tiles.length, rowIndex, colIndex, originCol, originRow,
          cols: Math.min(tileCols, pattern.width - originCol),
          rows: Math.min(tileRows, pattern.height - originRow),
          cellPx, labelFontPx, tickFontPx,
        }),
      );
      colIndex += 1;
    }
    rowIndex += 1;
  }

  return {
    kind: "sheet",
    cellPx,
    labels,
    tileCols,
    tileRows,
    tiles,
    warnings: labels ? [] : [{ code: "labels-omitted", maxEdge, cellPx }],
  };
}

/**
 * 格坐标 → **片内**像素矩形。**分片与单张共用这一条映射**（规格 §4.2 的承重不变量）。
 *
 * 越界（不在本片范围内）与小数 / 非安全整数一律抛错，不静默取整、不夹取：静默会把「接缝错行」变成
 * 只在真机上看得出、且无法复现的手感问题。
 */
export function cellBox(tile: SheetTilePlan, col: number, row: number): PixelRect {
  requireSafeInteger(col, "格子列号");
  requireSafeInteger(row, "格子行号");
  if (col < tile.originCol || col >= tile.originCol + tile.cols) {
    throw new Error(`列 ${col} 不在本片范围 ${tile.originCol}–${tile.originCol + tile.cols - 1} 内`);
  }
  if (row < tile.originRow || row >= tile.originRow + tile.rows) {
    throw new Error(`行 ${row} 不在本片范围 ${tile.originRow}–${tile.originRow + tile.rows - 1} 内`);
  }
  return {
    x: tile.grid.x + (col - tile.originCol) * tile.cellPx,
    y: tile.grid.y + (row - tile.originRow) * tile.cellPx,
    width: tile.cellPx,
    height: tile.cellPx,
  };
}

/** 片范围必须落在图纸内（否则 `cellAt` 会静默返回 `EMPTY`，数出一个偏小的数）。 */
function requireTileWithinPattern(pattern: Pattern, tile: SheetTilePlan): void {
  requireSafeInteger(tile.originCol, "片起始列");
  requireSafeInteger(tile.originRow, "片起始行");
  requireSafeInteger(tile.cols, "片列数");
  requireSafeInteger(tile.rows, "片行数");
  if (tile.cols < 1 || tile.rows < 1) {
    throw new Error(`片范围非法：${tile.cols}×${tile.rows}（列数 / 行数必须 ≥1）`);
  }
  if (tile.originCol < 0 || tile.originRow < 0 ||
      tile.originCol + tile.cols > pattern.width || tile.originRow + tile.rows > pattern.height) {
    throw new Error(
      `片范围 ${tile.originCol}–${tile.originCol + tile.cols - 1} × ${tile.originRow}–${tile.originRow + tile.rows - 1} 超出图纸 ${pattern.width}×${pattern.height}`,
    );
  }
}

/** 本片实心格数（空格不计）。信息条与页脚用它；O(本片格数)。 */
export function countTileBeads(pattern: Pattern, tile: SheetTilePlan): number {
  requirePattern(pattern);
  requireTileWithinPattern(pattern, tile);
  let count = 0;
  for (let row = tile.originRow; row < tile.originRow + tile.rows; row += 1) {
    for (let col = tile.originCol; col < tile.originCol + tile.cols; col += 1) {
      if (cellAt(pattern, col, row) !== EMPTY) count += 1;
    }
  }
  return count;
}

/**
 * 格内色号的墨色：取该色 `rgbToLab` 的 `L*`，离黑（L\*=0）与白（L\*=100）谁近用谁。
 *
 * 这是**对比度启发式**（不是色差判定，也不是可采购信息）；用 Lab 而不是自算相对亮度，是为了不与
 * 「颜色计算一律在 CIE Lab 空间做」这条项目约束冲突。分量有限性由 `rgbToLab` 的既有守卫负责（不写第二份）。
 */
export function labelInk(rgb: readonly [number, number, number]): "rgb(0, 0, 0)" | "rgb(255, 255, 255)" {
  const [lightness] = rgbToLab(rgb[0], rgb[1], rgb[2]);
  return lightness >= 50 ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)";
}

/**
 * 输出层**唯一**的颜色序列化口径：`rgbCss([255, 0, 0]) === "rgb(255, 0, 0)"`。
 *
 * 两个渲染器共用它——各拼一份 `rgb(...)` 字符串是「同一件事的第二份实现」，而这类漂移（比如一处夹取、
 * 一处不夹）在任何断言里都看不出来。夹取口径与 `rgbToLab` 一致（越界的**有限**值夹到 0–255；非有限抛错）。
 */
export function rgbCss(rgb: readonly [number, number, number]): string {
  const parts = [rgb[0], rgb[1], rgb[2]].map((value) => {
    if (!Number.isFinite(value)) {
      throw new Error(`颜色分量必须是有限数字（当前 ${String(value)}）`);
    }
    return Math.min(Math.max(Math.round(value), 0), 255);
  });
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
}

function requireUsages(usages: readonly ColorUsage[]): readonly ColorUsage[] {
  if (!Array.isArray(usages)) {
    throw new Error(`用量表必须是数组（当前 ${typeof usages}）`);
  }
  const safe: readonly ColorUsage[] = usages;
  const seen = new Set<string>();
  for (let i = 0; i < safe.length; i += 1) {
    const item = safe[i] as ColorUsage;
    if (typeof item.code !== "string" || item.code === "") {
      throw new Error(`用量表第 ${i} 项的 code 非法`);
    }
    if (typeof item.name !== "string") {
      throw new Error(`用量表第 ${i} 项的 name 非法`);
    }
    if (!Number.isInteger(item.count) || item.count < 0) {
      throw new Error(`用量表第 ${i} 项的 count 非法`);
    }
    if (seen.has(item.code)) {
      throw new Error(`用量表里的色号重复：${item.code}`);
    }
    seen.add(item.code);
  }
  return safe;
}

/** 全图用量表计划（独立成图，理由见规格 §1.4：图例高度依赖用色数，留在施工图上会造成布局循环依赖）。 */
export function planLegend(usages: readonly ColorUsage[], options?: PlanOptions): LegendPlan {
  const safe = requireUsages(usages);
  const maxEdge = requireMaxEdge(options, EXPORT_MAX_EDGE);
  const itemCols = Math.min(
    Math.max(Math.floor((maxEdge - 2 * SHEET_MARGIN) / LEGEND_ITEM_W), 1),
    LEGEND_COLS_MAX,
  );
  const itemRows = Math.ceil(safe.length / itemCols);
  const canvasWidth = 2 * SHEET_MARGIN + itemCols * LEGEND_ITEM_W;
  const canvasHeight = 2 * SHEET_MARGIN + SHEET_INFO_BAR_H + itemRows * LEGEND_ROW_H + SHEET_FOOTER_H;
  if (canvasWidth > maxEdge || canvasHeight > maxEdge) {
    throw new Error(`画布上限 ${maxEdge} px 太小，无法生成用量表`);
  }
  const tableTop = SHEET_MARGIN + SHEET_INFO_BAR_H;
  return {
    kind: "legend",
    itemCols,
    itemRows,
    canvasWidth,
    canvasHeight,
    itemWidth: LEGEND_ITEM_W,
    rowHeight: LEGEND_ROW_H,
    headerY: SHEET_MARGIN,
    tableTop,
    totalY: tableTop + itemRows * LEGEND_ROW_H,
    footerY: canvasHeight - SHEET_MARGIN - SHEET_FOOTER_H,
  };
}

/** 分享图计划：纯色块、无边距无文字、**不分片**（分享图不是施工图，不需要逐格可辨）。 */
export function planShare(pattern: Pattern, options?: PlanOptions): SharePlan {
  requirePattern(pattern);
  const maxEdge = requireMaxEdge(options, SHARE_MAX_EDGE);
  const longEdge = Math.max(pattern.width, pattern.height);
  const cellPx = Math.min(
    Math.max(Math.floor(maxEdge / longEdge), SHARE_CELL_PX_MIN),
    SHARE_CELL_PX_MAX,
  );
  const canvasWidth = pattern.width * cellPx;
  const canvasHeight = pattern.height * cellPx;
  if (canvasWidth > maxEdge || canvasHeight > maxEdge) {
    throw new Error(`画布上限 ${maxEdge} px 太小，无法生成分享图`);
  }
  return { kind: "share", cellPx, cols: pattern.width, rows: pattern.height, canvasWidth, canvasHeight };
}

/**
 * 分享图的格坐标 → 像素矩形。**与 `cellBox` 同一条口径**（安全整数、越界抛错、不夹取）。
 *
 * **为什么必须有它**（2026-10-05 由任务 2 的起草者发现的洞）：`SharePlan` 不含 `SheetTilePlan`，
 * 而渲染器按闸门又不许读 `cellPx` ⇒ 分享图的格像素本来**没有合法来源**，起草者当时只能拿
 * `canvasWidth / pattern.width` 反推——那正是「自己乘格像素」这条要消灭的形态。
 */
export function shareCellBox(plan: SharePlan, col: number, row: number): PixelRect {
  requireSafeInteger(col, "格子列号");
  requireSafeInteger(row, "格子行号");
  if (col < 0 || col >= plan.cols) {
    throw new Error(`列 ${col} 不在分享图范围 0–${plan.cols - 1} 内`);
  }
  if (row < 0 || row >= plan.rows) {
    throw new Error(`行 ${row} 不在分享图范围 0–${plan.rows - 1} 内`);
  }
  return { x: col * plan.cellPx, y: row * plan.cellPx, width: plan.cellPx, height: plan.cellPx };
}
```

> **实现者注意**：上面四个 `interface` 的字段必须与契约 §2 / 规格 §4.1 / §5.3 / §5.4 逐字一致
> （`SheetTilePlan` 的字段一个不多一个不少）。**不许**为了顺手少写一个字段而在渲染器里现算它。

- [ ] **步骤 5：运行测试，确认通过**

运行：`npx vitest run src/core/render/__tests__/layout.test.ts`
预期：PASS（全部用例绿）。若有失败，**先怀疑用例里的算术**：上表的每个数字都已在规格 §5.2 的样例表里
手算过一遍，与用例不一致时以「重算」为准，并把结论写进报告。

- [ ] **步骤 6：写源码闸门 `src/core/render/__tests__/layoutGate.test.ts`**

```ts
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * 「不许长出第二份坐标数学」的词法闸门（规格 §4.4）。
 *
 * **第一行的 `/// <reference types="vite/client" />` 不是装饰**（2026-10-05 由任务 2 起草者实测发现）：
 * 本仓没有任何 `*.d.ts` 入口把 `import.meta.glob` 的类型带进来，缺了它 `npm run build` 会报
 * `TS2339: Property 'glob' does not exist on type 'ImportMeta'`。`src/__tests__/coreBoundary.test.ts`
 * 的第一行就是同一句，且它的文件头解释了为什么用 `vite/client` 而不是 `@types/node`
 * （后者会把 Node 全局拉进整个程序、削弱 `tsconfig.json` 的 `types` 闸门）。**照着它写。**
 *
 * 与 `src/__tests__/coreBoundary.test.ts` 同法：`import.meta.glob` + `?raw` 读源码文本，做**词法近似**匹配。
 * 宁可漏报变体，也不制造误报——误报会卡死后续所有任务。
 *
 * 两条规则：
 * 1. `sheet.ts` / `share.ts` 里不出现标识符 `cellPx`。渲染器要线宽 / 字号只能读 plan 的派生字段
 *    （`lineWidths` / `labelFontPx` / `tickFontPx`），格子的像素位置只能经 `cellBox` / `shareCellBox` 取得。
 * 2. 两个渲染器都不直接读 `pattern.cells`——格值一律经 `cellAt(pattern, col, row)`（行优先 stride 属于它的职责）。
 * 3. 不得出现 `canvasWidth /` / `canvasHeight /` 这类除法，且 `share.ts` 必须经 `shareCellBox(` 取位置。
 *    **第 3 条不是洁癖**：`canvasWidth / pattern.width` 与 `shareCellBox` 数值逐位相同，把前者换上去的变异
 *    实测 **0 红**——两条数学等价的实现只能靠结构约束判别（详见该用例里的注释）。
 *
 * **先剥注释再扫**：否则「渲染器不许读 cellPx」这类诚实的注释会被自己的闸门判违规。
 * 已知偏差（刻意接受）：换名（`const c = tile.cellPx`）能绕过第 1 条；把 stride 拆成两步赋值能绕过第 2 条。
 * 它挡的是「后人顺手再写一份」，不是刻意规避；判别力由变异实测证明（把 `cellPx` 写回 `sheet.ts` ⇒ 恰好 1 红）。
 */
const RENDER_SOURCES: Record<string, string> = import.meta.glob<string>("../{sheet,share}.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** 剥离注释（保留换行与字符串内容），避免注释文本参与匹配。 */
function stripComments(source: string): string {
  let result = "";
  let quote: string | null = null;
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (quote !== null) {
      result += char;
      if (char === "\\") {
        result += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      result += char;
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      if (newline === -1) break;
      result += "\n";
      index = newline + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let cursor = index; cursor < stop; cursor += 1) {
        if (source[cursor] === "\n") result += "\n";
      }
      index = stop;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

describe("渲染器的词法闸门", () => {
  it("扫描目标就是那两个渲染器文件（扫错地方等于闸门形同虚设）", () => {
    const keys = Object.keys(RENDER_SOURCES).sort();
    expect(keys).toEqual(["../share.ts", "../sheet.ts"]);
    expect(keys.every((key) => (RENDER_SOURCES[key] ?? "").length > 0)).toBe(true);
  });

  it("渲染器里不出现 cellPx（坐标只能经 cellBox 取）", () => {
    const offenders = Object.keys(RENDER_SOURCES)
      .sort()
      .filter((key) => /\bcellPx\b/.test(stripComments(RENDER_SOURCES[key] ?? "")));
    expect(offenders).toEqual([]);
  });

  it("渲染器里不直接读 pattern.cells（格值只能经 cellAt 取）", () => {
    const offenders = Object.keys(RENDER_SOURCES)
      .sort()
      .filter((key) => /\bpattern\.cells\b/.test(stripComments(RENDER_SOURCES[key] ?? "")));
    expect(offenders).toEqual([]);
  });

  it("两个渲染器都经 cellAt 读格值（正向口径，可在源码里核对）", () => {
    for (const key of Object.keys(RENDER_SOURCES).sort()) {
      expect(RENDER_SOURCES[key] ?? "", `${key} 应经 cellAt 读格值`).toContain("cellAt(");
    }
  });

  it("渲染器里不得出现 canvasWidth / canvasHeight 参与的除法", () => {
    // **这条规则的由来（2026-10-05，任务 2 起草者实测）**：`share.ts` 原本用
    // `plan.canvasWidth / pattern.width` 反推格像素——它与 `shareCellBox` 在数值上**逐位相同**，
    // 把 `shareCellBox` 换回那条反推的变异实测 **0 红**：任何取值断言都判不开这两者。
    // 也就是说，**当两条实现在数学上等价时，唯一能判别的只有结构（源码）约束**。
    // 所以「分享图格像素只能来自 `shareCellBox`」必须由这条词法规则守住，而不是靠某条断言。
    const offenders = Object.keys(RENDER_SOURCES)
      .sort()
      .filter((key) => /\bcanvas(Width|Height)\s*\//.test(stripComments(RENDER_SOURCES[key] ?? "")));
    expect(offenders).toEqual([]);
  });

  it("share.ts 经 shareCellBox 取格位置（正向口径，与上一条配对）", () => {
    expect(RENDER_SOURCES["../share.ts"] ?? "", "../share.ts 应经 shareCellBox 取位置").toContain(
      "shareCellBox(",
    );
  });

  it("剥离注释：注释里提到 cellPx 不算违规，代码里的算", () => {
    const commented = `// 渲染器不许读 cellPx\nconst a = 1;`;
    expect(/\bcellPx\b/.test(stripComments(commented))).toBe(false);
    const real = `// 注释\nconst c = tile.cellPx;`;
    expect(/\bcellPx\b/.test(stripComments(real))).toBe(true);
  });
});
```

- [ ] **步骤 7：运行闸门（任务 1 结束时它是红的，这是设计）**

运行：`npx vitest run src/core/render/__tests__/layoutGate.test.ts`
预期：**恰 2 条红**——`扫描目标就是那两个渲染器文件`（此时 `sheet.ts` / `share.ts` 还没写，
`import.meta.glob` 的键是空数组）与 `share.ts 经 shareCellBox 取格位置`（`?? ""` 上的 `toContain` 必然失败）。
**其余 5 条会"通过"，但那是恒真通过**：空集合上的 `filter(...)` 必然得到 `[]`、`for` 循环一次都不跑、
`canvasWidth /` 的扫描也在空文本上通过。**这正是闸门里必须有那两条自检的原因**——没有它们，
整个闸门在文件缺失 / glob 写错时会静默全绿，等于形同虚设（与 `coreBoundary.test.ts`
的「扫描机制自检」同一条教训）。
**不许**为了让这一步变绿去改 glob（例如把 `../{sheet,share}.ts` 改成可选匹配）或删掉自检——
那样等于把闸门变成哑弹。如实把「2 红 + 5 条恒真通过」写进报告。

- [ ] **步骤 8：全量验证（此时带着那 2 条已知红）**

```bash
npm run test                    # 预期：新增文件后，唯一失败是上面那两条闸门自检
$env:TZ="UTC"; npm run test     # 同
npm run build                   # 预期：通过（新文件被 vue-tsc 检查）
```

**如实记录这个状态**：任务 1 的提交**允许带着这 2 条红**（写进报告与 commit 说明的关键词里），
任务 2 交付两个渲染器后必须转绿。若你选择把闸门用例整体推迟到任务 2 一起提交，也在报告里说明。

- [ ] **步骤 9：Commit**

```bash
git add src/core/render/types.ts src/core/render/layout.ts src/core/render/__tests__/layout.test.ts src/core/render/__tests__/layoutGate.test.ts
git commit -m "feat(render): 施工图/用量表/分享图的布局与唯一坐标映射"
```

**报告必须包含**（这是控制者复核的输入，缺一条就要返工）：
1. `npm run test` / `TZ=UTC` / `npm run build` 的**原始输出尾巴**（文件数 / 用例数 / 构建结果），
   以及**那两条已知红**（闸门自检）的名字与它们何时该转绿；
2. 步骤 7 的闸门状态（红还是绿）与原因；
3. 规格 §13.3 里 **M1 / M2 / M3 / M5 / M6 / M7** 这 6 条的**实测红数与失败点标题**
   （M4 / M9 / M10 / M11 / M12 / M15 / M16 属任务 2——它们要改的文件此时还不存在；M8 / M13 属任务 3；
   M14 属任务 4）。做法：改一行 → 跑聚焦用例 → 记红数 → `git checkout -- <文件>` 还原 → 再跑一次确认回到
   全绿。**不许预估红数**；
4. 任何与本计划 / 契约不符之处，以及你的处置（不许自行发明名字）。

---

---

---

---

---

## 任务 2：施工图与分享图渲染器（注入式绘制目标）

**文件：**
- 创建：`src/core/render/sheet.ts`（`drawSheetTile` + `drawLegend`）
- 创建：`src/core/render/share.ts`（`drawShare`）
- 测试：`src/core/render/__tests__/helpers.ts`（三份渲染器用例共用的普通对象桩 `createMockTarget()` + 调用记录）
- 测试：`src/core/render/__tests__/sheet.test.ts`
- 测试：`src/core/render/__tests__/share.test.ts`

**任务 1 已交付、本任务只许消费不许改的接口**（逐条点名，实现时若发现缺一项，按片段末尾「缺口」一节上报，不许自己在渲染器里补）：
`RenderTarget2D` / `PixelRect`（`types.ts`）；`planSheets` / `planLegend` / `planShare` / `cellBox` / **`shareCellBox`** / `countTileBeads` / `labelInk` / `rgbCss`、常量 `SHEET_MARGIN` `SHEET_RULER_LEFT` `SHEET_RULER_TOP` `SHEET_INFO_BAR_H` `SHEET_FOOTER_H`、类型 `SheetPlan` / `SheetTilePlan` / `LegendPlan` / `SharePlan`（`layout.ts`）。
**本任务不碰 `layout.ts` / `layout.test.ts` / `layoutGate.test.ts` 的任何一个字节**：闸门在任务 1 结束时是红的（两个渲染器还不存在，`import.meta.glob` 键为空），本任务交付两个渲染器后它必须转绿。

> **2026-10-05 控制者裁定（本片段据此更新，逐条处置见文末「缺口 / 裁定落地记录」）**：契约 §2 / §3 / **新增 §4b** 与规格 §4.1 / §6 / §7 / §12 / §13.1 已改，任务 1 的片段也已同步（`planShare` 现在返回 `cols` / `rows`、新增 `shareCellBox`、`layoutGate.test.ts` 补了 `/// <reference types="vite/client" />`）。相对本片段的第一版，**三处是新增的硬要求**：① `drawLegend` **多一个必需的 `palette` 入参**，色块改画真色（`fillRect` + `rgbCss`），色号 → rgb **只许**走 `createPaletteRuntime(palette).indexByCode`（`core/palette/registry.ts`，B3 规格 §9.2 的权威实现），找不到即抛 `用量表里的色号不在色卡里：${code}`；② 分享图**必须**用 `shareCellBox(plan, col, row)` 取格位置，删掉第一版里 `canvasWidth / pattern.width` 的反推；③ `drawLegend` 补一条「`usages` 与 `plan` 同源」的守卫，消息逐字 `用量表计划与本表不符：计划 ${plan.itemRows} 行、按 ${usages.length} 项应为 ${expected} 行`。

**本任务的纪律（规格 §4.4 与计划任务 0 的 R-1 / R-2）**：
1. `sheet.ts` / `share.ts` 的源码里**不出现标识符 `cellPx`**（连注释里也不写，虽然闸门会剥注释）；线宽 / 字号一律读 plan 的派生字段（`lineWidths` / `labelFontPx` / `tickFontPx`），施工图的格子像素位置一律经 `cellBox`、分享图的一律经 `shareCellBox`。

2. 格子值一律 `cellAt(pattern, col, row)`；**不读 `pattern.cells`**、不自己写行优先 stride。
3. 逐字遵守规格 §6 的 8 步绘制顺序与 §7 的分享图口径；§9 第 1 条：渲染器不读 `Date`，时间由 `meta.generatedAt` 传入。

---

- [ ] **步骤 1：写共用桩 `src/core/render/__tests__/helpers.ts`**

桩是**普通对象**（结构上满足 `RenderTarget2D`），**不许**用 `document.createElement("canvas")`：happy-dom 的 canvas 是桩实现、没有真实像素语义（契约 §5 第 1 条）。

两个设计要点（后面每条断言都靠它们，别顺手改掉）：
- `fillRect` 记录**调用当刻**的 `imageSmoothingEnabled`：分享图要求「关插值发生在第一次填充之前」，只在渲染结束后读 `target.imageSmoothingEnabled` 抓不到顺序错误（`services/__tests__/patternThumbnail.test.ts` 记 `drawImage` 时刻的 `smoothing` 是同一手法）。
- `beginPath` 之后的 `lineWidth` / `strokeStyle` 在 **`stroke()` 那一刻**刷新成当时的值：真实 canvas 也是在 `stroke` 时读这两个属性，所以「先 `beginPath` 再设线宽」这种完全合法的写法不会被记成错的值（记录在 `beginPath` 时刻会让正确实现假红）。
- 没有 `beginPath` 就打头的路径操作进 `strayOps`，**不静默并进上一组路径**：规格 §6 第 5 步要求「一组线共用一次 `beginPath` + 一次 `stroke`」，漏写 `beginPath` 必须是一种可观察的缺陷。

```ts
import type { RenderTarget2D } from "../types";

/**
 * 三个渲染器用例共用的**普通对象桩** + 调用记录。
 *
 * **为什么不用 `document.createElement("canvas")`**：happy-dom 的 canvas 是无像素语义的桩
 * （`getContext("2d")` 在本仓返回 null，见 `services/__tests__/patternThumbnail.test.ts` 的实测），
 * 拿它当目标只能写出恒真断言。这里改成记录「渲染器到底调了什么」——线宽 / 颜色 / 坐标 / 顺序
 * 全都在 Node 里可断言。真实像素的观感验证在规格 §14 的人工清单里，不做成断言（§13.4）。
 *
 * **与真实 ctx 的两处刻意对齐**（否则正确实现会假红）：
 * 1. `fillRect` 记下**调用当刻**的 `imageSmoothingEnabled`（分享图要求画之前就已关插值）；
 * 2. 路径的 `lineWidth` / `strokeStyle` 在 **`stroke()` 那一刻**刷新——真实 canvas 也是在 stroke
 *    时读这两个属性，所以「先 beginPath 再设线宽」这种合法写法不会被记成错的值。
 */

/** 一次 `fillRect`：实参 + 调用当刻的 2D 状态快照。 */
export interface FillCall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fillStyle: string;
  /** 调用当刻的 `imageSmoothingEnabled`（分享图要求「画之前」就已关闭插值）。 */
  readonly smoothing: boolean;
}

/** 一次 `fillText`：文本 + 实参 + 调用当刻的 2D 状态快照。 */
export interface TextCall {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly font: string;
  readonly fillStyle: string;
  readonly textAlign: RenderTarget2D["textAlign"];
  readonly textBaseline: RenderTarget2D["textBaseline"];
}

export type PathOp =
  | { readonly op: "moveTo"; readonly x: number; readonly y: number }
  | { readonly op: "lineTo"; readonly x: number; readonly y: number }
  | { readonly op: "stroke" };

/**
 * 一次 `beginPath` 起、到下一个 `beginPath` 前的全部路径操作。
 * `lineWidth` / `strokeStyle` 是 **`stroke()` 时刻**的值（真实 canvas 的读取时机）。
 */
export interface PathCall {
  lineWidth: number;
  strokeStyle: string;
  readonly ops: PathOp[];
}

/** 一次 `strokeRect`（用量表色块的外框走这里：真色填充之上压一道细框）。 */
export interface StrokeRectCall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly strokeStyle: string;
  readonly lineWidth: number;
}

export interface MockCalls {
  readonly fills: FillCall[];
  readonly texts: TextCall[];
  readonly paths: PathCall[];
  readonly strokeRects: StrokeRectCall[];
  /** 没有 `beginPath` 就打头的路径操作：漏写 `beginPath` 必须可观察，不静默并入上一组。 */
  readonly strayOps: string[];
  saves: number;
  restores: number;
}

/** 造一个普通对象绘制目标 + 它的调用记录（`calls` 与 `target` 同源，边画边记）。 */
export function createMockTarget(): { readonly target: RenderTarget2D; readonly calls: MockCalls } {
  const calls: MockCalls = {
    fills: [],
    texts: [],
    paths: [],
    strokeRects: [],
    strayOps: [],
    saves: 0,
    restores: 0,
  };
  let ops: PathOp[] = [];
  let hasPath = false;

  const target: RenderTarget2D = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    font: "10px sans-serif",
    textAlign: "left",
    textBaseline: "top",
    imageSmoothingEnabled: true,
    fillRect(x, y, w, h) {
      calls.fills.push({
        x,
        y,
        w,
        h,
        fillStyle: target.fillStyle,
        smoothing: target.imageSmoothingEnabled,
      });
    },
    strokeRect(x, y, w, h) {
      calls.strokeRects.push({
        x,
        y,
        w,
        h,
        strokeStyle: target.strokeStyle,
        lineWidth: target.lineWidth,
      });
    },
    beginPath() {
      ops = [];
      hasPath = true;
      calls.paths.push({ lineWidth: target.lineWidth, strokeStyle: target.strokeStyle, ops });
    },
    moveTo(x, y) {
      if (!hasPath) {
        calls.strayOps.push(`moveTo(${x}, ${y})`);
        return;
      }
      ops.push({ op: "moveTo", x, y });
    },
    lineTo(x, y) {
      if (!hasPath) {
        calls.strayOps.push(`lineTo(${x}, ${y})`);
        return;
      }
      ops.push({ op: "lineTo", x, y });
    },
    stroke() {
      if (!hasPath) {
        calls.strayOps.push("stroke()");
        return;
      }
      const current = calls.paths[calls.paths.length - 1];
      if (current !== undefined) {
        // stroke 时刻读属性（与真实 canvas 一致）
        current.lineWidth = target.lineWidth;
        current.strokeStyle = target.strokeStyle;
      }
      ops.push({ op: "stroke" });
    },
    fillText(text, x, y) {
      calls.texts.push({
        text,
        x,
        y,
        font: target.font,
        fillStyle: target.fillStyle,
        textAlign: target.textAlign,
        textBaseline: target.textBaseline,
      });
    },
    save() {
      calls.saves += 1;
    },
    restore() {
      calls.restores += 1;
    },
  };

  return { target, calls };
}
```

> **注意**：`helpers.ts` 不是测试文件（文件名不含 `.test.`，也没有 `it()`），所以**不** import `vitest`——契约 §1 的「每个渲染器 / 布局文件必须显式 import vitest」针对的是有 `describe` / `it` 的文件。它在 `__tests__/` 下，因此被 `coreBoundary.test.ts` 的规则 7 整文件排除。

- [ ] **步骤 2：写失败的用例 `src/core/render/__tests__/sheet.test.ts`（第一批：施工图）**

夹具的每个数字下面都要用上，别改成「随便造一张图」：6×6 的图纸刚好能一眼验算完全部几何（`cellPx = 40`、`grid = { x: 88, y: 176, w: 240, h: 240 }`、7 条竖线 + 7 条横线、刻度 0 / 5、板边界只有 0 列）。

```ts
import { describe, expect, it } from "vitest";
import type { Palette } from "../../palette/types";
import { EMPTY, type Pattern } from "../../pattern/types";
import {
  SHEET_FOOTER_H,
  SHEET_INFO_BAR_H,
  SHEET_MARGIN,
  SHEET_RULER_LEFT,
  SHEET_RULER_TOP,
  cellBox,
  planLegend,
  planShare,
  planSheets,
  type LegendPlan,
  type SheetPlan,
  type SheetTilePlan,
} from "../layout";
import { drawLegend, drawSheetTile, type SheetMeta } from "../sheet";
import { createMockTarget, type MockCalls } from "./helpers";

/**
 * 夹具：6×6、33 个实心格、3 个空格（(2,0) / (4,2) / (4,5)）、4 种颜色。
 * 颜色刻意含**纯白与纯黑**：格内色号的墨色（`labelInk`）只有这两端能被无歧义断言。
 */
const CELLS_6X6: readonly number[] = [
  0, 0, EMPTY, 0, 0, 0,
  0, 1, 1, 1, 1, 1,
  2, 0, 0, 0, EMPTY, 0,
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, EMPTY, 3,
];

function makePalette(): Palette {
  return {
    id: "test-palette",
    name: "测试色卡",
    source: "test",
    accuracy: "屏幕色仅供参考，以实物为准",
    colors: [
      { code: "A1", name: "白", rgb: [255, 255, 255] },
      { code: "A2", name: "黑", rgb: [0, 0, 0] },
      { code: "A3", name: "红", rgb: [255, 0, 0] },
      { code: "A4", name: "浅灰", rgb: [200, 200, 210] },
    ],
  };
}

function makePattern(width: number, height: number, values?: readonly number[]): Pattern {
  const cells = new Uint16Array(width * height);
  if (values !== undefined) cells.set(values);
  return { width, height, paletteId: "test-palette", cells };
}

function makeMeta(overrides: Partial<SheetMeta> = {}): SheetMeta {
  return {
    projectName: "测试工程",
    generatedAt: "2026-10-05 12:00",
    totalBeads: 33,
    colorCount: 4,
    paletteName: "测试色卡",
    accuracy: "屏幕色仅供参考，以实物为准",
    ...overrides,
  };
}

/** 独立的实心格计数（**不用** `countTileBeads` / `cellAt`：期望值必须与被测实现不同源）。 */
function solidInRange(
  pattern: Pattern,
  originCol: number,
  originRow: number,
  cols: number,
  rows: number,
): number {
  let count = 0;
  for (let row = originRow; row < originRow + rows; row += 1) {
    for (let col = originCol; col < originCol + cols; col += 1) {
      if ((pattern.cells[row * pattern.width + col] as number) !== EMPTY) count += 1;
    }
  }
  return count;
}

function solidInTile(pattern: Pattern, tile: SheetTilePlan): number {
  return solidInRange(pattern, tile.originCol, tile.originRow, tile.cols, tile.rows);
}

/**
 * 只取落在 `tile.grid` **内部**的文字。
 *
 * **这条过滤是必须的，不是洁癖**：`labels = false` 时信息条 / 刻度 / 板号 / 页脚都还在写字，
 * `expect(calls.texts).toEqual([])` 这种写法永远是假绿——它根本没读到「格区域内没有色号」
 * 这条真正要守的性质。渲染器用例里任何关于「格内色号」的断言都必须经过本函数。
 */
function textsInGrid(calls: MockCalls, tile: SheetTilePlan): MockCalls["texts"] {
  return calls.texts.filter(
    (text) =>
      text.x > tile.grid.x &&
      text.x < tile.grid.x + tile.grid.width &&
      text.y > tile.grid.y &&
      text.y < tile.grid.y + tile.grid.height,
  );
}

function fillAt(calls: MockCalls, x: number, y: number) {
  return calls.fills.find((fill) => fill.x === x && fill.y === y);
}

describe("drawSheetTile：底色、色块与文字", () => {
  const pattern = makePattern(6, 6, CELLS_6X6);
  const palette = makePalette();
  const plan = planSheets(pattern, palette);
  const tile = plan.tiles[0] as SheetTilePlan;

  it("夹具锚点：6×6 里有 33 个实心格、3 个空格（后面所有次数都由它推出）", () => {
    expect(solidInTile(pattern, tile)).toBe(33);
    expect(pattern.cells.length - solidInTile(pattern, tile)).toBe(3);
    expect(tile.grid).toEqual({ x: 88, y: 176, width: 240, height: 240 });
  });

  it("第 1 步整张底色 + 第 3 步实心格：fillRect 次数 = 1 + 实心格数", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());
    expect(calls.fills).toHaveLength(1 + solidInTile(pattern, tile));
    expect(calls.fills[0]).toMatchObject({
      x: 0,
      y: 0,
      w: tile.canvasWidth,
      h: tile.canvasHeight,
      fillStyle: "#ffffff",
    });
  });

  it("色块的坐标取自 cellBox、颜色取自色卡（rgbCss 口径）", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    const black = cellBox(tile, 1, 1);
    expect(fillAt(calls, black.x, black.y)).toMatchObject({
      w: black.width,
      h: black.height,
      fillStyle: "rgb(0, 0, 0)",
    });
    const red = cellBox(tile, 0, 2);
    expect(fillAt(calls, red.x, red.y)).toMatchObject({ fillStyle: "rgb(255, 0, 0)" });
    const grey = cellBox(tile, 5, 5);
    expect(fillAt(calls, grey.x, grey.y)).toMatchObject({ fillStyle: "rgb(200, 200, 210)" });
  });

  it("空格不填色（MARD 有白色豆，白 ≠ 空），只在格内画一条浅灰斜线", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    for (const [col, row] of [[2, 0], [4, 2], [4, 5]] as const) {
      const box = cellBox(tile, col, row);
      expect(fillAt(calls, box.x, box.y)).toBeUndefined();
    }

    const diagonal = calls.paths.find((path) => path.strokeStyle === "#cbd5e1");
    expect(diagonal).toBeDefined();
    expect(diagonal?.lineWidth).toBe(tile.lineWidths.thin);
    const first = cellBox(tile, 2, 0);
    const second = cellBox(tile, 4, 2);
    const third = cellBox(tile, 4, 5);
    // 三格斜线共用一次 beginPath / stroke，方向是左上 → 右下
    expect(diagonal?.ops).toEqual([
      { op: "moveTo", x: first.x, y: first.y },
      { op: "lineTo", x: first.x + first.width, y: first.y + first.height },
      { op: "moveTo", x: second.x, y: second.y },
      { op: "lineTo", x: second.x + second.width, y: second.y + second.height },
      { op: "moveTo", x: third.x, y: third.y },
      { op: "lineTo", x: third.x + third.width, y: third.y + third.height },
      { op: "stroke" },
    ]);
  });

  it("格内色号：每格一条、字号取 labelFontPx、墨色取 labelInk、位置是 cellBox 的中心", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    expect(tile.labelFontPx).toBe(15);
    const inGrid = textsInGrid(calls, tile);
    expect(inGrid).toHaveLength(33); // 实心格数：空格没有色号
    expect(inGrid.every((text) => ["A1", "A2", "A3", "A4"].includes(text.text))).toBe(true);

    const white = cellBox(tile, 0, 0);
    expect(calls.texts.find((text) => text.text === "A1")).toMatchObject({
      x: white.x + white.width / 2,
      y: white.y + white.height / 2,
      font: "15px sans-serif",
      fillStyle: "rgb(0, 0, 0)",
      textAlign: "center",
      textBaseline: "middle",
    });
    const black = cellBox(tile, 1, 1);
    expect(calls.texts.find((text) => text.text === "A2")).toMatchObject({
      x: black.x + black.width / 2,
      y: black.y + black.height / 2,
      fillStyle: "rgb(255, 255, 255)",
    });
  });

  it("信息条两行、刻度显示全局格号 + 1、板号与页脚逐字断言（本片颗数走 countTileBeads）", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    expect(calls.texts[0]).toMatchObject({
      text: "测试工程 · 6 × 6 格 · 成品 3.0 厘米",
      x: SHEET_MARGIN,
      y: SHEET_MARGIN,
      font: "18px sans-serif", // 契约 §4b：字体字符串必须带字体族
      fillStyle: "#0f172a",
      textAlign: "left",
      textBaseline: "top",
    });
    expect(calls.texts[1]).toMatchObject({
      text: "测试色卡 · 全图 33 颗（4 种色）/ 本片 33 颗 · 2026-10-05 12:00 · 屏幕色仅供参考，以实物为准",
      y: SHEET_MARGIN + Math.round(SHEET_INFO_BAR_H / 2),
    });

    expect(tile.colTicks.map((tick) => tick.col)).toEqual([0, 5]);
    // 上刻度带：0 列显示「1」，居中、底对齐
    expect(calls.texts.find((text) => text.text === "1" && text.textAlign === "center")).toMatchObject({
      x: tile.grid.x,
      y: tile.grid.y - 8,
      textBaseline: "bottom",
      font: "12px sans-serif",
    });
    // 左刻度带：5 行显示「6」，右对齐、垂直居中
    expect(calls.texts.find((text) => text.text === "6" && text.textBaseline === "middle")).toMatchObject({
      x: tile.grid.x - 8,
      y: tile.rowTicks[1]?.y,
    });

    expect(calls.texts.filter((text) => text.text === "第 1 块板")).toHaveLength(2);
    expect(
      calls.texts.find((text) => text.text === "第 1 块板" && text.textAlign === "center"),
    ).toMatchObject({
      x: tile.grid.x,
      y: tile.grid.y - SHEET_RULER_TOP + 2,
      textBaseline: "top",
    });
    expect(
      calls.texts.find((text) => text.text === "第 1 块板" && text.textAlign === "left"),
    ).toMatchObject({
      x: tile.grid.x - SHEET_RULER_LEFT + 2,
      y: tile.grid.y,
      textBaseline: "middle",
    });

    expect(calls.texts.find((text) => text.text.startsWith("第 1/1 片"))).toMatchObject({
      text: "第 1/1 片 · 列 1–6 · 行 1–6（含）· 本片 33 颗",
      x: SHEET_MARGIN,
      y: tile.grid.y + tile.grid.height + SHEET_FOOTER_H / 2,
    });
  });
});

describe("drawSheetTile：网格线、调用顺序与降级", () => {
  const pattern = makePattern(6, 6, CELLS_6X6);
  const palette = makePalette();
  const plan = planSheets(pattern, palette);
  const tile = plan.tiles[0] as SheetTilePlan;

  it("三档网格线由细到粗、每档一次 beginPath / stroke，板边界最后画", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    // 调用顺序 = [空格斜线（浅灰、细）, thin, major, board]
    expect(calls.paths.map((path) => path.lineWidth)).toEqual([1, 1, 2, 3]);
    expect(calls.paths.map((path) => path.strokeStyle)).toEqual([
      "#cbd5e1",
      "#0f172a",
      "#0f172a",
      "#0f172a",
    ]);

    const gridPaths = calls.paths.filter((path) => path.strokeStyle === "#0f172a");
    for (const kind of ["thin", "major", "board"] as const) {
      const group = gridPaths.find((path) => path.lineWidth === tile.lineWidths[kind]);
      expect(group).toBeDefined();
      const lines =
        tile.vLines.filter((line) => line.kind === kind).length +
        tile.hLines.filter((line) => line.kind === kind).length;
      expect(group?.ops.filter((op) => op.op !== "stroke")).toHaveLength(2 * lines);
      expect(group?.ops.filter((op) => op.op === "stroke")).toHaveLength(1);
    }

    // 板边界在细线**之后**（顺序反了：先画粗线会被后画的细线切断，板边界不再连续）
    const thinIndex = calls.paths.findIndex(
      (path) => path.lineWidth === tile.lineWidths.thin && path.strokeStyle === "#0f172a",
    );
    const boardIndex = calls.paths.findIndex((path) => path.lineWidth === tile.lineWidths.board);
    expect(thinIndex).toBeGreaterThanOrEqual(0);
    expect(boardIndex).toBeGreaterThan(thinIndex);
    expect(boardIndex).toBe(calls.paths.length - 1);
  });

  it("moveTo / lineTo 各 = 网格线条数 + 空格数，且没有游离的路径操作", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    const ops = calls.paths.flatMap((path) => path.ops);
    const gridLines = tile.vLines.length + tile.hLines.length;
    expect(gridLines).toBe(14);
    expect(ops.filter((op) => op.op === "moveTo")).toHaveLength(gridLines + 3);
    expect(ops.filter((op) => op.op === "lineTo")).toHaveLength(gridLines + 3);
    expect(calls.strayOps).toEqual([]);
  });

  it("某一档一条线都没有时不发空 stroke（4×4 只有板边界与细线）", () => {
    const small = makePattern(4, 4);
    const smallPlan = planSheets(small, palette);
    const smallTile = smallPlan.tiles[0] as SheetTilePlan;
    expect(smallTile.vLines.filter((line) => line.kind === "major")).toHaveLength(0);

    const { target, calls } = createMockTarget();
    drawSheetTile(target, small, palette, smallPlan, smallTile, makeMeta());
    expect(calls.paths.map((path) => path.lineWidth)).toEqual([1, 3]);
  });

  it("labels = false 时格区域内没有色号；信息条 / 刻度 / 页脚照常写字（必须按区域过滤，否则是假绿）", () => {
    const big = makePattern(500, 500);
    const noLabels = planSheets(big, palette, { maxEdge: 1143 });
    expect(noLabels.labels).toBe(false);
    const bigTile = noLabels.tiles[0] as SheetTilePlan;
    expect(solidInTile(big, bigTile)).toBe(841); // 29×29 全实心

    const { target, calls } = createMockTarget();
    drawSheetTile(target, big, palette, noLabels, bigTile, makeMeta({ totalBeads: 250000, colorCount: 1 }));

    expect(textsInGrid(calls, bigTile)).toEqual([]);
    // 假绿陷阱的反面证据：整张图上仍然有 17 条文字（信息条 2 + 刻度 12 + 板号 2 + 页脚 1）
    expect(calls.texts).toHaveLength(2 + 6 + 6 + 1 + 1 + 1);
    expect(calls.texts[1]?.text).toBe(
      "测试色卡 · 全图 250000 颗（1 种色）/ 本片 841 颗 · 2026-10-05 12:00 · 屏幕色仅供参考，以实物为准",
    );
    expect(calls.fills).toHaveLength(1 + 841);
  });
});

describe("drawSheetTile / drawLegend：入口守卫", () => {
  const palette = makePalette();
  const pattern = makePattern(6, 6, CELLS_6X6);
  const plan = planSheets(pattern, palette);
  const tile = plan.tiles[0] as SheetTilePlan;

  it("plan.kind 不匹配 / tile 不属于本 plan / 色卡不一致：写在任何写操作之前", () => {
    const { target, calls } = createMockTarget();

    const sharePlan = planShare(pattern);
    expect(() =>
      drawSheetTile(target, pattern, palette, sharePlan as unknown as SheetPlan, tile, makeMeta()),
    ).toThrow("plan 的类型不匹配：期望 sheet，实际 share");
    expect(calls.fills).toEqual([]);

    const legendPlan = planLegend([]);
    expect(() =>
      drawSheetTile(target, pattern, palette, legendPlan as unknown as SheetPlan, tile, makeMeta()),
    ).toThrow("plan 的类型不匹配：期望 sheet，实际 legend");
    expect(calls.fills).toEqual([]);

    const foreign = planSheets(makePattern(6, 6, CELLS_6X6), palette).tiles[0] as SheetTilePlan;
    expect(() => drawSheetTile(target, pattern, palette, plan, foreign, makeMeta())).toThrow(
      "传入的 tile 不属于这个 plan",
    );
    expect(calls.fills).toEqual([]);

    expect(() =>
      drawSheetTile(target, pattern, { ...palette, id: "other" }, plan, tile, makeMeta()),
    ).toThrow("与传入的色卡 other 不一致");
    expect(calls.fills).toEqual([]);
  });

  it("色号下标超出色卡时响亮失败（不静默涂成另一个色）", () => {
    const broken = makePattern(6, 6);
    broken.cells[0] = 9;
    const brokenPlan = planSheets(broken, palette);
    const { target } = createMockTarget();
    expect(() =>
      drawSheetTile(target, broken, palette, brokenPlan, brokenPlan.tiles[0] as SheetTilePlan, makeMeta()),
    ).toThrow("色卡里没有下标 9 的颜色");
  });

  it("drawLegend 的 plan.kind 不匹配即抛（把 sheet plan 传进去）", () => {
    const { target, calls } = createMockTarget();
    expect(() =>
      drawLegend(target, palette, [], plan as unknown as LegendPlan, makeMeta()),
    ).toThrow("plan 的类型不匹配：期望 legend，实际 sheet");
    expect(calls.fills).toEqual([]);
  });
});
```

- [ ] **步骤 3：运行测试，确认失败**

运行：`npx vitest run src/core/render/__tests__/sheet.test.ts`
预期：FAIL——`Failed to resolve import "../sheet"`（`sheet.ts` 还不存在）。把这条原始输出尾巴贴进报告。

- [ ] **步骤 4：写实现 `src/core/render/sheet.ts`**

实现要点（每条都对应一句规格原文，改之前先回头看规格）：
- 8 步顺序固定：底 → 信息条 → 色块与空格 → 格内色号 → 网格线（细 / 主 / 板）→ 刻度 → 板号 → 页脚。
- 空格斜线**共用一次** `beginPath` / `stroke`；三档网格线**每档**一次 `beginPath` / `stroke`；某一档一条线都没有时**不发空 stroke**。
- `plan.labels` 全文件只读一处（收集色号时），绘制由「有没有收集到」决定：这样 M4 的靶点唯一（两处读会让「只改一处」不报错），且 `labels = false` 时不必付 `rgbToLab` 的代价。
- 刻度显示全局格号 **+1**；页脚的行列范围是 **1 起的全局格坐标**，`r / c` 取 `tile.rowIndex + 1` / `tile.colIndex + 1`——**不从 `index` 反推网格形状**（那是第二份分片数学）。

```ts
import { beadsToCm, formatCm } from "../pattern/board";
import { cellAt } from "../pattern/edit";
import type { ColorUsage } from "../pattern/stats";
import { EMPTY, type Pattern } from "../pattern/types";
import { createPaletteRuntime } from "../palette/registry";
import type { Palette, PaletteColor } from "../palette/types";
import {
  SHEET_FOOTER_H,
  SHEET_INFO_BAR_H,
  SHEET_MARGIN,
  SHEET_RULER_LEFT,
  SHEET_RULER_TOP,
  cellBox,
  countTileBeads,
  labelInk,
  rgbCss,
  type LegendPlan,
  type SheetPlan,
  type SheetTilePlan,
} from "./layout";
import type { PixelRect, RenderTarget2D } from "./types";

/**
 * 施工图（分片）与用量表的绘制。
 *
 * **本文件零算术**（规格 §4.4 / 计划任务 0 的 R-1、R-2）：所有像素位置来自 plan 的派生字段
 * （`grid` / `vLines` / `hLines` / `colTicks` / `rowTicks` / `colBoards` / `rowBoards` /
 * `lineWidths` / `labelFontPx` / `tickFontPx`），格子位置一律经 `cellBox`，格子值一律经 `cellAt`。
 * 源码级闸门 `__tests__/layoutGate.test.ts` 守着这两条；改动这里之前先读它的两条规则。
 *
 * **不调 `save` / `restore`**：每张产物都用一张新画布（规格 §9.6「逐张渲染、即时释放」），
 * 没有需要保护的既有 ctx 状态；`RenderTarget2D` 里的这两个方法由真实 ctx 结构兼容性带进来。
 */

// ---------------------------------------------------------------------------
// 图上常量（**集中定义在这里，各带 JSDoc**；逐字口径见契约 §4b）
//
// 两类常量必须分清，免得后人以为这里是第二份坐标数学：
// - **字号**：不随格子缩放，**不参与布局预算**（布局里没有它们的位置——信息条 / 页脚 / 用量表都是
//   固定高度的带，文字放得下放不下由人眼在真机上看，不由 plan 决定）。只有格内色号 `labelFontPx`
//   与刻度 `tickFontPx` 由 plan 给。
// - **带内落位偏移**：plan 只给「沿线的那个坐标」（`colTicks.x` / `rowTicks.y` / `colBoards.x` /
//   `rowBoards.y`），文字的另一轴本来就不来自格子坐标，所以它**不是**格子↔像素映射（2026-10-05 裁定，
//   见规格 §6 末段）。**格子坐标一律来自 plan**——这条没变。
// ---------------------------------------------------------------------------

/** 底色：规格 §6 第 1 步逐字要求整张画布填白。 */
const SHEET_BACKGROUND = "#ffffff";
/** 网格线颜色（三档共用一色，档位只由线宽区分）。契约 §4b 已确认。 */
const GRID_STROKE = "#0f172a";
/** 空格斜线的「浅灰」（规格 §6 第 3 步）。契约 §4b 已确认；方向为左上 → 右下。 */
const EMPTY_STROKE = "#cbd5e1";
/** 文字墨色（信息条 / 刻度 / 板号 / 页脚 / 用量表正文）。格内色号**不**用它，仍取 `labelInk`。 */
const TEXT_INK = "#0f172a";
/** 刻度数字距网格边的带内内缩（px）。**带内落位偏移**，不是格子坐标。 */
const RULER_TEXT_GAP = 8;
/** 板号文字在刻度带内的内缩（px）。**带内落位偏移**。 */
const BOARD_TEXT_INSET = 2;
/** 信息条字号（px）。**不随格子缩放、不参与布局预算**。 */
const INFO_FONT_PX = 18;
/** 页脚字号（px）。**不随格子缩放、不参与布局预算**。 */
const FOOTER_FONT_PX = 16;
/** 用量表标题字号（px）。**不随格子缩放、不参与布局预算**。 */
const LEGEND_TITLE_FONT_PX = 20;
/** 用量表表头与表格行的字号（px）。**不随格子缩放**。 */
const LEGEND_FONT_PX = 14;
/** 用量表页脚三行（合计 / 精度声明 / 生成时间）的字号与行距（px）。**不随格子缩放**。 */
const LEGEND_FOOTER_FONT_PX = 12;
const LEGEND_FOOTER_LINE_H = 14;
const LEGEND_FOOTER_FIRST_LINE = 2;
/** 用量表色块边长（px）与色号 / 名称的横向偏移、颗数的右内缩（px）。带内落位偏移。 */
const LEGEND_SWATCH_SIZE = 20;
const LEGEND_CODE_X = 28;
const LEGEND_NAME_X = 88;
const LEGEND_RIGHT_PAD = 8;
/** 色块外框的描边色与线宽：画在真色填充**之上**的细框，让浅色块在白底上也有边界。 */
const SWATCH_FRAME_STROKE = "#94a3b8";
const SWATCH_FRAME_WIDTH = 1;
/** 网格线的绘制档位顺序：**由细到粗，不许反**（规格 §6 第 5 步）。M15 的靶点就是这一行。 */
const GRID_GROUPS = ["thin", "major", "board"] as const;

/** 施工图的元信息。**由调用方给**（规格 §9 第 1 条：渲染器不读 `Date`，产物才可逐位回归）。 */
export interface SheetMeta {
  readonly projectName: string;
  readonly generatedAt: string;
  readonly totalBeads: number;
  readonly colorCount: number;
  readonly paletteName: string;
  readonly accuracy: string;
}

/** 取色卡里的颜色；下标越界响亮失败（静默跳过会留下一块与真相不符的像素）。 */
function colorOf(palette: Palette, index: number): PaletteColor {
  const color = palette.colors[index];
  if (color === undefined) {
    throw new Error(`色卡里没有下标 ${index} 的颜色`);
  }
  return color;
}

/** 信息条第一行。**口径未定（哪个尺寸算「成品」），见 G-3**：这里取长边豆数换算成厘米。 */
function infoLineOne(pattern: Pattern, meta: SheetMeta): string {
  const longEdge = Math.max(pattern.width, pattern.height);
  return `${meta.projectName} · ${pattern.width} × ${pattern.height} 格 · 成品 ${formatCm(beadsToCm(longEdge))} 厘米`;
}

/** 信息条第二行：**精度声明是主规格 §11 的硬要求，不许省略**（末尾那一段来自 `meta.accuracy`）。 */
function infoLineTwo(meta: SheetMeta, tileBeads: number): string {
  return `${meta.paletteName} · 全图 ${meta.totalBeads} 颗（${meta.colorCount} 种色）/ 本片 ${tileBeads} 颗 · ${meta.generatedAt} · ${meta.accuracy}`;
}

/** 页脚：`r / c` 取 tile 的行序 / 列序（+1），列行范围是 1 起的**全局**格坐标。文案口径见 G-3。 */
function footerLine(tile: SheetTilePlan, tileBeads: number): string {
  const firstCol = tile.originCol + 1;
  const lastCol = tile.originCol + tile.cols;
  const firstRow = tile.originRow + 1;
  const lastRow = tile.originRow + tile.rows;
  return `第 ${tile.rowIndex + 1}/${tile.colIndex + 1} 片 · 列 ${firstCol}–${lastCol} · 行 ${firstRow}–${lastRow}（含）· 本片 ${tileBeads} 颗`;
}

/**
 * 画一张施工图分片：固定 8 步（规格 §6 第 1–8 步）。每一步只读 plan 给的几何，渲染器零算术。
 *
 * **为何公开**：`views/EditorPage.vue` 的导出面板（任务 4）是唯一生产消费者——它拿到 plan 的
 * `tiles`，逐片调用本函数、逐片下载（裁决 3 的用户手势口径）。用例用普通对象桩调用它。
 */
export function drawSheetTile(
  target: RenderTarget2D,
  pattern: Pattern,
  palette: Palette,
  plan: SheetPlan,
  tile: SheetTilePlan,
  meta: SheetMeta,
): void {
  // 入口守卫（契约 §12）写在任何写操作之前。`kind` 与 `tile` 的归属都是「错配不报错、
  // 只把坐标静默映射到另一片」的形态（计划任务 0 的 R-3），故一条不少。
  const kind: string = plan.kind;
  if (kind !== "sheet") {
    throw new Error(`plan 的类型不匹配：期望 sheet，实际 ${kind}`);
  }
  if (!plan.tiles.includes(tile)) {
    throw new Error("传入的 tile 不属于这个 plan");
  }
  if (pattern.paletteId !== palette.id) {
    throw new Error(`图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${palette.id} 不一致`);
  }

  // 第 1 步：底。整张画布填白（空格因此天然是白的，第 3 步不再填）。
  target.fillStyle = SHEET_BACKGROUND;
  target.fillRect(0, 0, tile.canvasWidth, tile.canvasHeight);

  // 第 2 步：信息条两行。本片颗数走 layout 的 countTileBeads（O(本片格数)），渲染器不自己数格子。
  const tileBeads = countTileBeads(pattern, tile);
  target.fillStyle = TEXT_INK;
  target.font = `${INFO_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "top";
  target.fillText(infoLineOne(pattern, meta), SHEET_MARGIN, SHEET_MARGIN);
  target.fillText(
    infoLineTwo(meta, tileBeads),
    SHEET_MARGIN,
    SHEET_MARGIN + Math.round(SHEET_INFO_BAR_H / 2),
  );

  // 第 3 步：色块与空格。逐格 `cellBox` → `cellAt`；实心格立刻填（**不画每格边框**，格线统一在
  // 第 5 步画），空格只收集斜线、循环结束后共用一次 beginPath / stroke。
  const emptyBoxes: PixelRect[] = [];
  const labelCells: Array<{
    readonly code: string;
    readonly ink: string;
    readonly cx: number;
    readonly cy: number;
  }> = [];
  for (let row = tile.originRow; row < tile.originRow + tile.rows; row += 1) {
    for (let col = tile.originCol; col < tile.originCol + tile.cols; col += 1) {
      const value = cellAt(pattern, col, row);
      const box = cellBox(tile, col, row);
      if (value === EMPTY) {
        emptyBoxes.push(box);
        continue;
      }
      const color = colorOf(palette, value);
      target.fillStyle = rgbCss(color.rgb);
      target.fillRect(box.x, box.y, box.width, box.height);
      // 第 4 步的色号只在这里收集：`plan.labels` 全文件**只读这一处**（M4 的靶点唯一）。
      // 关闭色号时不付 rgbToLab 的代价。
      if (plan.labels) {
        labelCells.push({
          code: color.code,
          ink: labelInk(color.rgb),
          cx: box.x + box.width / 2,
          cy: box.y + box.height / 2,
        });
      }
    }
  }
  if (emptyBoxes.length > 0) {
    target.beginPath();
    target.lineWidth = tile.lineWidths.thin;
    target.strokeStyle = EMPTY_STROKE;
    for (const box of emptyBoxes) {
      target.moveTo(box.x, box.y);
      target.lineTo(box.x + box.width, box.y + box.height);
    }
    target.stroke();
  }

  // 第 4 步：格内色号。字号取 plan 的 labelFontPx、墨色取 labelInk（Lab 的 L*），位置取 cellBox 的中心。
  if (labelCells.length > 0) {
    target.font = `${tile.labelFontPx}px sans-serif`;
    target.textAlign = "center";
    target.textBaseline = "middle";
    for (const cell of labelCells) {
      target.fillStyle = cell.ink;
      target.fillText(cell.code, cell.cx, cell.cy);
    }
  }

  // 第 5 步：网格线。按档分组、由细到粗，**每档一次 beginPath + 每线一对 moveTo/lineTo + 一次 stroke**；
  // 顺序不能反——先画粗线会被后画的细线切断，板边界就不再连续。
  for (const group of GRID_GROUPS) {
    const vertical = tile.vLines.filter((line) => line.kind === group);
    const horizontal = tile.hLines.filter((line) => line.kind === group);
    if (vertical.length === 0 && horizontal.length === 0) continue; // 不成组就不发空 stroke
    target.beginPath();
    target.lineWidth = tile.lineWidths[group];
    target.strokeStyle = GRID_STROKE;
    for (const line of vertical) {
      target.moveTo(line.at, tile.grid.y);
      target.lineTo(line.at, tile.grid.y + tile.grid.height);
    }
    for (const line of horizontal) {
      target.moveTo(tile.grid.x, line.at);
      target.lineTo(tile.grid.x + tile.grid.width, line.at);
    }
    target.stroke();
  }

  // 第 6 步：刻度。位置取自 plan（渲染器不自己算），显示值是**全局格号 + 1**。
  target.fillStyle = TEXT_INK;
  target.font = `${tile.tickFontPx}px sans-serif`;
  target.textAlign = "center";
  target.textBaseline = "bottom";
  for (const tick of tile.colTicks) {
    target.fillText(String(tick.col + 1), tick.x, tile.grid.y - RULER_TEXT_GAP);
  }
  target.textAlign = "right";
  target.textBaseline = "middle";
  for (const tick of tile.rowTicks) {
    target.fillText(String(tick.row + 1), tile.grid.x - RULER_TEXT_GAP, tick.y);
  }

  // 第 7 步：板边界标注。位置取自 plan 的 colBoards / rowBoards（带内远离网格的那一侧）。
  target.textAlign = "center";
  target.textBaseline = "top";
  for (const edge of tile.colBoards) {
    target.fillText(`第 ${edge.board} 块板`, edge.x, tile.grid.y - SHEET_RULER_TOP + BOARD_TEXT_INSET);
  }
  target.textAlign = "left";
  target.textBaseline = "middle";
  for (const edge of tile.rowBoards) {
    target.fillText(
      `第 ${edge.board} 块板`,
      tile.grid.x - SHEET_RULER_LEFT + BOARD_TEXT_INSET,
      edge.y,
    );
  }

  // 第 8 步：页脚（片范围）。r / c 取 tile.rowIndex / colIndex，**不从 index 反推网格形状**。
  target.fillStyle = TEXT_INK;
  target.font = `${FOOTER_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "middle";
  target.fillText(
    footerLine(tile, tileBeads),
    SHEET_MARGIN,
    tile.grid.y + tile.grid.height + SHEET_FOOTER_H / 2,
  );
}

/** 用量表里的合计颗数（与 `patternStats().total` 同义，但表只吃 `usages`，所以这里自己求和）。 */
function sumUsageCounts(usages: readonly ColorUsage[]): number {
  let total = 0;
  for (const usage of usages) total += usage.count;
  return total;
}

/**
 * 用量表（施工图的「第二种纸」，独立成图——规格 §1.4 的 D3：图例高度依赖用色数，留在施工图上
 * 会让布局出现循环依赖）。
 *
 * 组成（规格 §6 末段）：标题行 + 表头（**仅当 `plan.itemRows ≥ 1`**）+ 每项（色块 / 色号 / 名称 /
 * 颗数）+ 合计行 + 精度声明 + 生成时间。
 *
 * **为什么 `palette` 是必需入参**（2026-10-05 裁定）：色块要画真色，而 `ColorUsage` 只有
 * `code` / `name` / `count`（`core/pattern/stats.ts` 不许改）。色号 → rgb **只许**走
 * `createPaletteRuntime(palette).indexByCode`，不另写一份「色号 → 下标」的查找。
 *
 * **空表的例外**：`usages` 为空时**不画表头、不画色块、不画任何项**，只留标题、`合计 0 颗`、
 * 精度声明与生成时间（没有数据行的表头是噪声）。
 *
 * **为何公开**：`views/EditorPage.vue` 的导出面板（任务 4）是唯一生产消费者。
 */
export function drawLegend(
  target: RenderTarget2D,
  palette: Palette,
  usages: readonly ColorUsage[],
  plan: LegendPlan,
  meta: SheetMeta,
): void {
  const kind: string = plan.kind;
  if (kind !== "legend") {
    throw new Error(`plan 的类型不匹配：期望 legend，实际 ${kind}`);
  }

  // plan 内部自洽性（规格 §12，2026-10-05 裁定 G-11）：列数 × 每项宽 + 两侧边距必须等于画布宽。
  // 这条**替代**了「比对 `itemCols` 的期望值」——后者从 `(usages, plan)` 根本推不出来（13 列 1 行与
  // 15 列 1 行在 ≤15 项时行数相同），而查「计划自己是否自洽」一行就能判别，且能抓住「列数与画布宽
  // 配错」这一类伪造计划。**残余如实记**：伪造者若连 `canvasWidth` 一起换成自洽的假值，仍然不可判别。
  if (plan.itemCols * plan.itemWidth + 2 * SHEET_MARGIN !== plan.canvasWidth) {
    throw new Error(
      `用量表计划不自洽：${plan.itemCols} 列 × ${plan.itemWidth} px + 边距 ≠ 画布宽 ${plan.canvasWidth} px`,
    );
  }

  // 「usages 与 plan 同源」守卫：与 R-3 的 `tile ∈ plan.tiles` 同一类——配错不会报错，
  // 只会让行数溢出画布、画出一张看起来正常的残缺表。
  const expectedRows = Math.ceil(usages.length / plan.itemCols);
  if (plan.itemRows !== expectedRows) {
    throw new Error(
      `用量表计划与本表不符：计划 ${plan.itemRows} 行、按 ${usages.length} 项应为 ${expectedRows} 行`,
    );
  }

  // 色号 → rgb 的解析**全部**放在动笔之前（AGENTS.md：校验写在任何写操作之前）。
  // 若放到逐项循环里，第二项色号非法时会留下「半张已经画好」的产物。
  const runtime = createPaletteRuntime(palette);
  const swatchStyles: string[] = usages.map((usage) => {
    const index = runtime.indexByCode.get(usage.code);
    if (index === undefined) {
      throw new Error(`用量表里的色号不在色卡里：${usage.code}`);
    }
    const color = palette.colors[index];
    if (color === undefined) {
      throw new Error(`色卡里没有下标 ${index} 的颜色`);
    }
    return rgbCss(color.rgb);
  });

  target.fillStyle = SHEET_BACKGROUND;
  target.fillRect(0, 0, plan.canvasWidth, plan.canvasHeight);

  // 标题行
  target.fillStyle = TEXT_INK;
  target.font = `${LEGEND_TITLE_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "top";
  target.fillText(`${meta.projectName} · 用量表`, SHEET_MARGIN, plan.headerY);

  // 表头（仅在有用量项时画：空表的表头会让「空表只有标题与合计」那条断言失去意义）
  if (plan.itemRows >= 1) {
    target.font = `${LEGEND_FONT_PX}px sans-serif`;
    target.textAlign = "left";
    target.textBaseline = "middle";
    const headerY = plan.tableTop - plan.rowHeight / 2;
    target.fillText("色号", SHEET_MARGIN + LEGEND_CODE_X, headerY);
    target.fillText("名称", SHEET_MARGIN + LEGEND_NAME_X, headerY);
    target.textAlign = "right";
    target.fillText("颗数", SHEET_MARGIN + plan.itemWidth - LEGEND_RIGHT_PAD, headerY);
  }

  // 每项一行（多列时按 itemCols 换列）
  for (let index = 0; index < usages.length; index += 1) {
    const usage = usages[index] as ColorUsage;
    const cellX = SHEET_MARGIN + (index % plan.itemCols) * plan.itemWidth;
    const centerY =
      plan.tableTop + Math.floor(index / plan.itemCols) * plan.rowHeight + plan.rowHeight / 2;
    const swatchY = centerY - LEGEND_SWATCH_SIZE / 2;

    // 色块：先填该色号的**真色**（`rgbCss` 口径，与施工图的色块同一字符串），再压一道细框
    // （浅色块在白底上才有边界）。真色的来源见上面 `swatchStyles`。
    target.fillStyle = swatchStyles[index] as string;
    target.fillRect(cellX, swatchY, LEGEND_SWATCH_SIZE, LEGEND_SWATCH_SIZE);
    target.strokeStyle = SWATCH_FRAME_STROKE;
    target.lineWidth = SWATCH_FRAME_WIDTH;
    target.strokeRect(cellX, swatchY, LEGEND_SWATCH_SIZE, LEGEND_SWATCH_SIZE);

    target.fillStyle = TEXT_INK;
    target.font = `${LEGEND_FONT_PX}px sans-serif`;
    target.textAlign = "left";
    target.textBaseline = "middle";
    target.fillText(usage.code, cellX + LEGEND_CODE_X, centerY);
    target.fillText(usage.name, cellX + LEGEND_NAME_X, centerY);
    target.textAlign = "right";
    target.fillText(String(usage.count), cellX + plan.itemWidth - LEGEND_RIGHT_PAD, centerY);
  }

  // 合计行 + 精度声明（主规格 §11 的硬要求，不许省略）+ 生成时间
  const total = sumUsageCounts(usages);
  target.fillStyle = TEXT_INK;
  target.font = `${LEGEND_FOOTER_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "top";
  target.fillText(`合计 ${total} 颗`, SHEET_MARGIN, plan.totalY + LEGEND_FOOTER_FIRST_LINE);
  target.fillText(
    meta.accuracy,
    SHEET_MARGIN,
    plan.totalY + LEGEND_FOOTER_FIRST_LINE + LEGEND_FOOTER_LINE_H,
  );
  target.fillText(
    `生成时间：${meta.generatedAt}`,
    SHEET_MARGIN,
    plan.totalY + LEGEND_FOOTER_FIRST_LINE + 2 * LEGEND_FOOTER_LINE_H,
  );
}
```

> 两个 `draw*` 都带 JSDoc「为何公开」（`AGENTS.md`「公开 API ≠ 被使用的 API」）：生产消费者是任务 4 的 `ExportPanel.vue`（本片段起草时该面板尚未落地，如实写明是「面板」而不是「某行代码」）。

- [ ] **步骤 5：运行测试，确认通过**

运行：`npx vitest run src/core/render/__tests__/sheet.test.ts`
预期：PASS（第一批全绿）。若失败，**先怀疑用例里的算术**：夹具的每个数字都能手算（6×6 → `cellPx = 40`、`grid = {88,176,240,240}`、14 条网格线、3 条空格斜线、33 个实心格）。凡是「实现对了、用例错了」的情形，如实写进报告。

- [ ] **步骤 6：追加第二批用例（用量表 + §13.2 的渲染器侧承重断言）**

第二批含：① `makePaletteOf` 夹具工厂；② `drawLegend` 的六条（表头 / 每项一行 / **色块真是那个颜色** / 空表 / 同源守卫 / 计划自洽性）；③ §13.2-2 与 §13.2-3 的渲染器侧。

把下面整段**追加到 `sheet.test.ts` 末尾**（第一批的 import 已经够用，不要新增 import）：

```ts
/** 按色号表造一张色卡（用量表用例要把色号查回 rgb，所以色卡必须含这些色号）。 */
function makePaletteOf(codes: readonly string[]): Palette {
  return {
    id: "test-palette",
    name: "测试色卡",
    source: "test",
    accuracy: "屏幕色仅供参考，以实物为准",
    colors: codes.map((code, index) => ({
      code,
      name: `色 ${index + 1}`,
      rgb: [index * 10, index * 5, 0] as const,
    })),
  };
}

describe("drawLegend", () => {
  const palette = makePalette(); // A1 白 / A2 黑 / A3 红 / A4 浅灰
  const usages = [
    { code: "A1", name: "白", count: 12 },
    { code: "A2", name: "黑", count: 30 },
  ];
  const plan = planLegend(usages);

  it("标题行 + 表头 + 每项一行 + **色块是真色** + 合计 = 各项之和 + 精度声明 + 生成时间", () => {
    const { target, calls } = createMockTarget();
    drawLegend(target, palette, usages, plan, makeMeta());

    expect(calls.fills[0]).toMatchObject({
      x: 0,
      y: 0,
      w: plan.canvasWidth,
      h: plan.canvasHeight,
      fillStyle: "#ffffff",
    });
    // 顺序：标题 → 表头三列（表头必须在任何项行之前）
    expect(calls.texts.slice(0, 4).map((text) => text.text)).toEqual([
      "测试工程 · 用量表",
      "色号",
      "名称",
      "颗数",
    ]);

    // 每项一行：第 i 项落在第 i 列（默认上限下 itemCols = 13，两项同行不同列）
    expect(plan.itemCols).toBe(13);
    const cellX = (index: number) => SHEET_MARGIN + index * plan.itemWidth;
    const centerY = plan.tableTop + plan.rowHeight / 2;
    expect(calls.texts.find((text) => text.text === "A1")).toMatchObject({
      x: cellX(0) + 28,
      y: centerY,
      textAlign: "left",
      textBaseline: "middle",
    });
    expect(calls.texts.find((text) => text.text === "A2")).toMatchObject({ x: cellX(1) + 28, y: centerY });
    expect(calls.texts.find((text) => text.text === "白")).toMatchObject({ x: cellX(0) + 88, y: centerY });
    expect(calls.texts.find((text) => text.text === "30")).toMatchObject({
      x: cellX(1) + plan.itemWidth - 8,
      y: centerY,
      textAlign: "right",
    });

    // 色块：**真是那个颜色**（2026-10-05 补 `palette` 入参后才可断言）——fillStyle 必须等于该色号的
    // `rgbCss`，而且是一次**填充**（只描边的占位框会让这条红）。外框是压在真色之上的细框。
    const swatchY = plan.tableTop + (plan.rowHeight - 20) / 2;
    expect(calls.fills).toHaveLength(1 + 2);
    expect(calls.fills[1]).toMatchObject({
      x: cellX(0),
      y: swatchY,
      w: 20,
      h: 20,
      fillStyle: "rgb(255, 255, 255)",
    });
    expect(calls.fills[2]).toMatchObject({
      x: cellX(1),
      y: swatchY,
      w: 20,
      h: 20,
      fillStyle: "rgb(0, 0, 0)",
    });
    expect(calls.strokeRects).toHaveLength(2);
    expect(calls.strokeRects[0]).toMatchObject({ x: cellX(0), y: swatchY, w: 20, h: 20 });

    // 合计：测试自己求和，与被测实现不同源
    const expectedTotal = usages.reduce((sum, usage) => sum + usage.count, 0);
    expect(expectedTotal).toBe(42);
    expect(calls.texts.some((text) => text.text === "合计 42 颗")).toBe(true);
    expect(calls.texts.some((text) => text.text === makeMeta().accuracy)).toBe(true);
    expect(calls.texts.some((text) => text.text === "生成时间：2026-10-05 12:00")).toBe(true);
    expect(calls.texts).toHaveLength(1 + 3 + 2 * 3 + 3);
  });

  it("多列布局：第 14 项换到第 2 行第 1 列", () => {
    const codes = Array.from({ length: 14 }, (_, index) => `B${index + 1}`);
    const manyPalette = makePaletteOf(codes);
    const many = codes.map((code, index) => ({ code, name: `色 ${index + 1}`, count: index + 1 }));
    const manyPlan = planLegend(many);
    expect(manyPlan.itemCols).toBe(13);
    expect(manyPlan.itemRows).toBe(2);

    const { target, calls } = createMockTarget();
    drawLegend(target, manyPalette, many, manyPlan, makeMeta());
    expect(calls.texts.find((text) => text.text === "B14")).toMatchObject({
      x: SHEET_MARGIN + 28,
      y: manyPlan.tableTop + manyPlan.rowHeight + manyPlan.rowHeight / 2,
    });
    expect(calls.texts.some((text) => text.text === "合计 105 颗")).toBe(true); // 1+…+14 = 105
    expect(calls.fills).toHaveLength(1 + 14);
  });

  it("空用量表：表格区只有标题与合计（不画表头、不画项、不画色块）", () => {
    const emptyPlan = planLegend([]);
    const { target, calls } = createMockTarget();
    drawLegend(target, palette, [], emptyPlan, makeMeta({ totalBeads: 0, colorCount: 0 }));

    expect(calls.texts.map((text) => text.text)).toEqual([
      "测试工程 · 用量表",
      "合计 0 颗",
      "屏幕色仅供参考，以实物为准",
      "生成时间：2026-10-05 12:00",
    ]);
    expect(calls.strokeRects).toEqual([]);
    expect(calls.fills).toHaveLength(1); // 只有整张底色
  });

  it("usages 与 plan 不同源即抛，且不留下半张表（写在任何写操作之前）", () => {
    // 14 项 ⇒ 计划是 2 行；只喂 2 项 ⇒ 应为 1 行：行数不符必须响亮失败
    const many = Array.from({ length: 14 }, (_, index) => ({
      code: `A${index + 1}`,
      name: `色 ${index + 1}`,
      count: index + 1,
    }));
    const manyPlan = planLegend(many);
    expect(manyPlan.itemRows).toBe(2);

    const { target, calls } = createMockTarget();
    expect(() => drawLegend(target, palette, usages, manyPlan, makeMeta())).toThrow(
      "用量表计划与本表不符：计划 2 行、按 2 项应为 1 行",
    );
    expect(calls.fills).toEqual([]);
  });

  it("色号不在色卡里即抛，且不留下半张表（**第二项**才是坏色号，证明校验在动笔之前）", () => {
    const stranger = [
      { code: "A1", name: "白", count: 1 },
      { code: "Z9", name: "不在色卡", count: 2 },
    ];
    const strangerPlan = planLegend(stranger);
    const { target, calls } = createMockTarget();
    expect(() => drawLegend(target, palette, stranger, strangerPlan, makeMeta())).toThrow(
      "用量表里的色号不在色卡里：Z9",
    );
    expect(calls.fills).toEqual([]);
  });

  it("plan 不自洽（列数与画布宽配错）即抛，且不留下半张表", () => {
    // 伪造一个「12 列」的计划：行数仍与 usages 相符（ceil(2/12) = 1），所以只有自洽性检查拦得住它
    const forged = { ...plan, itemCols: 12 };
    const { target, calls } = createMockTarget();
    expect(() => drawLegend(target, palette, usages, forged, makeMeta())).toThrow(
      "用量表计划不自洽：12 列 × 300 px + 边距 ≠ 画布宽 3948 px",
    );
    expect(calls.fills).toEqual([]);
  });
});

describe("§13.2 承重断言的渲染器侧", () => {
  const palette = makePalette();

  it("§13.2-2：同一格在单张计划与分片计划里落到同一个 fillRect（去掉 origin 偏移会红）", () => {
    const single = makePattern(116, 116);
    const tiled = makePattern(500, 500);
    const singlePlan = planSheets(single, palette);
    const tiledPlan = planSheets(tiled, palette);
    // 前提：两次计划的格像素相同（不同就无从比较——用例自己先钉住这个前提）
    expect(singlePlan.cellPx).toBe(33);
    expect(tiledPlan.cellPx).toBe(33);

    const singleTile = singlePlan.tiles[0] as SheetTilePlan;
    const tiledTile = tiledPlan.tiles[0] as SheetTilePlan;
    const singleRun = createMockTarget();
    drawSheetTile(singleRun.target, single, palette, singlePlan, singleTile, makeMeta());
    const tiledRun = createMockTarget();
    drawSheetTile(tiledRun.target, tiled, palette, tiledPlan, tiledTile, makeMeta());

    const boxSingle = cellBox(singleTile, 7, 13);
    const boxTiled = cellBox(tiledTile, 7, 13);
    expect(boxTiled).toEqual(boxSingle);
    const fillSingle = fillAt(singleRun.calls, boxSingle.x, boxSingle.y);
    expect(fillSingle).toBeDefined();
    expect(fillAt(tiledRun.calls, boxTiled.x, boxTiled.y)).toEqual(fillSingle);
  });

  it("§13.2-3：底色铺满 plan 给的画布，格子区宽度 = 列数 × 格像素（与缩略图 512 上限无关）", () => {
    const big = makePattern(500, 500);
    const plan = planSheets(big, palette);
    const tile = plan.tiles[0] as SheetTilePlan;
    const { target, calls } = createMockTarget();
    drawSheetTile(target, big, palette, plan, tile, makeMeta());

    expect(calls.fills[0]).toMatchObject({ x: 0, y: 0, w: tile.canvasWidth, h: tile.canvasHeight });
    expect(tile.canvasWidth).toBe(2 * SHEET_MARGIN + SHEET_RULER_LEFT + tile.cols * plan.cellPx);
    expect(tile.grid.width).toBe(tile.cols * plan.cellPx);
    // 规格 §9 第 3 条：导出不经过 renderPatternThumbnail（它的 THUMBNAIL_MAX_EDGE = 512）
    expect(tile.grid.width).toBeGreaterThan(512);
    expect(tile.grid.height).toBeGreaterThan(512);
  });
});
```

- [ ] **步骤 7：运行测试，确认通过**

运行：`npx vitest run src/core/render/__tests__/sheet.test.ts`
预期：PASS（两个 describe 全绿）。用量表那些字面量（「测试工程 · 用量表」「色号 / 名称 / 颗数」「合计 N 颗」「生成时间：…」）**已逐字写进契约 §4b 并获批准**（2026-10-05）：实现时照抄，不许改文案；若你发现实现与 §4b 有任何不一致，以 §4b 为准并把它写进报告。

- [ ] **步骤 8：写失败的用例 `src/core/render/__tests__/share.test.ts`**

九条：画布尺寸与 `cols` / `rows`；关插值与关闭时机；`fillRect` 次数 = 实心格数；颜色逐格；**四角与 `shareCellBox` 逐位一致**；**`shareCellBox` 的三种守卫**；全空格；**plan 与图纸不符即抛**；入口守卫（kind / 色卡 / 色号下标）。

```ts
import { describe, expect, it } from "vitest";
import type { Palette } from "../../palette/types";
import { EMPTY, type Pattern } from "../../pattern/types";
import { planShare, planSheets, shareCellBox, type SharePlan } from "../layout";
import { drawShare } from "../share";
import { createMockTarget } from "./helpers";

/** 与 `sheet.test.ts` 同一张夹具（6×6、33 个实心格、3 个空格）：分享图与施工图的格值必须同源。 */
const CELLS_6X6: readonly number[] = [
  0, 0, EMPTY, 0, 0, 0,
  0, 1, 1, 1, 1, 1,
  2, 0, 0, 0, EMPTY, 0,
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, EMPTY, 3,
];

function makePalette(): Palette {
  return {
    id: "test-palette",
    name: "测试色卡",
    source: "test",
    accuracy: "屏幕色仅供参考，以实物为准",
    colors: [
      { code: "A1", name: "白", rgb: [255, 255, 255] },
      { code: "A2", name: "黑", rgb: [0, 0, 0] },
      { code: "A3", name: "红", rgb: [255, 0, 0] },
      { code: "A4", name: "浅灰", rgb: [200, 200, 210] },
    ],
  };
}

function makePattern(width: number, height: number, values?: readonly number[]): Pattern {
  const cells = new Uint16Array(width * height);
  if (values !== undefined) cells.set(values);
  return { width, height, paletteId: "test-palette", cells };
}

/** 独立计数（不用 `cellAt` / `countTileBeads`：期望值必须与被测实现不同源）。 */
function solidInRange(
  pattern: Pattern,
  originCol: number,
  originRow: number,
  cols: number,
  rows: number,
): number {
  let count = 0;
  for (let row = originRow; row < originRow + rows; row += 1) {
    for (let col = originCol; col < originCol + cols; col += 1) {
      if ((pattern.cells[row * pattern.width + col] as number) !== EMPTY) count += 1;
    }
  }
  return count;
}

describe("drawShare", () => {
  const palette = makePalette();
  const pattern = makePattern(6, 6, CELLS_6X6);
  const plan = planShare(pattern);

  it("planShare 的画布尺寸 = 格数 × 格像素（与 512 无关），并把图纸宽高记在 cols / rows 上", () => {
    expect(plan.cols).toBe(6);
    expect(plan.rows).toBe(6);
    expect(plan.cellPx).toBe(64);
    expect(plan.canvasWidth).toBe(pattern.width * plan.cellPx);
    expect(plan.canvasHeight).toBe(pattern.height * plan.cellPx);
    expect(plan.canvasWidth).toBe(384);
    const big = planShare(makePattern(500, 500));
    expect(big.cols).toBe(500);
    expect(big.rows).toBe(500);
    expect(big.cellPx).toBe(4);
    expect(big.canvasWidth).toBe(2000);
    expect(big.canvasHeight).toBe(2000);
  });

  it("四角：fillRect 的实参与 shareCellBox 逐位一致（右下角是空格 ⇒ 那里没有 fillRect）", () => {
    const { target, calls } = createMockTarget();
    drawShare(target, pattern, palette, plan);

    for (const [col, row] of [[0, 0], [5, 0], [0, 5], [5, 5]] as const) {
      const box = shareCellBox(plan, col, row);
      const fill = calls.fills.find((candidate) => candidate.x === box.x && candidate.y === box.y);
      if ((pattern.cells[row * 6 + col] as number) === EMPTY) {
        expect(fill).toBeUndefined(); // (5,5) 是空格
        continue;
      }
      expect(fill).toMatchObject({ w: box.width, h: box.height });
      expect(box.width).toBe(plan.cellPx);
    }
    // 映射本身逐位钉住（分享图没有边距：0 格就在 (0,0)）
    expect(shareCellBox(plan, 0, 0)).toEqual({ x: 0, y: 0, width: 64, height: 64 });
    expect(shareCellBox(plan, 5, 5)).toEqual({ x: 320, y: 320, width: 64, height: 64 });
  });

  it("shareCellBox 的守卫与 cellBox 同口径（越界列 / 越界行 / 非安全整数）", () => {
    // 与任务 1 的 `layout.test.ts` 同口径地再钉一遍：渲染器现在**依赖**这条守卫（超范围取位置
    // 会静默画到画布外），所以它也得由渲染器这一侧的用例守着。
    expect(() => shareCellBox(plan, 6, 0)).toThrow("列 6 不在分享图范围 0–5 内");
    expect(() => shareCellBox(plan, 0, 6)).toThrow("行 6 不在分享图范围 0–5 内");
    expect(() => shareCellBox(plan, -1, 0)).toThrow("列 -1 不在分享图范围 0–5 内");
    expect(() => shareCellBox(plan, 0.5, 0)).toThrow("格子列号必须是安全整数");
    expect(() => shareCellBox(plan, 0, 2 ** 53)).toThrow("格子行号必须是安全整数");
  });

  it("关插值：imageSmoothingEnabled = false，且在第一次填充之前就已关闭", () => {
    const { target, calls } = createMockTarget();
    expect(target.imageSmoothingEnabled).toBe(true); // 桩的初值：证明这条断言不是恒真
    drawShare(target, pattern, palette, plan);
    expect(target.imageSmoothingEnabled).toBe(false);
    expect(calls.fills.length).toBeGreaterThan(0);
    expect(calls.fills.every((fill) => fill.smoothing === false)).toBe(true);
  });

  it("fillRect 次数 = 实心格数；空格一次都不填（画布零初始化 ⇒ 空格全透明）", () => {
    const { target, calls } = createMockTarget();
    drawShare(target, pattern, palette, plan);

    const solid = solidInRange(pattern, 0, 0, 6, 6);
    expect(solid).toBe(33);
    expect(calls.fills).toHaveLength(solid);

    const expected = new Set<string>();
    // 期望值故意**不**用 `shareCellBox` 现算：那句是被测实现自己走的映射，用它算期望等于自证。
    // 这里直接手写「列 × 格像素」（测试里做算术没问题，闸门只扫实现文件）。
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        if ((pattern.cells[row * 6 + col] as number) !== EMPTY) {
          expected.add(`${col * plan.cellPx},${row * plan.cellPx}`);
        }
      }
    }
    expect(new Set(calls.fills.map((fill) => `${fill.x},${fill.y}`))).toEqual(expected);
    expect(calls.fills.every((fill) => fill.w === plan.cellPx && fill.h === plan.cellPx)).toBe(true);
  });

  it("颜色逐格取自色卡；无网格、无文字、无边距", () => {
    const { target, calls } = createMockTarget();
    drawShare(target, pattern, palette, plan);

    expect(
      calls.fills.find((fill) => fill.x === plan.cellPx && fill.y === plan.cellPx),
    ).toMatchObject({ fillStyle: "rgb(0, 0, 0)" }); // (col=1, row=1) 是 1 号色（黑）
    expect(
      calls.fills.find((fill) => fill.x === 5 * plan.cellPx && fill.y === 5 * plan.cellPx),
    ).toMatchObject({ fillStyle: "rgb(200, 200, 210)" }); // (col=5, row=5) 是 4 号色（浅灰）

    expect(calls.texts).toEqual([]);
    expect(calls.paths).toEqual([]);
    expect(calls.strokeRects).toEqual([]);

    // 无边距：第一格从 (0,0) 起，最后一格正好贴到画布右下角
    expect(calls.fills.some((fill) => fill.x === 0 && fill.y === 0)).toBe(true);
    expect(
      calls.fills.some(
        (fill) => fill.x + fill.w === plan.canvasWidth && fill.y + fill.h === plan.canvasHeight,
      ),
    ).toBe(true);
  });

  it("全空格图纸 ⇒ 一个块都不画（结果是一张全透明 PNG）", () => {
    const blank = makePattern(3, 3, [
      EMPTY, EMPTY, EMPTY,
      EMPTY, EMPTY, EMPTY,
      EMPTY, EMPTY, EMPTY,
    ]);
    const { target, calls } = createMockTarget();
    drawShare(target, blank, palette, planShare(blank));
    expect(calls.fills).toEqual([]);
    expect(calls.texts).toEqual([]);
    expect(target.imageSmoothingEnabled).toBe(false);
  });

  it("plan 与图纸不符即抛（否则会静默画出缺角 / 多空的图）", () => {
    const { target, calls } = createMockTarget();

    const narrower = makePattern(5, 6);
    expect(() => drawShare(target, narrower, palette, plan)).toThrow(
      "分享图计划与图纸不符：计划 6×6、图纸 5×6",
    );
    expect(calls.fills).toEqual([]);

    const shorter = makePattern(6, 5);
    expect(() => drawShare(target, shorter, palette, plan)).toThrow(
      "分享图计划与图纸不符：计划 6×6、图纸 6×5",
    );
    expect(calls.fills).toEqual([]);
  });

  it("plan.kind 不匹配 / 色卡不一致 / 色号下标越界：写在任何写操作之前", () => {
    const { target, calls } = createMockTarget();

    const sheetPlan = planSheets(pattern, palette);
    expect(() => drawShare(target, pattern, palette, sheetPlan as unknown as SharePlan)).toThrow(
      "plan 的类型不匹配：期望 share，实际 sheet",
    );
    expect(calls.fills).toEqual([]);

    expect(() => drawShare(target, pattern, { ...palette, id: "other" }, plan)).toThrow(
      "与传入的色卡 other 不一致",
    );
    expect(calls.fills).toEqual([]);

    const broken = makePattern(6, 6);
    broken.cells[0] = 9;
    expect(() => drawShare(target, broken, palette, planShare(broken))).toThrow(
      "色卡里没有下标 9 的颜色",
    );
  });
});
```

- [ ] **步骤 9：运行测试，确认失败**

运行：`npx vitest run src/core/render/__tests__/share.test.ts`
预期：FAIL——`Failed to resolve import "../share"`。

- [ ] **步骤 10：写实现 `src/core/render/share.ts`**

```ts
import { cellAt } from "../pattern/edit";
import { EMPTY, type Pattern } from "../pattern/types";
import type { Palette } from "../palette/types";
import { rgbCss, shareCellBox, type SharePlan } from "./layout";
import type { RenderTarget2D } from "./types";

/**
 * 分享图（规格 §7）：纯色块、**无网格无文字无边距**、空格跳过（画布零初始化 ⇒ 完全透明）。
 *
 * 与 `sheet.ts` 同样受两条源码级闸门约束：不出现格像素标识符、格值只经 `cellAt`。
 * 格子 → 像素一律经 `shareCellBox(plan, col, row)`（2026-10-05 裁定新增；第一版只能拿
 * `canvasWidth / pattern.width` 反推，那正是「自己乘格像素」）。
 *
 * **为何公开**：`views/EditorPage.vue` 的导出面板（任务 4）是唯一生产消费者。
 */
export function drawShare(
  target: RenderTarget2D,
  pattern: Pattern,
  palette: Palette,
  plan: SharePlan,
): void {
  const kind: string = plan.kind;
  if (kind !== "share") {
    throw new Error(`plan 的类型不匹配：期望 share，实际 ${kind}`);
  }
  if (pattern.paletteId !== palette.id) {
    throw new Error(`图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${palette.id} 不一致`);
  }
  // plan 与图纸必须同源（规格 §12 / §7，2026-10-05 裁定 G-10）：`planShare` 把图纸宽高原样记在
  // `cols` / `rows` 上，所以这条比对是免费的。**不比对会静默画出一张缺角 / 多空的图**——超出图纸的
  // 格子经 `cellAt` 返回 `EMPTY`（透明），看起来只是「这张图有点空」。与 R-3 的 `tile ∈ plan.tiles`
  // 同一类：生产路径不可达，但「不可达也要响亮失败」正是那条守卫存在的理由。
  if (plan.cols !== pattern.width || plan.rows !== pattern.height) {
    throw new Error(
      `分享图计划与图纸不符：计划 ${plan.cols}×${plan.rows}、图纸 ${pattern.width}×${pattern.height}`,
    );
  }

  // 图纸是色块：插值会造出图纸里真不存在的中间色（与 services/patternThumbnail.ts 同一口径），
  // 而且必须在**第一次填充之前**关掉。
  target.imageSmoothingEnabled = false;

  // 格数范围取自 plan（`planShare` 把图纸宽高原样记在 cols / rows 上），位置一律经 `shareCellBox`
  // ——分享图与施工图共用同一条映射口径（安全整数、越界抛错），渲染器一行乘法都不写。
  for (let row = 0; row < plan.rows; row += 1) {
    for (let col = 0; col < plan.cols; col += 1) {
      const value = cellAt(pattern, col, row);
      if (value === EMPTY) continue;
      const color = palette.colors[value];
      if (color === undefined) {
        throw new Error(`色卡里没有下标 ${value} 的颜色`);
      }
      const box = shareCellBox(plan, col, row);
      target.fillStyle = rgbCss(color.rgb);
      target.fillRect(box.x, box.y, box.width, box.height);
    }
  }
}
```

> **分享图的格像素只有一个来源**：`shareCellBox(plan, col, row)`。如果你写出 `plan.canvasWidth / pattern.width` 或任何 `col * N` 形态，就退回了第一版那个被裁定删掉的写法（规格 §4.1 末段如实记录了那个洞）。

- [ ] **步骤 11：运行测试，确认通过**

运行：`npx vitest run src/core/render/__tests__/share.test.ts`
预期：PASS。

- [ ] **步骤 12：跑源码闸门，确认它转绿**

运行：`npx vitest run src/core/render/__tests__/layoutGate.test.ts`
预期：**PASS（7 条全绿）**——任务 1 结束时这条文件是红的（`import.meta.glob("../{sheet,share}.ts")` 匹配不到文件，键为空数组，第一条「扫描目标就是那两个渲染器文件」失败）。本任务交付两个渲染器后它必须转绿（含 2026-10-05 新增的第 3 条：「渲染器里不得出现 canvasWidth / canvasHeight 参与的除法」+「share.ts 经 shareCellBox 取格位置」——这两条正是 M18 的唯一防线）。
若仍红：把失败标题连原始输出一起贴进报告，**不许**改闸门（改 glob、放宽正则、把断言删掉都算违规），只改 `sheet.ts` / `share.ts`。

- [ ] **步骤 13：变异实测 M4「`labels = false` 时仍画色号」**

**变异实测（红数不许预估）**——下面 10 条（M4 / M9 / M10 / M11 / M12 / M15 + 本次裁定新增的 M17 / M18 / M19 / M20）逐条做一遍，每条都走同一个循环：

1. **先把正确版本放进暂存区**：`git add <被测文件>`。这一步不能省——`sheet.ts` / `share.ts` 此时还是**未跟踪文件**，`git checkout -- <file>` 对未跟踪文件会报 `did not match any file(s) known to git`，还原不了。
2. 改**一行**（下面每条给了逐字动作）。
3. 跑该条的聚焦命令，**数红了几条**、抄下失败点的**用例标题**。
4. `git checkout -- <被测文件>` 还原，再跑一次同一命令，确认**回到全绿**。
5. 把「动作 / 实测红数 / 失败点标题」三列回填到你的报告里。

| 变异 | 聚焦命令 | 该红的断言 | 起草时沙箱实测参考 | **本仓实测（实现者回填）** |
|---|---|---|---|---|
| M4 | `sheet.test.ts` | 「labels = false 时格区域内没有色号…」 | 红 1 | 红 ___（实现者回填）／失败点标题 ___（实现者回填） |
| M9 | `layoutGate.test.ts` | 「渲染器里不出现 cellPx」 | 红 1 | 红 ___（实现者回填）／失败点标题 ___（实现者回填） |
| M10 | `share.test.ts` | 「关插值：imageSmoothingEnabled = false…」 | 红 2 | 红 ___（实现者回填）／失败点标题 ___（实现者回填） |
| M11 | `sheet.test.ts` | 「空格不填色…」 | 红 3 | 红 ___（实现者回填）／失败点标题 ___（实现者回填） |
| M12 | `sheet.test.ts` | 「三档网格线由细到粗…」 | 红 2 | 红 ___（实现者回填）／失败点标题 ___（实现者回填） |
| M15 | `sheet.test.ts` | 「三档网格线由细到粗…」（顺序反转） | 红 2 | 红 ___（实现者回填）／失败点标题 ___（实现者回填） |
| M17 | `sheet.test.ts` | 「…**色块是真色**…」 | 红 2 | 红 ___（实现者回填）／失败点标题 ___（实现者回填） |
| M18 | `layoutGate.test.ts`（取值断言那边是 `share.test.ts`） | **闸门第 3 条**（「不得出现 canvasWidth / canvasHeight 参与的除法」）；**取值断言 0 红** | 闸门红 1 / 取值 0 红 | 闸门红 ___（实现者回填）／取值红 ___（实现者回填）／失败点标题 ___（实现者回填） |
| M19 | `share.test.ts` | 「plan 与图纸不符即抛…」 | 红 1 | 红 ___（实现者回填）／失败点标题 ___（实现者回填） |
| M20 | `sheet.test.ts` | 「plan 不自洽（列数与画布宽配错）即抛…」 | 红 1 | 红 ___（实现者回填）／失败点标题 ___（实现者回填） |

> **沙箱实测参考不是验收标准**：它是起草者在 `%TEMP%\b4v`（本仓 `tsc` / `vitest`、`node_modules` 指向本仓）里按原文抽出代码块跑出来的，用来证明「这些断言确实有判别力」。**实现者必须在本仓自己重跑并回填**；对不上就是发现了新东西，如实写进报告。

**M4：把 `labels = false` 时仍画色号。** 动作：`sheet.ts` 里 `if (plan.labels) {`（第 3 步收集色号那一处，全文件唯一的 `plan.labels` 读取点）改成 `if (true) {`。
聚焦用例：`npx vitest run src/core/render/__tests__/sheet.test.ts`
**该红的断言**：「labels = false 时格区域内没有色号；信息条 / 刻度 / 页脚照常写字（必须按区域过滤，否则是假绿）」。
（起草时在临时树实测：**红 1**，就是这一条；labels=true 的夹具不受影响，所以「33 条色号」那几条不会连带转红。）

- [ ] **步骤 14：变异实测 M9「把格像素标识符写进渲染器」**

动作：在 `sheet.ts` 的 `drawSheetTile` 里、`if (!plan.tiles.includes(tile))` 那一行之后插入一行：
`if (tile.cellPx < 0) { throw new Error("unreachable"); }`
（这个形态**不会改变任何输出**：条件恒假、不抛错，因此它只会打红闸门那一条，是隔离度最高的写法。）
聚焦用例：`npx vitest run src/core/render/__tests__/layoutGate.test.ts`
**该红的断言**：「渲染器里不出现 cellPx（坐标只能经 cellBox 取）」。
（起草时在临时树实测：**红 1**，就是这一条——隔离度如设计所愿，其余 4 条闸门用例仍绿。还原后再跑一次闸门确认 5 条全绿；这次实测同时证明**闸门的剥注释逻辑没把这条代码误吞**：它是真源码，不是注释。）

- [ ] **步骤 15：变异实测 M11「空格斜线删掉」**

动作：删掉 `sheet.ts` 里 `if (emptyBoxes.length > 0) { … }` 整个块（含 `beginPath` / 两条 `moveTo`/`lineTo` / `stroke`）。
聚焦用例：`npx vitest run src/core/render/__tests__/sheet.test.ts`
**该红的断言**：至少「空格不填色（MARD 有白色豆，白 ≠ 空），只在格内画一条浅灰斜线」。
（起草时在临时树实测：**红 3**——上面这条 +「三档网格线由细到粗、每档一次 beginPath / stroke，板边界最后画」+「moveTo / lineTo 各 = 网格线条数 + 空格数，且没有游离的路径操作」；少了那组路径，后面两条的计数与顺序也一起变。）

- [ ] **步骤 16：变异实测 M10「分享图不关插值」**

动作：删掉 `share.ts` 里 `target.imageSmoothingEnabled = false;` 那一行。
聚焦用例：`npx vitest run src/core/render/__tests__/share.test.ts`
**该红的断言**：「关插值：imageSmoothingEnabled = false，且在第一次填充之前就已关闭」（桩的初值是 `true`，所以「没关」这一条抓得到；`calls.fills.every(fill => fill.smoothing === false)` 抓的是**顺序**——只在末尾读 `target` 抓不到这种写法）。
（起草时在临时树实测：**红 2**——上面这条 +「全空格图纸 ⇒ 一个块都不画（结果是一张全透明 PNG）」（它末尾也读了一次 `target.imageSmoothingEnabled`）。）

- [ ] **步骤 17：变异实测 M12「板边界线宽与细线相同」**

动作：`sheet.ts` 的网格线循环里，`target.lineWidth = tile.lineWidths[group];` 改成 `target.lineWidth = tile.lineWidths.thin;`。
聚焦用例：`npx vitest run src/core/render/__tests__/sheet.test.ts`
**该红的断言**：「三档网格线由细到粗、每档一次 beginPath / stroke，板边界最后画」（`calls.paths.map(p => p.lineWidth)` 不再等于 `[1, 1, 2, 3]`，且三档分组找不到 `major` / `board` 两组）。
（起草时在临时树实测：**红 2**——上面这条 +「某一档一条线都没有时不发空 stroke（4×4 只有板边界与细线）」（它断言 `[1, 3]`）。）

- [ ] **步骤 18：变异实测 M15「三组网格线的顺序反过来」**

动作：`sheet.ts` 里 `const GRID_GROUPS = ["thin", "major", "board"] as const;` 改成 `["board", "major", "thin"] as const`。
聚焦用例：`npx vitest run src/core/render/__tests__/sheet.test.ts`
**该红的断言**：「三档网格线由细到粗、每档一次 beginPath / stroke，板边界最后画」——具体是「`calls.paths.map(p => p.lineWidth)` 等于 `[1, 1, 2, 3]`」与「`boardIndex` 是最后一条」这两句。
（起草时在临时树实测：**红 2**——上面这条 +「某一档一条线都没有时不发空 stroke（4×4 只有板边界与细线）」（倒序后 4×4 的 `[1, 3]` 变成 `[3, 1]`）。）

- [ ] **步骤 19：变异实测 M17（本次裁定新增）「用量表色块改回只描边」**

动作：删掉 `sheet.ts` 里 `target.fillRect(cellX, swatchY, LEGEND_SWATCH_SIZE, LEGEND_SWATCH_SIZE);` 那一行（色块只剩外框、不再填真色）。
聚焦用例：`npx vitest run src/core/render/__tests__/sheet.test.ts`
**该红的断言**：「标题行 + 表头 + 每项一行 + **色块是真色** + 合计 = 各项之和 + 精度声明 + 生成时间」（`calls.fills` 从 1+2 变成 1）。
（起草时在临时树实测：**红 2**——上面这条 +「多列布局：第 14 项换到第 2 行第 1 列」（它也断言了 `calls.fills` 的总数）。
这条变异是 2026-10-05 裁定带来的**真实收益**：补 `palette` 入参之前，「色块真是那个颜色」这件事根本无法断言（规格 §13.1 的 `drawLegend` 行已据此加强）。）

- [ ] **步骤 20：变异实测 M18（本次裁定新增）「分享图改回反推格像素」**

动作：把 `share.ts` 里这三行
```ts
      const box = shareCellBox(plan, col, row);
      target.fillStyle = rgbCss(color.rgb);
      target.fillRect(box.x, box.y, box.width, box.height);
```
换成
```ts
      const unit = plan.canvasWidth / pattern.width;
      target.fillStyle = rgbCss(color.rgb);
      target.fillRect(col * unit, row * unit, unit, unit);
```
聚焦用例（**换文件**：这条变异的判别点在源码闸门，不在取值断言）：
`npx vitest run src/core/render/__tests__/layoutGate.test.ts`
**该红的断言：闸门第 3 条**——「渲染器里不得出现 canvasWidth / canvasHeight 参与的除法」，**红 1**。
同时把 `npx vitest run src/core/render/__tests__/share.test.ts` 也跑一遍并记录（**预期 0 红**）：**两个数字一起回填**，它们共同证明「结构约束在守、取值断言守不住」。

**必须写进报告的结论**（本片段起草时实测；控制者据此把闸门第 3 条定为规格 §4.4 的正式条款）：

> M18 实测在**取值断言上 0 红**（`canvasWidth / pattern.width` 与 `shareCellBox` 数值逐位相同：`planShare` 保证 `canvasWidth === cols × 格像素`，两边的结果一个像素都不差），唯一能判别的是**结构（源码）约束**——所以闸门第 3 条是这个修复的**唯一防线**，删掉它 M18 就重新变成哑弹，而没有任何断言会替它报警。
> 一般化（规格 §4.4 第 3 条）：**当两条实现在数学上等价时，唯一能判别的只有结构约束。**

- [ ] **步骤 21：变异实测 M19 / M20（本次裁定新增的两条守卫）**

这一条一次覆盖两个变异——它们各自要证明「本次新加的守卫不是摆设」。动作都是**整块删掉**守卫：

**M19：删掉 `share.ts` 里的 plan ↔ 图纸同源守卫。** 动作：删掉
```ts
  if (plan.cols !== pattern.width || plan.rows !== pattern.height) {
    throw new Error(
      `分享图计划与图纸不符：计划 ${plan.cols}×${plan.rows}、图纸 ${pattern.width}×${pattern.height}`,
    );
  }
```
聚焦用例：`npx vitest run src/core/render/__tests__/share.test.ts`
**该红的断言**：「plan 与图纸不符即抛（否则会静默画出缺角 / 多空的图）」。
（起草时在临时树实测：**红 1**，就是这一条。）

**M20：删掉 `sheet.ts` 里的 plan 自洽性检查。** 动作：删掉
```ts
  if (plan.itemCols * plan.itemWidth + 2 * SHEET_MARGIN !== plan.canvasWidth) {
    throw new Error(
      `用量表计划不自洽：${plan.itemCols} 列 × ${plan.itemWidth} px + 边距 ≠ 画布宽 ${plan.canvasWidth} px`,
    );
  }
```
聚焦用例：`npx vitest run src/core/render/__tests__/sheet.test.ts`
**该红的断言**：「plan 不自洽（列数与画布宽配错）即抛，且不留下半张表」。
（起草时在临时树实测：**红 1**，就是这一条。）

两条都还原后再跑一次聚焦用例确认全绿，然后把两个数字回填到报告。

- [ ] **步骤 22：全量验证**

```bash
npm run test
$env:TZ="UTC"; npm run test
npm run build
```

预期：三条全绿；`npm run test` 的用例数 = 基线 987 + 本任务新增（把**实际数字**与原始输出尾巴贴进报告，不许引用汇总行、不许预估）；`npm run build` 通过（`vue-tsc` 会检查新文件：`noUnusedLocals` / 严格模式 / 禁止 `any`）。`TZ=UTC` 那一趟必须重跑：本任务的字面量里没有本地时区依赖（`generatedAt` 由用例传入），这一趟是证明它。

> **G-9 已由控制者修掉**（2026-10-05）：任务 1 片段的 `layoutGate.test.ts` 第一行补上了 `/// <reference types="vite/client" />`，理由也写进了那个片段（本仓没有 `*.d.ts` 入口，缺它 `npm run build` 报 `TS2339: Property 'glob' does not exist on type 'ImportMeta'`）。⇒ **正常情况你不需要做任何事**。若这条报错在你手上仍然出现，说明你手上的任务 1 片段是旧版：**照抄原始报错并上报控制者，不要自己改任务 1 的文件、也不要把 `npm run build` 说成通过**。

- [ ] **步骤 23：Commit**

先看一眼有没有任务 1 留下的未跟踪文件（任务 1 允许把「当时还是红的」闸门用例推迟到本任务一起提交）：

```bash
git status --short
```

若 `src/core/render/__tests__/layoutGate.test.ts` 仍是未跟踪状态，一并带上；否则只加本任务的 5 个文件：

```bash
git add src/core/render/sheet.ts src/core/render/share.ts src/core/render/__tests__/helpers.ts src/core/render/__tests__/sheet.test.ts src/core/render/__tests__/share.test.ts
git commit -m "feat(render): 施工图分片与分享图绘制"
```

---

**起草时的实测（供参考，**不免除**实现者自己跑一遍）**

本片段起草时（**含 2026-10-05 裁定后的第二遍**），把任务 1 计划里的四个代码块与本片段的六个代码块一起**按原文抽出来**放进一个临时目录（`%TEMP%\b4v`，`node_modules` 指向本仓、用本仓的 `tsc` 与 `vitest`，仓库里一个字节都没动；另需照抄本仓的 `core/pattern/{types,edit,stats,board}.ts`、`core/palette/{types,registry}.ts`、`core/color/space.ts`），跑出：

```
npx tsc --noEmit（strict + noUnusedLocals + noUnusedParameters）   exit 0
npx vitest run --root %TEMP%\b4v
  ✓ layoutGate.test.ts (7)   ✓ layout.test.ts (30)   ✓ share.test.ts (9)   ✓ sheet.test.ts (21)
  Test Files 4 passed (4)    Tests 67 passed (67)
```

三点结论：① 本片段的六个代码块**按原文粘贴即可编译、即可全绿**（含闸门转绿那条：任务 1 单独跑时它是红的 1 条）；② 起草时就在这份临时树上实跑了 M4 / M9 / M10 / M11 / M12 / M15 / **M17 / M18 / M19 / M20**（实测红数 1 / 1 / 2 / 3 / 2 / 2 / 2 / **闸门 1 + 取值 0** / 1 / 1，失败点标题已逐条写进对应步骤）；③ **实现者仍必须在自己还原后的树上重跑一遍并回填自己的数字**——本片段的数字只用来对照：对不上就是发现了新东西，如实写进报告。

---

**报告必须包含**（这是控制者复核的输入，缺一条就返工）：

1. **原始输出尾巴**：`npx vitest run src/core/render/__tests__/sheet.test.ts`、`.../share.test.ts`、`.../layoutGate.test.ts`、`npm run test`、`$env:TZ="UTC"; npm run test`、`npm run build` 六条的结尾若干行（文件数 / 用例数 / 构建结果），以及本任务新增用例数（回原始清单重数，不引用汇总行）。
2. **闸门状态**：任务 1 遗留的红是哪一条、转绿后 `layoutGate.test.ts` 的实测结果；若你改动过闸门文件，逐字说明改了什么（正常情况下应当是「一个字节都没动」）。
3. **变异实测的红数与失败点标题**：M4 / M9 / M10 / M11 / M12 / M15 / **M17 / M18 / M19 / M20** 各一行「动作 → 实测红数 → 失败点用例标题」，以及每次 `git checkout --` 还原后回到全绿的那一次输出尾巴。**不许预估**；`M18` 要给出**两个数字**（闸门红 N / 取值断言 0 红）并附上那句结论：它的唯一防线是**结构约束**，删掉闸门第 3 条它就重新变成哑弹。
4. **与契约 / 规格不符之处**：你对文末「缺口 / 裁定落地记录」里每一条的处置；以及任何**新发现**的缺口——不许自行发明名字。
5. **未断言 / 只被间接覆盖的清单**（本项目的固定自问）：本片段里——
   - **`shareCellBox` 的回归只能由源码闸门第 3 条守住**（M18 取值断言 0 红）：两条实现在数学上等价时，取值断言判不开——如实记账，不许说成「已由断言覆盖」；
   - **`drawLegend` 的计划自洽性检查有残余**：伪造者若把 `canvasWidth` 一起换成自洽的假值（与 `itemCols` 匹配），仍然不可判别（契约 §12 已如实记录这条残余）；
   - 「`usages` 与 `plan` 同源」守卫只比**行数**：13 列 1 行与 15 列 1 行在 ≤15 项时行数相同 ⇒ 单靠它配错不报错（自洽性检查挡的是「列数与画布宽配错」那种伪造，不是「两个都自洽的计划互换」）；
   - 用量表各行的**字号**只被契约 §4b 的常量表钉住，用例没逐条断言（只断言了信息条的 `font` 与色号 / 刻度的字号）；
   - 网格线颜色、文字墨色只能断言「字符串等于常量」，「好不好看」测不到；
   - 用量表除第 1、2 项外的色块只断言了**条数**，没有逐项断言颜色；
   - 真实像素、真实 canvas 上限、`getImageData` 自检、长按存相册全部在规格 §13.4 / §14（本环境测不到，不许用桩做成恒真断言）。
6. **§13.2 的分工如实写明**：本任务承担 §13.2-2（plan → 渲染器）与 §13.2-3（渲染器 → 产物尺寸）的**渲染器侧**；§13.2-1（内存态 → 渲染器）与它的变异 M14 属任务 4 的 `EditorPage` 端到端用例，本任务不重复实现、也不许把它写成恒真断言。

### 缺口 / 裁定落地记录

第一版片段开工前，我列了 9 条契约 / 规格空白（G-1～G-9）并各留了一个「裁决一到只改一处」的临时处置。**控制者已于 2026-10-05 逐条裁定，本片段已按裁定改完**，下表是「裁定 → 本片段落地成什么」的对照（实现者按它核对，不要照第一版的旧写法）：

| 缺口 | 裁定 | 本片段的落地 |
|---|---|---|
| G-1 用量表画不出真色 | 采纳候选① | `drawLegend(target, palette, usages, plan, meta)`；色块 = `fillRect` + `rgbCss(rgb)` + 细框；色号 → rgb 只走 `createPaletteRuntime(palette).indexByCode`，找不到即抛 `用量表里的色号不在色卡里：${code}`；**新增**「色块真是那个颜色」断言 + 变异 M17 |
| G-2 分享图格像素没有合法来源 | 采纳候选①（责任在控制者） | `drawShare` 一律 `shareCellBox(plan, col, row)`；循环范围取 `plan.cols` / `plan.rows`；删掉 `canvasWidth / pattern.width` 反推；**新增**四角 / 越界列 / 越界行 / 非安全整数 用例 + 变异 M18（如实记录「0 红」） |
| G-3 图上文案无权威来源 | 批准我这一组 | 契约 §4b 逐字化；本片段的 `infoLineOne` / `infoLineTwo` / `footerLine` / 刻度 / 板号 / 用量表各行**逐字核对一致，无改动**；「成品取长边」及其理由写进了 §4b |
| G-4 字号 | 批准补 `sans-serif`（升级为强制）+ 批准五个字号常量 | 所有 `font` 一律 `${sizePx}px sans-serif`；五个常量集中定义在 `sheet.ts` 顶部并带 JSDoc（写明「不随格子缩放、不参与布局预算」）；信息条 `font` 进断言 |
| G-5 带内文字的另一轴 | 采纳，要求 JSDoc 写明定性 | `RULER_TEXT_GAP` / `BOARD_TEXT_INSET` / `LEGEND_*_X` 一组常量上方加了「带内落位偏移，不是格子↔像素映射；格子坐标一律来自 plan」的说明 |
| G-6 颜色口径 | 批准我这一组 | `GRID_STROKE` / `EMPTY_STROKE` / `TEXT_INK` / `SWATCH_FRAME_STROKE` 照批；用例按它们断言（新增信息条 `fillStyle` 一条） |
| G-7 空表口径 + 缺同源守卫 | 空表以 §13.1 为准；补守卫 | 表头改判据为 `plan.itemRows >= 1`；空表 4 条文字的断言保留；**新增**守卫（消息逐字用裁定的那条）+ 一条「第二项才是坏色号、`fills` 为空」的用例 |
| G-8 空格斜线方向 | 采纳左上 → 右下 | 用例逐条钉住三个空格的 `ops`（无改动） |
| G-9 `layoutGate.test.ts` 过不了 `vue-tsc` | 控制者已修（任务 1 片段补 `/// <reference types="vite/client" />`） | 本片段删掉了「替任务 1 上报」的处置说明，改为「正常情况无需动作；若仍报错说明你手上是旧版，照抄上报、不许自己改任务 1 的文件」 |
| G-10 分享图 plan 与图纸可能不同源 | **加守卫** | `drawShare` 在色卡守卫之后加 `plan.cols !== pattern.width \|\| plan.rows !== pattern.height` ⇒ 抛 `分享图计划与图纸不符：计划 ${plan.cols}×${plan.rows}、图纸 ${pattern.width}×${pattern.height}`（写在任何写操作之前）；**新增**两条用例（列不符 / 行不符，且 `calls.fills` 为空） |
| G-11 同源守卫只比行数 | **改造为 plan 内部自洽性检查**（不比对期望值） | `drawLegend` 在 kind 守卫之后加 `plan.itemCols × plan.itemWidth + 2 × SHEET_MARGIN !== plan.canvasWidth` ⇒ 抛 `用量表计划不自洽：${itemCols} 列 × ${itemWidth} px + 边距 ≠ 画布宽 ${canvasWidth} px`；**新增**一条用例（伪造 `itemCols: 12` 的计划）；残余（连 `canvasWidth` 一起伪造）写进「未断言清单」 |
| G-12 G-2 的修复没有断言能守住 | **采纳**：任务 1 的闸门加第 3 条（禁 `canvasWidth /` / `canvasHeight /`，正向要求 `share.ts` 出现 `shareCellBox(`）；规格 §4.4 第 3 条写成正式条款 | M18 的「该红的断言」从「0 红、无覆盖」改成「**闸门第 3 条，红 1**」；结论改写成「取值断言 0 红 + 结构约束是唯一防线」；表与报告清单同步 |

**裁定后仍然存在的缺口 / 残余限界（如实列出，不自行拍板）**：

1. **已无开放缺口**：G-1～G-12 全部闭环（G-10 / G-11 / G-12 见上表，其余见第一版裁定）。以下三条是本轮**已知且已如实记录**的限界，不是待裁决项——除非控制者认为其中某条值得再加固。
2. **`drawLegend` 自洽性检查的残余**：伪造者若把 `canvasWidth` 一起换成与 `itemCols` 匹配的假值，仍然不可判别（契约 §12 末句已如实记录）。
3. **`usages` 与 `plan` 同源守卫只比行数**：两个**各自自洽**的计划互换（13 列 1 行 vs 15 列 1 行、≤15 项）仍然不报错——自洽性检查挡不住这个，因为它查的是「计划自己」而不是「计划与这张表」。契约明确只要求这两条守卫，我没有再加第三条（加了就得发明消息）。

---

## 任务 3：落盘（严格建画布 / toBlob / 下载 / 文件名）

**文件：**
- 创建：`src/services/exporter.ts`
- 测试：`src/services/__tests__/exporter.test.ts`

**这个任务为什么单独成任务**：`core/render/types.ts` 的 `RenderTarget2D` 把「画什么」留在了 core，
把「画到哪儿、怎么落盘」全部推到这一层。它是 B4 里**唯一**碰 Canvas 与下载 API 的 service 文件
（规格 §3），也是「静默产出白图」这一整类失败形态的最后一道闸门：画布尺寸回读（§9 第 4 条）、
生成后像素自检（§9 第 5 条）、blob 非空与文件名非空（§8）。这些守卫一旦漏掉，UI 上看起来是
「成功保存了一张白图」，没有任何别的断言能发现。

**本片段覆盖的规格落点**：§8（五个签名与它们的行为）、§9 第 4 条（画布尺寸回读）、§9 第 5 条
（左上角边距的像素自检）、§13.1 的 `services/exporter` 行、§13.3 的 **M8** 与 **M13**、§13.4
（`getImageData` / `toBlob` / `createObjectURL` 在 happy-dom 里没有真实语义）。
**§9 第 6 条（逐张渲染后即时释放）归任务 4 的面板**（控制者裁定 2026-10-05）：每次 `canvasToBlob`
resolve 之后由 `ExportPanel` 对该张画布写 `canvas.width = 0; canvas.height = 0;`。本片段**不**新增
`releaseCanvas` 之类的导出——只有一个调用点，抽一个没人复用的函数正是本项目禁止的抽象
（`AGENTS.md`「公开 API ≠ 被使用的 API」）。

**开工前必须知道的环境事实（happy-dom 20.14.5，本机实测：`node_modules/happy-dom` 源码 + 一个
独立 node 探针脚本，不是推断）。下面五条直接决定替身必须怎么造——照着「真行为」写用例会得到一批
恒真的假绿用例**：

| 平台 API | 实测行为 | 用例的做法（不许依赖另一种行为） |
|---|---|---|
| `HTMLCanvasElement.prototype.getContext("2d")` | **返回 `null`**（本仓没有 `@happy-dom/canvas`，`settings.canvasAdapter` 为 `undefined`） | 「拿到上下文」用 `vi.spyOn(HTMLCanvasElement.prototype, "getContext")` 装最小替身；「拿不到」直接用默认真实行为（真元素 + 不装桩） |
| `canvas.width` / `canvas.height` | **纯属性，永不钳制**（`set width` 就是 `setAttribute`，写 8192 读回 8192） | 「回读不一致」只能靠自造的 `makeCanvasStub()`（getter/setter 里做 `Math.min` 模拟钳制）——**这是本任务唯一能打中 M8 的办法** |
| `canvas.toBlob` | **存在**；无 adapter 时走 `requestAnimationFrame(() => callback(new Blob([])))` ⇒ 给的是**大小 0 的 Blob，永远不是 `null`** | 用 `makeToBlobCanvas()`：记录请求的 MIME，回调由用例自己喂 `blob` / `null` |
| `URL.createObjectURL` / `revokeObjectURL` | **存在**（返回 `blob:nodedata:<uuid>`），但返回值不可预测，且真实实现要求 blob 已在 registered store 里 | 一律 `vi.stubGlobal("URL", { createObjectURL, revokeObjectURL })`（契约 §5 第 2 条明确要求）⇒ `createObjectURL` 收到的**实参**可逐位断言 |
| `document.createElement("a")` | 真元素；实例上换 `click` 可行（`HTMLElement.prototype.click` 可写可配置） | `vi.spyOn(document, "createElement")` 拦 `"a"`（其余标签透传），元素一创建就把 `click` 换成 `vi.fn()`：happy-dom 点 `href="blob:…"` 会走它自己的导航逻辑，不是本文件要测的东西 |

**真实像素在本环境测不到**（§13.4）：`getImageData` 的返回值没有语义。所以下面用例里关于自检的断言
只证明**接线**（采样坐标、RGBA 比较、抛出的逐字消息），真实判别力在规格 §14 的人工清单里——
这一点必须同时写进实现文件的 JSDoc 与报告，不许把它说成「像素已被覆盖」。

- [ ] **步骤 1：写用例 `src/services/__tests__/exporter.test.ts`（第一批：主路径）**

一次性粘贴下面整段。六个函数各覆盖主路径；判别性更强的边界（钳制、清洗、无副作用、采样点守卫）
在步骤 5 追加，那批的判别力由步骤 7 / 8 的变异实测证明。

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCanvasPainted,
  canvasToBlob,
  createCanvasStrict,
  downloadBlob,
  exportFilename,
  requireContext2D,
} from "../exporter";

/**
 * 这个文件测的是**平台边界**，不是像素。happy-dom 20.14.5 的四条环境事实（本机实测，
 * 见计划片段 task-03 的环境事实表）：
 *
 * 1. `HTMLCanvasElement.prototype.getContext("2d")` **返回 `null`**：本仓没有装 `@happy-dom/canvas`，
 *    `settings.canvasAdapter` 是 `undefined`。所以真画布上「拿不到上下文」是**默认状态**，
 *    「拿到上下文」只能靠桩。这也意味着任何依赖真实 `getImageData` / `toDataURL` 的断言都是假绿。
 * 2. 真画布的 `width` / `height` **永不钳制**（写 8192 读回 8192）⇒ `createCanvasStrict` 的
 *    「回读不一致」这条守卫在真元素上**永远走不到**，必须自造一个会钳制的画布替身（`makeCanvasStub`）。
 *    这是本文件唯一能测到规格 §8 那条守卫的办法。
 * 3. `toBlob` **存在**，但没有 adapter 时它走 `requestAnimationFrame(() => callback(new Blob([])))`
 *    ——给的是**大小 0 的 Blob，永远不是 `null`**。拿真画布跑 `canvasToBlob` 只会 resolve 一个空 blob
 *    （随后被 `downloadBlob` 以「导出内容为空」拒绝），`null` 分支根本走不到 ⇒ 用 `makeToBlobCanvas`。
 * 4. `URL.createObjectURL` / `revokeObjectURL` **存在**（返回 `blob:nodedata:<uuid>`），但返回值不可预测、
 *    断言不了「传进去的是哪个 blob」⇒ 一律 `vi.stubGlobal("URL", …)` 换掉，使实参可逐位断言。
 *
 * 真实像素的观感（色号可读、接缝不错行、信息条真的被画过）在规格 §14 的人工清单里，本文件
 * **不**把它写成断言（那会是恒真断言，规格 §13.4）。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface CreateElementStub {
  /** 每次 `document.createElement("canvas")` 交出的元素（长度即创建次数）。 */
  readonly canvases: HTMLCanvasElement[];
  /** 每次 `document.createElement("a")` 交出的元素（长度即创建次数）。 */
  readonly anchors: HTMLAnchorElement[];
}

/**
 * 换掉 `document.createElement`，只拦 `"canvas"` 与 `"a"`，其余标签原样透传
 * （`@vue/test-utils` / happy-dom 自己都要用真 `createElement`，账本 B2 记过这条）。
 *
 * `onCreateAnchor` 让用例在**元素一被创建**时就替换它的 `click`：happy-dom 里点一个
 * `href="blob:…"` 的锚点会走它自己的导航逻辑（`window.open`），那不是本文件要测的东西；
 * 在实例上换掉 `click` 之后，「实现调用过 `link.click()`」仍然被钉死。
 */
function stubCreateElement(
  makeCanvas: () => HTMLCanvasElement,
  onCreateAnchor?: (anchor: HTMLAnchorElement) => void,
): CreateElementStub {
  const canvases: HTMLCanvasElement[] = [];
  const anchors: HTMLAnchorElement[] = [];
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) => {
    if (tag === "canvas") {
      const canvas = makeCanvas();
      canvases.push(canvas);
      return canvas;
    }
    if (tag === "a") {
      const anchor = original("a", options) as HTMLAnchorElement;
      onCreateAnchor?.(anchor);
      anchors.push(anchor);
      return anchor;
    }
    return original(tag, options);
  }) as typeof document.createElement);
  return { canvases, anchors };
}

interface CanvasStubOptions {
  /** 写入 `width` 之后浏览器**实际留下**的值（模拟超限钳制）。缺省 = 原样留下。 */
  readonly clampWidthTo?: number;
  readonly clampHeightTo?: number;
  /** `getContext("2d")` 的返回值；缺省 `null`（happy-dom 无 canvas adapter 时的真实行为）。 */
  readonly context?: CanvasRenderingContext2D | null;
}

interface CanvasStub {
  readonly canvas: HTMLCanvasElement;
  /** 每次写 `width` 的实参（证明尺寸确实被写下去过）。 */
  readonly widthWrites: number[];
  readonly heightWrites: number[];
  /** 每次 `getContext` 的实参（证明问的是 `"2d"`）。 */
  readonly contextCalls: string[];
}

/**
 * **会钳制的画布替身**：这是本文件唯一能打中 `createCanvasStrict` 回读校验的办法，因为 happy-dom 的
 * 真 `HTMLCanvasElement` 写什么读什么（环境事实第 2 条），那条守卫在真元素上永远走不到。
 */
function makeCanvasStub(options: CanvasStubOptions = {}): CanvasStub {
  const widthWrites: number[] = [];
  const heightWrites: number[] = [];
  const contextCalls: string[] = [];
  const state = { width: 0, height: 0 };
  const stub = {
    get width(): number {
      return state.width;
    },
    set width(value: number) {
      widthWrites.push(value);
      state.width = options.clampWidthTo === undefined ? value : Math.min(value, options.clampWidthTo);
    },
    get height(): number {
      return state.height;
    },
    set height(value: number) {
      heightWrites.push(value);
      state.height =
        options.clampHeightTo === undefined ? value : Math.min(value, options.clampHeightTo);
    },
    getContext(kind: string): CanvasRenderingContext2D | null {
      contextCalls.push(kind);
      return kind === "2d" ? (options.context ?? null) : null;
    },
  };
  return { canvas: stub as unknown as HTMLCanvasElement, widthWrites, heightWrites, contextCalls };
}

interface ToBlobStub {
  readonly canvas: HTMLCanvasElement;
  /** 每次 `toBlob` 请求的 MIME（长度即调用次数）。 */
  readonly requestedTypes: (string | undefined)[];
  /** 由用例自己把回调结果喂回去 ⇒ 分别造「给 blob」与「给 null」两种情形。 */
  fire(blob: Blob | null): void;
}

/**
 * 只实现 `toBlob` 的画布替身。**不能用真画布**：happy-dom 的 `toBlob` 没有 adapter 时给的是
 * 大小 0 的 Blob（环境事实第 3 条），`null` 分支根本走不到。
 */
function makeToBlobCanvas(): ToBlobStub {
  let callback: BlobCallback | null = null;
  const requestedTypes: (string | undefined)[] = [];
  const canvas = {
    toBlob(cb: BlobCallback, type?: string): void {
      requestedTypes.push(type);
      callback = cb;
    },
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    requestedTypes,
    fire(blob: Blob | null): void {
      const take = callback;
      if (take === null) {
        throw new Error("toBlob 还没被调用：用例要先调 canvasToBlob(canvas)");
      }
      take(blob);
    },
  };
}

const OBJECT_URL = "blob:weefuse-fake-url";

/** 换掉全局 `URL`（契约 §5 第 2 条：不要依赖它存在，也不要依赖它的返回值）。 */
function stubUrlApi() {
  const createObjectURL = vi.fn((_blob: Blob) => OBJECT_URL);
  const revokeObjectURL = vi.fn((_url: string) => undefined);
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

/** 2D 上下文替身：只实现自检真正调用的那一个方法，并记录被读的像素坐标。 */
function stubPainted(pixel: readonly [number, number, number, number]): {
  readonly canvas: HTMLCanvasElement;
  readonly sampleCalls: number[][];
} {
  const sampleCalls: number[][] = [];
  const ctx = {
    getImageData: (x: number, y: number, width: number, height: number) => {
      sampleCalls.push([x, y, width, height]);
      return { width, height, data: new Uint8ClampedArray(pixel) } as unknown as ImageData;
    },
  } as unknown as CanvasRenderingContext2D;
  // happy-dom 默认 `getContext("2d") === null`（环境事实第 1 条），所以这里必须装替身。
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    ...args: unknown[]
  ) {
    return args[0] === "2d" ? ctx : null;
  });
  return { canvas: document.createElement("canvas"), sampleCalls };
}

describe("createCanvasStrict", () => {
  it("正常尺寸：建的就是 canvas、宽高被写下去、原样返回该元素", () => {
    const stub = makeCanvasStub();
    const created = stubCreateElement(() => stub.canvas);

    const canvas = createCanvasStrict(2432, 2564);

    expect(canvas).toBe(stub.canvas);
    expect(stub.widthWrites).toEqual([2432]);
    expect(stub.heightWrites).toEqual([2564]);
    expect(canvas.width).toBe(2432);
    expect(canvas.height).toBe(2564);
    expect(created.canvases).toHaveLength(1);
  });

  it("宽高非法 ⇒ 抛，且在任何建画布 / 写宽高之前（入口校验先于写操作）", () => {
    const stub = makeCanvasStub();
    const created = stubCreateElement(() => stub.canvas);

    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createCanvasStrict(bad, 16)).toThrow("画布宽高必须是 ≥1 的整数");
      expect(() => createCanvasStrict(16, bad)).toThrow("画布宽高必须是 ≥1 的整数");
    }

    // 拷问「守卫是不是真的写在了写操作之前」：把守卫挪到 createElement 之后，这两条会红。
    expect(created.canvases).toEqual([]);
    expect(stub.widthWrites).toEqual([]);
    expect(stub.heightWrites).toEqual([]);
  });
});

describe("requireContext2D", () => {
  it('拿到上下文就原样返回，问的是 "2d"', () => {
    const ctx = { fillStyle: "" } as unknown as CanvasRenderingContext2D;
    const stub = makeCanvasStub({ context: ctx });

    expect(requireContext2D(stub.canvas)).toBe(ctx);
    expect(stub.contextCalls).toEqual(["2d"]);
  });

  it("getContext 返回 null ⇒ 抛（happy-dom 无 canvas adapter 时的真实情形）", () => {
    const stub = makeCanvasStub();
    expect(() => requireContext2D(stub.canvas)).toThrow("无法获取 2D 上下文");
  });
});

describe("canvasToBlob", () => {
  it("Promise 化 toBlob：请求 image/png，回调给的 blob 原样 resolve", async () => {
    const stub = makeToBlobCanvas();
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

    const promise = canvasToBlob(stub.canvas);
    expect(stub.requestedTypes).toEqual(["image/png"]);
    stub.fire(png);

    await expect(promise).resolves.toBe(png);
  });

  it("回调给 null ⇒ reject（不静默 resolve 一个空结果）", async () => {
    const stub = makeToBlobCanvas();

    const promise = canvasToBlob(stub.canvas);
    stub.fire(null);

    await expect(promise).rejects.toThrow("导出 PNG 失败：toBlob 返回了 null");
  });
});

describe("downloadBlob", () => {
  it("恰好建一个 <a>、点一次、建与回收各一次 object URL；属性与顺序都对", () => {
    const url = stubUrlApi();
    const clickSpies: ReturnType<typeof vi.fn>[] = [];
    const created = stubCreateElement(
      () => {
        throw new Error("downloadBlob 不该创建画布");
      },
      (anchor) => {
        const click = vi.fn();
        clickSpies.push(click);
        anchor.click = click;
      },
    );
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

    downloadBlob(png, "图纸-施工图-r1c1.png");

    expect(created.anchors).toHaveLength(1);
    expect(created.canvases).toEqual([]);
    const anchor = created.anchors[0]!;
    expect(anchor.getAttribute("href")).toBe(OBJECT_URL);
    expect(anchor.getAttribute("download")).toBe("图纸-施工图-r1c1.png");
    // 实现的 JSDoc 声明「不挂进 DOM」：挂进去就必须配一次 remove()，那道清理在 click 抛错时会漏。
    expect(anchor.parentNode).toBeNull();
    expect(clickSpies).toHaveLength(1);
    expect(clickSpies[0]).toHaveBeenCalledTimes(1);
    expect(url.createObjectURL.mock.calls).toEqual([[png]]);
    expect(url.revokeObjectURL.mock.calls).toEqual([[OBJECT_URL]]);
    // 顺序：先 click 后 revoke。反过来的话部分浏览器会在数据被读走之前把它释放掉。
    expect(clickSpies[0]!.mock.invocationCallOrder[0]!).toBeLessThan(
      url.revokeObjectURL.mock.invocationCallOrder[0]!,
    );
  });

  it("blob 大小为 0 ⇒ 抛（不产出一个 0 字节的 png）", () => {
    stubUrlApi();
    stubCreateElement(() => makeCanvasStub().canvas);

    expect(() => downloadBlob(new Blob([]), "图纸-分享图.png")).toThrow(
      "导出内容为空（blob 大小为 0）",
    );
  });
});

describe("exportFilename", () => {
  it("施工图带 r{行}c{列}（1 起），用量表 / 分享图不带序号", () => {
    expect(exportFilename("小猫", "施工图", { rowIndex: 0, colIndex: 0 })).toBe("小猫-施工图-r1c1.png");
    expect(exportFilename("小猫", "施工图", { rowIndex: 2, colIndex: 4 })).toBe("小猫-施工图-r3c5.png");
    expect(exportFilename("小猫", "用量表")).toBe("小猫-用量表.png");
    expect(exportFilename("小猫", "分享图")).toBe("小猫-分享图.png");
  });
});

describe("assertCanvasPainted（§9 第 5 条）", () => {
  it("读回白色即通过，且采样点就是 (2, 2, 1, 1)", () => {
    const { canvas, sampleCalls } = stubPainted([255, 255, 255, 255]);

    expect(() => assertCanvasPainted(canvas)).not.toThrow();
    // 采样点必须是 (2, 2)：它在左上角边距里，始终被白底覆盖且不放任何文字，对合法图纸不可能误报。
    // 挪到「最后一格」会落到空格上、对合法图纸误报；挪到任何别处都会被这条断言抓住
    // （判别力来自坐标被钉住，不是来自 happy-dom 的像素——它没有真实像素语义）。
    expect(sampleCalls).toEqual([[2, 2, 1, 1]]);
  });

  it("读回全 0 ⇒ 抛契约 §3 的那条消息（带读回值）", () => {
    const { canvas } = stubPainted([0, 0, 0, 0]);

    expect(() => assertCanvasPainted(canvas)).toThrow(
      "画布内容自检失败：(2, 2) 读回 0,0,0,0（期望 255,255,255,255）",
    );
  });
});
```

- [ ] **步骤 2：运行测试，确认失败**

```bash
npx vitest run src/services/__tests__/exporter.test.ts
```

预期：**FAIL** —— `Failed to resolve import "../exporter" from "src/services/__tests__/exporter.test.ts". Does the file exist?`
（模块还不存在；1 个文件失败、0 条用例执行）。这是 TDD 的第一步，不是环境问题。

- [ ] **步骤 3：写实现 `src/services/exporter.ts`**

```ts
import { normalizeProjectName } from "./projectStore";

/**
 * B4 导出的**唯一接触平台落盘 API 的文件**（规格 §3）：建画布、取 2D 上下文、`toBlob`、下载、文件名。
 *
 * 为什么这一层必须存在：`core/render/**` 是零依赖纯计算层，不得引用 DOM 全局
 * （`src/__tests__/coreBoundary.test.ts` 的 `FORBIDDEN_GLOBALS`，`CanvasRenderingContext2D` 在其中）。
 * core 的渲染器吃的是自己声明的 `RenderTarget2D`（`core/render/types.ts`），真 ctx 由本文件注入——
 * 于是布局与绘制能在 Node 里被断言，平台能力只堆在这几个函数里。
 *
 * **本文件承担的两条「不静默」防线**（规格 §9 第 4/5 条、§16 的 B4-R2）：画布尺寸回读不一致即抛
 * （浏览器对超限画布会静默钳制或置 0）；渲染完成后在固定位置读回 1×1 像素自检
 * （`assertCanvasPainted`）——「分配成功但内容全空」是本平台真实存在的失败形态，它在 UI 上表现为
 * 一张白图，用户会以为图纸本来就这样。
 *
 * **如实记录**：真实像素的判别力在本环境（happy-dom）不存在——`getContext("2d")` 返回 `null`、
 * `getImageData` 没有语义。`assertCanvasPainted` 在 CI 里只被证明「接线正确」（采样坐标、比较、消息），
 * 真实判别力在规格 §14 的人工清单。
 */

/** 导出的内容标签；就是文件名中段那三个词（规格 §8 / 契约 §2）。 */
export type ExportItemLabel = "施工图" | "用量表" | "分享图";

/**
 * 自检采样点的 x / y。
 *
 * **取值理由**（控制者裁定 2026-10-05）：施工图渲染的第一步是整张画布填 `#ffffff`，而 (2, 2) 落在
 * `SHEET_MARGIN`(=24) 的**左上角边距**里——始终被白底覆盖、**不放任何文字**，比信息条里的点更稳
 * （信息条里有字，可能正好压在探针点上），且与图纸内容、格像素、用色数**全都无关**，所以它对一张
 * 合法图纸不可能误报；反过来「分配成功但内容全空」会让它读回 0，正是要抓的形态。选「最后一格」会
 * 选到空格上，那条自检就会对合法图纸误报（规格 §9 第 5 条点名了这条）。
 *
 * **分享图不调用自检**：它按设计是透明的，没有「必定不透明」的点（同一裁定）。
 */
const SELF_CHECK_X = 2;
const SELF_CHECK_Y = 2;

/**
 * 建一张**尺寸被验证过**的画布：`width` / `height` 必须是整数且 ≥1；写完之后回读，不一致即抛。
 *
 * **为什么必须回读**：浏览器对超过平台上限的画布不报错，而是静默钳制尺寸（有的实现直接置 0）
 * ⇒ 调用方拿到一张「看起来正常」的空白画布，用户拿到一张白图。这一层把那个静默失败变成抛错，
 * 由上层决定怎么办（`ExportPanel` 显示失败原因；上限的真值由 `/lab/canvas` 实测后回写
 * `EXPORT_MAX_EDGE`）。校验写在**任何写操作之前**（`AGENTS.md`「入口校验」）。
 *
 * **消费者**：`ExportPanel.vue`（每张产物渲染前建画布）。
 */
export function createCanvasStrict(width: number, height: number): HTMLCanvasElement {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error(`画布宽高必须是 ≥1 的整数（当前 ${width}×${height}）`);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  if (canvas.width !== width || canvas.height !== height) {
    throw new Error(
      `画布尺寸被浏览器钳制：期望 ${width}×${height}，实际 ${canvas.width}×${canvas.height}`,
    );
  }
  return canvas;
}

/**
 * 取 2D 上下文；拿不到即抛（不静默返回 `null`，让调用方在别处裸崩成 `TypeError`）。
 *
 * **消费者**：`ExportPanel.vue` 把返回值直接传给 `core/render/sheet.ts` / `share.ts`——
 * `CanvasRenderingContext2D` 结构上满足 core 的 `RenderTarget2D`，无需转换、无需断言。
 */
export function requireContext2D(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("无法获取 2D 上下文");
  }
  return ctx;
}

/**
 * Promise 化 `HTMLCanvasElement.toBlob`，固定请求 `"image/png"`。
 *
 * 回调给 `null`（编码失败）即 **reject**——规格 §8 明写「不静默返回空串」：静默成功会让用户以为
 * 自己保存了一张图。注意 happy-dom 的 `toBlob` 给的是**大小 0 的 Blob**（不是 `null`），
 * 那条路径由 `downloadBlob` 的「blob 大小为 0」守卫兜住。
 *
 * **消费者**：`ExportPanel.vue`（渲染完成后取 PNG）。
 */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("导出 PNG 失败：toBlob 返回了 null"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

/**
 * 触发一次下载：`URL.createObjectURL` → 临时 `<a download>` → `click()` → `revokeObjectURL`。
 *
 * **两条守卫都写在任何副作用之前**（`AGENTS.md`「入口校验」）：`blob.size === 0` 即抛（空文件是
 * 真实存在的失败形态，见 `canvasToBlob`）；文件名去空白后为空即抛。顺序上**先 `click()` 后
 * `revokeObjectURL`**：反过来会在部分浏览器上让下载拿不到数据。
 *
 * **这个 `文件名不能为空` 守卫不是 `normalizeProjectName` 的副本**（控制者裁定 2026-10-05）：两者校验的
 * 是**不同的对象**——`normalizeProjectName` 校验「工程名」（trim、非空、≤ `PROJECT_NAME_MAX`，属调用方
 * 的命名契约，`exportFilename` 已经用过它）；本函数校验的是**最终文件名**，它是 DOM 边界的最后一站，
 * 只判「去空白后非空」，不管长度、也不管名字从哪来。职责不同，所以这里**不许**从工程名再推导一次
 * 文件名（那是第二份命名逻辑）。
 *
 * **刻意不把 `<a>` 挂进 DOM**：现代浏览器对未挂载的 `<a download>` 调 `click()` 即可触发下载；
 * 挂进去就必须配一次 `remove()`，而那道清理在「`click()` 抛错」的路径上会被漏掉，DOM 里就留下
 * 一个永不回收的节点。用例用 `anchor.parentNode === null` 钉住这条决定。
 *
 * **消费者**：`ExportPanel.vue`（用户点「保存」后）。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  if (blob.size === 0) {
    throw new Error("导出内容为空（blob 大小为 0）");
  }
  const safeName = filename.trim();
  if (safeName === "") {
    throw new Error("文件名不能为空");
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeName;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * §9 第 5 条的**生成后自检**：读回采样点 `(SELF_CHECK_X, SELF_CHECK_Y)` 的 1×1 像素，不是不透明的
 * 白色即抛。
 *
 * 它挡的是「分配成功、内容全空 / 读回全 0」这一形态（规格 §16 的 B4-R2）：没有它，失败会以
 * 「一张白图」的形式成功交付。上下文获取复用 `requireContext2D`（不写第二份 `null` 检查）。
 * 消息里的坐标由这两个常量插值而来，所以**坐标与文案不会漂移**（改坐标会同时改掉消息与用例）。
 *
 * **采样点为什么是 (2, 2)**：见 `SELF_CHECK_X` 的注释——它在左上角边距里，始终白底、不放任何文字。
 *
 * **消费者 = `ExportPanel.vue`（生产消费者，契约 §2b 已补）**：每张渲染完成之后、`canvasToBlob` 之前
 * 调用它；**面板若不调用它，它就是零消费者，属缺陷**（`AGENTS.md`「公开 API ≠ 被使用的 API」）。
 * **分享图不调用自检**——它按设计是透明的，没有「必定不透明」的点（控制者裁定 2026-10-05）。
 */
export function assertCanvasPainted(canvas: HTMLCanvasElement): void {
  const ctx = requireContext2D(canvas);
  const { data } = ctx.getImageData(SELF_CHECK_X, SELF_CHECK_Y, 1, 1);
  const rgba = `${data[0]},${data[1]},${data[2]},${data[3]}`;
  if (data[0] !== 255 || data[1] !== 255 || data[2] !== 255 || data[3] !== 255) {
    throw new Error(
      `画布内容自检失败：(${SELF_CHECK_X}, ${SELF_CHECK_Y}) 读回 ${rgba}（期望 255,255,255,255）`,
    );
  }
}

/**
 * 产物文件名（模板已并入契约 §2）：`<清洗后的工程名>-施工图-r{行}c{列}.png` /
 * `<清洗后的工程名>-用量表.png` / `<清洗后的工程名>-分享图.png`——**非分片项不带序号**。
 * 分片序号 **1 起**（`rowIndex + 1`），与施工图页脚「第 r/c 片」同一口径。
 *
 * **清洗复用 `normalizeProjectName`，不写第二份**（规格 §8 明写）：它同时给出「非空」与
 * 「≤ `PROJECT_NAME_MAX` 字」两条约束，并在非法时抛它自己的中文消息——本函数**不吞、不改写**，
 * 让「名字非法」在导出这一步与在保存工程那一步是同一句话。
 *
 * 四个运行期守卫（TS 类型挡不住 `JSON.parse` / 强转 / 运行期拼接）：内容标签必须是三值之一
 * （否则会静默产出一个 `X-海报.png`）；`用量表` / `分享图` 带了 `tile` 即抛（静默忽略会让调用方
 * 以为自己传对了）；施工图必须有分片序号；序号必须是 ≥0 的整数（负数或小数会静默产出 `r0c0`
 * 或 `r1c2.5`，看起来完全正常）。
 *
 * **消费者**：`ExportPanel.vue`（生成每个产物的下载文件名）。
 */
export function exportFilename(
  projectName: string,
  item: ExportItemLabel,
  tile?: { rowIndex: number; colIndex: number },
): string {
  const safeName = normalizeProjectName(projectName);
  if (item !== "施工图" && item !== "用量表" && item !== "分享图") {
    throw new Error(`导出内容标签非法：${item}`);
  }
  if (item !== "施工图") {
    if (tile !== undefined) {
      throw new Error("用量表 / 分享图不带分片序号");
    }
    return `${safeName}-${item}.png`;
  }
  if (tile === undefined) {
    throw new Error("施工图的分片序号缺失");
  }
  if (
    !Number.isSafeInteger(tile.rowIndex) ||
    tile.rowIndex < 0 ||
    !Number.isSafeInteger(tile.colIndex) ||
    tile.colIndex < 0
  ) {
    throw new Error(`分片序号非法：${tile.rowIndex}, ${tile.colIndex}（必须是 ≥0 的整数）`);
  }
  return `${safeName}-${item}-r${tile.rowIndex + 1}c${tile.colIndex + 1}.png`;
}
```

- [ ] **步骤 4：运行测试，确认通过**

```bash
npx vitest run src/services/__tests__/exporter.test.ts
```

预期：**PASS**（第一批全部用例绿）。若有红：先怀疑用例里的桩（尤其「拿不到上下文」那条依赖 happy-dom
返回 `null` 的真实行为），再怀疑实现；**不许为了让用例变绿而放宽断言**。

- [ ] **步骤 5：补用例（第二批：判别性硬化 + 两个变异靶子）**

先改文件头的 import 行，加上 `ExportItemLabel` 类型（第二批要拿它做非法标签的强转）：

```ts
import {
  assertCanvasPainted,
  canvasToBlob,
  createCanvasStrict,
  downloadBlob,
  exportFilename,
  requireContext2D,
  type ExportItemLabel,
} from "../exporter";
```

再在文件**末尾**追加下面整段（不修改第一批的任何一行）：

```ts
describe("createCanvasStrict：回读校验（M8 的靶子）", () => {
  it("超限被静默钳制 ⇒ 抛，消息带期望与实际", () => {
    const stub = makeCanvasStub({ clampWidthTo: 4096, clampHeightTo: 4096 });
    stubCreateElement(() => stub.canvas);

    expect(() => createCanvasStrict(8192, 8192)).toThrow(
      "画布尺寸被浏览器钳制：期望 8192×8192，实际 4096×4096",
    );
  });

  it("被置 0 同样被抓（另一种真实的钳制形态）", () => {
    const stub = makeCanvasStub({ clampWidthTo: 0, clampHeightTo: 0 });
    stubCreateElement(() => stub.canvas);

    expect(() => createCanvasStrict(8192, 8192)).toThrow(
      "画布尺寸被浏览器钳制：期望 8192×8192，实际 0×0",
    );
  });

  it("只差一轴也算钳制（不能被「另一轴相等」骗过去）", () => {
    const stub = makeCanvasStub({ clampHeightTo: 4096 });
    stubCreateElement(() => stub.canvas);

    expect(() => createCanvasStrict(8192, 8192)).toThrow("画布尺寸被浏览器钳制");
  });
});

describe("downloadBlob：守卫先于副作用", () => {
  it("文件名清洗后为空 ⇒ 抛，且没有建 object URL、没有建元素", () => {
    const url = stubUrlApi();
    const created = stubCreateElement(() => makeCanvasStub().canvas);

    expect(() => downloadBlob(new Blob([new Uint8Array([1])]), "  \t ")).toThrow("文件名不能为空");

    expect(url.createObjectURL).not.toHaveBeenCalled();
    expect(created.anchors).toEqual([]);
  });

  it("blob 大小为 0 ⇒ 抛，同样在任何副作用之前（不留悬挂的 blob URL）", () => {
    const url = stubUrlApi();
    const created = stubCreateElement(() => makeCanvasStub().canvas);

    expect(() => downloadBlob(new Blob([]), "图纸-分享图.png")).toThrow(
      "导出内容为空（blob 大小为 0）",
    );

    expect(url.createObjectURL).not.toHaveBeenCalled();
    expect(created.anchors).toEqual([]);
  });
});

describe("exportFilename：清洗与序号守卫（M13 的靶子）", () => {
  it("复用 normalizeProjectName：前后空白被清掉（不写第二份清洗）", () => {
    expect(exportFilename("  小猫  ", "分享图")).toBe("小猫-分享图.png");
  });

  it("名字清洗后为空 ⇒ 抛 normalizeProjectName 的原消息（不吞、不改写）", () => {
    expect(() => exportFilename("   ", "分享图")).toThrow("工程名称不能为空");
  });

  it("100 字合法、101 字抛（长度上限来自 normalizeProjectName，不在这里重写）", () => {
    const longest = "图".repeat(100);
    expect(exportFilename(longest, "用量表")).toBe(`${longest}-用量表.png`);
    expect(() => exportFilename("图".repeat(101), "分享图")).toThrow("工程名称不能超过 100 个字符");
  });

  it("非字符串名字 ⇒ 抛（TS 类型挡不住运行期输入）", () => {
    expect(() => exportFilename(42 as unknown as string, "分享图")).toThrow("工程名称必须是字符串");
  });

  it("施工图缺分片序号 ⇒ 抛", () => {
    expect(() => exportFilename("小猫", "施工图")).toThrow("施工图的分片序号缺失");
  });

  it("用量表 / 分享图带了 tile ⇒ 抛（静默忽略会让调用方以为自己传对了）", () => {
    expect(() => exportFilename("小猫", "用量表", { rowIndex: 0, colIndex: 0 })).toThrow(
      "用量表 / 分享图不带分片序号",
    );
    expect(() => exportFilename("小猫", "分享图", { rowIndex: 3, colIndex: 4 })).toThrow(
      "用量表 / 分享图不带分片序号",
    );
  });

  it("分片序号必须是 ≥0 的整数 ⇒ 否则抛（负数会静默产出 r0c0）", () => {
    expect(() => exportFilename("小猫", "施工图", { rowIndex: -1, colIndex: 0 })).toThrow(
      "分片序号非法：-1, 0（必须是 ≥0 的整数）",
    );
    expect(() => exportFilename("小猫", "施工图", { rowIndex: 0, colIndex: 1.5 })).toThrow(
      "分片序号非法：0, 1.5（必须是 ≥0 的整数）",
    );
  });

  it("内容标签非法 ⇒ 抛（运行期不认 TS 类型）", () => {
    expect(() => exportFilename("小猫", "海报" as unknown as ExportItemLabel)).toThrow(
      "导出内容标签非法：海报",
    );
  });
});

describe("assertCanvasPainted：判据与守卫的接线", () => {
  it("只差一个通道也要红（半透明 / 偏色不能被当成「画过了」）", () => {
    for (const pixel of [
      [255, 255, 255, 254],
      [254, 255, 255, 255],
    ] as const) {
      const { canvas } = stubPainted(pixel);
      expect(() => assertCanvasPainted(canvas)).toThrow("画布内容自检失败：(2, 2) 读回");
    }
  });

  it("拿不到 2D 上下文时复用 requireContext2D 的守卫（不写第二份 null 检查）", () => {
    // 不装任何桩：happy-dom 无 canvas adapter ⇒ 真元素上 getContext("2d") 就是 null。
    const canvas = document.createElement("canvas");
    expect(() => assertCanvasPainted(canvas)).toThrow("无法获取 2D 上下文");
  });
});
```

- [ ] **步骤 6：运行测试**

```bash
npx vitest run src/services/__tests__/exporter.test.ts
```

预期：**PASS**（两个批次一起绿）。这一批是**硬化断言**，第一次跑就绿是正常的——
它们的判别力**不靠首跑**，而由步骤 7 / 8 的变异实测证明（各自点名了它该打红哪一条）。
若这里出现红：说明实现真的有问题（或断言写错了），修根因，不许删断言、不许改 `toThrow` 的子串去迎合。

- [ ] **步骤 7：变异实测 M8（`createCanvasStrict` 删掉回读校验）**

先**只暂存、不提交**这两个文件——它们是本任务新建的，`git checkout --` 从**索引**还原；
未暂存时它会对新文件报 `error: pathspec … did not match any file(s) known to git`，还原会失败：

```bash
git add src/services/exporter.ts src/services/__tests__/exporter.test.ts
```

**变异动作**（只动 `src/services/exporter.ts` 的一处）：删掉 `createCanvasStrict` 里这一段

```ts
  if (canvas.width !== width || canvas.height !== height) {
    throw new Error(
      `画布尺寸被浏览器钳制：期望 ${width}×${height}，实际 ${canvas.width}×${canvas.height}`,
    );
  }
```

**该红的断言**（本片段的靶子清单，**不是红数**）：

- `createCanvasStrict：回读校验（M8 的靶子）` › 「超限被静默钳制 ⇒ 抛，消息带期望与实际」
- 同 describe › 「被置 0 同样被抓（另一种真实的钳制形态）」
- 同 describe › 「只差一轴也算钳制（不能被『另一轴相等』骗过去）」
- （旁证）`createCanvasStrict` › 「正常尺寸…」应保持绿——它不依赖回读。

跑聚焦用例并回填：

```bash
npx vitest run src/services/__tests__/exporter.test.ts
git checkout -- src/services/exporter.ts
npx vitest run src/services/__tests__/exporter.test.ts
```

回填表（红数**不许预估**，以实测为准；下表里的权威值来自控制者在片段评审时的沙箱实跑——
实现本身与用例与本片段逐字相同。**实现者仍须自己复跑确认**；若复跑结果与权威值不同，以你的复跑为准，
并立刻报告差异）：

| 变异 | 实测红数 | 失败点标题（逐条抄 `FAIL` 行） | 还原后复跑 |
|---|---|---|---|
| M8 删掉回读校验 | 权威值 **3**（复跑确认后填你的实测值） | （实现者回填，逐条抄 `FAIL` 行） | 全绿（回填 `Test Files 1 passed` / `Tests 25 passed`） |

- [ ] **步骤 8：变异实测 M13（`exportFilename` 跳过 `normalizeProjectName`）**

**变异动作**（只动 `src/services/exporter.ts` 的两处）：

1. 删掉第一行 `import { normalizeProjectName } from "./projectStore";`；
2. 把 `exportFilename` 里的 `const safeName = normalizeProjectName(projectName);` 改成
   `const safeName = projectName;`。

**该红的断言**（靶子清单）：

- `exportFilename：清洗与序号守卫（M13 的靶子）` › 「复用 normalizeProjectName：前后空白被清掉」
- 同 describe › 「名字清洗后为空 ⇒ 抛 normalizeProjectName 的原消息」
- 同 describe › 「100 字合法、101 字抛」
- 同 describe › 「非字符串名字 ⇒ 抛」
- （旁证）`exportFilename` › 「施工图带 r{行}c{列}…」若名字里含空白才受影响——本片段的名字是
  `小猫`（无空白），**实测保持绿**（控制者沙箱复跑确认）；同样「用量表 / 分享图带了 tile」等
  其余守卫也不受这个变异影响。

跑聚焦用例并回填：

```bash
npx vitest run src/services/__tests__/exporter.test.ts
git checkout -- src/services/exporter.ts
npx vitest run src/services/__tests__/exporter.test.ts
```

回填表：

| 变异 | 实测红数 | 失败点标题（逐条抄 `FAIL` 行） | 还原后复跑 |
|---|---|---|---|
| M13 跳过 `normalizeProjectName` | 权威值 **4**（复跑确认后填你的实测值） | （实现者回填，逐条抄 `FAIL` 行） | 全绿（回填原始输出尾巴） |

> **规格 §13.3 的更正（控制者 2026-10-05）**：那一列已改成只写「该红的断言」、**不写数目**；
> 本片段的 M8 = **3 红**、M13 = **4 红**是控制者的沙箱实跑权威值，直接写进报告。
> 纪律不变：**不许为了对齐任何文档里的旧数字去改实现或用例**（红数不许预估，也不许反向凑数）。
> M13 的 4 条就是上面靶子清单里的四条清洗断言，一条不多一条不少——这是本次实测的事实，
> 不是估计。

- [ ] **步骤 9：全量验证**

```bash
npm run test
$env:TZ="UTC"; npm run test
npm run build
```

预期：`npm run test` 在基线（55 文件 / 987 用例）之上多出 1 个文件与若干用例，**全绿**；
`TZ=UTC` 同样全绿（本片段不引入任何日期/时区依赖，`generatedAt` 由调用方传入字符串）；`npm run build`
（`vue-tsc --noEmit && vite build`）通过——本任务的新文件都在 `src/**` 的 `include` 范围内，会被
`vue-tsc` 严格检查（禁止 `any`、`noUnusedLocals` 都在这里生效）。

- [ ] **步骤 10：Commit**

```bash
git add src/services/exporter.ts src/services/__tests__/exporter.test.ts
git commit -m "feat(services): 导出落盘与文件名"
```

**报告必须包含**（这是控制者复核的输入，缺一条就要返工）：

1. `npm run test` / `$env:TZ="UTC"; npm run test` / `npm run build` 三条命令的**原始输出尾巴**
   （文件数 / 用例数 / 构建结果），以及与本任务落地前后的对比；
2. 步骤 7 / 8 的**实测红数与失败点标题**（逐条抄 `FAIL` 行），以及 `git checkout --` 还原后复跑的
   全绿证据（`Test Files 1 passed` / `Tests 25 passed`）；与权威值（M8 = 3、M13 = 4）不一致时
   立刻报告，**不许改实现或用例去对齐任何文档里的数字**；
3. **自加的一条变异**（本片段未点名，由你挑一处最能暴露假绿的断言做）：建议二选一——
   （a）把 `getImageData(SELF_CHECK_X, SELF_CHECK_Y, 1, 1)` 的常量改成 `0` / `0`；
   （b）在 `downloadBlob` 里删掉 `link.download = safeName;`。动作、实测红数、失败点标题、
   还原后复跑，四条都要有。（选 (a) 时注意：坐标由常量插值进消息，所以采样点断言与两条消息断言
   会一起红——这正好是「坐标与文案不会漂移」这条裁定的证据，报告里点一句。）
4. **环境事实的实测确认**：本片段的环境事实表（5 行）你若实测到差异（例如某版本 happy-dom 的
   `getContext` 不再返回 `null`、或 `URL.createObjectURL` 不存在），**以实测为准**并回填表格；
5. `assertCanvasPainted` 的**生产消费者 = `ExportPanel`**（渲染完成之后、`canvasToBlob` 之前；
   分享图不调用自检）。如实报告：本任务提交时它在**生产代码里还没有调用点**（任务 4 才接上），
   而契约 §2b 已把它写成面板的义务——**面板不调用它，它就是零消费者，属缺陷**；
6. 文末「控制者裁定（2026-10-05）」表里 8 条**逐条核对**：你交付的代码与用例是否与裁定逐字一致
   （消息文本、守卫集合、文件名模板、采样点与消费者），每条给一行证据（引用你提交的那段代码 /
   那条断言的原文）；
7. 任何与本计划 / 契约不符之处与你的处置（**不许自行发明名字**；发现缺口就报，不要就地改名）。

---

---

## 任务 4：导出面板与编辑器装配

**文件：**
- 创建：
  - `src/components/editor/ExportPanel.vue`
  - `src/components/editor/__tests__/ExportPanel.test.ts`
- 修改（**只加不改**既有断言）：
  - `src/components/editor/PatternToolbar.vue`
    - 第 41 行（`defineEmits` 的 `save: [];` 之后）追加 `export: [];`
    - 第 127 行（`editor-dirty` 的 `</span>`）之后、第 129 行（`editor-save` 的 `<button>`）之前插入导出按钮
  - `src/components/editor/__tests__/PatternToolbar.test.ts`（文件末尾追加一个 `describe`）
  - `src/views/EditorPage.vue`
    - 第 20 行（`import PalettePanel …`）之前插入 `ExportPanel` 的 import
    - 第 75 行（`const allowLeave = ref(false);` 与其后空行）之后插入 `exporting`
    - 第 547 行（`@save="onCommand('save')"`）之后插入 `@export="exporting = true"`
    - 第 614 行（`</main>`）之前插入面板块
  - `src/views/__tests__/EditorPage.test.ts`
    - 第 75 行（`vi.mock("vue-router", …)` 那一块的收尾 `}));`）之后插入 `@/services/exporter` 的桩与三个模块级助手
    - 文件末尾追加一个 `describe`（三条例外用例）

**前置**：任务 1 / 2 / 3 必须已交付并提交——`src/core/render/{types,layout,sheet,share}.ts` 与
`src/services/exporter.ts` 都要在。本片段**不改**这三个任务的任何文件；发现它们与契约不符时**报控制者**，不自行改。

**这个任务为什么是一个任务**：面板的 props 契约与页面给的实参是同一个东西（契约 §2b），分开审会让
「面板的 props 对不对」与「页面给的是不是内存态图纸」各测一半、接缝没人守。三处用例分别钉三层：
面板自己（`ExportPanel.test.ts`）、工具栏只多了一个事件（`PatternToolbar.test.ts`）、
页面只做接线且**导出的是内存态图纸**（`EditorPage.test.ts`，规格 §13.2 第 1 条）。

**裁定的落点**（计划任务 0）：R-4（面板自持 plan 与逐项状态，页面只接线）、R-5（逐项导出 = 一次用户手势）、
R-6（不乘 DPR、不经过 `renderPatternThumbnail`、生成时间由调用方给字符串）。

---

- [ ] **步骤 1：写失败的用例 `src/components/editor/__tests__/ExportPanel.test.ts`**

**本文件覆盖**（规格 §13.1 的 `ExportPanel` 一行 + 控制者补充的两条）：计划摘要随 plan 变（含
`labels-omitted` 的琥珀文案）、逐项四个状态、一项失败不影响其他项、`revision` 变 ⇒ 所有「已生成」
复位且预览销号、**渲染完先自检再 `toBlob`（分享图故意不自检）**、**逐张渲染后即时释放画布
（失败路径也释放，且释放晚于 `toBlob`）**、只给 props 就能完整工作（不读 store）。
后两条与 `revision` 失效同属「面板的状态机」——它们都是同一条渲染路径上的顺序约束，所以写在**同一组**
`describe` 里。

```ts
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPalette } from "@/core/palette/registry";
import type { Palette } from "@/core/palette/types";
import { patternStats } from "@/core/pattern/stats";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import * as layout from "@/core/render/layout";
import type { RenderTarget2D } from "@/core/render/types";
import ExportPanel from "@/components/editor/ExportPanel.vue";

/**
 * 导出面板用例：**只给 props 就能完整工作**（契约 §2b）。
 *
 * 本文件**全程不建 pinia**：面板一旦 import 任何 store 并在 setup / 渲染里读它，挂载期就会以
 * 「no active Pinia」抛错，每一条用例都会红——这就是「面板不许 import `@/stores/*`」这条纪律的
 * 运行时证明（`只给 props 就能完整工作` 那一条另外补一条源码级词法闸门）。
 *
 * 平台边界只有一处桩：`@/services/exporter` 的五个碰平台的函数
 * （建画布 / ctx / **画布自检** / toBlob / 下载），`exportFilename` 用**真实现**
 * （文件名的逐字格式由任务 3 的用例负责，这里只钉「工程名 + 中文标签」这两件事被接上了）。
 * **不 mock `@/core/render/*`**：让真渲染器跑在下面的记录型 target 上，
 * 「props → plan → 渲染器」这条链才是真的被走过（happy-dom 的 canvas 没有像素语义，CONTRACT §5.1）。
 *
 * 与「面板的状态机」有关的三件事（逐项四态 / `revision` 失效 / **画布自检 + 即时释放**）都在
 * 下面同一组 `describe` 里：它们都是同一条渲染路径上的顺序约束，拆开就会各自假绿。
 */

/* ---------------- 桩 1：平台边界（exporter 的五个函数） ---------------- */

const exporter = vi.hoisted(() => ({
  createCanvasStrict: vi.fn<(width: number, height: number) => HTMLCanvasElement>(),
  requireContext2D: vi.fn<(canvas: HTMLCanvasElement) => RenderTarget2D>(),
  // 画布自检（契约 §2 的第 6 个导出）：生产消费者**就是本面板**——面板不调用它，它就是零消费者导出。
  assertCanvasPainted: vi.fn<(canvas: HTMLCanvasElement) => void>(),
  canvasToBlob: vi.fn<(canvas: HTMLCanvasElement) => Promise<Blob>>(),
  downloadBlob: vi.fn<(blob: Blob, filename: string) => void>(),
}));

vi.mock("@/services/exporter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/exporter")>();
  return { ...actual, ...exporter };
});

/* ---------------- 桩 2：labels-omitted 的定向桩（默认 null = 真实现） ---------------- */

/**
 * 为什么需要它：默认 `EXPORT_MAX_EDGE = 4096` 时 `kc = kr = 4 ≥ 1` ⇒ **`labels` 恒为真**，
 * 「省略色号」这条提示不可能由真 plan 产生；而契约 §2b 的 props 里没有 `maxEdge`，
 * 面板也无法被喂进一个更小的上限。要让那段琥珀文案进入被测路径，只能把 `planSheets` 定向替换一次
 * （控制者裁定 1：**不加 `maxEdge` prop**——它是平台事实、不是每张图的输入；本桩即采纳的处置）。
 */
const layoutStub = vi.hoisted(() => ({
  planSheets: null as null | typeof import("@/core/render/layout").planSheets,
}));

vi.mock("@/core/render/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/render/layout")>();
  return {
    ...actual,
    planSheets: (
      pattern: Parameters<typeof actual.planSheets>[0],
      palette: Parameters<typeof actual.planSheets>[1],
      options?: Parameters<typeof actual.planSheets>[2],
    ): ReturnType<typeof actual.planSheets> =>
      (layoutStub.planSheets ?? actual.planSheets)(pattern, palette, options),
  };
});

/* ---------------- 记录型绘制目标 ---------------- */

interface FillCall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fillStyle: string;
}

interface RecordingTarget {
  readonly target: RenderTarget2D;
  readonly fills: readonly FillCall[];
}

/**
 * `RenderTarget2D` 的普通对象桩 + `fillRect` 记录。**不碰 `document.createElement("canvas")`**：
 * happy-dom 的 ctx 没有像素语义，`getImageData` / `toDataURL` 都不可信（CONTRACT §5.1）。
 */
function createRecordingTarget(): RecordingTarget {
  const fills: FillCall[] = [];
  const target: RenderTarget2D = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "center",
    textBaseline: "middle",
    imageSmoothingEnabled: false,
    fillRect: (x, y, w, h) => {
      fills.push({ x, y, w, h, fillStyle: target.fillStyle });
    },
    strokeRect: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    fillText: () => undefined,
    save: () => undefined,
    restore: () => undefined,
  };
  return { target, fills };
}

/* ---------------- 假画布（即时释放那一条靠它才可观察） ---------------- */

interface FakeCanvas {
  readonly canvas: HTMLCanvasElement;
  /** 每一次 `width` / `height` 赋值都被记下来（`[属性, 值]`）。 */
  readonly writes: readonly (readonly [string, number])[];
}

/**
 * `createCanvasStrict` 的替身：宽高**可写且记录每一次写入**。
 *
 * 面板从不读画布的宽高（尺寸只在 `createCanvasStrict` 的入参里用），所以「渲染完是否即时释放」
 * 在 CI 里唯一可观察的形式就是**有没有写回 0**（规格 §9 第 6 条）。用普通对象 + getter/setter，
 * 不碰 happy-dom 的 canvas。
 *
 * `onWrite` 把「谁先谁后」也记进用例的顺序表——只断言「写没写过 0」是证不出「释放发生在 `toBlob`
 * **之后**」的，而提前释放（拿着 0×0 的画布去 `toBlob`）在生产路径上就是一张空图。
 */
function createFakeCanvas(
  width: number,
  height: number,
  onWrite: (what: string) => void,
): FakeCanvas {
  const writes: (readonly [string, number])[] = [];
  const current: { width: number; height: number } = { width, height };
  const canvas = {
    get width(): number {
      return current.width;
    },
    set width(value: number) {
      writes.push(["width", value]);
      onWrite("release:width");
      current.width = value;
    },
    get height(): number {
      return current.height;
    },
    set height(value: number) {
      writes.push(["height", value]);
      onWrite("release:height");
      current.height = value;
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, writes };
}

/* ---------------- object URL 的桩 ---------------- */

let createdUrls: string[] = [];
let revokedUrls: string[] = [];

/**
 * happy-dom 下 `URL.createObjectURL` / `revokeObjectURL` **可能不存在**（CONTRACT §5.2），
 * 所以不用 `vi.spyOn`；也**不整替 `URL` 全局**（它的构造函数还有别的用途）。
 */
function stubObjectUrl(): void {
  const target = URL as unknown as {
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
  };
  let seq = 0;
  createdUrls = [];
  revokedUrls = [];
  target.createObjectURL = () => {
    seq += 1;
    const url = `blob:panel-${seq}`;
    createdUrls.push(url);
    return url;
  };
  target.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };
}

/* ---------------- 夹具 ---------------- */

/** 夹具色卡：16 色（让 200×200 的夹具把用量表排到 2 行，摘要才真的「随 plan 变」）。 */
const palette: Palette = loadPalette({
  id: "panel-fixture",
  name: "夹具色卡",
  source: "https://example.com",
  accuracy: "屏幕色仅供参考，以实物为准",
  colors: Array.from({ length: 16 }, (_, i) => ({
    code: `A${i + 1}`,
    name: `色 ${i + 1}`,
    hex: `#${(i + 1).toString(16).padStart(2, "0")}0000`,
  })),
});

/** 4×2：1 张施工图、40 px/格、含色号；用到 3 个色号（用量表 1 行、分享图 256×128）。 */
function makeSmallPattern(): Pattern {
  return {
    width: 4,
    height: 2,
    paletteId: palette.id,
    cells: Uint16Array.from([0, 1, 2, EMPTY, 2, 2, 2, 2]),
  };
}

/** 200×200：4 张（2×2 片，每片 116 格、33 px/格）；用到 15 个色号（用量表 2 行、分享图 2000×2000）。 */
function makeLargePattern(): Pattern {
  const cells = new Uint16Array(200 * 200);
  for (let i = 0; i < cells.length; i += 1) cells[i] = i % 15;
  return { width: 200, height: 200, paletteId: palette.id, cells };
}

function mountPanel(pattern: Pattern, overrides: Record<string, unknown> = {}) {
  return mount(ExportPanel, {
    props: {
      pattern,
      palette,
      usages: patternStats(pattern, palette).usages,
      projectName: "小猫",
      revision: 0,
      ...overrides,
    },
  });
}

async function saveAndSettle(wrapper: ReturnType<typeof mount>, id: string): Promise<void> {
  await wrapper.get(`[data-testid='export-save-${id}']`).trigger("click");
  await flushPromises();
}

/** 面板源码：词法闸门用（`from "…/stores/…"` 一次都不许出现）。 */
const PANEL_SOURCES: Record<string, string> = import.meta.glob<string>("../ExportPanel.vue", {
  eager: true,
  query: "?raw",
  import: "default",
});

let recording: RecordingTarget;
/** 每一次 `createCanvasStrict` 造出来的假画布，按调用顺序（一次导出 = 一张画布）。 */
let canvases: FakeCanvas[];
/** 渲染路径上的**顺序**：自检必须早于 `toBlob`，释放必须晚于 `toBlob`。 */
let steps: string[] = [];

beforeEach(() => {
  recording = createRecordingTarget();
  canvases = [];
  steps = [];
  exporter.createCanvasStrict.mockReset().mockImplementation((width, height) => {
    const fake = createFakeCanvas(width, height, (what) => {
      steps.push(what);
    });
    canvases.push(fake);
    return fake.canvas;
  });
  exporter.requireContext2D.mockReset().mockImplementation(() => recording.target);
  exporter.assertCanvasPainted.mockReset().mockImplementation(() => {
    steps.push("selfcheck");
  });
  exporter.canvasToBlob.mockReset().mockImplementation(async () => {
    steps.push("toBlob");
    return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  });
  exporter.downloadBlob.mockReset();
  stubObjectUrl();
});

afterEach(() => {
  layoutStub.planSheets = null;
});

/* ---------------- 用例 ---------------- */

describe("计划摘要（规格 §10.2 / 契约 §4）", () => {
  it("三行摘要按契约 §4 逐字渲染，并随 plan 变（含片标签的总行 / 总列）", () => {
    const wrapper = mountPanel(makeSmallPattern());
    // 用 testid 定位 + `toBe`（不是整页 `text()` + `toContain`）：三行摘要都是单个插值，逐字相等
    // 是本环境里能断的最强形式；而整页文本里「用量表」既在摘要里、也在逐项标签里——那种定位
    // 既可能假绿（摘要写错、标签碰巧带上）也可能假红。
    expect(wrapper.get("[data-testid='export-summary-sheet']").text()).toBe(
      "共 1 张 · 每片最多 4×2 格 · 40 px/格 · 含格内色号",
    );
    expect(wrapper.get("[data-testid='export-summary-legend']").text()).toBe(
      "用量表 · 13 列 × 1 行 · 3948×230 px",
    );
    expect(wrapper.get("[data-testid='export-summary-share']").text()).toBe(
      "分享图 · 256×128 px（纯色块，无网格无文字）",
    );
    // 含色号这一档**不渲染**琥珀提示（契约 §4：它是「省略时另起一行」）
    expect(wrapper.find("[data-testid='export-warning-labels']").exists()).toBe(false);
    // 1 张时片标签是 1/1——它是**算出来的**，不是常量
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain(
      "施工图 第 1/1 行 第 1/1 列",
    );
  });

  it("换 plan（同一个实例）后摘要与逐项清单都跟着走，片标签是 2/2", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    const large = makeLargePattern();

    // **只换 pattern（`revision` 刻意不动）**：`beginSession` 会把 `revision` 归零，所以
    // 「从一张 revision = 0 的图纸换到另一张」时 revision 这一路根本不会触发——`watch` 若不看
    // `pattern` 的对象身份，清单就会停在上一张图纸的片数与标签上（契约 §2b 明文要求两个源都在，
    // 见步骤 12 的 M-rev-B）。
    await wrapper.setProps({ pattern: large, usages: patternStats(large, palette).usages });
    await flushPromises();

    expect(wrapper.get("[data-testid='export-summary-sheet']").text()).toBe(
      "共 4 张 · 每片最多 116×116 格 · 33 px/格 · 含格内色号",
    );
    expect(wrapper.get("[data-testid='export-summary-legend']").text()).toBe(
      "用量表 · 13 列 × 2 行 · 3948×260 px",
    );
    expect(wrapper.get("[data-testid='export-summary-share']").text()).toBe(
      "分享图 · 2000×2000 px（纯色块，无网格无文字）",
    );
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain(
      "施工图 第 1/2 行 第 1/2 列",
    );
    expect(wrapper.get("[data-testid='export-item-tile-3']").text()).toContain(
      "施工图 第 2/2 行 第 2/2 列",
    );
    expect(wrapper.find("[data-testid='export-item-tile-4']").exists()).toBe(false);
  });

  it("labels-omitted：摘要尾注与琥珀提示按契约 §4 逐字（定向桩，见文件头的说明）", () => {
    const small = makeSmallPattern();
    // **前提断言**：默认上限下真 plan 一定是含色号的。这一句同时是「桩不是可有可无」的证据——
    // 哪天常量下调到真能走到这一档，这条前提会红，那时应当把桩删掉、改用真 plan。
    const realPlan = layout.planSheets(small, palette);
    expect(realPlan.labels).toBe(true);

    layoutStub.planSheets = () => ({
      ...realPlan,
      labels: false,
      warnings: [{ code: "labels-omitted", maxEdge: 1143, cellPx: 31 }],
    });

    const wrapper = mountPanel(small);
    expect(wrapper.get("[data-testid='export-summary-sheet']").text()).toBe(
      "共 1 张 · 每片最多 4×2 格 · 31 px/格 · 已省略格内色号（画布上限 1143 px 太小）",
    );
    const warning = wrapper.get("[data-testid='export-warning-labels']");
    expect(warning.text()).toBe(
      "画布上限只有 1143 px，格内色号画不下（每格 31 px，低于 32 px）；建议减少豆数或改小图纸。",
    );
    // 「琥珀」不是形容词：它必须落在本仓库既有的「要用户注意、但不拦」配色上
    expect(warning.classes()).toContain("text-amber-700");
  });
});

describe("逐项导出：一次手势一张（规格 §10.3 / R-5）", () => {
  it("待生成 → 生成中… → 已生成：期间按钮禁用，画布尺寸取自 plan，预览指向同一颗 blob", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    const item = () => wrapper.get("[data-testid='export-item-legend']");
    expect(item().text()).toContain("待生成");
    expect(wrapper.get("[data-testid='export-save-legend']").attributes("disabled")).toBeUndefined();
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(false);

    // 卡住 `canvasToBlob`，让「生成中」成为可观察状态（它本来只存在于两个微任务之间）
    let release = (): void => {};
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          release = () => {
            resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
          };
        }),
    );

    await wrapper.get("[data-testid='export-save-legend']").trigger("click");
    expect(item().text()).toContain("生成中…");
    expect(wrapper.get("[data-testid='export-save-legend']").attributes("disabled")).toBeDefined();

    release();
    await flushPromises();

    expect(item().text()).toContain("已生成");
    expect(wrapper.get("[data-testid='export-save-legend']").attributes("disabled")).toBeUndefined();
    // 预览就是刚下载的那一颗字节：`<img src>` = 那次 `createObjectURL` 的返回值
    expect(wrapper.get("[data-testid='export-preview-legend']").attributes("src")).toBe(
      createdUrls[0],
    );
    // **画布尺寸取自 plan**：用量表计划的 3948×230（不是别处的常量、不是缩略图的 512 上限）
    expect(exporter.createCanvasStrict).toHaveBeenCalledWith(3948, 230);
    // 面板确实把**真渲染器**跑在它自己那份 plan 上（尺寸那条钉的是尺寸，这条钉的是真的画了）
    expect(recording.fills.length).toBeGreaterThan(0);

    // 落盘的名字带着工程名与这一类产物的中文标签（逐字格式由任务 3 的用例负责）
    expect(exporter.downloadBlob).toHaveBeenCalledTimes(1);
    const [blobArg, filenameArg] = exporter.downloadBlob.mock.calls[0];
    expect(blobArg.size).toBeGreaterThan(0);
    expect(filenameArg).toContain("小猫");
    expect(filenameArg).toContain("用量表");
    expect(filenameArg.endsWith(".png")).toBe(true);
  });

  it("一项失败不影响其他项：失败只写该项的状态与中文原因，重试仍可成功", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    // 契约 §3 的逐字消息：`toBlob` 给 null 时 `canvasToBlob` 的 reject 原因
    exporter.canvasToBlob.mockRejectedValueOnce(new Error("导出 PNG 失败：toBlob 返回了 null"));

    await saveAndSettle(wrapper, "legend");
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain(
      "失败：导出 PNG 失败：toBlob 返回了 null",
    );
    // 其他项**一个都没被带下水**：状态仍是「待生成」、没有预览、按钮仍可点
    expect(wrapper.get("[data-testid='export-item-share']").text()).toContain("待生成");
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain("待生成");
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(false);
    expect(exporter.downloadBlob).not.toHaveBeenCalled();

    // 失败不是终态：这一项自己重试成功
    await saveAndSettle(wrapper, "legend");
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("已生成");

    // 另一项独立走通（下载与预览都发生）
    await saveAndSettle(wrapper, "share");
    expect(wrapper.get("[data-testid='export-item-share']").text()).toContain("已生成");
    expect(exporter.downloadBlob).toHaveBeenCalledTimes(2);
  });

  it("改一格（revision 变）⇒ 所有「已生成」复位为「待生成」，预览销号后丢弃", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    await saveAndSettle(wrapper, "legend");
    await saveAndSettle(wrapper, "share");
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("已生成");
    expect(wrapper.get("[data-testid='export-item-share']").text()).toContain("已生成");
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(true);
    expect(createdUrls).toHaveLength(2);

    await wrapper.setProps({ revision: 1 });
    await flushPromises();

    // ① **所有**项回「待生成」（只复位被点过的那一两项会在这里红）
    for (const id of ["legend", "share", "tile-0"]) {
      const text = wrapper.get(`[data-testid='export-item-${id}']`).text();
      expect(text).toContain("待生成");
      expect(text).not.toContain("已生成");
    }
    // ② 预览**销号后**丢弃：`<img>` 消失，且两个 object URL 都被 revoke
    //    （只清 `previewUrl`、不调 `revokeObjectURL` 的写法在最后一条上红——那是一处真实的泄漏）
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='export-preview-share']").exists()).toBe(false);
    expect(revokedUrls).toEqual(createdUrls);
  });

  it("渲染完先自检、再 toBlob；分享图**故意不**自检（它按设计是透明的）", async () => {
    const wrapper = mountPanel(makeSmallPattern());

    await saveAndSettle(wrapper, "legend");
    // 顺序断言（`steps` 由假画布与两个桩按真实发生顺序记下）：自检必须**早于** toBlob——
    // 反过来的话，一张「看起来正常」的白图已经落盘了才被发现（规格 §9 第 5 条的整条目的）。
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);
    expect(exporter.assertCanvasPainted).toHaveBeenCalledTimes(1);
    expect(exporter.assertCanvasPainted).toHaveBeenCalledWith(canvases[0]?.canvas);

    // 施工图那一项同样要自检（用量表与施工图**都**有「必定不透明」的左上角边距采样点 `(2, 2)`）
    steps = [];
    await saveAndSettle(wrapper, "tile-0");
    expect(exporter.assertCanvasPainted).toHaveBeenCalledTimes(2);
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);

    // 分享图是**纯色块、空格透明**的产物：`(2, 2)` 这类采样点落在透明像素上是完全合法的，
    // 所以它没有「必定不透明」的位置可采（§9 第 5 条要求采样点与图纸内容无关）⇒ **故意不调**。
    // 少了这条反向断言，后人会以为是漏了、然后顺手补上——于是一张合法的全透明分享图会被自检
    // 判成失败。
    steps = [];
    await saveAndSettle(wrapper, "share");
    expect(exporter.assertCanvasPainted).toHaveBeenCalledTimes(2);
    expect(steps).toEqual(["toBlob", "release:width", "release:height"]);
  });

  it("逐张渲染后即时释放画布：成功与失败两条路径都写回 0，且释放晚于 toBlob", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    await saveAndSettle(wrapper, "tile-0");
    expect(canvases).toHaveLength(1);
    // 顺序与内容一起断：**toBlob 之后**才释放（提前释放＝拿着 0×0 的画布去 toBlob，生产上就是空图）
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);
    expect(canvases[0]?.writes).toEqual([
      ["width", 0],
      ["height", 0],
    ]);
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain("已生成");

    // 失败分支：`canvasToBlob` reject（契约 §3 的逐字原因）时**照样释放**——所以它在 `finally` 里。
    // 少了这一条，`try` 里直接释放的写法会在失败路径上把画布留到下一次 GC（内存峰值不再是一张）。
    canvases = [];
    steps = [];
    exporter.canvasToBlob.mockRejectedValueOnce(new Error("导出 PNG 失败：toBlob 返回了 null"));
    await saveAndSettle(wrapper, "share");

    expect(canvases).toHaveLength(1);
    expect(canvases[0]?.writes).toEqual([
      ["width", 0],
      ["height", 0],
    ]);
    expect(wrapper.get("[data-testid='export-item-share']").text()).toContain(
      "失败：导出 PNG 失败：toBlob 返回了 null",
    );
  });
});

describe("空图纸与 props 驱动（规格 §10.4 / 契约 §2b）", () => {
  it("用量表为空时给一行如实说明，不拦也不假装成功", () => {
    const wrapper = mountPanel(makeSmallPattern(), { usages: [] });
    expect(wrapper.get("[data-testid='export-empty-note']").text()).toBe("这张图纸没有可拼的像素");
    // 说明是**信息**，不是禁用：这一项照样可以保存（规格 §10.4：用户可能就是想导出这张空图）
    expect(wrapper.get("[data-testid='export-save-legend']").attributes("disabled")).toBeUndefined();
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("待生成");
  });

  it("只给 props 就能完整工作：本文件全程不建 pinia，源码里也没有任何 store 的 import", async () => {
    // 运行时证明：挂载 + 真的生成一项，全程没有任何 pinia 实例
    const wrapper = mountPanel(makeSmallPattern());
    await saveAndSettle(wrapper, "tile-0");
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain("已生成");

    // 源码级证明（词法近似，与 `coreBoundary` 同一口径）：`from "…/stores/…"` 一次都不许出现。
    // 已知偏差：`require("@/stores/editor")` 或动态 import 里的字符串绕得过这道闸门——它挡的是
    // 「后人顺手加一个 store 依赖」，不是刻意规避。
    const source = PANEL_SOURCES["../ExportPanel.vue"] ?? "";
    expect(source.length).toBeGreaterThan(0);
    expect(/from\s+["'][^"']*\/stores\//.test(source)).toBe(false);
  });
});
```

- [ ] **步骤 2：跑面板用例，确认失败**

运行：`npx vitest run src/components/editor/__tests__/ExportPanel.test.ts`

预期：FAIL——`Failed to resolve import "@/components/editor/ExportPanel.vue"`（SFC 还没写）。
若报的是 `Failed to resolve import "@/services/exporter"`，那是**任务 3 未交付**，不是本步骤的预期失败：
先确认前置任务已提交，不要把任务 3 的活干在这里。

---

- [ ] **步骤 3：写实现 `src/components/editor/ExportPanel.vue`**

```vue
<script setup lang="ts">
// src/components/editor/ExportPanel.vue
//
// 导出面板（B4）：把**内存里的图纸**（含未保存的涂改）渲染成三类 PNG，逐张由用户手势保存。
// props 进、`close` 出。
//
// 三条纪律（契约 §2b / 规格 §10 / 计划任务 0 的 R-4 / R-5 / R-6）：
// 1. **本组件不 import 任何 store**：它拿到什么就画什么，「图纸是哪一份」由页面（唯一装配点）决定。
//    用例全程不建 pinia——任何 store 读取都会以「no active Pinia」在挂载期抛错，那是这条纪律的
//    运行时证明。
// 2. **plan 与逐项状态都由面板自持**（R-4）：页面只做接线，一行导出逻辑都不许下沉到页面里。
// 3. **逐项导出 = 一次用户手势**（R-5）：点一次 → 渲染该张 → **画布自检** → `canvasToBlob` →
//    立刻 `downloadBlob` → 显示预览（`<img>` 指向同一颗 blob 的 object URL）→ **即时释放画布**。
//    不做连续多下载、不做 zip、不做 Web Share；任何一项失败只写该项的状态与中文原因，
//    **不影响其他项**。
//
// 与 `core/render/*` 的分工：plan 只出像素位置与尺寸，渲染器只按位置画，
// 面板只管「建画布 → 画 → 自检 → 存 → 预览 → 释放」。导出**不乘 DPR**、
// **不经过 `renderPatternThumbnail`**（R-6）。
import { computed, ref, watch } from "vue";
import type { Palette } from "@/core/palette/types";
import type { ColorUsage } from "@/core/pattern/stats";
import type { Pattern } from "@/core/pattern/types";
import {
  SHEET_LABEL_MIN_CELL_PX,
  planLegend,
  planShare,
  planSheets,
  type SheetTilePlan,
} from "@/core/render/layout";
import { drawLegend, drawSheetTile, type SheetMeta } from "@/core/render/sheet";
import { drawShare } from "@/core/render/share";
import {
  assertCanvasPainted,
  canvasToBlob,
  createCanvasStrict,
  downloadBlob,
  exportFilename,
  requireContext2D,
  type ExportItemLabel,
} from "@/services/exporter";

const props = defineProps<{
  pattern: Pattern;
  palette: Palette;
  usages: readonly ColorUsage[];
  projectName: string;
  revision: number;
}>();

const emit = defineEmits<{ close: [] }>();

/* ------------------------------------------------------------------ 计划 */

/**
 * 三个 plan。**它们不依赖 `revision`**（2026-10-05 控制者裁定，契约 §2b 已明写）：
 * `planSheets` / `planShare` 的输入只有图纸的**尺寸**与色卡，`planLegend` 的输入只有 `usages`
 * ——**三个都不读 `cells`**，所以「编辑一格」不改变其中任何一个。在这里写 `void props.revision;`
 * 是惰性代码，还会让后人误以为 plan 依赖编辑（于是把「plan 没跟着变」当成 bug、去查错地方）。
 *
 * 需要跟着编辑失效的是**逐项状态**，见下面那个 `watch`。
 * 将来若真有一个 plan 开始读格值，必须**同时**改契约与这里——那是一次有意的口径变化，
 * 不是顺手加一行能解决的。
 */
const sheetPlan = computed(() => planSheets(props.pattern, props.palette));
const legendPlan = computed(() => planLegend(props.usages));
const sharePlan = computed(() => planShare(props.pattern));

/** 结构化提示 → 中文文案（core 只出事实，规格 §5.3 的分工）。 */
const labelsOmitted = computed(
  () => sheetPlan.value.warnings.find((warning) => warning.code === "labels-omitted") ?? null,
);

/* -------------------------------------------------------------- 计划摘要 */

const sheetSummary = computed(() => {
  const plan = sheetPlan.value;
  const tail =
    labelsOmitted.value === null
      ? "含格内色号"
      : `已省略格内色号（画布上限 ${labelsOmitted.value.maxEdge} px 太小）`;
  return `共 ${plan.tiles.length} 张 · 每片最多 ${plan.tileCols}×${plan.tileRows} 格 · ${plan.cellPx} px/格 · ${tail}`;
});

const legendSummary = computed(() => {
  const plan = legendPlan.value;
  return `用量表 · ${plan.itemCols} 列 × ${plan.itemRows} 行 · ${plan.canvasWidth}×${plan.canvasHeight} px`;
});

const shareSummary = computed(() => {
  const plan = sharePlan.value;
  return `分享图 · ${plan.canvasWidth}×${plan.canvasHeight} px（纯色块，无网格无文字）`;
});

/**
 * 全图颗数与用色数由 `usages` 派生：`patternStats` 的定义就是「`usages` 恰是非空格色号的计数、
 * `colorCount === usages.length`、`total === Σ count`」，所以这两行与它逐字等价，
 * 且不必在面板里为信息条再走一次 O(格数) 遍历（页面已经算过一遍，规格 §5.4 的分工）。
 */
const totalBeads = computed(() => props.usages.reduce((sum, usage) => sum + usage.count, 0));
const colorCount = computed(() => props.usages.length);

/** 渲染器只吃字符串、不读 `Date`（规格 §9 第 1 条），所以每次生成取一次就够。 */
function makeMeta(generatedAt: string): SheetMeta {
  return {
    projectName: props.projectName,
    generatedAt,
    totalBeads: totalBeads.value,
    colorCount: colorCount.value,
    paletteName: props.palette.name,
    accuracy: props.palette.accuracy,
  };
}

/* -------------------------------------------------------------- 逐项清单 */

interface ExportItem {
  readonly id: string;
  readonly label: string;
  readonly kind: "sheet" | "legend" | "share";
  readonly tileIndex: number;
  status: "idle" | "busy" | "done" | "error";
  error: string;
  previewUrl: string;
}

/**
 * 分片栅格的行数 / 列数。**从 `plan.tiles` 派生**，不写第二份 `ceil(height / tileRows)` 除法
 * （渲染器被明令禁止反推网格形状，面板这一层也不该再长出一份分片数学）。
 */
const tileRowCount = computed(() =>
  sheetPlan.value.tiles.reduce((max, tile) => Math.max(max, tile.rowIndex + 1), 0),
);
const tileColCount = computed(() =>
  sheetPlan.value.tiles.reduce((max, tile) => Math.max(max, tile.colIndex + 1), 0),
);

/** 片标签的形状由契约 §2b 逐字给定。 */
function tileLabel(tile: SheetTilePlan): string {
  return `施工图 第 ${tile.rowIndex + 1}/${tileRowCount.value} 行 第 ${tile.colIndex + 1}/${tileColCount.value} 列`;
}

/** 渲染顺序 = 用量表 → 分享图 → 施工图各片（契约 §2b）。 */
function makeItems(): ExportItem[] {
  const items: ExportItem[] = [
    {
      id: "legend",
      label: "用量表",
      kind: "legend",
      tileIndex: -1,
      status: "idle",
      error: "",
      previewUrl: "",
    },
    {
      id: "share",
      label: "分享图",
      kind: "share",
      tileIndex: -1,
      status: "idle",
      error: "",
      previewUrl: "",
    },
  ];
  for (const tile of sheetPlan.value.tiles) {
    items.push({
      id: `tile-${tile.index}`,
      label: tileLabel(tile),
      kind: "sheet",
      tileIndex: tile.index,
      status: "idle",
      error: "",
      previewUrl: "",
    });
  }
  return items;
}

/**
 * 面板自持的逐项状态。`ref` 会把数组元素也变成响应式代理，所以就地改 `item.status` 即触发重渲染。
 * `previewUrl` 是 `<img>` 的来源，也是**唯一**需要在复位时销号的资源。
 */
const items = ref<ExportItem[]>([]);

/** 丢掉一项的预览：**先销号再清空**（只清 URL 会漏掉 object URL 的引用计数）。 */
function revokePreview(item: ExportItem): void {
  if (item.previewUrl === "") return;
  URL.revokeObjectURL(item.previewUrl);
  item.previewUrl = "";
}

/**
 * 图纸一变就重建清单：所有逐项状态回 `idle`、预览一律销号后丢弃（规格 §10.1）。
 * 它比「面板打开时禁止编辑」更硬——不依赖 UI 是否真的挡住了每一个改动入口：撤销、`Ctrl+Z`、
 * 工具栏在面板之上都能改到 `cells`。
 *
 * 源是**两个**（契约 §2b 逐字规定，缺一不可）：
 * - `revision`：`cells` 原地写，只有它能让 `markRaw` 的图纸失效；
 * - `pattern` 的**对象身份**：`beginSession` 会把 `revision` 归零——从一张 `revision = 0` 的图纸
 *   换到另一张时（`/edit/a → /edit/b` 而面板恰好开着），0 → 0 那一跳**不触发**，
 *   单靠 `revision` 时清单会停在上一张图纸的片数与标签上。
 *
 * 顺序写成 `[revision, pattern]` 或 `[pattern, revision]` 都可以，**两个都必须在**：
 * 顺手删掉 `() => props.pattern` 是一条会被 `计划摘要` 那组用例抓住的静默错误（见步骤 12 的 M-rev-B）。
 */
function rebuildItems(): void {
  for (const item of items.value) revokePreview(item);
  items.value = makeItems();
}

watch([() => props.revision, () => props.pattern], rebuildItems);
rebuildItems();

/* ---------------------------------------------------------- 逐项导出 */

function statusText(item: ExportItem): string {
  if (item.status === "idle") return "待生成";
  if (item.status === "busy") return "生成中…";
  if (item.status === "done") return "已生成";
  return `失败：${item.error}`;
}

/**
 * 落盘 + 出预览。两步共用**同一颗 blob**：预览就是刚下载的那一份字节，不是重新渲染的第二份。
 *
 * 文件名的第三个实参**只在施工图上传**：契约 §3 明写「用量表 / 分享图**不带**分片序号」，
 * 传一个显式的 `undefined` 也是在把「非分片项」这条语义赌在实现读不读 `arguments.length` 上。
 */
async function downloadAndPreview(
  item: ExportItem,
  canvas: HTMLCanvasElement,
  label: ExportItemLabel,
  tile?: SheetTilePlan,
): Promise<void> {
  const blob = await canvasToBlob(canvas);
  const filename =
    tile === undefined
      ? exportFilename(props.projectName, label)
      : exportFilename(props.projectName, label, tile);
  downloadBlob(blob, filename);
  revokePreview(item);
  item.previewUrl = URL.createObjectURL(blob);
}

/**
 * 保存一项：**渲染该张 → 自检 → 立刻下载 → 显示预览**（R-5）。
 *
 * 逐项独立：状态与原因都写在这一项上，抛错不冒泡到别的项（规格 §10.3）。
 * `busy` 期间按钮禁用（模板），函数自己再挡一次连点——手势可能比下一帧更快。
 *
 * 渲染完成后的两步都是**规格 §9 的防线**，顺序不能动：
 * 1. `assertCanvasPainted(canvas)`（自检，`@/services/exporter` 的导出，生产消费者就是本面板）——
 *    **只在施工图与用量表**上做：它们左上角的 `(2, 2)` 落在 `SHEET_MARGIN = 24` 的**边距**里，
 *    一定被整张白底覆盖、且该处永远没有文字（§9 第 5 条要求采样点与图纸内容无关）。
 *    **分享图故意不调用它**：分享图是纯色块、空格透明的产物，`(2, 2)` 落在透明像素上完全合法，
 *    那张图没有「必定不透明」的采样点——给它加自检会把一张合法的全透明分享图判成失败。
 * 2. 自检必须在 `canvasToBlob` **之前**：反过来的话，一张「看起来正常」的白图已经落盘了才被发现。
 * 3. 画布在 `finally` 里即时释放（§9 第 6 条：内存峰值 = 一张画布），且**晚于** `toBlob`
 *    （提前释放＝拿着 0×0 的画布去 toBlob，生产上就是一张空图）；失败路径同样要释放。
 */
async function saveItem(item: ExportItem): Promise<void> {
  if (item.status === "busy") return;
  item.status = "busy";
  item.error = "";
  let canvas: HTMLCanvasElement | null = null;
  try {
    const meta = makeMeta(new Date().toLocaleString("zh-CN"));
    if (item.kind === "legend") {
      const plan = legendPlan.value;
      canvas = createCanvasStrict(plan.canvasWidth, plan.canvasHeight);
      drawLegend(requireContext2D(canvas), props.usages, plan, meta);
      assertCanvasPainted(canvas);
      await downloadAndPreview(item, canvas, "用量表");
    } else if (item.kind === "share") {
      const plan = sharePlan.value;
      canvas = createCanvasStrict(plan.canvasWidth, plan.canvasHeight);
      drawShare(requireContext2D(canvas), props.pattern, props.palette, plan);
      // **不调用 `assertCanvasPainted`**（理由见函数头）：分享图按设计是透明的。
      await downloadAndPreview(item, canvas, "分享图");
    } else {
      const plan = sheetPlan.value;
      const tile = plan.tiles[item.tileIndex];
      if (tile === undefined) {
        // 不可达：`tileIndex` 由本文件从 `plan.tiles` 里取。消息逐字照契约 §2b
        // （控制者裁定 11 定稿）。
        throw new Error(`施工图分片不存在：${item.id}`);
      }
      canvas = createCanvasStrict(tile.canvasWidth, tile.canvasHeight);
      drawSheetTile(requireContext2D(canvas), props.pattern, props.palette, plan, tile, meta);
      assertCanvasPainted(canvas);
      await downloadAndPreview(item, canvas, "施工图", tile);
    }
    item.status = "done";
  } catch (error) {
    item.status = "error";
    item.error = error instanceof Error ? error.message : String(error);
  } finally {
    // 逐张渲染、**即时释放**（规格 §9 第 6 条）：内存峰值 = 一张画布。
    // 放在 `finally`（不是 `try` 尾部）：失败路径也释放，否则一张失败的大画布会挂到下一次 GC。
    // 契约 §2 的 exporter 导出面里没有 release 函数（只有一个调用点，抽一个没人复用的函数正是
    // 本项目禁止的抽象），所以这一步落在面板里。
    if (canvas !== null) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
</script>

<template>
  <!--
    面板是一个**覆盖层**（控制者裁定 10）。`data-testid` 全部照契约 §2b 的清单，**不许另造名字**：
    根 `export-panel`、摘要 `export-summary-sheet` / `-legend` / `-share`、琥珀提示
    `export-warning-labels`、空图纸说明 `export-empty-note`、关闭 `export-close`、
    逐项 `export-item-*` / `export-save-*` / `export-preview-*`。
  -->
  <section data-testid="export-panel" class="fixed inset-0 z-30 overflow-y-auto bg-white p-4">
    <header class="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
      <h2 class="text-2xl font-bold text-slate-900">导出图纸</h2>
      <button
        data-testid="export-close"
        class="min-h-11 rounded border border-slate-300 px-4 text-base"
        @click="emit('close')"
      >
        关闭
      </button>
    </header>

    <!-- 计划摘要：纯计算，不建画布（规格 §10.2） -->
    <div class="mx-auto mt-3 max-w-3xl space-y-1">
      <p data-testid="export-summary-sheet" class="text-base text-slate-700">{{ sheetSummary }}</p>
      <p v-if="labelsOmitted" data-testid="export-warning-labels" class="text-base text-amber-700">画布上限只有 {{ labelsOmitted.maxEdge }} px，格内色号画不下（每格 {{ labelsOmitted.cellPx }} px，低于 {{ SHEET_LABEL_MIN_CELL_PX }} px）；建议减少豆数或改小图纸。</p>
      <p data-testid="export-summary-legend" class="text-base text-slate-700">{{ legendSummary }}</p>
      <p data-testid="export-summary-share" class="text-base text-slate-700">{{ shareSummary }}</p>
      <p v-if="usages.length === 0" data-testid="export-empty-note" class="text-base text-amber-700">这张图纸没有可拼的像素</p>
      <p class="text-base text-slate-500">手机上也可以长按下面的预览图存进相册。</p>
    </div>

    <!-- 逐项：一项一个「保存」，互不影响 -->
    <ul class="mx-auto mt-4 max-w-3xl space-y-3">
      <li
        v-for="item in items"
        :key="item.id"
        :data-testid="`export-item-${item.id}`"
        class="rounded border border-slate-200 p-3"
      >
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-base text-slate-900">{{ item.label }}</span>
          <button
            :data-testid="`export-save-${item.id}`"
            :disabled="item.status === 'busy'"
            class="min-h-11 rounded bg-slate-900 px-6 text-base text-white disabled:opacity-50"
            @click="saveItem(item)"
          >
            保存
          </button>
          <span class="text-base text-slate-600">{{ statusText(item) }}</span>
        </div>
        <img
          v-if="item.previewUrl !== ''"
          :data-testid="`export-preview-${item.id}`"
          :src="item.previewUrl"
          alt="导出预览"
          class="mt-2 max-h-64 rounded border border-slate-200"
        />
      </li>
    </ul>
  </section>
</template>
```

- [ ] **步骤 4：跑面板用例，确认通过**

运行：`npx vitest run src/components/editor/__tests__/ExportPanel.test.ts`

预期：PASS（本文件全部用例绿）。若有失败，先按下面四条自查，再怀疑实现：
① 摘要里的数字（`3948×230` / `256×128` / `2000×2000` / `116×116` / `40` / `33`）都是按规格 §5.2
的算法**手算过的**，与本片段不一致时以重算为准并把结论写进报告；
② `labels-omitted` 那条必须**先**跑前提断言（`realPlan.labels === true`）再看桩的效果；
③ `待生成 / 生成中… / 已生成` 的判据是**项内文本**（`export-item-<id>`），不是整页文本；
④ 顺序表 `steps` 的期望形状是每次保存各一段 `["selfcheck", "toBlob", "release:width", "release:height"]`
（分享图那一段没有 `selfcheck`）——它是「自检早于 `toBlob`、释放晚于 `toBlob`」的**唯一**判据，
出现别的顺序说明实现把某一步挪了位置。

---

- [ ] **步骤 5：工具栏只加一个按钮与一个事件（`PatternToolbar.vue` + 它的用例）**

**改 1（第 41 行）**：`src/components/editor/PatternToolbar.vue` 的 `defineEmits` 里，在 `save: [];` 之后追加一行：

```ts
  export: [];
```

改完后那一段应为（**其余 emits 一行不动**）：

```ts
const emit = defineEmits<{
  "update:tool": [EditorTool];
  undo: [];
  redo: [];
  "update:showGrid": [boolean];
  "update:showLabels": [boolean];
  fit: [];
  "zoom-in": [];
  "zoom-out": [];
  save: [];
  export: [];
}>();
```

**改 2（第 127 行之后、第 129 行之前）**：在 `editor-dirty` 的 `</span>` 与 `editor-save` 的
`<button>` 之间插入：

```html
    <!--
      导出入口（B4）：**只加这一个按钮与一个 `export` 事件**——既有 props / 事件的语义一行不动。
      面板由 `EditorPage` 渲染（唯一装配点），本组件只知道「用户点了导出」。
      文案与类名照契约 §2b：`min-h-11`（= 44px，与工具栏其余按钮同口径）、`text-base`（= 16px）。
    -->
    <button
      data-testid="export"
      class="min-h-11 rounded border border-slate-300 px-4 text-base"
      @click="emit('export')"
    >
      导出
    </button>
```

**改 3**：`src/components/editor/__tests__/PatternToolbar.test.ts` 文件末尾**追加**（既有一行都不动）：

```ts
describe("导出入口", () => {
  // 契约 §2b / 规格 §13.1：工具栏**只加**一个 `export` 事件与一颗按钮，既有语义不动。
  //
  // 尺寸类名也在这里断：既有的「所有按钮的触控目标 ≥44px、字号 ≥16px」用例的 testid 清单是
  // **硬编码的**，而它属于「既有断言，一行不许改」——新增的这颗按钮否则没有任何尺寸类断言。
  // （控制者裁定 5 采纳本处置；把新按钮加进那条清单需要改既有断言，如实记为**延后 Minor**，
  //   见报告清单第 8 条。）
  it("点导出按钮 emit 一次空载荷的 export，且触控目标 ≥44px、字号 ≥16px", async () => {
    const wrapper = mountToolbar();
    const button = wrapper.get("[data-testid='export']");
    expect(button.text()).toContain("导出");
    expect(button.classes()).toContain("min-h-11"); // 2.75rem = 44px
    expect(button.classes()).toContain("text-base"); // 1rem = 16px

    await button.trigger("click");
    // 断言的是**载荷**：`toEqual([[]])` 同时钉住「只 emit 一次」与「是空载荷」
    expect(wrapper.emitted("export")).toEqual([[]]);
    // 串台守卫：复制粘贴漏改事件名（emit `save`）时这里红
    expect(wrapper.emitted("save")).toBeUndefined();
  });
});
```

- [ ] **步骤 6：跑工具栏用例，确认通过**

运行：`npx vitest run src/components/editor/__tests__/PatternToolbar.test.ts`

预期：PASS。既有 **13** 条 + 新增 1 条全绿——**既有断言一行都没改**（`git diff` 里该文件只有 `+`，没有 `-`）。
（13 是回原始清单数的：`Select-String -Path src/components/editor/__tests__/PatternToolbar.test.ts -Pattern "\bit\("`。
实测新数字时用同一条命令重数，不要引用本句。）

---

- [ ] **步骤 7：`EditorPage.vue` 只做接线（四处插入）**

**插入 1（第 20 行之前）**——保持 components 组的字母序：

```ts
import ExportPanel from "@/components/editor/ExportPanel.vue";
```

**插入 2（第 75 行 `const allowLeave = ref(false);` 与其后那行空行之后）**：

```ts
/**
 * 导出面板是否打开（规格 §10.1）。
 *
 * **页面只做接线**（R-4）：plan、逐项状态、渲染与下载都在 `ExportPanel` 里。页面给它的三样东西是
 * 「内存态图纸 + 页面已有的 usages + 失效通道 revision」——`usages` 直接复用上面那个 computed，
 * 面板因此不必再走一遍 O(格数) 的 `patternStats`（规格 §5.4 的分工）。
 */
const exporting = ref(false);
```

**插入 3（第 547 行 `@save="onCommand('save')"` 之后，仍在 `<PatternToolbar …>` 里）**：

```html
            @export="exporting = true"
```

改完后那段 `<PatternToolbar>` 的监听器块应为（**其余一行不动**）：

```html
            @fit="onCommand('fit')"
            @zoom-in="onCommand('zoom-in')"
            @zoom-out="onCommand('zoom-out')"
            @save="onCommand('save')"
            @export="exporting = true"
```

**插入 4（第 614 行 `</main>` 之前，也就是模板末尾）**：

```html
    <!--
      导出面板（规格 §10.1）。图纸来源恒为 `editor.pattern`（**内存态**，含未保存改动）——
      不读落盘记录里的任何字段，导出也不触发保存。

      `v-if` 必须**同时**要求 `editor.pattern` 存在（契约 §2b）：少了后半句，图纸还没载入时
      面板会在渲染期抛错（`:pattern` 拿到 null）。除此之外不新增别的门。
    -->
    <ExportPanel
      v-if="exporting && editor.pattern !== null"
      :pattern="editor.pattern"
      :palette="palette"
      :usages="usages"
      :project-name="session.record?.meta.name ?? '图纸'"
      :revision="editor.revision"
      @close="exporting = false"
    />
```

- [ ] **步骤 8：页面用例（一）——面板的出现 / 关闭 与 `usages` 的接线**

`src/views/__tests__/EditorPage.test.ts`：

**插入 A（第 75 行、`vi.mock("vue-router", …)` 那一块的 `}));` 之后）**：

```ts
/**
 * 导出面板的平台边界（任务 4）：`@/services/exporter` 的五个碰平台的函数换成替身，
 * `exportFilename` 用**真实现**（文件名的逐字格式是任务 3 用例的事）。
 *
 * 为什么不 mock `@/core/render/*`：规格 §13.2 第 1 条要的判据是「`drawSheetTile` **收到的该格
 * `fillRect` 颜色**是新色」——只有让真渲染器跑在下面这个记录型 target 上，`cellBox → fillRect`
 * 这条链才真的被走过（happy-dom 的 canvas 没有像素语义，CONTRACT §5.1）。
 */
const exporter = vi.hoisted(() => ({
  createCanvasStrict: vi.fn<(width: number, height: number) => HTMLCanvasElement>(),
  requireContext2D: vi.fn<(canvas: HTMLCanvasElement) => RenderTarget2D>(),
  // 面板也会调它（施工图 / 用量表；分享图按设计不调）：这里是**空实现**，
  // 「在哪一项上调用、顺序如何」由 `ExportPanel.test.ts` 用顺序表钉住。
  assertCanvasPainted: vi.fn<(canvas: HTMLCanvasElement) => void>(),
  canvasToBlob: vi.fn<(canvas: HTMLCanvasElement) => Promise<Blob>>(),
  downloadBlob: vi.fn<(blob: Blob, filename: string) => void>(),
}));

vi.mock("@/services/exporter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/exporter")>();
  return { ...actual, ...exporter };
});

interface FillCall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fillStyle: string;
}

interface RecordingTarget {
  readonly target: RenderTarget2D;
  readonly fills: readonly FillCall[];
}

/** 记录型绘制目标：`RenderTarget2D` 的普通对象桩 + `fillRect` 记录（不碰 happy-dom 的 canvas）。 */
function createRecordingTarget(): RecordingTarget {
  const fills: FillCall[] = [];
  const target: RenderTarget2D = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "center",
    textBaseline: "middle",
    imageSmoothingEnabled: false,
    fillRect: (x, y, w, h) => {
      fills.push({ x, y, w, h, fillStyle: target.fillStyle });
    },
    strokeRect: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    fillText: () => undefined,
    save: () => undefined,
    restore: () => undefined,
  };
  return { target, fills };
}

/**
 * object URL 的桩：happy-dom 下这两个方法**可能不存在**（CONTRACT §5.2），所以不用 `vi.spyOn`；
 * 也**不整替 `URL` 全局**（它的构造函数还有别的用途）。
 */
function stubObjectUrl(): void {
  const target = URL as unknown as {
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
  };
  let seq = 0;
  target.createObjectURL = () => {
    seq += 1;
    return `blob:page-${seq}`;
  };
  target.revokeObjectURL = () => undefined;
}
```

**插入 B（文件末尾）**：

```ts
// ---------------------------------------------------------------------------
// 新增（任务 4）：导出面板的接线与端到端
//
// 面板自己持有 plan 与逐项状态（契约 §2b / 规格 §10），页面只做三件事：`exporting` 开关、
// 把**内存态**图纸与页面已有的 `usages` 传下去、`@close` 关掉。下面三条用例把这三件事各钉一条，
// 第三条就是规格 §13.2 第 1 条（「导出旧图」的判别性用例）。
// ---------------------------------------------------------------------------

describe("导出面板接线（任务 4）", () => {
  let recording: RecordingTarget;

  beforeEach(() => {
    recording = createRecordingTarget();
    exporter.createCanvasStrict
      .mockReset()
      .mockImplementation((width, height) => ({ width, height }) as unknown as HTMLCanvasElement);
    exporter.requireContext2D.mockReset().mockImplementation(() => recording.target);
    exporter.assertCanvasPainted.mockReset();
    exporter.canvasToBlob
      .mockReset()
      .mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    exporter.downloadBlob.mockReset();
    stubObjectUrl();
  });

  it("点「导出」→ 面板出现；点「关闭」→ 回编辑态（图纸与编辑态都没被丢掉）", async () => {
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='export-panel']").exists()).toBe(false);

    await wrapper.get("[data-testid='export']").trigger("click");
    expect(wrapper.find("[data-testid='export-panel']").exists()).toBe(true);
    // 面板真的被挂起来了（不是空壳）：组件实例在，标题也在
    expect(wrapper.findComponent(ExportPanel).exists()).toBe(true);
    expect(wrapper.get("[data-testid='export-panel']").text()).toContain("导出图纸");

    await wrapper.get("[data-testid='export-close']").trigger("click");
    expect(wrapper.find("[data-testid='export-panel']").exists()).toBe(false);
    // 「回编辑态」不是把页面卸载重建：画布、工具栏与图纸都原样还在
    expect(wrapper.find("[data-testid='editor-canvas']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='tool-brush']").exists()).toBe(true);
    expect(Array.from(useEditor().pattern?.cells ?? [])).toEqual([0, EMPTY]);
  });

  it("面板的 `usages` 跟着图纸走：全空图纸如实说明，涂一格之后那句话消失", async () => {
    // 夹具：**全空**的 2×1 → `patternStats` 的 usages 为空（`EditorPage` 的 `usages` 就是它）
    const doc = toProjectDocument(
      { width: 2, height: 1, paletteId: palette.id, cells: Uint16Array.from([EMPTY, EMPTY]) },
      palette,
      { longSide: 2, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
    );
    const store = await createMemoryProjectStore();
    await store.put({
      meta: {
        id: "a",
        name: "小猫",
        createdAt: "2026-10-03T00:00:00.000Z",
        updatedAt: "2026-10-03T01:00:00.000Z",
        thumbnail: "",
        width: 0,
        height: 0,
        colorCount: 0,
      },
      doc,
      source: null,
    });
    setProjectStore(store);

    const wrapper = await mountPage();
    await wrapper.get("[data-testid='export']").trigger("click");
    expect(wrapper.get("[data-testid='export-empty-note']").text()).toBe("这张图纸没有可拼的像素");

    // 涂一格：`patternStats().usages` 从空变成 1 项——面板那一行必须跟着消失（`:usages` 的接线）。
    // 少了 `:usages` 这一条 props 的实时性，面板会一直说「没有可拼的像素」（不报错、只是撒谎）。
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [0, 0], [0, 0]);
    expect(wrapper.find("[data-testid='export-empty-note']").exists()).toBe(false);
  });
});
```

- [ ] **步骤 9：页面用例（二）——规格 §13.2 第 1 条的端到端**

在刚追加的 `describe("导出面板接线（任务 4）", …)` **内部**、`usages` 那条之后，再加一条：

```ts
  it("端到端（规格 §13.2-1）：改一格 → 导出施工图 → 渲染器收到的该格是新色，不是落盘记录里的旧值", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    const pattern = editor.pattern;
    if (pattern === null) throw new Error("载入失败：编辑器还没有图纸");
    const paintedColor = palette.colors[2];
    if (paintedColor === undefined) throw new Error("色卡至少要有三色");

    // 起点：(1,0) 是**空格**。涂成 2 号色 ⇒ 内存态与落盘记录从这一刻起不一致。
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    expect(Array.from(pattern.cells)).toEqual([0, 2]);
    // **夹具的判别力**：存储里那一格仍是旧的 EMPTY。少了这一句，「渲染器收到新色」与
    // 「新旧两份恰好一样」不可区分——M14 变异会照样绿。
    expect(storedCells(await getProjectStore().get("a"))).toEqual([0, EMPTY]);

    await wrapper.get("[data-testid='export']").trigger("click");
    await wrapper.get("[data-testid='export-save-tile-0']").trigger("click");
    await flushPromises();

    // 判据 = 渲染器**实际收到的**那一格 `fillRect` 的颜色（规格 §13.2 第 1 条逐字）。
    // 计划与坐标都由真 core 现算：单张施工图的 tile 覆盖全图，`(1,0)` 的片内像素由 `cellBox` 给出。
    const plan = planSheets(pattern, palette);
    const tile = plan.tiles[0];
    if (tile === undefined) throw new Error("施工图计划没有分片");
    const box = cellBox(tile, 1, 0);
    const painted = recording.fills.filter(
      (fill) => fill.x === box.x && fill.y === box.y && fill.w === box.width && fill.h === box.height,
    );
    // 期望值**不用 `rgbCss` 现算**（那是被测口径之一）：直接拼出契约 §2 的序列化形状
    expect(painted.map((fill) => fill.fillStyle)).toEqual([
      `rgb(${paintedColor.rgb[0]}, ${paintedColor.rgb[1]}, ${paintedColor.rgb[2]})`,
    ]);
    // 那一格只被画一次；M14（数据源换成落盘图纸）下它是空格 ⇒ 这里**一格都没有**
    expect(painted).toHaveLength(1);
  });
```

同时在该文件顶部的 import 区**追加**三行（**既有 import 一行不动**）：

```ts
import ExportPanel from "@/components/editor/ExportPanel.vue";
import { cellBox, planSheets } from "@/core/render/layout";
import type { RenderTarget2D } from "@/core/render/types";
```

（第三行合并进既有 import 块也可以；`ExportPanel` 放在既有 `PatternToolbar` 那两行之后即可。）

- [ ] **步骤 10：跑三处用例，确认通过**

```bash
npx vitest run src/components/editor/__tests__/ExportPanel.test.ts src/components/editor/__tests__/PatternToolbar.test.ts src/views/__tests__/EditorPage.test.ts
```

预期：三个文件全绿（编辑器页面既有 **43** 条 + 新增 3 条；工具栏既有 **13** 条 + 新增 1 条；面板新增的全部）。
两个既有条数都是回原始清单数的（`Select-String -Pattern "\bit\("`），实测时用同一条命令重数。
任一既有用例转红都说明接线改坏了既有行为——**不许改既有断言去迁就实现**，先查自己的插入位置。

---

- [ ] **步骤 11：变异实测 M14（规格 §13.3：把面板的数据源换成落盘的那份图纸）**

**这一步只改一行两处、跑完必须还原。红数不许预估，实跑后回填。**

动作（`src/views/EditorPage.vue`）：
① `<script setup>` 里补 `import { fromProjectDocument } from "@/core/project/file";`，并在 `exporting` 附近加一个临时的 computed：

```ts
const stalePattern = computed(() => {
  const record = session.record;
  if (record === null) {
    if (editor.pattern === null) throw new Error("没有图纸");
    return editor.pattern;
  }
  return fromProjectDocument(record.doc, palette).pattern;
});
```

（写成 `Record | null` 的三元会让 `:pattern="stalePattern"` 在 `vue-tsc` 下报 `Pattern | null` 不可赋值；
本步骤只跑 `vitest`，但**顺手让它类型干净**能避免把「变异跑不起来」误当成「变异 0 红」。）

② 模板里 `:pattern="editor.pattern"` → `:pattern="stalePattern"`。

运行：`npx vitest run src/views/__tests__/EditorPage.test.ts`

该红的断言：`导出面板接线（任务 4）` 里那条 `端到端（规格 §13.2-1）…`——它读的是渲染器**实际收到的**
那一格 `fillRect`；旧图纸上那一格是空格，所以 `painted` 是空数组，两条断言（`toEqual([rgb(...)])` 与
`toHaveLength(1)`）都应转红。**回填实测红数与失败点标题**（红数可能是 1，也可能是 2——取决于
vitest 是在第一条断言就中止该用例，实跑回填）。

还原与复核：

```bash
git checkout -- src/views/EditorPage.vue
npx vitest run src/views/__tests__/EditorPage.test.ts
```

预期：回到全绿。（若 `git checkout` 之后你的步骤 7 改动丢了，说明改动没提交——先确认这一点再继续。）

> **与规格字面的偏差，如实记录**：规格 §13.3 的 M14 写作「`EditorPage` 的数据源换成 `session.record`」。
> 这一动作**在本契约下不可直接执行**：`ProjectRecord` 里没有 `pattern` 字段，而 `session.pattern` 与
> `editor.pattern` 是**同一个对象**（既有用例 `expect(editor.pattern).toBe(session.pattern)` 已钉死）。
> 「旧图」只能由落盘 doc 解出来，所以本步骤用的是它的等价形态（控制者裁定 6 已采纳）。

- [ ] **步骤 12：变异实测——逐项状态的失效通道（三个变体）**

> 契约 §2b 定稿后的形态：**plan 不依赖编辑**（三个 plan 都是普通 `computed`，里面不写 `void props.revision;`），
> 需要失效的是**逐项状态**，靠 `watch([() => props.revision, () => props.pattern], rebuildItems)`。
> 所以这里的三个靶子全部打在这条 watch 上（而不是打在 plan 上）。

**M-rev-A：整条 `watch(...)` 删掉**

动作（`src/components/editor/ExportPanel.vue`）：删掉

```ts
watch([() => props.revision, () => props.pattern], rebuildItems);
```

运行：`npx vitest run src/components/editor/__tests__/ExportPanel.test.ts`

该红的断言：
- `逐项导出：一次手势一张（…）` → `改一格（revision 变）⇒ 所有「已生成」复位为「待生成」，预览销号后丢弃`（状态不复位、预览不销号）；
- `计划摘要（…）` → `换 plan（同一个实例）后摘要与逐项清单都跟着走，片标签是 2/2`（`items` 不重建，`export-item-tile-3` 不存在）。

**回填实测红数与失败点标题。**

**M-rev-B：把 `watch` 的源改成只有 `revision`（删掉 `() => props.pattern`）**

```ts
watch(() => props.revision, rebuildItems);   // ← 变异：少了 pattern 的对象身份
```

运行：同一条命令。

该红的断言：`计划摘要（…）` → `换 plan（同一个实例）后摘要与逐项清单都跟着走，片标签是 2/2`——
那条用例**只换 `pattern`、不动 `revision`**（正是 `beginSession` 把 0 归零的那一跳），
清单不重建 ⇒ `export-item-tile-3` 不存在、`export-item-tile-0` 的标签仍是 `第 1/1 行 第 1/1 列`。
**回填实测红数。**

> 说明：本变体替换了原来的「删掉三个 `void props.revision;`」——那三行已按控制者裁定**从实现里删除**
> （契约 §2b：plan 不依赖编辑），所以它不再是一个可执行的变异。新变体才是**能真正判别**的靶子
> （它证明「两个 watch 源都必须在」，而不是证明一行惰性代码没效果）。

**M-check-A：把 `assertCanvasPainted(canvas)` 挪到 `await downloadAndPreview(…)` 之后**（两处都挪）

运行：`npx vitest run src/components/editor/__tests__/ExportPanel.test.ts`
该红的断言：`渲染完先自检、再 toBlob…` 那条的**顺序表**（`steps` 会变成 `["toBlob", "selfcheck",
"release:width", "release:height"]`）。**回填实测红数。**

**M-check-B：删掉施工图分支里那句 `assertCanvasPainted(canvas);`**

运行：同一条命令。
该红的断言：`渲染完先自检…` 那条的 `toHaveBeenCalledTimes(2)`（施工图那一项不再自检）。
**回填实测红数。**

**M-release：把释放的两行从 `finally` 挪进 `try` 的末尾（成功路径照旧、失败路径不再释放）**

运行：同一条命令。
该红的断言：`逐张渲染后即时释放画布…` 那条的**失败半段**（`canvases[0].writes` 变成空数组，
即「失败也释放」这句话被证伪）。**回填实测红数。**

还原所有变体：

```bash
git checkout -- src/components/editor/ExportPanel.vue
npx vitest run src/components/editor/__tests__/ExportPanel.test.ts
```

预期：全绿。

- [ ] **步骤 13：全量验证**

```bash
npm run test
$env:TZ="UTC"; npm run test
npm run build
```

预期：全绿；`npm run build` 通过（新 SFC 与三个用例文件都被 `vue-tsc` 检查——注意本项目开了
`noUnusedLocals` / `noUnusedParameters`，测试文件也在检查范围内）。

- [ ] **步骤 14：Commit**

```bash
git add src/components/editor/ExportPanel.vue src/components/editor/__tests__/ExportPanel.test.ts src/components/editor/PatternToolbar.vue src/components/editor/__tests__/PatternToolbar.test.ts src/views/EditorPage.vue src/views/__tests__/EditorPage.test.ts
git commit -m "feat(editor): 导出面板与内存态图纸接线"
```

---

**报告必须包含**（这是控制者复核的输入，缺一条就要返工）：

1. `git status` / `git show --stat HEAD` 的尾巴——**六个文件**，且 `PatternToolbar.test.ts` /
   `EditorPage.test.ts` 的 diff 里 **只有 `+`**（既有断言一行未改）；
2. 步骤 2 的失败原文（证明是测试先行的：失败原因是 SFC 不存在，而不是「测试写错」）；
3. 步骤 4 / 6 / 10 三条聚焦命令的**原始输出尾巴**（文件数 / 用例数 / 耗时）；
4. 步骤 13 三条命令的**原始输出尾巴**（`npm run test` 与 `TZ=UTC` 各一遍的用例总数、`npm run build` 结果）；
5. **实测红数与失败点标题**：M14（步骤 11）、M-rev-A、M-rev-B、M-check-A、M-check-B、M-release（步骤 12）
   逐条回填。**不许预估**。（原 M-rev-B「删掉三个 `void props.revision;`」已随控制者裁定作废——
   那三行已从实现里删除；现行 M-rev-B 是「watch 源里删掉 `() => props.pattern`」，**它有判别力**。）
6. **控制者补充的两条**的证据：`assertCanvasPainted` 在施工图 / 用量表上各调一次、分享图**零次**
   （`ExportPanel.test.ts` 的 `渲染完先自检、再 toBlob…` 那条），以及即时释放的成功 / 失败两条路径
   （`逐张渲染后即时释放画布…` 那条，含 `steps` 顺序表）；
7. **`data-testid` 全部照契约 §2b 清单**的核对结果（`export-panel` / `export-summary-*` /
   `export-warning-labels` / `export-empty-note` / `export-close` / `export-item-*` / `export-save-*` /
   `export-preview-*`）：面板与三处用例**都不再用文案当定位器**；页面用例只剩一处
   `findComponent(ExportPanel).exists()`，它断言的是「组件真的被挂起来了」（不是文案定位）。
8. **延后 Minor（如实记录，不修）**：既有那条「所有按钮的触控目标 ≥44px、字号 ≥16px」用例的
   testid 清单是**硬编码**的（`tool-*` / `undo` / `redo` / `toggle-*` / `zoom-*` / `editor-save`），
   且属于「既有断言一行不许改」⇒ 新增的 `export` 按钮**不在它的覆盖内**。本片段把类名断言并进了
   新增的那一条用例（控制者裁定 5 采纳）；把它加进那条清单需要改既有断言，属**延后 Minor**，
   由控制者决定何时做（做了要同时更新那条用例的标题或注释，否则「所有按钮」这句话是失实的）；
9. `EditorPage.vue` 改动后的**实际行数**。**计数命令用这一条**：

   ```powershell
   @([System.IO.File]::ReadLines("src/views/EditorPage.vue")).Length
   ```

   **不要用 `(Get-Content …).Count`**：本机实测它会**少算**（本仓库的 `EditorPage.vue` 实际 615 行，
   `Get-Content .Count` 报 519；本片段自身 1547 行，它报 **1333**）。控制者已把这条工具陷阱记进账本
   （与 B3 的「`Set-Content -Encoding utf8` 仍写 BOM」同类：**工具的输出不能直接当证据**）。
   本片段的估算是 **615 + 28 ≈ 643 行**（`import` 1 + `exporting` 与其 JSDoc 约 10 + `@export` 1 +
   模板尾块约 16）。**未超过 800 行**，因此不触发「第二个消费者」原则的裁决；
   若实测超过 800，如实报告并提请控制者裁决（**不许**擅自抽 composable）；
10. 与契约 / 本片段不符之处，以及处置（不许自行发明名字）；
11. `## 控制者裁定记录` 里每一条的落实结果。

---

---

## 任务 5：`/lab/canvas` 探针页（R2 真机实测装置）与路由用例

**文件：**
- 创建：`src/views/CanvasLabPage.vue`
- 创建：`src/views/__tests__/CanvasLabPage.test.ts`
- 修改：`src/router/index.ts`（在现有 `:15` 的 `/lab/decode` 那一行之后**只加一行**）
- 修改：`src/router/__tests__/index.test.ts`（文件头 `:1-4` 的 import 区加一行；文件末尾 `:56-58` 之后**只加一条用例**）

**为什么这个任务独立成立：** `EXPORT_MAX_EDGE`（`core/render/layout.ts`）是全计划唯一的平台相关常量，它的依据是主规格 §12 的 **R2**（Android WebView 的 canvas 单边 / 面积上限具体值），而 R2 **只能真机实测**——取大了会得到一张静默的白图（B4-R2），取小了会白白多出几十片。这一页就是那台仪器：与 `/lab/decode` 同形（一个只给开发者的实验台，路由存在、**不进任何用户入口**），把「写进去的尺寸 / 读回来的尺寸 / 有没有 2D 上下文 / 能不能读回填进去的颜色」四件事逐档如实列出来，并给一个「复制为文本」按钮，便于把真值贴回来。**R-7 的边界必须写死在页面与用例里**：它是开发期实验台，后人不得把它当功能页维护。

**动手前先读：**
1. `src/views/DecodeLabPage.vue` 与 `src/views/__tests__/DecodeLabPage.test.ts` —— **同形**的样板：页面结构（`<script setup>` + 顶部说明段 + 一个执行按钮 + 结果区）、组件用例的桩法（`vi.spyOn(document, "createElement")` 换假画布、`vi.stubGlobal`、`vi.waitFor` / `flushPromises`、`afterEach` 里 `vi.restoreAllMocks()`）。**不要**另起一套页内约定。
2. B4 规格 **§11**（探针页的测量规程，逐字：档位梯、每档三个判据、二分 8 次、结果回写）、**§13.4**（「真实 canvas 上限」在 CI 里只能测「探针页把读数渲染成表格」）、**§14 清单 3**（手机打开 `/lab/canvas` 记录真值）、**§16 的 B4-R1/B4-R2**、计划 **任务 0 的 R-7**。
3. `src/router/index.ts` 全文（17 行）与 `src/router/__tests__/index.test.ts` 全文（59 行）——**路由用例钉的是什么**：只断言 `name` / `path` 挡不住「`component` 指向别的页面」（懒加载器不会因为 `resolve` 就被调用），所以既有 `/new`、`/new/setup` 两条都把 loader 跑一次做**恒等**比较。新用例照这个写。
4. `src/__tests__/coreBoundary.test.ts` 的 `FORBIDDEN_GLOBALS` —— 本任务是唯一会碰 `document.createElement("canvas")` 的新代码，但它在 `src/views/`，**不在闸门扫描范围内**；**不要**为了让探针「走 core」而往 `src/core/**` 里加任何东西（`RenderTarget2D` 是渲染器的接口，探针页直接用 DOM，两者不相干）。

---

### 测量规程（**逐字照 B4 规格 §11**，实现时不许改写口径）

- **两件事是独立的平台参数**：
  1. **单边上限**：固定短边为 **64**，长边走档位梯
     `1024, 1280, 1536, 1792, 2048, 2560, 3072, 3584, 4096, 5120, 6144, 8192, 10240, 12288, 16384, 24576, 32768`（≈1.25× 递进），共 **17** 档；
  2. **面积上限**：**正方形**走同一条梯。
- 每档**三个判据（缺一不可，因为「写成功」不等于「能用」）**：
  - `canvas.width === 写入值`（未被钳制）；
  - `getContext("2d") !== null`；
  - 填色后 `getImageData(角落 1×1)` 能读回**写入的颜色**（可读回 ⇒ 画布真的可用）。
- 每档取「**最后一个三项判据全部通过**的档位」作**下界**、它的**下一档**作**上界**，在下界与上界之间**二分 8 次**，报告收敛后的**最大通过值**；**两个方向的报告值都要有**。
- 结果回写：`EXPORT_MAX_EDGE`（取实测单边与面积上限下的**最保守值，向下取整到 2 的幂**）、主规格 §12 的 **R2** 行、B4 规格 §16 的 **B4-R1**（三处落点的回写规程在任务 6 的步骤 1 / 步骤 2）。

### 诚实边界（**必须写进页面文案、用例头注释与实现报告**）

1. **CI 只能测「页面把给定的读数渲染成表格与结论文案」**（规格 §13.4）。真实上限、真实像素语义、真实钳制形态**只能在手机上跑**（§14 清单 3）——happy-dom 的 canvas 是桩（`getImageData` 无真实语义、`toDataURL` 返回空载荷）。
2. **页面必须把「这一档是通过还是被钳制」如实显示**，判定列区分 **通过 / 被钳制 / 无 2D 上下文 / 像素读不回**；**不许把 `getContext` 返回 `null` 当成通过**，也不许在「尺寸被钳制」时读一个别的尺寸的像素来充当读数。
3. **没有区间时不许外推**：第一档就不过 ⇒ 结论写「没有可收敛的下界，二分未执行」；17 档全过 ⇒ 结论写「上界未触及，二分未执行」。这两种情况都**不得**编造一个收敛值。
4. 档位梯**扫完全部 17 档、不做提前退出**（上限是单调阈值时提前退出与扫完等价；扫完能如实暴露非单调读数，代价是几档必然失败的尝试）。每档测完**立刻释放画布**（`width = height = 0`）。
5. **页首自标的措辞**：把计划 R-7 的字面「开发期实验台；**CI 不测**」与 B4 规格 §11 已改后的澄清句「**真实上限只能真机测，CI 只测这张表怎么渲染**」写进**同一句**（控制者裁定 9：规格 §11 已同步改掉那半句，两处不许再读起来像整页零覆盖）。本片段的 `lab-notice` 就是这两半的合并，用例同时断言「CI 不测」与「CI 只测」。

---

- [ ] **步骤 1：写探针页 `src/views/CanvasLabPage.vue`**

```vue
<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

/**
 * `/lab/canvas` 探针页（B4 规格 §11 / 裁决 4）：测量本机 canvas 的**单边上限**与**面积上限**。
 *
 * **为什么要有这一页**：主规格 §12 的 R2（Android WebView 的 canvas 单边 / 面积上限具体值）只能真机实测，
 * 而它是 `core/render/layout.ts` 的 `EXPORT_MAX_EDGE` 的唯一依据——取大了会得到一张静默的白图
 * （B4-R2），取小了会白白多出几十片。
 *
 * **R-7：这是开发期实验台**。它只在路由表里存在、**不进任何用户入口**；页面自标「开发期实验台；CI 不测」。
 * `src/views/__tests__/CanvasLabPage.test.ts` 只覆盖**「给定的读数 → 表格与结论文案」这一段渲染**：
 * 真实上限、真实像素语义、真实钳制行为都测不到（happy-dom 的 canvas 是桩，规格 §13.4）。
 *
 * **判定口径（不许放宽）**：每档三个判据缺一不可——写回值一致 / 有 2D 上下文 / 填色后能读回写入的颜色；
 * 判定列按判据顺序取**第一个不通过的**，如实区分「被钳制 / 无 2D 上下文 / 像素读不回 / 通过」。
 * `getContext` 返回 `null` **不是通过**；尺寸被钳制时**不读**像素（读了也是别人的像素）。
 *
 * **没有区间时不外推**：第一档就不过 ⇒ 写「没有可收敛的下界，二分未执行」；17 档全过 ⇒ 写
 * 「上界未触及，二分未执行」。
 */

/** 单边上限方向的短边（规格 §11：固定短边为 64）。 */
const SHORT_EDGE = 64;

/** 二分次数（规格 §11）。 */
const BISECT_STEPS = 8;

/** 档位梯（规格 §11 逐字抄录，≈1.25× 递进；**改这里就等于改测量规程**）。 */
const LADDER = [
  1024, 1280, 1536, 1792, 2048, 2560, 3072, 3584, 4096, 5120, 6144, 8192,
  10240, 12288, 16384, 24576, 32768,
] as const;

type Direction = "edge" | "area";
type Stage = "ladder" | "bisect";
type Verdict = "pass" | "clamped" | "no-context" | "pixel-mismatch";

/** 两个方向（规格 §11：单边与面积都要有报告值）。 */
const DIRECTIONS: readonly Direction[] = ["edge", "area"];

/**
 * 探针色：三个分量互不相等、也都不是 0 / 255，所以「读回 0,0,0,0」「读回 255,255,255,255」
 * 「只读到部分通道」都会被判成不通过，而不是碰巧与写入值相等。
 */
const PROBE_RGB = [17, 99, 200] as const;
const PROBE_CSS = `rgb(${PROBE_RGB[0]}, ${PROBE_RGB[1]}, ${PROBE_RGB[2]})`;
const PROBE_EXPECTED = `${PROBE_RGB[0]},${PROBE_RGB[1]},${PROBE_RGB[2]},255`;

const PIXEL_CLAMPED = "未读（尺寸与写入值不一致，读了也是别人的像素）";
const PIXEL_NO_CONTEXT = "未测（没有 2D 上下文）";

interface Reading {
  readonly direction: Direction;
  readonly stage: Stage;
  /** 档位值：单边方向是长边（短边恒为 `SHORT_EDGE`），面积方向是正方形边长。 */
  readonly value: number;
  readonly width: number;
  readonly height: number;
  readonly readbackWidth: number;
  readonly readbackHeight: number;
  readonly hasContext: boolean;
  readonly clamped: boolean;
  readonly pixel: string;
  readonly verdict: Verdict;
}

type DirectionSummary =
  | { readonly direction: Direction; readonly status: "idle" }
  | { readonly direction: Direction; readonly status: "no-lower" }
  | { readonly direction: Direction; readonly status: "no-upper"; readonly lower: number }
  | {
      readonly direction: Direction;
      readonly status: "bisected";
      readonly lower: number;
      readonly upper: number;
      readonly upperVerdict: Verdict;
      readonly converged: number;
    };

const busy = ref(false);
const error = ref("");
const copyStatus = ref("");
const readings = ref<Reading[]>([]);

function dimensionsFor(direction: Direction, value: number): { width: number; height: number } {
  return direction === "edge" ? { width: value, height: SHORT_EDGE } : { width: value, height: value };
}

/**
 * 测一档：**三个判据全在这里**，`verdict` 按判据顺序取第一个不通过的。
 *
 * 画布用 `document.createElement("canvas")` 现建现弃（不用 OffscreenCanvas：真机上两者上限可能不同，
 * 而导出走的是 `<canvas>`）；每档测完立刻把宽高置 0（内存峰值 = 一张画布）。
 */
function probeSize(direction: Direction, stage: Stage, value: number): Reading {
  const { width, height } = dimensionsFor(direction, value);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const readbackWidth = canvas.width;
  const readbackHeight = canvas.height;
  const clamped = readbackWidth !== width || readbackHeight !== height;
  // 这里**不**包 try/catch：`getContext` 抛错属平台级失败（不是「这一档不过」），交给 `run()` 的兜底红字；
  // 第 6 条用例（抛错桩）钉住那条路径真的把原因显示出来
  const ctx = canvas.getContext("2d");
  const hasContext = ctx !== null;

  let pixel = PIXEL_NO_CONTEXT;
  let verdict: Verdict = "no-context";
  if (clamped) {
    // 判据 1 不过 ⇒ 判定就是「被钳制」；像素**不读**，也不编造
    pixel = PIXEL_CLAMPED;
    verdict = "clamped";
  } else if (ctx !== null) {
    ctx.fillStyle = PROBE_CSS;
    ctx.fillRect(0, 0, 8, 8);
    try {
      const data = ctx.getImageData(0, 0, 1, 1).data;
      pixel =
        data.length >= 4
          ? `${data[0]},${data[1]},${data[2]},${data[3]}`
          : `读回长度不足（${data.length}）`;
    } catch (e) {
      pixel = `读取抛错：${e instanceof Error ? e.message : String(e)}`;
    }
    verdict = pixel === PROBE_EXPECTED ? "pass" : "pixel-mismatch";
  }

  canvas.width = 0;
  canvas.height = 0;
  return {
    direction,
    stage,
    value,
    width,
    height,
    readbackWidth,
    readbackHeight,
    hasContext,
    clamped,
    pixel,
    verdict,
  };
}

/**
 * 最后一个三项全过的档位 + 它的下一档（含**那一档**的判定）；没有区间时返回 `null`
 * （第一档就不过 / 17 档全过）。
 *
 * `upperVerdict` 取自**上界那一档**，不是最后一档：单调平台上两者逐字相同（所以 CI 的三种读数
 * 在这一处**没有判别力**，如实标注），但一旦出现非单调读数（本页扫完全部 17 档正是为了如实暴露它），
 * 只有「上界那一档」是对的。
 */
function findBounds(
  ladder: readonly Reading[],
): { lower: number; upper: number; upperVerdict: Verdict } | null {
  let lastPass = -1;
  for (let i = 0; i < ladder.length; i += 1) {
    if (ladder[i]!.verdict === "pass") lastPass = i;
  }
  if (lastPass === -1 || lastPass === ladder.length - 1) return null;
  const upper = ladder[lastPass + 1]!;
  return { lower: ladder[lastPass]!.value, upper: upper.value, upperVerdict: upper.verdict };
}

/**
 * 跑一个方向：先扫完 17 档，再在下界 / 上界之间二分 8 次。
 *
 * **为什么不加「区间已收敛」的保护分支**：档位梯的最大档距是 8192（16384→24576 与 24576→32768），
 * 二分 8 次后区间宽度仍 ≥ 32 ⇒ `mid` 永远落在区间内部。加了也没有用例能判别（B3 的既有裁决：
 * 不加没有用例可判别的分支）。
 */
async function runDirection(direction: Direction): Promise<void> {
  const ladder: Reading[] = [];
  for (const value of LADDER) {
    const reading = probeSize(direction, "ladder", value);
    ladder.push(reading);
    readings.value.push(reading);
  }
  await nextTick();

  const bounds = findBounds(ladder);
  if (bounds === null) return;
  let { lower, upper } = bounds;
  for (let step = 0; step < BISECT_STEPS; step += 1) {
    const mid = Math.floor((lower + upper) / 2);
    const reading = probeSize(direction, "bisect", mid);
    readings.value.push(reading);
    if (reading.verdict === "pass") lower = mid;
    else upper = mid;
  }
  await nextTick();
}

/**
 * 兜底路径的文案：**保证非空**——空消息的 `Error` 取 `name`，非 `Error` 取 `String(e)`。
 *
 * 为什么值得一个函数：这是页面上唯一的兜底路径，而「`e.message` 为 `undefined` / 空串」是最典型的
 * 坏兜底（红字渲染成 `undefined`，看起来像 bug 却指不出原因）。第 6 条用例钉住它。
 */
function errorText(e: unknown): string {
  if (e instanceof Error) return e.message === "" ? e.name : e.message;
  return String(e);
}

async function run(): Promise<void> {
  busy.value = true;
  error.value = "";
  copyStatus.value = "";
  readings.value = [];
  try {
    for (const direction of DIRECTIONS) {
      await runDirection(direction);
    }
  } catch (e) {
    // 探针自己的任何抛错都显示成红字，不静默（已收下的读数保留在表里）
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

/** 逐档判定与结论文案都从**同一份读数**派生（不另存一份状态，避免表格与结论对不上）。 */
function summarize(direction: Direction, rows: readonly Reading[]): DirectionSummary {
  const ladder = rows.filter((r) => r.direction === direction && r.stage === "ladder");
  if (ladder.length === 0) return { direction, status: "idle" };
  const bounds = findBounds(ladder);
  if (bounds === null) {
    const anyPass = ladder.some((r) => r.verdict === "pass");
    if (!anyPass) return { direction, status: "no-lower" };
    return { direction, status: "no-upper", lower: ladder[ladder.length - 1]!.value };
  }
  let converged = bounds.lower;
  for (const row of rows) {
    if (row.direction === direction && row.stage === "bisect" && row.verdict === "pass") {
      converged = row.value;
    }
  }
  return {
    direction,
    status: "bisected",
    lower: bounds.lower,
    upper: bounds.upper,
    upperVerdict: bounds.upperVerdict,
    converged,
  };
}

const summaries = computed<Record<Direction, DirectionSummary>>(() => ({
  edge: summarize("edge", readings.value),
  area: summarize("area", readings.value),
}));

/**
 * 报告文本（「复制为文本」按钮的内容）：**逐档原始读数 + 两条结论 + 回写规程**。
 * 设备型号 / 浏览器版本不在页面里取（读数文本的页眉只带时间），由操作者手写进构建记录。
 */
const report = computed(() =>
  buildReportText(readings.value, summaries.value),
);

function buildReportText(
  rows: readonly Reading[],
  sums: Record<Direction, DirectionSummary>,
): string {
  const lines: string[] = [];
  lines.push(`/lab/canvas 探针读数（${new Date().toLocaleString("zh-CN")}）`);
  lines.push("方向\t阶段\t档位\t写入\t读回\tctx\t读回像素\t判定");
  for (const row of rows) {
    lines.push(
      [
        row.direction,
        row.stage,
        String(row.value),
        `${row.width}×${row.height}`,
        `${row.readbackWidth}×${row.readbackHeight}`,
        contextText(row),
        row.pixel,
        verdictText(row.verdict),
      ].join("\t"),
    );
  }
  lines.push("");
  lines.push("结论");
  for (const direction of DIRECTIONS) lines.push(conclusionText(sums[direction]));
  lines.push("");
  lines.push(
    "回写规程：取两个方向收敛值里更保守的那个，向下取整到 2 的幂 ⇒ EXPORT_MAX_EDGE（core/render/layout.ts）+ 主规格 §12 的 R2 行 + B4 规格 §16 的 B4-R1（规格 §11）。",
  );
  return lines.join("\n");
}

function rowsOf(direction: Direction): Reading[] {
  return readings.value.filter((r) => r.direction === direction);
}

function directionLabel(direction: Direction): string {
  return direction === "edge" ? `单边上限（短边固定 ${SHORT_EDGE} px）` : "面积上限（正方形）";
}

function contextText(reading: Reading): string {
  return reading.hasContext ? "有" : "无";
}

function verdictText(verdict: Verdict): string {
  if (verdict === "pass") return "通过";
  if (verdict === "clamped") return "被钳制";
  if (verdict === "no-context") return "无 2D 上下文";
  return "像素读不回";
}

function conclusionText(summary: DirectionSummary): string {
  const label = directionLabel(summary.direction);
  if (summary.status === "idle") return `${label}：尚未测量。`;
  if (summary.status === "no-lower") {
    return `${label}：档位梯的第一档（${LADDER[0]}）三项判据就没过——没有可收敛的下界，二分未执行（如实记录，不外推）。`;
  }
  if (summary.status === "no-upper") {
    return `${label}：档位梯全部 ${LADDER.length} 档通过——上界未触及，二分未执行（要更高只能加档位梯，不许外推）。`;
  }
  return `${label}：下界 ${summary.lower}（末档三项全过）· 上界 ${summary.upper}（${verdictText(summary.upperVerdict)}）· 二分 ${BISECT_STEPS} 次后收敛值 ${summary.converged}`;
}

async function copy(): Promise<void> {
  const text = report.value;
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) {
    copyStatus.value = "当前环境没有剪贴板 API：请手动选中下面的表格复制。";
    return;
  }
  try {
    await clipboard.writeText(text);
    copyStatus.value = `已复制 ${text.split("\n").length} 行到剪贴板。`;
  } catch (e) {
    copyStatus.value = `复制失败：${errorText(e)}；请手动选中下面的表格复制。`;
  }
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-6">
    <h1 class="text-2xl font-bold text-slate-900">canvas 上限探针（R2）</h1>

    <p data-testid="lab-notice" class="mt-2 max-w-3xl text-sm font-semibold text-amber-800">
      开发期实验台；CI 不测（<b>真实上限只能真机测，CI 只测这张表怎么渲染</b>）。它只在路由表里存在、
      <b>不进任何用户入口</b>；结果用于回写 <code>EXPORT_MAX_EDGE</code>（<code>core/render/layout.ts</code>）、
      主规格 §12 的 R2 与 B4 规格 §16 的 B4-R1。
    </p>
    <p class="mt-2 max-w-3xl text-sm text-slate-600">
      CI 覆盖的只是「<b>给定的读数 → 表格与结论文案</b>」这一段渲染：真实上限、真实像素语义与真实钳制行为
      都只能在手机上跑（B4 规格 §13.4 / §14 清单 3）。每档三个判据缺一不可——写入值一致 / 有 2D 上下文 /
      填色后能读回写入的颜色；<b>判定列逐档如实区分「通过 / 被钳制 / 无 2D 上下文 / 像素读不回」</b>，
      <code>getContext</code> 返回 <code>null</code> 不算通过。档位梯扫完全部
      {{ LADDER.length }} 档、不提前退出；没有区间时结论如实写「二分未执行」，不外推。
    </p>

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button
        data-testid="probe-run"
        class="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        :disabled="busy"
        @click="run"
      >
        {{ busy ? "测量中…" : "跑测量" }}
      </button>
      <button
        data-testid="probe-copy"
        class="rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-800 disabled:opacity-50"
        :disabled="readings.length === 0"
        @click="copy"
      >
        复制为文本
      </button>
      <span data-testid="probe-copy-status" class="text-sm text-slate-500">{{ copyStatus }}</span>
    </div>

    <p v-if="error" data-testid="probe-error" class="mt-3 text-sm text-red-600">{{ error }}</p>

    <template v-for="direction in DIRECTIONS" :key="direction">
      <section
        v-if="rowsOf(direction).length > 0"
        class="mt-6 max-w-5xl rounded bg-white p-4 shadow"
      >
        <h2 class="text-sm font-semibold text-slate-800">{{ directionLabel(direction) }}</h2>
        <table :data-testid="`probe-table-${direction}`" class="mt-2 w-full text-left text-xs">
          <thead>
            <tr class="text-slate-500">
              <th class="py-1">档位</th>
              <th class="py-1">写入</th>
              <th class="py-1">读回</th>
              <th class="py-1">ctx</th>
              <th class="py-1">读回像素</th>
              <th class="py-1">判定</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rowsOf(direction)"
              :key="`${row.stage}-${row.value}`"
              :data-testid="`probe-row-${direction}`"
              class="border-t border-slate-100"
            >
              <td data-testid="cell-value" class="py-1">{{ row.value }}</td>
              <td data-testid="cell-requested" class="py-1">{{ row.width }}×{{ row.height }}</td>
              <td data-testid="cell-readback" class="py-1">
                {{ row.readbackWidth }}×{{ row.readbackHeight }}
              </td>
              <td data-testid="cell-ctx" class="py-1">{{ contextText(row) }}</td>
              <td data-testid="cell-pixel" class="py-1">{{ row.pixel }}</td>
              <td data-testid="cell-verdict" class="py-1">{{ verdictText(row.verdict) }}</td>
            </tr>
          </tbody>
        </table>
        <p
          :data-testid="`probe-conclusion-${direction}`"
          class="mt-3 font-mono text-sm text-slate-800"
        >
          {{ conclusionText(summaries[direction]) }}
        </p>
      </section>
    </template>

    <p class="mt-6 max-w-3xl text-xs text-slate-500">
      三条如实标注：① 每档三个判据缺一不可，被钳制时<b>不读</b>像素（读了也是别人的像素）；
      ② 每档测完立刻把画布宽高置 0（内存峰值 = 一张画布）；若某一档直接把标签页打崩（不是返回读数），
      把崩掉的档位与现象如实记下来，回写时<b>把该档计为不通过</b>；
      ③ 本页只测 <code>&lt;canvas&gt;</code>，不测 <code>OffscreenCanvas</code>——导出走的是前者。
    </p>
  </main>
</template>
```

- [ ] **步骤 2：写用例 `src/views/__tests__/CanvasLabPage.test.ts`**

```ts
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import CanvasLabPage from "@/views/CanvasLabPage.vue";

/**
 * `/lab/canvas` 探针页的组件用例。
 *
 * **这一份用例只覆盖一件事**（B4 规格 §13.4）：**页面把给定的读数渲染成表格与结论文案**。
 * 真实上限、真实像素语义、真实钳制行为都测不到——happy-dom 的 canvas 是桩。
 *
 * **哪些是桩**：`document.createElement("canvas")` 整个换成 `FakeCanvas`（可配置「钳制阈值」
 * 「有没有 2D 上下文」「`getContext` 会不会抛错」「读回会不会抛错」）；`navigator.clipboard` 显式定义 /
 * 显式置 `undefined`。桩里的「读回」是把写进去的 `fillStyle` 原样返回，**不是**真实像素语义。
 *
 * **哪些只能人工**（B4 规格 §14 清单 3，写在这里防止后来者以为 CI 覆盖了它）：
 * ① 真机上的单边 / 面积上限数值；② `getImageData` 的真实像素语义（真实平台还有预乘 alpha、色彩管理）；
 * ③ 真实浏览器对超限画布的钳制形态（置 0 / 截断 / `getContext` 返回 null / 直接崩标签页）。
 *
 * **这一份用例能证明的**：判定列把「通过 / 被钳制 / 无 2D 上下文 / 像素读不回」如实分开；
 * 没有区间时结论**不外推**（「上界未触及」「没有可收敛的下界」都如实写出来）；页面上**唯一的兜底路径**
 * （`run()` 的 `catch`）真的把原因显示成非空红字、而不是崩页或渲染出 `undefined`。
 */

const EDGE_SHORT = 64;
/** 档位梯（与页面 / 规格 §11 逐字相同）：这里**写死**——改档位梯时它必须跟着改，否则红。 */
const LADDER = [
  1024, 1280, 1536, 1792, 2048, 2560, 3072, 3584, 4096, 5120, 6144, 8192,
  10240, 12288, 16384, 24576, 32768,
] as const;
const BISECT_STEPS = 8;
const CLAMP = 4096;
const PROBE_PIXEL = "17,99,200,255";

type Rgb = readonly [number, number, number];

interface FakeOptions {
  /** 写入超过它就被「钳制」：`canvas.width` / `height` 读回该值（模拟浏览器的静默钳制）。 */
  readonly clampAbove?: number | null;
  /** `getContext("2d")` 返回 null。 */
  readonly withoutContext?: boolean;
  /** `getContext("2d")` 直接抛错（模拟平台级失败：页面的兜底红字路径）。 */
  readonly throwOnContext?: boolean;
  /** `getImageData` 抛错（模拟超大画布上的读取失败）。 */
  readonly throwOnRead?: boolean;
}

function parseRgb(css: string): Rgb | null {
  const match = /rgb\((\d+), (\d+), (\d+)\)/.exec(css);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

class FakeCanvas {
  private requestedWidth = 0;
  private requestedHeight = 0;
  private fill = "";
  private filled: Rgb | null = null;

  constructor(private readonly options: FakeOptions) {}

  private clamp(value: number): number {
    const cap = this.options.clampAbove ?? null;
    return cap === null ? value : Math.min(value, cap);
  }

  get width(): number {
    return this.clamp(this.requestedWidth);
  }
  set width(value: number) {
    this.requestedWidth = value;
  }
  get height(): number {
    return this.clamp(this.requestedHeight);
  }
  set height(value: number) {
    this.requestedHeight = value;
  }

  getContext(kind: string): unknown {
    if (this.options.throwOnContext === true) throw new Error("假平台：无法获取上下文");
    if (kind !== "2d" || this.options.withoutContext === true) return null;
    const canvas = this;
    return {
      set fillStyle(value: string) {
        canvas.fill = value;
      },
      get fillStyle(): string {
        return canvas.fill;
      },
      /** 只有**覆盖 (0,0)** 的填色才算数：这样「忘了填色」会判成像素读不回，而不是恒真通过。 */
      fillRect(x: number, y: number, w: number, h: number): void {
        if (x <= 0 && y <= 0 && w >= 1 && h >= 1) canvas.filled = parseRgb(canvas.fill);
      },
      getImageData(): { data: Uint8ClampedArray } {
        if (canvas.options.throwOnRead === true) throw new Error("假平台：读回失败");
        const rgb = canvas.filled;
        return {
          data:
            rgb === null
              ? new Uint8ClampedArray([0, 0, 0, 0])
              : new Uint8ClampedArray([rgb[0], rgb[1], rgb[2], 255]),
        };
      },
    };
  }
}

/** 把 `document.createElement("canvas")` 换成假画布，其余标签原样透传（Vue 自己要用）。 */
function stubCanvases(options: FakeOptions): FakeCanvas[] {
  const instances: FakeCanvas[] = [];
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    elementOptions?: ElementCreationOptions,
  ) => {
    if (tag === "canvas") {
      const canvas = new FakeCanvas(options);
      instances.push(canvas);
      return canvas;
    }
    return original(tag, elementOptions);
  }) as typeof document.createElement);
  return instances;
}

const originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");

/**
 * happy-dom 下 `navigator.clipboard` 不可依赖（CONTRACT §5 第 2 条的同一口径）：显式定义，
 * 用完按原描述符还原。**若 happy-dom 的 `navigator` 被冻结**（`defineProperty` 抛错），
 * 改用 `vi.stubGlobal("navigator", Object.create(window.navigator, { clipboard: { value: … } }))`。
 *
 * 返回类型**不写死**（`vi.fn` 会从实现里推出 `(text: string) => Promise<void>`）：写
 * `ReturnType<typeof vi.fn>` 会把参数退化成 `any[]`，而 `mock.calls[0][0]` 的类型就再也拦不住
 * 「断言取错了参数」。
 */
function stubClipboard() {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

function hideClipboard(): void {
  Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true });
}

async function runProbe(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.get('[data-testid="probe-run"]').trigger("click");
  await flushPromises();
}

afterEach(() => {
  if (originalClipboard === undefined) Reflect.deleteProperty(window.navigator, "clipboard");
  else Object.defineProperty(window.navigator, "clipboard", originalClipboard);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/lab/canvas 探针页", () => {
  it("页首自标「开发期实验台；CI 不测」并写明 CI 只测这张表，且未跑之前不渲染任何表", () => {
    const wrapper = mount(CanvasLabPage);

    const notice = wrapper.get('[data-testid="lab-notice"]').text();
    expect(notice).toContain("开发期实验台");
    expect(notice).toContain("CI 不测");
    // 规格 §11 已把「CI 不测」与 §13.4 的「CI 里只能测表格渲染」写成一句话：两半都要在页面上
    expect(notice).toContain("CI 只测");
    expect(notice).toContain("不进任何用户入口");

    // 未测量之前不渲染空表（也不显示任何「结论」）
    expect(wrapper.find('[data-testid="probe-table-edge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="probe-table-area"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="probe-conclusion-edge"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("全部通过：两条梯各 17 行、逐行「通过」，结论如实写「上界未触及，二分未执行」", async () => {
    stubCanvases({});
    const wrapper = mount(CanvasLabPage);
    await runProbe(wrapper);

    for (const direction of ["edge", "area"] as const) {
      const rows = wrapper.findAll(`[data-testid="probe-row-${direction}"]`);
      expect(rows).toHaveLength(LADDER.length);
      for (const row of rows) {
        expect(row.get('[data-testid="cell-verdict"]').text()).toBe("通过");
      }
      // 第三判据真的被求值过：读回像素就是填进去的那个颜色（不是「跳过不算」）
      expect(rows[0]!.get('[data-testid="cell-pixel"]').text()).toBe(PROBE_PIXEL);
      expect(rows[0]!.get('[data-testid="cell-ctx"]').text()).toBe("有");

      const conclusion = wrapper.get(`[data-testid="probe-conclusion-${direction}"]`).text();
      expect(conclusion).toContain(`档位梯全部 ${LADDER.length} 档通过`);
      expect(conclusion).toContain("上界未触及");
      expect(conclusion).toContain("二分未执行");
      expect(conclusion).not.toContain("收敛值");
    }

    wrapper.unmount();
  });

  it("中途被钳制：下界 4096 / 上界 5120、二分 8 次收敛到 4096，钳制行不编造像素", async () => {
    stubCanvases({ clampAbove: CLAMP });
    const wrapper = mount(CanvasLabPage);
    await runProbe(wrapper);

    for (const direction of ["edge", "area"] as const) {
      const rows = wrapper.findAll(`[data-testid="probe-row-${direction}"]`);
      // 17 档 + 8 次二分 = 25 行（档距 1024 ⇒ 8 次二分都落在区间内部）
      expect(rows).toHaveLength(LADDER.length + BISECT_STEPS);

      const clampedRow = rows.find(
        (row) => row.get('[data-testid="cell-value"]').text() === "5120",
      );
      expect(clampedRow).toBeDefined();
      const expectedReadback = `${CLAMP}×${direction === "edge" ? EDGE_SHORT : CLAMP}`;
      expect(clampedRow!.get('[data-testid="cell-readback"]').text()).toBe(expectedReadback);
      expect(clampedRow!.get('[data-testid="cell-verdict"]').text()).toBe("被钳制");
      // 被钳制的档位**不编造**读回像素
      expect(clampedRow!.get('[data-testid="cell-pixel"]').text()).toContain("未读");

      const conclusion = wrapper.get(`[data-testid="probe-conclusion-${direction}"]`).text();
      expect(conclusion).toContain("下界 4096");
      expect(conclusion).toContain("上界 5120");
      expect(conclusion).toContain("被钳制");
      expect(conclusion).toContain(`二分 ${BISECT_STEPS} 次后收敛值 4096`);
    }

    wrapper.unmount();
  });

  it("ctx 为 null：逐行「无 2D 上下文」、结论写「没有可收敛的下界」，不外推", async () => {
    stubCanvases({ withoutContext: true });
    const wrapper = mount(CanvasLabPage);
    await runProbe(wrapper);

    for (const direction of ["edge", "area"] as const) {
      const rows = wrapper.findAll(`[data-testid="probe-row-${direction}"]`);
      expect(rows).toHaveLength(LADDER.length);
      for (const row of rows) {
        expect(row.get('[data-testid="cell-ctx"]').text()).toBe("无");
        expect(row.get('[data-testid="cell-pixel"]').text()).toContain("未测");
        // 这一条就是「不许把 getContext 返回 null 当成通过」
        expect(row.get('[data-testid="cell-verdict"]').text()).toBe("无 2D 上下文");
      }
      const conclusion = wrapper.get(`[data-testid="probe-conclusion-${direction}"]`).text();
      expect(conclusion).toContain("没有可收敛的下界");
      expect(conclusion).toContain("二分未执行");
      expect(conclusion).not.toContain("收敛值");
    }

    wrapper.unmount();
  });

  it("像素读不回（getImageData 抛错）：判定是「像素读不回」、结论仍不外推", async () => {
    stubCanvases({ throwOnRead: true });
    const wrapper = mount(CanvasLabPage);
    await runProbe(wrapper);

    const rows = wrapper.findAll('[data-testid="probe-row-edge"]');
    expect(rows).toHaveLength(LADDER.length);
    for (const row of rows) {
      expect(row.get('[data-testid="cell-pixel"]').text()).toContain("读取抛错");
      expect(row.get('[data-testid="cell-verdict"]').text()).toBe("像素读不回");
    }
    expect(wrapper.get('[data-testid="probe-conclusion-edge"]').text()).toContain("二分未执行");

    wrapper.unmount();
  });

  it("getContext 抛错：兜底红字出现、表格不产出、页面不崩（页面上唯一的兜底路径）", async () => {
    stubCanvases({ throwOnContext: true });
    const wrapper = mount(CanvasLabPage);

    await wrapper.get('[data-testid="probe-run"]').trigger("click");
    await flushPromises();

    const redText = wrapper.get('[data-testid="probe-error"]').text();
    // 兜底文案必须非空、且带上桩抛出的原因（不是空串、更不是 "undefined"）
    expect(redText).toContain("无法获取上下文");
    expect(redText).not.toContain("undefined");
    // 第一档就抛 ⇒ 一张表都没有（而不是渲染一张空表 / 半张表）
    expect(wrapper.find('[data-testid="probe-table-edge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="probe-table-area"]').exists()).toBe(false);
    // 页面不崩：按钮回到可用、页首自标仍在
    expect(wrapper.get('[data-testid="probe-run"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-testid="lab-notice"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it("复制为文本：把同一份读数写进剪贴板；没有剪贴板 API 时给手动复制的提示", async () => {
    stubCanvases({ clampAbove: CLAMP });
    const writeText = stubClipboard();
    const wrapper = mount(CanvasLabPage);
    await runProbe(wrapper);

    await wrapper.get('[data-testid="probe-copy"]').trigger("click");
    await flushPromises();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = String(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied).toContain("上界 5120");
    expect(copied).toContain(`二分 ${BISECT_STEPS} 次后收敛值 4096`);
    expect(copied).toContain("被钳制");
    expect(wrapper.get('[data-testid="probe-copy-status"]').text()).toContain("已复制");

    hideClipboard();
    await wrapper.get('[data-testid="probe-copy"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="probe-copy-status"]').text()).toContain("没有剪贴板 API");
    expect(writeText).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });
});
```

- [ ] **步骤 3：跑用例，并做五条定向变异证明判定列与兜底路径都有判别力**

运行：`npx vitest run src/views/__tests__/CanvasLabPage.test.ts`
预期：**PASS——6 条用例全绿**（`Test Files 1 passed (1)` / `Tests 6 passed (6)`）。

然后逐条做变异 → 记红数 → `git checkout -- src/views/CanvasLabPage.vue` 还原 → 再跑一次确认回到全绿。
**红数不许预估**：下面只写「变异动作 + 该红的用例标题」，实现者必须在自己报告里逐条附**实跑红数与失败点标题**（B4 规格 §13.3 的既有纪律）。

| # | 变异（改 `CanvasLabPage.vue` 的哪一处 → 改成什么） | 该红的用例（标题） |
|---|---|---|
| P1 | `probeSize` 里把 `clamped` 判据删掉（永远走 `else`），即把「尺寸被钳制」当成可用 | **`中途被钳制…` 那条**（25 行 → 17 行、判定列变成「通过」、结论变成「全部 17 档通过」）。`全部通过…` 那条**应当保持绿**——它本来就没有钳制，这正说明这条变异动的是钳制分支、没动通过分支（**别把它算成红**） |
| P2 | `verdict = pixel === PROBE_EXPECTED ? "pass" : "pixel-mismatch"` 改成无条件 `"pass"`（即「拿到 ctx 就算通过」） | **`像素读不回（getImageData 抛错）…` 那条**。`ctx 为 null…` 那条**应当保持绿**（`ctx === null` 在赋值之前就分流出去了）——两条判据各守一半，这里正好证明它们没有互相遮蔽 |
| P3 | `BISECT_STEPS` 由 `8` 改成 `7` | **`中途被钳制…` 那条**（行数 25 → 24，且结论里的「二分 8 次后收敛值 4096」不再匹配） |
| P4 | `summarize` 在 `bounds === null` 时返回一个编造的收敛值（例如 `LADDER[0]`） | **`全部通过…` 与 `ctx 为 null…` 两条**（两条都要求结论里不出现「收敛值」） |
| P5 | 把 `run()` 的兜底拆坏——**P5a**：删掉 `error.value = errorText(e);` 这一行（保留 `catch`）；**P5b**：删掉整个 `catch` 块（抛错逃出 async 函数） | **`getContext 抛错…` 那条**：P5a 下 `probe-error` 不存在 ⇒ `wrapper.get` 直接抛；P5b 下同一条断言失败，**另外可能被 vitest 报成未处理的 rejection——那也算同一条用例的红，不要当成第二个缺陷**。两种形态都必须让**恰好那一条**红 |

> **五条变异都必须至少红一条**；某条变异下**一条都不红**，说明对应的那条诚实边界没有断言在读它——按下面「暴露的字段」清单补断言，不许把 0 红当作「这条分支没人守」（B3 构建记录 §6 的形态：「0 红 ≠ 无守卫」要先排除「变异没生效」）。

**断言覆盖自查（防哑弹）**：本文件里必须**每一条**都被至少一条断言读过的输出：`verdict`（四种取值全读到）、`pixel`（通过值 / 未读 / 未测 / 读取抛错四种）、`ctx`（有 / 无 / `getContext` 抛错时的红字）、`readback`（未钳制的等值 + 被钳制的不等值）、`value`（5120 那一档被点名）、行数（17 / 25 / 抛错时 0 张表）、结论文案（`no-upper` / `no-lower` / `bisected` 三种状态各一条）、页首自标（4 个子串）、复制状态（成功 / 无剪贴板两种）、`probe-error`（非空 + 不含 `undefined`）。

- [ ] **步骤 4：路由表加一行 + 路由用例加一条恒等断言**

**(1) `src/router/index.ts`**：在现有 `:15` 的 `/lab/decode` 那一行**之后**插入（其余 5 行一个字不动）：

```ts
    // /lab/canvas 是 B4 的 canvas 上限探针页（R-7：**开发期实验台**，不进任何用户入口、页面自标「CI 不测」；
    // 真机实测结果回写 `EXPORT_MAX_EDGE`、主规格 §12 的 R2 与 B4 规格 §16 的 B4-R1）。
    { path: "/lab/canvas", name: "canvas-lab", component: () => import("@/views/CanvasLabPage.vue") },
```

**(2) `src/router/__tests__/index.test.ts`**：

- 文件头 import 区（现 `:1-4`）在 `import SetupPage from "@/views/SetupPage.vue";` **之前**插入一行：
  ```ts
  import CanvasLabPage from "@/views/CanvasLabPage.vue";
  ```
- 在文件**末尾**（现 `:56-58` 的「B1 的临时入口不再占着路由名 generate」那条 `it` 之后、`});` 之前）**只加**这一条用例（既有断言一个字符都不改）：

```ts
  // 任务 5 新增。`/lab/canvas` 是 B4 的开发期探针页（R-7：不进任何用户入口）——
  // **路由表是它唯一的存在处**，所以「名字打错 / 指向别的组件」在别处全是盲区。
  // 与 `/new`、`/new/setup` 两条同形：只断言 name / path 的话，把 `component` 换成任何别的页面
  // 照样绿（懒加载器不会因为 `resolve` 就被调用），所以直接把那个 loader 跑一次做**恒等**比较。
  it("/lab/canvas 是 canvas 上限探针页：名字 canvas-lab、路径 /lab/canvas、组件就是 CanvasLabPage", async () => {
    const route = router.resolve({ name: "canvas-lab" });

    expect(route.name).toBe("canvas-lab");
    expect(route.path).toBe("/lab/canvas");

    const loader = route.matched[0]?.components?.default;
    expect(typeof loader).toBe("function");
    const mod = await (loader as unknown as () => Promise<{ default: unknown }>)();
    expect(mod.default).toBe(CanvasLabPage);
  });
```

> **为什么用「恒等」而不是照着 `/lab/decode` 那一行写**：仓库里 `/lab/decode` 那条只是
> `expect(router.resolve({ name: "decode-lab" }).path).toBe("/lab/decode")`——它**不比较组件**，
> 挡不住「`/lab/canvas` 指向 `DecodeLabPage`」。**本条的写法取自 README 已公示的 `/new` / `/new/setup`
> 两条**（README `:58-59`：「路由表本身有**用例**守着（`/new` 指的是选图页、`/new/setup` 指的是装配页，
> 且 loader 解出的组件做**恒等**比较）」），即上面这段 `loader → mod.default → toBe(组件)` 的形状。
> **控制者裁定（2026-10-05）**：路由名 `canvas-lab` 采纳（与 `decode-lab` 同构词法）；强断言（组件恒等）
> 采纳，并确认「照 `/lab/decode` 那条写」这句指令与仓库现状不符、按更强的既有写法办。

**(3) 「不进任何用户入口」的自查（不是断言，是收尾报告里要贴的命令与结果）**：

```powershell
Get-ChildItem -Recurse -File src\views, src\components |
  Select-String -Pattern 'canvas-lab|lab/canvas' |
  Where-Object { $_.Path -notmatch 'CanvasLabPage' }
```

预期：**零命中**（与 `/lab/decode` 的现状同形——它现在也只在路由表、路由用例与 `services/imageSource.ts` 的一处注释里出现，没有任何用户入口指向它）。这一条**没有 CI 断言**：**控制者裁定（2026-10-05）不为它新开词法闸门**——`/lab/decode` 已有同一条约定，真正的机检对象是「其它页面不出现指向它的链接」（要扫 `.vue`，与现有只扫 `.ts` 的闸门不同类）。约定本身写进 README 的 `src/router/` 行（与 `/lab/decode` 并列注明「开发期实验台，不进任何用户入口」，见任务 6 步骤 8(5)），并把上面这条自查的输出如实写进报告。

- [ ] **步骤 5：全量验证**

```bash
npx vitest run src/router/__tests__/index.test.ts      # 预期：PASS（既有 4 条 + 新增 1 条 = 5 条）
npm run test                                            # 预期：全绿
$env:TZ="UTC"; npm run test                             # 预期：与上一条同样的文件数 / 用例数，全绿
npm run build                                           # 预期：vue-tsc --noEmit 无输出 + Vite 构建成功
```

**账目**：本任务新增 **1 个测试文件**（`src/views/__tests__/CanvasLabPage.test.ts`，**6 条用例**）与 **1 条路由用例**，合计 **+7 条用例**；`src/router/index.ts` 与 `src/router/__tests__/index.test.ts` 都是**只加不改**。
**闭合校验**：用 `node .superpowers/sdd/2026-10-05-app-b4-export/tools/count.mjs` 取分解式，与 `npm run test` 报出的 `Tests  N passed (N)` **逐位相等**；不等就先查清（多/少一条往往意味着用例没被收集或写重了），**不许把运行期总数与分解式任一直接抄进报告**。

- [ ] **步骤 6：Commit**

```bash
git add src/views/CanvasLabPage.vue src/views/__tests__/CanvasLabPage.test.ts src/router/index.ts src/router/__tests__/index.test.ts
git commit -m "feat(app): /lab/canvas 上限探针页（R2）与路由用例"
```

**报告必须包含**（控制者复核的输入，缺一条返工）：

1. `npm run test` / `$env:TZ="UTC"; npm run test` / `npm run build` 的**原始输出尾巴**；
2. P1–P5 五条变异的**实测红数与失败点标题**（不许预估；P5 要写清是 P5a 还是 P5b、以及有没有额外的未处理 rejection），以及还原后 `git status --short` 为空的证据；
3. 步骤 4(3) 那条 `Select-String` 自查的原始输出（零命中）；
4. 一句如实说明：**本页的真实上限没有被 CI 验证过**（只能人工，清单 3）；CI 证明的是「给定的读数 → 表格与结论文案」+ **唯一的兜底路径**（`getContext` 抛错 ⇒ 非空红字、无表产出、不崩页）；
5. 与计划 / 契约 / 规格不符之处与处置（**不许自行发明名字**：探针页的 testid / 判定文案 / 结论状态已集中在 `## 本页口径` 一节里，改动它们要同步那一节）。

---

### 本页口径（任务 5 交付物；审查时按此逐条核对）

> **层级说明（控制者裁定 C）**：片段里 `###` 是**片段顶层**（`### 任务 N`），任务内的任何子节一律用 `####`；
> 装配器对片段做「标题整体上提一级」，所以本节落成计划里的 `### 本页口径`（计划的层级恒定：`## ` = 任务 / 附录，
> `### ` = 任务内子节）。**本节与末尾的缺口节都用 `####`**，围栏内的构建记录骨架不动（那是内容模板）。

**控制者裁定（2026-10-05）**：探针页只有一个消费者（这条路由自己），它的读数结构与文案**不进跨任务契约**，由本片段自定——但必须**集中列一遍**，不许只散落在代码里。下面就是审查者的一眼清单（每一项都在步骤 1 / 步骤 2 的代码里有唯一来源）。

**路由与文件**

| 项 | 值 |
|---|---|
| 路由 | `path: "/lab/canvas"`、`name: "canvas-lab"`、组件 `() => import("@/views/CanvasLabPage.vue")` |
| 页面文件 | `src/views/CanvasLabPage.vue` |
| 用例文件 | `src/views/__tests__/CanvasLabPage.test.ts`（**6 条用例**，对应 P1–P5 五条变异） |
| 入口约定 | 只在路由表里存在、**不进任何用户入口**；CI 无断言（自查命令 + 报告如实记录）；约定同步进 README 的 `src/router/` 行 |

**`data-testid`（页面上共 8 个，全部会被用例读到）**

| testid | 挂在什么上 | 用例怎么用 |
|---|---|---|
| `lab-notice` | 页首自标段 | 断言含「开发期实验台」「CI 不测」「CI 只测」「不进任何用户入口」（R-7 的字面 + 规格 §11 改后的澄清句） |
| `probe-run` | 「跑测量」按钮 | `trigger("click")` 驱动整套读数；抛错用例里还断言它**回到可用**（`disabled` 属性不存在） |
| `probe-copy` | 「复制为文本」按钮 | 断言剪贴板收到同一份文本；`readings` 为空时 `disabled` |
| `probe-copy-status` | 复制状态行 | 断言「已复制」/「没有剪贴板 API」两种文案 |
| `probe-error` | 红字错误行（`v-if="error"`） | 第 6 条用例（`getContext` 抛错桩）断言：**红字出现、含桩抛出的原因、不含 `undefined`、且一张表都没产出** |
| `probe-table-<direction>` | 每个方向一张表（`edge` / `area`） | 未跑之前不存在；跑完存在；抛错用例里断言两张都不存在 |
| `probe-row-<direction>` | 表格数据行 | 断言行数（17 / 25 / 抛错时 0 张表） |
| `probe-conclusion-<direction>` | 每个方向的结论文案 | 断言三种结论状态（`no-upper` / `no-lower` / `bisected`） |

**兜底文案（页面上唯一的 catch）**：`errorText(e)` —— `Error` 取 `message`（**空串时取 `name`**）、非 `Error` 取 `String(e)`；`run()` 与 `copy()` 共用它。它保证红字**永不**是空串或 `undefined`（第 6 条用例钉住），第 6 条也是它唯一的 CI 判别力来源。

**行内单元格 testid（每行 6 个）**：`cell-value`（档位）/ `cell-requested`（写入 `w×h`）/ `cell-readback`（读回 `w×h`）/ `cell-ctx`（`有` / `无`）/ `cell-pixel`（读回的 `r,g,b,a` 或占位文案）/ `cell-verdict`（判定）。

**判定（`Verdict`）与它的中文文案——四种，缺一不可**

| `verdict` | 文案 | 何时取到 | 该格的 `cell-pixel` |
|---|---|---|---|
| `pass` | `通过` | 三个判据全过 | `17,99,200,255`（写入的探针色） |
| `clamped` | `被钳制` | `canvas.width`/`height` 读回 ≠ 写入值（**优先级最高**） | `未读（尺寸与写入值不一致，读了也是别人的像素）` |
| `no-context` | `无 2D 上下文` | 尺寸一致但 `getContext("2d") === null` | `未测（没有 2D 上下文）` |
| `pixel-mismatch` | `像素读不回` | 有 ctx，但读回像素 ≠ 写入色（含 `getImageData` 抛错：文案变成 `读取抛错：<原因>`） | 实际读回的串 / `读取抛错：…` |

**结论（`ConclusionStatus`）与它的文案——三种，`idle` 只在未测量时存在**

| `status` | 文案形状 |
|---|---|
| `idle` | `<方向>：尚未测量。`（模板 `v-if` 保证不渲染，但 computed 会求值——**mount 即覆盖**） |
| `no-lower` | `<方向>：档位梯的第一档（1024）三项判据就没过——没有可收敛的下界，二分未执行（如实记录，不外推）。` |
| `no-upper` | `<方向>：档位梯全部 17 档通过——上界未触及，二分未执行（要更高只能加档位梯，不许外推）。` |
| `bisected` | `<方向>：下界 L（末档三项全过）· 上界 U（<上界那一档的判定>）· 二分 8 次后收敛值 C` |

**方向名**：`edge` → `单边上限（短边固定 64 px）`；`area` → `面积上限（正方形）`。

**读数结构与常量（唯一来源都在页面里）**：`Reading` 的字段 = `direction` / `stage`(`ladder` \| `bisect`) / `value` / `width` / `height` / `readbackWidth` / `readbackHeight` / `hasContext` / `clamped` / `pixel` / `verdict`；`SHORT_EDGE = 64`、`BISECT_STEPS = 8`、`LADDER` 17 档、`PROBE_RGB = [17, 99, 200]`。用例里把 `LADDER` 与 `BISECT_STEPS` **再写死一份**（改档位梯时用例必须跟着改，否则红——这是刻意的第二处锚点）。

---

## 任务 6：收尾（README / AGENTS+CLAUDE 镜像 / 主规格注记 / B3 两条 Minor / JSDoc / 构建记录 / 账目闭合）

**文件：**
- 修改：`docs/superpowers/specs/2026-09-30-image-to-pattern-design.md`（**只加注记、不改历史正文**：§4.1 `:120` 后、§7.1 `:309` 后、§7.2 `:313` 后、§7.3 `:322` 后、§7.4 `:326` 后各插一段引用块；§12 的 **R2 行** `:407` 按实测回填）
- 修改：`docs/superpowers/specs/2026-10-05-app-b4-export-design.md`（§16 的 **B4-R1** 行，2026-10-05 的 HEAD 上是 `:705`，回填同一批实测值。**全片段的 B4 规格行号都按这一天记**——规格在实现期一直在被裁定追加，动手前一律先 `Select-String` 复核，见步骤 2 的开头）
- 修改：`docs/superpowers/notes/2026-10-04-app-b3-build-log.md`（§11 的两处：`:338-340` 的括号、`:343-346` 的措辞——**直接改写原文**，人类伙伴已批准）
- 修改：`src/core/pattern/build.ts`（`:160` 的 `buildPatternFromImage` JSDoc，**只补注释、不动行为**）
- 修改：`AGENTS.md`（`:103-107` 的「公开 API ≠ 被使用的 API」段；`:109-119` 的「关键常量」段）
- 修改：`CLAUDE.md`（**与 `AGENTS.md` 逐字相同的两处改动**——R-8）
- 修改：`README.md`（`:82` 后插入 B4 段、`:84` 的「下一步」、`:120-155` 的目录结构 5 处、`:101-107` 的账目、`:113-115` 的耗时句、`:116-117` 的构建行、`:285-292` 的「文档」节、`## 计划 B2 的延后项` 之后新增 `## 计划 B4 的延后项`）
- 创建：`docs/superpowers/notes/2026-10-05-app-b4-build-log.md`
- **明确不在本任务里**（控制者裁定 2026-10-05（B），B4 规格 §16 的 B4-R1 行同步写明）：**探针实测 `N < 4096` 时要改 `EXPORT_MAX_EDGE` 的四处文件**（`src/core/render/layout.ts` 的常量、`src/core/render/__tests__/layout.test.ts` 的既有断言、`AGENTS.md` 的常量行、`CLAUDE.md` 的常量行）——**触发条件是定死的**：人类伙伴报回读数后的**当天**，由**控制者**立新一版小轮简报（工作区 `.superpowers/sdd/<日期>-app-b4-canvas-limit/`，照 B3 人工验证小轮的先例：简报 + 分派实现者 + 控制者复核 + 全新子代理审查 + 定向复审），并写进**账本的「阶段交接」段**；**`N > 4096` 只是片数偏多、可选**（同样不在本任务里，但不必立轮）。本任务只写「怎么回写」的规程，并把「若 `N < 4096`，这一次修复轮优先级最高」写进构建记录的未验证面一节（步骤 11 的 §12）。**这一条不进 README 的延后项表**（那是「判定为可接受、明确不修」的表，而这是「待实测触发的修复」）。

**动手前先读：** B4 规格 **§17**（要回写的 6 条，本任务的清单就是它）、**§11**（结果回写的三处落点）、**§13.3**（红数不许预估）、**§14**（人工清单，含清单 3）、B3 构建记录 **§10.2 / §10.3**（「只加更正注记、不改历史正文」与「报告是**当时的**证据」两条先例）、**§11**（两条 Minor 的原文与上下文）、`.superpowers/sdd/2026-10-04-app-b3-manual-findings/progress.md` 的「阶段交接」末节（三条延后 Minor 的原文）、README 的 `:101-107`（**计数方法与闭合校验**就写在那里）与 `:58-59`（路由用例「恒等比较」的既有公示）、B1 构建记录 / B2 构建记录（构建记录骨架的样板，B3 同）、`.superpowers/sdd/2026-10-05-app-b4-export/tools/count.mjs`（账目重数脚本，头部注释写明了两个固定偏移，并留档了它自己的两次错误）。

---

### 本任务里的「数字」一律是**运行期取值**，不是占位符

本任务的每一步都不许写预测数字或 `<本次实测>` 这类尖括号模板（B3 的缺陷 22 就是这么来的）。所有要填数字的地方一律写成：**变量名 + 取值来源 + 取不到时的处置**。变量表如下（后面各步骤直接引用这些名字）：

| 变量 | 含义 | 取值来源（命令 / 位置） |
|---|---|---|
| `F` | 测试文件数 | `npm run test` 输出尾部的 `Test Files  F passed (F)`；必须与 `count.mjs` 的「测试文件」行**逐位相等** |
| `T` | 用例总数 | 同一次输出的 `Tests  T passed (T)` |
| `I` | `it(` 全局计数（含同行声明的那 1 条） | `node .superpowers/sdd/2026-10-05-app-b4-export/tools/count.mjs` 的「it( 全局」行 |
| `R` | `it.each` 展开行数 | 同脚本的「it.each 表 / 展开行」行的**后**一个数 |
| `E` | `it.each` 表数 | 同一行的**前**一个数 |
| `C` | 契约 `it(` 数（`projectStoreContract.ts`） | 同脚本的「契约 it 数 ×2」行 |
| `D` | `describe(` 行首计数 | 同脚本的「describe( 行首」行 |
| `S1 / S2 / S3` | 耗时读数 | 本轮**连续三次** `npm run test` 各自的 `Duration` |
| `S_mid` | 写进 README 的耗时值 | `S1` / `S2` / `S3` 的**中位数**（落笔时算成字面值；单次读数别当基准） |
| `B` | 构建读数 | 本轮 `npm run build` 输出尾部的 `modules transformed` 与 `built in …`（至少两次读数取区间） |
| `P_edge` | 单边方向收敛值 | 手机 `/lab/canvas` → 「跑测量」→「复制为文本」的文本里 `单边上限（短边固定 64 px）` 那一行的「收敛值」 |
| `P_area` | 面积方向收敛值 | 同一份文本里 `面积上限（正方形）` 那一行的「收敛值」 |
| `P_date` / `P_device` | 实测日期 / 设备与浏览器版本 | 操作者在探针读数文本的**页眉手写**（页面自己取不到）；`P_device` 形如「Pixel 8 / Chrome 141 / Android 16」 |
| `N` | 回写用的上限 | `2 ** Math.floor(Math.log2(Math.min(P_edge, P_area)))`（规格 §11：取最保守值、向下取整到 2 的幂） |

**闭合校验（先查清再落笔）**：`I + R + 2C + 1 === T` **并且** `F === count.mjs 的文件数`。
不等就说明至少有一个数是错的——**不许**「凑一下让它对上」，也不许引用任何汇总行（README 自己写明这个数字在本项目已出错三次）。
**分解式对不上时，先怀疑仪器本身**（控制者裁定 2026-10-05，已写进账本）：`count.mjs` 的头部注释留档了它自己的两次错误（契约 ×2 的归属、`it.each` 不匹配 `\bit\(` 这一点），所以顺序是「① 显式 UTF-8 手工重数一遍 → ② 判断是脚本错还是运行期读数错 → ③ 修脚本要连带修它的注释与 README 的计数方法句」。**不许**为了让它对上而改用例或改期望。

---

- [ ] **步骤 1：先把账目与探针读数取到手（不写任何文档）**

```bash
npm run test                                       # 记下 F / T / S1
node .superpowers/sdd/2026-10-05-app-b4-export/tools/count.mjs   # 记下 F(复核) / D / I / E / R / C，脚本会直接打印闭合分解式
npm run test                                       # S2
npm run test                                       # S3
$env:TZ="UTC"; npm run test                         # 记下 TZ 下的 F / T（应与上面相同）
npm run build                                      # 记下 B
```

**同时**（人工清单 3，能现在做就现在做、做不了就按「未执行」如实写）：
1. `npx vite --host` → 手机开 `http://<PC 局域网 IP>:1420/lab/canvas`；
2. 点「跑测量」→ 点「复制为文本」→ 把整段文本贴进构建记录 §7.1（**原文照贴，不许精简**）；
3. 在这段文本头部手写：日期、手机型号、浏览器与版本、系统版本（页面自己取不到这些）；
4. 算出 `N`，并确定它落在哪一支（**控制者裁定 2026-10-05：无论哪一支，任务 6 都不改代码**）：
   - **`N ≥ 4096`** ⇒ `EXPORT_MAX_EDGE` 的保守下界成立，**四处文件都不用改**（`layout.ts` 的 4096 不动、`layout.test.ts` 的 `expect(EXPORT_MAX_EDGE).toBe(4096)` 不动、`AGENTS.md` / `CLAUDE.md` 的常量行不动），R2 行如实写「实测 ≥ 4096，维持 4096」，构建记录 §12 记「可选：只是片数偏多、正确性不受影响」（`N > 4096` 时想上调常量也属可选，不立轮）；
   - **`N < 4096`** ⇒ **本任务不改任何代码**（代码已冻结，实测发生在人工验证阶段）。**触发条件已定死（控制者裁定 B，2026-10-05）**：人类伙伴报回 `/lab/canvas` 读数后的**当天**，由**控制者**立新一版小轮简报，工作区 `.superpowers/sdd/<日期>-app-b4-canvas-limit/`（照 B3 人工验证小轮的先例：简报 + 分派实现者 + 控制者复核 + 全新子代理审查 + 定向复审），并把该轮写进**本账本的「阶段交接」段**。本任务要做的两件事：① 把读数与「该轮优先级最高（否则该手机上导出会走降级链、甚至响亮失败）」写进构建记录 §12；② 报告控制者立轮。要改的是 `core/render/layout.ts` 常量、`core/render/__tests__/layout.test.ts` 的断言、`AGENTS.md` 的常量行、`CLAUDE.md` 的常量行**共四处文件**。
     **注意：这一条不进 README 的「计划 B4 的延后项」表**（那张表的口径是「判定为可接受、明确不修」，而这是「**待实测触发的修复**」，混进去会改变它的性质）——README 那一侧只在 B4 进度段/`EXPORT_MAX_EDGE` 的叙述里如实写「实测值以构建记录 §7.1 为准」。
5. **若清单 3 未执行**（没有手机 / 没有设备）⇒ `P_edge` / `P_area` / `N` **全部不填**，R2 行按步骤 2 的「未实测分支」写；**不许**用 `4096` 冒充读数（它是常量不是读数，混为一谈就是本项目三次记账错误的那一类）。

- [ ] **步骤 2：主规格 6 处（5 段注记 + 1 行回填）**

原则：**只加注记、不改历史正文**（B3 构建记录 §10.2 的先例）。五段注记一律用引用块（`>`）插在被更正的那一节**末尾**，下一节标题之前留一个空行；正文一个字不动。

> **行号先行自查**：本片段里**主规格**的行号（`:120` / `:304-309` / `:311-313` / `:315-322` / `:324-326` / `:407`）与**B4 规格**的行号（§1.3 的 D5 `:63`、§16 的 B4-R1 `:705`、§17 `:716-744`）都是 **2026-10-05 的 HEAD 快照**。B4 规格在实现期一直按裁定追加（当天已有三笔规格提交），**动手前一律先复核**：
> `Select-String -Path docs\superpowers\specs\2026-10-05-app-b4-export-design.md -Pattern 'B4-R1 \|','D5 \|','^## 17|^## 11\.'` 与主规格的 `Select-String … -Pattern '^### 7\.[1-4]|^## 12\.|^### 4\.1'`。**行号对不上时以内容为准**（按本节给出的「定位原文」找），并在报告里记下实际行号。

**(0) §4.1 的目录结构（现 `:120`，代码块收尾）之后插入**（定位原文：代码块里的 `│   │   └── render/    preview.ts  sheet.ts  share.ts  layout.ts   # 计划 B/C，尚未交付`，位于 `:102`）：

```markdown
> **2026-10-05 更正（B4 交付时加注，上面代码块不改）**：上面的目标结构里把 `render/` 写成
> `preview.ts  sheet.ts  share.ts  layout.ts`——**B4 不新建 `preview.ts`**：预览由 B1/B2 已交付的
> `services/patternThumbnail.ts` 承担（`renderPatternThumbnail` 的 512 上限**禁用于导出**，
> 见 B4 规格 §3 与 §9 第 3 条），新建一个同名职责的文件只会造出一个没有消费者的模块。
> B4 实际交付的是 `render/types.ts`（core 自己声明的绘制目标接口 `RenderTarget2D`）、
> `render/layout.ts`、`render/sheet.ts`、`render/share.ts`。见 B4 规格 §1.3 的 **D5**（该单元格
> 早期把这份目录结构误标为 §7.1，2026-10-05 已更正）与 §3 的模块边界表。
```

**(1) §7.1（现 `:304-309`）之后插入**（定位原文：`- \`sheet.ts\` 施工图：网格线 + 格内色号 + 行列坐标刻度（每 5 或 10 格） + 底部图例与用量表（色块、色号、颜色名、颗数） + 顶部信息条（尺寸、色卡、总颗数、用色数、生成时间）`）：

```markdown
> **2026-10-05 更正（B4 交付时加注，上面正文不改）**：上面第一行把「**底部图例与用量表**」列为**施工图**的
> 组成部分——**B4 改了这一点**：施工图上**不画图例**，用量表是**独立的一张图**（`legend`）。理由是布局出现
> 循环依赖：图例高 = `ceil(用色数 / 列数) × 行高`，而用色数要等分片方案定下来才知道，分片又取决于每片的网格高。
> 留在施工图上只有两条出路，代价都在 B4 规格 §1.4 里算过：① 按**全图**用色数预留高度 ⇒ 精细档下 500×500 从
> 25 片涨到 **81 片**；② 图例宽度脱离网格宽度 ⇒ 8×8 的小图纸被一张 221 色的表撑到 4000 px 宽。独立成图后
> 高度预算变成纯常量，且「图例全图唯一」消灭了「每片图例各不相同」这一整类缺陷；单片自足性由**格内色号 +
> 信息条（含全图颗数 / 全图用色数 / 本片颗数）+ 页脚（第 r/c 片 · 列 a–b · 行 c–d）**保住。损耗如实记录：
> 只打印某一片时手上没有全图用量表。完整推导见 B4 规格 §1.3 的 **D3** 与 §1.4。
```

**(2) §7.2（现 `:311-313`）之后插入**（定位原文：`格内色号仅当格子像素 ≥ 32px 时绘制；否则自动省略，并在界面上明确提示「图太大，已省略格内色号，建议分片导出」，而不是画一堆看不清的糊字。`）：

```markdown
> **2026-10-05 更正（B4 交付时加注，上面正文不改）**：阈值 **32 px** 不变，但那句提示文案
> 「图太大，已省略格内色号，**建议分片导出**」在 B4 的降级链下**已经失实**——B4 把顺序换成
> 「先降到 32 px（色号阈值）就停 → 转分片 → 仍不行才降到 8 px 并省略色号」，所以走到「省略色号」这一步时
> **已经分过片了**，再建议分片没有意义。B4 的文案是「画布上限 N px 太小，已省略格内色号（每格 x px，
> 低于 32 px）；建议减少豆数或改小图纸」。见 B4 规格 §1.3 的 **D2** 与契约 §4 的逐字文案。
```

**(3) §7.3（现 `:315-322`）之后插入**（定位原文：`1. 降低格子像素（下限 8px）` / `2. 仍超限 → 按拼豆板分区导出多张，每张标注列范围（如「第 1–29 列」）`）：

```markdown
> **2026-10-05 更正（B4 交付时加注，上面正文不改）**：上面这段有**两处**被 B4 改掉，逐条说明。
> ① **降级链的顺序**（正文第 1 条）：不再是「先降格像素（下限 8px）→ 再分片」，而是
> 「① 格像素降到 **32 px**（= 色号可读阈值）就停 → ② 转分片 → ③ 仍不行才降 **8 px** 并**省略色号**
> → ④ 再不行**响亮失败**（提示降低豆数）」。原因是先降到 8px 会得到一张**没有色号**的施工图，
> 而分片本可以保住色号；8 px 保留为最终兜底。主规格 §8 的「导出降级链全部失败 ⇒ 明确提示」正是第 ④ 步。
> ② **分片边界**（正文第 2 条）：不是「每片一块板、标注如『第 1–29 列』」，而是**每片尽量多的整块板、
> 边界取 29 的整数倍**（如「第 1–116 列」）——字面的「每片一块板」会让 500×500 产出 **324 片**，
> 而 29 的整数倍仍与板对齐、片数可控。B4 已实算的样例（58×58 → 1 张 40px/格；116×116 → 1 张 33px/格；
> 200×200 → 4 张；500×500 → **25 张**）在 B4 规格 §5.2 的样例表里。
> 第三句「分片是本功能最易出 bug 的地方」**仍然成立**：B4 为此交付了唯一坐标映射 `cellBox`、
> 一道源码级闸门（渲染器里出现 `cellPx` 即红）与一条跨计划不变量断言（同一格在单张与任一分片里
> 落到同一像素）。见 B4 规格 §1.3 的 **D1** / **D4**、§4.2、§4.4。
```

**(4) §7.4（现 `:324-326`）之后插入**（定位原文：`Android 上写入系统相册需走 MediaStore，**属待验证路径**。降级方案：保存到 App 私有目录 + 调起系统分享面板（微信、相册均可接收），功能等价、用户多点一步。先探，探不通即用降级方案并在 UI 中说明，不假定其可用。`）：

```markdown
> **2026-10-05 更正（B4 交付时加注，上面正文不改）**：**B4 未做这一节**——没写 MediaStore、
> 没调系统分享面板、没用 Web Share API。浏览器阶段只有「保存（`<a download>` 下载）+ **长按预览图**
> 存相册」，上面那句「App 私有目录 + 系统分享面板」的降级方案与「先探」全部留给**引入 Tauri 壳的那一轮**。
> 理由与 B1 规格 §2 的既有纪律同一条：**不写无法在浏览器阶段复现的真机分支**。见 B4 规格 §1.3 的 **D7**、
> §14 人工清单 4 / 5 与 §16 的 B4-R4。
```

**(5) §12 的 R2 行（现 `:407`）**：这一条是**回填**而不是加注记（规格 §17 第 1 条：「这是『验证结论回写本节的项』的既有要求」），格式照同表 R1 行（`:406`）的先例——在「风险」列末尾接 **已定论 + 日期 + 结论 + 指向构建记录**，「验证方式」列补落点，「降级方案」列补 B4 的落地口径。

- **改了哪一格**：整行替换（原行逐字为：
  `| R2 | Android WebView canvas 单边/面积上限具体值 | 真机二分测量 | 降低格子像素 → 分片导出 |`）
- **清单 3 已执行的写法**：
  ```markdown
  | R2 | Android WebView canvas 单边/面积上限具体值 —— **已定论（P_date，P_device）**：单边（短边固定 64）收敛 **P_edge**、面积（正方形）收敛 **P_area**；**B4 取更保守值并向下取整到 2 的幂 ⇒ `EXPORT_MAX_EDGE = N`**（`core/render/layout.ts`） | 真机二分测量（`/lab/canvas` 探针页，B4 交付；原始读数见 B4 构建记录 §7.1） | 降低格子像素 → 分片导出。**B4 的落地口径**：先降到 32 px（色号阈值）就停 → 分片 → 8 px 并省略色号 → 响亮失败（B4 规格 §5.2） |
  ```
  其中 `P_date` / `P_device` / `P_edge` / `P_area` / `N` 是**步骤 1 的变量**（来源：`/lab/canvas` 的「复制为文本」文本与操作者手写的页眉），落笔前先把字面值代入、并把那段文本贴进构建记录 §7.1；**`N` 与所有落点必须一致**（`layout.ts` 常量、`layout.test.ts` 断言、`AGENTS.md`/`CLAUDE.md` 常量行）。
- **清单 3 未执行的写法**（同样不加任何数字）：
  ```markdown
  | R2 | Android WebView canvas 单边/面积上限具体值 —— **未实测（截至 2026-10-05）**：探针页 `/lab/canvas` 已交付（B4 任务 5），真机读数待人工清单 3；`EXPORT_MAX_EDGE` 仍是 **保守下界 4096**，不是实测值 | 真机二分测量（装置已就绪：`/lab/canvas`，B4 交付；读数与回写规程见 B4 构建记录 §7.1 与 B4 规格 §11） | 降低格子像素 → 分片导出。**B4 的落地口径**：先降到 32 px（色号阈值）就停 → 分片 → 8 px 并省略色号 → 响亮失败（B4 规格 §5.2） |
  ```
- **不许**：把 R2 行写成 `4096` 的「实测值」（那是常量）；也不许把 `## 12.1` 那种长小节搬进 §12（R1 的小节先例是它自己的事，R2 的原始读数落在构建记录里）。

**(6) B4 规格 §16 的 B4-R1 行（2026-10-05 的 HEAD 上是 `:705`）**：同一批读数的第二个落点（B4 规格 §11 末尾明写「结果回写本规格 §16 的 B4-R1」；**控制者裁定 2026-10-05 采纳**：§11 自己就写了要回写）。做法两条：
- 在「验证方式」列末尾接一句（逐字）：`（探针页已交付：/lab/canvas；读数与回写值见 B4 构建记录 §7.1）`；
- 若已实测，再在「风险」列末尾接一句（逐字）：` —— **已定论**：单边 P_edge / 面积 P_area ⇒ EXPORT_MAX_EDGE = N（最保守值向下取整到 2 的幂）`，其中 `P_edge` / `P_area` / `N` 同步骤 1 的变量，落笔时代入字面值。
- **不改这一行的其它列**（它记的是规划期的风险与降级方案，属历史正文）。

- [ ] **步骤 3：B3 构建记录 §11 的两条 Minor——**直接改写原文**（人类伙伴已批准，不是加注记）**

**(1) 缺陷 ①：「六次变异实测」括号内只列 5 条红数。**
落点：`docs/superpowers/notes/2026-10-04-app-b3-build-log.md:338-340`（§11 的 `- **F3**：…` 那条 bullet 的末尾）。

改前（逐字）：
```markdown
- **F3**：画布的 `wheel` 通路（**桌面调试增强**，主规格 §6.2）：无修饰键 = 平移（`panCellView`），
  `ctrl+wheel` = 以指针为锚缩放（`scale × exp(-deltaY × 0.002)` + `zoomCellView`），两者都
  `preventDefault()`；触摸屏双指路径一行未动。**判别力**（六次变异实测）：方向反转红 2、锚点换成视口
  中心红 1（−288.56 vs −266.42）、去掉 `preventDefault` 红 3、`panCellView` 换漏夹取红 1
  （−1100 vs −368）、删非有限 `delta` 守卫红 1。
```

改后（逐字；只在括号内补齐**第 6 条**，前 5 条一个字不动）：
```markdown
- **F3**：画布的 `wheel` 通路（**桌面调试增强**，主规格 §6.2）：无修饰键 = 平移（`panCellView`），
  `ctrl+wheel` = 以指针为锚缩放（`scale × exp(-deltaY × 0.002)` + `zoomCellView`），两者都
  `preventDefault()`；触摸屏双指路径一行未动。**判别力**（六次变异实测）：方向反转红 2、锚点换成视口
  中心红 1（−288.56 vs −266.42）、去掉 `preventDefault` 红 3、`panCellView` 换漏夹取红 1
  （−1100 vs −368）、删非有限 `delta` 守卫红 1、**删掉 `requireWheelScale`（组件里对 `nextScale` 的
  第二份守卫）红 0**——第 6 条**红 0 也是判别力的一部分**：它证明那份守卫没有可判别的行为差异，
  据此在同一轮删除（详见本节末尾「两条如实记录」第 2 条）。
```

**(2) 缺陷 ③：「Firefox / Safari 鼠标滚轮常给 `deltaMode = 1`」的 Safari 部分无法核实。**
落点：同文件 `:343-346`（§11「两条如实记录」的第 1 条）。

改前（逐字）：
```markdown
  1. **`deltaMode` 未处理**：目标引擎是 Android Chromium / Tauri 的 WebView2，**`deltaMode` 恒为 0**
     （像素），所以这条缺口不影响交付面；受影响的只有 Firefox / Safari 桌面端——它们的鼠标滚轮常给
     `deltaMode = 1`（行）且 `deltaY ≈ ±3`，一次滚轮平移约 **3px**、`ctrl+` 滚轮一次缩放约
     **0.6%**（几乎无感）。本轮按「范围外如实报上来、不顺手修」处置（简报把公式钉死、也没提 `deltaMode`）。
```

改后（逐字；把 Safari 从「受影响面」里摘出来并标明未核实，方向仍然保守）：
```markdown
  1. **`deltaMode` 未处理**：目标引擎是 Android Chromium / Tauri 的 WebView2，**`deltaMode` 恒为 0**
     （像素），所以这条缺口不影响交付面；受影响的只有 **Firefox 桌面（行模式已确认）**——它的鼠标滚轮
     常给 `deltaMode = 1`（行）且 `deltaY ≈ ±3`，一次滚轮平移约 **3px**、`ctrl+` 滚轮一次缩放约
     **0.6%**（几乎无感）。**Safari 未核实**（本环境无法核实它的 `deltaMode`，因此不再把它与 Firefox
     并列；若它同样给行模式，现象与 Firefox 这一档相同，结论不变）。本轮按「范围外如实报上来、
     不顺手修」处置（简报把公式钉死、也没提 `deltaMode`）。
```

> **第三条延后 Minor（README 的耗时句）不在这里改**——它落在步骤 9（README 记的是**当前状态**，按本轮实测重写）。**B3 构建记录 §1 / §9 的 978 与 §11 的 987 一个字都不动**（「报告是**当时的**证据」，§10.3 的既有口径）。

- [ ] **步骤 4：`buildPatternFromImage` 的「为何公开」JSDoc**

落点：`src/core/pattern/build.ts:160`。原文本（逐字，一行）：
```ts
/** 便捷入口：位图 → 网格 → 图纸。位图应当已经是按裁剪框解码并缩放到目标尺寸的。 */
```
替换为（**只改这一块注释，函数体一行不动**）：
```ts
/**
 * 便捷入口：位图 → 网格 → 图纸。位图应当已经是按裁剪框解码并缩放到目标尺寸的。
 *
 * **为何公开（B4 收尾补写）**：它是「已经拿着解码好的位图」的直通入口——与 `buildPattern` 的差别只有
 * 前面那一步 `resampleToGrid(image, image.width, image.height)`（源宽 == 目标宽时是 1:1 精确复制，
 * 不引入插值）。它的用途是「调用方自己掌握重采样时机」的姊妹入口。
 *
 * **如实写明：它仍然是零生产消费者**——生产路径走 `src/services/pipeline.ts` 的
 * `buildPattern` + `resampleToGrid` 两步（先按裁剪框解码到目标尺寸，再按网格重采样），
 * **B4 的导出也不消费它**（导出直接对 `editor.pattern` 渲染，不再走图纸构建）。
 * **保留还是收窄到内部，留给下一次动到它的人裁决**：它现在的消费者只有
 * `src/core/pattern/__tests__/build.test.ts` 的 `describe("buildPatternFromImage")` 两条用例，
 * 而「不许删改既有测试」意味着收窄要连着改那两条。它与 `nearestCellColor`（sRGB 入参的姊妹 API、
 * 流水线不用它）是同一性质：**只被用例消费、都写明了为何公开**。
 */
```

- [ ] **步骤 5：`AGENTS.md` 与 `CLAUDE.md`——「关键常量」段（**两处逐字相同**）**

落点：两份文件的 `:109-119` 段。在最后一行（`- 编辑器显示阈值 \`GRID_LINE_MIN_CELL_PX = 6\`…`）**之后追加下面这 5 行**（原有 9 行一个字不动）。

**插入文本（`AGENTS.md` 与 `CLAUDE.md` 两处逐字相同）：**
```markdown
- 导出画布单边上限 `EXPORT_MAX_EDGE = 4096`（`core/render/layout.ts`；**探针页 `/lab/canvas` 实测后调整**，
  主规格 §12 的 R2 闭环前它只是主规格 §7.3 所给区间的**保守下界**，不是实测值）
- 施工图格内色号阈值 `SHEET_LABEL_MIN_CELL_PX = 32`（低于它省略色号；**刻意避开**编辑器屏幕提示的
  `CELL_LABEL_MIN_CELL_PX = 28`——同名不同义的量传错不会报错，是本项目记过账的形态）
- 施工图最终兜底格像素 `EXPORT_CELL_PX_FLOOR = 8`（主规格 §7.3；走到这里意味着 `labels = false`）
- 分享图长边上限 `SHARE_MAX_EDGE = 2048`（分享图是「看轮廓」的图，不需逐格可辨）
- 施工图分片步长 `TILE_STEP = BOARD_COLS`（= 29，`core/render/layout.ts`；**不许写第二份字面量 29**——
  分片按整块拼豆板对齐，必须与界面「需要几块板」共用同一组数字）
```

- [ ] **步骤 6：`AGENTS.md` 与 `CLAUDE.md`——「公开 API ≠ 被使用的 API」段（**两处逐字相同**）**

落点：两份文件的 `:103-107`。**整段替换**为下面这段（改动点：① 把 `buildPatternFromImage` 从「尚未写明」移进「已写明」；② 清空「尚未写明」清单；③ 新增 B4 的公开面与消费者）。

**替换文本（`AGENTS.md` 与 `CLAUDE.md` 两处逐字相同）：**
```markdown
**公开 API ≠ 被使用的 API**：导出即承诺。只被测试消费的导出要么收窄到内部，要么在 JSDoc 里
写明它为何公开。**已写明**：`Decoder.outputSize`（自我描述的文档字段、生产路径不读它）、
`nearestCellColor`（sRGB 入参的姊妹 API、流水线不用它）；`patternStats` 自 B2 起有了生产消费者
（`SetupPage.vue` 的结果阶段）并写明了为何公开；`edit.ts` 的四个导出在 **B3** 写明（见上）；
`buildPatternFromImage` 在 **B4** 写明（`core/pattern/build.ts` 的 JSDoc：位图直通入口，
**仍零生产消费者**——生产路径走 `pipeline.ts` 的 `buildPattern` + `resampleToGrid` 两步，
B4 的导出也不消费它；保留还是收窄留给下一次动到它的人）。
**尚未写明（零消费者）**：B4 收尾时这份清单**已清空**——新增公开导出时按本段口径自查并补 JSDoc。
**B4 新增的公开面**：
- `core/render/types.ts` 的 `RenderTarget2D` 是 **core 里第一份不是纯数据的类型**：core 不得引用 DOM
  全局，而 `CanvasRenderingContext2D` 在边界闸门（`src/__tests__/coreBoundary.test.ts` 的
  `FORBIDDEN_GLOBALS`）的禁用清单里——按本节上一条「在 core 定义接口，在 services 注入实现」的口径，
  由 `services/exporter.ts` 把真 ctx 传进去（结构上满足该接口），测试用普通对象桩。取舍如实记录：
  换到的是渲染器的全部布局与文字位置都能在 Node 里被断言。
- `core/render/layout.ts` 的 `planSheets` / `planLegend` / `planShare`：生产消费者是
  `components/editor/ExportPanel.vue`（面板自己持 plan、自己调渲染器）；`cellBox` / `shareCellBox` /
  `countTileBeads` / `labelInk` / `rgbCss` 的消费者是**渲染器**（`cellBox` 是施工图格坐标 → 输出像素的
  唯一映射，`shareCellBox` 是分享图那一条同口径的映射——**两个渲染器都不许自己乘格像素**，
  `rgbCss` 是输出层唯一的颜色序列化口径，两个渲染器共用）。
- `core/render/sheet.ts` / `share.ts` 的 `drawSheetTile` / `drawLegend` / `drawShare`：生产消费者是
  `ExportPanel.vue`（吃 `services/exporter.ts` 建好的画布上下文）。
- `services/exporter.ts` 的 `createCanvasStrict` / `requireContext2D` / `canvasToBlob` / `downloadBlob` /
  `exportFilename`：生产消费者同样是 `components/editor/ExportPanel.vue`（面板是 services 层之外唯一
  调用它们的组件）。
- `core/pattern/board.ts` 的 `BOARD_COLS` / `BOARD_ROWS`：**当前只被同文件的 `boardCount` 与常量断言
  用例消费**（`board.test.ts` 的 `expect(BOARD_COLS).toBe(29)`）；B4 的分片步长 `TILE_STEP = BOARD_COLS`
  是它们的**第一个跨文件消费者**——这正是它们当初被导出的理由（分片必须与界面「需要几块板」共用同一组数字）。
```

> **落笔前再核一次导出清单（这条不能省）**：契约 §2 在实现期会随任务 1–4 的发现增补（本轮已知两次：
> **`shareCellBox` 是新导出**、**`drawLegend` 多了一个必需的 `palette` 入参**）。粘贴上面这段之前，先
> `Select-String -Path src\core\render\*.ts, src\services\exporter.ts -Pattern '^export (function|const|interface)'`
> 与契约 §2 对一遍，**以最终代码为准**：代码里有、上面这段没写的公开导出，必须补进这一段（R-8：两份文件的
> 同一段**逐字相同**）。同理，若某个导出最后**没有**生产消费者，按本段的既有口径**如实写明**，不要笼统写成
> 「面板消费」。

- [ ] **步骤 7：`README.md`——「当前进度」段（`:82` 之后插入 B4 段）与「下一步」（`:84`）**

**(1) 在 `:82` 的 `/lab/decode` 那一条 bullet **之后**、`:84` 的「下一步」**之前**插入：

```markdown
应用层 **B4（导出）** 已完成：编辑器页内新增「导出」面板，把**当前内存里的图纸**（含未保存的涂改）渲染成
三类 PNG，**逐张由用户手势保存**（点一次 = 渲染一张 → 立刻下载 → 面板内显示预览；不做连续多下载、不做 zip）。
`npm run dev` 后：

- `/edit/:id` 的**「导出」面板**（B4 交付）：打开即显示**计划摘要**（纯计算、不建画布），三组产物逐项列出
  （施工图 N 项 + 用量表 1 项 + 分享图 1 项），每项一个「保存」：
  - **施工图**：网格 + **格内色号**（格像素 ≥ 32 px 时才画，否则省略并给琥珀提示）+ 行列坐标刻度（每 5 格）
    + **拼豆板边界**（每 29 格，粗线）+ 顶部信息条（工程名 / 尺寸 / 成品厘米 / 色卡 / 全图与**本片**颗数 /
    生成时间 /「屏幕色仅供参考，以实物为准」）+ 页脚（第 r/c 片 · 列 a–b · 行 c–d · 本片颗数）；
    超过画布上限时自动**分片**（每片尽量多的**整块板**，边界落在 29 的整数倍上）。
  - **降级链**（与主规格 §7.3 的偏离见 B4 规格 §1.3 的 D1）：① 格像素降到 **32 px**（色号阈值）就停 →
    ② 转分片 → ③ 仍不行才降到 **8 px** 并省略色号 → ④ 再不行**响亮失败**（提示降低豆数）。
  - **用量表**：独立成图的全图用量表（色块 / 色号 / 名称 / 颗数 / 合计）+ 精度声明 + 生成时间——
    **图例不画在施工图上**（理由见 B4 规格 §1.4）；空图纸（`usages` 为空）**不画表头与色块**，
    只留标题 + `合计 0 颗` + 精度声明 + 生成时间。
  - **分享图**：纯色块、无网格无文字、空格透明（长边 ≤2048 px）。
  - **图纸来源是内存态**（`editor.pattern`，含未保存改动）；图纸一改（`revision` 变**或** `pattern` 换了
    对象——`beginSession` 会把 `revision` 归零，0→0 那一跳不触发）⇒ 所有「已生成」状态立刻复位、
    预览丢弃——**不会导出旧图纸**。
  - 手机上也可以用**长按预览图**存进相册（浏览器阶段只有下载 + 长按保存；MediaStore 与系统分享面板
    留给引入 Tauri 壳的那一轮）。
- `/lab/canvas` **canvas 上限探针**（**开发期实验台，不进任何用户入口**）：固定短边 64 走档位梯量**单边上限**、
  正方形走同一条梯量**面积上限**；每档三个判据（写回值一致 / 有 2D 上下文 / 填色后能读回）缺一不可，
  取最后一个全过的档位为下界、它的下一档为上界，**二分 8 次**收敛；结果用来回写 `EXPORT_MAX_EDGE`
  与主规格 §12 的 R2。
```

**(2) `:84` 那一行**整行替换：

改前（逐字）：`下一步：计划 B4（导出：施工图 / 分享图 / 分片）→ Tauri Android 壳（相机 / 相册 / 系统分享）。`
改后（逐字）：
```markdown
下一步：Tauri Android 壳（相机 / 相册 / 系统分享）。
```

- [ ] **步骤 8：`README.md`——目录结构（5 处）与「文档」节**

**(1) `src/core/` 列表**（`:122-134`）：在最后一条（`- \`project/\`：工程文件契约…`）之后追加：
```markdown
  - `render/`：**导出几何与渲染（`layout.ts`：画布尺寸 / 格像素 / 分片 / 格子→输出像素的**唯一**映射
    `cellBox`；`types.ts`：core 自己声明的绘制目标接口 `RenderTarget2D`；`sheet.ts`：施工图与用量表；
    `share.ts`：分享图）**
```

**(2) `src/services/` 段**（`:135-137`）：在结尾「工程存储：IndexedDB 与内存两个实现共用一套契约测试」之后追加：
```markdown
**、`exporter.ts`：建画布（严格回读宽高、超限即抛）/ `toBlob` / `<a download>` 下载 / 文件名清洗**
```

**(3) `src/components/` 段**（`:144`）整行替换：

改前（逐字）：
```markdown
  **`editor/`：`PatternCanvas` 分层渲染与手势、`PatternToolbar`、`PalettePanel`、`PalettePicker`**）
```
改后（逐字）：
```markdown
  **`editor/`：`PatternCanvas` 分层渲染与手势、`PatternToolbar`、`PalettePanel`、`PalettePicker`、
  `ExportPanel`（导出面板：props 进 / `close` 出；自己持 plan、自己调 `core/render/*` 与
  `services/exporter.ts`）**）
```

**(4) `src/views/` 段**（`:147-149`）整段替换：

改前（逐字）：
```markdown
- `src/views/` — 页面（`LibraryPage.vue` 图纸库、**`PickPage.vue` 选图（`/new`）**、
  **`SetupPage.vue` 选区 / 参数 / 结果（`/new/setup`）**、`EditorPage.vue` 编辑器宿主
  （装配 / 保存 / 未保存拦截 / 重载）、`DecodeLabPage.vue` 解码实验台）
```
改后（逐字）：
```markdown
- `src/views/` — 页面（`LibraryPage.vue` 图纸库、**`PickPage.vue` 选图（`/new`）**、
  **`SetupPage.vue` 选区 / 参数 / 结果（`/new/setup`）**、`EditorPage.vue` 编辑器宿主
  （装配 / 保存 / 未保存拦截 / 重载 / 导出面板）、`DecodeLabPage.vue` 解码实验台、
  **`CanvasLabPage.vue` canvas 上限探针（`/lab/canvas`，开发期实验台）**）
```

**(5) `src/router/` 段**（`:150-151`）整段替换：

改前（逐字）：
```markdown
- `src/router/` — 路由表（`/`、`/new`、`/new/setup`、`/edit/:id`、`/lab/decode`）与
  **`__tests__/index.test.ts`**（钉住 `/new` 与 `/new/setup` 指向哪个组件）
```
改后（逐字；**控制者裁定 2026-10-05**：不新开「路由表」节，就把 `/lab/canvas` 加进这一行，并把「开发期实验台，不进用户入口」这条约定与 `/lab/decode` 并列写入）：
```markdown
- `src/router/` — 路由表（`/`、`/new`、`/new/setup`、`/edit/:id`、`/lab/decode`、`/lab/canvas`——
  后两条是**开发期实验台，不进任何用户入口**，只给开发者用、页面上也如此自标）与
  **`__tests__/index.test.ts`**（钉住 `/new`、`/new/setup` 与 `/lab/canvas` 指向哪个组件，都做**恒等**比较）
```

**(6) 「文档」节**（`:285-292`）：在最后一条（`- [计划 B2 构建记录](docs/superpowers/notes/2026-10-03-app-b2-build-log.md)`）之后追加 B4 三份：
```markdown
- [计划 B4 设计规格（导出：施工图 / 用量表 / 分享图 / 降级链 / 分片）](docs/superpowers/specs/2026-10-05-app-b4-export-design.md)
- [计划 B4 实现计划](docs/superpowers/plans/2026-10-05-app-b4-export.md)
- [计划 B4 构建记录](docs/superpowers/notes/2026-10-05-app-b4-build-log.md)
```
> **只加 B4 三份**（**控制者裁定 2026-10-05**）：README 的「文档」节**同时缺 B3 的三份**（规格 / 计划 / 构建记录）与第一阶段的构建记录——那是早于本任务的既有缺口。裁定是**不改 README 去补历史链接**（补会与 B3 收尾的范围打架），而是把它**如实记为延后 Minor**：账本里一条（`minor (deferred)` 或「本轮另外明确接受的项」，由控制者定编号）+ 构建记录 §8 的「E. 文档债」一组 + README 新增的「计划 B4 的延后项」表里一行（见步骤 10 的第 2 条与步骤 11 的 §8 骨架）。

- [ ] **步骤 9：`README.md`——「实测」段的账目、耗时句与构建行（**规程 + 闭合校验**）**

**(1) 账目**：`:101-107` 这一整段（从 `- **全量测试**：**55 文件 / 987 用例**全绿…` 到 `…先查清再落笔）。`）**整段替换**为下面这段——**每个数字位置都写成变量名，落笔前用步骤 1 取到的运行期值代入，代入后整段不许再出现字母变量**：

改前（逐字，供定位，不要照抄）：
```markdown
- **全量测试**：**55 文件 / 987 用例**全绿（2026-10-04 人工验证后的一轮修复之后**回原始清单重数**。
  **计数方法**（写在这里是为了防复发：这个数字在本项目已出错三次）：`src/**/*.test.ts` 按路径递归枚举
  数文件；`describe(` 按**行首**计数；`it(` 按 **`\bit\(` 全局**计数（含同行声明的那 1 条）；
  `it.each` **逐表展开**；`services/__tests__/projectStoreContract.ts` 的 **27** 条被内存 / IndexedDB
  两个实现各跑一遍（**54 例**）；`services/__tests__/decoders.test.ts` 的两元素数据循环多跑 **1** 条。
  分解式：**904 + 28 + 54 + 1 = 987**，与运行期总数逐位相等；`describe(` **221**、`it.each` **7** 条。
  **重数之后必须做这道闭合校验**——分解式与运行期总数对不上，就说明至少有一个数是错的，先查清再落笔）。
  对照：B2 收尾时本行记的是 47 文件 / 755 用例，而 B3 规格 §15 记的规划期实测是 47 文件 / 775 用例
  ——**两个旧数字不一致**，本行以实测输出为准（B3 起净增 **+8 文件**，用例数对 775 是 **+212**、
  对 755 是 **+232**；其中 `views/__tests__/EditorPage.test.ts` 7 → **43** 条、
  `views/__tests__/EditorPageRouterLink.test.ts` **2** 条、
  `components/editor/__tests__/PatternCanvas.test.ts` 20 → **25** 条）。
```
改后（**结构一字不动，只把数字换成变量、并补上「可机检」与「本计划的文件账目」两句**）：
```markdown
- **全量测试**：**F 文件 / T 用例**全绿（2026-10-05 应用层 B4 收尾之后**回原始清单重数**。
  **计数方法**（写在这里是为了防复发：这个数字在本项目已出错三次）：`src/**/*.test.ts` 按路径递归枚举
  数文件；`describe(` 按**行首**计数；`it(` 按 **`\bit\(` 全局**计数（含同行声明的那 1 条）；
  `it.each` **逐表展开**；`services/__tests__/projectStoreContract.ts` 的 **C** 条被内存 / IndexedDB
  两个实现各跑一遍（**2C 例**）；`services/__tests__/decoders.test.ts` 的两元素数据循环多跑 **1** 条。
  分解式：**I + R + 2C + 1 = T**，与运行期总数逐位相等；`describe(` **D**、`it.each` **E** 条。
  **重数之后必须做这道闭合校验**——分解式与运行期总数对不上，就说明至少有一个数是错的，先查清再落笔）。
  **三项可机检的数与那道分解式一律由 `node .superpowers/sdd/2026-10-05-app-b4-export/tools/count.mjs`
  打印**（它按显式 UTF-8 读文件、契约那份 ×2 自动算进去）——**不要手抄，也不要用任何汇总行**。
  对照：B3 收尾时本行记的是 55 文件 / 987 用例（另有 B3 构建记录 §1 / §9 的 978 与 §11 的 987 两代读数，
  那是**当时的证据**，保留不改）；B4 净增 **+（F−55）文件 / +（T−987）用例**（两个差值落笔时算成字面值），
  其中本计划新增的测试文件是 `core/render/__tests__/{layout,layoutGate,sheet,share}.test.ts`、
  `services/__tests__/exporter.test.ts`、`components/editor/__tests__/ExportPanel.test.ts`、
  `views/__tests__/CanvasLabPage.test.ts`，另有三份既有测试文件**只加不改**
  （`PatternToolbar.test.ts` / `EditorPage.test.ts` / `router/__tests__/index.test.ts`）。
```
> **`C` 的核对**：本计划没改 `projectStoreContract.ts`，所以脚本打印的 `C` **应当仍是 27**。若打印的不是 27，说明有别的改动混进来了——**先查清再落笔**（不要直接把打印值抄进去而不管它为什么变）。
> **分解式对不上时先怀疑仪器**（控制者裁定 2026-10-05）：`count.mjs` 与 README 这一句是**同一件仪器的两份表述**，改一边就必须同时改另一边；先显式 UTF-8 手工重数，再判断是脚本错还是运行期读数错。

**(2) 耗时句**：`:113-115` 那一句（从 `` `npm run test` 实测约 **8 s**（本机多次实测 7.7–8.6 s…`` 到 `…同样 **55 文件 / 987 用例**绿。`）**整句替换**：

改前（逐字，供定位）：`` `npm run test` 实测约 **8 s**（本机多次实测 7.7–8.6 s；冷启动那次 18.2 s，含 happy-dom 环境的一次性开销。**绝对耗时随机器负载波动**，单次读数别当基准）；`TZ=UTC npm run test`（与 CI 同环境）同样 **55 文件 / 987 用例**绿。``
改后（逐字，用 `S_mid` / `S1` / `S2` / `S3` 代入）：
```markdown
  `npm run test` 实测约 **S_mid**（S_mid = 本轮连续三次全量跑的 `Duration` 中位数，三次读数为 S1、S2、S3；
  冷启动那次含 happy-dom 环境的一次性开销，**不参与这个中位数**。**绝对耗时随机器负载波动**，
  单次读数别当基准——本行上一版写的「7.7–8.6 s」与阶段交接记的「5.17 / 5.53 s」都是**当时的实测**，
  两者不矛盾，README 记的是**当前状态**）；`TZ=UTC npm run test`（与 CI 同环境）同样 **F 文件 / T 用例**绿。
```
> 用时**至少连跑三次**再写中位数（上一版单次读数被后来的两次推翻过），并把这三次的原始 `Duration` 一行贴进构建记录 §9。

**(3) 构建行**（`:116-117`）：把 `94 modules` 与 `0.97–1.90 s` 换成 `B` 的实测值（至少两次读数取区间）。**理由**：本计划新增了页面与模块，Vite 的 `modules transformed` 必然与 94 不同；README 的「实测」段记的是**当前状态**。
> §17 没有点名这一行，但留着过期的 modules 数会与「README 记当前状态」的既有口径打架。**控制者裁定 2026-10-05：采纳这处顺手回填**（与 B4 规格 §16 的 B4-R1 行那处一同采纳）。

**(4) 不要动**：引擎构建耗时表（`:88-100`）与「干净安装」（`:118`）——本轮没有引擎侧行为改动，重测它们不在 §17 的范围内。

- [ ] **步骤 10：`README.md`——新增「计划 B4 的延后项」节（照 B1 / B2 的先例）**

落点：`## 计划 B2 的延后项` 那一节结束之后、`## 文档`（`:285`）**之前**。新增节如下（**表格内容整段来自账本，不在这里预写任何一行**）：

```markdown
## 计划 B4 的延后项

同样是「判定为可接受、明确不修」的项，逐条记此以免后来者当成待办。完整记录（含**简报 / 计划缺陷总表**、
控制者自己的错误清单、被推翻的结论、以及平台与环境事实）见
[计划 B4 构建记录](docs/superpowers/notes/2026-10-05-app-b4-build-log.md)。

**编号来源与口径**（**控制者裁定 A，2026-10-05**：README 与构建记录 §8 **必须用同一套编号与同一个 `K`**）：
`B4-1…B4-K` 是控制者进度账本 `.superpowers/sdd/2026-10-05-app-b4-export/progress.md` 里**全部**
`minor (deferred)` 行的逐条搬运——**`K` 收尾时回账本数**（`Select-String -Pattern 'minor \(deferred\)'`
数出的**行数**，执行阶段每审查出一条 minor 都由控制者逐条记进账本并带该标记），**下表「账本行」那一段的行数
必须逐位等于 `K`**，每条在「是什么」列尾部用括号给出**账本行号**便于回溯；**一行一条、不合并不改写**。
`B4-(K+1)…` 是**账本之外**的「本轮另外明确接受的项」，逐条在「为什么接受」列写明出处，共三类：
① 控制者 2026-10-05 裁定「不在本轮补」的**文档债**（见下表第一行）；
② 规格 §2 的不做项与 §13.4 的「CI 测不到」、（人工清单未执行的条目）；
③ **已按人类伙伴批准直接改写掉的 B3 §11 两条 Minor**（它们不是延后项，是**已修**——在此登记是为了
让「B3 的两条 Minor 已闭环」这件事与账本对得上）。
**两类不许与 `K` 混算**，否则重数必然对不上。

| # | 是什么（账本行号） | 为什么接受 / 何时该修 |
|---|---|---|
| B4-(K+1) | README「文档」节缺 B3 三份（B3 设计规格 / 实现计划 / 构建记录）与第一阶段构建记录的链接（**早于 B4 的既有缺口**；控制者 2026-10-05 裁定不在本轮补，只登记）。 | 补历史链接会与 B3 收尾的范围打架，且与本轮交付无关；本轮只加 B4 三份。**何时该修**：任何人下一次改「文档」节时顺手补齐，或专门一次纯文档提交。 |
| B4-(K+2) | **已完成、非延后**：B3 构建记录 §11 的两条 Minor（① 「六次变异实测」括号内补第 6 条（`requireWheelScale` 删除 → 红 0）；③ Safari 措辞改成「Firefox 桌面（行模式）已确认；Safari 未核实」）——人类伙伴批准**直接改写原文**，已在任务 6 步骤 3 落地。 | 登记它是为了让账本对得上（裁定 A 的第 ③ 类）；**它不是待办**，不要当延后项维护。 |
| …（其余逐行搬运，一条不落）… |
```

**落地规程（四条，缺一条就不许落笔）**：
1. `Select-String -Pattern 'minor \(deferred\)' .superpowers/sdd/2026-10-05-app-b4-export/progress.md` 数**行数** → 记下 `K`；**上表「账本行」那一段的行数必须等于 `K`**（不等就先查清：漏搬或多搬都要当场修），并把这条**计数方法**写进 README 的同一句（照 B2 先例：「`grep` 重数为 N 行 + 每行括号给账本行号」）；
2. 每条按账本原文搬运（**不合并不改写**），并在「是什么」列尾部标注账本行号；
3. **账本之外的三类行要单独标注、且不许与 `K` 混算**（文档债 / 规格 §2 与 §13.4 的明确接受项 / **已直接改写掉的 B3 §11 两条 Minor**——后者的两条要写明「已完成」，不是「延后」）；它们从 `B4-(K+1)` 起编号，并在「为什么接受」列写明出处。**若不这么分，重数就会与表格行数对不上**（这正是控制者裁定 A 要定的口径；README 与本骨架的 §8 必须用**同一个 `K` 与同一套编号**）；
4. 若 `K = 0`（账本里没有任何 `minor (deferred)` 行），本节正文改为一句「**本轮没有账本级的延后项**」，**标题保留**（便于后续检索），照上面第 3 条把「本轮另外明确接受的项」照列，并在构建记录 §8 里如实说明这个 0 是怎么来的（账本路径 + 计数命令 + 输出）。

> **账本不存在时的处置**：`.superpowers/sdd/2026-10-05-app-b4-export/progress.md` 是**实现期**才产生的（规划期该目录只有 `CONTRACT.md` 与 `tools/count.mjs`）。若收尾时它仍不存在，按上面第 4 条的写法处理，并在构建记录 §8 写明「账本缺失」——**不许**用别的数字凑一张表。

- [ ] **步骤 11：新建 `docs/superpowers/notes/2026-10-05-app-b4-build-log.md`（照 B3 构建记录的骨架）**

下面是要写进文件的**完整骨架**（除「实测数字」外全部就位；涉及数字的位置一律给变量与取值来源）。

> **骨架里的 `〔…〕` 是「填写指令」，不是待办标记**：每一处都写明了「填什么、从哪取」。落进仓库的那份文件里**不许残留任何 `〔`**——收尾时用
> `Select-String -Path docs\superpowers\notes\2026-10-05-app-b4-build-log.md -Pattern '〔'` 自查，**预期零命中**（这条与 README 账目的闭合校验同性质：写不下去的地方要当场查清，不是留个记号走人）。
> 另外**不许**把 `F` / `T` / `P_edge` 这类变量名原样留在文件里——变量表只是「取值来源」的说明，落笔时一律代入字面值。

骨架之后是本任务要求的**回填清单**（哪几节必须用真实读数回填 + 回填方法），它**不是文件内容**，是给实现者的作业说明。

````markdown
# 计划 B4（导出）构建记录

> 这份记录保存**判断依据**，而不只是结论。规格写「是什么」，README 写「怎么用」，这里写**为什么是这样、
> 以及过程中哪些判断被推翻过**。
>
> 记录范围：`main` 的 `6eb85b0`（B4 的实现计划骨架与契约落盘）→ `feat/app-b4-export` 的整个计划 B4 实现过程
> （2026-10-05），共 6 个任务（5 是探针页、6 是收尾）+ 按需的修复轮与整分支最终审查。
> 逐任务的原始证据（任务简报、实现报告、修复报告、变异日志、审查包）在构建期存放于
> `.superpowers/sdd/2026-10-05-app-b4-export/`，该目录被 gitignore（`.superpowers/sdd/.gitignore` 是 `*`）。
> **控制者的进度账本**是同目录的 `progress.md`（含全部裁决与延后项的原始记录）。

---

## 1. 交付物

| | |
|---|---|
| 分支 | `feat/app-b4-export`（基点：`main` 的 `6eb85b0`；**收尾时用 `git log --oneline main..HEAD` 的头尾两笔核对**） |
| 任务 | 6 个（1–6，其中 5 是 `/lab/canvas` 探针页、6 是收尾） |
| 提交 | **`(git log --oneline main..HEAD).Count`**（并分段重数：实现 N 笔 + 修复轮 M 笔 + 收尾文档 K 笔，各段由 `--grep` 分别数） |
| 测试 | **`F` 文件 / `T` 用例**（起点 `main` 是 55 文件 / 987 用例；增量 `F−55` / `T−987`）；`TZ=UTC` 同 |
| 关键交付 | 编辑器页内的导出面板：施工图（超限分片，格像素 ≥32 才画色号）+ 用量表（独立成图）+ 分享图；色号优先的降级链；唯一坐标映射 `cellBox` + 两道源码闸门 + 跨计划不变量断言；`/lab/canvas` 探针页（R2 真机实测装置） |

**生产代码账目**：新增 `core/render/{types,layout,sheet,share}.ts`、`services/exporter.ts`、
`components/editor/ExportPanel.vue`、`views/CanvasLabPage.vue`（**逐个与 `git diff --stat main..HEAD` 核对，
不许引用任何汇总行**）；修改 `components/editor/PatternToolbar.vue`、`views/EditorPage.vue`、
`router/index.ts`、`core/pattern/build.ts`（只补 JSDoc）。
**测试文件账目**：新增 `core/render/__tests__/{layout,layoutGate,sheet,share}.test.ts`、
`core/render/__tests__/helpers.ts`、`services/__tests__/exporter.test.ts`、
`components/editor/__tests__/ExportPanel.test.ts`、`views/__tests__/CanvasLabPage.test.ts`；
修改（只加不改）`components/editor/__tests__/PatternToolbar.test.ts`、`views/__tests__/EditorPage.test.ts`、
`router/__tests__/index.test.ts`。

---

## 2. 这一轮的主线：〔收尾时由控制者裁定后写一句判断句〕

> 形状照 B3 §2：B3 的主线是「计划的『代码块』与『判别力构造』都不可信（第七次确认）」。B4 的主线由控制者
> 在收尾时按实际过程裁定，**不许预先编造**；写的时候必须能回答「这一轮最贵的教训是哪一条、它由谁发现」。

### 简报 / 计划缺陷总表（**下一份计划最该读的一节**）

| # | 任务 | 简报或计划里的缺陷 | 若照抄的后果 | 谁发现 |
|---|---|---|---|---|
| 〔逐条回填〕 | | | | |

**收敛出的做法**（分派下一份计划时照做）：〔逐条回填〕

---

## 3. 控制者自己的错误清单（本轮）

| # | 错误 | 形态（推理 / 转述 / 算术 / 脚本事故 / 自检清单不全） | 谁纠正 |
|---|---|---|---|
| 〔逐条回填〕 | | | |

**模式**：与计划 A / B1 / B2 / B3 一致——控制者**在做判断上很少出错**，但**每一条都必须由别人的独立复核
或自己的事后取证才能发现**。〔本轮的具体形态逐条回填〕

---

## 4. 被推翻的结论

〔逐条回填：编号 + 「原来的结论」→「不成立」+ 谁推翻 + 修法。照 B3 §4 的写法，一条一段。〕

---

## 5. 平台 / 环境事实（本轮新增，后续别重踩）

| 事实 | 影响 |
|---|---|
| 〔逐条回填〕 | |

**候选条目（发生时务必写下来，没发生就不写）**：
- happy-dom 的 `getContext("2d")` 在未注册 adapter 时返回 `null`，可被 `document.createElement` 的替身完全接管
  （探针页用例的桩法）；
- 真实浏览器对**超限画布**的钳制形态（置 0 / 截断 / `getContext` 返回 null / 崩标签页）——这一条只能由
  人工清单 3 得到，**读数里必须写清是哪一种**；
- `getImageData` 在超大画布上抛错的具体消息；
- PowerShell 的编码坑（读/写含中文的文件一律显式 UTF-8；`Set-Content -Encoding utf8` 仍写 BOM）。

---

## 6. 「断言存在 ≠ 断言有效」在本轮的形态

| 形态 | 实例 | 打掉它的手段 |
|---|---|---|
| 〔逐条回填〕 | | |

〔至少回答一个问题：本轮有没有「删掉一条用例，全量测试照样全绿」的形态？如果有，是哪一条，处置是什么。〕

---

## 7. 浏览器 / 真机人工验证：**人类伙伴实测**（逐条如实记录）

规格 §14 的清单 1–10 由人类伙伴在 `npm run dev`（手机联调用 `npx vite --host`）上逐条走一遍；
**没走到的条目如实写「未执行」**（B3 §7 的先例：无效读数与缺失项本身就是这一轮的收获）。

| # | 条目 | 结果 |
|---|---|---|
| 1 | 桌面：58×58 施工图（色号可读、29/58 格处粗线、每 5 格刻度、空格斜线、信息条含精度声明、页脚片范围） | 〔回填：通过 / 部分通过 / 未执行 + 现象〕 |
| 2 | 桌面：500×500 导出（25 张、首末片范围与边界格一致、相邻片接缝同格同色、无缺列无重复列） | 〔回填〕 |
| 3 | 手机：`/lab/canvas` 记录单边与面积上限真值 | 〔回填 → 同时落进 §7.1〕 |
| 4 | 手机：导出施工图并**长按预览**存相册 | 〔回填〕 |
| 5 | 手机：导出分享图（无网格无文字、空格在相册白底上无异常） | 〔回填〕 |
| 6 | 手机：导出 116×116（单张 3940×4072 ≈ 64 MB RGBA，不崩不白屏；记录耗时与内存表现；**若崩** ⇒ 下调 `EXPORT_MAX_EDGE` 一处常量并如实记录） | 〔回填〕 |
| 7 | 桌面 + 手机：改一格**不保存**直接导出（图里那一格是新颜色） | 〔回填〕 |
| 8 | 桌面：连续点 6 个分片的「保存」（不应出现「已拦截多个下载」；文件数与本片数一致） | 〔回填〕 |
| 9 | 空图纸（全白格）：面板如实说明、用量表合计 0、分享图为全透明（文件极小） | 〔回填〕 |
| 10 | 横竖屏切换 / 面板打开期间（触控目标 ≥44px、不丢编辑态） | 〔回填〕 |

### 7.1 `/lab/canvas` 的 R2 原始读数与回写

**这一节必须贴「复制为文本」的原文，不许精简、不许转述。** 头部手写 `P_date` / `P_device`（探针页取不到
日期与设备，只有时间戳）。

```text
〔把 /lab/canvas 的「复制为文本」整段原文贴在这里（开头先补一行「P_date · P_device」）〕
```

**回写结果**：
- `P_edge` = 〔单边方向那一行的收敛值〕，`P_area` = 〔面积方向那一行的收敛值〕；
- `N = 2 ** Math.floor(Math.log2(Math.min(P_edge, P_area)))` = 〔落笔时算成字面值〕；
- 落点一致性**逐条打勾，缺一个就是漏写**：`core/render/layout.ts` 的 `EXPORT_MAX_EDGE`、
  `core/render/__tests__/layout.test.ts` 的常量断言、`AGENTS.md` + `CLAUDE.md` 的常量行；
  以及两份规格的落点：主规格 §12 的 R2 行、B4 规格 §16 的 B4-R1 行；
- **若清单 3 未执行**：这一节写「未执行」+ 原因，并把「`EXPORT_MAX_EDGE` 仍是保守下界 4096、不是实测值」
  写进 R2 行（两处落点按未实测分支写）。

---

## 8. 正式接受的限制与延后项（B4-1 … B4-K）

编号与**控制者账本** `.superpowers/sdd/2026-10-05-app-b4-export/progress.md` 里的 `minor (deferred)` 行
一一对应（`grep -c "minor (deferred)"` 重数 = **K**，与本节的条数**逐位相等**），**一行一条、不合并不改写**。
本节按**主题**归并列出「是什么」，避免与账本两处措辞漂移（照 B3 §8 的 A/B/C/D 四类分组法）。

**A. 报告 / 记账口径类**〔回填〕
**B. 注释 / 文档与代码的轻微不符**〔回填〕
**C. 覆盖缺口（补法明确、当前不构成风险）**〔回填：含规格 §13.4 那四条「CI 测不到」，以及探针页的
「真实上限」「真实像素」「真实钳制形态」三条〕
**D. 明确不做（与规格 §2 / §13 一致）**〔回填：PDF / A4 分页、MediaStore 与系统分享面板、连续多下载与 zip、
「单张大图（无色号）」开关、导出进度条与取消、DPR 参与导出〕
**E. 文档债（不在本轮范围）**：README「文档」节缺 B3 三份（B3 设计规格 / 实现计划 / 构建记录）与第一阶段
构建记录的链接（**早于 B4 的既有缺口**；控制者 2026-10-05 裁定不在本轮补，只登记，本轮只加 B4 三份）。
何时该修：任何人下一次改「文档」节时顺手补齐，或专门一次纯文档提交。

**编号口径**（控制者裁定 A：README 的同一节与本骨架**必须用同一个 `K` 与同一套编号**）：
`B4-1…B4-K` 与账本的 `minor (deferred)` 行一一对应——`K` 由
`Select-String -Pattern 'minor \(deferred\)' .superpowers/sdd/2026-10-05-app-b4-export/progress.md`
数**行数**得到，与这一段的行数**逐位相等**，每条在「是什么」列尾部给出账本行号；**账本之外**三类从
**B4-(K+1)** 起单列并写明出处——① 控制者裁定的文档债；② 规格 §2 的不做项 / §13.4 的「CI 测不到」/
人工清单未执行；③ **已按人类伙伴批准直接改写掉的 B3 §11 两条 Minor**（写明「已完成」，不是延后项）。
**三类不许与 `K` 混算**，否则重数必然对不上；README 那一节按同一口径写，**两处行数必须一致**。

**K = 0 时**：本节写「本轮账本里没有 `minor (deferred)` 行」，并附计数命令与原始输出；**不许**留空表，
且第 ① / ② / ③ 三类仍要照列。

---

## 9. 最终验证（原始输出）与账目回原始清单重数

```powershell
npm run test
 Test Files  F passed (F)
      Tests  T passed (T)
   Duration  S…

$env:TZ="UTC"; npm run test
 Test Files  F passed (F)
      Tests  T passed (T)

npm run build
〔输出尾部原文：modules transformed / built in〕
```

**账目回原始清单重数**（显式 UTF-8；**三项可机检的数不要手抄**）：

```bash
node .superpowers/sdd/2026-10-05-app-b4-export/tools/count.mjs
```

**闭合校验**：`I + R + 2C + 1 === T` **并且** `F === 脚本的文件数`——两个等式都要成立；不等就是有数错了，
**先查清再落笔**（本项目在这个数字上出错过三次）。分解式与运行期总数**逐位相等**的证据就是这里贴的两段原始输出。
另记：`describe(` 的**行首**计数是 `D`（纯正则会多算 `draft.test.ts` 里 JSDoc 的一次引用，差额照 B3 §9 的写法说明）；
无 `.only` / `.skip` / `.todo`。

---

## 10. 整分支最终审查与修复波（若发生了才写）

〔回填：审查覆盖范围（提交区间 / 文件数 / 行数）、结论（修完再合 / 可合）、Critical 与 Important 条数、
逐条处置、修复波提交与随后定向复审的结论〕

---

## 11. 人工验证后的一轮修复（若发生了才写）

〔回填：人类伙伴报回几条、哪几条代码/文档项、哪一条明确不做（性能类？）、提交列表、本轮最终账目（以本节为准，
§1 / §9 的旧读数是**当时的证据**，保留不改——B3 §10.3 的既有口径）〕

---

## 12. 未验证面与后续优先级（如实）

**这一节回答一个问题：这份交付里，哪一件事最可能在下一次真机使用中咬人。** 表的最后一行永远留给
「若 `/lab/canvas` 的实测值把 `EXPORT_MAX_EDGE` 判小了」——它是本轮唯一一条「正确性/可用性」级别的悬空项。

| # | 未验证 / 未闭环的事 | 现状 | 后续怎么闭环 | 优先级 |
|---|---|---|---|---|
| 1 | **若实测 `N < 4096`**：`EXPORT_MAX_EDGE` 仍停在保守下界 4096，而平台真实上限更小 | 任务 6 **不改代码**（代码在人工验证前已冻结）：要改的是 `core/render/layout.ts` 的常量、`core/render/__tests__/layout.test.ts` 的常量断言、`AGENTS.md` 的常量行、`CLAUDE.md` 的常量行**共四处文件** | **触发条件（控制者裁定 B，2026-10-05）**：人类伙伴报回读数后的**当天**，由**控制者**立新一版小轮简报，工作区 `.superpowers/sdd/<日期>-app-b4-canvas-limit/`（照 B3 人工验证小轮的先例：简报 + 分派实现者 + 控制者复核 + 全新子代理审查 + 定向复审），并把该轮写进**本账本的「阶段交接」段**；随后回写主规格 §12 的 R2 行与 B4 规格 §16 的 B4-R1。**这一条不进 README 的延后项表**（那是「判定为可接受、明确不修」的表，这是「待实测触发的修复」） | **最高**——否则该手机上导出会走降级链、甚至响亮失败 |
| 2 | 若实测 `N ≥ 4096` | 保守下界成立，**什么都不用改** | 只在 R2 / B4-R1 行写明「实测 ≥ 4096，维持 4096」 | 可选（只是片数偏多、正确性不受影响） |
| 3 | 人工清单里未执行的条目 | 〔回填：逐条列清单号 + 为什么没执行〕 | 〔回填：谁在什么条件下补做〕 | 〔回填〕 |
| 4 | 真实像素、长按存相册、多下载拦截、`toBlob` 在大画布上的耗时与失败率 | CI 测不到（规格 §13.4）；B1-2 的像素无断言口径不变 | 人工（清单 4 / 5 / 6 / 8） | 中 |
````

**（骨架到此为止。下面是本任务要求写进收尾报告的「回填清单」，不是文件内容。）**

**哪几节必须用真实读数回填 + 回填方法**：

| 节 | 必须回填的真实读数 | 回填方法（命令 / 位置） |
|---|---|---|
| §1 | 分支名、提交数、`F` / `T`、生产代码与测试文件清单 | `git log --oneline main..HEAD`（取 `.Count` 与头尾）、`npm run test`、`count.mjs`、`git diff --stat main..HEAD` |
| §5 | 本轮新踩到的平台事实（每条要写「影响」） | 逐任务从实现报告里搬；没发生的不写 |
| §7 | 人工清单 10 条的逐条结果 | 人类伙伴实测；**未执行的如实写「未执行」**，不写推测 |
| §7.1 | 「复制为文本」的整段原文 + `N` + 五处落点一致性 | 手机 `/lab/canvas` → 「跑测量」→「复制为文本」 |
| §8 | 延后项条数 `K` 与逐条（**两类单列**：账本行 = B4-1…B4-K；账本外的文档债与明确接受项 = B4-(K+1)…） | `grep -c "minor (deferred)" .superpowers/sdd/2026-10-05-app-b4-export/progress.md`（与账本段行数逐位相等；两类不许与 `K` 混算） |
| §9 | 三条命令的原始输出尾巴 + 分解式 + 闭合校验 | `npm run test`、`$env:TZ="UTC"; npm run test`、`npm run build`、`count.mjs` |
| §10 / §11 | 最终审查与修复轮的条数与处置 | 审查报告 / 修复报告；没发生就不写这两节 |
| §12 | `P_edge` / `P_area` / `N` 与「是否要立独立修复轮」 | 手机 `/lab/canvas` 的读数（§7.1）+ 步骤 1 的判定分支：`N < 4096` ⇒ 记「独立修复轮、优先级最高」+ 触发条件（**报回当天**、**控制者**立 `.superpowers/sdd/<日期>-app-b4-canvas-limit/`、照 B3 人工验证小轮五步、写进**账本阶段交接**、**不进 README 延后项表**）并报告控制者；`N ≥ 4096` ⇒ 记「可选」 |

- [ ] **步骤 12：全量验证（文档改动不该影响任何测试，但要跑一遍确认没手抖改坏源码）**

```bash
npm run test                       # 预期：与步骤 1 的 F / T 相同，全绿
$env:TZ="UTC"; npm run test        # 预期：同上
npm run build                      # 预期：vue-tsc --noEmit 无输出 + Vite 构建成功
```

**另跑一条一致性自查（「两处逐字相同」的机检）**：

```powershell
$a = Get-Content -Raw -Encoding utf8 AGENTS.md
$c = Get-Content -Raw -Encoding utf8 CLAUDE.md
if ($a -ne $c) { "两份不一致" } else { "两份逐字相同" }
```

预期：**两份逐字相同**（R-8 的硬要求；本任务的改动是「两份同一个位置各插同一段」，跑完这条才算数）。

- [ ] **步骤 13：Commit**

```bash
git add README.md AGENTS.md CLAUDE.md src/core/pattern/build.ts \
  docs/superpowers/specs/2026-09-30-image-to-pattern-design.md \
  docs/superpowers/specs/2026-10-05-app-b4-export-design.md \
  docs/superpowers/notes/2026-10-04-app-b3-build-log.md \
  docs/superpowers/notes/2026-10-05-app-b4-build-log.md
git commit -m "docs(app): B4 收尾（README / AGENTS+CLAUDE 镜像 / 主规格注记 / 构建记录）"
```

> **若步骤 1 判定 `N < 4096`**：**本任务不动任何代码**（**控制者裁定 2026-10-05（B）**：这是一次独立的小修复轮，不并进任务 6，见步骤 1 第 4 条）。要做的是两件事：① 把读数与「该修复轮优先级最高」写进构建记录 §12；② **报告控制者立轮**——**人类伙伴报回读数后的当天**由控制者立新一版小轮简报（工作区 `.superpowers/sdd/<日期>-app-b4-canvas-limit/`，照 B3 人工验证小轮先例：简报 + 分派实现者 + 控制者复核 + 全新子代理审查 + 定向复审），并写进**账本的「阶段交接」段**；那一轮才去改 `src/core/render/layout.ts` 的常量、`src/core/render/__tests__/layout.test.ts` 的断言、`AGENTS.md` 的常量行与 `CLAUDE.md` 的常量行（共四处文件）。**这一条不进 README 的延后项表**。
> **`.superpowers/**` 是 gitignore 的**（`.superpowers/sdd/.gitignore` 只有一行 `*`）：本片段文件、账本与工具链
> **不进 commit**，`git status --short` 里不应出现它们（若出现，说明有人动了 ignore 规则——**先查清**）。

**报告必须包含**（控制者复核的输入）：

1. `F / T / D / I / E / R / C` 七个数、**闭合等式 `I + R + 2C + 1 = T` 的代入过程**，以及 `npm run test` 的原始输出尾巴（若对不上：附「先怀疑仪器」的排查过程与结论）；
2. 「两处逐字相同」那条 PowerShell 自查的输出；
3. 主规格 **5 段注记（§4.1 / §7.1 / §7.2 / §7.3 / §7.4）** + R2 行 + B4 规格 §16 行 + B3 构建记录两处 + `buildPatternFromImage` JSDoc 的**落点行号**（改完后再 `grep -n` 记一次，别用改前的行号）；
4. 探针读数（若清单 3 已执行：原文 + `P_edge` / `P_area` / `N` + 落点是否一致的逐条核对；**若 `N < 4096`：附「任务 6 不改代码、已写进构建记录 §12 并报告控制者立独立修复轮」的说明**）；
5. 与计划 / 契约 / 规格不符之处与处置（**不许自行发明名字**，见文末「仍然开着的缺口」）。

---

---

## 附录 A：规格覆盖度矩阵（装配自检用；任何一行指不出任务就是漏了）

| 规格章节 | 落点 |
|---|---|
| §1.1 上游交办 5 项 | ① ② → 任务 1 / 2；③ → 任务 6；④ → 任务 1 / 5；B3 三条 Minor + README 耗时句 → 任务 6 |
| §1.3 D1–D7 偏离 | D1/D2/D4 → 任务 1；D3 → 任务 1（用量表独立成图）+ 任务 4（面板列出）；D5 → 文件结构（不建 `preview.ts`）；D6 → 任务 1（`planShare`）；D7 → 任务 4（不做分享面板） |
| §2 明确不做 | 全局约束 + 任务 4（不做连续多下载 / zip / Web Share） |
| §3 模块边界 | 文件结构 + 任务 1（types/layout）+ 任务 2（渲染器）+ 任务 3（services） |
| §4 坐标与几何 | 任务 1（`cellBox` / 闸门 / 跨计划不变量） |
| §5 降级链与布局 | 任务 1 |
| §6 施工图渲染 | 任务 2 |
| §7 分享图渲染 | 任务 2 |
| §8 落盘与文件名 | 任务 3 |
| §9 确定性与静默失败防线 | 9.1 → 任务 4（面板给 `generatedAt`）；9.2 / 9.3 → 任务 4 + 任务 1 的 `planSheets`（不经过缩略图）；9.4 / 9.5 → 任务 3；9.6 → 任务 4（逐张渲染 + 即时释放）；9.7 → 任务 1 / 2；9.8 → 任务 1 / 2（`cellAt` / `patternStats` / `beadsToCm`） |
| §10 面板与交互 | 任务 4 |
| §11 探针页 | 任务 5 |
| §12 入口校验清单 | 任务 1（core 六个导出）+ 任务 3（五个 service 导出） |
| §13.1 CI 用例 | 任务 1 / 2 / 3 / 4 |
| §13.2 三条承重断言 | 断言 1 → 任务 4；断言 2 → 任务 1；断言 3 → 任务 1（`planShare` / `planSheets` 的尺寸）+ 任务 3（建画布时确实用了 plan 的尺寸） |
| §13.3 变异清单 | 任务 1（M1/M2/M3/M5/M6/M7）、任务 2（M4/M9/M10/M11/M12/M15/M16）、任务 3（M8/M13）、任务 4（M14） |
| §13.4 测不到的 | 任务 6（构建记录如实标注）+ 规格 §14 的人工清单 |
| §14 人工验证清单 | 任务 6 写进 README / 构建记录；**执行者是人类伙伴**（本计划不假装做过） |
| §15 性能与内存预算 | 任务 6 记录；真机数字来自人工清单 3 / 6 |
| §16 待验证风险 | 任务 5（探针页）+ 任务 6（回写） |
| §17 需要回写的上游文档 | 任务 6 |
| §18 实现顺序建议 | 本计划的任务切分（1 → 2 → 3 → 4 → 5 → 6） |

## 附录 B：变异编号 → 任务归属（红数由实现者实跑回填，**不许预估**）

| 变异 | 任务 | 动作摘要 | 该红的断言 |
|---|---|---|---|
| M1 | 1 | `cellBox` 去掉 `− tile.originCol` | 跨计划不变量 + 分片用例 |
| M2 | 1 | `cellBox` 的越界守卫改成夹取 | 越界用例 |
| M3 | 1 | `labels` 判据 `≥ 32` 改 `> 32` | 阈值用例（`maxEdge = 1200` ⇒ 32px 那条） |
| M4 | 2 | `labels = false` 时仍画色号 | 「格区域内 `fillText` 为 0 次」 |
| M5 | 1 | `kc` / `kr` 的 `max(…, 1)` 去掉 | 极小 `maxEdge` 的失败用例 |
| M6 | 1 | `tileCols` 不取 29 的整数倍 | 分片边界用例 |
| M7 | 1 | 划片循环 `while (colStart < width)` 改 `<=` | 覆盖 / 重叠用例 |
| M8 | 3 | `createCanvasStrict` 删掉回读校验 | 钳制用例 |
| M9 | 2 | 把 `tile.cellPx` 写进 `sheet.ts`（例如自己算 `col * tile.cellPx`） | 源码闸门 |
| M10 | 2 | `drawShare` 删掉 `imageSmoothingEnabled = false` | 分享图用例 |
| M11 | 2 | 空格斜线删掉 | 空格用例 |
| M12 | 2 | 板边界线宽改成与细线相同 | 板边界线宽断言 |
| M13 | 3 | `exportFilename` 跳过 `normalizeProjectName` | 文件名用例 |
| M14 | 4 | 面板数据源换成 `session.record.pattern` | §13.2-1 端到端用例 |
| M15 | 2 | 三组网格线绘制顺序反过来 | 调用顺序断言 |
| M16 | 2 | `cellAt(...)` 换成自己写的 stride 乘法 | 源码闸门第 2 条 |

## 附录 C：装配时的类型一致性检查（逐条 grep，不许靠印象）

1. `SheetTilePlan` 的字段名在 `layout.ts`（产出）与 `sheet.ts`（消费）里**逐个一致**：`grid` / `vLines` /
   `hLines` / `colTicks` / `rowTicks` / `colBoards` / `rowBoards` / `lineWidths` / `labelFontPx` /
   `tickFontPx` / `cellPx` / `originCol` / `originRow` / `cols` / `rows` / `index` / `rowIndex` / `colIndex` /
   `canvasWidth` / `canvasHeight`。
2. `SheetMeta` 的六个字段在 `ExportPanel.vue`（产出）与 `sheet.ts`（消费）里逐字一致。
3. 常量名：`EXPORT_MAX_EDGE` / `EXPORT_CELL_PX_TARGET` / `SHEET_LABEL_MIN_CELL_PX` / `EXPORT_CELL_PX_FLOOR` /
   `SHARE_MAX_EDGE` / `TILE_STEP` / `TICK_EVERY` —— **不许出现第二份字面量 29 / 32 / 40 / 4096 / 2048**（在
   `src/**` 里 grep 一遍，命中处必须能解释为什么不是引用常量）。
4. `services/exporter.ts` 的导出名被 `ExportPanel.vue` 引用的那几处拼写一致。
5. `data-testid` 名在 `ExportPanel.vue` 与 `ExportPanel.test.ts` 里逐个一致（`export-item-*` /
   `export-save-*` / `export-preview-*`）。

---
