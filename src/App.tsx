import { Component, useEffect, useState, type ReactNode } from "react";
import { useAppStore } from "@/lib/store";
import SetupWizard from "@/pages/SetupWizard";
import MainPage from "@/pages/MainPage";

// ─── ErrorBoundary ─────────────────────────────────────────────────────────────
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 32, color: "#f87171", fontFamily: "monospace", fontSize: 13,
          background: "#0f172a", minHeight: "100vh", whiteSpace: "pre-wrap"
        }}>
          <strong style={{ fontSize: 16 }}>渲染错误（ErrorBoundary 捕获）</strong>
          {"\n\n"}
          {this.state.error.message}
          {"\n\n"}
          {this.state.error.stack}
          {"\n\n"}
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: "6px 16px", cursor: "pointer" }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Root ──────────────────────────────────────────────────────────────────────
function Root() {
  const isConfigured = useAppStore((s) => s.isConfigured);

  // Zustand v5 persist + localStorage：用 hasHydrated() 初始值 + onFinishHydration 订阅
  const [hydrated, setHydrated] = useState(
    () => useAppStore.persist.hasHydrated()
  );

  useEffect(() => {
    if (hydrated) return;
    const unsub = useAppStore.persist.onFinishHydration(() => setHydrated(true));
    // 双重保险：如果事件已错过，再同步检查一次
    if (useAppStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, [hydrated]);

  if (!hydrated) {
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        minHeight: "100vh", background: "#0f172a", color: "#94a3b8"
      }}>
        正在加载...
      </div>
    );
  }

  return isConfigured ? <MainPage /> : <SetupWizard />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  );
}
