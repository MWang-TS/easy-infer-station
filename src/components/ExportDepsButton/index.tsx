import { useState } from "react";
import { ArrowUpRight, Check, FileDown, Loader2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { saveEnvironmentYml } from "@/lib/tauri-bridge";
import { EASY_CONDA_URL } from "@/lib/links";

/**
 * 「导出安装清单」按钮。
 *
 * 用于「本机没有可用的 conda 环境」这类场景：导出 environment.yml，
 * 再拿到 Easy Conda 里导入安装。
 *
 * 依赖清单是**编译期内嵌**的（Rust `include_str!`），
 * 因此这里不需要 Python 后端在运行，也不需要 conda 已安装。
 */
export default function ExportDepsButton({
  compact = false,
  className = "",
}: {
  /** 紧凑模式：只在失败提示下方占一行，不显示说明文字。 */
  compact?: boolean;
  className?: string;
}) {
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const handleExport = async () => {
    setExporting(true);
    setNotice(null);
    try {
      const path = await saveEnvironmentYml("easy-infer-station-env.yml");
      if (path) setNotice(`已保存：${path}`);
    } catch (e) {
      setNotice(`导出失败：${String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={className}>
      <button
        onClick={handleExport}
        disabled={exporting}
        className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
        style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
        title="导出 environment.yml，可在 Easy Conda 中导入安装"
      >
        {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
        导出安装清单（environment.yml）
      </button>

      {notice && (
        <div
          className="mt-2 text-[11px] leading-relaxed break-all flex items-start gap-1"
          style={{ color: "hsl(var(--muted-foreground))" }}
        >
          {notice.startsWith("已保存") && (
            <Check className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: "hsl(var(--success))" }} />
          )}
          <span>{notice}</span>
        </div>
      )}

      {!compact && (
        <button
          onClick={() => openUrl(EASY_CONDA_URL).catch(() => {})}
          className="mt-2 w-full flex items-start gap-1 text-left text-[11px] leading-relaxed hover:opacity-70 transition-opacity"
          style={{ color: "hsl(var(--muted-foreground))" }}
          title={EASY_CONDA_URL}
        >
          <ArrowUpRight className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>
            在 Easy Conda 中「环境 → 导入」该文件即可自动装好 Python 3.10 与全部依赖；也可手动执行
            <code className="mx-1 px-1 rounded" style={{ background: "hsl(var(--muted))" }}>
              conda env create -f
            </code>
            。
          </span>
        </button>
      )}
    </div>
  );
}
