mod commands;

use commands::backend::{self, BackendState};
use std::sync::Mutex;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
