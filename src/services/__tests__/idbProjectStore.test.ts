import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeProjectStoreContract, makeRecord } from "./projectStoreContract";
import { createIdbProjectStore } from "@/services/idbProjectStore";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import type { ProjectStore } from "@/services/projectStore";

let counter = 0;
describeProjectStoreContract("IndexedDB 实现", async () => {
  counter += 1;
  return createIdbProjectStore({ databaseName: `wee-fuse-contract-${counter}` });
});

// ---------------------------------------------------------------------------
// 实现者补充（白盒）：上面的契约用例逐字用简报，未删改。下面这条读的是 IndexedDB
// 内部形状（object store 名），所以只放在 IDB 实现文件里，不进共用契约。
//
// 为什么需要它：把 `remove` 里的 `tx.objectStore(STORE_SOURCES).delete(id)` 整行删掉，
// 契约用例（含「remove 之后 list 与 get 都看不到它」）**全部保持绿**——`projects` 里那条
// 记录没了，`get` 自然返回 null。可 `sources` 里那份 2–6 MB 的原图会永远留在库里，
// 而工程 id 是 UUID、不会再被复用，等于每删一个工程漏一份原图字节。接口层看不见这件事，
// 只能白盒读。
// ---------------------------------------------------------------------------

/** 直接开库数 `sources` 里的记录条数（白盒：依赖实现的 object store 名）。 */
function countSources(databaseName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("sources", "readonly");
      const count = tx.objectStore("sources").count();
      count.onsuccess = () => {
        db.close();
        resolve(count.result);
      };
      count.onerror = () => {
        db.close();
        reject(count.error ?? new Error("统计原图条数失败"));
      };
    };
    request.onerror = () => reject(request.error ?? new Error("无法打开工程数据库"));
  });
}

describe("IndexedDB 实现：删除时的存储卫生（白盒）", () => {
  it("remove 把 sources 里的原图一并删掉，不留孤儿", async () => {
    const databaseName = "wee-fuse-remove-hygiene";
    const store: ProjectStore = await createIdbProjectStore({ databaseName });
    await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z", { withSource: true }));
    expect(await countSources(databaseName)).toBe(1);

    await store.remove("a");
    expect(await countSources(databaseName)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 修复轮 1 补充（白盒）：`list()` 必须**完全不碰** `projects` store。
//
// 为什么需要它：把 `list()` 改回 `db.transaction(STORE_PROJECTS)` + `getAll()` 再丢掉
// `doc`，契约用例**全绿**——因为 `projects` 里的 meta 与 `metas` 里的完全一样，
// `list()` 返回的 meta 也一模一样（「list 的 meta 与 get 的 meta 逐字段相等」照样通过）。
// 可那时 `grid` 已经被整条读进内存了：长边 500 的图纸是 25 万个数，几十个工程就是
// 数十 MB 的瞬时分配，而 §4.4 冗余字段存在的全部理由就是避免这件事（规格 §7.1）。
// 接口层看不出「读了多少字节」，只能白盒：清空 `projects` 后 `list()` 仍须完好。
// ---------------------------------------------------------------------------

/** 清空某个 object store（白盒：依赖实现的 object store 名）。 */
function clearStore(databaseName: string, storeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error(`清空 ${storeName} 失败`));
      };
    };
    request.onerror = () => reject(request.error ?? new Error("无法打开工程数据库"));
  });
}

/** 建一个「旧版本残留」的库：版本 1，但只有 `projects` + `sources`，没有 `metas`。 */
function createLegacyDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("projects", { keyPath: "meta.id" });
      db.createObjectStore("sources");
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error ?? new Error("无法建旧版数据库"));
  });
}

describe("IndexedDB 实现：列表不读 grid（白盒）", () => {
  it("list() 只读 metas：把 projects 清空后仍能返回全部 meta", async () => {
    const databaseName = "wee-fuse-list-hygiene";
    const store: ProjectStore = await createIdbProjectStore({ databaseName });
    await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
    await store.put(makeRecord("b", "小狗", "2026-10-03T02:00:00.000Z"));

    await clearStore(databaseName, "projects");

    // 若 list() 是靠 projects 拿 meta 的，这里会变成空数组或读失败。
    expect((await store.list()).map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("陈旧库（没有 metas store）时 list() 响亮失败，而不是返回空图库", async () => {
    const databaseName = "wee-fuse-legacy-db";
    await createLegacyDatabase(databaseName);
    const store: ProjectStore = await createIdbProjectStore({ databaseName });

    // 匹配的必须是「没有 metas」这条专属文案：没有这条守卫时，fake-indexeddb 抛的是
    // 英文 `No objectStore named metas in this database`（实测），不会命中这个 matcher。
    await expect(store.list()).rejects.toThrow(/没有 metas/);
  });
});

// ---------------------------------------------------------------------------
// 修复轮 1 补充：`estimateUsage()` 此前零断言。
//
// 用 `vi.stubGlobal` 注入 `navigator.storage`（happy-dom 自己没有这个 API），三条分支
// 各自可判别：值透传 / 抛错回落 null / 非数字回落 null。内存实现刻意不模拟配额，
// 所以即使平台支持也返回 null——这条单独钉住，免得将来有人「顺手」把内存实现改成
// 读 navigator.storage（那会让两套实现在同一台机器上给出不同结果）。
// ---------------------------------------------------------------------------

describe("estimateUsage：平台能力是注入出来的", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorage(estimate: () => Promise<unknown>): void {
    vi.stubGlobal("navigator", { storage: { estimate } });
  }

  it("平台支持时原样透传 usage / quota", async () => {
    stubStorage(async () => ({ usage: 1, quota: 2 }));
    const store = await createIdbProjectStore({ databaseName: "wee-fuse-estimate-passthrough" });
    expect(await store.estimateUsage()).toEqual({ usage: 1, quota: 2 });
  });

  it("estimate 抛错时返回 null（占用显示只是锦上添花，不该让调用方崩）", async () => {
    stubStorage(async () => {
      throw new Error("配额查询失败");
    });
    const store = await createIdbProjectStore({ databaseName: "wee-fuse-estimate-throw" });
    expect(await store.estimateUsage()).toBeNull();
  });

  it("usage / quota 不是数字时返回 null（不把字符串或 undefined 透传出去）", async () => {
    stubStorage(async () => ({ usage: "1", quota: 2 }));
    const store = await createIdbProjectStore({ databaseName: "wee-fuse-estimate-badtype" });
    expect(await store.estimateUsage()).toBeNull();
  });

  it("内存实现即使平台支持也返回 null（刻意不模拟配额）", async () => {
    stubStorage(async () => ({ usage: 1, quota: 2 }));
    const store: ProjectStore = await createMemoryProjectStore();
    expect(await store.estimateUsage()).toBeNull();
  });
});
