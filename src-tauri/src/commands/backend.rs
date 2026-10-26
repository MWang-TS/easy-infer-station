use serde::{Deserialize, Serialize};
use std::process::Child;
use std::sync::Mutex;
use tauri::State;
#[cfg(not(debug_assertions))]
use tauri::Manager;

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
    /// 检测到的 ultralytics 版本（无法读取时为空串或 "unknown"）
    pub ultralytics_version: String,
    pub missing_packages: Vec<String>,
    pub is_valid: bool,
}

/// 能加载 YOLO11（以及更早）版本的最低 ultralytics 版本。
const MIN_ULTRALYTICS: (u32, u32, u32) = (8, 3, 0);
/// 能加载 YOLO26 / YOLO27 的最低 ultralytics 版本。
const YOLO26_MIN_ULTRALYTICS: (u32, u32, u32) = (8, 4, 0);

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

#[cfg(not(debug_assertions))]
fn copy_file(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败 ({}): {}", parent.display(), e))?;
    }
    std::fs::copy(src, dst)
        .map_err(|e| format!("复制文件失败 ({} -> {}): {}", src.display(), dst.display(), e))?;
    Ok(())
}

#[cfg(not(debug_assertions))]
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

/// 安装包内嵌的后端源码（与 tauri.conf.json 的 bundle.resources 保持一致）
#[cfg(not(debug_assertions))]
const MANAGED_RESOURCES: [&str; 8] = [
    "app.py",
    "config.py",
    "requirements.txt",
    ".env.example",
    "routes",
    "services",
    "static",
    "models",
];

/// 只由安装包管理的代码目录（其中的陈旧 .py / __pycache__ 可以安全清除）
#[cfg(not(debug_assertions))]
const CODE_DIRS: [&str; 2] = ["routes", "services"];

/// 记录已同步到的版本。与当前版本不一致时，说明是升级后的首次启动，
/// 必须清理旧版本的 Python 模块，否则 `import services.xxx` 会命中残留文件。
#[cfg(not(debug_assertions))]
const RUNTIME_MARKER: &str = ".runtime-version";

#[cfg(not(debug_assertions))]
fn read_marker(runtime_dir: &std::path::Path) -> String {
    std::fs::read_to_string(runtime_dir.join(RUNTIME_MARKER))
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

/// 找出 `_up_` 资源目录。Tauri 会把 `../xxx` 形式的资源放到 `resource_dir/_up_`，
/// 不同版本 / 打包方式略有差异，所以按候选顺序探测而不是硬编码。
#[cfg(not(debug_assertions))]
fn resolve_resource_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .resource_dir()
        .map_err(|e| format!("找不到资源目录: {}", e))?;

    let candidates = [
        base.join("_up_"),
        base.clone(),
        base.join("resources"),
        base.join("resources").join("_up_"),
    ];

    for candidate in candidates {
        // app.py 是后端入口，用它判断这个候选目录是不是真的资源根
        if candidate.join("app.py").is_file() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "安装包资源不完整：在 {} 及 _up_ 下都没有找到 app.py（安装包可能损坏，请重新安装）",
        base.display()
    ))
}

/// 删除 `dst` 里在 `src` 中已不存在的 `.py` / `.pyc` / `__pycache__`。
/// 升级后上游可能删除了模块或改了目录结构，残留文件会遮蔽新代码。
#[cfg(not(debug_assertions))]
fn prune_removed_modules(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    let entries = match std::fs::read_dir(dst) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let counterpart = src.join(&name);

        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            if name == "__pycache__" {
                let _ = std::fs::remove_dir_all(&path);
            } else if counterpart.is_dir() {
                prune_removed_modules(&counterpart, &path)?;
            }
            continue;
        }

        if counterpart.exists() {
            continue;
        }

        let is_python = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("py") || ext.eq_ignore_ascii_case("pyc"))
            .unwrap_or(false);
        if is_python {
            let _ = std::fs::remove_file(&path);
        }
    }

    Ok(())
}

#[cfg(not(debug_assertions))]
fn sync_backend_runtime_dir(
    resource_dir: &std::path::Path,
    runtime_dir: &std::path::Path,
    version: &str,
) -> Result<(), String> {
    std::fs::create_dir_all(runtime_dir)
        .map_err(|e| format!("创建运行目录失败 ({}): {}", runtime_dir.display(), e))?;

    // 版本标记不一致 = 升级后的首次启动（或首次运行，旧版本没写标记）
    let stale = read_marker(runtime_dir) != version;

    for name in MANAGED_RESOURCES {
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

    if stale {
        for name in CODE_DIRS {
            let src = resource_dir.join(name);
            let dst = runtime_dir.join(name);
            if dst.is_dir() {
                prune_removed_modules(&src, &dst)?;
            }
        }
        // 根目录 app.py / config.py 的字节码缓存
        let _ = std::fs::remove_dir_all(runtime_dir.join("__pycache__"));

        std::fs::write(runtime_dir.join(RUNTIME_MARKER), version)
            .map_err(|e| format!("写入版本标记失败: {}", e))?;
    }

    // 兜底：同步后必须真的拿到后端入口，否则宁可报错也不要静默跑旧代码
    if !runtime_dir.join("app.py").is_file() {
        return Err(format!(
            "后端运行目录缺少 app.py（{}）",
            runtime_dir.display()
        ));
    }

    Ok(())
}

/// 确保 `backend_runtime` 与当前安装包一致，返回后端工作目录。
///
/// 关键点：这个函数必须**不依赖前端是否调用向导**。旧实现只在 `get_app_dir`
/// （仅配置向导使用）里同步，升级用户的 `appDir` 又存在 localStorage 里，
/// 因此向导不再出现 → 同步永不执行 → 继续用上一版本的 routes/services，
/// 表现为新接口 404 / 返回 HTML 导致前端 JSON 解析报错。
pub fn ensure_runtime(app: &tauri::AppHandle) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        // 开发模式直接用项目根目录，改代码即时生效
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "找不到项目根目录".to_string())?;
        return Ok(path.to_string_lossy().to_string());
    }

    #[cfg(not(debug_assertions))]
    {
        let resource_dir = resolve_resource_dir(app)?;
        let runtime_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("找不到本地数据目录: {}", e))?
            .join("backend_runtime");

        sync_backend_runtime_dir(&resource_dir, &runtime_dir, env!("CARGO_PKG_VERSION"))?;

        Ok(runtime_dir.to_string_lossy().to_string())
    }
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

    // ultralytics 版本检查：旧版本装得上但加载不了 YOLO11/26/27 权重，
    // 用户会看到「模型加载失败」，却不知道是包太旧。这里提前归类为依赖不完整。
    let ultralytics_version = read_ultralytics_version(path).unwrap_or_default();
    if !ultralytics_version.is_empty() {
        let current = parse_version_tuple(&ultralytics_version);
        if current < MIN_ULTRALYTICS {
            missing.push(format!(
                "ultralytics>={}.{}.{}（当前 {}，无法加载 YOLO11/26/27）",
                MIN_ULTRALYTICS.0, MIN_ULTRALYTICS.1, MIN_ULTRALYTICS.2, ultralytics_version
            ));
        } else if current < YOLO26_MIN_ULTRALYTICS {
            // 能跑 YOLO11，但 YOLO26/27 需要更新的版本：不算无效，但要让用户知道
            missing.push(format!(
                "ultralytics>={}.{}.{}（当前 {}，可运行 YOLO11，无法加载 YOLO26/27）",
                YOLO26_MIN_ULTRALYTICS.0,
                YOLO26_MIN_ULTRALYTICS.1,
                YOLO26_MIN_ULTRALYTICS.2,
                ultralytics_version
            ));
        }
    }

    CondaEnv {
        is_valid: missing.is_empty(),
        missing_packages: missing,
        name,
        path: path.to_string(),
        python_version: py_version,
        ultralytics_version,
    }
}

/// 解析 `8.4.189` / `8.3.0rc1` 这类版本号为可比较的三元组。
fn parse_version_tuple(raw: &str) -> (u32, u32, u32) {
    let cleaned: String = raw
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = cleaned.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// 从 site-packages 读取 ultralytics 的 `__version__`（纯文件读取，不启动 Python）。
fn read_ultralytics_version(env_path: &str) -> Option<String> {
    for dir in site_packages_dirs(env_path) {
        let init = dir.join("ultralytics").join("__init__.py");
        let Ok(content) = std::fs::read_to_string(&init) else {
            continue;
        };
        for line in content.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("__version__") {
                let value = rest
                    .trim_start()
                    .trim_start_matches('=')
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// 列出环境里所有可能的 site-packages 目录（Windows `Lib\` + Unix `lib/pythonX.Y/`）。
fn site_packages_dirs(env_path: &str) -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    let win = std::path::Path::new(env_path).join("Lib").join("site-packages");
    if win.exists() {
        dirs.push(win);
    }
    if let Ok(entries) = std::fs::read_dir(std::path::Path::new(env_path).join("lib")) {
        for entry in entries.flatten() {
            let candidate = entry.path().join("site-packages");
            if candidate.exists() {
                dirs.push(candidate);
            }
        }
    }
    dirs
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

/// 找出监听指定端口的进程 PID。
///
/// 为什么需要它：后端 Python 是子进程，若主程序被任务管理器强杀 / 崩溃，
/// 子进程会变成孤儿继续占着端口。新版本启动时抢不到端口，前端就连接到了
/// **旧版本的后端进程**，表现为「界面是新版，行为是旧版」——极难排查。
#[cfg(windows)]
fn find_pid_on_port(port: u16) -> Option<u32> {
    let mut command = std::process::Command::new("netstat");
    command.args(["-ano", "-p", "TCP"]);
    apply_no_window(&mut command);
    let output = command.output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let needle = format!(":{}", port);

    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 {
            continue;
        }
        // Proto 本地地址 外部地址 状态 PID
        if !cols[0].eq_ignore_ascii_case("TCP") || !cols[1].ends_with(&needle) {
            continue;
        }
        if !cols[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        if let Ok(pid) = cols[4].parse::<u32>() {
            return Some(pid);
        }
    }
    None
}

#[cfg(not(windows))]
fn find_pid_on_port(port: u16) -> Option<u32> {
    let output = std::process::Command::new("lsof")
        .args(["-t", &format!("-i:{}", port)])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .trim()
        .parse::<u32>()
        .ok()
}

#[cfg(windows)]
fn terminate_pid(pid: u32) -> bool {
    let mut command = std::process::Command::new("taskkill");
    command.args(["/F", "/PID", &pid.to_string()]);
    apply_no_window(&mut command);
    command.status().map(|s| s.success()).unwrap_or(false)
}

#[cfg(not(windows))]
fn terminate_pid(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 探测指定端口上的后端并返回 `/health` 内容（不可达时返回 None）。
async fn probe_health(port: u16) -> Option<serde_json::Value> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .ok()?;
    let resp = client
        .get(format!("http://127.0.0.1:{}/health", port))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<serde_json::Value>().await.ok()
}

fn health_version(health: &serde_json::Value) -> &str {
    health.get("app_version").and_then(|v| v.as_str()).unwrap_or("")
}

/// 确保端口上没有「旧版本残留」的后端。
///
/// 返回 Ok(Some(())) 表示已有一个**版本一致**的后端在跑，可直接复用；
/// Ok(None) 表示端口干净，可以启动新进程。
async fn clear_stale_backend(port: u16) -> Result<Option<()>, String> {
    let expected = env!("CARGO_PKG_VERSION");
    let Some(health) = probe_health(port).await else {
        return Ok(None);
    };

    let running = health_version(&health).to_string();
    if running == expected {
        return Ok(Some(()));
    }

    // 端口被旧版本（或无法识别版本的旧后端）占着 —— 必须清掉
    let Some(pid) = find_pid_on_port(port) else {
        return Err(format!(
            "端口 {} 已被其他程序占用（无法确定进程号），请关闭占用该端口的程序后重试",
            port
        ));
    };

    let _ = terminate_pid(pid);
    for _ in 0..24 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if probe_health(port).await.is_none() {
            return Ok(None);
        }
    }

    Err(format!(
        "端口 {} 被一个旧版本后端占用（正在运行 {}，当前 {}，PID {}），无法自动结束。\n\
         请在任务管理器中结束该进程后重启本应用。",
        port,
        if running.is_empty() { "未知版本" } else { &running },
        expected,
        pid
    ))
}

/// 启动 Python 后端（使用指定 conda 环境中的 Python）
#[tauri::command]
pub async fn start_backend(
    state: State<'_, BackendState>,
    app: tauri::AppHandle,
    python_exe: String,
    app_dir: String,
    port: u16,
) -> Result<(), String> {
    // 不要盲信前端传来的 app_dir：老版本把路径存进了 localStorage，
    // 升级后它仍指向同一个 backend_runtime，但里面的代码需要重新同步。
    let app_dir = ensure_runtime(&app).unwrap_or(app_dir);

    // 端口上若趴着旧版本后端（主程序被强杀留下的孤儿），必须先清掉，
    // 否则新进程抢不到端口，前端会静默连上旧代码。
    if clear_stale_backend(port).await?.is_some() {
        return Ok(());
    }

    // 把 Python 的 stdout/stderr 重定向到临时日志文件，方便诊断
    let log_path = std::env::temp_dir().join("easy_infer_backend.log");

    // 第一阶段：在同步块内生成进程。
    // MutexGuard 是 !Send，必须严格限制在块内，不能跨越后面的 await。
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
            .env("PYTHONIOENCODING", "utf-8")
            // 让后端在 /health 里自报版本，客户端才能识别「连的是不是旧代码」
            .env("EIS_APP_VERSION", env!("CARGO_PKG_VERSION"))
            .current_dir(&app_dir)
            .stdout(log_file)
            .stderr(log_clone);
        apply_no_window(&mut command);

        let child = command
            .spawn()
            .map_err(|e| format!("启动 Python 失败（python={}, dir={}）: {}", python_exe, app_dir, e))?;

        *guard = Some(child);
    }

    // 第二阶段：等 1 秒后检查进程是否立即退出
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    // 同样在同步块内取出结果，避免把 guard 带过 await
    let early_exit = {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let status = match guard.as_mut() {
            Some(child) => child.try_wait().ok().flatten(),
            None => None,
        };
        match status {
            Some(status) => {
                *guard = None;
                let log = std::fs::read(&log_path)
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .unwrap_or_default();
                Some(format!(
                    "Python 进程启动后立即退出（exit code: {:?}）\n\n输出:\n{}",
                    status.code(),
                    if log.is_empty() {
                        "（无输出，可能是 DLL 缺失或路径错误）".to_string()
                    } else {
                        log
                    }
                ))
            }
            None => None,
        }
    };
    if let Some(message) = early_exit {
        return Err(message);
    }

    // 第三阶段：短暂等待健康检查，确认应答的确实是**本次新启的**后端。
    // 端口若仍被别的进程抢去，这里会给出明确的「版本不一致」提示，
    // 而不是让界面连着旧代码继续跑。
    let expected = env!("CARGO_PKG_VERSION");
    for _ in 0..20 {
        if let Some(health) = probe_health(port).await {
            let running = health_version(&health);
            if running == expected {
                return Ok(());
            }
            if !running.is_empty() {
                // 刚启动的进程不会报出别的版本号，说明端口被别人占了
                return Err(format!(
                    "后端端口 {} 返回的版本是 {}，与当前应用 {} 不一致。\n\
                     可能有一个旧版本后端仍在运行，请结束它后重启本应用。",
                    port, running, expected
                ));
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }

    // 健康检查迟迟不通也不报错：CUDA 初始化本来就慢，交给前端继续轮询
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
    std::fs::read(&log_path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
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

/// 返回 app.py 所在目录（并确保它与当前安装包一致）
/// - Debug 构建（tauri dev）：CARGO_MANIFEST_DIR 的父目录（即项目根目录）
/// - Release 构建：`backend_runtime`（从安装包资源同步而来）
#[tauri::command]
pub fn get_app_dir(app: tauri::AppHandle) -> Result<String, String> {
    ensure_runtime(&app)
}
