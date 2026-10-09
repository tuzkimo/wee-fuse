import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { isReactive } from "vue";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import type { ProjectParams } from "@/core/project/types";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { getBuiltinPalette } from "@/services/palette";
import { renderPatternThumbnail } from "@/services/patternThumbnail";
import { setProjectStore, type ProjectMeta, type ProjectStore } from "@/services/projectStore";
import { useProjectSession, type RuntimeParams } from "@/stores/project";

/**
 * 会话 store 的用例。
 *
 * **为什么这个文件不在简报的文件清单里**：简报把测试面只划到 `LibraryPage.test.ts`，而
 * `stores/project.ts` 的 `load` / `adopt` / `save` / `reset` 因此零覆盖——其中 `save` 恰好是
 * 本项目最贵的一类缺陷（`AGENTS.md` 的 D1：两端各自都对、错在接线）：落盘格式的字段名是
 * `crop.w` / `crop.h` / `crop.rotate`，运行期是 `crop.width` / `crop.height` + 独立的
 * `rotation`，映射只发生在这一个函数里，错了不会抛错、只会静默产出一张错尺寸 / 未旋转的图。
 * 所以这里对**显式常量**断言，并跑一次 adopt → save → load 的端到端回读。
 *
 * 与 `projectStoreContract` 的假色卡不同，会话 store 的生产口径是 `getBuiltinPalette()`，
 * 故这里的图纸用内置 MARD221 的色卡 id 与真实下标。
 */

const PALETTE = getBuiltinPalette();

/** 一张 3×1 的图纸。色号下标**降序**（7 在 5 前面）：按下标直接搬会得到 [1, 0, EMPTY]。 */
function makePattern(): Pattern {
  return { width: 3, height: 1, paletteId: PALETTE.id, cells: Uint16Array.from([7, 5, EMPTY]) };
}

/** 运行期参数：注意 `crop.width/height` 与独立的 `rotation`。 */
const PARAMS: RuntimeParams = {
  longSide: 40,
  maxColors: 16,
  crop: { x: 1, y: 2, width: 30, height: 20 },
  rotation: 3,
};

/** 同一组参数的**落盘**形状：`crop.w/h/rotate`。两者由 store 负责搬运。 */
const DOC_PARAMS: ProjectParams = {
  longSide: 40,
  maxColors: 16,
  crop: { x: 1, y: 2, w: 30, h: 20, rotate: 3 },
};

const META: ProjectMeta = {
  id: "p1",
  name: "小猫",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  thumbnail: "",
  // 冗余字段故意填 0：`put` 必须从 doc 覆盖它们（见 projectStore.ts 的契约注释）。
  width: 0,
  height: 0,
  colorCount: 0,
};

function makeDoc() {
  return toProjectDocument(makePattern(), PALETTE, DOC_PARAMS);
}

/** 注入一份「已有一条 p1」的内存存储，并把记录返回给用例直接查库。 */
async function seedStore(): Promise<ProjectStore> {
  const store = await createMemoryProjectStore();
  await store.put({ meta: META, doc: makeDoc(), source: null });
  setProjectStore(store);
  return store;
}

describe("工程会话 store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("load 把工程载入内存，并把落盘的 crop.w/h/rotate 搬回运行期的 width/height/rotation", async () => {
    await seedStore();
    const session = useProjectSession();

    await expect(session.load("p1")).resolves.toBe(true);

    expect(session.error).toBe("");
    expect(session.dirty).toBe(false);
    expect(session.record?.meta.id).toBe("p1");
    expect(session.record?.meta.name).toBe("小猫");
    expect(session.pattern?.width).toBe(3);
    expect(session.pattern?.height).toBe(1);
    // 子集下标 → 全色卡下标：降序写入的色号必须还原成 [7, 5, EMPTY]
    expect([...(session.pattern?.cells ?? [])]).toEqual([7, 5, EMPTY]);
    expect(session.params?.longSide).toBe(40);
    expect(session.params?.maxColors).toBe(16);
    expect(session.params?.crop).toEqual({ x: 1, y: 2, width: 30, height: 20 });
    expect(session.params?.rotation).toBe(3);
    // markRaw：图纸持有 Uint16Array，被 Vue 深度代理纯属浪费（JSDoc 的承诺）
    expect(isReactive(session.pattern)).toBe(false);
  });

  it("load 找不到 id 时返回 false、把原因写进 error，并清掉当前会话（不留下半截）", async () => {
    await seedStore();
    const session = useProjectSession();
    // 先开一个会话（dirty=true）。否则下面的「全 null」是被空白初始态满足的，对「清空」零判别力。
    session.adopt(makePattern(), PARAMS, META, null, makeDoc());
    expect(session.dirty).toBe(true);

    await expect(session.load("nope")).resolves.toBe(false);

    expect(session.error).toContain("找不到工程：nope");
    expect(session.record).toBeNull();
    expect(session.pattern).toBeNull();
    expect(session.params).toBeNull();
    expect(session.dirty).toBe(false);
  });

  it("load 遇到损坏的 doc 时返回 false 并清空会话（不会留下「record 是新的、图纸是旧的」）", async () => {
    // `put` 侧不校验 doc（两个实现都只从 doc 派生 width / height / colorCount），
    // 所以「存储里躺着过不了 validateProjectDocument 的 doc」是可达状态：
    // 旧版本文件、被改坏的备份、将来某条写入路径。这里用「grid 长度与 width×height 不自洽」
    // 造一个必然解析失败的记录。
    const store = await seedStore();
    const badMeta: ProjectMeta = {
      ...META,
      id: "bad",
      name: "坏记录",
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
    await store.put({ meta: badMeta, doc: { ...makeDoc(), grid: [0] }, source: null });

    const session = useProjectSession();
    // 先处于「正开着 p1、且有未保存改动」的状态：这是半截会话会造成实际损害的前提
    session.adopt(makePattern(), PARAMS, META, null, makeDoc());
    expect(session.dirty).toBe(true);

    await expect(session.load("bad")).resolves.toBe(false);

    // 失败原因必须是「doc 解析失败」，而不是别的什么
    expect(session.error).toContain("不自洽");
    // 载入失败 ⇒ 当前没有工程（而不是「record 换成了 bad、pattern/params 还是 p1 的」）
    expect(session.record).toBeNull();
    expect(session.pattern).toBeNull();
    expect(session.params).toBeNull();
    expect(session.dirty).toBe(false);

    // 半截会话的真实后果：save() 会把上一个工程的图纸与参数写进坏记录的 id。
    // 会话已清空时必须写不进去。
    await expect(session.save()).resolves.toBe(false);
    expect((await store.get("bad"))?.meta.updatedAt).toBe(badMeta.updatedAt);
  });

  it("存储未注入时 load 返回 false 并把「未初始化」写进 error（不把异常抛给调用方）", async () => {
    await seedStore();
    setProjectStore(null);
    const session = useProjectSession();
    session.adopt(makePattern(), PARAMS, META, null, makeDoc());

    await expect(session.load("p1")).resolves.toBe(false);

    expect(session.error).toContain("工程存储尚未初始化");
    expect(session.record).toBeNull();
    expect(session.dirty).toBe(false);
  });

  it("adopt 用新生成的图纸开启会话：record 三件套齐全且 dirty 为 true", async () => {
    const session = useProjectSession();

    session.adopt(makePattern(), PARAMS, META, null, makeDoc());

    expect(session.dirty).toBe(true);
    expect(session.error).toBe("");
    expect(session.record).toEqual({ meta: META, doc: makeDoc(), source: null });
    expect([...(session.pattern?.cells ?? [])]).toEqual([7, 5, EMPTY]);
    // 不断言引用同一（`toBe`）：`params` 是普通对象，进 `ref` 后会被 Vue 包成响应式代理，
    // 那是框架的实现细节；这里只钉住「传进去的参数值被原样接收」。
    expect(session.params).toEqual(PARAMS);
    expect(isReactive(session.pattern)).toBe(false);
  });

  it("save 按落盘格式写回，且能被 load 端到端还原（crop 搬运 + 冗余字段由 put 派生）", async () => {
    const store = await seedStore();
    const session = useProjectSession();
    session.adopt(makePattern(), PARAMS, META, null, makeDoc());

    await expect(session.save()).resolves.toBe(true);
    expect(session.error).toBe("");
    expect(session.dirty).toBe(false);

    const saved = await store.get("p1");
    expect(saved?.doc.width).toBe(3);
    expect(saved?.doc.height).toBe(1);
    // 对显式常量断言，不做前后对称比较：`width` 写成 `w` 之外的位置错位都在这里红
    expect(saved?.doc.params).toEqual({
      longSide: 40,
      maxColors: 16,
      crop: { x: 1, y: 2, w: 30, h: 20, rotate: 3 },
    });
    expect(saved?.doc.grid).toEqual([1, 0, EMPTY]);
    // 冗余三件套由 put 从 doc 覆盖，不采信 adopt 传进去的 0
    expect(saved?.meta.width).toBe(3);
    expect(saved?.meta.height).toBe(1);
    expect(saved?.meta.colorCount).toBe(2);
    // save 会刷新 updatedAt。**本用例不依赖机器时钟**：只断言「与 adopt 传入的值不等」，
    // 不把它与 `new Date()` 比较（本机时钟是 2026-10-02，早于夹具常量）。
    expect(saved?.meta.updatedAt).not.toBe(META.updatedAt);

    // 端到端回读：save 出来的字节必须能被 load 还原成一模一样的运行期参数
    await expect(session.load("p1")).resolves.toBe(true);
    expect(session.params).toEqual(PARAMS);
    expect([...(session.pattern?.cells ?? [])]).toEqual([7, 5, EMPTY]);
    expect(session.dirty).toBe(false);
  });

  it("save 把原图副本原样带回存储（编辑器「改参数重跑」依赖它）", async () => {
    // `ProjectRecord.source` 的契约是「全尺寸原图副本；为 null 时 UI 必须禁用改参数重跑」。
    // 会话 store 若在 save 时把它丢掉，UI 只会看到一个突然不能重跑的工程——静默降级，
    // 而 `source` 是本文件里最后一个没有任何断言读过的字段。
    const store = await seedStore();
    const session = useProjectSession();
    const source = { blob: new Blob([new Uint8Array([7, 8, 9])]), type: "image/png" };
    session.adopt(makePattern(), PARAMS, META, source, makeDoc());

    await expect(session.save()).resolves.toBe(true);

    const saved = await store.get("p1");
    expect(saved?.source?.type).toBe("image/png");
    const bytes = new Uint8Array(await (saved?.source?.blob as Blob).arrayBuffer());
    // 逐字节比对：只比 type 抓不到「副本被换成了别的东西」
    expect([...bytes]).toEqual([7, 8, 9]);
  });

  it("没有会话时 save 返回 false 并写明原因，且不碰存储", async () => {
    const store = await seedStore();
    const session = useProjectSession();

    await expect(session.save()).resolves.toBe(false);

    expect(session.error).toContain("当前没有可保存的工程");
    // 库里那条仍是种子值：save 没有偷偷写一遍
    expect((await store.get("p1"))?.meta.updatedAt).toBe(META.updatedAt);
  });

  it("存储不可用时 save 返回 false，并保留内存状态（dirty 仍为 true）", async () => {
    await seedStore();
    const session = useProjectSession();
    session.adopt(makePattern(), PARAMS, META, null, makeDoc());
    setProjectStore(null);

    await expect(session.save()).resolves.toBe(false);

    expect(session.error).toContain("工程存储尚未初始化");
    expect(session.dirty).toBe(true);
    expect([...(session.pattern?.cells ?? [])]).toEqual([7, 5, EMPTY]);
  });

  it("reset 清空会话与错误", async () => {
    await seedStore();
    const session = useProjectSession();
    await session.load("nope");
    expect(session.error).not.toBe("");

    session.reset();

    expect(session.record).toBeNull();
    expect(session.pattern).toBeNull();
    expect(session.params).toBeNull();
    expect(session.dirty).toBe(false);
    expect(session.error).toBe("");
  });
});

/**
 * B3 追加：`markDirty()` 与 `save(options?: { thumbnail?: string })`。
 *
 * 新开一个 `describe` 而不是塞进上面那个块：上面 10 条用例一行都不许动（规格 §15 的单列改动面里
 * 没有本文件），把新增全部收在一个块里，`git diff` 的形状本身就是这条纪律的证据。
 *
 * 封面的口径来自规格 §8.2 的实测结论：`put` 从 `doc` 覆盖 `width` / `height` / `colorCount`
 * （`idbProjectStore.ts` / `memoryProjectStore.ts` 各自的 `deriveMeta` / `withDerivedMeta`），
 * **封面不在覆盖之列**——这件事的跨实现证据在 `services/__tests__/projectStoreContract.ts`
 * 第 295 行（「thumbnail 往返：合法 data:image/ 原样返回」，两个实现各跑一次），本文件不重复它。
 * 这里只测**会话层**的增量：「编辑之后那张新封面有没有被 `save()` 交到存储手里」。
 */
describe("B3：markDirty 与 save 的封面入参", () => {
  /**
   * **夹具修补 D2（简报的草稿在这里跑不起来）**：happy-dom 20.14.5 未注册 canvas adapter 时
   * `getContext("2d")` **返回 `null`**（这条实测事实记录在 `services/__tests__/patternThumbnail.test.ts`
   * 头部，本仓没有 `@happy-dom/canvas` 依赖），而 `NEW_THUMBNAIL` 是在 **describe 体**里求值的
   * ——不装替身，整个文件在**收集期**就抛 `无法获取 2D 上下文`，既有的 10 条也一条都跑不到。
   * 替身只实现被测渲染代码真正用到的四个成员，与 `patternThumbnail.test.ts` 同一口径；
   * 断言仍钉在真的 `HTMLCanvasElement` 与真的 `toDataURL` 上（happy-dom 这两者是真实实现）。
   */
  function createStubContext2D(): CanvasRenderingContext2D {
    const ctx = {
      imageSmoothingEnabled: true,
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: () => {
        /* 本块不断言像素，只借它跑通渲染 */
      },
      drawImage: () => {
        /* 同上 */
      },
    };
    return ctx as unknown as CanvasRenderingContext2D;
  }

  // 必须在 `NEW_THUMBNAIL` **之前**装上：那一行在收集期就会调进 `renderPatternThumbnail`。
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    ...args: unknown[]
  ) {
    return args[0] === "2d" ? createStubContext2D() : null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 旧封面：**非空**，一个合法的 data URL。既有用例的 `META` 是空串，钉不住「保留原值」。 */
  const OLD_THUMBNAIL = "data:image/png;base64,OLD";

  /**
   * B3 里编辑器保存时**真的**要传下去的东西：由 `renderPatternThumbnail` 产出的 data URL。
   *
   * **它的实际形态（实现者实测，别把它当成「缩略图渲染正确」的证据）**：本环境下它是
   * `"data:image/png;base64,"`，**长度 22、载荷为空**。原因不是实现错了，而是 happy-dom 在
   * 未注册 canvas adapter 时 `HTMLCanvasElement.prototype.toDataURL` 走的是
   * `data:${type};base64,${Buffer.from([]).toString("base64")}` 这一支（真 `toDataURL`、空载荷），
   * 而 2D 上下文是本块上面那个**平台替身**（见 D2 注释）——`putImageData` / `drawImage` 都是空实现，
   * 所以画布里根本没有像素。它证明的是「**一个真的渲染器出口产生的串能被 `save` 原样交给存储**」，
   * **不是**「缩略图的像素/尺寸/编码正确」（后者由 `services/__tests__/patternThumbnail.test.ts` 钉，
   * 真机观感在任务 9 的人工流程里做）。下面那条前缀断言因此**不是**对字面量的恒真断言。
   */
  const NEW_THUMBNAIL = renderPatternThumbnail(makePattern(), PALETTE);

  /** 与既有 `META` 同形，但封面非空、且 `updatedAt` 是一个**明确的旧值**（用于钉「被刷新」）。 */
  const META_WITH_THUMBNAIL: ProjectMeta = { ...META, thumbnail: OLD_THUMBNAIL };

  /** 种一条「已在库里、封面非空」的记录，并把内存存储注入进去。 */
  async function seedWithThumbnail(): Promise<ProjectStore> {
    const store = await createMemoryProjectStore();
    await store.put({ meta: META_WITH_THUMBNAIL, doc: makeDoc(), source: null });
    setProjectStore(store);
    return store;
  }

  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("① markDirty 幂等：两次调用后 dirty 仍为 true（不是 toggle）", () => {
    const session = useProjectSession();
    // 空白初始态先钉住基线：否则下面的 `true` 可能是被初始值满足的，断言没有判别力。
    expect(session.dirty).toBe(false);

    session.markDirty();
    expect(session.dirty).toBe(true);

    session.markDirty();
    // 只断言「仍是 true」：写成 `dirty.value = !dirty.value` 这类非幂等实现在这里会变回 false，
    // 而 §8.1 的口径是「幂等，把 dirty 置 true」——不是 toggle。
    expect(session.dirty).toBe(true);
  });

  it("② save 不传 options：行为与 B2 逐字一致——保留原封面、只刷新 updatedAt", async () => {
    const store = await seedWithThumbnail();
    const session = useProjectSession();
    session.adopt(makePattern(), PARAMS, META_WITH_THUMBNAIL, null, makeDoc());
    // 库里已有一条非空封面：不传 options 时它必须**原样留着**（这正是「向后兼容」的可观察形态）
    expect((await store.get("p1"))?.meta.thumbnail).toBe(OLD_THUMBNAIL);

    await expect(session.save()).resolves.toBe(true);

    const saved = await store.get("p1");
    // 空串是「保留原封面」的歧义源，`save` 自己不许把封面清成空串，更不许写成 undefined
    expect(saved?.meta.thumbnail).toBe(OLD_THUMBNAIL);
    // `updatedAt` 仍由 save 的既有口径刷成新时间：既有那条用例只断言「与 META.updatedAt 不等」，
    // 抓不到「改成等于 createdAt」这类实现（`createdAt` 也在 META 里、同样不相等）。
    expect(saved?.meta.updatedAt).not.toBe(META_WITH_THUMBNAIL.updatedAt);
    expect(saved?.meta.updatedAt).not.toBe(META_WITH_THUMBNAIL.createdAt);
    // id / name / createdAt 一个都不许被 save 顺手改掉
    expect(saved?.meta.id).toBe("p1");
    expect(saved?.meta.name).toBe("小猫");
    expect(saved?.meta.createdAt).toBe(META.createdAt);
    expect(session.dirty).toBe(false);
  });

  it("③ save({ thumbnail }) 把合法的新封面写进存储，且能被 session.load 端到端回读", async () => {
    const store = await seedWithThumbnail();
    const session = useProjectSession();
    session.adopt(makePattern(), PARAMS, META_WITH_THUMBNAIL, null, makeDoc());
    session.markDirty();
    // 前置断言：进 save 之前 dirty 必须是 true，否则下面的 `false` 是被初始值满足的
    expect(session.dirty).toBe(true);

    await expect(session.save({ thumbnail: NEW_THUMBNAIL })).resolves.toBe(true);

    expect(session.error).toBe("");
    expect(session.dirty).toBe(false);
    // 新值来自 `renderPatternThumbnail`——**不是**测试自己编的字符串（它的实际形态与「为什么它
    // 只证明前缀、不证明像素」见 `NEW_THUMBNAIL` 上方的注释），等于顺手跑了一次端到端接线
    expect(NEW_THUMBNAIL.startsWith("data:image/")).toBe(true);
    expect(NEW_THUMBNAIL).not.toBe(OLD_THUMBNAIL);

    const saved = await store.get("p1");
    // 这两条一起钉住「封面**真的**换了」：只断言 `not.toBe(OLD)` 会被空串满足
    expect(saved?.meta.thumbnail).toBe(NEW_THUMBNAIL);
    expect(saved?.meta.thumbnail).not.toBe(OLD_THUMBNAIL);
    // 冗余三件套仍由 put 从 doc 覆盖（换封面不影响它们）
    expect([saved?.meta.width, saved?.meta.height, saved?.meta.colorCount]).toEqual([3, 1, 2]);
    // 内存里的 record 也换成了新封面：页面随后读 session.record.meta.thumbnail 不能看到旧值
    expect(session.record?.meta.thumbnail).toBe(NEW_THUMBNAIL);

    // 端到端回读：保存出来的字节必须能被 load 还原成同一张封面与同一组参数
    await expect(session.load("p1")).resolves.toBe(true);
    expect(session.record?.meta.thumbnail).toBe(NEW_THUMBNAIL);
    expect(session.params).toEqual(PARAMS);
    expect([...(session.pattern?.cells ?? [])]).toEqual([7, 5, EMPTY]);
  });

  it.each([
    ["空串", ""],
    ["非 data:image/ 前缀（相对路径）", "images/cover.png"],
    ["远程 URL", "https://example.com/cover.png"],
    ["data:text/html", "data:text/html,<b>x</b>"],
    ["data:image 少了斜杠", "data:imagepng"],
  ])("④ save({ thumbnail }) 遇到非法封面（%s）抛中文错误，且一个字节都不写", async (_label, bad) => {
    const store = await seedWithThumbnail();
    const session = useProjectSession();
    session.adopt(makePattern(), PARAMS, META_WITH_THUMBNAIL, null, makeDoc());
    session.markDirty();

    // 校验必须在**任何写操作之前**（AGENTS.md 硬约束）：异常抛给调用方（`save` 的既有契约是
    // 「存储失败返回 false 并写 error」，而「入参非法」是调用方的编程错误，必须响亮失败、
    // 不许被吞成 `false`——吞掉就变成「保存按钮没反应」）。
    await expect(session.save({ thumbnail: bad })).rejects.toThrow(/data:image\//);
    await expect(session.save({ thumbnail: bad })).rejects.toThrow("封面");

    // 库里的封面与 updatedAt 都还是种子值：抛错前没有发生任何写
    const untouched = await store.get("p1");
    expect(untouched?.meta.thumbnail).toBe(OLD_THUMBNAIL);
    expect(untouched?.meta.updatedAt).toBe(META_WITH_THUMBNAIL.updatedAt);
    // 内存状态不被非法入参破坏（否则用户按了保存就丢编辑态）
    expect(session.dirty).toBe(true);
    expect(session.record?.meta.thumbnail).toBe(OLD_THUMBNAIL);
  });

  it("⑤ save({}) 与 save({ thumbnail: undefined }) 等价于不传 options（保留原封面）", async () => {
    const store = await seedWithThumbnail();
    const session = useProjectSession();
    session.adopt(makePattern(), PARAMS, META_WITH_THUMBNAIL, null, makeDoc());

    await expect(session.save({})).resolves.toBe(true);
    await expect(session.save({ thumbnail: undefined })).resolves.toBe(true);

    expect((await store.get("p1"))?.meta.thumbnail).toBe(OLD_THUMBNAIL);
    expect(session.dirty).toBe(false);
  });

  it("⑥ save 的封面判据是前缀而不是内容完整性：`data:image/` 被接受并原样落库", async () => {
    // **为什么这条断言「接受」而不是「拒绝」**（这条注释就是本用例存在的主要理由）：
    // 合法性的判据逐字取自规格 §12 与 `put` 的既有守卫——`startsWith("data:image/")` 且非空；
    // `"data:image/"` 两条都满足，所以它是**合法值**，简报「④ 非法清单」里的那一行与判据矛盾。
    // 判据守的是「列表页会把这个串直接塞进 `<img src>`」这个注入面（§12），**不是**「这张 PNG
    // 能不能解码」——内容完整性不属于这一层的判据。
    // 本环境的实证说明这条边界**不可再收紧**：happy-dom 真 `toDataURL`（无 canvas adapter）
    // 产出 `"data:image/png;base64,"`，载荷是 `Buffer.from([])` 即**空**——连渲染器自己的产物
    // 载荷都可能是空的，判据只能落在前缀上（见 `services/__tests__/patternThumbnail.test.ts`
    // 头部与本任务报告「NEW_THUMBNAIL 的实际形态」一节）。
    // **若将来把规则收紧成「必须含 `,`」或「前缀后必须有内容」，这条会红**——那时要同时改
    // `put` 的守卫、规格 §12 与本层的文案，而不是只改这里；把那次讨论逼出来正是它存在的理由。
    const store = await seedWithThumbnail();
    const session = useProjectSession();
    session.adopt(makePattern(), PARAMS, META_WITH_THUMBNAIL, null, makeDoc());
    expect(session.dirty).toBe(true); // 前置基线：否则下面的 `false` 是被初始值满足的

    await expect(session.save({ thumbnail: "data:image/" })).resolves.toBe(true);

    // 原样落库：既不被截断，也没被改写成 OLD_THUMBNAIL 或空串
    expect((await store.get("p1"))?.meta.thumbnail).toBe("data:image/");
    expect(session.record?.meta.thumbnail).toBe("data:image/");
    expect(session.error).toBe("");
    expect(session.dirty).toBe(false);
  });
});
