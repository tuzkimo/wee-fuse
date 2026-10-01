import type { DecodeRequest, Decoder } from "@/core/image/decode";
import type { RgbaImage } from "@/core/image/types";

/** 平台位图的最小接口，便于测试注入假实现。 */
export interface BitmapLike {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** 抽象出所有平台能力，便于在 Node 测试里替换。 */
export interface BitmapPlatform {
  /** 只裁剪、不缩放，得到原生像素。 */
  createRegion(
    source: Blob,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): Promise<BitmapLike>;
  /** 裁剪并按目标尺寸缩放。resizeQuality 交给实现决定。 */
  createRegionResized(
    source: Blob,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    targetWidth: number,
    targetHeight: number,
  ): Promise<BitmapLike>;
  /** 读出位图像素。 */
  readPixels(bitmap: BitmapLike): RgbaImage;
}

interface ResizeOptions extends ImageBitmapOptions {
  resizeWidth?: number;
  resizeHeight?: number;
  resizeQuality?: "pixelated" | "low" | "medium" | "high";
}

/**
 * 快路径：一次 createImageBitmap 完成裁剪 + 缩放。
 *
 * resizeQuality 显式指定为 "high"，避免退化成最近邻。即便如此，各平台 WebView 的
 * 实际滤波质量仍需真机验证（规格 R1），因此保底路径必须同时存在。
 */
export function createFastDecoder(platform: BitmapPlatform): Decoder {
  return {
    name: "fast:createImageBitmap+crop+resize",
    outputSize: "target",
    async decode(source: Blob, request: DecodeRequest): Promise<RgbaImage> {
      const { crop, targetWidth, targetHeight } = request;
      const bitmap = await platform.createRegionResized(
        source,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        targetWidth,
        targetHeight,
      );
      try {
        return platform.readPixels(bitmap);
      } finally {
        bitmap.close();
      }
    },
  };
}

/**
 * 保底路径：只裁剪出原生像素，由 core 的面积平均重采样完成缩放。
 *
 * 画质最好（面积平均是精确的 box filter），但中间位图是原生像素，
 * 大尺寸裁剪会占用大量内存。仅在快路径画质实测不合格时启用。
 */
export function createExactDecoder(platform: BitmapPlatform): Decoder {
  return {
    name: "exact:createImageBitmap+crop → area-average",
    outputSize: "native",
    async decode(source: Blob, request: DecodeRequest): Promise<RgbaImage> {
      const { crop } = request;
      const bitmap = await platform.createRegion(
        source,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
      );
      try {
        return platform.readPixels(bitmap);
      } finally {
        bitmap.close();
      }
    },
  };
}

/** 真实平台实现：基于 createImageBitmap + OffscreenCanvas。 */
export function createDomBitmapPlatform(): BitmapPlatform {
  const requireApi = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) throw new Error(`当前环境不支持 ${name}`);
    return value;
  };

  const createBitmap = requireApi(
    typeof createImageBitmap === "function" ? createImageBitmap : undefined,
    "createImageBitmap",
  );

  const readPixels = (bitmap: BitmapLike): RgbaImage => {
    const width = bitmap.width;
    const height = bitmap.height;
    const source = bitmap as unknown as CanvasImageSource;

    // 优先 OffscreenCanvas；Android WebView 版本较老时回落到 <canvas>。
    // 目标设备是平板，系统 WebView 版本不可控，这条回落值得留着。
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("无法获取 2D 绘图上下文");
      ctx.drawImage(source, 0, 0);
      const imageData = ctx.getImageData(0, 0, width, height);
      return { width, height, data: imageData.data };
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("无法获取 2D 绘图上下文");
    ctx.drawImage(source, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    return { width, height, data: imageData.data };
  };

  return {
    async createRegion(source, sx, sy, sw, sh) {
      return createBitmap(source, sx, sy, sw, sh);
    },
    async createRegionResized(source, sx, sy, sw, sh, targetWidth, targetHeight) {
      const options: ResizeOptions = {
        resizeWidth: targetWidth,
        resizeHeight: targetHeight,
        resizeQuality: "high",
      };
      return createBitmap(source, sx, sy, sw, sh, options);
    },
    readPixels,
  };
}
