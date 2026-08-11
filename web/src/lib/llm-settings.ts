/** 模型接口表单的纯函数层：浏览器先做即时校验，服务端仍会执行同等约束。 */
export interface LlmSettingsDraft {
  baseUrl: string;
  model: string;
  fallbackModel: string;
  thirdModel: string;
  apiKey: string;
  fallbackApiKey: string;
}

export interface LlmSettingsUpdateInput {
  provider?: "openai-compatible" | "anthropic" | "gemini";
  baseUrl: string;
  model: string;
  fallbackModel: string;
  thirdModel: string;
  apiKey?: string;
  fallbackApiKey?: string;
  confirmEndpointChange?: boolean;
}

function normalizedModel(value: string, required: boolean): string {
  const model = value.trim();
  if (required && !model) throw new Error("请填写主模型名称");
  if (model.length > 160 || /[\r\n\0]/.test(model)) throw new Error("模型名称格式有误");
  return model;
}

export function normalizeSettingsBaseUrl(value: string): string {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("请填写完整的模型 API 地址，例如 https://example.com/v1");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("模型 API 地址需使用 http(s)，并去掉账号、查询参数和锚点");
  }
  return url.toString().replace(/\/+$/, "");
}

/** Empty means “not configured”; a real endpoint still receives strict URL validation. */
export function settingsBaseUrlOrigin(value?: string): string {
  if (!value?.trim()) return "";
  return new URL(normalizeSettingsBaseUrl(value)).origin;
}

export function buildLlmSettingsUpdate(
  draft: LlmSettingsDraft,
  confirmEndpointChange = false,
): LlmSettingsUpdateInput {
  const apiKey = draft.apiKey.trim();
  const fallbackApiKey = draft.fallbackApiKey.trim();
  if (/[\r\n\0]/.test(apiKey) || /[\r\n\0]/.test(fallbackApiKey)) {
    throw new Error("API Key 中含有换行或控制字符");
  }
  return {
    baseUrl: normalizeSettingsBaseUrl(draft.baseUrl),
    model: normalizedModel(draft.model, true),
    fallbackModel: normalizedModel(draft.fallbackModel, false),
    thirdModel: normalizedModel(draft.thirdModel, false),
    ...(apiKey ? { apiKey } : {}),
    ...(fallbackApiKey ? { fallbackApiKey } : {}),
    ...(confirmEndpointChange ? { confirmEndpointChange: true } : {}),
  };
}
