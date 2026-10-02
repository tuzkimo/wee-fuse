import {
  normalizeProjectName,
  sortByUpdatedAtDesc,
  type ProjectMeta,
  type ProjectRecord,
  type ProjectStore,
} from "./projectStore";

/**
 * 默认数据库名。
 *
 * **为何公开**：`main.ts` 在挂载前建库时要报出这个名字（换实现 / 排查用户数据问题时也要），
 * 它因此是正式的契约面而不是实现细节。测试传自己的名字，避免用例之间互相污染。
 */
export const IDB_DATABASE_NAME = "wee-fuse";

const STORE_PROJECTS = "projects";
/**
 * 与 `projects` 同一份 meta 的**第二副本**，只给 `list()` 读。
 *
 * 为什么不直接从 `projects` 里 `getAll()` 再把 `doc` 丢掉：那样 `grid` 已经被整条读进内存了。
 * 长边 500 的图纸 grid 是 25 万个数，几十个工程就是数十 MB 的瞬时分配——而 §4.4 冗余字段
 * （`meta.width/height/colorCount`）存在的**全部理由**就是让列表页不必载入 grid（规格 §7.1）。
 * 两份 meta 在同一事务里写，因此不会漂移。
 */
const STORE_METAS = "metas";
const STORE_SOURCES = "sources";
const DB_VERSION = 1;

/**
 * IndexedDB 实现。**本文件是全项目唯一 import `indexedDB` 的地方**——真机换成 App
 * 私有目录时，只替换这个文件，上层的 `ProjectStore` 接口与数据模型都不动。
 *
 * 记录分成三个 object store：`projects`（meta + doc）、`metas`（只有 meta，供 `list()` 读）与
 * `sources`（原图，**落盘为 `ArrayBuffer` + `type`**）。`list()` 只开 `metas` 的事务，
 * 因此既不会读到 MB 级的原图，也不会把几十万格的 `grid` 载入内存——这对图纸库有几十个
 * 工程的情况很重要（规格 §7.1）。`metas` 与 `projects` 的 meta 在同一事务里写，不会漂移。
 *
 * **为什么原图落盘 `ArrayBuffer` 而不是 `Blob`**（任务 0 的实测结论，账本 R3）：happy-dom 的全局
 * `Blob` 过不了结构化克隆（无 `Symbol.toStringTag`，字节挂在 symbol 键上），裸 `structuredClone`
 * 就把它退化成 `{type}`；而 Node 原生 `Blob` 在 fake-indexeddb 下逐字节往返是**成功**的。也就是说
 * 「存 Blob」在生产上可行、但**测试里测不到那条路径**——除非用 `node:buffer` 的 Blob 冒充浏览器 Blob，
 * 那是「测的是 mock」的形态，会被判为缺陷。改存 `ArrayBuffer` 让测试与生产走同一条路径，
 * 在真实浏览器与 happy-dom 上都成立。代价是保存时把已在内存里的原图多拷一份字节。
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

/**
 * 陈旧数据库（本分支早期版本建的，只有 `projects` + `sources`）没有 `metas`。
 * `list()` 必须**响亮失败**：静默返回空数组会让用户以为图库空了，那正是本项目要消灭的
 * 「看起来正常、数据其实没读到」形态。（`DB_VERSION` 保持 1：尚未发布，不需要迁移，
 * 测试都用自己的新鲜数据库名。）
 */
function requireStore(db: IDBDatabase, name: string): void {
  if (!db.objectStoreNames.contains(name)) {
    throw new Error(
      `数据库 ${db.name} 里没有 ${name} object store（疑似旧版本残留）：请删除该库后重建，不要把它当空图库`,
    );
  }
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
      if (!db.objectStoreNames.contains(STORE_METAS)) {
        db.createObjectStore(STORE_METAS, { keyPath: "meta.id" });
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

/** `metas` store 记录的形状：**只有** meta，没有 doc / source。 */
interface StoredMeta {
  readonly meta: ProjectMeta;
}

/** `sources` store 记录的形状：原图字节 + MIME 类型。**存 `ArrayBuffer`，不存 `Blob`**（见文件头注释）。 */
interface StoredSource {
  readonly bytes: ArrayBuffer;
  readonly type: string;
}

async function readRecord(db: IDBDatabase, id: string): Promise<ProjectRecord | null> {
  const tx = db.transaction([STORE_PROJECTS, STORE_SOURCES], "readonly");
  const stored = await promisifyRequest<StoredProject | undefined>(
    tx.objectStore(STORE_PROJECTS).get(id),
  );
  if (stored === undefined) return null;
  const storedSource = await promisifyRequest<StoredSource | undefined>(
    tx.objectStore(STORE_SOURCES).get(id),
  );
  if (storedSource === undefined) return { meta: stored.meta, doc: stored.doc, source: null };
  // 出库时用**当前环境自己的 `Blob`** 重新包一次，接口对外仍是 Blob。
  return {
    meta: stored.meta,
    doc: stored.doc,
    source: { blob: new Blob([storedSource.bytes], { type: storedSource.type }), type: storedSource.type },
  };
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
        requireStore(db, STORE_METAS);
        // **只碰 `metas`**：`projects` 里有整张 grid，读它再丢掉就等于把几十万个数拉进内存
        // （规格 §7.1「grid 与 source 不进列表内存」）。改回读 `projects` 会被
        // `idbProjectStore.test.ts` 里的白盒用例打红。
        const tx = db.transaction(STORE_METAS, "readonly");
        const all = await promisifyRequest<StoredMeta[]>(tx.objectStore(STORE_METAS).getAll());
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
      // §12：`thumbnail` 是外部可影响的展示字段，而列表页会把它直接塞进 `<img src>`。
      // 只放行空串与 `data:image/`——`javascript:` / 远程 URL / `data:text/html` 一律拒绝，
      // 且必须在**任何写操作之前**拒绝。
      if (
        typeof record.meta.thumbnail !== "string" ||
        (record.meta.thumbnail !== "" && !record.meta.thumbnail.startsWith("data:image/"))
      ) {
        throw new Error(
          `工程封面图必须是 data:image/ 开头的字符串或空串（当前 ${String(record.meta.thumbnail)}）`,
        );
      }
      const meta = deriveMeta(
        { ...record.meta, name: normalizeProjectName(record.meta.name) },
        record.doc,
      );
      // **必须在开事务之前**把 Blob 读成 ArrayBuffer：IndexedDB 的事务在「没有挂起请求」时会
      // 自动提交，若在事务内部 `await` 一个非 IDB 的异步操作，等回来时事务已经关了，
      // 后面的 `put` 会抛 TransactionInactiveError（且只在大图上偶发，最难查）。
      const sourceBytes =
        record.source === null ? null : await record.source.blob.arrayBuffer();
      await withDb(async (db) => {
        // 三条记录在同一个事务里写：不能出现「meta 写进去了、原图没写进去」的半状态，
        // 也不能出现 `metas` 与 `projects` 的 meta 不一致（列表显示旧名字、详情是新名字）。
        const tx = db.transaction([STORE_PROJECTS, STORE_METAS, STORE_SOURCES], "readwrite");
        tx.objectStore(STORE_PROJECTS).put({ meta, doc: record.doc } satisfies StoredProject);
        tx.objectStore(STORE_METAS).put({ meta } satisfies StoredMeta);
        if (sourceBytes === null) {
          tx.objectStore(STORE_SOURCES).delete(record.meta.id);
        } else {
          tx.objectStore(STORE_SOURCES).put(
            { bytes: sourceBytes, type: (record.source as { type: string }).type } satisfies StoredSource,
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
        const tx = db.transaction([STORE_PROJECTS, STORE_METAS, STORE_SOURCES], "readwrite");
        tx.objectStore(STORE_PROJECTS).delete(id);
        tx.objectStore(STORE_METAS).delete(id);
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
        const tx = db.transaction([STORE_PROJECTS, STORE_METAS], "readwrite");
        tx.objectStore(STORE_PROJECTS).put({ meta, doc: record.doc } satisfies StoredProject);
        // `metas` 这份副本必须跟着改：`list()` 只读它，漏改就会出现「列表还是旧名字、
        // 点进去是新名字」——`list()` 与 `get()` 的 meta 必须逐字段相等（契约里有断言）。
        tx.objectStore(STORE_METAS).put({ meta } satisfies StoredMeta);
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
