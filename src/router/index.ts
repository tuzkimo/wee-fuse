import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: () => import("@/views/LibraryPage.vue") },
    // B2：向导第一步是选图（替换 B1 的临时生成入口 GeneratePage）。任务 11 会在其后加
    // `/new/setup`（选区与参数），任务 14 删掉 GeneratePage 及其用例。
    { path: "/new", name: "pick", component: () => import("@/views/PickPage.vue") },
    // B1 只到「载入并显示只读参数（名称 / 尺寸 / 用色数 / 是否保存了原图）」；图纸预览与编辑是计划 B3。
    { path: "/edit/:id", name: "editor", component: () => import("@/views/EditorPage.vue") },
    { path: "/lab/decode", name: "decode-lab", component: () => import("@/views/DecodeLabPage.vue") },
  ],
});
