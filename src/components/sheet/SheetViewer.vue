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
/**
 * 实例已卸载（第 2 轮修复，审查者指出的**真实泄漏**）。
 *
 * 「关闭」按钮没有 `disabled`：用户完全可以在现算结算**之前**就关掉（换工程重挂时，旧实例同理）。
 * 那种情况下 `onUnmounted` 已经跑过（当时 `blobUrl` 还是 `""`，没有任何东西可 revoke），
 * 之后那颗 blob 才 resolve——若不拦，`URL.createObjectURL` 会在**已死实例**上诞生一个
 * **永远不会被回收**的 object URL，把整颗全分辨率位图（116 格单张约 60MB）钉到页面生命周期结束，
 * 每次「打开 → 早关」漏一份。
 *
 * 判据必须排在 `createObjectURL` **之前**（与 `ExportPanel.vue` 的 `unmounted` 闸同款，
 * 那里注释逐字写着「关闭按钮没有 disabled…这是一个真实的泄漏」）。
 */
let disposed = false;

/** 现算完成前用缩略图垫场；算完换成施工图。 */
const previewSrc = computed(() => blobUrl.value || props.thumbnail);

/**
 * 图上页眉、文件名与标题的**唯一**工程名来源（2026-10-08 收口）。
 *
 * 此前是三处两个源：标题与文件名取 `props.name`，而渲染进图里的页眉取 `record.meta.name`——两者由
 * 不同的人在不同时刻写入，重命名之后就可能是两个名字（一张图上的名字与它落盘的文件名不同，用户
 * 无从判断哪一份是新的）。**取 `props.name`**：① 标题与文件名本来就用它（改另两处会改掉现有行为
 * 与既有断言）；② 它是用户点开这条工程时看到的名字，「图上与档上同名」的判据就是用户看到的那一个。
 * `record.meta.name` 在本组件里不再被读（`record` 只提供 `doc`）。
 */
const sheetName = computed(() => props.name);

onMounted(async () => {
  try {
    const record = await getProjectStore().get(props.projectId);
    if (record === null) {
      error.value = `找不到工程：${props.projectId}`;
      return;
    }
    const { pattern } = fromProjectDocument(record.doc, palette);
    const usages = patternStats(pattern, palette).usages;
    const blob = await renderSheetBlob({ pattern, palette, usages, projectName: sheetName.value });
    // **卸载判据排在任何副作用之前**（见 `disposed` 的 JSDoc）：这里是这颗 blob 唯一的注册点，
    // 一旦放过，已死实例上生出来的 object URL 再没有人能销号。
    if (disposed) return;
    sheetBlob.value = blob;
    // **预览 URL 单独兜错**（2026-10-08 收口）：它与「图纸生成」是两件事——URL 造不出来时图纸**已经
    // 算完了**（`sheetBlob` 已就位、保存按钮因此可点），报成「图纸生成失败」是失实；同理也不该让它
    // 落进下面那个 catch，把一颗已生成的 blob 说成失败。预览失败只影响垫场图，保存路径不受影响。
    try {
      blobUrl.value = URL.createObjectURL(blob);
    } catch (e) {
      error.value = `预览生成失败：${e instanceof Error ? e.message : String(e)}`;
    }
  } catch (e) {
    // 中文包裹（第 2 轮修复）：`String(e)` 对非 Error 来源（IndexedDB 的 `DOMException`、
    // 被抛出的字符串 / 普通对象）会露出裸英文，而**「失败必须给出中文原因」对所有来源成立**。
    error.value = `图纸生成失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy.value = false;
  }
});

onUnmounted(() => {
  disposed = true;
  if (blobUrl.value !== "") URL.revokeObjectURL(blobUrl.value);
  blobUrl.value = "";
  sheetBlob.value = null;
});

async function save(): Promise<void> {
  const blob = sheetBlob.value;
  // `saving` 早退是**判据**，`:disabled` 只是视觉：同一 tick 的第二次点击会在 `disabled` 刷新之前
  // 进来（见 `saving` 的 JSDoc）。可点性判的是 `sheetBlob`（而不是 `blobUrl`）：blob 在 URL 之前
  // 就绪，URL 造不出来不该让一颗**已经生成好**的 blob 存不了（2026-10-08 收口）。
  if (blob === null || saving.value) return;
  saving.value = true;
  // **入口清空**（第 2 轮修复）：不清的话，重试期间屏幕上还挂着上一轮的「保存失败：…」，
  // 用户会以为**这次**也失败了（而这次可能成功）。
  saveState.value = "";
  try {
    await getPlatform().album.save(blob, exportFilename(sheetName.value, "施工图"));
    // **浏览器支逐字是「已生成」**（2026-10-08 控制者撤销此前的保留裁决）：B5-24（2026-10-06）已把
    // 口径收口为「已生成」，理由是下载被浏览器拦下时「已开始下载」失实；本批规格 §9.2-3 也要求
    // 与导出面板同一口径（`ExportPanel.vue` 的 `statusText` 浏览器支就是「已生成」）。
    saveState.value = getPlatform().album.kind === "album" ? "已保存到相册" : "已生成";
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
      <h2 data-testid="sheet-title" class="project-name text-2xl font-bold text-slate-900">{{ sheetName }} · 施工图</h2>
      <div class="flex flex-wrap gap-3">
        <button
          data-testid="sheet-save"
          :disabled="sheetBlob === null || saving"
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
