use serde::{Deserialize, Serialize};
use tauri::{plugin::PluginHandle, Runtime};

/// Android 插件的 Rust 句柄。`save` 只把**路径**送过去（字节已经在临时文件里了）。
pub struct Album<R: Runtime>(pub PluginHandle<R>);

/// 送给 Kotlin 的参数。字段名与 Kotlin 侧 `SaveArgs` **逐字一致**。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavePayload {
    path: String,
    filename: String,
}

/// Kotlin `invoke.resolve(JSObject{uri, bytes})` 的镜像。
///
/// **为什么必须有一个结构体、不能写成 `::<String>`**（2026-10-06 控制者跨语言核对时抓到的接线缺陷）：
/// `run_mobile_plugin::<T>` 会把 Kotlin 的返回值按 `T` 反序列化，而 Kotlin 侧 resolve 的是**对象**
/// （`{"uri": …, "bytes": …}`）⇒ 写成 `String` 会在真机上以反序列化失败告终。这条链**只有真机跑得到**
/// （CI 里 `tauriDriver.ts` 不可执行），所以它**必须在纸面上就对得上**。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveResponse {
    /// MediaStore 返回的 `content://` URI；由 Rust 侧打印进日志，便于核对落点（见下方 `println!`）。
    uri: String,
    /// Kotlin **实际复制进相册**的字节数（第三层核对用它，见 `src-tauri/src/lib.rs`）。
    bytes: usize,
}

impl<R: Runtime> Album<R> {
    /// 交给 Kotlin 的 `@Command fun save`；**返回 Kotlin 报的实际写入字节数**（不是 Rust 自己数的）。
    /// Kotlin 侧 `invoke.reject` 时这里拿到错误原文并**原样上抛**（不吞）。
    pub fn save(&self, path: String, filename: String) -> Result<usize, String> {
        let response: SaveResponse = self
            .0
            .run_mobile_plugin("save", SavePayload { path, filename })
            .map_err(|error| format!("相册插件调用失败：{error}"))?;
        println!("AlbumPlugin::save 落到 {}", response.uri);
        Ok(response.bytes)
    }
}
