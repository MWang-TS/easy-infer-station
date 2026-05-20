use serde::{Deserialize, Serialize};
use std::process::Child;
use std::sync::Mutex;
use tauri::{Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn apply_no_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

// 全局 Python 进程状态
pub struct BackendState(pub Mutex<Option<Child>>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CondaEnv {
    pub name: String,
    pub path: String,
    pub python_version: String,
    pub missing_packages: Vec<String>,
    pub is_valid: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackendStatus {
    pub running: bool,
    pub healthy: bool,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackendClientConfig {
    pub api_token: String,
}

fn read_backend_env_value(app_dir: &str, key: &str) -> String {
    if let Ok(value) = std::env::var(key) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let env_path = std::path::Path::new(app_dir).join(".env");
    let content = match std::fs::read_to_string(env_path) {
        Ok(content) => content,
        Err(_) => return String::new(),
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some((env_key, env_value)) = trimmed.split_once('=') else {
            continue;
        };

        if env_key.trim() != key {
            continue;
        }

        return env_value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string();
    }

    String::new()
}

fn copy_file(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败 ({}): {}", parent.display(), e))?;
    }
    std::fs::copy(src, dst)
        .map_err(|e| format!("复制文件失败 ({} -> {}): {}", src.display(), dst.display(), e))?;
    Ok(())
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("创建目录失败 ({}): {}", dst.display(), e))?;

    for entry in std::fs::read_dir(src)
        .map_err(|e| format!("读取目录失败 ({}): {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| format!("读取目录项失败 ({}): {}", src.display(), e))?;
        let entry_path = entry.path();
        let target_path = dst.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败 ({}): {}", entry_path.display(), e))?;

        if file_type.is_dir() {
            copy_dir_all(&entry_path, &target_path)?;
        } else {
            copy_file(&entry_path, &target_path)?;
        }
    }

    Ok(())
}

fn sync_backend_runtime_dir(resource_dir: &std::path::Path, runtime_dir: &std::path::Path) -> Result<(), String> {
    let resource_names = [
        "app.py",
        "config.py",
        "requirements.txt",
        ".env.example",
        "routes",
        "services",
        "static",
        "models",
    ];

    std::fs::create_dir_all(runtime_dir)
        .map_err(|e| format!("创建运行目录失败 ({}): {}", runtime_dir.display(), e))?;

    for name in resource_names {
        let src = resource_dir.join(name);
        if !src.exists() {
            continue;
        }

        let dst = runtime_dir.join(name);
        if src.is_dir() {
            copy_dir_all(&src, &dst)?;
        } else {
            copy_file(&src, &dst)?;
        }
    }

    Ok(())
}

/// 列出系统中所有的 conda 环境
#[tauri::command]
pub async fn list_conda_envs() -> Result<Vec<CondaEnv>, String> {
    // Step 1: conda env list --json（唯一的子进程调用）
    let output = tokio::task::spawn_blocking(|| {
        let mut command = std::process::Command::new("conda");
        command.args(["env", "list", "--json"]);
        apply_no_window(&mut command);
        command.output()
    })
    .await
    .map_err(|e| format!("执行 conda 扫描任务失败: {}", e))?
    .map_err(|e| format!("无法执行 conda 命令: {}", e))?;

    if !output.status.success() {
        return Err("conda 命令执行失败，请确认 conda 已安装并在 PATH 中".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("解析 conda 输出失败: {}", e))?;

    let env_paths: Vec<String> = json["envs"]
        .as_array()
        .ok_or("无法读取环境列表")?
        .iter()
        .filter_map(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    // Step 2: 纯文件系统检查，无需启动 Python 进程
    let result: Vec<CondaEnv> = env_paths
        .into_iter()
        .map(|path| check_conda_env_fs(&path))
        .collect();

    Ok(result)
}

/// 通过文件系统（conda-meta + site-packages）检查环境，零子进程开销
fn check_conda_env_fs(path: &str) -> CondaEnv {
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("base")
        .to_string();

    // 从 conda-meta 读取 Python 版本（找 python-X.Y.Z-*.json）
    let conda_meta = if cfg!(target_os = "windows") {
        format!("{}\\conda-meta", path)
    } else {
        format!("{}/conda-meta", path)
    };

    let py_version = std::fs::read_dir(&conda_meta)
        .ok()
        .and_then(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .find(|name| name.starts_with("python-") && name.ends_with(".json"))
                .and_then(|fname| {
                    // "python-3.10.12-h2bbff73_2.json" → "3.10.12"
                    fname.strip_prefix("python-")?.split('-').next().map(|s| s.to_string())
                })
        })
        .unwrap_or_else(|| "unknown".to_string());

    // 需要检查的所有依赖：(conda-meta前缀, site-packages目录名, 显示名称)
    // conda-meta前缀为空字符串表示只检查 site-packages
    let required: &[(&str, &str, &str)] = &[
        ("pytorch",       "torch",         "torch"),
        ("ultralytics",   "ultralytics",   "ultralytics"),
        ("flask",         "flask",          "Flask"),
        ("flask-socketio","flask_socketio", "Flask-SocketIO"),
        ("",              "flask_cors",     "Flask-Cors"),
        ("",              "cv2",            "opencv-python"),
        ("pillow",        "PIL",            "Pillow"),
        ("gevent",        "gevent",         "gevent"),
    ];

    let mut missing: Vec<String> = Vec::new();
    for (conda_name, site_name, display) in required {
        let found = (!conda_name.is_empty() && pkg_in_conda_meta(&conda_meta, conda_name))
            || pkg_in_site_packages(path, site_name);
        if !found {
            missing.push(display.to_string());
        }
    }

    CondaEnv {
        is_valid: missing.is_empty(),
        missing_packages: missing,
        name,
        path: path.to_string(),
        python_version: py_version,
    }
}

/// 在 conda-meta 目录中查找 {pkg_name}-*.json
fn pkg_in_conda_meta(conda_meta: &str, pkg_name: &str) -> bool {
    let prefix = format!("{}-", pkg_name);
    std::fs::read_dir(conda_meta)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .any(|e| {
                    let fname = e.file_name().to_string_lossy().to_string();
                    fname.starts_with(&prefix) && fname.ends_with(".json")
                })
        })
        .unwrap_or(false)
}

/// 在 site-packages 中查找包目录（兼容 Windows Lib\ 和 Unix lib/pythonX.Y/）
fn pkg_in_site_packages(env_path: &str, pkg_name: &str) -> bool {
    // Windows: Lib\site-packages\{pkg}
    let win_path = format!("{}\\Lib\\site-packages\\{}", env_path, pkg_name);
    if std::path::Path::new(&win_path).exists() {
        return true;
    }
    // Unix: lib/pythonX.Y/site-packages/{pkg}（遍历 lib/ 下的子目录）
    let lib_dir = format!("{}/lib", env_path);
    if let Ok(entries) = std::fs::read_dir(&lib_dir) {
        for entry in entries.flatten() {
            let candidate = entry.path()
                .join("site-packages")
                .join(pkg_name);
            if candidate.exists() {
                return true;
            }
        }
    }
    false
}

/// 验证指定 conda 环境是否满足依赖要求
#[tauri::command]
pub async fn validate_conda_env(env_path: String) -> Result<CondaEnv, String> {
    Ok(check_conda_env_fs(&env_path))
}

/// 启动 Python 后端（使用指定 conda 环境中的 Python）
#[tauri::command]
pub async fn start_backend(
    state: State<'_, BackendState>,
    python_exe: String,
    app_dir: String,
    port: u16,
) -> Result<(), String> {
    // 把 Python 的 stdout/stderr 重定向到临时日志文件，方便诊断
    let log_path = std::env::temp_dir().join("easy_infer_backend.log");

    // 第一阶段：在锁内生成进程（不跨 await，避免 MutexGuard: !Send 问题）
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;

        if guard.is_some() {
            return Err("后端已在运行".to_string());
        }

        let log_file = std::fs::File::create(&log_path)
            .map_err(|e| format!("创建日志文件失败: {}", e))?;
        let log_clone = log_file.try_clone().map_err(|e| e.to_string())?;

        let mut command = std::process::Command::new(&python_exe);
        command
            .args(["-u", "app.py"])
            .env("PORT", port.to_string())
            .env("PYTHONUNBUFFERED", "1")
            .current_dir(&app_dir)
            .stdout(log_file)
            .stderr(log_clone);
        apply_no_window(&mut command);

        let child = command
            .spawn()
            .map_err(|e| format!("启动 Python 失败（python={}, dir={}）: {}", python_exe, app_dir, e))?;

        *guard = Some(child);
    } // 锁在这里释放，之后可以安全 await

    // 第二阶段：等 1 秒后检查进程是否立即退出
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut child) = *guard {
        if let Ok(Some(status)) = child.try_wait() {
            *guard = None;
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            return Err(format!(
                "Python 进程启动后立即退出（exit code: {:?}）\n\n输出:\n{}",
                status.code(),
                if log.is_empty() { "（无输出，可能是 DLL 缺失或路径错误）".to_string() } else { log }
            ));
        }
    }

    Ok(())
}

/// 停止 Python 后端进程
#[tauri::command]
pub async fn stop_backend(state: State<'_, BackendState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    if let Some(mut child) = guard.take() {
        child.kill().map_err(|e| format!("停止后端失败: {}", e))?;
        let _ = child.wait();
    }

    Ok(())
}

/// 检查后端子进程是否还在运行（进程提前退出时立即感知，不用傻等超时）
#[tauri::command]
pub fn check_backend_alive(state: State<'_, BackendState>) -> bool {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                // 进程已退出，清除状态
                *guard = None;
                false
            }
            Ok(None) => true, // 仍在运行
            Err(_) => false,
        }
    } else {
        false
    }
}

/// 读取 Python 后端的日志文件（启动失败时诊断用）
#[tauri::command]
pub fn get_backend_log() -> String {
    let log_path = std::env::temp_dir().join("easy_infer_backend.log");
    std::fs::read_to_string(log_path)
        .unwrap_or_else(|_| "(日志文件不存在)".to_string())
}

/// 检查后端健康状态（轮询 /health 接口）
#[tauri::command]
pub async fn backend_health(port: u16) -> BackendStatus {
    let url = format!("http://127.0.0.1:{}/health", port);

    match reqwest::get(&url).await {
        Ok(resp) if resp.status().is_success() => BackendStatus {
            running: true,
            healthy: true,
            message: "后端运行正常".to_string(),
        },
        Ok(resp) => BackendStatus {
            running: true,
            healthy: false,
            message: format!("后端响应异常: {}", resp.status()),
        },
        Err(_) => BackendStatus {
            running: false,
            healthy: false,
            message: "无法连接到后端".to_string(),
        },
    }
}

#[tauri::command]
pub fn get_backend_client_config(app_dir: String) -> BackendClientConfig {
    BackendClientConfig {
        api_token: read_backend_env_value(&app_dir, "API_TOKEN"),
    }
}

// ─── 更新检查 ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub has_update: bool,
    pub latest_version: String,
    pub current_version: String,
    pub release_notes: String,
    pub release_url: String,
}

fn parse_semver(v: &str) -> (u32, u32, u32) {
    let v = v.trim_start_matches('v');
    let parts: Vec<u32> = v.split('.').filter_map(|s| s.parse().ok()).collect();
    (
        parts.first().copied().unwrap_or(0),
        parts.get(1).copied().unwrap_or(0),
        parts.get(2).copied().unwrap_or(0),
    )
}

/// 检查 GitHub Releases 是否有新版本
#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
    const API_URL: &str =
        "https://api.github.com/repos/MWang-TS/easy-infer-station/releases/latest";

    let client = reqwest::Client::builder()
        .user_agent("easy-infer-station-updater")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .get(API_URL)
        .send()
        .await
        .map_err(|e| format!("网络请求失败，请检查网络连接: {}", e))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("暂无发布版本，请稍后再试".to_string());
    }

    if !resp.status().is_success() {
        return Err(format!("GitHub API 返回错误: {}", resp.status()));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let tag_name = json["tag_name"].as_str().unwrap_or("").to_string();
    let release_notes = json["body"].as_str().unwrap_or("").to_string();
    let release_url = json["html_url"]
        .as_str()
        .unwrap_or("https://github.com/MWang-TS/easy-infer-station/releases")
        .to_string();

    let latest_version = tag_name.trim_start_matches('v').to_string();
    let has_update =
        parse_semver(&latest_version) > parse_semver(CURRENT_VERSION);

    Ok(UpdateInfo {
        has_update,
        latest_version,
        current_version: CURRENT_VERSION.to_string(),
        release_notes,
        release_url,
    })
}

/// 返回 app.py 所在目录
/// - Debug 构建（tauri dev）：CARGO_MANIFEST_DIR 的父目录（即项目根目录）
/// - Release 构建：可执行文件旁边的目录
#[tauri::command]
pub fn get_app_dir(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        // src-tauri/../  →  easy_infer_station/
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "找不到项目根目录".to_string())?
            .to_string_lossy()
            .to_string();
        return Ok(path);
    }
    #[cfg(not(debug_assertions))]
    {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("找不到资源目录: {}", e))?;
        let runtime_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("找不到本地数据目录: {}", e))?
            .join("backend_runtime");

        sync_backend_runtime_dir(&resource_dir, &runtime_dir)?;

        Ok(runtime_dir.to_string_lossy().to_string())
    }
}
