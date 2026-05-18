import { useState, useEffect, useCallback, useRef } from "react";
import {
  Cpu,
  Wifi,
  WifiOff,
  Settings,
  Play,
  Square,
  FolderOpen,
  Link,
  Image,
  Film,
  ChevronDown,
  Trash2,
  Monitor,
  Activity,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import {
  startBackend,
  stopBackend,
  backendHealth,
  checkBackendAlive,
  getBackendLog,
  getBackendClientConfig,
  browseFile,
  browseModelFile,
  type BackendStatus,
} from "@/lib/tauri-bridge";
import {
  initSocket,
  disconnectSocket,
  emitStartInference,
  emitStopInference,
} from "@/lib/socket";
import EnvManager from "@/components/EnvManager";

const BACKEND_PORT = 8080;

// ─── 顶部状态栏 ───────────────────────────────────────────────
function TopBar({
  onOpenEnvManager,
  onRefresh,
}: {
  onOpenEnvManager: () => void;
  onRefresh: () => void;
}) {
  const { socketConnected, backendStatus, systemInfo, backendMessage, reset } =
    useAppStore();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await onRefresh();
    setTimeout(() => setRefreshing(false), 800);
  };

  const handleReconfigure = () => {
    if (confirm("重新配置将停止当前后端并返回设置向导，确认继续？")) {
      reset();
    }
  };

  return (
    <div
      className="flex items-center px-4 h-11 gap-4 flex-shrink-0"
      style={{ background: "hsl(var(--card))", borderBottom: "1px solid hsl(var(--border))" }}
    >
      <div className="flex items-center gap-2">
        <Cpu className="w-4 h-4" style={{ color: "hsl(var(--primary))" }} />
        <span className="font-semibold text-sm" style={{ color: "hsl(var(--foreground))" }}>
          Easy Infer Station
        </span>
        <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}>
          v0.0.1
        </span>
      </div>

      <div className="flex-1" />

      {/* GPU 信息 */}
      {systemInfo?.has_gpu && (
        <div className="flex items-center gap-1 text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
          <Monitor className="w-3.5 h-3.5" />
          <span>{systemInfo.gpu_name}</span>
        </div>
      )}

      {/* 后端状态 */}
      <div className="flex items-center gap-1.5 text-xs">
        <div
          className={cn("w-2 h-2 rounded-full", backendStatus === "running" ? "animate-pulse" : "")}
          style={{
            background:
              backendStatus === "running"
                ? "hsl(var(--success))"
                : backendStatus === "starting"
                ? "hsl(var(--warning))"
                : backendStatus === "error"
                ? "hsl(var(--destructive))"
                : "hsl(var(--border))",
          }}
        />
        <span style={{ color: "hsl(var(--muted-foreground))" }}>
          {backendStatus === "running"
            ? "后端运行中"
            : backendStatus === "starting"
            ? "启动中..."
            : backendStatus === "error"
            ? backendMessage || "后端错误"
            : "后端未启动"}
        </span>
      </div>

      {/* Socket 状态 */}
      {socketConnected ? (
        <Wifi className="w-4 h-4" style={{ color: "hsl(var(--success))" }} />
      ) : (
        <WifiOff className="w-4 h-4" style={{ color: "hsl(var(--muted-foreground))" }} />
      )}

      {/* 刷新按钮 */}
      <button
        onClick={handleRefresh}
        disabled={refreshing}
        className="p-1.5 rounded-md transition-opacity hover:opacity-70 disabled:opacity-40"
        style={{ color: "hsl(var(--muted-foreground))" }}
        title="刷新连接 / 重新加载模型列表"
      >
        <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
      </button>

      {/* 设置按钮 */}
      <button
        onClick={onOpenEnvManager}
        className="p-1.5 rounded-md transition-opacity hover:opacity-70"
        style={{ color: "hsl(var(--muted-foreground))" }}
        title="环境管理"
      >
        <Settings className="w-4 h-4" />
      </button>

      {/* 重新配置 */}
      <button
        onClick={handleReconfigure}
        className="p-1.5 rounded-md transition-opacity hover:opacity-70 text-xs"
        style={{ color: "hsl(var(--muted-foreground))" }}
        title="重新配置（返回设置向导）"
      >
        重置
      </button>
    </div>
  );
}

// ─── 左侧控制面板 ─────────────────────────────────────────────
interface InferParamsState {
  inputType: "image" | "video" | "rtsp";
  inputSource: string;
  modelPath: string;
  confidence: number;
  iouThresh: number;
  device: string;
  frameSkip: number;
  selectedLabels: number[];                              // 勾选的类别 id；空 = 全部检测
  roiEnabled: boolean;
  roiCoords: [number, number, number, number] | null;    // 归一化 [x1,y1,x2,y2]
  trackingEnabled: boolean;
  trackerType: "bytetrack" | "botsort";
}

// ─── 辅助：画 ROI 矩形 ─────────────────────────────────────────
function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }

function drawRoiRect(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  coords: [number, number, number, number],
  color: string,
  dashed: boolean,
) {
  const [x1, y1, x2, y2] = coords;
  const px = x1 * w, py = y1 * h, pw = (x2 - x1) * w, ph = (y2 - y1) * h;
  ctx.fillStyle = color + "22";
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  if (dashed) ctx.setLineDash([6, 3]);
  else ctx.setLineDash([]);
  ctx.strokeRect(px, py, pw, ph);
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = "bold 11px sans-serif";
  ctx.fillText("ROI", px + 4, py + 14);
}

function ControlPanel({
  params,
  onChange,
  models,
  labels,
  onStart,
  onStop,
  isInferring,
  backendRunning,
  width,
  onBrowseFile,
  onBrowseModel,
  onStartRoiDraw,
  roiDrawMode,
}: {
  params: InferParamsState;
  onChange: (p: Partial<InferParamsState>) => void;
  models: string[];
  labels: string[];
  onStart: () => void;
  onStop: () => void;
  isInferring: boolean;
  backendRunning: boolean;
  width: number;
  onBrowseFile: () => void;
  onBrowseModel: () => void;
  onStartRoiDraw: () => void;
  roiDrawMode: boolean;
}) {
  const inputTypes: { value: InferParamsState["inputType"]; label: string; icon: React.ReactNode }[] = [
    { value: "image", label: "图片", icon: <Image className="w-3.5 h-3.5" /> },
    { value: "video", label: "视频", icon: <Film className="w-3.5 h-3.5" /> },
    { value: "rtsp", label: "RTSP", icon: <Link className="w-3.5 h-3.5" /> },
  ];

  return (
    <div
      className="flex-shrink-0 flex flex-col h-full"
      style={{
        width, background: "hsl(var(--card))",
        borderRight: "1px solid hsl(var(--border))",
      }}
    >
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* 模型选择 */}
        <Section title="模型">
          <label className="text-xs mb-1 block" style={{ color: "hsl(var(--muted-foreground))" }}>
            模型文件
          </label>
          <div className="flex gap-1">
            <div className="relative flex-1 min-w-0">
              <select
                value={params.modelPath}
                onChange={(e) => onChange({ modelPath: e.target.value })}
                className="w-full appearance-none pr-7 pl-2 py-1.5 rounded text-xs"
                style={{
                  background: "hsl(var(--muted))",
                  border: "1px solid hsl(var(--border))",
                  color: "hsl(var(--foreground))",
                }}
              >
                <option value="">-- 选择模型 --</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m.split(/[\\/]/).pop()}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
                style={{ color: "hsl(var(--muted-foreground))" }}
              />
            </div>
            <button
              onClick={onBrowseModel}
              title="从本地浏览 .pt 模型文件"
              className="flex-shrink-0 flex items-center justify-center px-2 rounded transition-opacity hover:opacity-70"
              style={{
                background: "hsl(var(--muted))",
                border: "1px solid hsl(var(--border))",
                color: "hsl(var(--foreground))",
              }}
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
          </div>
          {labels.length > 0 && (
            <div className="mt-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
                  过滤类别（空=全部）
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => onChange({ selectedLabels: labels.map((_, i) => i) })}
                    className="text-xs px-1.5 py-0.5 rounded transition-opacity hover:opacity-70"
                    style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))", border: "1px solid hsl(var(--border))" }}
                  >全选</button>
                  <button
                    onClick={() => onChange({ selectedLabels: [] })}
                    className="text-xs px-1.5 py-0.5 rounded transition-opacity hover:opacity-70"
                    style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))", border: "1px solid hsl(var(--border))" }}
                  >清空</button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
                {labels.map((l, idx) => {
                  const sel = params.selectedLabels.includes(idx);
                  return (
                    <button
                      key={idx}
                      onClick={() =>
                        onChange({
                          selectedLabels: sel
                            ? params.selectedLabels.filter((i) => i !== idx)
                            : [...params.selectedLabels, idx],
                        })
                      }
                      className="text-xs px-1.5 py-0.5 rounded transition-all"
                      style={{
                        background: sel ? "hsl(var(--primary))" : "hsl(var(--muted))",
                        color: sel ? "hsl(var(--primary-foreground))" : "hsl(var(--muted-foreground))",
                        border: "1px solid hsl(var(--border))",
                      }}
                    >
                      {l}
                    </button>
                  );
                })}
              </div>
              {params.selectedLabels.length === 0 && (
                <div className="text-xs mt-1 opacity-50" style={{ color: "hsl(var(--muted-foreground))" }}>
                  未筛选，检测所有类别
                </div>
              )}
            </div>
          )}
        </Section>

        {/* 输入源 */}
        <Section title="输入源">
          <div className="flex gap-1 mb-2">
            {inputTypes.map((t) => (
              <button
                key={t.value}
                onClick={() => onChange({ inputType: t.value })}
                className="flex-1 flex items-center justify-center gap-1 py-1 rounded text-xs transition-all"
                style={{
                  background:
                    params.inputType === t.value
                      ? "hsl(var(--primary))"
                      : "hsl(var(--muted))",
                  color:
                    params.inputType === t.value
                      ? "hsl(var(--primary-foreground))"
                      : "hsl(var(--muted-foreground))",
                  border: "1px solid hsl(var(--border))",
                }}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          {params.inputType === "rtsp" ? (
            <input
              type="text"
              placeholder="rtsp://..."
              value={params.inputSource}
              onChange={(e) => onChange({ inputSource: e.target.value })}
              className="w-full px-2 py-1.5 rounded text-xs"
              style={{
                background: "hsl(var(--muted))",
                border: "1px solid hsl(var(--border))",
                color: "hsl(var(--foreground))",
              }}
            />
          ) : (
            <div className="flex gap-1">
              <input
                type="text"
                placeholder={params.inputType === "image" ? "图片路径..." : "视频路径..."}
                value={params.inputSource}
                onChange={(e) => onChange({ inputSource: e.target.value })}
                className="flex-1 px-2 py-1.5 rounded-l text-xs min-w-0"
                style={{
                  background: "hsl(var(--muted))",
                  border: "1px solid hsl(var(--border))",
                  color: "hsl(var(--foreground))",
                }}
              />
              <button
                onClick={onBrowseFile}
                className="px-2 py-1.5 rounded-r flex items-center transition-opacity hover:opacity-70"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                title="浏览"
              >
                <FolderOpen className="w-3.5 h-3.5" style={{ color: "hsl(var(--muted-foreground))" }} />
              </button>
            </div>
          )}
        </Section>

        {/* 推理参数 */}
        <Section title="推理参数">
          <SliderField
            label="置信度"
            value={params.confidence}
            min={0.1}
            max={1}
            step={0.05}
            onChange={(v) => onChange({ confidence: v })}
          />
          <SliderField
            label="IOU 阈值"
            value={params.iouThresh}
            min={0.1}
            max={1}
            step={0.05}
            onChange={(v) => onChange({ iouThresh: v })}
          />
          <div className="mt-2">
            <label className="text-xs mb-1 block" style={{ color: "hsl(var(--muted-foreground))" }}>
              推理设备
            </label>
            <div className="relative">
              <select
                value={params.device}
                onChange={(e) => onChange({ device: e.target.value })}
                className="w-full appearance-none pr-7 pl-2 py-1.5 rounded text-xs"
                style={{
                  background: "hsl(var(--muted))",
                  border: "1px solid hsl(var(--border))",
                  color: "hsl(var(--foreground))",
                }}
              >
                <option value="cuda">CUDA (GPU)</option>
                <option value="cpu">CPU</option>
              </select>
              <ChevronDown
                className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
                style={{ color: "hsl(var(--muted-foreground))" }}
              />
            </div>
          </div>
        </Section>

        {/* 目标跟踪 */}
        <Section title="目标跟踪">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
              启用跟踪（视频/RTSP）
            </span>
            <button
              onClick={() => onChange({ trackingEnabled: !params.trackingEnabled })}
              className="text-xs px-2 py-0.5 rounded transition-all"
              style={{
                background: params.trackingEnabled ? "hsl(var(--primary))" : "hsl(var(--muted))",
                color: params.trackingEnabled ? "hsl(var(--primary-foreground))" : "hsl(var(--muted-foreground))",
                border: "1px solid hsl(var(--border))",
              }}
            >
              {params.trackingEnabled ? "已启用" : "已禁用"}
            </button>
          </div>
          {params.trackingEnabled && (
            <div className="relative">
              <select
                value={params.trackerType}
                onChange={(e) => onChange({ trackerType: e.target.value as "bytetrack" | "botsort" })}
                className="w-full appearance-none pr-7 pl-2 py-1.5 rounded text-xs"
                style={{
                  background: "hsl(var(--muted))",
                  border: "1px solid hsl(var(--border))",
                  color: "hsl(var(--foreground))",
                }}
              >
                <option value="bytetrack">ByteTrack</option>
                <option value="botsort">BoT-SORT</option>
              </select>
              <ChevronDown
                className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
                style={{ color: "hsl(var(--muted-foreground))" }}
              />
            </div>
          )}
        </Section>

        {/* ROI 区域 */}
        <Section title="ROI 区域">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
              启用 ROI 过滤
            </span>
            <button
              onClick={() => onChange({ roiEnabled: !params.roiEnabled })}
              className="text-xs px-2 py-0.5 rounded transition-all"
              style={{
                background: params.roiEnabled ? "hsl(var(--primary))" : "hsl(var(--muted))",
                color: params.roiEnabled ? "hsl(var(--primary-foreground))" : "hsl(var(--muted-foreground))",
                border: "1px solid hsl(var(--border))",
              }}
            >
              {params.roiEnabled ? "已启用" : "已禁用"}
            </button>
          </div>
          {params.roiEnabled && (
            <>
              <button
                onClick={onStartRoiDraw}
                disabled={roiDrawMode}
                className="w-full py-1 rounded text-xs transition-opacity hover:opacity-70 disabled:opacity-40"
                style={{
                  background: roiDrawMode ? "hsl(var(--primary))" : "hsl(var(--muted))",
                  color: roiDrawMode ? "hsl(var(--primary-foreground))" : "hsl(var(--muted-foreground))",
                  border: "1px solid hsl(var(--border))",
                }}
              >
                {roiDrawMode ? "在预览上拖拽绘制..." : "在预览上绘制 ROI"}
              </button>
              {params.roiCoords && (
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
                    ✓ ROI 已设置
                  </span>
                  <button
                    onClick={() => onChange({ roiCoords: null })}
                    className="text-xs px-1.5 py-0.5 rounded transition-opacity hover:opacity-70"
                    style={{ color: "hsl(var(--destructive))", border: "1px solid hsl(var(--border))" }}
                  >
                    清除
                  </button>
                </div>
              )}
              {!params.roiCoords && (
                <p className="text-xs mt-1 opacity-50" style={{ color: "hsl(var(--muted-foreground))" }}>
                  尚未设置 ROI
                </p>
              )}
            </>
          )}
        </Section>
      </div>

      {/* 底部控制按钮 */}
      <div
        className="p-3 space-y-2 flex-shrink-0"
        style={{ borderTop: "1px solid hsl(var(--border))" }}
      >
        {!isInferring ? (
          <button
            onClick={onStart}
            disabled={!backendRunning || !params.modelPath || !params.inputSource}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
            style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
          >
            <Play className="w-4 h-4" />
            开始推理
          </button>
        ) : (
          <button
            onClick={onStop}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
            style={{ background: "hsl(var(--destructive))", color: "white" }}
          >
            <Square className="w-4 h-4" />
            停止推理
          </button>
        )}
      </div>
    </div>
  );
}

// ─── 推理结果展示区 ────────────────────────────────────────────
function InferenceView({
  logHeight,
  onLogDragStart,
  roiEnabled,
  roiCoords,
  roiDrawMode,
  onRoiDrawn,
  onRoiDrawModeEnd,
  previewFrame,
  previewLoading,
}: {
  logHeight: number;
  onLogDragStart: (e: React.MouseEvent) => void;
  roiEnabled: boolean;
  roiCoords: [number, number, number, number] | null;
  roiDrawMode: boolean;
  onRoiDrawn: (coords: [number, number, number, number]) => void;
  onRoiDrawModeEnd: () => void;
  previewFrame: string | null;
  previewLoading: boolean;
}) {
  const { currentFrame, isInferring, inferLog } = useAppStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawStateRef = useRef({ active: false, startX: 0, startY: 0 });
  const cbRef = useRef({ onRoiDrawn, onRoiDrawModeEnd });
  useEffect(() => { cbRef.current = { onRoiDrawn, onRoiDrawModeEnd }; }, [onRoiDrawn, onRoiDrawModeEnd]);

  // 重画静态 ROI
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width || canvas.offsetWidth;
    canvas.height = r.height || canvas.offsetHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (roiEnabled && roiCoords) {
      drawRoiRect(ctx, canvas.width, canvas.height, roiCoords, "#00e676", false);
    }
  }, [roiEnabled, roiCoords]);

  // 动态绘制事件
  useEffect(() => {
    if (!roiDrawMode) return;
    const onMove = (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas || !drawStateRef.current.active) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const r = canvas.getBoundingClientRect();
      const x = clamp01((e.clientX - r.left) / r.width);
      const y = clamp01((e.clientY - r.top) / r.height);
      const { startX, startY } = drawStateRef.current;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawRoiRect(
        ctx, canvas.width, canvas.height,
        [Math.min(startX, x), Math.min(startY, y), Math.max(startX, x), Math.max(startY, y)],
        "#2979ff", true,
      );
    };
    const onUp = (e: MouseEvent) => {
      if (!drawStateRef.current.active) return;
      drawStateRef.current.active = false;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const r = canvas.getBoundingClientRect();
      const x = clamp01((e.clientX - r.left) / r.width);
      const y = clamp01((e.clientY - r.top) / r.height);
      const { startX, startY } = drawStateRef.current;
      const x1 = Math.min(startX, x), y1 = Math.min(startY, y);
      const x2 = Math.max(startX, x), y2 = Math.max(startY, y);
      if (x2 - x1 > 0.02 && y2 - y1 > 0.02) {
        cbRef.current.onRoiDrawn([x1, y1, x2, y2]);
      } else {
        cbRef.current.onRoiDrawModeEnd();
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [roiDrawMode]);

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (!roiDrawMode) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width;
    canvas.height = r.height;
    drawStateRef.current = {
      active: true,
      startX: clamp01((e.clientX - r.left) / r.width),
      startY: clamp01((e.clientY - r.top) / r.height),
    };
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* 图像/帧展示 */}
      <div
        className="flex-1 flex items-center justify-center relative overflow-hidden"
        style={{ background: "hsl(222 47% 8%)" }}
      >
        {currentFrame ? (
          <img
            src={currentFrame}
            alt="inference result"
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
          />
        ) : previewFrame ? (
          <>
            <img
              src={previewFrame}
              alt="preview"
              style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", opacity: 0.75 }}
            />
            <div
              style={{
                position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)",
                background: "rgba(0,0,0,0.55)", color: "#aaa",
                padding: "2px 10px", borderRadius: 4, fontSize: 11, pointerEvents: "none",
              }}
            >
              首帧预览 — 可在此绘制 ROI
            </div>
          </>
        ) : (
          <div className="text-center" style={{ color: "hsl(var(--muted-foreground))" }}>
            <Activity className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <div className="text-sm">
              {isInferring ? "等待推理结果..." : previewLoading ? "加载首帧预览..." : "暂无画面"}
            </div>
          </div>
        )}
        {/* ROI 画布覆盖层 */}
        {(roiEnabled || roiDrawMode) && (
          <canvas
            ref={canvasRef}
            style={{
              position: "absolute", inset: 0, width: "100%", height: "100%",
              cursor: roiDrawMode ? "crosshair" : "default",
              pointerEvents: roiDrawMode ? "auto" : "none",
            }}
            onMouseDown={handleCanvasMouseDown}
          />
        )}
        {/* 绘制模式提示 */}
        {roiDrawMode && (
          <div
            style={{
              position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
              background: "rgba(41,121,255,0.85)", color: "#fff",
              padding: "2px 10px", borderRadius: 4, fontSize: 12, pointerEvents: "none",
            }}
          >
            拖拽绘制 ROI 区域
          </div>
        )}
      </div>

      {/* 日志拖拽把手 */}
      <div
        onMouseDown={onLogDragStart}
        style={{
          height: 4, flexShrink: 0, cursor: "ns-resize", zIndex: 10,
          background: "hsl(var(--border))",
        }}
        className="hover:bg-blue-500/50 transition-colors"
      />

      {/* 状态日志 */}
      <div
        style={{
          height: logHeight,
          overflowY: "auto",
          background: "hsl(222 47% 7%)",
          borderTop: "none",
          color: "hsl(var(--muted-foreground))",
          flexShrink: 0,
        }}
        className="p-2 font-mono text-xs"
      >
        {inferLog.length === 0 ? (
          <span className="opacity-40">系统日志...</span>
        ) : (
          inferLog.map((log, i) => (
            <div key={i} className="leading-5">
              {log}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── 报警图库 ─────────────────────────────────────────────────
function AlarmGallery({ width }: { width: number }) {
  const { alarmImages, clearAlarmImages } = useAppStore();

  return (
    <div
      className="flex-shrink-0 flex flex-col h-full"
      style={{ width, background: "hsl(var(--card))", borderLeft: "1px solid hsl(var(--border))" }}
    >
      <div
        className="flex items-center justify-between px-3 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid hsl(var(--border))" }}
      >
        <span className="text-xs font-medium" style={{ color: "hsl(var(--foreground))" }}>
          报警记录 {alarmImages.length > 0 && `(${alarmImages.length})`}
        </span>
        {alarmImages.length > 0 && (
          <button
            onClick={clearAlarmImages}
            className="p-1 rounded transition-opacity hover:opacity-70"
            style={{ color: "hsl(var(--muted-foreground))" }}
            title="清空记录"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {alarmImages.length === 0 ? (
          <div
            className="text-center py-8 text-xs"
            style={{ color: "hsl(var(--muted-foreground))" }}
          >
            无报警记录
          </div>
        ) : (
          alarmImages.map((img) => (
            <div
              key={img.id}
              className="rounded-lg overflow-hidden"
              style={{ border: "1px solid hsl(var(--border))" }}
            >
              <img
                src={img.src}
                alt={img.label}
                className="w-full aspect-video object-cover"
                style={{ display: "block" }}
              />
              <div className="px-2 py-1">
                <div
                  className="text-xs font-medium"
                  style={{ color: "hsl(var(--destructive))" }}
                >
                  {img.label}
                </div>
                <div className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
                  {img.timestamp}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── 辅助组件 ─────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        className="text-xs font-semibold uppercase tracking-wider mb-2"
        style={{ color: "hsl(var(--muted-foreground))" }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs mb-1">
        <span style={{ color: "hsl(var(--muted-foreground))" }}>{label}</span>
        <span style={{ color: "hsl(var(--foreground))" }}>{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 rounded appearance-none cursor-pointer"
        style={{ accentColor: "hsl(var(--primary))" }}
      />
    </div>
  );
}

// ─── 主页面 ───────────────────────────────────────────────────
export default function MainPage() {
  const config = useAppStore((s) => s.config);
  const { setBackendStatus, setSocketConnected, setModels, setLabels, addInferLog } =
    useAppStore();
  const { backendStatus, isInferring, models, labels } = useAppStore();
  const [apiToken, setApiToken] = useState("");

  const [envManagerOpen, setEnvManagerOpen] = useState(false);
  const [params, setParams] = useState<InferParamsState>({
    inputType: "image",
    inputSource: "",
    modelPath: "",
    confidence: 0.5,
    iouThresh: 0.45,
    device: "cuda",
    frameSkip: 3,
    selectedLabels: [],
    roiEnabled: false,
    roiCoords: null,
    trackingEnabled: false,
    trackerType: "bytetrack",
  });

  // ROI 绘制模式
  const [roiDrawMode, setRoiDrawMode] = useState(false);

  // ─── 视频/RTSP 首帧预览
  const [previewFrame, setPreviewFrame] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const rtspDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── 拖拽调整面板大小 ────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [alarmWidth, setAlarmWidth] = useState(208);
  const [logHeight, setLogHeight] = useState(128);

  const getAuthHeaders = () => {
    const headers = new Headers();
    if (apiToken) {
      headers.set("X-API-Token", apiToken);
    }
    return headers;
  };

  const makeDragger = (
    getter: () => number,
    setter: (v: number) => void,
    axis: "x" | "y",
    sign: 1 | -1,
    min: number,
    max: number
  ) => (e: React.MouseEvent) => {
    e.preventDefault();
    const start = axis === "x" ? e.clientX : e.clientY;
    const startSize = getter();
    const onMove = (me: MouseEvent) => {
      const delta = (axis === "x" ? me.clientX : me.clientY) - start;
      setter(Math.max(min, Math.min(max, startSize + sign * delta)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const startSidebarDrag = makeDragger(() => sidebarWidth, setSidebarWidth, "x", 1, 160, 400);
  const startAlarmDrag = makeDragger(() => alarmWidth, setAlarmWidth, "x", -1, 140, 360);
  const startLogDrag = makeDragger(() => logHeight, setLogHeight, "y", -1, 60, 400);

  // ─── 打开文件对话框 ──────────────────────────────────────────
  const handleBrowse = async () => {
    const path = await browseFile(params.inputType as "image" | "video");
    if (path)
      setParams((p) => ({ ...p, inputSource: path, roiCoords: null, roiEnabled: false }));
  };

  // 防止 React Strict Mode 双重 mount 导致重复启动后端
  const hasStarted = useRef(false);

  // 启动后端并建立 Socket 连接
  useEffect(() => {
    if (!config) return;
    if (hasStarted.current) return;
    hasStarted.current = true;

    let healthTimer: ReturnType<typeof setInterval>;

    const boot = async () => {
      setBackendStatus("starting");
      addInferLog(`正在启动 Python 后端 (${config.conda.envName})...`);

      let clientApiToken = "";
      try {
        const clientConfig = await getBackendClientConfig(config.appDir);
        clientApiToken = clientConfig.api_token.trim();
        setApiToken(clientApiToken);
      } catch (e) {
        addInferLog(`读取后端鉴权配置失败，将按无鉴权模式继续: ${e}`);
        setApiToken("");
      }

      try {
        await startBackend(config.conda.pythonExe, config.appDir, config.port);
        addInferLog(`Python 进程已启动: ${config.conda.pythonExe}`);
        addInferLog(`工作目录: ${config.appDir}`);
      } catch (e) {
        const errMsg = String(e);
        if (errMsg.includes("后端已在运行")) {
          // 上次会话的后端进程仍在运行，跳过启动直接尝试连接
          addInferLog("检测到后端已在运行，尝试连接...");
        } else {
          // 真正的启动失败
          setBackendStatus("error", errMsg);
          addInferLog(`后端启动失败: ${e}`);
          return;
        }
      }

      // 等待后端就绪（最多 90 秒，进程提前退出则立即报错）
      let attempts = 0;
      const MAX_ATTEMPTS = 90;
      const waitHealthy = () =>
        new Promise<void>((resolve, reject) => {
          const timer = setInterval(async () => {
            attempts++;

            // 检查进程是否还活着
            try {
              const alive = await checkBackendAlive();
              if (!alive) {
                clearInterval(timer);
                const log = await getBackendLog();
                reject(new Error(`Python 进程已退出\n\n输出日志:\n${log.slice(-2000)}`));
                return;
              }
            } catch { /* ignore */ }

            try {
              const status: BackendStatus = await backendHealth(config.port);
              if (status.healthy) {
                clearInterval(timer);
                resolve();
              } else if (attempts >= MAX_ATTEMPTS) {
                clearInterval(timer);
                const log = await getBackendLog().catch(() => '');
                reject(new Error(`后端启动超时（${MAX_ATTEMPTS}秒）\n\n最吊输出:\n${log.slice(-1000)}`));
              }
            } catch {
              if (attempts >= MAX_ATTEMPTS) {
                clearInterval(timer);
                reject(new Error(`后端启动超时（${MAX_ATTEMPTS}秒）`));
              }
            }
          }, 1000);
        });

      try {
        await waitHealthy();
        setBackendStatus("running");
        addInferLog("后端启动成功");

        // 建立 Socket 连接
        initSocket(config.port, clientApiToken || undefined);

        // 加载模型列表
        fetchModels();

        // 定期健康检查
        healthTimer = setInterval(async () => {
          try {
            const s = await backendHealth(config.port);
            if (!s.healthy) {
              setBackendStatus("error", "后端无响应");
            }
          } catch {
            setBackendStatus("error", "后端无响应");
          }
        }, 10000);
      } catch (e) {
        setBackendStatus("error", String(e));
        addInferLog(`后端启动失败: ${e}`);
      }
    };

    boot();

    return () => {
      clearInterval(healthTimer);
      disconnectSocket();
      stopBackend().catch(() => {});
    };
  }, [config]);

  const fetchModels = async () => {
    try {
      const resp = await fetch(`http://127.0.0.1:${config?.port ?? 8080}/api/models/list`, {
        headers: getAuthHeaders(),
      });
      const data = await resp.json();
      // 后端返回 {filename, filepath, size} 对象数组，取 filepath 存为字符串列表
      const list: unknown[] = data.models ?? [];
      const paths = list.map((m) =>
        typeof m === "string" ? m : (m as { filepath: string }).filepath
      );
      setModels(paths);
    } catch {
      /* 忽略 */
    }
  };

  const fetchLabels = useCallback(async (modelPath: string) => {
    if (!modelPath) return;
    try {
      const resp = await fetch(
        `http://127.0.0.1:${config?.port ?? 8080}/api/model/labels?model_path=${encodeURIComponent(modelPath)}`,
        { headers: getAuthHeaders() }
      );
      const data = await resp.json();
      // model.names 返回 dict {0:'person',...}，需要转换为按 id 排序的字符串数组
      const raw: unknown = data.labels ?? [];
      const list: string[] = Array.isArray(raw)
        ? (raw as string[])
        : Object.entries(raw as Record<string, string>)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([, v]) => String(v));
      setLabels(list);
      // 切换模型时清除已选类别
      setParams((p) => ({ ...p, selectedLabels: [] }));
    } catch {
      /* 忽略 */
    }
  }, [apiToken, config, setLabels]);

  useEffect(() => {
    if (params.modelPath) fetchLabels(params.modelPath);
  }, [params.modelPath, fetchLabels]);

  const fetchFirstFrame = useCallback(async (source: string, type: string) => {
    if (!source || !config) return;
    setPreviewLoading(true);
    try {
      const resp = await fetch(
        `http://127.0.0.1:${config.port}/api/preview/first_frame?source=${encodeURIComponent(source)}&type=${type}`,
        { headers: getAuthHeaders() }
      );
      const data = await resp.json();
      if (data.success) setPreviewFrame(data.frame as string);
      else setPreviewFrame(null);
    } catch {
      setPreviewFrame(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [apiToken, config]);

  // 输入源变更时自动加载首帧
  useEffect(() => {
    if (rtspDebounceRef.current) clearTimeout(rtspDebounceRef.current);
    if (!params.inputSource || params.inputType === "image") {
      setPreviewFrame(null);
      return;
    }
    if (params.inputType === "video") {
      fetchFirstFrame(params.inputSource, "video");
    } else if (params.inputType === "rtsp") {
      // RTSP 用户可能还在输入，延迟 1.5s 再请求
      rtspDebounceRef.current = setTimeout(() => {
        fetchFirstFrame(params.inputSource, "rtsp");
      }, 1500);
    }
    return () => {
      if (rtspDebounceRef.current) clearTimeout(rtspDebounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.inputSource, params.inputType]);

  const handleRefresh = useCallback(async () => {
    if (!config) return;
    disconnectSocket();
    try {
      const status = await backendHealth(config.port);
      if (status.healthy) {
        setBackendStatus("running");
      }
    } catch { /* 忽略 */ }
    initSocket(config.port, apiToken || undefined);
    await fetchModels();
  }, [apiToken, config, setBackendStatus]);

  const handleBrowseModel = async () => {
    const path = await browseModelFile();
    if (!path) return;
    // 若该路径尚未在列表中，追加进去以便下拉框能显示
    if (!models.includes(path)) {
      setModels([...models, path]);
    }
    setParams((p) => ({ ...p, modelPath: path }));
  };

  const handleStart = () => {
    emitStartInference({
      input_type: params.inputType,
      input_source: params.inputSource,
      model_path: params.modelPath,
      confidence: params.confidence,
      iou: params.iouThresh,
      device: params.device,
      frame_skip: params.frameSkip,
      selected_labels: params.selectedLabels,
      roi_enabled: params.roiEnabled,
      roi_coords: params.roiCoords,
      tracking_enabled: params.trackingEnabled,
      tracker: params.trackerType,
    });
  };

  const handleStop = () => {
    emitStopInference();
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <TopBar onOpenEnvManager={() => setEnvManagerOpen(true)} onRefresh={handleRefresh} />

      <div className="flex flex-1 overflow-hidden">
        <ControlPanel
          params={params}
          onChange={(p) => {
            setParams((prev) => {
              const next = { ...prev, ...p };
              // 输入源变更时自动清除 ROI
              if ("inputSource" in p && p.inputSource !== prev.inputSource) {
                next.roiCoords = null;
                next.roiEnabled = false;
                setRoiDrawMode(false);
              }
              return next;
            });
          }}
          models={models}
          labels={labels}
          onStart={handleStart}
          onStop={handleStop}
          isInferring={isInferring}
          backendRunning={backendStatus === "running"}
          width={sidebarWidth}
          onBrowseFile={handleBrowse}
          onBrowseModel={handleBrowseModel}
          onStartRoiDraw={() => setRoiDrawMode(true)}
          roiDrawMode={roiDrawMode}
        />

        {/* 侧边栏拖拽把手 */}
        <div
          onMouseDown={startSidebarDrag}
          style={{
            width: 4, flexShrink: 0, cursor: "ew-resize", zIndex: 10,
            background: "hsl(var(--border))",
          }}
          className="hover:bg-blue-500/50 transition-colors"
        />

        <InferenceView
          logHeight={logHeight}
          onLogDragStart={startLogDrag}
          roiEnabled={params.roiEnabled}
          roiCoords={params.roiCoords}
          roiDrawMode={roiDrawMode}
          onRoiDrawn={(coords) => {
            setParams((p) => ({ ...p, roiCoords: coords }));
            setRoiDrawMode(false);
          }}
          onRoiDrawModeEnd={() => setRoiDrawMode(false)}
          previewFrame={previewFrame}
          previewLoading={previewLoading}
        />

        {/* 报警面板拖拽把手 */}
        <div
          onMouseDown={startAlarmDrag}
          style={{
            width: 4, flexShrink: 0, cursor: "ew-resize", zIndex: 10,
            background: "hsl(var(--border))",
          }}
          className="hover:bg-blue-500/50 transition-colors"
        />

        <AlarmGallery width={alarmWidth} />
      </div>

      {/* 环境管理器抽屉 */}
      {envManagerOpen && (
        <EnvManager onClose={() => setEnvManagerOpen(false)} />
      )}
    </div>
  );
}
