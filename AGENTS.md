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

## 分层边界（硬约束）

- `src/core/**` 是纯计算层：**不得** import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，
  **不得**引用 DOM 全局（`document`、`window`、`createImageBitmap`、`OffscreenCanvas`、`Image`）。
  只允许 ECMAScript 标准内置对象。违反这条，引擎就无法在 Node 里全量单测。
- `src/services/**` 是唯一接触平台 API 的层。需要平台能力时，在 core 定义接口，在 services 注入实现。

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
