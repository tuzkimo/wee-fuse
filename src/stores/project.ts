import { defineStore } from "pinia";
import { markRaw, ref } from "vue";
import { fromProjectDocument, toProjectDocument } from "@/core/project/file";
import type { ProjectParams } from "@/core/project/types";
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

  /** 清空会话状态（`reset` 与「载入失败」共用）。刻意不动 `error`。 */
  function clearSession(): void {
    record.value = null;
    pattern.value = null;
    params.value = null;
    dirty.value = false;
  }

  /**
   * 从存储载入一个工程。失败时把原因写进 `error`、**把会话清空**并返回 false。
   *
   * 「载入失败」的语义是**当前没有工程**，不是「保留上一个」更不是「留下半截」：
   * `record` 若在 `fromProjectDocument` 之前落位，解析一旦抛错就会剩下「`record` 是新工程、
   * `pattern` / `params` 还是上一个工程」，之后任意一次 `save()` 都会把**上一个工程的图纸与
   * 参数写进新工程的 id**。损坏的 doc 是现实存在的：`put` 侧不校验 doc（两个实现都只从 doc
   * 派生 width / height / colorCount），旧版本文件、被改坏的备份、将来某条写入路径都能产出它。
   * 所以顺序是**先解析、成功了再一次性提交会话状态**。
   */
  async function load(id: string): Promise<boolean> {
    error.value = "";
    try {
      const loaded = await getProjectStore().get(id);
      if (loaded === null) {
        clearSession();
        error.value = `找不到工程：${id}`;
        return false;
      }
      const parsed = fromProjectDocument(loaded.doc, getBuiltinPalette());
      record.value = loaded;
      pattern.value = markRaw(parsed.pattern);
      params.value = parsed.params;
      dirty.value = false;
      return true;
    } catch (e) {
      clearSession();
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
    clearSession();
    error.value = "";
  }

  return { record, pattern, params, dirty, error, load, adopt, save, reset };
});
