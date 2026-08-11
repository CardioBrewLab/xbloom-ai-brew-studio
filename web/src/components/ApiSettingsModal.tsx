/** 模型接口设置弹窗：Key 仅提交给本机后端，读取时只显示是否已配置。 */
import { useEffect, useRef, useState } from "react";
import {
  api,
  type LlmSettingsPublic,
  type ModelProvider,
  type ModelProviderPreset,
} from "../lib/api.js";
import {
  buildLlmSettingsUpdate,
  settingsBaseUrlOrigin,
  type LlmSettingsDraft,
} from "../lib/llm-settings.js";
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
  const [provider, setProvider] = useState<ModelProvider>("openai-compatible");
  const [providers, setProviders] = useState<ModelProviderPreset[]>([]);
  const [detectedModels, setDetectedModels] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  /** 丢弃已关闭弹窗或更晚一次识别之前返回的旧响应。 */
  const detectionRunRef = useRef(0);

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
    setProvider(next.provider ?? "openai-compatible");
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setSaved(false);
    setTestResult("");
    Promise.all([api.getLlmSettings(), api.listLlmProviders().catch(() => [])])
      .then(([next, available]) => {
        if (!cancelled) {
          hydrate(next);
          setProviders(available);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError((reason as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      detectionRunRef.current += 1;
    };
  }, [open]);

  const updateDraft = (key: keyof LlmSettingsDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
    setTestResult("");
  };

  const selectPreset = (preset: ModelProviderPreset) => {
    setProvider(preset.provider);
    setDraft((current) => ({ ...current, baseUrl: preset.baseUrl, model: "" }));
    setDetectedModels([]);
    setSaved(false);
    setTestResult("");
  };

  const detect = async () => {
    const runId = ++detectionRunRef.current;
    const requestedBaseUrl = draft.baseUrl.trim();
    const requestedProvider = provider;
    const requestedApiKey = draft.apiKey.trim();
    setError("");
    setSaved(false);
    setDetecting(true);
    try {
      const result = await api.detectLlmModels({
        provider: requestedProvider,
        baseUrl: requestedBaseUrl,
        ...(requestedApiKey ? { apiKey: requestedApiKey } : {}),
      });
      if (runId !== detectionRunRef.current) return;
      setProvider(result.provider);
      setDetectedModels(result.models);
      const resolvedBaseUrl = result.baseUrl || requestedBaseUrl;
      const endpointCompleted =
        resolvedBaseUrl.replace(/\/+$/, "") !== requestedBaseUrl.replace(/\/+$/, "");
      setDraft((current) => ({
        ...current,
        baseUrl: resolvedBaseUrl,
        model:
          !current.model.trim() || !result.models.includes(current.model.trim())
            ? (result.models[0] ?? "")
            : current.model,
      }));
      setTestResult(
        `${endpointCompleted ? "已自动补全接口路径 · " : ""}已识别 ${result.models.length} 个模型 · ${result.latencyMs}ms`,
      );
    } catch (reason) {
      if (runId === detectionRunRef.current) setError((reason as Error).message);
    } finally {
      if (runId === detectionRunRef.current) setDetecting(false);
    }
  };

  const save = async () => {
    setError("");
    setSaved(false);
    let payload;
    try {
      const currentOrigin = settingsBaseUrlOrigin(settings?.baseUrl);
      const nextOrigin = settingsBaseUrlOrigin(draft.baseUrl);
      const reusesSavedKey = Boolean(settings?.apiKeyConfigured) && !draft.apiKey.trim();
      const endpointChanged = Boolean(currentOrigin && currentOrigin !== nextOrigin);
      let confirmed = false;
      if (endpointChanged && reusesSavedKey) {
        confirmed = window.confirm(
          "模型地址的域名或端口已变化。保存后，现有 API Key 与豆子/提示内容会发送到新地址。确认这是你信任的接口吗？",
        );
        if (!confirmed) return;
      }
      payload = { ...buildLlmSettingsUpdate(draft, confirmed), provider };
    } catch (reason) {
      setError((reason as Error).message);
      return;
    }
    setSaving(true);
    try {
      const result = await api.updateLlmSettings(payload);
      hydrate(result.settings);
      await onApplied?.();
      const checked = result.test ?? (await api.testLlmSettings());
      setTestResult(`${checked.model} · ${checked.latencyMs}ms`);
      setSaved(true);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    const confirmed = window.confirm(
      settings?.source === "user"
        ? "清除后，这个账号将不再保存当前模型连接。继续吗？"
        : "恢复后将重新使用 .env 中的模型设置。继续吗？",
    );
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
            这里只保存模型连接。xBloom 官方账号、小红书登录和手机 App 上传流程彼此独立。
            云端配置按当前账号加密保存；本地版由当前 Windows 用户保护密钥。
          </div>

          {settings?.localOverridePresent && !settings.localOverrideValid && (
            <div className="rounded-xl border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-4 py-3 text-xs leading-relaxed text-[var(--warn)]">
              本机覆盖文件需要修复。重新填写并保存，或恢复为 .env 设置即可。
            </div>
          )}

          {providers.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium text-[var(--tx-2)]">选择服务</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {providers.map((preset) => {
                  const selected =
                    provider === preset.provider &&
                    draft.baseUrl.replace(/\/+$/, "") === preset.baseUrl.replace(/\/+$/, "");
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => selectPreset(preset)}
                      disabled={detecting || saving}
                      className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                        selected
                          ? "border-[var(--acc)] bg-[var(--acc-soft)] text-[var(--acc)]"
                          : "border-[var(--line)] bg-[var(--bg-card)] text-[var(--tx-2)] hover:border-[var(--line-strong)]"
                      }`}
                    >
                      <span className="block text-xs font-semibold">{preset.label}</span>
                      <span className="mt-1 block truncate text-[10px] opacity-70">
                        {preset.domestic
                          ? "国内服务"
                          : preset.id === "custom"
                            ? "兼容网关"
                            : "海外服务"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <Field label="模型 API 地址" hint="支持官方接口与 OpenAI 兼容网关">
            <input
              value={draft.baseUrl}
              onChange={(event) => updateDraft("baseUrl", event.target.value)}
              disabled={detecting || saving}
              placeholder="https://example.com/v1"
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
              disabled={detecting || saving}
              placeholder={settings?.apiKeyConfigured ? "留空保留当前 Key" : "输入 API Key"}
              autoComplete="off"
              spellCheck={false}
              className={`${inputCls} font-mono text-xs`}
            />
          </Field>

          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field
                label="主模型"
                hint={detectedModels.length ? "从接口实时读取" : "可手动填写模型 ID"}
              >
                <input
                  value={draft.model}
                  onChange={(event) => updateDraft("model", event.target.value)}
                  disabled={detecting || saving}
                  placeholder="先识别模型，或手动输入"
                  spellCheck={false}
                  list="xbloom-model-options"
                  className={`${inputCls} font-mono text-xs`}
                />
                <datalist id="xbloom-model-options">
                  {detectedModels.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </Field>
            </div>
            <button
              type="button"
              onClick={() => void detect()}
              disabled={
                detecting ||
                saving ||
                !draft.baseUrl.trim() ||
                (!draft.apiKey.trim() && !settings?.apiKeyConfigured)
              }
              className={`${btnGhost} h-10 shrink-0`}
            >
              {detecting ? <Spinner /> : null} 识别模型
            </button>
          </div>

          <details className="rounded-xl border border-[var(--line)] bg-[var(--bg-inset)]">
            <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-[var(--tx-2)]">
              备用模型链
            </summary>
            <div className="space-y-4 border-t border-[var(--line)] bg-[var(--bg-card)] p-4">
              <Field label="第二模型" hint="留空关闭">
                <input
                  value={draft.fallbackModel}
                  onChange={(event) => updateDraft("fallbackModel", event.target.value)}
                  disabled={detecting || saving}
                  placeholder="备用模型名称"
                  spellCheck={false}
                  className={`${inputCls} font-mono text-xs`}
                />
              </Field>
              <Field label="第三模型" hint="留空关闭">
                <input
                  value={draft.thirdModel}
                  onChange={(event) => updateDraft("thirdModel", event.target.value)}
                  disabled={detecting || saving}
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
                  disabled={detecting || saving}
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
              <p>
                {settings?.source === "user"
                  ? "正在使用当前账号的个人配置"
                  : settings?.source === "local"
                    ? "正在使用本机覆盖设置"
                    : settings?.source === "unconfigured"
                      ? "当前账号尚未配置模型"
                      : "正在使用部署环境设置"}
              </p>
              <p>页面只读取“已配置”状态，不读取已保存的 Key 原文。</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void reset()}
                disabled={saving || detecting || !settings?.localOverridePresent}
                className={btnGhost}
              >
                {settings?.source === "user" ? "清除个人配置" : "恢复 .env"}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || detecting || loading}
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
