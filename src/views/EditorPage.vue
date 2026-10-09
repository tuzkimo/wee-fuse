<script setup lang="ts">
// src/views/EditorPage.vue
//
// 编辑器宿主页：只做「接线」——载入、播种 store、把四个展示组件的 props/emits 接起来、
// 保存、未保存离开拦截、B1-8 重载、键盘撤销。**画与手势在 PatternCanvas，状态在 stores/editor.ts，
// 视图数学在 core/pattern/view.ts**；本文件里不许出现第二份坐标数学或第二个 dirty 标志。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  RouterLink,
  onBeforeRouteLeave,
  useRoute,
  useRouter,
  type RouteLocationRaw,
} from "vue-router";
import { fitTransform, type Size, type ViewTransform } from "@/core/crop/view";
import type { Rect } from "@/core/image/types";
import { patternStats, type ColorUsage } from "@/core/pattern/stats";
import type { Pattern } from "@/core/pattern/types";
import { zoomCellView, type CellPoint } from "@/core/pattern/view";
import ExportPanel from "@/components/editor/ExportPanel.vue";
import PalettePanel from "@/components/editor/PalettePanel.vue";
import PatternCanvas from "@/components/editor/PatternCanvas.vue";
import PatternToolbar from "@/components/editor/PatternToolbar.vue";
import SheetViewer from "@/components/sheet/SheetViewer.vue";
import { getBuiltinPalette } from "@/services/palette";
import { renderPatternThumbnail } from "@/services/patternThumbnail";
import { useDraft } from "@/stores/draft";
import { useEditor } from "@/stores/editor";
import { useProjectSession } from "@/stores/project";

/**
 * 编辑器（B3）。
 *
 * B1 只到「载入工程 + 显示只读参数」，B2 加了「改参数重新生成」入口；B3 补上真正的编辑：
 * 这个文件本身**没有**任何绘制或几何代码，它只是把 store 与四个 props 进 / 事件出的组件接起来。
 * 落盘一律走 `useProjectSession().save()`（本页不 import `indexedDB`）。
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
 * 两个覆盖层的打开状态：`panelMode` 是打印面板（`null` = 关着）、`sheetOpen` 是查看施工图。
 *
 * **C7 起「导出」按钮被删除**（人类伙伴 2026-10-09 裁定）：单张施工图原本有两个出口——打印面板的
 * sheet 模式与「查看施工图」，两者是同一张图。现在只剩「查看施工图」一个，打印面板只服务打印页。
 *
 * **页面只做接线**（R-4）：计划、清单、逐项状态、渲染与落盘都在两个组件里。页面给它们的四样东西是
 * 「内存态图纸 + 页面已有的 usages + 打开形态 + 失效通道 revision」——`usages` 直接复用**下面**那个
 * `usages` computed（它在 `stats` 之后派生；面板因此不必再走一遍 O(格数) 的 `patternStats`）。
 */
const panelMode = ref<"print" | null>(null);
/** 查看施工图（吃内存态图纸，**含未保存改动**；不读落盘记录里的图纸字段）。 */
const sheetOpen = ref(false);

/**
 * **已经载入**的 id。
 *
 * 必须是 state 而不是 `computed(() => route.params.id)`（那是**当前路由**的 id）：`watch` 回调
 * 跑起来时路由已经变成新 id 了，拿它去比较会恒等、于是永远提前 return——B1-8 会**原样复现**
 * （`/edit/a → /edit/b` 只变参数、不重载），而且不报任何错。
 */
const loadedId = ref("");

/**
 * 图纸统计。**`void editor.revision` 是承重的，删不得**：`cells` 是 `Uint16Array`，
 * `paint` / `applyRect` / `undo` / `redo` 都是**原地写入**，Vue 的响应式追踪看不到——
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

/** 框选：抬手才 emit，一条命令。 */
function onSelect(rect: Rect): void {
  editor.applyRect(rect);
}

/** 吸管：设当前色并切回画笔（切换在 store 里做，页面不重复一遍）。 */
function onPick(point: CellPoint): void {
  editor.pickFromCell(point.x, point.y);
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
  if (name === "save") void save();
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
 *   **内存态与 `session.dirty` 都不动**（主规格 §8），页面也不跳转。
 * - **封面非法会抛**（`session.save` 的编程错误守卫，生产不可达）→ **不吞**：吞成一条用户可见的
 *   错误条只会给出一个「重试保存」的按钮，而重试必然再抛一次——那是响亮失败被降级成死路。
 *
 * `finally` 只负责把 `saving` 放回去（抛错时也必须放回去，否则按钮永久禁用）。
 */
async function save(): Promise<void> {
  const pattern = session.pattern;
  if (pattern === null || editor.saving) return;
  editor.setSaving(true);
  editor.setError("");
  try {
    const thumbnail = thumbnailFor(pattern);
    const saved = await session.save({ thumbnail });
    if (!saved) editor.setError(session.error);
  } finally {
    editor.setSaving(false);
  }
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
  if (pendingRerun.value) seedRerunDraft();
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

/** 保存并离开：保存失败**不放行**（改动还在内存里，走了就丢）。 */
async function saveAndLeave(): Promise<void> {
  await save();
  if (editor.error !== "") return;
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
 * 把当前工程的原图与参数播种进向导草稿（B2 规格 §7）。**逻辑与 B1 / B2 逐字相同**
 * （B3 只是在**何时**调用它上加了确认这一步）。
 *
 * **只播种、不解码**：原图尺寸与预览位图在 `SetupPage` 挂载时统一解码——同一段解码逻辑出现在
 * 两处正是本项目最贵的缺陷形态（「两端各自正确、错在接线」）。所以这里刻意**不**调用
 * `adoptImage`（它要尺寸与预览画布），也不碰 `setSourceSize`。
 *
 * 三个入参各自的来源与取舍：
 * - `source.blob` / `type` 直接取自记录；记录里**没有**原始文件名（`ProjectSource` 只有这两个
 *   字段），`DraftSource.name` 只能填工程名。
 * - `params` 取自 `session.params`（`fromProjectDocument` 已经把落盘的 `crop.w/h/rotate` 映射成
 *   运行期的 `crop.width/height` + 独立 `rotation`，这里不许再映射一遍）。`crop` **拷一份**再传。
 * - `meta` 原样沿用 `id` / `name` / `createdAt`：重跑要覆盖同一条记录。
 */
function seedRerunDraft(): void {
  const record = session.record;
  const params = session.params;
  if (record === null || record.source === null || params === null) return;

  draft.adoptProject({
    source: { blob: record.source.blob, type: record.source.type, name: record.meta.name },
    params: {
      longSide: params.longSide,
      maxColors: params.maxColors,
      crop: {
        x: params.crop.x,
        y: params.crop.y,
        width: params.crop.width,
        height: params.crop.height,
      },
      rotation: params.rotation,
    },
    meta: { id: record.meta.id, name: record.meta.name, createdAt: record.meta.createdAt },
  });
}

/**
 * 「改参数重新生成」入口（B2 规格 §7 + B3 规格 §8.5 的接缝）。
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
  seedRerunDraft();
  void router.push({ name: "setup" });
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <p
      v-if="session.error"
      data-testid="editor-error"
      class="rounded bg-red-50 p-4 text-lg text-red-700"
    >
      {{ session.error }}
    </p>

    <template v-else-if="session.record">
      <!--
        回图纸库入口（F1：人工验证发现编辑页**没有任何回库入口**——Tauri 壳里没有浏览器工具栏，
        这个缺口更明显）。它是**普通的 `RouterLink`**：

        - 不用 `@click="router.push(...)"`：`RouterLink` 渲染成 `<a>`，平板与读屏都更好
          （主规格 §6.4）；
        - **不为它写任何新的拦截逻辑**——`onBeforeRouteLeave` 会把这次导航当成一次普通的离开，
          有未保存改动时自动弹**同一条**页面内确认条（下面那段 JSDoc 就是那条守卫）；
        - 触控目标 ≥44px（`min-h-11`）、字号 ≥16px（`text-base`，主规格 §6.4）。
      -->
      <div class="flex flex-wrap items-center gap-3">
        <RouterLink
          data-testid="back-to-library"
          to="/"
          class="inline-flex min-h-11 items-center rounded border border-slate-300 px-4 text-base text-slate-700"
        >
          ← 回图纸库
        </RouterLink>
        <h1 class="project-name text-3xl font-bold text-slate-900">{{ session.record.meta.name }}</h1>
      </div>
      <!-- 尺寸与用色数读**图纸**（规格 §8.3），不是 `meta` 的冗余字段 -->
      <p v-if="editor.pattern" data-testid="editor-size" class="mt-2 text-lg text-slate-600">
        {{ editor.pattern.width }} × {{ editor.pattern.height }} ·
        {{ stats?.colorCount ?? 0 }} 种颜色
      </p>

      <p v-if="session.record.source" data-testid="rerun-available" class="mt-4 text-lg text-slate-600">
        原图已保存，可以改参数重新生成。
      </p>
      <p v-else data-testid="rerun-unavailable" class="mt-4 text-lg text-amber-700">
        这个工程没有保存原图，只能继续编辑或重新导出，不能改参数重新生成。
      </p>

      <!--
        裁决 2：**不额外拦截、不做第二次确认**（重跑本身不问「是否编辑过」），只在入口旁固定如实
        说明；**有未保存改动时仍走同一条确认条**——`rerun()` 把「去 setup」当成一次待确认的离开
        交给 §8.4 的守卫，后者是「刚刚涂完没保存就被带走」那一支的兜底（规格 §8.5）。
      -->
      <p data-testid="rerun-warning" class="mt-2 text-base text-slate-500">
        重新生成会按原图重做整张图纸，手工涂改不会保留。
      </p>

      <button
        v-if="session.record.source"
        data-testid="rerun"
        class="mt-3 min-h-14 rounded bg-slate-900 px-6 text-lg text-white"
        @click="rerun"
      >
        改参数重新生成
      </button>

      <div v-if="editor.pattern" class="mt-6 flex flex-col gap-4 md:flex-row">
        <div class="h-[60vh] min-h-64 flex-1 rounded bg-white p-3 shadow">
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
            @measure="onMeasure"
            @update:view="onView"
            @paint="onPaint"
            @select="onSelect"
            @pick="onPick"
          />
        </div>

        <div class="space-y-4 md:w-80">
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
            :saving="editor.saving"
            :dirty="session.dirty"
            @update:tool="editor.setTool($event)"
            @undo="onCommand('undo')"
            @redo="onCommand('redo')"
            @update:show-grid="editor.setShowGrid($event)"
            @update:show-labels="editor.setShowLabels($event)"
            @fit="onCommand('fit')"
            @zoom-in="onCommand('zoom-in')"
            @zoom-out="onCommand('zoom-out')"
            @save="onCommand('save')"
            @view-sheet="sheetOpen = true"
            @print="panelMode = 'print'"
          />

          <PalettePanel
            :palette="palette"
            :usages="usages"
            :current-color="editor.currentColor"
            @update:current-color="editor.setCurrentColor($event)"
          />

          <!--
            「添加颜色」入口与 `PalettePicker` **都由 `PalettePanel` 自己渲染**（控制者裁决 R-3）：
            页面不再放第二个入口。原因有二——① 同一 testid 出现两次会让 `get` 命中靠前的那个、
            `findAll` 数量翻倍，用例的判据变得依赖 DOM 顺序；② 页面那份 `palette.colors.findIndex(…)`
            会是第 4 份「色号 → 全色卡下标」的同源实现，而规格 §9.2 明确要求这个映射只走
            `core/palette` 的权威实现（`createPaletteRuntime().indexByCode`），面板里已经有一份。
          -->
        </div>
      </div>
    </template>

    <!-- 未保存离开的确认条（页面内，不是浏览器 confirm）。
         **z-40 > 导出覆盖层的 z-30**（修复波 B-2）：面板打开时按返回，守卫照常拦下并把 `leaving`
         置真，但确认条若被压在全屏面板之下，用户看到的是「按了没反应」——什么都没发生、也没有出口。 -->
    <div
      v-if="leaving"
      data-testid="leave-bar"
      class="fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-center gap-3 border-t border-slate-300 bg-amber-50 p-4"
    >
      <p class="text-lg text-amber-900">有未保存的改动，确定要离开吗？</p>
      <button
        data-testid="leave-save"
        class="min-h-12 rounded bg-slate-900 px-4 text-base text-white"
        @click="saveAndLeave"
      >
        保存并离开
      </button>
      <button
        data-testid="leave-discard"
        class="min-h-12 rounded border border-slate-300 px-4 text-base"
        @click="discardAndLeave"
      >
        放弃改动
      </button>
      <button
        data-testid="leave-cancel"
        class="min-h-12 rounded border border-slate-300 px-4 text-base"
        @click="cancelLeave"
      >
        继续编辑
      </button>
    </div>

    <!-- 保存失败的琥珀条与重试（与 SetupPage 同形） -->
    <div
      v-if="editor.error"
      data-testid="save-error"
      class="mt-4 rounded bg-amber-50 p-4 text-lg text-amber-800"
    >
      保存失败：{{ editor.error }}
    </div>
    <button
      v-if="editor.error"
      data-testid="retry-save"
      class="mt-3 min-h-12 rounded border border-slate-300 px-4 text-base"
      @click="save"
    >
      重试保存
    </button>

    <!--
      打印面板（C7 起只剩打印页一种形态）。**图纸来源恒为 `editor.pattern`**（**内存态**，
      含未保存改动）——打印不触发保存、也不读落盘记录里的图纸字段。
      **唯一取自落盘记录的是工程名**（`:project-name`，只是文件名的前缀与图上标题）。

      `v-if` 必须**同时**要求 `editor.pattern` 存在（契约 §2b）：少了后半句，图纸还没载入时
      面板会在渲染期抛错（`:pattern` 拿到 null）。除此之外不新增别的门。
    -->
    <ExportPanel
      v-if="panelMode !== null && editor.pattern !== null"
      :pattern="editor.pattern"
      :palette="palette"
      :usages="usages"
      :project-name="session.record?.meta.name ?? '图纸'"
      :revision="editor.revision"
      @close="panelMode = null"
    />

    <!--
      查看施工图（C7 起是单张施工图的**唯一**出口，自带保存）。同样吃**内存态**图纸：
      编辑器里刚改的格子直接反映到图上，不需要先保存。
    -->
    <SheetViewer
      v-if="sheetOpen && editor.pattern !== null"
      :pattern="editor.pattern"
      :palette="palette"
      :name="session.record?.meta.name ?? '图纸'"
      @close="sheetOpen = false"
    />
  </main>
</template>
