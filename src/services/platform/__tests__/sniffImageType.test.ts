import { describe, expect, it } from "vitest";
import { imageFileName, imageNameFromUri, sniffImageType } from "../sniffImageType";

/** 四种格式的真前缀（逐字节），外加两种「像但不是」。 */
const CASES: readonly { readonly note: string; readonly bytes: number[]; readonly type: string }[] = [
  { note: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a], type: "image/png" },
  { note: "JPEG", bytes: [0xff, 0xd8, 0xff, 0xe0], type: "image/jpeg" },
  { note: "WEBP（RIFF + WEBP）", bytes: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], type: "image/webp" },
  { note: "HEIC（ftyp 在第 4 字节）", bytes: [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63], type: "image/heic" },
  { note: "RIFF 但不是 WEBP（例如 WAV）⇒ 不认", bytes: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], type: "application/octet-stream" },
  { note: "全零 ⇒ 回落", bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], type: "application/octet-stream" },
];

describe("sniffImageType", () => {
  for (const testCase of CASES) {
    it(`${testCase.note} ⇒ ${testCase.type}`, () => {
      expect(sniffImageType(new Uint8Array(testCase.bytes))).toBe(testCase.type);
    });
  }

  it("长度不足的截断字节不越界、不谎报（PNG 只剩前两字节 ⇒ 回落）", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBe("application/octet-stream");
    expect(sniffImageType(new Uint8Array([]))).toBe("application/octet-stream");
  });
});

describe("imageNameFromUri", () => {
  it("末段带白名单扩展名 ⇒ 原样保留", () => {
    expect(imageNameFromUri("content://media/external/images/12345.JPEG", "image/jpeg")).toBe("12345.JPEG");
  });

  it("无扩展名的 content:// 末段 ⇒ 回落「相册图片.<ext>」，且 ext 由嗅探结果决定", () => {
    expect(imageNameFromUri("content://media/external/images/media/1", "image/png")).toBe("相册图片.png");
    expect(imageNameFromUri("file:///tmp/x", "application/octet-stream")).toBe("相册图片.bin");
  });

  it("百分号编码的末段（形如 image%3A1234）⇒ 回落，不许把 image:1234 当工程名", () => {
    const name = imageNameFromUri("content://media/external/images/media/image%3A1234", "image/jpeg");
    expect(name).toBe("相册图片.jpg");
    expect(name).not.toContain(":");
  });
});

describe("imageFileName（两个调用点真正用的入口）", () => {
  it("自己嗅字节定扩展名：无扩展名的内容 URI + PNG 字节 ⇒ 相册图片.png", () => {
    expect(imageFileName("content://media/external/images/media/1", new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(
      "相册图片.png",
    );
  });

  it("末段扩展名优先于魔数（刻意口径）：末段是 .jpg 而字节是 PNG ⇒ 仍用末段的名字", () => {
    // 这一条把「先扩展名、后魔数」的判序**写死**：它只影响 `File.name`（进而影响默认工程名），
    // 解码路径不看 `type`，所以宁可保留用户看得懂的原始文件名，也不按字节改名。
    expect(imageFileName("file:///tmp/holiday.jpg", new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("holiday.jpg");
  });
});
