# 计划 B5：Tauri Android 壳（图片来源 / 保存到相册 / 生命周期） 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把跑在浏览器里的完整 App 变成**装得进 Android 手机的 App**，并实现只有装进手机才能做的四件事——相册选图 / 拍照 / 系统分享进入 / 保存到相册，以及「返回键不静默丢稿」的生命周期闭环。

**架构：** 新增一层平台能力层（`src/services/platform/`）：四个能力的窄接口 + 两条实现（浏览器 / Tauri），运行时按 `globalThis.isTauri` 注入，两条实现共跑一份契约测试；`src-tauri/` 提供 Rust 工程与 Android 生成工程，全仓**只有 `tauriDriver.ts` 一个文件**接触 `@tauri-apps/*`，且全部走动态 `import()`，所以浏览器路径与全部既有单测一行不改。**先探路（spike）拿到六份真机读数，再用读数决定相册 / 拍照 / 分享 / 保存的具体实现分支。**

**技术栈：** Tauri 2（`@tauri-apps/cli` 2.12.x / `tauri` 2.12.1）、Rust stable、Android SDK 36 + NDK 30、Vue 3 + TypeScript 严格模式 + vitest（happy-dom）。

**规格：** `docs/superpowers/specs/2026-10-06-app-b5-tauri-shell-design.md`（本计划的全部论证依据；执行者两份都要读）

---

## 全局约束

> 每条都来自规格或 `AGENTS.md`，数值逐字照抄。**每个任务都隐含包含本节。**

1. 分支 `feat/app-b5`，基点 `main` 的 `f402514`（加规格提交 `c064073`）。
2. 基线：`npm run test` = **62 文件 / 1137 用例**全绿（分解式 `1054 + 28 + 54 + 1 = 1137`）；`npm run build` 通过。
3. **不许删改任何既有测试**；本轮只许追加用例与断言。既有断言一行不改是本计划的硬约束。
4. TypeScript 严格模式，**禁止 `any`**；提交信息用 Conventional Commits + 中文描述。
5. `identifier = cn.tuzkimo.weefuse`（**一经确定不再改**：它决定 Android 包名与 App 数据目录）。
6. `bundle.android.minSdkVersion = 29`；相册落点 `Pictures/WeeFuse`；Android 显示名 `一起拼豆`（手改 `gen/android/app/src/main/res/values/strings.xml` 的 `app_name`）；`productName = WeeFuse`。
7. **`@tauri-apps/*` 只许出现在 `src/services/platform/tauriDriver.ts`**（静态或动态 import 一律算），机检 = `src/__tests__/platformGate.test.ts` 的 G1。
8. **`isTauri` 只许在 `src/services/platform/capabilities.ts` 里被读**（机检 = G2）。
9. `setPlatform(...)` 必须出现在 `main.ts` 的 `mount(...)` **之前**（机检 = G3）。
10. `src/core/**` 不得 import `@tauri-apps/*`、不得引用 DOM 全局（既有闸门 `src/__tests__/coreBoundary.test.ts`，本轮不动它）。
11. 公开导出一律要有中文 JSDoc 写明**消费者是谁**；零消费者的如实写明理由（`AGENTS.md`「公开 API ≠ 被使用的 API」）。
12. 入口守卫写在**任何写操作之前**；错误消息逐字照规格 §4.4（`导出内容为空（blob 大小为 0）` / `文件名不能为空` / `图片选择器返回了非文件对象` / `本平台不支持拍照` / `分享内容不是文件` / `回调必须是函数`）。
13. 每个任务收尾三跑：`npm run test`、`npm run build`、涉及 Rust 时 `cargo check --manifest-path src-tauri/Cargo.toml`；`npm run test` 与 `TZ=UTC npm run test` 都要对得上。
14. **变异只能在已提交的树上做**（B4 的 R-12：`git checkout --` 会静默丢弃未提交改动）；**变异脚本必须自证替换真的发生了**（B4 账本：0 红与全红一样，先怀疑仪器）；**红数不许预估**，由实现者实跑回填。
15. 行数一律用 `[System.IO.File]::ReadAllLines($p).Length` 数（`Get-Content <file>.Count` 在本机会少算，B4 已记）。
16. 需要对外报的数字一律**回原始清单重数**，不引用任何汇总行。
17. 每个任务只许创建/修改简报点名的文件；**不许自己派子代理**。
18. **本计划分两遍写**：任务 0–2（能力层 / 壳骨架 / spike）在探路前定稿；任务 3–8 在 spike 读数到手后补写进同一份文档（规格 §13 的既定安排），**不留占位符**。

---

## 文件结构（决定任务分解，先锁死）

| 文件 | 职责 | 哪个任务创建 |
|---|---|---|
| `src/services/platform/types.ts` | 四个能力的接口 + `Platform`（本轮的契约面） | 任务 0 |
| `src/services/platform/capabilities.ts` | `isTauriRuntime()` / `setPlatform` / `getPlatform`（`isTauri` 的唯一读取点） | 任务 0 |
| `src/services/platform/guards.ts` | `requireSavableBlob`（两实现共用的一份守卫） | 任务 0 |
| `src/services/platform/browserPlatform.ts` | 浏览器实现（下载 / 可见 input / 生命周期 no-op） | 任务 0 |
| `src/services/platform/__tests__/platformContract.ts` | 两实现共用的契约用例（非 `.test.ts`，不被收集） | 任务 0 |
| `src/services/platform/tauriDriver.ts` | **唯一**接触 `@tauri-apps/*` 的文件（动态 import + 窄接口） | 任务 2 |
| `src/services/platform/tauriPlatform.ts` | `createTauriPlatform(driver?)`：驱动 → 能力（纯逻辑） | 任务 2 |
| `src/views/ShellProbePage.vue` | `/lab/shell` 探针页（开发期实验台，留存的第三个） | 任务 2 |
| `src-tauri/**` | Rust 工程 + Tauri 配置 + Android 生成工程 + 移动插件 | 任务 1 / 2 |
| `src-tauri/plugins/album/**` | MediaStore 移动插件（Kotlin + Rust 包装） | 任务 2 |
| `scripts/make-app-icon.mjs` | 零依赖生成 1024² 源图标 PNG | 任务 1 |
| `src/__tests__/platformGate.test.ts` | G1–G4 四条源码级闸门 | 任务 1 |
| `src/composables/useShareIntake.ts` | 分享摄入链（App 级） | pass 2 任务 5 |
| `src/composables/useShellLifecycle.ts` | 返回键 / 退出请求装配（App 级） | pass 2 任务 7 |

---

### 任务 0：平台能力层（接口 / 守卫 / 注入 / 浏览器实现 / 契约测试）

**交付物**：四个能力的接口 + 一份两实现共用的契约测试 + 浏览器实现；`main.ts` 在挂载前注入。**本任务结束时浏览器行为与今天逐字等价**（`npm run test` 全绿，既有断言一行未改）。

**文件：**
- 创建：`src/services/platform/types.ts`、`src/services/platform/guards.ts`、`src/services/platform/capabilities.ts`、`src/services/platform/browserPlatform.ts`
- 测试：`src/services/platform/__tests__/platformContract.ts`（**不是 `.test.ts`**，不被 vitest 收集）、`guards.test.ts`、`capabilities.test.ts`、`browserPlatform.test.ts`
- 修改：`src/services/exporter.ts`（`downloadBlob` 的两条守卫改为调用 `requireSavableBlob`，**两条消息逐字不变**）、`src/main.ts`（挂载前注入）

- [ ] **步骤 1：写接口 `types.ts`**

`src/services/platform/types.ts`：

```ts
/**
 * 平台能力层的契约（计划 B5 规格 §4.1）。
 *
 * **为什么要有这一层**：`src/services/**` 是唯一接触平台 API 的层（`AGENTS.md` 分层边界），
 * 而「浏览器」与「Tauri 壳」是两套平台。把差异收在四个窄接口后面换来三件事——浏览器路径与
 * 全部既有单测一行不改；壳实现能在 CI 里被**假驱动**完整驱动；平台判断只有一处
 * （`capabilities.ts`，机检 G2）。
 *
 * **名字是契约面**：五个接口与它们的字段名被 `tauriPlatform.ts`、`PickPage.vue`、
 * `ExportPanel.vue`、两个 composable 与契约测试同时引用，改名会一次打红多处。改之前先读规格 §4.1。
 */

/** 相册入口的形态。`"file-input"`：页面里那个可见的 `<input type=file>` 就是入口；`"native-picker"`：由按钮唤出。 */
export type ImagePickingKind = "file-input" | "native-picker";

export interface ImagePicking {
  /** 决定 UI 渲染哪条分支。**消费者**：`views/PickPage.vue`。 */
  readonly kind: ImagePickingKind;
  /**
   * 是否支持拍照。false 时 UI **不渲染**「拍一张」入口（宁可没有入口，也不给一个点了没反应的按钮）。
   * **消费者**：`views/PickPage.vue`。
   */
  readonly canCapture: boolean;
  /**
   * 取一张图；用户取消返回 `null`（取消是正常操作，不许抛错）。**非 `File` 的返回值一律抛错**。
   *
   * **消费者**：`views/PickPage.vue` 的 `native-picker` 分支。
   * **如实记录：浏览器实现下零生产消费者**——浏览器里相册入口是页面里那个可见的 input，
   * 走的是 `file-input` 分支，不会调用本方法。保留它是为了「接口固定 + 两条实现共跑契约测试」，
   * 它也正是壳存在的理由。（这条与 `AGENTS.md`「公开 API ≠ 被使用的 API」的处分口径一致：
   * 不删、不藏，把零消费者写在 JSDoc 里。）
   */
  pickFromAlbum(): Promise<File | null>;
  /**
   * 拍一张；用户取消返回 `null`。`canCapture === false` 时**抛错**（调用方不该在那种情况下调它）。
   *
   * **消费者**：`views/PickPage.vue` 的「拍一张」按钮（仅 `canCapture === true` 时渲染）。
   * **如实记录**：浏览器实现固定 `canCapture = false`，所以它在浏览器里同样零生产消费者；
   * 若 spike 判定壳里也走不通拍照，它在壳里也是零消费者——届时 `canCapture = false`、
   * 入口不存在，这一条要在构建记录里写明。
   */
  capturePhoto(): Promise<File | null>;
}

export interface ShareInbox {
  /** 是否支持「从别的 App 分享进来」。false ⇒ `composables/useShareIntake.ts` 不装配摄入链。 */
  readonly supported: boolean;
  /**
   * 冷启动那一份分享（就是启动 App 的那次 intent）。**取走即清**：再次调用返回 `null`。
   * 为什么必须清：摄入链有副作用（改草稿、跳路由），重复摄取会让用户莫名其妙地回到选区页。
   * **消费者**：`composables/useShareIntake.ts`。
   */
  takeSharedImage(): Promise<File | null>;
  /** 热启动（App 已在运行时收到新的分享）。返回解绑函数。**消费者**：`composables/useShareIntake.ts`。 */
  onSharedImage(handler: (file: File) => void): () => void;
}

/** 保存落点：浏览器 = 下载到默认下载目录；壳 = 系统相册。 */
export type AlbumSaveKind = "download" | "album";

export interface AlbumSaver {
  /** 决定成功提示文案。**消费者**：`components/editor/ExportPanel.vue`。 */
  readonly kind: AlbumSaveKind;
  /**
   * 保存一张产物。**失败必须抛**（不静默——用户会以为自己存过了）。
   * **消费者**：`components/editor/ExportPanel.vue`（每个产物的「保存」）。
   */
  save(blob: Blob, filename: string): Promise<void>;
}

export interface AppLifecycle {
  /**
   * 退出 / 关闭请求。handler 返回 `true` = 阻止这次退出。返回解绑函数。
   *
   * **消费者**：`composables/useShellLifecycle.ts`。
   * **浏览器实现是刻意的 no-op**：浏览器阶段的退出拦截由 `views/EditorPage.vue` 自己的
   * `beforeunload` 承担，本层不接管（接管就要把那段逻辑搬进 `browserPlatform`，而
   * 「既有断言一行不改」是本轮的硬约束）。代价：桌面 Tauri 下会有两次 `preventDefault`，
   * 行为与今天等价（规格 §5.5.3）。
   */
  onExitRequested(handler: () => boolean): () => void;
  /**
   * Android 返回键。返回解绑函数。**消费者**：`composables/useShellLifecycle.ts`。
   * 浏览器实现是刻意的 no-op（没有返回键这个概念）。
   */
  onBackButton(handler: (info: { readonly canGoBack: boolean }) => void): () => void;
  /** 明确退出 App。浏览器实现是刻意的 no-op。**消费者**：`composables/useShellLifecycle.ts`。 */
  exit(): Promise<void>;
}

export interface Platform {
  readonly imagePicking: ImagePicking;
  readonly shareInbox: ShareInbox;
  readonly album: AlbumSaver;
  readonly lifecycle: AppLifecycle;
}
```

- [ ] **步骤 2：写守卫的失败测试**

`src/services/platform/__tests__/guards.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { requireSavableBlob } from "../guards";

/**
 * 守卫的直接用例。
 *
 * 为什么不把它们放进 `platformContract.ts`：契约测试是**按实现各跑一遍**的，而守卫是纯函数、
 * 与实现无关；放进去会让同一条纯函数断言跑两遍，还会把「消息逐字」与「实现语义」两件事混在一起。
 *
 * 两条消息逐字沿用 `services/exporter.ts` 里 `downloadBlob` 原有的那两条——本任务把它们
 * 收敛到一处，**消息一个字都不许改**（既有 `exporter.test.ts` 读的就是这两句）。
 */
describe("requireSavableBlob", () => {
  it("空 blob 响亮失败", () => {
    expect(() => requireSavableBlob(new Blob([]), "a.png")).toThrowError(
      "导出内容为空（blob 大小为 0）",
    );
  });

  it("不是 Blob 的输入有自己的消息（不谎称「blob 大小为 0」）", () => {
    expect(() => requireSavableBlob({ size: 12 }, "a.png")).toThrowError("导出内容必须是 Blob");
    expect(() => requireSavableBlob(null, "a.png")).toThrowError("导出内容必须是 Blob");
  });

  it("空白文件名响亮失败", () => {
    expect(() => requireSavableBlob(new Blob([new Uint8Array([1])]), "   ")).toThrowError(
      "文件名不能为空",
    );
  });

  it("非字符串文件名有自己的消息（过去是裸 TypeError）", () => {
    expect(() => requireSavableBlob(new Blob([new Uint8Array([1])]), 42)).toThrowError(
      "文件名必须是字符串",
    );
  });

  it("合法入参返回 trim 后的文件名与同一个 blob 对象", () => {
    const blob = new Blob([new Uint8Array([1, 2])]);
    const safe = requireSavableBlob(blob, "  小猫-施工图.png  ");
    expect(safe.blob).toBe(blob);
    expect(safe.filename).toBe("小猫-施工图.png");
  });
});
```

运行：`npx vitest run src/services/platform/__tests__/guards.test.ts`
预期：FAIL —— `Cannot find module '../guards'`（或 `requireSavableBlob is not a function`）。

- [ ] **步骤 3：写 `guards.ts` 让它通过**

`src/services/platform/guards.ts`：

```ts
/** 已通过守卫的可保存内容。 */
export interface SavableBlob {
  readonly blob: Blob;
  /** **已 trim**：调用方拿它去建文件名，不要再自己 trim 一次。 */
  readonly filename: string;
}

/**
 * 「能不能存」的唯一判据：blob 必须是有内容的 `Blob`，文件名 trim 后非空。返回窄化后的入参。
 *
 * **为什么收敛到一处**（规格 §3.1）：浏览器实现（下载）与壳实现（相册）都要判这两件事；
 * 各写一份必然漂移，而这里是**唯一**会在失败时告诉用户「为什么没存下」的地方。
 * `services/exporter.ts` 的 `downloadBlob` 改成调用它，**两条消息逐字不变**。
 *
 * **为什么有四条消息而不是两条**（2026-10-06 由片段起草者提出、控制者裁定采纳）：入参是
 * `unknown`，而「不是 Blob」「不是字符串」都真的能从 JS / JSON / 强转进来。若把它们并进
 * 「导出内容为空」/「文件名不能为空」，消息就**与事实不符**——本项目为此记过多次账
 * （B4 账本里「消息不实」是出现最多的 minor 类）。四条消息与 `normalizeProjectName` 的
 * 「工程名称必须是字符串」同一口径；**判序固定：先内容、后文件名**。
 *
 * 校验写在**任何写操作之前**（`AGENTS.md` 入口校验）。
 */
export function requireSavableBlob(blob: unknown, filename: unknown): SavableBlob {
  if (!(blob instanceof Blob)) {
    throw new Error("导出内容必须是 Blob");
  }
  if (blob.size === 0) {
    throw new Error("导出内容为空（blob 大小为 0）");
  }
  if (typeof filename !== "string") {
    throw new Error("文件名必须是字符串");
  }
  if (filename.trim() === "") {
    throw new Error("文件名不能为空");
  }
  return { blob, filename: filename.trim() };
}
```

运行：`npx vitest run src/services/platform/__tests__/guards.test.ts`
预期：5 passed。

- [ ] **步骤 4：把 `downloadBlob` 的两条守卫收敛过来（消息逐字不变）**

改 `src/services/exporter.ts`：在文件顶部加

```ts
import { requireSavableBlob } from "./platform/guards";
```

把 `downloadBlob` 开头的两条 `if`（原文是 `if (blob.size === 0) throw new Error("导出内容为空（blob 大小为 0）");` 与
`const safeName = filename.trim(); if (safeName === "") throw new Error("文件名不能为空");`）**整段**换成：

```ts
  // 两条守卫收敛到 `services/platform/guards.ts` 的 `requireSavableBlob`（规格 §3.1）：
  // 壳里的相册实现要判同样两件事，各写一份必然漂移。**消息逐字未变**，既有用例读的就是它们。
  const safe = requireSavableBlob(blob, filename);
```

函数体里后续对 `blob` / `safeName` 的引用改成 `safe.blob` / `safe.filename`（`link.download = safe.filename;`，
`URL.createObjectURL(safe.blob)`，`setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)` 里的 `url` 不变）。

运行：`npx vitest run src/services/__tests__/exporter.test.ts`
预期：**30 passed**（与改动前逐字相同）。**这一跑就是「既有断言一行未改」的证据**：如果它不是 30 passed，先停下查清楚，不要改那份测试。

> **2026-10-06 控制者实测更正（写计划时抄错了数字）**：本节原先写「预期 29 passed」，是从 B4 账本
> **任务 3 完成时**那条记录（`- 交付：… __tests__/exporter.test.ts（29 用例）`）抄来的；B4 收尾的
> **修复波**后来又往这个文件加了 1 条，最终是 **30**。控制者自己跑 `npx vitest run src/services/__tests__/exporter.test.ts`
> 得 `Test Files 1 passed / Tests 30 passed`，并用 `git log 8b4fa6c..HEAD -- src/services/__tests__/exporter.test.ts`
> 确认该文件在本轮**一次都没被改**（0 条提交）⇒ **30 是文件真值、29 是过期读数**。
> **教训**：跨轮抄数字必须回原始清单重数——B4 账本里记 29 的那一行是**当时的证据**，不是最终值
> （README 自己写过「978 与 987 两代读数，那是当时的证据，保留不改」）。

- [ ] **步骤 5：写 `capabilities.ts` 的失败测试**

`src/services/platform/__tests__/capabilities.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPlatform } from "../browserPlatform";
import { getPlatform, isTauriRuntime, setPlatform } from "../capabilities";
import type { Platform } from "../types";

/** 一个最小的假实现，用来验证注入真的换了实现。 */
function fakePlatform(): Platform {
  return {
    imagePicking: {
      kind: "native-picker",
      canCapture: true,
      pickFromAlbum: async () => null,
      capturePhoto: async () => null,
    },
    shareInbox: { supported: true, takeSharedImage: async () => null, onSharedImage: () => () => undefined },
    album: { kind: "album", save: async () => undefined },
    lifecycle: {
      onExitRequested: () => () => undefined,
      onBackButton: () => () => undefined,
      exit: async () => undefined,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setPlatform(browserPlatform);
});

describe("capabilities", () => {
  it("未注入时就是浏览器实现（不是抛错）", () => {
    expect(getPlatform()).toBe(browserPlatform);
    expect(getPlatform().album.kind).toBe("download");
  });

  it("setPlatform 之后 getPlatform 返回新实现", () => {
    const fake = fakePlatform();
    setPlatform(fake);
    expect(getPlatform()).toBe(fake);
    expect(getPlatform().imagePicking.kind).toBe("native-picker");
  });

  it("setPlatform 收到非对象时响亮失败（不静默把实现置成 undefined）", () => {
    expect(() => setPlatform(undefined as unknown as Platform)).toThrowError("平台实现必须是对象");
    expect(() => setPlatform(null as unknown as Platform)).toThrowError("平台实现必须是对象");
  });

  it("isTauriRuntime：全局缺失 / false / true 三态，且只认布尔 true", () => {
    expect(isTauriRuntime()).toBe(false); // 缺失
    vi.stubGlobal("isTauri", false);
    expect(isTauriRuntime()).toBe(false);
    vi.stubGlobal("isTauri", "yes");
    expect(isTauriRuntime()).toBe(false); // 只认布尔 true，不认真值
    vi.stubGlobal("isTauri", true);
    expect(isTauriRuntime()).toBe(true);
  });
});
```

运行：`npx vitest run src/services/platform/__tests__/capabilities.test.ts`
预期：FAIL —— `Cannot find module '../capabilities'`。

- [ ] **步骤 6：写 `capabilities.ts`**

`src/services/platform/capabilities.ts`：

```ts
import { browserPlatform } from "./browserPlatform";
import type { Platform } from "./types";

/**
 * 当前平台实现。**初始值就是浏览器实现**，永远不为 `null`。
 *
 * **与 `services/projectStore.ts` 的刻意差异**：那里未注入时抛错（它需要一个真的异步后端，
 * 静默返回假实现会产出错误结果）；这里未注入时返回浏览器实现——因为那个实现**没有依赖、
 * 没有副作用、在 happy-dom 里真的能跑**，它就是这个仓库在浏览器里的真实行为。
 * 收益是**既有组件用例一行都不用改**：`ExportPanel.test.ts` 打桩的是 `@/services/exporter`，
 * 而 `browserPlatform` 的 `save` 正是 import 那个模块的 `downloadBlob`，桩照样命中。
 */
let current: Platform = browserPlatform;

/**
 * 是否运行在 Tauri 壳里。
 *
 * **全仓唯一读 `isTauri` 的地方**（机检 = `src/__tests__/platformGate.test.ts` 的 G2）：
 * 散开之后，某个 happy-dom 用例会莫名其妙地去碰 Tauri 的全局对象，而它在 CI 里是绿是红
 * 取决于执行顺序——那是最难查的一类失败。
 *
 * **为什么不 import `@tauri-apps/api/core` 的 `isTauri()`**：那会让本文件在 `npm run test`
 * 的收集阶段就去 import Tauri 的包（`AGENTS.md` 的 G1 也禁止）。Tauri 自己设的是
 * `globalThis.isTauri = true`，读它就够了。**只认布尔 `true`**：`"yes"` 之类的真值不算。
 */
export function isTauriRuntime(): boolean {
  return (globalThis as { isTauri?: unknown }).isTauri === true;
}

/**
 * 注入平台实现。`main.ts` 在挂载前调用一次。
 *
 * **校验入参**：`setPlatform(undefined)` 会把实现置成 `undefined`，之后每一个
 * `getPlatform().album.save(...)` 都落成裸 `TypeError`——那是没有契约口径的失败。
 */
export function setPlatform(platform: Platform): void {
  if (typeof platform !== "object" || platform === null) {
    throw new Error("平台实现必须是对象");
  }
  current = platform;
}

/** 取当前实现。**不会抛**：未注入时是浏览器实现（见 `current` 的 JSDoc）。 */
export function getPlatform(): Platform {
  return current;
}
```

运行：`npx vitest run src/services/platform/__tests__/capabilities.test.ts`
预期：4 passed。

- [ ] **步骤 7：写契约测试与浏览器实现的失败测试**

`src/services/platform/__tests__/platformContract.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Platform } from "../types";

/**
 * 两条实现共用的契约用例。
 *
 * **为什么共用一份**：`AGENTS.md` 的分层纪律要求「在 core 定义接口，在 services 注入实现」，
 * 而两份实现的语义必须一致——一致性只有一份会红的用例能守住。
 * 先例：`services/__tests__/projectStoreContract.ts`（内存 / IndexedDB 两个实现共用 27 条）。
 *
 * **本文件不是 `.test.ts`**，所以 vitest 不会把它当用例文件收集；它由
 * `browserPlatform.test.ts` 与 `tauriPlatform.test.ts` 各自调用一次。
 * （先例：`projectStoreContract.ts` 证明非 `.test.ts` 的辅助文件确实不会被收集。）
 *
 * **驱动方式由 harness 提供**，因为两条实现的「怎么让它取消 / 怎么观察它存了什么」不同：
 * 浏览器是隐藏 input + `downloadBlob` 桩，壳是假驱动的可编程返回值。
 */
export interface PlatformHarness {
  readonly platform: Platform;
  /**
   * 让正在等待的 `pickFromAlbum()` 立刻结束：`file` = 选中，`null` = 用户取消。
   * 调用时若没有等待中的选择器，实现应抛错（而不是静默什么都不做）。
   */
  finishPick(file: File | null): void;
  /** 同上，用于 `capturePhoto()`；`canCapture === false` 的实现可以抛错（契约不会调它）。 */
  finishCapture(file: File | null): void;
  /** 成功保存时收到的实参。**守卫拦下的那两次调用不许出现在这里**（这是顺序证明）。 */
  readonly saves: { readonly blob: Blob; readonly filename: string }[];
}

export function runPlatformContract(label: string, makeHarness: () => PlatformHarness): void {
  describe(`平台能力契约：${label}`, () => {
    it("save：空 blob 响亮失败，且没有任何副作用", async () => {
      const h = makeHarness();
      await expect(h.platform.album.save(new Blob([]), "a.png")).rejects.toThrowError(
        "导出内容为空（blob 大小为 0）",
      );
      expect(h.saves).toHaveLength(0);
    });

    it("save：空白文件名响亮失败，且没有任何副作用", async () => {
      const h = makeHarness();
      const blob = new Blob([new Uint8Array([1, 2, 3])]);
      await expect(h.platform.album.save(blob, "   ")).rejects.toThrowError("文件名不能为空");
      expect(h.saves).toHaveLength(0);
    });

    it("save：合法入参把同一个 blob 与 trim 后的文件名交给落点", async () => {
      const h = makeHarness();
      const blob = new Blob([new Uint8Array([1, 2, 3])]);
      await h.platform.album.save(blob, "  小猫-分享图.png \n");
      expect(h.saves).toHaveLength(1);
      expect(h.saves[0]?.blob).toBe(blob);
      expect(h.saves[0]?.filename).toBe("小猫-分享图.png");
    });

    it("pickFromAlbum：取消返回 null（不是抛错）", async () => {
      const h = makeHarness();
      const pending = h.platform.imagePicking.pickFromAlbum();
      h.finishPick(null);
      await expect(pending).resolves.toBeNull();
    });

    it("pickFromAlbum：选中时返回同一个 File 对象", async () => {
      const h = makeHarness();
      const file = new File([new Uint8Array([1])], "小猫.png", { type: "image/png" });
      const pending = h.platform.imagePicking.pickFromAlbum();
      h.finishPick(file);
      await expect(pending).resolves.toBe(file);
    });

    it("takeSharedImage：取走即清，第二次返回 null", async () => {
      const h = makeHarness();
      const first = await h.platform.shareInbox.takeSharedImage();
      const second = await h.platform.shareInbox.takeSharedImage();
      expect(second).toBeNull();
      if (h.platform.shareInbox.supported) {
        expect(first).not.toBeNull();
      } else {
        expect(first).toBeNull();
      }
    });

    it("capturePhoto：canCapture 为假时必须响亮失败（而不是静默返回 null）", async () => {
      const h = makeHarness();
      if (h.platform.imagePicking.canCapture) return;
      await expect(h.platform.imagePicking.capturePhoto()).rejects.toThrowError(
        "本平台不支持拍照",
      );
    });

    it("解绑函数可调用且不抛；exit() 不抛", async () => {
      const h = makeHarness();
      const offExit = h.platform.lifecycle.onExitRequested(() => true);
      const offBack = h.platform.lifecycle.onBackButton(() => undefined);
      expect(() => offExit()).not.toThrow();
      expect(() => offBack()).not.toThrow();
      await expect(h.platform.lifecycle.exit()).resolves.toBeUndefined();
    });
  });
}
```

`src/services/platform/__tests__/browserPlatform.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPlatform } from "../browserPlatform";
import { runPlatformContract, type PlatformHarness } from "./platformContract";

/**
 * 浏览器实现的用例 = 共用契约 + 它自己的两件事（`kind` / `canCapture` 的取值，以及
 * 「隐藏 input 真的挂进了 DOM、用完被摘掉」）。
 *
 * `downloadBlob` 用 `vi.mock` 换掉：`browserPlatform` 的 `save` 就是调它，
 * 而这里要观察的正是「存了哪颗 blob、用了什么文件名」。
 * **注意 `vi.mock` 的路径是相对本文件解析的**（`__tests__/` → `src/services/exporter`），
 * 写成 `"../exporter"` 会解到 `src/services/platform/exporter` 这个不存在的位置。
 */
const exporterSpy = vi.hoisted(() => ({ downloadBlob: vi.fn() }));

vi.mock("../../exporter", () => ({ downloadBlob: exporterSpy.downloadBlob }));

function makeHarness(): PlatformHarness {
  const saves: { blob: Blob; filename: string }[] = [];
  exporterSpy.downloadBlob.mockImplementation((blob: Blob, filename: string) => {
    saves.push({ blob, filename });
  });
  return {
    platform: browserPlatform,
    saves,
    finishPick(file) {
      const input = document.body.querySelector<HTMLInputElement>("input[type=file]");
      if (input === null) throw new Error("没有等待中的文件输入");
      if (file === null) {
        input.dispatchEvent(new Event("cancel"));
        return;
      }
      const list = new FileList() as unknown as File[];
      list.push(file);
      input.files = list as unknown as FileList;
      input.dispatchEvent(new Event("change"));
    },
    finishCapture() {
      throw new Error("浏览器实现不支持拍照，契约不该调到这一支");
    },
  };
}

afterEach(() => {
  exporterSpy.downloadBlob.mockReset();
  document.body.innerHTML = "";
});

runPlatformContract("浏览器实现", makeHarness);

describe("浏览器实现的取值与 DOM 卫生", () => {
  it("kind / canCapture / shareInbox.supported 的取值就是浏览器事实", () => {
    expect(browserPlatform.imagePicking.kind).toBe("file-input");
    expect(browserPlatform.imagePicking.canCapture).toBe(false);
    expect(browserPlatform.shareInbox.supported).toBe(false);
    expect(browserPlatform.album.kind).toBe("download");
  });

  it("选图会把隐藏 input 挂进 DOM，结束（取消）之后把它摘掉", async () => {
    const h = makeHarness();
    const pending = browserPlatform.imagePicking.pickFromAlbum();
    const input = document.body.querySelector<HTMLInputElement>("input[type=file]");
    expect(input).not.toBeNull();
    expect(input?.accept).toBe("image/*");
    h.finishPick(null);
    await pending;
    expect(document.body.querySelector("input[type=file]")).toBeNull();
  });

  it("`files[0]` 不是 File 对象 ⇒ reject 契约消息，且节点照样被摘掉", async () => {
    // 这条用例不经过 harness 的 `finishPick`：它要造的是一个**契约违反**（列表里有东西但不是 File），
    // 而 harness 的签名只接受 `File | null`。
    const pending = browserPlatform.imagePicking.pickFromAlbum();
    const input = document.body.querySelector<HTMLInputElement>("input[type=file]");
    expect(input).not.toBeNull();
    const list = new FileList() as unknown as unknown[];
    list.push({ 不是文件: true });
    input!.files = list as unknown as FileList;
    input!.dispatchEvent(new Event("change"));

    await expect(pending).rejects.toThrowError("图片选择器返回了非文件对象");
    expect(input!.parentNode).toBeNull();
  });

  it("本层**不接管** beforeunload（规格 §5.5.3）：注册两个生命周期回调时窗口上一条监听都不加", () => {
    const add = vi.spyOn(window, "addEventListener");

    browserPlatform.lifecycle.onExitRequested(() => true);
    browserPlatform.lifecycle.onBackButton(() => undefined);

    expect(add.mock.calls).toEqual([]);
  });
});
```

运行：`npx vitest run src/services/platform/__tests__/browserPlatform.test.ts`
预期：FAIL —— `Cannot find module '../browserPlatform'`。

- [ ] **步骤 8：写 `browserPlatform.ts`**

`src/services/platform/browserPlatform.ts`：

```ts
import { downloadBlob } from "../exporter";
import { requireSavableBlob } from "./guards";
import type { AlbumSaver, AppLifecycle, ImagePicking, Platform, ShareInbox } from "./types";

/** 解绑函数：什么都没注册，所以解绑也什么都不做——但**必须真的可调用**（装配方无条件调用它）。 */
const NOOP_UNBIND = (): void => undefined;

/** 两条消息各只写一次，并注明它们是与壳实现共用的契约面（`types.ts` / 规格 §4.4）。 */
const CAPTURE_UNSUPPORTED_MESSAGE = "本平台不支持拍照";
const PICKER_NOT_A_FILE_MESSAGE = "图片选择器返回了非文件对象";

const imagePicking: ImagePicking = {
  kind: "file-input",
  canCapture: false,
  /**
   * 程序化选图：建一个隐藏 `<input type=file>` → 挂进 `document.body` → `click()` → 等 `change` 或 `cancel`。
   *
   * **为什么挂进 DOM 又要摘掉**：未挂载的 file input 在部分 WebKit 版本上调 `click()` 不唤起选择器；
   * 挂进去就必须在**三条结算路径**（选中 / 取消 / 非 File）上都摘掉节点，否则每点一次就往 `body`
   * 里留一个隐藏 input。所以 `cleanup` 只有一处，三条路径都经它。
   *
   * **取消 `null` / 契约违反抛错**：`change` 到达但列表为空 ⇒ 按取消（用户清空选择本来就是取消）；
   * 拿回来的**不是 `File` 对象** ⇒ 响亮失败（静默当取消等于把契约违反伪装成用户行为）。
   *
   * **只监听 `cancel`、不用 `focus` 兜底**：`focus` 会在「用户选了文件但耗时较长」时先触发，把成功
   * 误判成取消。代价是老浏览器上取消后这颗 promise 不结算——而它唯一的消费者是壳里的按钮。
   */
  pickFromAlbum(): Promise<File | null> {
    return new Promise<File | null>((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.style.display = "none";

      let settled = false;
      const cleanup = (): void => {
        input.removeEventListener("change", onChange);
        input.removeEventListener("cancel", onCancel);
        input.remove();
      };
      const finish = (file: File | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(file);
      };
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(message));
      };
      const onChange = (): void => {
        const picked: unknown = input.files?.[0] ?? null;
        if (picked === null) {
          // 老浏览器上「没选任何文件就关掉」会以 `change` + 空 FileList 到达 ⇒ **按取消处理**：
          // 用户清空选择本来就是取消，判成失败会给他弹一条看不懂的红条。
          finish(null);
          return;
        }
        if (!(picked instanceof File)) {
          // 而「拿回来的不是 File」是**契约违反**，必须响亮失败（不许静默当取消）。
          fail(PICKER_NOT_A_FILE_MESSAGE);
          return;
        }
        finish(picked);
      };
      const onCancel = (): void => {
        finish(null);
      };

      input.addEventListener("change", onChange);
      input.addEventListener("cancel", onCancel);
      document.body.append(input);
      input.click();
    });
  },
  /**
   * 浏览器实现恒不支持拍照（规格 §5.2 第 3 级）。**响亮失败而不是返回 `null`**：静默返回 `null`
   * 会被读成「用户取消了」。消费者是壳里的「拍一张」按钮（仅 `canCapture === true` 时渲染）。
   */
  capturePhoto: () => Promise.reject(new Error(CAPTURE_UNSUPPORTED_MESSAGE)),
};

const shareInbox: ShareInbox = {
  supported: false,
  takeSharedImage: () => Promise.resolve(null),
  onSharedImage: () => NOOP_UNBIND,
};

const album: AlbumSaver = {
  kind: "download",
  async save(blob, filename) {
    // 守卫先于任何副作用：`downloadBlob` 内部也会调同一个 `requireSavableBlob`，
    // 这里再调一次是为了让「校验在任何写操作之前」在**本层**也成立（`AGENTS.md`）。
    const safe = requireSavableBlob(blob, filename);
    downloadBlob(safe.blob, safe.filename);
  },
};

const lifecycle: AppLifecycle = {
  onExitRequested: () => NOOP_UNBIND,
  onBackButton: () => NOOP_UNBIND,
  exit: () => Promise.resolve(),
};

/**
 * 浏览器实现（默认实现）。**它就是今天的行为**，一个字节都没改：
 * 相册入口仍是页面里那个可见的 `<input type=file>`（`kind = "file-input"`），
 * 保存仍是 `downloadBlob`，退出拦截仍由 `EditorPage.vue` 的 `beforeunload` 承担。
 */
export const browserPlatform: Platform = { imagePicking, shareInbox, album, lifecycle };
```

运行：`npx vitest run src/services/platform/__tests__/browserPlatform.test.ts`
预期：**10 passed**（8 条契约 + 2 条浏览器自身）。

- [ ] **步骤 9：`main.ts` 挂载前注入**

在 `src/main.ts` 顶部加：

```ts
import { browserPlatform } from "./services/platform/browserPlatform";
import { setPlatform } from "./services/platform/capabilities";
```

在 `bootstrap()` 里 `setProjectStore(...)` 之后、`createApp(...).mount("#app")` **之前**加：

```ts
  // 平台能力层：未注入时 `getPlatform()` 就是这个浏览器实现（`capabilities.ts` 的默认值），
  // 这里显式注入一次是为了让「注入早于挂载」成为结构事实（机检 = platformGate 的 G3）。
  // 任务 2 会把它换成 `isTauriRuntime() ? createTauriPlatform() : browserPlatform`。
  setPlatform(browserPlatform);
```

运行：

```powershell
npm run test
npm run build
```

预期：`npm run test` = **65 文件 / 1158 用例**（基线 62/1137 + 本任务的 3 个新测试文件 / 21 条：guards 5 + capabilities 4 + 契约 8 + 浏览器自身 4；`platformContract.ts` 不以 `.test.ts` 结尾，**不计入文件数**；**以实跑数字为准**），**全绿**；`npm run build` 通过。

- [ ] **步骤 10：变异实测（红数回填，不许预估）**

在**已提交**的树上逐条做（B4 的 R-12），每条都要先自证「替换真的发生了」，做完还原并确认 `git diff` 为空：

| ID | 改哪一行 | 期望哪条用例红 |
|---|---|---|
| M6 | `guards.ts` 删掉 `|| blob.size === 0` 那半条 | `guards.test.ts` 的「空 blob 响亮失败」+ 契约里每个实现的同名用例 |
| M10 | `browserPlatform.ts` 的 `finish(null)` 改成 `finish(new File([], "x"))`（把取消当选中） | 契约的「取消返回 null」 |
| M15 | `capabilities.ts` 的 `=== true` 改成真值判断（`Boolean(...)`） | `capabilities.test.ts` 的 `"yes"` 那一档 |

把三条的**实测红数**填回本步骤下方（实现者填，控制者独立复跑）：

```
M6 → ? 红    M10 → ? 红    M15 → ? 红
```

- [ ] **步骤 11：把起草片段里被我否掉的两条口径写进报告（供审查者对照）**

本任务的片段由子代理起草，控制者逐条裁定过。**四条裁定，其中两条否掉了起草者的写法**，实现者按本计划正文（已按裁定改过）执行，并把下面这段原样附到报告里：

1. **采纳**：`requireSavableBlob` 用**四条**消息（+`导出内容必须是 Blob` / `文件名必须是字符串`），不是只有两条。理由：入参是 `unknown`，把「不是 Blob」并进「blob 大小为 0」会让消息与事实不符。规格 §4.4 已同步登记。
2. **否掉**：起草者想在 `capabilities.test.ts` 里塞一份**文本扫描**作为「G2 闸门在本任务内可执行的那一半」，好让变异 M13 在本任务里能跑。**不采纳**——那会造出第二份 G2（真闸门在任务 1 的 `platformGate.test.ts`），而本项目对「两处判同一件事」的后果有明确记账（迟早一处改一处不改）。**M13 因此不在本任务的变异表里，它排在任务 1**（那里闸门已存在）。
3. **采纳（形态不同）**：契约测试的驱动方式由 harness 提供，但**用单一工厂参数**（`runPlatformContract(label, makeHarness)`），不是起草者的三参形态（`label, createPlatform, control`）。理由：`saves`（观察）与 `finishPick`（驱动）都随同一次构造产生，拆成两个参数会让「观察到的 saves 与正在驱动的平台**不是同一份**」这种错配在类型上可表达。
4. **更正（我读错了）**：我在派发摘要里把起草者写成「`change` 无文件时走 reject」。**核对其逐字代码后不成立**——它的 `onChange` 是 `files?.[0] ?? null`，空列表走 `finish(null)`（取消），只有拿回来的**不是 `File` 对象**时才 reject。这与我的裁定一致，**不是分歧**；此处如实更正我自己的误读（本项目对控制者的错也记账）。
5. **采纳**：`change` 带回来的东西必须过一道 `instanceof File` —— **理由是真的**：`input.files[0]` 在运行期可以是别的东西（本计划的浏览器用例就能造出来），不过这道检查就会 resolve 一个非 `File`，**静默违反契约**。同时采纳它的两个消息常量（`CAPTURE_UNSUPPORTED_MESSAGE` / `PICKER_NOT_A_FILE_MESSAGE`），让「同一条消息在实现里只出现一次」。
6. **采纳**：浏览器实现必须**不监听 `beforeunload`**（规格 §5.5.3），并为此单开一条用例（`vi.spyOn(window, "addEventListener")` 的调用表为空）——否则「本层不接管」这句 JSDoc 没有任何断言守着。

- [ ] **步骤 12：Commit**

```powershell
git add src/services/platform src/services/exporter.ts src/main.ts
git commit -m "feat(services): 平台能力层（四能力接口 / 共用守卫 / 浏览器实现 / 契约测试）"
```

---



### 任务 1：壳骨架（src-tauri 最小工程 + 图标 + Android 工程 + CI 门禁 + 四条闸门）

**交付物**：一个能构建、能装到手机上的最小壳（首屏就是现有图纸库），`gen/android` 已入库，CI 多一个 `rust-check` job，四条闸门落地（其中 **G1 / G3b / G4 是故意红**，写明转绿时点）。

**文件：**
- 创建：`src-tauri/Cargo.toml`、`src-tauri/build.rs`、`src-tauri/src/main.rs`、`src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json`、`scripts/make-app-icon.mjs`、`src/__tests__/platformGate.test.ts`
- 由 CLI 生成（入库）：`src-tauri/icons/**`、`src-tauri/gen/android/**`
- 修改：`package.json`（devDependency `@tauri-apps/cli`）、`.gitignore`（**注意它的 `src-tauri/gen/` 是模板遗留，要改**）、`.github/workflows/ci.yml`、`src-tauri/gen/android/app/src/main/res/values/strings.xml`
  （**不碰 `src/main.ts`**：挂载前注入已在任务 0 完成；本任务只把它**读**进闸门 G3 / G3b）

- [ ] **步骤 1：装 Tauri CLI 并确认版本**

运行：

```powershell
npm install --save-dev "@tauri-apps/cli@^2"
npx tauri --version
```

预期：装完 `package.json` 多出 `@tauri-apps/cli`，`npx tauri --version` 打印 `tauri-cli 2.12.x`。
（`AGENTS.md` 记的 npm arborist bug 只在**没有 lockfile** 的干净环境里触发；本仓 `package-lock.json` 在库，直接 `npm install` 即可。**不要**加 `.npmrc`。）

- [ ] **步骤 2：写 Rust 工程的最小四件套**

`src-tauri/Cargo.toml`：

```toml
[package]
name = "weefuse"
version = "0.1.0"
description = "一起拼豆 WeeFuse"
edition = "2021"
rust-version = "1.77"

[lib]
# 官方模板口径：移动端把 App 编译成库、由平台框架加载，所以入口在 lib 里，main.rs 只转发。
name = "weefuse_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`src-tauri/build.rs`：

```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/src/main.rs`：

```rust
// Windows 上 release 构建不弹控制台窗口；调试构建保留控制台，真机日志靠它。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    weefuse_lib::run()
}
```

`src-tauri/src/lib.rs`（本任务的最小形态；命令与插件在任务 2 才加）：

```rust
/// 应用入口。桌面端由 `main.rs` 调用，移动端由 `#[tauri::mobile_entry_point]` 生成的胶水调用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running weefuse");
}
```

运行：`cargo check --manifest-path src-tauri/Cargo.toml`
预期：通过（首次会拉取 crates.io 依赖，可能几分钟）。**注意：此时 `tauri.conf.json` 还不存在，`generate_context!` 会编译失败** —— 所以本步骤只写 `Cargo.toml` / `build.rs` / `main.rs`，`lib.rs` 留到步骤 3 之后再 `cargo check`。正确的顺序是：步骤 3 写好配置，再一起 `cargo check`。

- [ ] **步骤 3：写 `tauri.conf.json`**

`src-tauri/tauri.conf.json`：

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "WeeFuse",
  "version": "0.1.0",
  "identifier": "cn.tuzkimo.weefuse",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "一起拼豆",
        "width": 1280,
        "height": 900,
        "resizable": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "android": {
      "minSdkVersion": 29
    },
    "fileAssociations": [
      { "ext": ["png"], "mimeType": "image/png" },
      { "ext": ["jpg", "jpeg"], "mimeType": "image/jpeg" },
      { "ext": ["webp"], "mimeType": "image/webp" }
    ]
  }
}
```

逐项理由见规格 §6.1。**三条不许改的**：`identifier`（裁决 5）、`minSdkVersion: 29`（D4）、`fileAssociations` 的三条与**不写** `androidIntentActionFilters`（默认即含 `Send`）。

`src-tauri/capabilities/default.json`：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "本轮只放真正用到的权限：应用自己的命令不需要 capability，插件命令才需要。",
  "windows": ["main"],
  "permissions": ["core:default"]
}
```

- [ ] **步骤 4：`cargo check` 通过**

运行：`cargo check --manifest-path src-tauri/Cargo.toml`
预期：`Finished` / exit 0。

- [ ] **步骤 5：写图标生成脚本（零依赖）**

`scripts/make-app-icon.mjs`：

```js
// 生成 1024×1024 的 App 图标源 PNG，零依赖（只用 node:zlib 与 node:fs）。
//
// 为什么要手写 PNG：`npx tauri icon` 需要一个 ≥1024² 的源图，而本仓没有任何图标资源；
// 为一个图标引入图像处理依赖不值得（`AGENTS.md`：不为了这件事加依赖）。PNG 的最小形态
// 很规整——签名 + IHDR + IDAT(zlib) + IEND，CRC32 与 zlib 都由 Node 标准库给出。
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
const BEADS = 6; // 6×6 颗豆，像一张「拼了一半的图纸」
const MARGIN = 112;
const GAP = 10;

// 装饰用的六个颜色（不取自任何色卡口径，纯图形）
const COLORS = [
  [0x1e, 0x29, 0x3b],
  [0xef, 0x44, 0x44],
  [0xf5, 0x9e, 0x0b],
  [0x22, 0xc5, 0x5e],
  [0x3b, 0x82, 0xf6],
  [0xa8, 0x55, 0xf7],
];

const pixels = new Uint8Array(SIZE * SIZE * 4);
pixels.fill(255); // 不透明白底

const cell = Math.floor((SIZE - 2 * MARGIN - (BEADS - 1) * GAP) / BEADS);
const radius = cell / 2;

for (let row = 0; row < BEADS; row += 1) {
  for (let col = 0; col < BEADS; col += 1) {
    const index = row * BEADS + col;
    if (index % 7 === 3) continue; // 留几个空格子
    const color = COLORS[index % COLORS.length];
    const cx = MARGIN + col * (cell + GAP) + radius;
    const cy = MARGIN + row * (cell + GAP) + radius;
    for (let y = Math.max(0, Math.floor(cy - radius)); y < Math.min(SIZE, Math.ceil(cy + radius)); y += 1) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x < Math.min(SIZE, Math.ceil(cx + radius)); x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > radius * radius) continue;
        const offset = (y * SIZE + x) * 4;
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = 255;
      }
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // 位深
ihdr[9] = 6; // 颜色类型：RGBA
ihdr[10] = 0; // 压缩方法
ihdr[11] = 0; // 过滤方法
ihdr[12] = 0; // 非隔行

// 每行前面加一个过滤字节 0（None）
const stride = SIZE * 4;
const raw = Buffer.alloc(SIZE * (stride + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (stride + 1)] = 0;
  Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(new URL("../app-icon.png", import.meta.url), png);
console.log(`app-icon.png 已生成：${SIZE}×${SIZE}，${png.length} 字节`);
```

运行：

```powershell
node scripts/make-app-icon.mjs
npx tauri icon app-icon.png
```

预期：`app-icon.png` 生成（约几十 KB），`npx tauri icon` 在 `src-tauri/icons/` 下生成全套 PNG / ico / icns，并打印生成清单。
**若 `npx tauri icon` 报「input 必须是 PNG」以外的错误**：把完整报错原文记进报告，**不要**改脚本去凑——先看清它要什么。

- [ ] **步骤 6：初始化 Android 工程并留下「入库判定」的第一段证据**

运行：

```powershell
npx tauri android init
git status --short | Out-String
git status --ignored --short src-tauri/gen | Select-Object -First 20 | Out-String
```

预期：`src-tauri/gen/android/**` 被创建。
**必须记录**上面三条命令的**原始输出**。注意第二条**大概率是空的**——因为此刻 `.gitignore` 还把整个 `src-tauri/gen/` 忽略掉（模板遗留），所以第三条（`--ignored`）才看得到文件确实生成了。这一段与步骤 9 的第二段合起来，就是规格 §6.2 要的证据。

- [ ] **步骤 7：把启动器显示名改成中文，并核对 minSdk**

改 `src-tauri/gen/android/app/src/main/res/values/strings.xml` 里的 `app_name`：

```xml
<resources>
    <string name="app_name">一起拼豆</string>
    <string name="main_activity_title">一起拼豆</string>
</resources>
```

（第二条若原文件里不存在就只改第一条；**以生成出来的原文件为准**，不要凭空补 key。）

运行并记录：

```powershell
Select-String -Path src-tauri/gen/android/app/build.gradle.kts -Pattern "minSdk"
```

预期：`minSdk` 为 `29`（由 `tauri.conf.json` 的 `bundle.android.minSdkVersion` 生成）。
**若仍是 24**：说明该字段没被 CLI 采用，把 `build.gradle.kts` 的相关原文与 `tauri.conf.json` 的字段一起记进报告，**手改 `build.gradle.kts` 为 29 并在此写明这是手改**（规格 D4 的目标值不变）。

- [ ] **步骤 8：改 `.gitignore`（注意：`src-tauri/gen/` **已经被忽略**，是第一次提交从 Tauri 模板抄来的）**

现状（`git log --oneline -- .gitignore` 只有一条 `3fedef3 chore: 初始化 …工程骨架与 CI`，说明这两行是模板遗留、不是决定）：

```gitignore
src-tauri/target/
src-tauri/gen/
```

按裁决 6（`gen/android` 入库）把第二行**换掉**，得到：

```gitignore
node_modules/
dist/
dist-ssr/
*.local
.DS_Store
src-tauri/target/
# `gen/schemas` 是每次构建重新生成的 capability schema，忽略；
# `gen/android` 是 Android Studio 工程，按裁决 6 入库（app_name 等手改要能留下）。
src-tauri/gen/schemas/
src-tauri/gen/apple/
src-tauri/gen/android/**/build/
src-tauri/gen/android/.gradle/
src-tauri/gen/android/local.properties
src-tauri/gen/android/.idea/
*.apk
*.aab
*.keystore
coverage/
```

- [ ] **步骤 8b：确认 `gen/android` 已经不再被忽略**

运行并记录原始输出：

```powershell
git status --short src-tauri/gen | Select-Object -First 5 | Out-String
git status --short src-tauri/gen | Measure-Object -Line | Select-Object -ExpandProperty Lines
```

预期：出现大量 `?? src-tauri/gen/android/...`（文件数以实跑为准），**没有** `src-tauri/gen/schemas/`。
若仍是 0 行 ⇒ 说明忽略规则没改对（`git check-ignore -v src-tauri/gen/android/app/build.gradle.kts` 可定位是哪条规则命中），**先修 `.gitignore` 再往下走**。

- [ ] **步骤 9：构建 debug APK（判据 F 的机器侧）并留下第二段证据**

运行：

```powershell
npx tauri android build --apk --debug
git status --short src-tauri/gen | Select-Object -First 30 | Out-String
```

预期：构建成功，产物在 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/`（**以实际打印的路径为准**）。
**必须记录**：命令的原始输出尾巴（含 APK 路径与大小）、耗时、以及构建后 `git status` 的原始输出。**这一条只证明「本机能构建」；能不能装、装上能不能跑由任务 2 的真机步骤回答。**

- [ ] **步骤 9b：按两段证据决定「入库」还是「忽略」（规格 §6.2；不许凭印象）**

读步骤 6/8b/9 记录的原始输出，按下面的判据落一条结论，**把结论与依据的原文一起写进报告**：

- 若构建**没有**改写已生成的 `gen/android` 源文件（第二次 `git status` 里只有 `gen/android/**/build/` 下的产物，且这些已被步骤 8 的规则忽略、不出现）⇒ **维持入库**（裁决 6）。
- 若 CLI **重写了** `gen/android` 里本该受控的文件（例如 `build.gradle.kts` / `AndroidManifest.xml` / `tauri.properties`）⇒ **当场改判为忽略**：把 `.gitignore` 的第 8 步那几行换回 `src-tauri/gen/`，并在 README 写明「`npx tauri android init` 是构建前置步骤」。此时**启动器中文名的落点要跟着换**：先查 `tauri.conf.json` 有没有对应字段；没有就把名字交回 `productName`（即接受英文 `WeeFuse`），并把这条如实写进 README 的「已知限制与延后项」。

- [ ] **步骤 10：CI 加 `rust-check` job**

改 `.github/workflows/ci.yml`：**既有 `build-and-test` job 一行不动**，文件末尾追加：

```yaml
  rust-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - name: 安装 Tauri 的 Linux 前置库
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
            libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: 安装依赖
        run: npm ci

      - name: 构建前端（generate_context! 需要 dist/ 存在）
        run: npm run build

      - name: Rust 类型检查
        run: cargo check --manifest-path src-tauri/Cargo.toml
```

**这个 job 测不到什么**（写进提交信息与报告）：不构建 APK、不跑 Android target、不碰 NDK/JDK/gradle、不验证真机行为。它只回答「Rust 侧还编译得过吗」。

- [ ] **步骤 11：写四条闸门（G1 / G2 / G3 绿，G3b / G4 故意红）**

`src/__tests__/platformGate.test.ts`：

```ts
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * 平台接入的四条源码级闸门（规格 §3.2）。
 *
 * **为什么要有它们**：这类缺陷在 happy-dom 里绿不绿取决于执行顺序 —— 一旦平台判断散开，
 * 某个用例会莫名其妙地去碰 Tauri 的全局对象，而它在 CI 里是绿是红要看谁先跑。闸门的对象
 * 是**结构**，不是取值：`ExportPanel` 改回直调 `downloadBlob` 时浏览器里照样能用、照样全绿
 * （G4 的靶子正是这条）。
 *
 * 与 `coreBoundary.test.ts` / `layoutGate.test.ts` 同法：`import.meta.glob` + `?raw` 读源码文本，
 * 做**词法近似**匹配；剥注释用同一套手写状态机（照 `layoutGate.test.ts` 的实现抄，不 import 它——
 * 那个文件在 `core/render/__tests__/` 下，跨层 import 会让本闸门依赖 core 的测试辅助）。
 *
 * **已知偏差（刻意接受、不许放宽规则）**：把包名拼成 `"@tauri-apps/" + name` 能绕过 G1；
 * `globalThis["is" + "Tauri"]` 能绕过 G2。两条都要求作者**主动规避**，代价大于收益。
 * **本文件自身不在 G1 / G2 的扫描范围内**（否则它用来描述禁令的那几个字符串与正则字面量会把
 * 自己判违规）。**另一条要注意的偏差**：`stripComments` 不认识正则字面量——`/@tauri-apps\//`
 * 这种写法里的 `\//` 会被它当成行注释的开头，把该行剩余部分吞掉（方向是漏报）。
 *
 * 转绿时点（本计划分两遍写，先记在这里）：
 * - **G2 / G3：本任务即绿**；
 * - **G1：任务 2 转绿** —— 它要求「含 `@tauri-apps/` 的文件集合**恰好**是 `tauriDriver.ts`」，
 *   而那个文件任务 2 才创建；在此之前集合是空的，闸门**故意红**（不是恒真通过：它要求那个文件存在）；
 * - **G3b：任务 2 转绿**（`main.ts` 引入 `isTauriRuntime()`）；
 * - **G4：pass 2 的「保存到相册」任务转绿**（面板改走 `album.save`）。
 */
const SOURCES: Record<string, string> = import.meta.glob<string>("../**/*.{ts,vue}", {
  eager: true,
  query: "?raw",
  import: "default",
});

const GATE_FILE = "../__tests__/platformGate.test.ts";
const DRIVER_FILE = "../services/platform/tauriDriver.ts";
const CAPABILITIES_FILE = "../services/platform/capabilities.ts";
const MAIN_FILE = "../main.ts";
const PANEL_FILE = "../components/editor/ExportPanel.vue";

/** 剥离注释（保留换行与字符串内容）。 */
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
      while (index < source.length && source[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 2;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

/** 再剥掉字符串**内容**（保留引号）。用于「不许出现某个标识符」这类检查。 */
function stripStrings(source: string): string {
  let result = "";
  let quote: string | null = null;
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (quote === null) {
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        result += char;
        index += 1;
        continue;
      }
      result += char;
      index += 1;
      continue;
    }
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) {
      quote = null;
      result += char;
      index += 1;
      continue;
    }
    index += 1;
  }
  return result;
}

function textOf(path: string): string {
  const source = SOURCES[path];
  if (source === undefined) throw new Error(`闸门读不到源码：${path}`);
  return source;
}

/** 逐文件扫「剥注释、保留字符串」的文本（import 的包名就在字符串里，不能剥）。 */
function filesWithKeptStrings(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const [path, source] of Object.entries(SOURCES)) {
    if (path === GATE_FILE) continue;
    if (pattern.test(stripComments(source))) hits.push(path);
  }
  return hits.sort();
}

describe("平台接入闸门", () => {
  it("G1：只有 tauriDriver.ts 允许出现 @tauri-apps/", () => {
    expect(filesWithKeptStrings(/@tauri-apps\//)).toEqual([DRIVER_FILE]);
  });

  it("G2：只有 capabilities.ts 允许读 isTauri", () => {
    const hits: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      // **必须跳过本文件自己**（与 G1 同理，但这里是踩出来的）：下面的正则字面量 `/…\bisTauri\b/`
      // 不是字符串、`stripStrings` 剥不掉它，于是本文件会把自己判成违规、G2 永远红。
      if (path === GATE_FILE) continue;
      if (/\bisTauri\b/.test(stripStrings(stripComments(source)))) hits.push(path);
    }
    expect(hits.sort()).toEqual([CAPABILITIES_FILE]);
  });

  it("G3：main.ts 的 setPlatform 必须早于 mount", () => {
    const code = stripComments(textOf(MAIN_FILE));
    const setIndex = code.indexOf("setPlatform(");
    const mountIndex = code.indexOf("mount(");
    expect(setIndex).toBeGreaterThanOrEqual(0);
    expect(mountIndex).toBeGreaterThanOrEqual(0);
    expect(setIndex).toBeLessThan(mountIndex);
  });

  it("G3b（任务 2 转绿）：main.ts 必须按运行时选择实现", () => {
    expect(stripComments(textOf(MAIN_FILE))).toContain("isTauriRuntime()");
  });

  it("G4（pass 2 转绿）：ExportPanel 不得直调 downloadBlob，必须走 album.save", () => {
    const code = stripComments(textOf(PANEL_FILE));
    expect(code).not.toContain("downloadBlob");
    expect(code).toContain("album.save(");
  });
});
```

运行：`npx vitest run src/__tests__/platformGate.test.ts`
预期：**2 passed / 3 failed**（G1 / G3b / G4 故意红；G1 红是因为 `tauriDriver.ts` 还没被创建），失败原因与转绿时点正是上面注释里写的那三条。**不许为了让它变绿而提前创建空壳 `tauriDriver.ts` 或提前改面板**。

- [ ] **步骤 12：变异实测（四条闸门各一条，红数回填）**

在**已提交**的树上做（B4 的 R-12），每条自证替换生效、做完还原并确认 `git diff` 为空：

| ID | 改哪一行 | 期望哪条用例红 |
|---|---|---|
| M7 | 在 `src/services/platform/tauriPlatform.ts` 顶部加一句 `import type { X } from "@tauri-apps/api/core";`（该文件此时还不存在 ⇒ **用 `src/views/ShellProbePage.vue` 之外的任意既有文件**，例如 `src/services/exporter.ts`，加一句同样的 import） | G1 |
| M13 | 在 `src/services/platform/browserPlatform.ts` 里读一次 `globalThis.isTauri` | G2 |
| M14 | 把 `src/main.ts` 里的 `setPlatform(browserPlatform);` 挪到 `.mount("#app")` **之后** | G3 |

（M7 的变异体会让 `npm run build` 因为真的 import 了未安装的包而失败——**这也算「G1 红」的证据**，但要分开记：先跑 `npx vitest run src/__tests__/platformGate.test.ts` 看闸门是否红，再还原。）

填回：

```
M7 → ? 红    M13 → ? 红    M14 → ? 红
```

- [ ] **步骤 13：三跑记录**

```powershell
npm run test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

预期：`npm run test` = **66 文件 / 1163 用例**（任务 0 之后的 65/1158 加上本任务的 1 个新测试文件 / 5 条闸门用例；**以实跑数字为准**），其中 **3 条故意红**（G1 / G3b / G4）；`npm run build` 通过（`vue-tsc` 不报错）；`cargo check` exit 0。

- [ ] **步骤 13：Commit**

```powershell
git add src-tauri src/__tests__/platformGate.test.ts scripts/make-app-icon.mjs app-icon.png .gitignore .github/workflows/ci.yml package.json package-lock.json
git commit -m "feat(app): Tauri 壳骨架（Android 工程 / 图标 / CI rust-check）与平台接入四闸门"
```

> **注意 `git add src-tauri` 的覆盖面**：步骤 8 改完 `.gitignore` 之后 `src-tauri/gen/android/**` 不再被忽略，所以这条会把整个 Android 工程一起入库（裁决 6）。提交前先看一遍 `git status --short` 里 `src-tauri/` 的行数，把它记进报告（这就是「入库了多少文件」的原始读数）。

---

### 任务 2：spike 探路（`/lab/shell` 探针页 + `tauriDriver` + Rust 命令 + 最小 Kotlin 插件）

**交付物**：一个能装到手机上、能跑的探针页，跑出**六份原始读数**（F 由「装上了且这一页打开了」回答，A–E 由页面逐项回答），并据此**定下 pass 2 各任务的实现分支**。

**这一任务为什么不建 `tauriPlatform.ts`**（写计划时改正的一处顺序）：探针页要探的四件事（分享进入 / 存相册 / 返回键 / 关闭请求）**直接消费驱动**就够了；若现在就建壳侧能力实现，它会带着「相册选图 / 拍照」两个还不知道怎么实现的方法过一轮——要么放假实现（撒谎），要么写投机代码（pass 2 可能全丢）。**壳侧能力实现与 `main.ts` 的切换放进 pass 2 的第一个接线任务**（相册选图），届时 `createTauriPlatform` 的每个方法都有真实读数与真实消费者。**代价如实记录**：那一步会让 `platformGate` 的 G3b 转绿，而不是本任务。

**文件：**
- 创建：`src/services/platform/tauriDriver.ts`、`src/services/platform/sniffImageType.ts`、`src/views/ShellProbePage.vue`、`src/views/__tests__/ShellProbePage.test.ts`、`src/services/platform/__tests__/sniffImageType.test.ts`
- 修改：`src/router/index.ts`（+1 条路由 `name: "shell-lab"`）、`src/router/__tests__/index.test.ts`（**只追加**一条恒等断言）
- 修改：`src-tauri/Cargo.toml`（+ `tauri-plugin-dialog` / `tauri-plugin-fs` / 本地插件 path 依赖）
- 修改：`src-tauri/capabilities/default.json`（+ `dialog:allow-open` + `fs` 读文件权限）
- 修改：`src-tauri/src/lib.rs`（`OpenedUris` + `take_opened_uris` + `RunEvent::Opened` 的 emit + `save_image_to_album`）
- 创建：`src-tauri/plugins/album/**`（最小移动插件：`Cargo.toml` / `build.rs` / `src/lib.rs` / `src/mobile.rs` / `src/desktop.rs` / `android/build.gradle.kts` / `android/src/main/AndroidManifest.xml` / `android/src/main/java/cn/tuzkimo/weefuse/album/AlbumPlugin.kt`）
- **一次性脚手架（必须删）**：`src/router/index.ts` 顶部临时加一行 `redirect`（步骤 8 用，步骤 12 前删掉）
- 报告（**不入库**）：`.superpowers/sdd/2026-10-06-app-b5-spike/report.md`

**为什么 `sniffImageType.ts` 在本任务建（片段裁定 1）**：规格 §5.3.5 定的是「末段扩展名 / 魔数嗅探 / `相册图片.<ext>`」这套规则**两处共用一份实现**，而两处正是本任务的 `pickImageFile`（dialog 分支：`content://` → 字节 → `File`）与 pass 2 的分享摄入。不在本任务建它就必然出现两份。**pass 2 的任务 3/5 只许消费它，不许再写第二份。**

- [ ] **步骤 1：写驱动 `tauriDriver.ts`（全仓唯一接触 `@tauri-apps/*` 的文件，全部走动态 import）**

`src/services/platform/tauriDriver.ts`：

```ts
/**
 * **全仓唯一接触 `@tauri-apps/*` 的文件**（B5 规格 §3.2 的 G1 闸门守着这一条）。
 *
 * **为什么必须只有这一处**：`@tauri-apps/api` 与插件包在 import 期就会读 `window.__TAURI_INTERNALS__`
 * （`invoke` 的实现靠它）。`npm run test` 跑在 happy-dom 里没有这个对象，所以任何在**模块顶层**
 * 静态 import 它们的文件都会在用例**收集阶段**就崩，而崩的原因与被测行为毫无关系。
 * 本文件把「碰 Tauri」收敛成一处，并且：
 *
 * 1. **全部用动态 `import()`**，只在 `loadTauriDriver()` 第一次被调用时执行（结果 memoize）；
 * 2. 返回一个**窄接口** `TauriDriver`，而不是把插件的模块对象直接透传——这样消费方在 Node 里
 *    可以被一个假驱动完整驱动；
 * 3. 本文件**不做任何判断**：谁在什么时候调它，由消费方决定。
 *
 * **消费者**：`views/ShellProbePage.vue`（开发期探针，本任务）；pass 2 的壳侧能力实现
 * （`tauriPlatform.ts`）与它共用同一份驱动。
 */
export interface TauriDriver {
  /** 取走启动时进来的分享 URI（Android 的 `ACTION_SEND`）。**取走即清**：第二次调用返回空数组。 */
  takeOpenedUris(): Promise<string[]>;
  /** 热启动：App 已在运行时又收到一次分享。返回解绑函数。 */
  listenOpened(handler: (uri: string) => void): Promise<() => void>;
  /** 读一个 URI（Android 上是 `content://…`）的全部字节。 */
  readFileAsBytes(uri: string): Promise<Uint8Array>;
  /**
   * 把 PNG 字节存进系统相册（Android）/ 桌面返回「不支持」。返回**实际写入的字节数**——
   * 驱动拿它与 `bytes.length` 比对（端到端的字节核对，见实现）。
   */
  saveToAlbum(bytes: Uint8Array, filename: string): Promise<number>;
  /**
   * 拍照。**可选成员**（片段裁定 2）：`Platform.imagePicking.canCapture` 是**同步字段**，而驱动是
   * 异步加载的；「本平台不支持拍照」在驱动形态上的表达就正好是**不提供这个方法**。pass 2 的
   * `tauriPlatform` 用它的有无来决定 `canCapture`，不必新增任何 `xxxForTests` 导出。
   */
  captureImageFile?(): Promise<File | null>;
  /** Android 返回键；payload 里 `canGoBack` 取自 WebView 的历史。返回解绑函数。 */
  onBackButtonPress(handler: (info: { readonly canGoBack: boolean }) => void): Promise<() => void>;
  /** 关闭 / 退出请求；handler 返回 `true` 即阻止这次退出。返回解绑函数。 */
  onCloseRequested(handler: () => boolean): Promise<() => void>;
  /** 明确退出 App。 */
  exitApp(): Promise<void>;
}

let pending: Promise<TauriDriver> | null = null;

/**
 * 本壳是否提供拍照（§5.2 三级降级的结论落点）。
 *
 * **判据 B 的读数决定它**：`/lab/shell` 的 B 块若证明 `capture="environment"` 直接进相机且拍完能解码，
 * 保持 `true`；只出文件选择器 / 相机起不来 ⇒ 任务 4 走第 2 级（Kotlin `capture` 插件）；第 2 级也走不通
 * ⇒ 改成 `false`（UI 不渲染入口，README 写明未交付拍照）。
 *
 * **为什么它是一个常量而不是「问驱动」**：`Platform.imagePicking.canCapture` 是**同步字段**，而
 * `loadTauriDriver()` 是异步的（`createTauriPlatform()` 不传驱动时驱动还没加载）。同一份事实只有这一个
 * 落点：`createDriver()` 按它决定要不要给出 `captureImageFile`（下方条件展开），`tauriPlatform.ts` 只在
 * **没注入驱动**时读它。两处不会漂移。
 *
 * **消费者**：`src/services/platform/tauriPlatform.ts`（`canCapture` 的同步来源）与本文件的
 * `createDriver()`。零其他消费者。
 */
export const CAPTURE_SUPPORTED = true;

/**
 * 用隐藏 `<input type=file>` 取图；`capture` 非空时带上 `capture` 属性（拍照那一条路）。
 *
 * **取消 = `null`**（正常操作，不许抛错）。**「一直没有 change」不当作失败**：若真机上取消后按钮永久
 * 卡在「读取中」，说明 WebView 不支持 `cancel` 事件（Chrome 113+ 才有）——那是**判据 B 的读数**，
 * 记进报告，处置在任务 3/4 的 busy 闸门（加超时或改走 dialog 分支），不在这里偷偷加超时。
 */
function pickWithHiddenInput(capture: "environment" | null): Promise<File | null> {
  return new Promise<File | null>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    if (capture !== null) input.setAttribute("capture", capture);
    input.style.display = "none";
    // 先挂进 body 再 click：部分 WebKit 版本对未挂载的 file input 调 click 不唤起选择器。
    document.body.append(input);

    let settled = false;
    const finish = (value: File | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => finish(null));

    try {
      input.click();
    } catch (error) {
      settled = true;
      input.remove();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * 取驱动（memoize：插件只 import 一次）。
 *
 * **不在这里判断「是不是壳里」**：那是 `capabilities.ts` 的 `isTauriRuntime()` 的职责（G2）。
 * 本函数只在**已经确定要接触 Tauri** 的地方被调用。
 */
export function loadTauriDriver(): Promise<TauriDriver> {
  pending ??= createDriver();
  return pending;
}

async function createDriver(): Promise<TauriDriver> {
  const [core, event, app, window, dialog, fs] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
    import("@tauri-apps/api/app"),
    import("@tauri-apps/api/window"),
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);

  /**
   * 相册选图（**当前实现 = dialog + fs**，规格 §5.1 表格的 B 面）。
   *
   * `plugin-dialog` 在 Android 上返回 **`content://` URI**，`plugin-fs` 的 `readFile` 读它的字节
   * （官方口径：filesystem 插件对任何路径格式开箱可用）⇒ 这里自己拼 `File`，并**复用
   * `sniffImageType.ts`** 定名字与 MIME（§5.3.5：这条规则只有一份）。
   *
   * **运行期守卫**：`multiple: false` 时官方类型是 `string | null`，但 `invoke` 的返回值过 JSON 边界，
   * 拿到的不是字符串就**响亮失败**，不把数组 / 对象当路径传下去。
   */
  async function pickImageFile(): Promise<File | null> {
    const selected = await dialog.open({
      multiple: false,
      directory: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (selected === null) return null;
    if (typeof selected !== "string") {
      throw new Error(`图片选择器返回了非路径对象：${typeof selected}`);
    }
    const bytes = await fs.readFile(selected);
    return new File([bytes], imageFileName(selected, bytes), { type: sniffImageType(bytes) });
  }

  async function captureImageFile(): Promise<File | null> {
    return pickWithHiddenInput("environment");
  }

  return {
    pickImageFile,
    // 判据 B 的两级都走不通 ⇒ `CAPTURE_SUPPORTED = false` ⇒ 驱动**不提供**这个方法，
    // `tauriPlatform.canCapture` 因此为 false，UI 不渲染「拍一张」（§5.2 第 3 级）。
    ...(CAPTURE_SUPPORTED ? { captureImageFile } : {}),
    async takeOpenedUris() {
      return core.invoke<string[]>("take_opened_uris");
    },
    async listenOpened(handler) {
      return event.listen<string>("opened", (payload) => {
        handler(payload.payload);
      });
    },
    async readFileAsBytes(uri) {
      return fs.readFile(uri);
    },
    async saveToAlbum(bytes, filename) {
      // **自描述信封**（片段裁定 3）：body = `[u32 LE 文件名字节数][文件名 UTF-8][图像字节]`。
      //
      // **为什么不把文件名放进 `invoke` 的 `options.headers`**：HTTP header 的值域是 ASCII，
      // 而 `exportFilename()` 产出的是中文名（「小猫-施工图-r1c1.png」）；即便 `encodeURIComponent`
      // 能把它绕成 ASCII，也等于把「文件名的编码」塞进 header 解析里，还要赌 `invoke` 的第三个
      // 参数支持 `headers`。信封把两件事分开、可逐条校验，且**不依赖任何未经核实的 API**。
      const nameBytes = new TextEncoder().encode(filename);
      const body = new Uint8Array(4 + nameBytes.length + bytes.length);
      new DataView(body.buffer).setUint32(0, nameBytes.length, true);
      body.set(nameBytes, 4);
      body.set(bytes, 4 + nameBytes.length);

      const written = await core.invoke<number>("save_image_to_album", body);
      // **端到端字节核对**：Rust 返回它真正交给相册的字节数，不等即抛。这是这条桥唯一能在真机上
      // 证明自己没被截断的手段（判据 C/D 的读数里那句「端到端一致（N 字节）」就是它）。
      if (written !== bytes.length) {
        throw new Error(`相册写入字节数不一致：期望 ${bytes.length}，实际 ${written}`);
      }
      return written;
    },
    async onBackButtonPress(handler) {
      // 官方 payload 就是 `{ canGoBack: boolean }`；这里显式重建，免得把 Tauri 的 payload 类型
      // （可能带可选字段）泄漏到窄接口上。
      return app.onBackButtonPress((payload) => {
        handler({ canGoBack: payload.canGoBack });
      });
    },
    async onCloseRequested(handler) {
      // `preventDefault` 必须在监听器里**同步**调用，而 `handler` 本身是同步的 ⇒ 这条链上没有 await。
      return window.getCurrentWindow().onCloseRequested((closeEvent) => {
        if (handler()) closeEvent.preventDefault();
      });
    },
    async exitApp() {
      await app.exit(0);
    },
  };
}
```

> **本文件在 CI 里没有可执行用例**（上面那条 import 期行为就是原因），如实登记：信封布局、字节核对、
> `app.exit()` 的判别力都在真机判据 C/D/E 的读数里。本层的「测试」是 `npm run build` 的类型检查。

- [ ] **步骤 1b：写 `sniffImageType.ts`（两处共用的那份实现）与它的用例**

`src/services/platform/sniffImageType.ts`：

```ts
/**
 * 从字节里嗅出图片类型；从 URI 里取一个能当工程名用的文件名。
 *
 * **为什么要有这一层**（规格 §5.3.5）：Android 交回来的 `content://…` 不带 MIME、末段常常没有
 * 扩展名（形如 `image%3A1234`），而它最终会经 `defaultProjectName` 变成**默认工程名**——
 * 不允许出现「image:1234」这种工程名。规则必须只有一份：dialog 备选（本任务）与分享摄入
 * （pass 2 任务 5）共用。
 *
 * **为什么用魔数而不是信任调用方给的 MIME**：解码路径根本不看 `File.type`
 * （`decodeImageElement` 走 object URL + `<img>.decode()`，由 WebView 嗅探真实字节），`type`
 * 只影响我们自己的记录、显示与默认工程名 ⇒ 魔数足够，而它**是纯函数、能在 CI 里逐字节断言**。
 *
 * **已知边界（如实登记）**：只认四种常见格式（PNG / JPEG / WEBP / HEIC）。其余一律回落
 * `application/octet-stream` —— 回落不是失败：真正的格式判定在解码那一步，这里错了会以
 * 「解码失败」的形式响亮暴露。
 */

/** 魔数表。**顺序无关**（每种格式的前缀互不前缀包含）。 */
const SIGNATURES: readonly { readonly type: string; readonly bytes: readonly number[]; readonly offset: number }[] = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff], offset: 0 },
  { type: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // "RIFF"；完整判据还要看 8..12 处的 "WEBP"
  { type: "image/heic", bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // "ftyp" 在第 4 字节起
];

const WEBP_TAG = [0x57, 0x45, 0x42, 0x50]; // "WEBP"

/**
 * 嗅图片类型。**长度不足时直接回落**（不许越界读：`bytes[3]` 在长度 1 的数组上拿到 `undefined`，
 * 与 `0x89` 比较恒不相等，所以越界本身不会崩——但那是**靠运气**，不是靠判据）。
 */
export function sniffImageType(bytes: Uint8Array): string {
  for (const signature of SIGNATURES) {
    const end = signature.offset + signature.bytes.length;
    if (bytes.length < end) continue;
    let matched = true;
    for (let i = 0; i < signature.bytes.length; i += 1) {
      if (bytes[signature.offset + i] !== signature.bytes[i]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (signature.type === "image/webp") {
      // RIFF 是容器前缀（WAV / AVI 同前缀）⇒ 必须再看 8..12 的 "WEBP" 才算数。
      if (bytes.length < 12) continue;
      let isWebp = true;
      for (let i = 0; i < WEBP_TAG.length; i += 1) {
        if (bytes[8 + i] !== WEBP_TAG[i]) {
          isWebp = false;
          break;
        }
      }
      if (!isWebp) continue;
    }
    return signature.type;
  }
  return "application/octet-stream";
}

/** 扩展名 → 类型（用于「URI 末段有扩展名」时先按扩展名判，再回落魔数）。 */
const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
};

/** 默认文件名的词干。**与扩展名分开**：工程名由 `defaultProjectName` 去扩展名而来。 */
const FALLBACK_STEM = "相册图片";

/**
 * 从一个 URI / 路径里取一个能当工程名的文件名。第二参是 `sniffImageType` 的结果
 * （**不由本函数自己嗅**：URI 的阶段还读不到字节，两件事分开才可能各自被断言）。
 *
 * 规则（规格 §5.1 末段）：
 * 1. 末段（`/` 分隔）做一次最小百分号解码；
 * 2. 末段含 `.` 且扩展名在白名单里 ⇒ 原样用它；
 * 3. 否则 ⇒ `` `${FALLBACK_STEM}.${扩展名}` ``，扩展名由 `sniffedType` 反查（`image/jpeg` → `jpg`），
 *    查不到用 `bin`。
 *
 * **不返回空串**：空串会让 `defaultProjectName("")` 回落「新图纸」——那是把「名字丢了」藏起来。
 */
export function imageNameFromUri(uri: string, sniffedType: string): string {
  const decoded = decodeURIComponent(uri);
  const tail = decoded.split("/").pop() ?? "";
  const dot = tail.lastIndexOf(".");
  if (dot > 0 && dot < tail.length - 1) {
    const ext = tail.slice(dot + 1).toLowerCase();
    if (EXTENSION_TYPES[ext] !== undefined) return tail;
  }
  const sniffedExt = Object.entries(EXTENSION_TYPES).find(([, type]) => type === sniffedType)?.[0] ?? "bin";
  return `${FALLBACK_STEM}.${sniffedExt}`;
}
```

`src/services/platform/__tests__/sniffImageType.test.ts`（表驱动，**7 条**）：

```ts
import { describe, expect, it } from "vitest";
import { imageNameFromUri, sniffImageType } from "../sniffImageType";

/** 四种格式的真前缀（逐字节），外加两种「像但不是」。 */
const CASES: readonly { readonly note: string; readonly bytes: number[]; readonly type: string }[] = [
  { note: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a], type: "image/png" },
  { note: "JPEG", bytes: [0xff, 0xd8, 0xff, 0xe0], type: "image/jpeg" },
  { note: "WEBP（RIFF + WEBP）", bytes: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], type: "image/webp" },
  { note: "HEIC（ftyp 在第 4 字节）", bytes: [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63], type: "image/heic" },
  { note: "RIFF 但不是 WEBP（例如 WAV）⇒ 不认", bytes: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], type: "application/octet-stream" },
  { note: "全零 ⇒ 回落", bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], type: "application/octet-stream" },
];

describe("sniffImageType", () => {
  for (const testCase of CASES) {
    it(`${testCase.note} ⇒ ${testCase.type}`, () => {
      expect(sniffImageType(new Uint8Array(testCase.bytes))).toBe(testCase.type);
    });
  }

  it("长度不足的截断字节不越界、不谎报（PNG 只剩前两字节 ⇒ 回落）", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBe("application/octet-stream");
    expect(sniffImageType(new Uint8Array([]))).toBe("application/octet-stream");
  });
});

describe("imageNameFromUri", () => {
  it("末段带白名单扩展名 ⇒ 原样保留", () => {
    expect(imageNameFromUri("content://media/external/images/12345.JPEG", "image/jpeg")).toBe("12345.JPEG");
  });

  it("无扩展名的 content:// 末段 ⇒ 回落「相册图片.<ext>」，且 ext 由嗅探结果决定", () => {
    expect(imageNameFromUri("content://media/external/images/media/1", "image/png")).toBe("相册图片.png");
    expect(imageNameFromUri("file:///tmp/x", "application/octet-stream")).toBe("相册图片.bin");
  });

  it("百分号编码的末段（形如 image%3A1234）⇒ 回落，不许把 image:1234 当工程名", () => {
    const name = imageNameFromUri("content://media/external/images/media/image%3A1234", "image/jpeg");
    expect(name).toBe("相册图片.jpg");
    expect(name).not.toContain(":");
  });
});
```

运行：`npx vitest run src/services/platform/__tests__/sniffImageType.test.ts`
预期：**10 passed**（6 个格式表 + 1 条截断 + 3 条命名）。

- [ ] **步骤 1c：写壳侧能力实现 `tauriPlatform.ts` 与它的用例**

**为什么它必须在本任务出现**（而不是 pass 2）：探针页 C / D / E 要跑的是**交付路径**（能力层 → 驱动），
而不是只跑驱动——否则取到的读数回答不了「用户点保存时会发生什么」。它的相册选图（dialog + fs）与拍照
（隐藏 input + `capture`）两支在本任务就有**真实实现**，所以不存在「先放假方法」的问题；pass 2 只按
判据读数**换实现**（A 通 ⇒ 换成隐藏 input 并删 dialog 依赖；B 不通 ⇒ 换 Kotlin 相机或改成不支持）。

`src/services/platform/tauriPlatform.ts`：

```ts
import { requireSavableBlob } from "./guards";
import { imageFileName, sniffImageType } from "./sniffImageType";
import { CAPTURE_SUPPORTED, loadTauriDriver, type TauriDriver } from "./tauriDriver";
import type { AlbumSaver, AppLifecycle, ImagePicking, Platform, ShareInbox } from "./types";

/**
 * 把 `TauriDriver`（唯一接触 `@tauri-apps/*` 的那一层）适配成 `Platform`（规格 §4.3 / §4.4）。
 *
 * **本文件是纯逻辑**：不 import 任何 `@tauri-apps/*`、不读 DOM 全局（除构造 `File`），全部依赖经参数
 * 进来 ⇒ 在 happy-dom 里被一个**假驱动**完整驱动（`__tests__/tauriPlatform.test.ts`）。
 *
 * **规格 §4.4 的守卫逐字在此**，且一律写在任何写操作之前（`AGENTS.md` 入口校验）：
 * `图片选择器返回了非文件对象` / `本平台不支持拍照` / `分享内容不是文件` / `回调必须是函数`；
 * `save` 的两条消息由 `requireSavableBlob` 提供（两实现共用）。
 *
 * **消费者**：`src/main.ts`（生产唯一消费者：`setPlatform(isTauriRuntime() ? createTauriPlatform() : browserPlatform)`）
 * 与 `src/services/platform/__tests__/tauriPlatform.test.ts`（假驱动）。
 */
export function createTauriPlatform(driver?: TauriDriver): Platform {
  // 构造注入：传了就用传进来的（用例走这条）；没传就在**第一次真正用到时**再动态加载（§4.3）。
  // 不新增任何 `xxxForTests` 导出——依赖从参数进来是正常的构造注入。
  let loaded: TauriDriver | null = driver ?? null;

  async function requireDriver(): Promise<TauriDriver> {
    if (loaded === null) loaded = await loadTauriDriver();
    return loaded;
  }

  /**
   * 非 `File` 且非 `null` 的驱动返回值**一律抛**（不静默当取消）。消息由调用方逐字给出（§4.4）。
   *
   * **为什么必须有这条**：`invoke` 的返回值过 JSON 边界，`undefined` / 数字 / 字符串都可能出现；
   * 静默当取消会让「选择器坏了」表现得像「用户没选」。
   */
  function requireFileOrNull(value: unknown, message: string): File | null {
    if (value === null) return null;
    if (value instanceof File) return value;
    throw new Error(message);
  }

  /** URI → `File`（§5.3.2 的末两步 + §5.3.5 的命名 / 嗅探）。守卫在构造之前。 */
  async function fileFromUri(source: TauriDriver, uri: string): Promise<File> {
    const bytes = await source.readFileAsBytes(uri);
    if (!(bytes instanceof Uint8Array)) throw new Error("分享内容不是文件");
    if (bytes.length === 0) throw new Error("分享内容是空文件");
    return new File([bytes], imageFileName(uri, bytes), { type: sniffImageType(bytes) });
  }

  /**
   * 「注册一个异步到手的监听，返回**同步**解绑函数」——§4.1 把三个注册型入口的返回类型钉成
   * `() => void`，而驱动侧的注册都是 `Promise`。
   *
   * 两个边界都必须处理：① 注册还没完成就有人解绑 ⇒ 注册一完成**立刻**解绑（否则监听泄漏、页面卸载后
   * 还在跑）；② 注册本身失败 ⇒ 日志留原文（§4.1 的返回类型没有第二个出口）。
   */
  function bindLate(
    register: (source: TauriDriver) => Promise<() => void>,
    what: string,
  ): () => void {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        const unbind = await register(await requireDriver());
        if (disposed) unbind();
        else unlisten = unbind;
      } catch (error) {
        console.error(`${what}的监听注册失败`, error);
      }
    })();

    return () => {
      disposed = true;
      if (unlisten !== null) {
        unlisten();
        unlisten = null;
      }
    };
  }

  // 注入驱动时按驱动形态判断（用例走这条，能真正判别「本平台不支持拍照」那条守卫）；
  // 没注入驱动时读 `CAPTURE_SUPPORTED`（同步可得），而 `createDriver()` 按**同一个常量**决定
  // 要不要提供 `captureImageFile` ⇒ 只有一份事实。
  const canCapture =
    driver === undefined ? CAPTURE_SUPPORTED : typeof driver.captureImageFile === "function";

  const imagePicking: ImagePicking = {
    kind: "native-picker",
    canCapture,
    async pickFromAlbum(): Promise<File | null> {
      const value = await (await requireDriver()).pickImageFile();
      return requireFileOrNull(value, "图片选择器返回了非文件对象");
    },
    async capturePhoto(): Promise<File | null> {
      if (!canCapture) throw new Error("本平台不支持拍照");
      const source = await requireDriver();
      const capture = source.captureImageFile;
      if (capture === undefined) {
        // 常量与驱动形态一致时不可达；它存在是因为两者是**同一份事实**的两个投影——
        // 一旦漂移，这里响亮失败，而不是在下一行裸崩成 TypeError。
        throw new Error("本平台不支持拍照");
      }
      return requireFileOrNull(await capture(), "图片选择器返回了非文件对象");
    },
  };

  const shareInbox: ShareInbox = {
    supported: true,
    async takeSharedImage(): Promise<File | null> {
      const source = await requireDriver();
      const uris = await source.takeOpenedUris();
      // `invoke` 的返回值过 JSON 边界：不是数组、元素不是非空字符串都算「分享内容不是文件」（§4.4）。
      if (!Array.isArray(uris)) throw new Error("分享内容不是文件");
      if (uris.length === 0) return null;
      const first: unknown = uris[0];
      if (typeof first !== "string" || first.trim() === "") throw new Error("分享内容不是文件");
      return fileFromUri(source, first);
    },
    onSharedImage(handler: (file: File) => void): () => void {
      if (typeof handler !== "function") throw new Error("回调必须是函数");
      return bindLate((source) => {
        return source.listenOpened((uri) => {
          void fileFromUri(source, uri)
            .then((file) => handler(file))
            .catch((error: unknown) => {
              // §4.1 把 handler 的签名钉成 `(file: File) => void`，失败没有第二个出口：用户可见的提示条
              // 由任务 5 的 `useShareIntake` 负责，而「读不出字节」这一步只能留日志。**不静默吞掉**。
              console.error("分享内容读取失败", error);
            });
        });
      }, "分享进入");
    },
  };

  const album: AlbumSaver = {
    kind: "album",
    async save(blob: Blob, filename: string): Promise<void> {
      // 守卫在**任何写操作之前**：空 blob / 空文件名不许走到 arrayBuffer，更不许建临时文件。
      const safe = requireSavableBlob(blob, filename);
      const bytes = new Uint8Array(await safe.blob.arrayBuffer());
      await (await requireDriver()).saveToAlbum(bytes, safe.filename);
    },
  };

  const lifecycle: AppLifecycle = {
    onExitRequested(handler: () => boolean): () => void {
      if (typeof handler !== "function") throw new Error("回调必须是函数");
      return bindLate((source) => source.onCloseRequested(handler), "关闭请求");
    },
    onBackButton(handler: (info: { readonly canGoBack: boolean }) => void): () => void {
      if (typeof handler !== "function") throw new Error("回调必须是函数");
      return bindLate((source) => source.onBackButtonPress(handler), "返回键");
    },
    async exit(): Promise<void> {
      await (await requireDriver()).exitApp();
    },
  };

  return { imagePicking, shareInbox, album, lifecycle };
}
```

`src/services/platform/__tests__/tauriPlatform.test.ts`（**8 条**，全部用假驱动）：

```ts
import { describe, expect, it, vi } from "vitest";
import { CAPTURE_SUPPORTED, type TauriDriver } from "@/services/platform/tauriDriver";
import { createTauriPlatform } from "@/services/platform/tauriPlatform";

/**
 * 壳侧能力实现的假驱动用例（规格 §9.1 的「两份实现共用契约」里的壳那一份）。
 *
 * **为什么用假驱动**：真实现在 happy-dom 下不可执行（`@tauri-apps/*` 在 import 期读
 * `window.__TAURI_INTERNALS__`），而 §4.4 的守卫与 §5.3.2 的取走语义**都是纯逻辑**，必须能在 CI 里被
 * 判别。**这一份能证明的**：取消 → `null`；非 `File` 返回值抛（`undefined` 也算，不许静默当取消）；
 * `canCapture === false` 时抛「本平台不支持拍照」；`save` 的两条守卫**在任何写操作之前**（驱动一次都没被
 * 调用）；正常路径把字节与清洗后的名字交给驱动；三个注册型入口的解绑语义（含「注册完成前就解绑」）；
 * `exit` 调驱动一次；热启动链路把 URI 变成带名字与 MIME 的 `File`。
 * **测不到的**：`take_opened_uris` 的「取走即清」（那是 Rust 侧 `std::mem::take`，CI 无 Rust 单测）。
 */
const PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

/** `bindLate` 里有 2–3 个 await 点；刷够微任务再断言（这里没有真实异步源，不用定时器）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

interface DriverOptions {
  readonly pick?: () => Promise<File | null>;
  /** `null` = **不提供** `captureImageFile`（§5.2 第 3 级的形态）。 */
  readonly capture?: (() => Promise<File | null>) | null;
  readonly uris?: () => Promise<string[]>;
  readonly opened?: (handler: (uri: string) => void) => Promise<() => void>;
  readonly bytes?: (uri: string) => Promise<Uint8Array>;
  readonly save?: (bytes: Uint8Array, filename: string) => Promise<void>;
  readonly back?: (handler: (info: { canGoBack: boolean }) => void) => Promise<() => void>;
  readonly close?: (handler: () => boolean) => Promise<() => void>;
}

function makeDriver(options: DriverOptions = {}): {
  driver: TauriDriver;
  exitApp: ReturnType<typeof vi.fn>;
} {
  const exitApp = vi.fn(async () => {});
  const driver: TauriDriver = {
    pickImageFile: vi.fn(options.pick ?? (async () => null)),
    ...(options.capture === null
      ? {}
      : { captureImageFile: vi.fn(options.capture ?? (async () => null)) }),
    takeOpenedUris: vi.fn(options.uris ?? (async () => [])),
    listenOpened: vi.fn(options.opened ?? (async () => () => {})),
    readFileAsBytes: vi.fn(options.bytes ?? (async () => PNG_HEAD)),
    saveToAlbum: vi.fn(options.save ?? (async () => {})),
    onBackButtonPress: vi.fn(options.back ?? (async () => () => {})),
    onCloseRequested: vi.fn(options.close ?? (async () => () => {})),
    exitApp,
  };
  return { driver, exitApp };
}

describe("createTauriPlatform（假驱动）", () => {
  it("pickFromAlbum：拿到 File 原样返回；取消返回 null；非 File（含 undefined）一律抛「图片选择器返回了非文件对象」", async () => {
    const file = new File([PNG_HEAD], "相册.png", { type: "image/png" });
    const platform = createTauriPlatform(makeDriver({ pick: async () => file }).driver);
    expect(platform.imagePicking.kind).toBe("native-picker");
    expect(await platform.imagePicking.pickFromAlbum()).toBe(file);

    const cancelled = createTauriPlatform(makeDriver({ pick: async () => null }).driver);
    expect(await cancelled.imagePicking.pickFromAlbum()).toBeNull();

    for (const bad of [42, "content://x", undefined, {}] as const) {
      const broken = createTauriPlatform(
        makeDriver({ pick: async () => bad as unknown as File | null }).driver,
      );
      await expect(broken.imagePicking.pickFromAlbum()).rejects.toThrow(
        "图片选择器返回了非文件对象",
      );
    }
  });

  it("canCapture：驱动不提供 captureImageFile ⇒ false 且 capturePhoto 抛「本平台不支持拍照」；提供时转发并守返回值", async () => {
    const without = createTauriPlatform(makeDriver({ capture: null }).driver);
    expect(without.imagePicking.canCapture).toBe(false);
    await expect(without.imagePicking.capturePhoto()).rejects.toThrow("本平台不支持拍照");

    const shot = new File([PNG_HEAD], "拍.png", { type: "image/png" });
    const withCapture = createTauriPlatform(makeDriver({ capture: async () => shot }).driver);
    expect(withCapture.imagePicking.canCapture).toBe(true);
    expect(await withCapture.imagePicking.capturePhoto()).toBe(shot);

    const cancelled = createTauriPlatform(makeDriver({ capture: async () => null }).driver);
    expect(await cancelled.imagePicking.capturePhoto()).toBeNull();

    const broken = createTauriPlatform(
      makeDriver({ capture: async () => 7 as unknown as File | null }).driver,
    );
    await expect(broken.imagePicking.capturePhoto()).rejects.toThrow("图片选择器返回了非文件对象");
  });

  it("takeSharedImage：空数组 ⇒ null；取第一个 URI 读字节构造 File（名字/类型按 §5.1 + §5.3.5）；非字符串 / 非字节 / 空字节一律抛", async () => {
    const empty = createTauriPlatform(makeDriver({ uris: async () => [] }).driver);
    expect(await empty.shareInbox.takeSharedImage()).toBeNull();

    const read: string[] = [];
    const source = makeDriver({
      uris: async () => ["content://media/external/images/media/image%3A1234"],
      bytes: async (uri) => {
        read.push(uri);
        return PNG_HEAD;
      },
    });
    const platform = createTauriPlatform(source.driver);
    expect(platform.shareInbox.supported).toBe(true);
    const file = await platform.shareInbox.takeSharedImage();
    expect(read).toEqual(["content://media/external/images/media/image%3A1234"]);
    // ★ 接线断言：URI 末段不可用 ⇒ 名字取自嗅探结果；`type` 也来自嗅探而不是 URI。
    expect(file?.name).toBe("相册图片.png");
    expect(file?.type).toBe("image/png");
    expect(file?.size).toBe(PNG_HEAD.length);

    for (const bad of [42, null, ""] as const) {
      const broken = makeDriver({ uris: async () => [bad as unknown as string] });
      await expect(createTauriPlatform(broken.driver).shareInbox.takeSharedImage()).rejects.toThrow(
        "分享内容不是文件",
      );
    }

    const notBytes = makeDriver({
      uris: async () => ["content://x/1"],
      bytes: async () => [1, 2, 3] as unknown as Uint8Array,
    });
    await expect(createTauriPlatform(notBytes.driver).shareInbox.takeSharedImage()).rejects.toThrow(
      "分享内容不是文件",
    );

    const emptyBytes = makeDriver({
      uris: async () => ["content://x/1"],
      bytes: async () => new Uint8Array(),
    });
    await expect(
      createTauriPlatform(emptyBytes.driver).shareInbox.takeSharedImage(),
    ).rejects.toThrow("分享内容是空文件");
  });

  it("save：空 blob / 空文件名两条守卫逐字复用且**在任何写操作之前**；正常路径把字节与清洗后的名字交给驱动", async () => {
    const calls: Array<{ bytes: Uint8Array; filename: string }> = [];
    const source = makeDriver({
      save: async (bytes, filename) => {
        calls.push({ bytes, filename });
      },
    });
    const platform = createTauriPlatform(source.driver);
    expect(platform.album.kind).toBe("album");

    await expect(platform.album.save(new Blob([]), "a.png")).rejects.toThrow(
      "导出内容为空（blob 大小为 0）",
    );
    const good = new Blob([PNG_HEAD], { type: "image/png" });
    await expect(platform.album.save(good, "   ")).rejects.toThrow("文件名不能为空");
    // ★ 两条守卫都在任何写操作之前：驱动一次都没被调用。
    expect(calls).toHaveLength(0);

    await platform.album.save(good, "  名字.png  ");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filename).toBe("名字.png");
    expect(Array.from(calls[0]!.bytes)).toEqual(Array.from(PNG_HEAD));
  });

  it("解绑：onBackButton 解绑后不再回调；注册完成之前解绑 ⇒ 注册一完成立刻解绑", async () => {
    let backHandler: ((info: { canGoBack: boolean }) => void) | null = null;
    const unlistenBack = vi.fn(() => {});
    const platform = createTauriPlatform(
      makeDriver({
        back: async (handler) => {
          backHandler = handler;
          return unlistenBack;
        },
      }).driver,
    );

    const seen: boolean[] = [];
    const unbind = platform.lifecycle.onBackButton((info) => seen.push(info.canGoBack));
    await settle();
    expect(backHandler).not.toBeNull();
    backHandler!({ canGoBack: true });
    expect(seen).toEqual([true]);

    unbind();
    expect(unlistenBack).toHaveBeenCalledTimes(1);

    // 「注册还没完成就解绑」：注册一完成必须**立刻**解绑，否则监听泄漏、页面卸载后还在跑。
    const unlistenLate = vi.fn(() => {});
    let resolveRegistration: ((value: () => void) => void) | null = null;
    const latePlatform = createTauriPlatform(
      makeDriver({
        back: () =>
          new Promise<() => void>((resolve) => {
            resolveRegistration = resolve;
          }),
      }).driver,
    );
    const lateUnbind = latePlatform.lifecycle.onBackButton(() => {});
    lateUnbind();
    await settle();
    expect(resolveRegistration).not.toBeNull();
    resolveRegistration!(unlistenLate);
    await settle();
    expect(unlistenLate).toHaveBeenCalledTimes(1);
  });

  it("onExitRequested 的 handler 返回值原样交给驱动；handler 非函数抛「回调必须是函数」；exit 调驱动一次", async () => {
    let closeHandler: (() => boolean) | null = null;
    const source = makeDriver({
      close: async (handler) => {
        closeHandler = handler;
        return () => {};
      },
    });
    const platform = createTauriPlatform(source.driver);

    platform.lifecycle.onExitRequested(() => true);
    await settle();
    expect(closeHandler).not.toBeNull();
    expect(closeHandler!()).toBe(true);

    expect(() => platform.lifecycle.onExitRequested("x" as unknown as () => boolean)).toThrow(
      "回调必须是函数",
    );
    expect(() =>
      platform.lifecycle.onBackButton(
        undefined as unknown as (info: { readonly canGoBack: boolean }) => void,
      ),
    ).toThrow("回调必须是函数");

    await platform.lifecycle.exit();
    expect(source.exitApp).toHaveBeenCalledTimes(1);
  });

  it("热启动：驱动的 listenOpened 交给 handler 的 URI 被读成 File 再交给平台 handler", async () => {
    let openedHandler: ((uri: string) => void) | null = null;
    const source = makeDriver({
      opened: async (handler) => {
        openedHandler = handler;
        return () => {};
      },
    });
    const platform = createTauriPlatform(source.driver);
    const received: File[] = [];
    platform.shareInbox.onSharedImage((file) => received.push(file));
    await settle();
    expect(openedHandler).not.toBeNull();

    openedHandler!("content://media/external/images/media/image%3A9");
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0]!.name).toBe("相册图片.png");
    expect(received[0]!.type).toBe("image/png");
    expect(source.driver.readFileAsBytes).toHaveBeenCalledWith(
      "content://media/external/images/media/image%3A9",
    );
  });

  it("不传驱动：五个形态字段立刻可读（驱动是懒加载的）", () => {
    // 这条同时是「懒加载」的**间接**判别：若 `createTauriPlatform()` 在构造期就去 `import()`
    // `@tauri-apps/*`，happy-dom 下那次 import 会 reject，vitest 把未处理的 rejection 记为失败。
    const platform = createTauriPlatform();
    expect(platform.imagePicking.kind).toBe("native-picker");
    expect(platform.imagePicking.canCapture).toBe(CAPTURE_SUPPORTED);
    expect(platform.shareInbox.supported).toBe(true);
    expect(platform.album.kind).toBe("album");
  });
});
```

运行：`npx vitest run src/services/platform/__tests__/tauriPlatform.test.ts`
预期：**8 passed**（本步骤先写用例后写实现，第一次跑应当是 `Failed to resolve import` 的红）。

- [ ] **步骤 1d：`main.ts` 换成按运行时选择实现（G3b 在本任务转绿）**

在 `src/main.ts` 顶部加：

```ts
import { isTauriRuntime, setPlatform } from "./services/platform/capabilities";
import { createTauriPlatform } from "./services/platform/tauriPlatform";
```

把任务 0 写入的那一行 `setPlatform(browserPlatform);` 换成：

```ts
  // 平台实现只在这里注入一次（规格 §3.2 的 G3）：壳里用 Tauri 实现，其余一律浏览器实现。
  // 「壳里」的判据只有一处 —— `capabilities.ts` 的 `isTauriRuntime()`（G2 要求 `isTauri` 只在
  // capabilities.ts 里被读，所以这里读的是那个函数，不是全局标记本身）。
  setPlatform(isTauriRuntime() ? createTauriPlatform() : browserPlatform);
```

`browserPlatform` 的 import 仍然要用（浏览器那一支），不要删。**浏览器路径为什么与今天逐字等价**：
不传驱动时 `createTauriPlatform()` 只构造四个能力对象、**不触发任何 `import()`**，而 `isTauriRuntime()`
在浏览器里为 `false` ⇒ 那一支根本不会被选中。

运行：`npm run test` + `npm run build` + `npx vitest run src/__tests__/platformGate.test.ts`
预期：`platformGate` **4 passed / 1 failed**（只剩 G4 故意红；**G1 与 G3b 在本任务转绿**）。

- [ ] **步骤 2：Rust 侧（`OpenedUris` + 取走即清的命令 + 自描述信封的原始字节体落盘）**

`src-tauri/src/lib.rs` 全文：

```rust
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// 启动 / 运行期分发进来的分享 URI（Android `ACTION_SEND` → `intent.data`）。
///
/// **取走即清**（见 `take_opened_uris`）：摄入链有副作用（改草稿、跳路由），重复摄取同一张图
/// 会让用户莫名其妙地回到选区页。官方的 `opened_urls` 例子是累积的，本仓刻意不照抄。
#[derive(Default)]
struct OpenedUris(Mutex<Vec<String>>);

/// 取走全部待处理 URI 并清空。
///
/// **为什么不叫 `opened_urls`**：名字要体现语义（取走即清），照官方例子命名会让后来者以为它是只读查询。
#[tauri::command]
fn take_opened_uris(app: tauri::AppHandle) -> Vec<String> {
    let state = app.state::<OpenedUris>();
    let mut guard = state.0.lock().expect("OpenedUris 锁中毒");
    std::mem::take(&mut *guard)
}

/// 把 PNG 的**原始字节体**写进系统相册；返回**实际写入的字节数**（JS 侧拿它做端到端核对）。
///
/// body 是一段**自描述信封**（规格 §5.4.1 + 片段裁定 3）：
/// `[u32 LE 文件名字节数][文件名 UTF-8][图像字节]`。
/// 为什么不把文件名放进 `invoke` 的 `options.headers`：HTTP header 值域是 ASCII，而文件名是
/// 中文；信封把「名字」与「字节」分成两段、可逐条校验，也不依赖任何未经核实的 API。
///
/// 实现顺序：**先校验信封、再落临时文件、再交给 Android 插件、最后无条件删临时文件**。
/// 临时文件是「字节要过一段 JSON 到 Kotlin」与「不要把字节塞进 JSON」的折中：Kotlin 只收一个路径。
#[tauri::command]
fn save_image_to_album(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<usize, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("保存失败：需要原始字节体".into());
    };
    if body.len() < 4 {
        return Err("保存失败：信封太短（至少要有 4 字节的文件名长度）".into());
    }
    let name_len = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    // `checked_add`：`name_len` 来自报文，直接相加在 32 位设备上可能溢出后回绕成一个「合法」的小下标。
    let bytes_start = 4usize
        .checked_add(name_len)
        .ok_or("保存失败：文件名字节数溢出")?;
    if bytes_start > body.len() {
        return Err("保存失败：文件名字节数越界".into());
    }
    let filename = std::str::from_utf8(&body[4..bytes_start])
        .map_err(|_| "保存失败：文件名不是合法 UTF-8")?
        .to_string();
    if filename.trim().is_empty() {
        return Err("文件名不能为空".into());
    }
    let image = &body[bytes_start..];
    if image.is_empty() {
        return Err("导出内容为空（blob 大小为 0）".into());
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let temp = std::env::temp_dir().join(format!("weefuse-{stamp}.png"));
    std::fs::write(&temp, image).map_err(|e| format!("写临时文件失败：{e}"))?;

    let result = save_with_platform(&app, &temp, &filename);
    // **无条件删除**：成功失败都删（临时文件不该留在设备上）。
    let _ = std::fs::remove_file(&temp);

    // **第三层核对**（规格 §5.4.1 声称的「三层联动」在这里落地）：拿 Kotlin 报的**实际写入字节数**
    // 与本次图像长度比。Rust 自己读到的长度是 `image.len()`，若只返回它，链路上任何截断都发现不了
    // （2026-10-06 控制者核对时发现计划早先正是这么写的 ⇒ 规格那句话当时是**假的**）。
    let written = result?;
    if written != image.len() {
        return Err(format!(
            "相册写入字节数不一致：期望 {}，实际 {written}",
            image.len()
        ));
    }
    // 返回 **Kotlin 报的数**（前端 `tauriDriver.saveToAlbum` 再拿它与 JS 侧的 `bytes.length` 比 ⇒ 三层闭合）。
    Ok(written)
}

/// 平台分派：Android 交给 Kotlin 插件（**返回 Kotlin 报的实际写入字节数**）；
/// 其它平台响亮失败（桌面端仅开发调试，不假装支持）。
#[cfg(target_os = "android")]
fn save_with_platform(
    app: &tauri::AppHandle,
    path: &std::path::Path,
    filename: &str,
) -> Result<usize, String> {
    use tauri_plugin_album::AlbumExt;
    app.album()
        .save(path.to_string_lossy().to_string(), filename.to_string())
}

#[cfg(not(target_os = "android"))]
fn save_with_platform(
    _app: &tauri::AppHandle,
    _path: &std::path::Path,
    _filename: &str,
) -> Result<usize, String> {
    Err("本平台不支持写入相册（桌面壳仅用于开发调试）".into())
}

/// 应用入口。桌面端由 `main.rs` 调用，移动端由 `#[tauri::mobile_entry_point]` 生成的胶水调用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_album::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(OpenedUris::default())
        .invoke_handler(tauri::generate_handler![take_opened_uris, save_image_to_album])
        .build(tauri::generate_context!())
        .expect("error while building weefuse")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = event {
                let mut guard = app.state::<OpenedUris>().0.lock().expect("OpenedUris 锁中毒");
                for url in &urls {
                    guard.push(url.to_string());
                }
                drop(guard);
                // **一个 URI 一条事件、payload 是字符串**（不是数组）：驱动的 `listen<string>("opened")`
                // 收到的就是单个 `content://…`。发数组会让 `payload.payload` 变成 `string[]`，
                // 而 `fileFromUri` 走的是 `typeof first !== "string"` 那条守卫 ⇒ 每次热启动分享都报
                // 「分享内容不是文件」。跨语言边界上的类型对不上是**静默形态**，所以这里逐条写清楚。
                for url in urls {
                    let _ = app.emit("opened", url.to_string());
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            {
                let _ = (app, event);
            }
        });
}
```

> **`RunEvent::Opened` 在桌面 target 上不存在**（它是 cfg 到 macOS / iOS / Android 的），所以上面
> 用 `#[cfg(...)]` 把整个 `if let` 圈住，并在非移动分支里显式用掉 `(app, event)`——否则
> `cargo check` 会在桌面 target 上报「未使用的变量」。**这也是 `cargo check` 能在 CI 的
> ubuntu 上跑的前提**（它编的是桌面 target）。

- [ ] **步骤 3：最小 Kotlin 插件（只回答「MediaStore 免不免权限」）**

`src-tauri/plugins/album/Cargo.toml`：

```toml
[package]
name = "tauri-plugin-album"
version = "0.1.0"
description = "把 PNG 写进 Android 系统相册（MediaStore）"
edition = "2021"

[build-dependencies]
tauri-plugin = { version = "2", features = ["build"] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`src-tauri/plugins/album/build.rs`：

```rust
const COMMANDS: &[&str] = &["save"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
```

`src-tauri/plugins/album/src/lib.rs`：

```rust
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
mod mobile;

/// 插件入口。桌面 / iOS 不注册任何命令——`save` 命令只存在于 Android。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("album");
    #[cfg(target_os = "android")]
    let builder = builder.setup(|app, api| {
        let handle = api.register_android_plugin("cn.tuzkimo.weefuse.album", "AlbumPlugin")?;
        app.manage(mobile::Album(handle));
        Ok(())
    });
    builder.build()
}

/// Rust 侧取插件句柄的扩展 trait。**消费者**：`src-tauri/src/lib.rs` 的 `save_with_platform`。
#[cfg(target_os = "android")]
pub trait AlbumExt<R: Runtime> {
    fn album(&self) -> &mobile::Album<R>;
}

#[cfg(target_os = "android")]
impl<R: Runtime, T: tauri::Manager<R>> AlbumExt<R> for T {
    fn album(&self) -> &mobile::Album<R> {
        self.state::<mobile::Album<R>>().inner()
    }
}
```

`src-tauri/plugins/album/src/mobile.rs`：

```rust
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{PluginHandle, PluginApi},
    Runtime,
};

/// Android 插件的 Rust 句柄。`save` 只把**路径**送过去（字节已经在临时文件里了）。
pub struct Album<R: Runtime>(pub PluginHandle<R>);

/// 送给 Kotlin 的参数。字段名与 Kotlin 侧 `SaveArgs` **逐字一致**。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavePayload {
    path: String,
    filename: String,
}

/// Kotlin `invoke.resolve(JSObject{uri, bytes})` 的镜像。
///
/// **为什么必须有一个结构体、不能写成 `::<String>`**（2026-10-06 控制者跨语言核对时抓到的接线缺陷）：
/// `run_mobile_plugin::<T>` 会把 Kotlin 的返回值按 `T` 反序列化，而 Kotlin 侧 resolve 的是**对象**
/// （`{"uri": …, "bytes": …}`）⇒ 写成 `String` 会在真机上以反序列化失败告终。这条链**只有真机跑得到**
/// （CI 里 `tauriDriver.ts` 不可执行），所以它**必须在纸面上就对得上**。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveResponse {
    /// MediaStore 返回的 `content://` URI；由 Rust 侧打印进日志，便于核对落点（见下方 `println!`）。
    uri: String,
    /// Kotlin **实际复制进相册**的字节数（第三层核对用它，见 `src-tauri/src/lib.rs`）。
    bytes: usize,
}

impl<R: Runtime> Album<R> {
    /// 交给 Kotlin 的 `@Command fun save`；**返回 Kotlin 报的实际写入字节数**（不是 Rust 自己数的）。
    /// Kotlin 侧 `invoke.reject` 时这里拿到错误原文并**原样上抛**（不吞）。
    pub fn save(&self, path: String, filename: String) -> Result<usize, String> {
        let response: SaveResponse = self
            .0
            .run_mobile_plugin("save", SavePayload { path, filename })
            .map_err(|error| format!("相册插件调用失败：{error}"))?;
        println!("AlbumPlugin::save 落到 {}", response.uri);
        Ok(response.bytes)
    }
}
```

`src-tauri/plugins/album/android/build.gradle.kts`：

```kotlin
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cn.tuzkimo.weefuse.album"
    // ★★ 下面三个值**不能照抄**：AGP 要求同一工程里所有 module 的 compileSdk 与 JVM target 一致，
    // 不一致会报「Inconsistent JVM-target compatibility」或 compileSdk 冲突。
    // 实现时**先读生成工程的实际值**，把它们对齐（三个值都以 `gen/android/app/build.gradle.kts` 为准）：
    //   Select-String -Path src-tauri/gen/android/app/build.gradle.kts -Pattern 'compileSdk|targetSdk|JavaVersion|JVM_|jvmTarget'
    // 并把读到的实际值写进 spike 报告。
    compileSdk = 36                      // ← 以 app 模块的实际值为准（Tauri 的模板可能更高）
    defaultConfig {
        minSdk = 29                      // 与 tauri.conf.json 的 bundle.android.minSdkVersion 对齐（D4）
    }
    compileOptions {
        // ← 以 app 模块的实际值为准：Tauri 的模板目前是 `JavaVersion.VERSION_1_8`，
        //   本计划早先写的 17 会与它冲突（2026-10-06 查官方模板后更正的**预测**，实测以 spike 为准）
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"                // ← 同上，与 app 模块的 `JvmTarget.JVM_1_8` 对齐
    }
}

dependencies {
    implementation(project(":tauri-android"))
}
```

> **为什么这一块必须「先读再写」而不是照抄**（2026-10-06 控制者查官方模板后的更正）：Tauri CLI 生成的
> `gen/android/app/build.gradle.kts` 里 `compileSdk` / `targetSdk` / `sourceCompatibility` / `jvmTarget`
> 都是**模板版本相关的**（查到的 dev 模板是 `compileSdk = 37` + `JavaVersion.VERSION_1_8` + `JVM_1_8`）。
> 插件的 gradle 与它不一致时 AGP 会**明确报错**（不是静默），但那一轮的实现者会卡在这里查半天——所以
> 在简报里就把「读三个值、对齐、把实际值写进报告」写成步骤。

`src-tauri/plugins/album/android/src/main/AndroidManifest.xml`：

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <!-- 刻意为空：API 29+ 用 MediaStore 插入不需要任何权限（本插件要证明的正是这一点）。 -->
</manifest>
```

`src-tauri/plugins/album/android/src/main/java/cn/tuzkimo/weefuse/album/AlbumPlugin.kt`：

```kotlin
package cn.tuzkimo.weefuse.album

import android.app.Activity
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class SaveArgs {
    // 这几个字段名必须与 Rust 侧 `SavePayload` 的 camelCase 序列化逐字一致（path / filename）。
    var path: String? = null
    var filename: String? = null
}

/**
 * 把临时文件复制进系统相册的 `Pictures/WeeFuse`。
 *
 * **只用 `MediaStore`，不申请任何权限**（本插件要回答的判据 D 就是「API 29+ 免不免权限」）。
 * 落点取 `RELATIVE_PATH` 而不是绝对路径：scoped storage 下后者不可写。
 */
@TauriPlugin
class AlbumPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun save(invoke: Invoke) {
        val args = invoke.parseArgs(SaveArgs::class.java)
        val sourcePath = args.path
        val filename = args.filename
        if (sourcePath == null || filename == null) {
            invoke.reject("保存失败：缺少路径或文件名")
            return
        }
        val source = File(sourcePath)
        if (!source.isFile) {
            invoke.reject("保存失败：临时文件不存在")
            return
        }
        try {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, filename)
                put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(
                        MediaStore.Images.Media.RELATIVE_PATH,
                        Environment.DIRECTORY_PICTURES + "/WeeFuse",
                    )
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
            }
            val resolver = activity.contentResolver
            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("MediaStore 插入返回了 null")
            resolver.openOutputStream(uri).use { output ->
                if (output == null) throw IllegalStateException("拿不到输出流")
                source.inputStream().use { input -> input.copyTo(output) }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            }
            invoke.resolve(uri.toString())
        } catch (error: Exception) {
            invoke.reject("写入相册失败：${error.message ?: error.javaClass.simpleName}")
        }
    }
}
```

> **`parseArgs` 的字段名与 `invoke.reject` 的消息**：Kotlin 侧拿不到 Rust 的 `SavePayload`
> 类型，两边靠 **camelCase 的 JSON 字段名**约定（`path` / `filename`）。这是移动插件最常见的
> 静默失败点，所以：① `SavePayload` 写了 `#[serde(rename_all = "camelCase")]`；② `SaveArgs`
> 的字段名与它逐字对应；③ 参数缺失时**响亮 reject**，不静默返回成功。

- [ ] **步骤 4：`Cargo.toml` 与 capabilities 接线**

`src-tauri/Cargo.toml` 的 `[dependencies]` 追加：

```toml
tauri-plugin-album = { path = "plugins/album" }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
```

`src-tauri/capabilities/default.json` 全文：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "本轮只放真正用到的权限：应用自己的命令（take_opened_uris / save_image_to_album）不需要 capability，插件命令才需要。",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "fs:allow-read-file",
    {
      "identifier": "fs:scope",
      "allow": [{ "path": "**" }]
    }
  ]
}
```

> **`fs:scope` 为什么给 `**`**：Android 上选择器交回的是 `content://…`，`plugin-fs` 在移动端把
> 它当**运行时授权**的 URI 处理，路径式 scope 管不到它；桌面端（仅开发调试）要在任意目录里试
> 文件。**这是一处放宽，必须记进报告**：将来若发现 scope 对 `content://` 真的生效，应收窄成
> 相册目录 + App 私有目录。

- [ ] **步骤 5：写探针页 `ShellProbePage.vue`（A / B 用裸 input，C–F 走能力层）**

**判据与走哪条路（刻意的分叉，不是不一致）**：**A / B 用裸 `<input type="file">`，不经能力层**——它们问的
就是「WebView 里这个 input 好不好使」；若经能力层，读到的会是驱动当前选定的那条实现，问题就被换掉了。
**C / D / E / F 走 `getPlatform()`**——它们问的是「交付路径通不通」。

`src/views/ShellProbePage.vue`：

```vue
<script lang="ts">
import type { AlbumSaveKind, ImagePickingKind } from "@/services/platform/types";
import type { SniffedImageType } from "@/services/platform/sniffImageType";

/**
 * `/lab/shell` 的读数结构（规格 §13 的六判据 F/A/B/C/D/E）。
 *
 * **结构化而不是一堆字符串**：本项目的纪律是「固定自问还有哪些输出 / 字段从未被任何断言读过」——
 * 把读数做成有字段的类型，用例才能逐字段钉住（字符串拼接里少一个字段是看不出来的）。
 * **消费者**：`src/views/__tests__/ShellProbePage.test.ts`（唯一消费者：生产路径不读这些结构）。
 */
export interface FileInputProbeReading {
  readonly criterion: "A" | "B";
  /** 该 input 在 DOM 上真的带着的属性值（证明 `accept` / `capture` 落到了元素上）。 */
  readonly accept: string;
  readonly capture: string;
  readonly name: string;
  readonly size: number;
  /** WebView 给的 `File.type`——可能是空串，正是要看它。 */
  readonly mimeFromWebView: string;
  /** 我们按魔数嗅探出来的类型。 */
  readonly mimeSniffed: SniffedImageType;
  /** 前 16 字节的十六进制（大写、空格分隔）。 */
  readonly magicHex: string;
  /** 解码结果：`宽×高`，或中文失败原因（`probeImageSize` 抛出的原文）。 */
  readonly decode: string;
}

export interface ShareProbeReading {
  readonly coldStart: string;
  readonly hotStart: string;
  readonly rawBody: string;
}

export interface AlbumProbeReading {
  readonly kind: AlbumSaveKind;
  readonly filename: string;
  readonly bytes: number;
  readonly result: string;
}

export interface LifecycleProbeReading {
  readonly requested: boolean;
  readonly backPresses: readonly string[];
  readonly closeRequests: readonly string[];
}

export interface BuildInfoProbeReading {
  readonly tauriRuntime: boolean;
  readonly userAgent: string;
  readonly href: string;
  readonly pickKind: ImagePickingKind;
  readonly canCapture: boolean;
  readonly shareSupported: boolean;
  readonly albumKind: AlbumSaveKind;
}

export interface ShellProbeReadings {
  readonly a: FileInputProbeReading | null;
  readonly b: FileInputProbeReading | null;
  readonly c: ShareProbeReading | null;
  readonly d: AlbumProbeReading | null;
  readonly e: LifecycleProbeReading | null;
  readonly f: BuildInfoProbeReading | null;
}
</script>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import {
  assertCanvasPainted,
  canvasToBlob,
  createCanvasStrict,
  requireContext2D,
} from "@/services/exporter";
import { getPlatform, isTauriRuntime } from "@/services/platform/capabilities";
import { sniffImageType } from "@/services/platform/sniffImageType";
import { probeImageSize } from "@/services/probe";

/**
 * `/lab/shell` 探针页（规格 §13 任务 2 的六判据装置）——**第三个开发期实验台**，与 `/lab/canvas` 同形：
 * 只在路由表里存在、**不进任何用户入口**、页面自标「开发期实验台 / CI 不测」、**留存**（换设备 / 换
 * Tauri 版本时还要重测）。
 *
 * **与 `/lab/canvas` 的关键差别**：那台仪器测的是本机能力（浏览器里也能跑），这一台测的是**壳本身**——
 * 必须在装到手机上的 APK 里跑（F 块就是用来把「跑的是哪个实现」说清楚的）。
 *
 * **CI 只覆盖「读数 → 表格与报告文本」这一段渲染**：真实 `capture` 行为、真实 `content://`、真实
 * MediaStore、真实返回键都在人工清单里（规格 §9.4）；页面上任何「看起来测到了」都不算。
 */

/** 判据 D 的探针图边长：64 够用（相册里那一眼要看的是**文件在不在、字节数对不对**，不是画质）。 */
const PROBE_EDGE = 64;

/** 兜底文案必须非空：空消息的 `Error` 要取 `name`，非 `Error` 要取 `String`。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message === "" ? error.name : error.message;
  return String(error);
}

const readings = reactive<ShellProbeReadings>({
  a: null,
  b: null,
  c: null,
  d: null,
  e: null,
  f: null,
});
const busy = ref<"" | "C" | "D">("");
const error = ref("");
const copyStatus = ref("");
const unsubscribers: Array<() => void> = [];

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

/** A / B 的读数：属性值 → 文件事实 → 嗅探 → 解码。**只读前 32 字节**（不把 10 MB 原图读进堆）。 */
async function readFileInput(
  criterion: "A" | "B",
  input: HTMLInputElement,
): Promise<FileInputProbeReading> {
  const capture = input.getAttribute("capture") ?? "（未设置）";
  const file = input.files?.[0] ?? null;
  if (file === null) {
    return {
      criterion,
      accept: input.accept,
      capture,
      name: "（未选中文件）",
      size: 0,
      mimeFromWebView: "",
      mimeSniffed: "application/octet-stream",
      magicHex: "",
      decode: "（未选中文件）",
    };
  }
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  let decode: string;
  try {
    const size = await probeImageSize(file);
    decode = `${size.width}×${size.height}`;
  } catch (caught) {
    decode = errorText(caught);
  }
  return {
    criterion,
    accept: input.accept,
    capture,
    name: file.name,
    size: file.size,
    mimeFromWebView: file.type,
    mimeSniffed: sniffImageType(head),
    magicHex: hexOf(head.subarray(0, 16)),
    decode,
  };
}

async function onRawInput(criterion: "A" | "B", event: Event): Promise<void> {
  try {
    const reading = await readFileInput(criterion, event.target as HTMLInputElement);
    if (criterion === "A") readings.a = reading;
    else readings.b = reading;
  } catch (caught) {
    error.value = `${criterion} 块读数失败：${errorText(caught)}`;
  }
}

/** 画一张探针图并取 PNG（C 的原始字节体探针与 D 共用：**同一个产物、两条不同的证据**）。 */
async function renderProbePng(): Promise<Blob> {
  const canvas = createCanvasStrict(PROBE_EDGE, PROBE_EDGE);
  const ctx = requireContext2D(canvas);
  ctx.fillStyle = "#3366cc";
  ctx.fillRect(0, 0, PROBE_EDGE, PROBE_EDGE);
  assertCanvasPainted(canvas);
  return canvasToBlob(canvas);
}

/**
 * C 块：**冷启动取走 + 原始字节体探针**。
 *
 * 两半**刻意用不同的载荷**：冷启动那一半证明 URI 可读（字节数就是证据，URI 原文在 `adb logcat` 的
 * `RunEvent::Opened` 行里）；原始字节体那一半用**探针图**走完整保存链。把分享进来那张图再存一次相册
 * 对判据没有增量，却会在相册里留下一个用 `.png` 名字的 JPEG。
 */
async function runC(): Promise<void> {
  busy.value = "C";
  error.value = "";
  const platform = getPlatform();
  let coldStart = "无待处理分享（把 App 从任务切换器划掉，再从相册 App 分享一张图进来）";
  try {
    const file = await platform.shareInbox.takeSharedImage();
    if (file !== null) {
      coldStart = `${file.name} / ${file.size} 字节 / ${file.type === "" ? "（空 MIME）" : file.type}`;
    }
  } catch (caught) {
    coldStart = `取走失败：${errorText(caught)}`;
  }

  let rawBody: string;
  try {
    const probe = await renderProbePng();
    await platform.album.save(probe, "weefuse-c-raw-body.png");
    rawBody = `端到端一致（${probe.size} 字节，探针图）`;
  } catch (caught) {
    rawBody = `失败：${errorText(caught)}`;
  }

  readings.c = {
    coldStart,
    hotStart: readings.c?.hotStart ?? "（尚未收到）",
    rawBody,
  };
  busy.value = "";
}

/** D 块：把**真画布产物**走一遍 `album.save`（§5.4.1 的三段链：真画布 → blob → 相册）。 */
async function runD(): Promise<void> {
  busy.value = "D";
  error.value = "";
  const platform = getPlatform();
  const filename = "weefuse-probe-album.png";
  let bytes = 0;
  let result: string;
  try {
    const blob = await renderProbePng();
    bytes = blob.size;
    await platform.album.save(blob, filename);
    result = "已受理（去相册 Pictures/WeeFuse 核对文件名与字节数）";
  } catch (caught) {
    result = errorText(caught);
  }
  readings.d = { kind: platform.album.kind, filename, bytes, result };
  busy.value = "";
}

/**
 * E 块：注册返回键与关闭请求的监听。
 *
 * `onExitRequested` 的 handler **返回 false（不阻止）**：探针页没有草稿可丢，而「让这次退出真的发生」
 * 才是判据 E 要看的。生产语义（`() => session.dirty`）在任务 7 的 `useShellLifecycle`。
 */
function runE(): void {
  if (readings.e !== null) return;
  const platform = getPlatform();
  try {
    unsubscribers.push(
      platform.lifecycle.onBackButton((info) => {
        const current = readings.e;
        if (current === null) return;
        readings.e = { ...current, backPresses: [...current.backPresses, `canGoBack=${info.canGoBack}`] };
      }),
    );
    unsubscribers.push(
      platform.lifecycle.onExitRequested(() => {
        const current = readings.e;
        if (current !== null) {
          readings.e = {
            ...current,
            closeRequests: [...current.closeRequests, "onExitRequested 被调用（探针返回 false：不阻止）"],
          };
        }
        return false;
      }),
    );
    readings.e = { requested: true, backPresses: [], closeRequests: [] };
  } catch (caught) {
    error.value = `E 块注册失败：${errorText(caught)}`;
  }
}

/** F 块：这一行是「APK 里跑的是浏览器实现还是 Tauri 实现」的唯一判据。 */
function runF(): void {
  const platform = getPlatform();
  readings.f = {
    tauriRuntime: isTauriRuntime(),
    userAgent: navigator.userAgent,
    href: location.href,
    pickKind: platform.imagePicking.kind,
    canCapture: platform.imagePicking.canCapture,
    shareSupported: platform.shareInbox.supported,
    albumKind: platform.album.kind,
  };
}

/** 页面级的「明确退出」（E 的第三半）：单独一个按钮——按下去 App 就没了，放进 E 块读数来不及看。 */
async function exitApp(): Promise<void> {
  try {
    await getPlatform().lifecycle.exit();
  } catch (caught) {
    error.value = `明确退出失败：${errorText(caught)}`;
  }
}

/**
 * 热启动订阅在**挂载时**注册：人从相册 App 分享进来时 WeeFuse 在后台——只有「App 启动时就订阅好」
 * 才接得住那一刻。C 按钮只负责取走冷启动那一份与跑 raw body 探针。
 */
onMounted(() => {
  try {
    unsubscribers.push(
      getPlatform().shareInbox.onSharedImage((file) => {
        const current = readings.c;
        readings.c = {
          coldStart: current?.coldStart ?? "（未跑，未取走冷启动分享）",
          hotStart: `${file.name} / ${file.size} 字节 / ${file.type === "" ? "（空 MIME）" : file.type}`,
          rawBody: current?.rawBody ?? "（未跑）",
        };
      }),
    );
  } catch (caught) {
    error.value = `热启动订阅失败：${errorText(caught)}`;
  }
});

onUnmounted(() => {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers.length = 0;
});

const readingA = computed(() => lineFileInput(readings.a));
const readingB = computed(() => lineFileInput(readings.b));
const readingC = computed(() => {
  const c = readings.c;
  if (c === null) return "未跑：点下面那个按钮取走冷启动分享；热启动已订阅。";
  return `冷启动：${c.coldStart} · 热启动：${c.hotStart} · 原始字节体：${c.rawBody}`;
});
const readingD = computed(() => {
  const d = readings.d;
  if (d === null) return "未跑：点下面那个按钮画一张探针图并存进相册。";
  return `落点：${d.kind} · 文件名：${d.filename} · 字节数：${d.bytes} · 结果：${d.result}`;
});
const readingE = computed(() => {
  const e = readings.e;
  if (e === null) return "未跑：点下面那个按钮注册监听，然后按系统返回键、再从任务切换器划掉 App。";
  return `已请求注册：是 · 返回键：${e.backPresses.length === 0 ? "（尚未触发）" : e.backPresses.join(" | ")} · 关闭请求：${e.closeRequests.length === 0 ? "（尚未触发）" : e.closeRequests.join(" | ")}`;
});
const readingF = computed(() => {
  const f = readings.f;
  if (f === null) return "未跑：点下面那个按钮读一次。";
  return `tauriRuntime=${f.tauriRuntime} · 相册选图形态=${f.pickKind} · 支持拍照=${f.canCapture} · 分享进入=${f.shareSupported ? "supported" : "unsupported"} · 保存落点=${f.albumKind} · UA=${f.userAgent} · ${f.href}`;
});

function lineFileInput(reading: FileInputProbeReading | null): string {
  if (reading === null) return "未跑：点下面那个输入框选一张图。";
  return `文件=${reading.name} · 字节数=${reading.size} · capture=${reading.capture} · WebView MIME=${reading.mimeFromWebView === "" ? "（空）" : reading.mimeFromWebView} · 嗅探 MIME=${reading.mimeSniffed} · 前 16 字节=${reading.magicHex === "" ? "（无）" : reading.magicHex} · 解码=${reading.decode}`;
}

/** 判定要点：**跟着读数一起被复制走**，人类伙伴不必回头翻计划。 */
const VERDICT_NOTES: readonly string[] = [
  "判定要点\tF\tAPK 装得上 + 首屏是图纸库 + 本行 tauriRuntime=true ⇒ 通过；false ⇒ 壳里跑的是浏览器实现（B5-R1）",
  "判定要点\tA\tA 能唤出系统选择器且「解码」是宽×高 ⇒ 通过（任务 3 把 pickImageFile 换成隐藏 input，并删掉 dialog 依赖与 dialog:allow-open 权限）；唤不出 / 解码失败 ⇒ 不通过（当前实现已是 dialog+fs 分支，无需改代码，B5-R2 记为已发生）",
  "判定要点\tB\t点按**直接进相机**且「解码」是宽×高 ⇒ 第 1 级成立；只出文件选择器 ⇒ 任务 4 走第 2 级（Kotlin capture 插件）；第 2 级也不通 ⇒ CAPTURE_SUPPORTED=false（不留半截入口）",
  "判定要点\tC\t「冷启动」或「热启动」给出文件名与字节数（URI 原文看 logcat 的 RunEvent::Opened 行）且「原始字节体」写「端到端一致（N 字节…）」⇒ 通过；写「请求体不是 Raw」⇒ B5-R4（退 base64 并写明原因）；「取走失败」⇒ B5-R3",
  "判定要点\tD\t「结果」写「已受理…」且相册 Pictures/WeeFuse 下出现该文件、字节数一致 ⇒ 通过；出现权限 / 拒绝 / insert 返回 null ⇒ 走 dialog.save()（B5-R5）",
  "判定要点\tE\t按返回键后「返回键」出现 canGoBack=… ⇒ 通过；划掉 App 时「关闭请求」出现条目 ⇒ 一并通过；**返回键不触发是缺陷**，**关闭请求不触发不构成缺陷**（B5-R6，如实记录）",
];

/** 把全部读数拼成制表符分隔的文本（照 `/lab/canvas` 的口径：这是本页对人类伙伴的核心交付物）。 */
function buildReportText(state: ShellProbeReadings, stamp: string): string {
  const rows: string[] = [];
  const push = (criterion: string, field: string, value: string): void => {
    rows.push([criterion, field, value].join("\t"));
  };

  for (const criterion of ["A", "B"] as const) {
    const reading = criterion === "A" ? state.a : state.b;
    if (reading === null) {
      push(criterion, "（未跑）", "在本块选一张图");
      continue;
    }
    push(criterion, "accept", reading.accept === "" ? "（空）" : reading.accept);
    push(criterion, "capture", reading.capture);
    push(criterion, "文件", reading.name);
    push(criterion, "字节数", String(reading.size));
    push(criterion, "WebView MIME", reading.mimeFromWebView === "" ? "（空）" : reading.mimeFromWebView);
    push(criterion, "嗅探 MIME", reading.mimeSniffed);
    push(criterion, "前 16 字节", reading.magicHex === "" ? "（无）" : reading.magicHex);
    push(criterion, "解码", reading.decode);
  }

  if (state.c === null) push("C", "（未跑）", "点「跑 C」");
  else {
    push("C", "冷启动分享", state.c.coldStart);
    push("C", "热启动分享", state.c.hotStart);
    push("C", "原始字节体", state.c.rawBody);
  }

  if (state.d === null) push("D", "（未跑）", "点「存到相册」");
  else {
    push("D", "落点", state.d.kind);
    push("D", "文件名", state.d.filename);
    push("D", "字节数", String(state.d.bytes));
    push("D", "结果", state.d.result);
  }

  if (state.e === null) push("E", "（未跑）", "点「注册 E 监听」");
  else {
    push("E", "已请求注册", state.e.requested ? "是" : "否");
    push("E", "返回键", state.e.backPresses.length === 0 ? "（尚未触发）" : state.e.backPresses.join(" | "));
    push("E", "关闭请求", state.e.closeRequests.length === 0 ? "（尚未触发）" : state.e.closeRequests.join(" | "));
  }

  if (state.f === null) push("F", "（未跑）", "点「读构建信息」");
  else {
    push("F", "是否 Tauri 运行时", String(state.f.tauriRuntime));
    push("F", "相册选图形态", state.f.pickKind);
    push("F", "支持拍照", String(state.f.canCapture));
    push("F", "分享进入", state.f.shareSupported ? "supported" : "unsupported");
    push("F", "保存落点", state.f.albumKind);
    push("F", "User-Agent", state.f.userAgent);
    push("F", "地址", state.f.href);
  }

  return [`/lab/shell 探针读数（${stamp}）`, "判据\t字段\t读数", ...rows, ...VERDICT_NOTES].join("\n");
}

const report = computed(() => buildReportText(readings, new Date().toLocaleString("zh-CN")));

async function copy(): Promise<void> {
  const text = report.value;
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) {
    copyStatus.value = "当前环境没有剪贴板 API：请手动选中下面的读数复制。";
    return;
  }
  try {
    await clipboard.writeText(text);
    copyStatus.value = `已复制 ${text.split("\n").length} 行到剪贴板。`;
  } catch (caught) {
    copyStatus.value = `复制失败：${errorText(caught)}；请手动选中下面的读数复制。`;
  }
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-6">
    <h1 class="text-2xl font-bold text-slate-900">壳能力六判据探针（B5 spike）</h1>

    <p data-testid="lab-notice" class="mt-2 max-w-3xl text-sm font-semibold text-amber-800">
      开发期实验台；CI 不测（<b>真实的 input / 相机 / content:// / MediaStore / 返回键只能在装到手机上的
      APK 里测，CI 只测这一页怎么把读数渲染成文本</b>）。它只在路由表里存在、<b>不进任何用户入口</b>。
    </p>
    <p class="mt-2 max-w-3xl text-sm text-slate-600">
      A / B 用<b>裸 <code>&lt;input type=file&gt;</code></b>（问的是 WebView 本身好不好使），
      C / D / E / F 走 <code>getPlatform()</code>（问的是交付路径通不通）。
    </p>

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button
        data-testid="probe-copy"
        class="rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-800"
        @click="copy"
      >
        复制为文本
      </button>
      <span data-testid="probe-copy-status" class="text-sm text-slate-500">{{ copyStatus }}</span>
    </div>

    <p v-if="error" data-testid="probe-error" class="mt-3 text-sm text-red-600">{{ error }}</p>

    <section class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">A · 相册输入（裸 input，不经能力层）</h2>
      <input
        data-testid="input-a"
        class="mt-2 block w-full rounded border border-slate-300 p-2 text-sm"
        type="file"
        accept="image/*"
        @change="onRawInput('A', $event)"
      />
      <p data-testid="reading-a" class="mt-2 break-all font-mono text-xs text-slate-700">{{ readingA }}</p>
    </section>

    <section class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">
        B · 拍照输入（裸 input + <code>capture="environment"</code>）
      </h2>
      <input
        data-testid="input-b"
        class="mt-2 block w-full rounded border border-slate-300 p-2 text-sm"
        type="file"
        accept="image/*"
        capture="environment"
        @change="onRawInput('B', $event)"
      />
      <p data-testid="reading-b" class="mt-2 break-all font-mono text-xs text-slate-700">{{ readingB }}</p>
    </section>

    <section class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">C · 分享进入 + 原始字节体（走能力层）</h2>
      <p class="mt-1 text-xs text-slate-500">
        热启动订阅已在本页挂载时注册。URI 原文看 <code>adb logcat</code> 里的 <code>RunEvent::Opened</code> 行。
      </p>
      <button
        data-testid="probe-run-c"
        class="mt-2 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        :disabled="busy !== ''"
        @click="runC"
      >
        {{ busy === "C" ? "跑 C 中…" : "跑 C：取走冷启动分享 + 发一次原始字节体" }}
      </button>
      <p data-testid="reading-c" class="mt-2 break-all font-mono text-xs text-slate-700">{{ readingC }}</p>
    </section>

    <section class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">D · 存相册（走能力层）</h2>
      <button
        data-testid="probe-run-d"
        class="mt-2 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        :disabled="busy !== ''"
        @click="runD"
      >
        {{ busy === "D" ? "存 D 中…" : "跑 D：画一张探针图并存进相册" }}
      </button>
      <p data-testid="reading-d" class="mt-2 break-all font-mono text-xs text-slate-700">{{ readingD }}</p>
    </section>

    <section class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">E · 返回键与关闭请求（走能力层）</h2>
      <button
        data-testid="probe-run-e"
        class="mt-2 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        :disabled="readings.e !== null"
        @click="runE"
      >
        {{ readings.e === null ? "注册 E 监听" : "已注册" }}
      </button>
      <p data-testid="reading-e" class="mt-2 break-all font-mono text-xs text-slate-700">{{ readingE }}</p>
    </section>

    <section class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">F · 构建信息（走能力层）</h2>
      <button
        data-testid="probe-run-f"
        class="mt-2 rounded bg-slate-900 px-4 py-2 text-sm text-white"
        @click="runF"
      >
        读构建信息
      </button>
      <p data-testid="reading-f" class="mt-2 break-all font-mono text-xs text-slate-700">{{ readingF }}</p>
    </section>

    <div class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">页面级：明确退出 App（判据 E 的第三半）</h2>
      <p class="mt-1 text-xs text-slate-500">
        它不在六块之内：按下去 App 就没了，放进 E 块读数来不及看。干净状态下按返回键走到根时，生产实现
        走的也是这一条（<code>lifecycle.exit()</code>）。
      </p>
      <button
        data-testid="probe-exit"
        class="mt-2 rounded border border-red-300 bg-white px-4 py-2 text-sm text-red-700"
        @click="exitApp"
      >
        明确退出 App
      </button>
    </div>

    <p class="mt-6 max-w-3xl text-xs text-slate-500">
      两条如实标注：① A / B **不经能力层**，所以它们与「任务 3 / 4 最终选哪条实现」无关；
      ② 本页在浏览器里也能打开（<code>npm run dev</code> → <code>/lab/shell</code>），那时 F 块会如实写
      <code>tauriRuntime=false</code>、A–E 读到的是浏览器实现。判据 C / D 都会往系统相册写探针文件，
      跑完记得删掉。
    </p>
  </main>
</template>
```
- [ ] **步骤 6：路由与路由用例（只追加）**

`src/router/index.ts` 追加一条（与 `/lab/canvas` 同构）：

```ts
  // /lab/shell 是任务 2 的六判据探针页（**开发期实验台**，不进任何用户入口、页面自标；判据 A–F 的原始
  // 读数由人类伙伴从这一页复制进 B5 spike 报告）。它**留存**为第三个实验台——与 `/lab/decode`、
  // `/lab/canvas` 并列：换设备 / 换 Tauri 版本时还要重测。
  { path: "/lab/shell", name: "shell-lab", component: () => import("@/views/ShellProbePage.vue") },
```

`src/router/__tests__/index.test.ts`：顶部加一行 import（追加用例的必然结果），并在 `describe` 内**末尾追加**一条（既有 4 条一字不动）：

```ts
import ShellProbePage from "@/views/ShellProbePage.vue";
```

```ts
  // `name` + `path` 两条断言挡不住「component 指错页面」：懒加载路由的 `components.default` 是一个
  // **loader 函数**（`router.resolve` 不会调它），所以必须自己跑一次 loader 再做恒等比较。
  // 写法取自同一文件里 `/new` 与 `/new/setup` 那两条（既有先例：不做只断 path 的弱断言）。
  it("/lab/shell 是六判据探针页：名字 shell-lab、路径 /lab/shell、组件就是 ShellProbePage", async () => {
    const route = router.resolve({ name: "shell-lab" });

    expect(route.name).toBe("shell-lab");
    expect(route.path).toBe("/lab/shell");

    const loader = route.matched[0]?.components?.default;
    expect(typeof loader).toBe("function");
    const mod = await (loader as unknown as () => Promise<{ default: unknown }>)();
    expect(mod.default).toBe(ShellProbePage);
  });
```

- [ ] **步骤 7：探针页用例（4 条）**

`src/views/__tests__/ShellProbePage.test.ts`：

```ts
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPlatform } from "@/services/platform/browserPlatform";
import { setPlatform } from "@/services/platform/capabilities";
import type {
  AlbumSaver,
  AppLifecycle,
  ImagePicking,
  Platform,
  ShareInbox,
} from "@/services/platform/types";
import { probeImageSize } from "@/services/probe";
import ShellProbePage, { type FileInputProbeReading } from "@/views/ShellProbePage.vue";

/**
 * `/lab/shell` 探针页的组件用例（规格 §9.4 的边界：真实 input / 相机 / content:// / MediaStore /
 * 返回键**一条都测不到**）。
 *
 * **这一份能证明的四件事**：
 * ① 页首自标「开发期实验台 / CI 不测 / 不进任何用户入口」，六块各有触发点，未跑时报告如实写「（未跑）」；
 * ② 判据 A / B **走裸 input 且完全不碰能力层**（把 A 改成调 `pickFromAlbum` 这条必红）；
 * ③ 判据 C / D 走 `getPlatform()`：C 的载荷是探针图、D 的载荷是 `canvasToBlob` 产出的那颗 blob
 *    （**恒等比较**），两条的文件名与字节数都被读过；
 * ④ 判据 E / F 走 `getPlatform()`：E 的 handler 返回值原样透传（探针**不阻止**退出）、卸载时解绑函数都被
 *    调用；F 的读数逐字来自注入的平台（这就是「APK 里跑的是哪个实现」的判据）。
 *
 * **哪些是桩**：`@/services/exporter` 整个模块（happy-dom 没有真 canvas）、`@/services/probe` 的
 * `probeImageSize`（解码是桩）、`navigator.clipboard`、以及 `setPlatform` 注入的假平台。
 * **桩里没有任何 Tauri**：这一页与 `@tauri-apps/*` 之间隔着能力层。
 */

const PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x48, 0x44, 0x52,
]);
const PNG_HEX = "89 50 4E 47 0D 0A 1A 0A 00 00 00 00 49 48 44 52";

// `canvasToBlob` **每次返回同一个 Blob 实例**，用例才能对 D 的实参做恒等比较。
vi.mock("@/services/exporter", () => {
  const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
  const context = { fillStyle: "", fillRect: (): void => {} };
  return {
    createCanvasStrict: (_width: number, _height: number) => ({ getContext: () => context }),
    requireContext2D: (_canvas: unknown) => context,
    canvasToBlob: async (_canvas: unknown) => blob,
    assertCanvasPainted: (_canvas: unknown): void => {},
  };
});

vi.mock("@/services/probe", () => ({
  probeImageSize: vi.fn(async (_source: Blob) => ({ width: 4032, height: 3024 })),
}));

const mockedProbeSize = vi.mocked(probeImageSize);

interface PlatformOverrides {
  readonly imagePicking?: Partial<ImagePicking>;
  readonly shareInbox?: Partial<ShareInbox>;
  readonly album?: Partial<AlbumSaver>;
  readonly lifecycle?: Partial<AppLifecycle>;
}

/** 假平台：默认取浏览器实现（四个成员都是真的、无副作用），只覆盖本用例关心的那几个。 */
function fakePlatform(overrides: PlatformOverrides = {}): Platform {
  return {
    imagePicking: { ...browserPlatform.imagePicking, ...overrides.imagePicking },
    shareInbox: { ...browserPlatform.shareInbox, ...overrides.shareInbox },
    album: { ...browserPlatform.album, ...overrides.album },
    lifecycle: { ...browserPlatform.lifecycle, ...overrides.lifecycle },
  };
}

const originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");

function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

function hideClipboard(): void {
  Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true });
}

/** 给裸 input 塞一个选中项：happy-dom 不会真的选文件，`files` 是只读的，所以直接定义它。 */
function selectFile(input: { element: Element }, file: File | null): void {
  Object.defineProperty(input.element, "files", {
    value: file === null ? [] : [file],
    configurable: true,
  });
}

async function copiedText(wrapper: ReturnType<typeof mount>): Promise<string> {
  await wrapper.get('[data-testid="probe-copy"]').trigger("click");
  await flushPromises();
  const writeText = vi.mocked(window.navigator.clipboard.writeText);
  return String(writeText.mock.calls[0]?.[0] ?? "");
}

afterEach(() => {
  setPlatform(browserPlatform);
  if (originalClipboard === undefined) Reflect.deleteProperty(window.navigator, "clipboard");
  else Object.defineProperty(window.navigator, "clipboard", originalClipboard);
  vi.restoreAllMocks();
  mockedProbeSize.mockResolvedValue({ width: 4032, height: 3024 });
});

describe("/lab/shell 探针页", () => {
  it("页首自标「开发期实验台 / CI 不测 / 不进任何用户入口」，六块各有触发点，未跑时报告如实写「（未跑）」", async () => {
    stubClipboard();
    const wrapper = mount(ShellProbePage);

    const notice = wrapper.get('[data-testid="lab-notice"]').text();
    expect(notice).toContain("开发期实验台");
    expect(notice).toContain("CI 不测");
    expect(notice).toContain("不进任何用户入口");

    // A / B 的触发点是裸 input（属性要在 DOM 上真的带着——B 的 `capture` 就是判据本身）
    expect(wrapper.get('[data-testid="input-a"]').attributes("accept")).toBe("image/*");
    expect(wrapper.get('[data-testid="input-a"]').attributes("capture")).toBeUndefined();
    expect(wrapper.get('[data-testid="input-b"]').attributes("capture")).toBe("environment");
    // C–F 的触发点是按钮
    for (const criterion of ["c", "d", "e", "f"] as const) {
      expect(wrapper.find(`[data-testid="probe-run-${criterion}"]`).exists()).toBe(true);
    }
    // 「明确退出」不在六块之内（它会立刻关掉 App）
    expect(wrapper.find('[data-testid="probe-exit"]').exists()).toBe(true);

    for (const criterion of ["a", "b", "c", "d", "e", "f"] as const) {
      expect(wrapper.get(`[data-testid="reading-${criterion}"]`).text()).toContain("未跑");
    }

    const copied = await copiedText(wrapper);
    expect(copied).toContain("判据\t字段\t读数");
    for (const criterion of ["A", "B", "C", "D", "E", "F"] as const) {
      expect(copied).toContain(`${criterion}\t（未跑）\t`);
    }
    // 判定要点跟着读数一起走（人不必回头翻计划）
    expect(copied).toContain("判定要点\tC\t");
    expect(wrapper.get('[data-testid="probe-copy-status"]').text()).toContain("已复制");

    // 没有剪贴板 API 时的兜底分支
    hideClipboard();
    await wrapper.get('[data-testid="probe-copy"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="probe-copy-status"]').text()).toContain("没有剪贴板 API");

    wrapper.unmount();
  });

  it("A / B 是裸 input：读数由 input 自己产出（名字/字节数/嗅探/魔数/解码），且**完全不碰能力层**", async () => {
    const pickFromAlbum = vi.fn(async () => null);
    const capturePhoto = vi.fn(async () => null);
    setPlatform(fakePlatform({ imagePicking: { pickFromAlbum, capturePhoto } }));
    stubClipboard();
    const wrapper = mount(ShellProbePage);

    const file = new File([PNG_HEAD], "从相册选的图.png", { type: "image/png" });
    const inputA = wrapper.get('[data-testid="input-a"]');
    selectFile(inputA, file);
    await inputA.trigger("change");
    await flushPromises();

    const readingA: FileInputProbeReading = {
      criterion: "A",
      accept: "image/*",
      capture: "（未设置）",
      name: "从相册选的图.png",
      size: PNG_HEAD.length,
      mimeFromWebView: "image/png",
      mimeSniffed: "image/png",
      magicHex: PNG_HEX,
      decode: "4032×3024",
    };
    const lineA = wrapper.get('[data-testid="reading-a"]').text();
    expect(lineA).toContain(`文件=${readingA.name}`);
    expect(lineA).toContain(`字节数=${readingA.size}`);
    expect(lineA).toContain(`嗅探 MIME=${readingA.mimeSniffed}`);
    expect(lineA).toContain(`前 16 字节=${readingA.magicHex}`);
    expect(lineA).toContain(`解码=${readingA.decode}`);
    expect(wrapper.get('[data-testid="input-a"]').attributes("capture")).toBeUndefined();

    // B 也走同一条路（裸 input），只是属性不同
    const inputB = wrapper.get('[data-testid="input-b"]');
    selectFile(inputB, new File([PNG_HEAD], "拍的.png", { type: "image/png" }));
    await inputB.trigger("change");
    await flushPromises();
    expect(wrapper.get('[data-testid="reading-b"]').text()).toContain("capture=environment");

    // ★ 判据 A / B 的定义：**不经能力层**
    expect(pickFromAlbum).not.toHaveBeenCalled();
    expect(capturePhoto).not.toHaveBeenCalled();
    expect(mockedProbeSize).toHaveBeenCalledTimes(2);

    const copied = await copiedText(wrapper);
    expect(copied).toContain("A\tcapture\t（未设置）");
    expect(copied).toContain(`A\t文件\t${readingA.name}`);
    expect(copied).toContain(`A\t字节数\t${readingA.size}`);
    expect(copied).toContain("A\t嗅探 MIME\timage/png");
    expect(copied).toContain(`A\t前 16 字节\t${PNG_HEX}`);
    expect(copied).toContain("A\t解码\t4032×3024");
    expect(copied).toContain("B\tcapture\tenvironment");

    // 解码失败那一支也要如实进读数（不许留空）——判据 A / B 的失败形态就是它
    mockedProbeSize.mockRejectedValueOnce(new Error("图片解码失败（假平台）"));
    selectFile(inputA, new File([PNG_HEAD], "坏图.png", { type: "image/png" }));
    await inputA.trigger("change");
    await flushPromises();
    expect(wrapper.get('[data-testid="reading-a"]').text()).toContain("解码=图片解码失败（假平台）");

    wrapper.unmount();
  });

  it("C / D 走能力层：C 取走冷启动分享 + 探针图走保存链；D 保存的是 canvasToBlob 产出的那颗 blob（恒等）", async () => {
    const shared = new File([PNG_HEAD], "相册图片.png", { type: "image/png" });
    const takeSharedImage = vi.fn(async () => shared);
    const save = vi.fn(async (_blob: Blob, _filename: string) => {});
    setPlatform(
      fakePlatform({
        shareInbox: { supported: true, takeSharedImage },
        album: { kind: "album", save },
      }),
    );
    stubClipboard();
    const wrapper = mount(ShellProbePage);

    await wrapper.get('[data-testid="probe-run-c"]').trigger("click");
    await flushPromises();
    expect(takeSharedImage).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    const readingC = wrapper.get('[data-testid="reading-c"]').text();
    expect(readingC).toContain("冷启动：相册图片.png / 12 字节 / image/png");
    expect(readingC).toContain("原始字节体：端到端一致（4 字节，探针图）");

    await wrapper.get('[data-testid="probe-run-d"]').trigger("click");
    await flushPromises();
    expect(save).toHaveBeenCalledTimes(2);
    // ★ 接线断言：D 的载荷**就是** `canvasToBlob` 产出的那一颗（不是另建的一颗），文件名由页面给出
    const canvasBlob = await (await import("@/services/exporter")).canvasToBlob(
      {} as unknown as HTMLCanvasElement,
    );
    expect(save.mock.calls[1]?.[0]).toBe(canvasBlob);
    expect(save.mock.calls[1]?.[1]).toBe("weefuse-probe-album.png");
    expect(save.mock.calls[0]?.[1]).toBe("weefuse-c-raw-body.png");
    const readingD = wrapper.get('[data-testid="reading-d"]').text();
    expect(readingD).toContain("落点：album");
    expect(readingD).toContain("文件名：weefuse-probe-album.png");
    expect(readingD).toContain("字节数：4");
    expect(readingD).toContain("已受理");

    // 保存失败要把**驱动/插件给的中文原因**如实显示出来（§5.4「不静默」）
    save.mockRejectedValueOnce(new Error("MediaStore 拒绝插入（insert 返回 null）"));
    await wrapper.get('[data-testid="probe-run-d"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="reading-d"]').text()).toContain(
      "结果：MediaStore 拒绝插入（insert 返回 null）",
    );

    wrapper.unmount();
  });

  it("E / F 走能力层：探针**不阻止**退出（handler 返回 false）、卸载时解绑；F 的读数逐字来自注入的平台", async () => {
    let backHandler: ((info: { readonly canGoBack: boolean }) => void) | null = null;
    let closeHandler: (() => boolean) | null = null;
    const unbindBack = vi.fn(() => {});
    const unbindClose = vi.fn(() => {});
    const unbindShare = vi.fn(() => {});
    const exit = vi.fn(async () => {});
    setPlatform(
      fakePlatform({
        imagePicking: { kind: "native-picker", canCapture: true },
        shareInbox: { supported: true, onSharedImage: () => unbindShare },
        lifecycle: {
          onBackButton: (handler) => {
            backHandler = handler;
            return unbindBack;
          },
          onExitRequested: (handler) => {
            closeHandler = handler;
            return unbindClose;
          },
          exit,
        },
      }),
    );
    stubClipboard();
    const wrapper = mount(ShellProbePage);
    await flushPromises();

    const runE = wrapper.get('[data-testid="probe-run-e"]');
    await runE.trigger("click");
    await flushPromises();
    expect(backHandler).not.toBeNull();
    expect(closeHandler).not.toBeNull();

    // 探针的退出请求 handler **返回 false**（让退出真的发生，才能确认事件本身触发了）
    expect(closeHandler!()).toBe(false);
    backHandler!({ canGoBack: true });
    await flushPromises();
    const readingE = wrapper.get('[data-testid="reading-e"]').text();
    expect(readingE).toContain("已请求注册：是");
    expect(readingE).toContain("返回键：canGoBack=true");
    expect(readingE).toContain("关闭请求：onExitRequested 被调用");
    expect(runE.attributes("disabled")).toBeDefined(); // 幂等：不许注册第二份

    await wrapper.get('[data-testid="probe-run-f"]').trigger("click");
    await flushPromises();
    const readingF = wrapper.get('[data-testid="reading-f"]').text();
    expect(readingF).toContain("tauriRuntime=false"); // happy-dom 里没有 isTauri
    expect(readingF).toContain("相册选图形态=native-picker");
    expect(readingF).toContain("支持拍照=true");
    expect(readingF).toContain("分享进入=supported");
    expect(readingF).toContain("保存落点=album");

    await wrapper.get('[data-testid="probe-exit"]').trigger("click");
    await flushPromises();
    expect(exit).toHaveBeenCalledTimes(1);

    // 页面卸载 ⇒ 解绑函数都被调用（含挂载时注册的热启动订阅）
    wrapper.unmount();
    expect(unbindBack).toHaveBeenCalledTimes(1);
    expect(unbindClose).toHaveBeenCalledTimes(1);
    expect(unbindShare).toHaveBeenCalledTimes(1);
  });
});
```
- [ ] **步骤 8：构建 + 装机（判据 F）+ 一次性入口脚手架（片段裁定 4）**

**先说清问题**：APK 里**没有地址栏**，而 `/lab/*` 按约定不进任何用户入口 ⇒ 探针页在壳里**没有入口**。
B4 的清单 3 是在**手机浏览器**里跑的（`npx tauri --host` → `http://<PC-IP>:1420/lab/canvas`），壳里没有这条退路。

**处置**：一次性脚手架 **S1**——在 `src/router/index.ts` 的 `routes` **最前面**临时加一行

```ts
  // 【一次性脚手架 S1，本任务结束前必须删除】让真机能进 /lab/shell。
  { path: "/", redirect: { name: "shell-lab" } },
```

**两次构建，职责不同**：

1. **不带脚手架的构建**（先做）：`npx tauri android build --apk --debug` → 装到手机 → **判据 F 的验收**：
   打得开、首屏是**图纸库**（不是探针页）；
2. **带脚手架的构建**（后做）：加上 S1 那一行 → 重新构建安装 → 打开就直接落在 `/lab/shell`，
   跑判据 F② / A / B / C / D / E。

**删除与验证**（本任务收尾的硬动作）：删掉 S1 → 跑 `npm run test` + `npm run build` →
`git diff src/router/index.ts` 里**不许**出现 `redirect`（用 `Select-String -Path src/router/index.ts -Pattern "redirect"`
确认零命中）→ 再把这一步的原始输出记进报告。**替代路径**（若临时改路由表不被接受）：桌面 Chrome
的 `chrome://inspect` 连上手机 WebView，在控制台执行 `location.href = "/lab/shell"`——两条路都可行时
**优先 S1**（它不依赖 USB 调试）。

**装机的两种方式**（`adb devices` 现在为空）：USB 数据线 + `adb install -r <apk>`；或把 APK 拷进
手机用文件管理器安装（需允许「安装未知应用」）。**用哪一种写进报告**。

**逐条点按由人类伙伴执行**：F② / A / B / C / D / E，然后「复制为文本」把整段读数贴回报告；
判据 C 的分享那一步要先把 App 从任务切换器划掉 → 去相册 App 选一张图 →「分享」→ 选「一起拼豆」，
回到探针页点「跑 C」（后再做一次热启动：App 停在探针页不关，再分享一张**不同的**图，看「热启动」那一行）；
判据 E 点「注册 E 监听」后按返回键、再从任务切换器划掉 App（**先把读数复制走**，划掉会把 App 杀掉）。

- [ ] **步骤 9：spike 报告（不入库）**

`​.superpowers/sdd/2026-10-06-app-b5-spike/report.md`，逐栏填：

| 栏 | 填什么 |
|---|---|
| 环境 | 手机型号、Android 版本、系统 WebView 版本（F 块的 User-Agent 里）、APK 路径与体积、两次构建的耗时 |
| F① | 不带脚手架那次：装上了吗？首屏是图纸库吗？（安装被拦 / 闪退 / 白屏三个问题都没有） |
| F② | 带脚手架那次：`tauriRuntime=` 那一行 |
| A | A 块**整段原文**（8 行：accept / capture / 文件 / 字节数 / WebView MIME / 嗅探 MIME / 前 16 字节 / 解码） |
| B | B 块**整段原文**（同上 8 行；重点：点按后是进相机，还是仍进文件选择器） |
| C | C 块整段 + `adb logcat` 的 `RunEvent::Opened：…` / `save_image_to_album：收到原始字节体 …` / `AlbumPlugin::save 落到 content://…` 三行原文 |
| D | D 块整段 + 相册 `Pictures/WeeFuse` 下的文件名与字节数（人工看） |
| E | E 块整段 + 返回键与划掉两次的表现（含 logcat 原文） |
| 判定 | 六条判据逐条的「可用 / 不可用」，以及不可用时 pass 2 走哪条降级（见下） |
| 已知偏差 | 本任务里放宽过的东西（`fs:scope` / AndroidManifest / S1 脚手架已删）与没做到的事 |

**判定规则（写死，不许临场改）**

| 判据 | 算「可用」的读数 | 算「不可用」的读数 ⇒ pass 2 走哪条 |
|---|---|---|
| F | APK 装得上、打得开、首屏是**图纸库**；F 块 `tauriRuntime=true` | 构建失败 / 装不上 / 打不开 / `tauriRuntime=false` ⇒ **停下来**，按规格 §11 的 B5-R1 三级处理（装 SDK 组件需先问人类伙伴 / 换 NDK / 当场重估范围） |
| A | `<input type=file>` 能唤出系统选择器、选出的 `File` 能解码（A 块「解码」是 `宽×高`） | 唤不出 / 解码失败 ⇒ **无需改代码**（当前 `pickImageFile` 已经是 dialog + fs 分支，也已由 D 块顺带验过它能存进相册），把 B5-R2 记为「已发生、已按 dialog 降级」。**反向也要办**：A 可用 ⇒ 任务 3 把 `pickImageFile` 换成隐藏 input（零依赖），并**删掉** `tauri-plugin-dialog` 依赖与 `dialog:allow-open` 权限 |
| B | 点按**直接进相机**且「解码」是 `宽×高` | 只出文件选择器 / 相机起不来 ⇒ 任务 4 走第 2 级（Kotlin `ACTION_IMAGE_CAPTURE`）；第 2 级也不通 ⇒ `CAPTURE_SUPPORTED = false`、UI 不渲染入口、README 写明未交付 |
| C | 「冷启动」或「热启动」给出文件名与字节数（URI 原文见 logcat）；「原始字节体」写 `端到端一致（N 字节…）` | 收不到 URI / 取走失败 ⇒ B5-R3（Kotlin 把流复制到 cache）；「原始字节体」写 `请求体不是 Raw` ⇒ B5-R4（退 base64 并写明原因） |
| D | 「结果」写「已受理…」；相册里出现该文件；**字节数与读数一致**；**没有**弹任何权限请求 | 出现权限 / 拒绝 / `insert 返回 null` / 相册里没有 ⇒ B5-R5：降级 `dialog.save()`（规格 D2），README 写明「保存位置由用户选择」 |
| E | 按返回键后「返回键」出现 `canGoBack=…`；划掉 App 时「关闭请求」出现条目 | **返回键不触发是缺陷**（任务 7 查插件注册与 manifest）；**关闭请求不触发不构成缺陷**（B5-R6，如实记录：返回键三分支已覆盖） |

- [ ] **步骤 9b：把「零判别力」的口子如实登记（不许含糊过去）**

本任务引入了三样**在 CI 里证明不了自己**的东西。它们不是缺陷，但**必须**写进报告与构建记录，否则后人会把「有代码」当成「已验证」：

1. **`tauriDriver.ts` 在 happy-dom 下不可执行**：它 `import` 的每个包在 import 期都读 `window.__TAURI_INTERNALS__`，而 happy-dom 没有。所以**信封布局**（`[u32 LE][名字][字节]`）、**字节核对**（`written !== bytes.length`）、**`exitApp()`** 三处在 CI 里**零判别力**。判别力在真机判据 C / D（读数里那句「端到端一致（N 字节）」就是它）。
2. **Rust `take_opened_uris` 的「取走即清」零判别力**：本轮 CI 只对 Rust 跑 `cargo check`（规格 §6.3 明确写了不跑 Android target、不做 Rust 单测）。判别力在真机判据 C 的两次（冷启动取走之后**再按一次**必须仍是「无待处理分享」）。
3. **`pickImageFile` 的 dialog + fs 分支零判别力**（CI 里不会真的开选择器）：它的判别力是 A 块读数；**pass 2 若 A 可用，它连同 `tauri-plugin-dialog` 依赖与 `dialog:allow-open` 权限一起删**。

⇒ 报告里必须逐条出现上面三句，并写清各自的判别力落在哪一条真机读数上。

- [ ] **步骤 10：三跑 + 变异**

```powershell
npm run test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

预期：`npm run test` = **69 文件 / 1186 用例**（任务 1 之后 66/1163 + 本任务 3 个新测试文件 23 条：sniffImageType 10 + tauriPlatform 8 + 探针页 4 + 路由追加 1；**以实跑数字为准**），其中**只有 1 条故意红（G4）**——**G1 与 G3b 在本任务转绿**（`tauriDriver.ts` 已存在且是唯一含 `@tauri-apps/` 的文件；`main.ts` 已按 `isTauriRuntime()` 选择实现）；`npm run build` 通过；`cargo check` exit 0。

变异（在已提交的树上、逐条自证替换生效、还原后确认全绿，**红数不许预估**）：

| ID | 改哪一行 | 期望红 |
|---|---|---|
| V1 | `tauriPlatform.ts` 的 `album.save` 删掉 `requireSavableBlob(blob, filename);` 整行 | 「save：…两条守卫…」用例（双红：不再抛，且驱动**被调用了**） |
| V2 | `tauriPlatform.ts` 的 `capturePhoto` 删掉开头的 `if (!canCapture) throw …` | 「canCapture：驱动不提供 captureImageFile…」用例 |
| V3 | `tauriPlatform.ts` 的 `requireFileOrNull` 里 `throw new Error(message);` 改成 `return null;` | 「pickFromAlbum：…非 File…」+「canCapture：…守返回值」+「takeSharedImage：…」三条 |
| V4 | `tauriPlatform.ts` 的 `bindLate` 里 `if (disposed) unbind(); else unlisten = unbind;` 改成 `unlisten = unbind;` | 「解绑：…注册完成之前解绑」用例（`unlistenLate` 不会再被调用） |
| V5 | `sniffImageType.ts` 的 `startsWith` 删掉 `if (bytes.length < offset + pattern.length) return false;` | `sniffImageType.test.ts` 的「截断字节」那条 |
| V6 | `ShellProbePage.vue` 的 A / B 改成走 `getPlatform().imagePicking.pickFromAlbum()` | 「A / B 是裸 input…完全不碰能力层」用例 |
| V7 | `ShellProbePage.vue` 的 `runD` 把 `platform.album.save(...)` 换成直调 `downloadBlob(blob, filename)` | 「C / D 走能力层…」用例（假平台的 `save` 第二次不会被调用） |
| **V8** | `tauriDriver.ts` 的 `saveToAlbum` 里 `if (written !== bytes.length) { throw … }` 整段删掉 | **CI 里一条都不红**（本文件在 happy-dom 下不可执行）——**如实登记**：判别力在真机判据 C/D（相册文件字节数 vs 读数） |
| **V9** | `src-tauri/src/lib.rs` 的 `take_opened_uris` 把 `std::mem::take(…)` 换成 `.clone()` | **CI 里一条都不红**（Rust 无单测，`cargo check` 照样过）——判别力在真机判据 C 的「再按一次跑 C」 |

填回：`V1 → ? 红  V2 → ? 红  V3 → ? 红  V4 → ? 红  V5 → ? 红  V6 → ? 红  V7 → ? 红  V8 → 0 红（预期）  V9 → 0 红（预期）`

> **V8 / V9 是刻意留的两条「应当不红」**：它们把「哪些语义在 CI 里没有判别力」写成**结论**而不是含糊过去
> （B4 账本里 G-12 的 0 红就是这么被记下来的）。**两条都必须真的跑一次并在报告里留档**；
> **不许**为了让它红去补一条假断言。

- [ ] **步骤 11：把 spike 的判定写回计划（pass 2 的依据）**

在**本节末尾**追加一段 `#### spike 判定回填（实现者填，控制者复核）`，逐条写下六判据的最终分支选择（A/B/C/D/E 各选了哪条实现），并列出它对 pass 2 任务 3–7 的具体影响（例如「A 走 dialog ⇒ 任务 3 删掉真机 input 那条路」）。这段是 pass 2 计划写作的输入。

- [ ] **步骤 12：Commit**

```powershell
git add src/services/platform/tauriDriver.ts src/views/ShellProbePage.vue src/views/__tests__/ShellProbePage.test.ts src/router src-tauri
git commit -m "feat(app): /lab/shell 壳能力探针页、Tauri 驱动、Rust 命令与最小区块相册插件"
```

（`.superpowers/**` 被 gitignore，报告不进这个提交。）

> **任务 2 到此结束。计划第二遍**（任务 3–7：相册接线 / 拍照 / 分享进入 / 保存到相册 / 生命周期）在 spike
> 读数到手后**插在任务 2 与任务 8 之间**——它们的分支由六判据决定，**没有读数就写不出可执行的逐字代码**
> （全局约束 18）。**任务 8 是为数不多与读数无关的一块，故先写**：它无论如何都要做、不会被任何读数推翻。

---

### 任务 3：相册选图接线（`PickPage` 的 `native-picker` 分支 + 判据 A 的处置）

**前置**：任务 2 的 spike 已跑完，**判据 A 的读数已写进 spike 报告**。本任务的步骤 4 是**条件步骤**，按那读数走。

**交付物**：壳里（`kind === "native-picker"`）的用户点了「从相册选一张」就能走完「选图 → 解码 → 落草稿 → 进选区页」；浏览器那条老路**一行不动**。

**文件：**
- 修改：`src/views/PickPage.vue`、`src/views/__tests__/PickPage.test.ts`（**只追加**用例）
- **仅当判据 A 可用**：修改 `src/services/platform/tauriDriver.ts`（`pickImageFile` 换成隐藏 input）、`src-tauri/Cargo.toml`（删 `tauri-plugin-dialog`）、`src-tauri/src/lib.rs`（**删掉 `.plugin(tauri_plugin_dialog::init())` 那一行**）、`src-tauri/capabilities/default.json`（删 `dialog:allow-open`）

- [ ] **步骤 1：抄下判据 A 的读数与结论（不许凭印象）**

从 spike 报告里把 **A 块的整段读数**贴进本次任务的报告开头，并写清结论：**A 可用** 还是 **A 不可用**（判定规则见计划任务 2 的判定表：A 能唤出系统选择器且「解码」是 `宽×高` ⇒ 可用）。

- [ ] **步骤 2：写 `PickPage` 的失败测试（`native-picker` 分支）**

在 `src/views/__tests__/PickPage.test.ts` **末尾追加**（既有 8 条一字不动）：

```ts
/**
 * `native-picker` 分支（壳里）：两个按钮 + 复用同一条「解码 → 落草稿 → 进选区页」。
 *
 * **为什么这些用例必须注入假平台**：分支条件来自 `getPlatform().imagePicking.kind`（浏览器实现是
 * `"file-input"`），所以壳那一支在默认环境下**根本不会渲染**。注入假平台是唯一能执行到它的办法，
 * 也正是 `setPlatform` 这个注入点存在的理由（规格 §4.2）。
 *
 * **不测的**：真实选择器 / 相机（规格 §9.4）——那两支的判别力在人工清单与 spike 读数里。
 */
function fakeShellPlatform(overrides: {
  canCapture: boolean;
  pickFromAlbum?: () => Promise<File | null>;
  capturePhoto?: () => Promise<File | null>;
}): Platform {
  return {
    ...browserPlatform,
    imagePicking: {
      kind: "native-picker",
      canCapture: overrides.canCapture,
      pickFromAlbum: overrides.pickFromAlbum ?? (async () => null),
      capturePhoto: overrides.capturePhoto ?? (async () => null),
    },
  };
}

describe("PickPage（native-picker 分支）", () => {
  it("渲染「从相册选一张」；canCapture 为真时另有「拍一张」，为假时没有", () => {
    setPlatform(fakeShellPlatform({ canCapture: true }));
    const withCamera = mount(PickPage);
    expect(withCamera.find("[data-testid='pick-album']").exists()).toBe(true);
    expect(withCamera.find("[data-testid='pick-camera']").exists()).toBe(true);
    // 浏览器那条老路（可见 input + 下一步）在这一支下**不该出现**
    expect(withCamera.find("[data-testid='file-input']").exists()).toBe(false);

    setPlatform(fakeShellPlatform({ canCapture: false }));
    const withoutCamera = mount(PickPage);
    expect(withoutCamera.find("[data-testid='pick-album']").exists()).toBe(true);
    expect(withoutCamera.find("[data-testid='pick-camera']").exists()).toBe(false);
  });

  it("点「从相册选一张」⇒ 用 pickFromAlbum 拿到的文件走完解码与落草稿，并跳选区页", async () => {
    const platform = stubPlatform({ width: 800, height: 600 });
    const picked = new File([new Uint8Array([1, 2, 3, 4])], "从相册.png", { type: "image/png" });
    const pickFromAlbum = vi.fn(async () => picked);
    setPlatform(fakeShellPlatform({ canCapture: true, pickFromAlbum }));

    const wrapper = mount(PickPage);
    await wrapper.get("[data-testid='pick-album']").trigger("click");
    await flushPromises();

    expect(pickFromAlbum).toHaveBeenCalledTimes(1);
    const draft = useDraft();
    expect(draft.source?.name).toBe("从相册.png");
    expect(toRaw(draft.source)?.blob).toBe(picked);
    expect(draft.sourceSize).toEqual({ width: 800, height: 600 });
    expect(platform.canvases).toHaveLength(1);
    expect(draft.preview).toBe(platform.canvases[0]);
    expect(draft.crop).toEqual({ x: 100, y: 0, width: 600, height: 600 });
    expect(push).toHaveBeenCalledWith({ name: "setup" });
  });

  it("取消（返回 null）⇒ 不报错、不跳转、草稿不动", async () => {
    stubPlatform();
    setPlatform(fakeShellPlatform({ canCapture: false, pickFromAlbum: async () => null }));

    const wrapper = mount(PickPage);
    await wrapper.get("[data-testid='pick-album']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='pick-error']").exists()).toBe(false);
    expect(push).not.toHaveBeenCalled();
    expect(useDraft().source).toBeNull();
  });

  it("选择器抛错 ⇒ 显示中文原因、不跳转、不留半截草稿；按钮恢复可用", async () => {
    stubPlatform();
    setPlatform(
      fakeShellPlatform({
        canCapture: false,
        pickFromAlbum: async () => {
          throw new Error("图片选择器返回了非文件对象");
        },
      }),
    );

    const wrapper = mount(PickPage);
    await wrapper.get("[data-testid='pick-album']").trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-testid='pick-error']").text()).toContain(
      "图片选择器返回了非文件对象",
    );
    expect(push).not.toHaveBeenCalled();
    expect(useDraft().source).toBeNull();
    expect((wrapper.get("[data-testid='pick-album']").element as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("「拍一张」走 capturePhoto（**不是** pickFromAlbum）——这条钉住接线没接错", async () => {
    stubPlatform();
    const pickFromAlbum = vi.fn(async () => null);
    const capturePhoto = vi.fn(async () => null);
    setPlatform(fakeShellPlatform({ canCapture: true, pickFromAlbum, capturePhoto }));

    const wrapper = mount(PickPage);
    await wrapper.get("[data-testid='pick-camera']").trigger("click");
    await flushPromises();

    expect(capturePhoto).toHaveBeenCalledTimes(1);
    expect(pickFromAlbum).not.toHaveBeenCalled();
  });
});
```

（这份用例需要 `beforeEach` 里 `setPlatform(browserPlatform)` 的复位与 `afterEach` 的 `setPlatform(browserPlatform)`——**照 `src/services/platform/__tests__/browserPlatform.test.ts` 的写法**；若既有 `afterEach` 里没有复位，就在本文件里加一行，**不改既有断言**。）

运行：`npx vitest run src/views/__tests__/PickPage.test.ts`
预期：**红**（`pick-album` 找不到）。

- [ ] **步骤 3：实现 `PickPage` 的 `native-picker` 分支**

`src/views/PickPage.vue` 的 `<script setup>` 里加（既有 `pick()` / `resume()` 一行不动）：

```ts
import { getPlatform } from "@/services/platform/capabilities";

/**
 * 平台决定的入口形态（规格 §5.1）：浏览器 = 页面里那个可见 input（老路，一行不动）；
 * 壳里 = 两个按钮（`native-picker`）。**判断只读一次**：`kind` / `canCapture` 都是同步字段
 * （规格 §4.1），装配期读出来存进常量，避免模板里反复调 `getPlatform()`。
 */
const platform = getPlatform();
const useNativePicker = platform.imagePicking.kind === "native-picker";
const canCapture = platform.imagePicking.canCapture;

/**
 * 壳里的一条路：取图（相册或拍照）→ 解码 → 落草稿 → 进选区页。
 *
 * **与 `pick()` 共用同一条后续**（`loadImageSource` → `adoptImage` → `push setup`）：两条入口的差别
 * 只在「怎么拿到 `File`」，**解码与草稿语义必须完全一致**——这正是本任务存在的理由。
 * **取消是正常操作**（`null`）⇒ 静默返回，不写 `error`；**抛错才提示**，且不留半截草稿。
 * `busy` 闸门与 `pick()` 同源（同一 tick 连点两次只处理一次）。
 */
async function pickNative(source: "album" | "camera"): Promise<void> {
  if (busy.value) return;
  error.value = "";

  busy.value = true;
  try {
    const file =
      source === "album"
        ? await platform.imagePicking.pickFromAlbum()
        : await platform.imagePicking.capturePhoto();
    if (file === null) return;

    const loaded = await loadImageSource(file);
    draft.adoptImage({
      source: { blob: loaded.blob, type: loaded.type, name: loaded.name },
      sourceSize: loaded.sourceSize,
      preview: loaded.preview,
    });
    await router.push({ name: "setup" });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
```

模板：在 `<section class="mt-6 space-y-6">` 内部、把现有那个 `<label>`（可见 input）与「下一步」按钮**包进 `v-if="!useNativePicker"`**，并加一支 `v-else`：

```vue
      <template v-if="useNativePicker">
        <button
          data-testid="pick-album"
          class="block min-h-14 w-full rounded bg-slate-900 px-8 text-lg text-white disabled:opacity-50"
          :disabled="busy"
          @click="pickNative('album')"
        >
          {{ busy ? "正在读取…" : "从相册选一张" }}
        </button>
        <button
          v-if="canCapture"
          data-testid="pick-camera"
          class="mt-3 block min-h-14 w-full rounded border border-slate-300 px-8 text-lg disabled:opacity-50"
          :disabled="busy"
          @click="pickNative('camera')"
        >
          拍一张
        </button>
      </template>
      <template v-else>
        <!-- 浏览器那条老路：可见 input + 下一步。**一个字都不改**（既有 8 条用例钉着它）。 -->
        …原有 label 与按钮原样搬进来…
      </template>
```

「继续上次的选区」按钮与错误条**两支共用**，放在 `template` 之外，位置不变。

运行：`npx vitest run src/views/__tests__/PickPage.test.ts`（新 5 条 + 既有 8 条全绿）+ `npm run test` + `npm run build`

- [ ] **步骤 4：条件步骤——按判据 A 的读数处置 dialog 依赖（**这一步最容易漏**）**

**若 A 可用**（裸 `<input>` 在壳里能选图）⇒ **四处一起改，少一处就编译或权限不一致**：

1. `src/services/platform/tauriDriver.ts` 的 `pickImageFile` 换成隐藏 input（**与 `pickWithHiddenInput` 同一条路**：`capture` 传 `null`），删掉 `plugin-dialog` 的 import 与 `dialog.open(...)`；
   **`plugin-fs` 与 `readFileAsBytes` 保留**（分享进入那条路还要读 `content://`）。
2. `src-tauri/Cargo.toml` 删掉 `tauri-plugin-dialog = "2"` 与那句注释。
3. `src-tauri/src/lib.rs` 删掉 **`.plugin(tauri_plugin_dialog::init())`** 这一行——**漏了它 `cargo check` 会直接红**（依赖没了但代码还在用），这正是「删依赖」最常被漏的第二步。
4. `src-tauri/capabilities/default.json` 删掉 `"dialog:allow-open"`。

**验收（写进报告）**：
```powershell
Select-String -Path src-tauri -Pattern "plugin-dialog" -Recurse | ForEach-Object { $_.Path }   # 期望零命中
Select-String -Path src-tauri -Pattern "dialog" -Recurse | ForEach-Object { $_.Path }          # 期望只剩注释/无关词
npx vitest run src/services/platform/__tests__/tauriPlatform.test.ts                            # 期望 8 passed
cargo check --manifest-path src-tauri/Cargo.toml                                                # 期望 exit 0
```

**若 A 不可用** ⇒ **本步骤是空操作**（当前 dialog 分支就是正确实现）；在报告里写明「B5-R2 已发生、已按 dialog 降级」，并**保留**那三处依赖与权限。

- [ ] **步骤 5：变异（红数不许预估）**

| ID | 改哪一行 | 期望红 |
|---|---|---|
| M19 | `PickPage.vue` 里把 `pickNative("album")` 接到 `capturePhoto()` | 「点『从相册选一张』…」会转而调 `pickFromAlbum` 的断言 + 「拍一张走 capturePhoto」那条 |
| M20 | `pickNative` 删掉 `if (file === null) return;`（取消时继续往下走） | 「取消 ⇒ 不报错、不跳转、草稿不动」 |
| M21 | `pickNative` 把 `busy.value = true` 那两行删掉 | 新增用例里若有 busy 相关断言（**本任务没写**）⇒ 如实记：**这条在本任务无靶子**，busy 闸门的判别力由既有那条「同一 tick 连点两次」用例承担 |

- [ ] **步骤 6：三跑 + Commit**

```powershell
npm run test          # 贴 Test Files / Tests 两行，并给新的闭合分解式
$env:TZ="UTC"; npm run test; Remove-Item Env:\TZ
npm run build
```

```powershell
git add src/views/PickPage.vue src/views/__tests__/PickPage.test.ts src/services/platform/tauriDriver.ts src-tauri
git commit -m "feat(app): 壳里的相册选图入口（native-picker 分支）与按判据 A 的依赖处置"
```

（若步骤 4 是空操作，`git add` 里去掉 `tauriDriver.ts` 与 `src-tauri`。）


---

### 任务 5：分享进入（`useShareIntake` + `App.vue` 装配与提示条）

**前置**：任务 2 的 spike 已跑完，**判据 C 的读数已写进 spike 报告**（URI 形态、能否读字节、raw body 是否可用）。步骤 5 是按该读数的条件步骤。

**交付物**：从相册 App / 文件管理器「分享」一张图进「一起拼豆」⇒ **直接落在选区页**且图就是那一张；**冷启动的分享只被摄取一次**（取走即清）；失败**不留半截草稿**；编辑器里还有未保存改动时**不把用户带走**。

**文件：**
- 创建：`src/composables/useShareIntake.ts`、`src/composables/__tests__/useShareIntake.test.ts`
- 修改：`src/App.vue`（装配 + 提示条模板）

- [ ] **步骤 1：抄下判据 C 的读数与结论**

把 spike 报告里 **C 块的整段读数**（冷启动 / 热启动 / 原始字节体三行）+ `adb logcat` 里 `RunEvent::Opened：…` 那一行**原文**贴进本次任务报告的开头，写清：URI 的实际形态、能否读出字节、raw body 是否可用。

- [ ] **步骤 2：写失败测试**

`src/composables/__tests__/useShareIntake.test.ts`（照 `src/composables/__tests__/useCanvasSurface.test.ts` 的既有挂载写法；`loadImageSource` 用 `vi.mock("@/services/probe")` + 假画布桩住，**照 `views/__tests__/PickPage.test.ts` 的手法**）：

```ts
/**
 * 分享摄入链（规格 §5.3.6）。**五条必须分开钉**：
 * ① 浏览器（`supported === false`）**不装配**——不能凭空多出一个订阅面；
 * ② 成功 ⇒ 「解码 → 落草稿 → 进选区页」与相册入口**完全同一条**（差别只在怎么拿到 `File`）；
 * ③ 冷启动空 ⇒ 什么都不做（不是错误）；
 * ④ 失败 ⇒ **不落任何草稿** + 提示条给中文原因（与 `PickPage` 的既有纪律同源）；
 * ⑤ **编辑器有未保存改动时不 adopt、不导航** ⇒ 暂存 + 提示条 + 「继续」；点「继续」后重试成功。
 *
 * **⑤ 是本任务唯一的新语义**：直接 `adoptImage` + `push` 会被编辑器守卫拦下，留下「草稿里有图但页面
 * 没动」的半截状态；先 `push` 再 adopt 又会丢掉被取消的那次导航。所以**先不 adopt**。
 * **代价如实记**：暂存期间内存里留一张原图（数 MB），直到用户点「继续」或关掉提示条。
 */
describe("useShareIntake", () => {
  it("supported 为 false ⇒ 不订阅、不取走、提示条不出现", async () => {
    // …注入 { ...browserPlatform, shareInbox: { supported: false, takeSharedImage, onSharedImage } }…
    expect(takeSharedImage).not.toHaveBeenCalled();
    expect(onSharedImage).not.toHaveBeenCalled();
    expect(wrapper.find("[data-testid='share-banner']").exists()).toBe(false);
  });

  it("冷启动取到文件 ⇒ 解码、落草稿、进选区页", async () => {
    // 断言 draft.source / sourceSize / preview（恒等于本次建的那张画布）/ crop / stage === "crop" / push setup
  });

  it("冷启动是空的 ⇒ 什么都不做（不报错、不跳转、不落草稿）", async () => { /* … */ });

  it("解码失败 ⇒ 提示条给中文原因，且**不落任何草稿**", async () => {
    // loadImageSource 抛「图片解码失败」⇒ 断言 draft.source === null、banner 含该原因、未 push
  });

  it("编辑器有未保存改动时收到分享 ⇒ 不 adopt、不导航、给「继续」；点继续后重试成功", async () => {
    // 让 route.name === "editor" 且 session.dirty === true（照 EditorPage 既有测试的置脏方式）
    // …触发冷启动摄入…
    expect(useDraft().source).toBeNull();  // ★ 没有半截草稿
    expect(push).not.toHaveBeenCalled();   // ★ 没有把用户带走
    expect(wrapper.get("[data-testid='share-banner']").text()).toContain("未保存");
    // …清掉脏标记…
    await wrapper.get("[data-testid='share-retry']").trigger("click");
    await flushPromises();
    expect(useDraft().source).not.toBeNull();
    expect(push).toHaveBeenCalledWith({ name: "setup" });
  });

  it("点「知道了」⇒ 提示条消失且暂存被释放", async () => {
    // …先制造暂存态…点 share-dismiss ⇒ 断言 banner 不存在、且再次点 retry 什么都不做
  });

  it("热启动（onSharedImage 触发的文件）也走同一条链", async () => { /* … */ });

  it("卸载 ⇒ 解绑（不泄漏监听）", async () => { /* … */ });
});
```

运行：`npx vitest run src/composables/__tests__/useShareIntake.test.ts` ⇒ 预期**红**。

- [ ] **步骤 3：实现**

`src/composables/useShareIntake.ts`：

```ts
import { onUnmounted, ref, type Ref } from "vue";
import { useRouter } from "vue-router";
import { loadImageSource } from "@/services/imageSource";
import { getPlatform } from "@/services/platform/capabilities";
import { useDraft } from "@/stores/draft";
import { useProjectSession } from "@/stores/project";

/** 提示条要用的状态。**页面只读它、调 `retry` / `dismiss`**，摄入逻辑全在本文件里。 */
export interface ShareIntake {
  /** 空串 = 不显示提示条。 */
  readonly message: Ref<string>;
  /** 编辑器有未保存改动时暂存的那一份分享（非空时提示条给「继续」按钮）。 */
  readonly pending: Ref<File | null>;
  /** 「继续」：重试摄入暂存的那一份。 */
  retry(): Promise<void>;
  /** 「知道了」：丢弃暂存并清空提示（**释放那张原图的引用**）。 */
  dismiss(): void;
}

/**
 * 分享进入的摄入链（规格 §5.3.6）。**在 `App.vue` 的 setup 顶层调用一次。**
 *
 * **为什么挂在 App 而不是某个页面**：分享进来时 App 可能停在任意页面（甚至刚被拉起）；
 * 摄入链要在**任何页面**都接得住，成功后统一跳 `/new/setup`。
 *
 * **两个入口一条链**：冷启动（`takeSharedImage`，取走即清）与热启动（`onSharedImage`）都进 `intake()`。
 *
 * **失败一律不落草稿**：与 `PickPage` 的既有纪律同源——留一个「有 source 没 preview」的半截状态，
 * 选区页会拿到空画布。
 *
 * **编辑器 dirty 时先不 adopt**：直接改草稿 + 跳路由会被编辑器守卫拦下，留下「草稿里有图、页面没动」
 * 的半截状态。所以暂存 + 提示条 + 「继续」；**代价是内存里留一张原图**，直到用户处理。
 */
export function useShareIntake(): ShareIntake {
  const router = useRouter();
  const draft = useDraft();
  const session = useProjectSession();
  const platform = getPlatform();

  const message = ref("");
  const pending = ref<File | null>(null);

  async function intake(file: File): Promise<void> {
    message.value = "";
    try {
      const loaded = await loadImageSource(file);
      draft.adoptImage({
        source: { blob: loaded.blob, type: loaded.type, name: loaded.name },
        sourceSize: loaded.sourceSize,
        preview: loaded.preview,
      });
      await router.push({ name: "setup" });
      pending.value = null;
    } catch (error) {
      // **不落草稿**：失败时草稿必须与「什么都没发生过」一致。
      message.value = `分享的图片没能处理：${error instanceof Error ? error.message : String(error)}`;
      pending.value = null;
    }
  }

  /** 摄入前先看「编辑器里有没有未保存的改动」——有就暂存，别把用户带走。 */
  async function intakeOrPark(file: File): Promise<void> {
    if (router.currentRoute.value.name === "editor" && session.dirty) {
      pending.value = file;
      message.value = "收到一张分享的图片；当前编辑还没保存，处理完再点「继续」。";
      return;
    }
    await intake(file);
  }

  let offShared: (() => void) | null = null;

  if (platform.shareInbox.supported) {
    // 热启动：**越早订阅越好**（App 启动时就订好），否则人在相册 App 里分享时接不住。
    offShared = platform.shareInbox.onSharedImage((file) => {
      void intakeOrPark(file);
    });

    // 冷启动：那一份可能已经在 Rust 状态里等着了。
    void (async () => {
      try {
        const file = await platform.shareInbox.takeSharedImage();
        if (file !== null) await intakeOrPark(file);
      } catch (error) {
        message.value = `分享的图片没能读取：${error instanceof Error ? error.message : String(error)}`;
      }
    })();
  }

  onUnmounted(() => {
    offShared?.();
  });

  return {
    message,
    pending,
    async retry(): Promise<void> {
      const file = pending.value;
      if (file === null) return;
      await intake(file);
    },
    dismiss(): void {
      pending.value = null;
      message.value = "";
    },
  };
}
```

- [ ] **步骤 4：装进 `App.vue`（含提示条）**

```vue
<script setup lang="ts">
// 壳里的两个装配（规格 §5.3.6 / §5.5.1）：分享摄入与生命周期。
// **都必须在 setup 顶层调用**：它们各自用 `onUnmounted` 登记解绑。
import { useShareIntake } from "@/composables/useShareIntake";
import { useShellLifecycle } from "@/composables/useShellLifecycle";

const share = useShareIntake();
useShellLifecycle();
</script>

<template>
  <RouterView />

  <!-- 分享摄入的提示条：**不打断用户**（不是弹窗），且不进任何 store。
       `role="status"` 而不是 `alert`：它是「说明」，不是「必须立刻处理的错误」。
       `z-50` 高于导出面板覆盖层的 z-30 与未保存确认条的 z-40：它是全局的，不该被任何面板盖住。 -->
  <p
    v-if="share.message.value !== ''"
    data-testid="share-banner"
    role="status"
    class="fixed inset-x-0 bottom-0 z-50 bg-amber-50 p-4 text-base text-amber-900"
  >
    {{ share.message.value }}
    <button
      v-if="share.pending.value !== null"
      data-testid="share-retry"
      class="ml-3 rounded border border-amber-400 px-3 py-1"
      @click="share.retry()"
    >
      继续
    </button>
    <button
      data-testid="share-dismiss"
      class="ml-2 rounded border border-amber-400 px-3 py-1"
      @click="share.dismiss()"
    >
      知道了
    </button>
  </p>
</template>
```

运行：`npx vitest run src/composables/__tests__/useShareIntake.test.ts`（8 条全绿）+ `npm run test` + `npm run build`

- [ ] **步骤 5：按判据 C 的读数处置**

- **URI 可读 + raw body 可用** ⇒ **空操作**（本任务已完成）。
- **URI 读不出** ⇒ 追加 Kotlin「把 URI 流复制到 app cache 并返回路径」的命令 + 驱动改用该路径（前端**一行不改**：它只认 `File`）。把改动与读数一起写进报告。
- **raw body 不可用** ⇒ 属于任务 6 的处置范围（`saveToAlbum` 改 base64），**但要在本任务报告里交叉登记**，免得两边都以为对方在处理。

- [ ] **步骤 6：变异（红数不许预估）**

| ID | 改哪一行 | 期望红 |
|---|---|---|
| M28 | `intakeOrPark` 去掉「编辑器 + dirty」那道判断（无条件 `intake`） | 「编辑器有未保存改动 ⇒ 不 adopt、不导航」那条（草稿会被填上、`push` 被调用） |
| M29 | `dismiss()` 只清 `message` 不清 `pending` | 「点『知道了』⇒ 提示条消失且暂存被释放」那条 |
| M30 | 冷启动那段改成调用了 `takeSharedImage()` 但**忽略返回值** | 「冷启动取到文件 ⇒ 落草稿」那条 |

- [ ] **步骤 7：三跑 + Commit**

```powershell
npm run test; $env:TZ="UTC"; npm run test; Remove-Item Env:\TZ; npm run build
```

```powershell
git add src/composables/useShareIntake.ts src/composables/__tests__/useShareIntake.test.ts src/App.vue src-tauri src/services/platform/tauriDriver.ts
git commit -m "feat(app): 系统分享进入的摄入链（冷/热启动同一条路，编辑器有未保存改动时不带走用户）"
```

---

### 任务 6：保存到相册接线（`ExportPanel` 换调 `album.save`，G4 转绿）

**前置**：任务 2 的 spike 已跑完，**判据 D 的读数已写进 spike 报告**；步骤 5 是按该读数的条件步骤。

**交付物**：面板的三类产物都经 `getPlatform().album.save(...)` 落盘（壳里 = 系统相册、浏览器 = 仍走 `downloadBlob`）；**`platformGate` 的 G4 在本任务转绿**（5 passed / 0 failed）。

**文件：**
- 修改：`src/components/editor/ExportPanel.vue`、`src/components/editor/__tests__/ExportPanel.test.ts`（**只追加**用例）
- **仅当判据 D 不可用**：修改 `src/services/platform/tauriPlatform.ts`、`src-tauri/capabilities/default.json`（加 `dialog:allow-save` 与 `fs:allow-write-file`）

- [ ] **步骤 1：抄下判据 D 的读数与结论**

把 spike 报告里 **D 块的整段读数**贴进本次任务报告的开头，写清结论：**D 可用**（相册里出现文件、无权限弹窗）还是 **D 不可用**。

- [ ] **步骤 2：先核「成功文案」的既有断言（决定实现写法，不许跳过）**

```powershell
Select-String -Path src/components/editor/ExportPanel.vue -Pattern "已保存|已生成|下载" | ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
Select-String -Path src/components/editor/__tests__/ExportPanel.test.ts -Pattern "已保存|已生成|下载" | ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

**把两条命令的原始输出贴进报告。** 判据：既有用例若**断言过**成功文案，那么**下载那一支的文案一个字都不能改**——只允许在 `album.kind === "album"` 时用新文案（`已保存到相册`）。这是「既有断言一行不改」在本任务的具体落法。

- [ ] **步骤 3：写失败测试（走平台的接线 + 恒等实参）**

在 `ExportPanel.test.ts` **末尾追加**（既有断言一字不动）。本文件已经 `vi.mock("@/services/exporter")`；本任务要断言的是「面板把**渲染出的那颗 blob** 与 `exportFilename` 的名字交给了**平台**」，所以注入假平台：

```ts
/**
 * 承重断言（规格 §9.2-2）：「保存」必须**经平台层**落盘，且交给它的是**渲染出的那一颗** blob。
 *
 * **为什么必须恒等比较**：`toBe` 才能钉住「不是另建的一颗空 blob / 不是重新包一层」；
 * 只断言 `save` 被调用过，把实参换成 `new Blob([])` 也绿。
 * **为什么还要断言名字**：名字来自 `exportFilename(projectName, label, tile)`——分片项必须带 `r{r}c{c}`；
 * 接线写错（漏传 `tile`）会让**分片文件名全部变成非分片**，而图本身完全正常。
 */
it("点某一项的「保存」⇒ 经 getPlatform().album.save 落盘，实参是那颗 blob 与带分片序号的名字", async () => {
  const saves: Array<{ blob: Blob; filename: string }> = [];
  const albumSave = vi.fn(async (blob: Blob, filename: string) => {
    saves.push({ blob, filename });
  });
  setPlatform({ ...browserPlatform, album: { kind: "album", save: albumSave } });

  // …此处照本文件**既有的**那条成功用例的挂载 / 点击写法（同一个夹具、同一个 testid），只换断言…
  const canvasBlob = await (await import("@/services/exporter")).canvasToBlob(
    {} as unknown as HTMLCanvasElement,
  );
  expect(albumSave).toHaveBeenCalledTimes(1);
  expect(saves[0]?.blob).toBe(canvasBlob);
  expect(saves[0]?.filename).toBe(exportFilename("小猫", "施工图", { rowIndex: 1, colIndex: 1 }));

  setPlatform(browserPlatform); // 复位，别影响本文件其余用例
});

it("平台保存失败 ⇒ 走既有的琥珀条失败路径（不静默）", async () => {
  const albumSave = vi.fn(async () => {
    throw new Error("MediaStore 拒绝插入（insert 返回 null）");
  });
  setPlatform({ ...browserPlatform, album: { kind: "album", save: albumSave } });

  // …同一个夹具点「保存」…断言：错误条出现且含驱动给的中文原因；该项状态不是「已生成」；不产生预览 URL。
  setPlatform(browserPlatform);
});
```

（两处注释里的「照既有写法」指本文件里**已经存在的**成功用例与失败用例的挂载 / 点击 / 断言写法：把那几条的**结构**抄过来、只换注入的平台与断言，**不改那几条本身**。）

运行：`npx vitest run src/components/editor/__tests__/ExportPanel.test.ts`
预期：**红**（新用例拿不到 `album.save` 调用——面板还在直调 `downloadBlob`）。

- [ ] **步骤 4：实现（只改那一处调用 + 成功文案分叉）**

`ExportPanel.vue` 的 `downloadAndPreview` 里那一处：

```ts
  // 上一版：`downloadBlob(blob, filename);`（直调平台层之外的东西）
  // 本任务：经能力层（规格 §5.4.3）——壳里进系统相册、浏览器里仍是下载；
  // 面板**不再知道**具体落点，也不能再自己拼第二份命名逻辑（名字走 exportFilename）。
  await getPlatform().album.save(blob, filename);
```

成功文案按 `getPlatform().album.kind` 分叉：`"album"` ⇒ `已保存到相册`；`"download"` ⇒ **保持步骤 2 读出来的原文案不变**。

运行：`npx vitest run src/components/editor/__tests__/ExportPanel.test.ts`（新 2 条 + 既有全绿）
再跑：`npx vitest run src/__tests__/platformGate.test.ts` ⇒ **预期 5 passed / 0 failed（G4 转绿）**

- [ ] **步骤 5：条件步骤——按判据 D 的读数处置**

**若 D 可用** ⇒ **空操作**（`tauriPlatform.album.save` 已经写进相册）。

**若 D 不可用** ⇒ 壳侧降级（规格 D2）：`tauriPlatform.ts` 的 `album.save` 改走 `dialog.save({ defaultPath: filename, filters: [{ name: "PNG", extensions: ["png"] }] })` 拿路径 → `plugin-fs` 的 `writeFile` 写入；**`ExportPanel` 一行不动**（调用点仍是 `album.save` ⇒ G4 照样该绿）；capabilities 加 `dialog:allow-save` 与 `fs:allow-write-file`（**只加用到的**）；README 写明「保存位置由用户选择，不会自动进相册」。**用户取消（`null`）与写入失败要分开**：取消静默返回，写入失败抛错。

- [ ] **步骤 6：变异（红数不许预估）**

| ID | 改哪一行 | 期望红 |
|---|---|---|
| M22 | `ExportPanel.vue` 把 `album.save(blob, filename)` 改回 `downloadBlob(blob, filename)` | **G4**（闸门）+ 新加的「经平台落盘」那条 |
| M23 | `exportFilename` 调用里漏传 `tile`（分片项变成非分片名字） | 新用例的名字断言（`r2c2` 那半） |
| M24 | 失败分支把 `albumSave` 的抛错吞掉（catch 后当成功） | 新加的「失败走琥珀条」那条 |

- [ ] **步骤 7：三跑 + Commit**

```powershell
npm run test          # 新增 2 条；贴 Test Files / Tests 两行与新分解式
$env:TZ="UTC"; npm run test; Remove-Item Env:\TZ
npm run build
npx vitest run src/__tests__/platformGate.test.ts   # 5 passed
```

```powershell
git add src/components/editor/ExportPanel.vue src/components/editor/__tests__/ExportPanel.test.ts src/services/platform/tauriPlatform.ts src-tauri
git commit -m "feat(exporter): 面板经能力层落盘（壳里进相册），platformGate 的 G4 转绿"
```

（步骤 5 是空操作时，`git add` 里去掉 `tauriPlatform.ts` 与 `src-tauri`。）
（步骤 5 是空操作时，`git add` 里去掉 `src-tauri` 与 `tauriDriver.ts`。）

---

### 任务 7：生命周期（返回键三分支 + 退出请求；`App.vue` 装配）

**前置**：任务 2 的 spike 已跑完，**判据 E 的读数已写进 spike 报告**（它只影响本任务的**记录与排查路径**，不影响三分支的实现——见步骤 5）。

**交付物**：`/edit/:id` 里有未保存改动时，Android 返回键**不会**把 App 直接退掉（走已有的页面内确认条）；退出请求在 dirty 时被拦一次；**切后台不做机制**（规格 §5.5.4，如实写进文档）。

**文件：**
- 创建：`src/composables/useShellLifecycle.ts`、`src/composables/__tests__/useShellLifecycle.test.ts`
- 修改：`src/App.vue`（加两行装配；任务 5 会再加一个 composable）

- [ ] **步骤 1：抄下判据 E 的读数与结论**

把 spike 报告里 **E 块的整段读数**（返回键 / 关闭请求两行 + logcat 原文）贴进本次任务报告的开头。

- [ ] **步骤 2：写失败测试**

`src/composables/__tests__/useShellLifecycle.test.ts`（**挂载一个空测试组件来跑 composable**——照本仓 `src/composables/__tests__/useCanvasSurface.test.ts` 的既有写法，别自创 helper）：

```ts
/**
 * 返回键的三个分支（规格 §5.5.1）——**必须互不遮蔽**：
 * ① `canGoBack` ⇒ `history.back()`，让既有的路由守卫与确认条原样生效（**不新增第二套确认 UI**）；
 * ② 无历史 + 有未保存改动 ⇒ 走到图纸库（守卫会拦下并弹同一条确认条）——**绝不直接 exit**；
 * ③ 无历史 + 干净 ⇒ 正常退出。
 *
 * **为什么三条要分开钉**：写成一个「dirty 就拦、否则退出」的函数在 ① 上会静默丢掉「回上一页」的行为
 * （用户按返回键会从编辑器直接退出 App），而三支挤在一起时，把 ① 接成 ③ 只会让一条红。
 * `history.back` 在 happy-dom 里没有导航语义 ⇒ 用 spy 钉调用，**不假装测到了真导航**。
 */
describe("useShellLifecycle", () => {
  it("canGoBack ⇒ 调 history.back()，既不 push 也不 exit", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    // …注入假 router（`vi.mock("vue-router")`，照 `views/__tests__/PickPage.test.ts` 的既有写法）…
    // …注入假平台（`setPlatform(fakePlatform)`），它的 `onBackButton` 把 handler 存下来供本用例触发…
    // …挂测试组件…
    backHandler({ canGoBack: true });
    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("无历史 + dirty ⇒ 走路由去 library（**不 exit**）", async () => {
    // session.dirty 置脏：用 store 的既有方式（`adopt` 或 `markDirty`，后者幂等）
    backHandler({ canGoBack: false });
    expect(push).toHaveBeenCalledWith({ name: "library" });
    expect(exit).not.toHaveBeenCalled();
  });

  it("无历史 + 干净 ⇒ exit() 恰好一次，且不 push", async () => {
    backHandler({ canGoBack: false });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("退出请求的 handler 返回 session.dirty（干净 ⇒ false，dirty ⇒ true）", async () => {
    expect(exitRequestHandler()).toBe(false);
    // …置 dirty…
    expect(exitRequestHandler()).toBe(true);
  });

  it("卸载 ⇒ 两个解绑函数各被调用一次（不泄漏监听）", async () => {
    // …挂载后卸载…
    expect(unbindBack).toHaveBeenCalledTimes(1);
    expect(unbindExit).toHaveBeenCalledTimes(1);
  });
});
```

运行：`npx vitest run src/composables/__tests__/useShellLifecycle.test.ts`
预期：**红**（`useShellLifecycle` 不存在）。

- [ ] **步骤 3：实现**

`src/composables/useShellLifecycle.ts`：

```ts
import { onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { getPlatform } from "@/services/platform/capabilities";
import { useProjectSession } from "@/stores/project";

/**
 * 壳里的退出 / 返回键装配（规格 §5.5.1 / §5.5.2）。**在 `App.vue` 的 setup 顶层调用一次。**
 *
 * **为什么三个分支这么分**（不是随手写的）：
 * ① `canGoBack` ⇒ `history.back()`：**让既有机制原样生效**——Vue Router 的 popstate → `EditorPage` 的
 *    `onBeforeRouteLeave` → 有未保存改动就取消导航并弹出**同一条**页面内确认条。这里**绝不新增第二套确认 UI**。
 * ② 无历史且有未保存改动 ⇒ `router.push({ name: "library" })`：主动走到图纸库，守卫照常拦下。
 *    **绝不 `exit()`** —— 那正是「静默丢稿」，也是本任务存在的唯一理由。
 * ③ 无历史且干净 ⇒ 正常退出。
 *
 * **为什么 `onExitRequested` 只返回 `session.dirty`**（不弹任何东西）：此时用户看到的是「App 还在」，
 * 下一步他自己会点返回键或保存。返 `true` 即阻止这次退出（`onCloseRequested` 的 `preventDefault`）。
 *
 * **注册返回键会抑制 Tauri 自带的默认导航**（规格 D3）⇒ 这三个分支**就是**返回键的全部行为，没有兜底。
 */
export function useShellLifecycle(): void {
  const router = useRouter();
  const session = useProjectSession();
  const platform = getPlatform();

  // 退出请求：dirty 时拦一次。Android 上「关闭请求」是否真被触发见构建记录；**不触发也不构成缺陷**。
  const offExit = platform.lifecycle.onExitRequested(() => session.dirty);

  // 返回键：三个分支互不遮蔽。
  const offBack = platform.lifecycle.onBackButton((info) => {
    if (info.canGoBack) {
      history.back();
      return;
    }
    if (session.dirty) {
      void router.push({ name: "library" });
      return;
    }
    void platform.lifecycle.exit();
  });

  onUnmounted(() => {
    offExit();
    offBack();
  });
}
```

- [ ] **步骤 4：装配进 `App.vue`**

`src/App.vue` 现在是 5 行空壳（`<script setup lang="ts"></script>` + `<RouterView />`）。**逻辑一律留在 composable 里，页面保持极薄**：

```vue
<script setup lang="ts">
// 壳里的生命周期装配（规格 §5.5.1 / §5.5.2）。任务 5 会在这里再加一个 `useShareIntake()`。
// **两个 composable 都必须在 setup 顶层调用**：它们各自用 `onUnmounted` 登记解绑，放进条件分支或事件
// 回调里会让解绑登记不到（Vue 的生命周期钩子只在 setup 同步执行期被收集）。
import { useShellLifecycle } from "@/composables/useShellLifecycle";

useShellLifecycle();
</script>

<template>
  <RouterView />
</template>
```

运行：`npx vitest run src/composables/__tests__/useShellLifecycle.test.ts`（5 条全绿）+ `npm run test` + `npm run build`

- [ ] **步骤 5：按判据 E 的读数处置（只影响记录与排查，不改三分支）**

- **返回键触发** ⇒ 本任务完成，读数进构建记录。
- **返回键不触发** ⇒ **是缺陷**：查 `onBackButtonPress` 的注册链（`@tauri-apps/api/app` 的 `app` 插件是否被注册、Android 侧是否可用），把排查过程与结论写进报告；**三分支实现不变**。
- **关闭请求不触发** ⇒ **不是缺陷**（B5-R6）：如实记进构建记录。
- **切后台**：**不做机制**（规格 §5.5.4：Rust 无 `Paused`/`Suspended` 事件、`visibilitychange` 拦不住）⇒ 把「编辑中切后台被系统回收会丢未保存改动」写进 README 的已知限制。

- [ ] **步骤 6：变异（红数不许预估）**

| ID | 改哪一行 | 期望红 |
|---|---|---|
| M25 | 返回键 handler 去掉 `if (info.canGoBack) { history.back(); return; }` 整段 | 「canGoBack ⇒ 调 history.back()」那条（它会掉进 dirty/exit 分支） |
| M26 | 同处去掉 `if (session.dirty) { …push…; return; }`（无历史时无条件 exit） | 「无历史 + dirty ⇒ 走路由」那条 |
| M27 | `onExitRequested(() => session.dirty)` 改成 `() => false` | 「退出请求的 handler 返回 session.dirty」那条 |

- [ ] **步骤 7：三跑 + Commit**

```powershell
npm run test          # 新增 5 条；贴 Test Files / Tests 两行与新分解式
$env:TZ="UTC"; npm run test; Remove-Item Env:\TZ
npm run build
```

```powershell
git add src/composables/useShellLifecycle.ts src/composables/__tests__/useShellLifecycle.test.ts src/App.vue
git commit -m "feat(app): 壳里的返回键三分支与退出请求装配（有未保存改动不静默退出）"
```

---

### 任务 8：收尾（账目 / 构建记录 / 文档回写 / 人工清单回填）

**交付物**：一份能交给下一个人接着做的仓库状态——账目对得上、构建记录写清「哪些是真验过的、哪些没有」、上游文档同步、人工清单逐条有结果。

**文件：**
- 创建：`docs/superpowers/notes/2026-10-06-app-b5-build-log.md`
- 修改：`README.md`、`AGENTS.md` 与 `CLAUDE.md`（**逐字相同的镜像**）、主规格 `docs/superpowers/specs/2026-09-30-image-to-pattern-design.md`（**只加更正注记**）、B5 规格（实现相对规格有偏离时逐条回填）、本计划（执行中改过口径时同步）

- [ ] **步骤 1：账目回原始清单重数（不许引用任何汇总行）**

```powershell
npm run test           # 贴原始输出的 Test Files / Tests 两行
$env:TZ="UTC"; npm run test; Remove-Item Env:\TZ     # 与 CI 同环境，数字必须一致
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

**计数口径**（照 README 既有那段，别自创）：`src/**/*.test.ts` 按路径递归枚举数文件；`describe(` 按**行首**计数；`it(` 按 **`\bit\(` 全局**计数；`it.each` **逐表展开**；`services/__tests__/projectStoreContract.ts` 的条数被内存 / IndexedDB 两个实现各跑一遍；`decoders.test.ts` 的两元素数据循环多跑 1 条。
**必须给出闭合分解式并与运行期总数逐位相等**。**对不上就先怀疑仪器**（B4 账本记过两次仪器错：`it.each` 的括号平衡、`CASES` 的类型标注里有 `[`）。

- [ ] **步骤 2：新建构建记录**

`docs/superpowers/notes/2026-10-06-app-b5-build-log.md`，骨架照 B4（`2026-10-05-app-b4-build-log.md`），**必含七节**：
1. 交付物与账目（含计数方法与原始输出）；
2. **spike 六判据的原始读数整段**（F/A/B/C/D/E，不许摘要）+ `adb logcat` 三行原文；
3. **被推翻的结论与平台事实**（`capture="environment"` 有没有被 WebView 尊重、`content://` 的实际形态、`plugin-fs` 读它时 scope 有没有拦、MediaStore 是否免权限、`onCloseRequested` 在划掉 App 时是否触发、`gen/android` 两次构建前后 `git status` 的差异）；
4. 控制者自己的错误清单（本轮已有三处仪器错误 + 一处记账错误 + 一处对片段的误读，**逐条如实写**）；
5. 人工清单 1–15 的逐条结果（**未执行的写「未执行」**，不许用推测填空）；
6. 正式接受的限制与延后项（一行一条，编号 `B5-1…`，供 README 引用）；
7. 未验证面与后续优先级（**最后一行永远留给「哪一件事最可能在下一次真机使用中咬人」**）。

**构建记录里不许残留任何 `〔`**（B4 的骨架用 `〔…〕` 当填写指令；落进仓库的那份必须全部填实或删掉）——写完用 `Select-String -Pattern '〔'` 自查零命中并把输出贴进报告。

- [ ] **步骤 3：README 回写**

四处：
1. **当前进度**：B5 交付了什么、`npm run dev` 下怎么用（`/lab/shell` 是开发期实验台、**不进用户入口**）、保存到相册的实际落点与降级、分享进入怎么触发；
2. **目录结构**：`src-tauri/`（Rust + Android 生成工程 + 本地移动插件）、`src/services/platform/`（能力层与**唯一**的 Tauri 接触点）、两个 composable、`/lab/shell` 那一行；
3. **开发命令**：`npx tauri android dev` / `npx tauri android build --apk --debug`；并写明**桌面壳（`npx tauri dev`）仅开发调试、不作验收依据**；
4. **已知限制与延后项**：切后台被系统回收会丢未保存改动、拍照的最终状态（交付了 / 未交付及原因）、**平板未验**（本轮验收设备是手机）、release 签名与上架未做、图纸库落在 WebView 的 IndexedDB 上（**卸载 App 会连图纸一起没**）、`onSharedImage` 与读字节失败只有 `console.error` 没有 UI 出口。

- [ ] **步骤 4：AGENTS.md 与 CLAUDE.md 的逐字镜像**

四类内容（**两份必须逐字相同、同时改**）：
1. **分层边界**段：**`@tauri-apps/*` 只许出现在 `src/services/platform/tauriDriver.ts`**（机检 = `platformGate.test.ts` 的 G1）；`isTauri` 只许在 `capabilities.ts` 里读（G2）。
2. **关键常量**段：`identifier = cn.tuzkimo.weefuse`（**不许改**）、`bundle.android.minSdkVersion = 29`、相册落点 `Pictures/WeeFuse`、Android 显示名 `一起拼豆`、`CAPTURE_SUPPORTED` 的最终值。
3. **「公开 API ≠ 被使用的 API」**段：平台能力层的公开面与消费者逐条（含 `pickFromAlbum` / `capturePhoto` / `shareInbox` 三成员在浏览器实现下零消费者这一条如实说明）。
4. **开发流程**段：补一句「spike 的六判据与降级链」，指向 B5 规格 §13 与构建记录。

自检：两份文件的差异集合必须**恰好等于那一行自指**（各自写对方文件名）——`Compare-Object` 的输出应是 1–2 行。

- [ ] **步骤 5：主规格只加更正注记（不改历史正文）**

照 B3/B4 的先例逐处加注记，每处写清「原正文怎么写 → 本轮实际怎么做 → 为什么」：§2.1「图片来源」行、§7.4「保存到相册」、§9「真机清单」（补壳内结果）、§12 的 **R3** 与 **R4** **回填结论**（「验证结论回写本节的项」是主规格自己写的既有要求）。

- [ ] **步骤 6：人工清单 1–15 逐条回填**

B5 规格 §10 的 15 条：1–8 决定「壳能不能用」、9–10 决定生命周期、11–13 是 B4 的欠账（116×116 的 64 MB、空图纸、横竖屏）、14 是「切后台会丢」的确认、15 是壳内复测 `/lab/canvas`。**每条都要有结果**；未执行的如实写「未执行」并说明缺的是**装置**还是**时间**。清单 11 若显示 116×116 会崩，**按 B4 构建记录 §12 的预登记规则另立独立小轮**，本轮只记读数。

- [ ] **步骤 7：按规格 §14 的九条完成标准逐条打勾**

逐条给**证据**（命令 + 原始输出片段），不许只写「已完成」。任何一条不成立的，写清为什么不成立、以及它对后续哪一轮有影响。

- [ ] **步骤 8：Commit**

```powershell
git add README.md AGENTS.md CLAUDE.md docs
git commit -m "docs(b5): 收尾（构建记录 / README / AGENTS+CLAUDE 镜像 / 主规格注记 / 人工清单回填）"
```

---

