<script setup lang="ts">
// src/views/SetupPage.vue
//
// `/new/setup`：选区 → 参数 → 结果，三个阶段一个页面。断点**只决定布局**（平板左右分栏 /
// 手机单栏分步），行为不分叉——这是设计评审时选定的路线 2（规格 §4.5）。
//
// 生成即落盘，重跑覆盖同一条记录：走 `useProjectSession().adopt()` + `save()`，
// 它是 B1 规格 §4.4 那个会话模型的第一个生产消费者。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { centerSquare, isCropResolvable, type AspectLock } from "@/core/crop/rect";
import type { ZoomLevel } from "@/core/crop/view";
import { rotatedSize } from "@/core/image/rotate";
import { computeGridSize } from "@/core/pattern/build";
import { patternStats } from "@/core/pattern/stats";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import CropCanvas from "@/components/crop/CropCanvas.vue";
import ParamPanel from "@/components/param/ParamPanel.vue";
import { createDomBitmapPlatform, createExactDecoder, createFastDecoder } from "@/services/decoders";
import { loadImageSource } from "@/services/imageSource";
import { getBuiltinPalette } from "@/services/palette";
import { RESULT_PREVIEW_MAX_EDGE, renderPatternThumbnail } from "@/services/patternThumbnail";
import { generatePattern } from "@/services/pipeline";
import { defaultProjectName, getProjectStore, type ProjectMeta } from "@/services/projectStore";
import { useDraft, type RerunTarget } from "@/stores/draft";
import { useProjectSession } from "@/stores/project";

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
 * **本页已经落盘的那条记录的身份**（`id` / 名称 / `createdAt`）。
 *
 * 第二次点「生成」就是就地重跑：覆盖同一条记录，而不是在图纸库里再堆一条几乎一样的。
 * 身份的来源有两处，优先级见 `generate()` 里的 `draft.rerunOf ?? savedTarget.value`：
 *
 * 1. `draft.rerunOf`——用户是从**编辑器**那条记录进来重跑的（任务 12 的入口），它更权威；
 * 2. 本页自己生成过的那条（本 ref）。
 *
 * **为什么不直接读 `session.record`**：会话是全局的，`/edit/:id` 会把**上一个工程**留在里面。
 * 用户「进过编辑器 → 回图纸库 → 新建 → 选图」这条路径上 `draft.rerunOf` 是 null，而
 * `session.record` 仍是那个旧工程——按它取 id 会把新图纸**写进旧工程的 id**（名字沿用旧的、
 * 内容换成新的），是静默的数据损坏。本 ref 只可能装着「与当前草稿同源的这一次生成」，没有这个
 * 风险；离开本页时随组件一起消失，也不需要 store 提供额外的清空入口。
 */
const savedTarget = ref<RerunTarget | null>(null);

/** 三个阶段各自的可见性：平板两栏常驻（结果阶段左栏换成结果、**右栏参数仍在**，可直接重跑），
 *  手机一次只显示一屏。 */
const showCanvas = computed(() => draft.stage === "crop" && draft.preview !== null);
const showParams = computed(() => (isWide.value ? true : draft.stage === "params"));
const showResult = computed(() => draft.stage === "result" && session.pattern !== null);

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

const resultImage = computed(() =>
  session.pattern === null ? "" : renderPatternThumbnail(session.pattern, palette, RESULT_PREVIEW_MAX_EDGE),
);

const resultStats = computed(() =>
  session.pattern === null ? null : patternStats(session.pattern, palette),
);

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
  // 规格 §9：已生成且此后无改动 → 整份草稿作废；中途退出 → 只释放预览，选区与参数留着。
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
    // 编辑器进来的重跑目标优先（用户是冲着那条记录来的），其次才是本页已经生成过的那条。
    const target = draft.rerunOf ?? savedTarget.value;
    const meta: ProjectMeta = {
      id: target?.id ?? createId(),
      name: target?.name ?? defaultProjectName(source.name),
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
      },
      meta,
      { blob: source.blob, type: source.type },
      toProjectDocument(pattern, palette, {
        longSide: draft.longSide,
        maxColors: draft.maxColors,
        crop: { x: crop.x, y: crop.y, w: crop.width, h: crop.height, rotate: draft.rotation },
      }),
    );
    // 采纳即记住身份（**早于** `save()`）：保存失败后的下一次生成仍然落在同一条记录上，
    // 不会因为一次失败就分叉出第二条。
    savedTarget.value = { id: meta.id, name: meta.name, createdAt: meta.createdAt };

    const saved = await session.save();
    draft.markGenerated();
    if (!saved) {
      // 保存失败不丢态：图纸还在内存里，结果照常显示，给用户一条重试的路（主规格 §8）。
      draft.setError(`图纸已生成，但保存失败：${session.error}`);
    }
  } catch (e) {
    draft.setError(e instanceof Error ? e.message : String(e));
  } finally {
    draft.setBusy(false);
  }
}

async function retrySave(): Promise<void> {
  if (await session.save()) draft.setError("");
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
    <header class="flex flex-wrap items-center justify-between gap-4">
      <h1 class="text-2xl font-bold text-slate-900">
        {{ draft.stage === "result" ? "生成结果" : "框出想拼的那块" }}
      </h1>
      <button class="min-h-12 rounded border border-slate-300 px-4 text-base" @click="router.push({ name: 'home' })">
        回图纸库
      </button>
    </header>

    <p v-if="storeError" class="mt-4 rounded bg-red-50 p-4 text-lg text-red-700">
      工程存储不可用：{{ storeError }}
    </p>
    <p v-if="preparing" class="mt-4 text-lg text-slate-500">正在准备预览…</p>

    <div :class="isWide ? 'mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]' : 'mt-6 space-y-6'">
      <section v-if="showCanvas" data-testid="crop-pane" class="rounded bg-white p-3 shadow">
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

      <section v-if="showResult" data-testid="result-pane" class="rounded bg-white p-4 shadow">
        <img v-if="resultImage" data-testid="result-preview" :src="resultImage" alt="" class="w-full rounded bg-slate-100" />
        <p class="mt-3 text-lg font-semibold text-slate-900">已更新这张图纸</p>
        <p v-if="resultStats" data-testid="result-stats" class="mt-1 text-base text-slate-600">
          实际用了 {{ resultStats.colorCount }} 种颜色，共 {{ resultStats.total }} 颗豆
        </p>
        <div class="mt-4 flex flex-wrap gap-3">
          <button
            v-if="!isWide"
            data-testid="back-to-params"
            class="min-h-12 rounded border border-slate-300 px-4 text-base"
            @click="draft.setStage('params')"
          >
            改参数
          </button>
          <button
            data-testid="open-editor"
            class="min-h-12 rounded bg-slate-900 px-4 text-base text-white"
            @click="router.push({ name: 'editor', params: { id: session.record?.meta.id ?? '' } })"
          >
            去编辑
          </button>
        </div>
      </section>

      <section v-if="showParams" data-testid="param-pane" class="rounded bg-white p-4 shadow">
        <ParamPanel
          v-if="draft.crop !== null"
          :long-side="draft.longSide"
          :max-colors="draft.maxColors"
          :crop="draft.crop"
          :rotation="draft.rotation"
          :palette-name="palette.name"
          :palette-accuracy="palette.accuracy"
          :busy="draft.busy"
          :generate-blocked-reason="blockedReason"
          @update:long-side="draft.setLongSide($event)"
          @update:max-colors="draft.setMaxColors($event)"
          @generate="generate"
        />
      </section>
    </div>

    <div v-if="!isWide" class="mt-6 flex gap-3">
      <button
        v-if="draft.stage === 'crop'"
        data-testid="to-params"
        class="min-h-14 flex-1 rounded bg-slate-900 text-lg text-white"
        @click="draft.setStage('params')"
      >
        下一步
      </button>
      <button
        v-if="draft.stage === 'params'"
        data-testid="back-to-crop"
        class="min-h-14 rounded border border-slate-300 px-6 text-lg"
        @click="draft.setStage('crop')"
      >
        上一步
      </button>
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
