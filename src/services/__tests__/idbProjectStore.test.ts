import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { describeProjectStoreContract, makeRecord } from "./projectStoreContract";
import { createIdbProjectStore } from "@/services/idbProjectStore";
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
