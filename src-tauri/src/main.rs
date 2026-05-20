// Release 构建时才隐藏控制台窗口；debug 模式保留控制台以便查看 panic 信息
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    easy_infer_station_lib::run()
}
