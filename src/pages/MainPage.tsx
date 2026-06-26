import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import {
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
  ArrowDownToLine,
  CheckCircle2,
  X,
  Coffee,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  ScanSearch,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import alipayQR from "@/assets/alipay_qr.png";
import wechatpayQR from "@/assets/wechat_qr.png";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import type { BatchResultItem } from "@/lib/store";
import {
  startBackend,
  stopBackend,
  backendHealth,
  checkBackendAlive,
  getBackendLog,
  getBackendClientConfig,
  browseFile,
  browseModelFile,
  browseMultipleImageFiles,
  checkForUpdates,
  type BackendStatus,
  type UpdateInfo,
} from "@/lib/tauri-bridge";
import { openUrl } from "@tauri-apps/plugin-opener";
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

  // 更新检查状态
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);

  // 打赏弹窗
  const [showDonateModal, setShowDonateModal] = useState(false);

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

  const handleCheckUpdate = async () => {
    setChecking(true);
    setUpdateError(null);
    try {
      const info = await checkForUpdates();
      setUpdateInfo(info);
      setShowUpdateModal(true);
    } catch (e) {
      setUpdateError(String(e));
      setShowUpdateModal(true);
    } finally {
      setChecking(false);
    }
  };

  const handleDownload = () => {
    if (updateInfo?.release_url) {
      openUrl(updateInfo.release_url).catch(() => {});
    }
  };

  return (
    <>
      <div
        className="flex items-center px-4 h-11 gap-4 flex-shrink-0 select-none"
        style={{ background: "hsl(var(--card))", borderBottom: "1px solid hsl(var(--border))" }}
      >
        <div
          className="flex items-center gap-2"
          onMouseDown={(e) => { if (e.buttons === 1) getCurrentWindow().startDragging(); }}
        >
          <img src="/app-icon.png" className="w-4 h-4" style={{ imageRendering: "pixelated" }} />
          <span className="font-semibold text-sm whitespace-nowrap" style={{ color: "hsl(var(--foreground))" }}>
            Easy Infer Station
          </span>
          <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}>
            v0.0.4
          </span>
        </div>

        <div
          className="flex-1 h-full"
          onMouseDown={(e) => { if (e.buttons === 1) getCurrentWindow().startDragging(); }}
        />

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
              ? "后端错误"
              : "后端未启动"}
          </span>
        </div>

        {/* Socket 状态 */}
        {socketConnected ? (
          <span title="WebSocket 已连接：可实时接收推理帧与日志">
            <Wifi className="w-4 h-4" style={{ color: "hsl(var(--success))" }} />
          </span>
        ) : (
          <span title="WebSocket 未连接：等待后端启动">
            <WifiOff className="w-4 h-4" style={{ color: "hsl(var(--muted-foreground))" }} />
          </span>
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

        {/* 检查更新按钮 */}
        <button
          onClick={handleCheckUpdate}
          disabled={checking}
          className="p-1.5 rounded-md transition-opacity hover:opacity-70 disabled:opacity-40"
          style={{ color: "hsl(var(--muted-foreground))" }}
          title="检查更新"
        >
          <ArrowDownToLine className={cn("w-4 h-4", checking && "animate-bounce")} />
        </button>

        {/* Buy me a coffee */}
        <button
          onClick={() => setShowDonateModal(true)}
          className="p-1.5 rounded-md transition-opacity hover:opacity-70"
          style={{ color: "hsl(var(--muted-foreground))" }}
          title="请作者喝杯咖啡"
        >
          <Coffee className="w-4 h-4" />
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

        {/* 窗口控制按钮 */}
        <div className="flex items-center ml-2">
          <button
            onClick={() => getCurrentWindow().minimize()}
            className="w-8 h-8 flex items-center justify-center hover:bg-white/10 transition-colors"
            title="最小化"
          >
            <span className="text-xs leading-none" style={{ color: "hsl(var(--muted-foreground))" }}>─</span>
          </button>
          <button
            onClick={() => getCurrentWindow().toggleMaximize()}
            className="w-8 h-8 flex items-center justify-center hover:bg-white/10 transition-colors"
            title="最大化 / 还原"
          >
            <span className="text-xs leading-none" style={{ color: "hsl(var(--muted-foreground))" }}>□</span>
          </button>
          <button
            onClick={() => getCurrentWindow().close()}
            className="w-8 h-8 flex items-center justify-center hover:bg-red-500 hover:text-white transition-colors rounded-sm"
            title="关闭"
          >
            <X className="w-3.5 h-3.5" style={{ color: "hsl(var(--muted-foreground))" }} />
          </button>
        </div>
      </div>

      {/* 打赏弹窗 */}
      {showDonateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={() => setShowDonateModal(false)}
        >
          <div
            className="relative rounded-2xl shadow-2xl p-8"
            style={{
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              maxWidth: "90vw",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 关闭 */}
            <button
              onClick={() => setShowDonateModal(false)}
              className="absolute top-3 right-3 p-1 rounded-md hover:opacity-70 transition-opacity"
              style={{ color: "hsl(var(--muted-foreground))" }}
            >
              <X className="w-4 h-4" />
            </button>

            {/* 标题 */}
            <div className="flex items-center justify-center gap-2 mb-6">
              <Coffee className="w-5 h-5" style={{ color: "#c8813a" }} />
              <span className="font-semibold text-base" style={{ color: "hsl(var(--foreground))" }}>
                请作者喝杯咖啡
              </span>
              <Coffee className="w-5 h-5" style={{ color: "#c8813a" }} />
            </div>

            {/* 卡片区 */}
            <div className="flex gap-4">
              {/* 支付宝卡 */}
              <div
                className="flex flex-col items-center rounded-xl overflow-hidden"
                style={{
                  width: 192,
                  border: "2px solid #1677ff",
                  background: "hsl(var(--background))",
                }}
              >
                {/* 卡头 */}
                <div
                  className="w-full flex items-center justify-center gap-1.5 py-2.5"
                  style={{ background: "#1677ff" }}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="white">
                    <path d="M21.422 13.346c.307.127.578.32.795.566L22.5 14.5c0 2.485-4.701 4.5-10.5 4.5S1.5 16.985 1.5 14.5c0-.234.023-.463.068-.688.51.19 1.078.359 1.693.505.068.016.136.033.206.049l.101.022c.67.142 1.385.26 2.132.353.1.013.2.024.3.036.3.034.605.064.912.09l.195.016c.42.03.843.053 1.268.067l.206.006C8.918 14.987 9.463 15 10.012 15a37.2 37.2 0 0 0 1.476-.034l.207-.009a31.65 31.65 0 0 0 1.267-.092l.195-.018a28.1 28.1 0 0 0 .9-.1l.3-.04a26.9 26.9 0 0 0 1.98-.338l.19-.043c.665-.161 1.275-.346 1.818-.552zm-9.41-9.845A6.014 6.014 0 0 1 18 9.5c0 .518-.066 1.02-.19 1.5a55.3 55.3 0 0 1-1.598.246 29.3 29.3 0 0 1-2.037.19 35.5 35.5 0 0 1-1.178.051L12.75 11.5H12c-.57 0-1.135-.015-1.69-.044l-.209-.012a31.1 31.1 0 0 1-1.178-.097 26.5 26.5 0 0 1-1.997-.3A30 30 0 0 1 5.37 10.8a6.012 6.012 0 0 1-.359-1.26l-.005-.04H5A6 6 0 0 1 12.012 3.5zm0 1.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"/>
                  </svg>
                  <span className="text-sm font-semibold text-white">支付宝</span>
                </div>
                {/* 二维码 */}
                <div className="p-3">
                  <img
                    src={alipayQR}
                    alt="支付宝收款码"
                    style={{ width: 160, height: 160, display: "block" }}
                    draggable={false}
                  />
                </div>
                {/* 底部提示 */}
                <div
                  className="w-full text-center py-2 text-xs"
                  style={{ color: "#1677ff", borderTop: "1px solid #e0eeff" }}
                >
                  扫码即可支付
                </div>
              </div>

              {/* 微信卡 */}
              <div
                className="flex flex-col items-center rounded-xl overflow-hidden"
                style={{
                  width: 192,
                  border: "2px solid #07c160",
                  background: "hsl(var(--background))",
                }}
              >
                {/* 卡头 */}
                <div
                  className="w-full flex items-center justify-center gap-1.5 py-2.5"
                  style={{ background: "#07c160" }}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="white">
                    <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.295.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.81-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.6-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-7.062-6.122zm-3.518 3.187c.535 0 .969.44.969.983a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.983.969-.983zm4.728 0c.535 0 .969.44.969.983a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.983.969-.983z"/>
                  </svg>
                  <span className="text-sm font-semibold text-white">微信支付</span>
                </div>
                {/* 二维码 */}
                <div className="p-3">
                  <img
                    src={wechatpayQR}
                    alt="微信收款码"
                    style={{ width: 160, height: 160, display: "block" }}
                    draggable={false}
                  />
                </div>
                {/* 底部提示 */}
                <div
                  className="w-full text-center py-2 text-xs"
                  style={{ color: "#07c160", borderTop: "1px solid #d9f5e8" }}
                >
                  扫码即可支付
                </div>
              </div>
            </div>

            <p className="text-center text-xs mt-5" style={{ color: "hsl(var(--muted-foreground))" }}>
              您的支持是持续开发的动力 ❤️
            </p>
          </div>
        </div>
      )}

      {/* 更新弹窗 */}
      {showUpdateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setShowUpdateModal(false)}
        >
          <div
            className="relative w-[480px] max-w-[90vw] rounded-xl shadow-2xl p-6"
            style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 关闭按钮 */}
            <button
              onClick={() => setShowUpdateModal(false)}
              className="absolute top-3 right-3 p-1 rounded-md hover:opacity-70 transition-opacity"
              style={{ color: "hsl(var(--muted-foreground))" }}
            >
              <X className="w-4 h-4" />
            </button>

            {updateError ? (
              /* 检查失败 */
              <>
                <div className="flex items-center gap-2 mb-3">
                  <span className="font-semibold text-sm" style={{ color: "hsl(var(--foreground))" }}>
                    检查更新失败
                  </span>
                </div>
                <p className="text-xs rounded-md p-3" style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}>
                  {updateError}
                </p>
                <div className="flex justify-end mt-4">
                  <button
                    onClick={() => setShowUpdateModal(false)}
                    className="px-4 py-1.5 rounded-md text-sm transition-opacity hover:opacity-80"
                    style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                  >
                    关闭
                  </button>
                </div>
              </>
            ) : updateInfo?.has_update ? (
              /* 有新版本 */
              <>
                <div className="flex items-center gap-2 mb-1">
                  <ArrowDownToLine className="w-5 h-5" style={{ color: "hsl(var(--primary))" }} />
                  <span className="font-semibold text-base" style={{ color: "hsl(var(--foreground))" }}>
                    发现新版本 v{updateInfo.latest_version}
                  </span>
                </div>
                <p className="text-xs mb-4" style={{ color: "hsl(var(--muted-foreground))" }}>
                  当前版本：v{updateInfo.current_version}
                </p>
                {updateInfo.release_notes && (
                  <div
                    className="rounded-md p-3 mb-4 text-xs max-h-48 overflow-y-auto whitespace-pre-wrap"
                    style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}
                  >
                    {updateInfo.release_notes}
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowUpdateModal(false)}
                    className="px-4 py-1.5 rounded-md text-sm transition-opacity hover:opacity-80"
                    style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                  >
                    稍后再说
                  </button>
                  <button
                    onClick={handleDownload}
                    className="px-4 py-1.5 rounded-md text-sm font-medium transition-opacity hover:opacity-80 flex items-center gap-1.5"
                    style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
                  >
                    <ArrowDownToLine className="w-3.5 h-3.5" />
                    前往下载
                  </button>
                </div>
              </>
            ) : (
              /* 已是最新 */
              <>
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 className="w-5 h-5" style={{ color: "hsl(var(--success))" }} />
                  <span className="font-semibold text-base" style={{ color: "hsl(var(--foreground))" }}>
                    已是最新版本
                  </span>
                </div>
                <p className="text-sm mb-4" style={{ color: "hsl(var(--muted-foreground))" }}>
                  当前版本 v{updateInfo?.current_version} 已是最新，无需更新。
                </p>
                <div className="flex justify-end">
                  <button
                    onClick={() => setShowUpdateModal(false)}
                    className="px-4 py-1.5 rounded-md text-sm transition-opacity hover:opacity-80"
                    style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                  >
                    关闭
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ─── 左侧控制面板 ─────────────────────────────────────────────
interface InferParamsState {
  inputType: "image" | "video" | "rtsp";
  inputSource: string;
  imagePaths: string[];   // 多图模式已选文件（非空时优先用批量模式）
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
  onBrowseMultiple,
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
  onBrowseMultiple: () => void;
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
          ) : params.inputType === "image" && params.imagePaths.length > 0 ? (
            /* 多图模式：显示已选文件列表 */
            <>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
                  已选 {params.imagePaths.length} 张图片
                </span>
                <button
                  onClick={() => onChange({ imagePaths: [] })}
                  className="text-xs px-1.5 py-0.5 rounded transition-opacity hover:opacity-70"
                  style={{ color: "hsl(var(--destructive))", border: "1px solid hsl(var(--border))" }}
                >
                  清空
                </button>
              </div>
              <div className="max-h-24 overflow-y-auto space-y-0.5 mb-1">
                {params.imagePaths.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1 text-xs rounded px-1.5 py-0.5"
                    style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                  >
                    <span className="flex-1 truncate" style={{ color: "hsl(var(--foreground))" }}>
                      {p.split(/[\\/]/).pop()}
                    </span>
                    <button
                      onClick={() => onChange({ imagePaths: params.imagePaths.filter((_, j) => j !== i) })}
                      className="flex-shrink-0 p-0.5 rounded hover:opacity-70 transition-opacity"
                      style={{ color: "hsl(var(--muted-foreground))" }}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={onBrowseMultiple}
                className="w-full py-1 rounded text-xs flex items-center justify-center gap-1 transition-opacity hover:opacity-70"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                重新选择
              </button>
            </>
          ) : (
            /* 单文件模式 */
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
                className="px-2 py-1.5 flex items-center transition-opacity hover:opacity-70"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))", borderRight: "none" }}
                title="单选"
              >
                <FolderOpen className="w-3.5 h-3.5" style={{ color: "hsl(var(--muted-foreground))" }} />
              </button>
              {params.inputType === "image" && (
                <button
                  onClick={onBrowseMultiple}
                  className="px-2 py-1.5 rounded-r flex items-center transition-opacity hover:opacity-70"
                  style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                  title="批量多选图片"
                >
                  <span className="text-xs font-medium" style={{ color: "hsl(var(--muted-foreground))" }}>批量</span>
                </button>
              )}
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
            disabled={!backendRunning || !params.modelPath || (params.imagePaths.length > 0 ? false : !params.inputSource)}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
            style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
          >
            <Play className="w-4 h-4" />
            {params.imagePaths.length > 0 ? `批量推理 (${params.imagePaths.length}张)` : "开始推理"}
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

// ─── 批量推理画廊 ──────────────────────────────────────────────
function LbBtn({
  onClick,
  title,
  label,
  active,
  children,
}: {
  onClick: () => void;
  title: string;
  label: string;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-lg transition-all hover:bg-white/10"
      style={{
        background: active ? "rgba(255,255,255,0.2)" : "transparent",
        color: active ? "white" : "rgba(255,255,255,0.75)",
        minWidth: "52px",
      }}
    >
      {children}
      <span style={{ fontSize: "10px" }}>{label}</span>
    </button>
  );
}

function BatchGallery() {
  const { batchResults, isBatchInferring, batchProgress, clearBatchResults } = useAppStore();
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  // 统一用一个对象描述视口状态，方便在事件回调中原子更新
  const [view, setView] = useState({ scale: 1, offsetX: 0, offsetY: 0, fitMode: true });

  // 拖拽相关 ref（不需要触发重渲染）
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const offsetAtDragStart = useRef({ x: 0, y: 0 });
  // 用 ref 缓存最新 offset，供 mousedown 闭包读取
  const currentOffset = useRef({ x: 0, y: 0 });
  currentOffset.current = { x: view.offsetX, y: view.offsetY };

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const total = batchResults.length;
  const selected = selectedIdx !== null ? (batchResults[selectedIdx] ?? null) : null;

  const resetView = () => setView({ scale: 1, offsetX: 0, offsetY: 0, fitMode: true });

  const openLightbox = (idx: number) => {
    setSelectedIdx(idx);
    resetView();
    isDragging.current = false;
  };

  const goPrev = useCallback(() => {
    setSelectedIdx((i) => i === null ? null : (i - 1 + total) % total);
    setView({ scale: 1, offsetX: 0, offsetY: 0, fitMode: true });
    isDragging.current = false;
  }, [total]);

  const goNext = useCallback(() => {
    setSelectedIdx((i) => i === null ? null : (i + 1) % total);
    setView({ scale: 1, offsetX: 0, offsetY: 0, fitMode: true });
    isDragging.current = false;
  }, [total]);

  // 键盘快捷键
  useEffect(() => {
    if (selectedIdx === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedIdx(null);
        isDragging.current = false;
      } else if (e.key === "ArrowLeft") {
        setSelectedIdx((i) => i === null ? null : (i - 1 + total) % total);
        setView({ scale: 1, offsetX: 0, offsetY: 0, fitMode: true });
        isDragging.current = false;
      } else if (e.key === "ArrowRight") {
        setSelectedIdx((i) => i === null ? null : (i + 1) % total);
        setView({ scale: 1, offsetX: 0, offsetY: 0, fitMode: true });
        isDragging.current = false;
      } else if (e.key === "+" || e.key === "=") {
        setView((v) => ({ ...v, scale: Math.min(v.scale * 1.25, 8), fitMode: false }));
      } else if (e.key === "-") {
        setView((v) => ({ ...v, scale: Math.max(v.scale * 0.8, 0.1), fitMode: false }));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIdx, total]);

  // 鼠标滚轮缩放（zoom-to-cursor）
  useEffect(() => {
    const container = containerRef.current;
    if (!container || selectedIdx === null) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      // 鼠标相对容器中心的偏移
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      setView((v) => {
        const newScale = Math.max(0.1, Math.min(8, v.scale * factor));
        const ratio = newScale / v.scale;
        return {
          scale: newScale,
          // 保持鼠标下的图像点不动
          offsetX: mx - ratio * (mx - v.offsetX),
          offsetY: my - ratio * (my - v.offsetY),
          fitMode: false,
        };
      });
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [selectedIdx]);

  // 拖拽：mousedown 挂在容器上，mousemove/mouseup 挂在 window 上防止丢失
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    offsetAtDragStart.current = { ...currentOffset.current };
  }, []);

  useEffect(() => {
    if (selectedIdx === null) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      setView((v) => ({
        ...v,
        offsetX: offsetAtDragStart.current.x + (e.clientX - dragStart.current.x),
        offsetY: offsetAtDragStart.current.y + (e.clientY - dragStart.current.y),
        fitMode: false,
      }));
    };
    const handleMouseUp = () => { isDragging.current = false; };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [selectedIdx]);

  // 原始大小：计算使图像呈现 1:1 像素所需的 scale
  const handleOriginalSize = useCallback(() => {
    const img = imgRef.current;
    const container = containerRef.current;
    if (img && container && img.naturalWidth > 0) {
      const fitScale = Math.min(
        container.clientWidth / img.naturalWidth,
        container.clientHeight / img.naturalHeight,
      );
      setView({ scale: 1 / fitScale, offsetX: 0, offsetY: 0, fitMode: false });
    } else {
      setView({ scale: 1, offsetX: 0, offsetY: 0, fitMode: false });
    }
  }, []);

  return (
    <div className="w-full h-full flex flex-col overflow-hidden">
      {/* 进度条（推理中） */}
      {isBatchInferring && batchProgress && (
        <div
          className="px-3 py-2 flex-shrink-0"
          style={{ borderBottom: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }}
        >
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span style={{ color: "hsl(var(--foreground))" }}>
              批量推理中... ({batchProgress.current}/{batchProgress.total})
            </span>
            {batchProgress.filename && (
              <span className="truncate max-w-[200px]" style={{ color: "hsl(var(--muted-foreground))" }}>
                {batchProgress.filename}
              </span>
            )}
          </div>
          <div className="w-full rounded-full h-1.5" style={{ background: "hsl(var(--muted))" }}>
            <div
              className="h-1.5 rounded-full transition-all duration-300"
              style={{
                background: "hsl(var(--primary))",
                width: `${batchProgress.total > 0 ? (batchProgress.current / batchProgress.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* 标题栏（完成后） */}
      {!isBatchInferring && batchResults.length > 0 && (
        <div
          className="px-3 py-1.5 flex-shrink-0 flex items-center justify-between"
          style={{ borderBottom: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }}
        >
          <span className="text-xs font-medium" style={{ color: "hsl(var(--foreground))" }}>
            批量结果 ({batchResults.length} 张)
          </span>
          <button
            onClick={clearBatchResults}
            className="p-1 rounded transition-opacity hover:opacity-70"
            style={{ color: "hsl(var(--muted-foreground))" }}
            title="清空批量结果"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 画廊网格 */}
      <div className="flex-1 overflow-y-auto p-2">
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
        >
          {batchResults.map((item, idx) => (
            <div
              key={item.id}
              onClick={() => item.image && openLightbox(idx)}
              className="rounded-lg overflow-hidden transition-all"
              style={{
                border: "1px solid hsl(var(--border))",
                background: "hsl(var(--card))",
                cursor: item.image ? "pointer" : "default",
              }}
            >
              <div
                className="aspect-video overflow-hidden flex items-center justify-center"
                style={{ background: "hsl(222 47% 8%)" }}
              >
                {item.image ? (
                  <img src={item.image} alt={item.filename} className="w-full h-full object-cover" />
                ) : (
                  <span
                    className="text-xs px-2 text-center line-clamp-3"
                    style={{ color: "hsl(var(--destructive))" }}
                    title={item.error}
                  >
                    {item.error ?? "推理失败"}
                  </span>
                )}
              </div>
              <div className="px-2 py-1">
                <div className="text-xs truncate" style={{ color: "hsl(var(--foreground))" }}>{item.filename}</div>
                <div className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
                  {item.detectionCount} 个目标
                </div>
              </div>
            </div>
          ))}

          {/* 待推理占位卡 */}
          {isBatchInferring && batchProgress &&
            Array.from({ length: Math.max(0, batchProgress.total - batchResults.length) }).map((_, i) => (
              <div
                key={`pending-${i}`}
                className="rounded-lg overflow-hidden"
                style={{ border: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }}
              >
                <div
                  className="aspect-video animate-pulse"
                  style={{ background: "hsl(var(--muted))" }}
                />
                <div className="px-2 py-1 space-y-1">
                  <div className="h-2.5 rounded" style={{ background: "hsl(var(--muted))", width: "75%" }} />
                  <div className="h-2 rounded" style={{ background: "hsl(var(--muted))", width: "45%" }} />
                </div>
              </div>
            ))
          }
        </div>
      </div>

      {/* 灯箱大图预览 */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center"
          style={{ background: "rgba(0,0,0,0.92)" }}
          onClick={() => { setSelectedIdx(null); isDragging.current = false; }}
        >
          {/* 关闭按钮 */}
          <button
            onClick={() => { setSelectedIdx(null); isDragging.current = false; }}
            className="absolute top-4 right-4 p-1.5 rounded-full transition-opacity hover:opacity-80 z-10"
            style={{ background: "rgba(255,255,255,0.15)", color: "white" }}
          >
            <X className="w-4 h-4" />
          </button>

          {/* 文件名 + 序号 */}
          <div
            className="mb-2 text-sm truncate max-w-[80vw] px-4 text-center flex-shrink-0"
            style={{ color: "rgba(255,255,255,0.8)" }}
          >
            {selected.filename}
            <span className="ml-2 text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>
              {selected.detectionCount} 个目标
            </span>
            <span className="ml-2 text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
              {selectedIdx! + 1} / {total}
            </span>
          </div>

          {/* 图片容器：overflow hidden + transform 实现缩放平移 */}
          <div
            ref={containerRef}
            className="flex items-center justify-center flex-shrink-0 select-none rounded-lg"
            style={{
              width: "88vw",
              height: "66vh",
              overflow: "hidden",
              cursor: "grab",
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={handleMouseDown}
          >
            <img
              ref={imgRef}
              key={selected.id}
              src={selected.image}
              alt={selected.filename}
              draggable={false}
              style={{
                maxWidth: "88vw",
                maxHeight: "66vh",
                objectFit: "contain",
                display: "block",
                transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})`,
                transformOrigin: "center center",
                userSelect: "none",
                pointerEvents: "none",
              }}
            />
          </div>

          {/* 工具栏 */}
          <div
            className="mt-3 flex items-center flex-shrink-0"
            style={{
              background: "rgba(20,20,20,0.88)",
              backdropFilter: "blur(10px)",
              borderRadius: "12px",
              padding: "4px 8px",
              gap: "2px",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <LbBtn onClick={goPrev} title="后退 (←)" label="后退">
              <ChevronLeft className="w-4 h-4" />
            </LbBtn>
            <LbBtn onClick={goNext} title="前进 (→)" label="前进">
              <ChevronRight className="w-4 h-4" />
            </LbBtn>

            <div style={{ width: 1, height: 32, background: "rgba(255,255,255,0.15)", margin: "0 6px" }} />

            <LbBtn
              onClick={resetView}
              title="适合窗口"
              label="适合窗口"
              active={view.fitMode}
            >
              <Maximize2 className="w-4 h-4" />
            </LbBtn>
            <LbBtn
              onClick={handleOriginalSize}
              title="原始大小 (1:1)"
              label="原始大小"
            >
              <ScanSearch className="w-4 h-4" />
            </LbBtn>

            <div style={{ width: 1, height: 32, background: "rgba(255,255,255,0.15)", margin: "0 6px" }} />

            <LbBtn
              onClick={() => setView((v) => ({ ...v, scale: Math.max(v.scale * 0.8, 0.1), fitMode: false }))}
              title="缩小 (-)"
              label="缩小"
            >
              <ZoomOut className="w-4 h-4" />
            </LbBtn>
            <LbBtn
              onClick={() => setView((v) => ({ ...v, scale: Math.min(v.scale * 1.25, 8), fitMode: false }))}
              title="放大 (+)"
              label="放大"
            >
              <ZoomIn className="w-4 h-4" />
            </LbBtn>

            {!view.fitMode && (
              <span
                className="ml-2 text-xs"
                style={{ color: "rgba(255,255,255,0.5)", minWidth: "40px", textAlign: "center" }}
              >
                {Math.round(view.scale * 100)}%
              </span>
            )}
          </div>
        </div>
      )}
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
  inputType,
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
  inputType: "image" | "video" | "rtsp";
}) {
  const { currentFrame, isInferring, inferLog, batchResults, isBatchInferring } = useAppStore();
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
        {isBatchInferring || (batchResults.length > 0 && inputType === "image") ? (
          /* 批量模式：显示画廊（仅 image 模式） */
          <div className="absolute inset-0">
            <BatchGallery />
          </div>
        ) : currentFrame ? (
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
        {/* ROI 画布覆盖层（批量模式下不显示） */}
        {!isBatchInferring && (batchResults.length === 0 || inputType !== "image") && (roiEnabled || roiDrawMode) && (
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
    imagePaths: [],
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
      setParams((p) => ({ ...p, inputSource: path, imagePaths: [], roiCoords: null, roiEnabled: false }));
  };

  const handleBrowseMultiple = async () => {
    const paths = await browseMultipleImageFiles();
    if (paths && paths.length > 0) {
      setParams((p) => ({ ...p, imagePaths: paths, inputSource: "", roiCoords: null, roiEnabled: false }));
    }
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
      if (!data.success) {
        addInferLog(`加载标签失败: ${data.message ?? "未知错误"}`);
        return; // 不清空已有标签
      }
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
    } catch (e) {
      addInferLog(`加载标签请求失败: ${e}`);
    }
  }, [apiToken, config, setLabels, addInferLog]);

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
    const commonParams = {
      model_path: params.modelPath,
      confidence: params.confidence,
      iou: params.iouThresh,
      device: params.device,
      selected_labels: params.selectedLabels,
      roi_enabled: params.roiEnabled,
      roi_coords: params.roiCoords,
    };

    if (params.imagePaths.length > 0) {
      // 批量多图模式
      emitStartInference({
        input_type: "images",
        input_paths: params.imagePaths,
        ...commonParams,
      });
    } else {
      // 单输入模式（图片/视频/RTSP）
      emitStartInference({
        input_type: params.inputType,
        input_source: params.inputSource,
        frame_skip: params.frameSkip,
        tracking_enabled: params.trackingEnabled,
        tracker: params.trackerType,
        ...commonParams,
      });
    }
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
              // 切换输入类型时清除多图列表
              if ("inputType" in p && p.inputType !== prev.inputType) {
                next.imagePaths = [];
              }
              // 清空多图时也清除批量结果
              if ("imagePaths" in p && (p.imagePaths ?? []).length === 0 && prev.imagePaths.length > 0) {
                useAppStore.getState().clearBatchResults();
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
          onBrowseMultiple={handleBrowseMultiple}
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
          inputType={params.inputType}
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
