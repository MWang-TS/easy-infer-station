mod commands;

use commands::backend::{self, BackendState};
use commands::manifest;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(BackendState(Mutex::new(None)))
        .setup(|app| {
            // 每次启动都把安装包内的后端源码同步到 backend_runtime。
            // 这里必须无条件执行：不能只靠前端「配置向导」调用 get_app_dir，
            // 否则升级后的用户（配置已持久化、向导不再出现）会继续跑旧版本代码，
            // 表现为新接口 404 / 返回 HTML，前端 JSON 解析报错。
            if let Err(err) = backend::ensure_runtime(app.handle()) {
                eprintln!("[eis] 同步后端运行目录失败: {err}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend::list_conda_envs,
            backend::validate_conda_env,
            backend::start_backend,
            backend::stop_backend,
            backend::check_backend_alive,
            backend::get_backend_log,
            backend::backend_health,
            backend::get_backend_client_config,
            backend::get_app_dir,
            backend::check_for_updates,
            manifest::get_dependency_manifest,
            manifest::render_environment_yml,
            manifest::render_requirements_txt,
            manifest::export_environment_yml,
            manifest::export_requirements_txt,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // 窗口销毁时强制杀掉 Python 后端进程
                let state = window.state::<BackendState>();
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
