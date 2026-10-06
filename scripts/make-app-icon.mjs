// 生成 1024×1024 的 App 图标源 PNG，零依赖（只用 node:zlib 与 node:fs）。
//
// 为什么要手写 PNG：`npx tauri icon` 需要一个 ≥1024² 的源图，而本仓没有任何图标资源；
// 为一个图标引入图像处理依赖不值得（`AGENTS.md`：不为了这件事加依赖）。PNG 的最小形态
// 很规整——签名 + IHDR + IDAT(zlib) + IEND，CRC32 与 zlib 都由 Node 标准库给出。
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
const BEADS = 6; // 6×6 颗豆，像一张「拼了一半的图纸」
const MARGIN = 112;
const GAP = 10;

// 装饰用的六个颜色（不取自任何色卡口径，纯图形）
const COLORS = [
  [0x1e, 0x29, 0x3b],
  [0xef, 0x44, 0x44],
  [0xf5, 0x9e, 0x0b],
  [0x22, 0xc5, 0x5e],
  [0x3b, 0x82, 0xf6],
  [0xa8, 0x55, 0xf7],
];

const pixels = new Uint8Array(SIZE * SIZE * 4);
pixels.fill(255); // 不透明白底

const cell = Math.floor((SIZE - 2 * MARGIN - (BEADS - 1) * GAP) / BEADS);
const radius = cell / 2;

for (let row = 0; row < BEADS; row += 1) {
  for (let col = 0; col < BEADS; col += 1) {
    const index = row * BEADS + col;
    if (index % 7 === 3) continue; // 留几个空格子
    const color = COLORS[index % COLORS.length];
    const cx = MARGIN + col * (cell + GAP) + radius;
    const cy = MARGIN + row * (cell + GAP) + radius;
    for (let y = Math.max(0, Math.floor(cy - radius)); y < Math.min(SIZE, Math.ceil(cy + radius)); y += 1) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x < Math.min(SIZE, Math.ceil(cx + radius)); x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > radius * radius) continue;
        const offset = (y * SIZE + x) * 4;
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = 255;
      }
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // 位深
ihdr[9] = 6; // 颜色类型：RGBA
ihdr[10] = 0; // 压缩方法
ihdr[11] = 0; // 过滤方法
ihdr[12] = 0; // 非隔行

// 每行前面加一个过滤字节 0（None）
const stride = SIZE * 4;
const raw = Buffer.alloc(SIZE * (stride + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (stride + 1)] = 0;
  Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(new URL("../app-icon.png", import.meta.url), png);
console.log(`app-icon.png 已生成：${SIZE}×${SIZE}，${png.length} 字节`);
