import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  { path: "/", name: "home", component: () => import("@/views/LibraryPage.vue") },
  // B2：向导第一步是选图，第二步是选区 / 参数 / 结果装配页 `SetupPage`。
  // B1 的临时生成入口 `GeneratePage`（固定居中正方裁剪、一次点按即生成）已被这两页替换，
  // 该页与它的用例已在 B2 任务 14 删除。
  { path: "/new", name: "pick", component: () => import("@/views/PickPage.vue") },
  { path: "/new/setup", name: "setup", component: () => import("@/views/SetupPage.vue") },
  // /edit/:id 是 B3 的编辑器宿主：载入图纸 → 缩放平移 / 画笔 / 填充 / 撤销 → 显式保存。
  // 有未保存改动时离开会被页面内的确认条拦下（同页重载由 `watch(route.params.id)` 处理，B1-8）。
  { path: "/edit/:id", name: "editor", component: () => import("@/views/EditorPage.vue") },
  // `/edit/:id/result` 是**编辑来源的结果页**（C8 规格 §3.4）：编辑器保存成功后落到这里，
  // 内容与生成结果页共用同一个 `ResultPanel`，只是标题是「修改成功」、来源是刚落盘的那份。
  { path: "/edit/:id/result", name: "edit-result", component: () => import("@/views/EditResultPage.vue") },
];

// `/lab/shell` **只在 DEV 构建注册**（`import.meta.env.DEV` 在生产构建里被静态折叠，组件连同它的
// 探针依赖因此不进生产包）。
//
// **2026-10-13：`/lab/decode` 与 `/lab/canvas` 已删除**（审计整改，人类伙伴裁定）。两者的使命都是
// 一次性的：`/lab/canvas` 的 2026-10-06 真机读数已归档（B4 记录 §7.1，`EXPORT_MAX_EDGE` 当年就是按
// 它定下的）、而 C8 起该常量改由真实测量定界；`/lab/decode` 的「去留」自 2026-10-01 起就挂在
// B2 规格 §13（B2-55），本次结清。两个页面的原始代码在 git 历史里。
if (import.meta.env.DEV) {
  routes.push(
    // 六判据探针页（**开发期实验台**，不进任何用户入口、页面自标）——它是三台里唯一**可复用**的：
    // 换设备 / 换 Tauri 版本时还要重测。判据 A–F 的原始读数由人类伙伴从这一页复制进 B5 spike 报告。
    { path: "/lab/shell", name: "shell-lab", component: () => import("@/views/ShellProbePage.vue") },
  );
}

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
