# Android 发布指南

WeeFuse 的出包与发布说明。内容原在 `README.md` 的「正式版发布」一段，2026-10-07 随
[「README 与开发记录分离」](superpowers/specs/2026-10-07-readme-and-dev-notes-restructure-design.md)
移到这里——README 只留「一句话指路」。

## 正式版发布（在线）

推 `v*` tag ⇒ Actions 的 **`release-android`** 工作流在 GitHub 机器上出 arm64 **已签名** release APK
（`WeeFuse_<tag>_arm64.apk`）并自动挂 GitHub Release。

- **只发布正式版本，没有手动入口**：2026-10-07 起照 `wee-count` 的 `release-android.yml` 收窄——
  原先「`workflow_dispatch` 手动出 debug 包」那条已撤掉。理由是**签名 release 的 CI 路径已经跑通**
  （run `37604348081` 的产物同时含 `weefuse-release-apk` ✓），手动入口买不到额外信息，
  只多一个「手动跑要不要发 Release」的分支判断。
- **tag 必须与 `src-tauri/tauri.conf.json` 的版本号一致**（工作流第 2 步会校验，不一致就红）。
- **四个签名 secret 缺任何一个都在第一步响亮失败**（不是跳过 release）：那四个 secret 已配置好 ✓（2026-10-07）。

## 签名材料（本地，**绝不允许入库**）

| 用途 | 路径 |
|---|---|
| 钥匙 | `src-tauri/gen/android/weefuse.jks` |
| 口令与别名 | `src-tauri/gen/android/app/key.properties`（`storeFile` / `storePassword` / `keyAlias` / `keyPassword`） |

这两个文件**绝不能入库**（`.gitignore` 已挡 `*.jks` / `*.p12`，`key.properties` 也在忽略清单里）。

> **危险点**：它们与 `src-tauri/gen/android/**` 处在同一个目录，而那个目录是**入库**的
> （裁决 6：为「换台机器就能重建」）。所以**每次换机器 / 重建工程之后，必须用 `git check-ignore -v`
> 复验这两个文件仍被忽略**，不要只看目录在不在。

本地 `npx tauri android build --apk` 直接出**已签名** release 包 ✓
（2026-10-07 实测：本地产物指纹与 CI 产物一致）。

## 换钥匙

```bash
keytool -genkeypair -v -keystore src-tauri/gen/android/weefuse.jks -alias weefuse \
  -keyalg RSA -keysize 2048 -validity 10000
```

⇒ 改 `src-tauri/gen/android/app/key.properties` ⇒ 用

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("…\weefuse.jks"))
```

更新 CI 的 **`ANDROID_KEYSTORE_BASE64`**；另三个 secret 同步改：

| secret | 对应 `key.properties` 的字段 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `weefuse.jks` 的 base64 全文 |
| `ANDROID_KEYSTORE_PASSWORD` | `storePassword` |
| `ANDROID_KEY_ALIAS` | `keyAlias` |
| `ANDROID_KEY_PASSWORD` | `keyPassword` |

## 维护须知：`tauri init` 会把工程改回模板

`src-tauri/gen/android/**` 入库，其中有**三处是手改**：

1. 图标 mipmap；
2. `MainActivity.kt` 的 insets 消费；
3. `app/build.gradle.kts` 的 release 签名块（`keystoreProperties` + `signingConfigs.create("release")` + release 挂钩）。

**重跑 `npx tauri android init` 会把这三处一起改回模板** ⇒ 重跑**之前**先读
[B5 构建记录](superpowers/notes/2026-10-06-app-b5-build-log.md) 的维护须知（§6 的 B5-15），
重跑**之后**必须复验「图标是不是我们的」与「页面顶部有没有被系统栏盖住」。

**正确顺序是 `android init` → `npx tauri icon app-icon.png`**；反过来是**静默失效**（装出来是 Tauri logo）。

另有一条未 pin 项：`android/app/build.gradle.kts` 未固定 `ndkVersion`（B5-11），NDK 升级会静默换版本。

## 相关文档

- [B5 设计规格](superpowers/specs/2026-10-06-app-b5-tauri-shell-design.md) / [实现计划](superpowers/plans/2026-10-06-app-b5-tauri-shell.md)
- [B5 构建记录](superpowers/notes/2026-10-06-app-b5-build-log.md)：§6 延后项、§7 未验证面、§8 的 CI 提案与落地结果
- [B4 构建记录 §7.1](superpowers/notes/2026-10-05-app-b4-build-log.md)：`EXPORT_MAX_EDGE` 的真机读数与预登记规则
