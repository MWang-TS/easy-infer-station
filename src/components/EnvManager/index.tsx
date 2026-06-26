import { useState, useEffect } from "react";
import { X, RefreshCw, CheckCircle, XCircle, Loader2, AlertCircle, Github, Mail } from "lucide-react";
import { useAppStore, type AppConfig } from "@/lib/store";
import { listCondaEnvs, type CondaEnv } from "@/lib/tauri-bridge";
import { stopBackend } from "@/lib/tauri-bridge";
import { disconnectSocket } from "@/lib/socket";
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
  const [tab, setTab] = useState<"env" | "about">("env");

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
          {(["env", "about"] as const).map((t) => (
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
              {t === "env" ? "环境管理" : "关于"}
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

        {/* ── 关于面板 ── */}
        {tab === "about" && (
          <div className="flex-1 flex flex-col px-4 py-6 gap-5">
            {/* 应用信息 */}
            <div className="flex flex-col gap-1">
              <p className="text-base font-semibold" style={{ color: "hsl(var(--foreground))" }}>
                Easy Infer Station
              </p>
              <p className="text-xs" style={{ color: "hsl(var(--muted-foreground))" }}>
                v0.0.4 · YOLO 推理桌面工具
              </p>
            </div>

            <div
              className="h-px flex-shrink-0"
              style={{ background: "hsl(var(--border))" }}
            />

            {/* 代码仓库 */}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium" style={{ color: "hsl(var(--muted-foreground))" }}>
                代码仓库
              </p>
              <button
                onClick={() => openUrl("https://github.com/MWang-TS/easy-infer-station").catch(() => {})}
                title="github.com/MWang-TS/easy-infer-station"
                className="flex items-center gap-2 text-xs hover:opacity-70 transition-opacity"
                style={{ color: "hsl(var(--foreground))" }}
              >
                <Github className="w-5 h-5" />
              </button>
            </div>

            {/* 联系作者 */}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium" style={{ color: "hsl(var(--muted-foreground))" }}>
                联系作者
              </p>
              <button
                onClick={() => openUrl("mailto:gawain@tsagent.cc").catch(() => {})}
                className="flex items-center gap-2 text-xs hover:opacity-70 transition-opacity"
                style={{ color: "hsl(var(--foreground))" }}
              >
                <Mail className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 text-left">gawain@tsagent.cc</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

