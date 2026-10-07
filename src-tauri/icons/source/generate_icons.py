#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 WeeFuse（一起拼豆）应用图标源图。

极简风：纯白底 + 胖胖猪肉体（にくまるフォント）黑字「豆」——与姊妹项目
`d:\\projects\\my\\wee-count\\`（白底黑字「銭」）成对。

输出 1024x1024 PNG：
  - app-icon.png            完整图标（桌面 / iOS / Android 旧版 mipmap / favicon）
  - app-icon-bg.png         Android 自适应背景层（纯白满铺）
  - app-icon-fg.png         Android 自适应前景层（「豆」，透明底）
  - app-icon-monochrome.png Android 13+ 主题图标蒙版层（字形剪影，透明底）

为什么用 Python 而不是原来的零依赖 Node 脚本：渲染字体字形必须有字体光栅化器，Node 标准库
没有，而为一个图标去引 npm 图像依赖不划算。这里只借 Pillow（**仅在重新生成图标时才需要，
不是构建期依赖**）；生成出来的 4 张源图**已入库**，日常构建 / CI 不跑这个脚本。

重新生成：
    python src-tauri/icons/source/generate_icons.py
    npx tauri icon src-tauri/icons/source/manifest.json

比例口径（为什么 fg / mono 比 full 小很多）：
Android 自适应图标是一张 108dp 的图层，交给启动器用**任意形状**的蒙版裁切，**保证可见的只有
居中的 66dp 直径圆**（= 图层的 0.611）。所以前景层与蒙版层的字形不只是「看起来占七成」，
**离中心最远的墨迹**还必须落进那个圆里——否则圆形蒙版的启动器会把「豆」上下两横的角切掉。
脚本实测最远墨迹半径并断言这两层没出安全区：不合规就退出码 1，且**在落盘之前**就退出，不留半套图。

排版常识：`GLYPH_*` 是**墨迹**占比（不是字号），脚本会用实测包围盒迭代收敛到目标值。
"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
FONT_PATH = os.path.join(OUT_DIR, "fonts", "PangPangZhu.otf")

WHITE = (255, 255, 255, 255)
BLACK = (0, 0, 0, 255)
CLEAR = (0, 0, 0, 0)
CHAR = "豆"

# 墨迹最长边占画布比例
GLYPH_FULL = 0.70   # 完整图标：方形画布，四种比例里唯一没有「安全圆」约束的一层
GLYPH_LAYER = 0.47  # 前景层 / 蒙版层：受 66dp 安全圆约束，0.47 让字形占可见圆约 77%，
                    # 且最远墨迹半径 0.291 < 安全半径 0.306（实测；0.48 是上限，0.50 切角）

# Android 自适应图标：可见安全区是 108dp 图层中央的 66dp 直径圆
SAFE_CIRCLE = 66 / 108
SAFE_RADIUS = SAFE_CIRCLE / 2


def render_glyph(char, ratio):
    """把字形画在透明蒙版上：墨迹最长边收敛到 ratio×SIZE，且墨迹包围盒精确居中。

    返回 (L 模式蒙版, 墨迹包围盒)。字号由实测包围盒反解，所以 ratio 就是墨迹占比本身。
    """
    measure = ImageDraw.Draw(Image.new("L", (1, 1)))
    probe = ImageFont.truetype(FONT_PATH, 256)
    pb = measure.textbbox((0, 0), char, font=probe)
    if pb[2] <= pb[0] or pb[3] <= pb[1]:
        raise SystemExit(f"字体里没有「{char}」的字形（probe bbox={pb}）——换字或换字体，别硬画")

    font_size = round(256 * SIZE * ratio / max(pb[2] - pb[0], pb[3] - pb[1]))
    mask = None
    for _ in range(8):
        img = Image.new("L", (SIZE, SIZE), 0)
        draw = ImageDraw.Draw(img)
        font = ImageFont.truetype(FONT_PATH, font_size)
        tb = draw.textbbox((0, 0), char, font=font)
        draw.text(
            ((SIZE - (tb[2] - tb[0])) / 2 - tb[0], (SIZE - (tb[3] - tb[1])) / 2 - tb[1]),
            char,
            font=font,
            fill=255,
        )
        ink = img.getbbox()
        if ink is None:
            raise SystemExit(f"「{char}」渲染后是空白（字号 {font_size}）")
        got = max(ink[2] - ink[0], ink[3] - ink[1]) / SIZE
        mask = img
        if abs(got - ratio) <= 0.002:
            break
        font_size = max(1, round(font_size * ratio / got))
    else:
        raise SystemExit(f"「{char}」的字号收敛失败（目标 {ratio}，最后落在 {got:.4f}）")

    # 用实测墨迹包围盒再居中一次：textbbox 是含边距的排版框，不等于墨迹
    dx = round(SIZE / 2 - (ink[0] + ink[2]) / 2)
    dy = round(SIZE / 2 - (ink[1] + ink[3]) / 2)
    if dx or dy:
        shifted = Image.new("L", (SIZE, SIZE), 0)
        shifted.paste(mask, (dx, dy))
        mask = shifted
        ink = mask.getbbox()
    if ink[0] <= 0 or ink[1] <= 0 or ink[2] >= SIZE or ink[3] >= SIZE:
        raise SystemExit(f"「{char}」墨迹触到画布边缘（bbox={ink}）——比例 {ratio} 太大，会被裁")
    return mask, ink


def furthest_ink_radius(mask, ink):
    """离画布中心最远的不透明像素距离（相对画布边长）。

    这是「会不会被圆形蒙版切到」的真正判据——包围盒对角线只是它的上界，
    对「豆」这种笔画端点收细的字，包围盒角上其实没墨。
    """
    px = mask.load()
    center = SIZE / 2
    worst = 0.0
    for y in range(ink[1], ink[3]):
        for x in range(ink[0], ink[2]):
            if px[x, y] > 16:
                dist = math.hypot(x + 0.5 - center, y + 0.5 - center) / SIZE
                if dist > worst:
                    worst = dist
    return worst


def paint(mask, background):
    """把单色蒙版上色到指定底色上。"""
    img = Image.new("RGBA", (SIZE, SIZE), background)
    img.paste(Image.new("RGBA", (SIZE, SIZE), BLACK), (0, 0), mask)
    return img


def main():
    full_mask, full_ink = render_glyph(CHAR, GLYPH_FULL)
    layer_mask, layer_ink = render_glyph(CHAR, GLYPH_LAYER)
    layer_radius = furthest_ink_radius(layer_mask, layer_ink)
    # (文件名, 图像, 墨迹包围盒或 None, 最远墨迹半径或 None, 是否受安全圆约束)
    outputs = [
        ("app-icon.png", paint(full_mask, WHITE), full_ink, furthest_ink_radius(full_mask, full_ink), False),
        ("app-icon-bg.png", Image.new("RGBA", (SIZE, SIZE), WHITE), None, None, False),
        ("app-icon-fg.png", paint(layer_mask, CLEAR), layer_ink, layer_radius, True),
        ("app-icon-monochrome.png", paint(layer_mask, CLEAR), layer_ink, layer_radius, True),
    ]

    # 先校验、再落盘：出安全区就一个文件都不写（本仓约定：校验写在任何写操作之前）
    print(f"「{CHAR}」  安全圆占图层 {SAFE_CIRCLE:.3f}（108dp 图层里保证可见的 66dp 圆）")
    failures = []
    for name, _, ink, radius, gated in outputs:
        if ink is None:
            print(f"  {name:26s} 纯色满铺")
            continue
        w, h = ink[2] - ink[0], ink[3] - ink[1]
        note = f"最远墨迹半径 {radius:.3f}"
        if gated:
            note += f" / 安全半径 {SAFE_RADIUS:.3f}"
            if radius > SAFE_RADIUS:
                failures.append(
                    f"{name} 最远墨迹半径 {radius:.3f} 超出安全半径 {SAFE_RADIUS:.3f}，圆形蒙版会切角"
                )
        print(
            f"  {name:26s} 墨迹 {w}×{h}px（{w / SIZE:.3f}×{h / SIZE:.3f}）"
            f" {note} · 占可见圆 {w / SIZE / SAFE_CIRCLE:.1%}"
        )

    if failures:
        print("\n[FAIL] 有图层出安全区，不写任何文件：", file=sys.stderr)
        for line in failures:
            print("  - " + line, file=sys.stderr)
        raise SystemExit(1)

    print()
    for name, img, _, _, _ in outputs:
        path = os.path.join(OUT_DIR, name)
        img.save(path)
        print(f"  [OK] {name:26s} {os.path.getsize(path)} B")
    print(f"\n[OK] 全部图层都在安全区内，已写入 {len(outputs)} 个文件")


if __name__ == "__main__":
    main()
