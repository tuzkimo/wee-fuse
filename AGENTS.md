# 项目约定

> **本文件与 `CLAUDE.md` 是并行维护的镜像：改动必须同时改，两边内容保持一致。**

## 项目概述

一起拼豆（WeeFuse）— 拼豆辅助 App，Android 平台（**平板优先，但手机与平板都要求排版正确**）。
- 前端：Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS v4
- 客户端壳：Tauri 2.0（**B5 起已落地 Android 壳**，桌面端仅用于开发调试）
- 本地存储：IndexedDB
- 图像引擎：纯前端 TypeScript，`src/core/` 零依赖、与框架无关
- 后端：后续阶段引入（Go），当前不建目录

环境：Node 22+（本项目实测 Node 24.19.0）；要出 Android 包时另需 Rust stable、Android SDK/NDK、JDK 17。
出包、签名材料与换钥匙见 `docs/Android发布指南.md`。

**分层边界、平台壳、文档真源、开发流程、入口校验、关键常量**等细则见 `docs/开发约定详解.md`。
逐阶段的规格 / 计划 / 构建记录在 `docs/archive/`（**历史证据，不是当前口径，默认不必读**）。

## 开发命令

```bash
# 前端
npm ci                   # 权威依赖安装方式（package-lock.json 必须入库）
npm run dev              # Vite 开发服务器（端口 1420）
npm run build            # vue-tsc 类型检查 + Vite 构建
npm run test             # 单元测试（vitest）
npm run test:watch       # 单元测试（监听模式）
npm run palette:fetch    # 重新抓取并生成 MARD 色卡数据

# Android 壳
npx tauri android dev                    # 真机/模拟器调试（会装 SDK 组件，首次较慢）
npx tauri android build --apk --debug    # 出 debug APK
```

## superpowers 落盘约定

- 计划 / 规格仍按 skill 默认写到 `docs/superpowers/{plans,specs}/`——**不改默认路径**（新计划照旧
  写在这里，只把做完的搬走，目录自然保持在小规模）。
- **已执行完的**计划、被取代的规格、抽走延后项后的构建记录，`git mv` 到 `docs/archive/`：
  同层移动、历史保留，归档区的目录页是 `docs/archive/README.md`。
- **在飞的计划不改名、不搬家**：SDD 的进度账本按 `.superpowers/sdd/<计划文件名>/` 认领，
  改名或搬家会让控制器当成全新开始、重跑已完成的任务。
- 计划里**不再有「更新 `docs/开发文档索引.md`」这一步**（该文件已于 2026-10-13 删除）：技术栈 / 环境
  并进了本文件，逐阶段表进了 `docs/archive/README.md`。新增一批功能**不需要**再往任何表里加行。

## 技术约束

- 不重构无关代码，不要修改未被明确要求的文件。
- 测试优先：非 bugfix 类功能必须附带单元测试，不可删改已有测试。
  - 例外：已有断言与**新的规格要求直接冲突**时，**经人工确认可修改**（禁止为让代码变绿而放宽、删除或改弱断言）。
- TypeScript 严格模式，禁止 `any`。
- 提交信息用 Conventional Commits + 中文描述：`feat(core): 面积平均重采样与空格判定`。
- 颜色计算一律在 CIE Lab 空间做；逐格映射用 ΔE76（性能），选色阶段用 CIEDE2000（精度）。
- 分层边界：`src/core/**` 是纯计算层，不得 import `vue` / `pinia` / `@tauri-apps/*`、不得引用 DOM 全局；
  平台能力在 core 定义接口、在 services 注入实现（闸门 `src/__tests__/coreBoundary.test.ts`）。
- 入口校验：公开 API 必须校验到「非法输入响亮失败」，校验写在任何写操作之前。
- 依赖：不要加 `.npmrc`、不要改依赖版本；无 lockfile 时裸 `npm install` 会撞 npm 11.5.2 的 arborist bug，
  用 `npm install --legacy-peer-deps` 或升到 npm 12.x。
