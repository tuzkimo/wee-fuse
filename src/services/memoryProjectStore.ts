import {
  normalizeProjectName,
  prepareRecordForPut,
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
   * IDB 走结构化克隆，**每一层**都是新对象。若这里只换掉 `doc` 本身、让 `params` /
   * `params.crop` / `palette.codes` 继续共享引用，调用方改 `doc.params.crop.x` 或
   * `palette.codes[0]` 就只会写进内存实现——「换实现不影响调用方」这个承诺就破了。
   * 所以逐层展开：`doc`、`doc.params`、`doc.params.crop`、`doc.palette`、
   * `doc.palette.codes`、`doc.grid` 全是新对象 / 新数组。
   *
   * `source.blob` 沿用同一引用（Blob 按约定不可变；IDB 实现读回时也是新建一个 Blob 包同一批字节）。
   */
  function cloneRecord(record: ProjectRecord): ProjectRecord {
    return {
      meta: { ...record.meta },
      doc: {
        ...record.doc,
        palette: { ...record.doc.palette, codes: [...record.doc.palette.codes] },
        grid: [...record.doc.grid],
        params: { ...record.doc.params, crop: { ...record.doc.params.crop } },
      },
      source: record.source === null ? null : { ...record.source },
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
      // 守卫 + 归一化工程名 + 按 doc 重算冗余字段：与 IDB 实现共用一份（`prepareRecordForPut`）。
      // 各写一份时，改口径只改到一处也不会红——而一旦内存实现漏改，生产（IDB）反而是对的，
      // 漂移是静默的。
      const stored = prepareRecordForPut(record);
      records.set(stored.meta.id, cloneRecord(stored));
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
