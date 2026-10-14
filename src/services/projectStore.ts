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
}

/**
 * 工程名长度上限。
 *
 * **为何公开**：UI（改名对话框）要用它约束输入框的 `maxlength`，让超长名字在**输入时**就被挡住，
 * 而不是等 `put` / `rename` 抛错；它因此是契约面而不是实现细节。
 * （不做输入时的实时字数计数：超长输入已被 `maxlength` 拦在输入框外，计数没有信息量。）
 */
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

/**
 * 从文件名派生默认工程名：去扩展名（`replace(/\.[^.]+$/, "")`）→ `trim` → 空则回落「新图纸」
 * → **夹到 `PROJECT_NAME_MAX`**。行为逐字迁自 B1「新建图纸」页的 `defaultName`。
 *
 * **为什么必须夹**：相册里的长标题 / 长时间戳文件名超过 100 字很常见，不夹就会让 `put`
 * → `normalizeProjectName` 抛「工程名称不能超过 100 个字符」——而记录根本没进库，图纸库里
 * 连那一行都不存在，唯一的改名入口对不存在的记录也不存在。这是一条**响亮失败但用户无出路**
 * 的死路，必须在源头截断。
 *
 * **为何公开**：它是「新建工程」这一动作的默认名来源，由 B2 的选区 / 参数页（`SetupPage`，
 * 接替 B1 已删除的 `GeneratePage`）在生产代码里消费——导出即承诺，故连同其输入校验一起固化在
 * 本文件的契约面上。
 *
 * **入参取 `unknown` 并在运行期校验**：文件名来自 `File.name`，在 TS 里是 `string`，但
 * 「新建工程」的调用链会经过 store / 路由参数等运行期不受类型保护的地方；非字符串一律响亮
 * 抛错，静默回落「新图纸」会把「调用方传错了东西」伪装成一个正常结果。
 */
export function defaultProjectName(fileName: unknown): string {
  if (typeof fileName !== "string") {
    throw new Error(`文件名必须是字符串（当前 ${String(fileName)}）`);
  }
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  return base.length === 0 ? "新图纸" : base.slice(0, PROJECT_NAME_MAX);
}

/** 按 `updatedAt` 倒序（新的在前）。两个实现共用，保证列表顺序口径一致。 */
export function sortByUpdatedAtDesc(metas: readonly ProjectMeta[]): ProjectMeta[] {
  return [...metas].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * 从文档重算列表用的冗余字段（`width` / `height` / `colorCount` 只由 doc 决定）。
 *
 * 两个存储实现与 `stores/project` 的保存路径**共用这一份**：各写一份时，只改到一处也不会红
 * ——契约用例两个实现都跑，可一旦内存实现漏改，生产（IDB）反而是对的，漂移是静默的。
 */
export function deriveMeta(meta: ProjectMeta, doc: ProjectDocument): ProjectMeta {
  return {
    ...meta,
    width: doc.width,
    height: doc.height,
    colorCount: doc.palette.codes.length,
  };
}

/**
 * `put` 的共用入口处理：守卫（写在任何写操作之前）→ 归一化工程名 → 按 doc 重算冗余字段。
 *
 * **调用方拿到的是将要落盘的那一份**，所以「内存态与存储态一致」不需要第二次推导：`save()`
 * 把返回值赋回会话即可。原样赋回调用方给的记录时，内存里的 `meta.width` 会停在占位值上
 * （`SetupPage` 建的 meta 就写着 0）。
 */
export function prepareRecordForPut(record: ProjectRecord): ProjectRecord {
  if (typeof record.meta.id !== "string" || record.meta.id.length === 0) {
    throw new Error("工程 id 必须是非空字符串");
  }
  // §12：`thumbnail` 是外部可影响的展示字段，而列表页会把它直接塞进 `<img src>`。
  // 只放行空串与 `data:image/`——`javascript:` / 远程 URL / `data:text/html` 一律拒绝。
  if (
    typeof record.meta.thumbnail !== "string" ||
    (record.meta.thumbnail !== "" && !record.meta.thumbnail.startsWith("data:image/"))
  ) {
    throw new Error(
      `工程封面图必须是 data:image/ 开头的字符串或空串（当前 ${String(record.meta.thumbnail)}）`,
    );
  }
  return {
    meta: deriveMeta({ ...record.meta, name: normalizeProjectName(record.meta.name) }, record.doc),
    doc: record.doc,
    source: record.source,
  };
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
