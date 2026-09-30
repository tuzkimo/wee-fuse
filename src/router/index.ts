import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: () => import("@/views/HomePage.vue") },
    { path: "/lab/decode", name: "decode-lab", component: () => import("@/views/DecodeLabPage.vue") },
  ],
});
