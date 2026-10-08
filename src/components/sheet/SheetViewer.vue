<script setup lang="ts">
// 首页「查看施工图」的全屏层（B6）：**现算**，不落盘（规格 §9.3）。
//
// 三条纪律：
// 1. 打开瞬间先用列表里已有的缩略图垫场（它在记录里，零成本），现算完成后换成真正的施工图；
// 2. 渲染只经 `renderSheetBlob`（与导出面板同一条通道），本组件不建画布、不调 core 渲染器；
// 3. 落盘经能力层（`getPlatform().album.save`），文件名走 `exportFilename`——不在这里拼第二份命名。
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { fromProjectDocument } from "@/core/project/file";
import { patternStats } from "@/core/pattern/stats";
import { getBuiltinPalette } from "@/services/palette";
import { getPlatform } from "@/services/platform/capabilities";
import { exportFilename } from "@/services/exporter";
import { renderSheetBlob } from "@/services/sheetExport";
import { getProjectStore } from "@/services/projectStore";

const props = defineProps<{
  projectId: string;
  name: string;
  thumbnail: string;
}>();
const emit = defineEmits<{ close: [] }>();

const palette = getBuiltinPalette();
/**
 * 现算出来的 blob **本体**留着（`shallowRef`：它是大对象，不需要也不该被深代理），
 * `<img>` 用它的 object URL。保存时直接落盘这颗 blob——**不要**用 `fetch(objectUrl)` 再取一遍，
 * 那会在内存里多复制一份全分辨率位图（116 格的单张施工图约 60MB）。
 */
const sheetBlob = shallowRef<Blob | null>(null);
const blobUrl = ref("");
const error = ref("");
const busy = ref(true);
const saveState = ref("");
/**
 * 有保存挂在飞行中（修复轮，控制者裁定）。
 *
 * **为什么必须是一个真的状态、而不是只靠按钮的 `:disabled`**：同一 tick 里的两次 `click`
 * （真机双击、或测试里连着两次派发）都会进 handler——那一刻 `:disabled` 还没被渲染刷新，
 * 于是壳里往相册写两份、浏览器触发两次下载（用户不会想要第二份）。所以判据写在 `save()` 的**入口**，
 * `:disabled` 只是视觉上的那一半（让用户看到「点了，正在存」）。
 */
const saving = ref(false);

/** 现算完成前用缩略图垫场；算完换成施工图。 */
const previewSrc = computed(() => blobUrl.value || props.thumbnail);

onMounted(async () => {
  try {
    const record = await getProjectStore().get(props.projectId);
    if (record === null) {
      error.value = `找不到工程：${props.projectId}`;
      return;
    }
    const { pattern } = fromProjectDocument(record.doc, palette);
    const usages = patternStats(pattern, palette).usages;
    const blob = await renderSheetBlob({ pattern, palette, usages, projectName: record.meta.name });
    sheetBlob.value = blob;
    blobUrl.value = URL.createObjectURL(blob);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
});

onUnmounted(() => {
  if (blobUrl.value !== "") URL.revokeObjectURL(blobUrl.value);
  blobUrl.value = "";
  sheetBlob.value = null;
});

async function save(): Promise<void> {
  const blob = sheetBlob.value;
  // `saving` 早退是**判据**，`blobUrl === ''` 那个 `disabled` 只是视觉：同一 tick 的第二次点击
  // 会在 `disabled` 刷新之前进来（见 `saving` 的 JSDoc）。
  if (blob === null || saving.value) return;
  saving.value = true;
  try {
    await getPlatform().album.save(blob, exportFilename(props.name, "施工图"));
    saveState.value = getPlatform().album.kind === "album" ? "已保存到相册" : "已开始下载";
  } catch (e) {
    saveState.value = `保存失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    // **失败也要放行**：卡在 `saving = true` 等于「错一次就再也存不了」，而失败原因已经显示出来了。
    saving.value = false;
  }
}
</script>

<template>
  <section data-testid="sheet-viewer" class="fixed inset-0 z-30 overflow-y-auto bg-white p-4">
    <header class="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
      <h2 data-testid="sheet-title" class="project-name text-2xl font-bold text-slate-900">{{ name }} · 施工图</h2>
      <div class="flex flex-wrap gap-3">
        <button
          data-testid="sheet-save"
          :disabled="blobUrl === '' || saving"
          class="min-h-11 rounded bg-slate-900 px-6 text-base text-white disabled:opacity-50"
          @click="save"
        >
          保存
        </button>
        <button data-testid="sheet-close" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="emit('close')">
          关闭
        </button>
      </div>
    </header>
    <p v-if="busy" data-testid="sheet-loading" class="mx-auto mt-3 max-w-4xl text-base text-slate-500">正在生成施工图…</p>
    <p v-if="error" data-testid="sheet-error" class="mx-auto mt-3 max-w-4xl rounded bg-amber-50 p-4 text-lg text-amber-800">{{ error }}</p>
    <p v-if="saveState" data-testid="sheet-save-state" class="mx-auto mt-3 max-w-4xl text-base text-slate-600">{{ saveState }}</p>
    <img v-if="previewSrc !== ''" data-testid="sheet-preview" :src="previewSrc" alt="施工图" class="mx-auto mt-3 w-full max-w-4xl rounded bg-slate-100" />
  </section>
</template>
