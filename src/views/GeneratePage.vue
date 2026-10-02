<script setup lang="ts">
// src/views/GeneratePage.vue
//
// ⚠️ 临时入口（计划 B1）：固定「居中正方裁剪 + 长边 58/116 + 档位 16/32/不限」。
// 规格要求的完整流程是「选图 → 拖动缩放选区 → 尺寸/色卡/档位设置 → 生成」，
// 由计划 B2 用真正的选区页与设置页**替换本文件**。不要把它当正式入口继续加功能。
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import { createDomBitmapPlatform, createExactDecoder, createFastDecoder } from "@/services/decoders";
import { fileFromInput, probeSourceSize } from "@/services/imageSource";
import { getBuiltinPalette } from "@/services/palette";
import { renderPatternThumbnail } from "@/services/patternThumbnail";
import { generatePattern } from "@/services/pipeline";
import { getProjectStore, type ProjectMeta, type ProjectRecord } from "@/services/projectStore";

const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const longSide = ref("58");
const maxColors = ref("32");
const busy = ref(false);
const error = ref("");
const storeError = ref("");

/** B1 临时入口的固定档位（规格 §8）：长边 58 / 116，档位 16 / 32 / 不限。 */
const LONG_SIDE_CHOICES = [58, 116] as const;
const MAX_COLOR_CHOICES = [
  { value: "16", label: "简单（16 色）" },
  { value: "32", label: "标准（32 色）" },
  { value: "", label: "精细（颜色不限）" },
] as const;

// 存储实现在 `main.ts` 注入。取不到时**不隐藏按钮**，而是把原因显示出来：这是本页唯一的
// 写操作入口，静默禁用会让用户以为是自己没选图。
onMounted(() => {
  try {
    getProjectStore();
  } catch (e) {
    storeError.value = e instanceof Error ? e.message : String(e);
  }
});

function parseMaxColors(raw: string): 16 | 32 | null {
  if (raw === "16") return 16;
  if (raw === "32") return 32;
  return null;
}

async function run(): Promise<void> {
  error.value = "";
  const picked = fileFromInput(fileInput.value);
  if (!picked.ok) {
    error.value = picked.reason;
    return;
  }

  busy.value = true;
  try {
    const palette = getBuiltinPalette();
    const size = await probeSourceSize(picked.file);
    // 居中正方裁剪，边长取短边（与解码实验台的 0.5 倍裁剪不同，这里取满）。
    // R25：宽高在这里换轴就会得到「裁到另一根轴上」的源矩形——不是崩溃，而是一张位置不对、
    // 甚至越界的图纸。`GeneratePage.test.ts` 用假平台直接断言交给 `createImageBitmap` 的源矩形。
    const side = Math.min(size.width, size.height);
    const crop = {
      x: Math.round((size.width - side) / 2),
      y: Math.round((size.height - side) / 2),
      width: side,
      height: side,
    };
    const targetLongSide = Number.parseInt(longSide.value, 10);
    const targetMaxColors = parseMaxColors(maxColors.value);

    const platform = createDomBitmapPlatform();
    const pattern = await generatePattern(
      { source: picked.file, crop, rotation: 0, longSide: targetLongSide, maxColors: targetMaxColors },
      {
        exactDecoder: createExactDecoder(platform),
        fastDecoder: createFastDecoder(platform),
        palette,
      },
    );

    // 全透明 / 整图低于空格判定阈值的图会得到一张一个实心格都没有的图纸。它进库只会在
    // 图纸库里留下一张点开什么都没有的工程，所以在这里就响亮拒绝（写任何东西之前）。
    const filledCount = pattern.cells.reduce(
      (sum, value) => (value === EMPTY ? sum : sum + 1),
      0,
    );
    if (filledCount === 0) {
      error.value = "这张图没有可拼的像素，换一张试试";
      return;
    }

    const params = {
      longSide: targetLongSide,
      maxColors: targetMaxColors,
      crop: { x: crop.x, y: crop.y, w: crop.width, h: crop.height, rotate: 0 },
    };
    const doc = toProjectDocument(pattern, palette, params);
    const id = createId();
    const now = new Date().toISOString();
    // width / height / colorCount 交给存储层从 doc 派生（`put` 会覆盖这三个字段），
    // 这里刻意不自己算一份——冗余字段有两个来源就会漂移。
    const meta: ProjectMeta = {
      id,
      name: defaultName(picked.file.name),
      createdAt: now,
      updatedAt: now,
      thumbnail: renderPatternThumbnail(pattern, palette),
      width: 0,
      height: 0,
      colorCount: 0,
    };
    const record: ProjectRecord = {
      meta,
      doc,
      source: { blob: picked.file, type: picked.file.type },
    };
    await getProjectStore().put(record);
    await router.push({ name: "home" });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/** 工程 id：优先用 crypto.randomUUID（安全上下文），不可用时退到时间戳 + 随机数。 */
function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 默认工程名：原文件名去掉扩展名；为空时给一个中性名。 */
function defaultName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  return base.length === 0 ? "新图纸" : base;
}

const canGenerate = computed(() => !busy.value && storeError.value === "");
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <h1 class="text-3xl font-bold text-slate-900">新建图纸</h1>
    <!-- 临时占位标注（规格 §8）：三处必须同时存在——文件头注释、这里、README。 -->
    <p class="mt-2 text-base text-amber-700">
      临时入口（计划 B1）：固定居中正方裁剪，长边与档位只有两三个选项。
      完整的「选区 → 尺寸 → 档位」界面由后续计划提供。
    </p>

    <p v-if="storeError" class="mt-4 rounded bg-red-50 p-4 text-lg text-red-700">
      工程存储不可用：{{ storeError }}
    </p>

    <section class="mt-6 space-y-6">
      <label class="block text-lg">
        选一张图片
        <input ref="fileInput" type="file" accept="image/*" class="mt-2 block text-base" />
      </label>

      <label class="block text-lg">
        长边豆数
        <select
          v-model="longSide"
          data-testid="long-side"
          class="mt-2 block min-h-12 rounded border border-slate-300 px-3 text-lg"
        >
          <option v-for="n in LONG_SIDE_CHOICES" :key="n" :value="String(n)">{{ n }} 颗</option>
        </select>
      </label>

      <label class="block text-lg">
        用几种颜色
        <select
          v-model="maxColors"
          data-testid="max-colors"
          class="mt-2 block min-h-12 rounded border border-slate-300 px-3 text-lg"
        >
          <option v-for="c in MAX_COLOR_CHOICES" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </label>

      <button
        data-testid="generate-run"
        class="min-h-14 rounded bg-slate-900 px-8 text-lg text-white disabled:opacity-50"
        :disabled="!canGenerate"
        @click="run"
      >
        {{ busy ? "正在生成…" : "生成图纸" }}
      </button>
    </section>

    <p
      v-if="error"
      data-testid="generate-error"
      class="mt-4 rounded bg-amber-50 p-4 text-lg text-amber-800"
    >
      {{ error }}
    </p>
  </main>
</template>
