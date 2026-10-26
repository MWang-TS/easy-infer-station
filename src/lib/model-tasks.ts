/**
 * 模型任务元数据（与后端 `services/model_registry.py` 保持一致）。
 *
 * 任务由模型文件自身决定（`YOLO(path).task`），UI 只做展示，
 * 不再用「目标检测 / 分类」按钮去猜 —— 猜错会在换模型后静默失效。
 */

export const SUPPORTED_TASKS = ["detect", "segment", "classify", "pose", "obb"] as const;

export type ModelTask = (typeof SUPPORTED_TASKS)[number];

export const TASK_LABELS: Record<ModelTask, string> = {
  detect: "目标检测",
  segment: "实例分割",
  classify: "图像分类",
  pose: "姿态估计",
  obb: "旋转框检测",
};

export const TASK_DESCRIPTIONS: Record<ModelTask, string> = {
  detect: "输出目标矩形框与类别",
  segment: "输出矩形框 + 像素级掩膜",
  classify: "输出整图（或 ROI 抠图）类别，无框",
  pose: "输出人体关键点，可做摔倒判定",
  obb: "输出带角度的旋转框（航拍 / 文档）",
};

/** 前端只区分「分类」与「其余（框类）」两套 UI 流程。 */
export function isClassifyTask(task: string | undefined | null): boolean {
  return task === "classify";
}

export function taskLabel(task: string | undefined | null): string {
  if (!task) return "";
  return TASK_LABELS[task as ModelTask] ?? task;
}

export function taskDescription(task: string | undefined | null): string {
  if (!task) return "";
  return TASK_DESCRIPTIONS[task as ModelTask] ?? "";
}

/** 后端返回的模型信息（`/api/model/labels`、`/api/model/info`）。 */
export interface ModelInfo {
  task?: string;
  task_label?: string;
  task_description?: string;
  family?: string;
  family_label?: string;
  size?: string;
  class_count?: number;
  model_path?: string;
  device?: string;
}

/** 可下载的官方权重（`/api/models/presets`）。 */
export interface ModelPreset {
  name: string;
  family: string;
  family_label: string;
  task: string;
  task_label: string;
  size: string;
  size_label: string;
  min_ultralytics: string;
  available: boolean;
  local?: boolean;
  /** 该文件可用的显式下载源 id（不含 auto，auto 恒可用） */
  sources?: string[];
}

/** 可选的权重下载源（`/api/models/presets` 的 `sources` 字段）。 */
export interface ModelSource {
  id: string;
  label: string;
  description: string;
  /** false 表示第三方中间人（`.pt` 是 pickle，加载即执行代码） */
  trusted: boolean;
  recommended: boolean;
}
