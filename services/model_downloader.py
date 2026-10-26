"""
# services/model_downloader.py

## 核心功能
按官方命名规则下载 Ultralytics 预训练权重到本地 `models/` 目录。

### 设计要点
- **不依赖 ultralytics 内部的下载实现**：`attempt_download_asset()` 会把文件下到
  进程 cwd，且 release tag 是硬编码的（YOLO11 与 YOLO26 不在同一个 tag）。
  这里自己拼 URL 并逐个 release 回退，落盘位置始终是 `models/`。
- **下载源可切换**：默认「自动」= 魔搭镜像优先、缺失时回落官方 GitHub。
  源定义在 `services/model_sources.py`（国内直连 GitHub 只有 20~30 KB/s）。
- **校验文件是真的权重**：`.pt` 是 torch 的 zip 容器。除了 `PK\\x03\\x04` 魔数和体积，
  还要能作为 zip 正常打开且 entries 非空 —— 镜像站返回的 HTML 错误页、
  被截断的半截文件都会被挡在这里，而不是留到加载时变成「模型损坏」。
- **断点续传不能跨源**：魔搭与 GitHub 的文件数值等价但字节不同（zip 元数据不同），
  所以 `.part` 会记录来源 URL，换源时必须丢弃重下，否则拼出一个坏文件。
- 下载失败要给出可操作的提示（网络受限时引导手动下载）。
"""
from __future__ import annotations

import os
import urllib.error
import urllib.request
import zipfile

from config import Config
from services import model_registry as registry
from services import model_sources as sources

# 权重最小体积（官方 n 级模型约 5~6MB；100KB 只是排除 HTML/空文件的兜底）
MIN_WEIGHT_BYTES = 100 * 1024
CHUNK_SIZE = 256 * 1024
# 单次 socket 读超时。国内直连 GitHub 的 CDN 偶尔会卡住十几秒，60 秒容易误判失败。
TIMEOUT_SECONDS = 120
# 单个来源的最大尝试次数（配合 Range 断点续传，弱网也能凑齐文件）。
MAX_ATTEMPTS = 3
# 可选镜像前缀（放在 URL 前面），覆盖界面上选择的下载源，供内网/自建镜像使用，例如
#   EIS_MODEL_MIRROR=https://ghfast.top/
MIRROR_ENV = "EIS_MODEL_MIRROR"


class ModelDownloadError(RuntimeError):
    """下载失败（网络不可达 / 资产不存在 / 内容非法）。"""


def local_path_for(name: str) -> str:
    """官方权重名在本地的目标路径。"""
    return os.path.join(Config.get_models_dir(), os.path.basename(name))


def _looks_like_weight(path: str) -> bool:
    """校验文件是真的 ultralytics 权重（zip 容器且可读）。"""
    try:
        if os.path.getsize(path) < MIN_WEIGHT_BYTES:
            return False
        with open(path, "rb") as handle:
            if handle.read(4) != b"PK\x03\x04":
                return False
    except OSError:
        return False

    # 半截 zip / 错误页伪装成 zip 时魔数与体积都可能通过，这里再验一次完整性
    try:
        with zipfile.ZipFile(path) as archive:
            return bool(archive.namelist())
    except (zipfile.BadZipFile, OSError):
        return False


def _part_url_matches(part: str, url: str) -> bool:
    """`<target>.part` 旁边记着它来自哪个 URL；跨源续传会拼出坏文件。"""
    try:
        with open(f"{part}.url", "r", encoding="utf-8") as handle:
            return handle.read().strip() == url
    except OSError:
        return False


def _discard(path: str) -> None:
    for candidate in (path, f"{path}.url"):
        try:
            os.remove(candidate)
        except OSError:
            pass


def _download_one(url: str, target: str, on_progress=None) -> None:
    """下载单个文件，支持 `.part` 断点续传与多次重试。

    续传很关键：国内直连 GitHub 时大文件常在最后几百 KB 卡死，
    每次从头重来等于永远下不完。
    """
    part = f"{target}.part"
    marker = f"{part}.url"
    last_error = None

    for _attempt in range(MAX_ATTEMPTS):
        resume_from = os.path.getsize(part) if os.path.exists(part) else 0
        # 上一次残留来自别的源（跨源字节不同）→ 不能接着写
        if resume_from and not _part_url_matches(part, url):
            _discard(part)
            resume_from = 0

        headers = {"User-Agent": "easy-infer-station"}
        if resume_from:
            headers["Range"] = f"bytes={resume_from}-"

        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                # 服务器不支持 Range 时会回 200 并从头开始，此时必须覆盖写
                if resume_from and response.status != 206:
                    resume_from = 0
                try:
                    with open(marker, "w", encoding="utf-8") as handle:
                        handle.write(url)
                except OSError:
                    pass
                total = int(response.headers.get("Content-Length") or 0) + resume_from
                received = resume_from
                if on_progress:
                    try:
                        on_progress(received, total)
                    except Exception:
                        on_progress = None

                with open(part, "ab" if resume_from else "wb") as out:
                    while True:
                        chunk = response.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        out.write(chunk)
                        received += len(chunk)
                        if on_progress:
                            try:
                                on_progress(received, total)
                            except Exception:
                                on_progress = None
        except Exception as exc:
            last_error = exc
            # 已下到的部分保留在 .part 里，下一轮从断点继续
            continue

        if not _looks_like_weight(part):
            _discard(part)
            raise ModelDownloadError("下载内容不是有效的模型文件")

        os.replace(part, target)
        # part 已被 rename 掉，这里只需顺带删掉它的 `.url` 标记
        _discard(part)
        return

    raise ModelDownloadError(f"下载中断：{last_error}")


def list_sources() -> list[dict]:
    """供前端渲染的下载源清单。"""
    return [dict(item) for item in sources.SOURCES]


def available_sources(name: str) -> list[str]:
    """该文件可用的显式源（不含 auto）。"""
    return sources.source_support(name)


def download_weight(name: str, on_progress=None, source: str | None = None) -> str:
    """按指定下载源把官方权重下到 `models/`，返回本地路径。

    `source` 见 `model_sources.SOURCES`（默认 `auto`：魔搭优先、回落官方）。
    `on_progress(received_bytes, total_bytes)` 会在分块写入时被调用。
    已存在同名有效文件时直接返回，不重复下载。
    """
    plain = os.path.basename(str(name or "").strip())
    info = registry.parse_model_name(plain)
    if not info:
        raise ModelDownloadError(f"不是可识别的官方权重名：{name}")
    if info["family"] in registry.UNRELEASED_FAMILIES:
        raise ModelDownloadError(f"{plain} 尚未发布（官方文档已预览，但权重尚未上线）")

    target = local_path_for(plain)
    if _looks_like_weight(target):
        return target

    selected = sources.get_source(source)
    if selected["id"] == "modelscope" and not sources.supports_modelscope(plain):
        raise ModelDownloadError(
            f"魔搭镜像没有 {plain}，请改用「自动」（会自动回落到官方 GitHub）"
            "或「GitHub 官方」。"
        )

    candidates = sources.build_candidates(plain, selected["id"])
    if not candidates:
        raise ModelDownloadError(f"下载源「{selected['label']}」没有可用地址：{plain}")

    # 环境变量里的自定义镜像优先级最高（内网代理 / 自建镜像场景）
    mirror = (os.environ.get(MIRROR_ENV) or "").strip()
    if mirror:
        if not mirror.endswith("/"):
            mirror += "/"
        candidates = [
            (f"自定义镜像·{label}", f"{mirror}{url}") for label, url in candidates
        ]

    os.makedirs(os.path.dirname(target), exist_ok=True)

    errors = []
    for label, url in candidates:
        try:
            _download_one(url, target, on_progress)
            return target
        except urllib.error.HTTPError as exc:
            errors.append(f"{label}: HTTP {exc.code}")
            # 404/403 = 该源没有这个资产，换下一个候选继续试
            if exc.code in (403, 404):
                continue
            # 限流 / 5xx 换源也没意义
            break
        except ModelDownloadError as exc:
            errors.append(f"{label}: {exc}")
            # 已连上但内容非法 → 换源也不会变好
            if "不是有效的模型文件" in str(exc):
                raise
            continue
        except Exception as exc:
            errors.append(f"{label}: {exc}")
            break

    hint = "可在浏览器中手动下载该权重后，用「浏览」按钮选择本地 .pt 文件。"
    if selected["id"] == "modelscope":
        hint = "魔搭镜像可能未同步该文件，改用「自动」会自动回落到官方 GitHub。"
    raise ModelDownloadError("下载失败（" + "; ".join(errors) + "）。" + hint)


def ensure_local(model_ref: str, on_progress=None) -> str | None:
    """把「本地路径」或「官方权重名」统一解析成本地文件路径。

    - 已是存在的文件 → 原样返回
    - 官方权重名（`yolo11n.pt`）→ 缺失时下载到 `models/`
    - 其它（既不是文件也不是官方名）→ 返回 None，由调用方报「模型文件不存在」
    """
    ref = str(model_ref or "").strip()
    if not ref:
        return None
    if os.path.exists(ref):
        return ref
    if not registry.parse_model_name(ref):
        return None

    target = local_path_for(ref)
    if _looks_like_weight(target):
        return target
    return download_weight(ref, on_progress)
