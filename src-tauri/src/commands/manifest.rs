//! 依赖清单导出。
//!
//! 场景：用户的机器上还没有一个满足要求的 conda 环境时，需要「一键导出安装清单」，
//! 再拿到 [Easy Conda](https://github.com/MWang-TS/easy-conda) 里导入安装。
//!
//! 关键设计：
//! - **编译期内嵌** `requirements.txt`，不读运行时文件。
//!   用户恰恰是在「没有可用环境」时用这个功能，此时后端可能根本没起来，
//!   也拿不到可靠的文件路径；内嵌可保证任何情况下都能导出。
//! - 生成的 `environment.yml` 必须能被 Easy Conda 的
//!   `parse_yaml_preview` → `import_environment_yaml`（即 `conda env create -f`）直接吃下，
//!   因此只使用 `name / channels / dependencies（含 pip 子列表）` 这几个字段。

use serde::Serialize;
use std::path::Path;

/// 依赖规格的唯一真相源。改依赖只改仓库根目录的 `requirements.txt`。
const REQUIREMENTS_TXT: &str = include_str!("../../../requirements.txt");

/// 生成的 conda 环境使用的 Python 版本。
///
/// 与 README 的安装说明保持一致；`ultralytics` / `torch` 在此版本上组合最稳。
const PYTHON_VERSION: &str = "3.10";

/// 生成的环境名（导入时可被用户覆盖）。
const ENV_NAME: &str = "easy-infer-station";

#[derive(Debug, Serialize, Clone)]
pub struct DepItem {
    /// 包名（原样，保留 PyPI 上的大小写）。
    pub name: String,
    /// 版本约束原文，如 `==8.2.89` / `>=2.0.0`；未指定时为空串。
    pub spec: String,
    /// 便于 UI 展示的完整规格，如 `ultralytics==8.2.89`。
    pub requirement: String,
}

#[derive(Debug, Serialize)]
pub struct DepManifest {
    pub python_version: String,
    pub env_name: String,
    pub channels: Vec<String>,
    pub packages: Vec<DepItem>,
    /// 依赖总数，省得前端再算。
    pub count: usize,
    pub app_version: String,
    /// 补充说明（展示给用户，避免踩坑）。
    pub notes: Vec<String>,
}

/// 解析 `requirements.txt`：忽略空行、`#` 注释与 `-r/-e` 等选项行。
fn parse_requirements() -> Vec<DepItem> {
    let mut items = Vec::new();
    for raw in REQUIREMENTS_TXT.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // 行内注释：`Flask==3.0.0  # 说明`
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() || line.starts_with('-') {
            continue;
        }
        // 环境标记（`; python_version < "3.9"`）不参与包名/版本拆分
        let (core, marker) = match line.split_once(';') {
            Some((left, right)) => (left.trim(), Some(right.trim())),
            None => (line, None),
        };
        let (name, spec) = split_name_spec(core);
        if name.is_empty() {
            continue;
        }
        let requirement = match marker {
            Some(marker) if !marker.is_empty() => format!("{core}; {marker}"),
            _ => core.to_string(),
        };
        items.push(DepItem {
            name: name.to_string(),
            spec: spec.to_string(),
            requirement,
        });
    }
    items
}

/// 拆出包名与版本约束：`torch>=2.0.0` → (`torch`, `>=2.0.0`)。
fn split_name_spec(text: &str) -> (&str, &str) {
    for (idx, ch) in text.char_indices() {
        if matches!(ch, '=' | '>' | '<' | '!' | '~' | ' ' | '[') {
            return (&text[..idx], text[idx..].trim());
        }
    }
    (text.trim(), "")
}

fn manifest() -> DepManifest {
    let packages = parse_requirements();
    DepManifest {
        python_version: PYTHON_VERSION.to_string(),
        env_name: ENV_NAME.to_string(),
        channels: vec!["conda-forge".to_string()],
        count: packages.len(),
        packages,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        notes: vec![
            "PyPI 上的 torch 默认包含 CUDA 运行时，包体积较大；纯 CPU 机器可以装，只是下载慢。"
                .to_string(),
            "如需 GPU 加速，装完环境后按显卡 CUDA 版本重装 torch：".to_string(),
            "  pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121"
                .to_string(),
            "本清单是依赖定义，不是离线包缓存；重建时会从渠道/镜像重新下载。".to_string(),
        ],
    }
}

/// 返回依赖清单（不落盘）。前端用于展示「当前需要哪些库、什么版本」。
#[tauri::command]
pub fn get_dependency_manifest() -> DepManifest {
    manifest()
}

/// 生成 `environment.yml` 文本（供前端「复制」使用，也可单独预览）。
#[tauri::command]
pub fn render_environment_yml() -> String {
    build_environment_yml(&manifest())
}

/// 生成 `requirements.txt` 文本（与仓库里的保持一致，便于直接 `pip install -r`）。
#[tauri::command]
pub fn render_requirements_txt() -> String {
    REQUIREMENTS_TXT.replace("\r\n", "\n")
}

#[tauri::command]
pub fn export_environment_yml(destination: String) -> Result<String, String> {
    let content = build_environment_yml(&manifest());
    write_atomic(Path::new(&destination), &content)?;
    Ok(destination)
}

#[tauri::command]
pub fn export_requirements_txt(destination: String) -> Result<String, String> {
    let content = render_requirements_txt();
    write_atomic(Path::new(&destination), &content)?;
    Ok(destination)
}

/// 构造 `environment.yml`。
///
/// 全部第三方库放进 `pip:` 子列表：
/// - 与 README 的安装方式完全一致，用户已熟悉的那些命令无需改写
/// - conda 仅为装 Python 与 pip 服务，避免 conda 与 pip 混装同一个包导致冲突
fn build_environment_yml(manifest: &DepManifest) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "# Easy Infer Station v{} 依赖清单\n\
         # 由 Easy Infer Station 自动生成，可直接在 Easy Conda 的「环境 → 导入」中使用。\n\
         # 生成内容随应用版本变化，请勿手工维护。\n",
        manifest.app_version
    ));
    out.push_str(&format!("name: {}\n", manifest.env_name));
    out.push_str("channels:\n");
    for channel in &manifest.channels {
        out.push_str(&format!("  - {channel}\n"));
    }
    out.push_str("dependencies:\n");
    out.push_str(&format!("  - python={}\n", manifest.python_version));
    out.push_str("  - pip\n");
    out.push_str("  - pip:\n");
    for item in &manifest.packages {
        // YAML 里含 `#` 的值必须加引号，否则会被当成注释截断
        let value = quote_yaml(&item.requirement);
        out.push_str(&format!("      - {value}\n"));
    }
    out
}

/// 只在必要时加引号：含 YAML 特殊字符（`#`、`:`、`[`、`{`、引号、前后空白）时转为单引号字符串。
fn quote_yaml(value: &str) -> String {
    let needs_quote = value.is_empty()
        || value.starts_with(' ')
        || value.ends_with(' ')
        || value
            .chars()
            .any(|ch| matches!(ch, '#' | ':' | '[' | ']' | '{' | '}' | '\'' | '"' | '&' | '*' | '?' | '|' | '>' | '%' | '@' | '`'));
    if needs_quote {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        value.to_string()
    }
}

/// 原子写入：先写同目录临时文件再 rename，失败不会留下半截目标文件。
fn write_atomic(dest: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败 ({}): {}", parent.display(), e))?;
    }
    let tmp = dest.with_extension(format!(
        "{}.tmp",
        dest.extension().and_then(|e| e.to_str()).unwrap_or("txt")
    ));
    std::fs::write(&tmp, content.as_bytes())
        .map_err(|e| format!("写入临时文件失败 ({}): {}", tmp.display(), e))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("保存文件失败 ({}): {}", dest.display(), e)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_packages() {
        let items = parse_requirements();
        assert!(items.len() >= 15, "应解析出全部依赖，实际 {}", items.len());
        let flask = items.iter().find(|i| i.name == "Flask").expect("Flask");
        assert_eq!(flask.spec, "==3.0.0");
        assert_eq!(flask.requirement, "Flask==3.0.0");
    }

    #[test]
    fn yml_is_valid_structure() {
        let yml = build_environment_yml(&manifest());
        // 落盘供人工/外部校验（控制台编码会污染中文，看不出真实内容）
        let path = std::env::temp_dir().join("eis-generated-environment.yml");
        std::fs::write(&path, yml.as_bytes()).expect("write temp yml");
        println!("WROTE {}", path.display());
        assert!(yml.starts_with('#'));
        assert!(yml.contains("\nname: easy-infer-station\n"));
        assert!(yml.contains("\n  - python=3.10\n"));
        assert!(yml.contains("\n  - pip:\n"));
        assert!(yml.contains("\n      - opencv-python==4.10.0.84\n"));
        assert!(!yml.contains('\r'));
    }
}
