<script setup lang="ts">
// src/views/SetupPage.vue
//
// `/new/setup`：**编辑 → 结果**两个阶段一个页面（C8 第 4 项把手机的三步分页取消：`crop` 与
// `params` 渲染出的是同一屏，两个取值没有区别，于是 `Stage` 收敛成 `"edit" | "result"`）。
// 断点**只决定布局**（平板左右分栏 / 手机单栏上下排），行为不分叉。
//
// 生成即落盘，重跑覆盖同一条记录：走 `useProjectSession().adopt()` + `save()`，
// 它是 B1 规格 §4.4 那个会话模型的第一个生产消费者。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { centerSquare, isCropResolvable, type AspectLock } from "@/core/crop/rect";
import type { ZoomLevel } from "@/core/crop/view";
import { rotatedSize } from "@/core/image/rotate";
import { computeGridSize } from "@/core/pattern/build";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
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

/** 结果阶段才换成结果卡片；其余时候**一页里同时有选区画布与参数**（手机也不再分页，C8 第 4 项）。 */
const showResult = computed(() => draft.stage === "result" && session.pattern !== null);
const showEditor = computed(() => draft.stage !== "result");

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

  if (draft.source === null) {
    await router.push({ name: "pick" });
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
        customMaxColors: draft.customMaxColors,
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
        customMaxColors: draft.customMaxColors,
        crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
        rotation: draft.rotation,
      },
      meta,
      { blob: source.blob, type: source.type },
      toProjectDocument(pattern, palette, {
        longSide: draft.longSide,
        maxColors: draft.maxColors,
        customMaxColors: draft.customMaxColors,
        crop: { x: crop.x, y: crop.y, w: crop.width, h: crop.height, rotate: draft.rotation },
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
  <main class="min-h-screen bg-slate-50 p-4 md:p-6">
    <header class="flex flex-wrap items-center gap-3">
      <!--
        返回箭头（C8 第 4 项替换掉原「回图纸库」整块按钮）。触控目标 ≥44px、`aria-label` 必给
        （箭头没有文字，读屏用户否则听到一个没有名字的按钮；主规格 §6.4）。
        分叉口径见 `goBack()`：编辑阶段按历史退，结果阶段恒回图纸库。
      -->
      <button
        data-testid="setup-back"
        aria-label="返回"
        class="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-slate-300 text-xl text-slate-700"
        @click="goBack"
      >
        ←
      </button>
      <h1 class="text-2xl font-bold text-slate-900">
        {{ draft.stage === "result" ? "生成结果" : "框出想拼的那块" }}
      </h1>
    </header>

    <p v-if="storeError" class="mt-4 rounded bg-red-50 p-4 text-lg text-red-700">
      工程存储不可用：{{ storeError }}
    </p>
    <p v-if="preparing" class="mt-4 text-lg text-slate-500">正在准备预览…</p>

    <div :class="isWide ? 'mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]' : 'mt-6 space-y-6'">
      <section v-if="showEditor" data-testid="crop-pane" class="rounded bg-white p-3 shadow">
        <div class="h-[55vh] min-h-64">
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
            class="min-h-12 rounded border px-4 text-base"
            :class="draft.aspect === option.value ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300'"
            @click="draft.setAspect(option.value)"
          >
            {{ option.label }}
          </button>
          <button data-testid="rotate" class="min-h-12 rounded border border-slate-300 px-4 text-base" @click="rotate">
            旋转 90°
          </button>
          <button
            v-for="level in ZOOM_OPTIONS"
            :key="String(level)"
            :data-testid="`zoom-${String(level)}`"
            class="min-h-12 rounded border px-4 text-base"
            :class="draft.zoom === level ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300'"
            @click="draft.setZoom(level)"
          >
            {{ level === "fit" ? "适配" : `${level}×` }}
          </button>
          <button data-testid="reset-crop" class="min-h-12 rounded border border-slate-300 px-4 text-base" @click="resetCrop">
            重置选区
          </button>
        </div>
      </section>

      <!--
        结果阶段：卡片本体是共用组件 `ResultPanel`（C8 规格 §3.4，与编辑来源的结果页同一份）。
        宿主只负责接线：图纸 / 色卡 / 文案分叉 / 重跑动作 / 跳转。
        `result-pane` 这个 testid 留在宿主的 `<section>` 上（组件根节点是单根 section，不抢这个 id）。
      -->
      <section v-if="showResult" data-testid="result-pane" class="rounded bg-white p-4 shadow">
        <ResultPanel
          v-if="session.pattern !== null"
          :pattern="session.pattern"
          :palette="palette"
          :is-new="resultIsNew"
          :can-rerun="true"
          :name="session.record?.meta.name ?? '图纸'"
          @rerun="draft.setStage('edit')"
          @edit="router.push({ name: 'editor', params: { id: session.record?.meta.id ?? '' } })"
          @ok="router.push({ name: 'home' })"
        />
      </section>

      <section v-if="showEditor" data-testid="param-pane" class="rounded bg-white p-4 shadow">
        <ParamPanel
          v-if="draft.crop !== null"
          :name="draft.name"
          :long-side="draft.longSide"
          :max-colors="draft.maxColors"
          :custom-max-colors="draft.customMaxColors"
          :palette-color-count="palette.colors.length"
          :crop="draft.crop"
          :rotation="draft.rotation"
          :palette-name="palette.name"
          :busy="draft.busy"
          :generate-blocked-reason="blockedReason"
          @update:name="draft.setName"
          @update:long-side="draft.setLongSide($event)"
          @update:max-colors="draft.setMaxColors($event)"
          @update:custom-max-colors="draft.setCustomMaxColors($event)"
          @generate="generate"
        />
      </section>
    </div>

    <p v-if="draft.error" data-testid="setup-error" class="mt-4 rounded bg-amber-50 p-4 text-lg text-amber-800">
      {{ draft.error }}
    </p>
    <button
      v-if="draft.error.includes('保存失败')"
      data-testid="retry-save"
      class="mt-3 min-h-12 rounded border border-slate-300 px-4 text-base"
      @click="retrySave"
    >
      重试保存
    </button>
  </main>
</template>
