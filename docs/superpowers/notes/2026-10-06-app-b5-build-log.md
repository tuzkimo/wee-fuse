# 计划 B5（Tauri Android 壳）构建记录

> **本文件的状态（2026-10-06，任务 2 进行中）**：控制者先把**自己那侧的**内容写进来
> （§4 控制者的错误清单、§3 平台事实与被推翻的结论、§6 已接受的延后项骨架、§7 未验证面），
> 因为账本（`.superpowers/**`）**不入库**，而那几节的内容必须留在仓库里。
> **§1 的账目、§2 的 spike 六判据原始读数、§5 的人工清单结果**由**收尾任务**（任务 8）在任务 2–7 跑完后补齐；
> 本节标题里的「任务 2 进行中」届时一并改掉。**本文件里不许残留任何填写指令式的占位符**。

- 分支：`main` 就地执行（照 B1–B4 先例）
- 规格（权威）：`docs/superpowers/specs/2026-10-06-app-b5-tauri-shell-design.md`
- 计划：`docs/superpowers/plans/2026-10-06-app-b5-tauri-shell.md`
- 账本（**不入库**）：`.superpowers/sdd/2026-10-06-app-b5-tauri-shell/progress.md`

---

## 1. 交付物与账目

**基线**（起飞前，2026-10-06）：`62 文件 / 1137 用例`（分解式 `1054 + 28 + 54 + 1 = 1137`）。

| 时点 | 文件 / 用例 | 说明 |
|---|---|---|
| 任务 0 完成后 | **65 / 1164** | 平台能力层：4 实现 + 4 测试文件（含两实现共用的契约），修复轮 +6 条 |
| 任务 1 完成后 | **66 / 1169** | 壳骨架：新增 `src/__tests__/platformGate.test.ts`（5 条，其中 **G1 / G3b / G4 故意红**） |
| 任务 2 完成后 | **69 / 1194** | spike 探路：3 个新测试文件（`sniffImageType` / `tauriPlatform` / `ShellProbePage`）+ 路由追加 1 条 = **+25**；闸门只剩 **G4** 故意红 |
| 任务 8 收尾时 | 由收尾任务回原始清单重数并给闭合分解式 | 计数口径见 README 的既有段落；**分解式对不上先怀疑仪器**（B4 记过两次仪器错） |

**任务 0 / 1 的关键原始读数**（控制者自己跑，不是采信自述）：

```text
任务 0：npm run test → Test Files 65 passed (65) / Tests 1164 passed (1164)（默认与 TZ=UTC 各一次）
         exporter.test.ts → Test Files 1 passed (1) / Tests 30 passed (30)（该文件本轮 0 条提交 = 未改）
任务 1：npm run test → Test Files 1 failed | 65 passed (66) / Tests 3 failed | 1166 passed (1169)
         3 条红恰为 G1 / G3b / G4（故意红，阶梯见计划）
         npx vitest run src/__tests__/platformGate.test.ts → Tests 3 failed | 2 passed (5)
         npm run build → ✓；cargo check --manifest-path src-tauri/Cargo.toml → Finished dev profile … in 0.28s
任务 1 APK：src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
         457,149,528 字节（435.97 MB；debug + 四 ABI，正常偏大）
```

---

## 2. spike 六判据的原始读数（任务 2）

**由收尾任务补齐**：F（装机与首屏）/ A（裸 `<input type=file>`）/ B（`capture="environment"`）/
C（`ACTION_SEND` → `RunEvent::Opened` + 原始字节体）/ D（MediaStore 存相册）/ E（返回键与关闭请求）——
每条的「复制为文本」整段原文 + `adb logcat` 的三行原文，**不许摘要**。

---

## 3. 被推翻的结论与平台事实（本轮已确凿的部分）

### 3.1 平台事实（实测，带证据）

| # | 事实 | 证据 |
|---|---|---|
| P1 | **`RunEvent` 只有 9 个变体**（`Exit` / `ExitRequested` / `WindowEvent` / `WebviewEvent` / `Ready` / `Resumed` / `MainEventsCleared` / `MenuEvent` / `TrayIconEvent`）⇒ **没有 `Paused` / `Suspended`** | docs.rs `tauri 2.12.1` 的 `RunEvent` 页 |
| P2 | **`RunEvent::Opened` 是 cfg 到 macOS / iOS / Android 的**（docs.rs 默认 target 的枚举里没有它）⇒ Rust 侧必须 `#[cfg(...)]` 圈住，否则 **CI 的桌面 `cargo check` 编译失败** | 同上 + 实现里的 `#[cfg]` |
| P3 | **分享进入有官方路径**：`bundle.fileAssociations` 自动生成 Android `intent-filter`，`androidIntentActionFilters` **默认含 `Send` / `SendMultiple` / `View`** ⇒ 不需要自己写 Kotlin 收 intent | 官方 File Associations on Mobile 文档 |
| P4 | **返回键**：`@tauri-apps/api/app` 的 `onBackButtonPress`（payload `{canGoBack}`）；**一旦注册监听器，默认导航被完全抑制** ⇒ 导航必须自己做 | PR #14133 的 `AppPlugin.kt`（`hasListener` 为真时只 `trigger`、不导航） |
| P5 | **`plugin-dialog` 在 Android 返回 `content://` URI**；`plugin-fs` 官方口径「works with any path format」 | 官方 Dialog 插件文档 |
| P6 | **官方没有任何「保存到相册 / 系统分享」插件** ⇒ MediaStore 必须自己写 Kotlin 移动插件 | 官方插件目录 |
| P7 | **AGP 会在构建期自动下载并装进系统 SDK**：本轮 `$ANDROID_HOME/platforms/android-37.0`（created 2026-10-06 11:21:14）与 `build-tools/36.0.0` 是 `npx tauri android build` 期间被装上的（`android.builder.sdkDownload` 默认开启 + `licenses/` 已接受） | 目录 creation time + 构建日志里的 `Installing Android SDK Platform 37.0 … complete.` |
| P8 | **gradle wrapper 要 `gradle-9.6.1`**（本机 `~/.gradle` 缓存里只有 8.14.3 ⇒ 首次构建现下载 100%） | `gen/android/gradle/wrapper/gradle-wrapper.properties` + 构建日志 |
| P9 | **构建前提：`package.json` 必须有 `"tauri": "tauri"` script**。gradle 的 `:app:rustBuild{Arm,Arm64,X86,X86_64}Debug` 会执行 `npm run -- tauri android android-studio-script`；缺它四个任务全失败（`npm error Missing script: "tauri"`），实测第一次 build 因此失败、耗时 **531.9 s** | 构建日志 + 修复后第二次 build 成功（133.6 s） |
| P10 | **`npx tauri android init` 不改写已有文件**：重跑之后 `strings.xml` 哈希不变、`git status --short` 为空 ⇒ 手工改的 `app_name` 不会被冲掉（**这是裁决 6「`gen/android` 入库」成立的关键证据**） | 实现者的 reinit 实测 + 控制者的 `git status --short -- src-tauri/gen` 零改动复核 |
| P11 | **`gen/android` 自带的 `.gitignore`** 忽略 `build` / `.gradle` / `local.properties` / `key.properties` / `keystore.properties` / `/.tauri` / **`/tauri.settings.gradle`**（后者是 CLI 构建期生成、把插件 gradle 工程接进来的胶水文件，忽略它是对的） | 生成工程里的 `.gitignore` + `git check-ignore -v` |
| P12 | **debug + 四 ABI 的 universal APK ≈ 436 MB**（含调试符号）；`minSdk = 29`（由 `bundle.android.minSdkVersion` 生成，**不是手改**）；模板实际 `compileSdk/targetSdk = 37`、`JavaVersion.VERSION_1_8` / `JvmTarget.JVM_1_8`、**未 pin `ndkVersion`** | `gen/android/app/build.gradle.kts` + APK 字节数 |
| P13 | **Tauri 的 Android 模板用 `compileSdk = 37`**（dev 分支；本机 SDK 原本只有 `android-36/36.1`）——缺的平台由 P7 的自动下载解决，**因此「降到 36」那一级从未触发** | 官方模板 + 本机实测 |
| P14 | **`tauri android build` 每次都会重写两个「被忽略」的接线文件**：`gen/android/tauri.settings.gradle` 与 `gen/android/app/tauri.build.gradle.kts`，里面是**本机绝对路径** ⇒ 它们**必须继续被忽略**（现有规则已覆盖）。**推论**：构建会自己重新生成它们，**「换机器要先 `tauri android init`」不成立**（两次构建实测都没有改动任何**被跟踪**的 `gen/android` 文件） | 任务 2 的 §6.2 判定实测 + 控制者的 `git status --short -- src-tauri/gen` 零改动复核 |
| P15 | **`cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-linux-android` 可用且廉价**（首次 14.9 s、缓存后 0.34 s，exit 0）——**它是唯一能在 CI/本机抓住「只在 Android target 现形」缺陷的检查**（本轮那两处 E0599/E0716 正是靠真机构建才抓到） | 任务 2 的新读数 + 控制者亲手复跑 |
| P16 | **npm 侧依赖是运行时依赖**：`tauriDriver.ts` 动态 import 的 `@tauri-apps/api` / `plugin-dialog` / `plugin-fs` 必须放 `dependencies`（要打进产物），不是 `devDependencies`。**这是计划的硬缺口**（计划正文只提到包名、没有安装步骤）⇒ 不装则 `vue-tsc` TS2307、Vite 解析失败、**APK 根本出不来** | 任务 2 的安装结果 + `package.json` + 控制者裁决 |
| P17 | **插件的 `permissions/**` 是 `cargo check` 期由 `tauri_plugin::Builder::build()` 写进源码树的产物**（生成路径由插件框架定死、实测确定性）⇒ **保留入库**（否则每次 `cargo check` 都会弄脏工作区）。**如实登记**：它们不是有意入库的（`git add src-tauri/plugins` 顺手带进来），保留是事后追认 | 任务 2 实测 + 控制者裁决 |
| P18 | **动态 `import()` 的壳侧代码在产物里真的是惰性的**（控制者复核）：`dist/assets/*.js` 里 `@tauri-apps` 出现 **0 次**（无裸说明符 ⇒ 浏览器端不会解析失败）；`core-*.js` / `window-*.js` 两个独立 chunk 含 `__TAURI_INTERNALS__`；**主 chunk（110.5 KB）既不含 `__TAURI_INTERNALS__` 也不含 `loadTauriDriver`** ⇒ 浏览器启动路径**根本不加载**壳侧代码 | 控制者对 `dist` 的扫描（2026-10-06） |

### 3.2 被推翻的结论（**本轮改掉的判断，逐条留档**）

| # | 曾经的判断 | 实际 | 影响 |
|---|---|---|---|
| R1 | 「计划步骤 4 的 `cargo check` 排在步骤 5 的图标之前没问题」 | **错**：Windows 上 `tauri-build` 生成资源文件要读 `icons/icon.ico`（由 `npx tauri icon` 产出）⇒ 先跑必失败（`` `…\icons/icon.ico` not found ``） | 计划加顺序更正注记 |
| R2 | 「`compileSdk = 37` 会让构建失败，需要先问人类伙伴再装 SDK 组件」 | **错**（结果层面）：AGP 自己把平台装上了（P7）。**但红线的判断仍然有效**——只是**被工具链绕过了**，没有人做过这个决定 | 升级规则补一条：体检「有没有 `sdkmanager`」不足以判断构建会不会动系统 SDK，真正决定它的是 `android.builder.sdkDownload` + licenses 状态 |
| R3 | 「`git status --short <目录>` 能看到未跟踪目录里的文件清单」 | **错**：它会**折叠**成一行（`?? src-tauri/gen/`），要看清单必须 `--untracked-files=all` | 计划里的取证命令更正 |
| R4 | 「任务 1 之后用例数是 66 / 1163（基线 65 / 1158）」 | **错**：真值 **66 / 1169**（基线 65 / 1164，任务 0 修复轮 +6） | 计划更正。**与 `exporter.test.ts` 的 29→30 是同一类错：跨轮抄数字没回原始清单重数** |
| R5 | 「G1 会在任务 2 建出 `tauriDriver.ts` 后转绿」 | **只对了一半**：`src/__tests__/coreBoundary.test.ts` 把 `"@tauri-apps/api/core"` 当**数据**用 ⇒ G1 会一直命中它 | G1 的扫描范围排除测试文件（提交 `925599a`），理由与 core 扫描同一处置 |
| R6 | 「`sniffImageType.ts` 的『长度不足』守卫删掉会让『截断字节』那条用例转红」（计划 V5） | **错（实测 0 红）**：`Uint8Array` 越界读恒为 `undefined`，与任何魔数字节都不相等 ⇒ 循环自己收敛。**这不是断言无效**，是这道守卫在当前载体上不承重 | 计划更正 V5；JSDoc 写明保留理由（显式判据 + 换载体时行为不变） |
| R7 | 「`gradlew` 的可执行位无所谓」 | **错**：`git ls-files -s` 显示 **100644**（应为 100755）；不影响本项目构建路径（走 `npm run -- tauri …`，不经 `./gradlew`），但 Unix 上手动 `./gradlew` 会 permission denied | `git update-index --chmod=+x`（提交 `24bb266`/`135fb1a`） |
| R8 | 「`.gitattributes` 的 `* text=auto eol=lf` 会让新克隆里的 `gradlew.bat` 变 LF」 | **成立**（风险真实），实测工作副本是 CRLF、`git check-attr` 显示 `gradlew.bat → eol: crlf`（新规则生效） | 追加 `*.bat text eol=crlf` 与 `gradlew text eol=lf` |
| R9 | 「计划里的 Rust 壳代码只要桌面 `cargo check` 过就没问题」 | **错**：`#[cfg(target_os = "android")]` 与 `RunEvent::Opened` 那段整块在桌面 target 上**根本不参与编译** ⇒ **mobile-only 代码从不被 CI 类型检查**。任务 2 实跑 `tauri android build`（编 aarch64-linux-android）时抓到两处：① `app.state::<OpenedUris>().0.lock()` 是**临时值**，语句结束即释放而 `guard` 后面还要用 ⇒ `error[E0716]`（先绑 `let state = …`）；② 插件移动端路径缺 `tauri::Manager` 引入 | 提交 `afc0ed0`；并记入下面的「未验证面」 |
| R10 | 「脚手架（把 `/` 重定向到 `/lab/shell`）留在仓库里会被测试发现」 | **错**：S1 在位时 `npm run test` 仍是 **1193 passed / 1 failed（只有 G4）**——**没有任何用例读 `/` 的落点** ⇒ 全靠 `Select-String -Pattern "redirect"` 人工复验。**这是本计划的一处危险面**：一个「临时脚手架忘了撤」不会被 CI 拦下，而它会把整个 App 的首屏换成实验台 | 计划的任务 2 步骤里写了那条 `Select-String` 复验（本轮 `HIT_COUNT=0` ✔）；**建议**（未做，属后续项）：加一条用例断言「`/` 的名字是 `home` 且不是重定向」（审查给了机理：vue-router 4 的 `resolve` **不追重定向**，所以既有那条 `resolve({name:"home"}).path === "/"` 对重定向与换组件**都照样绿**） |
| R11 | 「请求体用裸 `Uint8Array`（`InvokeBody::Raw`）传图像字节」——**计划与规格 D3 的核心设计** | **错（在 Android 上必然失败）**：`tauri-2.12.1/src/ipc/mod.rs:54-56` 的厂商原文——**Android 上 `InvokeBody::Raw` 不被支持，枚举里恒为 `InvokeBody::Json`**，并建议改用 **base64 字符串**（比数字数组省 4 倍）。⇒ `src-tauri/src/lib.rs` 的 `let Some(InvokeBody::Raw(..)) = … else { Err("保存失败：需要原始字节体") }` **必然命中** ⇒ **判据 C 的「原始字节体」与判据 D 必然失败**，三层字节核对在任何环境都跑不到（桌面在 `save_with_platform` 之前就返回「本平台不支持写入相册」） | 已派修复轮：**改 base64 JSON 请求体**（规格 B5-R4 的退路正式启用）+ 探针页读数结构跟着改 + 重建两份 APK。**发现时机关键**：人类伙伴尚未开始跑 A–E ⇒ 这一趟没白费。**教训**：跨语言/跨进程的能力边界**要读厂商源码里的「不支持」清单**，不能只读 API 签名——`InvokeBody::Raw` 在 Rust 侧类型完全合法，是**运行时**在 Android 上永不填充 |

---

## 4. 控制者自己的错误清单（逐条如实，**不去美化**）

1. **计划里的跨语言接线缺陷（最贵的一处）**：`mobile.rs` 写 `run_mobile_plugin::<String>`，而 Kotlin resolve 的是**对象** `{uri, bytes}`
   ⇒ 真机上必然反序列化失败；同时 `lib.rs` 返回的是 **Rust 自己数的**字节数，让规格 §5.4.1 承诺的「三层字节核对」**当时是假的**。
   抓到方式：把三段（JS ↔ Rust ↔ Kotlin）当**一条链**逐段对类型。提交 `2f2957f`。
2. **自己写的闸门会永久红**：`platformGate` 的 **G2** 循环没跳过闸门文件自身，而文件里那个正则字面量 `/…\bisTauri\b/` 不是字符串、`stripStrings` 剥不掉 ⇒ 它会把自己判违规。
   教训顺带一条：`stripComments` 不认识正则字面量（`\//` 之后的该行内容会被吞）。
3. **`tauriDriver` 声明了 `pickImageFile()` 却没实现**（`pickViaDialog` 是模块级导出）⇒ `vue-tsc` 会直接红。
4. **热启动事件的 payload 类型对不上**：Rust 发**数组**、驱动 `listen<string>` 收**单个字符串** ⇒ 每次热启动都会被 `typeof first !== "string"` 判成「分享内容不是文件」（静默形态）。
5. **路由用例永远红**：我原先直接比较懒加载路由的 `components.default`（那是 **loader 函数**）与组件默认导出。
6. **仪器错误 ×4**：
   ① 变异脚本用 `$ErrorActionPreference = "Stop"` 配原生命令 ⇒ 脚本在**还原之前**退出，把 `guards.ts` 留在变异态（靠 `git checkout --` 救回）；
   ② 抽计划里的代码块用 `StartsWith('```js')`，而 `'```json'.StartsWith('```js')` **为真** ⇒ 抽到了 JSON 块（教训：用**块内唯一标记**定位）；
   ③ 用 `git show | Out-String` 与磁盘内容做字符串比较来判断「文件有没有变」⇒ 假阴性（`Out-String` 补尾随换行）；判「有没有变」**一律用 `git status` / `git diff --exit-code`**；
   ④ PowerShell 命令里带中文 + `$(` ⇒ 解析崩（教训：**脚本 ASCII-only，中文只出现在被处理的数据里**）。
7. **记账错误 ×2**：
   ① 派任务 0 的提示词里写「严格 9 个文件」，实际 **10 个**（4 实现 + 4 测试 + 2 修改）；
   ② 修复轮的删除行审计我列 7 项却写「8 行」，且**漏列恰好是被加强的两行代码**（`const add = vi.spyOn(...)` 与 `await h.platform.album.save(...)`）⇒ 读者无法从账目自证「只有加强、没有削弱」这个结论（结论本身经复审独立复核仍成立）。
8. **误读起草片段**：我在派发摘要里写「起草者让 `change` 无文件时走 reject」，核对其逐字代码后**不成立**（空列表就是取消）。已更正留档。
9. **变异 ID 撞号**：任务 6 补的靶子写成 `M25`，与任务 7 的 `M25–M27` 撞（任务 5 又占了 `M28–M30`）⇒ 全计划查重后把任务 7 改为 `M31–M33`。**教训：新增编号前先全文件查重**。
10. **并发误提交**：修复轮正在跑时，我用 `git add <两个 docs 文件> && git commit`，把它**已 `update-index` 到暂存区**的 `gradlew` 模式变更一起提交了（端状态正确，但**过程是我制造的竞态**）。
    教训：并行时要么 `git commit -- <paths>` 限定路径，要么先确认暂存区只有自己的改动。
11. **预判错两次**：① 以为 `compileSdk 37` 是拦路虎（真墙是 P9 的 `tauri` script）；② 以为「装 SDK 组件」这条红线会由人来触发（被 AGP 绕过了，见 R2）。

---

## 5. 人工验证清单（规格 §10 的 15 条）

**由收尾任务补齐**：逐条结果，**未执行的如实写「未执行」**并说明缺的是**装置**还是**时间**。
清单 11（116×116 ≈ 64 MB 不崩）若显示会崩，**按 B4 构建记录 §12 的预登记规则另立独立小轮**，本轮只记读数。

### 5.1 控制者已用机器侧证据**提前结清**的条目（人类伙伴不必再花时间）

| # | 条目 | 机器侧证据（已有） |
|---|---|---|
| **12** | B4 清单 9 补做：空图纸（全空格）⇒ 面板如实说明；用量表合计 0；分享图为全透明 | **三条子声称全部已有单测**：`share.test.ts:170`「全空格图纸 ⇒ 一个块都不画（结果是一张全透明 PNG）」；`sheet.test.ts:707` 的「合计 0 颗」；`ExportPanel.test.ts:498` 的 `describe("空图纸与 props 驱动（规格 §10.4 / 契约 §2b）")`。⇒ 逻辑层面已结清，上手机只剩「看一眼面板文案」。 |
| **13**（前半） | 触控目标 ≥44px | 全仓按钮统一 `min-h-11`（= 44px）/ `min-h-12` / `min-h-14`；`EditorPage.vue:472` 的注释写明该约定；**`ExportPanel.vue` 里低于 44px 的按钮：0 个**（对 `h-10` / `min-h-10` / `h-9` / `py-2` 扫描零命中）。⇒ 只剩「横竖屏切换下的实际布局」需真机。 |
| **1**（前半） | 图标是自己的（不是 Tauri logo） | 图标由 `scripts/make-app-icon.mjs` 生成源图（1024×1024 / 24097 B），`npx tauri icon` 切成 **52 个**入库（含 Android 全套 mipmap）；APK 二进制里能搜到 `一起拼豆` 的 UTF-8 字节。⇒ 只剩「装机后图标显示为它」需真机一眼。 |

**其余条目（1 后半 / 2–11 / 13 后半 / 14 / 15）确实要上手机**：它们是「交付后的 App 走一遍全流程」，
必须先有 pass 2 的接线（任务 3–7），或依赖真机行为（装机 / 相机 / 分享 / 相册 / 旋转 / 内存）。

---

## 6. 正式接受的限制与延后项（截至任务 1）

一行一条，编号供 README 引用。**判定为可接受、明确不修**的项：

- B5-1 测试文件整体不在 G1 的扫描范围内（`__tests__` 路径段 / `.test.ts` / `.spec.ts` 结尾）。理由：包名在既有测试里是**数据**（`coreBoundary.test.ts`），而测试里静态 import `@tauri-apps/*` 会在 vitest 收集阶段就崩（自证）。**代价如实记**：测试文件里把包名拼进字符串不会被拦。
- B5-2 闸门的语料库只有 `src/**/*.{ts,vue}` ⇒ 不看 `.js` / `.mjs` / `.cjs` / `.jsx` / `.tsx`，也不看仓库根配置。换后缀 / 换语言前必须先改那个 glob。
- B5-3 `stripComments` 不认识正则字面量：`\//` 会开启行注释分支、吞掉该行右侧（影响**全部四个**闸门，方向是漏报）。
- B5-4 G3 是子串判据（`indexOf("mount(")` 能被 `unmount(` 或字符串满足）；G4 的正向半段 `toContain("album.save(")` **剥注释但保留字符串** ⇒ 字符串里写一句就能满足它，而合法的等价写法（先取 `album` 再 `save`）会被它判红。
- B5-5 `sniffImageType.ts` 的长度守卫在当前载体（`Uint8Array`）上**不承重**（删掉它 0 红，见 R6）。保留理由是「显式判据 + 换载体时行为不变」。
- B5-6 `browserPlatform` 的 `capturePhoto` 只抛「本平台不支持拍照」，拿不到「非 File ⇒ 抛」那条路径 ⇒ §4.4 的第二条消息在浏览器实现里没有可触发用例（判别力在壳实现，任务 2 起）。
- B5-7 契约里 `capturePhoto` 的两条用例在任务 0 时**只执行「不适用」支 + 对账断言**（浏览器 `canCapture === false`）；真正驱动 `finishCapture` 要等壳 harness 声明 `canCapture: true`。
- B5-8 `finishCapture` 的参数放宽为 `unknown`（为了能注入契约违反）⇒ 调用点误写 `undefined` 能过编译（仅测试脚手架）。
- B5-9 `removeEventListener`（`browserPlatform.ts`）无断言——节点已摘除且无引用，属防御性，**不为它造假装能判别的用例**。
- B5-10 `types.ts` 里三处 JSDoc 引错任务号（写「计划（任务 3）」，实际是 5 / 6 / 7）。**修法**：JSDoc 里不引任务号（改「后续接线任务（见计划的任务表）」）——**排给下一次触碰该文件的人**。
- B5-11 `gen/android/app/build.gradle.kts` 未 pin `ndkVersion` ⇒ NDK 升级会静默换版本（本轮 `30.0.14904198`）；CI 不覆盖。
- B5-12 `app-icon.png` 是图标**源图**（`scripts/make-app-icon.mjs` 生成、`npx tauri icon` 消费）⇒ 入库，但此前没有书面理由（本条即理由）。

---

## 7. 未验证面与后续优先级（截至任务 1）
| # | 未验证 / 未闭环 | 现状 | 怎么闭环 | 优先级 |
|---|---|---|---|---|
| 1 | **六判据（F/A/B/C/D/E）全未取得真机读数** | 探针页与通路在任务 2 交付；**A–E 需要人类伙伴在手机上点** | 操作卡：`.superpowers/sdd/2026-10-06-app-b5-tauri-shell/phone-probe-instructions.md` | **最高**（它决定 pass 2 各任务的实现分支） |
| 2 | **平板未验** | 本轮验收设备是**手机**（裁决 4） | 将来有平板时重跑 `/lab/shell` 与人工清单 | 中 |
| 3 | **release 签名 / 上架未做** | 只交付 debug APK（debug keystore 由 CLI 生成） | 需 keystore 与账号（敏感配置，红线） | 低（本阶段不要求） |
| 4 | **Rust 侧零单测**（CI 只 `cargo check`） | `take_opened_uris` 的「取走即清」、信封解析、三层核对都只有真机判别力 | §2 的判据 C/D 读数 | 中 |
| 4b | **mobile-only 的 `cfg` 分支从不被 CI 编译** | CI 的 `cargo check` 编的是桌面 target，`#[cfg(target_os = "android")]` 整块（含 `save_with_platform` 的 Android 实现、`RunEvent::Opened` 的入队与 `emit`）与插件的移动端路径**不参与类型检查**。**实测代价（R9）**：任务 2 用真机构建才抓到 `E0716` 临时值与被遗漏的 `Manager` 引入 | 每次 `tauri android build` 顺带验证；若要把这条纳入 CI，需要加一个 Android target 的 `cargo check`（本轮不做，记为首选项） | 中 |
| 5 | **`tauriDriver.ts` 在 happy-dom 下不可执行** | 信封布局 / 字节核对 / `exitApp()` 三处零 CI 断言 | 同上 | 中 |
| 6 | **切后台被系统回收会丢未保存改动** | 规格 §5.5.4 的刻意不做（Rust 无 `Paused`/`Suspended`；`visibilitychange` 拦不住） | 写进 README 的已知限制 | 低（如实记录即可） |
| 7 | **`:app:rustBuild*` 依赖 `npm run tauri`** | 已由 `"tauri": "tauri"` script 解决（P9）；但 CI **不构建 APK** ⇒ 这条链只在真机构建时被验证 | 每次真机构建顺带验证 | 低 |

---

## 8. 待批准的建议（**改动 CI/CD 属红线，未经批准不做**）

| # | 建议 | 实测依据 | 状态 |
|---|---|---|---|
| 1 | 在 CI 的 `rust-check` job 里**加一步** `cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-linux-android` | P15：可用；首次 14.9 s、缓存后 0.34 s、exit 0。**它能抓住 R9 那两处「只在 Android target 现形」的缺陷**——本轮是靠真机构建才发现的，CI 当时全绿 | **待人类伙伴批准**（`.github/workflows/ci.yml` 属 CI 配置，按项目红线必须先问） |
| 2 | 加一条用例断言「`/` 的 name 是 `home` 且不是 redirect」 | R10：S1 脚手架在位时 `npm run test` 完全无感（1193 passed / 1 failed） | 待排期（pass 2 任一次触碰 `src/router/__tests__/index.test.ts` 时顺手做） |

