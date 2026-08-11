import { useState } from "react";
import { api, type AuthSession } from "../lib/api.js";
import { btnGhost, btnPrimary, Field, inputCls, Modal, Spinner } from "./ui.js";

export interface AccountModalProps {
  open: boolean;
  session: AuthSession | null;
  onClose: () => void;
  onChanged: (session: AuthSession) => void | Promise<void>;
}

export default function AccountModal({ open, session, onClose, onChanged }: AccountModalProps) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const next =
        mode === "register"
          ? await api.register(loginName.trim(), password)
          : await api.login(loginName.trim(), password);
      setPassword("");
      await onChanged(next);
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await api.logout();
      await onChanged(next);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={session?.authenticated ? "个人账号" : "保存你的工作台"}
      sub="配方、豆库和接口配置按账号分开保存"
    >
      {session?.authenticated && session.user ? (
        <div className="space-y-5">
          <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg-inset)] p-5">
            <p className="text-[11px] tracking-[0.12em] text-[var(--tx-3)]">当前账号</p>
            <p className="mt-2 font-display text-lg font-semibold text-[var(--tx-1)]">
              {session.user.displayName}
            </p>
            <p className="mt-1 text-xs text-[var(--tx-3)]">
              这台浏览器会保持登录；密钥正文不会返回页面。
            </p>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void logout()}
              disabled={busy}
              className={btnGhost}
            >
              {busy ? <Spinner /> : null} 退出登录
            </button>
          </div>
          {error && <p className="text-xs text-[var(--bad)]">{error}</p>}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] p-1">
            {(
              [
                ["register", "注册"],
                ["login", "登录"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setError("");
                }}
                className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                  mode === value
                    ? "bg-[var(--bg-card)] text-[var(--tx-1)] shadow-sm"
                    : "text-[var(--tx-3)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <Field label="账号名" hint="中英文、数字或常用符号">
            <input
              value={loginName}
              onChange={(event) => setLoginName(event.target.value)}
              autoComplete="username"
              className={inputCls}
              placeholder="给工作台起一个账号名"
            />
          </Field>
          <Field label="密码" hint="至少 10 个字符">
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !busy) void submit();
              }}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              className={inputCls}
              placeholder={mode === "register" ? "设置密码" : "输入密码"}
            />
          </Field>
          <p className="text-[11px] leading-5 text-[var(--tx-3)]">
            密码先在这台设备完成加密计算，再提交登录凭据；模型 Key
            以密文保存。每个账号的配置、豆库和配方彼此分开。
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !loginName.trim() || password.length < 10}
              className={`${btnPrimary} h-10`}
            >
              {busy ? <Spinner /> : null} {mode === "register" ? "注册并继续" : "登录"}
            </button>
          </div>
          {error && (
            <p className="rounded-lg border border-[color-mix(in_srgb,var(--bad)_35%,transparent)] bg-[color-mix(in_srgb,var(--bad)_8%,transparent)] px-3 py-2 text-xs text-[var(--bad)]">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
