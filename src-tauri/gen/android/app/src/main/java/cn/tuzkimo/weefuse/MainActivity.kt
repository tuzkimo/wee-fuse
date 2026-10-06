package cn.tuzkimo.weefuse

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // 2026-10-06 真机缺陷 A-FIX 2：壳里内容顶到屏幕最上沿、被状态栏/导航栏盖住。
    //
    // 根因：`enableEdgeToEdge()`（Tauri 模板自带）让窗口 edge-to-edge，而**没有人消费 insets**。
    // 为什么不用 `WindowCompat.setDecorFitsSystemWindows(window, true)`：本项目
    // `targetSdk = 37`（`app/build.gradle.kts`），而从 Android 15 起，targetSdk >= 35 的应用
    // **强制 edge-to-edge**，`setDecorFitsSystemWindows(true)` 已被平台忽略
    // （`windowOptOutEdgeToEdgeEnforcement` 这个临时退路对 targetSdk >= 36 也已失效）。
    // ⇒ 唯一正确的做法是**自己把 insets 让给内容**。
    //
    // 做法：`android.R.id.content` 是 Tauri 放 WebView 的那个 FrameLayout（`setContentView` 的
    // 落点），给它加一圈 padding = 给 WebView 留出系统栏与刘海的宽度；insets 里取
    // **systemBars（状态栏 + 导航栏）+ displayCutout（刘海）** 的并集（`getInsets` 对多个类型取最大）。
    // 监听器设在 `content` 上、且**不**把 insets 标成 CONSUMED：WebView 自己不消费系统栏 insets，
    // 所以不会二次加 padding。
    val content = findViewById<View>(android.R.id.content) ?: return
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars =
        insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    // onCreate 里设监听器正常会在首次布局前收到派发；显式再请求一次，免得错过已经派发过的那些。
    ViewCompat.requestApplyInsets(content)
  }
}
