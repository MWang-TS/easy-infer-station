import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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

export interface CondaEnv {
  name: string;
  path: string;
  python_version: string;
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
