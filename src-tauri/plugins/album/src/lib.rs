use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

// `app.manage(...)` 要 `Manager` 在作用域内；而它只在 `#[cfg(target_os = "android")]` 的那段 setup 里
// 用到 ⇒ **按 target 引入**：桌面上无条件 import 会得到 unused import 警告。
// **这条缺陷只在 Android target 上编译时才现形**（2026-10-06 任务 2 实跑：桌面 `cargo check` 全绿，
// `npx tauri android build` 报 `no method named manage found for &AppHandle`，E0599）——
// 计划正文的 lib.rs 少了这一行，是「`cargo check` 只覆盖桌面 target」的又一个实例。
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
mod mobile;

/// 插件入口。桌面 / iOS 不注册任何命令——`save` 命令只存在于 Android。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("album");
    #[cfg(target_os = "android")]
    let builder = builder.setup(|app, api| {
        let handle = api.register_android_plugin("cn.tuzkimo.weefuse.album", "AlbumPlugin")?;
        app.manage(mobile::Album(handle));
        Ok(())
    });
    builder.build()
}

/// Rust 侧取插件句柄的扩展 trait。**消费者**：`src-tauri/src/lib.rs` 的 `save_with_platform`。
#[cfg(target_os = "android")]
pub trait AlbumExt<R: Runtime> {
    fn album(&self) -> &mobile::Album<R>;
}

#[cfg(target_os = "android")]
impl<R: Runtime, T: tauri::Manager<R>> AlbumExt<R> for T {
    fn album(&self) -> &mobile::Album<R> {
        self.state::<mobile::Album<R>>().inner()
    }
}
