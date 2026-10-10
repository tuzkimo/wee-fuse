import { createPinia, setActivePinia } from "pinia";
import { toRaw } from "vue";
import { beforeEach, describe, expect, it } from "vitest";
import { useDraft, type Stage } from "@/stores/draft";

/**
 * 向导草稿 store 的用例。
 *
 * 简报（task-7-brief.md）那份测试与它自己的实现有**两处不匹配**：`source` 是
 * `ref(plainObject)`，读出来是 Vue 的响应式代理，`expect(draft.source).toBe(SOURCE)` 恒假
 * （实测 2 条红）。这里改成 `expect(toRaw(draft.source)).toBe(SOURCE)`：`toRaw` 剥掉代理层，
 * 「同一张图还在草稿里」这件事才真正被钉住。**不要**改成 `draft.source.blob` 的同一性比较
 * （实测：那样写 4 条红——happy-dom 的 `Blob` 是普通对象，`ref` 里的它同样被 Vue 代理），
 * 也不要用 `toEqual(SOURCE)`（它把同一性交给结构化比较，不是这条断言想验的事）。
 *
 * 除简报的 17 条之外另有 9 条，补的都是**简报没钉住的承重行为**（详见 task-7-report.md）：
 * 非法输入不得留下半截草稿（2 条）、原图换小后既有选区仍不越界（1 条）、非法阶段抛错
 * （1 条）、退化 / 非有限选区在 `adoptProject` 入口就被拒（1 条）、没有原图尺寸时 `setCrop`
 * 响亮拒绝（1 条）、`releasePreview` 只释放预览（1 条）、`reset` 清干净每一段（1 条）、
 * `setBusy` / `setError` / `setStage` 是纯 setter（1 条）。
 *
 * 修复轮 1（审查驱动）再补 6 条：五个 setter 的**写入值**各一条（此前只断言了 `generated`，
 * 「赋值被删掉」26 条全绿——见下面 `describe("setter 的写入值…")`），以及 `setPreview` 的
 * `null` / 非对象守卫（1 条）。
 *
 * C8 任务 8 再补 5 条（`工程名是草稿的一段…` 那个 describe）：`draft.name` 的三个来源与
 * `setName` 的校验（2 条）、身份里不再有名字（1 条）、`stage` 只剩 edit / result（1 条）、
 * `adoptProject` 的记录名校验落在写操作之前（1 条）。**同一轮里改掉了既有断言中的
 * `stage === "crop"`（→ `"edit"`）与 `setRerunOf` / `rerunOf` 上关于 `name` 的那几条**
 * （规格直接冲突，逐条登记在 `task-8-report.md`）。
 */

const SOURCE = { blob: new Blob([new Uint8Array([1, 2, 3])]), type: "image/png", name: "小猫.png" };
/** 第二张图：用来分辨「新图到底有没有被写进去」，所以 blob / type / name 三者都不同。 */
const OTHER_SOURCE = { blob: new Blob([new Uint8Array([9, 9])]), type: "image/jpeg", name: "别的图.jpg" };

function fakePreview(): HTMLCanvasElement {
  return { width: 800, height: 600 } as unknown as HTMLCanvasElement;
}

function seedImage() {
  const draft = useDraft();
  draft.adoptImage({ source: SOURCE, sourceSize: { width: 800, height: 600 }, preview: fakePreview() });
  return draft;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("adoptImage：新图进来时的初始态", () => {
  it("选区是居中正方（与 B1 临时入口行为等价），阶段回到选区、未生成", () => {
    const draft = seedImage();
    expect(draft.crop).toEqual({ x: 100, y: 0, width: 600, height: 600 });
    expect(draft.stage).toBe("edit");
    expect(draft.generated).toBe(false);
    expect(draft.rotation).toBe(0);
    expect(draft.aspect).toBe("free");
    expect(draft.zoom).toBe("fit");
  });

  it("默认参数是 58 颗 / 32 色（字面量断言，常量被改坏时它会红）", () => {
    const draft = seedImage();
    expect(draft.longSide).toBe(58);
    expect(draft.maxColors).toBe(16);
  });

  it("换一张图会清掉上一次的 rerunOf、错误与改过的参数", () => {
    const draft = seedImage();
    draft.adoptProject({
      source: SOURCE,
      params: { longSide: 116, maxColors: "all", crop: { x: 0, y: 0, width: 10, height: 10 }, rotation: 2 },
      meta: { id: "p1", name: "旧图", createdAt: "2026-10-01T00:00:00.000Z" },
    });
    draft.setError("上一次的错误");
    expect(draft.rerunOf?.id).toBe("p1");

    draft.adoptImage({ source: SOURCE, sourceSize: { width: 800, height: 600 }, preview: fakePreview() });

    expect(draft.rerunOf).toBeNull();
    expect(draft.error).toBe("");
    expect(draft.longSide).toBe(58);
    expect(draft.maxColors).toBe(16);
  });

  it("非法尺寸在写操作之前抛错（不把上一份草稿冲成半截）", () => {
    const draft = seedImage();
    draft.setLongSide(116);

    expect(() =>
      draft.adoptImage({
        source: OTHER_SOURCE,
        sourceSize: { width: 800.5, height: 600 },
        preview: fakePreview(),
      }),
    ).toThrow(/原图宽度/);

    // 尺寸校验若落在赋值之后，这里会看到「新 source / 新尺寸 / 旧选区」的混合态。
    expect(toRaw(draft.source)).toBe(SOURCE);
    expect(draft.sourceSize).toEqual({ width: 800, height: 600 });
    expect(draft.crop).toEqual({ x: 100, y: 0, width: 600, height: 600 });
    expect(draft.longSide).toBe(116);
  });

  /**
   * **修复轮 1（审查发现）**：名字派生（`defaultProjectName` 在非字符串文件名上抛
   * 「文件名必须是字符串」）此前落在四次写操作**之后**，与 `adoptProject` 的
   * `normalizeProjectName` 顺序不一致。
   *
   * 可达性低（`File.name` 在 TS 里是 `string`），但「校验写在任何写操作之前」是 `AGENTS.md` 的
   * 硬约束：顺序错了就会留下「原图是新的、名字还是上一张图的」半截草稿，而调用方只看到一句抛错。
   * 判别力：把 `nextName` 挪回写操作之后，本用例的后四条立刻红。
   */
  it("非字符串文件名在写操作之前抛错（不留半截草稿）", () => {
    const draft = seedImage();
    expect(draft.name).toBe("小猫");

    expect(() =>
      draft.adoptImage({
        source: { blob: new Blob([]), type: "image/png", name: 42 as unknown as string },
        sourceSize: { width: 10, height: 10 },
        preview: fakePreview(),
      }),
    ).toThrow(/文件名/);

    // 名字校验若落在写操作之后：source / sourceSize / crop 全被换成新的，名字却还停在旧值。
    expect(toRaw(draft.source)).toBe(SOURCE);
    expect(draft.sourceSize).toEqual({ width: 800, height: 600 });
    expect(draft.crop).toEqual({ x: 100, y: 0, width: 600, height: 600 });
    expect(draft.name).toBe("小猫");
  });
});

describe("generated 的失效规则", () => {
  it("改选区 / 旋转 / 比例 / 长边 / 档位都会让「已生成」失效", () => {
    const draft = seedImage();
    draft.markGenerated();
    expect(draft.generated).toBe(true);

    draft.setCrop({ x: 0, y: 0, width: 100, height: 100 });
    expect(draft.generated).toBe(false);
    draft.markGenerated();
    draft.setRotation(1);
    expect(draft.generated).toBe(false);
    draft.markGenerated();
    draft.setAspect("1:1");
    expect(draft.generated).toBe(false);
    draft.markGenerated();
    draft.setLongSide(116);
    expect(draft.generated).toBe(false);
    draft.markGenerated();
    draft.setMaxColors("all");
    expect(draft.generated).toBe(false);
  });

  /**
   * **修复轮 1（审查发现）**：`setName` 起初不参与失效，于是「生成 → 重做 → 只改名 → 离开」时
   * 那次改名被 `onLeaveSetup()` 的作废分支静默丢掉，而只改 `longSide` 之类的参数就会保留草稿。
   *
   * 名字会被写进那条落盘记录（`generate()` 的 `meta.name`），属于影响产物的字段——与其它参数
   * setter 同形才对称。判别力：把 `setName` 里的 `generated.value = false;` 删掉，这条红。
   */
  it("改工程名也让「已生成」失效（名字是一等草稿字段，会被写进记录）", () => {
    const draft = seedImage();
    draft.markGenerated();
    expect(draft.generated).toBe(true);

    draft.setName("新名字");

    expect(draft.name).toBe("新名字");
    expect(draft.generated).toBe(false);
  });

  // 视图不是图纸参数：缩放与平移改了，产物一个像素都不会变。
  it("改缩放档位与平移**不**让「已生成」失效（它们不影响产物）", () => {
    const draft = seedImage();
    draft.markGenerated();
    draft.setZoom(4);
    draft.setPan({ x: -10, y: -20 });
    expect(draft.generated).toBe(true);
  });

  it("markGenerated 同时进入结果阶段", () => {
    const draft = seedImage();
    draft.markGenerated();
    expect(draft.stage).toBe("result");
  });
});

describe("setter 的写入值（把赋值整行删掉、只留守卫，这些用例必须转红）", () => {
  // 审查驱动的修复轮 1：下面五个 setter 此前**只**被断言了 `generated` 的失效与否，
  // 「值到底有没有写进去」从未被读过。控制者实测：把 `setZoom` / `setPan` / `setRotation` /
  // `setAspect` + `setMaxColors` 的赋值整行删掉（只留 `requireXxx(next);` 那半句守卫），
  // 26 条全绿。所以每条都**必须传入与默认值不同的值**——zoom 默认 "fit"、pan 默认 {0,0}、
  // rotation 默认 0、aspect 默认 "free"、maxColors 默认 32。传默认值进去，赋值被删掉时
  // 断言仍然是绿的，那是「读的是默认值」的假覆盖。

  it('setZoom 把传入的 "fit" 之外的档位写进 zoom', () => {
    const draft = seedImage();
    draft.setZoom(4);
    expect(draft.zoom).toBe(4);
  });

  it("setPan 把传入的非零平移写进 pan", () => {
    const draft = seedImage();
    draft.setPan({ x: -3, y: -7 });
    expect(draft.pan).toEqual({ x: -3, y: -7 });
  });

  it("setRotation 把传入的非 0 角度写进 rotation", () => {
    const draft = seedImage();
    draft.setRotation(2);
    expect(draft.rotation).toBe(2);
  });

  it('setAspect 把传入的 "free" 之外的比例锁写进 aspect', () => {
    const draft = seedImage();
    draft.setAspect("9:16");
    expect(draft.aspect).toBe("9:16");
  });

  it("setMaxColors 把传入的 32 之外的档位写进 maxColors", () => {
    const draft = seedImage();
    draft.setMaxColors(16);
    expect(draft.maxColors).toBe(16);
  });
});

describe("离开 SetupPage 时的生死规则（规格 §9）", () => {
  it("已生成且此后无改动 → 清空草稿", () => {
    const draft = seedImage();
    draft.markGenerated();
    draft.onLeaveSetup();
    expect(draft.source).toBeNull();
    expect(draft.preview).toBeNull();
    expect(draft.crop).toBeNull();
  });

  it("中途退出 → 只释放预览，选区与参数都留着", () => {
    const draft = seedImage();
    draft.setLongSide(116);
    draft.setCrop({ x: 10, y: 20, width: 100, height: 100 });
    draft.onLeaveSetup();

    expect(draft.preview).toBeNull();
    expect(toRaw(draft.source)).toBe(SOURCE);
    expect(draft.crop).toEqual({ x: 10, y: 20, width: 100, height: 100 });
    expect(draft.longSide).toBe(116);
  });

  it("生成后又改了参数再离开 → 按「中途退出」处理（草稿留着）", () => {
    const draft = seedImage();
    draft.markGenerated();
    draft.setLongSide(29);
    draft.onLeaveSetup();
    expect(toRaw(draft.source)).toBe(SOURCE);
    expect(draft.preview).toBeNull();
  });

  /**
   * **修复轮 1（审查发现）**：只改名的出口必须与「只改长边」一致——`setName` 纳入 `generated`
   * 失效之前，这条路会走「已生成且无改动」的作废分支，改名与整份草稿一起消失。
   */
  it("生成后只改了名字再离开 → 同样按「中途退出」处理（改名不会被静默作废）", () => {
    const draft = seedImage();
    draft.markGenerated();
    draft.setName("新名字");
    draft.onLeaveSetup();

    expect(toRaw(draft.source)).toBe(SOURCE);
    expect(draft.name).toBe("新名字");
    expect(draft.preview).toBeNull();
  });
});

describe("adoptProject：从已有工程改参数重跑", () => {
  it("播种旋转 / 长边 / 档位与覆盖目标；原图尺寸到齐后才落下选区", () => {
    const draft = useDraft();
    draft.adoptProject({
      source: SOURCE,
      params: { longSide: 116, maxColors: "all", crop: { x: 3, y: 5, width: 400, height: 200 }, rotation: 3 },
      meta: { id: "p1", name: "小猫", createdAt: "2026-10-01T00:00:00.000Z" },
    });

    // 原图尺寸还没解码出来：此刻**没有**选区，而不是一个用 NaN 算出来的选区。
    expect(draft.sourceSize).toBeNull();
    expect(draft.crop).toBeNull();

    draft.setSourceSize({ width: 800, height: 600 });

    expect(draft.sourceSize).toEqual({ width: 800, height: 600 });
    expect(draft.crop).toEqual({ x: 3, y: 5, width: 400, height: 200 });
    expect(draft.rotation).toBe(3);
    expect(draft.longSide).toBe(116);
    expect(draft.maxColors).toBe("all");
    expect(draft.rerunOf).toEqual({ id: "p1", createdAt: "2026-10-01T00:00:00.000Z" });
    // C8 §3.7：名字随记录一起进草稿，成为**唯一真相**（不再挂在身份上）。
    expect(draft.name).toBe("小猫");
    // 预览不在编辑器里解码：交给 SetupPage 挂载时补（规格 §7）。
    expect(draft.preview).toBeNull();
    expect(draft.stage).toBe("edit");
    expect(draft.generated).toBe(false);
  });

  it("越界的旧参数被夹进源图，而不是把 NaN 传进流水线", () => {
    const draft = useDraft();
    draft.adoptProject({
      source: SOURCE,
      params: { longSide: 58, maxColors: 24, crop: { x: -50, y: 900, width: 1200, height: 100 }, rotation: 0 },
      meta: { id: "p2", name: "手改坏的文件", createdAt: "2026-10-01T00:00:00.000Z" },
    });
    draft.setSourceSize({ width: 800, height: 600 });

    expect(draft.crop).toEqual({ x: 0, y: 500, width: 800, height: 100 });
  });

  it("非法参数在写操作之前抛错（不留半截草稿）", () => {
    const draft = seedImage();
    draft.setError("上一次的错误");

    expect(() =>
      draft.adoptProject({
        source: OTHER_SOURCE,
        params: {
          longSide: 116,
          maxColors: "all",
          crop: { x: 3, y: 5, width: 400, height: 200 },
          rotation: 7 as unknown as 0,
        },
        meta: { id: "p9", name: "坏参数", createdAt: "2026-10-01T00:00:00.000Z" },
      }),
    ).toThrow(/旋转角度/);

    // 抛错之后草稿必须还是原来那一份：新图没进去、旧选区还在、覆盖目标没换、错误没被清。
    expect(toRaw(draft.source)).toBe(SOURCE);
    expect(draft.crop).toEqual({ x: 100, y: 0, width: 600, height: 600 });
    expect(draft.rerunOf).toBeNull();
    expect(draft.error).toBe("上一次的错误");
  });

  it("退化 / 非有限的选区在入口就被拒（不留到 setSourceSize 才炸）", () => {
    const draft = useDraft();
    expect(() =>
      draft.adoptProject({
        source: SOURCE,
        params: { longSide: 58, maxColors: 24, crop: { x: Number.NaN, y: 0, width: 100, height: 100 }, rotation: 0 },
        meta: { id: "p3", name: "坏选区", createdAt: "2026-10-01T00:00:00.000Z" },
      }),
    ).toThrow(/选区/);

    // 校验在写操作之前：source 不能被这一份非法输入占上。
    expect(draft.source).toBeNull();
  });
});

describe("setSourceSize：原图尺寸落地的唯一入口", () => {
  it("要求整数且 ≥1（小数会让长度校验互相放过）", () => {
    const draft = useDraft();
    expect(() => draft.setSourceSize({ width: 0, height: 600 })).toThrow(/原图宽度/);
    expect(() => draft.setSourceSize({ width: 800.5, height: 600 })).toThrow(/原图宽度/);
    expect(() => draft.setSourceSize({ width: 800, height: Number.NaN })).toThrow(/原图高度/);
  });

  it("原图换小后既有选区仍被夹进新边界（「crop 合法且不越界」不被尺寸刷新破坏）", () => {
    const draft = seedImage();
    draft.setSourceSize({ width: 300, height: 300 });
    expect(draft.crop).toEqual({ x: 0, y: 0, width: 300, height: 300 });
  });
});

describe("其他入口校验（规格 §12）", () => {
  it("长边必须 1–116 的整数", () => {
    const draft = seedImage();
    for (const bad of [0, 117, 1.5, Number.NaN]) {
      expect(() => draft.setLongSide(bad)).toThrow(/长边豆数必须是 1–116 的整数/);
    }
  });

  it("档位只允许 8 / 16 / 24 / custom / all（旧枚举 32 / null 一律拒）", () => {
    const draft = seedImage();
    for (const bad of [32, null, 0, Number.NaN, "16"]) {
      expect(() => draft.setMaxColors(bad as unknown as 16)).toThrow(/档位/);
    }
    // 三个预设档 + 不限 + 自定义都放行
    for (const good of [8, 16, 24, "all", "custom"] as const) {
      expect(() => draft.setMaxColors(good)).not.toThrow();
    }
  });

  it("旋转 / 比例 / 缩放 / 平移的非法值抛错", () => {
    const draft = seedImage();
    expect(() => draft.setRotation(4 as unknown as 0)).toThrow(/旋转角度/);
    expect(() => draft.setAspect("16:9" as unknown as "4:3")).toThrow(/比例锁/);
    expect(() => draft.setZoom(3 as unknown as 2)).toThrow(/缩放档位/);
    expect(() => draft.setPan({ x: Number.NaN, y: 0 })).toThrow(/平移/);
  });

  it("阶段只允许 edit / result（旧的 crop / params 一律响亮拒绝，拼错不会静默留在状态机里）", () => {
    const draft = seedImage();
    draft.setStage("result");
    expect(draft.stage).toBe("result");

    expect(() => draft.setStage("crop" as unknown as Stage)).toThrow(/阶段/);
    expect(() => draft.setStage("params" as unknown as Stage)).toThrow(/阶段/);
    expect(() => draft.setStage("done" as unknown as Stage)).toThrow(/阶段/);
    expect(draft.stage).toBe("result");
  });

  it("setRerunOf：存一份副本、null 清空、非法字段抛中文错误且不改状态", () => {
    const draft = seedImage();
    expect(draft.rerunOf).toBeNull();

    // 合法输入：身份是「本草稿指向的那条落盘记录」，**存副本**——调用方（`SetupPage` 的 `meta`）
    // 原地改它不该悄悄改掉 store 里的身份。
    const meta = { id: "p1", createdAt: "2026-10-03T00:00:00.000Z" };
    draft.setRerunOf(meta);
    expect(draft.rerunOf).toEqual(meta);
    expect(draft.rerunOf).not.toBe(meta);

    // `null` = 清空（`adoptImage` / `reset` 的清理路径）。
    draft.setRerunOf(null);
    expect(draft.rerunOf).toBeNull();

    // 非法输入：`id` 空串会造出一条谁也打不开的记录（`put` 的键），必须响亮拒绝。
    draft.setRerunOf({ id: "keep", createdAt: "2026-10-03T00:00:00.000Z" });
    expect(() => draft.setRerunOf({ id: "", createdAt: "t" })).toThrow(/id/);
    expect(() =>
      draft.setRerunOf({ id: "x", createdAt: undefined as unknown as string }),
    ).toThrow(/createdAt/);
    // 校验写在任何写操作之前：两次抛错之后身份仍是上一条。
    expect(draft.rerunOf).toEqual({ id: "keep", createdAt: "2026-10-03T00:00:00.000Z" });
  });

  it("setCrop 把越界矩形夹回来（守住 crop 的合法不变量）", () => {
    const draft = seedImage();
    draft.setCrop({ x: 700, y: 500, width: 400, height: 400 });
    expect(draft.crop).toEqual({ x: 400, y: 200, width: 400, height: 400 });
  });

  it("setCrop 在没有原图尺寸时响亮拒绝（算不出边界就不知道夹到哪）", () => {
    const draft = useDraft();
    expect(() => draft.setCrop({ x: 0, y: 0, width: 10, height: 10 })).toThrow(/还没有选图/);
    expect(draft.crop).toBeNull();
  });

  it("setPreview 把画布挂上（重跑路径由 SetupPage 解码后调用；`markRaw` 让它保持同一性）", () => {
    const draft = useDraft();
    const canvas = fakePreview();
    draft.setPreview(canvas);
    expect(draft.preview).toBe(canvas);
  });

  it("setPreview 拒绝 null / undefined / 非对象，且不顶掉已挂上的画布", () => {
    const draft = seedImage();
    const canvas = draft.preview;
    expect(canvas).not.toBeNull();

    // 修复轮 1 实测（Vue 3.5.43）：没有这条守卫时，`null` / `undefined` 会在 `markRaw` 里抛英文
    // `TypeError`（`Cannot convert undefined or null to object`），而 `7` 这类原始值会被
    // `markRaw` 原样返回、**静默**写进 `preview`——下游就把非画布当画布用。守卫把三类都变成
    // 响亮的中文领域错误。`null` 也**不是**「清预览」的入口，清预览只有 `releasePreview()`。
    expect(() => draft.setPreview(null as unknown as HTMLCanvasElement)).toThrow(/预览/);
    expect(() => draft.setPreview(7 as unknown as HTMLCanvasElement)).toThrow(/预览/);
    expect(() => draft.setPreview(undefined as unknown as HTMLCanvasElement)).toThrow(/预览/);

    // 抛错发生在写操作之前：原来挂着的那张画布必须还在（`markRaw` 让它保持同一性）。
    expect(draft.preview).toBe(canvas);
  });
});

describe("releasePreview / reset", () => {
  it("releasePreview 只释放预览，其余状态一个不动", () => {
    const draft = seedImage();
    draft.setLongSide(116);
    draft.releasePreview();

    expect(draft.preview).toBeNull();
    expect(toRaw(draft.source)).toBe(SOURCE);
    expect(draft.sourceSize).toEqual({ width: 800, height: 600 });
    expect(draft.longSide).toBe(116);
    expect(draft.stage).toBe("edit");
  });

  it("reset 把每一段都退回初始态（含 busy / error / rerunOf）", () => {
    const draft = seedImage();
    draft.markGenerated();
    draft.setBusy(true);
    draft.setError("炸了");
    draft.setZoom(4);
    draft.setPan({ x: 5, y: 5 });
    draft.reset();

    expect(draft.source).toBeNull();
    expect(draft.sourceSize).toBeNull();
    expect(draft.preview).toBeNull();
    expect(draft.rerunOf).toBeNull();
    expect(draft.crop).toBeNull();
    expect(draft.rotation).toBe(0);
    expect(draft.aspect).toBe("free");
    expect(draft.zoom).toBe("fit");
    expect(draft.pan).toEqual({ x: 0, y: 0 });
    expect(draft.longSide).toBe(58);
    expect(draft.maxColors).toBe(16);
    expect(draft.stage).toBe("edit");
    expect(draft.generated).toBe(false);
    expect(draft.busy).toBe(false);
    expect(draft.error).toBe("");
    // C8 §3.7：名字也是草稿的一段，`reset` 必须一起清掉。
    expect(draft.name).toBe("");
  });

  it("setBusy / setError / setStage 是纯 setter，不改 generated", () => {
    const draft = seedImage();
    draft.markGenerated();
    draft.setBusy(true);
    draft.setError("保存失败");
    draft.setStage("result");
    expect(draft.generated).toBe(true);
    expect(draft.busy).toBe(true);
    expect(draft.error).toBe("保存失败");
    expect(draft.stage).toBe("result");
  });
});

/**
 * C8 规格 §3.7：工程名的**唯一真相**搬到草稿上（`draft.name`），身份（`RerunTarget`）收窄成
 * 「覆盖哪一条」。下面四条钉住这次收敛的三个面：名字的来源与可改性、非法输入响亮失败、
 * 身份里不再有名字、阶段只有两个取值。
 *
 * **简报给出的原句有两处笔误**，逐条登记在 `task-8-report.md` 的「测试侧更正」：
 * ① `fakeCanvas()` → 本文件既有的 `fakePreview()`；② 「传多余 `name` 会抛 /id|createdAt/」不成立
 * ——`{ id: "a", createdAt: "x" }` 两个字段都合法、`requireRerunTarget` 也不再看 `name`，
 * 所以它**不抛**；同一意图下改成「多传的 `name` 不得被存进身份」（有判别力，见下）。
 */
describe("工程名是草稿的一段，身份只管覆盖哪一条（C8 §3.7）", () => {
  it("工程名是草稿的一部分：选图即定名，可随时改（C8 规格 §3.7）", () => {
    const draft = useDraft();
    draft.adoptImage({
      source: { blob: new Blob([]), type: "image/png", name: "IMG_20260401_123456.jpg" },
      sourceSize: { width: 10, height: 10 },
      preview: fakePreview(),
    });
    expect(draft.name).toBe("IMG_20260401_123456");
    draft.setName("  小猫  ");
    expect(draft.name).toBe("小猫"); // 走 normalizeProjectName：trim + 非空 + ≤100
  });

  it("工程名非法时响亮失败，且不写坏已有的名字", () => {
    const draft = useDraft();
    draft.setName("小猫");
    expect(() => draft.setName("   ")).toThrow(/不能为空/);
    expect(() => draft.setName("阿".repeat(101))).toThrow(/100/);
    expect(draft.name).toBe("小猫");
  });

  it("身份只管「覆盖哪一条」：`rerunOf` 里不再有名字", () => {
    const draft = useDraft();
    draft.setRerunOf({ id: "a", createdAt: "2026-10-10T00:00:00.000Z" });
    expect(draft.rerunOf).toEqual({ id: "a", createdAt: "2026-10-10T00:00:00.000Z" });

    // 多传一个 `name`（旧形状）：身份必须**丢掉**它。实现若把 `name` 一起拷进身份
    // （即改回 `{ id, name, createdAt }`），`toEqual` 立刻红——这才是本条要钉的行为。
    draft.setRerunOf({ id: "a", name: "小猫", createdAt: "x" } as never);
    expect(draft.rerunOf).toEqual({ id: "a", createdAt: "x" });
    expect(draft.rerunOf).not.toHaveProperty("name");
  });

  it("stage 只有 edit / result 两个取值", () => {
    const draft = useDraft();
    expect(draft.stage).toBe("edit");
    draft.setStage("result");
    expect(draft.stage).toBe("result");
    // 旧取值一律被 requireStage 响亮拒绝。
    expect(() => draft.setStage("params" as never)).toThrow(/阶段/);
    expect(() => draft.setStage("crop" as never)).toThrow(/阶段/);
  });

  it("adoptProject 的记录名非法时在写操作之前抛错（不留半截草稿）", () => {
    const draft = seedImage();
    expect(draft.name).toBe("小猫");

    expect(() =>
      draft.adoptProject({
        source: OTHER_SOURCE,
        params: { longSide: 58, maxColors: 24, crop: { x: 0, y: 0, width: 10, height: 10 }, rotation: 0 },
        meta: { id: "p4", name: "   ", createdAt: "2026-10-01T00:00:00.000Z" },
      }),
    ).toThrow(/不能为空/);

    // 名字校验若落在写操作之后，这里会看到「新 source / 新身份 / 空名字」的混合态。
    expect(toRaw(draft.source)).toBe(SOURCE);
    expect(draft.rerunOf).toBeNull();
    expect(draft.name).toBe("小猫");
  });
});
