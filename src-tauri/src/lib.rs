/// 应用入口。桌面端由 `main.rs` 调用，移动端由 `#[tauri::mobile_entry_point]` 生成的胶水调用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running weefuse");
}
