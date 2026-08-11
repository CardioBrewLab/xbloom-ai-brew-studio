import { pathToFileURL } from "node:url";

const APP_MARKERS = ["xBloom AI Brew Studio", "xBloom Brew Studio"];
const PREVIEW_TOKEN_NAMES = ["eo_token", "eo_time"];

export function normalizeHostedUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? "").trim());
  } catch {
    throw new Error("请提供完整的 Hosted URL，例如 https://brew.example.com/");
  }

  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("Hosted URL 必须使用 HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Hosted URL 不应包含用户名或密码");
  }
  if (PREVIEW_TOKEN_NAMES.some((name) => url.searchParams.has(name))) {
    throw new Error("检测到 EdgeOne 临时预览令牌；请改用已绑定的正式自定义域名");
  }

  url.hash = "";
  return url;
}

async function readResponse(response, label, expectedUrl) {
  // fetch follows redirects by default. Re-check the final URL so an apparently
  // stable custom domain cannot pass by forwarding to an expiring preview URL.
  if (response.url) {
    let finalUrl;
    try {
      finalUrl = normalizeHostedUrl(response.url);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${label}最终地址无效：${reason}`);
    }
    if (finalUrl.origin !== expectedUrl.origin) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${label}被重定向到其他来源 ${finalUrl.origin}；请直接检查最终公开域名`);
    }
  }

  const body = await response.text();
  if (response.status === 401) {
    throw new Error(`${label}返回 401；EdgeOne 系统域名的预览授权可能已过期，请检查正式自定义域名`);
  }
  if (!response.ok) {
    throw new Error(`${label}返回 HTTP ${response.status}`);
  }
  return body;
}

function parseStatusPayload(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("状态接口没有返回 JSON");
  }

  const capabilities = payload?.capabilities;
  if (
    payload?.ok !== true ||
    typeof payload.version !== "string" ||
    !payload.version.trim() ||
    !capabilities ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities) ||
    capabilities.generate !== true
  ) {
    throw new Error("状态接口返回的不是 xBloom Brew Studio 状态契约");
  }
  return payload;
}

export async function checkHostedUrl(rawUrl, options = {}) {
  const url = normalizeHostedUrl(rawUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const request = (target) =>
    fetchImpl(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "xbloom-hosted-public-check/1.0" },
    });

  const pageResponse = await request(url);
  const pageBody = await readResponse(pageResponse, "首页", url);
  if (!APP_MARKERS.some((marker) => pageBody.includes(marker))) {
    throw new Error("首页可访问，但没有识别到 xBloom Brew Studio 页面标记");
  }

  const statusUrl = new URL("/api/status", url);
  const statusResponse = await request(statusUrl);
  const statusBody = await readResponse(statusResponse, "状态接口", statusUrl);
  const statusPayload = parseStatusPayload(statusBody);

  return {
    ok: true,
    url: url.href,
    pageStatus: pageResponse.status,
    apiStatus: statusResponse.status,
    version: statusPayload.version,
    deployment: statusPayload.deployment ?? null,
  };
}

async function main() {
  const target = process.argv[2] ?? process.env.HOSTED_URL;
  if (!target) {
    throw new Error("用法：npm run check:hosted-url -- https://YOUR_PUBLIC_HOST/");
  }
  const result = await checkHostedUrl(target);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
