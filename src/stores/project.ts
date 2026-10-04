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

  /**
   * 用一份新生成的图纸开启会话。
   *
   * **B1 里没有生产消费者**（如实记录，别当成「生成页在用」）：B1 的生成页直接把新工程
   * `put` 进存储——它落盘后立刻跳回图纸库，不需要「当前会话」这个概念。这个方法是 B2/B3 的
   * 接口面（规格 §4.4 的会话模型：改参数重跑、编辑器接着改都要先采纳一份新图纸），
   * 本分支的 `project.test.ts` 覆盖了它。
   */
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

  /**
   * 把 `dirty` 置 `true`。**幂等**——重复调用不改变结果。
   *
   * 为什么需要它：`dirty` 的语义一直是「内存与存储不一致」，但在 B3 之前**只有 `adopt` 会置它**
   * （全仓 `dirty.value = true` 只有那一处）。编辑器的提交 / 撤销 / 重做都会让内存与存储不一致，
   * 却都不走 `adopt`。**不新增第二个 dirty 标志**（规格 §8.1）：两个标志迟早会出现「一个真一个假」
   * 的状态，而路由守卫只看其中一个——那正是「用户以为保存过了、其实没保存」的来源。
   *
   * 只有 `save()` 成功、`load()` 成功、`reset()` 会把它复位成 `false`。
   */
  function markDirty(): void {
    dirty.value = true;
  }

  /**
   * 把当前状态写回存储。失败时保留内存状态并返回 false（规格 §9）。
   *
   * `options.thumbnail`（B3 新增，可选）是**编辑后重算的封面**。规格 §8.2 的实测结论：
   * `put` 只从 `doc` 覆盖 `width` / `height` / `colorCount`（两个实现的 `deriveMeta` /
   * `withDerivedMeta`），**封面不在覆盖之列**——所以编辑过图纸之后不把新封面传进来，
   * 图纸库列表里的封面就永远停在首次生成那一刻的样子（不报错、只是看着是旧的）。
   * 调用方用 `renderPatternThumbnail(pattern, palette)` 出图，再 `save({ thumbnail })`。
   *
   * 不传 `options`（或 `options.thumbnail` 为 `undefined`）时行为与 B2 **逐字一致**：
   * 沿用 `record.value.meta.thumbnail`，既有调用点与既有断言一行都不用改。
   *
   * 入参校验在**任何写操作之前**、且**抛错而不是返回 false**：`thumbnail` 非法是调用方的编程错误，
   * 吞成 `false` 只会变成「按了保存没反应」——静默降级比响亮失败难查得多。
   * 空串**明确拒绝**：它在 `put` 的守卫里是合法值（= 无封面），在这里却是「保留原封面」的歧义源，
   * 两种语义共用一个值迟早写错。
   */
  async function save(options?: { thumbnail?: string }): Promise<boolean> {
    if (record.value === null || pattern.value === null || params.value === null) {
      error.value = "当前没有可保存的工程";
      return false;
    }
    const nextThumbnail = options?.thumbnail;
    if (
      nextThumbnail !== undefined &&
      (typeof nextThumbnail !== "string" || nextThumbnail === "" || !nextThumbnail.startsWith("data:image/"))
    ) {
      throw new Error(
        `保存时提供的工程封面必须是非空且以 data:image/ 开头的字符串（当前 ${String(nextThumbnail)}）`,
      );
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
        meta: {
          ...record.value.meta,
          updatedAt: new Date().toISOString(),
          ...(nextThumbnail === undefined ? {} : { thumbnail: nextThumbnail }),
        },
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

  return { record, pattern, params, dirty, error, load, adopt, save, markDirty, reset };
});
