import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: () => import("@/views/LibraryPage.vue") },
    // B1 的临时入口：居中正方裁剪、固定长边 58 / 档位 32。计划 B2 会用真正的
    // 「选区 → 尺寸 → 档位」流程替换它。
    { path: "/new", name: "generate", component: () => import("@/views/GeneratePage.vue") },
    // B1 只到「载入并显示只读预览 + 参数」，编辑器是计划 B3。
    { path: "/edit/:id", name: "editor", component: () => import("@/views/EditorPage.vue") },
    { path: "/lab/decode", name: "decode-lab", component: () => import("@/views/DecodeLabPage.vue") },
  ],
});
