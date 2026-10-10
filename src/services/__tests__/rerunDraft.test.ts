import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import type { ProjectParams } from "@/core/project/types";
import { getBuiltinPalette } from "@/services/palette";
import { setProjectStore, type ProjectMeta } from "@/services/projectStore";
import { seedRerunDraft } from "@/services/rerunDraft";
import { useDraft } from "@/stores/draft";
import { useProjectSession, type RuntimeParams } from "@/stores/project";

/**
 * `seedRerunDraft` 的用例（C8 规格 §3.4）。
 *
 * **为什么单独测它**：编辑页的「重做」与编辑来源结果页的「重做」共用这一份，两处各写一遍就是
 * 「同一件事的第二份实现」，而它写错的形态是**静默的**——草稿身份不对 ⇒ 覆盖到别的记录；
 * 参数漏播 ⇒ 生成出来的图纸与记录不一致。
 *
 * **2026-10-10 口径简化**：用色数只剩一个数字字段，所以这里钉的判据从
 * 「`maxColors: "custom"` + `customMaxColors: 20` 两个字段一起过」收敛成
 * 「`maxColors: 20` 这一个数字过」——用色数取 20（草稿默认 16），播种与默认才分得开。
 */
const palette = getBuiltinPalette();

/** 夹具：2×1 图纸，用色数是 20（草稿默认 16 ⇒ 「播进去了」与「本来就是默认值」可区分）。 */
const DOC_PARAMS: ProjectParams = {
  longSide: 2,
  maxColors: 20,
  crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 },
};

/** 同一组参数的**运行期**形状（与 `stores/project.ts` 的 `RuntimeParams` 同口径）。 */
const RUNTIME_PARAMS: RuntimeParams = {
  longSide: 2,
  maxColors: 20,
  crop: { x: 0, y: 0, width: 8, height: 8 },
  rotation: 0,
};

const META: ProjectMeta = {
  id: "a",
  name: "小猫",
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T01:00:00.000Z",
  thumbnail: "",
  // 冗余字段：`put` 从 doc 覆盖它们，这里不参与本文件的行为。
  width: 0,
  height: 0,
  colorCount: 0,
};

function makePattern(): Pattern {
  return { width: 2, height: 1, paletteId: palette.id, cells: Uint16Array.from([0, EMPTY]) };
}

function makeDoc() {
  return toProjectDocument(makePattern(), palette, DOC_PARAMS);
}

beforeEach(() => {
  setActivePinia(createPinia());
  setProjectStore(null);
});

describe("seedRerunDraft（C8：编辑页与编辑结果页共用的一份播种）", () => {
  it("播种草稿时把记录里的用色数一起带过去（重跑必须用回那个数）", () => {
    const session = useProjectSession();
    const draft = useDraft();
    // 起点刻意不是 20（草稿默认 16）：`adoptProject` 若不播种 maxColors，读回来的就是默认值。
    expect(draft.maxColors).toBe(16);
    session.adopt(
      makePattern(),
      RUNTIME_PARAMS,
      META,
      { blob: new Blob([new Uint8Array([7, 8])]), type: "image/png" },
      makeDoc(),
    );

    expect(seedRerunDraft(draft, session)).toBe(true);
    expect(draft.maxColors).toBe(20);
    expect(draft.rerunOf?.id).toBe("a");
  });

  it("没有记录 / 没有原图 / 没有参数 ⇒ 返回 false 且一点草稿都不写", () => {
    const session = useProjectSession();
    const draft = useDraft();
    expect(seedRerunDraft(draft, session)).toBe(false);
    expect(draft.source).toBeNull();
    expect(draft.rerunOf).toBeNull();
  });

  it("记录在、但这张工程没有原图 ⇒ 同样返回 false（重跑无从谈起）", () => {
    const session = useProjectSession();
    const draft = useDraft();
    session.adopt(makePattern(), RUNTIME_PARAMS, META, null, makeDoc());

    expect(seedRerunDraft(draft, session)).toBe(false);
    expect(draft.source).toBeNull();
  });
});
