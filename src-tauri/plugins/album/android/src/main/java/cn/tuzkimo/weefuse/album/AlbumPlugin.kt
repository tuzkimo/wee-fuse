package cn.tuzkimo.weefuse.album

import android.app.Activity
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class SaveArgs {
    // 这几个字段名必须与 Rust 侧 `SavePayload` 的 camelCase 序列化逐字一致（path / filename）。
    var path: String? = null
    var filename: String? = null
}

/**
 * 把临时文件复制进系统相册的 `Pictures/WeeFuse`。
 *
 * **只用 `MediaStore`，不申请任何权限**（本插件要回答的判据 D 就是「API 29+ 免不免权限」）。
 * 落点取 `RELATIVE_PATH` 而不是绝对路径：scoped storage 下后者不可写。
 *
 * **返回值是一段对象 `{uri, bytes}`，不是字符串**（2026-10-06 控制者跨语言核对时抓到的接线缺陷）：
 * Rust 侧 `run_mobile_plugin::<SaveResponse>` 按 `{uri, bytes}` 反序列化，`resolve(uri.toString())`
 * 会让它在真机上以反序列化失败告终。这条链在 CI 里跑不到（前端驱动在 happy-dom 下不可执行），
 * 所以两边必须在纸面上就对得上。
 */
@TauriPlugin
class AlbumPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun save(invoke: Invoke) {
        val args = invoke.parseArgs(SaveArgs::class.java)
        val sourcePath = args.path
        val filename = args.filename
        if (sourcePath == null || filename == null) {
            invoke.reject("保存失败：缺少路径或文件名")
            return
        }
        val source = File(sourcePath)
        if (!source.isFile) {
            invoke.reject("保存失败：临时文件不存在")
            return
        }
        try {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, filename)
                put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(
                        MediaStore.Images.Media.RELATIVE_PATH,
                        Environment.DIRECTORY_PICTURES + "/WeeFuse",
                    )
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
            }
            val resolver = activity.contentResolver
            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("MediaStore 插入返回了 null")
            var copied = 0L
            resolver.openOutputStream(uri).use { output ->
                if (output == null) throw IllegalStateException("拿不到输出流")
                source.inputStream().use { input -> copied = input.copyTo(output) }
            }
            // **第三层核对**（规格 §5.4.1）：Kotlin 自校验「复制出去的字节数 == 临时文件长度」。
            // 不一致时把刚插入的条目删掉再 reject——不然相册里会留下一张半截图，而用户以为存成功了。
            if (copied != source.length()) {
                resolver.delete(uri, null, null)
                throw IllegalStateException(
                    "写入字节数不一致：期望 ${source.length()}，实际 $copied",
                )
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            }
            // 返回 **Kotlin 报的实际写入字节数**：Rust 用它做第二层核对，前端驱动做第一层核对。
            val result = JSObject()
            result.put("uri", uri.toString())
            result.put("bytes", copied)
            invoke.resolve(result)
        } catch (error: Exception) {
            invoke.reject("写入相册失败：${error.message ?: error.javaClass.simpleName}")
        }
    }
}
