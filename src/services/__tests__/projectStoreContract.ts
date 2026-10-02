import { describe, expect, it } from "vitest";
import { loadPalette } from "@/core/palette/registry";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import type { ProjectParams } from "@/core/project/types";
import type { ProjectMeta, ProjectRecord, ProjectStore } from "@/services/projectStore";

export const contractPalette = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" },
    { code: "A2", hex: "#000000" },
    { code: "A3", hex: "#ff0000" },
  ],
});

export const contractParams: ProjectParams = {
  longSide: 2,
  maxColors: 16,
  crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 },
};

/** 造一条工程记录。`id` 与 `updatedAt` 可指定，用于验证排序。 */
export function makeRecord(
  id: string,
  name: string,
  updatedAt: string,
  options: { withSource?: boolean; thumbnail?: string } = {},
): ProjectRecord {
  const doc = toProjectDocument(
    {
      width: 2,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([2, EMPTY]),
    },
    contractPalette,
    contractParams,
  );
  const meta: ProjectMeta = {
    id,
    name,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt,
    thumbnail: options.thumbnail ?? "",
    // 下面三个是**故意的错误值**：契约要求 put 从 doc 覆盖它们，而不是采信入参。
    width: 999,
    height: 999,
    colorCount: 999,
  };
  return {
    meta,
    doc,
    source: options.withSource === true ? { blob: new Blob([new Uint8Array([7, 8])]), type: "image/png" } : null,
  };
}

/**
 * 两个实现的共用契约。任何一条在 IndexedDB 实现上通过、在内存实现上失败（或反之），
 * 都说明「可替换」这个承诺是假的。
 */
export function describeProjectStoreContract(
  label: string,
  createStore: () => Promise<ProjectStore>,
): void {
  describe(`${label} 契约`, () => {
    it("put 之后 get 能取回同一条记录", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      const record = await store.get("a");
      expect(record).not.toBeNull();
      expect(record?.meta.name).toBe("小猫");
      expect(record?.doc.grid).toEqual([0, EMPTY]);
    });

    it("冗余字段由 put 从 doc 覆盖，不采信调用方传的值", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      const meta = await store.get("a");
      expect(meta?.meta.width).toBe(2);
      expect(meta?.meta.height).toBe(1);
      expect(meta?.meta.colorCount).toBe(1);
    });

    it("source 为 null 时往返仍是 null", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      expect((await store.get("a"))?.source).toBeNull();
    });

    it("原图字节往返：类型不变、逐字节相同（落盘是 ArrayBuffer，接口仍是 Blob）", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z", { withSource: true }));
      const source = (await store.get("a"))?.source;
      expect(source?.type).toBe("image/png");
      expect(source?.blob).toBeInstanceOf(Blob);
      expect(source?.blob.size).toBe(2);
      // 逐字节比对：只比 size 抓不到「内容被换掉但长度相同」
      const bytes = new Uint8Array(await (source?.blob as Blob).arrayBuffer());
      expect([...bytes]).toEqual([7, 8]);
    });

    it("get 不存在的 id 返回 null，不抛错", async () => {
      const store = await createStore();
      expect(await store.get("nope")).toBeNull();
    });

    it("list 按 updatedAt 倒序，且不含 grid 与 source", async () => {
      // **本用例不依赖机器时钟**：三条 `updatedAt` 全部由本用例显式注入，断言只用到它们
      // 之间的相对大小，从不拿它们与 `new Date()` 比较。（本机时钟是 2026-10-02，早于上面的
      // 夹具常量 2026-10-03；任何「rename 之后必然排在最前」的写法都会在这台机器上假红，
      // 所以「rename 会更新 updatedAt」只用「前后值不等」断言，见上面的用例。）
      const store = await createStore();
      await store.put(makeRecord("old", "旧的", "2026-10-03T01:00:00.000Z"));
      await store.put(makeRecord("new", "新的", "2026-10-03T05:00:00.000Z"));
      await store.put(makeRecord("mid", "中间", "2026-10-03T03:00:00.000Z"));

      const list = await store.list();
      expect(list.map((m) => m.id)).toEqual(["new", "mid", "old"]);
      // 列表项不得把 doc / source 带出来（source 是 MB 级 Blob）
      expect(list[0]).not.toHaveProperty("doc");
      expect(list[0]).not.toHaveProperty("source");
    });

    it("remove 之后 list 与 get 都看不到它", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      await store.remove("a");
      expect(await store.get("a")).toBeNull();
      expect(await store.list()).toEqual([]);
    });

    it("remove 不存在的 id 不抛错（幂等）", async () => {
      const store = await createStore();
      await expect(store.remove("nope")).resolves.toBeUndefined();
    });

    it("rename 只改 name 与 updatedAt，不碰 doc", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      const before = await store.get("a");
      const renamed = await store.rename("a", "小狗");

      expect(renamed.name).toBe("小狗");
      expect(renamed.updatedAt).not.toBe("2026-10-03T01:00:00.000Z");
      const after = await store.get("a");
      expect(after?.meta.name).toBe("小狗");
      expect(after?.doc).toEqual(before?.doc);
      expect(after?.meta.createdAt).toBe(before?.meta.createdAt);
    });

    it("get 返回的是副本，改它不会写回库里（与 IndexedDB 的结构化克隆语义一致）", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      const first = await store.get("a");
      // 故意在取出的对象上乱改：真实的调用方（编辑器）会就地改 grid
      (first as { meta: { name: string } }).meta.name = "被改坏了";
      (first?.doc.grid as number[])[0] = 999;
      // 嵌套层也要试：只换掉 `doc` 本身而共享 `params.crop` / `palette.codes` 的浅拷贝
      // 会让这两处静默写回库里（IDB 的结构化克隆是**逐层**拷贝，内存实现必须一致）。
      (first?.doc.params.crop as { x: number }).x = 999;
      (first?.doc.palette.codes as string[])[0] = "被改坏了";

      const second = await store.get("a");
      expect(second?.meta.name).toBe("小猫");
      expect(second?.doc.grid).toEqual([0, EMPTY]);
      expect(second?.doc.params.crop.x).toBe(0);
      expect(second?.doc.palette.codes).toEqual(["A3"]);
    });

    it("put 之后调用方改自己那份 record，也不会改到库里（写入侧同样要拷贝）", async () => {
      // 这条不是简报原文（同文件末尾那几条补充）：上面那条只盖住了**出库侧**的引用泄漏。
      // 把内存实现的 `put` 改成 `records.set(record.meta.id, stored)`（不 clone），
      // 上面的用例仍然全绿——因为出库时又 clone 了一次。可调用方（编辑器）会在 put 之后
      // 继续就地改同一份 `doc.grid` 做下一轮生成，那样「已保存的版本」会被静默改掉，
      // 而 IDB 实现因为结构化克隆不会。这正是「换实现不影响调用方」要挡住的事。
      const store = await createStore();
      const mine = makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z");
      await store.put(mine);
      (mine.doc.grid as number[])[0] = 999;
      (mine as { meta: { name: string } }).meta.name = "被改坏了";

      const after = await store.get("a");
      expect(after?.meta.name).toBe("小猫");
      expect(after?.doc.grid).toEqual([0, EMPTY]);
    });

    it("rename 不存在的 id 抛错", async () => {
      const store = await createStore();
      await expect(store.rename("nope", "x")).rejects.toThrow(/找不到/);
    });

    it("rename 拒绝空白名与超长名", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      await expect(store.rename("a", "   ")).rejects.toThrow(/名称/);
      await expect(store.rename("a", "x".repeat(101))).rejects.toThrow(/名称/);
    });

    it("put 覆盖同 id 的记录（不产生两条）", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      await store.put(makeRecord("a", "小猫二号", "2026-10-03T02:00:00.000Z"));
      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.name).toBe("小猫二号");
    });

    // -----------------------------------------------------------------------
    // 以下四条是**实现者事后变异自审时的补充**（简报的 13 条用例逐字未改）：
    // 变异实测证明简报原有断言**读不到**这几处行为——把 `normalizeProjectName` 的
    // `return trimmed` 改成 `return name`，13 条用例在两个实现上**全绿**；把 `put` 的
    // id 守卫整段删掉也全绿；把长度上限的 `>` 改成 `>=` 同样全绿；IDB 的 `put` 覆盖时
    // 不清 `sources` 旧行也全绿（`get` 会返回上一张图）。
    // 「换实现不影响调用方」这个承诺要成立，这几处也是契约的一部分，故补上断言。
    // -----------------------------------------------------------------------

    it("名称归一化：put 与 rename 都去掉首尾空白", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "  小猫  ", "2026-10-03T01:00:00.000Z"));
      expect((await store.get("a"))?.meta.name).toBe("小猫");

      const renamed = await store.rename("a", "  小狗  ");
      expect(renamed.name).toBe("小狗");
      expect((await store.get("a"))?.meta.name).toBe("小狗");
    });

    it("名称长度上限是闭区间：恰好 100 字接受，101 字拒绝", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      const atLimit = await store.rename("a", "x".repeat(100));
      expect(atLimit.name).toHaveLength(100);
      await expect(store.rename("a", "x".repeat(101))).rejects.toThrow(/名称/);
    });

    it("put 拒绝空 id（写库之前就响亮失败）", async () => {
      const store = await createStore();
      await expect(store.put(makeRecord("", "小猫", "2026-10-03T01:00:00.000Z"))).rejects.toThrow(
        /id/,
      );
      expect(await store.list()).toEqual([]);
    });

    it("用 source=null 覆盖已有记录后，get 不再返回旧原图", async () => {
      // 这条也不是简报原文（同上面三条）：把 IDB 实现 `put` 里
      // `if (sourceBytes === null) delete(...)` 的分支改成只在非 null 时才动 `sources`，
      // 原有的 16 条用例在两个实现上**全绿**——也就是「覆盖后残留旧原图」这个
      // 「看起来正常、其实给的是上一张图」的静默形态，原先没有任何断言在读。
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z", { withSource: true }));
      await store.put(makeRecord("a", "小猫", "2026-10-03T02:00:00.000Z"));
      expect((await store.get("a"))?.source).toBeNull();
    });

    // -----------------------------------------------------------------------
    // 以下八条是**修复轮 1**（控制者按规格 §12 的 `put` 校验表、§7.1「grid 不进列表内存」
    // 与审查意见要求）补的，简报与计划样例都漏了这几处：
    // ① `put` 的 thumbnail 校验（规格 §12 明列，原实现任意字符串都能入库）
    // ② thumbnail 往返  ③ doc 非 grid 字段的逐字段往返（对显式常量断言，不做前后对称比较）
    // ④ rename 不动冗余字段  ⑤ `list()` 与 `get()` 的 meta 逐字段相等（`metas` store 的守门）
    // ⑥ `put` 拒绝空白 name  ⑦ 非字符串 name  ⑧ doc 嵌套字段的深拷贝
    // -----------------------------------------------------------------------

    it("thumbnail 非法时 put 拒绝，且失败发生在写库之前（list 仍为空）", async () => {
      const store = await createStore();
      // 三种都不以 `data:image/` 开头：脚本协议、远程 URL、非图片的 data URL。
      // 列表页会把 thumbnail 直接塞进 `<img src>`，所以这三类都必须进不了库。
      for (const bad of [
        "javascript:alert(1)",
        "https://example.com/x.png",
        "data:text/html;base64,AA",
      ]) {
        await expect(
          store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z", { thumbnail: bad })),
        ).rejects.toThrow(/封面图/);
      }
      expect(await store.list()).toEqual([]);

      // 正向：合法空串必须通过（挡住「非空即拒」这种写歪的守卫）。
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      expect((await store.get("a"))?.meta.thumbnail).toBe("");
    });

    it("thumbnail 往返：合法 data:image/ 原样返回", async () => {
      const store = await createStore();
      const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z", { thumbnail: dataUrl }));
      expect((await store.get("a"))?.meta.thumbnail).toBe(dataUrl);
    });

    it("doc 的非 grid 字段逐字段往返（对显式常量断言，不做前后对称比较）", async () => {
      // 前后对称比较（`expect(after).toEqual(before)`）抓不到「两边一起漏字段」：
      // 落盘时丢掉 `params`，before 与 after 会一起变成 `undefined` 而相等。
      // 所以这里把每个字段钉到**显式常量**上。
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      const doc = (await store.get("a"))?.doc;

      expect(doc?.format).toBe("weefuse-project");
      expect(doc?.version).toBe(1);
      expect(doc?.width).toBe(2);
      expect(doc?.height).toBe(1);
      expect(doc?.palette.id).toBe("fake");
      expect(doc?.palette.codes).toEqual(["A3"]);
      expect(doc?.params.longSide).toBe(2);
      expect(doc?.params.maxColors).toBe(16);
      expect(doc?.params.crop).toEqual({ x: 0, y: 0, w: 8, h: 8, rotate: 0 });
      expect(doc?.grid).toEqual([0, EMPTY]);
    });

    it("rename 不动冗余字段：width / height / colorCount 保持 put 写入的值", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      const renamed = await store.rename("a", "小狗");
      // 入参是 999（见 makeRecord），这里必须仍是 put 从 doc 派生的 2 / 1 / 1。
      expect(renamed.width).toBe(2);
      expect(renamed.height).toBe(1);
      expect(renamed.colorCount).toBe(1);

      const after = await store.get("a");
      expect(after?.meta.width).toBe(2);
      expect(after?.meta.height).toBe(1);
      expect(after?.meta.colorCount).toBe(1);
    });

    it("list 返回的 meta 与 get 返回的 meta 逐字段相等", async () => {
      // 这条是 `idbProjectStore` 改用独立的 `metas` store 后的守门用例：
      // 两份副本只要有一处漂移（put/rename 漏更新、列表少带字段），这里就红。
      const store = await createStore();
      await store.put(
        makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z", {
          thumbnail: "data:image/png;base64,AA",
        }),
      );
      const renamed = await store.rename("a", "小狗");
      const fromList = (await store.list())[0];
      const fromGet = (await store.get("a"))?.meta;

      expect(fromList).toEqual(fromGet);
      expect(fromGet).toEqual(renamed);
    });

    it("put 拒绝空白 name（与 rename 同一条守卫，但是另一个入口）", async () => {
      const store = await createStore();
      await expect(store.put(makeRecord("a", "   ", "2026-10-03T01:00:00.000Z"))).rejects.toThrow(
        /名称/,
      );
      expect(await store.list()).toEqual([]);
    });

    it("非字符串 name 拒绝：rename 与 put 都在写库之前抛错", async () => {
      const store = await createStore();
      await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
      await expect(store.rename("a", 123 as unknown as string)).rejects.toThrow(/必须是字符串/);

      const bad = makeRecord("b", "小猫", "2026-10-03T01:00:00.000Z");
      await expect(
        store.put({ ...bad, meta: { ...bad.meta, name: 123 as unknown as string } }),
      ).rejects.toThrow(/必须是字符串/);

      // 两次都必须失败在写库之前：库里有且只有 put 成功的那一条。
      expect((await store.list()).map((m) => m.id)).toEqual(["a"]);
      expect((await store.list())[0]?.name).toBe("小猫");
    });

    it("doc 的嵌套字段也是拷贝：改调用方的 params.crop.x 与 palette.codes 不会改到库里", async () => {
      const store = await createStore();
      const mine = makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z");
      await store.put(mine);
      (mine.doc.params.crop as { x: number }).x = 999;
      (mine.doc.palette.codes as string[])[0] = "被改坏了";

      const after = await store.get("a");
      expect(after?.doc.params.crop.x).toBe(0);
      expect(after?.doc.palette.codes).toEqual(["A3"]);
    });
  });
}
