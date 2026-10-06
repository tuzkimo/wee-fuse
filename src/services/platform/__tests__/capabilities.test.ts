import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPlatform } from "../browserPlatform";
import { getPlatform, isTauriRuntime, setPlatform } from "../capabilities";
import type { Platform } from "../types";

/** 一个最小的假实现，用来验证注入真的换了实现。 */
function fakePlatform(): Platform {
  return {
    imagePicking: {
      kind: "native-picker",
      canCapture: true,
      pickFromAlbum: async () => null,
      capturePhoto: async () => null,
    },
    shareInbox: { supported: true, takeSharedImage: async () => null, onSharedImage: () => () => undefined },
    album: { kind: "album", save: async () => undefined },
    lifecycle: {
      onExitRequested: () => () => undefined,
      onBackButton: () => () => undefined,
      exit: async () => undefined,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setPlatform(browserPlatform);
});

describe("capabilities", () => {
  it("未注入时就是浏览器实现（不是抛错）", () => {
    expect(getPlatform()).toBe(browserPlatform);
    expect(getPlatform().album.kind).toBe("download");
  });

  it("setPlatform 之后 getPlatform 返回新实现", () => {
    const fake = fakePlatform();
    setPlatform(fake);
    expect(getPlatform()).toBe(fake);
    expect(getPlatform().imagePicking.kind).toBe("native-picker");
  });

  it("setPlatform 收到非对象时响亮失败（不静默把实现置成 undefined）", () => {
    expect(() => setPlatform(undefined as unknown as Platform)).toThrowError("平台实现必须是对象");
    expect(() => setPlatform(null as unknown as Platform)).toThrowError("平台实现必须是对象");
  });

  it("isTauriRuntime：全局缺失 / false / true 三态，且只认布尔 true", () => {
    expect(isTauriRuntime()).toBe(false); // 缺失
    vi.stubGlobal("isTauri", false);
    expect(isTauriRuntime()).toBe(false);
    vi.stubGlobal("isTauri", "yes");
    expect(isTauriRuntime()).toBe(false); // 只认布尔 true，不认真值
    vi.stubGlobal("isTauri", true);
    expect(isTauriRuntime()).toBe(true);
  });
});
