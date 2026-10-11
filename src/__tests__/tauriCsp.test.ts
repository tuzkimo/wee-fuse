/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * `src-tauri/tauri.conf.json` 的 CSP 闸门（2026-10-11 实机缺陷的回归守卫）。
 *
 * **这条闸门修的实机缺陷**：T8 只设了 `app.security.csp`、没设 `devCsp`。而 `tauri-utils` 的
 * `SecurityConfig.csp` 文档逐字写着「If `devCsp` is not specified, this value is also injected on
 * dev.」（`config.rs:3040-3041`），`tauri-2.12.1/src/manager/mod.rs:361-370` 的 `csp()` 也是
 * `dev_csp.or(csp)`，`protocol/tauri.rs:182` 把 `csp_header` 放进响应头。于是在
 * `npx tauri android dev` 里页面（`http://tauri.localhost`，走 Tauri 自定义协议）**也吃这份 CSP**；
 * 而它的 `connect-src` 只有 `ipc: http://ipc.localhost`、**没有 `ws:`** ⇒ Vite 的 HMR WebSocket
 * 被拦死（logcat 里是 `Tauri/Console: [vite] Direct websocket connection fallback ... the previous
 * connection error`）⇒ Vite 客户端 polling 成功后 `location.reload()` ⇒ SPA 重启、内存里的
 * `draft` 丢失、当前路径 `/new` 原地重绘。用户看到的是「拍照 / 分享后自动跳回选图页」。
 *
 * **为什么两条都要断**：只断 dev 允许 `ws:` 的话，把 devCsp 直接删掉会红（对），但把 `ws:` 塞进
 * 生产 `csp` 也会绿——那等于为了让 dev 能跑，把生产 WebView 的 `connect-src` 放开到任意 ws。
 * 所以生产必须**不含** `ws:`，dev 必须**含**。`?raw` 读文本、`JSON.parse` 断字段（同
 * `platformGate.test.ts` 的 `import.meta.glob` + 词法判据手法）。
 */
const CONFIG: Record<string, string> = import.meta.glob<string>("../../src-tauri/tauri.conf.json", {
  eager: true,
  query: "?raw",
  import: "default",
});

const CONFIG_PATH = "../../src-tauri/tauri.conf.json";

interface TauriConfig {
  readonly app?: {
    readonly security?: {
      readonly csp?: unknown;
      readonly devCsp?: unknown;
    };
  };
}

const raw = CONFIG[CONFIG_PATH];
if (raw === undefined) throw new Error(`读不到 ${CONFIG_PATH}（glob 的语料库变了？）`);
const config = JSON.parse(raw) as TauriConfig;
const security = config.app?.security;
if (security === undefined) throw new Error("配置里没有 app.security");

function directive(csp: string, name: string): string {
  const found = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
  if (found === undefined) throw new Error(`CSP 里没有 ${name} 指令：${csp}`);
  return found;
}

describe("app.security.csp（生产）", () => {
  it("保留 IPC 与 data:/blob: 图源，且不放开 ws（生产 WebView 没有 HMR）", () => {
    expect(typeof security.csp).toBe("string");
    const csp = security.csp as string;
    expect(directive(csp, "connect-src")).toBe("connect-src ipc: http://ipc.localhost");
    expect(directive(csp, "img-src")).toContain("data:");
    expect(directive(csp, "img-src")).toContain("blob:");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(csp).not.toContain("ws:");
  });
});

describe("app.security.devCsp（dev 包）", () => {
  it("存在，且 connect-src 允许 Vite 的 HMR WebSocket", () => {
    expect(typeof security.devCsp).toBe("string");
    const csp = security.devCsp as string;
    // HMR 的 ws 地址随部署而变（adb reverse 下是 localhost、LAN 下是设备 IP、
    // Vite 的 direct 回退还会换 host）⇒ 认**协议源** `ws:`，不认具体主机。
    expect(directive(csp, "connect-src")).toContain("ws:");
    // dev 的页面（tauri.localhost）自己发起的同源请求（Vite 的 restart 轮询）也要放行。
    expect(directive(csp, "connect-src")).toContain("'self'");
    expect(directive(csp, "connect-src")).toContain("ipc: http://ipc.localhost");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
  });
});
