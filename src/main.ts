import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { createIdbProjectStore } from "./services/idbProjectStore";
import { setProjectStore } from "./services/projectStore";
import "./style.css";

// 存储实现只在这里注入一次：页面通过 `getProjectStore()` 取，测试注入内存实现。
//
// **注入在挂载之前**：图纸库首屏的 `onMounted` 就会调 `getProjectStore()`，若改成
// 「先挂载、后注入」（例如把注入写成不 await 的 `.then()`），首屏那一瞬会看到
// `current === null`，于是首页先闪一句「存储不可用」再自己变回来——对用户就是
// 「我的图库没了」。所以这里用一个 async 引导函数把「注入 → 挂载」串成顺序执行。
//
// **不用顶层 await**：`vite.config.ts` 没有改 `build.target`，Vite 6 的默认值是
// `'modules'`（chrome87 / edge88 / es2020 / firefox78 / safari14），esbuild 在那里直接
// 报 `Top-level await is not available in the configured target environment`（实测）。
// 改 target 会连带提高整个产物的浏览器门槛，为一个入口语句不值得。
//
// 打开失败（隐私模式 / 配额 / 陈旧数据库）时**仍然挂载**：图纸库会显示「存储不可用」
// 并禁用新建，而不是整页白屏。这里只把原因记到控制台。
async function bootstrap(): Promise<void> {
  try {
    setProjectStore(await createIdbProjectStore());
  } catch (error) {
    console.error("工程存储初始化失败", error);
  }
  createApp(App).use(createPinia()).use(router).mount("#app");
}

void bootstrap();
