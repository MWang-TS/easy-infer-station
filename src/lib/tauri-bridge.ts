import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

const LAST_INPUT_PATH_KEY = "easyolo_last_input_path";
const LAST_MODEL_PATH_KEY = "easyolo_last_model_path";

/** 打开系统文件对话框，返回用户选择的文件绝对路径（取消返回 null）。记忆上次路径。 */
export async function browseFile(inputType: "image" | "video"): Promise<string | null> {
  const filters =
    inputType === "image"
      ? [{ name: "图片", extensions: ["jpg", "jpeg", "png", "bmp", "webp", "gif"] }]
      : [{ name: "视频", extensions: ["mp4", "avi", "mov", "mkv", "webm"] }];
  const lastPath = localStorage.getItem(LAST_INPUT_PATH_KEY) ?? undefined;
  const result = await open({ multiple: false, filters, defaultPath: lastPath });
  const path = typeof result === "string" ? result : null;
  if (path) localStorage.setItem(LAST_INPUT_PATH_KEY, path);
  return path;
}

/** 打开系统文件对话框，多选图片文件，返回路径数组（取消返回 null）。 */
export async function browseMultipleImageFiles(): Promise<string[] | null> {
  const lastPath = localStorage.getItem(LAST_INPUT_PATH_KEY) ?? undefined;
  const result = await open({
    multiple: true,
    filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "bmp", "webp"] }],
    defaultPath: lastPath,
  });
  const paths = Array.isArray(result) ? result : result ? [result] : null;
  if (paths && paths.length > 0) localStorage.setItem(LAST_INPUT_PATH_KEY, paths[0]);
  return paths;
}

/** 打开系统文件对话框，选择 YOLO .pt 模型文件（取消返回 null）。记忆上次路径。 */
export async function browseModelFile(): Promise<string | null> {
  const lastPath = localStorage.getItem(LAST_MODEL_PATH_KEY) ?? undefined;
  const result = await open({
    multiple: false,
    filters: [{ name: "YOLO 模型 (*.pt)", extensions: ["pt"] }],
    defaultPath: lastPath,
  });
  const path = typeof result === "string" ? result : null;
  if (path) localStorage.setItem(LAST_MODEL_PATH_KEY, path);
  return path;
}

/** 打开系统文件对话框，选择 ROI JSON 文件（取消返回 null）。 */
export async function browseRoiJsonFile(): Promise<string | null> {
  const result = await open({
    multiple: false,
    filters: [{ name: "ROI JSON (*.json)", extensions: ["json"] }],
  });
  return typeof result === "string" ? result : null;
}

export interface CondaEnv {
  name: string;
  path: string;
  python_version: string;
  /** 检测到的 ultralytics 版本；低于 8.3 无法加载 YOLO11，低于 8.4 无法加载 YOLO26/27 */
  ultralytics_version?: string;
  missing_packages: string[];
  is_valid: boolean;
}

export interface BackendStatus {
  running: boolean;
  healthy: boolean;
  message: string;
}

export interface BackendClientConfig {
  api_token: string;
}

/** 列出系统所有 conda 环境 */
export async function listCondaEnvs(): Promise<CondaEnv[]> {
  return invoke<CondaEnv[]>("list_conda_envs");
}

/** 验证指定 conda 环境的依赖 */
export async function validateCondaEnv(envPath: string): Promise<CondaEnv> {
  return invoke<CondaEnv>("validate_conda_env", { envPath });
}

/** 启动 Python 后端 */
export async function startBackend(
  pythonExe: string,
  appDir: string,
  port: number
): Promise<void> {
  return invoke("start_backend", { pythonExe, appDir, port });
}

/** 停止 Python 后端 */
export async function stopBackend(): Promise<void> {
  return invoke("stop_backend");
}

/** 查询后端健康状态 */
export async function backendHealth(port: number): Promise<BackendStatus> {
  return invoke<BackendStatus>("backend_health", { port });
}

/** 读取前端连接后端所需的客户端配置，例如 API token */
export async function getBackendClientConfig(appDir: string): Promise<BackendClientConfig> {
  return invoke<BackendClientConfig>("get_backend_client_config", { appDir });
}

/** 获取 app.py 所在目录（dev=项目根目录，release=exe同级） */
export async function getAppDir(): Promise<string> {
  return invoke<string>("get_app_dir");
}

/** 检查 Python 后端子进程是否还在运行 */
export function checkBackendAlive(): Promise<boolean> {
  return invoke<boolean>("check_backend_alive");
}

/** 读取 Python 后端的输出日志（用于启动失败诊断） */
export function getBackendLog(): Promise<string> {
  return invoke<string>("get_backend_log");
}

// ─── 依赖清单导出 ───────────────────────────────────────────────
//
// 场景：用户机器上还没有满足要求的 conda 环境时，需要导出一份安装清单，
// 拿到 Easy Conda 里导入安装。清单来自**编译期内嵌**的 requirements.txt，
// 因此不依赖 Python 后端是否已启动。

export interface DepItem {
  name: string;
  /** 版本约束原文，如 `==8.2.89` / `>=2.0.0`；未指定时为空串。 */
  spec: string;
  /** 完整规格，如 `ultralytics==8.2.89`。 */
  requirement: string;
}

export interface DepManifest {
  python_version: string;
  env_name: string;
  channels: string[];
  packages: DepItem[];
  count: number;
  app_version: string;
  notes: string[];
}

/** 读取依赖清单（用于界面展示）。 */
export function getDependencyManifest(): Promise<DepManifest> {
  return invoke<DepManifest>("get_dependency_manifest");
}

/** 生成 environment.yml 文本（复制用）。 */
export function renderEnvironmentYml(): Promise<string> {
  return invoke<string>("render_environment_yml");
}

/** 生成 requirements.txt 文本（复制用）。 */
export function renderRequirementsTxt(): Promise<string> {
  return invoke<string>("render_requirements_txt");
}

/** 弹出保存对话框并写入 environment.yml，返回保存路径（取消返回 null）。 */
export async function saveEnvironmentYml(
  defaultName = "easy-infer-station-env.yml"
): Promise<string | null> {
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: "Conda 环境清单", extensions: ["yml", "yaml"] }],
  });
  if (!path) return null;
  return invoke<string>("export_environment_yml", { destination: path });
}

/** 弹出保存对话框并写入 requirements.txt，返回保存路径（取消返回 null）。 */
export async function saveRequirementsTxt(
  defaultName = "requirements.txt"
): Promise<string | null> {
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: "pip 依赖清单", extensions: ["txt"] }],
  });
  if (!path) return null;
  return invoke<string>("export_requirements_txt", { destination: path });
}

export interface UpdateInfo {
  has_update: boolean;
  latest_version: string;
  current_version: string;
  release_notes: string;
  release_url: string;
}

/** 检查 GitHub Releases 是否有新版本 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("check_for_updates");
}
