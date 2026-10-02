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

/**
 * 工程名长度上限。
 *
 * **为何公开**：UI（改名对话框、图纸库）要在用户输入时就给出上限提示与计数，
 * 而不是等 `put` / `rename` 抛错；它因此是契约面而不是实现细节。
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
