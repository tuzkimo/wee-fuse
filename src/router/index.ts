import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: () => import("@/views/LibraryPage.vue") },
    // B2：向导第一步是选图（替换 B1 的临时生成入口 GeneratePage），第二步是选区 / 参数 / 结果
    // 装配页 `SetupPage`。任务 14 删掉 GeneratePage 及其用例。
    { path: "/new", name: "pick", component: () => import("@/views/PickPage.vue") },
    { path: "/new/setup", name: "setup", component: () => import("@/views/SetupPage.vue") },
    // B1 只到「载入并显示只读参数（名称 / 尺寸 / 用色数 / 是否保存了原图）」；图纸预览与编辑是计划 B3。
    { path: "/edit/:id", name: "editor", component: () => import("@/views/EditorPage.vue") },
    { path: "/lab/decode", name: "decode-lab", component: () => import("@/views/DecodeLabPage.vue") },
  ],
});
