import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: () => import("@/views/LibraryPage.vue") },
    // B2：向导第一步是选图，第二步是选区 / 参数 / 结果装配页 `SetupPage`。
    // B1 的临时生成入口 `GeneratePage`（固定居中正方裁剪、一次点按即生成）已被这两页替换，
    // 该页与它的用例已在 B2 任务 14 删除。
    { path: "/new", name: "pick", component: () => import("@/views/PickPage.vue") },
    { path: "/new/setup", name: "setup", component: () => import("@/views/SetupPage.vue") },
    // /edit/:id 是 B3 的编辑器宿主：载入图纸 → 缩放平移 / 画笔 / 框选 / 吸管 / 撤销 → 显式保存。
    // 有未保存改动时离开会被页面内的确认条拦下（同页重载由 `watch(route.params.id)` 处理，B1-8）。
    { path: "/edit/:id", name: "editor", component: () => import("@/views/EditorPage.vue") },
    // `/edit/:id/result` 是**编辑来源的结果页**（C8 规格 §3.4）：编辑器保存成功后落到这里，
    // 内容与生成结果页共用同一个 `ResultPanel`，只是标题是「修改成功」、来源是刚落盘的那份。
    { path: "/edit/:id/result", name: "edit-result", component: () => import("@/views/EditResultPage.vue") },
    { path: "/lab/decode", name: "decode-lab", component: () => import("@/views/DecodeLabPage.vue") },
    // /lab/canvas 是 B4 的 canvas 上限探针页（R-7：**开发期实验台**，不进任何用户入口、页面自标「CI 不测」；
    // 真机实测结果回写 `EXPORT_MAX_EDGE`、主规格 §12 的 R2 与 B4 规格 §16 的 B4-R1）。
    { path: "/lab/canvas", name: "canvas-lab", component: () => import("@/views/CanvasLabPage.vue") },
    // /lab/shell 是任务 2 的六判据探针页（**开发期实验台**，不进任何用户入口、页面自标；判据 A–F 的原始
    // 读数由人类伙伴从这一页复制进 B5 spike 报告）。它**留存**为第三个实验台——与 `/lab/decode`、
    // `/lab/canvas` 并列：换设备 / 换 Tauri 版本时还要重测。
    { path: "/lab/shell", name: "shell-lab", component: () => import("@/views/ShellProbePage.vue") },
  ],
});
