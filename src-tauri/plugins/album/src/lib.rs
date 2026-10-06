use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

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
