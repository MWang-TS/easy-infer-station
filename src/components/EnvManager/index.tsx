import { useState, useEffect } from "react";
import {
  X, RefreshCw, CheckCircle, XCircle, Loader2, AlertCircle,
  Github, Mail, Globe, ExternalLink, Copyright,
  Package, FileDown, ClipboardCopy, Check, ArrowUpRight,
} from "lucide-react";
import { useAppStore, type AppConfig } from "@/lib/store";
import { listCondaEnvs, type CondaEnv } from "@/lib/tauri-bridge";
import { stopBackend } from "@/lib/tauri-bridge";
import {
  getDependencyManifest,
  renderEnvironmentYml,
  renderRequirementsTxt,
  saveEnvironmentYml,
  saveRequirementsTxt,
  type DepManifest,
} from "@/lib/tauri-bridge";
import { disconnectSocket } from "@/lib/socket";
import { APP_VERSION } from "@/lib/version";
import {
  CONTACT_EMAIL,
  EASY_CONDA_URL,
  PRODUCT_HOME_URL,
  REPO_URL,
  STUDIO_URL,
} from "@/lib/links";
import { openUrl } from "@tauri-apps/plugin-opener";

interface EnvManagerProps {
  onClose: () => void;
}

export default function EnvManager({ onClose }: EnvManagerProps) {
  const { config, setConfig, setBackendStatus, addInferLog } = useAppStore();
  const [scanning, setScanning] = useState(false);
  const [envs, setEnvs] = useState<CondaEnv[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CondaEnv | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [tab, setTab] = useState<"env" | "deps" | "about">("env");

  // ─── 依赖清单 / 导出 ─────────────────────────────────────────
  const [manifest, setManifest] = useState<DepManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"" | "yml" | "txt">("");
  const [copied, setCopied] = useState<"" | "yml" | "txt">("");
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== "deps" || manifest) return;
    getDependencyManifest()
      .then(setManifest)
      .catch((e) => setManifestError(String(e)));
  }, [tab, manifest]);

  const handleScan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      const result = await listCondaEnvs();
      setEnvs(result);
      if (config?.conda.envPath) {
        const cur = result.find((e) => e.path === config.conda.envPath);
        setSelected(cur ?? null);
      }
    } catch (e) {
      setScanError(String(e));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    handleScan();
  }, []);

  const handleSwitch = async () => {
    if (!selected || !config) return;
    setRestarting(true);

    const pythonExe = selected.path.includes("\\")
      ? `${selected.path}\\python.exe`
      : `${selected.path}/bin/python`;

    const newConfig: AppConfig = {
      ...config,
      conda: {
        envPath: selected.path,
        envName: selected.name,
        pythonExe,
      },
    };

    addInferLog(`切换环境到: ${selected.name}，重启后端中...`);

    try {
      setBackendStatus("stopped");
      disconnectSocket();
      await stopBackend();
      setConfig(newConfig);
    } catch (e) {
      addInferLog(`切换失败: ${e}`);
    } finally {
      setRestarting(false);
      onClose();
    }
  };

  /**
   * 复制到剪贴板。
   * WebView2 下 `navigator.clipboard` 依赖安全上下文，失败时退回 textarea + execCommand。
   */
  const copyText = async (text: string): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
      throw new Error("clipboard unavailable");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(area);
      }
    }
  };

  const handleExport = async (kind: "yml" | "txt") => {
    setExporting(kind);
    setExportNotice(null);
    try {
      const path =
        kind === "yml" ? await saveEnvironmentYml() : await saveRequirementsTxt();
      if (path) setExportNotice(`已保存到 ${path}`);
    } catch (e) {
      setExportNotice(`导出失败：${String(e)}`);
    } finally {
      setExporting("");
    }
  };

  const handleCopy = async (kind: "yml" | "txt") => {
    try {
      const text =
        kind === "yml" ? await renderEnvironmentYml() : await renderRequirementsTxt();
      await copyText(text);
      setCopied(kind);
      setTimeout(() => setCopied(""), 1800);
    } catch (e) {
      setExportNotice(`复制失败：${String(e)}`);
    }
  };

  return (
    <>
      {/* 遮罩 */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: "rgba(0,0,0,0.5)" }}
        onClick={onClose}
      />

      {/* 抽屉 */}
      <div
        className="fixed right-0 top-0 bottom-0 z-50 flex flex-col w-80"
        style={{ background: "hsl(var(--card))", borderLeft: "1px solid hsl(var(--border))" }}
      >
        {/* 标题栏 */}
        <div
          className="flex items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ borderBottom: "1px solid hsl(var(--border))" }}
        >
          <h2 className="font-semibold text-sm" style={{ color: "hsl(var(--foreground))" }}>
            系统管理
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded transition-opacity hover:opacity-70"
            style={{ color: "hsl(var(--muted-foreground))" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 标签页 */}
        <div
          className="flex flex-shrink-0"
          style={{ borderBottom: "1px solid hsl(var(--border))" }}
        >
          {(["env", "deps", "about"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="flex-1 py-2 text-xs font-medium transition-colors"
              style={{
                color: tab === t ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))",
                borderBottom: tab === t ? "2px solid hsl(var(--primary))" : "2px solid transparent",
                background: "transparent",
              }}
            >
              {t === "env" ? "环境" : t === "deps" ? "依赖" : "关于"}
            </button>
          ))}
        </div>

        {/* ── 环境管理面板 ── */}
        {tab === "env" && (
          <>
            {/* 当前环境信息 */}
            {config && (
              <div
                className="mx-3 mt-3 p-3 rounded-lg flex-shrink-0"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
              >
                <div className="text-xs font-medium mb-1" style={{ color: "hsl(var(--muted-foreground))" }}>
                  当前环境
                </div>
                <div className="text-sm font-semibold" style={{ color: "hsl(var(--foreground))" }}>
                  {config.conda.envName}
                </div>
                <div className="text-xs mt-0.5" style={{ color: "hsl(var(--muted-foreground))" }}>
                  {config.conda.envPath}
                </div>
              </div>
            )}

            {/* 可用环境列表 */}
            <div className="flex items-center justify-between px-3 mt-4 mb-2 flex-shrink-0">
              <span className="text-xs font-medium" style={{ color: "hsl(var(--muted-foreground))" }}>
                可用环境
              </span>
              <button
                onClick={handleScan}
                disabled={scanning}
                className="flex items-center gap-1 text-xs transition-opacity hover:opacity-70"
                style={{ color: "hsl(var(--primary))" }}
              >
                {scanning ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                刷新
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-3 space-y-2">
              {scanning && (
                <div className="flex items-center gap-2 py-6 justify-center"
                  style={{ color: "hsl(var(--muted-foreground))" }}>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">扫描中...</span>
                </div>
              )}
              {scanError && (
                <div className="flex items-start gap-2 p-3 rounded-lg"
                  style={{ background: "hsl(var(--destructive) / 0.15)", border: "1px solid hsl(var(--destructive) / 0.4)" }}>
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: "hsl(var(--destructive))" }} />
                  <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>{scanError}</span>
                </div>
              )}
              {!scanning && envs.map((env) => (
                <button
                  key={env.path}
                  onClick={() => setSelected(env)}
                  className="w-full p-3 rounded-lg text-left transition-all hover:opacity-80"
                  style={{
                    background: selected?.path === env.path ? "hsl(var(--accent))" : "hsl(var(--muted))",
                    border: "1px solid hsl(var(--border))",
                    outline: selected?.path === env.path ? "2px solid hsl(var(--primary))" : "none",
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium" style={{ color: "hsl(var(--foreground))" }}>
                      {env.name}
                      {env.path === config?.conda.envPath && (
                        <span className="ml-1 text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
                          (当前)
                        </span>
                      )}
                    </span>
                    {env.is_valid ? (
                      <CheckCircle className="w-4 h-4" style={{ color: "hsl(var(--success))" }} />
                    ) : (
                      <XCircle className="w-4 h-4" style={{ color: "hsl(var(--destructive))" }} />
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 mt-1">
                    <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
                      Python {env.python_version}
                    </span>
                    {env.ultralytics_version && (
                      <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
                        ultralytics {env.ultralytics_version}
                      </span>
                    )}
                    {env.is_valid ? (
                      <span className="text-xs" style={{ color: "hsl(var(--success))" }}>
                        ✓ 所有依赖就绪
                      </span>
                    ) : (
                      <span className="text-xs" style={{ color: "hsl(var(--destructive))" }}>
                        缺少: {env.missing_packages.join(", ")}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>

            {/* 切换按钮 */}
            <div className="p-3 flex-shrink-0" style={{ borderTop: "1px solid hsl(var(--border))" }}>
              <button
                onClick={handleSwitch}
                disabled={!selected || !selected.is_valid || selected.path === config?.conda.envPath || restarting}
                className="w-full py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
              >
                {restarting ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    切换中...
                  </span>
                ) : (
                  "切换环境并重启"
                )}
              </button>
            </div>
          </>
        )}

        {/* ── 依赖清单 / 导出面板 ── */}
        {tab === "deps" && (
          <>
            <div
              className="mx-3 mt-3 p-3 rounded-lg flex-shrink-0"
              style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
            >
              <div className="flex items-center gap-2">
                <Package className="w-4 h-4 flex-shrink-0" style={{ color: "hsl(var(--primary))" }} />
                <span className="text-sm font-semibold" style={{ color: "hsl(var(--foreground))" }}>
                  运行依赖
                </span>
              </div>
              <div className="text-xs mt-1.5" style={{ color: "hsl(var(--muted-foreground))" }}>
                {manifest
                  ? `Python ${manifest.python_version} · ${manifest.count ?? (manifest.packages ?? []).length} 个包`
                  : manifestError
                  ? "读取失败"
                  : "读取中…"}
              </div>
            </div>

            {manifestError && (
              <div
                className="mx-3 mt-3 flex items-start gap-2 p-3 rounded-lg flex-shrink-0"
                style={{ background: "hsl(var(--destructive) / 0.15)", border: "1px solid hsl(var(--destructive) / 0.4)" }}
              >
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: "hsl(var(--destructive))" }} />
                <span className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>{manifestError}</span>
              </div>
            )}

            <div className="flex items-center justify-between px-3 mt-4 mb-2 flex-shrink-0">
              <span className="text-xs font-medium" style={{ color: "hsl(var(--muted-foreground))" }}>
                包与版本
              </span>
              {manifest && (
                <span className="text-[11px]" style={{ color: "hsl(var(--muted-foreground))" }}>
                  {(manifest.channels ?? []).join(", ") || "—"}
                </span>
              )}
            </div>

            {/* 依赖列表 */}
            <div className="flex-1 overflow-y-auto px-3">
              {!manifest && !manifestError && (
                <div className="flex items-center gap-2 py-6 justify-center" style={{ color: "hsl(var(--muted-foreground))" }}>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">读取中...</span>
                </div>
              )}
              {manifest && (
                <ul className="space-y-1 pb-2">
                  <li
                    className="flex items-center justify-between gap-2 px-2 py-1.5 rounded"
                    style={{ background: "hsl(var(--accent))" }}
                  >
                    <span className="text-xs font-medium" style={{ color: "hsl(var(--foreground))" }}>python</span>
                    <span className="text-xs font-mono" style={{ color: "hsl(var(--primary))" }}>
                      =={manifest.python_version}
                    </span>
                  </li>
                  {(manifest.packages ?? []).map((item) => (
                    <li
                      key={item.name}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 rounded"
                      style={{ background: "hsl(var(--muted))" }}
                      title={item.requirement}
                    >
                      <span className="text-xs truncate" style={{ color: "hsl(var(--foreground))" }}>
                        {item.name}
                      </span>
                      <span
                        className="text-xs font-mono flex-shrink-0"
                        style={{ color: item.spec ? "hsl(var(--muted-foreground))" : "hsl(var(--warning))" }}
                      >
                        {item.spec || "未固定"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 导出操作 */}
            <div className="p-3 flex-shrink-0 space-y-2" style={{ borderTop: "1px solid hsl(var(--border))" }}>
              {exportNotice && (
                <div
                  className="text-[11px] leading-relaxed break-all rounded-md p-2"
                  style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}
                >
                  {exportNotice}
                </div>
              )}

              <button
                onClick={() => handleExport("yml")}
                disabled={exporting !== "" || !manifest}
                className="w-full py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
              >
                {exporting === "yml" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <FileDown className="w-4 h-4" />
                )}
                导出 environment.yml
              </button>

              <div className="flex gap-2">
                <button
                  onClick={() => handleExport("txt")}
                  disabled={exporting !== "" || !manifest}
                  className="flex-1 py-1.5 rounded-lg text-xs flex items-center justify-center gap-1.5 transition-opacity hover:opacity-80 disabled:opacity-40"
                  style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                >
                  {exporting === "txt" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <FileDown className="w-3.5 h-3.5" />
                  )}
                  requirements.txt
                </button>
                <button
                  onClick={() => handleCopy("yml")}
                  disabled={!manifest}
                  className="flex-1 py-1.5 rounded-lg text-xs flex items-center justify-center gap-1.5 transition-opacity hover:opacity-80 disabled:opacity-40"
                  style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                  title="复制 environment.yml 内容"
                >
                  {copied === "yml" ? (
                    <Check className="w-3.5 h-3.5" style={{ color: "hsl(var(--success))" }} />
                  ) : (
                    <ClipboardCopy className="w-3.5 h-3.5" />
                  )}
                  {copied === "yml" ? "已复制" : "复制 YAML"}
                </button>
              </div>

              <button
                onClick={() => openUrl(EASY_CONDA_URL).catch(() => {})}
                className="w-full flex items-start gap-1.5 text-[11px] leading-relaxed text-left hover:opacity-70 transition-opacity pt-1"
                style={{ color: "hsl(var(--muted-foreground))" }}
                title={EASY_CONDA_URL}
              >
                <ArrowUpRight className="w-3 h-3 mt-0.5 flex-shrink-0" />
                <span>
                  导出的 environment.yml 可在「Easy Conda」的「环境 → 导入」中直接安装；也可以手动执行
                  <code className="mx-1 px-1 rounded" style={{ background: "hsl(var(--muted))" }}>
                    conda env create -f
                  </code>
                  安装。
                </span>
              </button>
            </div>
          </>
        )}

        {/* ── 关于面板 ── */}
        {tab === "about" && (
          <div className="flex-1 flex flex-col px-4 py-6 gap-5 overflow-y-auto">
            {/* 应用信息 */}
            <div className="flex flex-col gap-1">
              <p className="text-base font-semibold" style={{ color: "hsl(var(--foreground))" }}>
                Easy Infer Station
              </p>
              <p className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
                v{APP_VERSION} · YOLO 推理桌面工具
              </p>
            </div>

            <div
              className="h-px flex-shrink-0"
              style={{ background: "hsl(var(--border))" }}
            />

            {/* 产品主页 */}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium" style={{ color: "hsl(var(--muted-foreground))" }}>
                产品主页
              </p>
              <button
                onClick={() => openUrl(PRODUCT_HOME_URL).catch(() => {})}
                title="eis.tsagent.cc"
                className="flex items-center gap-2 text-xs hover:opacity-70 transition-opacity"
                style={{ color: "hsl(var(--foreground))" }}
              >
                <Globe className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 text-left">Easy Infer Station — PT 模型测试与演示工具</span>
                <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-60" />
              </button>
            </div>

            {/* 出品方 */}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium" style={{ color: "hsl(var(--muted-foreground))" }}>
                出品方
              </p>
              <button
                onClick={() => openUrl(STUDIO_URL).catch(() => {})}
                title="tsagent.cc"
                className="flex items-center gap-2 text-xs hover:opacity-70 transition-opacity"
                style={{ color: "hsl(var(--foreground))" }}
              >
                <span
                  className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold flex-shrink-0"
                  style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
                >
                  火
                </span>
                <span className="flex-1 text-left">火木工作室 — AI 原生产品</span>
                <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-60" />
              </button>
            </div>

            {/* 代码仓库 */}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium" style={{ color: "hsl(var(--muted-foreground))" }}>
                代码仓库
              </p>
              <button
                onClick={() => openUrl(REPO_URL).catch(() => {})}
                title="github.com/MWang-TS/easy-infer-station"
                className="flex items-center gap-2 text-xs hover:opacity-70 transition-opacity"
                style={{ color: "hsl(var(--foreground))" }}
              >
                <Github className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 text-left">MWang-TS/easy-infer-station</span>
                <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-60" />
              </button>
            </div>

            {/* 联系作者 */}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium" style={{ color: "hsl(var(--muted-foreground))" }}>
                联系作者
              </p>
              <button
                onClick={() => openUrl(`mailto:${CONTACT_EMAIL}`).catch(() => {})}
                className="flex items-center gap-2 text-xs hover:opacity-70 transition-opacity"
                style={{ color: "hsl(var(--foreground))" }}
              >
                <Mail className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 text-left">{CONTACT_EMAIL}</span>
              </button>
            </div>

            {/* 版权信息 */}
            <div className="mt-auto pt-2 flex flex-col gap-1">
              <div
                className="h-px flex-shrink-0 mb-2"
                style={{ background: "hsl(var(--border))" }}
              />
              <p
                className="flex items-start gap-1.5 text-[11px] leading-relaxed"
                style={{ color: "hsl(var(--muted-foreground))" }}
              >
                <Copyright className="w-3 h-3 mt-0.5 flex-shrink-0" />
                <span>
                  Copyright © {new Date().getFullYear()} 火木工作室. All rights reserved.
                </span>
              </p>
              <p className="text-[11px] leading-relaxed" style={{ color: "hsl(var(--muted-foreground))" }}>
                本软件基于 AGPL-3.0 协议开源，按「现状」提供，不附带任何担保。
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

