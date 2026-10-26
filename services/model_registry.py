"""
# services/model_registry.py

## 核心功能
模型家族 / 任务能力 / 下载预设的唯一真相源。

### 为什么需要它
Ultralytics 一个包同时支持 YOLOv5 / v8 / v9 / v10 / v11 / v12 / YOLO26 / YOLO27，
而且同一家族下还有 `detect / segment / classify / pose / obb` 五种任务。

**任务不是由 UI 开关决定的，而是模型文件自带的元数据**：
`YOLO('xxx.pt').task` 就说明了它是什么任务。任何按文件名或按钮猜任务的写法，
都会在用户换模型后出错（历史上 pose 需要额外传 `task='pose'`，对 detect 模型是无效甚至有害的）。

因此这里把「任务判定 + 结果解析」集中在一处，推理服务与 HTTP 接口都只调本模块。
"""
from __future__ import annotations

import re

# Ultralytics 支持的 5 种 .pt 任务（语义分割/深度估计等暂不是 .pt 训练产物）
SUPPORTED_TASKS = ("detect", "segment", "classify", "pose", "obb")

TASK_LABELS = {
    "detect": "目标检测",
    "segment": "实例分割",
    "classify": "图像分类",
    "pose": "姿态估计",
    "obb": "旋转框检测",
}

TASK_DESCRIPTIONS = {
    "detect": "输出目标的矩形框与类别",
    "segment": "输出目标矩形框 + 像素级掩膜",
    "classify": "输出整图（或 ROI 抠图）的类别，无框",
    "pose": "输出人体关键点，可做摔倒判定",
    "obb": "输出带角度的旋转框（航拍/文档等场景）",
}

# 文件名后缀 → 任务。detect 无后缀。
TASK_SUFFIXES = {
    "": "detect",
    "-seg": "segment",
    "-cls": "classify",
    "-pose": "pose",
    "-obb": "obb",
}

# 家族前缀 → 展示信息。顺序无要求，匹配时按长度倒序。
MODEL_FAMILIES = {
    "yolov8": {"label": "YOLOv8", "min_ultralytics": "8.0.0"},
    "yolov9": {"label": "YOLOv9", "min_ultralytics": "8.2.0"},
    "yolov10": {"label": "YOLOv10", "min_ultralytics": "8.2.0"},
    "yolo11": {"label": "YOLO11", "min_ultralytics": "8.3.0"},
    "yolov11": {"label": "YOLO11", "min_ultralytics": "8.3.0"},
    "yolo12": {"label": "YOLO12", "min_ultralytics": "8.3.0"},
    "yolo26": {"label": "YOLO26", "min_ultralytics": "8.4.0"},
    "yolo27": {"label": "YOLO27", "min_ultralytics": "8.4.0"},
    "yolov5": {"label": "YOLOv5", "min_ultralytics": "8.0.0"},
}

# 官方权重尺寸后缀
MODEL_SIZES = ("n", "s", "m", "l", "x")

SIZE_LABELS = {
    "n": "nano（最快）",
    "s": "small",
    "m": "medium（均衡）",
    "l": "large",
    "x": "xlarge（最准）",
}

# 首页展示的推荐预设：只需给「家族 + 任务」，其余按官方命名规则拼出文件名。
PRESET_FAMILIES = ("yolo26", "yolo11", "yolov8")
PRESET_TASKS = ("detect", "segment", "pose", "classify", "obb")
PRESET_SIZES = ("n", "s", "m")

# 官方暂未发布 YOLO27 权重（截至 ultralytics 8.4.x 仅在文档中预览）。
# 一旦发布，无需改代码：只要文件名符合 yolo27n.pt 的命名规则即可直接加载。
UNRELEASED_FAMILIES = ("yolo27",)


def _family_prefixes_by_length():
    return sorted(MODEL_FAMILIES.keys(), key=len, reverse=True)


def parse_model_name(name: str) -> dict | None:
    """从权重文件名解析家族 / 尺寸 / 任务。

    `yolo11n-pose.pt` → {family: 'yolo11', size: 'n', task: 'pose'}
    无法识别时返回 None（用户自训练模型的文件名通常不含这些信息）。
    """
    if not isinstance(name, str):
        return None
    stem = name.strip().replace("\\", "/").rsplit("/", 1)[-1]
    if not stem.lower().endswith(".pt"):
        return None
    stem = stem[:-3].lower()

    family = ""
    for prefix in _family_prefixes_by_length():
        if stem.startswith(prefix):
            family = prefix
            break
    if not family:
        return None

    rest = stem[len(family):]
    task = "detect"
    for suffix, suffix_task in TASK_SUFFIXES.items():
        if suffix and rest.endswith(suffix):
            task = suffix_task
            rest = rest[: -len(suffix)]
            break

    size = rest if rest in MODEL_SIZES else ""
    return {
        "family": family,
        "family_label": MODEL_FAMILIES[family]["label"],
        "size": size,
        "task": task,
        "task_label": TASK_LABELS.get(task, task),
    }


def build_weight_name(family: str, size: str, task: str) -> str:
    """按官方命名规则拼权重文件名：`yolo11` + `n` + `pose` → `yolo11n-pose.pt`。"""
    suffix = ""
    for key, value in TASK_SUFFIXES.items():
        if value == task:
            suffix = key
            break
    return f"{family}{size}{suffix}.pt"


def download_presets() -> list[dict]:
    """可一键下载的官方权重列表（按家族 → 任务 → 尺寸展开）。"""
    presets = []
    for family in PRESET_FAMILIES:
        meta = MODEL_FAMILIES[family]
        for task in PRESET_TASKS:
            for size in PRESET_SIZES:
                name = build_weight_name(family, size, task)
                presets.append(
                    {
                        "name": name,
                        "family": family,
                        "family_label": meta["label"],
                        "task": task,
                        "task_label": TASK_LABELS[task],
                        "size": size,
                        "size_label": SIZE_LABELS[size],
                        "min_ultralytics": meta["min_ultralytics"],
                        "available": family not in UNRELEASED_FAMILIES,
                    }
                )
    return presets


def resolve_task(model, fallback: str = "detect") -> str:
    """取模型自身的任务；拿不到时退回 fallback。"""
    task = getattr(model, "task", None)
    if isinstance(task, str) and task in SUPPORTED_TASKS:
        return task
    return fallback if fallback in SUPPORTED_TASKS else "detect"


def describe_model(model, model_path: str) -> dict:
    """模型信息（供接口返回给前端展示）。"""
    parsed = parse_model_name(model_path) or {}
    task = resolve_task(model)
    names = getattr(model, "names", None) or {}
    family = parsed.get("family", "")
    return {
        "task": task,
        "task_label": TASK_LABELS.get(task, task),
        "task_description": TASK_DESCRIPTIONS.get(task, ""),
        "family": family,
        "family_label": parsed.get("family_label") or "自定义模型",
        "size": parsed.get("size", ""),
        "class_count": len(names),
        "tasks": list(SUPPORTED_TASKS),
    }


# ─── 结果解析 ────────────────────────────────────────────────
#
# 同一份逻辑要覆盖三种结果形态：
#   detect/segment/pose → result.boxes
#   obb                 → result.obb（无 xyxyn，需按图像尺寸归一化）
#   classify            → result.probs
#
# 这些 helper 都做「空结果安全」，调用方不用到处写 hasattr。


def get_items(result):
    """返回 (kind, container)。kind ∈ 'obb' | 'boxes'；无目标返回 (None, None)。

    OBB 优先：OBB 模型下 `result.boxes` 可能为 None，而 `result.obb` 一定存在。
    """
    obb = getattr(result, "obb", None)
    if obb is not None:
        try:
            if len(obb) > 0:
                return "obb", obb
        except TypeError:
            pass
    boxes = getattr(result, "boxes", None)
    if boxes is not None:
        try:
            if len(boxes) > 0:
                return "boxes", boxes
        except TypeError:
            pass
    return None, None


def count_items(result) -> int:
    """目标数量：框 / 旋转框 / 掩膜三种都算。"""
    kind, items = get_items(result)
    if kind is not None:
        return len(items)
    masks = getattr(result, "masks", None)
    data = getattr(masks, "data", None)
    if data is not None and hasattr(data, "__len__"):
        return len(data)
    return 0


def filter_by_labels(result, selected_labels) -> None:
    """按类别 id 过滤结果（原地修改）。boxes 与 obb 都处理。"""
    if not selected_labels:
        return
    keep = {int(v) for v in selected_labels}
    import torch

    for attr in ("boxes", "obb"):
        obj = getattr(result, attr, None)
        if obj is None:
            continue
        try:
            classes = obj.cls
            if classes is None or len(classes) == 0:
                continue
            mask = torch.tensor([int(c.item()) in keep for c in classes])
            setattr(result, attr, obj[mask])
        except Exception:
            continue


def iter_items(result):
    """逐条产出 `{class_id, class_name, confidence, center, box, quad}`。

    - `center` / `box` 均为**归一化**坐标，OBB 也换算成外接矩形
    - `quad` 仅 OBB 有：归一化后的 4 个角点，用于绘制旋转框
    """
    h, w = getattr(result, "orig_shape", (1, 1))[:2]
    w = max(int(w), 1)
    h = max(int(h), 1)
    names = getattr(result, "names", None) or {}

    kind, items = get_items(result)
    if kind is None:
        return

    try:
        confs = items.conf.cpu().numpy() if items.conf is not None else []
        classes = items.cls.cpu().numpy() if items.cls is not None else []
    except Exception:
        return

    if kind == "boxes":
        try:
            boxes = items.xyxy.cpu().numpy()
        except Exception:
            return
        for idx, (x1, y1, x2, y2) in enumerate(boxes):
            cls_id = int(classes[idx]) if idx < len(classes) else -1
            yield {
                "class_id": cls_id,
                "class_name": str(names.get(cls_id, cls_id)),
                "confidence": float(confs[idx]) if idx < len(confs) else 0.0,
                "box": (
                    float(x1) / w,
                    float(y1) / h,
                    float(x2) / w,
                    float(y2) / h,
                ),
                "center": (
                    (float(x1) + float(x2)) / 2 / w,
                    (float(y1) + float(y2)) / 2 / h,
                ),
                "quad": None,
            }
        return

    # OBB：xywhr（中心点 + 宽高 + 角度）与 xyxyxyxy（4 角点）
    try:
        xywhr = items.xywhr.cpu().numpy()
        quads = items.xyxyxyxy.cpu().numpy()
    except Exception:
        return
    for idx, (cx, cy, bw, bh, _angle) in enumerate(xywhr):
        cls_id = int(classes[idx]) if idx < len(classes) else -1
        quad = None
        if idx < len(quads):
            quad = tuple((float(p[0]) / w, float(p[1]) / h) for p in quads[idx])
        yield {
            "class_id": cls_id,
            "class_name": str(names.get(cls_id, cls_id)),
            "confidence": float(confs[idx]) if idx < len(confs) else 0.0,
            "box": (
                (float(cx) - float(bw) / 2) / w,
                (float(cy) - float(bh) / 2) / h,
                (float(cx) + float(bw) / 2) / w,
                (float(cy) + float(bh) / 2) / h,
            ),
            "center": (float(cx) / w, float(cy) / h),
            "quad": quad,
        }
