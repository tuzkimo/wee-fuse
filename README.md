# 一起拼豆（WeeFuse）

拼豆辅助 App：把图片转成可以照着拼的拼豆图纸。Android 平板优先。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![ci](https://github.com/tuzkimo/wee-fuse/actions/workflows/ci.yml/badge.svg)](https://github.com/tuzkimo/wee-fuse/actions/workflows/ci.yml)
[![release-android](https://github.com/tuzkimo/wee-fuse/actions/workflows/release-android.yml/badge.svg)](https://github.com/tuzkimo/wee-fuse/actions/workflows/release-android.yml)

## 功能特性

- **图片转图纸**：从相机 / 相册选图（浏览器里直接选文件）；矩形选区可拖动、四角缩放，
  比例锁 **1:1 / 4:3 / 9:16**，支持**旋转 90°**，缩放档位适配 / 2× / 4×，一键重置为居中正方。
- **参数与色卡**：长边豆数 **1–500**（58 / 116 快捷值）；用色档位 **简单 16 / 标准 32 / 精细不限**；
  内置 **MARD 221** 色卡；实时给出成品颗数、厘米数与需要几块拼豆板。
- **图纸库**：数据存本机 IndexedDB，无后端、断网可用；封面是**图纸缩略图**（不是原图），
  可改名、二次确认删除，并显示占用与配额。
- **编辑器**：双指缩放平移；画笔单颗与拖动连涂；框选批量换色；吸管（吸空格 = 橡皮）；
  撤销 / 重做 50 步；网格线与格内色号可开关；调色板按当前图纸的实时用色列出，可按全色卡添加颜色。
  **编辑只改内存，显式「保存」才落盘**（保存会重算封面）；有未保存改动时在页面内离开会被拦下。
- **导出三类 PNG**（逐张由手势保存）：**施工图**（网格、格内色号、每 5 格坐标刻度、每 29 格拼豆板边界、
  顶部信息条与页脚；超出画布上限时按整块拼豆板自动分片）、**用量表**（色块 / 色号 / 名称 / 颗数 / 合计）、
  **分享图**（纯色块、空格透明）。
- **Android 壳（Tauri 2）**：相机 / 相册选图；**系统分享直接进 App**（多图只取第一张并提示）；
  **保存进系统相册**；返回键三分支（有未保存改动不会静默退出）。
- **色准**：颜色计算全在 CIE Lab 空间；逐格映射用 ΔE76，选色阶段用 CIEDE2000。

## 目标平台

Android 平板优先。桌面窗口与浏览器只用于开发调试。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS v4 |
| 客户端壳 | Tauri 2.0（Android 为主目标平台，桌面端仅开发调试） |
| 本地存储 | IndexedDB |
| 图像引擎 | 纯 TypeScript，零依赖、与框架无关（`src/core/`） |

## 快速开始（开发调试）

环境要求：Node 22+（本项目实测 Node 24.19.0）；要出 APK 另需 Rust stable、Android SDK/NDK 与 JDK 17。

```bash
npm ci
npm run dev              # Vite dev server（http://localhost:1420）
npm run test             # 单元测试（vitest）
npm run build            # vue-tsc 类型检查 + Vite 构建
npx tauri android dev    # 编译并推送到已连接的 Android 设备
npx tauri android build --apk --debug   # 出 debug APK
```

> 权威安装方式是 `npm ci`，**`package-lock.json` 必须保留**——在没有 lockfile 的干净环境里跑裸
> `npm install` 会撞上 npm 11.5.2 的 arborist bug。Android 端 gradle wrapper 默认走腾讯镜像
> （`src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties`），海外网络可改回官方源。

## 获取安装包与发布

推 `v*` tag 触发 Actions 的 **`release-android`** 工作流，在 GitHub 机器上出 arm64 **已签名** release APK
（`WeeFuse_<tag>_arm64.apk`）并自动挂到 [GitHub Release](https://github.com/tuzkimo/wee-fuse/releases)；
tag 必须与 `src-tauri/tauri.conf.json` 的版本号一致。本地出已签名包：`npx tauri android build --apk`。

签名材料位置、换钥匙步骤与 CI 的四个 secret 见 **[Android 发布指南](docs/Android发布指南.md)**。

## 文档

- [开发约定](AGENTS.md)（分层边界、平台壳约束、关键常量、开发流程）
- [Android 发布指南](docs/Android发布指南.md)

| 阶段 | 设计规格 | 实现计划 | 构建记录 |
|---|---|---|---|
| 第一阶段：图像引擎 | [规格](docs/superpowers/specs/2026-09-30-image-to-pattern-design.md) | [计划](docs/superpowers/plans/2026-09-30-engine.md) | [记录](docs/superpowers/notes/2026-10-01-engine-build-log.md) |
| 计划 B1：应用层骨架 | [规格](docs/superpowers/specs/2026-10-03-app-skeleton-design.md) | [计划](docs/superpowers/plans/2026-10-03-app-b1-skeleton.md) | [记录](docs/superpowers/notes/2026-10-03-app-b1-build-log.md) |
| 计划 B2：选区与参数页 | [规格](docs/superpowers/specs/2026-10-03-app-b2-crop-settings-design.md) | [计划](docs/superpowers/plans/2026-10-03-app-b2-crop-settings.md) | [记录](docs/superpowers/notes/2026-10-03-app-b2-build-log.md) |
| 计划 B3：编辑器 | [规格](docs/superpowers/specs/2026-10-04-app-b3-editor-design.md) | [计划](docs/superpowers/plans/2026-10-04-app-b3-editor.md) | [记录](docs/superpowers/notes/2026-10-04-app-b3-build-log.md) |
| 计划 B4：导出 | [规格](docs/superpowers/specs/2026-10-05-app-b4-export-design.md) | [计划](docs/superpowers/plans/2026-10-05-app-b4-export.md) | [记录](docs/superpowers/notes/2026-10-05-app-b4-build-log.md) |
| 计划 B5：Tauri Android 壳 | [规格](docs/superpowers/specs/2026-10-06-app-b5-tauri-shell-design.md) | [计划](docs/superpowers/plans/2026-10-06-app-b5-tauri-shell.md) | [记录](docs/superpowers/notes/2026-10-06-app-b5-build-log.md) |

各轮的**延后项与已知限制的唯一真源是那份构建记录**（第一阶段见引擎记录的 §9，B1 见其 §8，
B2 见其 §8，B4 见其 §8，B5 见其 §6/§7）——README 不再复制它们。

## License

[MIT](LICENSE)
