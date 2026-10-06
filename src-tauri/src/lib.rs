use serde::Deserialize;
use std::sync::Mutex;
// `Emitter` 只在移动端的 `app.emit("opened", …)` 处用到，而 **CI 编的是桌面 target**
// （规格 §6.3：`cargo check` 跑在 ubuntu 上）⇒ 无条件 import 会在桌面 target 上产生
// 「unused import: Emitter」警告。计划正文是一行 `use tauri::{Emitter, Manager};`，
// 2026-10-06 任务 2 实跑看到这条警告后按 target 拆开（`Manager` 在桌面也真的用到：
// `take_opened_uris` 的 `app.state::<OpenedUris>()`）。
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
use tauri::Emitter;
use tauri::Manager;

/// 启动 / 运行期分发进来的分享 URI（Android `ACTION_SEND` → `intent.data`）。
///
/// **取走即清**（见 `take_opened_uris`）：摄入链有副作用（改草稿、跳路由），重复摄取同一张图
/// 会让用户莫名其妙地回到选区页。官方的 `opened_urls` 例子是累积的，本仓刻意不照抄。
#[derive(Default)]
struct OpenedUris(Mutex<Vec<String>>);

/// 取走全部待处理 URI 并清空。
///
/// **为什么不叫 `opened_urls`**：名字要体现语义（取走即清），照官方例子命名会让后来者以为它是只读查询。
///
/// **零判别力（如实登记）**：本轮 CI 只对 Rust 跑 `cargo check`（规格 §6.3 明确写了不跑 Android target、
/// 不做 Rust 单测），所以「取走即清」这条语义**在 CI 里零判别力**——把 `std::mem::take` 换成
/// `.clone()`（变异 V9）`cargo check` 照样过、`npm run test` 一条都不红。它的判别力在**真机判据 C 的
/// 两次**：冷启动取走之后**再按一次**「跑 C」，读数必须仍是「无待处理分享」。
#[tauri::command]
fn take_opened_uris(app: tauri::AppHandle) -> Vec<String> {
    let state = app.state::<OpenedUris>();
    let mut guard = state.0.lock().expect("OpenedUris 锁中毒");
    std::mem::take(&mut *guard)
}

/// 前端交上来的请求体：**文件名 + base64 的图像字节**。
///
/// **为什么不是原始字节体（`InvokeBody::Raw`）**——2026-10-06 任务 2 修复轮 F1，由任务级审查者引
/// 厂商源码证实，`tauri-2.12.1/src/ipc/mod.rs:54-56` 原文：
///
/// > ### Android
/// > On Android, [InvokeBody::Raw] is not supported. The enum will always contain [InvokeBody::Json].
/// > When targeting Android Devices, consider passing raw bytes as a base64 String, which is still
/// > more efficient than passing them as a number array in [InvokeBody::Json]
///
/// ⇒ Android 上 `Uint8Array` 的请求体走 JSON，`InvokeBody::Raw` **永远拿不到**；上一版按计划写的
/// 「原始字节体信封」在真机上必然命中 `保存失败：需要原始字节体` 那条 Err（判据 C 与 D 必红，
/// 三层核对在任何环境都跑不到）。厂商原文同时劝退「数字数组」（4 倍膨胀）⇒ 本仓走 **base64**
/// （1.37 倍），这正是规格 **B5-R4 预登记的退路**，现在正式启用。
///
/// 字段名与前端 `tauriDriver.saveToAlbum` 的 `{ request: { filename, dataBase64 } }` 逐字对应
/// （`camelCase`；外层 `request` 是命令参数名，内层由 serde 转）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRequest {
    filename: String,
    /// 图像字节的标准 base64（`+` / `/` 字母表、`=` 填充，与前端 `encodeBase64` 同一口径）。
    data_base64: String,
}

/// 把 PNG 字节写进系统相册；返回**实际写入的字节数**（JS 侧拿它做端到端核对）。
///
/// 请求体是 `SaveRequest`（base64 + 文件名，理由见它的 JSDoc）。
///
/// 实现顺序：**先校验文件名、再解 base64、再落临时文件、再交给 Android 插件、最后无条件删临时文件**。
/// 临时文件是「字节要过一段 JSON 到 Kotlin」与「不要把字节塞进那段 JSON」的折中：Kotlin 只收一个路径。
#[tauri::command]
fn save_image_to_album(app: tauri::AppHandle, request: SaveRequest) -> Result<usize, String> {
    use base64::Engine as _;

    let filename = request.filename;
    if filename.trim().is_empty() {
        return Err("文件名不能为空".into());
    }
    let image = base64::engine::general_purpose::STANDARD
        .decode(request.data_base64.as_bytes())
        // **中文原因**（`{error}` 是 base64 crate 的英文详情，原样附在后面，不吞）。
        .map_err(|error| format!("保存失败：base64 解码失败（{error}）"))?;
    if image.is_empty() {
        return Err("导出内容为空（blob 大小为 0）".into());
    }
    // **判据 C 的证据行**（`/lab/shell` 的 C 块与操作卡里逐字引用同一串；`{}` 处是真机上的实际数字）。
    // 走 `log::info!` 而不是 `println!`：Android 上原生 stdout 默认不接 logcat（理由见 `Cargo.toml`
    // 的 `android_logger` 段与 `run()` 里的 `init_once`）。
    log::info!("save_image_to_album：收到 base64 解码后 {} 字节", image.len());

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let temp = std::env::temp_dir().join(format!("weefuse-{stamp}.png"));
    std::fs::write(&temp, &image).map_err(|e| format!("写临时文件失败：{e}"))?;

    let result = save_with_platform(&app, &temp, &filename);
    // **无条件删除**：成功失败都删（临时文件不该留在设备上）。
    let _ = std::fs::remove_file(&temp);

    // **第三层核对**（规格 §5.4.1 声称的「三层联动」在这里落地）：拿 Kotlin 报的**实际写入字节数**
    // 与本次图像长度比。Rust 自己读到的长度是 `image.len()`，若只返回它，链路上任何截断都发现不了
    // （2026-10-06 控制者核对时发现计划早先正是这么写的 ⇒ 规格那句话当时是**假的**）。
    // 改走 base64 之后这条核对**才真的可达**：`{}` 那一层以前是 `InvokeBody::Raw` 的 else 分支。
    let written = result?;
    if written != image.len() {
        return Err(format!(
            "相册写入字节数不一致：期望 {}，实际 {written}",
            image.len()
        ));
    }
    // 返回 **Kotlin 报的数**（前端 `tauriDriver.saveToAlbum` 再拿它与 JS 侧的 `bytes.length` 比 ⇒ 三层闭合）。
    Ok(written)
}

/// 平台分派：Android 交给 Kotlin 插件（**返回 Kotlin 报的实际写入字节数**）；
/// 其它平台响亮失败（桌面端仅开发调试，不假装支持）。
#[cfg(target_os = "android")]
fn save_with_platform(
    app: &tauri::AppHandle,
    path: &std::path::Path,
    filename: &str,
) -> Result<usize, String> {
    use tauri_plugin_album::AlbumExt;
    app.album()
        .save(path.to_string_lossy().to_string(), filename.to_string())
}

#[cfg(not(target_os = "android"))]
fn save_with_platform(
    _app: &tauri::AppHandle,
    _path: &std::path::Path,
    _filename: &str,
) -> Result<usize, String> {
    Err("本平台不支持写入相册（桌面壳仅用于开发调试）".into())
}

/// 应用入口。桌面端由 `main.rs` 调用，移动端由 `#[tauri::mobile_entry_point]` 生成的胶水调用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // **Android 上先把日志后端装上**：原生 `println!` 走 stdout，而 App 进程的 stdout 默认不接
    // logcat ⇒ 不装后端的话下面那几行「证据」在真机上可能一行都看不到（2026-10-06 定向复审 G2）。
    // `init_once` 幂等；桌面 / iOS 不需要它（桌面 `cargo check` 里这段整个不编）。
    #[cfg(target_os = "android")]
    android_logger::init_once(
        android_logger::Config::default()
            // 日志级别与 tag：`adb logcat` 里按 tag 过滤时用 `WeeFuse`。
            .with_max_level(log::LevelFilter::Info)
            .with_tag("WeeFuse"),
    );
    tauri::Builder::default()
        .plugin(tauri_plugin_album::init())
        .plugin(tauri_plugin_fs::init())
        .manage(OpenedUris::default())
        .invoke_handler(tauri::generate_handler![take_opened_uris, save_image_to_album])
        .build(tauri::generate_context!())
        .expect("error while building weefuse")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = event {
                // **判据 C 的证据行之一**（`/lab/shell` 的 C 块与操作卡里逐字引用同一串；
                // `{}` 处是真机上的实际数字）。它证明「分享进来的 intent 真的到了 Rust」——
                // 探针页读到的冷启动 / 热启动文件名与字节数是它的下游。
                log::info!("RunEvent::Opened：收到 {} 个 URI", urls.len());
                // **判据 C 的「URI 原文」那一行**（规格 §13 判据 C 明写「打印收到的 URI」；
                // 2026-10-06 定向复审 G1 发现原来只打了**个数**，而操作卡/探针页三处都让人
                // 「去 logcat 看 URI 原文」⇒ 会让人找一行不存在的输出）。**逐条打**，
                // 格式固定为 `RunEvent::Opened：URI = {url}`，与探针页提示、操作卡逐字一致。
                for url in &urls {
                    log::info!("RunEvent::Opened：URI = {url}");
                }
                // **`state` 必须先绑成 `let`**（2026-10-06 任务 2 实跑 Android target 时抓到的
                // 计划缺陷）：`app.state::<OpenedUris>()` 返回的是一个**临时值**，直接
                // `app.state::<OpenedUris>().0.lock()` 会在语句结束时把它释放掉，而 `guard`
                // 还要在后面几行里用 ⇒ `error[E0716]: temporary value dropped while borrowed`。
                // 桌面 `cargo check` 看不到它（整段是 cfg 到移动端的），只有 `tauri android build`
                // 编 aarch64-linux-android 时才会现形。
                let state = app.state::<OpenedUris>();
                let mut guard = state.0.lock().expect("OpenedUris 锁中毒");
                for url in &urls {
                    guard.push(url.to_string());
                }
                drop(guard);
                // **一个 URI 一条事件、payload 是字符串**（不是数组）：驱动的 `listen<string>("opened")`
                // 收到的就是单个 `content://…`。发数组会让 `payload.payload` 变成 `string[]`，
                // 而 `fileFromUri` 走的是 `typeof first !== "string"` 那条守卫 ⇒ 每次热启动分享都报
                // 「分享内容不是文件」。跨语言边界上的类型对不上是**静默形态**，所以这里逐条写清楚。
                for url in urls {
                    let _ = app.emit("opened", url.to_string());
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            {
                let _ = (app, event);
            }
        });
}
