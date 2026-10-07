# 一起拼豆（WeeFuse）

本地优先、把照片变成拼豆图纸的 Android 辅助 App。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![ci](https://github.com/tuzkimo/wee-fuse/actions/workflows/ci.yml/badge.svg)](https://github.com/tuzkimo/wee-fuse/actions/workflows/ci.yml)
[![release-android](https://github.com/tuzkimo/wee-fuse/actions/workflows/release-android.yml/badge.svg)](https://github.com/tuzkimo/wee-fuse/actions/workflows/release-android.yml)

## 功能特性

- **照片变图纸**：从相册或相机选一张图，拖一拖选框框住要拼的部分——可以旋转，可以锁比例
  （1:1 / 4:3 / 9:16），也能放大到 2× / 4× 看清细节。
- **想拼多大由你定**：长边 1–500 颗豆（58 / 116 是一键快捷值）；用色档位选
  **简单 16 色 / 标准 32 色 / 精细不限**；随选随算成品厘米数与需要几块拼豆板。
- **内置 MARD 221 色卡**：出图直接给色号，照着手上有的颜色拼。
- **图纸库**：图纸存在本机，不联网也能用；封面就是图纸缩略图，可以改名、删除，
  也会告诉你占了多少空间。
- **编辑器**：放大缩小、拖动查看；一颗颗点着画、按住连着涂、框选一整块换色、吸管取色；
  撤销 / 重做 50 步；网格线与格内色号可开关。**改动先留在内存里，「保存」之后才写回图纸库。**
- **导出三种图**：
  - **施工图**：带网格、格内色号、行列刻度和拼豆板分界线；图太大时按整块板自动分片，一片片照着拼。
  - **用量表**：每种色号各要多少颗、一共多少颗。
  - **分享图**：纯色块、空格透明，适合发出去看效果。
- **手机和平板上直接可用**：从相机或相册选图；别的 App 里把图片分享过来能直接进 App；
  导出的图可以存进系统相册。
- **颜色尽量贴近实物**：按人眼感知的色差配色，少一点「屏幕上看着对、拼出来不对」。

## 开发

见[开发约定](AGENTS.md)与[开发文档索引](docs/开发文档索引.md)。

## License

[MIT](LICENSE)
