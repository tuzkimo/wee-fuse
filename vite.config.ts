import { fileURLToPath, URL } from "url";
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [vue(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
  },
  test: {
    // `tsconfig.json` 的 `types: ["vitest/globals"]` 让 vue-tsc 认为 describe/it/expect
    // 是全局可用的；这里必须同步打开运行时注入，否则不显式 import 就写用例会
    // 「vue-tsc 放行、npm run test 报 describe is not defined」。现有用例都显式 import，
    // 打开后行为不变。`tsconfig.json` 的 `types` 保持不动——它是拦住 `src/core/**`
    // 误用 Node 全局（process/Buffer）的那道闸门。
    globals: true,
    environment: "happy-dom",
    testTimeout: 20000,
  },
});
