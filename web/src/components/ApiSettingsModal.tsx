/** 模型接口设置弹窗：Key 仅提交给本机后端，读取时只显示是否已配置。 */
import { useEffect, useState } from "react";
import { api, type LlmSettingsPublic } from "../lib/api.js";
import { buildLlmSettingsUpdate, type LlmSettingsDraft } from "../lib/llm-settings.js";
import { btnGhost, btnPrimary, Field, inputCls, Modal, Spinner } from "./ui.js";

const EMPTY_DRAFT: LlmSettingsDraft = {
  baseUrl: "",
  model: "",
  fallbackModel: "",
  thirdModel: "",
  apiKey: "",
  fallbackApiKey: "",
};

export interface ApiSettingsModalProps {
  open: boolean;
  onClose: () => void;
  onApplied?: () => void | Promise<void>;
}

export default function ApiSettingsModal({ open, onClose, onApplied }: ApiSettingsModalProps) {
  const [settings, setSettings] = useState<LlmSettingsPublic | null>(null);
  const [draft, setDraft] = useState<LlmSettingsDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState("");

  const hydrate = (next: LlmSettingsPublic) => {
    setSettings(next);
    setDraft({
      baseUrl: next.baseUrl,
      model: next.model,
      fallbackModel: next.fallbackModel,
      thirdModel: next.thirdModel,
      apiKey: "",
      fallbackApiKey: "",
    });
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setSaved(false);
    setTestResult("");
    api
      .getLlmSettings()
      .then((next) => {
        if (!cancelled) hydrate(next);
      })
      .catch((reason) => {
        if (!cancelled) setError((reason as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const updateDraft = (key: keyof LlmSettingsDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
    setTestResult("");
  };

  const save = async () => {
    setError("");
    setSaved(false);
    let payload;
    try {
      const currentOrigin = settings ? new URL(settings.baseUrl).origin : "";
      const nextOrigin = new URL(draft.baseUrl.trim()).origin;
      const reusesSavedKey = Boolean(settings?.apiKeyConfigured) && !draft.apiKey.trim();
      const endpointChanged = Boolean(currentOrigin && currentOrigin !== nextOrigin);
      let confirmed = false;
      if (endpointChanged && reusesSavedKey) {
        confirmed = window.confirm(
          "模型地址的域名或端口已变化。保存后，现有 API Key 与豆子/提示内容会发送到新地址。确认这是你信任的接口吗？",
        );
        if (!confirmed) return;
      }
      payload = buildLlmSettingsUpdate(draft, confirmed);
    } catch (reason) {
      setError((reason as Error).message);
      return;
    }
    setSaving(true);
    try {
      const next = await api.updateLlmSettings(payload);
      hydrate(next);
      await onApplied?.();
      const checked = await api.testLlmSettings();
      setTestResult(`${checked.model} · ${checked.latencyMs}ms`);
      setSaved(true);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    const confirmed = window.confirm("恢复后将重新使用 .env 中的模型设置。继续吗？");
    if (!confirmed) return;
    setSaving(true);
    setError("");
    setSaved(false);
    setTestResult("");
    try {
      const next = await api.resetLlmSettings();
      hydrate(next);
      await onApplied?.();
      setSaved(true);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="模型接口设置"
      sub="更换生成配方所用的模型地址与密钥"
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--tx-3)]">
          <Spinner /> 正在读取本机设置…
        </div>
      ) : (
        <div className="space-y-5">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] px-4 py-3 text-xs leading-relaxed text-[var(--tx-2)]">
            这里仅调整 AI 模型连接。工作台地址、xBloom 官方云端、小红书账号和手机 App
            上传流程保持原样。 外部地址使用 HTTPS；本机模型服务可使用 localhost / 127.0.0.1 的 HTTP
            地址。
          </div>

          {settings?.localOverridePresent && !settings.localOverrideValid && (
            <div className="rounded-xl border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-4 py-3 text-xs leading-relaxed text-[var(--warn)]">
              本机覆盖文件需要修复。重新填写并保存，或恢复为 .env 设置即可。
            </div>
          )}

          <Field label="模型 API 地址" hint="OpenAI 兼容接口">
            <input
              value={draft.baseUrl}
              onChange={(event) => updateDraft("baseUrl", event.target.value)}
              placeholder="https://example.com/v1"
              spellCheck={false}
              className={`${inputCls} font-mono text-xs`}
            />
          </Field>

          <Field label="主模型">
            <input
              value={draft.model}
              onChange={(event) => updateDraft("model", event.target.value)}
              placeholder="模型名称"
              spellCheck={false}
              className={`${inputCls} font-mono text-xs`}
            />
          </Field>

          <Field
            label="主 API Key"
            hint={settings?.apiKeyConfigured ? "已配置 · 留空保留" : "尚未配置"}
          >
            <input
              type="password"
              value={draft.apiKey}
              onChange={(event) => updateDraft("apiKey", event.target.value)}
              placeholder={settings?.apiKeyConfigured ? "留空保留当前 Key" : "输入 API Key"}
              autoComplete="off"
              spellCheck={false}
              className={`${inputCls} font-mono text-xs`}
            />
          </Field>

          <details className="rounded-xl border border-[var(--line)] bg-[var(--bg-inset)]">
            <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-[var(--tx-2)]">
              备用模型链
            </summary>
            <div className="space-y-4 border-t border-[var(--line)] bg-[var(--bg-card)] p-4">
              <Field label="第二模型" hint="留空关闭">
                <input
                  value={draft.fallbackModel}
                  onChange={(event) => updateDraft("fallbackModel", event.target.value)}
                  placeholder="备用模型名称"
                  spellCheck={false}
                  className={`${inputCls} font-mono text-xs`}
                />
              </Field>
              <Field label="第三模型" hint="留空关闭">
                <input
                  value={draft.thirdModel}
                  onChange={(event) => updateDraft("thirdModel", event.target.value)}
                  placeholder="第三模型名称"
                  spellCheck={false}
                  className={`${inputCls} font-mono text-xs`}
                />
              </Field>
              <Field
                label="备用 API Key"
                hint={settings?.fallbackApiKeyConfigured ? "已配置 · 留空保留" : "可选"}
              >
                <input
                  type="password"
                  value={draft.fallbackApiKey}
                  onChange={(event) => updateDraft("fallbackApiKey", event.target.value)}
                  placeholder={
                    settings?.fallbackApiKeyConfigured
                      ? "留空保留当前备用 Key"
                      : "备用渠道使用时填写"
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className={`${inputCls} font-mono text-xs`}
                />
              </Field>
            </div>
          </details>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
            <div className="text-[11px] leading-4 text-[var(--tx-3)]">
              <p>{settings?.source === "local" ? "正在使用本机覆盖设置" : "正在使用 .env 设置"}</p>
              <p>Key 由当前 Windows 用户加密保护，页面读取不到已保存的原文。</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void reset()}
                disabled={saving || !settings?.localOverridePresent}
                className={btnGhost}
              >
                恢复 .env
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || loading}
                className={`${btnPrimary} h-10`}
              >
                {saving ? (
                  <>
                    <Spinner /> 保存中…
                  </>
                ) : (
                  "保存并测试"
                )}
              </button>
            </div>
          </div>

          {saved && (
            <p className="rounded-lg border border-[color-mix(in_srgb,var(--ok)_35%,transparent)] bg-[var(--sage-soft)] px-3 py-2 text-xs text-[var(--sage-deep)]">
              连接已通过（{testResult}），下一次生成将使用这组模型设置。
            </p>
          )}
          {error && (
            <p className="rounded-lg border border-[color-mix(in_srgb,var(--bad)_35%,transparent)] bg-[color-mix(in_srgb,var(--bad)_8%,transparent)] px-3 py-2 text-xs leading-relaxed text-[var(--bad)]">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
