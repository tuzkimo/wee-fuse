// Windows 上 release 构建不弹控制台窗口；调试构建保留控制台，真机日志靠它。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    weefuse_lib::run()
}
