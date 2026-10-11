# 审计整改构建记录：Task 7 收窄 Android 权限

- 日期：2026-10-11
- 计划：`docs/superpowers/plans/2026-10-11-audit-fixes.md`，任务 7
- 规格：`docs/superpowers/specs/2026-10-11-audit-fixes-design.md`（§第 3 条 fs scope、§第 6 条 INTERNET）
- 提交信息：`chore(tauri): release 去掉 INTERNET 权限并收窄 fs scope`（本记录与改动同一提交）

## 1. 改了什么

| 文件 | 改动 |
|---|---|
| `src-tauri/gen/android/app/src/main/AndroidManifest.xml` | 删除 `<uses-permission android:name="android.permission.INTERNET" />` |
| `src-tauri/gen/android/app/src/debug/AndroidManifest.xml` | 新建；只声明 `INTERNET`（dev server 走 `http://localhost:1420`） |
| `src-tauri/capabilities/default.json` | 删除整个 `fs:scope` 对象（原 `allow: [{ path: "**" }]`），只留 `fs:allow-read-file`；理由写进 `description` |
| `docs/开发约定详解.md` | 「平台壳」节补一条维护口径：release 无 `INTERNET`、debug 专用清单才有；`capabilities` 不放 `fs:scope` |

## 2. 命令与结果

- `git diff --name-only`（改动文件）：

  ```
  docs/开发约定详解.md
  src-tauri/capabilities/default.json
  src-tauri/gen/android/app/src/main/AndroidManifest.xml
  ```

  另加未跟踪的新文件 `src-tauri/gen/android/app/src/debug/AndroidManifest.xml`。

- `node -e "JSON.parse(...)"` 校验 `capabilities/default.json`：**JSON OK**（删除 `fs:scope` 后语法有效）。

- `npm run test`：**82 文件 / 1462 用例全绿**（前端未改动，确认无回归）。

- `npm run build`（`vue-tsc --noEmit` + `vite build`）：**通过**，`✓ built in 2.11s`。

- `npx tauri android build --apk --debug`：**成功**。

  ```
  Finished 1 APK at:
      D:\projects\my\wee-fuse\src-tauri\gen/android\app/build/outputs/apk/universal/debug/app-universal-debug.apk
  ```

- **debug 合并清单仍含 `INTERNET`**：

  ```
  $ grep -n "INTERNET" src-tauri/gen/android/app/build/intermediates/merged_manifests/universalDebug/processUniversalDebugManifest/AndroidManifest.xml
  11:    <uses-permission android:name="android.permission.INTERNET" />

  $ grep -n "INTERNET" src-tauri/gen/android/app/build/intermediates/merged_manifests/arm64Debug/processArm64DebugManifest/AndroidManifest.xml
  11:    <uses-permission android:name="android.permission.INTERNET" />
  ```

  证明 debug 专用清单被正确合并（`tauri android dev` 的联网能力不变）。

- **release 清单不再声明 `INTERNET`**：本机未产出 release 构建产物
  （`find src-tauri/gen/android/app/build -path "*release*" -name AndroidManifest.xml` 无结果），
  故以**真源清单**为证：

  ```
  $ grep -c "INTERNET" src-tauri/gen/android/app/src/main/AndroidManifest.xml
  0
  ```

  即 release（`main`）+ 无 debug 覆盖时不再有联网权限。发布前若跑 `--release`，应复核合并清单里无 `INTERNET`。

## 3. PENDING 人工验证（本机无 adb 设备，**未做**）

以下三项在 CI/无设备环境**零判别力**，必须在真机上完成并回填结果：

1. [ ] `npx tauri android dev`：App 能连上 dev server 并正常打开（证明 debug 清单被合并、`INTERNET` 仍在）。
2. [ ] 装机后从相册 / 别的 App 分享一张图进 App：能进入选区页
   （证明去掉 `fs:scope` 后 mobile 的 `content://` 读取仍可用）。
3. [ ] （Task 8，CSP 落地后）真机跑一次：首页图纸库能加载（IPC + IndexedDB 不受 CSP 影响）→
   打开一条工程的「查看施工图」（`blob:` 图能显示）→ 点「保存」（相册写入成功）→ 分享一张图进来（App 内交互正常）。
   任何一步白屏就回退 CSP 并记录原因。

> 说明：第 1、2 项对应任务 7 的验收；第 3 项属任务 8，集中记在此处避免两处记录漂移。
> 上述均**未验证**，不得据此声称通过。

---

# 审计整改构建记录：Task 8 给 WebView 加 CSP

- 日期：2026-10-11
- 计划：`docs/superpowers/plans/2026-10-11-audit-fixes.md`，任务 8
- 规格：`docs/superpowers/specs/2026-10-11-audit-fixes-design.md`
- 提交信息：`chore(tauri): 为 WebView 配置内容安全策略`

## 1. 改了什么

| 文件 | 改动 |
|---|---|
| `src-tauri/tauri.conf.json` | `app.security.csp` 由 `null` 改为策略字符串（保留 Tauri IPC 与 `data:` / `blob:` 图片） |

改后的 `app.security` 块：

```json
"security": {
  "csp": "default-src 'self'; script-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'"
}
```

`connect-src` 含 `ipc: http://ipc.localhost`（否则 `invoke` 全挂）；`img-src` 含 `data:`（缩略图）与 `blob:`（施工图 object URL）。

## 2. 命令与结果

- `node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')); console.log('config JSON valid')"`：**`config JSON valid`**。

- `npm run build`（`vue-tsc --noEmit` + `vite build`）：**通过**，`✓ built in 1.80s`。

- `cargo check --manifest-path src-tauri/Cargo.toml`：**通过**；该命令经 `tauri::generate_context!` 解析 `tauri.conf.json`，是 CI 里唯一能证明配置合法的检查。

  ```
     Compiling weefuse v0.12.1 (D:\projects\my\wee-fuse\src-tauri)
      Finished `dev` profile [unoptimized + debuginfo] target(s) in 9.09s
  ```

- `npm run test`：**82 文件 / 1462 用例全绿**（前端未改动，确认无回归）。

## 3. PENDING 人工验证（本机无 adb 设备，**未做**）

Task 8 的真机验收项即上文 Task 7 PENDING 清单的第 3 项（首页加载 → `blob:` 施工图 → 保存 → 分享），
为避免两处记录漂移，此处不重复，结果仍为**未验证**。任何一步白屏即回退 CSP 并记录原因。

补充口径（已由控制者核实，无需真机复核）：Tauri 的 `csp` 只注入 Tauri 自身 asset resolver 提供的 HTML，
不注入外部 dev server；本应用 dev 流程（`tauri android dev` → Vite :1420）是外部服务，故该 CSP 不影响开发 HMR，
`devCsp` 未设也不影响。
