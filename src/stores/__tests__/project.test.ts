import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { isReactive } from "vue";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import type { ProjectParams } from "@/core/project/types";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { getBuiltinPalette } from "@/services/palette";
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
  maxColors: 32,
  crop: { x: 1, y: 2, width: 30, height: 20 },
  rotation: 3,
};

/** 同一组参数的**落盘**形状：`crop.w/h/rotate`。两者由 store 负责搬运。 */
const DOC_PARAMS: ProjectParams = {
  longSide: 40,
  maxColors: 32,
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
    expect(session.params?.maxColors).toBe(32);
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
      maxColors: 32,
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
