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
