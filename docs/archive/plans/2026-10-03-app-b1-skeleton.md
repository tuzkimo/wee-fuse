# 计划 B1：应用骨架、工程文件契约与图纸库 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在浏览器里跑通「选图 → 生成图纸 → 自动落盘 → 图纸库列表 → 改名 / 打开 / 删除」，并把 `Pattern` ↔ 工程文件的契约用端到端测试钉死。

**架构：** 三层不变——`src/core/project/` 是纯函数（工程文件 schema、校验、双向映射、`Pattern → RGBA` 栅格化），`src/services/` 是唯一碰平台的一层（IndexedDB 存储、`<input type=file>` 图片源、Canvas 缩略图），`src/stores/` 持有 UI 状态并通过一个模块级适配器取得存储实现（测试可替换）。

**技术栈：** Vue 3 + TypeScript（严格模式）+ Vite + Pinia + vue-router + Tailwind v4 + vitest（happy-dom）；新增 devDependency `fake-indexeddb`。

**规格：** [2026-10-03-app-skeleton-design.md](../specs/2026-10-03-app-skeleton-design.md)（本计划的论证依据；执行者两份都要读）。相关上游：[主规格 §4.4](../specs/2026-09-30-image-to-pattern-design.md)。

---

## 全局约束

- `src/core/**` **不得** import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，不得引用 DOM 全局（`document`、`window`、`navigator`、`Image`、`ImageData`、`OffscreenCanvas`、`createImageBitmap`…）。core 内的 import 只能是相对路径（`./`、`../`）。闸门测试：`src/__tests__/coreBoundary.test.ts`，随 `npm run test` 执行。
- **`src/core/**` 里不要给参数或变量起名 `window`**（闸门对形参名有已文档化的**误报**，处置约定是改命名，不放宽规则）。用 `table` / `bounds` / `region` 之类。
- TypeScript 严格模式，**禁止 `any`**；`noUnusedLocals` / `noUnusedParameters` 已开。
- 测试文件必须**显式** `import { describe, expect, it } from "vitest"`（约定写法，虽然 `test.globals` 已开）。
- 不可删改已有测试（当前 22 文件 / 312 用例）。
- 公开 API 的入口必须校验到「非法输入响亮失败」，校验写在**任何写操作之前**；内联就地校验，**不新建共享校验模块**（避免出现第二种风格）。
- 提交信息用 Conventional Commits + 中文描述：`feat(project): 工程文件子集色号重映射`。
- 关键常量：`EMPTY = 0xffff`、长边豆数 1–500、用色档位 `16 | 32 | null`、撤销栈 50。
- 验证命令：`npm run test`、`npm run build`、`npm run dev`（端口 1420）。装依赖用 `npm install --legacy-peer-deps`（见 `AGENTS.md` 的 npm 版本 hazard）。

**分支：** 本计划在 `feat/app-b1` 上执行（从 `main` 起）。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/core/project/types.ts` | 工程文件 schema 的类型、字面量常量、`validateProjectDocument` 与三个 `require*` 校验片段 |
| `src/core/project/file.ts` | `Pattern` ↔ `ProjectDocument` 双向映射（子集色号重映射、`crop` 字段搬位） |
| `src/core/pattern/raster.ts` | `Pattern` + `Palette` → `RgbaImage`。纯函数，供缩略图渲染使用 |
| `src/services/projectStore.ts` | `ProjectStore` 接口 + `ProjectMeta` / `ProjectRecord` + 模块级单例适配器（`setProjectStore` / `getProjectStore`） |
| `src/services/idbProjectStore.ts` | IndexedDB 实现（唯一 import `indexedDB` 的文件） |
| `src/services/memoryProjectStore.ts` | 内存实现（Node 测试注入；日后 Tauri fs 实现的同层替身） |
| `src/services/palette.ts` | 内置 MARD221 的唯一生产入口（`loadPalette` + JSON） |
| `src/services/patternThumbnail.ts` | `Pattern` → ≤512px PNG data URL（Canvas） |
| `src/services/imageSource.ts` | `<input type=file>` → `File`；原图尺寸探测的再导出 |
| `src/stores/project.ts` | Pinia：当前工程会话（`record` / `doc` / `pattern` / 脏标记） |
| `src/views/LibraryPage.vue` | 首页图纸库（列表 / 改名 / 删除 / 打开 / 占用显示） |
| `src/views/GeneratePage.vue` | **临时**生成入口（居中正方裁剪、长边 58、档位 32），B2 会替换 |
| `src/views/EditorPage.vue` | 载入工程并显示只读预览 + 参数（B1 只到这一步，编辑器是 B3） |
| `src/router/index.ts` | 修改：注册新路由 |
| `src/style.css` | 已存在（Tailwind 入口），不改 |

---

## 任务 0：验证 IndexedDB 与 fake-indexeddb 的 `Blob` 存取（B1 第 0 步）

**为什么第一个做：** 规格 §6.2 把「IndexedDB 能否原样存取 `Blob`」列为**已知未验证点**，且本规格不做假定。退路（改存 `ArrayBuffer`）只影响 `idbProjectStore.ts`，但它决定任务 3 怎么写。

**文件：**
- 创建：`src/services/__tests__/idbBlobProbe.test.ts`
- 修改：`package.json`（加 devDependency）

- [ ] **步骤 1：写探针测试**

```ts
// src/services/__tests__/idbBlobProbe.test.ts
/**
 * B1 第 0 步探针：IndexedDB 与 fake-indexeddb 能否原样存取 `Blob`。
 *
 * 规格 §6.2 把这个列为**已知未验证点**。存量 `source` 是全尺寸原图（2–6 MB），
 * 若 Blob 在某一路径上被降级成 `{}` 或空串，工程文件会**静默丢图**——图纸还能打开、
 * 还能编辑，只有「改参数重跑」会失效，属于最难归因的一类问题。故先量再写。
 *
 * 探针跑在 **fake-indexeddb** 上（Node 环境），它代表的是「结构化克隆语义」，
 * 不是浏览器实现本身；浏览器侧由任务 3 之后的人工验证覆盖（`npm run dev`）。
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("blobs");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function put(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function get(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readonly");
    const request = tx.objectStore("blobs").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readBytes(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

describe("B1 第 0 步：IndexedDB 的 Blob 存取", () => {
  it("happy-dom 本身不提供 indexedDB，探针环境由 fake-indexeddb 提供", () => {
    // 这条断言的作用是**记录环境事实**：若某天 happy-dom 开始自带 indexedDB，
    // 下面那条 Blob 往返断言量的就不再是 fake-indexeddb，本文件的自述就过期了。
    expect(typeof indexedDB).toBe("object");
    expect(typeof indexedDB.open).toBe("function");
  });

  it("Blob 原样往返：类型与字节逐个相同", async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const db = await openDb("wee-fuse-blob-probe");
    await put(db, "photo", new Blob([bytes], { type: "image/jpeg" }));

    const read = await get(db, "photo");
    expect(read, "取回的不是 Blob —— 退路：改存 ArrayBuffer").toBeInstanceOf(Blob);
    const blob = read as Blob;
    expect(blob.type).toBe("image/jpeg");
    expect(blob.size).toBe(bytes.length);
    // 逐字节比对：只比 size 抓不到「内容被换掉但长度相同」
    expect([...(await readBytes(blob))]).toEqual([...bytes]);
    db.close();
  });

  it("多类型值（字符串 + 数组 + Blob）能共存于一条记录", async () => {
    // 任务 3 要把 meta / doc / source 放进**同一条记录**，故这里按真实形状试一次。
    const db = await openDb("wee-fuse-blob-probe-mixed");
    const record = {
      meta: { id: "a", name: "小猫", width: 3, height: 3 },
      doc: { format: "weefuse-project", version: 1, grid: [0, 1, 65535] },
      source: new Blob([new Uint8Array([9, 9])], { type: "image/png" }),
    };
    await put(db, "rec", record);

    const read = (await get(db, "rec")) as typeof record;
    expect(read.meta.name).toBe("小猫");
    expect(read.doc.grid).toEqual([0, 1, 65535]);
    expect(read.source).toBeInstanceOf(Blob);
    expect([...(await readBytes(read.source))]).toEqual([9, 9]);
    db.close();
  });
});
```

- [ ] **步骤 2：运行它，确认失败**

运行：`npm run test -- src/services/__tests__/idbBlobProbe.test.ts`
预期：FAIL，报 `Failed to resolve import "fake-indexeddb/auto"`（模块还不存在）。
**注意**：若它反而是 PASS，说明 happy-dom 自己提供了 indexedDB——那必须回写规格 §6.2 并重新评估任务 3。

- [ ] **步骤 3：安装 fake-indexeddb**

运行：`npm install --dev --legacy-peer-deps fake-indexeddb`
预期：`package.json` 的 `devDependencies` 出现 `fake-indexeddb`，`package-lock.json` 被更新。
**不要**为此加 `.npmrc`，也不要改其他依赖版本（见 `AGENTS.md`）。

- [ ] **步骤 4：运行探针，确认通过**

运行：`npm run test -- src/services/__tests__/idbBlobProbe.test.ts`
预期：PASS，2 条（第 1 条环境事实 + 第 2 条 Blob 往返）。
若第 2 条 FAIL 且报的是「取回的不是 Blob」→ 记录结论，任务 3 改存 `ArrayBuffer`（接口不变）。

- [ ] **步骤 5：回写规格 §6.2 的验证结论**

把 `docs/superpowers/specs/2026-10-03-app-skeleton-design.md` §6.2 的「已知未验证点」段改为实测结论（通过 / 走退路），并注明测量环境是 fake-indexeddb 而非真实浏览器。

- [ ] **步骤 6：Commit**

```bash
git add package.json package-lock.json src/services/__tests__/idbBlobProbe.test.ts docs/superpowers/specs/2026-10-03-app-skeleton-design.md
git commit -m "test(services): 验证 IndexedDB/fake-indexeddb 的 Blob 存取（B1 第 0 步）"
```

---

## 任务 1：工程文件 schema 与校验（`core/project/types.ts`）

**文件：**
- 创建：`src/core/project/types.ts`
- 测试：`src/core/project/__tests__/types.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/core/project/__tests__/types.test.ts
import { describe, expect, it } from "vitest";
import { loadPalette } from "../../palette/registry";
import { validateProjectDocument } from "../types";

/** 测试色卡：5 色，code 与全色卡下标一一对应（A1=0 A2=1 A3=2 A4=3 A5=4）。 */
const palette = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" },
    { code: "A2", hex: "#000000" },
    { code: "A3", hex: "#ff0000" },
    { code: "A4", hex: "#00ff00" },
    { code: "A5", hex: "#0000ff" },
  ],
});

/** 一份合法文档。各条非法用例都从它派生，保证「只有被测字段不同」。 */
function validDoc(): Record<string, unknown> {
  return {
    format: "weefuse-project",
    version: 1,
    width: 2,
    height: 2,
    palette: { id: "fake", codes: ["A3", "A4"] },
    grid: [0, 1, 0, 1],
    params: { longSide: 2, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
  };
}

describe("validateProjectDocument", () => {
  it("合法文档原样通过，并保留全部字段", () => {
    const doc = validateProjectDocument(validDoc(), palette);
    expect(doc.width).toBe(2);
    expect(doc.height).toBe(2);
    expect(doc.palette.codes).toEqual(["A3", "A4"]);
    expect(doc.grid).toEqual([0, 1, 0, 1]);
    expect(doc.params.crop).toEqual({ x: 0, y: 0, w: 8, h: 8, rotate: 0 });
  });

  it("非对象 / null 直接报错", () => {
    expect(() => validateProjectDocument(null, palette)).toThrow(/不是对象/);
    expect(() => validateProjectDocument("x", palette)).toThrow(/不是对象/);
    expect(() => validateProjectDocument([], palette)).toThrow(/不是对象/);
  });

  it("format 不符时报「不是 WeeFuse 工程文件」", () => {
    expect(() => validateProjectDocument({ ...validDoc(), format: "other" }, palette)).toThrow(
      /不是 WeeFuse 工程文件/,
    );
  });

  it("version 不认识时报错并带上版本号", () => {
    expect(() => validateProjectDocument({ ...validDoc(), version: 2 }, palette)).toThrow(
      /版本 2/,
    );
    expect(() => validateProjectDocument({ ...validDoc(), version: "1" }, palette)).toThrow(
      /版本/,
    );
  });

  it("width / height 必须是 ≥1 的整数", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
      expect(() => validateProjectDocument({ ...validDoc(), width: bad }, palette)).toThrow(
        /宽度/,
      );
      expect(() => validateProjectDocument({ ...validDoc(), height: bad }, palette)).toThrow(
        /高度/,
      );
    }
  });

  it("width / height 不得超过 500（与长边豆数上限同口径，同时挡住宽高相乘溢出成 Infinity）", () => {
    expect(() => validateProjectDocument({ ...validDoc(), width: 501 }, palette)).toThrow(/宽度/);
    expect(() => validateProjectDocument({ ...validDoc(), height: 501 }, palette)).toThrow(/高度/);
  });

  it("grid 长度必须等于 width*height", () => {
    expect(() => validateProjectDocument({ ...validDoc(), grid: [0, 1, 0] }, palette)).toThrow(
      /长度/,
    );
  });

  it("grid 每格必须是 65535 或小于 codes.length 的整数", () => {
    expect(() => validateProjectDocument({ ...validDoc(), grid: [0, 2, 0, 1] }, palette)).toThrow(
      /色号下标/,
    );
    expect(() =>
      validateProjectDocument({ ...validDoc(), grid: [0, 65535, 0, 1] }, palette),
    ).not.toThrow();
    expect(() => validateProjectDocument({ ...validDoc(), grid: [0, 1.5, 0, 1] }, palette)).toThrow(
      /色号下标/,
    );
  });

  it("每个 code 都必须存在于全色卡", () => {
    expect(() =>
      validateProjectDocument(
        { ...validDoc(), palette: { id: "fake", codes: ["A3", "ZZ9"] } },
        palette,
      ),
    ).toThrow(/ZZ9/);
  });

  it("code 不得重复（重复会让重映射依赖顺序）", () => {
    expect(() =>
      validateProjectDocument(
        { ...validDoc(), palette: { id: "fake", codes: ["A3", "A3"] } },
        palette,
      ),
    ).toThrow(/重复/);
  });

  it("palette.id 必须与传入色卡一致", () => {
    expect(() =>
      validateProjectDocument(
        { ...validDoc(), palette: { id: "other", codes: ["A3", "A4"] } },
        palette,
      ),
    ).toThrow(/色卡/);
  });

  it("params.longSide 必须是 1–500 的整数", () => {
    for (const bad of [0, -1, 501, 1.5, Number.NaN]) {
      expect(() =>
        validateProjectDocument(
          { ...validDoc(), params: { ...(validDoc().params as object), longSide: bad } },
          palette,
        ),
      ).toThrow(/长边/);
    }
  });

  it("params.maxColors 只允许 16 / 32 / null", () => {
    for (const bad of [8, 0, 16.5, Number.NaN, Number.POSITIVE_INFINITY, "16"]) {
      expect(() =>
        validateProjectDocument(
          { ...validDoc(), params: { ...(validDoc().params as object), maxColors: bad } },
          palette,
        ),
      ).toThrow(/档位/);
    }
    for (const good of [16, 32, null]) {
      expect(() =>
        validateProjectDocument(
          { ...validDoc(), params: { ...(validDoc().params as object), maxColors: good } },
          palette,
        ),
      ).not.toThrow();
    }
  });

  it("params.crop 的 x/y 必须有限，w/h 必须有限且 ≥1，rotate 必须是 0–3 的整数", () => {
    const withCrop = (crop: unknown) =>
      validateProjectDocument(
        { ...validDoc(), params: { ...(validDoc().params as object), crop } },
        palette,
      );
    expect(() => withCrop({ x: Number.NaN, y: 0, w: 8, h: 8, rotate: 0 })).toThrow(/裁剪/);
    expect(() => withCrop({ x: 0, y: Number.POSITIVE_INFINITY, w: 8, h: 8, rotate: 0 })).toThrow(
      /裁剪/,
    );
    expect(() => withCrop({ x: 0, y: 0, w: 0, h: 8, rotate: 0 })).toThrow(/裁剪/);
    expect(() => withCrop({ x: 0, y: 0, w: 8, h: Number.NaN, rotate: 0 })).toThrow(/裁剪/);
    expect(() => withCrop({ x: 0, y: 0, w: 8, h: 8, rotate: 4 })).toThrow(/旋转/);
    expect(() => withCrop({ x: 0, y: 0, w: 8, h: 8, rotate: 1.5 })).toThrow(/旋转/);
    expect(() => withCrop({ x: 0, y: 0, w: 8, h: 8, rotate: -1 })).toThrow(/旋转/);
    expect(() => withCrop(undefined)).toThrow(/裁剪/);
  });

  it("非法文档抛的是错误，不是一个「看起来正常」的对象", () => {
    // 这条断言的方向：坏输入必须**响亮失败**，而不是被补齐成默认值。
    let caught: unknown = null;
    try {
      validateProjectDocument({ ...validDoc(), width: 0 }, palette);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/project/__tests__/types.test.ts`
预期：FAIL，报 `Failed to resolve import "../types"`。

- [ ] **步骤 3：编写实现**

```ts
// src/core/project/types.ts
import { EMPTY, MAX_LONG_SIDE, MIN_LONG_SIDE, type MaxColors } from "../pattern/types";
import type { Palette } from "../palette/types";

/** 工程文件格式标识。 */
export const PROJECT_FORMAT = "weefuse-project";
/** 当前工程文件版本。不认识的值必须报错，不得猜测。 */
export const PROJECT_VERSION = 1;

/**
 * 生成参数。与运行期 `services/pipeline.ts` 的 `GenerateRequest` **字段名不同**：
 * 这里按落盘格式写 `crop.w` / `crop.h` / `crop.rotate`，运行期是 `Rect.width` /
 * `Rect.height` 加一个**独立的** `rotation`。两者的映射集中在 `file.ts`（见 §5.3），
 * 不允许在别处各写一份。
 */
export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 顺时针 90° 的次数，0–3。 */
  readonly rotate: number;
}

export interface ProjectParams {
  readonly longSide: number;
  readonly maxColors: MaxColors;
  readonly crop: CropRect;
}

/**
 * 工程文件里承载的**图纸本体**。
 *
 * `id` / `name` / 时间戳 / 列表封面图**不在这里**——它们是展示数据，属于运行期的
 * `ProjectMeta`。这样本模块与 `file.ts` 完全不接触 UI 概念。
 */
export interface ProjectDocument {
  readonly format: string;
  readonly version: number;
  readonly width: number;
  readonly height: number;
  readonly palette: { readonly id: string; readonly codes: readonly string[] };
  /** 行优先，长度 = width*height；下标到 palette.codes；65535 = 空格。 */
  readonly grid: readonly number[];
  readonly params: ProjectParams;
}

function requireFiniteNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what}必须是有限数字（当前 ${String(value)}）`);
  }
  return value;
}

function requireInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${what}必须是整数（当前 ${String(value)}）`);
  }
  return value;
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what}不是对象`);
  }
  return value as Record<string, unknown>;
}

/**
 * 校验并载入一份工程文件。
 *
 * **非法输入一律抛错，不补齐、不猜测。** 工程文件来自磁盘 / 本地存储，是外部输入：
 * 静默补默认值会产出「看起来正常、内容已错」的图纸，正是本项目要消灭的失败形态。
 *
 * 与 `AGENTS.md`「入口校验」一节同口径：网格尺寸必须是整数且 ≥1 且 ≤ 长边豆数上限
 * （上限同时挡住 `width * height` 相乘溢出成 `Infinity`，那会让下面的长度校验失去意义）；
 * `grid` 长度必须与宽高自洽；`maxColors` 必须运行期校验（类型挡不住 `JSON.parse` + 强转）。
 *
 * 本函数**不校验** `id` / `name` / 时间戳 / 缩略图——它们不在工程文件里。
 *
 * @param doc 待校验的原始值（通常来自 `JSON.parse`）
 * @param fullPalette 全色卡，用于把 `palette.codes` 的每个色号解析成全色卡下标
 */
export function validateProjectDocument(doc: unknown, fullPalette: Palette): ProjectDocument {
  const d = requireObject(doc, "工程文件");

  if (d.format !== PROJECT_FORMAT) {
    throw new Error(`不是 WeeFuse 工程文件（format = ${String(d.format)}）`);
  }
  if (d.version !== PROJECT_VERSION) {
    throw new Error(`工程文件版本 ${String(d.version)} 不认识（当前支持 ${PROJECT_VERSION}）`);
  }

  const width = requireInteger(d.width, "图纸宽度");
  const height = requireInteger(d.height, "图纸高度");
  // 上界与长边豆数上限同口径。它同时挡住 width*height 溢出成 Infinity —— 否则
  // 「grid.length === width*height」这条自洽校验会被 Infinity 悄悄绕过。
  if (width < 1 || width > MAX_LONG_SIDE) {
    throw new Error(`图纸宽度必须在 1–${MAX_LONG_SIDE} 之间（当前 ${width}）`);
  }
  if (height < 1 || height > MAX_LONG_SIDE) {
    throw new Error(`图纸高度必须在 1–${MAX_LONG_SIDE} 之间（当前 ${height}）`);
  }

  const paletteRaw = requireObject(d.palette, "色卡引用");
  if (paletteRaw.id !== fullPalette.id) {
    throw new Error(
      `工程文件的色卡是 ${String(paletteRaw.id)}，与当前载入的色卡 ${fullPalette.id} 不一致`,
    );
  }
  if (!Array.isArray(paletteRaw.codes)) throw new Error("色卡引用里的 codes 不是数组");

  const known = new Set<string>();
  for (const color of fullPalette.colors) known.add(color.code);
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const rawCode of paletteRaw.codes) {
    if (typeof rawCode !== "string") throw new Error("色卡引用里出现了非字符串色号");
    if (!known.has(rawCode)) {
      throw new Error(`工程文件引用了色卡里不存在的色号：${rawCode}`);
    }
    // 重复会让「子集下标 → 全色卡下标」的查表结果依赖遍历顺序，并让同一张图有两种
    // 字节表示，无法逐位比对。
    if (seen.has(rawCode)) throw new Error(`工程文件里的色号重复：${rawCode}`);
    seen.add(rawCode);
    codes.push(rawCode);
  }

  if (!Array.isArray(d.grid)) throw new Error("工程文件的 grid 不是数组");
  const grid = d.grid as unknown[];
  const expected = width * height;
  if (grid.length !== expected) {
    throw new Error(`工程文件的 grid 长度 ${grid.length} 与 ${width}×${height} 不自洽`);
  }
  const cells: number[] = [];
  for (let i = 0; i < grid.length; i++) {
    const value = grid[i];
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`第 ${i} 格的色号下标不是整数（当前 ${String(value)}）`);
    }
    if (value !== EMPTY && (value < 0 || value >= codes.length)) {
      throw new Error(`第 ${i} 格的色号下标 ${value} 越界（本图只有 ${codes.length} 个色号）`);
    }
    cells.push(value);
  }

  const params = requireObject(d.params, "生成参数");
  const longSide = params.longSide;
  if (
    typeof longSide !== "number" ||
    !Number.isInteger(longSide) ||
    longSide < MIN_LONG_SIDE ||
    longSide > MAX_LONG_SIDE
  ) {
    throw new Error(`长边豆数必须在 ${MIN_LONG_SIDE}–${MAX_LONG_SIDE} 之间（当前 ${String(longSide)}）`);
  }
  const maxColors = params.maxColors;
  if (maxColors !== 16 && maxColors !== 32 && maxColors !== null) {
    throw new Error(`用色档位非法：${String(maxColors)}（只允许 16 / 32 / null）`);
  }

  const cropRaw = requireObject(params.crop, "裁剪区域");
  const x = requireFiniteNumber(cropRaw.x, "裁剪区域 x");
  const y = requireFiniteNumber(cropRaw.y, "裁剪区域 y");
  const w = requireFiniteNumber(cropRaw.w, "裁剪区域宽度");
  const h = requireFiniteNumber(cropRaw.h, "裁剪区域高度");
  if (w < 1 || h < 1) {
    throw new Error(`裁剪区域尺寸非法：${w}×${h}`);
  }
  const rotate = cropRaw.rotate;
  if (typeof rotate !== "number" || !Number.isInteger(rotate) || rotate < 0 || rotate > 3) {
    throw new Error(`旋转角度非法：${String(rotate)}（必须是 0–3 的整数）`);
  }

  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    width,
    height,
    palette: { id: fullPalette.id, codes },
    grid: cells,
    params: { longSide, maxColors, crop: { x, y, w, h, rotate } },
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/core/project/__tests__/types.test.ts`
预期：PASS，全部用例。
再运行闸门：`npm run test -- src/__tests__/coreBoundary.test.ts` → PASS（本文件不得出现 DOM 全局或非相对 import）。

- [ ] **步骤 5：Commit**

```bash
git add src/core/project/types.ts src/core/project/__tests__/types.test.ts
git commit -m "feat(project): 工程文件 schema 与运行期校验"
```

---

## 任务 2：`Pattern` ↔ 工程文件双向映射（`core/project/file.ts`）

**这是整份计划最重的任务**——规格 §5 的两个静默风险点都在这里。

**文件：**
- 创建：`src/core/project/file.ts`
- 测试：`src/core/project/__tests__/file.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/core/project/__tests__/file.test.ts
import { describe, expect, it } from "vitest";
import { loadPalette } from "../../palette/registry";
import { EMPTY, type Pattern } from "../../pattern/types";
import { fromProjectDocument, toProjectDocument } from "../file";
import { validateProjectDocument, type ProjectParams } from "../types";

const palette = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" }, // 0
    { code: "A2", hex: "#000000" }, // 1
    { code: "A3", hex: "#ff0000" }, // 2
    { code: "A4", hex: "#00ff00" }, // 3
    { code: "A5", hex: "#0000ff" }, // 4
  ],
});

const params: ProjectParams = {
  longSide: 3,
  maxColors: 16,
  crop: { x: 0, y: 0, w: 12, h: 12, rotate: 1 },
};

/** 3×3 图纸：用 A3(2) / A5(4) / 空格，**刻意跳过 A1/A2/A4**，子集与全色卡下标才会不同。 */
function pattern3x3(): Pattern {
  return {
    width: 3,
    height: 3,
    paletteId: "fake",
    cells: Uint16Array.from([2, 2, EMPTY, 4, 2, 4, EMPTY, 4, 2]),
  };
}

/** 真实的落盘 - 回读往返，含一次 JSON 序列化。 */
function roundTrip(p: Pattern, fullPalette = palette): Pattern {
  const doc = toProjectDocument(p, fullPalette, params);
  const reparsed: unknown = JSON.parse(JSON.stringify(doc));
  return fromProjectDocument(reparsed, fullPalette).pattern;
}

describe("toProjectDocument", () => {
  it("子集色号升序、去重，且只包含图上真正用到的色号", () => {
    const doc = toProjectDocument(pattern3x3(), palette, params);
    // 全色卡下标 2 与 4 → 色号 A3 与 A5；A1/A2/A4 未出现，不得进 codes
    expect(doc.palette.codes).toEqual(["A3", "A5"]);
  });

  it("grid 的下标是到 codes 的子集下标，空格保留 65535", () => {
    const doc = toProjectDocument(pattern3x3(), palette, params);
    // A3 是子集下标 0，A5 是子集下标 1
    expect(doc.grid).toEqual([0, 0, EMPTY, 1, 0, 1, EMPTY, 1, 0]);
  });

  it("同一张图，改变涂画顺序不改变落盘字节（子集恒为升序）", () => {
    const a = toProjectDocument(pattern3x3(), palette, params);
    const b = toProjectDocument(pattern3x3(), palette, params);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("宽高与长边来自图纸与参数，不从 grid 反推", () => {
    const doc = toProjectDocument(pattern3x3(), palette, params);
    expect(doc.width).toBe(3);
    expect(doc.height).toBe(3);
    expect(doc.params.longSide).toBe(3);
    expect(doc.params.crop).toEqual({ x: 0, y: 0, w: 12, h: 12, rotate: 1 });
  });

  it("全空格图纸：codes 为空、grid 全 65535（不得产出非法下标）", () => {
    const empty: Pattern = {
      width: 2,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([EMPTY, EMPTY]),
    };
    const doc = toProjectDocument(empty, palette, params);
    expect(doc.palette.codes).toEqual([]);
    expect(doc.grid).toEqual([EMPTY, EMPTY]);
  });

  it("只用一种颜色的图纸：codes 只有一个", () => {
    const one: Pattern = {
      width: 2,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([3, 3]),
    };
    expect(toProjectDocument(one, palette, params).palette.codes).toEqual(["A4"]);
  });

  it("paletteId 与传入色卡不符时抛错（不静默按位置映射）", () => {
    const wrong: Pattern = { ...pattern3x3(), paletteId: "other" };
    expect(() => toProjectDocument(wrong, palette, params)).toThrow(/色卡/);
  });

  it("cells 里有超出色卡长度的下标时抛错", () => {
    const bad: Pattern = {
      width: 1,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([99]),
    };
    expect(() => toProjectDocument(bad, palette, params)).toThrow(/越界|色卡/);
  });

  it("cells 长度与宽高不符时抛错", () => {
    const bad: Pattern = {
      width: 3,
      height: 3,
      paletteId: "fake",
      cells: Uint16Array.from([2, 2]),
    };
    expect(() => toProjectDocument(bad, palette, params)).toThrow(/长度/);
  });

  it("非法参数抛错（长边越界 / 档位非法 / 旋转非法）", () => {
    const p = pattern3x3();
    expect(() => toProjectDocument(p, palette, { ...params, longSide: 501 })).toThrow(/长边/);
    expect(() =>
      toProjectDocument(p, palette, { ...params, maxColors: 8 as unknown as 16 }),
    ).toThrow(/档位/);
    expect(() =>
      toProjectDocument(p, palette, { ...params, crop: { ...params.crop, rotate: 4 } }),
    ).toThrow(/旋转/);
  });
});

describe("fromProjectDocument", () => {
  it("端到端往返后 cells 逐格一致（含 JSON 序列化）", () => {
    const p = pattern3x3();
    const back = roundTrip(p);
    expect(back.width).toBe(3);
    expect(back.height).toBe(3);
    expect(back.paletteId).toBe("fake");
    expect([...back.cells]).toEqual([...p.cells]);
  });

  it("往返保留空格的 65535，不变成某个色号下标", () => {
    const back = roundTrip(pattern3x3());
    expect(back.cells[2]).toBe(EMPTY);
    expect(back.cells[6]).toBe(EMPTY);
  });

  it("换一种 codes 顺序，载入结果必须完全相同（专打「按下标直接搬」的实现）", () => {
    // 这条是本任务最有判别力的断言：若实现按下标直接搬而不按 code 查表，
    // 同一个 grid 配不同顺序的 codes 会得到不同的 cells —— 图纸看起来正常、色号全错。
    const p = pattern3x3();
    const base = toProjectDocument(p, palette, params);
    const shuffled = {
      ...base,
      palette: { id: base.palette.id, codes: [...base.palette.codes].reverse() },
      // codes 反序后，每个色号的子集下标也跟着换：原来的 0→1、1→0
      grid: base.grid.map((v) => (v === EMPTY ? EMPTY : 1 - v)),
    };
    const a = fromProjectDocument(validateProjectDocument(base, palette), palette).pattern;
    const b = fromProjectDocument(validateProjectDocument(shuffled, palette), palette).pattern;
    expect([...b.cells]).toEqual([...a.cells]);
  });

  it("crop 字段搬位：w/h → width/height，rotate 挪到 crop 外面", () => {
    const doc = toProjectDocument(pattern3x3(), palette, params);
    const { crop, rotation } = fromProjectDocument(doc, palette).params;
    expect(crop).toEqual({ x: 0, y: 0, width: 12, height: 12 });
    expect(rotation).toBe(1);
  });

  it("载入时校验失败会抛错，而不是产出一个看起来正常的图纸", () => {
    const doc = toProjectDocument(pattern3x3(), palette, params);
    expect(() =>
      fromProjectDocument({ ...doc, width: 0 }, palette),
    ).toThrow(/宽度/);
  });

  it("全空格图纸往返后仍是全空格", () => {
    const empty: Pattern = {
      width: 2,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([EMPTY, EMPTY]),
    };
    const back = roundTrip(empty);
    expect([...back.cells]).toEqual([EMPTY, EMPTY]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/project/__tests__/file.test.ts`
预期：FAIL，报 `Failed to resolve import "../file"`。

- [ ] **步骤 3：编写实现**

```ts
// src/core/project/file.ts
import type { Palette } from "../palette/types";
import { EMPTY, MAX_LONG_SIDE, type Pattern } from "../pattern/types";
import { validateProjectDocument, type ProjectDocument, type ProjectParams } from "./types";

/**
 * 把图纸落盘成工程文件。
 *
 * 两个方向都做**子集**处理：`Pattern.cells` 用的是**全色卡下标**，而落盘的 `grid`
 * 用的是**到 `palette.codes` 的子集下标**。存色号字符串而不是色卡下标，是为了将来
 * 校准色值或重排色卡顺序时，旧工程不会静默错位（图纸看起来正常、色号全错）。
 *
 * 子集恒为**出现过的色号、升序**：同一张图因此有唯一的字节表示，可以逐位比对；
 * 涂画顺序不同不会产生两种落盘结果。
 *
 * 非法输入一律抛错（不补齐、不猜测）。
 */
export function toProjectDocument(
  pattern: Pattern,
  fullPalette: Palette,
  params: ProjectParams,
): ProjectDocument {
  if (pattern.paletteId !== fullPalette.id) {
    throw new Error(
      `图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${fullPalette.id} 不一致`,
    );
  }
  if (!Number.isInteger(pattern.width) || pattern.width < 1 || pattern.width > MAX_LONG_SIDE) {
    throw new Error(`图纸宽度非法：${pattern.width}`);
  }
  if (!Number.isInteger(pattern.height) || pattern.height < 1 || pattern.height > MAX_LONG_SIDE) {
    throw new Error(`图纸高度非法：${pattern.height}`);
  }
  if (pattern.cells.length !== pattern.width * pattern.height) {
    throw new Error(
      `图纸 cells 长度 ${pattern.cells.length} 与 ${pattern.width}×${pattern.height} 不自洽`,
    );
  }
  if (
    !Number.isInteger(params.longSide) ||
    params.longSide < 1 ||
    params.longSide > MAX_LONG_SIDE
  ) {
    throw new Error(`长边豆数非法：${params.longSide}`);
  }
  if (params.maxColors !== 16 && params.maxColors !== 32 && params.maxColors !== null) {
    throw new Error(`用色档位非法：${String(params.maxColors)}`);
  }
  const { x, y, w, h, rotate } = params.crop;
  for (const [name, value] of Object.entries({ x, y, w, h })) {
    if (!Number.isFinite(value)) throw new Error(`裁剪区域 ${name} 非法：${String(value)}`);
  }
  if (w < 1 || h < 1) throw new Error(`裁剪区域尺寸非法：${w}×${h}`);
  if (!Number.isInteger(rotate) || rotate < 0 || rotate > 3) {
    throw new Error(`旋转角度非法：${rotate}`);
  }

  // 收集出现过的全色卡下标（升序）。EMPTY 不是色号，单独处置。
  const used = new Set<number>();
  for (let i = 0; i < pattern.cells.length; i++) {
    const value = pattern.cells[i] as number;
    if (value === EMPTY) continue;
    if (value < 0 || value >= fullPalette.colors.length) {
      throw new Error(`第 ${i} 格的色号下标 ${value} 越界（色卡只有 ${fullPalette.colors.length} 色）`);
    }
    used.add(value);
  }
  const fullIndices = [...used].sort((a, b) => a - b);

  // 全色卡下标 → 子集下标
  const subsetOf = new Map<number, number>();
  const codes: string[] = [];
  fullIndices.forEach((fullIndex, subsetIndex) => {
    subsetOf.set(fullIndex, subsetIndex);
    codes.push((fullPalette.colors[fullIndex] as { code: string }).code);
  });

  const grid: number[] = [];
  for (let i = 0; i < pattern.cells.length; i++) {
    const value = pattern.cells[i] as number;
    grid.push(value === EMPTY ? EMPTY : (subsetOf.get(value) as number));
  }

  return {
    format: "weefuse-project",
    version: 1,
    width: pattern.width,
    height: pattern.height,
    palette: { id: fullPalette.id, codes },
    grid,
    params: { longSide: params.longSide, maxColors: params.maxColors, crop: { x, y, w, h, rotate } },
  };
}

/**
 * 从工程文件还原图纸与生成参数。
 *
 * **两处静默风险点必须在这一次调用里同时处理完**（规格 §5.2 / §5.3）：
 *
 * 1. **子集色号 → 全色卡下标**：先按 `code` 查 `fullPalette` 得到全色卡下标，建
 *    `子集下标 → 全色卡下标` 表，再逐格重映射。**只比对 `palette.id` 抓不到错配**
 *    （同 id 但文件里是子集色卡），结果是每个色号静默标成别的名字。
 * 2. **`crop` 字段搬位**：文件里是 `w` / `h` / `rotate`，运行期是 `width` / `height`
 *    加上一个**独立**的 `rotation`。不映射就会拿到 `undefined` 尺寸，进而是 NaN 网格。
 *
 * 这两件事不许拆成两个各自正确的函数：本项目最严重的一次缺陷（`build.ts` 把 Lab 分量
 * 喂给入参为 sRGB 的函数）正是「两端各自都对、错在接线」，只有端到端跑一次才会暴露。
 */
export function fromProjectDocument(
  doc: unknown,
  fullPalette: Palette,
): {
  pattern: Pattern;
  params: { longSide: number; maxColors: ProjectParams["maxColors"]; crop: { x: number; y: number; width: number; height: number }; rotation: 0 | 1 | 2 | 3 };
} {
  const checked = validateProjectDocument(doc, fullPalette);

  const indexByCode = new Map<string, number>();
  fullPalette.colors.forEach((color, i) => indexByCode.set(color.code, i));

  // 子集下标 → 全色卡下标。逐 code 查表，绝不按下标直接搬。
  const fullIndexOfSubset = checked.palette.codes.map((code) => {
    const index = indexByCode.get(code);
    if (index === undefined) {
      // validateProjectDocument 已保证存在；这里是防御，避免 ?? 0 那种静默回落。
      throw new Error(`色卡里找不到色号 ${code}`);
    }
    return index;
  });

  const cells = new Uint16Array(checked.width * checked.height);
  for (let i = 0; i < cells.length; i++) {
    const value = checked.grid[i] as number;
    cells[i] = value === EMPTY ? EMPTY : (fullIndexOfSubset[value] as number);
  }

  const { x, y, w, h, rotate } = checked.params.crop;
  return {
    pattern: {
      width: checked.width,
      height: checked.height,
      paletteId: fullPalette.id,
      cells,
    },
    params: {
      longSide: checked.params.longSide,
      maxColors: checked.params.maxColors,
      crop: { x, y, width: w, height: h },
      rotation: rotate as 0 | 1 | 2 | 3,
    },
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/core/project/__tests__/file.test.ts`
预期：PASS，全部用例。
再运行：`npm run test -- src/__tests__/coreBoundary.test.ts` → PASS。

- [ ] **步骤 5：做事后变异（本项目的硬纪律：断言存在 ≠ 断言有效）**

对实现做四处破坏，**每一处都必须让至少一条用例转红**。逐条记录输出：

1. 把 `fromProjectDocument` 里的 `fullIndexOfSubset[value]` 改成 `value`（即「按下标直接搬」）→ 预期「换一种 codes 顺序」与「端到端往返」转红。
2. 把 `toProjectDocument` 里的 `codes.push(...)` 改成 `codes.unshift(...)`（子集降序）→ 预期「子集色号升序」与「换一种 codes 顺序」转红。
3. 把 `grid.push(value === EMPTY ? EMPTY : ...)` 里的 `EMPTY` 改成 `0` → 预期「空格保留 65535」转红。
4. 把 `crop: { x, y, width: w, height: h }` 里的 `width: w` 改成 `width: 0` → 预期「crop 字段搬位」转红。

任何一处**没有**转红，说明那条断言不判别，必须补强断言后再继续。把四处结果写进任务报告。

- [ ] **步骤 6：Commit**

```bash
git add src/core/project/file.ts src/core/project/__tests__/file.test.ts
git commit -m "feat(project): Pattern 与工程文件双向映射（子集色号重映射、crop 字段搬位）"
```

---

## 任务 3：存储层——接口、IndexedDB 实现、内存实现

**文件：**
- 创建：`src/services/projectStore.ts`、`src/services/idbProjectStore.ts`、`src/services/memoryProjectStore.ts`
- 测试：`src/services/__tests__/projectStoreContract.ts`（共用契约）、`src/services/__tests__/idbProjectStore.test.ts`、`src/services/__tests__/memoryProjectStore.test.ts`

- [ ] **步骤 1：编写共用的契约测试与两个入口（先写测试）**

```ts
// src/services/__tests__/projectStoreContract.ts
import { describe, expect, it } from "vitest";
import { loadPalette } from "@/core/palette/registry";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import type { ProjectParams } from "@/core/project/types";
import type { ProjectMeta, ProjectRecord, ProjectStore } from "@/services/projectStore";

export const contractPalette = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" },
    { code: "A2", hex: "#000000" },
    { code: "A3", hex: "#ff0000" },
  ],
});

export const contractParams: ProjectParams = {
  longSide: 2,
  maxColors: 16,
  crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 },
};

/** 造一条工程记录。`id` 与 `updatedAt` 可指定，用于验证排序。 */
export function makeRecord(
  id: string,
  name: string,
  updatedAt: string,
  options: { withSource?: boolean } = {},
): ProjectRecord {
  const doc = toProjectDocument(
    {
      width: 2,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([2, EMPTY]),
    },
    contractPalette,
    contractParams,
  );
  const meta: ProjectMeta = {
    id,
    name,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt,
    thumbnail: "",
    // 下面三个是**故意的错误值**：契约要求 put 从 doc 覆盖它们，而不是采信入参。
    width: 999,
    height: 999,
    colorCount: 999,
  };
  return {
    meta,
    doc,
    source: options.withSource === true ? { blob: new Blob([new Uint8Array([7, 8])]), type: "image/png" } : null,
  };
}

/**
 * 两个实现的共用契约。任何一条在 IndexedDB 实现上通过、在内存实现上失败（或反之），
 * 都说明「可替换」这个承诺是假的。
 */
export function describeProjectStoreContract(
  label: string,
  createStore: () => Promise<ProjectStore>,
): void {
  describe(`${label} 契约`, () => {
    it("put 之后 get 能取回同一条记录", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      const record = await store.get("a");
      expect(record).not.toBeNull();
      expect(record?.meta.name).toBe("小猫");
      expect(record?.doc.grid).toEqual([0, EMPTY]);
    });

    it("冗余字段由 put 从 doc 覆盖，不采信调用方传的值", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      const meta = await store.get("a");
      expect(meta?.meta.width).toBe(2);
      expect(meta?.meta.height).toBe(1);
      expect(meta?.meta.colorCount).toBe(1);
    });

    it("source 为 null 时往返仍是 null", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      expect((await store.get("a"))?.source).toBeNull();
    });

    it("source 为 Blob 时往返后仍是 Blob，且类型不变", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z", { withSource: true }));
      const source = (await store.get("a"))?.source;
      expect(source?.type).toBe("image/png");
      expect(source?.blob).toBeInstanceOf(Blob);
      expect(source?.blob.size).toBe(2);
    });

    it("get 不存在的 id 返回 null，不抛错", async () => {
      const store = await createStore();
      expect(await store.get("nope")).toBeNull();
    });

    it("list 按 updatedAt 倒序，且不含 grid 与 source", async () => {
      const store = await createStore();
      await store.put(makeRecord("old", "旧的", "2026-10-03T01:00:00.000Z"));
      await store.put(makeRecord("new", "新的", "2026-10-03T05:00:00.000Z"));
      await store.put(makeRecord("mid", "中间", "2026-10-03T03:00:00.000Z"));

      const list = await store.list();
      expect(list.map((m) => m.id)).toEqual(["new", "mid", "old"]);
      // 列表项不得把 doc / source 带出来（source 是 MB 级 Blob）
      expect(list[0]).not.toHaveProperty("doc");
      expect(list[0]).not.toHaveProperty("source");
    });

    it("remove 之后 list 与 get 都看不到它", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      await store.remove("a");
      expect(await store.get("a")).toBeNull();
      expect(await store.list()).toEqual([]);
    });

    it("remove 不存在的 id 不抛错（幂等）", async () => {
      const store = await createStore();
      await expect(store.remove("nope")).resolves.toBeUndefined();
    });

    it("rename 只改 name 与 updatedAt，不碰 doc", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      const before = await store.get("a");
      const renamed = await store.rename("a", "小狗");

      expect(renamed.name).toBe("小狗");
      expect(renamed.updatedAt).not.toBe("2026-10-03T01:00:00.000Z");
      const after = await store.get("a");
      expect(after?.meta.name).toBe("小狗");
      expect(after?.doc).toEqual(before?.doc);
      expect(after?.meta.createdAt).toBe(before?.meta.createdAt);
    });

    it("get 返回的是副本，改它不会写回库里（与 IndexedDB 的结构化克隆语义一致）", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      const first = await store.get("a");
      // 故意在取出的对象上乱改：真实的调用方（编辑器）会就地改 grid
      (first as { meta: { name: string } }).meta.name = "被改坏了";
      (first?.doc.grid as number[])[0] = 999;

      const second = await store.get("a");
      expect(second?.meta.name).toBe("小猫");
      expect(second?.doc.grid).toEqual([0, EMPTY]);
    });

    it("rename 不存在的 id 抛错", async () => {
      const store = await createStore();
      await expect(store.rename("nope", "x")).rejects.toThrow(/找不到/);
    });

    it("rename 拒绝空白名与超长名", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      await expect(store.rename("a", "   ")).rejects.toThrow(/名称/);
      await expect(store.rename("a", "x".repeat(101))).rejects.toThrow(/名称/);
    });

    it("put 覆盖同 id 的记录（不产生两条）", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      await store.put(makeRecord("a", "小猫二号", "2026-10-03T02:00:00.000Z"));
      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.name).toBe("小猫二号");
    });
  });
}
```

```ts
// src/services/__tests__/memoryProjectStore.test.ts
import { describeProjectStoreContract } from "./projectStoreContract";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";

describeProjectStoreContract("内存实现", async () => createMemoryProjectStore());
```

```ts
// src/services/__tests__/idbProjectStore.test.ts
import "fake-indexeddb/auto";
import { describeProjectStoreContract } from "./projectStoreContract";
import { createIdbProjectStore } from "@/services/idbProjectStore";

let counter = 0;
describeProjectStoreContract("IndexedDB 实现", async () => {
  counter += 1;
  return createIdbProjectStore({ databaseName: `wee-fuse-contract-${counter}` });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/services/__tests__/memoryProjectStore.test.ts src/services/__tests__/idbProjectStore.test.ts`
预期：FAIL，报 `Failed to resolve import "@/services/memoryProjectStore"` 等。

- [ ] **步骤 3：编写接口与两个实现**

```ts
// src/services/projectStore.ts
import type { ProjectDocument } from "@/core/project/types";

/** 列表展示数据。`list()` 只返回它——不含 grid 与 source。 */
export interface ProjectMeta {
  /** UUID，主键，一经创建不可变。 */
  readonly id: string;
  /** 展示名，用户可改；与 id 无关。 */
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** ≤512px 的图纸缩略图（`data:image/png;base64,…`），可为空串。 */
  readonly thumbnail: string;
  /** 以下三个是**冗余自 doc** 的列表字段：只在 `put` 里由 doc 计算写入。 */
  readonly width: number;
  readonly height: number;
  readonly colorCount: number;
}

export interface ProjectSource {
  readonly blob: Blob;
  readonly type: string;
}

export interface ProjectRecord {
  readonly meta: ProjectMeta;
  readonly doc: ProjectDocument;
  /** 全尺寸原图副本。为 null 时 UI 必须禁用「改参数重跑」。 */
  readonly source: ProjectSource | null;
}

/**
 * 工程存储。真机上是 App 私有目录里的「一个工程 = 一个目录」，浏览器上是 IndexedDB —— 
 * 数据模型按前者设计，IndexedDB 只是它的一种实现。接口按此形状定义，换实现不影响调用方。
 *
 * 约束：`put` 必须**从 `record.doc` 覆盖** `meta.width` / `height` / `colorCount`，
 * 不采信调用方传入的值——它们是冗余的派生字段，只有这样才能保证与真相对得上。
 */
export interface ProjectStore {
  list(): Promise<ProjectMeta[]>;
  get(id: string): Promise<ProjectRecord | null>;
  put(record: ProjectRecord): Promise<void>;
  remove(id: string): Promise<void>;
  rename(id: string, name: string): Promise<ProjectMeta>;
  /** 浏览器支持时返回占用与配额（字节）；不支持时返回 null。 */
  estimateUsage(): Promise<{ usage: number; quota: number } | null>;
}

/** 工程名长度上限。 */
export const PROJECT_NAME_MAX = 100;

/** 校验并归一化工程名；非法时抛错。`rename` 与 `put` 共用。 */
export function normalizeProjectName(name: unknown): string {
  if (typeof name !== "string") throw new Error("工程名称必须是字符串");
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("工程名称不能为空");
  if (trimmed.length > PROJECT_NAME_MAX) {
    throw new Error(`工程名称不能超过 ${PROJECT_NAME_MAX} 个字符`);
  }
  return trimmed;
}

/** 按 `updatedAt` 倒序（新的在前）。两个实现共用，保证列表顺序口径一致。 */
export function sortByUpdatedAtDesc(metas: readonly ProjectMeta[]): ProjectMeta[] {
  return [...metas].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---------------------------------------------------------------------------
// 模块级适配器
// ---------------------------------------------------------------------------

let current: ProjectStore | null = null;

/**
 * 注入当前存储实现。`main.ts` 在挂载前注入 IndexedDB 实现；测试注入内存实现。
 *
 * 为什么用模块级单例而不是 `app.provide`：B1 只有「图纸库 / 生成 / 编辑器」三个页面且
 * 每个页面只在异步操作里取存储，不存在渲染期依赖，单例最省；测试也不必为了拿到 app
 * 实例去绕 `vi.mock` 的提升顺序（那是这类测试最常见的坑）。
 *
 * **代价如实记录**：跨测试的文件级泄漏是可能的，所以每个测试文件都要自己调一次
 * `setProjectStore`（复用 `afterEach(() => setProjectStore(null))` 亦可）。
 */
export function setProjectStore(store: ProjectStore | null): void {
  current = store;
}

/** 取当前存储实现；未注入时抛错（不静默返回一个假实现）。 */
export function getProjectStore(): ProjectStore {
  if (current === null) {
    throw new Error("工程存储尚未初始化：请先调用 setProjectStore()");
  }
  return current;
}
```

```ts
// src/services/memoryProjectStore.ts
import {
  normalizeProjectName,
  sortByUpdatedAtDesc,
  type ProjectMeta,
  type ProjectRecord,
  type ProjectStore,
} from "./projectStore";

/**
 * 内存实现。
 *
 * 公开理由是「测试替身」：契约测试用它跑同一套用例，从而保证「换实现不影响调用方」
 * 这个承诺是真的。它同时是将来 Tauri fs 实现的同层替身。
 *
 * 刻意**不**模拟配额：`estimateUsage()` 恒返回 null，与「浏览器不支持」同一条分支。
 */
export async function createMemoryProjectStore(): Promise<ProjectStore> {
  const records = new Map<string, ProjectRecord>();

  /**
   * 落库与出库都做一次深拷贝，**为的是与 IndexedDB 实现语义一致**：
   * IDB 读出的记录是结构化克隆的副本，调用方改它不会影响库里；若内存实现交出引用，
   * 同一个调用方在两套实现下行为不同——「换实现不影响调用方」这个承诺就破了。
   *
   * `grid` 要显式复制：`[...doc.grid]` 浅拷数组元素，但数组本身必须换一个。
   * `source.blob` 沿用同一引用（Blob 按约定不可变，IDB 的结构化克隆也是复用其字节）。
   */
  function cloneRecord(record: ProjectRecord): ProjectRecord {
    return {
      meta: { ...record.meta },
      doc: { ...record.doc, palette: { ...record.doc.palette }, grid: [...record.doc.grid] },
      source: record.source === null ? null : { ...record.source },
    };
  }

  /** 从文档里重算列表用的冗余字段。 */
  function withDerivedMeta(record: ProjectRecord): ProjectRecord {
    return {
      meta: {
        ...record.meta,
        width: record.doc.width,
        height: record.doc.height,
        colorCount: record.doc.palette.codes.length,
      },
      doc: record.doc,
      source: record.source,
    };
  }

  return {
    async list(): Promise<ProjectMeta[]> {
      return sortByUpdatedAtDesc([...records.values()].map((r) => ({ ...r.meta })));
    },
    async get(id: string): Promise<ProjectRecord | null> {
      const found = records.get(id);
      return found === undefined ? null : cloneRecord(found);
    },
    async put(record: ProjectRecord): Promise<void> {
      if (typeof record.meta.id !== "string" || record.meta.id.length === 0) {
        throw new Error("工程 id 必须是非空字符串");
      }
      const name = normalizeProjectName(record.meta.name);
      const stored = withDerivedMeta({ ...record, meta: { ...record.meta, name } });
      records.set(record.meta.id, cloneRecord(stored));
    },
    async remove(id: string): Promise<void> {
      records.delete(id);
    },
    async rename(id: string, name: string): Promise<ProjectMeta> {
      const existing = records.get(id);
      if (existing === undefined) throw new Error(`找不到工程：${id}`);
      const normalized = normalizeProjectName(name);
      const meta: ProjectMeta = {
        ...existing.meta,
        name: normalized,
        updatedAt: new Date().toISOString(),
      };
      records.set(id, { ...existing, meta });
      return { ...meta };
    },
    async estimateUsage(): Promise<{ usage: number; quota: number } | null> {
      return null;
    },
  };
}
```

```ts
// src/services/idbProjectStore.ts
import {
  normalizeProjectName,
  sortByUpdatedAtDesc,
  type ProjectMeta,
  type ProjectRecord,
  type ProjectStore,
} from "./projectStore";

/** 默认数据库名。测试传自己的名字，避免用例之间互相污染。 */
export const IDB_DATABASE_NAME = "wee-fuse";

const STORE_PROJECTS = "projects";
const STORE_SOURCES = "sources";
const DB_VERSION = 1;

/**
 * IndexedDB 实现。**本文件是全项目唯一 import `indexedDB` 的地方**——真机换成 App
 * 私有目录时，只替换这个文件，上层的 `ProjectStore` 接口与数据模型都不动。
 *
 * 记录分成两个 object store：`projects`（meta + doc）与 `sources`（原图的 Blob）。
 * `list()` 因此天然不会读到 MB 级的原图——这对图纸库有几十个工程的情况很重要。
 *
 * 冗余字段（`meta.width` / `height` / `colorCount`）一律在 `put` 里**从 doc 重新计算**，
 * 不采信调用方传入的值。
 */
export interface IdbProjectStoreOptions {
  readonly databaseName?: string;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败"));
  });
}

/** 用完即关：不做连接缓存。本项目写操作是低频的用户动作，正确性优先于这点开销。 */
function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: "meta.id" });
      }
      if (!db.objectStoreNames.contains(STORE_SOURCES)) {
        db.createObjectStore(STORE_SOURCES);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开工程数据库"));
  });
}

interface StoredProject {
  readonly meta: ProjectMeta;
  readonly doc: ProjectRecord["doc"];
}

async function readRecord(db: IDBDatabase, id: string): Promise<ProjectRecord | null> {
  const tx = db.transaction([STORE_PROJECTS, STORE_SOURCES], "readonly");
  const stored = await promisifyRequest<StoredProject | undefined>(
    tx.objectStore(STORE_PROJECTS).get(id),
  );
  if (stored === undefined) return null;
  const source = await promisifyRequest<{ blob: Blob; type: string } | undefined>(
    tx.objectStore(STORE_SOURCES).get(id),
  );
  return { meta: stored.meta, doc: stored.doc, source: source ?? null };
}

/** 从文档里算出列表用的冗余字段。 */
function deriveMeta(meta: ProjectMeta, doc: ProjectRecord["doc"]): ProjectMeta {
  return {
    ...meta,
    width: doc.width,
    height: doc.height,
    colorCount: doc.palette.codes.length,
  };
}

export async function createIdbProjectStore(
  options: IdbProjectStoreOptions = {},
): Promise<ProjectStore> {
  const databaseName = options.databaseName ?? IDB_DATABASE_NAME;

  async function withDb<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await openDatabase(databaseName);
    try {
      return await run(db);
    } finally {
      db.close();
    }
  }

  return {
    async list(): Promise<ProjectMeta[]> {
      return withDb(async (db) => {
        const tx = db.transaction(STORE_PROJECTS, "readonly");
        const all = await promisifyRequest<StoredProject[]>(
          tx.objectStore(STORE_PROJECTS).getAll(),
        );
        return sortByUpdatedAtDesc(all.map((entry) => entry.meta));
      });
    },

    async get(id: string): Promise<ProjectRecord | null> {
      return withDb((db) => readRecord(db, id));
    },

    async put(record: ProjectRecord): Promise<void> {
      if (typeof record.meta.id !== "string" || record.meta.id.length === 0) {
        throw new Error("工程 id 必须是非空字符串");
      }
      const meta = deriveMeta(
        { ...record.meta, name: normalizeProjectName(record.meta.name) },
        record.doc,
      );
      await withDb(async (db) => {
        // 两条记录在同一个事务里写：不能出现「meta 写进去了、原图没写进去」的半状态。
        const tx = db.transaction([STORE_PROJECTS, STORE_SOURCES], "readwrite");
        tx.objectStore(STORE_PROJECTS).put({ meta, doc: record.doc } satisfies StoredProject);
        if (record.source === null) {
          tx.objectStore(STORE_SOURCES).delete(record.meta.id);
        } else {
          tx.objectStore(STORE_SOURCES).put(
            { blob: record.source.blob, type: record.source.type },
            record.meta.id,
          );
        }
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("写入工程失败"));
          tx.onabort = () => reject(tx.error ?? new Error("写入工程被中止"));
        });
      });
    },

    async remove(id: string): Promise<void> {
      await withDb(async (db) => {
        const tx = db.transaction([STORE_PROJECTS, STORE_SOURCES], "readwrite");
        tx.objectStore(STORE_PROJECTS).delete(id);
        tx.objectStore(STORE_SOURCES).delete(id);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("删除工程失败"));
          tx.onabort = () => reject(tx.error ?? new Error("删除工程被中止"));
        });
      });
    },

    async rename(id: string, name: string): Promise<ProjectMeta> {
      const normalized = normalizeProjectName(name);
      return withDb(async (db) => {
        const record = await readRecord(db, id);
        if (record === null) throw new Error(`找不到工程：${id}`);
        const meta: ProjectMeta = {
          ...record.meta,
          name: normalized,
          updatedAt: new Date().toISOString(),
        };
        const tx = db.transaction(STORE_PROJECTS, "readwrite");
        tx.objectStore(STORE_PROJECTS).put({ meta, doc: record.doc } satisfies StoredProject);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("重命名失败"));
          tx.onabort = () => reject(tx.error ?? new Error("重命名被中止"));
        });
        return meta;
      });
    },

    async estimateUsage(): Promise<{ usage: number; quota: number } | null> {
      // fake-indexeddb 与部分老 WebView 都没有 navigator.storage.estimate。
      // 走 undefined 分支返回 null，而不是抛错——占用显示只是锦上添花。
      const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
      if (storage === undefined || typeof storage.estimate !== "function") return null;
      try {
        const estimate = await storage.estimate();
        const usage = estimate.usage;
        const quota = estimate.quota;
        if (typeof usage !== "number" || typeof quota !== "number") return null;
        return { usage, quota };
      } catch {
        return null;
      }
    },
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/services/__tests__/memoryProjectStore.test.ts src/services/__tests__/idbProjectStore.test.ts`
预期：两个文件全 PASS（同一套契约用例在两个实现上各跑一遍）。

- [ ] **步骤 5：做事后变异**

逐条破坏并确认转红：

1. 把 `deriveMeta` 整个去掉、直接返回入参 `meta` → 预期「冗余字段由 put 从 doc 覆盖」在两个实现上转红。
2. 把 `readRecord` 里 `source ?? null` 改成恒 `null` → 预期「source 为 Blob 时往返后仍是 Blob」在 IDB 实现上转红。
3. 把 `sortByUpdatedAtDesc` 的 `b.updatedAt.localeCompare(a.updatedAt)` 改成 `a.updatedAt.localeCompare(b.updatedAt)` → 预期「list 按 updatedAt 倒序」在两个实现上转红。
4. 把 `rename` 里的 `createdAt` 不动、改成也更新 → 预期「rename 只改 name 与 updatedAt」转红。

- [ ] **步骤 6：Commit**

```bash
git add src/services/projectStore.ts src/services/idbProjectStore.ts src/services/memoryProjectStore.ts src/services/__tests__/
git commit -m "feat(services): 工程存储接口 + IndexedDB 与内存双实现（含共用契约测试）"
```

---

## 任务 4：图纸栅格化与缩略图

**文件：**
- 创建：`src/core/pattern/raster.ts`、`src/services/patternThumbnail.ts`
- 测试：`src/core/pattern/__tests__/raster.test.ts`、`src/services/__tests__/patternThumbnail.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/core/pattern/__tests__/raster.test.ts
import { describe, expect, it } from "vitest";
import { loadPalette } from "../../palette/registry";
import { patternToRgbaImage } from "../raster";
import { EMPTY } from "../types";

const palette = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" },
    { code: "A2", hex: "#000000" },
    { code: "A3", hex: "#ff0000" },
  ],
});

describe("patternToRgbaImage", () => {
  it("每个色号映射成对应 RGB，alpha 为 255", () => {
    const image = patternToRgbaImage(
      { width: 2, height: 1, paletteId: "fake", cells: Uint16Array.from([0, 2]) },
      palette,
    );
    expect(image.width).toBe(2);
    expect(image.height).toBe(1);
    // 只读 R 通道会漏掉「绿蓝写错」，故三通道都断言
    expect([...image.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...image.data.slice(4, 8)]).toEqual([255, 0, 0, 255]);
  });

  it("空格映射成完全透明，且 RGB 清零（不是黑色不透明）", () => {
    const image = patternToRgbaImage(
      { width: 1, height: 1, paletteId: "fake", cells: Uint16Array.from([EMPTY]) },
      palette,
    );
    expect([...image.data]).toEqual([0, 0, 0, 0]);
  });

  it("paletteId 不符时抛错", () => {
    expect(() =>
      patternToRgbaImage(
        { width: 1, height: 1, paletteId: "other", cells: Uint16Array.from([0]) },
        palette,
      ),
    ).toThrow(/色卡/);
  });

  it("色号下标越界时抛错，不静默取 0 号色", () => {
    expect(() =>
      patternToRgbaImage(
        { width: 1, height: 1, paletteId: "fake", cells: Uint16Array.from([9]) },
        palette,
      ),
    ).toThrow(/越界/);
  });

  it("cells 长度与宽高不符时抛错", () => {
    expect(() =>
      patternToRgbaImage(
        { width: 2, height: 2, paletteId: "fake", cells: Uint16Array.from([0]) },
        palette,
      ),
    ).toThrow(/长度/);
  });
});
```

```ts
// src/services/__tests__/patternThumbnail.test.ts
import { describe, expect, it } from "vitest";
import { loadPalette } from "@/core/palette/registry";
import { EMPTY } from "@/core/pattern/types";
import { renderPatternThumbnail, THUMBNAIL_MAX_EDGE } from "@/services/patternThumbnail";

const palette = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" },
    { code: "A2", hex: "#000000" },
  ],
});

/**
 * happy-dom 的 canvas 是桩实现，`toDataURL` 返回固定占位串、不反映像素。
 * 故这里**不**断言图像内容（那需要真实 canvas），只断言契约：调用了哪些平台 API、
 * 画布尺寸怎么算、空图纸是否被拒绝。像素内容的验证在任务 9 的人工流程里做。
 */
describe("renderPatternThumbnail", () => {
  it("返回带 png 前缀的 data URL", () => {
    const url = renderPatternThumbnail(
      { width: 2, height: 2, paletteId: "fake", cells: Uint16Array.from([0, 1, 1, 0]) },
      palette,
    );
    expect(url.startsWith("data:image/png")).toBe(true);
  });

  it("长边超过上限时按比例缩小，且不放大（1×1 图纸保持 1×1）", () => {
    // 这条用 spy 读画布实际尺寸：只断言「返回了字符串」抓不到尺寸算错。
    const sizes: Array<{ w: number; h: number }> = [];
    const original = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = original(tag) as HTMLCanvasElement;
      if (tag === "canvas") {
        // 记录 width/height 被设成什么值（赋值即入账）
        const target = el as HTMLCanvasElement & { __sizes?: Array<{ w: number; h: number }> };
        target.__sizes = sizes;
        let w = 0;
        let h = 0;
        Object.defineProperty(el, "width", {
          get: () => w,
          set: (v: number) => {
            w = v;
            sizes.push({ w, h });
          },
        });
        Object.defineProperty(el, "height", {
          get: () => h,
          set: (v: number) => {
            h = v;
            sizes.push({ w, h });
          },
        });
      }
      return el;
    });

    renderPatternThumbnail(
      { width: THUMBNAIL_MAX_EDGE * 2, height: THUMBNAIL_MAX_EDGE, paletteId: "fake", cells: new Uint16Array(THUMBNAIL_MAX_EDGE * 2 * THUMBNAIL_MAX_EDGE) },
      palette,
    );
    // 长边被压到上限
    expect(Math.max(...sizes.map((s) => s.w))).toBe(THUMBNAIL_MAX_EDGE);
    spy.mockRestore();
  });

  it("全空格图纸也返回合法 data URL（不抛错）", () => {
    const url = renderPatternThumbnail(
      { width: 1, height: 1, paletteId: "fake", cells: Uint16Array.from([EMPTY]) },
      palette,
    );
    expect(url.startsWith("data:image/png")).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/pattern/__tests__/raster.test.ts src/services/__tests__/patternThumbnail.test.ts`
预期：FAIL，报模块不存在。

- [ ] **步骤 3：编写实现**

```ts
// src/core/pattern/raster.ts
import type { RgbaImage } from "../image/types";
import type { Palette } from "../palette/types";
import { EMPTY, type Pattern } from "./types";

/**
 * 把图纸栅格化为 RGBA 位图：每格一个像素。
 *
 * 供列表封面（缩略图）与将来的导出渲染共用。**空格映射为完全透明**（RGB 也清零，
 * 不是「黑色但不透明」——后者在叠加到白底时会变成一个个黑点）。
 *
 * 非法输入一律抛错：色号下标越界若静默取 0 号色，会产出一张「看起来正常、颜色全错」的
 * 图纸，而空格的 `EMPTY` 与越界下标又共用同一个值域，不查就会互相冒充。
 */
export function patternToRgbaImage(pattern: Pattern, palette: Palette): RgbaImage {
  if (pattern.paletteId !== palette.id) {
    throw new Error(`图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${palette.id} 不一致`);
  }
  if (pattern.cells.length !== pattern.width * pattern.height) {
    throw new Error(
      `图纸 cells 长度 ${pattern.cells.length} 与 ${pattern.width}×${pattern.height} 不自洽`,
    );
  }

  const colors: number[][] = palette.colors.map((c) => [c.rgb[0], c.rgb[1], c.rgb[2]]);
  const data = new Uint8ClampedArray(pattern.width * pattern.height * 4);

  for (let i = 0; i < pattern.cells.length; i++) {
    const value = pattern.cells[i] as number;
    const to = i * 4;
    if (value === EMPTY) continue; // 已零初始化 = 完全透明
    const rgb = colors[value];
    if (rgb === undefined) {
      throw new Error(`第 ${i} 格的色号下标 ${value} 越界（色卡只有 ${colors.length} 色）`);
    }
    data[to] = rgb[0] as number;
    data[to + 1] = rgb[1] as number;
    data[to + 2] = rgb[2] as number;
    data[to + 3] = 255;
  }

  return { width: pattern.width, height: pattern.height, data };
}
```

```ts
// src/services/patternThumbnail.ts
import { patternToRgbaImage } from "@/core/pattern/raster";
import type { Pattern } from "@/core/pattern/types";
import type { Palette } from "@/core/palette/types";

/** 列表封面缩略图的长边上限（像素）。 */
export const THUMBNAIL_MAX_EDGE = 512;

/**
 * 把图纸渲染成列表封面缩略图（PNG data URL）。
 *
 * 封面必须是**图纸**而不是原图照片——用户在图纸库里找的是「那张小猫拼豆图」。
 * 长边压到 `THUMBNAIL_MAX_EDGE`，**只缩不放**（小图纸保持原始格数，避免把 8×8 的图纸
 * 放大成一张糊图）。
 *
 * 空格保持透明：列表卡片本身是白底，透明格会透出白底，视觉效果与「不拼豆」一致。
 */
export function renderPatternThumbnail(
  pattern: Pattern,
  palette: Palette,
  maxEdge: number = THUMBNAIL_MAX_EDGE,
): string {
  if (!Number.isInteger(maxEdge) || maxEdge < 1) {
    throw new Error(`缩略图长边上限非法：${maxEdge}`);
  }
  const image = patternToRgbaImage(pattern, palette);

  const cellCanvas = document.createElement("canvas");
  cellCanvas.width = image.width;
  cellCanvas.height = image.height;
  const cellCtx = cellCanvas.getContext("2d");
  if (cellCtx === null) throw new Error("无法获取 2D 上下文");

  const cellData = cellCtx.createImageData(image.width, image.height);
  cellData.data.set(image.data);
  cellCtx.putImageData(cellData, 0, 0);

  const longEdge = Math.max(image.width, image.height);
  const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(image.width * scale));
  out.height = Math.max(1, Math.round(image.height * scale));
  const outCtx = out.getContext("2d");
  if (outCtx === null) throw new Error("无法获取 2D 上下文");
  // 缩略图用最近邻：图纸是色块，插值会产生不存在的中间色，让人以为图纸里有那些颜色。
  outCtx.imageSmoothingEnabled = false;
  outCtx.drawImage(cellCanvas, 0, 0, out.width, out.height);

  return out.toDataURL("image/png");
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/core/pattern/__tests__/raster.test.ts src/services/__tests__/patternThumbnail.test.ts`
预期：PASS。
再运行：`npm run test -- src/__tests__/coreBoundary.test.ts` → PASS。

- [ ] **步骤 5：做事后变异**

1. `raster.ts` 里把 `if (value === EMPTY) continue;` 删掉 → 预期「空格映射成完全透明」转红（`EMPTY` 会去越界分支抛错或写出脏数据）。
2. `raster.ts` 里把 `data[to + 1] = rgb[1]` 删掉 → 预期「每个色号映射成对应 RGB」转红（G 通道未被断言才算漏洞，本用例三通道都断言了）。
3. `patternThumbnail.ts` 里把 `longEdge > maxEdge ? maxEdge / longEdge : 1` 改成恒 `maxEdge / longEdge` → 预期「不放大」转红。

- [ ] **步骤 6：Commit**

```bash
git add src/core/pattern/raster.ts src/core/pattern/__tests__/raster.test.ts src/services/patternThumbnail.ts src/services/__tests__/patternThumbnail.test.ts
git commit -m "feat(render): 图纸栅格化与列表封面缩略图"
```

---

## 任务 5：内置色卡入口与图片源

**文件：**
- 创建：`src/services/palette.ts`、`src/services/imageSource.ts`
- 测试：`src/services/__tests__/palette.test.ts`、`src/services/__tests__/imageSource.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/services/__tests__/palette.test.ts
import { describe, expect, it } from "vitest";
import { getBuiltinPalette } from "@/services/palette";

describe("内置色卡入口", () => {
  it("返回 MARD 221 色卡，且 id / 色数正确", () => {
    const palette = getBuiltinPalette();
    expect(palette.id).toBe("mard221");
    expect(palette.colors).toHaveLength(221);
  });

  it("重复调用返回同一对象（不在每次渲染里重新解析 JSON）", () => {
    expect(getBuiltinPalette()).toBe(getBuiltinPalette());
  });

  it("包含色号 A1 与 H1（能对上真实可采购色号）", () => {
    const codes = new Set(getBuiltinPalette().colors.map((c) => c.code));
    expect(codes.has("A1")).toBe(true);
    expect(codes.has("H1")).toBe(true);
  });
});
```

```ts
// src/services/__tests__/imageSource.test.ts
import { describe, expect, it } from "vitest";
import { fileFromInput, probeSourceSize } from "@/services/imageSource";

/** 造一张真实可解码的小 PNG（1×1 红点），避免依赖外部文件。 */
function onePixelPng(): Blob {
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

describe("imageSource", () => {
  it("fileFromInput 在没选文件时返回 null 并说明原因", () => {
    const result = fileFromInput(null);
    expect(result.ok).toBe(false);
  });

  it("fileFromInput 拒绝空文件", () => {
    const result = fileFromInput(new File([], "empty.png", { type: "image/png" }));
    expect(result.ok).toBe(false);
  });

  it("fileFromInput 接受有内容的图片文件", () => {
    const result = fileFromInput(new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.name).toBe("a.png");
  });

  it("probeSourceSize 能读出真实 PNG 的尺寸", async () => {
    const size = await probeSourceSize(onePixelPng());
    expect(size).toEqual({ width: 1, height: 1 });
  });

  it("probeSourceSize 对损坏数据抛出中文错误", async () => {
    await expect(probeSourceSize(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }))).rejects.toThrow();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/services/__tests__/palette.test.ts src/services/__tests__/imageSource.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：编写实现**

```ts
// src/services/palette.ts
import builtinMard221 from "@/core/palette/builtin/mard221.json";
import { loadPalette } from "@/core/palette/registry";
import type { Palette } from "@/core/palette/types";

/**
 * 内置色卡（MARD 221）的**唯一生产入口**。
 *
 * 在计划 A 里 MARD221 只被测试消费（`import raw from "../builtin/mard221.json"`），
 * 生产路径从未加载过它——B1 是第一个真正需要色卡的运行路径。集中在这里是为了：
 * ① 校验只跑一次（`loadPalette` 会逐字段白名单重建 221 条）；
 * ② 应用各处拿到的是**同一个对象**，不会出现「两份 221 色卡」这种同源副本；
 * ③ core 不许 import JSON 之外的裸包名，故这个入口必须留在 services 层。
 *
 * 惰性初始化：模块被 import 时不解析，首次调用才解析，避免拖慢启动。
 */
let cached: Palette | null = null;

export function getBuiltinPalette(): Palette {
  if (cached === null) cached = loadPalette(builtinMard221);
  return cached;
}
```

```ts
// src/services/imageSource.ts
import { probeImageSize } from "./probe";

/**
 * 图片来源。
 *
 * 计划 B1 只实现「浏览器 `<input type="file">`」一条路径；相机 / 相册 / 系统分享 target
 * 是**真机能力**，在浏览器里无法验证，故按规格 §2 的约定不写无法验证的分支——留到引入
 * Tauri 壳的那一轮。这里的函数形状按「一次交互产出一个 File」定义，届时新增实现即可。
 */

export type FileInputResult =
  | { readonly ok: true; readonly file: File }
  | { readonly ok: false; readonly reason: string };

/** 从文件输入的当前值里取文件。没选、或选了一个空文件时返回带原因的结果。 */
export function fileFromInput(input: HTMLInputElement | null): FileInputResult {
  const file = input?.files?.[0];
  if (file === undefined || file === null) {
    return { ok: false, reason: "请先选一张图片" };
  }
  if (file.size === 0) {
    return { ok: false, reason: "这个文件是空的，请换一张图片" };
  }
  return { ok: true, file };
}

/** 读出图片的原始像素尺寸。失败时抛出中文原因（不静默返回 0×0）。 */
export function probeSourceSize(source: Blob): Promise<{ width: number; height: number }> {
  return probeImageSize(source);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/services/__tests__/palette.test.ts src/services/__tests__/imageSource.test.ts`
预期：PASS。
若 `probeSourceSize` 的「真实 PNG」用例在 happy-dom 下不通过（happy-dom 可能不真的解码 PNG），把该用例改为在任务 9 的人工流程里验证，并在测试文件头注明原因——**不要**用假实现把断言做成恒真。

- [ ] **步骤 5：Commit**

```bash
git add src/services/palette.ts src/services/imageSource.ts src/services/__tests__/palette.test.ts src/services/__tests__/imageSource.test.ts
git commit -m "feat(services): 内置色卡入口与图片源"
```

---

## 任务 6：工程会话 store 与图纸库页面

**文件：**
- 创建：`src/stores/project.ts`、`src/views/LibraryPage.vue`
- 修改：`src/router/index.ts`
- 测试：`src/views/__tests__/LibraryPage.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/views/__tests__/LibraryPage.test.ts
import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { setProjectStore } from "@/services/projectStore";
import { makeRecord } from "@/services/__tests__/projectStoreContract";
import LibraryPage from "@/views/LibraryPage.vue";

const push = vi.fn();
vi.mock("vue-router", () => ({
  useRouter: () => ({ push }),
  RouterLink: { template: "<a><slot /></a>" },
}));

describe("LibraryPage", () => {
  beforeEach(async () => {
    push.mockClear();
    setActivePinia(createPinia());
    const store = await createMemoryProjectStore();
    await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
    await store.put(makeRecord("b", "小狗", "2026-10-03T05:00:00.000Z"));
    setProjectStore(store);
  });

  it("列出全部工程，按 updatedAt 倒序", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    const names = wrapper.findAll("[data-testid='project-name']").map((n) => n.text());
    expect(names).toEqual(["小狗", "小猫"]);
  });

  it("每行显示豆数与用色数", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    const first = wrapper.findAll("[data-testid='project-card']")[0];
    expect(first?.text()).toContain("2 × 1");
    expect(first?.text()).toContain("1");
  });

  it("空列表给出提示而不是一片空白", async () => {
    setProjectStore(await createMemoryProjectStore());
    const wrapper = mount(LibraryPage);
    await flushPromises();
    expect(wrapper.find("[data-testid='empty-hint']").exists()).toBe(true);
  });

  it("点「新建」跳到生成页", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    await wrapper.find("[data-testid='new-project']").trigger("click");
    expect(push).toHaveBeenCalledWith({ name: "generate" });
  });

  it("点卡片打开编辑器", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    await wrapper.findAll("[data-testid='open-project']")[0]?.trigger("click");
    expect(push).toHaveBeenCalledWith({ name: "editor", params: { id: "b" } });
  });

  it("重命名后列表显示新名字", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    await wrapper.findAll("[data-testid='rename-project']")[0]?.trigger("click");
    const input = wrapper.find("[data-testid='rename-input']");
    await input.setValue("新名字");
    await wrapper.find("[data-testid='rename-confirm']").trigger("click");
    await flushPromises();
    expect(wrapper.findAll("[data-testid='project-name']")[0]?.text()).toBe("新名字");
  });

  it("删除必须二次确认，确认后该条消失", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    await wrapper.findAll("[data-testid='delete-project']")[0]?.trigger("click");
    // 未确认前不能删
    expect(wrapper.findAll("[data-testid='project-card']")).toHaveLength(2);
    // 确认框里要出现工程名，防误删
    expect(wrapper.find("[data-testid='confirm-dialog']").text()).toContain("小狗");
    await wrapper.find("[data-testid='delete-confirm']").trigger("click");
    await flushPromises();
    const names = wrapper.findAll("[data-testid='project-name']").map((n) => n.text());
    expect(names).toEqual(["小猫"]);
  });

  it("取消删除后该条还在", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    await wrapper.findAll("[data-testid='delete-project']")[0]?.trigger("click");
    await wrapper.find("[data-testid='delete-cancel']").trigger("click");
    await flushPromises();
    expect(wrapper.findAll("[data-testid='project-card']")).toHaveLength(2);
  });

  it("存储不可用时给出提示并禁用新建，不静默失败", async () => {
    setProjectStore(null);
    const wrapper = mount(LibraryPage);
    await flushPromises();
    expect(wrapper.find("[data-testid='store-unavailable']").exists()).toBe(true);
    expect(
      (wrapper.find("[data-testid='new-project']").element as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/views/__tests__/LibraryPage.test.ts`
预期：FAIL，报 `Failed to resolve import "@/views/LibraryPage.vue"`。

- [ ] **步骤 3：编写 store 与页面**

```ts
// src/stores/project.ts
import { defineStore } from "pinia";
import { markRaw, ref } from "vue";
import { fromProjectDocument, toProjectDocument } from "@/core/project/file";
import type { ProjectParams } from "@/core/project/types";
import type { Pattern } from "@/core/pattern/types";
import type { Pattern } from "@/core/pattern/types";
import { getBuiltinPalette } from "@/services/palette";
import { getProjectStore, type ProjectMeta, type ProjectRecord } from "@/services/projectStore";

/** `fromProjectDocument` 的返回类型里参数那一半。 */
export interface RuntimeParams {
  readonly longSide: number;
  readonly maxColors: ProjectParams["maxColors"];
  readonly crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly rotation: 0 | 1 | 2 | 3;
}

/**
 * 当前工程会话。
 *
 * 只做三件事：把存储里的记录载入内存、把内存里的状态准备回写、跟踪「有没有未保存的改动」。
 * **不 import `indexedDB`**——存储实现一律经 `getProjectStore()` 取，测试可替换。
 *
 * `pattern` 用 `markRaw`：它是 `Uint16Array` 的持有者，被 Vue 深度代理会带来不必要的开销，
 * 且 `reactive` 包装 TypedArray 对将来编辑器的写入没有帮助。
 */
export const useProjectSession = defineStore("projectSession", () => {
  const record = ref<ProjectRecord | null>(null);
  const pattern = ref<Pattern | null>(null);
  const params = ref<RuntimeParams | null>(null);
  const dirty = ref(false);
  const error = ref("");

  /** 从存储载入一个工程。失败时把原因写进 `error` 并返回 false。 */
  async function load(id: string): Promise<boolean> {
    error.value = "";
    try {
      const loaded = await getProjectStore().get(id);
      if (loaded === null) {
        error.value = `找不到工程：${id}`;
        return false;
      }
      record.value = loaded;
      const parsed = fromProjectDocument(loaded.doc, getBuiltinPalette());
      pattern.value = markRaw(parsed.pattern);
      params.value = parsed.params;
      dirty.value = false;
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /** 用一份新生成的图纸开启会话（生成页用）。 */
  function adopt(
    newPattern: Pattern,
    newParams: RuntimeParams,
    meta: ProjectMeta,
    source: ProjectRecord["source"],
    doc: ProjectRecord["doc"],
  ): void {
    record.value = { meta, doc, source };
    pattern.value = markRaw(newPattern);
    params.value = newParams;
    dirty.value = true;
    error.value = "";
  }

  /** 把当前状态写回存储。失败时保留内存状态并返回 false（规格 §9）。 */
  async function save(): Promise<boolean> {
    if (record.value === null || pattern.value === null || params.value === null) {
      error.value = "当前没有可保存的工程";
      return false;
    }
    try {
      const doc = toProjectDocument(pattern.value, getBuiltinPalette(), {
        longSide: params.value.longSide,
        maxColors: params.value.maxColors,
        crop: {
          x: params.value.crop.x,
          y: params.value.crop.y,
          w: params.value.crop.width,
          h: params.value.crop.height,
          rotate: params.value.rotation,
        },
      });
      const saving: ProjectRecord = {
        meta: { ...record.value.meta, updatedAt: new Date().toISOString() },
        doc,
        source: record.value.source,
      };
      await getProjectStore().put(saving);
      record.value = saving;
      dirty.value = false;
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  function reset(): void {
    record.value = null;
    pattern.value = null;
    params.value = null;
    dirty.value = false;
    error.value = "";
  }

  return { record, pattern, params, dirty, error, load, adopt, save, reset };
});
```

```vue
<!-- src/views/LibraryPage.vue -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getProjectStore, type ProjectMeta } from "@/services/projectStore";

const router = useRouter();
const projects = ref<ProjectMeta[]>([]);
const usage = ref<{ usage: number; quota: number } | null>(null);
const storeUnavailable = ref(false);
const error = ref("");
const renamingId = ref<string | null>(null);
const renameDraft = ref("");
const pendingDelete = ref<ProjectMeta | null>(null);

const hasProjects = computed(() => projects.value.length > 0);

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function refresh(): Promise<void> {
  error.value = "";
  let store;
  try {
    store = getProjectStore();
  } catch (e) {
    storeUnavailable.value = true;
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  storeUnavailable.value = false;
  projects.value = await store.list();
  usage.value = await store.estimateUsage();
}

onMounted(refresh);

function startRename(meta: ProjectMeta): void {
  renamingId.value = meta.id;
  renameDraft.value = meta.name;
}

async function confirmRename(): Promise<void> {
  const id = renamingId.value;
  if (id === null) return;
  try {
    await getProjectStore().rename(id, renameDraft.value);
    renamingId.value = null;
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (target === null) return;
  try {
    await getProjectStore().remove(target.id);
    pendingDelete.value = null;
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function open(id: string): void {
  void router.push({ name: "editor", params: { id } });
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <header class="flex flex-wrap items-center justify-between gap-4">
      <h1 class="text-3xl font-bold text-slate-900">我的图纸</h1>
      <button
        data-testid="new-project"
        class="min-h-12 rounded bg-slate-900 px-6 text-lg text-white disabled:opacity-50"
        :disabled="storeUnavailable"
        @click="router.push({ name: 'generate' })"
      >
        新建图纸
      </button>
    </header>

    <p v-if="storeUnavailable" data-testid="store-unavailable" class="mt-4 rounded bg-red-50 p-4 text-lg text-red-700">
      这个浏览器不允许本地保存（可能是隐私模式），所以暂时不能新建或打开图纸。
    </p>
    <p v-if="error && !storeUnavailable" class="mt-4 rounded bg-amber-50 p-4 text-lg text-amber-800">
      {{ error }}
    </p>

    <p v-if="!storeUnavailable && !hasProjects" data-testid="empty-hint" class="mt-8 text-lg text-slate-500">
      还没有图纸。点右上角「新建图纸」选一张图片开始吧。
    </p>

    <ul class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <li
        v-for="meta in projects"
        :key="meta.id"
        data-testid="project-card"
        class="rounded-lg bg-white p-4 shadow"
      >
        <img
          v-if="meta.thumbnail"
          :src="meta.thumbnail"
          alt=""
          class="mb-3 h-32 w-full rounded bg-slate-100 object-contain"
        />
        <div v-else class="mb-3 flex h-32 w-full items-center justify-center rounded bg-slate-100 text-slate-400">
          没有封面
        </div>

        <template v-if="renamingId === meta.id">
          <input
            v-model="renameDraft"
            data-testid="rename-input"
            class="min-h-12 w-full rounded border border-slate-300 px-3 text-lg"
          />
          <div class="mt-2 flex gap-3">
            <button data-testid="rename-confirm" class="min-h-12 flex-1 rounded bg-slate-900 text-white" @click="confirmRename">
              好
            </button>
            <button class="min-h-12 flex-1 rounded border border-slate-300" @click="renamingId = null">
              算了
            </button>
          </div>
        </template>

        <template v-else>
          <p data-testid="project-name" class="truncate text-lg font-semibold text-slate-900">
            {{ meta.name }}
          </p>
          <p class="mt-1 text-base text-slate-500">{{ meta.width }} × {{ meta.height }} · {{ meta.colorCount }} 种颜色</p>
          <div class="mt-3 flex flex-wrap gap-3">
            <button data-testid="open-project" class="min-h-12 flex-1 rounded bg-slate-900 px-4 text-white" @click="open(meta.id)">
              打开
            </button>
            <button data-testid="rename-project" class="min-h-12 rounded border border-slate-300 px-4" @click="startRename(meta)">
              改名
            </button>
            <button data-testid="delete-project" class="min-h-12 rounded border border-red-300 px-4 text-red-700" @click="pendingDelete = meta">
              删除
            </button>
          </div>
        </template>
      </li>
    </ul>

    <p v-if="usage" class="mt-8 text-base text-slate-500">
      已用 {{ formatMb(usage.usage) }} / 可用约 {{ formatMb(usage.quota) }}
    </p>

    <div
      v-if="pendingDelete"
      data-testid="confirm-dialog"
      class="fixed inset-0 flex items-center justify-center bg-black/40 p-4"
    >
      <div class="w-full max-w-md rounded-lg bg-white p-6">
        <p class="text-xl text-slate-900">确定删掉「{{ pendingDelete.name }}」吗？删了就找不回来了。</p>
        <div class="mt-6 flex gap-4">
          <button data-testid="delete-confirm" class="min-h-14 flex-1 rounded bg-red-600 text-lg text-white" @click="confirmDelete">
            删掉
          </button>
          <button data-testid="delete-cancel" class="min-h-14 flex-1 rounded border border-slate-300 text-lg" @click="pendingDelete = null">
            不删
          </button>
        </div>
      </div>
    </div>
  </main>
</template>
```

```ts
// src/router/index.ts
import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: () => import("@/views/LibraryPage.vue") },
    // B1 的临时入口：居中正方裁剪、固定长边 58 / 档位 32。计划 B2 会用真正的
    // 「选区 → 尺寸 → 档位」流程替换它。
    { path: "/new", name: "generate", component: () => import("@/views/GeneratePage.vue") },
    // B1 只到「载入并显示只读预览 + 参数」，编辑器是计划 B3。
    { path: "/edit/:id", name: "editor", component: () => import("@/views/EditorPage.vue") },
    { path: "/lab/decode", name: "decode-lab", component: () => import("@/views/DecodeLabPage.vue") },
  ],
});
```

> 任务 6 的测试只覆盖 `LibraryPage`，`GeneratePage` / `EditorPage` 在任务 7 建。为了让本任务的 `npm run build` 能过，**在任务 6 里先各建一个最小占位页**（各 3 行、只有标题），任务 7 再填实。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/views/__tests__/LibraryPage.test.ts`
预期：PASS，9 条。

- [ ] **步骤 5：做事后变异**

1. 把「新建」按钮的 `:disabled="storeUnavailable"` 删掉 → 预期「存储不可用时禁用新建」转红。
2. 把删除确认框里的 `{{ pendingDelete.name }}` 删掉 → 预期「确认框里要出现工程名」转红。
3. 把 `confirmDelete` 里的 `await getProjectStore().remove(target.id)` 注释掉 → 预期「删除必须二次确认，确认后该条消失」的**后半段**转红（前半段仍绿，说明它测的是「未确认前不能删」）。

- [ ] **步骤 6：Commit**

```bash
git add src/stores/project.ts src/views/LibraryPage.vue src/views/GeneratePage.vue src/views/EditorPage.vue src/router/index.ts src/views/__tests__/LibraryPage.test.ts
git commit -m "feat(library): 图纸库首页与会话 store"
```

---

## 任务 7：生成页（B1 临时入口）与编辑器只读页

**文件：**
- 修改：`src/views/GeneratePage.vue`、`src/views/EditorPage.vue`、`src/main.ts`
- 测试：`src/views/__tests__/GeneratePage.test.ts`、`src/views/__tests__/EditorPage.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/views/__tests__/GeneratePage.test.ts
import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { setProjectStore } from "@/services/projectStore";
import GeneratePage from "@/views/GeneratePage.vue";

const push = vi.fn();
vi.mock("vue-router", () => ({
  useRouter: () => ({ push }),
  RouterLink: { template: "<a><slot /></a>" },
}));

/**
 * 生成页依赖真实解码（createImageBitmap）与真实图片。happy-dom 不提供这些，
 * 所以这里测的是**失败路径与状态机**：没选图时不许开工、错误要有中文原因、
 * 成功后要跳到首页。真正的端到端生成在任务 9 的人工流程里验。
 */
describe("GeneratePage", () => {
  beforeEach(() => {
    push.mockClear();
    setActivePinia(createPinia());
  });

  it("没选图片时点生成给出提示，不跳转", async () => {
    setProjectStore(await createMemoryProjectStore());
    const wrapper = mount(GeneratePage);
    await wrapper.find("[data-testid='generate-run']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='generate-error']").text()).toContain("请先选");
    expect(push).not.toHaveBeenCalled();
  });

  it("存储未初始化时给出明确错误而不是白屏", async () => {
    setProjectStore(null);
    const wrapper = mount(GeneratePage);
    await flushPromises();
    expect(wrapper.text()).toContain("工程存储");
  });

  it("长边档位选择器默认 58，并可切到 116", async () => {
    setProjectStore(await createMemoryProjectStore());
    const wrapper = mount(GeneratePage);
    const select = wrapper.find("[data-testid='long-side']");
    expect((select.element as HTMLSelectElement).value).toBe("58");
    await select.setValue("116");
    expect((select.element as HTMLSelectElement).value).toBe("116");
  });
});
```

```ts
// src/views/__tests__/EditorPage.test.ts
import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { setProjectStore } from "@/services/projectStore";
import { makeRecord } from "@/services/__tests__/projectStoreContract";
import EditorPage from "@/views/EditorPage.vue";

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "a" } }),
  useRouter: () => ({ push: vi.fn() }),
  RouterLink: { template: "<a><slot /></a>" },
}));

describe("EditorPage（B1 只读版）", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = await createMemoryProjectStore();
    await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z", { withSource: true }));
    setProjectStore(store);
  });

  it("载入工程并显示名称与尺寸", async () => {
    const wrapper = mount(EditorPage);
    await flushPromises();
    expect(wrapper.text()).toContain("小猫");
    expect(wrapper.text()).toContain("2 × 1");
  });

  it("有原图时显示「可以改参数重跑」，没有时明确禁用并给原因", async () => {
    const wrapper = mount(EditorPage);
    await flushPromises();
    expect(wrapper.find("[data-testid='rerun-available']").exists()).toBe(true);

    const noSource = await createMemoryProjectStore();
    await noSource.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
    setProjectStore(noSource);
    const second = mount(EditorPage);
    await flushPromises();
    expect(second.find("[data-testid='rerun-unavailable']").text()).toContain("原图");
  });

  it("找不到工程时显示错误，不白屏", async () => {
    setProjectStore(await createMemoryProjectStore());
    const wrapper = mount(EditorPage);
    await flushPromises();
    expect(wrapper.find("[data-testid='editor-error']").text()).toContain("找不到");
  });

  it("标注了「编辑器将在后续计划提供」这一 B1 边界", async () => {
    const wrapper = mount(EditorPage);
    await flushPromises();
    expect(wrapper.find("[data-testid='editor-todo']").exists()).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/views/__tests__/GeneratePage.test.ts src/views/__tests__/EditorPage.test.ts`
预期：FAIL（占位页里没有 `data-testid`）。

- [ ] **步骤 3：编写实现**

`GeneratePage.vue` 的脚本部分：

```ts
// src/views/GeneratePage.vue
//
// ⚠️ 临时入口（计划 B1）：固定「居中正方裁剪 + 长边 58/116 + 档位 16/32/不限」。
// 规格要求的完整流程是「选图 → 拖动缩放选区 → 尺寸/色卡/档位设置 → 生成」，
// 由计划 B2 用真正的选区页与设置页**替换本文件**。不要把它当正式入口继续加功能。
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import { createExactDecoder, createFastDecoder, createDomBitmapPlatform } from "@/services/decoders";
import { fileFromInput, probeSourceSize } from "@/services/imageSource";
import { getBuiltinPalette } from "@/services/palette";
import { renderPatternThumbnail } from "@/services/patternThumbnail";
import { getProjectStore, type ProjectMeta, type ProjectRecord } from "@/services/projectStore";
import { generatePattern } from "@/services/pipeline";

const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const longSide = ref("58");
const maxColors = ref("32");
const busy = ref(false);
const error = ref("");
const storeError = ref("");

/** B1 临时入口的固定档位（规格 §8）：长边 58 / 116，档位 16 / 32 / 不限。 */
const LONG_SIDE_CHOICES = [58, 116] as const;
const MAX_COLOR_CHOICES = [
  { value: "16", label: "简单（16 色）" },
  { value: "32", label: "标准（32 色）" },
  { value: "", label: "精细（颜色不限）" },
] as const;

onMounted(() => {
  try {
    getProjectStore();
  } catch (e) {
    storeError.value = e instanceof Error ? e.message : String(e);
  }
});

function parseMaxColors(raw: string): 16 | 32 | null {
  if (raw === "16") return 16;
  if (raw === "32") return 32;
  return null;
}

async function run(): Promise<void> {
  error.value = "";
  const picked = fileFromInput(fileInput.value);
  if (!picked.ok) {
    error.value = picked.reason;
    return;
  }

  busy.value = true;
  try {
    const palette = getBuiltinPalette();
    const size = await probeSourceSize(picked.file);
    // 居中正方裁剪，边长取短边（与解码实验台的 0.5 倍裁剪不同，这里取满）
    const side = Math.min(size.width, size.height);
    const crop = {
      x: Math.round((size.width - side) / 2),
      y: Math.round((size.height - side) / 2),
      width: side,
      height: side,
    };
    const targetLongSide = Number.parseInt(longSide.value, 10);
    const targetMaxColors = parseMaxColors(maxColors.value);

    const platform = createDomBitmapPlatform();
    const pattern = await generatePattern(
      { source: picked.file, crop, rotation: 0, longSide: targetLongSide, maxColors: targetMaxColors },
      {
        exactDecoder: createExactDecoder(platform),
        fastDecoder: createFastDecoder(platform),
        palette,
      },
    );

    const filledCount = pattern.cells.reduce(
      (sum, value) => (value === EMPTY ? sum : sum + 1),
      0,
    );
    if (filledCount === 0) {
      error.value = "这张图没有可拼的像素，换一张试试";
      return;
    }

    const params = { longSide: targetLongSide, maxColors: targetMaxColors, crop: { x: crop.x, y: crop.y, w: crop.width, h: crop.height, rotate: 0 } };
    const doc = toProjectDocument(pattern, palette, params);
    const id = createId();
    const now = new Date().toISOString();
    const meta: ProjectMeta = {
      id,
      name: defaultName(picked.file.name),
      createdAt: now,
      updatedAt: now,
      thumbnail: renderPatternThumbnail(pattern, palette),
      width: 0,
      height: 0,
      colorCount: 0,
    };
    const record: ProjectRecord = {
      meta,
      doc,
      source: { blob: picked.file, type: picked.file.type },
    };
    await getProjectStore().put(record);
    await router.push({ name: "home" });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/** 工程 id：优先用 crypto.randomUUID（安全上下文），不可用时退到时间戳 + 随机数。 */
function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 默认工程名：原文件名去掉扩展名；为空时给一个中性名。 */
function defaultName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  return base.length === 0 ? "新图纸" : base;
}

const canGenerate = computed(() => !busy.value && storeError.value === "");
```

模板要点（其余样式按 `LibraryPage` 的大触控目标风格）：

```vue
<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <h1 class="text-3xl font-bold text-slate-900">新建图纸</h1>
    <p class="mt-2 text-base text-amber-700">
      临时入口（计划 B1）：固定居中正方裁剪，长边与档位只有两三个选项。
      完整的「选区 → 尺寸 → 档位」界面由后续计划提供。
    </p>

    <p v-if="storeError" class="mt-4 rounded bg-red-50 p-4 text-lg text-red-700">
      工程存储不可用：{{ storeError }}
    </p>

    <section class="mt-6 space-y-6">
      <label class="block text-lg">
        选一张图片
        <input ref="fileInput" type="file" accept="image/*" class="mt-2 block text-base" />
      </label>

      <label class="block text-lg">
        长边豆数
        <select v-model="longSide" data-testid="long-side" class="mt-2 block min-h-12 rounded border border-slate-300 px-3 text-lg">
          <option v-for="n in LONG_SIDE_CHOICES" :key="n" :value="String(n)">{{ n }} 颗</option>
        </select>
      </label>

      <label class="block text-lg">
        用几种颜色
        <select v-model="maxColors" class="mt-2 block min-h-12 rounded border border-slate-300 px-3 text-lg">
          <option v-for="c in MAX_COLOR_CHOICES" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </label>

      <button
        data-testid="generate-run"
        class="min-h-14 rounded bg-slate-900 px-8 text-lg text-white disabled:opacity-50"
        :disabled="!canGenerate"
        @click="run"
      >
        {{ busy ? "正在生成…" : "生成图纸" }}
      </button>
    </section>

    <p v-if="error" data-testid="generate-error" class="mt-4 rounded bg-amber-50 p-4 text-lg text-amber-800">
      {{ error }}
    </p>
  </main>
</template>
```

`EditorPage.vue`（B1 只读版）：

```vue
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useProjectSession } from "@/stores/project";

const route = useRoute();
const session = useProjectSession();
const loaded = ref(false);

onMounted(async () => {
  const id = route.params.id;
  loaded.value = await session.load(typeof id === "string" ? id : "");
});
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <p v-if="session.error" data-testid="editor-error" class="rounded bg-red-50 p-4 text-lg text-red-700">
      {{ session.error }}
    </p>

    <template v-else-if="loaded && session.record">
      <h1 class="text-3xl font-bold text-slate-900">{{ session.record.meta.name }}</h1>
      <p class="mt-2 text-lg text-slate-600">
        {{ session.record.meta.width }} × {{ session.record.meta.height }} · {{ session.record.meta.colorCount }} 种颜色
      </p>

      <p v-if="session.record.source" data-testid="rerun-available" class="mt-4 text-lg text-slate-600">
        原图已保存，可以改参数重新生成。
      </p>
      <p v-else data-testid="rerun-unavailable" class="mt-4 text-lg text-amber-700">
        这个工程没有保存原图，只能继续编辑或重新导出，不能改参数重新生成。
      </p>

      <p data-testid="editor-todo" class="mt-6 rounded bg-slate-100 p-4 text-lg text-slate-600">
        画笔、框选、吸管与撤销会在后续计划里加到这里。现在只能看参数。
      </p>
    </template>
  </main>
</template>
```

`src/main.ts`（修改：注入存储实现）：

```ts
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { createIdbProjectStore } from "./services/idbProjectStore";
import { setProjectStore } from "./services/projectStore";
import "./style.css";

// 存储实现只在这里注入一次：页面通过 getProjectStore() 取，测试注入内存实现。
// 打开失败时**仍然挂载**应用——图纸库页面会显示「存储不可用」并禁用新建，
// 而不是整页白屏。
try {
  setProjectStore(await createIdbProjectStore());
} catch (error) {
  console.error("工程存储初始化失败", error);
}

createApp(App).use(createPinia()).use(router).mount("#app");
```

> **实现注意**：顶层 `await` 需要 Vite 的目标支持（`build.target` 默认 `esnext` 时可用）。若 `npm run build` 报错，改成 `.then()` 形式：
> ```ts
> void createIdbProjectStore()
>   .then((store) => setProjectStore(store))
>   .catch((error: unknown) => console.error("工程存储初始化失败", error));
> createApp(App).use(createPinia()).use(router).mount("#app");
> ```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/views/__tests__/GeneratePage.test.ts src/views/__tests__/EditorPage.test.ts`
预期：PASS。
运行全量：`npm run test` → 预期全绿（既有 312 用例 + 本轮新增）。
运行构建：`npm run build` → 预期通过。

- [ ] **步骤 5：端到端人工验证（规格 §11 的完成标准）**

运行：`npm run dev`，浏览器打开 `http://localhost:1420`，逐条走并记录：

1. 首页显示「还没有图纸」提示。
2. 点「新建图纸」→ 选一张真实照片（硬边内容优先，例如截图）→ 长边 58 / 标准 32 → 生成。
3. 回到首页，看到新卡片：**封面是拼豆图纸**（不是原图照片）、名字是原文件名、豆数与用色数正确。
4. 点「改名」改成别的名字，刷新页面后仍是新名字（证明真的落盘了，不是内存态）。
5. 点「打开」→ 编辑器显示名称、尺寸、「原图已保存，可以改参数重新生成」。
6. 回首页点「删除」→ 确认框里出现工程名 → 删掉 → 卡片消失 → **刷新后仍然消失**。
7. 再生成 3–5 张，确认列表底部出现「已用 X MB / 可用约 Y MB」。
8. 开发者工具 → Application → IndexedDB → `wee-fuse`，确认 `projects`（4–5 条）与 `sources`（含 Blob）两个 store 都有数据，且 `projects` 里**没有** MB 级数据。

- [ ] **步骤 6：做事后变异**

1. `GeneratePage` 里把 `filledCount === 0` 那段删掉 → 预期「全空格不产出空图纸」这条行为消失（**注意**：本任务的自动用例没覆盖它，所以这条只能靠人工：用一张全透明 PNG 走一遍，必须看到提示而不是一张空图纸）。
2. `EditorPage` 里把 `source` 为 null 的分支删掉 → 预期「没有原图时明确禁用」转红。
3. `main.ts` 里把 `setProjectStore` 整个删掉 → 预期应用仍能挂载、首页显示「存储不可用」（**不许**白屏）。

- [ ] **步骤 7：更新 README**

把 `README.md` 的「当前进度」段改为：引擎已完成；应用层 B1（骨架 / 工程文件契约 / 图纸库）已完成，可在浏览器里跑通「选图 → 生成 → 保存 → 图纸库」；明确写出 `/new` 是**临时入口**，选区 / 编辑器 / 导出分别在 B2 / B3 / B4。同时在「目录结构」里补 `src/core/project/`、`src/stores/`、新页面。

- [ ] **步骤 8：Commit**

```bash
git add src/views/GeneratePage.vue src/views/EditorPage.vue src/main.ts src/views/__tests__/GeneratePage.test.ts src/views/__tests__/EditorPage.test.ts README.md
git commit -m "feat(app): B1 临时生成入口、编辑器只读页与应用装配"
```

---

## 任务 8：收尾复核

**文件：** 无新增；只做验证与文档回写。

- [ ] **步骤 1：全量验证**

```bash
npm ci
npm run test
npm run build
```
预期：三条全过。记录实际用例数与文件数（**回原始输出重数，不引用任何汇总行**——本项目纪律）。

- [ ] **步骤 2：规格覆盖度对照**

逐条打开 `docs/superpowers/specs/2026-10-03-app-skeleton-design.md`，为每一节指出实现它的任务。**特别检查这几条容易漏的**：

- §4.4 的 `source === null` → 禁用「改参数重跑」且有原因（任务 7 步骤 5 第 5 条 + `EditorPage` 的两条用例）。
- §6.2 的「数据模型按工程 = 一个目录设计」→ 任务 3 的两 store 结构 + 接口形状。
- §7.3 的占用显示 → 任务 7 步骤 5 第 7 条 + `LibraryPage` 的 `usage` 渲染。
- §9 的「存储接口不可用」→ 任务 6 的用例 + 任务 7 的 `storeError`。
- §12 的入口校验清单 → 逐个公开导出核对是否都校验了。

- [ ] **步骤 3：回写规格的实测结论**

把规格 §14 的三条风险（B1-R1 / B1-R2 / B1-R3）逐条改为实测结论：
- B1-R1 在任务 0 已回写；
- B1-R2 用任务 7 步骤 5 第 7 条读到的数字；
- B1-R3 记录 `crypto.randomUUID` 在浏览器里是否可用。

- [ ] **步骤 4：写构建记录**

按 `docs/superpowers/notes/2026-10-01-engine-build-log.md` 的体例新建
`docs/superpowers/notes/2026-10-04-app-b1-build-log.md`，只记**判断依据与被推翻的判断**，不重复规格与 README。至少覆盖：

- 本次规格自检改掉的三处（JSON 缺 `width`/`height`、`thumbnail` 三处口径打架、一条用例方向写反）；
- 任务 0 的实测结论与它是如何影响任务 3 的；
- 各任务事后变异的结果（哪一处没有转红、如何补强）；
- 与规格不一致但被授权的偏离（例如 `window` 形参命名规避闸门的处理）。

- [ ] **步骤 5：Commit**

```bash
git add docs/ README.md
git commit -m "docs: B1 构建记录与风险实测回写"
```

---

## 自检记录（计划作者已执行）

**1. 规格覆盖度**

| 规格节 | 实现它的任务 |
|---|---|
| §3 模块边界（11 个新文件） | 任务 1–7 逐个落地 |
| §4 工程文件格式 v1 + §4.3 三处修正 | 任务 1（schema）、任务 2（映射） |
| §4.4 `doc` / `meta` / `source` 三分与冗余字段纪律 | 任务 1（doc）、任务 3（meta + 覆盖规则） |
| §5.1–§5.3 双向映射、两处静默风险点 | 任务 2 |
| §5.4 校验口径全表 | 任务 1 |
| §6.1–§6.3 存储接口与边界 | 任务 3、任务 6 |
| §7 图纸库 UI（列表 / 改名 / 删除 / 占用 / 布局） | 任务 6 |
| §8 临时生成入口（含三处标注） | 任务 7（页面标题 + 文件头注释 + README；文件头注释写在脚本首行） |
| §9 错误处理六条 | 任务 1（文件损坏）、任务 3（存储不可用）、任务 6、任务 7 |
| §10 测试要点（含 JSON 序列化往返、判别力用例） | 任务 2（往返 + 换顺序）、任务 3（共用契约）、任务 4、任务 6 |
| §11 验证命令与完成标准 | 任务 7 步骤 5、任务 8 步骤 1 |
| §12 入口校验清单 | 任务 1、任务 2、任务 3（`put` / `rename`） |
| §13 延后项（四条不修） | 未新增任务（有意） |
| §14 三条风险 | 任务 0（B1-R1）、任务 7 步骤 5（B1-R2 / R3）、任务 8 步骤 3 |

**已知缺口（如实记录，不粉饰）**：

1. **`GeneratePage` 的成功路径没有自动化测试**。它需要真实解码与真实图片，happy-dom 不提供。自动用例只覆盖状态机与失败路径，成功路径靠任务 7 步骤 5 的人工流程。这是本计划最大的测试缺口。
2. **`renderPatternThumbnail` 的像素内容无断言**。happy-dom 的 canvas 是桩实现，只断言了 data URL 前缀与画布尺寸，**没有**断言缩略图画的是什么。像素正确性靠人工（任务 7 步骤 5 第 3 条要求「封面是拼豆图纸而不是原图照片」）。
3. **`estimateUsage()` 的两条分支都没有自动用例**。它在 `memoryProjectStore` 上恒为 null、在 `idbProjectStore` 上依赖 `navigator.storage`，fake-indexeddb 不提供。覆盖靠人工。
4. **DPR 处理与平板横竖屏切换不在本计划内**（B1 没有 Canvas 交互预览，属于 B2 / B3 的约束）。

**2. 占位符扫描**：无「待定」「TODO」「后续实现」「类似任务 N」。首轮写作时曾在任务 6 的 `stores/project.ts` 里留下两个未定义的辅助函数（`paletteFor` / `getBuiltinPaletteRef`）来回避 import 展开，随后判定这就是占位符，已删掉并改为顶部直接 `import { getBuiltinPalette } from "@/services/palette"`——`services/palette.ts` 不 import store，不存在循环依赖。

**另一处自检修正**：任务 3 的内存实现原本直接把 `doc` / `source` 的**引用**存进 Map 并原样交出，而 IndexedDB 实现（结构化克隆）交出的必然是副本——两套实现的语义不一致，「换实现不影响调用方」这个承诺就是假的。已改为落库与出库各做一次深拷贝，并在共用契约里补了一条专打引用泄漏的用例（取出的对象上乱改后再取一次，必须还是原值）。

**3. 类型一致性**（逐个核对跨任务引用）：

- `ProjectMeta` / `ProjectRecord` / `ProjectStore` 定义于任务 3，被任务 6（`LibraryPage`、`stores/project.ts`）、任务 7 使用，字段名一致。
- `ProjectDocument` / `ProjectParams` 定义于任务 1，被任务 2、任务 6、任务 7 使用。
- `fromProjectDocument` 返回的 `params.crop` 是 `{x, y, width, height}` + 独立 `rotation`（任务 2），任务 6 的 `save()` 把它反向拼回 `{w, h, rotate}`——**这是本轮唯一一处双向字段搬位，已在任务 2 步骤 5 的变异 4 与任务 6 的 `save()` 里各钉一次**。
- `renderPatternThumbnail(pattern, palette, maxEdge?)`（任务 4）被任务 7 以两参形式调用，一致。
- `THUMBNAIL_MAX_EDGE` 定义并导出（任务 4），只在任务 4 的测试里使用——按「公开 API ≠ 被使用的 API」约定，它在 JSDoc 里已写明为何公开（上限可被调用方调整）。
- `getBuiltinPalette()`（任务 5）被任务 6 与任务 7 使用，返回类型 `Palette` 一致。
- `fileFromInput` / `probeSourceSize`（任务 5）被任务 7 使用，返回形状一致。
