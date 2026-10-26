import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, Check, Globe, Loader2, RefreshCw, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModelPreset, ModelSource } from "@/lib/model-tasks";

/**
 * 官方权重下载面板。
 *
 * 后端 `/api/models/presets` 给出可下载清单（家族 × 任务 × 尺寸）与可用下载源，
 * `/api/models/download` 把文件放进 `models/`，返回本地路径。
 *
 * 下载源默认「自动」：魔搭（ModelScope）镜像优先，该源没有的文件自动回落官方
 * GitHub。国内直连 GitHub 的 release 资产通常只有 20~30 KB/s，一个 5MB 的 n 级
 * 权重都要几分钟；魔搭实测 400+ KB/s 且权重与官方数值一致。
 *
 * 注意：YOLO27 目前官方尚未发布权重（文档已预览），后端会标记 `available: false`。
 * 一旦发布，无需改这里的代码 —— 列表由后端生成。
 */

const SIZES = ["n", "s", "m"] as const;
const SOURCE_KEY = "eis:model-source";

/**
 * 解析后端响应。
 *
 * Flask 对不存在的路由 / 未捕获异常返回的是 HTML 错误页，直接 `resp.json()` 会抛
 * `Unexpected token '<', "<!doctype "... is not valid JSON` 这种完全看不懂的报错。
 * 这种情形基本上只有一个原因：后端跑的还是旧版本代码（安装包升级后未同步）。
 */
async function readJson(resp: Response): Promise<any> {
  const text = await resp.text();
  const body = text.trim();
  if (body.startsWith("{") || body.startsWith("[")) {
    try {
      return JSON.parse(body);
    } catch {
      // 下面统一报错
    }
  }
  if (resp.status === 404) {
    throw new Error(
      "后端接口不存在，通常是升级后后端代码未同步：请完全退出并重新启动本应用后再试"
    );
  }
  if (resp.status >= 500) {
    throw new Error(
      `后端处理失败（HTTP ${resp.status}），请查看应用日志；若刚升级过版本，请重启应用`
    );
  }
  throw new Error(`后端返回了非 JSON 响应（HTTP ${resp.status}）`);
}

export default function ModelDownloader({
  open,
  port,
  onClose,
  onDownloaded,
}: {
  open: boolean;
  /** 后端端口（来自应用配置，不要写死） */
  port: number;
  onClose: () => void;
  /** 下载成功后回调，带上本地路径，便于直接选中该模型 */
  onDownloaded: (filepath: string) => void;
}) {
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [tasks, setTasks] = useState<{ task: string; label: string; description: string }[]>([]);
  const [sources, setSources] = useState<ModelSource[]>([]);
  const [source, setSource] = useState<string>(() => {
    try {
      return localStorage.getItem(SOURCE_KEY) || "auto";
    } catch {
      return "auto";
    }
  });
  const [version, setVersion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [family, setFamily] = useState("yolo26");
  const [task, setTask] = useState("detect");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (port: number) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/models/presets`);
      const data = await readJson(resp);
      if (!data.success) throw new Error(data.message ?? "读取失败");
      setPresets(data.presets ?? []);
      setTasks(data.tasks ?? []);
      setSources(data.sources ?? []);
      setVersion(data.ultralytics_version ?? "");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);

  const changeSource = (next: string) => {
    setSource(next);
    try {
      localStorage.setItem(SOURCE_KEY, next);
    } catch {
      /* 隐私模式 / 存储被禁用时忽略 */
    }
  };

  useEffect(() => {
    if (!open) return;
    load(port);
  }, [open, port, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const families = useMemo(() => {
    const seen = new Map<string, string>();
    presets.forEach((p) => seen.set(p.family, p.family_label));
    return [...seen.entries()];
  }, [presets]);

  const rows = useMemo(
    () => presets.filter((p) => p.family === family && p.task === task),
    [presets, family, task]
  );

  const currentSource = useMemo(
    () => sources.find((s) => s.id === source) ?? null,
    [sources, source]
  );

  /** 显式选了某个镜像时，该镜像没有的文件要提前提示（auto 会自动回落） */
  const unsupported = (preset: ModelPreset) =>
    source !== "auto" && !(preset.sources ?? []).includes(source);

  const handleDownload = async (preset: ModelPreset) => {
    setBusy(preset.name);
    setNotice(null);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/models/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: preset.name, source }),
      });
      const data = await readJson(resp);
      if (!data.success) throw new Error(data.message ?? "下载失败");
      setNotice(`已下载 ${preset.name}`);
      setPresets((prev) =>
        prev.map((p) => (p.name === preset.name ? { ...p, local: true } : p))
      );
      onDownloaded(data.filepath);
    } catch (e) {
      setNotice(`下载失败：${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)" }}
      role="presentation"
    >
      <div
        className="relative rounded-xl shadow-2xl flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="下载官方模型"
        style={{
          width: 560,
          maxWidth: "94vw",
          maxHeight: "86vh",
          background: "hsl(var(--card))",
          border: "1px solid hsl(var(--border))",
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ borderBottom: "1px solid hsl(var(--border))" }}
        >
          <div>
            <div className="text-sm font-semibold" style={{ color: "hsl(var(--foreground))" }}>
              下载官方模型
            </div>
            <div className="text-xs mt-0.5" style={{ color: "hsl(var(--muted-foreground))" }}>
              自动放入 models 目录，下载后可直接选用
              {version ? ` · ultralytics ${version}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => load(port)}
              disabled={loading}
              className="p-1.5 rounded transition-opacity hover:opacity-70 disabled:opacity-40"
              style={{ color: "hsl(var(--muted-foreground))" }}
              title="刷新列表"
            >
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded transition-opacity hover:opacity-70"
              style={{ color: "hsl(var(--muted-foreground))" }}
              title="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 下载源 */}
        <div
          className="px-4 py-2.5 flex-shrink-0"
          style={{ borderBottom: "1px solid hsl(var(--border))" }}
        >
          <div className="flex items-center gap-2">
            <Globe
              className="w-3.5 h-3.5 flex-shrink-0"
              style={{ color: "hsl(var(--muted-foreground))" }}
            />
            <span className="text-[11px] flex-shrink-0" style={{ color: "hsl(var(--muted-foreground))" }}>
              下载源
            </span>
            <select
              value={source}
              onChange={(e) => changeSource(e.target.value)}
              className="text-[11px] px-2 py-1 rounded flex-shrink-0 outline-none"
              style={{
                background: "hsl(var(--muted))",
                color: "hsl(var(--foreground))",
                border: "1px solid hsl(var(--border))",
                maxWidth: 190,
              }}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                  {s.recommended ? "（推荐）" : ""}
                  {s.trusted ? "" : " ⚠"}
                </option>
              ))}
            </select>
            {currentSource && (
              <span
                className="text-[10px] truncate"
                style={{ color: "hsl(var(--muted-foreground))" }}
                title={currentSource.description}
              >
                {currentSource.description}
              </span>
            )}
          </div>
        </div>

        {/* 家族 / 任务选择 */}
        <div className="px-4 pt-3 flex-shrink-0 space-y-2">
          <div className="flex flex-wrap gap-1">
            {families.map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFamily(key)}
                className="px-2 py-1 rounded text-xs transition-all"
                style={{
                  background: family === key ? "hsl(var(--primary))" : "hsl(var(--muted))",
                  color:
                    family === key ? "hsl(var(--primary-foreground))" : "hsl(var(--muted-foreground))",
                  border: "1px solid hsl(var(--border))",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            {tasks.map((t) => (
              <button
                key={t.task}
                onClick={() => setTask(t.task)}
                title={t.description}
                className="px-2 py-1 rounded text-xs transition-all"
                style={{
                  background: task === t.task ? "hsl(var(--accent))" : "transparent",
                  color:
                    task === t.task ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))",
                  border: "1px solid hsl(var(--border))",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5">
          {error && (
            <div
              className="flex items-start gap-2 p-3 rounded-lg text-xs"
              style={{
                background: "hsl(var(--destructive) / 0.12)",
                border: "1px solid hsl(var(--destructive) / 0.35)",
                color: "hsl(var(--muted-foreground))",
              }}
            >
              <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: "hsl(var(--destructive))" }} />
              <span>{error}</span>
            </div>
          )}
          {!error && loading && rows.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-8" style={{ color: "hsl(var(--muted-foreground))" }}>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">读取中…</span>
            </div>
          )}
          {!loading && rows.length === 0 && !error && (
            <div className="text-center py-8 text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
              该组合暂无可用权重
            </div>
          )}

          {rows
            .filter((r) => (SIZES as readonly string[]).includes(r.size))
            .map((preset) => (
              <div
                key={preset.name}
                className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate" style={{ color: "hsl(var(--foreground))" }}>
                    {preset.name}
                  </div>
                  <div className="text-[11px]" style={{ color: "hsl(var(--muted-foreground))" }}>
                    {preset.size_label} · 需 ultralytics ≥ {preset.min_ultralytics}
                    {unsupported(preset) && (
                      <span style={{ color: "hsl(var(--warning))" }}> · 该源无此文件</span>
                    )}
                  </div>
                </div>
                {!preset.available ? (
                  <span className="text-[11px] px-2 py-1 rounded flex-shrink-0"
                    style={{ color: "hsl(var(--warning))", border: "1px solid hsl(var(--border))" }}>
                    尚未发布
                  </span>
                ) : preset.local ? (
                  <span className="text-[11px] flex items-center gap-1 flex-shrink-0" style={{ color: "hsl(var(--success))" }}>
                    <Check className="w-3 h-3" />
                    已下载
                  </span>
                ) : (
                  <button
                    onClick={() => handleDownload(preset)}
                    disabled={busy !== null || unsupported(preset)}
                    className="text-[11px] px-2 py-1 rounded flex items-center gap-1 flex-shrink-0 transition-opacity hover:opacity-80 disabled:opacity-40"
                    title={unsupported(preset) ? "该下载源没有此文件，请选择「自动」或「GitHub 官方」" : undefined}
                    style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
                  >
                    {busy === preset.name ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        下载中
                      </>
                    ) : (
                      <>
                        <ArrowDownToLine className="w-3 h-3" />
                        下载
                      </>
                    )}
                  </button>
                )}
              </div>
            ))}
        </div>

        <div
          className="px-4 py-2.5 text-[11px] flex-shrink-0 space-y-1"
          style={{ borderTop: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
        >
          {notice && <div>{notice}</div>}
          <div>
            默认走魔搭（ModelScope）镜像，该源未同步的文件（如 YOLOv8 的
            seg/pose/cls/obb）自动回落官方 GitHub；也可设置环境变量
            <code className="mx-1 px-1 rounded" style={{ background: "hsl(var(--muted))" }}>
              EIS_MODEL_MIRROR
            </code>
            走自建镜像。也可手动下载 .pt 后用左侧「浏览」按钮选择。
          </div>
        </div>
      </div>
    </div>
  );
}
