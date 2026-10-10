// src/composables/__tests__/useShellLifecycle.test.ts
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import App from "@/App.vue";
import { useOverlayBack } from "@/composables/useOverlayBack";
import { useShellLifecycle } from "@/composables/useShellLifecycle";
import { browserPlatform } from "@/services/platform/browserPlatform";
import { setPlatform } from "@/services/platform/capabilities";
import type { AppLifecycle, Platform } from "@/services/platform/types";
import { useProjectSession } from "@/stores/project";

/**
 * 返回键的四个分支（规格 §5.5.1 / §3.6.2）——**必须互不遮蔽**：
 * ① `canGoBack` ⇒ `backOrHome(router)`（**本轮修 2**：硬件返回键与页面上的返回箭头共用同一份判据——
 *    上一页是一条已作废的生图流程页时改回图纸库，否则 `router.back()`），让既有的路由守卫与确认条
 *    原样生效（**不新增第二套确认 UI**）；
 * ② 无历史 + 有未保存改动 ⇒ 走到图纸库（守卫会拦下并弹同一条确认条）——**绝不直接 exit**；
 * ③ 无历史 + 干净 ⇒ 正常退出。
 * ④ 有覆盖层 ⇒ **先关栈顶那一个、并消费掉这次返回**（C8 新增，规格 §3.6.2；Android 标准：临时界面
 *    优先于导航栈）。实现在回调**首行**先判它 ⇒ 上面的 ①②③ 只在覆盖层栈空时可及（编号沿用 B5 的
 *    ①②③，④ 是新增那支，不是执行顺序的第四位）。
 *
 * **为什么这几支要分开钉**：写成一个「dirty 就拦、否则退出」的函数在 ① 上会静默丢掉「回上一页」的行为
 * （用户按返回键会从编辑器直接退出 App），而四支挤在一起时，把 ① 接成 ③ 只会让一条红。
 * ① 的判据由 `views/backOrHome.ts` 给出（文件头写清了「为什么上一页是流程页时不能回去」），
 * 本文件的替身钉的是**这一支真的把路由器交给了那个函数**：`history.back()` 的裸调是上一轮的实机根因
 * （硬件返回键从没经过「流程页前缀」这条判据 ⇒ 又回 `/new` 选图页）。
 *
 * **「happy-dom 里没有导航语义」这句是错的、不要再照抄**（本轮修 2 顺手更正）：happy-dom 的
 * `window.history.back()` 会派发 `popstate` 并**真的驱动 vue-router**——`EditorBackNavFlow.test.ts`
 * 的断言 C 就是拿它当「硬件返回键」驱动真导航的。本节用替身钉调用（读数是「调了 `router.back()`
 * 没有」），真导航那一半在 `EditorBackNavFlow.test.ts` 与真机人工清单，两处不重复。
 *
 * **与计划逐字稿的一处刻意的加强（如实登记，不是变更）**：计划给的 ① 片段没有置脏，本文件在 ① 里
 * **先置脏再按返回键**。理由：分支的**顺序**也要被钉住——`if (session.dirty)` 写在 `if (info.canGoBack)`
 * 之前时，「有历史 + 有未保存改动」（编辑器里按返回键的**真正常态**）会变成 push 到图纸库，
 * 而计划片段里的 ① 在这种错序下**照样全绿**（它不置脏，走不到 dirty 那一支）。置脏之后：
 * ①（有历史 + 脏）钉顺序，②（无历史 + 脏）钉 dirty 分支本身，③（无历史 + 干净）钉退出，
 * **B5 那轮的用例条数不变**（当时验收要求恰好 5 条）；C8 又加了三条覆盖层用例（canGoBack 有历史的
 * ① vs ②、覆盖层关掉后回到既有分支、无历史 + 覆盖层），**本轮修 2 再加两条**（① 的流程页判据两格：
 * 「上一页已作废 ⇒ push home」与「当前页也在流程里 ⇒ back()」），本文件现共 **11 条**（含真路由表那条）。
 *
 * **如实登记这组用例的覆盖缺口（不假装已覆盖）**：4 格输入（`canGoBack` × `dirty`）里
 * **「有历史 + 干净」没有被单独覆盖**——它与 ① 同走 `if (info.canGoBack)` 那一支，而那一支的
 * 分支体不读 `session.dirty`。能通过本文件的 11 条、却在那一格出错的实现**是存在的**（把该支再按 `dirty`
 * 拆开，例如干净时顺手 `exit()`）；那种写法等于把同一条路拆成两条、属自造分支，而 B5 那轮的验收要求
 * 用例恰好 5 条，故当时不追加（C8 追加的三条与本轮修 2 追加的两条也刻意没碰这一格 ⇒ 缺口至今仍在）。
 *
 * **两种宿主，各钉一半**（照 `useShareIntake.test.ts` 的口径）：
 * - 内联 `Host`（照 `useCanvasSurface.test.ts` 的写法）跑 ①–④：`useShellLifecycle()` 的返回值是 `void`，
 *   handler 只能从**假平台**那里取回来驱动（`onBackButton` / `onExitRequested` 把 handler 存下来）。
 * - **真 `App.vue`** 跑 ⑤：装配住在 `App.vue` 的 setup 顶层，只测 composable 等于把「接线」留给审查者
 *   （本项目最严重的计划缺陷 D1 就是两端各自正确、错在接线）。真挂 `App.vue` 之后，「装配没被调用」
 *   会让 `offBack` / `offExit` 一次都不被调用 ⇒ ⑤ 红。
 *
 * **假平台只换 `lifecycle`**（其余照抄浏览器实现）。浏览器实现的 `lifecycle` 是**刻意的 no-op**
 * （规格 §5.5.3：`onExitRequested` / `onBackButton` 都返回 `NOOP_UNBIND`、`exit` 什么都不做）
 * ⇒ 拿它当桩就什么也钉不住，本文件的每一条都会恒真。
 */

/**
 * 路由替身（**本轮修 2 扩充**：composable 不再自己调 `history.back()`，而是把路由器交给
 * `views/backOrHome.ts`，所以替身要给出那个函数读的三样——`back` / `options.history.state` /
 * `currentRoute`，只有 `push` 的话点一下返回键就会在判据里 `undefined` 报错而不是「行为不对」）。
 * 其余从真模块透传——`App.vue` 的 `<RouterView />` 由挂载时的 `stubs` 提供（模板走
 * `resolveComponent`），不经过这里。
 *
 * **不为了省事改成让实现直接依赖 `window.history`**（那是实机缺陷的形态）：判据读的上一页是
 * vue-router 写进 `history.state.back` 的 fullPath，裸 `window.history` 给不出它
 * （见 `views/backOrHome.ts` 的文件头）。
 */
const routerStub = vi.hoisted(() => ({
  push: vi.fn(async (): Promise<unknown> => undefined),
  back: vi.fn((): void => undefined),
  /** `router.options.history.state`——判据读它的 `.back`，用例直接喂值。 */
  historyState: {} as { back?: unknown },
  /** `router.currentRoute.value.path`——「当前页也在流程里就不避开」那条判据要读它。 */
  currentRoute: { value: { path: "/" } },
}));
const push = routerStub.push;
const routeBack = routerStub.back;
const historyState = routerStub.historyState;
const currentRoute = routerStub.currentRoute;

vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return {
    ...actual,
    useRouter: () => ({
      push: routerStub.push,
      back: routerStub.back,
      options: { history: { state: routerStub.historyState } },
      currentRoute: routerStub.currentRoute,
    }),
  };
});

interface LifecycleSpies {
  readonly platform: Platform;
  /** `platform.lifecycle.exit()`。 */
  readonly exit: ReturnType<typeof vi.fn>;
  /** `onExitRequested` 返回的解绑函数。 */
  readonly offExit: ReturnType<typeof vi.fn>;
  /** `onBackButton` 返回的解绑函数。 */
  readonly offBack: ReturnType<typeof vi.fn>;
  /** 退出请求的 handler（`onExitRequested` 的入参）。 */
  readonly exitHandlers: (() => boolean)[];
  /** 返回键的 handler（`onBackButton` 的入参）。 */
  readonly backHandlers: ((info: { readonly canGoBack: boolean }) => void)[];
}

/**
 * 假平台：只换 `lifecycle`，并把两个 handler **存下来**交由用例驱动——丢进变量就再没人驱动过它们，
 * 「按返回键会发生什么」这条用户可见行为就零守卫（`useCanvasSurface.test.ts` 的 `stubResizeObserver`
 * 记着同一条教训）。
 */
function lifecycleSpies(): LifecycleSpies {
  const exitHandlers: (() => boolean)[] = [];
  const backHandlers: ((info: { readonly canGoBack: boolean }) => void)[] = [];
  const exit = vi.fn(async (): Promise<void> => undefined);
  const offExit = vi.fn();
  const offBack = vi.fn();
  const lifecycle: AppLifecycle = {
    onExitRequested: (handler) => {
      exitHandlers.push(handler);
      return offExit;
    },
    onBackButton: (handler) => {
      backHandlers.push(handler);
      return offBack;
    },
    exit,
  };
  return { platform: { ...browserPlatform, lifecycle }, exit, offExit, offBack, exitHandlers, backHandlers };
}

/**
 * 派发一次返回键。**先断言恰好注册了一个 handler**：装配两次（或在两个宿主里各装一次）时，
 * 「第一个 handler 的行为」会掩盖第二个，这里让它**响亮失败**而不是静默测一个替代品。
 */
function pressBack(spies: LifecycleSpies, info: { readonly canGoBack: boolean }): void {
  expect(spies.backHandlers).toHaveLength(1);
  spies.backHandlers[0](info);
}

/** 派发一次退出请求，返回它的 handler 的返回值（`true` = 阻止这次退出）。 */
function requestExit(spies: LifecycleSpies): boolean {
  expect(spies.exitHandlers).toHaveLength(1);
  return spies.exitHandlers[0]();
}

/** 内联宿主：DOM 刻意是空的——本 composable 没有任何模板面，handler 由假平台驱动。 */
const Host = defineComponent({
  setup() {
    useShellLifecycle();
  },
  template: `<div />`,
});

function mountHost() {
  return mount(Host);
}

/** 真 `App.vue`（模板里的 `<RouterView />` 要桩掉：本文件没有装真路由）。 */
function mountApp() {
  return mount(App, { global: { stubs: { RouterView: true } } });
}

beforeEach(() => {
  setActivePinia(createPinia());
  // `mockResolvedValueOnce` 这类一次性实现会跨用例泄漏（`mockClear` 只清调用记录、不清实现）⇒
  // 每个用例前重铺默认实现（`push` 成功时 resolve `undefined`，与 vue-router 一致）。
  push.mockReset();
  push.mockImplementation(async (): Promise<unknown> => undefined);
  routeBack.mockReset();
  // 判据读的两颗输入也是跨用例的模块级状态：不复位就会让后跑的用例继承上一个用例喂的历史 / 当前页。
  delete historyState.back;
  currentRoute.value.path = "/";
});

afterEach(() => {
  // 注入是**模块级状态**（`capabilities.ts` 的 `current`）：不复位就会让后跑的用例继承假平台。
  setPlatform(browserPlatform);
  vi.restoreAllMocks();
});

describe("useShellLifecycle", () => {
  it("canGoBack 且上一页不是流程页 ⇒ 调 router.back()，既不 push 也不 exit", () => {
    const spies = lifecycleSpies();
    setPlatform(spies.platform);
    // **前提写具体**（本轮修 2）：这一支已由 `backOrHome` 的判据接管，默认规则只在
    // 「上一页不是流程页」时走 `router.back()`；喂 `/`（图纸库）就是那一格。
    historyState.back = "/";
    currentRoute.value.path = "/edit/a";
    // **刻意先置脏**（见文件头）：有历史时返回键必须交给既有的路由守卫 + 确认条，
    // 而不是被 dirty 分支抢走 —— 编辑器里按返回键正是「有历史 + 有未保存改动」这一格。
    useProjectSession().markDirty();

    const wrapper = mountHost();
    pressBack(spies, { canGoBack: true });

    expect(routeBack).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(spies.exit).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  /**
   * **本轮修 2 的核心回归判据**（实机症状：结果页 →「编辑」→ 按返回 ⇒ 仍然回到选图页 `/new`）。
   *
   * 上一轮把「上一页是会失效的流程页 ⇒ 回图纸库」做成了按页传参的选项，于是只有 `EditorPage.vue`
   * 的返回箭头接了线，**硬件返回键这一支还是裸 `history.back()`**：它退到那条已作废的 `/new/setup`，
   * `SetupPage` 的入口守卫再把人弹回选图页 ⇒ 用户看到的就是「返回键仍然回到 `/new`」。
   *
   * 这条用例钉的正是那一支：当前页在编辑器（`/edit/a`，不在流程前缀下）、上一页是已作废的 `/new/setup`
   * ⇒ 必须 `push({ name: "home" })`，且 `router.back()` 一次都不能被调（那一 `back()` 正是死条目的来源）。
   * **修复前这条必红**：旧实现调的是裸 `window.history.back()`，`push` 一次都不会发生。
   */
  it("硬件返回键也走同一份判据：上一页是已作废的流程页 ⇒ push home，不 back()", () => {
    const spies = lifecycleSpies();
    setPlatform(spies.platform);
    historyState.back = "/new/setup";
    currentRoute.value.path = "/edit/a";
    // 编辑器里按返回键的真正常态：有历史 + 有未保存改动。dirty 分支不许把这一支抢走
    //（顺序由上面那条「上一页不是流程页」的用例钉住：那一格必须 back()）。
    useProjectSession().markDirty();

    const wrapper = mountHost();
    pressBack(spies, { canGoBack: true });

    expect(routeBack).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ name: "home" });
    expect(spies.exit).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  /**
   * **另一半（承重）**：当前页**也在**流程前缀下时**不避开**。生图页（当前 `/new/setup`）按返回
   * 必须回到选图页 `/new`——那是它的上一步。少了这个条件，生图页的返回会被改成回图纸库，
   * 比要修的缺陷更糟（`views/backOrHome.ts` 的 `isDeadFlowEntry` 写明了这一点）。
   */
  it("硬件返回键：当前页也在流程里（生图页的上一页是选图页）⇒ 照常 back()", () => {
    const spies = lifecycleSpies();
    setPlatform(spies.platform);
    historyState.back = "/new";
    currentRoute.value.path = "/new/setup";

    const wrapper = mountHost();
    pressBack(spies, { canGoBack: true });

    expect(routeBack).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(spies.exit).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("无历史 + dirty ⇒ 走路由去图纸库 `home`（**不 exit**）", () => {
    const spies = lifecycleSpies();
    setPlatform(spies.platform);
    useProjectSession().markDirty();

    const wrapper = mountHost();
    pressBack(spies, { canGoBack: false });

    // 守卫（`EditorPage` 的 `onBeforeRouteLeave`）会拦下这次导航并弹出**同一条**确认条；
    // 走到「图纸库」是**发起一次导航**、把决策交给既有机制，绝不是替用户决定丢弃。
    expect(push).toHaveBeenCalledWith({ name: "home" });
    expect(push).toHaveBeenCalledTimes(1);
    expect(spies.exit).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("无历史 + 干净 ⇒ exit() 恰好一次，且不 push", () => {
    const spies = lifecycleSpies();
    setPlatform(spies.platform);

    const wrapper = mountHost();
    expect(useProjectSession().dirty).toBe(false);
    pressBack(spies, { canGoBack: false });

    expect(spies.exit).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("退出请求的 handler 返回 session.dirty（干净 ⇒ false，dirty ⇒ true）", () => {
    const spies = lifecycleSpies();
    setPlatform(spies.platform);

    const wrapper = mountHost();
    // 干净 ⇒ `false` = 放行这次退出（`onCloseRequested` 不 `preventDefault`）。
    expect(requestExit(spies)).toBe(false);

    useProjectSession().markDirty();
    // dirty ⇒ `true` = 阻止这次退出，且**不弹任何东西**（此时用户看到的是「App 还在」，
    // 下一步他自己会点返回键或保存 —— 规格 §5.5.2）。
    expect(requestExit(spies)).toBe(true);
    expect(push).not.toHaveBeenCalled();
    expect(spies.exit).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("卸载 ⇒ 两个解绑函数各被调用一次（不泄漏监听）", () => {
    const spies = lifecycleSpies();
    setPlatform(spies.platform);

    // **真 `App.vue`**：这一条同时钉住「装配真的接了线」（没接线 ⇒ 两个解绑函数各自 0 次 ⇒ 红）。
    const wrapper = mountApp();
    // 解绑必须发生在卸载时，而不是挂载时（挂载就解绑 = 返回键与退出请求全程没人听）。
    expect(spies.offBack).not.toHaveBeenCalled();
    expect(spies.offExit).not.toHaveBeenCalled();

    wrapper.unmount();
    expect(spies.offBack).toHaveBeenCalledTimes(1);
    expect(spies.offExit).toHaveBeenCalledTimes(1);
  });

  it("有覆盖层 ⇒ 先关覆盖层：既不 router.back() 也不 push、也不 exit", () => {
    const spies = lifecycleSpies();
    setPlatform(spies.platform);
    // 覆盖层宿主只注册覆盖层，不装 shell 生命周期（`pressBack` 会断言 handler 恰好一个）。
    const closed = vi.fn();
    const Overlay = defineComponent({
      setup() {
        useOverlayBack(closed);
      },
      template: `<div />`,
    });
    const overlay = mount(Overlay);
    const host = mountHost();

    pressBack(spies, { canGoBack: true });

    expect(closed).toHaveBeenCalledTimes(1);
    // 返回被覆盖层**消费掉**，不落到导航栈：这一步改钉路由替身上的 `back`（本轮修 2 后实现不再自己
    // 碰 `window.history`，钉它就成了恒真的哑弹）。
    expect(routeBack).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(spies.exit).not.toHaveBeenCalled();
    overlay.unmount();
    host.unmount();
  });

  it("覆盖层关掉之后再按返回键 ⇒ 回到既有的三分支（不遮蔽）", () => {
    const spies = lifecycleSpies();
    setPlatform(spies.platform);
    // 第二按要走的是 `canGoBack` 那一支里「上一页不是流程页」的格（本轮修 2 后判据在 `backOrHome`）。
    historyState.back = "/";
    currentRoute.value.path = "/edit/a";
    const closed = vi.fn();
    const Overlay = defineComponent({
      setup() {
        useOverlayBack(closed);
      },
      template: `<div />`,
    });
    const overlay = mount(Overlay);
    const host = mountHost();

    pressBack(spies, { canGoBack: true });
    pressBack(spies, { canGoBack: true });

    expect(closed).toHaveBeenCalledTimes(1);
    expect(routeBack).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    overlay.unmount();
    host.unmount();
  });

  it("无历史 + 有覆盖层 ⇒ 仍然先关覆盖层（不 exit）", () => {
    const spies = lifecycleSpies();
    setPlatform(spies.platform);
    const closed = vi.fn();
    const Overlay = defineComponent({
      setup() {
        useOverlayBack(closed);
      },
      template: `<div />`,
    });
    const overlay = mount(Overlay);
    const host = mountHost();

    pressBack(spies, { canGoBack: false });

    expect(closed).toHaveBeenCalledTimes(1);
    expect(routeBack).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(spies.exit).not.toHaveBeenCalled();
    overlay.unmount();
    host.unmount();
  });
});

/**
 * **关键 2 的守卫（2026-10-06 任务级审查发现）**：本文件的 9 条用例把 `useRouter` 换成了只带 `push` 的替身 ⇒
 * 导航目标**名字对不对**在这一层恒绿 ✗ —— 实测 `{ name: "library" }`（图纸库的真名是 `home`）能全绿通过，
 * 而真机上 `vue-router` 会在 matcher 里**同步抛** `MATCHER_NOT_FOUND`、`void router.push(...)` 吞不掉 ⇒
 * 返回键直接死 ✗。所以这里**拿真路由表**核一次目标名：它属于「A 的输出喂给 B」那条纪律的最小形态
 * （替身换掉了真接线 ⇒ 必须另有一条真件在环）。
 */
describe("useShellLifecycle：导航目标必须在真路由表里存在", () => {
  it("图纸库的 name 是 home（不是 library）", async () => {
    const { router } = await import("@/router");
    const names = router.getRoutes().map((route) => route.name);
    expect(names).toContain("home");
    expect(names).not.toContain("library");
  });
});