mod commands;

use commands::backend::{self, BackendState};
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
