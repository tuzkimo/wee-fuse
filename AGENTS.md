# 项目约定

## 项目概述

一起拼豆（WeeFuse）— 拼豆辅助 App，Android 平板优先。
- 前端：Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS v4
- 客户端壳：Tauri 2.0（后续阶段引入，桌面端仅开发调试）
- 图像引擎：纯前端 TypeScript，`src/core/` 零依赖、与框架无关
- 后端：后续阶段引入（Go），当前不建目录

## 开发命令

```bash
npm run dev              # Vite 开发服务器（端口 1420）
npm run build            # vue-tsc 类型检查 + Vite 构建
npm run test             # 单元测试（vitest）
npm run test:watch       # 单元测试（监听模式）
npm run palette:fetch    # 重新抓取并生成 MARD 色卡数据
```

### 依赖安装与 npm 版本 hazard

- 权威安装方式是 `npm ci`；**`package-lock.json` 必须入库**，删掉它会让装依赖失败。
- 在没有 lockfile 的干净环境里跑裸 `npm install` 会撞上 npm 11.5.2（Node 24.19.0 自带）的
  arborist bug：`Cannot read properties of null (reading 'edgesOut')`。触发链是 vitest 的 peer
  范围让 npm 去探索 `vite@8` → `@vitejs/devtools` → `vitest@5` 这条环。与本机依赖版本、镜像、
  项目配置均无关；npm 12.1.0 已修。
- 解法：用 `npm install --legacy-peer-deps` 生成 lockfile，或把 npm 升到 12.x。
- 不要为此添加 `.npmrc`，也不要改动依赖版本。

## 分层边界（硬约束）

- `src/core/**` 是纯计算层：**不得** import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，
  **不得**引用 DOM 全局（`document`、`window`、`createImageBitmap`、`OffscreenCanvas`、`Image`）。
  只允许 ECMAScript 标准内置对象。违反这条，引擎就无法在 Node 里全量单测。
- `src/services/**` 是唯一接触平台 API 的层。需要平台能力时，在 core 定义接口，在 services 注入实现。
- 边界闸门是 `src/__tests__/coreBoundary.test.ts`（随 `npm run test` 执行），按**词法近似**匹配，有已知偏差：
  把参数命名为 `window`（或清单里其他被禁名）会在函数体内的引用处**误报**（形如
  `function h(a, window) { return window + 1; }`）；而 `fn(a, window, b)`、`[a, window, b]`
  这类实参 / 数组元素形态会**反向导致整篇遮蔽**，让该文件的 `window` 检查全线失效。
- 闸门只守**要交付的 core 代码**：`src/core/**` 下路径含 `__tests__/` 路径段、或文件名以
  `.test.ts` / `.spec.ts` 结尾的文件**不在扫描范围内**（整文件不扫）。它们是开发期产物，
  按本项目约定显式 `import … from "vitest"`（`vite.config.ts` 里保留了 `test.globals: true`，
  所以技术上也可以不 import——但显式 import 是约定、也是推荐写法），而 core 的 import
  白名单只放行相对路径；不排除就等于闸门在拒绝计划自己的测试文件。取舍：core 测试文件里
  误用 DOM 全局不会被这道闸门拦下——那不影响交付代码的纯度，且测试本来就跑在 happy-dom 里，
  真出问题会以测试失败的形式暴露。
- 撞上时的处置是**改掉这个命名**（例如参数改叫 `sampleWindow`），不要放宽闸门规则，
  也不要在 `src/core/**` 里加任何绕过标记。完整偏差清单见该测试文件头部注释。

## 技术约束

- TypeScript 严格模式，禁止 `any`。
- 测试优先：非 bugfix 类功能必须附带单元测试，不可删改已有测试。
- 提交信息用 Conventional Commits + 中文描述：`feat(core): 面积平均重采样与空格判定`。
- 颜色计算一律在 CIE Lab 空间做；逐格映射用 ΔE76（性能），选色阶段用 CIEDE2000（精度）。

## 关键常量（改动需同步规格文档）

- 空格标记 `EMPTY = 0xffff`
- 长边豆数范围 1–500
- 用色档位 `16 | 32 | null`
- 生成解码目标宽度 = 长边豆数 × 4
- 预览解码位图长边 ≤ 1600
- 空格判定：alpha 加权覆盖率 ≥ 0.25
- 撤销栈上限 50
