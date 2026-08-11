/**
 * 小红书账号入口（任务 #83）：顶栏常驻状态徽标 + 弹窗内扫码登录/续期/切换账号。
 * - 徽标四态：已登录（+昵称）/ 已过期（警示）/ 未登录 / 服务离线（MCP 未启动）
 * - 弹窗流程：状态展示 → 取二维码（base64 图 + 倒计时）→ 2.5s 轮询确认 → 成功刷新；
 *   二维码过期提供「换一张」；已登录时经「登出并切换账号」（delete_cookies）重新扫码。
 * - 失效自动提醒：调研事件 xhsLoginExpired 置徽标警示态，非阻断，不打断生成流程。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type XhsStatus, xhsFailureKindFromError } from "../lib/api.js";
import { xhsQrFailureCopy, type XhsQrFailureKind } from "../lib/xhs-qr.js";
import { btnGhost, btnPrimary, btnText, Modal, Spinner, StatusDot } from "./ui.js";
import { createPortal } from "react-dom";
import { hostedPage, pairCompanion } from "../lib/companion.js";

/** 二维码展示态状态机 */
type QrPhase = "idle" | "loading" | "code" | "expired" | "confirmed" | "already" | "error";

const POLL_INTERVAL_MS = 2500;

export default function XhsAccount({
  /** 调研事件检测到小红书登录失效（App 层置位，非阻断警示） */
  expiredAlert,
  /** 登录成功/状态恢复后清除失效警示 */
  onClearExpired,
}: {
  expiredAlert: boolean;
  onClearExpired: () => void;
}) {
  const [status, setStatus] = useState<XhsStatus | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // ---- 二维码流程状态 ----
  const [qrPhase, setQrPhase] = useState<QrPhase>("idle");
  const [qrSrc, setQrSrc] = useState("");
  const [qrExpiresAt, setQrExpiresAt] = useState(0);
  const [qrHint, setQrHint] = useState("");
  const [qrError, setQrError] = useState("");
  const [qrFailureKind, setQrFailureKind] = useState<XhsQrFailureKind>();
  const [busy, setBusy] = useState(false);
  const [confirmedName, setConfirmedName] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // ---- Cookie 导入兜底（任务 #97：扫码被风控拦截时的替代通道）----
  const [cookieText, setCookieText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [importFailed, setImportFailed] = useState(false);
  /** 登录说明折叠态（任务 #126：已登录态默认折叠） */
  const [infoOpen, setInfoOpen] = useState(false);
  const [pairBusy, setPairBusy] = useState(false);
  /** 状态探活与账号操作各自使用序列号，晚到响应不得覆盖新状态。 */
  const statusRequestIdRef = useRef(0);
  const operationIdRef = useRef(0);

  const refreshStatus = useCallback(async () => {
    const requestId = ++statusRequestIdRef.current;
    try {
      const s = await api.xhsStatus();
      if (requestId !== statusRequestIdRef.current) return null;
      setStatus(s);
      // 实际已登录 → 失效警示自动解除（如已在别处续期）
      if (s.online && s.loggedIn) onClearExpired();
      return s;
    } catch {
      if (requestId !== statusRequestIdRef.current) return null;
      setStatus(null);
      return null;
    }
  }, [onClearExpired]);

  // 任务 #99：ref 化不稳定回调——轮询 effect 的依赖数组只留 [qrPhase, qrExpiresAt]，
  // 避免 onClearExpired/refreshStatus 身份变化（如父组件流式重渲染）反复拆除重建 interval
  // 导致轮询饥饿（扫完码永远停在「等待确认」）；interval 回调内读 ref 拿最新引用。
  const onClearExpiredRef = useRef(onClearExpired);
  const refreshStatusRef = useRef(refreshStatus);
  /** 弹窗开关同步镜像：供在途异步回调（fetchQrcode）判断弹窗是否已被关闭 */
  const modalOpenRef = useRef(false);
  /** 每次取码递增；关闭弹窗或再次取码后，旧请求结果不得覆盖新状态。 */
  const qrRequestIdRef = useRef(0);
  useEffect(() => {
    onClearExpiredRef.current = onClearExpired;
    refreshStatusRef.current = refreshStatus;
  });

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  /** 取二维码：alreadyLoggedIn 走切号引导；其余展示码 + 倒计时 */
  const fetchQrcode = useCallback(async () => {
    const requestId = ++qrRequestIdRef.current;
    setQrPhase("loading");
    setQrError("");
    setQrFailureKind(undefined);
    setQrSrc("");
    setQrHint("");
    setQrExpiresAt(0);
    try {
      const r = await api.xhsQrcode();
      // 任务 #99：弹窗已在等待期间被关闭（closeModal 已重置为 idle）——
      // 丢弃迟到的取码结果，避免重新进入 code 态又拉起轮询/倒计时空转
      if (!modalOpenRef.current || requestId !== qrRequestIdRef.current) return;
      if (r.alreadyLoggedIn) {
        setQrPhase("already");
        return;
      }
      if (!r.qrcode || !r.expiresAt) {
        setQrPhase("error");
        setQrFailureKind(r.failureKind ?? "no_qrcode");
        setQrError(r.message ?? "二维码获取失败，请稍后重试");
        return;
      }
      setQrSrc(r.qrcode);
      setQrExpiresAt(r.expiresAt);
      setQrHint(r.hint ?? "");
      setQrPhase("code");
    } catch (e) {
      if (!modalOpenRef.current || requestId !== qrRequestIdRef.current) return;
      setQrPhase("error");
      setQrFailureKind(xhsFailureKindFromError(e) ?? "unknown");
      setQrError((e as Error).message);
    }
  }, []);

  /** 登出并切换账号：delete_cookies 成功后立即取新码（二次确认，防误触） */
  const logoutAndSwitch = useCallback(async () => {
    if (!window.confirm("登出后当前账号会立即下线，需重新扫码才能恢复。确定要切换账号吗？")) return;
    const operationId = ++operationIdRef.current;
    setBusy(true);
    try {
      await api.xhsLogout();
      if (!modalOpenRef.current || operationId !== operationIdRef.current) return;
      await fetchQrcode();
    } catch (e) {
      if (!modalOpenRef.current || operationId !== operationIdRef.current) return;
      setQrPhase("error");
      setQrError(`登出失败：${(e as Error).message}`);
    } finally {
      if (operationId === operationIdRef.current) setBusy(false);
    }
  }, [fetchQrcode]);

  // 倒计时 1s 刷新显示
  useEffect(() => {
    if (qrPhase !== "code") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [qrPhase]);

  // 轮询确认：上一次结束后再等待 2.5s，避免 MCP 慢响应时请求重叠。
  useEffect(() => {
    if (qrPhase !== "code") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (Date.now() >= qrExpiresAt) {
        if (!cancelled) setQrPhase("expired");
        return;
      }
      try {
        const r = await api.xhsPoll();
        if (!cancelled && r.loggedIn) {
          setConfirmedName(r.nickname ?? "");
          setQrPhase("confirmed");
          onClearExpiredRef.current();
          void refreshStatusRef.current();
          return;
        }
      } catch {
        // 单次轮询失败后退避重试，二维码主状态仍保留。
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [qrPhase, qrExpiresAt]);

  const openModal = () => {
    operationIdRef.current += 1;
    modalOpenRef.current = true;
    setModalOpen(true);
    void refreshStatus();
  };

  const connectCompanion = async () => {
    setPairBusy(true);
    setQrError("");
    try {
      await pairCompanion();
      await refreshStatus();
    } catch (error) {
      setQrError((error as Error).message);
    } finally {
      setPairBusy(false);
    }
  };

  /**
   * 任务 #99：关闭弹窗时若扫码流程仍在进行中（取码中/展示码），一并重置为 idle，
   * 让 2.5s 轮询与 1s 倒计时两个 effect 随依赖变化自然清理，不后台空转到过期。
   * 已确认/已登录等终态不动，保留重新打开弹窗时的状态展示。
   */
  const closeModal = () => {
    operationIdRef.current += 1;
    qrRequestIdRef.current += 1;
    modalOpenRef.current = false;
    setModalOpen(false);
    setQrPhase((p) => (p === "code" || p === "loading" ? "idle" : p));
  };

  /** Cookie 导入：后端写入 cookies.json 后立即验证；失败文案由后端 message 携带 */
  const importCookies = useCallback(async () => {
    if (!cookieText.trim() || importBusy) return;
    const operationId = ++operationIdRef.current;
    setImportBusy(true);
    setImportMsg("");
    setImportFailed(false);
    try {
      const r = await api.xhsCookieImport(cookieText.trim());
      if (!modalOpenRef.current || operationId !== operationIdRef.current) return;
      setConfirmedName(r.nickname ?? "");
      setQrPhase("confirmed");
      setCookieText("");
      onClearExpired();
      void refreshStatus();
    } catch (e) {
      if (!modalOpenRef.current || operationId !== operationIdRef.current) return;
      setImportFailed(true);
      setImportMsg((e as Error).message);
    } finally {
      if (operationId === operationIdRef.current) setImportBusy(false);
    }
  }, [cookieText, importBusy, onClearExpired, refreshStatus]);

  // ---- 徽标四态 ----
  const offline = status !== null && !status.online;
  const loggedIn = !!status?.online && status.loggedIn;
  const showExpiredAlert = expiredAlert && !loggedIn;
  const badgeTone: "ok" | "warn" | "off" | "bad" = loggedIn
    ? "ok"
    : showExpiredAlert
      ? "bad"
      : offline || status === null
        ? "off"
        : "warn";
  const badgeLabel = loggedIn
    ? `小红书 · ${status?.nickname ?? "已登录"}`
    : showExpiredAlert
      ? "小红书 · 已过期"
      : offline || status === null
        ? "小红书 · 服务离线"
        : status?.checkFailed
          ? "小红书 · 状态未知"
          : "小红书 · 未登录";

  const remainingSec = Math.max(0, Math.round((qrExpiresAt - now) / 1000));
  const qrFailure = xhsQrFailureCopy(qrFailureKind);

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        title="小红书账号：扫码登录 / 续期 / 切换账号"
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] leading-4 transition-colors duration-150 hover:bg-[var(--bg-inset)] ${
          showExpiredAlert
            ? "border-[color-mix(in_srgb,var(--bad)_45%,transparent)] text-[var(--bad)]"
            : "border-[var(--line)] text-[var(--tx-2)]"
        }`}
      >
        <StatusDot tone={badgeTone} pulse={loggedIn || showExpiredAlert} />
        {badgeLabel}
      </button>

      {modalOpen &&
        createPortal(
          <Modal
            open={modalOpen}
            onClose={closeModal}
            title="小红书账号"
            sub="联网调研的小红书笔记来源依赖此账号；登录过期或需要换号时在此重新扫码"
          >
            <div className="space-y-4">
              {/* ---- 品牌状态卡片（任务 #126）：card-surface + 品牌标识 + ghost 动作 ---- */}
              <div
                className="card-surface animate-fade-up overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--bg-card)]"
                style={{ animationDelay: "0ms" }}
              >
                {/* 品牌头部：XHS 粉点 + eyebrow + 在线状态灯 */}
                <div className="flex items-center justify-between gap-3 px-5 py-4">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--xhs-brand-soft)]">
                      <span className="h-2.5 w-2.5 rounded-full bg-[var(--xhs-brand)]" />
                    </span>
                    <div>
                      <p className="eyebrow">小红书 · Xiaohongshu</p>
                      <p className="mt-0.5 text-[11px] text-[var(--tx-3)]">联网调研笔记来源</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <StatusDot tone={badgeTone} pulse={loggedIn || showExpiredAlert} />
                    <span className="text-[11px] font-medium text-[var(--tx-2)]">
                      {loggedIn ? "在线" : offline ? "离线" : "待确认"}
                    </span>
                  </div>
                </div>
                {/* 状态正文 */}
                <div className="border-t border-[var(--line)] px-5 py-3.5 text-[13px] text-[var(--tx-1)]">
                  {status === null ? (
                    <span className="text-[var(--tx-2)]">正在检查登录状态…</span>
                  ) : !status.online ? (
                    <span className="text-[var(--tx-2)]">
                      {hostedPage()
                        ? "网页尚未连接这台电脑上的小红书助手"
                        : "小红书本地服务未启动 —— 请确认 xiaohongshu-mcp 常驻服务已运行"}
                    </span>
                  ) : loggedIn ? (
                    <span>
                      <span className="font-medium text-[var(--sage-deep)]">已登录</span>
                      {status.nickname ? ` · ${status.nickname}` : ""}
                    </span>
                  ) : status.checkFailed ? (
                    <span className="text-[var(--tx-2)]">
                      登录状态检查失败（浏览器异常等），可尝试重新扫码
                      {status.message ? `：${status.message}` : ""}
                    </span>
                  ) : showExpiredAlert ? (
                    <span className="text-[var(--bad)]">
                      登录已过期 —— 请重新扫码登录后，调研才能继续获取小红书笔记
                    </span>
                  ) : (
                    <span className="text-[var(--tx-2)]">
                      未登录 —— 扫码登录后，生成方案时会参考小红书冲煮笔记
                    </span>
                  )}
                </div>
                {/* 动作区：登出/刷新降为 ghost 文本按钮（任务 #126），保留原 onClick */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--line)] px-5 py-3">
                  {offline && hostedPage() && (
                    <button
                      type="button"
                      className={btnPrimary}
                      onClick={() => void connectCompanion()}
                      disabled={pairBusy}
                    >
                      {pairBusy && <Spinner />} 连接本地助手
                    </button>
                  )}
                  {status?.online !== false &&
                    !loggedIn &&
                    qrPhase !== "code" &&
                    qrPhase !== "loading" && (
                      <button
                        type="button"
                        className={btnPrimary}
                        onClick={() => void fetchQrcode()}
                        disabled={busy}
                      >
                        {showExpiredAlert ? "重新扫码登录" : "扫码登录"}
                      </button>
                    )}
                  {loggedIn && qrPhase !== "code" && qrPhase !== "loading" && (
                    <button
                      type="button"
                      className={`${btnText} transition-all hover:-translate-y-px`}
                      onClick={() => void logoutAndSwitch()}
                      disabled={busy}
                    >
                      {busy && <Spinner />} 登出并切换账号
                    </button>
                  )}
                  {qrPhase === "code" && (
                    <button
                      type="button"
                      className={`${btnText} transition-all hover:-translate-y-px`}
                      title="换码后当前二维码立即失效，请在无法扫码时才使用"
                      onClick={() => void fetchQrcode()}
                    >
                      换一张（旧码作废）
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${btnText} transition-all hover:-translate-y-px`}
                    onClick={() => void refreshStatus()}
                  >
                    刷新状态
                  </button>
                  {qrError && offline && hostedPage() && (
                    <span className="text-[11px] text-[var(--bad)]">{qrError}</span>
                  )}
                </div>
              </div>

              {/* ---- 二维码流程区（任务 #126：视觉整合进同一卡片体系）---- */}
              {qrPhase === "code" && (
                <div className="card-surface animate-fade-up flex flex-col items-center gap-3 rounded-[14px] border border-[var(--line)] bg-[var(--bg-card)] px-5 py-6">
                  <img
                    src={qrSrc}
                    alt="小红书登录二维码"
                    className="h-56 w-56 rounded-lg border border-[var(--line)] bg-white p-2"
                    onError={() => {
                      setQrFailureKind("image_invalid");
                      setQrError("二维码图片数据已返回，但浏览器没有成功显示。请重新取码。");
                      setQrPhase("error");
                    }}
                  />
                  <p className="text-xs text-[var(--tx-2)]">
                    打开小红书 App 扫一扫确认登录 ·{" "}
                    <span className="tnum font-medium text-[var(--tx-1)]">
                      {Math.floor(remainingSec / 60)}:{String(remainingSec % 60).padStart(2, "0")}
                    </span>{" "}
                    后失效
                  </p>
                  {/* 任务 #89：MCP 同一时刻只保留一个扫码会话，换码即作废旧码 —— 防用户扫码中途换码导致手机端 failed to login */}
                  <p className="text-[11px] text-[var(--warn)]">
                    二维码只能扫一次：扫码确认前请勿点「换一张」，否则本张码立即失效（手机端会报
                    failed to login）
                  </p>
                  {qrHint && <p className="text-[11px] text-[var(--tx-3)]">{qrHint}</p>}
                </div>
              )}

              {qrPhase === "loading" && (
                <div className="card-surface flex flex-col items-center gap-4 rounded-[14px] border border-[var(--line)] bg-[var(--bg-card)] px-5 py-6 text-center">
                  <div
                    className="relative grid h-48 w-48 grid-cols-5 gap-2 overflow-hidden rounded-xl border border-[var(--line)] bg-white p-5 shadow-inner"
                    aria-hidden
                  >
                    {Array.from({ length: 25 }, (_, index) => (
                      <span
                        key={index}
                        className={`rounded-[2px] ${index % 3 === 0 || index % 7 === 0 ? "bg-[#1a1714]" : "bg-[#ece8e1]"}`}
                      />
                    ))}
                    <span className="absolute inset-0 animate-shimmer bg-[linear-gradient(105deg,transparent_35%,rgba(255,255,255,0.72)_50%,transparent_65%)]" />
                  </div>
                  <div>
                    <p className="flex items-center justify-center gap-2 text-sm font-medium text-[var(--tx-1)]">
                      <Spinner /> 正在唤起小红书登录页
                    </p>
                    <p className="mt-1 text-[11px] leading-5 text-[var(--tx-3)]">
                      浏览器内核返回二维码后会自动显示，请稍候。
                    </p>
                  </div>
                </div>
              )}

              {qrPhase === "expired" && (
                <div className="card-surface space-y-3 rounded-[14px] border border-[var(--line)] bg-[var(--bg-card)] px-5 py-5 text-center">
                  <p className="text-sm text-[var(--tx-2)]">二维码已过期</p>
                  <button type="button" className={btnPrimary} onClick={() => void fetchQrcode()}>
                    换一张
                  </button>
                </div>
              )}

              {qrPhase === "confirmed" && (
                <div className="card-surface space-y-1 rounded-[14px] border border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-[var(--sage-soft)] px-5 py-5 text-center">
                  <p className="text-sm font-medium text-[var(--sage-deep)]">
                    ✓ 登录成功{confirmedName ? `：${confirmedName}` : ""}
                  </p>
                  <p className="text-[11px] text-[var(--tx-3)]">调研链路已恢复小红书笔记来源</p>
                </div>
              )}

              {qrPhase === "error" && (
                <div className="card-surface space-y-3 rounded-[14px] border border-[color-mix(in_srgb,var(--bad)_35%,transparent)] bg-[var(--bg-card)] px-5 py-5 text-center">
                  <div>
                    <p className="text-sm font-medium text-[var(--tx-1)]">{qrFailure.title}</p>
                    <p className="mt-1 text-[11px] leading-5 text-[var(--tx-3)]">
                      {qrFailure.detail}
                    </p>
                    {qrError && (
                      <p className="mt-2 text-[11px] leading-relaxed text-[var(--bad)]">
                        {qrError}
                      </p>
                    )}
                  </div>
                  <div className="flex justify-center gap-2">
                    <button
                      type="button"
                      className={btnGhost}
                      onClick={() => void refreshStatus()}
                      disabled={busy}
                    >
                      刷新状态
                    </button>
                    <button
                      type="button"
                      className={btnPrimary}
                      onClick={() => void fetchQrcode()}
                      disabled={busy}
                    >
                      重新取码
                    </button>
                  </div>
                </div>
              )}

              {qrPhase === "already" && (
                <div className="card-surface space-y-3 rounded-[14px] border border-[var(--line)] bg-[var(--bg-card)] px-5 py-5 text-center">
                  <p className="text-sm text-[var(--tx-2)]">
                    当前账号已登录，如需切换账号，请先登出
                  </p>
                  <div className="flex justify-center">
                    <button
                      type="button"
                      className={btnGhost}
                      onClick={() => void logoutAndSwitch()}
                      disabled={busy}
                    >
                      {busy && <Spinner />} 登出并扫码换号
                    </button>
                  </div>
                </div>
              )}

              {/* Cookie 导入兜底（任务 #97）：仅未登录时展示，视觉整合进同一卡片体系（任务 #126） */}
              {!loggedIn && qrPhase !== "confirmed" && (
                <details className="card-surface group rounded-[14px] border border-[var(--line)] bg-[var(--bg-card)] px-4 py-3">
                  <summary className="cursor-pointer select-none text-xs text-[var(--tx-2)] transition-colors hover:text-[var(--tx-1)]">
                    扫码一直失败？试试粘贴浏览器 Cookie 登录
                  </summary>
                  <div className="mt-3 space-y-2.5 border-t border-[var(--line)] pt-3">
                    <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-[var(--tx-2)]">
                      <li>在 PC 浏览器打开 xiaohongshu.com 并登录（浏览器扫码/验证码均可）；</li>
                      <li>
                        登录后按 F12 → Application → Cookies → 选中 xiaohongshu.com，或用 Console
                        执行 document.cookie；
                      </li>
                      <li>复制全部 Cookie 内容粘贴到下方（需包含 web_session）。</li>
                    </ol>
                    <textarea
                      value={cookieText}
                      onChange={(e) => setCookieText(e.target.value)}
                      placeholder="a1=xxx; web_session=xxx; webId=xxx …"
                      rows={3}
                      className="w-full resize-y rounded-md border border-[var(--line)] bg-[var(--bg-inset)] px-2.5 py-2 font-mono text-[11px] text-[var(--tx-1)] placeholder:text-[var(--tx-3)] focus:outline-none focus:ring-1 focus:ring-[var(--sage)]"
                    />
                    {importMsg && (
                      <p
                        className={`text-[11px] leading-relaxed ${importFailed ? "text-[var(--bad)]" : "text-[var(--sage-deep)]"}`}
                      >
                        {importMsg}
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className={btnPrimary}
                        disabled={importBusy || !cookieText.trim()}
                        onClick={() => void importCookies()}
                      >
                        {importBusy && <Spinner />} 导入并验证
                      </button>
                      <span className="text-[11px] text-[var(--tx-3)]">
                        Cookie 仅存入本机 MCP 服务，不会上传
                      </span>
                    </div>
                  </div>
                </details>
              )}

              {/* ---- 登录说明（折叠区，任务 #126）：已登录态默认折叠，collapser grid-rows 动效 ---- */}
              <div className="card-surface animate-fade-up overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--bg-card)]">
                <button
                  type="button"
                  onClick={() => setInfoOpen(!infoOpen)}
                  aria-expanded={infoOpen}
                  className="flex w-full items-center justify-between gap-2 px-5 py-3.5 text-left transition-colors duration-150 hover:bg-[var(--bg-card-hover)]"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="eyebrow shrink-0">登录说明</span>
                    <span className="truncate text-[11px] text-[var(--tx-3)]">
                      登录态由本地 xiaohongshu-mcp 服务保管 · 仅用于调研
                    </span>
                  </div>
                  <svg
                    className={`h-3.5 w-3.5 shrink-0 text-[var(--tx-3)] transition-transform duration-200 ${infoOpen ? "rotate-180" : ""}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden
                  >
                    <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <div className="collapser" data-open={infoOpen}>
                  <div className="collapser-inner">
                    <div className="space-y-3.5 border-t border-[var(--line)] px-5 py-4">
                      {/* 服务说明 */}
                      <div>
                        <p className="eyebrow mb-1">服务说明</p>
                        <p className="text-[11px] leading-relaxed text-[var(--tx-2)]">
                          登录态由本地 xiaohongshu-mcp 服务保管，仅用于调研检索，不会发布任何内容。
                          若在其他设备登录同一账号，可能会互踢下线，届时在此重新扫码即可。
                        </p>
                      </div>
                      {/* 二维码 */}
                      <div>
                        <p className="eyebrow mb-1">二维码</p>
                        <p className="text-[11px] leading-relaxed text-[var(--tx-2)]">
                          取码后请尽快扫码：二维码约 4 分钟过期，且同一时刻只有一张码有效。
                        </p>
                      </div>
                      {/* 故障排查 */}
                      <div>
                        <p className="eyebrow mb-1">故障排查</p>
                        <p className="text-[11px] leading-relaxed text-[var(--tx-2)]">
                          {/* 任务 #89：风控自助指引（手机端报 failed to login 时） */}
                          若手机端反复提示 failed to
                          login，多为小红书风控（取码过频/新账号新设备）：请等 30 分钟以上再试，
                          或改用手机 4G/5G
                          网络扫码；扫码时如弹出滑块/安全验证，务必先完成验证再确认登录。
                        </p>
                      </div>
                      {/* 兜底通道 */}
                      <div>
                        <p className="eyebrow mb-1">兜底通道</p>
                        <p className="text-[11px] leading-relaxed text-[var(--tx-2)]">
                          也可直接展开上方「粘贴浏览器 Cookie」兜底通道完成登录。
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}
