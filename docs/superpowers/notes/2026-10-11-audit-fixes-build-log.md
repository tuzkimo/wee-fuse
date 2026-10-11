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
