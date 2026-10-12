<script setup lang="ts">
// src/views/SetupPage.vue
//
// `/new/setup`：**编辑 → 结果**两个阶段一个页面（C8 第 4 项把手机的三步分页取消：`crop` 与
// `params` 渲染出的是同一屏，两个取值没有区别，于是 `Stage` 收敛成 `"edit" | "result"`）。
// 断点**只决定布局**（平板三栏 / 手机单栏上下排），行为不分叉。
//
// **D1/§7.3 起两个阶段不再互斥**：生成之后左栏（裁剪）与右栏（参数）仍然可见可改，中栏
// （`preview-pane`）换成上一次的结果——这正是「一屏做完」的意思。中栏三态：未生成 = 放大裁剪
// 预览（复用 `draft.preview`，不新算）；已生成 = 结果卡片；生成后又改参数 = 一成不变。
//
// 生成即落盘，重跑覆盖同一条记录：走 `useProjectSession().adopt()` + `save()`，
// 它是 B1 规格 §4.4 那个会话模型的第一个生产消费者。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { centerSquare, isCropResolvable, type AspectLock } from "@/core/crop/rect";
import type { ZoomLevel } from "@/core/crop/view";
import { rotatedSize } from "@/core/image/rotate";
import { boardCount, beadsToCm, formatCm } from "@/core/pattern/board";
import { computeGridSize } from "@/core/pattern/build";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import BeadButton from "@/components/ui/BeadButton.vue";
import PixelIcon from "@/components/ui/PixelIcon.vue";
import CropCanvas from "@/components/crop/CropCanvas.vue";
import ParamPanel from "@/components/param/ParamPanel.vue";
import ResultPanel from "@/components/result/ResultPanel.vue";
import { createDomBitmapPlatform, createExactDecoder, createFastDecoder } from "@/services/decoders";
import { loadImageSource } from "@/services/imageSource";
import { getBuiltinPalette } from "@/services/palette";
import { renderPatternThumbnail } from "@/services/patternThumbnail";
import { generatePattern } from "@/services/pipeline";
import { getProjectStore, type ProjectMeta } from "@/services/projectStore";
import { useDraft } from "@/stores/draft";
import { useProjectSession } from "@/stores/project";
import { backOrHome } from "@/views/backOrHome";

const router = useRouter();
const draft = useDraft();
const session = useProjectSession();

const storeError = ref("");
const preparing = ref(false);
// 断点由 `md:` 前缀（列宽）与这个 JS 旗标（排法：平板横向三栏 / 手机单栏纵向）共同承担；
// 保留 JS 这一路是因为它已有两条用例钉着（视口跨断点时类名当场换、查询串就是 768px）。
const isWide = ref(false);
let media: MediaQueryList | null = null;

/** 工具条的选项常量：**不在模板里写 `as` 断言或 `as const`**，那在模板表达式里不可靠。 */
const ASPECT_OPTIONS: readonly { readonly value: AspectLock; readonly label: string }[] = [
  { value: "free", label: "自由" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "9:16", label: "9:16" },
];
const ZOOM_OPTIONS: readonly ZoomLevel[] = ["fit", 2, 4];

const palette = getBuiltinPalette();

/**
 * **本次生成是新建还是覆盖**（结果阶段的文案依据，规格 §6.2 的意图）。
 *
 * 取值就是「生成**之前**store 里有没有身份」：`true` = 这一次会新建一条（首次生成，或换图 /
 * 重置后的第一次），`false` = 这一次覆盖 `draft.rerunOf` 那条。必须在 `setRerunOf` 写回
 * **之前**取下来——写回之后身份恒为非 null，这个判断就再也分不出新建与覆盖。
 *
 * 身份本身**不在这里**：它是 `stores/draft.ts` 的 `rerunOf`（单一来源）。此前本页另有一个
 * 页面级 `savedTarget`，组件一销毁就丢，于是「生成 → 改参数 → 硬件返回键离开 → 从
 * 继续上次的选区回来 → 再生成」会新建出第二条同名记录（见 `setRerunOf` 的 JSDoc）。
 */
const resultIsNew = ref(true);

/**
 * 最近一次生成**是否没能落盘**（`session.save()` 返回 false）。
 *
 * 离开页面时的草稿处置由它决定，因为规格 §9 的「已生成 → 整份草稿作废」有一条**前提**：
 * 图纸已经在库里（重跑走编辑器的入口，草稿留着没有意义）。保存失败时图纸**不在**库里——
 * 此刻若照样作废草稿，用户看到的是「保存失败 + 重试保存」，一离开页面却**图纸与草稿双双消失**，
 * 没有任何出路。所以失败这一支只释放预览（`releasePreview()`），保留 `source` / 几何 / 参数，
 * 让 `/new` 的「继续上次的选区」还能用、用户可以重新生成并重试保存。
 *
 * **由页面判断、不改 `stores/draft.ts` 的 `onLeaveSetup()` 语义**：「这一次生成落盘了没有」
 * 只有发起保存的页面知道，store 里没有任何字段能表达它；给 `onLeaveSetup` 加一条入口就等于
 * 改规格 §9 那一行（那是跨页面的规则，改它要同步规格）。页面分两支则完全落在本页的职责内。
 *
 * 成功即回落 `false`（含 `retrySave()` 补上的那一次）：重试成功后图纸确实进库了，§9 的作废
 * 分支重新生效——否则「失败过又补存成功」的草稿会永远赖在 store 里。
 */
const lastSaveFailed = ref(false);

/**
 * 中栏是不是「上一次的结果」（§7.3）。**不再与编辑两栏互斥**：生成之后 `crop-pane` /
 * `param-pane` 照旧渲染，中栏从裁剪预览换成结果卡片。改完参数不自动重算（一成不变）；
 * 想再看一次走中栏的 `result-rerun`（把阶段切回 `edit`，与「重做」的既有语义一致）。
 */
const showResult = computed(() => draft.stage === "result" && session.pattern !== null);

/** 顶栏主按钮两态（§7.3）：未生成 = 「开始拼 ▶」；已生成 = 「完成 ✓」（现有 `result-ok` 那条路）。 */
const primaryLabel = computed(() => {
  if (showResult.value) return "完成 ✓";
  return draft.busy ? "正在拼…" : "开始拼 ▶";
});

function onPrimary(): void {
  if (showResult.value) {
    void router.push({ name: "home" });
    return;
  }
  void generate();
}

/**
 * 中栏的尺寸 chip（§7.3）：读**产物自身**（§6.3），厘米换算排在最后（那是给家长看的）。
 * 与 `ResultPanel` 的尺寸三行同一组 core 换算，不写第二份。
 */
const sizeChip = computed(() => {
  const pattern = session.pattern;
  if (pattern === null) return "";
  const boards = boardCount(pattern.width, pattern.height);
  return `${pattern.width} × ${pattern.height} · ${boards.total} 块板 · 约 ${formatCm(beadsToCm(pattern.width))} 厘米`;
});

/**
 * 未生成时中栏那份放大的裁剪预览。
 *
 * **复用左栏同一份 `draft.preview`，不新算**（§7.3）：只是把它再叠画到中栏这块画布上，
 * 没有解码、没有重采样。画布内尺寸取预览原尺寸，缩放交给 CSS（`max-*` 保持宽高比）。
 */
const previewCanvas = ref<HTMLCanvasElement | null>(null);

function drawPreview(): void {
  const element = previewCanvas.value;
  const source = draft.preview;
  if (element === null || source === null) return;
  element.width = source.width;
  element.height = source.height;
  const ctx = element.getContext("2d");
  if (ctx === null) return;
  // 像素风不重采样（§6.2）。
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0);
}

// 中栏画布是 `v-if` 建的：元素挂上 / 拆下、或预览换了一份，都要重画。
watch([previewCanvas, () => draft.preview], drawPreview, { flush: "post" });

/** 中栏深色底的板孔点阵（§7.3：`radial-gradient`，间距 22px）。 */
const boardDots = {
  backgroundImage: "radial-gradient(var(--color-bead-hole) 2px, transparent 2px)",
  backgroundSize: "22px 22px",
};

/**
 * 页头的返回箭头（C8 规格 §3.6.1，Ruling 21 的分叉口径）。
 *
 * **编辑阶段**走 `backOrHome`：有上一页就退回去（通常是从选图页进来的），历史为空才回图纸库。
 * **结果阶段恒回图纸库**：结果不是独立路由（它就是本页的 `stage === "result"`），
 * `back()` 会退到**上一页**——也就是选图页——而用户按的是「结束」而不是「再选一张图」。
 * 这与 `EditResultPage` 的返回箭头同一口径（它也不走 `backOrHome`）。
 */
function goBack(): void {
  if (draft.stage === "result") {
    void router.push({ name: "home" });
    return;
  }
  backOrHome(router);
}

/**
 * 生成前的豆数网格（也是「这张选区拼得出来吗」的判据）。
 *
 * **必须按选区的比例算，不是整图的比例**：`services/pipeline.ts` 的入参就是
 * `computeGridSize(rotatedSize(crop.width, crop.height, rotation), longSide)`。用整图尺寸算会让
 * 「选区 100×20 到底拼不拼得出来」这类判断与产物对不上（按整图会算出 58×44 而拦下一条真能拼的
 * 选区）——UI 说不行、流水线其实能生成，正是本项目点名的「两端各自正确、错在接线」。
 *
 * 走 `rotatedSize` 而不是 `orientedSizeOf`：后者要求**整数**尺寸，而 `crop.width/height` 可以是
 * 小数（拖动角手柄的结果，`resizeByHandle` 不做取整、`stores/draft.ts` 的 `setCrop` 也不取整），
 * 拿小数选区去调它会在渲染期直接抛错。`ParamPanel` 与流水线用的也是 `rotatedSize`，三处同口径。
 */
const grid = computed(() => {
  if (draft.sourceSize === null || draft.crop === null) return null;
  const oriented = rotatedSize(draft.crop.width, draft.crop.height, draft.rotation);
  return computeGridSize(oriented.width, oriented.height, draft.longSide);
});

/** 生成按钮的额外阻拦原因（空串 = 没有）。长边是否非法由面板自己判断。 */
const blockedReason = computed(() => {
  if (draft.sourceSize === null || draft.crop === null || grid.value === null) return "还没有选好图";
  if (!isCropResolvable(draft.crop, grid.value, draft.rotation)) {
    // 数字用**选区的**朝向尺寸（判据也是它），不是整图尺寸——提示里的两个数必须同源，
    // 否则用户按提示放大到「够大」了仍然被拦（提示指向了错的那个量）。
    const oriented = rotatedSize(draft.crop.width, draft.crop.height, draft.rotation);
    return `选区 ${Math.round(oriented.width)} × ${Math.round(oriented.height)} 像素要拼 ${grid.value.width} × ${grid.value.height} 颗豆，请放大选区或减小长边`;
  }
  if (storeError.value !== "") return storeError.value;
  return "";
});

function onMediaChange(event: MediaQueryListEvent): void {
  isWide.value = event.matches;
}

onMounted(async () => {
  // 存储未注入时不静默禁用：这一页唯一的写操作就是落盘，说清原因比让用户白跑一遍强。
  try {
    getProjectStore();
  } catch (e) {
    storeError.value = e instanceof Error ? e.message : String(e);
  }

  media = window.matchMedia("(min-width: 768px)");
  isWide.value = media.matches;
  media.addEventListener("change", onMediaChange);
  /*
   * 入口守卫：草稿被作废了（`/new/setup` 直接进来、或从编辑器的返回箭头退到一条**已经被
   * `onLeaveSetup()` 作废**的历史条目上）⇒ 这一页现在不成立，回选图页。
   *
   * **必须是 `replace`，不是 `push`**：守卫的语义是「这一页现在不成立」，它不该在历史里**新增**
   * 一条。`push` 留下的是一条重复的选图页条目——用户从选图页再按返回时退到的是这条重复条目
   * （看起来就是「按了没反应」），而正确的一页是**进流程之前**的那一页；实机上「返回键原地乒乓、
   * 每次多塞一条历史」正是被这个 `push` 放大的（判据见 `SetupPage.test.ts` 那条 replace 用例，
   * 与 `EditorBackNavFlow.test.ts` 的端到端用例）。
   */
  if (draft.source === null) {
    await router.replace({ name: "pick" });
    return;
  }

  // 重跑路径：草稿里有原图但预览要现解码（编辑器里不重复这段逻辑，见规格 §7）。
  if (draft.preview === null) {
    preparing.value = true;
    try {
      const loaded = await loadImageSource(
        new File([draft.source.blob], draft.source.name, { type: draft.source.type }),
      );
      draft.setSourceSize(loaded.sourceSize);
      draft.setPreview(loaded.preview);
    } catch (e) {
      draft.setError(e instanceof Error ? e.message : String(e));
    } finally {
      preparing.value = false;
    }
  }
});

onBeforeUnmount(() => {
  media?.removeEventListener("change", onMediaChange);
  media = null;
  // 规格 §9 的两条出口（见 `lastSaveFailed` 的 JSDoc）：已生成**且图纸确实进了库** → 整份草稿
  // 作废；中途退出，或这一次生成没能落盘 → 只释放预览，选区与参数留着。
  if (lastSaveFailed.value) {
    draft.releasePreview();
    return;
  }
  draft.onLeaveSetup();
});

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function generate(): Promise<void> {
  // 重入闸门：`disabled` 要等 Vue patch 完 DOM（微任务）才生效，同一 tick 内的第二次派发看到的
  // 按钮仍是可用的，没有这道闸门就会跑两遍流水线、`put` 两条记录（任务 10 的 `PickPage` 同一处置）。
  if (draft.busy) return;

  // **纵深防御**：`blockedReason`（选区太小 / 存储不可用）目前只挂在 `ParamPanel` 的 `disabled`
  // 上——那是 UI 层的一道闸门，将来出现第二个入口（快捷键、另一个按钮、从编辑器直接触发）就会
  // 绕过它，跑出一张「每格分不到一个源像素」的图纸。与「流水线自己拒绝越界 crop，即使 UI 已夹取」
  // 是同一模式：门槛必须有第二处承重。UI 已经说明了原因，这里**静默返回**即可，不再写一条错误。
  if (blockedReason.value !== "") return;

  const source = draft.source;
  const sourceSize = draft.sourceSize;
  const crop = draft.crop;
  if (source === null || sourceSize === null || crop === null) {
    draft.setError("还没有选好图");
    return;
  }

  draft.setError("");
  draft.setBusy(true);
  try {
    const platform = createDomBitmapPlatform();
    const pattern = await generatePattern(
      {
        source: source.blob,
        sourceSize,
        crop,
        rotation: draft.rotation,
        longSide: draft.longSide,
        maxColors: draft.maxColors,
        removeBackground: draft.removeBackground,
      },
      {
        exactDecoder: createExactDecoder(platform),
        fastDecoder: createFastDecoder(platform),
        palette,
      },
    );

    // 全透明 / 整图低于空格判定阈值 → 一个实心格都没有。进库只会在图纸库里留下一张点开
    // 什么都没有的工程，所以在写任何东西之前就响亮拒绝（B1 的既有处置，迁到这里）。
    if (!pattern.cells.some((value) => value !== EMPTY)) {
      draft.setError("这张图没有可拼的像素，换一张试试");
      return;
    }

    const thumbnail = renderPatternThumbnail(pattern, palette);
    const now = new Date().toISOString();
    // 身份**只有一个来源**：`draft.rerunOf`（编辑器重跑入口种下的，或上一次生成成功后写回的）。
    // **不**读 `session.record`：会话是全局的，`/edit/:id` 会把上一个工程留在里面；「进过编辑器 →
    // 回图纸库 → 新建 → 选图」这条路径上 `rerunOf` 是 null，而 `session.record` 仍是那个旧工程——
    // 按它取 id 会把新图纸写进旧工程的 id（名字沿用旧的、内容换成新的），是静默的数据损坏。
    const target = draft.rerunOf;
    // 新建 / 覆盖必须在写回之前判定（见 `resultIsNew`）。
    const isNew = target === null;
    const meta: ProjectMeta = {
      id: target?.id ?? createId(),
      // 名字**只有一个来源**：`draft.name`（C8 §3.7——`adoptImage` 从文件名种下、`adoptProject`
      // 从记录带进来、`ParamPanel` 的输入框当场改）。这里原先还有一条
      // `defaultProjectName(source.name)` 的 fallback，那正是「名字有两个来源」的形态：
      // 用户在生图页改了名字，落盘的却是文件名派生的那一个。
      name: draft.name,
      createdAt: target?.createdAt ?? now,
      updatedAt: now,
      thumbnail,
      // width / height / colorCount 由存储层从 doc 派生（put 会覆盖），这里刻意不自己算一份。
      width: 0,
      height: 0,
      colorCount: 0,
    };

    session.adopt(
      pattern,
      {
        longSide: draft.longSide,
        maxColors: draft.maxColors,
        crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
        rotation: draft.rotation,
        // 与下面 doc 里那一行同源：运行期参数与落盘参数必须说同一件事。
        removeBackground: draft.removeBackground,
      },
      meta,
      { blob: source.blob, type: source.type },
      toProjectDocument(pattern, palette, {
        longSide: draft.longSide,
        maxColors: draft.maxColors,
        crop: { x: crop.x, y: crop.y, w: crop.width, h: crop.height, rotate: draft.rotation },
        removeBackground: draft.removeBackground,
      }),
    );

    const saved = await session.save();
    resultIsNew.value = isNew;
    draft.markGenerated();
    if (saved) {
      // 生成**并保存成功**之后，把这条记录的身份写回 store——身份从此随草稿存活，不随组件销毁。
      // 这是「离开页面再回来仍然覆盖同一条」的承重一步（原先的页面级 `savedTarget` 就是在这里
      // 丢的）。保存失败这一支**不写回**：那条记录此刻并不在库里，写回会让结果文案与实际落盘
      // 不一致；失败后的续存由 `retrySave()` 成功时补写。
      draft.setRerunOf({ id: meta.id, createdAt: meta.createdAt });
      lastSaveFailed.value = false;
    } else {
      // 保存失败不丢态：图纸还在内存里，结果照常显示，给用户一条重试的路（主规格 §8）。
      // 同时记住「这次没进库」，离开页面时才不会按 §9 把草稿一起作废。
      lastSaveFailed.value = true;
      draft.setError(`图纸已生成，但保存失败：${session.error}`);
    }
  } catch (e) {
    draft.setError(e instanceof Error ? e.message : String(e));
  } finally {
    draft.setBusy(false);
  }
}

async function retrySave(): Promise<void> {
  if (await session.save()) {
    // 图纸这一步才真的进库：
    // ① 补上身份写回（`generate()` 的写回只在保存成功那一支发生）——否则「保存失败 → 重试成功 →
    //    改参数再生成」会分叉出第二条记录；
    // ② 把离开页面的出口交回 §9 的作废分支（见 `lastSaveFailed`）。
    const meta = session.record?.meta;
    if (meta !== undefined) {
      draft.setRerunOf({ id: meta.id, createdAt: meta.createdAt });
    }
    lastSaveFailed.value = false;
    draft.setError("");
  }
}

function rotate(): void {
  draft.setRotation(((draft.rotation + 1) % 4) as 0 | 1 | 2 | 3);
}

function resetCrop(): void {
  if (draft.sourceSize === null) return;
  draft.setAspect("free");
  // **用 `centerSquare`，不在这里重写一遍居中口径**：同一段「居中正方、边长取短边、奇偶不齐时
  // `Math.round`」的逻辑在 `core/crop/rect.ts` 里已被四条用例钉住（含 801×600 的奇偶情形），
  // 视图层再抄一份就是第二处会漂的副本（任务 4 修复轮 3 的审查发现）。
  draft.setCrop(centerSquare(draft.sourceSize));
}
</script>

<template>
  <!-- 手机上底部那颗 `fixed` 动作条会盖住内容：主体留出它的高度把最后一张卡片顶出来。 -->
  <main class="min-h-screen bg-bead-sand pb-20 md:pb-0">
    <!--
      顶栏（§6.4）：手机 64px / 平板 80px，`bead-sand-2` 底 + 4px `bead-line` 底边。
      主按钮两态（§7.3）：未生成「开始拼 ▶」（走现有生成）、已生成「完成 ✓」（走现有回家那条路）。
    -->
    <header class="flex h-16 items-center gap-4 border-b-4 border-bead-line bg-bead-sand-2 px-4 md:h-20 md:px-8">
      <!--
        返回箭头（图标按钮，与选图页同一口径）：触控目标 56×56（§6.5）、`aria-label` 必给
        （箭头没有文字，读屏用户否则听到一个没有名字的按钮）。分叉口径见 `goBack()`。
      -->
      <BeadButton data-testid="setup-back" variant="icon" aria-label="返回" @click="goBack">
        <PixelIcon name="back" :size="24" />
      </BeadButton>
      <h1 class="project-name flex-1 text-[24px] text-bead-ink md:text-[36px]">{{ draft.name }}</h1>
      <!--
        页头这颗只在平板上出现：手机上主按钮固定在底部安全区之上（下面那条动作条），
        同屏两颗同名主按钮会让用户分不清哪颗是收尾。
      -->
      <BeadButton
        data-testid="setup-primary"
        variant="primary"
        class="max-md:hidden"
        :disabled="!showResult && (draft.busy || blockedReason !== '')"
        @click="onPrimary"
      >
        {{ primaryLabel }}
      </BeadButton>
    </header>

    <p
      v-if="storeError"
      class="mx-4 mt-4 rounded-bead-sm border-4 border-bead-ink bg-bead-warn-bg p-4 text-[24px] text-bead-warn-ink md:mx-8"
    >
      工程存储不可用：{{ storeError }}
    </p>
    <p v-if="preparing" class="mx-4 mt-4 text-[24px] text-bead-ink md:mx-8">正在准备预览…</p>

    <!--
      三栏（§7.3）：左 = 选区（`crop-pane`）、中 = 上一次的结果（`preview-pane`）、右 = 参数
      （`param-pane`）。**阶段不再互斥**：生成之后左右两栏仍在，这是「一屏做完」。
      侧栏在 `md` 区间收窄、`lg` 才加宽：768~900px 三栏同屏时中栏不会被左右挤死（R30）。

      手机（<768px）单列，顺序 **中栏 → 选范围 → 参数**：`preview-pane` 因而排在 DOM 首位
      （单列下没有 `order`，DOM 顺序就是看到的顺序）；平板用 `md:order-*` 把它挪回中间。
      顺序不能倒——先裁剪后参数会让他调完参数还要往回滚才能看到结果。
    -->
    <div
      data-testid="setup-body"
      :class="isWide ? 'mt-6 flex gap-4 p-4' : 'mt-6 space-y-6 p-4'"
    >
      <!--
        中栏（§7.3）：未生成 = 放大的裁剪预览（复用 `draft.preview`，不新算）+ 一行提示；
        已生成 = 共用组件 `ResultPanel` + 尺寸 chip。背景是四处允许的深色看图底的其中一处。
        `preview-pane` 是本任务新加的容器 testid；`result-pane` 仍挂在宿主这个 `<section>` 上。
        手机吸顶且固定高 40vh，`md` 下两者都取消（平板上它是并排的中间一栏，不跟着页面滚）。
      -->
      <section
        data-testid="preview-pane"
        class="sticky top-0 h-[40vh] overflow-y-auto rounded-bead-md border-4 border-bead-ink bg-bead-board p-3 md:static md:order-2 md:h-auto md:overflow-visible md:min-h-[60vh] md:flex-1 md:min-w-0"
        :style="boardDots"
      >
        <template v-if="showResult">
          <section data-testid="result-pane" class="rounded-bead-md bg-bead-card p-4 md:p-6">
            <ResultPanel
              v-if="session.pattern !== null"
              :pattern="session.pattern"
              :palette="palette"
              :is-new="resultIsNew"
              :can-rerun="true"
              :name="session.record?.meta.name ?? '图纸'"
              :show-done="false"
              @rerun="draft.setStage('edit')"
              @edit="router.push({ name: 'editor', params: { id: session.record?.meta.id ?? '' } })"
              @ok="router.push({ name: 'home' })"
            />
          </section>
          <p
            v-if="sizeChip !== ''"
            data-testid="size-chip"
            class="mt-3 rounded-bead-sm border-3 border-bead-line-2 bg-bead-sand-3 px-4 py-2 text-[24px] text-bead-ink"
          >
            {{ sizeChip }}
          </p>
        </template>

        <div v-else class="flex h-full flex-col items-center justify-center gap-4">
          <canvas
            ref="previewCanvas"
            data-testid="preview-canvas"
            class="max-h-full max-w-full rounded-bead-sm md:max-h-[45vh]"
          ></canvas>
          <p v-if="draft.preview !== null" class="text-[24px] text-bead-sand-2">点开始拼看看</p>
        </div>
      </section>

      <section
        data-testid="crop-pane"
        class="rounded-bead-md border-4 border-bead-ink bg-bead-card p-3 md:order-first md:w-[200px] md:shrink-0 lg:w-[236px]"
      >
        <div class="h-[40vh] min-h-[240px] md:h-[46vh]">
          <CropCanvas
            v-if="draft.preview !== null && draft.crop !== null && draft.sourceSize !== null"
            :preview="draft.preview"
            :source-size="draft.sourceSize"
            :crop="draft.crop"
            :rotation="draft.rotation"
            :aspect="draft.aspect"
            :zoom="draft.zoom"
            :pan="draft.pan"
            @update:crop="draft.setCrop($event)"
            @update:pan="draft.setPan($event)"
          />
        </div>

        <div class="mt-3 flex flex-wrap gap-2">
          <button
            v-for="option in ASPECT_OPTIONS"
            :key="option.value"
            :data-testid="`aspect-${option.value}`"
            class="min-h-14 rounded-bead-sm border-4 border-bead-ink px-4 text-[24px]"
            :class="draft.aspect === option.value ? 'bg-bead-accent text-bead-card' : 'bg-bead-card text-bead-ink'"
            @click="draft.setAspect(option.value)"
          >
            {{ option.label }}
          </button>
          <button
            data-testid="rotate"
            class="min-h-14 rounded-bead-sm border-4 border-bead-ink bg-bead-card px-4 text-[24px] text-bead-ink"
            @click="rotate"
          >
            旋转 90°
          </button>
          <button
            v-for="level in ZOOM_OPTIONS"
            :key="String(level)"
            :data-testid="`zoom-${String(level)}`"
            class="min-h-14 rounded-bead-sm border-4 border-bead-ink px-4 text-[24px]"
            :class="draft.zoom === level ? 'bg-bead-accent text-bead-card' : 'bg-bead-card text-bead-ink'"
            @click="draft.setZoom(level)"
          >
            {{ level === "fit" ? "适配" : `${level}×` }}
          </button>
          <button
            data-testid="reset-crop"
            class="min-h-14 rounded-bead-sm border-4 border-bead-ink bg-bead-card px-4 text-[24px] text-bead-ink"
            @click="resetCrop"
          >
            重置选区
          </button>
        </div>
      </section>

      <section
        data-testid="param-pane"
        class="rounded-bead-md border-4 border-bead-ink bg-bead-card p-4 md:order-last md:w-[220px] md:shrink-0 lg:w-[262px]"
      >
        <ParamPanel
          v-if="draft.crop !== null"
          :name="draft.name"
          :long-side="draft.longSide"
          :max-colors="draft.maxColors"
          :palette-color-count="palette.colors.length"
          :remove-background="draft.removeBackground"
          :crop="draft.crop"
          :rotation="draft.rotation"
          :palette-name="palette.name"
          :busy="draft.busy"
          :generate-blocked-reason="blockedReason"
          @update:name="draft.setName"
          @update:long-side="draft.setLongSide($event)"
          @update:max-colors="draft.setMaxColors($event)"
          @update:remove-background="draft.setRemoveBackground"
          @generate="generate"
        />
      </section>
    </div>

    <!--
      手机底部动作条（§7.3）：`fixed` 之上是安全区。
      `env(safe-area-inset-bottom)` **只在 `viewport-fit=cover` 下才非零**（`index.html` 的 meta），
      所以它必须真的写成行内 `style`——写成类名不会被任何工具验证，写错了也看不出来（Review Focus 1）。
    -->
    <div
      data-testid="setup-action-bar"
      class="fixed inset-x-0 bottom-0 z-10 border-t-4 border-bead-ink bg-bead-sand-2 px-4 pt-3 md:hidden"
      :style="{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }"
    >
      <BeadButton
        data-testid="setup-action-primary"
        variant="primary"
        class="h-14 w-full"
        :disabled="!showResult && (draft.busy || blockedReason !== '')"
        @click="onPrimary"
      >
        {{ primaryLabel }}
      </BeadButton>
    </div>

    <p
      v-if="draft.error"
      data-testid="setup-error"
      class="mx-4 mt-4 rounded-bead-sm border-4 border-bead-ink bg-bead-warn-bg p-4 text-[24px] text-bead-warn-ink md:mx-8"
    >
      {{ draft.error }}
    </p>
    <BeadButton
      v-if="draft.error.includes('保存失败')"
      data-testid="retry-save"
      variant="secondary"
      class="ml-4 mt-3 md:ml-8"
      @click="retrySave"
    >
      重试保存
    </BeadButton>
  </main>
</template>
