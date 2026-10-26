"""
# services/model_sources.py

## 核心功能
定义 Ultralytics 预训练权重的下载源（官方 GitHub / 国内魔搭镜像 / 第三方加速），
并把「文件名 + 源」翻译成有序的候选 URL 列表。

### 为什么要单独一层
- 国内直连 GitHub 的 release 资产经常只有 20~30 KB/s，一个 5MB 的 n 级权重都要几分钟。
- 魔搭（ModelScope）的 `Ultralytics/*` 仓库是官方同步的，实测 400+ KB/s，
  且权重数值与 GitHub 版本完全一致（state_dict 哈希相同，仅 zip 打包元数据不同）。
- 第三方加速站（ghfast / gh-proxy）只是 URL 前缀代理，属于可信度未知的中间人；
  `.pt` 是 pickle 容器，加载即执行代码，所以它们的可信标记为 False，需用户显式选择。

### 魔搭覆盖范围（实测，2025-01）
| 家族   | detect | segment | pose | classify | obb |
|--------|--------|---------|------|----------|-----|
| YOLO26 | ✅     | ✅      | ✅   | ✅       | ✅  |
| YOLO11 | ✅     | ✅      | ✅   | ❌       | ❌  |
| YOLOv8 | ✅     | ❌      | ❌   | ❌       | ❌  |

未覆盖的组合由「自动」源回落到官方 GitHub，不会静默拿错文件。
"""
from __future__ import annotations

from services import model_registry as registry

# 官方 GitHub release 资产
GITHUB_REPO = "ultralytics/assets"
# 按新→旧尝试，最后回退 latest（不同家族落在不同 tag 下）
GITHUB_RELEASE_TAGS = ("v8.4.0", "v8.3.0", "latest")
GITHUB_URL_TEMPLATE = "https://github.com/{repo}/releases/download/{tag}/{name}"

# 第三方 GitHub 加速前缀（按实测速度排序）
PROXY_PREFIXES = (
    ("ghfast.top", "https://ghfast.top/"),
    ("gh-proxy.com", "https://gh-proxy.com/"),
)

# 魔搭上官方同步的仓库（家族 → repo）
MODELSCOPE_REPOS = {
    "yolo26": "Ultralytics/YOLO26",
    "yolo11": "Ultralytics/YOLO11",
    "yolov11": "Ultralytics/YOLO11",
    "yolov8": "Ultralytics/YOLOv8",
}

# 魔搭实际同步到的任务（未列出的任务文件在魔搭不存在，请求会 404）
MODELSCOPE_TASKS = {
    "yolo26": ("detect", "segment", "pose", "classify", "obb"),
    "yolo11": ("detect", "segment", "pose"),
    "yolov11": ("detect", "segment", "pose"),
    "yolov8": ("detect",),
}

MODELSCOPE_URL_TEMPLATE = "https://modelscope.cn/models/{repo}/resolve/master/{name}"

# 对外暴露的源清单（顺序即 UI 展示顺序）
SOURCES = (
    {
        "id": "auto",
        "label": "自动（国内优先）",
        "description": "优先走魔搭镜像，该源没有的文件自动回落到官方 GitHub。",
        "trusted": True,
        "recommended": True,
    },
    {
        "id": "modelscope",
        "label": "魔搭 ModelScope",
        "description": "国内直连速度快，由 Ultralytics 官方账号同步，权重与官方一致。",
        "trusted": True,
        "recommended": False,
    },
    {
        "id": "github",
        "label": "GitHub 官方",
        "description": "官方 release 原始地址，国内可能很慢甚至超时。",
        "trusted": True,
        "recommended": False,
    },
    {
        "id": "proxy",
        "label": "第三方加速",
        "description": "经 ghfast.top / gh-proxy.com 代理，速度较好但属第三方中间人，请自行评估。",
        "trusted": False,
        "recommended": False,
    },
)

SOURCE_IDS = tuple(item["id"] for item in SOURCES)
DEFAULT_SOURCE = "auto"


def normalize_source(source: str | None) -> str:
    """把外部传入的源标识收敛到已知值，未知值回落到默认源。"""
    value = str(source or "").strip().lower()
    return value if value in SOURCE_IDS else DEFAULT_SOURCE


def get_source(source: str | None) -> dict:
    target = normalize_source(source)
    for item in SOURCES:
        if item["id"] == target:
            return dict(item)
    return dict(SOURCES[0])


def modelscope_repo(name: str) -> str | None:
    """该权重在魔搭对应的 repo；不存在则返回 None。"""
    info = registry.parse_model_name(name)
    if not info:
        return None
    family = info["family"]
    repo = MODELSCOPE_REPOS.get(family)
    if not repo:
        return None
    if info["task"] not in MODELSCOPE_TASKS.get(family, ()):
        return None
    if not info["size"]:
        return None
    return repo


def supports_modelscope(name: str) -> bool:
    return modelscope_repo(name) is not None


def modelscope_url(name: str) -> str | None:
    repo = modelscope_repo(name)
    if not repo:
        return None
    return MODELSCOPE_URL_TEMPLATE.format(repo=repo, name=name)


def github_urls(name: str) -> list[tuple[str, str]]:
    """官方 GitHub 各 tag 的候选地址：[(说明, url), ...]"""
    return [
        (
            f"GitHub {tag}",
            GITHUB_URL_TEMPLATE.format(repo=GITHUB_REPO, tag=tag, name=name),
        )
        for tag in GITHUB_RELEASE_TAGS
    ]


def proxy_urls(name: str) -> list[tuple[str, str]]:
    candidates = []
    for host, prefix in PROXY_PREFIXES:
        for tag in GITHUB_RELEASE_TAGS:
            plain = GITHUB_URL_TEMPLATE.format(repo=GITHUB_REPO, tag=tag, name=name)
            candidates.append((f"{host} {tag}", f"{prefix}{plain}"))
    return candidates


def build_candidates(name: str, source: str | None) -> list[tuple[str, str]]:
    """按优先级返回 [(来源说明, url), ...]。

    - `auto`：魔搭（若覆盖该文件名）→ 官方 GitHub 各 tag
    - `modelscope`：仅魔搭（不做静默回落，避免用户以为走了国内源实际走了官方）
    - `github`：仅官方 GitHub 各 tag
    - `proxy`：第三方加速各前缀 × 各 tag
    """
    selected = normalize_source(source)

    if selected == "modelscope":
        url = modelscope_url(name)
        return [("魔搭 ModelScope", url)] if url else []

    if selected == "github":
        return github_urls(name)

    if selected == "proxy":
        return proxy_urls(name)

    # auto
    candidates = []
    url = modelscope_url(name)
    if url:
        candidates.append(("魔搭 ModelScope", url))
    candidates.extend(github_urls(name))
    return candidates


def source_support(name: str) -> list[str]:
    """该文件可用的显式源（auto 恒可用，不列在这里）。"""
    available = ["github", "proxy"]
    if supports_modelscope(name):
        available.insert(0, "modelscope")
    return available
