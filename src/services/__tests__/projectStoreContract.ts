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
  options: { withSource?: boolean } = {},
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
    thumbnail: "",
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

      const second = await store.get("a");
      expect(second?.meta.name).toBe("小猫");
      expect(second?.doc.grid).toEqual([0, EMPTY]);
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
  });
}
