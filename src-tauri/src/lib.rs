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

/// 把 PNG 的**原始字节体**写进系统相册；返回**实际写入的字节数**（JS 侧拿它做端到端核对）。
///
/// body 是一段**自描述信封**（规格 §5.4.1 + 片段裁定 3）：
/// `[u32 LE 文件名字节数][文件名 UTF-8][图像字节]`。
/// 为什么不把文件名放进 `invoke` 的 `options.headers`：HTTP header 值域是 ASCII，而文件名是
/// 中文；信封把「名字」与「字节」分成两段、可逐条校验，也不依赖任何未经核实的 API。
///
/// 实现顺序：**先校验信封、再落临时文件、再交给 Android 插件、最后无条件删临时文件**。
/// 临时文件是「字节要过一段 JSON 到 Kotlin」与「不要把字节塞进 JSON」的折中：Kotlin 只收一个路径。
#[tauri::command]
fn save_image_to_album(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<usize, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("保存失败：需要原始字节体".into());
    };
    if body.len() < 4 {
        return Err("保存失败：信封太短（至少要有 4 字节的文件名长度）".into());
    }
    let name_len = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    // `checked_add`：`name_len` 来自报文，直接相加在 32 位设备上可能溢出后回绕成一个「合法」的小下标。
    let bytes_start = 4usize
        .checked_add(name_len)
        .ok_or("保存失败：文件名字节数溢出")?;
    if bytes_start > body.len() {
        return Err("保存失败：文件名字节数越界".into());
    }
    let filename = std::str::from_utf8(&body[4..bytes_start])
        .map_err(|_| "保存失败：文件名不是合法 UTF-8")?
        .to_string();
    if filename.trim().is_empty() {
        return Err("文件名不能为空".into());
    }
    let image = &body[bytes_start..];
    if image.is_empty() {
        return Err("导出内容为空（blob 大小为 0）".into());
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let temp = std::env::temp_dir().join(format!("weefuse-{stamp}.png"));
    std::fs::write(&temp, image).map_err(|e| format!("写临时文件失败：{e}"))?;

    let result = save_with_platform(&app, &temp, &filename);
    // **无条件删除**：成功失败都删（临时文件不该留在设备上）。
    let _ = std::fs::remove_file(&temp);

    // **第三层核对**（规格 §5.4.1 声称的「三层联动」在这里落地）：拿 Kotlin 报的**实际写入字节数**
    // 与本次图像长度比。Rust 自己读到的长度是 `image.len()`，若只返回它，链路上任何截断都发现不了
    // （2026-10-06 控制者核对时发现计划早先正是这么写的 ⇒ 规格那句话当时是**假的**）。
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
    tauri::Builder::default()
        .plugin(tauri_plugin_album::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(OpenedUris::default())
        .invoke_handler(tauri::generate_handler![take_opened_uris, save_image_to_album])
        .build(tauri::generate_context!())
        .expect("error while building weefuse")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = event {
                let mut guard = app.state::<OpenedUris>().0.lock().expect("OpenedUris 锁中毒");
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
