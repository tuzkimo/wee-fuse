# C8 出口与交互重做、看图 / 打印改造、图面版式放大 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把「看图纸」做成主出口（看图 app 手势 + 底部操作条），把打印页做成多页预览 + 一键保存，把三个页面的按钮与工程名入口收敛，让图上的标题与用料条随图纸尺寸放大到可读并消除打印页左沿错位。

**架构：** 交互层新增一个「覆盖层返回栈」（`useOverlayBack` + `useShellLifecycle` 的返回键优先关覆盖层）；结果页从 `SetupPage` 抽成共用的 `ResultPanel` 并新增 `/edit/:id/result` 路由；`SheetViewer` 拿回捏合 / 双击 / 平移并自带打印入口；`ExportPanel` 从「一页一项」改为「多页预览 + 一个保存按钮」；core 侧把标题与用料条字号从固定像素改成由格像素推出的比例值，并把打印页的标题 / 用料条 / 网格块三处左沿对齐。

**技术栈：** TypeScript 严格模式、Vue 3 + Pinia + vue-router、Vitest（happy-dom）、Vite、Tailwind CSS v4。

**规格：** `docs/superpowers/specs/2026-10-10-c8-exits-viewer-and-layout-design.md`（本计划的论证依据，执行者两份都读）

## 全局约束

- `src/core/**` 是纯计算层：**不得** import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，**不得**引用 DOM 全局（闸门 `src/__tests__/coreBoundary.test.ts`）。
- `core/render/sheet.ts` 里**不得出现标识符 `cellPx`**、**不得直接读 `pattern.cells`**、**不得出现 `canvasWidth /` 或 `canvasHeight /` 这类除法**，且必须出现 `cellAt(`（闸门 `src/core/render/__tests__/layoutGate.test.ts`，四条检查，**一条不放宽**）。
- TypeScript 严格模式，**禁止 `any`**。
- 公开 API 必须校验到「非法输入响亮失败」，校验写在任何写操作之前。
- 提交信息用 Conventional Commits + 中文描述，例如 `feat(core): 标题与用料条字号改为随格像素缩放`。
- 不要加 `.npmrc`、不要改依赖版本、**不要引入任何第三方库**（手势与滑动条都用原生实现）。
- **不改打印页的版面规则**：`1 格 = min(实物豆径, 可打印宽/列, 可打印高/行)`、**永不放大超过实物**、纸型与板大小枚举、分页数学，一条都不动。29 板 + A4 恒为 `1 格 = 5.0mm（实物大小）`。
- `data-testid` **只加不删**：`sheet-close` / `export-close` / `export-panel` 等一律不改名（改的只是文案、图标与配色）。本计划里被删除的 id 只有规格 §4.1 / §5.3 明确列出的那些。
- 组件**不 import store**：`PatternToolbar` / `PalettePanel` / `ParamPanel` / `ResultPanel` / `ExportPanel` / `TierSlider` 一律 props 进、事件出（既有纪律，逐字沿用）。
- 关键常量（C8 生效值，逐字照抄规格 §7.5）：
  `SHEET_MARGIN = 20`、`SHEET_RULER_LEFT = 42`、`SHEET_RULER_TOP = 36`、`EXPORT_CELL_MAX_PX = 96`、
  `EXPORT_MAX_EDGE = 4096`、`SHEET_TITLE_FONT_RATIO = 0.5`、`SHEET_TITLE_FONT_MIN_PX = 24`、
  `SHEET_TITLE_FONT_MAX_PX = 56`、`SHEET_TITLE_LINE_RATIO = 1.3`、`SHEET_TITLE_GAP = 18`、
  `TITLE_FONT_HARD_MIN_PX = 16`、`TEXT_WIDTH_SAFETY = 1.05`、`LEGEND_FONT_RATIO = 0.36`、
  `LEGEND_FONT_MIN_PX = 18`、`LEGEND_FONT_MAX_PX = 40`、`LEGEND_ROW_RATIO = 1.7`、
  `LEGEND_SWATCH_RATIO = 1.25`、`LEGEND_CODE_GAP_RATIO = 0.5`、`LEGEND_ITEM_PAD_RATIO = 0.4`、
  `LEGEND_ITEM_SAMPLE = "F25 (12345)"`、`LEGEND_PAD_TOP = 24`、`SHEET_MIN_LABEL_FONT_PX = 10`、
  `PRINT_DPI = 300`、`PRINT_MARGIN_MM = 10`、`PRINT_BEAD_PX = 59`。
- 每个任务结束时 `npm run test` 必须**全绿**（中间态也不许红），最后一个任务另跑 `npm run build`。

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/composables/useOverlayBack.ts` | 覆盖层返回栈（Android 标准：先关最上层临时界面） | 创建 |
| `src/composables/useShellLifecycle.ts` | 返回键分支：先问覆盖层栈，再走导航栈 | 修改 |
| `src/views/LibraryPage.vue` | 去存储占用、按钮主次、删除框接返回栈 | 修改 |
| `src/core/render/layout.ts` | 字号比例常量、文本宽度估算、标题字号、用料条几何推导、打印页左沿 | 修改（核心） |
| `src/core/render/sheet.ts` | 用料条字号改读计划；标题 / 用料条不再读私有常量 | 修改 |
| `src/services/sheetExport.ts` | 两条 Blob 通道把 `projectName` 传给计划；`boardPageTile` 多收名字 | 修改 |
| `src/components/result/ResultPanel.vue` | 结果卡片（两个宿主共用）+ 自带查看层 | 创建 |
| `src/views/EditResultPage.vue` | `/edit/:id/result` 宿主（标题「修改成功」） | 创建 |
| `src/views/backOrHome.ts` | `backOrHome()`：历史为空时回首页的唯一判据 | 创建 |
| `src/services/rerunDraft.ts` | `seedRerunDraft()`：从记录播种草稿（编辑页与结果页共用） | 创建 |
| `src/router/index.ts` | 新增 `edit-result` 路由 | 修改 |
| `src/views/EditorPage.vue` | 返回箭头、删两个覆盖层、保存后跳结果页、重做搬进工具栏 | 修改 |
| `src/components/editor/PatternToolbar.vue` | 删查看 / 打印，加重做 / 橡皮 | 修改 |
| `src/components/editor/PalettePanel.vue` | 色槽变按钮（下拉）、删添加颜色与橡皮 | 修改 |
| `src/components/sheet/SheetViewer.vue` | 捏合 / 双击 / 平移 + 底部操作条 + 打印入口 + 接返回栈 | 重写 |
| `src/components/editor/ExportPanel.vue` | 多页预览 + 一键顺序保存 + 返回箭头 + 接返回栈 | 重写 |
| `src/views/SetupPage.vue` | 单页布局、返回箭头、改名输入、滑动条、stage 收敛 | 修改 |
| `src/components/param/ParamPanel.vue` | 工程名输入 + 两个滑动条 + 删声明 | 修改 |
| `src/components/param/TierSlider.vue` | 滑动条 + 节点刻度 + 数字输入框 | 创建 |
| `src/stores/draft.ts` | `name` 单一真相、`RerunTarget` 收窄、`Stage` 收敛 | 修改 |
| `docs/开发约定详解.md` / `docs/开发文档索引.md` 等 | 常量表与新口径 | 修改 |

---

## 任务 1：覆盖层返回栈与 Android 返回键（规格 §3.6.2）

**文件：**
- 创建：`src/composables/useOverlayBack.ts`
- 修改：`src/composables/useShellLifecycle.ts:54-64`
- 测试：`src/composables/__tests__/useOverlayBack.test.ts`（新建）、`src/composables/__tests__/useShellLifecycle.test.ts`（扩两条）

- [ ] **步骤 1：写失败的测试（栈本身）**

新建 `src/composables/__tests__/useOverlayBack.test.ts`：

```ts
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick, ref } from "vue";
import { closeTopOverlay, useOverlayBack } from "@/composables/useOverlayBack";

/**
 * 覆盖层返回栈（C8 规格 §3.6.2）：**后进先出**，与 Android 的「先关最上层临时界面」一致。
 * 栈是模块级状态，所以每个用例前必须把它清空——用例之间靠 `unmount()` 注销，
 * 漏掉一次就会把上一个用例的覆盖层留给下一个（本文件每一条都自己挂、自己卸）。
 */

/** 按挂载生命周期注册的宿主（`active` 不给）。 */
function mountOverlay(onBack: () => void) {
  const Host = defineComponent({
    setup() {
      useOverlayBack(onBack);
    },
    template: `<div />`,
  });
  return mount(Host);
}

/** 由外部布尔量控制注册与否的宿主（确认条 / 对话框那一类）。 */
function mountToggle(onBack: () => void, active: ReturnType<typeof ref<boolean>>) {
  const Host = defineComponent({
    setup() {
      useOverlayBack(onBack, () => active.value);
    },
    template: `<div />`,
  });
  return mount(Host);
}

describe("useOverlayBack", () => {
  it("栈空时 closeTopOverlay 返回 false（不抛）", () => {
    expect(closeTopOverlay()).toBe(false);
  });

  it("挂载即注册：关掉它返回 true，再关一次返回 false", () => {
    const closed = vi.fn();
    const wrapper = mountOverlay(closed);

    expect(closeTopOverlay()).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closeTopOverlay()).toBe(false);
    wrapper.unmount();
  });

  it("后注册的先关（LIFO，打印页压在查看层之上时先关打印页）", () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = mountOverlay(first);
    const b = mountOverlay(second);

    expect(closeTopOverlay()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(closeTopOverlay()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
  });

  it("卸载即注销（关不掉的覆盖层会让返回键永远走不到导航栈）", () => {
    const closed = vi.fn();
    const wrapper = mountOverlay(closed);
    wrapper.unmount();

    expect(closeTopOverlay()).toBe(false);
    expect(closed).not.toHaveBeenCalled();
  });

  it("active 为假时不注册，变真才注册，回落假即注销", async () => {
    const closed = vi.fn();
    const active = ref(false);
    const wrapper = mountToggle(closed, active);

    expect(closeTopOverlay()).toBe(false);

    active.value = true;
    await nextTick();
    expect(closeTopOverlay()).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);

    // 重复置真不重复注册：栈里仍然只有它一个（否则返回键会连关两次、第二次关到不存在的东西）
    active.value = true;
    await nextTick();
    expect(closeTopOverlay()).toBe(false);

    active.value = true;
    await nextTick();
    active.value = false;
    await nextTick();
    expect(closeTopOverlay()).toBe(false);
    wrapper.unmount();
  });

  it("非函数入参响亮失败（不静默注册一个空回调）", () => {
    expect(() => useOverlayBack(undefined as never)).toThrow(/关闭回调/);
    expect(closeTopOverlay()).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/composables/__tests__/useOverlayBack.test.ts`
预期：FAIL —— `Failed to resolve import "@/composables/useOverlayBack"`。

- [ ] **步骤 3：实现 `useOverlayBack`**

新建 `src/composables/useOverlayBack.ts`：

```ts
// src/composables/useOverlayBack.ts
import { onUnmounted, watch } from "vue";

/**
 * 覆盖层返回栈（C8 规格 §3.6.2）。
 *
 * **为什么需要它**：Android 的标准返回行为是「先关最上层的临时界面（对话框 / 抽屉 / 全屏层），
 * 再走导航栈，栈空则退出 App」。本项目原先只实现了后半段（`useShellLifecycle` 的三分支），
 * 而查看层与打印页是**覆盖层、不是路由** ⇒ 按返回键会连页面一起离开。
 *
 * **栈是模块级状态**：返回键只有一个监听者（`useShellLifecycle`，装在 `App.vue`），
 * 覆盖层却散在四个组件里；把栈放在模块级是让「后打开的覆盖层先被关」这件事只有一份实现。
 * 代价：它是全局可变状态，所以**注销必须可靠**——`onUnmounted` 与 `active` 回落两条路径都走 `sync(false)`。
 */
interface OverlayEntry {
  readonly close: () => void;
}

const stack: OverlayEntry[] = [];

/**
 * 关掉栈顶那一个；栈空返回 `false`。
 *
 * **唯一调用方是 `useShellLifecycle` 的返回键分支**（它据此决定是否把这次返回交给导航栈）。
 */
export function closeTopOverlay(): boolean {
  const top = stack.pop();
  if (top === undefined) return false;
  top.close();
  return true;
}

/**
 * 注册一个覆盖层：它活着的时候，返回键先关它。
 *
 * - `active` 省略 ⇒ 按**组件挂载生命周期**计（查看层与打印页是 `v-if` 挂载的）；
 * - 给了 `active` ⇒ 按它的真假注册 / 注销（页内确认条与对话框由 `ref` 控制显隐，不重新挂载）。
 *
 * **必须在 setup 的同步执行期调用**（内部用 `watch` 与 `onUnmounted`，与 `useShellLifecycle` 同口径）。
 */
export function useOverlayBack(onBack: () => void, active?: () => boolean): void {
  if (typeof onBack !== "function") {
    throw new Error(`覆盖层的关闭回调必须是函数（当前 ${typeof onBack}）`);
  }
  const entry: OverlayEntry = { close: onBack };
  const isActive = active ?? ((): boolean => true);
  let present = false;

  const sync = (on: boolean): void => {
    if (on === present) return;
    present = on;
    if (on) {
      stack.push(entry);
      return;
    }
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
  };

  watch(isActive, sync, { immediate: true });
  onUnmounted(() => {
    sync(false);
  });
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/composables/__tests__/useOverlayBack.test.ts`
预期：PASS（6 条）。

- [ ] **步骤 5：写失败的测试（返回键优先级）**

在 `src/composables/__tests__/useShellLifecycle.test.ts` 的 `describe("useShellLifecycle", …)` 里新增两条
（**用文件里既有的 `lifecycleSpies()` / `pressBack()` / `mountHost()`，不要新造 helper**）：

```ts
  it("有覆盖层 ⇒ 先关覆盖层：既不 history.back() 也不 push、也不 exit", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
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
    expect(back).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(spies.exit).not.toHaveBeenCalled();
    overlay.unmount();
    host.unmount();
  });

  it("覆盖层关掉之后再按返回键 ⇒ 回到既有的三分支（不遮蔽）", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
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

    pressBack(spies, { canGoBack: true });
    pressBack(spies, { canGoBack: true });

    expect(closed).toHaveBeenCalledTimes(1);
    expect(back).toHaveBeenCalledTimes(1);
    overlay.unmount();
    host.unmount();
  });
```

顶部 import 里加 `import { useOverlayBack } from "@/composables/useOverlayBack";`（`mount` 与 `defineComponent` 已在）。

- [ ] **步骤 6：运行测试验证失败**

运行：`npm run test -- src/composables/__tests__/useShellLifecycle.test.ts`
预期：FAIL —— 两条新用例都红（`closed` 一次都没被调用、`history.back()` 被调了）。

- [ ] **步骤 7：改 `useShellLifecycle` 的返回键分支**

`src/composables/useShellLifecycle.ts`：import 里加 `closeTopOverlay`，并把 `onBackButton` 的回调改成：

```ts
  // 返回键：**覆盖层优先**，其余三个分支互不遮蔽（C8 规格 §3.6.2）。
  const offBack = platform.lifecycle.onBackButton((info) => {
    // ① Android 标准：最上层的临时界面（查看层 / 打印页 / 对话框 / 确认条）先关，
    //    这一步**消费掉**本次返回，不落到导航栈。
    if (closeTopOverlay()) return;
    if (info.canGoBack) {
      history.back();
      return;
    }
    if (session.dirty) {
      void router.push({ name: "home" });
      return;
    }
    void platform.lifecycle.exit();
  });
```

同时把文件头那段「三个分支」的 JSDoc 改成「四个分支」并补一句：
「① 覆盖层栈非空 ⇒ 关栈顶（C8 新增，见规格 §3.6.2）；②③④ 与 B5 逐字相同。」

- [ ] **步骤 8：运行测试验证通过**

运行：`npm run test -- src/composables`
预期：PASS（`useShellLifecycle.test.ts` 7 条 + `useOverlayBack.test.ts` 6 条 + 其余 composable 用例不动）。

- [ ] **步骤 9：Commit**

```bash
git add src/composables/useOverlayBack.ts src/composables/useShellLifecycle.ts src/composables/__tests__/useOverlayBack.test.ts src/composables/__tests__/useShellLifecycle.test.ts
git commit -m "feat(ui): 覆盖层返回栈，Android 返回键先关最上层临时界面"
```

---

## 任务 2：图纸库页改版（规格 §3.2）

**文件：**
- 修改：`src/views/LibraryPage.vue:19`（`usage`）、`:85-87`（`formatMb`）、`:119-123`（`refresh` 的第三段）、`:164-174`（标题行）、`:229-242`（卡片按钮）、`:247-249`（占用行）
- 测试：`src/views/__tests__/LibraryPage.test.ts`

- [ ] **步骤 1：写失败的测试**

在 `src/views/__tests__/LibraryPage.test.ts` 的 `describe("LibraryPage", …)` 里新增三条
（**用文件里既有的 `mount(LibraryPage)` + `flushPromises()` 手法，不新造 helper**）：

```ts
  it("卡片的两颗主按钮：查看在前（黑底）、编辑在后（白底描边）（C8 第 1 项）", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    const card = wrapper.findAll("[data-testid='project-card']")[0]!;
    const texts = card.findAll("button").map((button) => button.text());
    expect(texts.slice(0, 2)).toEqual(["查看", "编辑"]);

    const view = card.get("[data-testid='view-sheet']");
    const edit = card.get("[data-testid='open-project']");
    // 主操作是「看图纸」：黑底在它身上，编辑是白底描边（与改名 / 删除同形）。
    expect(view.classes()).toContain("bg-slate-900");
    expect(edit.classes()).not.toContain("bg-slate-900");
    expect(edit.classes()).toContain("border-slate-300");
  });

  it("不再显示存储占用那一行（C8 第 1 项：开发者读数不是用户信息）", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    expect(wrapper.text()).not.toContain("已用");
    expect(wrapper.text()).not.toContain("可用约");
  });

  it("右上角按钮是「新建」，空列表提示同口径", async () => {
    setProjectStore(await createMemoryProjectStore());
    const wrapper = mount(LibraryPage);
    await flushPromises();
    expect(wrapper.get("[data-testid='new-project']").text()).toBe("新建");
    expect(wrapper.get("[data-testid='empty-hint']").text()).toContain("「新建」");
  });
```

**同时删掉/改写既有用例**（按 `grep -n "已用\|可用约\|施工图\|打开" src/views/__tests__/LibraryPage.test.ts` 逐条处理）：

- 断言「已用 X / 可用约 Y」的用例（`已用`×6、`可用约`×2 全在这个文件里）：**整条删除**——
  `estimateUsage` 不再是本页的读点。若该用例同时还断言了「占用读不出来只是少一行字」的容错分支，
  把那条也删掉并在实现报告里写明原因（读点消失，容错分支随之消失）。
- 断言卡片按钮文案「施工图」/「打开」的：改成「查看」/「编辑」（行为断言 `view-sheet` 打开查看层、
  `open-project` 跳编辑器**保持不变**）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/views/__tests__/LibraryPage.test.ts`
预期：FAIL —— 三条新用例红（按钮文案仍是「打开 / 施工图」、占用行仍在、按钮是「新建图纸」）。

- [ ] **步骤 3：改 `LibraryPage.vue`**

1. 删掉 `const usage = ref<{ usage: number; quota: number } | null>(null);` 与 `formatMb()`。
2. `refresh()` 里的第 ③ 段（`try { usage.value = await store.estimateUsage(); } catch { usage.value = null; }`）
   与它上面那段 JSDoc（「占用读不出来只是少一行字…闭合 B1-17」）**整段删除**——读点没了，容错也没了。
3. 模板底部那一段 `<p v-if="usage" …>已用 …</p>` 删除。
4. 标题行按钮文案 `新建图纸` → `新建`（`data-testid` 不变）。
5. 空列表提示：`还没有图纸。点右上角「新建图纸」选一张图片开始吧。` → `还没有图纸。点右上角「新建」选一张图片开始吧。`
6. 卡片按钮块改成（**顺序即数组顺序：查看在前、编辑在后**）：

```vue
          <div class="mt-3 flex flex-wrap gap-3">
            <button
              data-testid="view-sheet"
              class="min-h-12 flex-1 rounded bg-slate-900 px-4 text-white"
              @click="openSheet(meta)"
            >
              查看
            </button>
            <button
              data-testid="open-project"
              class="min-h-12 rounded border border-slate-300 px-4"
              @click="open(meta.id)"
            >
              编辑
            </button>
            <button data-testid="rename-project" class="min-h-12 rounded border border-slate-300 px-4" @click="startRename(meta)">
              改名
            </button>
            <button data-testid="delete-project" class="min-h-12 rounded border border-red-300 px-4 text-red-700" @click="pendingDelete = meta">
              删除
            </button>
          </div>
```

7. **删除确认框接进覆盖层返回栈**（Android 标准：返回键取消对话框）：

```ts
import { useOverlayBack } from "@/composables/useOverlayBack";
// …在 `pendingDelete` 声明之后：
/**
 * 删除确认框是「临时界面」：Android 返回键先取消它，而不是离开页面（C8 规格 §3.6.2）。
 * 判据用 `pendingDelete !== null`——对话框由 `ref` 控制显隐，不重新挂载组件。
 */
useOverlayBack(
  () => {
    pendingDelete.value = null;
  },
  () => pendingDelete.value !== null,
);
```

8. 顶部 JSDoc 里 `StoreFailure` 那段关于「占用读不出来」的话（`refresh` 的 ③）同步删掉，别留下与代码不符的注释。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/views/__tests__/LibraryPage.test.ts`
预期：PASS。

- [ ] **步骤 5：跑全套**

运行：`npm run test`
预期：PASS。若 `src/services/__tests__/idbProjectStore.test.ts` 或别处断言 `estimateUsage`，
**不要**动实现去迁就它——那说明该导出还有别的生产消费者，回到规格核对后再改（本任务只允许删本页的读点）。

- [ ] **步骤 6：Commit**

```bash
git add src/views/LibraryPage.vue src/views/__tests__/LibraryPage.test.ts
git commit -m "feat(ui): 图纸库页去存储占用、查看升为主操作并把删除框接入返回栈"
```

---

## 任务 3：core 图面版式 —— 字号随格像素缩放 + 打印页左沿对齐（规格 §7）

**文件：**
- 修改：`src/core/render/layout.ts`（常量区 `:33-115`、`planGridScale` `:617-667`、`planLegendBands` `:680-746`、`planSheet` `:432-`、`planBoardPage` `:781-881`）
- 修改：`src/core/render/sheet.ts`（`drawLegendBand` 的字号、删私有常量 `LEGEND_FONT_PX`）
- 修改：`src/services/sheetExport.ts:75-80`、`:116-130`、`:171-181`（传 `projectName`；`boardPageTile` 多收一个名字）
- 修改：`src/components/editor/ExportPanel.vue:225-232`（`pageUsages` 的 `planBoardPage`）与 `:277-285`（`boardPageTile`）——**只补一个实参，其余不动**（面板的整体改造是任务 7）
- 测试：`src/core/render/__tests__/layout.test.ts`、`src/core/render/__tests__/sheet.test.ts`、`src/services/__tests__/sheetExport.test.ts`

- [ ] **步骤 1：写失败的测试（`layout.test.ts` 末尾新增一段）**

```ts
describe("C8：字号随格像素缩放与标题宽度", () => {
  const usages = (count: number): ColorUsage[] =>
    Array.from({ length: count }, (_, i) => ({ code: `A${i + 1}`, name: `色 ${i + 1}`, count: 10 }));

  it("估算函数：CJK 比 ASCII 宽，且带 5% 余量", () => {
    expect(estimateTextWidthPx("a", 100)).toBe(55);
    expect(estimateTextWidthPx("aa", 100)).toBe(110);
    expect(estimateTextWidthPx("中", 100)).toBe(105);
    // 全角标点也算宽（`（` 是 U+FF08）
    expect(estimateTextWidthPx("（", 100)).toBe(105);
  });

  it("估算函数的非法输入响亮失败", () => {
    expect(() => estimateTextWidthPx(1 as never, 10)).toThrow(/字符串/);
    expect(() => estimateTextWidthPx("x", 0)).toThrow(/正的有限数字/);
    expect(() => estimateTextWidthPx("x", Number.NaN)).toThrow(/正的有限数字/);
  });

  it("用料条几何全部由字号推出，且行高放得下字号", () => {
    for (const font of [18, 24, 35, 40]) {
      const box = legendGeometry(font);
      expect(box.rowHeight).toBeGreaterThan(font);
      expect(box.itemWidth).toBeGreaterThan(box.codeX);
      expect(box.swatchSize).toBeGreaterThan(0);
    }
    expect(legendGeometry(40).rowHeight).toBeGreaterThan(legendGeometry(18).rowHeight);
    expect(legendGeometry(40).itemWidth).toBeGreaterThan(legendGeometry(18).itemWidth);
  });

  it("29×25（格像素取上限 96）⇒ 标题 48px、用料条 35px，都随格像素走", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), "小猫");
    expect(plan.cellPx).toBe(EXPORT_CELL_MAX_PX);
    expect(plan.titleFontPx).toBe(48);
    expect(plan.legend.fontPx).toBe(35);
    expect(plan.labelFontPx).toBe(35);
  });

  it("标题与上刻度带之间有净距，用料条与下刻度带之间也有（第 7 项：不紧贴）", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), "小猫");
    const titleHeight = Math.round(plan.titleFontPx * SHEET_TITLE_LINE_RATIO);
    expect(plan.titleY).toBe(SHEET_MARGIN);
    expect(plan.ruler.topY).toBe(SHEET_MARGIN + titleHeight + SHEET_TITLE_GAP);
    const gridBottom = plan.grid.y + plan.grid.height;
    expect(plan.ruler.bottomY).toBe(gridBottom);
    expect(plan.legendTop).toBe(gridBottom + SHEET_RULER_TOP + LEGEND_PAD_TOP);
    expect(SHEET_TITLE_GAP).toBeGreaterThanOrEqual(16);
    expect(LEGEND_PAD_TOP).toBeGreaterThanOrEqual(20);
  });

  it("画布高度含标题行、两条刻度带与用料条（漏算任一项都会叠字）", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), "小猫");
    const titleHeight = Math.round(plan.titleFontPx * SHEET_TITLE_LINE_RATIO);
    expect(plan.canvasHeight).toBe(
      SHEET_MARGIN +
        titleHeight +
        SHEET_TITLE_GAP +
        SHEET_RULER_TOP +
        plan.grid.height +
        SHEET_RULER_TOP +
        LEGEND_PAD_TOP +
        plan.legend.itemRows * plan.legend.rowHeight +
        SHEET_MARGIN,
    );
  });

  it("超长工程名：字号被压小、但不低于硬底，且标题上界落在画布内（不静默裁字）", () => {
    const long = "阿".repeat(60);
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), long);
    expect(plan.titleFontPx).toBeLessThan(48);
    expect(plan.titleFontPx).toBeGreaterThanOrEqual(TITLE_FONT_HARD_MIN_PX);
    const bound =
      SHEET_MARGIN + estimateTextWidthPx(long, plan.titleFontPx) + SHEET_TITLE_FIXED_EM * plan.titleFontPx;
    expect(bound).toBeLessThanOrEqual(plan.canvasWidth);
  });

  it("名字长到硬底都放不下 ⇒ 响亮失败", () => {
    expect(() =>
      planSheet(makePattern(29, 25), makePalette(13), usages(13), "阿".repeat(200), { maxEdge: 400 }),
    ).toThrow(/工程名太长/);
  });

  it("工程名必须是非空字符串", () => {
    expect(() => planSheet(makePattern(4, 4), makePalette(4), [], 5 as never)).toThrow(/工程名/);
    expect(() => planSheet(makePattern(4, 4), makePalette(4), [], "   ")).toThrow(/工程名/);
  });

  it("小图纸的画布为标题让路（4×4 的网格块只有 384px 宽）", () => {
    const plan = planSheet(makePattern(4, 4), makePalette(8), usages(8), "小猫");
    const gridBlockRight = plan.grid.x + plan.grid.width + SHEET_RULER_LEFT;
    expect(plan.canvasWidth).toBeGreaterThan(gridBlockRight);
    expect(plan.canvasWidth).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
  });

  it("打印页：标题 / 用料条 / 网格块三者左沿对齐（第 8 项）", () => {
    const plan = planBoardPage(makePattern(29, 29), makePalette(4), usages(4), {
      boardSize: 29,
      paper: "a4",
      index: 0,
      projectName: "小猫",
    });
    expect(plan.titleLeft).toBe(plan.grid.x - SHEET_RULER_LEFT);
    expect(plan.legend.left).toBe(plan.titleLeft);
    // 打印版面规则一个字没动：29 板 + A4 仍是实物大小
    expect(plan.cellMm).toBeCloseTo(5, 5);
    expect(plan.scaleRatio).toBe(1);
  });

  it("打印页：纸越宽，长名字的标题字号只会更大或持平", () => {
    const name = "名字".repeat(20);
    const a4 = planBoardPage(makePattern(29, 29), makePalette(4), usages(4), {
      boardSize: 29, paper: "a4", index: 0, projectName: name,
    });
    const a3 = planBoardPage(makePattern(29, 29), makePalette(4), usages(4), {
      boardSize: 29, paper: "a3", index: 0, projectName: name,
    });
    expect(a3.titleFontPx).toBeGreaterThanOrEqual(a4.titleFontPx);
  });

  it("模板 em 上界不小于真实模板的估算宽（改了文案必须同步）", () => {
    const tpl = `小猫 · 116 × 116 格 · 221 色 · 13456 颗`;
    expect(SHEET_TITLE_FIXED_EM).toBeGreaterThanOrEqual(
      estimateTextWidthPx(tpl.replace("小猫", ""), 1),
    );
  });
});
```

- [ ] **步骤 2：写失败的测试（`sheet.test.ts` 新增一段）**

```ts
describe("C8：标题与用料条的字号随格像素", () => {
  it("用料条用计划给的字号画，不再是写死的 14px", () => {
    const { calls, plan } = renderSheetFixture({ projectName: "小猫" });
    const legendTexts = calls.texts.filter((text) => text.text.includes("("));
    expect(legendTexts.length).toBeGreaterThan(0);
    for (const text of legendTexts) {
      expect(text.font).toBe(`${plan.legend.fontPx}px sans-serif`);
    }
    expect(plan.legend.fontPx).toBeGreaterThan(14);
  });

  it("标题用计划给的字号画（48px，不再是 22px）", () => {
    const { calls, plan } = renderSheetFixture({ projectName: "小猫" });
    const title = calls.texts.find((text) => text.y === SHEET_MARGIN);
    expect(title?.font).toBe(`${plan.titleFontPx}px sans-serif`);
    expect(plan.titleFontPx).toBeGreaterThan(22);
  });
});
```

`renderSheetFixture` / `renderBoardPageFixture` 是文件里既有的 helper：给它们加一个可选的 `projectName`
（默认 "测试工程"），并把内部 `planSheet` / `planBoardPage` 的调用补上这个名字（见步骤 8 的签名变更）。
**同时改掉**该文件里所有 `SHEET_TITLE_FONT_PX` 的引用（该常量本任务删除）。

- [ ] **步骤 3：运行测试验证失败**

运行：`npm run test -- src/core/render/__tests__/layout.test.ts src/core/render/__tests__/sheet.test.ts`
预期：FAIL —— `estimateTextWidthPx` / `legendGeometry` / `plan.legend.fontPx` 不存在，
`planSheet` 的第 4 个实参是 `PlanOptions` 而不是工程名（类型错误）。

- [ ] **步骤 4：改常量区（`layout.ts`）**

删掉 `SHEET_TITLE_H = 34`、`SHEET_TITLE_FONT_PX = 22`、`LEGEND_ITEM_W = 120`、`LEGEND_ROW_H = 22`、
`LEGEND_SWATCH_SIZE = 16`、`LEGEND_CODE_X = 24`、`LEGEND_COUNT_RIGHT_PAD = 8`，把 `LEGEND_PAD_TOP` 改成 24，
并新增（放在原来那一段的位置，逐字照抄规格 §7.5）：

```ts
/** 标题字号比例（0.5 × cellPx）与上下限。 */
export const SHEET_TITLE_FONT_RATIO = 0.5;
export const SHEET_TITLE_FONT_MIN_PX = 24;
export const SHEET_TITLE_FONT_MAX_PX = 56;
/** 标题行高比例（行高 = 1.3 × 字号）。 */
export const SHEET_TITLE_LINE_RATIO = 1.3;
/** 标题行底边与上刻度带之间的净距。 */
export const SHEET_TITLE_GAP = 18;
/** 标题字号的硬底：低于它就不是「字小」而是噪点，计划阶段响亮失败。 */
export const TITLE_FONT_HARD_MIN_PX = 16;
/** 文本宽度估算的余量（估算是估算，不是实测 —— 见 `estimateTextWidthPx`）。 */
export const TEXT_WIDTH_SAFETY = 1.05;
/** 用料条字号比例（0.36 × cellPx）与上下限。 */
export const LEGEND_FONT_RATIO = 0.36;
export const LEGEND_FONT_MIN_PX = 18;
export const LEGEND_FONT_MAX_PX = 40;
/** 由用料字号推出的几何比例：行高 / 色块 / 色号缩进 / 项内右留白。 */
export const LEGEND_ROW_RATIO = 1.7;
export const LEGEND_SWATCH_RATIO = 1.25;
export const LEGEND_CODE_GAP_RATIO = 0.5;
export const LEGEND_ITEM_PAD_RATIO = 0.4;
/** 项宽的估算样本：三字色号 + 5 位颗数（MARD 色号最长三字，颗数上限 116 × 116）。 */
export const LEGEND_ITEM_SAMPLE = "F25 (12345)";
/** 用料条顶边与下刻度带底沿的净距（C8 由 12 抬到 24）。 */
export const LEGEND_PAD_TOP = 24;
```

- [ ] **步骤 5：写估算、几何与标题字号的三个函数（`layout.ts`）**

放在常量区之后、`GridGeometry` 之前：

```ts
/**
 * 文本宽度的**估算**（core 不许引用 DOM ⇒ 量不了字）。
 *
 * CJK / 全角按 `1em`、其余按 `0.55em`，再乘 `TEXT_WIDTH_SAFETY`。**它是估算**：判别力靠人工目视
 * （C8 规格 §10 第 7 条），所以留了 5% 余量。只用于「装不装得下」与画布宽度，不参与任何格坐标。
 */
export function estimateTextWidthPx(text: string, fontPx: number): number {
  if (typeof text !== "string") {
    throw new Error(`待估文本必须是字符串（当前 ${typeof text}）`);
  }
  if (!Number.isFinite(fontPx) || fontPx <= 0) {
    throw new Error(`字号必须是正的有限数字（当前 ${String(fontPx)}）`);
  }
  let em = 0;
  for (const char of text) {
    em += isWideCodePoint(char.codePointAt(0) ?? 0) ? 1 : 0.55;
  }
  return Math.ceil(em * fontPx * TEXT_WIDTH_SAFETY);
}

/** CJK / 全角码点（宽字符按 1em 计）。**只影响估算**，不参与任何渲染决定。 */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/**
 * 标题模板里**除工程名之外**那部分的最大 em 宽（`fontPx = 1` ⇒ 读数就是 em 数）。
 *
 * **由最长模板字面量量出来、不手写魔数**：文案改了它会跟着变，`layout.test.ts` 有一条用例
 * 钉着「不小于真实模板」。打印页的标题模板含板号 / 页范围 / 毫米，取最坏情况（4 位页号、116 行）。
 */
export const SHEET_TITLE_FIXED_EM = estimateTextWidthPx(" · 116 × 116 格 · 221 色 · 13456 颗", 1);
export const BOARD_TITLE_FIXED_EM = estimateTextWidthPx(
  " · 第 116 行 第 116 列 · 第 16/16 块板 · 板 58 × 58 · A3 · 本页 列 116–116 行 116–116 · 1 格 = 4.7mm（实物的 93%）",
  1,
);

/** 用料条几何：**全部由用料字号推出**（`LegendBandPlan` 的取值口径只此一份）。 */
export function legendGeometry(fontPx: number): {
  readonly rowHeight: number;
  readonly swatchSize: number;
  readonly codeX: number;
  readonly itemWidth: number;
} {
  const font = requirePositiveInteger(fontPx, "用料条字号");
  const swatchSize = Math.round(font * LEGEND_SWATCH_RATIO);
  const codeX = swatchSize + Math.round(font * LEGEND_CODE_GAP_RATIO);
  const itemWidth =
    codeX + estimateTextWidthPx(LEGEND_ITEM_SAMPLE, font) + Math.round(font * LEGEND_ITEM_PAD_RATIO);
  return { rowHeight: Math.round(font * LEGEND_ROW_RATIO), swatchSize, codeX, itemWidth };
}

/**
 * 标题字号：比例值（24–56）→ 按可用宽**逐 1px 下调** → 硬底 16px → 仍放不下就响亮失败。
 *
 * 宽度用 `estimateTextWidthPx(工程名, f) + fixedEm × f` 作**上界**（C8 规格 §7.3）：计划拿不到整条
 * 标题（打印页的标题含 `1 格 = X mm`，那要计划先算出来），但模板里除名字之外那部分是固定且
 * 长度有界的 ⇒ 上界只多不少。**逐 1px 下调而不是解方程**：估算函数带 `ceil`，不保证线性，
 * 而最坏情况只有 40 次迭代。
 */
export function planTitleFont(input: {
  readonly projectName: string;
  readonly fixedEm: number;
  readonly cellPx: number;
  readonly availableWidth: number;
}): number {
  const projectName = requireProjectName(input.projectName);
  const fixedEm = requirePositiveNumber(input.fixedEm, "标题模板 em 上界");
  const cellPx = requirePositiveInteger(input.cellPx, "格像素");
  const availableWidth = requirePositiveInteger(input.availableWidth, "标题可用宽");
  const ratioFont = Math.min(
    SHEET_TITLE_FONT_MAX_PX,
    Math.max(SHEET_TITLE_FONT_MIN_PX, Math.round(cellPx * SHEET_TITLE_FONT_RATIO)),
  );
  const fits = (font: number): boolean =>
    estimateTextWidthPx(projectName, font) + fixedEm * font <= availableWidth;
  if (fits(ratioFont)) return ratioFont;
  for (let font = ratioFont - 1; font >= TITLE_FONT_HARD_MIN_PX; font -= 1) {
    if (fits(font)) return font;
  }
  throw new Error(
    `工程名太长：${availableWidth} px 宽放不下「${projectName}」（标题字号硬底 ${TITLE_FONT_HARD_MIN_PX} px）`,
  );
}
```

同时补两个守卫（放在文件里既有的 `require*` 那一群里，风格照抄）：

```ts
function requireProjectName(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`工程名必须是非空字符串（当前 ${JSON.stringify(value)}）`);
  }
  return value;
}

function requirePositiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} 必须是正的有限数字（当前 ${String(value)}）`);
  }
  return value;
}
```

- [ ] **步骤 6：`planGridScale` 用「字号上限」做保守预算，并返回用料字号**

```ts
  // **预算一律用字号上限**（标题行高 73、用料行高 68、项宽 341）：这三者都比真实值大，
  // 所以由它定出的格像素只会偏保守、不会溢出画布（C8 规格 §7.2 的最后一段）。
  const titleBudget = Math.round(SHEET_TITLE_FONT_MAX_PX * SHEET_TITLE_LINE_RATIO);
  const legendRowBudget = Math.round(LEGEND_FONT_MAX_PX * LEGEND_ROW_RATIO);
  const legendItemBudget = legendGeometry(LEGEND_FONT_MAX_PX).itemWidth;
  const itemColsUpper = Math.max(
    1,
    Math.min(Math.floor(availableWidth / legendItemBudget), Math.max(1, usageCount)),
  );
  const itemRowsUpper = usageCount === 0 ? 0 : Math.ceil(usageCount / itemColsUpper);
  const bandsBudget = input.reserveBandsInHeight
    ? titleBudget +
      SHEET_TITLE_GAP +
      2 * SHEET_RULER_TOP +
      LEGEND_PAD_TOP +
      itemRowsUpper * legendRowBudget
    : 0;
```

返回类型加一个字段（其余不变）：

```ts
  const legendFontPx = Math.min(
    LEGEND_FONT_MAX_PX,
    Math.max(LEGEND_FONT_MIN_PX, Math.round(cellPx * LEGEND_FONT_RATIO)),
  );
  return { cellPx, labelFontPx, rulerFontPx, legendFontPx };
```

- [ ] **步骤 7：`planLegendBands` 收用料字号 + 对齐方式**

- 入参加 `readonly legendFontPx: number;` 与 `readonly legendAlign: "center" | "start";`
  （**不给默认值**：单张传 `"center"`、打印页传 `"start"`，两处都显式写出来）。
- 用 `legendGeometry(input.legendFontPx)` 得到 `rowHeight` / `swatchSize` / `codeX` / `itemWidth`，
  替换原来读 `LEGEND_ITEM_W` / `LEGEND_ROW_H` / `LEGEND_SWATCH_SIZE` / `LEGEND_CODE_X` 的四处。
- 左右落位改成：

```ts
  const bandWidth = itemCols * box.itemWidth;
  const legendLeft =
    input.legendAlign === "start"
      ? input.legendLeftBase
      : input.legendLeftBase + Math.max(0, Math.floor((wrapWidth - bandWidth) / 2));
```
- `LegendBandPlan` **加一个字段 `fontPx`、删一个字段 `countRightPad`**（后者由 `LEGEND_ITEM_PAD_RATIO`
  取代，渲染器本来就没读它）；`layout.test.ts:348` 那条用到 `countRightPad` 的用例改成断言
  「`itemWidth ≥ codeX + estimateTextWidthPx(LEGEND_ITEM_SAMPLE, font) + round(font × LEGEND_ITEM_PAD_RATIO)`」。

- [ ] **步骤 8：改 `planSheet` 与 `planBoardPage` 的签名与落位**

`planSheet` 的签名变成：

```ts
export function planSheet(
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  projectName: string,
  options?: PlanOptions,
): SheetPlan
```

主体：

```ts
  const name = requireProjectName(projectName);
  const scale = planGridScale({ /* 与 C7 相同，只多不了参数 */ });
  const titleFontPx = planTitleFont({
    projectName: name,
    fixedEm: SHEET_TITLE_FIXED_EM,
    cellPx: scale.cellPx,
    availableWidth: maxEdge - 2 * SHEET_MARGIN,
  });
  const titleHeight = Math.round(titleFontPx * SHEET_TITLE_LINE_RATIO);
  const gridX = SHEET_MARGIN + SHEET_RULER_LEFT;
  const gridY = SHEET_MARGIN + titleHeight + SHEET_TITLE_GAP + SHEET_RULER_TOP;
  const bands = planLegendBands({
    usages: safeUsages,
    legendWrapWidth: pattern.width * scale.cellPx,
    legendLeftBase: gridX,
    legendAlign: "center",
    legendFontPx: scale.legendFontPx,
    cellPx: scale.cellPx,
    cols: pattern.width,
    rows: pattern.height,
    gridX,
    gridY,
    rulerFontPx: scale.rulerFontPx,
  });
  // 标题（身份信息）允许把画布撑宽：用料条那条纪律仍然成立（它按网格宽换行）。
  const titleRight =
    SHEET_MARGIN +
    estimateTextWidthPx(name, titleFontPx) +
    SHEET_TITLE_FIXED_EM * titleFontPx;
  return {
    …,
    canvasWidth: Math.max(bands.canvasWidth, titleRight + SHEET_MARGIN),
    canvasHeight: bands.canvasHeight,
    titleFontPx,
    legend: bands.legend,
    …
  };
```

`planBoardPage` 的 `page` 参数加一个**必填**字段 `readonly projectName: string;`，主体改成：

```ts
  const name = requireProjectName(page.projectName);
  // …纸型 / 可打印区 / 页身份 / cols / rows / planGridScale 全部与 C7 相同…
  const gridWidth = cols * scale.cellPx;
  const gridX = Math.floor((canvasWidth - (SHEET_RULER_LEFT + gridWidth)) / 2) + SHEET_RULER_LEFT;
  // **C8 第 8 项**：标题 / 用料条 / 网格块三者共用同一条左沿（网格块左沿 = 左序号带左沿）。
  const blockLeft = gridX - SHEET_RULER_LEFT;
  const titleFontPx = planTitleFont({
    projectName: name,
    fixedEm: BOARD_TITLE_FIXED_EM,
    cellPx: scale.cellPx,
    // 标题从块左沿起排 ⇒ 它能用到的是「画布宽 − 右边距 − 块左沿」
    availableWidth: canvasWidth - marginPx - blockLeft,
  });
  const titleHeight = Math.round(titleFontPx * SHEET_TITLE_LINE_RATIO);
  const gridY = marginPx + titleHeight + SHEET_TITLE_GAP + SHEET_RULER_TOP;
  const bands = planLegendBands({
    usages: safeUsages,
    legendWrapWidth: canvasWidth - marginPx - blockLeft,
    legendLeftBase: blockLeft,
    legendAlign: "start",
    legendFontPx: scale.legendFontPx,
    …
  });
```

返回里 `titleLeft: blockLeft`（其余 `titleY: marginPx` / `titleFontPx` 照旧）。

- [ ] **步骤 9：`sheet.ts` 的用料条字号改读计划**

```ts
    target.fillStyle = TEXT_INK;
    target.font = `${band.fontPx}px sans-serif`;
```
并删掉文件顶部的 `const LEGEND_FONT_PX = 14;`（连同它的注释）——计划里已经有这个值，
留一个渲染器私有常量就是第二份真相。

- [ ] **步骤 10：`sheetExport.ts` 与 `ExportPanel.vue` 的调用点**

```ts
// renderSheetBlob
const plan = planSheet(input.pattern, input.palette, input.usages, input.projectName);

// renderBoardPageBlob
const plan = planBoardPage(input.pattern, input.palette, pageUsages, {
  boardSize: input.boardSize,
  paper: input.paper,
  index: input.pageIndex,
  projectName: input.projectName,
});

// boardPageTile：第 4 个参数插在 usages 之后（与 planSheet 同序）
export function boardPageTile(
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  projectName: string,
  boardSize: 29 | 58,
  paper: "a4" | "a3",
  pageIndex: number,
): { readonly rowIndex: number; readonly colIndex: number }
```

`ExportPanel.vue` 的两处（**只补实参**）：
`planBoardPage(..., { boardSize, paper, index, projectName: snapshot.projectName })` 与
`boardPageTile(snapshot.pattern, snapshot.palette, snapshot.usages, snapshot.projectName, snapshot.boardSize, snapshot.paper, item.pageIndex)`。

- [ ] **步骤 11：跑测试并改既有断言（同一任务内做完）**

运行：`npm run test -- src/core/render src/services/__tests__/sheetExport.test.ts`
预期：新用例 PASS；下面这些**旧断言**会红，逐条按新口径改：

- `layout.test.ts` 的常量基线（`LEGEND_ROW_H` / `LEGEND_ITEM_W` / `SHEET_TITLE_H` / `SHEET_TITLE_FONT_PX`）
  → 改成新常量（比例值、`LEGEND_PAD_TOP = 24`）。
- `plan.legend.itemCols === Math.floor(plan.grid.width / LEGEND_ITEM_W)` 三处
  → `plan.legend.itemWidth`。
- 画布高度公式里 `plan.legend.itemRows * LEGEND_ROW_H` → `plan.legend.rowHeight`。
- `planSheet` / `planBoardPage` 的每个调用点补工程名（`sheet.test.ts` 20 处、`layout.test.ts` 若干、
  `sheetExport.test.ts` 的 `boardPageTile`）。
- `sheet.test.ts` 里断言标题字号 22 / 用料条字号 14 的用例 → 用 `plan.titleFontPx` / `plan.legend.fontPx`。

- [ ] **步骤 12：跑全套与两道闸门**

运行：`npm run test`
预期：PASS。
运行：`npm run test -- src/core/render/__tests__/layoutGate.test.ts src/__tests__/coreBoundary.test.ts`
预期：PASS（`sheet.ts` 仍不出现 `cellPx`、不读 `pattern.cells`、无 `canvasWidth /` 除法、仍有 `cellAt(`）。

- [ ] **步骤 13：Commit**

```bash
git add src/core/render/layout.ts src/core/render/sheet.ts src/core/render/__tests__ src/services/sheetExport.ts src/services/__tests__/sheetExport.test.ts src/components/editor/ExportPanel.vue
git commit -m "feat(core): 标题与用料条字号随格像素缩放，打印页三处左沿对齐"
```

---

## 任务 4：结果页抽成共用组件 + `/edit/:id/result` 路由（规格 §3.4）

**文件：**
- 创建：`src/views/backOrHome.ts`、`src/services/rerunDraft.ts`、`src/components/result/ResultPanel.vue`、`src/views/EditResultPage.vue`
- 修改：`src/router/index.ts:14-16`、`src/views/SetupPage.vue`（结果阶段换成 `ResultPanel`，删本页的查看层与打印面板）
- 测试：`src/components/result/__tests__/ResultPanel.test.ts`（新建）、`src/views/__tests__/EditResultPage.test.ts`（新建）、`src/views/__tests__/SetupPage.test.ts`、`src/router/__tests__/index.test.ts`

- [ ] **步骤 1：写失败的测试（`ResultPanel`）**

新建 `src/components/result/__tests__/ResultPanel.test.ts`：

```ts
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinPalette } from "@/services/palette";
import ResultPanel from "@/components/result/ResultPanel.vue";

/**
 * 结果卡片（C8 规格 §3.4）：两个宿主共用，纯展示（不 import store）。
 * 预览缩略图走替身——happy-dom 的 canvas 没有像素语义，本文件只钉按钮与文案。
 */
vi.mock("@/services/patternThumbnail", () => ({
  renderPatternThumbnail: () => "data:image/png;base64,AAAA",
  RESULT_PREVIEW_MAX_EDGE: 1600,
}));
vi.mock("@/services/sheetExport", () => ({
  renderSheetBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
}));

const palette = getBuiltinPalette();
const pattern = { width: 4, height: 4, paletteId: palette.id, cells: new Uint16Array(16) };

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(ResultPanel, {
    props: { pattern, palette, isNew: true, canRerun: true, ...overrides },
  });
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:result-1") as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

describe("ResultPanel（C8：四颗按钮、没有打印）", () => {
  it("四颗按钮的顺序与文案：重做 / 查看 / 编辑 / OK", () => {
    const texts = mountPanel().findAll("button").map((button) => button.text());
    expect(texts).toEqual(["重做", "查看", "编辑", "OK"]);
  });

  it("编辑是白底、OK 是黑底（主操作是「结束回家」）", () => {
    const wrapper = mountPanel();
    const edit = wrapper.get("[data-testid='open-editor']");
    const ok = wrapper.get("[data-testid='result-ok']");
    expect(edit.classes()).not.toContain("bg-slate-900");
    expect(edit.classes()).toContain("border-slate-300");
    expect(ok.classes()).toContain("bg-slate-900");
  });

  it("没有「打印」按钮（打印从查看层里进）", () => {
    expect(mountPanel().find("[data-testid='result-print']").exists()).toBe(false);
  });

  it("canRerun 为假时不渲染「重做」", () => {
    expect(mountPanel({ canRerun: false }).find("[data-testid='result-rerun']").exists()).toBe(false);
  });

  it("三颗按钮各 emit 自己那一个事件", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='result-rerun']").trigger("click");
    await wrapper.get("[data-testid='open-editor']").trigger("click");
    await wrapper.get("[data-testid='result-ok']").trigger("click");
    expect(wrapper.emitted("rerun")).toHaveLength(1);
    expect(wrapper.emitted("edit")).toHaveLength(1);
    expect(wrapper.emitted("ok")).toHaveLength(1);
  });

  it("「查看」打开查看层（本组件自带它，宿主不必知道）", async () => {
    const wrapper = mountPanel();
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(false);
    await wrapper.get("[data-testid='result-view-sheet']").trigger("click");
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(true);
  });

  it("保存文案按 isNew 分叉", () => {
    expect(mountPanel({ isNew: true }).get("[data-testid='result-save-state']").text()).toBe("已保存到图纸库");
    expect(mountPanel({ isNew: false }).get("[data-testid='result-save-state']").text()).toBe("已更新这张图纸");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/components/result`
预期：FAIL —— 模块不存在。

- [ ] **步骤 3：实现 `ResultPanel.vue`**

把 `SetupPage.vue` 现有结果阶段那一段（`:423-471`：预览图 / 保存文案 / 统计 / 尺寸 / 按钮排）
**整段搬进来**，只改三处：按钮组换成下表、`resultImage`/`resultStats`/`resultSize` 三个 computed
随之内联、查看层由本组件自己渲染。

| 顺序 | 文案 | class | `data-testid` | 事件 |
|---|---|---|---|---|
| 1 | 重做 | `min-h-12 rounded border border-slate-300 px-4 text-base` | `result-rerun` | `emit("rerun")` |
| 2 | 查看 | 同上 | `result-view-sheet` | `sheetOpen = true` |
| 3 | 编辑 | 同上（白底描边） | `open-editor` | `emit("edit")` |
| 4 | OK | `min-h-12 rounded bg-slate-900 px-4 text-base text-white` | `result-ok` | `emit("ok")` |

```vue
<script setup lang="ts">
import { computed, ref } from "vue";
import type { Palette } from "@/core/palette/types";
import { boardCount, beadsToCm, formatCm } from "@/core/pattern/board";
import { patternStats } from "@/core/pattern/stats";
import type { Pattern } from "@/core/pattern/types";
import SheetViewer from "@/components/sheet/SheetViewer.vue";
import { RESULT_PREVIEW_MAX_EDGE, renderPatternThumbnail } from "@/services/patternThumbnail";

const props = defineProps<{
  pattern: Pattern;
  palette: Palette;
  isNew: boolean;
  thumbnail?: string;
  canRerun: boolean;
}>();
const emit = defineEmits<{ rerun: []; edit: []; ok: [] }>();

const sheetOpen = ref(false);
const preview = computed(() =>
  renderPatternThumbnail(props.pattern, props.palette, RESULT_PREVIEW_MAX_EDGE),
);
const stats = computed(() => patternStats(props.pattern, props.palette));
const size = computed(() => { /* 逐字搬 SetupPage 的 resultSize */ });
</script>
```

根节点是**单根** `<section class="rounded bg-white p-4 shadow">`（**不带 `result-pane`**：那个 id 归宿主，
`SetupPage` 的 `<section data-testid="result-pane">` 包着它）。查看层放在根 section 的**最后一行**
（`<SheetViewer v-if="sheetOpen" … />`），保持单根——多根会让宿主传下来的属性落不到任何元素上。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/components/result`
预期：PASS（7 条）。

- [ ] **步骤 5：写失败的测试（`backOrHome` 与 `seedRerunDraft`）**

新建 `src/views/__tests__/backOrHome.test.ts`：

```ts
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it, vi } from "vitest";
import { backOrHome } from "@/views/backOrHome";

/**
 * 「返回上一页」的统一判据（C8 规格 §3.6.1）：有上一页才 `back()`，否则回图纸库。
 * **用真 `createMemoryHistory` 的 router**（`EditorPageRouterLink.test.ts` 的先例）：
 * 判据读的是 vue-router 自己写在 `options.history.state.back` 里的上一页，替身给不出它。
 */
const routes = [
  { path: "/", name: "home", component: { template: "<div />" } },
  { path: "/edit/:id", name: "editor", component: { template: "<div />" } },
  { path: "/new/setup", name: "setup", component: { template: "<div />" } },
];

describe("backOrHome", () => {
  it("历史为空（根页面）⇒ 去图纸库，而不是什么都不做", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/");
    await router.isReady();
    const push = vi.spyOn(router, "push");

    backOrHome(router);

    expect(push).toHaveBeenCalledWith({ name: "home" });
  });

  it("有上一页 ⇒ back()，不 push", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/");
    await router.push("/edit/a");
    await router.isReady();
    const back = vi.spyOn(router, "back").mockImplementation(() => {});
    const push = vi.spyOn(router, "push");

    backOrHome(router);

    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
});
```

新建 `src/services/__tests__/rerunDraft.test.ts`（用 `createPinia` + 真 store，fixture 抄
`EditorPage.test.ts` 的 `makeEditorRecord`；**关键是 `params.maxColors: "custom"` + `customMaxColors: 20`**）：

```ts
it("播种草稿时把自定义色数一起带过去（重跑 custom 工程必须用回那个数）", () => {
  setActivePinia(createPinia());
  const session = useProjectSession();
  const draft = useDraft();
  // …session.adopt(...) 成一条 maxColors: "custom"、customMaxColors: 20 的记录…
  expect(seedRerunDraft(draft, session)).toBe(true);
  expect(draft.maxColors).toBe("custom");
  expect(draft.customMaxColors).toBe(20);
  expect(draft.rerunOf?.id).toBe("a");
});

it("没有原图 / 没有参数 / 没有记录 ⇒ 返回 false 且一点草稿都不写", () => {
  setActivePinia(createPinia());
  const session = useProjectSession();
  const draft = useDraft();
  expect(seedRerunDraft(draft, session)).toBe(false);
  expect(draft.source).toBeNull();
});
```

- [ ] **步骤 6：运行测试验证失败**

运行：`npm run test -- src/views/__tests__/backOrHome.test.ts src/services/__tests__/rerunDraft.test.ts`
预期：FAIL —— 两个模块都不存在。

- [ ] **步骤 7：实现 `backOrHome` 与 `seedRerunDraft`**

```ts
// src/views/backOrHome.ts
import type { Router } from "vue-router";

/**
 * 「返回上一页」的统一实现（C8 规格 §3.6.1）。
 *
 * vue-router 4 把上一页的 fullPath 写在它自己的 `history.state.back` 里（根页面是 `null`）——
 * 两条历史实现（web / memory）都有这个字段，所以**不要**去读 `window.history.length`
 * （它在 memory history 下恒为 1，判据会永远走「回首页」那一支）。
 * 历史为空时回图纸库，而不是什么都不做：那是用户眼里的「按了没反应」。
 */
export function backOrHome(router: Router): void {
  const state = router.options.history.state as { readonly back?: unknown } | undefined;
  if (typeof state?.back === "string") {
    router.back();
    return;
  }
  void router.push({ name: "home" });
}
```

```ts
// src/services/rerunDraft.ts
import type { useDraft } from "@/stores/draft";
import type { useProjectSession } from "@/stores/project";

/**
 * 把当前工程的原图与参数播种进向导草稿（B2 规格 §7），返回是否真的播种了。
 *
 * **编辑页的「重做」与编辑来源结果页的「重做」共用这一份**（C8 规格 §3.4）：两处各写一遍就是
 * 「同一件事的第二份实现」，而它写错的形态是静默的——草稿身份不对 ⇒ 覆盖到别的记录。
 *
 * **顺带修一个既有缺陷**（C8 实现时发现，如实登记）：原实现（`EditorPage.vue`）**没有**把
 * `params.customMaxColors` 带进草稿，于是重跑一条「自定义 20 色」的工程时，草稿里的
 * `customMaxColors` 还是 store 里的残留值（默认 32），而 `maxColors === "custom"` ⇒
 * **生成出来的用色数与记录不一致，且没有任何报错**。这里补上，并由 `rerunDraft.test.ts` 钉住。
 */
export function seedRerunDraft(
  draft: ReturnType<typeof useDraft>,
  session: ReturnType<typeof useProjectSession>,
): boolean {
  const record = session.record;
  const params = session.params;
  if (record === null || record.source === null || params === null) return false;
  draft.adoptProject({
    source: { blob: record.source.blob, type: record.source.type, name: record.meta.name },
    params: {
      longSide: params.longSide,
      maxColors: params.maxColors,
      ...(params.customMaxColors === undefined
        ? {}
        : { customMaxColors: params.customMaxColors }),
      crop: { x: params.crop.x, y: params.crop.y, width: params.crop.width, height: params.crop.height },
      rotation: params.rotation,
    },
    meta: { id: record.meta.id, name: record.meta.name, createdAt: record.meta.createdAt },
  });
  return true;
}
```

- [ ] **步骤 8：运行测试验证通过**

运行：`npm run test -- src/views/__tests__/backOrHome.test.ts src/services/__tests__/rerunDraft.test.ts`
预期：PASS。

- [ ] **步骤 9：加路由 + 写 `EditResultPage.vue` + 改 `SetupPage.vue`**

1. `src/router/index.ts` 的编辑器路由**之后**加：

```ts
    { path: "/edit/:id/result", name: "edit-result", component: () => import("@/views/EditResultPage.vue") },
```

2. 新建 `src/views/EditResultPage.vue`：

```vue
<script setup lang="ts">
// `/edit/:id/result`：编辑保存成功后的结果页（C8 规格 §3.4）。标题行「修改成功」+ 共用结果卡片。
// 正常路径下 `session.pattern` 就是刚保存的那份（内存态，不重新读库）；刷新 / 直链进来时它为空，
// 这时按 id 补一次 `load`，仍取不到就回首页。
import { computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import ResultPanel from "@/components/result/ResultPanel.vue";
import { seedRerunDraft } from "@/services/rerunDraft";
import { getBuiltinPalette } from "@/services/palette";
import { useDraft } from "@/stores/draft";
import { useProjectSession } from "@/stores/project";
import { backOrHome } from "@/views/backOrHome";

const route = useRoute();
const router = useRouter();
const draft = useDraft();
const session = useProjectSession();
const palette = getBuiltinPalette();

const pattern = computed(() => session.pattern);
const canRerun = computed(() => session.record?.source != null);

onMounted(async () => {
  if (session.pattern !== null) return;
  const id = typeof route.params.id === "string" ? route.params.id : "";
  const loaded = await session.load(id);
  if (!loaded || session.pattern === null) await router.push({ name: "home" });
});

/** 「重做」= 改参数重新生成：播种草稿后回生图页（与编辑器里那颗「重做」同一个动作）。 */
function rerun(): void {
  if (seedRerunDraft(draft, session)) void router.push({ name: "setup" });
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <header class="flex flex-wrap items-center gap-3">
      <button
        data-testid="result-back"
        aria-label="返回"
        class="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-slate-300 text-xl text-slate-700"
        @click="backOrHome(router)"
      >
        ←
      </button>
      <h1 class="text-2xl font-bold text-slate-900">修改成功</h1>
    </header>

    <div class="mt-6">
      <ResultPanel
        v-if="pattern !== null"
        :pattern="pattern"
        :palette="palette"
        :is-new="false"
        :can-rerun="canRerun"
        :thumbnail="session.record?.meta.thumbnail ?? ''"
        @rerun="rerun"
        @edit="router.push({ name: 'editor', params: { id: route.params.id } })"
        @ok="router.push({ name: 'home' })"
      />
    </div>
  </main>
</template>
```

3. `SetupPage.vue`：删掉 `sheetOpen` / `exporting` / `resultImage` / `resultThumbnail` / `resultStats` /
   `resultUsages` / `resultSize` 与 `SheetViewer` / `ExportPanel` 的渲染，把结果 `<section>` 内换成：

```vue
      <section v-if="showResult" data-testid="result-pane" class="rounded bg-white p-4 shadow">
        <ResultPanel
          v-if="session.pattern !== null"
          :pattern="session.pattern"
          :palette="palette"
          :is-new="resultIsNew"
          :can-rerun="true"
          @rerun="draft.setStage('crop')"
          @edit="router.push({ name: 'editor', params: { id: session.record?.meta.id ?? '' } })"
          @ok="router.push({ name: 'home' })"
        />
      </section>
```

   （`@rerun` 用 `'crop'` 而不是 `'params'`：平板上右栏参数常驻、左栏要回到选区画布；
   手机单页与 stage 收敛在任务 8 一起做——那时这里改成 `setStage('edit')`。）

- [ ] **步骤 10：改既有断言并跑测试**

运行：`npm run test -- src/views/__tests__/SetupPage.test.ts src/router/__tests__/index.test.ts`
预期：先红后绿。逐条改：

- `SetupPage.test.ts` 里断言 `result-print` 的用例：删掉「打印」那半句（按钮已不存在）。
- `back-to-crop` / `back-to-params` 两处 → `result-rerun`（行为：`draft.stage` 变 `"crop"`）。
- `open-editor` / `result-view-sheet` 的断言保留（id 不变）。
- 本文件里 `sheet-close`×1 / `export-summary-print`×1 的用例：**删掉**——本页不再渲染这两个覆盖层，
  它们的职责搬到 `ResultPanel.test.ts`。
- 新增一条 `result-ok`：点它 `push({ name: "home" })`。
- `router/__tests__/index.test.ts` 加一条：`router.resolve({ name: "edit-result", params: { id: "a" } }).path === "/edit/a/result"`。

运行：`npm run test`
预期：PASS。

- [ ] **步骤 11：Commit**

```bash
git add src/components/result src/views/EditResultPage.vue src/views/backOrHome.ts src/views/__tests__/backOrHome.test.ts src/services/rerunDraft.ts src/services/__tests__/rerunDraft.test.ts src/router src/views/SetupPage.vue src/views/__tests__/SetupPage.test.ts
git commit -m "feat(ui): 结果页抽成共用组件并新增 /edit/:id/result，顺带补齐重跑的 customMaxColors"
```

---

## 任务 5：编辑页出口收敛（规格 §3.3）

**文件：**
- 修改：`src/components/editor/PatternToolbar.vue`（全文件）
- 修改：`src/components/editor/PalettePanel.vue:111-175`
- 修改：`src/views/EditorPage.vue`（标题行 `:487-496`、两行提示 `:503-517`、按钮 `:519-526`、工具栏接线 `:554-573`、覆盖层 `:650-670`、`save()` `:252-264`、`seedRerunDraft` `:421-441`）
- 测试：`src/components/editor/__tests__/PatternToolbar.test.ts`、`src/components/editor/__tests__/PalettePanel.test.ts`、`src/views/__tests__/EditorPage.test.ts`、`src/views/__tests__/EditorPageRouterLink.test.ts`

- [ ] **步骤 1：写失败的测试（工具栏）**

在 `src/components/editor/__tests__/PatternToolbar.test.ts` 里（**用既有的 `mountToolbar(overrides)`**）新增：

```ts
  it("工具行里有「橡皮」，它带按下态（C8 第 3 项：挪进画笔那一行）", async () => {
    const wrapper = mountToolbar({ eraserActive: true });
    const row = wrapper.get("[data-testid='toolbar-row-tools']");
    expect(row.text()).toContain("橡皮");
    const eraser = wrapper.get("[data-testid='eraser']");
    expect(eraser.attributes("aria-pressed")).toBe("true");
    await eraser.trigger("click");
    expect(wrapper.emitted("eraser")).toHaveLength(1);
  });

  it("输出行是「重做 + 保存」：没有查看施工图、没有打印（C8 第 3 项）", () => {
    const wrapper = mountToolbar();
    const row = wrapper.get("[data-testid='toolbar-row-output']");
    expect(row.text()).toContain("重做");
    expect(row.text()).toContain("保存");
    expect(wrapper.find("[data-testid='view-sheet']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='print']").exists()).toBe(false);
  });

  it("「重做」在保存那一行、白底，点它 emit rerun", async () => {
    const wrapper = mountToolbar();
    const rerun = wrapper.get("[data-testid='rerun']");
    expect(rerun.classes()).toContain("border-slate-300");
    expect(rerun.classes()).not.toContain("bg-slate-900");
    await rerun.trigger("click");
    expect(wrapper.emitted("rerun")).toHaveLength(1);
  });

  it("canRerun 为假时不渲染「重做」（没有原图的工程改不了参数）", () => {
    expect(mountToolbar({ canRerun: false }).find("[data-testid='rerun']").exists()).toBe(false);
  });

  it("历史行的第二颗按钮叫「恢复」（它仍是 redo 事件）", async () => {
    const wrapper = mountToolbar({ canRedo: true });
    const row = wrapper.get("[data-testid='toolbar-row-history']");
    expect(row.text()).toContain("撤销");
    expect(row.text()).toContain("恢复");
    expect(row.text()).not.toContain("重做");
    await wrapper.get("[data-testid='redo']").trigger("click");
    expect(wrapper.emitted("redo")).toHaveLength(1);
  });
```

**删掉**该文件里断言 `view-sheet` / `print` 两个按钮与它们 emit 的用例（6 处 `view-sheet` 命中）。

- [ ] **步骤 2：写失败的测试（调色板面板）**

在 `src/components/editor/__tests__/PalettePanel.test.ts` 里（**用既有的 `mountPanel(overrides)`**）新增：

```ts
  it("当前色槽是一颗按钮，点它展开选色（C8 第 3 项：删掉「添加颜色」入口）", async () => {
    const wrapper = mountPanel();
    const slot = wrapper.get("[data-testid='palette-current']");
    expect(slot.element.tagName).toBe("BUTTON");
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
    await slot.trigger("click");
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(true);
  });

  it("没有「添加颜色」按钮，也没有橡皮按钮（橡皮搬到工具栏）", () => {
    const wrapper = mountPanel();
    expect(wrapper.find("[data-testid='palette-add']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='palette-eraser']").exists()).toBe(false);
  });

  it("当前色是 EMPTY 时槽位文案是「橡皮」", () => {
    const wrapper = mountPanel({ currentColor: EMPTY });
    expect(wrapper.get("[data-testid='palette-current']").text()).toBe("橡皮");
  });
```

**删掉/改写**该文件里 `palette-add`（3 处）与 `palette-eraser`（1 处）的既有用例，
以及 `不拼豆（橡皮）` 那段文案断言（6 处 `不拼豆` 里有 5 处在本文件）。

- [ ] **步骤 3：写失败的测试（编辑页）**

在 `src/views/__tests__/EditorPage.test.ts` 里（**用既有的 `mountPage()` / `makeEditorRecord()`**，
并把下面代码里的 `saveMock` / `pushMock` 换成**该文件里既有的桩变量名**——先读文件头确认，
不要为了这几条用例新造一套桩）新增：

```ts
  it("标题前是返回箭头（不再是「回图纸库」RouterLink）（C8 第 3 项）", async () => {
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='back-to-library']").exists()).toBe(false);
    const back = wrapper.get("[data-testid='editor-back']");
    expect(back.element.tagName).toBe("BUTTON");
    expect(back.text()).toContain("←");
  });

  it("保存成功后跳到「修改成功」的结果页（C8 第 3 项）", async () => {
    const wrapper = await mountPage();
    await wrapper.get("[data-testid='editor-save']").trigger("click");
    await flushPromises();
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith({ name: "edit-result", params: { id: "a" } });
  });

  it("保存失败**不**跳转（留在编辑器给重试）", async () => { /* saveMock 返回 false ⇒ push 没被调用 */ });

  it("不再有改参重生的两行提示（C8 第 3 项）", async () => {
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='rerun-available']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='rerun-warning']").exists()).toBe(false);
  });

  it("编辑器自己不再渲染查看层与打印面板（出口只剩结果页那一条）", async () => {
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='export-panel']").exists()).toBe(false);
  });
```

**删掉**该文件里通过工具栏打开查看层 / 打印面板的用例（`sheet-close`×1、`export-close`×1、
`export-save-`×1、`export-item-`×2、`export-preview-`×1、`export-summary-print`×2），
以及 `rerun-available`（3 处）与 `rerun-warning`（1 处）的既有断言所在的用例。

- [ ] **步骤 4：运行测试验证失败**

运行：`npm run test -- src/components/editor/__tests__/PatternToolbar.test.ts src/components/editor/__tests__/PalettePanel.test.ts src/views/__tests__/EditorPage.test.ts`
预期：FAIL —— 新用例全红（`eraser` / `rerun` 不在工具栏、`palette-current` 还是 `div`、`editor-back` 不存在）。

- [ ] **步骤 5：改 `PatternToolbar.vue`**

props 加两个、emits 换两个：

```ts
const props = defineProps<{
  …既有七个…;
  /** 「重做」（改参数重新生成）是否可用：没有保存原图的工程没有这一项。 */
  canRerun: boolean;
  /** 当前色槽是不是橡皮（`EMPTY`）——「橡皮」按钮的按下态。 */
  eraserActive: boolean;
}>();
const emit = defineEmits<{
  "update:tool": [EditorTool];
  undo: [];
  redo: [];
  "update:showGrid": [boolean];
  "update:showLabels": [boolean];
  fit: [];
  "zoom-in": [];
  "zoom-out": [];
  save: [];
  /** 改参数重新生成（C8 从页面上那颗大按钮搬进来）。 */
  rerun: [];
  /** 把当前色槽设为橡皮（`EMPTY`）**并切回画笔**——见 `EditorPage.onEraser`。 */
  eraser: [];
}>();
```

模板：工具行尾部加橡皮、输出行换成「重做 + 保存 + 未保存」，删掉 `view-sheet` / `print` 两个按钮
（连带它们上面那段解释两个出口的注释）。橡皮的 `data-testid="eraser"`、`aria-pressed` 直接绑 `eraserActive`。

- [ ] **步骤 6：改 `PalettePanel.vue`**

- 当前色槽 `<div data-testid="palette-current">` → `<button type="button" data-testid="palette-current" :aria-expanded="picking" … @click="picking = !picking">`，
  内部内容不变，只把 `不拼豆（橡皮）` 改成 `橡皮`。
- 删掉底部那两颗按钮（`palette-add` / `palette-eraser`）与包着它们的 `<div>`。
- `PalettePicker` 的 `v-if="picking"` 保留（`onPick` 里 `picking = false` 的既有语义不变）。
- 文件头注释里「+「添加颜色」入口 +「橡皮 / 不拼豆」」那句改成「+ 点当前色槽展开的选择器」。

- [ ] **步骤 7：改 `EditorPage.vue`**

1. 删掉本地的 `seedRerunDraft()`，改成 `import { seedRerunDraft } from "@/services/rerunDraft";`，
   `rerun()` 里那一行变成 `if (!seedRerunDraft(draft, session)) return;`。
2. `import { EMPTY } from "@/core/pattern/types";` + 新增：

```ts
/**
 * 橡皮（C8 第 3 项：按钮从调色板搬进工具栏）。
 * **顺带切回画笔**：在框选 / 吸管工具下只把色槽设成 `EMPTY` 的话，用户点完看不出任何变化
 * （与「吸管取色后切回画笔」同口径）。
 */
function onEraser(): void {
  editor.setCurrentColor(EMPTY);
  editor.setTool("brush");
}
```

3. 标题行：删 `<RouterLink data-testid="back-to-library" to="/">` 整块，换成返回箭头按钮：

```vue
        <button
          data-testid="editor-back"
          aria-label="返回"
          class="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-slate-300 text-xl text-slate-700"
          @click="backOrHome(router)"
        >
          ←
        </button>
```

   （`import { backOrHome } from "@/views/backOrHome";`；`RouterLink` 的 import 可以删了——
   本文件不再有第二个 `RouterLink`。**保留** `onBeforeRouteLeave` 与 `beforeunload` 两条守卫，一行不改。）

4. 删掉 `rerun-available` / `rerun-unavailable` / `rerun-warning` 三段 `<p>` 与页面中部那颗 `rerun` 按钮。
   注意 `rerun-unavailable` 那句「这个工程没有保存原图…」**一并删除**：没有原图时工具栏不渲染「重做」，
   提示的对象不存在了。
5. 工具栏接线改成（删 `@view-sheet` / `@print`，加 `@rerun` / `@eraser`）：

```vue
            :can-rerun="session.record?.source != null"
            :eraser-active="editor.currentColor === EMPTY"
            …
            @rerun="rerun"
            @eraser="onEraser"
```

6. 删掉 `sheetOpen` / `panelMode` 两个 ref、`SheetViewer` / `ExportPanel` 的 import 与模板里那两块覆盖层。
7. `save()` 成功那一支加跳转：

```ts
    const saved = await session.save({ thumbnail });
    if (!saved) {
      editor.setError(session.error);
      return;
    }
    // 保存成功 ⇒ 跳「修改成功」结果页（C8 规格 §3.3）。此时 `session.dirty` 已为假，守卫不拦这次导航。
    void router.push({ name: "edit-result", params: { id: route.params.id } });
```

   **`finally` 里 `editor.setSaving(false)` 原样保留**（提前 `return` 也会走到它）。
8. 未保存确认条接进返回栈：

```ts
/**
 * 未保存确认条也是「临时界面」：Android 返回键先收掉它（= 继续编辑），而不是离开页面
 * （C8 规格 §3.6.2）。判据用 `leaving`，它由守卫与「重做」两条路径共同置真。
 */
useOverlayBack(
  () => {
    cancelLeave();
  },
  () => leaving.value,
);
```

- [ ] **步骤 8：改 `EditorPageRouterLink.test.ts`**

该文件用真 router 钉「入口声明的目标真的会走守卫」。入口从 `RouterLink` 变成按钮 + `backOrHome`
之后，用例改成：在 `/edit/a` 上置脏 → 点 `[data-testid='editor-back']` → 断言出现
`[data-testid='leave-bar']`（守卫被真的走了一次），并**保留**原来那条「`RouterLink` 换成 `router.push`
之后目标名字对不对」的教训注释（改为描述按钮这一条路径）。

- [ ] **步骤 9：运行测试验证通过**

运行：`npm run test -- src/components/editor src/views/__tests__/EditorPage.test.ts src/views/__tests__/EditorPageRouterLink.test.ts`
预期：PASS。

- [ ] **步骤 10：跑全套**

运行：`npm run test`
预期：PASS（此时 `SheetViewer` / `ExportPanel` 仍是旧版本，它们自己的用例不受影响——
编辑页不再渲染它们，等于把两处宿主减到一处）。

- [ ] **步骤 11：Commit**

```bash
git add src/components/editor/PatternToolbar.vue src/components/editor/PalettePanel.vue src/views/EditorPage.vue src/components/editor/__tests__ src/views/__tests__/EditorPage.test.ts src/views/__tests__/EditorPageRouterLink.test.ts
git commit -m "feat(ui): 编辑页出口收敛（重做/橡皮进工具栏、保存后跳修改成功页、返回箭头接返回栈）"
```

---

## 任务 6：查看层做成看图 app（规格 §4）

**文件：**
- 重写：`src/components/sheet/SheetViewer.vue`
- 测试：`src/components/sheet/__tests__/SheetViewer.test.ts`

- [ ] **步骤 1：写失败的测试**

在 `SheetViewer.test.ts` 里改两处、加一组（**用既有的 `mountViewer()` / `makePattern()` 与
`albumSave` / `renderSheetBlob` / `createObjectUrl` 三个替身**）：

```ts
/** 让舞台量到一个非零视口：happy-dom 的 `getBoundingClientRect()` 恒为 0，视图数学因此不可达。 */
function withViewport(wrapper: ReturnType<typeof mountViewer>, width = 800, height = 600): void {
  const stage = wrapper.get("[data-testid='sheet-stage']").element as HTMLElement;
  stage.getBoundingClientRect = () =>
    ({
      x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height,
      toJSON: () => ({}),
    }) as DOMRect;
  window.dispatchEvent(new Event("resize"));
}

/** 从 `<img>` 的内联 transform 里读当前比例（视图为 null 时返回 0）。 */
function scaleOf(wrapper: ReturnType<typeof mountViewer>): number {
  const style = wrapper.get("[data-testid='sheet-preview']").attributes("style") ?? "";
  const match = /scale\(([\d.]+)\)/.exec(style);
  return match === null ? 0 : Number(match[1]);
}

describe("SheetViewer 的看图手势（C8 第 2 项）", () => {
  it("底部操作条是四颗按钮：放大 / 缩小 / 打印 / 保存；「适配」按钮与精度声明都没了", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.find("[data-testid='sheet-zoom-in']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='sheet-zoom-out']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='sheet-print']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='sheet-save']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='sheet-zoom-fit']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='sheet-accuracy']").exists()).toBe(false);
  });

  it("量到视口后：默认是整图适配，点放大比例变大、点缩小比例回落", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    withViewport(wrapper);
    const fit = scaleOf(wrapper);
    expect(fit).toBeGreaterThan(0);

    await wrapper.get("[data-testid='sheet-zoom-in']").trigger("click");
    const zoomed = scaleOf(wrapper);
    expect(zoomed).toBeGreaterThan(fit);

    await wrapper.get("[data-testid='sheet-zoom-out']").trigger("click");
    expect(scaleOf(wrapper)).toBeLessThan(zoomed);
  });

  it("双击在「放大到上限」与「整图适配」之间切换", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    withViewport(wrapper);
    const fit = scaleOf(wrapper);
    const stage = wrapper.get("[data-testid='sheet-stage']");

    await stage.trigger("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 400, clientY: 300 });
    const zoomed = scaleOf(wrapper);
    expect(zoomed).toBeGreaterThan(fit);

    await stage.trigger("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 400, clientY: 300 });
    expect(scaleOf(wrapper)).toBeCloseTo(fit, 5);
  });

  it("单指拖动会平移视图（transform 的 translate 变化）", async () => {
    // **用 100×100 的图纸**：2×1 在 800×600 里默认视图是 64px/格（`minCellScale` 的上限），
    // 图像只有 128px 宽 < 视口 ⇒ `clampView` 把它按居中夹住，拖动**什么都不会变**（假绿）。
    // 100×100 的适配比例是 6px/格，连点 8 次放大后 6×1.25⁸ ≈ 35 → 图像 3500px，横向真的可拖。
    const wrapper = mount(SheetViewer, {
      props: { pattern: makePattern(100, 100), palette, name: "测试工程", thumbnail: "" },
    });
    await flushPromises();
    withViewport(wrapper);
    for (let i = 0; i < 8; i += 1) {
      await wrapper.get("[data-testid='sheet-zoom-in']").trigger("click");
    }
    const before = wrapper.get("[data-testid='sheet-preview']").attributes("style");
    const stage = wrapper.get("[data-testid='sheet-stage']");
    await stage.trigger("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointermove", { pointerId: 1, clientX: 430, clientY: 310 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 430, clientY: 310 });
    expect(wrapper.get("[data-testid='sheet-preview']").attributes("style")).not.toBe(before);
  });

  it("「打印」在查看层里打开打印页，关掉它回到查看层", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.find("[data-testid='export-panel']").exists()).toBe(false);
    await wrapper.get("[data-testid='sheet-print']").trigger("click");
    expect(wrapper.find("[data-testid='export-panel']").exists()).toBe(true);
    await wrapper.get("[data-testid='export-close']").trigger("click");
    expect(wrapper.find("[data-testid='export-panel']").exists()).toBe(false);
    // 打印页用的是**同一份**用量（不重算第二遍统计）
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(true);
  });

  it("接进覆盖层返回栈：closeTopOverlay() 关掉查看层", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    expect(closeTopOverlay()).toBe(true);
    expect(wrapper.emitted("close")).toEqual([[]]);
    wrapper.unmount();
  });
});
```

**删掉**「查看层显示色卡精度声明」那条用例；把原来 `describe("SheetViewer 的缩放接线")` 里
「三个按钮都在」那条按上文改写、`sheet-zoom-fit` 的调用从第二条里删掉（其余断言保留）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/components/sheet/__tests__/SheetViewer.test.ts`
预期：FAIL —— `sheet-print` 不存在、`sheet-zoom-fit` 还在、`sheet-accuracy` 还在、
双击不改变比例（组件今天没有捏合与双击）。

- [ ] **步骤 3：重写 `SheetViewer.vue` 的手势与视图段**

保留 C7 已有的三块（**逐字不动**）：`sheetBlob` / `blobUrl` / `busy` / `error` / `saveState` / `saving` /
`disposed` 这一整套现算与保存逻辑、`renderSheetBlob` 的调用与卸载销号、`save()` 的全部判据。
在它之上做四件事：

1. 用 **`pointers` Map + 增量捏合**替换原来的 `dragging` 单指实现：

```ts
/**
 * 看图手势（C8 规格 §4.2）。**结构照搬 `PatternCanvas` 的 `pointerdown/move/up`**（同一套
 * `pointers` Map + 两指手势），但**不合并成一个抽象**：那个组件要区分「工具手势」与「视图手势」，
 * 这里只有视图手势，硬合并会造出一个谁都不像的中间层。
 *
 * 增量式捏合（用上一帧的两指距离，而不是起始距离）：夹取在图纸边缘随时会生效，
 * 用起始距离算出来的比例在夹取之后会把图「弹」回去。
 */
const pointers = new Map<number, { readonly x: number; readonly y: number }>();
interface PinchState {
  readonly ids: readonly [number, number];
  lastDistance: number;
  lastCentre: { x: number; y: number };
}
let pinch: PinchState | null = null;
/** 单指按下时的落点：抬手时用它判「这是一次轻点还是一次拖动」。 */
let pressOrigin: { readonly x: number; readonly y: number } | null = null;
/** 上一次轻点（双击判定用）。**不依赖 `dblclick`**：Android WebView 不保证派发它。 */
let lastTap: { readonly at: number; readonly x: number; readonly y: number } | null = null;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 12;

function localPoint(event: PointerEvent, element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function onPointerDown(event: PointerEvent): void {
  const element = stage.value;
  if (element === null) return;
  const point = localPoint(event, element);
  pointers.set(event.pointerId, point);
  if (pointers.size === 1) {
    pressOrigin = point;
    dragging = point;
  }
  if (pointers.size === 2) {
    const ids = [...pointers.keys()] as [number, number];
    const a = pointers.get(ids[0]);
    const b = pointers.get(ids[1]);
    if (a !== undefined && b !== undefined) {
      pinch = {
        ids,
        lastDistance: Math.hypot(a.x - b.x, a.y - b.y),
        lastCentre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }
    dragging = null;
  }
}

function onPointerMove(event: PointerEvent): void {
  const element = stage.value;
  const current = view.value;
  if (element === null || current === null || !canTransform.value) return;
  if (!pointers.has(event.pointerId)) return;
  const previous = pointers.get(event.pointerId) as { x: number; y: number };
  const point = localPoint(event, element);
  pointers.set(event.pointerId, point);

  if (pinch !== null) {
    const a = pointers.get(pinch.ids[0]);
    const b = pointers.get(pinch.ids[1]);
    if (a === undefined || b === undefined) return;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // 退化输入（两指重合 / 还没分开）由**手势层**拦下：core 的守卫不该为一种正常动作放宽。
    if (pinch.lastDistance > 0 && distance > 0) {
      const scaled = zoomCellView(
        current,
        viewport.value,
        grid.value,
        current.scale * (distance / pinch.lastDistance),
        centre,
      );
      view.value = panCellView(
        scaled,
        viewport.value,
        grid.value,
        centre.x - pinch.lastCentre.x,
        centre.y - pinch.lastCentre.y,
      );
    }
    pinch.lastDistance = distance;
    pinch.lastCentre = centre;
    return;
  }

  if (dragging !== null && pointers.size === 1) {
    view.value = panCellView(
      current,
      viewport.value,
      grid.value,
      point.x - previous.x,
      point.y - previous.y,
    );
    dragging = point;
  }
}

function onPointerUp(event: PointerEvent): void {
  const element = stage.value;
  const point = element === null ? null : localPoint(event, element);
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinch = null;
  const origin = pressOrigin;
  if (pointers.size === 0) {
    dragging = null;
    pressOrigin = null;
  }
  if (point === null || origin === null || !canTransform.value) return;
  // 双击判定：**单指**、位移在容差内、两次轻点间隔 < 300ms。多指（捏合结束那一抬）不算。
  if (pointers.size > 0) return;
  if (Math.hypot(point.x - origin.x, point.y - origin.y) > TAP_SLOP_PX) {
    lastTap = null;
    return;
  }
  const now = Date.now();
  if (
    lastTap !== null &&
    now - lastTap.at < DOUBLE_TAP_MS &&
    Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < TAP_SLOP_PX
  ) {
    lastTap = null;
    onDoubleTap();
    return;
  }
  lastTap = { at: now, x: point.x, y: point.y };
}

/** 双击：在「整图适配」与「放大到上限」之间切换（看图 app 的通用动作）。 */
function onDoubleTap(): void {
  const current = view.value;
  if (current === null || !canTransform.value) return;
  const fit = defaultCellView(viewport.value, grid.value);
  if (current.scale > fit.scale * 1.01) {
    view.value = fit;
    return;
  }
  zoomAt(maxCellScale(viewport.value, grid.value), {
    x: viewport.value.width / 2,
    y: viewport.value.height / 2,
  });
}
```

   （`zoomAt` / `zoomBy` / `wheel` 沿用 C7 的实现；`zoomFit` 保留但**只给双击用**，
   不再有按钮：`zoomFit()` 内部就是 `view.value = defaultCellView(...)`。
   `import { maxCellScale }` 加进既有 import 里。
   `dragging` 的类型仍是 `{ x: number; y: number } | null`，改成 `let dragging: { x: number; y: number } | null = null;`。）

2. 接返回栈与打印面板：

```ts
/** 覆盖层返回栈（C8 规格 §3.6.2）：Android 返回键先关查看层，而不是离开页面。 */
useOverlayBack(() => emit("close"));

/** 打印面板是否打开。**在查看层内部打开**（同一页的 z-30 + 更靠后的 DOM 顺序即压在它之上），
 *  于是三个宿主页面都不必知道打印页存在（C8 规格 §4.3）。 */
const printing = ref(false);
/** 喂给打印页的用量与喂给渲染通道的是**同一份**（不重算第二遍 O(格数) 的统计）。 */
const usages = ref<readonly ColorUsage[]>([]);
```

   `onMounted` 里把 `const stats = patternStats(...)` 的结果存进 `usages.value`，并把它喂给 `renderSheetBlob`。

3. 模板：标题行 `[←] + 标题`（`sheet-close` **沿用旧 id**）、底部四颗按钮的行（`sheet-save-state` 挪进这一行，
   仍用 `v-if="saveState"` 包着）、`SheetViewer` 自己渲染 `<ExportPanel v-if="printing" … @close="printing = false" />`
   作为**根 section 内部的最后一个元素**（保持单根，`@close` 由宿主的 `v-if` 收掉整个查看层）。
   舞台加 `touch-none` 类（Tailwind 的 `touch-action: none`），并绑
   `@dblclick="onDoubleTap"`、`@pointerdown`、`@pointermove`、`@pointerup`、`@pointercancel="onPointerUp"`。

4. 删掉：`sheet-zoom-fit` 按钮、`sheet-accuracy` 那行、`{{ Math.round(scale) }} px/格` 与
   「捏合或拖动可缩放平移」两行、以及 `palette.accuracy` 的读取（组件不再需要 palette 的 accuracy；
   `palette` 仍是 props，渲染与统计要用它）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/components/sheet`
预期：PASS。若双击那条用例在 happy-dom 下拿不到 `PointerEvent` 的 `clientX`
（`@vue/test-utils` 退化成普通 `Event` 时会丢掉这些字段），把两次轻点改成手动派发：
`stage.element.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerId: 1, clientX: 400, clientY: 300 }))`
——**不要**为了避免这一点而把双击判定改成读 `event.timeStamp`（happy-dom 的时间戳不可控）。

- [ ] **步骤 5：跑全套**

运行：`npm run test`
预期：PASS（`LibraryPage.test.ts` 与结果页那两条 `sheet-close` 断言都仍然有效——id 没变）。

- [ ] **步骤 6：Commit**

```bash
git add src/components/sheet/SheetViewer.vue src/components/sheet/__tests__/SheetViewer.test.ts
git commit -m "feat(sheet): 查看层改为看图 app（捏合/双击/平移、底部操作条、内置打印入口）"
```

---

## 任务 7：打印页改成多页预览 + 一键保存（规格 §5）

**文件：**
- 重写：`src/components/editor/ExportPanel.vue`
- 测试：`src/components/editor/__tests__/ExportPanel.test.ts`

**保留不动的四样**（逐字沿用，它们是 B4/B6 的既有防线）：`SaveSnapshot` 快照、
`generation` 代数与 `unmounted` 双判据、`exportFilename` / `boardPageTile` / `getPlatform().album.save`
三条落盘纪律、四个选项按钮在保存期间的禁用。

- [ ] **步骤 1：改测试的落盘桩**

`ExportPanel.test.ts` 现在把落盘桩做在 `@/services/exporter` 的 `downloadBlob` 上。
改成**直接替 `getPlatform`**（面板调的就是 `getPlatform().album.save`，与 `SheetViewer.test.ts` 同款，
而且能观察到「顺序保存」的每一次调用与中途挂起）：

```ts
const albumSave = vi.hoisted(() => vi.fn());
const albumKind = vi.hoisted(() => ({ value: "download" as "download" | "album" }));
vi.mock("@/services/platform/capabilities", () => ({
  getPlatform: () => ({ album: { kind: albumKind.value, save: albumSave } }),
}));
```
`beforeEach` 里 `albumSave.mockReset().mockResolvedValue(undefined); albumKind.value = "download";`。
`resetExporterMock(...)` 仍然要调（`renderBoardPageBlob` 走的是真 `sheetExport` → 被替身的 `exporter` 五函数）。

**删掉**所有逐项用例（`export-item-*` 43 处、`export-save-*` 13 处、`export-preview-*` 11 处、
`export-close` 的关闭用例保留但断言目标不变），**保留**：摘要、空图纸、四个选项、
「只给 props 就能完整工作（不建 pinia）」、源码级「不许 import store」闸门、长按提示。

- [ ] **步骤 2：写失败的测试（预览 + 一键保存）**

```ts
describe("C8：多页预览与一键保存", () => {
  it("预览条一页一格，只有当前页真的渲染出图（16 页全量驻留会吃掉内存）", async () => {
    const wrapper = mountPanel(printOverrides());   // 116×116 + 29 板 ⇒ 16 页
    await flushPromises();
    expect(wrapper.get("[data-testid='print-page-indicator']").text()).toContain("第 1 / 16 页");
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(16);
    expect(wrapper.findAll("[data-testid^='print-preview-img-']")).toHaveLength(1);
    const src = wrapper.get("[data-testid='print-preview-img-0']").attributes("src");
    expect(createdUrls).toContain(src);
  });

  it("翻到第 2 页：换图、释放上一页的 object URL", async () => {
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    const first = wrapper.get("[data-testid='print-preview-img-0']").attributes("src");
    await wrapper.get("[data-testid='print-page-next']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='print-page-indicator']").text()).toContain("第 2 / 16 页");
    expect(wrapper.find("[data-testid='print-preview-img-0']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='print-preview-img-1']").exists()).toBe(true);
    expect(revokedUrls).toContain(first);
  });

  it("一键保存：顺序存满 16 张，文件名逐页正确，文案按落点分叉", async () => {
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();

    expect(albumSave).toHaveBeenCalledTimes(16);
    const names = albumSave.mock.calls.map((call) => call[1] as string);
    expect(names[0]).toBe(exportFilename("测试工程", "打印", { rowIndex: 0, colIndex: 0 }));
    expect(names[15]).toBe(exportFilename("测试工程", "打印", { rowIndex: 3, colIndex: 3 }));
    // 浏览器落点说「已生成」，不冒充相册（既有口径逐字保留）
    expect(wrapper.get("[data-testid='print-save-state']").text()).toContain("已生成 16 张");
  });

  it("中途失败：停下、如实报已存几张与第几张失败，按钮变成「继续保存剩余 N 张」", async () => {
    albumSave
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("相册写入被拒绝"));
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();

    expect(albumSave).toHaveBeenCalledTimes(3);
    const text = wrapper.get("[data-testid='print-save-state']").text();
    expect(text).toContain("已存 2 张");
    expect(text).toContain("第 3 张失败：相册写入被拒绝");

    // 重试只存没成功的那 14 页（不重存已经进相册的）
    albumSave.mockResolvedValue(undefined);
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();
    expect(albumSave).toHaveBeenCalledTimes(3 + 14);
    expect(wrapper.get("[data-testid='print-save-state']").text()).toContain("已生成 16 张");
  });

  it("保存期间禁用四个选项与保存按钮，并显示「正在保存 第 1/16 页」", async () => {
    let release: () => void = () => undefined;
    albumSave.mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    await wrapper.get("[data-testid='print-save-all']").trigger("click");

    expect(wrapper.get("[data-testid='print-save-state']").text()).toContain("正在保存 第 1/16 页");
    expect((wrapper.get("[data-testid='print-save-all']").element as HTMLButtonElement).disabled).toBe(true);
    for (const id of ["print-board-29", "print-board-58", "print-paper-a4", "print-paper-a3"]) {
      expect((wrapper.get(`[data-testid='${id}']`).element as HTMLButtonElement).disabled).toBe(true);
    }
    release();
    await flushPromises();
  });

  it("保存中途换板大小：落盘照常完成，但不把状态写回已经被丢弃的清单（代数判据）", async () => {
    // 沿用既有那条「飞行中改选项」用例的手法：手动解除 disabled 之后点选项按钮。
  });

  it("面板在结算前被卸载 ⇒ 连 object URL 都不建（沿用 F6 的口径）", async () => { /* … */ });
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`npm run test -- src/components/editor/__tests__/ExportPanel.test.ts`
预期：FAIL —— `print-preview-*` / `print-page-*` / `print-save-all` / `print-save-state` 都不存在。

- [ ] **步骤 4：重写面板**

状态（把逐项 `ExportItem` 那一套换成一条全局状态）：

```ts
/** 当前预览到第几页（0 起）。预览条左右滑动与 ◀/▶ 都写它。 */
const currentPage = ref(0);
/** 当前页的预览 URL。**只有当前页**——116×116 + 29 板是 16 页，全量驻留会把十几张位图钉在内存里。 */
const previewUrl = ref("");
const previewPage = ref(-1);
/** 保存状态：`saved` 是**已经成功落盘**的页索引集合，失败后重试只补没成功的。 */
const saved = ref<ReadonlySet<number>>(new Set());
const savingAll = ref(false);
const saveState = ref("");
const saveError = ref("");
```

关键函数（**判据与快照逐字沿用 B6**）：

```ts
/**
 * 渲染并显示第 `index` 页的预览：先取快照（与落盘同一份），再渲染，再建 URL。
 * **代数 / 卸载判据排在 `createObjectURL` 之前**——URL 根本不诞生，就没有「诞生在面板被丢弃之后」这一形态。
 */
async function showPreview(index: number): Promise<void> { … }

/** 释放当前预览 URL（换页与卸载都走它，销号语义只有一份）。 */
function revokePreview(): void { … }

/** 一键保存：**顺序**逐页渲染 + 落盘，逐页更新进度；失败即停并如实报数。 */
async function saveAll(): Promise<void> { … }
```

模板结构（`print-` 前缀的新 id 见规格 §5.3）：

```
[← export-close]  打印
摘要 export-summary-print / 四个选项 / export-empty-note / 长按提示
◀ 第 N / M 页 ▶（print-page-indicator / print-page-prev / print-page-next）
横向预览条：overflow-x-auto snap-x snap-mandatory，一页一格
   · 当前页 ⇒ <img :data-testid="`print-preview-img-${i}`">
   · 其它页 ⇒ 占位 <p>第 N 页</p>
[ 保存全部（N 张） ] print-save-all
<p v-if="saveState" print-save-state>
```

- 滑动改变当前页：预览条绑 `@scroll`，用 `Math.round(strip.scrollLeft / strip.clientWidth)` 求当前页
  （`scroll-snap-type: x mandatory` 保证它总是整页对齐），与 `currentPage` 不同才触发 `showPreview`。
- 保存按钮文案：没有失败时「保存全部（16 张）」；有失败时「继续保存剩余 14 张」。
- 成功文案按落点分叉（既有口径）：`album` ⇒「已保存到相册 16 张」、`download` ⇒「已生成 16 张」。
- `<- export-close` 是返回箭头（图标 `←`），`data-testid` **不变**；同时 `useOverlayBack(() => emit("close"))`
  接进返回栈（规格 §3.6.2）。
- 删掉 `ExportItem` 接口、`items` / `makeItems` / `statusText` / `saveItem` / `pageUsages` 的逐项用法
  （`pageUsages(snapshot, index)` **保留**：一键保存逐页要本页用量）。

- [ ] **步骤 5：运行测试验证通过**

运行：`npm run test -- src/components/editor/__tests__/ExportPanel.test.ts`
预期：PASS。

- [ ] **步骤 6：跑全套**

运行：`npm run test`
预期：PASS（此时只有查看层渲染这个面板，它的 `export-close` 断言仍然有效）。

- [ ] **步骤 7：Commit**

```bash
git add src/components/editor/ExportPanel.vue src/components/editor/__tests__/ExportPanel.test.ts
git commit -m "feat(ui): 打印页改为多页预览 + 一键顺序保存（推翻「不做连续多下载」）"
```

---

## 任务 8：生图页单页化 + 滑动条 + 改名输入（规格 §6 与 §3.7）

**文件：**
- 创建：`src/components/param/TierSlider.vue`
- 修改：`src/stores/draft.ts:36`（`Stage`）、`:46-51`（`RerunTarget`）、`:205-233`（新增 `name`）、`:264-286`（`adoptImage`）、`:300-325`（`adoptProject`）、`:341-355`（`setRerunOf`）、`:473-489`（`reset`）、`:491-515`（导出面）
- 修改：`src/components/param/ParamPanel.vue`（全文件）
- 修改：`src/views/SetupPage.vue`（页头、单页布局、接线、`generate()` 用 `draft.name`）
- 测试：`src/components/param/__tests__/TierSlider.test.ts`（新建）、`src/components/param/__tests__/ParamPanel.test.ts`、`src/stores/__tests__/draft.test.ts`、`src/views/__tests__/SetupPage.test.ts`、`src/views/__tests__/PickPage.test.ts`、`src/composables/__tests__/useShareIntake.test.ts`

- [ ] **步骤 1：写失败的测试（store 的三处收敛）**

在 `src/stores/__tests__/draft.test.ts` 里改既有断言、加新用例：

```ts
  it("工程名是草稿的一部分：选图即定名，可随时改（C8 规格 §3.7）", () => {
    const draft = useDraft();
    draft.adoptImage({ source: { blob: new Blob([]), type: "image/png", name: "IMG_20260401_123456.jpg" }, sourceSize: { width: 10, height: 10 }, preview: fakeCanvas() });
    expect(draft.name).toBe("IMG_20260401_123456");
    draft.setName("  小猫  ");
    expect(draft.name).toBe("小猫");            // 走 normalizeProjectName：trim + 非空 + ≤100
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
    expect(() => draft.setRerunOf({ id: "a", name: "小猫", createdAt: "x" } as never)).toThrow(/id|createdAt/);
  });

  it("stage 只有 edit / result 两个取值", () => {
    const draft = useDraft();
    expect(draft.stage).toBe("edit");
    draft.setStage("result");
    expect(draft.stage).toBe("result");
    draft.setStage("params" as never);
    // 非法取值由 requireStage 响亮拒绝
    expect(() => draft.setStage("crop" as never)).toThrow(/阶段/);
  });
```

**同时把该文件里所有 `"crop"` / `"params"` 的断言改成 `"edit"`**（14 处 `stage` 命中分布在本文件与
`SetupPage.test.ts` / `PickPage.test.ts` / `useShareIntake.test.ts`）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/stores/__tests__/draft.test.ts`
预期：FAIL —— `draft.name` / `setName` 不存在、`Stage` 仍认 `"crop"`。

- [ ] **步骤 3：改 `stores/draft.ts`**

```ts
/** 向导阶段（C8 收敛）：手机单页之后 `crop` 与 `params` 渲染出完全一样的界面，两个取值没有区别。 */
export type Stage = "edit" | "result";

/**
 * 「本草稿指向的落盘记录」（身份）。**不再含 `name`**（C8 规格 §3.7）：名字搬到 `draft.name`，
 * 身份只管「下一次生成是新建还是覆盖同一条」。
 */
export interface RerunTarget {
  readonly id: string;
  readonly createdAt: string;
}

/**
 * `adoptProject`（从已有工程重跑）的入参：**身份 + 名字**。
 *
 * **它是独立类型、不是 `RerunTarget`**：身份（`RerunTarget`）已经收窄成 `{ id, createdAt }`，
 * 而重跑必须同时把记录里的名字带进草稿（`name.value = normalizeProjectName(input.meta.name)`）——
 * 两者恰好都从 `ProjectMeta` 来，但语义不同，混用一个类型会让「少了名字」在编译期看不出来。
 */
export interface AdoptMeta {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}
```

- `const name = ref("");` + `function setName(value: string): void { name.value = normalizeProjectName(value); }`
  （`import { defaultProjectName, normalizeProjectName } from "@/services/projectStore";`）。
- `adoptImage`：`name.value = defaultProjectName(input.source.name);`（放在 `source.value = input.source` 之后）。
- `adoptProject`：入参 `meta` 的类型由 `RerunTarget` 改成 **`AdoptMeta`**（`{ id, name, createdAt }`，
  见上面的类型块），主体写 `name.value = normalizeProjectName(input.meta.name);`
  与 `rerunOf.value = { id: input.meta.id, createdAt: input.meta.createdAt };`。
  **调用方不用改**：`services/rerunDraft.ts`（任务 4）与 `EditorPage` 传的都是 `{ id, name, createdAt }`。
- `setRerunOf`：`rerunOf.value = { id: next.id, createdAt: next.createdAt };`，
  `requireRerunTarget` 去掉对 `name` 的校验（保留 `id` / `createdAt`）。
- `reset()`：`name.value = "";`。
- `adoptImage` / `adoptProject` / `reset` 里的 `stage.value = "crop"` 一律改 `"edit"`。
- `requireStage`：只认 `"edit" | "result"`，消息写「向导阶段非法：…（只允许 edit / result）」。
- 返回值里加 `name` 与 `setName`。JSDoc 按 §3.7 补一段（三个来源合并成一个、`adoptImage` 种下默认名）。

- [ ] **步骤 4：运行 store 测试验证通过**

运行：`npm run test -- src/stores/__tests__/draft.test.ts`
预期：PASS。

- [ ] **步骤 5：写失败的测试（`TierSlider`）**

新建 `src/components/param/__tests__/TierSlider.test.ts`：

```ts
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import TierSlider from "@/components/param/TierSlider.vue";

function mountSlider(overrides: Record<string, unknown> = {}) {
  return mount(TierSlider, {
    props: {
      label: "长边豆数",
      min: 1,
      max: 116,
      value: 58,
      nodes: [{ value: 29, label: "29" }, { value: 58, label: "58" }, { value: 116, label: "116" }],
      inputTestId: "long-side",
      sliderTestId: "long-side-slider",
      ...overrides,
    },
  });
}

describe("TierSlider（C8 第 4 项）", () => {
  it("滑条与数字输入框都在，且输入框的回显是当前值", () => {
    const wrapper = mountSlider();
    expect(wrapper.get("[data-testid='long-side-slider']").attributes("type")).toBe("range");
    const input = wrapper.get("[data-testid='long-side']");
    expect(input.attributes("type")).toBe("number");
    expect((input.element as HTMLInputElement).value).toBe("58");
  });

  it("每个节点都画出了标签（档位用滑条上的节点表示）", () => {
    const wrapper = mountSlider();
    const marks = wrapper.findAll("[data-node]").map((mark) => mark.text());
    expect(marks).toEqual(["29", "58", "116"]);
  });

  it("拖滑条 ⇒ emit 合法值与空错误", async () => {
    const wrapper = mountSlider();
    await wrapper.get("[data-testid='long-side-slider']").setValue("100");
    expect(wrapper.emitted("input")).toEqual([[{ value: 100, error: "" }]]);
  });

  it("输入框填非法值 ⇒ emit value: null + 中文原因（父级据此禁用生成）", async () => {
    const wrapper = mountSlider();
    await wrapper.get("[data-testid='long-side']").setValue("1.5");
    expect(wrapper.emitted("input")?.at(-1)).toEqual([{ value: null, error: "要填 1–116 之间的整数" }]);
    await wrapper.get("[data-testid='long-side']").setValue("");
    expect(wrapper.emitted("input")?.at(-1)).toEqual([{ value: null, error: "要填 1–116 之间的整数" }]);
  });

  it("父级改值 ⇒ 输入框回显跟着走（只有一个写入者）", async () => {
    const wrapper = mountSlider();
    await wrapper.setProps({ value: 29 });
    expect((wrapper.get("[data-testid='long-side']").element as HTMLInputElement).value).toBe("29");
  });
});
```

- [ ] **步骤 6：运行测试验证失败**

运行：`npm run test -- src/components/param/__tests__/TierSlider.test.ts`
预期：FAIL —— 模块不存在。

- [ ] **步骤 7：实现 `TierSlider.vue`**

```vue
<script setup lang="ts">
// 档位滑动条 + 数字输入框（C8 第 4 项）。**纯展示**：props 进、事件出，不 import store，
// 也不知道「长边」或「用色数」是什么——档位节点由调用方给。
//
// 两个写入者会漂移：所以输入框的文本只由本组件持有（`draft`），父级的 `value` 只在**变化**时覆盖它
// （与既有 `longSide` 输入框同一套手法）。
import { computed, ref, watch } from "vue";

export interface TierNode {
  readonly value: number;
  readonly label: string;
}

const props = defineProps<{
  label: string;
  min: number;
  max: number;
  /** 当前生效值（父级权威）。 */
  value: number;
  nodes: readonly TierNode[];
  inputTestId: string;
  sliderTestId: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  /** 每敲一次都会 emit：非法时 `value` 为 `null`、`error` 是中文原因。 */
  input: [{ readonly value: number | null; readonly error: string }];
}>();

const draft = ref(String(props.value));
watch(
  () => props.value,
  (next) => {
    draft.value = String(next);
  },
);

/** 解析出的合法值；非法（空串、小数、越界、非有限）为 `null`。 */
const parsed = computed<number | null>(() => {
  const value = Number(draft.value);
  return Number.isInteger(value) && value >= props.min && value <= props.max ? value : null;
});

const error = computed(() =>
  parsed.value === null ? `要填 ${props.min}–${props.max} 之间的整数` : "",
);

function report(text: string): void {
  draft.value = text;
  emit("input", { value: parsed.value, error: error.value });
}

/** 节点在轨道上的位置（**近似**：原生拇指会把行程两端各内缩约半个拇指宽，
 *  但它是档位提示、精确值看输入框，不值得为它自绘轨道）。 */
function nodeLeft(value: number): string {
  return `${((value - props.min) / (props.max - props.min)) * 100}%`;
}
</script>

<template>
  <label class="block text-lg text-slate-800">
    {{ label }}
    <div class="mt-2 flex items-center gap-3">
      <div class="min-w-0 flex-1">
        <input
          :data-testid="sliderTestId"
          type="range"
          :min="min"
          :max="max"
          :value="value"
          :disabled="disabled"
          class="h-11 w-full accent-slate-900 disabled:opacity-50"
          @input="report(($event.target as HTMLInputElement).value)"
        />
        <div class="relative h-5">
          <span
            v-for="node in nodes"
            :key="node.value"
            data-node
            class="absolute -translate-x-1/2 text-xs text-slate-500"
            :style="{ left: nodeLeft(node.value) }"
          >
            {{ node.label }}
          </span>
        </div>
      </div>
      <input
        :data-testid="inputTestId"
        :value="draft"
        type="number"
        inputmode="numeric"
        :min="min"
        :max="max"
        :disabled="disabled"
        class="min-h-12 w-24 rounded border border-slate-300 px-3 text-lg disabled:opacity-50"
        @input="report(($event.target as HTMLInputElement).value)"
      />
    </div>
  </label>
</template>
```

- [ ] **步骤 8：运行测试验证通过**

运行：`npm run test -- src/components/param/__tests__/TierSlider.test.ts`
预期：PASS。

- [ ] **步骤 9：改 `ParamPanel.vue`（+ 重写它的用例）**

1. props：删 `paletteAccuracy`，加 `name: string`；emits 加 `"update:name": [string]`。
2. 顶部加工程名输入（**最上面**，先于两个参数）：

```vue
    <div class="block text-lg text-slate-800">
      图纸名字
      <input
        :value="nameDraft"
        data-testid="project-name-input"
        type="text"
        :maxlength="PROJECT_NAME_MAX"
        class="mt-2 block min-h-12 w-full rounded border border-slate-300 px-3 text-lg"
        @input="onNameInput"
      />
      <p data-testid="project-name-counter" class="mt-1 text-base text-slate-500">
        {{ nameDraft.trim().length }} / {{ PROJECT_NAME_MAX }} · 这个名字会印在图纸标题与文件名上
      </p>
    </div>
```

```ts
const nameDraft = ref(props.name);
watch(() => props.name, (next) => { nameDraft.value = next; });
const nameError = computed(() => (nameDraft.value.trim().length === 0 ? "工程名称不能为空" : ""));

function onNameInput(event: Event): void {
  nameDraft.value = (event.target as HTMLInputElement).value;
  if (nameError.value === "") emit("update:name", nameDraft.value);
}
```

3. 长边与用色数换成两个 `TierSlider`：

```vue
    <TierSlider
      label="长边豆数"
      :min="MIN_LONG_SIDE"
      :max="MAX_LONG_SIDE"
      :value="longSide"
      :nodes="LONG_SIDE_NODES"
      :disabled="busy"
      input-test-id="long-side"
      slider-test-id="long-side-slider"
      @input="onLongSideInput"
    />

    <TierSlider
      label="用几种颜色"
      :min="1"
      :max="paletteColorCount"
      :value="colorSliderValue"
      :nodes="COLOR_NODES"
      :disabled="busy"
      input-test-id="max-colors"
      slider-test-id="max-colors-slider"
      @input="onMaxColorsInput"
    />
    <p data-testid="max-colors-tier" class="text-base text-slate-500">{{ colorTierText }}</p>
```

```ts
const LONG_SIDE_NODES = [{ value: 29, label: "29" }, { value: 58, label: "58" }, { value: 116, label: "116" }];
/** 用色档位的节点：三个预设 + **最右端的「不限」**（滑条上界就是色卡色数）。 */
const COLOR_NODES = computed(() => [
  { value: 8, label: "8 色" },
  { value: 16, label: "16 色" },
  { value: 24, label: "24 色" },
  { value: props.paletteColorCount, label: "不限" },
]);

/** 滑条上的位置：`"all"` 停在最右端，`"custom"` 停在自定义值上。 */
const colorSliderValue = computed(() =>
  props.maxColors === "all"
    ? props.paletteColorCount
    : props.maxColors === "custom"
      ? props.customMaxColors
      : props.maxColors,
);

const colorTierText = computed(() => {
  if (props.maxColors === "all") return "用色：不限（跳过分簇，能少则少）";
  if (props.maxColors === "custom") return `用色：自定义 ${props.customMaxColors} 色`;
  return `用色：${props.maxColors} 色`;
});

function onLongSideInput(state: { value: number | null; error: string }): void {
  longSideError.value = state.error === "" ? "" : `长边豆数${state.error}`;
  longSideDraft.value = state.value;
  if (state.value !== null) emit("update:longSide", state.value);
}

/**
 * 用色数：**滑条上界就是「不限」**（C8 规格 §6 裁定 B）。三个预设值原样映射到档位，
 * 其余整数走 `"custom"` + 该数值；填到上界（= 色卡色数）就是「不限」。
 */
function onMaxColorsInput(state: { value: number | null; error: string }): void {
  colorError.value = state.error === "" ? "" : `色数${state.error}`;
  if (state.value === null) return;
  if (state.value >= props.paletteColorCount) {
    emit("update:maxColors", "all");
    return;
  }
  if (state.value === 8 || state.value === 16 || state.value === 24) {
    emit("update:maxColors", state.value);
    return;
  }
  emit("update:customMaxColors", state.value);
  emit("update:maxColors", "custom");
}
```

4. `blockedReason` 变成 `longSideError || colorError || nameError || props.generateBlockedReason`
   （本地错优先于父级原因，顺序不变）。
5. 删掉：`LONG_SIDE_PRESETS` 三个按钮、`MAX_COLOR_CHOICES` 五个按钮、`custom-max-colors` 输入框、
   色卡卡片里的 `paletteAccuracy` 那一行（色卡名保留）。
6. `ParamPanel.test.ts` 的改法：`max-colors-*` 按钮的用例改成滑条用例
   （`max-colors-slider` 的 `.setValue("8")` / `"20"` / `"221"` ⇒ 分别 emit `8` / `custom`+`20` / `all`），
   `custom-max-colors` 的用例删掉，`palette-card` 的断言删掉 accuracy 那半句，新增工程名输入的三条
   （回显 / 计数 / 空名字报错且不 emit）。

- [ ] **步骤 10：改 `SetupPage.vue`（单页 + 接线）**

1. 页头：删「回图纸库」按钮，换成 `setup-back` 返回箭头（`@click="backOrHome(router)"`，与任务 4/5 同款）。
2. 可见性判据换成单页口径：

```ts
/** 结果阶段才换成结果卡片；其余时候**一页里同时有选区画布与参数**（手机也不再分页，C8 第 4 项）。 */
const showResult = computed(() => draft.stage === "result" && session.pattern !== null);
const showEditor = computed(() => draft.stage !== "result");
```
   `showCanvas` / `showParams` 删除；模板里 `crop-pane` 与 `param-pane` 都改用 `v-if="showEditor"`，
   `isWide` 只决定两栏还是单栏（`grid lg:grid-cols-[2fr_1fr]`）。
3. 删掉底部「下一步」（`to-params`）与「上一步」（`back-to-crop`）那一整块。
4. `ParamPanel` 接线：加 `:name="draft.name"` 与 `@update:name="draft.setName"`，删 `:palette-accuracy`。
5. `generate()`：`name: draft.name`（删掉 `defaultProjectName(source.name)` 那个 fallback 与它的 import）。
6. 结果卡片的 `@rerun` 从 `draft.setStage('crop')` 改成 `draft.setStage('edit')`（任务 4 留的临时值）。
7. `onBeforeUnmount` / `retrySave` / `resultIsNew` 等逻辑一行不改。

- [ ] **步骤 11：改既有断言并跑全套**

运行：`npm run test`
预期：先红后绿。逐条改：

- `SetupPage.test.ts`：`to-params` / 「下一步」/「上一步」的用例删除；`stage` 的 `"crop"` → `"edit"`；
  单页可见性新增一条（**手机（`isWide = false`）时 `crop-pane` 与 `param-pane` 同时存在**，
  用既有的 `matchMedia` 桩驱动）；`max-colors-*` / `preset-*` / `custom-max-colors` 的操作改成滑条。
- `PickPage.test.ts`（1 处）与 `useShareIntake.test.ts`（2 处）：`draft.stage === "crop"` → `"edit"`。

运行：`npm run build`
预期：PASS（`vue-tsc` 严格模式、无 `any`）。

- [ ] **步骤 12：Commit**

```bash
git add src/stores/draft.ts src/stores/__tests__/draft.test.ts src/components/param src/views/SetupPage.vue src/views/__tests__/SetupPage.test.ts src/views/__tests__/PickPage.test.ts src/composables/__tests__/useShareIntake.test.ts
git commit -m "feat(ui): 生图页单页化 + 档位滑动条 + 工程名提前可改（stage 收敛为 edit/result）"
```

---

## 任务 9：同步既有文档口径与版本号（规格 §8、§12）

**文件：**
- 修改：`docs/开发约定详解.md`、`docs/开发文档索引.md`、`docs/superpowers/specs/2026-09-30-image-to-pattern-design.md`、`2026-10-03-app-b2-crop-settings-design.md`、`2026-10-05-app-b4-export-design.md`、`2026-10-09-c7-sheet-style-and-exports-design.md`
- 修改：`package.json` / `package-lock.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock`

- [ ] **步骤 1：`开发约定详解.md`**

- §入口校验与 §关键常量两处 `用色档位 16 | 32 | null` → `8 | 16 | 24 | "custom" | "all"`（C7 漏改，本次修正，并注明「2026-10-10 由 C8 补」）。
- §关键常量：按计划任务 3 的常量增删逐条同步（删 `SHEET_TITLE_FONT_PX` / `SHEET_TITLE_H` /
  `LEGEND_ITEM_W` / `LEGEND_ROW_H` / `LEGEND_SWATCH_SIZE` / `LEGEND_CODE_X` / `LEGEND_COUNT_RIGHT_PAD`，
  新增比例常量与 `LEGEND_PAD_TOP = 24`、`SHEET_TITLE_GAP = 18`）。
- 打印页那一段「标题行左沿 = 可打印区左沿」→「标题 / 用料条 / 网格块三者左沿对齐（C8 §7.4）」。
- 新增一条：**打印页一键保存会连发 N 次下载**，这是 B4 那条「不做连续多下载」纪律的**明确推翻**
  （人类伙伴 2026-10-10 裁定，交付面是 Android 壳）。
- `Palette.accuracy`：写明它**零 UI 渲染点**（消费者只有 `registry.ts` 的 `requireString` 与色卡数据用例），
  主规格 §11 那条「必须显示在色卡 UI 与导出图纸上」**已作废**。

- [ ] **步骤 2：主规格与三份既有规格改口径**

- `2026-09-30-image-to-pattern-design.md`：§11 与 `Palette.accuracy` 的注释改成
  「**仅作数据来源说明，不参与任何 UI 渲染**（2026-10-10 由 C8 变更，见 C8 规格 §8.1）」。
- `2026-10-03-app-b2-crop-settings-design.md` §187 / §355、`2026-10-05-app-b4-export-design.md` §416 附近：
  同一句硬要求加更正注记。
- `2026-10-09-c7-sheet-style-and-exports-design.md` §3.5：**加更正注记**（不改历史正文，见 `开发约定详解.md` §文档真源），
  指到 C8 规格 §8.1。

- [ ] **步骤 3：`开发文档索引.md`**

逐阶段表补两行（**C7 那行本来就没登记**）：

```markdown
| C7：施工图改版与出口收敛 | [规格](superpowers/specs/2026-10-09-c7-sheet-style-and-exports-design.md) | [计划](superpowers/plans/2026-10-09-c7-sheet-style-and-exports.md) | — | — |
| C8：出口与交互重做、看图 / 打印改造、图面版式放大 | [规格](superpowers/specs/2026-10-10-c8-exits-viewer-and-layout-design.md) | [计划](superpowers/plans/2026-10-10-c8-exits-viewer-and-layout.md) | — | — |
```

- [ ] **步骤 4：版本号定到 0.12.0（五处同步）**

`package.json` 与 `package-lock.json` 的 `version`、`src-tauri/tauri.conf.json` 的 `version`、
`src-tauri/Cargo.toml` 的 `version`、`src-tauri/Cargo.lock` 里本包的 `version`。
**改完核对五处读数一致**（`git diff --stat` + 逐文件读回）。

- [ ] **步骤 5：跑最后的验证**

运行：`npm run test` 与 `npm run build`
预期：两条都 PASS。**不接受**「只改了文档所以不用跑」。

- [ ] **步骤 6：Commit**

```bash
git add docs package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(release): 同步 C8 口径与常量表，版本号定到 0.12.0"
```

---

## 自检记录（写计划后逐条对照规格）

**1. 规格覆盖度**

| 规格章节 | 落在哪个任务 |
|---|---|
| §3.1 导航图 | 任务 4（路由）+ 任务 5（编辑页）+ 任务 8（生图页） |
| §3.2 图纸库页 | 任务 2 |
| §3.3 编辑页 | 任务 5 |
| §3.4 结果页 + 新路由 | 任务 4 |
| §3.5 `draft.stage` 收敛 | 任务 8（与单页化同任务：分开做会留下「收敛了但手机还在分页」的不一致态） |
| §3.6.1 返回箭头去向 | 任务 4（`backOrHome`）+ 任务 5（编辑页）+ 任务 8（生图页） |
| §3.6.2 覆盖层返回栈 | 任务 1（模块与返回键）+ 任务 2（删除框）+ 任务 5（确认条）+ 任务 6（查看层）+ 任务 7（打印页） |
| §3.7 工程名单一真相 | 任务 8（含改名输入） |
| §4 查看层 | 任务 6 |
| §5 打印页 | 任务 7 |
| §6 生图页 | 任务 8 |
| §7.1–§7.5 图面版式 | 任务 3（常量表同步在任务 9） |
| §8 文档与冲突 | 任务 9 |
| §9 风险 | 各任务的「跑全套」步骤 + 任务 9 |
| §10 验收 | 任务 9 的 `npm run test` / `npm run build`；人工清单在实现报告里逐条填读数 |
| §11 已确认决策 | 全部落在具体任务里（无一条只在文档里） |
| §12 交付与版本 | 任务 9 |

**2. 占位符扫描**：无「待定 / TODO / 后续实现」。任务 7 步骤 2 里两条时序用例
（代数、卸载）写的是「沿用既有那条用例的手法」——**这是刻意的**：那两条的完整断言就在被改的文件里
（`ExportPanel.test.ts:196-263` 的保存飞行中断言与 F6 用例），执行者照抄并换驱动方式即可，
本处不重复贴 60 行代码；对应的判据（代数 + `unmounted`）在步骤 4 的实现要点里逐条列出。

**3. 类型一致性**：`planSheet(pattern, palette, usages, projectName, options?)` 与
`planBoardPage(pattern, palette, usages, { boardSize, paper, index, projectName })` 在任务 3 内定义，
调用点（`sheetExport.ts` 两处、`ExportPanel` 两处、测试）在同一任务里全部改到；
`boardPageTile(..., projectName, ...)` 的新签名在任务 3 与任务 7 的调用处一致；
`LegendBandPlan` 在本计划里是 **+`fontPx` / −`countRightPad`**（任务 3 步骤 7 写明，任务 7 的渲染不受影响）；
`ResultPanel` 的 props/emits 在任务 4 定义，任务 4 的两个宿主与任务 8 的 `@rerun` 都用同一组名字。

**4. 顺序与中间态**：任务 1→2→3 互不依赖；任务 4 必须在 5 之前（编辑器要跳到新路由），
6 在 7 之前（查看层要能打开打印页）；**每个任务的最后一步都是 `npm run test` 全绿**——
跨任务的测试改动都排在「先删宿主、后改组件」这一侧（编辑页在任务 5 先不再渲染两个覆盖层，
打印页在任务 7 才改自己的 id，所以两处提交之间不会有别的文件被同一个 id 改名打到）。

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-10-10-c8-exits-viewer-and-layout.md`。两种执行方式：

**1. 子代理驱动（推荐）** —— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
必需子技能：`subagent-driven-development`（本仓 `开发约定详解.md` §开发流程 的「写任务简报 → 子代理实现 →
控制者复核每条承重声明 → 全新子代理做任务级审查 → 修复轮」就是它）。

**2. 内联执行** —— 在当前会话中用 `executing-plans` 批量执行并在检查点停下。

