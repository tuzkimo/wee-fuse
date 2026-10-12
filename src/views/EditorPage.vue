<script setup lang="ts">
// src/views/EditorPage.vue
//
// 编辑器宿主页：只做「接线」——载入、播种 store、把四个展示组件的 props/emits 接起来、
// 保存、未保存离开拦截、B1-8 重载、键盘撤销。**画与手势在 PatternCanvas，状态在 stores/editor.ts，
// 视图数学在 core/pattern/view.ts**；本文件里不许出现第二份坐标数学或第二个 dirty 标志。
// **填充同样只接线**：出口多了一条「点一下填充」，连通判定在 `core/pattern/background.ts`、
// 入账在 `editor.paintCells`，本页只把下标与容差搬过去。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter, type RouteLocationRaw } from "vue-router";
import { fitTransform, type Size, type ViewTransform } from "@/core/crop/view";
import { createPaletteRuntime } from "@/core/palette/registry";
import { BACKGROUND_TOLERANCE, patternBackgroundIndices } from "@/core/pattern/background";
import { patternStats, type ColorUsage } from "@/core/pattern/stats";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { zoomCellView, type CellPoint } from "@/core/pattern/view";
import BeadButton from "@/components/ui/BeadButton.vue";
import PixelIcon from "@/components/ui/PixelIcon.vue";
import PalettePanel from "@/components/editor/PalettePanel.vue";
import PatternCanvas from "@/components/editor/PatternCanvas.vue";
import PatternToolbar from "@/components/editor/PatternToolbar.vue";
import { useOverlayBack } from "@/composables/useOverlayBack";
import { getBuiltinPalette } from "@/services/palette";
import { renderPatternThumbnail } from "@/services/patternThumbnail";
import { seedRerunDraft } from "@/services/rerunDraft";
import { useDraft } from "@/stores/draft";
import { useEditor } from "@/stores/editor";
import { useProjectSession } from "@/stores/project";
import { backOrHome } from "@/views/backOrHome";

/**
 * 编辑器（B3）。
 *
 * B1 只到「载入工程 + 显示只读参数」，B2 加了「改参数重新生成」入口；B3 补上真正的编辑：
 * 这个文件本身**没有**任何绘制或几何代码，它只是把 store 与三个 props 进 / 事件出的组件
 * （画布 / 工具栏 / 调色板）接起来。落盘一律走 `useProjectSession().save()`（本页不 import `indexedDB`）。
 *
 * **C8 第 3 项起出口收敛**：查看施工图与打印这两块覆盖层不再由本页渲染（单张施工图的出口是
 * 「保存 → 修改成功结果页 → 查看」），本页因此也删掉了 `sheetOpen` / `panelMode` 两个 ref 与
 * **本地那份** `seedRerunDraft`（改成 import `@/services/rerunDraft` 的共用实现——本地那份当年
 * 漏传一个参数就静默产出「用色数与记录不一致」的图纸，见 `services/rerunDraft.ts` 的文件头）。
 *
 * **两条静默错误的防线**（写错都不报错）：
 * 1. 尺寸与用色数读**图纸**（`patternStats`），不读 `session.record.meta.*`——那三个字段是
 *    **上一次 `put` 时的**冗余值，编辑后立刻显示它就是显示一个假的数（规格 §8.3）。
 * 2. 统计与色板清单必须显式依赖 `editor.revision`（见 `stats` 的 JSDoc）。
 */
const route = useRoute();
const router = useRouter();
const draft = useDraft();
const session = useProjectSession();
const editor = useEditor();

/**
 * 顶栏保存按钮的文案。长任务期间唯一的进度反馈就是这行字（与 `ParamPanel` 的「正在生成…」
 * 同一口径）；`saving` 期间按钮同时 `disabled`，防并发保存。
 * `aria-label` 固定是「保存」（§7.4）：读屏用户不需要听到「正在保存…」，那是眼睛看的。
 */
const saveLabel = computed(() => (editor.saving ? "正在保存…" : "保存"));

/**
 * 调色板是**页面**取的（store 不持有 `Palette`，规格 §7 要点 1），以 props 进组件。
 *
 * **它必须是同一次取值的唯一一份**：`PalettePanel` 的 `currentColor` 越界守卫（任务 6）拿它当
 * 上界，而 `beginSession` 的色数也必须是**同一个数**。两处各自 `getBuiltinPalette()` 也能对，
 * 但那就多了一份可能漂移的真相——同源、同一处取值。
 */
const palette = getBuiltinPalette();

/** 最近一次量到的视口尺寸：适配按钮与 ± 缩放的锚点都用它（规格 §4.2 / §4.3）。 */
const viewport = ref<Size>({ width: 0, height: 0 });

/** 离开确认条是否可见。 */
const leaving = ref(false);
/** 被拦下的那次导航的目标；点「保存并离开」/「放弃改动」时重放它。 */
const pending = ref<RouteLocationRaw | null>(null);
/**
 * 待重放的目标来自「改参数重新生成」：重放前要先播种草稿。
 *
 * 草稿播种是**一次写操作**，所以它必须等用户确认离开之后才发生——点 rerun 时若先把草稿播种好
 * 再等确认，用户点「继续编辑」就会留下一个「回不去」的草稿身份（下一次生成会覆盖那条记录）。
 */
const pendingRerun = ref(false);
/**
 * **唯一的放行开关**：点过「保存并离开」或「放弃改动」后才置真，用来重放同一次导航。
 * 它不是为了绕过守卫，而是为了让守卫的判据是**显式**的——「已经处理过了」是一个状态，
 * 不能靠临时把 `session.dirty` 置假来表达（那会顺手改掉一个语义不同的状态位）。
 */
const allowLeave = ref(false);

/**
 * **已经载入**的 id。
 *
 * 必须是 state 而不是 `computed(() => route.params.id)`（那是**当前路由**的 id）：`watch` 回调
 * 跑起来时路由已经变成新 id 了，拿它去比较会恒等、于是永远提前 return——B1-8 会**原样复现**
 * （`/edit/a → /edit/b` 只变参数、不重载），而且不报任何错。
 */
const loadedId = ref("");

/**
 * 按色号批量换色的**选中集合**（全色卡下标，§5.6），页面自持。
 *
 * 它必须在这一层：面板与画布**都要读同一份**（面板算计数、画布高亮），而两者之间没有父子关系。
 * 它是**页面局部 UI 状态**：不进 store、不进历史、不落盘——「谁被选中」不是图纸的内容，
 * 换图纸或重新进页就该消失（规格 §5.6）。
 */
const selectedColors = ref<readonly number[]>([]);

/**
 * 图纸统计。**`void editor.revision` 是承重的，删不得**：`cells` 是 `Uint16Array`，
 * `paint` / `paintCells` / `undo` / `redo` 都是**原地写入**，Vue 的响应式追踪看不到——
 * `pattern` 又是 `markRaw`。刷新只有一条显式通道：`revision` 自增。
 *
 * `usages` **由它派生**，所以这一行是尺寸线与色板清单**共用**的失效通道：少了它，涂色之后
 * 两处都会**静默**停在上一次的样子（没有报错、没有白屏，只是数字和清单少一行）。
 * 一处依赖 + 一处派生（而不是两处各自扫一遍 `patternStats`）也顺带省掉一次 O(格数) 遍历。
 */
const stats = computed(() => {
  void editor.revision;
  const pattern = editor.pattern;
  return pattern === null ? null : patternStats(pattern, palette);
});

/** 已用色清单（面板的 props）。派生自 `stats`：同一份统计、同一条失效通道。 */
const usages = computed<readonly ColorUsage[]>(() => stats.value?.usages ?? []);

/**
 * 最近一次算出来的封面**以及它对应的图纸身份与 `revision`**。
 *
 * 保存失败后的「重试保存」沿用同一张封面（裁决 6）：同一份图纸、同一次编辑状态连着写两次却
 * 换上两张不同的封面，会让人以为「重试又改了东西」。反过来，图纸真的改过（`revision` 变了）或
 * 换了图纸（**对象身份**变了——`beginSession` 会把 `revision` 归零，只比 revision 会把上一张
 * 图纸的封面写到新图纸上）时必须重算，否则封面与内容不符。
 */
let thumbnailCache: { readonly pattern: Pattern; readonly revision: number; readonly dataUrl: string } | null =
  null;

/** 取（必要时重算）当前图纸的封面。 */
function thumbnailFor(pattern: Pattern): string {
  const cached = thumbnailCache;
  if (cached !== null && cached.pattern === pattern && cached.revision === editor.revision) {
    return cached.dataUrl;
  }
  const dataUrl = renderPatternThumbnail(pattern, palette);
  thumbnailCache = { pattern, revision: editor.revision, dataUrl };
  return dataUrl;
}

/**
 * 把记录里的图纸播种进编辑器。失败分支与 B1 一致：`load()` 失败会把原因写进 `session.error`、
 * 把会话清空，页面因此**不进编辑态**（没有图纸就没有画布，见模板）。
 */
async function activate(id: string): Promise<void> {
  // 先记下「这次载入的是谁」：重复触发时 `watch` 靠它挡掉无谓的第二次载入。
  loadedId.value = id;
  // 选中是**上一次会话的 UI 状态**：换图纸（含 `session.load` 失败后 `editor.reset()` 的两条
  // 提前 `return`）之后它必须清空。放在最顶上一行覆盖成功与两条失败三条路径（控制者裁决）。
  selectedColors.value = [];
  const loaded = await session.load(id);
  if (!loaded) {
    editor.reset();
    return;
  }
  const pattern = session.pattern;
  if (pattern === null) {
    // 载入成功却没有图纸：不可能走到（`load` 同时提交两者），但这里不猜——
    // 拿 null 去 `beginSession` 会抛在渲染路径上（白屏，比响亮失败更糟）。
    editor.reset();
    return;
  }
  editor.beginSession(pattern, palette.colors.length);
  // **换图纸后视图要按新尺寸重算**（B1-8）：容器尺寸没变，画布因此**不会**重新 measure
  // （它只在挂载与容器尺寸变化时量），只靠 `beginSession` 把视图复位成占位视图是不够的。
  // 这里用最近一次量到的视口重落一次默认缩放——`beginSession` 刚把 `viewInitialized` 置假，
  // 所以这一跳走的是 `defaultCellView`（首次载入时视口还是 0，跳过，等画布量完自己来）。
  if (viewport.value.width > 0) editor.onViewport(viewport.value);
}

/** 画布量到尺寸：视图落定**只在 store 里判**（首次落默认缩放，其后只夹取，规格 §4.2）。 */
function onMeasure(size: Size): void {
  viewport.value = size;
  editor.onViewport(size);
}

/** 画布改了视图（平移 / 捏合）→ 直接写回 store。 */
function onView(next: ViewTransform): void {
  editor.setView(next);
}

/** 单指涂抹：下标集合由画布算好（含补格），本页只转发。 */
function onPaint(indices: number[]): void {
  editor.paint(indices);
}

/**
 * 填充：点一下 → 求与它连通的目标区域 → 交给 store 入账。
 *
 * **容差随手里拿的东西变**（规格 §8）：拿橡皮时用 `BACKGROUND_TOLERANCE`（照片背景有渐变残留，
 * 容差能一次收干净，这正是原来的「去背景」）；拿颜色时用 `0`（精确同色）——孩子点一块色块期望的是
 * 「这一整块同色的都变」，容差会误伤旁边看起来相近但色号不同的区域。
 * 对擦除宽容、对涂色严格，因为吃过头是更坏的失败。
 */
function onFill(point: CellPoint): void {
  const pattern = editor.pattern;
  if (pattern === null) return;
  const color = editor.currentColor;
  // 判定在 core、入账在 store，本页只做两件事之间的搬运：色卡的 Lab 表用页面已经持有的
  // `palette` 生成（store 按设计不持有色卡），单次点击一条命令、一步可撤销。
  const indices = patternBackgroundIndices(
    pattern,
    createPaletteRuntime(palette).labs,
    point,
    color === EMPTY ? BACKGROUND_TOLERANCE : 0,
  );
  editor.paintCells(indices, color);
}

/**
 * 按色号批量换色（§6）：把面板发来的 `sources`（有效选中的全色卡下标）与目标色转交 store。
 *
 * **`sources` 用面板那份，页面不自己从 `selectedColors` 再算一遍**：面板交出的就是操作条
 * 计数用的那一份（§7 第 1 条——选中期间被涂光的色号不算数），另算一份的下场是「条上说改 1 个
 * 色号，实际改了别的格子」。`to` 可以是 `EMPTY`（批量擦除，由选择器的橡皮项给出）。
 *
 * 换完清空选中：改动已落地，留在选中态会让用户接着误改同一批格子。
 */
function onRecolor(sources: readonly number[], to: number): void {
  editor.recolor(sources, to);
  selectedColors.value = [];
}

/**
 * 适配 = `fitTransform` 的**既有导出**（规格 §4.2：不新增第三个函数），语义是**填满视口**。
 *
 * **它与默认视图的口径有意不同**：小图纸上「适配」会把格子放大到满屏（2×1 在 800×600 里是 400 px/格），
 * 而默认视图封在 `min(适配比例, MAX_CELL_PX)`（`defaultCellView`，规格 §5.2）。这不是缺陷——
 * 「适配」是用户主动按下的动作，要看的是整张图铺满；「默认视图」要的是不吓人。
 * 本函数**保持裸 `fitTransform`**（规格 §5.2 逐字要求），不要顺手改成 `defaultCellView`。
 */
function fitView(): void {
  const pattern = editor.pattern;
  if (pattern === null || viewport.value.width <= 0) return;
  editor.setView(fitTransform(viewport.value, { width: pattern.width, height: pattern.height }));
}

/**
 * ± 缩放比例（规格未定的实现常量，控制者裁决 6：1.25 是「按一次看得见变化、又不越过上界」的
 * 经验值）。锚点 = **视口中心**是规格 §4.3 已定的口径，不是自选。
 */
const ZOOM_STEP = 1.25;

/** ± 缩放：锚点取视口中心，夹取与锚点不变量的权威都在 `zoomCellView` 里（规格 §4.3）。 */
function zoomBy(factor: number): void {
  const pattern = editor.pattern;
  if (pattern === null || viewport.value.width <= 0) return;
  editor.setView(
    zoomCellView(
      editor.view,
      viewport.value,
      { width: pattern.width, height: pattern.height },
      editor.view.scale * factor,
      { x: viewport.value.width / 2, y: viewport.value.height / 2 },
    ),
  );
}

/** emit 总线：模板里的监听器都进这里，逻辑只有一份。 */
function onCommand(name: string): void {
  if (name === "save") void saveThenResult();
  else if (name === "undo") editor.undo();
  else if (name === "redo") editor.redo();
  else if (name === "fit") fitView();
  else if (name === "zoom-in") zoomBy(ZOOM_STEP);
  else if (name === "zoom-out") zoomBy(1 / ZOOM_STEP);
}

/**
 * 保存：**封面必须在这里重算**。存储层的 `put` 只从 doc 覆盖 `width` / `height` / `colorCount`，
 * 封面不在覆盖之列（规格 §8.2）——不重算，图纸库列表里的封面会永远停在首次生成那一刻的样子。
 *
 * 失败语义是**二分**的，页面对两种失败的处理也必须是二分（控制者裁决 5）：
 * - **存储失败**（`save()` 返回 false + 写 `session.error`）→ 显示琥珀条与「重试保存」，
 *   **内存态与 `session.dirty` 都不动**（主规格 §8），页面也**不跳转**：跳走会把改动丢在一个
 *   没有编辑入口的结果页上。
 * - **封面非法会抛**（`session.save` 的编程错误守卫，生产不可达）→ **不吞**：吞成一条用户可见的
 *   错误条只会给出一个「重试保存」的按钮，而重试必然再抛一次——那是响亮失败被降级成死路。
 *
 * 成功之后**跳「修改成功」结果页**（C8 规格 §3.3）：这是编辑页收敛后唯一的出口（查看施工图与打印
 * 两块覆盖层已从本页删除）。此刻 `session.dirty` 已为假，所以 `onBeforeRouteLeave` 不会拦这次导航。
 *
 * **跳转不写在 `save()` 里面**（本条与简报草稿的第 7.7 步不同，见任务 5 报告 §偏差 D1）：
 * `saveAndLeave()`（确认条的「保存并离开」）也调 `save()`，而它的语义是**去用户选定的那个目标**
 * （`pending`：去 setup 重做、或切到另一个 id）。跳转若写进 `save()`，那条路径会先跳结果页、再跳
 * 用户的目标——两次导航、历史里多一条无意义的 edit-result。所以 `save()` 只回答「存成功了没有」，
 * 「存成功之后去哪」由两个调用方各自决定。
 *
 * `finally` 只负责把 `saving` 放回去（抛错时也必须放回去，否则按钮永久禁用）——提前 `return`
 * 也会走到它。
 */
async function save(): Promise<boolean> {
  const pattern = session.pattern;
  if (pattern === null || editor.saving) return false;
  editor.setSaving(true);
  editor.setError("");
  try {
    const thumbnail = thumbnailFor(pattern);
    const saved = await session.save({ thumbnail });
    if (!saved) {
      editor.setError(session.error);
      return false;
    }
    return true;
  } finally {
    editor.setSaving(false);
  }
}

/**
 * 工具栏的「保存」与保存失败后的「重试保存」共用的这一条：存成功就跳「修改成功」结果页
 * （C8 规格 §3.3）。两个入口共用一份，是因为它们的语义完全相同——都是「用户按了保存」；
 * 失败时留在编辑器给重试（不跳转）。
 */
async function saveThenResult(): Promise<void> {
  if (!(await save())) return;
  void router.push({ name: "edit-result", params: { id: route.params.id } });
}

/**
 * 重放被拦下的那次导航；`allowLeave` 先置真，守卫才不会再拦一次。
 *
 * **被拦下的那次「换 id」导航可能已经提交**（见 `watch` 的 JSDoc）：同一条路由记录只变参数时
 * `onBeforeRouteLeave` 根本不会触发（它不是 `beforeRouteUpdate`），`route.params.id` 在 `watch`
 * 醒来时**已经是新 id** 了。所以重放一个与当前地址逐字相同的目标会被 vue-router 当成重复导航
 * 直接 resolve，`route.params.id` 不再变化、`watch` 也不再醒——**新图纸永远不会被载入**
 * （URL 是 b、画布还是 a，且没有任何迹象）。因此这里必须**自己**比对并载入新 id，不把责任留给
 * `watch`；`activate` 会先写 `loadedId`，所以哪怕 `watch` 真的又醒了也只会有这一次载入。
 */
async function replayPending(): Promise<void> {
  const target = pending.value;
  // 「改参数重新生成」被拦下的那一次：确认离开之后才播种草稿（见 `pendingRerun`）。
  if (pendingRerun.value) seedRerunDraft(draft, session);
  allowLeave.value = true;
  if (target !== null) await router.push(target);
  const nextId = typeof route.params.id === "string" ? route.params.id : "";
  if (nextId !== "" && nextId !== loadedId.value) await activate(nextId);
  // `await router.push(...)` 会走一次微任务，确认条此刻仍在 DOM 里是正常的——用例在 `flushPromises`
  // 之后才断言它消失。这里**不**为了「让 DOM 早点更新」而把这三行前移：`allowLeave` 必须在
  // `push` **之前**置真，否则重复放行的那一次导航会被守卫再拦回来（成环）。
  leaving.value = false;
  pending.value = null;
  pendingRerun.value = false;
  allowLeave.value = false;
}

/** 保存并离开：保存失败**不放行**（改动还在内存里，走了就丢）；成功则重放被拦下的那次导航。 */
async function saveAndLeave(): Promise<void> {
  if (!(await save())) return;
  await replayPending();
}

/** 放弃改动：不写盘，直接放行这次导航。丢弃的是内存里的改动，存储里那条记录原样留着。 */
async function discardAndLeave(): Promise<void> {
  await replayPending();
}

/** 继续编辑：只是收掉确认条。**不放行守卫**，下一次导航照样会被拦。 */
function cancelLeave(): void {
  pending.value = null;
  pendingRerun.value = false;
  leaving.value = false;
}

/**
 * 未保存确认条也是「临时界面」：Android 返回键先收掉它（= 继续编辑），而不是离开页面
 * （C8 规格 §3.6.2）。判据用 `leaving`——它由守卫与「重做」两条路径共同置真。
 *
 * **必须在 setup 的同步执行期调用**（`useOverlayBack` 内部用 `watch` 与 `onUnmounted`）；
 * 注册 / 注销跟着 `leaving` 走，所以「收掉之后条目要出栈」这件事由那个 composable 负责
 * （本页不持有第二份覆盖层状态）。
 */
useOverlayBack(
  () => {
    cancelLeave();
  },
  () => leaving.value,
);

onMounted(async () => {
  const id = route.params.id;
  // 路由参数可能是 `string[]`（重复参数）或 undefined，两种都不是合法 id：
  // 传空串让 `load` 走「找不到工程」那条响亮失败的路，而不是把数组塞进存储查询。
  await activate(typeof id === "string" ? id : "");
});

/**
 * B1-8：`/edit/a → /edit/b` 只变参数、不重挂组件，所以必须在这里重载。
 *
 * 有未保存改动时**不直接载入**：把这次「切到另一个 id」当成一次普通的离开，交给同一条确认条
 * （规格 §8.4 的表：id 变化与路由离开共用一条确认条）。`pending` 里存的是**编辑器自己的目标**。
 *
 * **这条 `watch` 不是「确认之后的载入者」**（早期注释在此写反了，正是切换工程不载入的源头）：
 * 同一条路由记录只变参数时 `onBeforeRouteLeave` **不会触发**，所以 `watch` 醒来时那次导航**已经提交**、
 * `route.params.id` 已经是新 id；它只负责拉起确认条并 `return`。用户确认之后由 `replayPending()`
 * **自己**载入新 id（那一次 `router.push` 的目标与当前地址逐字相同，vue-router 视为重复导航直接
 * resolve，`route.params.id` 不会再变——等 `watch` 再醒就是永远不载入）。
 */
watch(
  () => route.params.id,
  async (id) => {
    const next = typeof id === "string" ? id : "";
    if (next === "" || next === loadedId.value) return;
    if (session.dirty && !allowLeave.value) {
      pending.value = { name: "editor", params: { id: next } };
      pendingRerun.value = false;
      leaving.value = true;
      return;
    }
    await activate(next);
  },
);

/**
 * 未保存时取消本次导航，并弹出页面内的确认条（**不是浏览器 `confirm`**：主规格 §6.4 的
 * 儿童设计原则是「破坏性操作靠可撤销兜底」，而未保存的改动离开即丢、不可撤销，所以必须拦——
 * 但用一个看得懂、点得动的确认条）。
 *
 * 目标存进 `pending` 而不是让调用方各自处理：三个出口里有两个是「先处理再走同一条路」，
 * 存进一个 ref 是唯一不需要三份实现的做法。
 */
onBeforeRouteLeave((to) => {
  if (!session.dirty || allowLeave.value) return true;
  // `RouteLocationNormalized` 与 `RouteLocationRaw` 的差别只在 `name` 的可选性上（前者是
  // 「可能没有名字的已解析路由」，后者是「交给路由器去解析的地址」）；`push` 收下它完全合法，
  // 这里不为了让类型闭嘴而改写目标（改写会丢掉 params / query 里的语义）。
  pending.value = to as unknown as RouteLocationRaw;
  pendingRerun.value = false;
  leaving.value = true;
  return false;
});

/** 键盘撤销 / 重做（主规格 §6.5 的常用操作要有快捷键）。窗口监听，卸载时摘掉。 */
function onKeyDown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key !== "z" && event.key !== "Z") return;
  event.preventDefault();
  if (event.shiftKey) editor.redo();
  else editor.undo();
}

/**
 * **整页导航**（改地址栏 / 刷新 / 关标签页）**都走这条通道，但弹不弹由浏览器决定**（规格 §8.4）：
 * 实测 Chrome **刷新有提示、关标签页不弹**。
 *
 * **两条如实边界**（2026-10-04 人工实测，Chrome）：
 *
 * 1. 它**只**覆盖**整页导航**：刷新时 `preventDefault()` 会弹原生提示，而**关闭标签页时不会弹**
 *    （实测）——所以后一种情况下**未保存的改动会静默丢失**。这不是本页能补的（提示是否出现由浏览器
 *    决定），移动壳里也没有标签页：**退出 / 切后台**的生命周期处理留给引入 Tauri 壳的那一轮
 *    （规格 §8.4 的既有口径）。
 * 2. **SPA 内的路由离开不走这条路**（返回图纸库 / 去重跑 / 换 id）：页面不会被卸载，走的是
 *    `onBeforeRouteLeave` + 页面内确认条——那一条不依赖浏览器给不给面子。
 *
 * **`preventDefault()` 就是这条通道的全部**：现代浏览器不再读 `returnValue` 的文案，
 * 但它仍然要求处理器**显式**取消事件才弹框。干净时**什么都不做**（连 `returnValue` 都不设），
 * 否则每次关页都拦一下。
 */
function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!session.dirty) return;
  event.preventDefault();
}

onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("beforeunload", onBeforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("beforeunload", onBeforeUnload);
});

/**
 * 橡皮（C8 第 3 项：按钮从调色板搬进工具栏）。
 * **顺带切回画笔**：在填充工具下只把色槽设成 `EMPTY` 的话，用户点完看不出任何变化
 * （工具还停在填充）。
 */
function onEraser(): void {
  editor.setCurrentColor(EMPTY);
  editor.setTool("brush");
}

/**
 * 「重做」入口（B2 规格 §7 + B3 规格 §8.5 的接缝；C8 第 3 项从页面中部搬进工具条，
 * 任务 12 起在左组、与撤销/恢复同族）。
 *
 * **草稿播种走共用实现**（`@/services/rerunDraft` 的 `seedRerunDraft`）：本页原来有一份**本地**
 * 副本，它漏传了一个参数 ⇒ 从编辑器点「重做」跑一条记录时，草稿里的用色数还是残留值
 * ⇒ **静默产出用色数与记录不一致的图纸**（2026-10-10 的口径简化把用色数并成了一个数字，
 * 那类「漏传第二个字段」的缺陷面随之消失，但「播种走同一份实现」这条纪律不变）。
 * 现在它与编辑来源结果页的「重做」是**同一份**实现（两处各写一遍就是「同一件事的第二份实现」）。
 * 那条实现同时负责「只播种、不解码」：原图尺寸与预览位图统一在 `SetupPage` 解码（同一段解码逻辑
 * 出现在两处正是本项目最贵的缺陷形态）。
 *
 * 有未保存改动时**不播种、也不跳转**：把 `{ name: "setup" }` 当成一次待确认的离开交给同一条
 * 确认条。**不能**先播种再让守卫去拦——播种是一次写操作，用户点「继续编辑」之后那个草稿身份
 * 会留在 store 里（下一次生成会覆盖这条记录），而页面上看不出任何异常。
 *
 * 与守卫同源（`session.dirty` + `allowLeave`），不新增第二个 dirty 标志。
 */
function rerun(): void {
  const record = session.record;
  if (record === null || record.source === null || session.params === null) return;
  if (session.dirty && !allowLeave.value) {
    pending.value = { name: "setup" };
    pendingRerun.value = true;
    leaving.value = true;
    return;
  }
  if (!seedRerunDraft(draft, session)) return;
  void router.push({ name: "setup" });
}
</script>

<template>
  <main class="min-h-screen bg-bead-sand">
    <p
      v-if="session.error"
      data-testid="editor-error"
      class="mx-4 mt-4 rounded-bead-sm border-4 border-bead-ink bg-bead-warn-bg p-4 text-[24px] text-bead-warn-ink md:mx-8"
    >
      {{ session.error }}
    </p>

    <template v-else-if="session.record">
      <!--
        顶栏（§6.4 / §7.4）：手机 64px / 平板 80px，`bead-sand-2` 底 + 4px `bead-line` 底边。
        手机**不显示作品名**（他不认字，作品名是给家长的），平板显示并截断（`.project-name`）：
        实现是**同一个 h1** 加 `hidden md:block`，不是渲染两份（R3 不允许同名节点复制）。
        保存按钮（`go` 变体，主操作）与它右上角的未保存圆点都在这里（C8 第 3 项起从工具条搬来）。
      -->
      <header
        class="flex h-16 items-center justify-between gap-4 border-b-4 border-bead-line bg-bead-sand-2 px-4 md:h-20 md:px-8"
      >
        <!--
          返回箭头（C8 第 3 项替换掉原「回图纸库」整块 `RouterLink`）。

          - 为什么不是 `RouterLink`：规格 §3.6.1 要的是「有上一页就退回去、历史为空才回图纸库」——
            那是一次**判断**，声明式目标做不到（F1 那版只会回图纸库）。
          - 判据本体只有一份，在 `views/backOrHome.ts`（**不在这里再写一份**）：上一页若是一条已经作废的
            生图流程页（`/new` 前缀），退回去会被 `SetupPage` 的入口守卫弹到选图页，而选图页没有返回入口
            ⇒ 实机上是「按返回却回选图页」——所以那一支改回图纸库。Android 硬件返回键走的是**同一个**
            `backOrHome`（`useShellLifecycle` 的 `canGoBack` 分支），两个入口共用一份口径、不各写一份。
          - `backOrHome` 内部走 `router.push` / `router.back`，所以离场守卫**照常生效**：有未保存
            改动时会被同一条页面内确认条拦下（`onBeforeRouteLeave` 那段就是那条守卫）——
            「改回首页」这一支与 `back()` 一样**不绕过**它（`EditorPageRouterLink.test.ts` 钉这一跳）。
          - 触控目标 ≥56px（`min-h-14 min-w-14`，规格 §6.5 的硬下界；44px 是 Material 口径，
            规格逐字否掉了它）、`aria-label` 必给（箭头没有文字，读屏用户否则
            听到一个没有名字的按钮；主规格 §6.4）。
        -->
        <button
          data-testid="editor-back"
          aria-label="返回"
          class="inline-flex min-h-14 min-w-14 items-center justify-center rounded-bead-sm border-4 border-bead-ink bg-bead-card text-[24px] text-bead-ink shadow-pop-sm active:translate-y-1 active:shadow-none"
          @click="backOrHome(router)"
        >
          ←
        </button>
        <!--
          隐藏写在**宿主** div 上，不是写在 h1 上：`.project-name` 是 `style.css` 末尾的
          **无层级**全局类（`display:-webkit-box`），按 CSS 层叠规则它压过 `@layer utilities` 里的
          `hidden` / `md:block`——直接写在 h1 上在真浏览器里根本不生效（jsdom 不解析布局，测不出来）。
        -->
        <div class="hidden min-w-0 flex-1 md:block">
          <h1 class="project-name text-[24px] text-bead-ink md:text-[36px]">
            {{ session.record.meta.name }}
          </h1>
        </div>
        <!-- 保存按钮的锚点：圆点要浮在它的右上角，所以两者共用一个定位祖先。 -->
        <div class="relative">
          <BeadButton
            data-testid="editor-save"
            variant="go"
            aria-label="保存"
            :disabled="editor.saving"
            @click="onCommand('save')"
          >
            <PixelIcon name="save" :size="24" />
            <span>{{ saveLabel }}</span>
          </BeadButton>
          <!-- 未保存指示：干净时不渲染；内容从「未保存」三个字换成一颗 `bead-danger` 圆点（§7.4）。 -->
          <span
            v-if="session.dirty"
            data-testid="editor-dirty"
            aria-hidden="true"
            class="absolute -right-1 -top-1 size-[22px] rounded-bead-pill border-4 border-bead-ink bg-bead-danger"
          />
        </div>
      </header>
      <!-- 尺寸与用色数读**图纸**（规格 §8.3），不是 `meta` 的冗余字段 -->
      <p
        v-if="editor.pattern"
        data-testid="editor-size"
        class="mx-4 mt-2 text-[24px] text-bead-ink md:mx-8"
      >
        {{ editor.pattern.width }} × {{ editor.pattern.height }} ·
        {{ stats?.colorCount ?? 0 }} 种颜色
      </p>

      <!--
        C8 第 3 项：原来这里有三段提示（「原图已保存，可以改参数重新生成」/「这个工程没有保存原图…」/
        「重新生成会按原图重做整张图纸，手工涂改不会保留。」）与一颗页面中部的大按钮。它们全部删除：
        「重做」搬进工具条左组（没有原图时**不渲染**，所以「提示的对象」不存在了），
        「会重做整张图纸」这层意思由「重做」这个名字与它旁边那颗 `undo` 图标承担。
      -->

      <div v-if="editor.pattern" class="mx-4 mt-6 flex flex-col gap-4 md:mx-8 md:flex-row">
        <div class="h-[60vh] min-h-64 flex-1 rounded-bead-md border-4 border-bead-ink bg-bead-card p-3 shadow-pop-sm">
          <PatternCanvas
            :pattern="editor.pattern"
            :palette="palette"
            :view="editor.view"
            :revision="editor.revision"
            :last-dirty="editor.lastDirty"
            :tool="editor.tool"
            :current-color="editor.currentColor"
            :show-grid="editor.showGrid"
            :show-labels="editor.showLabels"
            :selected="selectedColors"
            @measure="onMeasure"
            @update:view="onView"
            @paint="onPaint"
            @fill="onFill"
          />
        </div>

        <div class="space-y-4 md:w-80">
          <PalettePanel
            :palette="palette"
            :usages="usages"
            :current-color="editor.currentColor"
            :selected="selectedColors"
            @update:current-color="editor.setCurrentColor($event)"
            @update:selected="selectedColors = $event"
            @recolor="onRecolor"
          />

          <!--
            选择器（`PalettePicker`）**由 `PalettePanel` 自己渲染**（控制者裁决 R-3）：页面不放第二个
            入口。原因有二——① 同一 testid 出现两次会让 `get` 命中靠前的那个、`findAll` 数量翻倍，
            用例的判据变得依赖 DOM 顺序；② 页面那份 `palette.colors.findIndex(…)` 会是第 4 份
            「色号 → 全色卡下标」的同源实现，而规格 §9.2 明确要求这个映射只走 `core/palette` 的权威
            实现（`createPaletteRuntime().indexByCode`），面板里已经有一份。
            **C8 第 3 项**：原来的「添加颜色」入口已从面板删除，现在点**当前色槽**开合它。
          -->
        </div>
      </div>

      <!--
        工具条（§7.4）：排在画布与色板**之后**，所以它在这一层、不在右栏里。两条理由：
        ① 顺序：DOM 顺序就是手机上的可见顺序——「画布 → 底部色豆条 → 工具条」，塞在右栏里
           手机上会变成「画布 → 工具条 → 色豆条」；
        ② 宽度：平板要十一颗**一条**排完（约 700px），塞进 320px 的右栏里必然折成三行。
      -->
      <div v-if="editor.pattern" class="mx-4 mb-6 mt-4 md:mx-8">
        <!--
          撤销 / 重做状态读 `editor.canUndo` / `editor.canRedo` 这两个 computed，
          **不许**读 `editor.history.canUndo`：`history` 是 `markRaw` 的类实例，读它的 getter
          不建立响应式依赖，按钮会永久停在初始状态（控制者裁决 9）。
        -->
        <PatternToolbar
          :can-undo="editor.canUndo"
          :can-redo="editor.canRedo"
          :tool="editor.tool"
          :show-grid="editor.showGrid"
          :show-labels="editor.showLabels"
          :can-rerun="session.record?.source != null"
          :eraser-active="editor.currentColor === EMPTY"
          @update:tool="editor.setTool($event)"
          @undo="onCommand('undo')"
          @redo="onCommand('redo')"
          @update:show-grid="editor.setShowGrid($event)"
          @update:show-labels="editor.setShowLabels($event)"
          @fit="onCommand('fit')"
          @zoom-in="onCommand('zoom-in')"
          @zoom-out="onCommand('zoom-out')"
          @rerun="rerun"
          @eraser="onEraser"
        />
      </div>
    </template>

    <!--
      未保存离开的确认条（页面内，不是浏览器 confirm）。`z-40` 让它盖住整页内容；C8 第 3 项之后
      本页不再渲染任何全屏覆盖层（查看层与打印面板已删除），所以这条 z 序不再与谁比较——保留
      `z-40` 是为了「它必须浮在最上面」这条不变量本身。
      它同时是覆盖层返回栈上的一项（见 `cancelLeave` 下面那次 `useOverlayBack`）：Android 返回键
      先收掉它，而不是离开页面。 -->
    <div
      v-if="leaving"
      data-testid="leave-bar"
      class="fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-center gap-3 border-t-4 border-bead-line bg-bead-warn-bg p-4"
    >
      <p class="text-[24px] text-bead-warn-ink">有未保存的改动，确定要离开吗？</p>
      <button
        data-testid="leave-save"
        class="min-h-12 rounded-bead-sm bg-bead-ink px-4 text-[24px] text-bead-card"
        @click="saveAndLeave"
      >
        保存并离开
      </button>
      <button
        data-testid="leave-discard"
        class="min-h-12 rounded-bead-sm border-4 border-bead-ink bg-bead-card px-4 text-[24px] text-bead-ink"
        @click="discardAndLeave"
      >
        放弃改动
      </button>
      <button
        data-testid="leave-cancel"
        class="min-h-12 rounded-bead-sm border-4 border-bead-ink bg-bead-card px-4 text-[24px] text-bead-ink"
        @click="cancelLeave"
      >
        继续编辑
      </button>
    </div>

    <!-- 保存失败的琥珀条与重试（与 SetupPage 同形） -->
    <div
      v-if="editor.error"
      data-testid="save-error"
      class="mx-4 mt-4 rounded-bead-sm border-4 border-bead-ink bg-bead-warn-bg p-4 text-[24px] text-bead-warn-ink md:mx-8"
    >
      保存失败：{{ editor.error }}
    </div>
    <button
      v-if="editor.error"
      data-testid="retry-save"
      class="ml-4 mt-3 min-h-12 rounded-bead-sm border-4 border-bead-ink bg-bead-card px-4 text-[24px] text-bead-ink md:ml-8"
      @click="saveThenResult"
    >
      重试保存
    </button>
  </main>
</template>
