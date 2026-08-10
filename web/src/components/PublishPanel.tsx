/**
 * 云端发布面板（入口）：
 * - 云端可达性 / 登录状态展示；未登录时提供邮箱密码登录
 * - 已登录时打开"发布预览弹窗"，确认全部字段后发布
 */
import { useState } from "react";
import { api, type CloudStatus } from "../lib/api.js";
import type { Recipe } from "../lib/recipe-schema.js";
import { btnPrimary, Card, CardHeader, Field, inputCls, Spinner, StatusDot } from "./ui.js";

export interface PublishPanelProps {
  recipe: Recipe | null;
  cloud: CloudStatus | null;
  /** 云端状态变化（登录/登出）后通知外层刷新 */
  onCloudChanged: () => void;
  /** 打开发布预览弹窗 */
  onOpenPreview: () => void;
  /** 当前配方绑定的云端 tableId（任务 #118）：会话态随切换历史/新生成清空（任务 #115），
      存在即表示当前配方已发布/来源于云端，后续发布走更新链路 */
  cloudTableId?: string;
}

export default function PublishPanel({
  recipe,
  cloud,
  onCloudChanged,
  onOpenPreview,
  cloudTableId,
}: PublishPanelProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState("");

  const login = async () => {
    if (!email.trim() || !password) return;
    setLoggingIn(true);
    setError("");
    try {
      await api.cloudLogin(email.trim(), password);
      setEmail("");
      setPassword("");
      onCloudChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoggingIn(false);
    }
  };

  const logout = async () => {
    setError("");
    try {
      await api.cloudLogout();
      onCloudChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const loggedIn = cloud?.loggedIn ?? false;
  const reachable = cloud?.reachable ?? false;

  return (
    <Card>
      <CardHeader
        icon={<IconCloud />}
        title="同步到手机"
        sub="上传到 xBloom 官方云端，手机 App 中直接使用"
        right={
          <span className="flex items-center gap-1.5 text-[11px] text-[var(--tx-3)]">
            <StatusDot
              tone={!cloud ? "off" : loggedIn ? "ok" : reachable ? "warn" : "bad"}
              pulse={loggedIn}
            />
            {!cloud ? "离线" : loggedIn ? "已登录" : reachable ? "未登录" : "不可达"}
          </span>
        }
      />
      <div className="space-y-4 p-5">
        {cloud && !cloud.reachable && (
          <p className="flex h-11 items-center rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-3.5 text-xs text-[var(--tx-2)]">
            <span className="truncate">{cloud.message || "xBloom 官方云端暂时不可用"}</span>
          </p>
        )}

        {!loggedIn ? (
          <div className="space-y-3">
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
                "登录 xBloom 官方云端"
              )}
            </button>
            {cloud?.proxyUsed && (
              <p className="text-[11px] text-[var(--tx-3)]">当前通过代理访问云端服务</p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {/* 已发布徽标（任务 #118）：绑定当前配方（recipe && cloudTableId），
                切换历史/新生成时 cloudTableId 清空（任务 #115），不残留到其他配方 */}
            {recipe && cloudTableId && (
              <p className="animate-fade-up flex items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-[var(--sage-soft)] px-3.5 py-2.5 text-xs font-medium text-[var(--sage-deep)]">
                <span aria-hidden>✓</span>
                <span className="min-w-0 flex-1 truncate">已上传 · 再次上传将更新原记录</span>
                <span className="tnum shrink-0 text-[10px] font-normal opacity-70">
                  {cloudTableId}
                </span>
              </p>
            )}
            <button
              type="button"
              onClick={onOpenPreview}
              disabled={!recipe}
              className={`${btnPrimary} w-full`}
            >
              {recipe ? "预览并上传到手机 App…" : "暂无可上传配方"}
            </button>
            <p className="text-center text-[11px] leading-relaxed text-[var(--tx-3)]">
              上传前可核对段名、配方卡颜色、旁路水与振动设置
            </p>
            <button
              type="button"
              onClick={() => void logout()}
              className="w-full rounded-lg border border-[var(--line-strong)] px-3 py-1.5 text-xs text-[var(--tx-2)] transition-colors hover:border-[var(--bad)]/60 hover:text-[var(--bad)]"
            >
              退出登录
            </button>
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-[var(--bad)]/50 bg-[color-mix(in_srgb,var(--bad)_10%,transparent)] px-3 py-2 text-xs text-[var(--bad)]">
            ⚠ {error}
          </p>
        )}
      </div>
    </Card>
  );
}

function IconCloud() {
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
      <path
        d="M7 18a4.5 4.5 0 0 1-.5-8.97A6 6 0 0 1 18 8.5a4 4 0 0 1-1 9.5H7z"
        strokeLinejoin="round"
      />
    </svg>
  );
}
