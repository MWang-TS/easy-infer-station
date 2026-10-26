import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  CheckCircle2,
  Coffee,
  Loader2,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { POLL_INTERVAL_MS, SETTLE_GRACE_MS } from "@/lib/payment/config";
import { getDeviceCode } from "@/lib/payment/device-code";
import {
  GatewayError,
  centsToYuan,
  createTipOrder,
  fetchClientConfig,
  fetchOrder,
  newClientOrderId,
  parseYuanToCents,
  type ClientConfig,
  type OrderView,
  type PaymentProvider,
} from "@/lib/payment/gateway";

/**
 * 打赏弹窗。
 *
 * 流程（payment-server 接入指南 §7）：
 *   GET  /client/config           拿 tips 上下限与可用渠道（价格不写死在前端）
 *   POST /client/orders           下单（orderType=tip，金额单位元）
 *   GET  /client/orders/{id}      每 2 秒轮询，直到 paid / closed / failed
 *
 * 三条硬规则：
 *   1. `pending` / `creating` **绝不提示失败**
 *   2. 订单过期后再等 60 秒（服务端兜底对账）才判「未确认」
 *   3. 关闭弹窗立即停止轮询；进入终态后换新的 clientOrderId
 */

type Phase =
  | "idle"
  | "creating"
  | "pending"
  | "unconfirmed"
  | "paid"
  | "closed"
  | "failed"
  | "error";

/** 预设档位（分），最终由服务端 tips.minCents / maxCents 过滤。 */
const PRESET_CENTS = [500, 990, 1990, 3990];

const PROVIDER_META: Record<PaymentProvider, { label: string; badge: string; color: string }> = {
  alipay: { label: "支付宝", badge: "支", color: "#1677ff" },
  wechat: { label: "微信支付", badge: "微", color: "#07c160" },
};

function errorText(error: unknown): string {
  if (error instanceof GatewayError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export default function TipDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  const [provider, setProvider] = useState<PaymentProvider>("alipay");
  const [amountInput, setAmountInput] = useState("9.90");
  const [phase, setPhase] = useState<Phase>("idle");
  const [order, setOrder] = useState<OrderView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /**
   * 幂等键。
   * 同一次「金额 + 渠道」的重试复用同一个 id（防网络重试产生两笔单），
   * 一旦订单进入 closed / failed 终态就作废，下次必须换新值 —— 否则永远拿回死单。
   */
  const idempotencyRef = useRef<{ signature: string; id: string; dead: boolean }>({
    signature: "",
    id: "",
    dead: true,
  });

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const next = await fetchClientConfig();
      setConfig(next);
      const first = next.providers[0];
      if (first) setProvider(first);
    } catch (error) {
      setConfigError(errorText(error));
    } finally {
      setConfigLoading(false);
    }
  }, []);

  // 每次打开：清掉上一次的订单与提示，必要时拉一次目录
  useEffect(() => {
    if (!open) return;
    setOrder(null);
    setMessage(null);
    setPhase("idle");
    if (!config) loadConfig();
    // 目录只依赖 open 首次拉取，config/loadConfig 变化不需要重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 秒级刷新倒计时（只在有订单时跑）
  useEffect(() => {
    if (!open || !order) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, order]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // 轮询支付结果
  useEffect(() => {
    if (!open || phase !== "pending" || !order) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const parsedExpiry = Date.parse(order.expiresAt);
    const deadline = Number.isFinite(parsedExpiry)
      ? parsedExpiry + SETTLE_GRACE_MS
      : Number.POSITIVE_INFINITY;

    const tick = async () => {
      if (stopped) return;

      if (Date.now() > deadline) {
        // 已超时仍未确认：可能用户已付款但回调/对账尚未完成。
        // 这里**不能**引导用户重新支付，只能提示核对。
        setPhase("unconfirmed");
        setMessage("未确认到支付结果。如已付款请勿重复支付，稍后可在支付账单中核对。");
        return;
      }

      try {
        const latest = await fetchOrder(order.orderId, getDeviceCode());
        if (stopped) return;
        if (latest.status === "paid") {
          setOrder(latest);
          setPhase("paid");
          return;
        }
        if (latest.status === "closed" || latest.status === "failed") {
          setOrder(latest);
          setPhase(latest.status);
          setMessage(
            latest.status === "closed"
              ? "订单已关闭（超时未支付），请重新生成二维码。"
              : "下单失败，请重新生成二维码。"
          );
          idempotencyRef.current.dead = true;
          return;
        }
      } catch (error) {
        // 网络抖动 / 限流：静默重试；只有确定性错误才中止
        if (error instanceof GatewayError && !error.retryable) {
          if (!stopped) {
            setPhase("error");
            setMessage(error.message);
          }
          return;
        }
      }

      if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    timer = setTimeout(tick, 1200);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, phase, order]);

  const bounds = config?.tips;
  const providers = config?.providers ?? [];

  const presetCents = useMemo(() => {
    if (!bounds) return [];
    const { minCents, maxCents } = bounds;
    const list = PRESET_CENTS.filter((cents) => cents >= minCents && cents <= maxCents);
    return list.length > 0 ? list : [Math.min(Math.max(minCents, 100), maxCents)];
  }, [bounds]);

  const amountCents = parseYuanToCents(amountInput);
  const amountValid =
    amountCents !== null &&
    !!bounds &&
    amountCents >= bounds.minCents &&
    amountCents <= bounds.maxCents;

  const handleCreate = async () => {
    if (!config || !bounds) return;
    if (amountCents === null) {
      setMessage("请输入有效金额（最多两位小数）");
      return;
    }
    if (amountCents < bounds.minCents) {
      setMessage(`打赏金额不能低于 ¥${centsToYuan(bounds.minCents)}`);
      return;
    }
    if (amountCents > bounds.maxCents) {
      setMessage(`打赏金额不能高于 ¥${centsToYuan(bounds.maxCents)}`);
      return;
    }
    if (!providers.includes(provider)) {
      setMessage("所选支付方式暂未启用");
      return;
    }

    setMessage(null);
    setPhase("creating");

    const signature = `${provider}:${amountCents}`;
    const cached = idempotencyRef.current;
    if (cached.dead || cached.signature !== signature) {
      idempotencyRef.current = { signature, id: newClientOrderId(), dead: false };
    }

    try {
      const created = await createTipOrder({
        deviceCode: getDeviceCode(),
        provider,
        amount: centsToYuan(amountCents),
        clientOrderId: idempotencyRef.current.id,
      });
      setOrder(created);
      setNow(Date.now());
      if (created.status === "paid") {
        setPhase("paid");
        idempotencyRef.current.dead = true;
      } else if (created.status === "closed" || created.status === "failed") {
        setPhase(created.status);
        setMessage("订单已关闭，请重新生成二维码。");
        idempotencyRef.current.dead = true;
      } else {
        setPhase("pending");
      }
    } catch (error) {
      setPhase("error");
      setMessage(errorText(error));
      // 网络失败时订单可能已创建：保留幂等键，用户重试不会产生第二笔单
      if (error instanceof GatewayError && !error.retryable) {
        idempotencyRef.current.dead = true;
      }
    }
  };

  const handleCheckNow = async () => {
    if (!order) return;
    try {
      const latest = await fetchOrder(order.orderId, getDeviceCode());
      setOrder(latest);
      if (latest.status === "paid") setPhase("paid");
      else if (latest.status === "closed" || latest.status === "failed") {
        setPhase(latest.status);
        setMessage("订单已关闭，请重新生成二维码。");
        idempotencyRef.current.dead = true;
      } else {
        setMessage("支付尚未到账，请稍等片刻或重新扫码支付。");
      }
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  const handleReset = () => {
    idempotencyRef.current.dead = true;
    setOrder(null);
    setMessage(null);
    setPhase("idle");
  };

  const handleClose = () => {
    onClose();
  };

  if (!open) return null;

  const expiresAt = order ? Date.parse(order.expiresAt) : Number.NaN;
  const remainingMs = order && Number.isFinite(expiresAt) ? expiresAt - now : Number.NaN;
  const remainingText = (() => {
    if (!order) return "";
    if (!Number.isFinite(remainingMs)) return "";
    if (remainingMs <= 0) return "二维码已过期，正在确认支付结果…";
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `二维码有效期 ${minutes}:${String(seconds).padStart(2, "0")}`;
  })();

  const showForm = phase === "idle" || phase === "creating" || phase === "error";
  const showQr =
    (phase === "pending" || phase === "unconfirmed" || phase === "closed" || phase === "failed") &&
    !!order;

  // 通过 Portal 挂到 body：避免被父级 flex / overflow / 层叠上下文干扰，
  // 保证遮罩真正覆盖整个窗口、层级可靠（Tauri WebView2 下尤其明显）。
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)" }}
      // 点击遮罩**不关闭**：打赏涉及扫码与资金，误触失焦会打断支付流程。
      // 只允许通过右上角 × 或 Esc 显式关闭。
      role="presentation"
    >
      <div
        className="relative rounded-2xl shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="打赏"
        style={{
          width: 480,
          maxWidth: "92vw",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "linear-gradient(160deg, #0f1b2d 0%, #0a1220 100%)",
          border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
        }}
      >
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 z-10 w-8 h-8 flex items-center justify-center rounded-full hover:opacity-70 transition-opacity"
          style={{ background: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.6)" }}
          title="关闭"
        >
          <X className="w-4 h-4" />
        </button>

        {/* 标题 */}
        <div className="flex flex-col items-center pt-8 pb-5 px-8">
          <span style={{ fontSize: 40, lineHeight: 1 }}>☕</span>
          <h2 className="mt-3 text-xl font-bold" style={{ color: "#fff" }}>
            Buy Me a Coffee
          </h2>
          <p className="mt-1.5 text-sm text-center" style={{ color: "rgba(255,255,255,0.5)" }}>
            {config ? `${config.productName} 是免费软件，打赏完全自愿` : "如果这个软件对你有帮助，可以请作者喝杯咖啡"}
          </p>
        </div>

        <div style={{ height: 1, background: "rgba(255,255,255,0.08)" }} />

        {/* 目录加载失败：可继续用软件，不阻断 */}
        {configError && (
          <div className="px-6 pt-5">
            <div
              className="flex items-start gap-2 rounded-lg p-3 text-xs"
              style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.35)", color: "#fca5a5" }}
            >
              <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-semibold mb-1">暂时无法连接支付服务器</div>
                <div style={{ color: "rgba(252,165,165,0.85)" }}>{configError}</div>
              </div>
            </div>
            <button
              onClick={loadConfig}
              disabled={configLoading}
              className="mt-3 w-full py-2 rounded-lg text-sm flex items-center justify-center gap-2 transition-opacity hover:opacity-80 disabled:opacity-50"
              style={{ background: "rgba(255,255,255,0.1)", color: "#fff" }}
            >
              {configLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              重试
            </button>
          </div>
        )}

        {/* 表单 */}
        {showForm && !configError && (
          <div className="px-6 pt-5 pb-6">
            {!config ? (
              <div className="flex flex-col items-center gap-3 py-10" style={{ color: "rgba(255,255,255,0.5)" }}>
                <Loader2 className="w-6 h-6 animate-spin" />
                <span className="text-sm">正在获取打赏信息…</span>
              </div>
            ) : !bounds?.enabled ? (
              <div className="text-center text-sm py-10" style={{ color: "rgba(255,255,255,0.5)" }}>
                当前未开放打赏
              </div>
            ) : (
              <>
                {/* 金额档位 */}
                <div className="text-xs mb-2" style={{ color: "rgba(255,255,255,0.45)" }}>
                  选择金额（元）
                </div>
                <div className="grid grid-cols-4 gap-2 mb-3">
                  {presetCents.map((cents) => {
                    const active = amountCents === cents;
                    return (
                      <button
                        key={cents}
                        onClick={() => {
                          setAmountInput(centsToYuan(cents));
                          setMessage(null);
                        }}
                        className={cn(
                          "py-2 rounded-lg text-sm font-semibold transition-all",
                          active ? "text-white" : "text-white/70 hover:text-white"
                        )}
                        style={{
                          background: active ? "rgba(246,169,74,0.18)" : "rgba(255,255,255,0.06)",
                          border: active ? "1.5px solid #f6a94a" : "1.5px solid rgba(255,255,255,0.1)",
                        }}
                      >
                        ¥{cents % 100 === 0 ? cents / 100 : centsToYuan(cents)}
                      </button>
                    );
                  })}
                </div>

                {/* 自定义金额 */}
                <div
                  className="flex items-center gap-2 px-3 py-2 rounded-lg mb-4"
                  style={{ background: "rgba(255,255,255,0.06)", border: "1.5px solid rgba(255,255,255,0.1)" }}
                >
                  <span className="text-sm" style={{ color: "rgba(255,255,255,0.45)" }}>¥</span>
                  <input
                    value={amountInput}
                    onChange={(e) => {
                      setAmountInput(e.target.value);
                      setMessage(null);
                    }}
                    onBlur={() => {
                      // 失焦时把 9.9 规范成 9.90，避免与按钮上的展示格式不一致
                      const cents = parseYuanToCents(amountInput);
                      if (cents !== null) setAmountInput(centsToYuan(cents));
                    }}
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label="打赏金额（元）"
                    className="flex-1 bg-transparent outline-none text-sm"
                    style={{ color: "#fff" }}
                  />
                  <span className="text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
                    ¥{centsToYuan(bounds.minCents)} ~ ¥{centsToYuan(bounds.maxCents)}
                  </span>
                </div>

                {!amountValid && amountInput.trim() !== "" && (
                  <div className="mb-3 -mt-2 text-[11px]" style={{ color: "rgba(252,165,165,0.9)" }}>
                    {amountCents === null
                      ? "金额格式不正确，最多两位小数"
                      : `请输入 ¥${centsToYuan(bounds.minCents)} ~ ¥${centsToYuan(bounds.maxCents)} 之间的金额`}
                  </div>
                )}

                {/* 支付渠道 */}
                <div className="text-xs mb-2" style={{ color: "rgba(255,255,255,0.45)" }}>
                  支付方式
                </div>
                <div className="flex gap-2 mb-4">
                  {providers.map((item) => {
                    const meta = PROVIDER_META[item];
                    const active = provider === item;
                    return (
                      <button
                        key={item}
                        onClick={() => setProvider(item)}
                        className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm transition-all"
                        style={{
                          background: active ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)",
                          border: active ? `1.5px solid ${meta.color}` : "1.5px solid rgba(255,255,255,0.1)",
                          color: active ? "#fff" : "rgba(255,255,255,0.6)",
                        }}
                      >
                        <span
                          className="w-5 h-5 rounded flex items-center justify-center text-[11px] font-bold"
                          style={{ background: meta.color, color: "#fff" }}
                        >
                          {meta.badge}
                        </span>
                        {meta.label}
                      </button>
                    );
                  })}
                </div>

                {message && (
                  <div className="mb-3 text-xs" style={{ color: "#fca5a5" }}>
                    {message}
                  </div>
                )}

                <button
                  onClick={handleCreate}
                  disabled={phase === "creating"}
                  className="w-full py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-opacity hover:opacity-90 disabled:opacity-40"
                  style={{ background: "#f6a94a", color: "#1a1206" }}
                >
                  {phase === "creating" ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      正在生成二维码…
                    </>
                  ) : (
                    <>生成打赏二维码</>
                  )}
                </button>
                <p className="mt-3 text-[11px] text-center leading-relaxed" style={{ color: "rgba(255,255,255,0.3)" }}>
                  打赏为纯自愿行为，不产生任何授权或功能解锁
                </p>
              </>
            )}
          </div>
        )}

        {/* 二维码 / 结果 */}
        {showQr && order && (
          <div className="px-6 pt-5 pb-6 flex flex-col items-center">
            {phase === "pending" && order.qrCode ? (
              <>
                <div className="rounded-2xl p-4" style={{ background: "#fff" }}>
                  <QRCodeSVG
                    value={order.qrCode}
                    size={208}
                    level="M"
                    marginSize={0}
                    title="打赏支付二维码"
                    className="w-[208px] h-[208px] block"
                  />
                </div>
                <div className="mt-4 text-2xl font-bold" style={{ color: "#f6a94a" }}>
                  ¥{centsToYuan(order.amountCents)}
                </div>
                <div className="mt-1 text-xs" style={{ color: "rgba(255,255,255,0.45)" }}>
                  {PROVIDER_META[order.provider]?.label ?? order.provider} · 请使用手机扫码支付
                </div>
                <div className="mt-2 text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
                  {remainingText}
                </div>

                <div className="mt-5 w-full flex gap-2">
                  <button
                    onClick={handleCheckNow}
                    className="flex-1 py-2 rounded-lg text-sm transition-opacity hover:opacity-80"
                    style={{ background: "rgba(255,255,255,0.1)", color: "#fff" }}
                  >
                    我已完成支付
                  </button>
                  <button
                    onClick={handleReset}
                    className="py-2 px-4 rounded-lg text-sm transition-opacity hover:opacity-80"
                    style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.65)" }}
                    title="重新选择金额"
                  >
                    重选
                  </button>
                </div>

                <p className="mt-3 text-[11px] text-center leading-relaxed" style={{ color: "rgba(255,255,255,0.3)" }}>
                  支付完成后本页面会自动确认，无需手动刷新
                </p>
              </>
            ) : phase === "pending" ? (
              /* 订单已创建但服务端未下发二维码内容：极少数渠道/时序情况，别直接判失败 */
              <>
                <div
                  className="w-full rounded-lg p-3 text-xs flex items-start gap-2"
                  style={{ background: "rgba(246,169,74,0.12)", border: "1px solid rgba(246,169,74,0.35)", color: "#fcd34d" }}
                >
                  <Loader2 className="w-4 h-4 flex-shrink-0 mt-0.5 animate-spin" />
                  <span>支付二维码尚未生成，正在等待服务器返回…</span>
                </div>
                <div className="mt-4 w-full flex gap-2">
                  <button
                    onClick={handleCheckNow}
                    className="flex-1 py-2 rounded-lg text-sm transition-opacity hover:opacity-80"
                    style={{ background: "rgba(255,255,255,0.1)", color: "#fff" }}
                  >
                    再查一次
                  </button>
                  <button
                    onClick={handleReset}
                    className="py-2 px-4 rounded-lg text-sm transition-opacity hover:opacity-80"
                    style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.65)" }}
                  >
                    重选
                  </button>
                </div>
              </>
            ) : (
              <>
                <div
                  className="w-full rounded-lg p-3 text-xs flex items-start gap-2"
                  style={{
                    background: phase === "unconfirmed" ? "rgba(246,169,74,0.12)" : "rgba(239,68,68,0.12)",
                    border:
                      phase === "unconfirmed"
                        ? "1px solid rgba(246,169,74,0.35)"
                        : "1px solid rgba(239,68,68,0.35)",
                    color: phase === "unconfirmed" ? "#fcd34d" : "#fca5a5",
                  }}
                >
                  <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    {message ??
                      (phase === "unconfirmed"
                        ? "未确认到支付结果，请先核对账单后再决定是否重新打赏。"
                        : "订单已关闭，请重新生成二维码。")}
                  </span>
                </div>

                {phase === "unconfirmed" ? (
                  <div className="mt-4 w-full flex gap-2">
                    <button
                      onClick={handleCheckNow}
                      className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
                      style={{ background: "rgba(255,255,255,0.1)", color: "#fff" }}
                    >
                      再查一次
                    </button>
                    <button
                      onClick={handleReset}
                      className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
                      style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.7)" }}
                    >
                      重新生成二维码
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleReset}
                    className="mt-4 w-full py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-opacity hover:opacity-90"
                    style={{ background: "#f6a94a", color: "#1a1206" }}
                  >
                    <RefreshCw className="w-4 h-4" />
                    重新生成二维码
                  </button>
                )}
              </>
            )}

            {message && phase === "pending" && (
              <div className="mt-3 text-xs text-center" style={{ color: "rgba(255,255,255,0.5)" }}>
                {message}
              </div>
            )}
          </div>
        )}

        {/* 支付成功 */}
        {phase === "paid" && order && (
          <div className="px-6 pb-6 flex flex-col items-center">
            <div
              className="w-full rounded-lg p-4 flex items-center gap-3"
              style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.35)" }}
            >
              <CheckCircle2 className="w-6 h-6 flex-shrink-0" style={{ color: "#22c55e" }} />
              <div>
                <div className="text-sm font-semibold" style={{ color: "#86efac" }}>
                  感谢打赏 ¥{centsToYuan(order.amountCents)}
                </div>
                <div className="text-xs mt-0.5" style={{ color: "rgba(134,239,172,0.75)" }}>
                  你的支持是持续更新的动力
                </div>
              </div>
            </div>
            <button
              onClick={handleClose}
              className="mt-4 w-full py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
              style={{ background: "rgba(255,255,255,0.1)", color: "#fff" }}
            >
              关闭
            </button>
          </div>
        )}

        <div
          className="py-3.5 text-center text-xs"
          style={{
            color: "rgba(255,255,255,0.35)",
            background: "rgba(255,255,255,0.04)",
            borderTop: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <span className="inline-flex items-center gap-1">
            <Coffee className="w-3 h-3" />
            打赏不产生任何授权，软件保持全部功能可用
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
