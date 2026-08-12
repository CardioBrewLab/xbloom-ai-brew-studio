/**
 * 云端配方管理页（分栏重做版）：
 * - 未登录 → 分栏登录卡：左栏暖灰品牌区（黑白 logo + Fraunces 引言），
 *   右栏白底 max-w 400 居中（标题 + 说明 + 邮箱密码 + 黑色全宽登录按钮 + 帮助小字）
 * - 已登录 → GET /api/cloud/recipes 列出云端账号配方，支持删除与导入本地编辑
 * - 品牌澄清：明确标注所连接的是 xBloom 官方云服务域名
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CloudRecipeEntry, type CloudRegion, type CloudStatus } from "../lib/api.js";
import type { Recipe } from "../lib/recipe-schema.js";
import { cloudDetailReference } from "../lib/cloud-share.js";
import {
  btnGhost,
  btnPrimary,
  btnText,
  Card,
  CardHeader,
  Field,
  inputCls,
  Spinner,
  StatusDot,
} from "../components/ui.js";

export interface CloudPageProps {
  cloud: CloudStatus | null;
  cloudRegion: CloudRegion;
  onCloudRegionChange: (region: CloudRegion) => void;
  onCloudChanged: () => void;
  /** 导入到本地编辑（切换回工作台）；cloudTableId 记录来源供后续云端更新 */
  onImport: (recipe: Recipe, cloudTableId?: string) => void;
}

/** 列表摘要里的云端 grandWater 语义是粉水比 ratio，总水 ≈ dose × ratio */
function summaryWater(entry: CloudRecipeEntry): number | null {
  const dose = Number(entry.dose);
  const ratio = Number(entry.grandWater);
  if (!Number.isFinite(dose) || !Number.isFinite(ratio) || dose <= 0 || ratio <= 0) return null;
  return Math.round(dose * ratio * 10) / 10;
}

/** 按云端区域返回官方 API / 分享页域名（与后端 /api/config 的 cloudRegion 联动） */
function cloudDomains(region: "cn" | "global"): { apiHost: string; shareHost: string } {
  return region === "cn"
    ? { apiHost: "clientcn-api.xbloomcoffee.cn", shareHost: "share-h5.xbloomcoffee.cn" }
    : { apiHost: "client-api.xbloom.com", shareHost: "share-h5.xbloom.com" };
}

export default function CloudPage({
  cloud,
  cloudRegion,
  onCloudRegionChange,
  onCloudChanged,
  onImport,
}: CloudPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [entries, setEntries] = useState<CloudRecipeEntry[] | null>(null);
  const [listError, setListError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const listRequestRef = useRef(0);
  const loggedIn = cloud?.loggedIn ?? false;
  const cloudAccountIdentity = cloud?.memberId ?? cloud?.email ?? "";

  const { apiHost, shareHost } = cloudDomains(cloudRegion);

  const refresh = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    setEntries(null);
    setListError("");
    try {
      const res = await api.cloudRecipes(cloudRegion);
      if (requestId !== listRequestRef.current) return;
      setEntries(res.recipes ?? []);
    } catch (e) {
      if (requestId !== listRequestRef.current) return;
      setEntries(null);
      setListError((e as Error).message);
    }
  }, [cloudRegion]);

  useEffect(() => {
    if (loggedIn) {
      void refresh();
    } else {
      listRequestRef.current += 1;
      setEntries(null);
      setListError("");
    }
  }, [cloudAccountIdentity, loggedIn, refresh]);

  const login = async () => {
    if (!email.trim() || !password) return;
    setLoggingIn(true);
    setMessage("");
    try {
      await api.cloudLogin(email.trim(), password, cloudRegion);
      setEmail("");
      setPassword("");
      onCloudChanged();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setLoggingIn(false);
    }
  };

  const remove = async (tableId: string) => {
    setBusyId(tableId);
    setMessage("");
    try {
      await api.cloudDeleteRecipe(tableId, cloudRegion);
      setEntries((list) => (list ? list.filter((e) => e.tableId !== tableId) : list));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusyId("");
    }
  };

  /** 导入编辑：列表只有摘要字段，需用官方分享引用拉取完整配方。 */
  const importEntry = async (entry: CloudRecipeEntry) => {
    setBusyId(String(entry.tableId));
    setMessage("");
    try {
      const detailRef = cloudDetailReference(entry, cloudRegion);
      const res = await api.cloudDetail(detailRef, cloudRegion);
      onImport(res.recipe, String(entry.tableId));
    } catch (e) {
      setMessage(`导入失败：${(e as Error).message}`);
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="mx-auto max-w-[1440px] space-y-6 px-6 py-8">
      {/* 页面级标题（Fraunces） */}
      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold leading-8 tracking-[-0.025em] text-[var(--tx-1)]">
          云端配方
        </h2>
        <p className="max-w-2xl text-sm leading-[22px] text-[var(--tx-2)]">
          管理 xBloom 官方云端账号下的配方，导入本地微调，或将工作台作品发布回云端。
        </p>
        {/* 品牌澄清 */}
        <p className="flex items-start gap-2 rounded-xl border border-[var(--line)] bg-[var(--bg-card)] px-4 py-3 text-xs leading-relaxed text-[var(--tx-3)]">
          <IconShield />
          <span>
            连接 <span className="font-medium text-[var(--tx-2)]">xBloom 官方云服务</span>（
            {apiHost}）· 分享链接为官方 {shareHost} 页面，手机打开即导入官方
            APP。本工具不是第三方站点。
          </span>
        </p>
      </div>

      {!loggedIn ? (
        /* ============================ 分栏登录卡 ============================ */
        <Card className="overflow-hidden">
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            {/* 左栏：品牌区（暖灰底） */}
            <div className="relative hidden flex-col justify-between bg-[var(--bg-brand)] p-10 md:flex">
              <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#111110]">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#FFFFFF"
                  strokeWidth="1.6"
                  aria-hidden
                >
                  <path
                    d="M5 11h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-5zM16 12h1.5a2.5 2.5 0 0 1 0 5H16"
                    strokeLinecap="round"
                  />
                  <path
                    d="M9 7c0-1.2 1-1.5 1-2.5M12.5 7c0-1.2 1-1.5 1-2.5"
                    strokeLinecap="round"
                    opacity="0.6"
                  />
                </svg>
              </div>
              <div>
                <p className="font-display text-2xl font-medium leading-9 tracking-[-0.01em] text-[var(--tx-1)]">
                  Brew Brilliance
                  <br />
                  with Every Cup
                </p>
                <p className="mt-3 text-xs leading-relaxed text-[var(--tx-2)]">
                  登录 xBloom 官方云端，配方随账号同步，手机扫码即可导入官方 APP 冲煮。
                </p>
              </div>
              <p className="text-[11px] tracking-[0.06em] text-[var(--tx-3)]">
                XBLOOM OFFICIAL CLOUD
              </p>
            </div>

            {/* 右栏：登录表单（max-w 400 居中） */}
            <div className="flex items-center justify-center p-8 md:p-12">
              <div className="w-full max-w-[400px]">
                {/* 离线 / 不可达：单行浅色 banner */}
                {cloud !== null && !cloud.reachable && (
                  <div className="mb-5 flex h-11 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-3.5 text-xs text-[var(--tx-2)]">
                    <StatusDot tone="bad" />
                    <span className="truncate">
                      {cloud.message || "xBloom 官方云端暂时不可达，登录可能失败"}
                    </span>
                  </div>
                )}

                <h3 className="text-2xl font-semibold tracking-[-0.01em] text-[var(--tx-1)]">
                  登录 xBloom 官方云端
                </h3>
                <p className="mt-2 text-sm leading-[22px] text-[var(--tx-2)]">
                  使用 xBloom App 同款账号登录。
                  <br />
                  登录后可查看、删除并导入账号下的全部云端配方。
                </p>
                {cloud?.autoLogin && (
                  <p className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--tx-2)]">
                    {cloud.passwordStored === false
                      ? "已保存加密会话令牌，刷新页面后仍可使用；令牌失效时在这里重新登录。"
                      : "本机已配置自动登录账号：服务启动或请求云端时会自动登录。"}
                  </p>
                )}

                <div className="mt-6 space-y-4">
                  <Field label="账号区域" hint="与手机 xBloom App 的账号区域保持一致">
                    <div className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] p-1">
                      {(
                        [
                          ["cn", "中国区"],
                          ["global", "全球区"],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => onCloudRegionChange(value)}
                          className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                            cloudRegion === value
                              ? "bg-[var(--bg-card)] text-[var(--tx-1)] shadow-sm"
                              : "text-[var(--tx-3)]"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label="xBloom 账号邮箱">
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
                      "登录"
                    )}
                  </button>
                  {message && (
                    <p className="rounded-lg border border-[color-mix(in_srgb,var(--bad)_40%,transparent)] bg-[color-mix(in_srgb,var(--bad)_8%,transparent)] px-3.5 py-2.5 text-xs text-[var(--bad)]">
                      {message}
                    </p>
                  )}
                </div>

                <div className="mt-6 space-y-1.5 border-t border-[var(--line)] pt-4 text-xs leading-relaxed text-[var(--tx-3)]">
                  <p>忘记密码？请在 xBloom 官方 App 或官网找回。</p>
                  <p>
                    {cloud?.passwordStored === false
                      ? "密码仅用于本次登录并在请求结束后丢弃；站点只保存加密会话令牌。"
                      : "账号凭证仅用于直连 xBloom 官方接口。"}
                  </p>
                  {cloud?.proxyUsed && <p>当前通过代理访问云端服务。</p>}
                </div>
              </div>
            </div>
          </div>
        </Card>
      ) : (
        /* ============================ 已登录：配方列表 ============================ */
        <Card>
          <CardHeader
            title="xBloom 官方云端 · 我的配方"
            sub={
              entries
                ? `${entries.length} 条云端配方${cloud?.email ? ` · ${cloud.email}` : ""}`
                : "加载中…"
            }
            right={
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5 text-xs text-[var(--tx-3)]">
                  <StatusDot tone="ok" pulse />
                  已登录
                </span>
                <button type="button" onClick={() => void refresh()} className={btnGhost}>
                  刷新列表
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void api
                      .cloudLogout(cloudRegion)
                      .then(onCloudChanged)
                      .catch(() => onCloudChanged());
                  }}
                  className={btnText}
                >
                  退出登录
                </button>
              </div>
            }
          />
          <div className="space-y-4 p-5">
            {cloud?.autoLogin && (
              <p className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-xs text-[var(--tx-2)]">
                <IconShield />
                {cloud.passwordStored === false
                  ? `已使用加密会话连接${cloud.email ? ` ${cloud.email}` : ""}；会话失效后重新登录。`
                  : `已使用本机配置的账号${cloud.email ? ` ${cloud.email} ` : " "}自动登录。`}
              </p>
            )}
            {listError && (
              <p className="rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-4 py-3 text-center text-xs text-[var(--tx-3)]">
                {listError}
              </p>
            )}

            {entries !== null && entries.length === 0 && !listError && (
              <div className="flex flex-col items-center gap-3 p-12 text-center">
                <IconCloudBig />
                <p className="text-sm font-medium text-[var(--tx-1)]">云端账号下还没有配方</p>
                <p className="text-xs leading-relaxed text-[var(--tx-2)]">
                  回到工作台生成一条配方，通过「云端发布」上传后即可在此管理
                </p>
              </div>
            )}

            <ul className="space-y-2">
              {(entries ?? []).map((entry) => {
                const color = typeof entry.theColor === "string" ? entry.theColor : undefined;
                const water = summaryWater(entry);
                const busy = busyId === String(entry.tableId);
                return (
                  <li
                    key={String(entry.tableId)}
                    className="animate-fade-up flex items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--bg-card)] px-4 py-3.5 transition-[border-color] duration-150 hover:border-[var(--line-strong)]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {color && (
                        <span
                          className="h-8 w-8 shrink-0 rounded-lg border border-[var(--line-strong)]"
                          style={{ backgroundColor: color }}
                        />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-[var(--tx-1)]">
                          {entry.theName || "未命名配方"}
                        </p>
                        <p className="tnum mt-0.5 truncate text-[11px] text-[var(--tx-3)]">
                          {String(entry.tableId)}
                          {water !== null && Number(entry.dose) > 0
                            ? ` · ${entry.dose}g / ≈${water}ml · 比例 1:${entry.grandWater}`
                            : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {busy && <Spinner />}
                      <button
                        type="button"
                        onClick={() => void importEntry(entry)}
                        disabled={busy}
                        className={btnGhost}
                        title="拉取云端全量配方并载入到工作台编辑"
                      >
                        导入编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(String(entry.tableId))}
                        disabled={busy}
                        className="inline-flex h-9 items-center justify-center rounded-lg border border-[var(--line)] px-3.5 text-xs text-[var(--tx-3)] transition-colors duration-150 hover:border-[color-mix(in_srgb,var(--bad)_40%,transparent)] hover:text-[var(--bad)] disabled:opacity-40"
                      >
                        删除
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>

            {message && (
              <p className="rounded-lg border border-[color-mix(in_srgb,var(--bad)_40%,transparent)] bg-[color-mix(in_srgb,var(--bad)_8%,transparent)] px-3.5 py-2.5 text-xs text-[var(--bad)]">
                {message}
              </p>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function IconShield() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
      className="mt-0.5 shrink-0"
    >
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" strokeLinejoin="round" />
      <path d="M9.5 12l2 2 3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCloudBig() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--tx-3)"
      strokeWidth="1.5"
      aria-hidden
    >
      <path
        d="M7 18a4.5 4.5 0 0 1-.5-8.97A6 6 0 0 1 18 8.5a4 4 0 0 1-1 9.5H7z"
        strokeLinejoin="round"
      />
    </svg>
  );
}
