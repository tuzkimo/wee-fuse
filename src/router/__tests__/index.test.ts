import { describe, expect, it } from "vitest";
import { router } from "@/router";
import PickPage from "@/views/PickPage.vue";

/**
 * 路由表的用例（本任务新增）。
 *
 * **为什么补**：自审做变异时实测——把 `/new` 的 `name` 从 `"pick"` 改回 `"generate"`（即撤销本
 * 任务对路由表的那处改动），全量 720 条**一条都不红**。原因是本项目的页面用例一律整替
 * `vue-router`（`vi.mock("vue-router", …)` 只给一个假的 `useRouter`），它们看得见页面里的字符串，
 * 看不见路由表；而 `src/router/index.ts` 此前**没有任何用例读过它**。
 *
 * 于是「`/new` 指向选图页」这件事在别处全是间接覆盖：`LibraryPage.test.ts` 只钉住「按钮点了会
 * `push({ name: "pick" })`」，至于这个名字在路由表里存不存在、指向哪个组件，只有这里能回答。
 */
describe("router", () => {
  it("/new 是选图页：名字 pick、路径 /new、组件就是 PickPage", async () => {
    const route = router.resolve({ name: "pick" });

    expect(route.name).toBe("pick");
    expect(route.path).toBe("/new");

    // 只断言 name / path 的话，把 `component` 换回 GeneratePage 照样绿（懒加载器不会因为
    // `resolve` 就被调用）。这里直接把那个 loader 跑一次，做**恒等**比较。
    const loader = route.matched[0]?.components?.default;
    expect(typeof loader).toBe("function");
    const mod = await (loader as unknown as () => Promise<{ default: unknown }>)();
    expect(mod.default).toBe(PickPage);
  });

  it("原样未动的三条路由：/、/edit/:id、/lab/decode", () => {
    // 本任务只改 `/new` 一行；这三条是防止「顺手重构路由表」的回归线。
    expect(router.resolve({ name: "home" }).path).toBe("/");
    expect(router.resolve({ name: "editor", params: { id: "a" } }).path).toBe("/edit/a");
    expect(router.resolve({ name: "decode-lab" }).path).toBe("/lab/decode");
  });
});
