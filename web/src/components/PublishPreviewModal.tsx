/**
 * 发布预览弹窗：
 * - 发布前完整展示将上传的字段：名称、theColor 取色器（预设 + 自定义）、
 *   全局参数、旁路、每段（段名可编辑 / 水量 / 温度 / 流速 / 图案 / 停顿 / 振动）
 * - 确认后：存在云端来源 tableId → PUT 更新原配方；否则 POST /api/cloud/publish 新建
 * - 成功展示分享链接 + 二维码
 */
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { api, type CloudStatus } from "../lib/api.js";
import { shouldBindCloudRecord } from "../lib/cloud-publish-state.js";
import { CUP_TYPES, type Recipe } from "../lib/recipe-schema.js";
import { PATTERN_LABELS } from "../lib/curve-math.js";
import { btnGhost, btnPrimary, Field, inputCls, Modal, Spinner } from "./ui.js";

/** 配方卡颜色预设（官方鼠尾草绿为默认） */
const COLOR_PRESETS = [
  "#C9D5B8",
  "#E5B96B",
  "#7FB2A0",
  "#8FA3C8",
  "#C97F5D",
  "#B47A33",
  "#D4A0A0",
  "#A8C686",
];

export interface PublishPreviewModalProps {
  open: boolean;
  onClose: () => void;
  recipe: Recipe | null;
  cloud: CloudStatus | null;
  /** 登录成功后通知外层刷新云端状态 */
  onLoggedIn?: () => void;
  /** 云端来源 tableId（从云端导入的配方）：存在时发布走更新而非新建 */
  cloudTableId?: string;
  /** 发布/更新成功后回传 tableId，供外层后续发布改走更新链路 */
  onPublished?: (tableId: string) => void | Promise<void>;
}

export default function PublishPreviewModal({
  open,
  onClose,
  recipe,
  cloud,
  onLoggedIn,
  cloudTableId,
  onPublished,
}: PublishPreviewModalProps) {
  const [draft, setDraft] = useState<Recipe | null>(null);
  const [publishName, setPublishName] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [tableId, setTableId] = useState("");
  /** 本次成功操作类型：create=新建发布 / update=更新；
   *  不能直接看 cloudTableId（onPublished 后外层会立即回填，首次发布也会误显“更新成功”） */
  const [publishedMode, setPublishedMode] = useState<"create" | "update" | "">("");
  const [publishVerification, setPublishVerification] = useState<{
    state: "verified" | "mismatch" | "unverified";
    message: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  /** 发布预演：后端对齐官方 ratio 0.1 步进后实际上传的值（任务 #39） */
  const [preview, setPreview] = useState<{
    adjustments: string[];
    alignedGrandWater: number;
    cloudRatio: number;
    pours: { theName?: string; volume: number }[];
  } | null>(null);
  /** 发布/更新成功后后端回传的留痕（与预演一致） */
  const [publishAdjustments, setPublishAdjustments] = useState<string[]>([]);
  /** 预演失败降级提示（Kim 审查：不能被 catch 吞掉后误呈"无需对齐"） */
  const [previewError, setPreviewError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 每次打开 → 以当前配方初始化草稿
  useEffect(() => {
    if (open && recipe) {
      setDraft(JSON.parse(JSON.stringify(recipe)) as Recipe);
      setPublishName(recipe.name);
      setShareUrl("");
      setTableId("");
      setPublishedMode("");
      setPublishVerification(null);
      setError("");
      setPreview(null);
      setPreviewError("");
      setPublishAdjustments([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 已登录且打开中 → 向后端预演实际上传值（仅在影响对齐的字段变化时重拉）
  const previewSrc = draft ?? recipe;
  const alignKey = previewSrc
    ? JSON.stringify({
        dose: previewSrc.doseGrams,
        water: previewSrc.grandWater,
        vols: previewSrc.pours.map((p) => p.volume),
      })
    : "";
  useEffect(() => {
    if (!open || !previewSrc || !(cloud?.loggedIn ?? false)) {
      setPreview(null);
      setPreviewError("");
      return;
    }
    let cancelled = false;
    api
      .cloudPublishPreview(previewSrc)
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setPreview({
            adjustments: r.adjustments,
            alignedGrandWater: r.alignedGrandWater,
            cloudRatio: r.cloudRatio,
            pours: r.pours,
          });
          setPreviewError("");
        } else {
          // 任务#55 警告2：后端预演校验失败（HTTP 200 + ok:false）不能静默吞掉，
          // 否则弹窗会按原始未对齐值呈现；显式降级提示，实发时会重新校验
          setPreview(null);
          setPreviewError(r.message || "预演失败，发布时将重新校验");
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError((e as Error).message || "预演失败");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, alignKey, cloud?.loggedIn]);

  // 渲染二维码
  useEffect(() => {
    if (!shareUrl || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, shareUrl, {
      width: 180,
      margin: 1,
      color: { dark: "#111110", light: "#FFFFFF" },
    }).catch(() => {});
  }, [shareUrl]);

  if (!recipe) return null;
  const d = draft ?? recipe;
  const loggedIn = cloud?.loggedIn ?? false;

  const setPourName = (i: number, name: string) =>
    setDraft((prev) =>
      prev
        ? { ...prev, pours: prev.pours.map((p, j) => (j === i ? { ...p, theName: name } : p)) }
        : prev,
    );

  const login = async () => {
    if (!email.trim() || !password) return;
    setLoggingIn(true);
    setError("");
    try {
      await api.cloudLogin(email.trim(), password);
      onLoggedIn?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoggingIn(false);
    }
  };

  const publish = async () => {
    if (!draft) return;
    setPublishing(true);
    setError("");
    try {
      const name = publishName.trim() || undefined;
      if (cloudTableId) {
        // 云端来源配方 → 更新原记录，不新建重复配方
        const res = await api.cloudUpdateRecipe(cloudTableId, { recipe: draft, name });
        setPublishedMode("update");
        setShareUrl(res.shareUrl);
        setTableId(res.tableId);
        setPublishAdjustments(res.adjustments ?? []);
        setPublishVerification(res.verification);
        if (shouldBindCloudRecord(res.verification)) await onPublished?.(String(res.tableId));
      } else {
        const res = await api.cloudPublish(draft, name);
        setPublishedMode("create");
        setShareUrl(res.shareUrl);
        setTableId(res.tableId);
        setPublishAdjustments(res.adjustments ?? []);
        setPublishVerification(res.verification);
        if (shouldBindCloudRecord(res.verification)) await onPublished?.(String(res.tableId));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  const verifyAgain = async () => {
    if (!tableId) return;
    setPublishing(true);
    setError("");
    try {
      const res = await api.cloudVerifyRecipe(tableId);
      setPublishVerification(res.verification);
      if (shouldBindCloudRecord(res.verification)) await onPublished?.(tableId);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("复制失败，请手动选择链接复制");
    }
  };

  const ratio = (d.grandWater + (d.bypassEnabled ? d.bypassVolume : 0)) / d.doseGrams;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="发布预览"
      sub="确认上传到 xBloom 官方云端的全部字段"
      wide
    >
      {shareUrl ? (
        /* -------- 发布成功 -------- */
        <div className="animate-fade-up space-y-4 text-center">
          <p
            className={`text-xs ${publishVerification?.state === "verified" ? "text-[var(--ok)]" : "text-[var(--warn)]"}`}
          >
            {publishVerification?.state === "verified"
              ? "✓ 已写入并完成回读确认"
              : "云端已写入，等待回读确认"}
            {publishedMode ? ` · ${publishedMode === "update" ? "更新原记录" : "新建记录"}` : ""}
            {tableId ? ` · ${tableId}` : ""}
          </p>
          {publishVerification && (
            <p
              className={`mx-auto max-w-md rounded-lg border px-3 py-2 text-left text-[11px] ${
                publishVerification.state === "verified"
                  ? "border-[color-mix(in_srgb,var(--ok)_35%,transparent)] bg-[var(--sage-soft)] text-[var(--sage-deep)]"
                  : "border-[var(--line-strong)] bg-[var(--bg-inset)] text-[var(--tx-2)]"
              }`}
            >
              {publishVerification.state === "verified"
                ? "回读已确认 · "
                : publishVerification.state === "mismatch"
                  ? "回读发现差异，请先核对 · "
                  : "回读待确认 · "}
              {publishVerification.message}
            </p>
          )}
          {publishVerification?.state !== "verified" && (
            <button
              type="button"
              onClick={() => void verifyAgain()}
              disabled={publishing}
              className={`${btnPrimary} mx-auto`}
            >
              {publishing ? (
                <>
                  <Spinner /> 正在回读…
                </>
              ) : (
                "重新回读确认"
              )}
            </button>
          )}
          {publishAdjustments.length > 0 && (
            <div className="mx-auto max-w-md rounded-lg border border-[var(--line-strong)] bg-[var(--bg-inset)] px-3 py-2 text-left text-[11px] text-[var(--tx-2)]">
              <p className="mb-1 font-medium text-[var(--tx-1)]">
                已按官方约束自动对齐（实际上传值）：
              </p>
              <ul className="space-y-0.5">
                {publishAdjustments.map((a, i) => (
                  <li key={i}>· {a}</li>
                ))}
              </ul>
            </div>
          )}
          <a
            href={shareUrl}
            target="_blank"
            rel="noreferrer"
            className="block break-all text-base font-semibold leading-snug text-[var(--tx-1)] underline decoration-[var(--acc)] decoration-2 underline-offset-4 hover:text-[var(--acc)]"
          >
            {shareUrl}
          </a>
          <div className="flex justify-center">
            <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-card)] p-3 shadow-[var(--shadow-card)]">
              <canvas ref={canvasRef} width={180} height={180} />
            </div>
          </div>
          <p className="text-[11px] text-[var(--tx-3)]">
            用手机扫描二维码或打开链接，即可将配方导入 xBloom 官方 APP 冲煮
          </p>
          <div className="flex justify-center gap-2">
            <button type="button" onClick={() => void copy()} className={btnGhost}>
              {copied ? "✓ 已复制" : "复制链接"}
            </button>
            <button type="button" onClick={onClose} className={btnGhost}>
              完成
            </button>
          </div>
        </div>
      ) : !loggedIn ? (
        /* -------- 未登录 -------- */
        <div className="space-y-3">
          <p className="rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-3 py-2 text-xs text-[var(--tx-2)]">
            发布前需要登录 xBloom 官方云端账号。
          </p>
          <Field label="邮箱">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="输入注册 xBloom App 时使用的邮箱"
              className={inputCls}
            />
          </Field>
          <Field label="密码">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void login()}
              placeholder="输入账号密码"
              className={inputCls}
            />
          </Field>
          <button
            type="button"
            onClick={() => void login()}
            disabled={loggingIn || !email.trim() || !password}
            className={`${btnPrimary} w-full`}
          >
            {loggingIn ? (
              <>
                <Spinner /> 登录中…
              </>
            ) : (
              "登录 xBloom 官方云端"
            )}
          </button>
        </div>
      ) : (
        /* -------- 字段预览与编辑 -------- */
        <div className="space-y-4">
          {/* 预演失败降级提示：不误呈"无需对齐"（Kim 审查） */}
          {previewError && (
            <div className="rounded-xl border border-[var(--line-strong)] bg-[var(--bg-inset)] px-3 py-2 text-xs text-[var(--tx-2)]">
              ⚠ 预演失败，发布时将重新校验：{previewError}
            </div>
          )}

          {/* 对齐留痕横幅：如实展示即将上传的调整（任务 #39） */}
          {preview && preview.adjustments.length > 0 && (
            <div className="rounded-xl border border-[var(--acc)]/40 bg-[color-mix(in_srgb,var(--acc)_8%,transparent)] px-3 py-2 text-xs">
              <p className="font-medium text-[var(--tx-1)]">
                官方云端要求 总水量 = 粉量 × 粉水比（粉水比仅支持 0.1 步进），已自动就近对齐：
              </p>
              <ul className="mt-1 space-y-0.5 text-[var(--tx-2)]">
                {preview.adjustments.map((a, i) => (
                  <li key={i}>· {a}</li>
                ))}
              </ul>
              <p className="tnum mt-1 text-[var(--tx-2)]">
                实际上传：总水 {preview.alignedGrandWater}ml · 粉水比 1:{preview.cloudRatio} · 分段{" "}
                {preview.pours.map((p) => `${p.volume}ml`).join(" + ")}
              </p>
            </div>
          )}

          {/* 卡片预览 */}
          <div
            className="flex items-center justify-between rounded-xl border px-4 py-3"
            style={{ backgroundColor: `${d.theColor}22`, borderColor: `${d.theColor}66` }}
          >
            <div>
              <p className="font-display text-base font-semibold text-[var(--tx-1)]">
                {publishName || d.name || "未命名配方"}
              </p>
              <p className="tnum mt-0.5 text-[11px] text-[var(--tx-2)]">
                {d.doseGrams}g · {d.grandWater}ml · 1:{ratio.toFixed(1)} · {d.pours.length} 段
              </p>
            </div>
            <span
              className="h-8 w-8 rounded-lg border border-[var(--line-strong)]"
              style={{ backgroundColor: d.theColor }}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="发布名称">
              <input
                value={publishName}
                onChange={(e) => setPublishName(e.target.value)}
                placeholder={d.name}
                className={inputCls}
              />
            </Field>
            <Field label="配方卡颜色 theColor">
              <div className="flex items-center gap-1.5">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`颜色 ${c}`}
                    onClick={() => setDraft((p) => (p ? { ...p, theColor: c } : p))}
                    className={`h-6 w-6 rounded-md border transition-transform hover:scale-110 ${
                      d.theColor.toUpperCase() === c.toUpperCase()
                        ? "border-[var(--acc)] ring-2 ring-[var(--acc-soft)]"
                        : "border-[var(--line-strong)]"
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <input
                  type="color"
                  className="xcolor"
                  value={d.theColor}
                  onChange={(e) => setDraft((p) => (p ? { ...p, theColor: e.target.value } : p))}
                  aria-label="自定义颜色"
                />
              </div>
            </Field>
          </div>

          {/* 全局字段 */}
          <div className="tnum grid grid-cols-2 gap-2 rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] p-3 text-[11px] sm:grid-cols-4">
            {[
              ["cupType", d.cupType],
              ["粉量", `${d.doseGrams}g`],
              ["研磨度", `${d.grinderSize}`],
              ["转速", `${d.rpm}rpm`],
              ["总水量", `${d.grandWater}ml`],
              ["磨豆模式", d.isSetGrinderSize === 2 ? "预磨粉" : "本机磨豆"],
              ["旁路水", d.bypassEnabled ? `${d.bypassVolume}ml · ${d.bypassTemp}℃` : "关闭"],
              ["粉水比", `1:${ratio.toFixed(1)}`],
            ].map(([k, v]) => (
              <div key={k}>
                <p className="text-[var(--tx-3)]">{k}</p>
                <p className="mt-0.5 font-medium text-[var(--tx-1)]">{v}</p>
              </div>
            ))}
          </div>

          {/* 分段预览（段名可编辑） */}
          <div className="overflow-hidden rounded-xl border border-[var(--line)]">
            <table className="tnum w-full text-[11px]">
              <thead>
                <tr className="bg-[var(--bg-inset)] text-left text-[var(--tx-3)]">
                  <th className="px-3 py-2 font-medium">段名</th>
                  <th className="px-2 py-2 font-medium">水量</th>
                  <th className="px-2 py-2 font-medium">温度</th>
                  <th className="px-2 py-2 font-medium">流速</th>
                  <th className="px-2 py-2 font-medium">图案</th>
                  <th className="px-2 py-2 font-medium">停顿</th>
                  <th className="px-2 py-2 font-medium">振动</th>
                </tr>
              </thead>
              <tbody>
                {d.pours.map((p, i) => (
                  <tr key={i} className="border-t border-[var(--line)] text-[var(--tx-2)]">
                    <td className="px-3 py-1.5">
                      <input
                        value={p.theName ?? ""}
                        onChange={(e) => setPourName(i, e.target.value)}
                        placeholder={`Pour ${i + 1}`}
                        className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] text-[var(--tx-1)] outline-none focus:border-[var(--acc-line)]"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      {p.volume}ml
                      {preview &&
                        preview.adjustments.length > 0 &&
                        preview.pours[i] &&
                        preview.pours[i].volume !== p.volume && (
                          <span className="ml-1 text-[var(--tx-3)]">
                            → {preview.pours[i].volume}
                          </span>
                        )}
                    </td>
                    <td className="px-2 py-1.5">{p.temperature}℃</td>
                    <td className="px-2 py-1.5">{p.flowRate}</td>
                    <td className="px-2 py-1.5">{PATTERN_LABELS[p.pattern]}</td>
                    <td className="px-2 py-1.5">{p.pausing}s</td>
                    <td className="px-2 py-1.5">
                      {[p.vibBefore ? "前" : "", p.vibAfter ? "后" : ""]
                        .filter(Boolean)
                        .join("+") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[var(--tx-3)]">
            cupType 取值：{CUP_TYPES.join(" / ")} · 纯手冲场景
          </p>

          {error && (
            <p className="rounded-lg border border-[var(--bad)]/50 bg-[color-mix(in_srgb,var(--bad)_10%,transparent)] px-3 py-2 text-xs text-[var(--bad)]">
              ⚠ {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={btnGhost}>
              取消
            </button>
            <button
              type="button"
              onClick={() => void publish()}
              disabled={publishing}
              className={btnPrimary}
            >
              {publishing ? (
                <>
                  <Spinner /> {cloudTableId ? "更新中…" : "发布中…"}
                </>
              ) : cloudTableId ? (
                `更新云端配方 ${cloudTableId}`
              ) : (
                "确认发布到云端"
              )}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
