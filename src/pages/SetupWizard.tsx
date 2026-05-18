import { useState, useEffect } from "react";
import { Cpu, Search, CheckCircle, XCircle, AlertCircle, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { listCondaEnvs, getAppDir, type CondaEnv } from "@/lib/tauri-bridge";
import { useAppStore, type AppConfig } from "@/lib/store";

type Step = "mode" | "conda-select" | "confirm";

export default function SetupWizard() {
  const setConfig = useAppStore((s) => s.setConfig);

  const [step, setStep] = useState<Step>("mode");
  const [scanning, setScanning] = useState(false);
  const [envs, setEnvs] = useState<CondaEnv[]>([]);
  const [selected, setSelected] = useState<CondaEnv | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [appDir, setAppDir] = useState<string>("");

  useEffect(() => {
    getAppDir().then(setAppDir).catch(console.error);
  }, []);

  const handleScanEnvs = async () => {
    setScanning(true);
    setScanError(null);
    try {
      const result = await listCondaEnvs();
      setEnvs(result);
    } catch (e) {
      setScanError(String(e));
    } finally {
      setScanning(false);
    }
  };

  const handleConfirm = () => {
    if (!selected) return;

    const pythonExe = selected.path.includes("\\")
      ? `${selected.path}\\python.exe`
      : `${selected.path}/bin/python`;

    const config: AppConfig = {
      mode: "conda",
      conda: {
        envPath: selected.path,
        envName: selected.name,
        pythonExe,
      },
      port: 8080,
      appDir,
    };
    setConfig(config);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6"
      style={{ background: "hsl(var(--background))" }}>
      <div className="w-full max-w-2xl">
        {/* 标题 */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: "hsl(var(--primary))" }}>
            <Cpu className="w-8 h-8" style={{ color: "hsl(var(--background))" }} />
          </div>
          <h1 className="text-2xl font-bold mb-1" style={{ color: "hsl(var(--foreground))" }}>
            Easy Infer Station
          </h1>
          <p style={{ color: "hsl(var(--muted-foreground))" }}>首次启动配置</p>
        </div>

        {/* 步骤指示器 */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {(["mode", "conda-select", "confirm"] as Step[]).map((s, idx) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all",
                  step === s
                    ? "text-white"
                    : idx < (["mode", "conda-select", "confirm"] as Step[]).indexOf(step)
                    ? "opacity-60"
                    : "opacity-30"
                )}
                style={{
                  background:
                    step === s
                      ? "hsl(var(--primary))"
                      : idx < (["mode", "conda-select", "confirm"] as Step[]).indexOf(step)
                      ? "hsl(var(--success))"
                      : "hsl(var(--border))",
                }}
              >
                {idx + 1}
              </div>
              {idx < 2 && (
                <div className="w-12 h-px" style={{ background: "hsl(var(--border))" }} />
              )}
            </div>
          ))}
        </div>

        {/* 卡片内容 */}
        <div className="rounded-xl p-6" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>

          {/* Step 1: 选择模式 */}
          {step === "mode" && (
            <div>
              <h2 className="text-lg font-semibold mb-2" style={{ color: "hsl(var(--foreground))" }}>
                选择运行模式
              </h2>
              <p className="text-sm mb-6" style={{ color: "hsl(var(--muted-foreground))" }}>
                选择推理后端的运行方式
              </p>

              <button
                className="w-full p-4 rounded-lg text-left transition-all group"
                style={{
                  background: "hsl(var(--accent))",
                  border: "2px solid hsl(var(--primary))",
                }}
                onClick={() => {
                  setStep("conda-select");
                  handleScanEnvs();
                }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center"
                    style={{ background: "hsl(var(--primary) / 0.2)" }}>
                    <Cpu className="w-5 h-5" style={{ color: "hsl(var(--primary))" }} />
                  </div>
                  <div>
                    <div className="font-semibold" style={{ color: "hsl(var(--foreground))" }}>
                      本地 Conda 环境
                    </div>
                    <div className="text-sm" style={{ color: "hsl(var(--muted-foreground))" }}>
                      使用本机已安装的 Python conda 环境（推荐，支持 GPU）
                    </div>
                  </div>
                  <ChevronRight className="ml-auto w-5 h-5" style={{ color: "hsl(var(--muted-foreground))" }} />
                </div>
              </button>
            </div>
          )}

          {/* Step 2: 选择 conda 环境 */}
          {step === "conda-select" && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-semibold" style={{ color: "hsl(var(--foreground))" }}>
                  选择 Conda 环境
                </h2>
                <button
                  onClick={handleScanEnvs}
                  className="flex items-center gap-1 text-sm px-3 py-1 rounded-md transition-opacity hover:opacity-80"
                  style={{ color: "hsl(var(--primary))" }}
                  disabled={scanning}
                >
                  {scanning ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Search className="w-4 h-4" />
                  )}
                  重新扫描
                </button>
              </div>
              <p className="text-sm mb-4" style={{ color: "hsl(var(--muted-foreground))" }}>
                选择包含 torch 和 ultralytics 的环境（标记 ✓ 可用）
              </p>

              {scanning && (
                <div className="flex items-center gap-2 py-8 justify-center"
                  style={{ color: "hsl(var(--muted-foreground))" }}>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>正在扫描 conda 环境...</span>
                </div>
              )}

              {scanError && (
                <div className="flex items-start gap-2 p-3 rounded-lg mb-4"
                  style={{ background: "hsl(var(--destructive) / 0.15)", border: "1px solid hsl(var(--destructive) / 0.4)" }}>
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: "hsl(var(--destructive))" }} />
                  <div>
                    <div className="text-sm font-medium" style={{ color: "hsl(var(--destructive-foreground))" }}>
                      扫描失败
                    </div>
                    <div className="text-xs mt-1" style={{ color: "hsl(var(--muted-foreground))" }}>
                      {scanError}
                    </div>
                    <div className="text-xs mt-1" style={{ color: "hsl(var(--muted-foreground))" }}>
                      请确认 conda 已安装且在 PATH 中（conda init 后重启终端）
                    </div>
                  </div>
                </div>
              )}

              {!scanning && !scanError && envs.length === 0 && (
                <div className="text-center py-8" style={{ color: "hsl(var(--muted-foreground))" }}>
                  <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <div className="text-sm">未找到 conda 环境</div>
                  <div className="text-xs mt-1">
                    请先安装 Anaconda 或 Miniconda，并创建含 torch + ultralytics 的环境
                  </div>
                </div>
              )}

              {!scanning && envs.length > 0 && (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {envs.map((env) => (
                    <button
                      key={env.path}
                      onClick={() => setSelected(env)}
                      className={cn(
                        "w-full p-3 rounded-lg text-left transition-all",
                        selected?.path === env.path ? "ring-2" : "hover:opacity-80"
                      )}
                      style={{
                        background:
                          selected?.path === env.path
                            ? "hsl(var(--accent))"
                            : "hsl(var(--muted))",
                        border: "1px solid hsl(var(--border))",
                        outline:
                          selected?.path === env.path
                            ? `2px solid hsl(var(--primary))`
                            : "none",
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-medium" style={{ color: "hsl(var(--foreground))" }}>
                            {env.name}
                          </span>
                          <span className="text-xs px-1.5 py-0.5 rounded"
                            style={{ background: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>
                            Python {env.python_version}
                          </span>
                        </div>
                        {env.is_valid ? (
                          <CheckCircle className="w-4 h-4" style={{ color: "hsl(var(--success))" }} />
                        ) : (
                          <XCircle className="w-4 h-4" style={{ color: "hsl(var(--destructive))" }} />
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 mt-1">
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
              )}

              <div className="flex gap-2 mt-4">
                <button
                  className="flex-1 py-2 rounded-lg text-sm transition-opacity hover:opacity-80"
                  style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                  onClick={() => setStep("mode")}
                >
                  返回
                </button>
                <button
                  className="flex-1 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
                  style={{
                    background: selected?.is_valid ? "hsl(var(--primary))" : "hsl(var(--muted))",
                    color: selected?.is_valid ? "hsl(var(--primary-foreground))" : "hsl(var(--muted-foreground))",
                  }}
                  disabled={!selected || !selected.is_valid}
                  onClick={() => setStep("confirm")}
                >
                  下一步
                </button>
              </div>
            </div>
          )}

          {/* Step 3: 确认 */}
          {step === "confirm" && selected && (
            <div>
              <h2 className="text-lg font-semibold mb-2" style={{ color: "hsl(var(--foreground))" }}>
                确认配置
              </h2>
              <p className="text-sm mb-6" style={{ color: "hsl(var(--muted-foreground))" }}>
                请确认以下配置信息
              </p>

              <div className="space-y-3 p-4 rounded-lg mb-6"
                style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}>
                <div className="flex justify-between text-sm">
                  <span style={{ color: "hsl(var(--muted-foreground))" }}>运行模式</span>
                  <span style={{ color: "hsl(var(--foreground))" }}>本地 Conda</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span style={{ color: "hsl(var(--muted-foreground))" }}>环境名称</span>
                  <span style={{ color: "hsl(var(--foreground))" }}>{selected.name}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span style={{ color: "hsl(var(--muted-foreground))" }}>Python 版本</span>
                  <span style={{ color: "hsl(var(--foreground))" }}>{selected.python_version}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span style={{ color: "hsl(var(--muted-foreground))" }}>后端端口</span>
                  <span style={{ color: "hsl(var(--foreground))" }}>8080</span>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  className="flex-1 py-2 rounded-lg text-sm transition-opacity hover:opacity-80"
                  style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))" }}
                  onClick={() => setStep("conda-select")}
                >
                  返回
                </button>
                <button
                  className="flex-1 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
                  style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
                  onClick={handleConfirm}
                >
                  开始使用
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
