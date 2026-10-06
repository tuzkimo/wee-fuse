import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { createIdbProjectStore } from "./services/idbProjectStore";
import { setProjectStore } from "./services/projectStore";
import { browserPlatform } from "./services/platform/browserPlatform";
import { setPlatform } from "./services/platform/capabilities";
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
// **这个 try/catch 不是「存储失败」的兜底——注入期事实上不会失败。**
// `createIdbProjectStore()` 是**惰性建库**：它是 async 工厂，只返回一个持有 `databaseName`
// 的闭包对象，真正的 `indexedDB.open` 发生在每次操作的 `withDb` 里。因此 `await` 它不会
// reject，catch 只在「注入代码本身出意外」（例如模块级初始化被打断）时才可能进入。
//
// 真实的三类失败——隐私模式、配额用尽、陈旧库缺 object store——都发生在**首次使用**
// （`list()` / `put()`）：图纸库把它显示成琥珀色的错误行（此时 `storeUnavailable` 仍是
// false、新建按钮**不会**被禁用，用户会一路走到生成页的 `put` 才看到原始报错文本），
// 生成页把它显示成自己的错误行。**但这都不是挂载期的问题**：无论哪种情况页面都照常挂载，
// 不存在白屏。只有 `current === null`（未注入）那一支才会被图纸库兜成
// 「存储不可用 + 禁用新建」。
// （把「库打不开」也做成「存储不可用」需要让 `LibraryPage` 区分「未注入」与「打开失败」两种
// 语义，已记入计划 B2 待办，本文件不在这里兜。）
async function bootstrap(): Promise<void> {
  try {
    setProjectStore(await createIdbProjectStore());
  } catch (error) {
    console.error("工程存储初始化失败", error);
  }
  // 平台能力层：未注入时 `getPlatform()` 就是这个浏览器实现（`capabilities.ts` 的默认值），
  // 这里显式注入一次是为了让「注入早于挂载」成为结构事实（机检 = platformGate 的 G3）。
  // 任务 2 会把它换成 `isTauriRuntime() ? createTauriPlatform() : browserPlatform`。
  setPlatform(browserPlatform);
  createApp(App).use(createPinia()).use(router).mount("#app");
}

void bootstrap();
