/**
 * 设备实验室：默认不占用日常上传路径。
 * Windows 使用原生 WinRT/Bleak 做按需发现；加载配方后由用户在机器上确认开始。
 */
import { useEffect, useState } from "react";
import { api, type BleStatus } from "../lib/api.js";
import type { Recipe } from "../lib/recipe-schema.js";
import { btnGhost, btnPrimary, Card, CardHeader, Spinner, StatusDot } from "./ui.js";

export interface BlePanelProps {
  recipe: Recipe | null;
}

export default function BlePanel({ recipe }: BlePanelProps) {
  const [status, setStatus] = useState<BleStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(false);
  /** 加载成功时后端透传的非拦截警告。 */
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.bleStatus();
        if (!cancelled) setStatus(s);
      } catch (e) {
        if (!cancelled)
          setStatus({
            available: false,
            connected: false,
            ready: false,
            backend: "python-bleak",
            reason: (e as Error).message,
            supportsRemoteStart: false,
            guidance: "日常使用请同步到手机 xBloom App。",
          });
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    setMessage("");
    setWarnings([]);
    try {
      await fn();
      setMessage(okMsg);
      setStatus(await api.bleStatus().catch(() => status));
    } catch (e) {
      setMessage(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** 冲煮专用：除通用 run 流程外，消费后端透传的可达性等警告（不阻塞） */
  const brew = async (r: Recipe) => {
    setBusy(true);
    setMessage("");
    setWarnings([]);
    try {
      const res = await api.bleBrew(r);
      setMessage(res.message ?? "配方已加载，请在机器上确认开始");
      setWarnings(res.warnings ?? []);
      setStatus(await api.bleStatus().catch(() => status));
    } catch (e) {
      setMessage(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const available = status?.available ?? false;
  const connected = status?.connected ?? false;
  const ready = status?.ready ?? false;

  return (
    <Card>
      <CardHeader
        icon={<IconBle />}
        title="设备实验室"
        sub={checking ? "检查本机能力…" : "可选工具 · 日常使用走手机 App 上传"}
        right={
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[11px] text-[var(--tx-3)]">
              <StatusDot
                tone={checking ? "off" : ready || connected ? "ok" : available ? "warn" : "off"}
                pulse={connected}
              />
              {checking
                ? "检测中"
                : connected
                  ? "已连接"
                  : ready
                    ? "已发现"
                    : available
                      ? "待检测"
                      : "未就绪"}
            </span>
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="rounded-md border border-[var(--line)] px-2 py-1 text-[11px] text-[var(--tx-3)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--tx-1)]"
            >
              {expanded ? "收起" : "展开"}
            </button>
          </div>
        }
      />
      {expanded && (
        <div className="animate-fade-up p-5">
          {checking ? (
            <p className="flex items-center gap-2 text-xs text-[var(--tx-3)]">
              <Spinner /> 正在查询 BLE 能力…
            </p>
          ) : !available ? (
            <div className="rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-4 py-3 text-xs leading-relaxed text-[var(--tx-3)]">
              <p className="font-medium text-[var(--tx-2)]">本机 BLE 工具尚未就绪</p>
              {status?.reason && <p className="mt-1">{status.reason}</p>}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-3 py-3 text-[11px] leading-relaxed text-[var(--tx-3)]">
                <p className="font-medium text-[var(--tx-2)]">先用手机 App，必要时再用这里</p>
                <p className="mt-1">
                  机器同时只接收一个蓝牙连接。检测前请退出手机 xBloom
                  App，或暂时关闭手机蓝牙，并保持机器唤醒。
                </p>
                <p className="mt-2 font-mono text-[10px] opacity-75">
                  {status?.backend === "python-bleak" ? "Windows 原生蓝牙 · Bleak" : "Noble BLE"}
                </p>
              </div>

              {!ready && !connected && (
                <button
                  type="button"
                  onClick={() => void run(() => api.bleConnect(), "已发现附近的 xBloom")}
                  disabled={busy}
                  className={`${btnGhost} w-full`}
                >
                  {busy ? <Spinner /> : "检测附近的 xBloom"}
                </button>
              )}

              {(ready || connected) && (
                <>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--tx-2)]">
                    <input
                      type="checkbox"
                      checked={confirm}
                      onChange={(e) => setConfirm(e.target.checked)}
                      className="mt-0.5 h-3.5 w-3.5 accent-[var(--tx-1)]"
                    />
                    <span>
                      我已断开手机 App 的蓝牙连接，机器处于唤醒状态；加载后会在机器上确认开始
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      if (recipe) void brew(recipe);
                    }}
                    disabled={busy || !confirm || !recipe}
                    className={`${btnPrimary} w-full`}
                  >
                    {busy ? <Spinner /> : "加载当前配方到机器"}
                  </button>
                  {!recipe && (
                    <p className="text-[11px] text-[var(--tx-3)]">
                      当前没有可下发的配方，请先生成或载入
                    </p>
                  )}
                </>
              )}

              {message && (
                <p
                  className={`rounded-lg px-3 py-2 text-xs ${
                    message.startsWith("⚠")
                      ? "border border-[var(--bad)]/50 bg-[color-mix(in_srgb,var(--bad)_10%,transparent)] text-[var(--bad)]"
                      : "border border-[var(--sage)]/40 bg-[var(--sage-soft)] text-[var(--sage-deep)]"
                  }`}
                >
                  {message}
                </p>
              )}

              {/* 加载阶段的非拦截警告。 */}
              {warnings.length > 0 && (
                <ul className="space-y-0.5 rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-3 py-2 text-[11px] leading-relaxed text-[var(--tx-3)]">
                  {warnings.map((w, i) => (
                    <li key={i}>⚠ {w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function IconBle() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <path d="M7 7l10 10-5 4V3l5 4L7 17" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
