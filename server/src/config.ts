/**
 * 类型化配置：dotenv 读取仓库根目录 .env（与 .env.example 对应）。
 * 无论从 src/（tsx dev）还是 dist/（编译产物）运行，向上两级都是仓库根。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { detectModelProvider, type ModelProvider } from "../../shared/dist/model-provider.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, "../../.env");

// dotenv 17 logs a promotional load message by default; startup output is an
// operational surface here, so keep it deterministic without hiding errors.
dotenv.config({ path: envPath, quiet: true });

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 可选数值参数：env 未设/空串/非法值时返回 undefined（调用方不下发，维持现状） */
function optNum(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function envText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function modelProvider(value: string | undefined, baseUrl: string): ModelProvider {
  if (value === "anthropic" || value === "gemini" || value === "openai-compatible") return value;
  return detectModelProvider(baseUrl);
}

/**
 * 多候选生成并发数（任务 #106）：env GENERATE_CANDIDATES，缺省/空/非法值 = 3，
 * 合法值钳位到 [1,5] 整数。N=1 = 回滚开关，生成链路与现状逐字节一致。
 * 任务 #113：区分「未设置」与「设置了但越界」——仅未设置（undefined/空串/非法值）
 * 回退 3；已设置的数值（含 0/负数/超 5/小数）一律钳位到 [1,5] 整数，
 * 即 GENERATE_CANDIDATES=0 显式钳位为 1（回滚）而非静默回退 3。
 */
export function parseGenerateCandidates(value: string | undefined): number {
  const n = optNum(value);
  if (n === undefined) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

export interface AppConfig {
  /** 后端监听地址（固定本机回环） */
  host: string;
  /** 后端监听端口 */
  port: number;
  /** LLM 网关配置（OpenAI 兼容协议，支持双 key 三级兜底） */
  llm: {
    /** 接口协议；自建网关可显式指定，官方域名会自动识别。 */
    provider: ModelProvider;
    baseUrl: string;
    /** 主渠道 key（默认用于主模型与第二兜底模型） */
    apiKey: string;
    /** 兜底渠道 key（用于第三兜底模型；缺省回退 apiKey） */
    fallbackApiKey: string;
    /** 主模型 */
    model: string;
    /** 第二兜底模型 */
    fallbackModel: string;
    /** 第三兜底模型（空串 = 禁用） */
    thirdModel: string;
    /** GPT 系思考强度（reasoning_effort），仅对 gpt 系模型下发 */
    reasoningEffort: string;
    /** 采样温度（任务 #71/#106 采样层治理）：undefined = env 未设。
     * 按模型分发：模型名含 "gpt" 一律不下发 temperature；
     * 其他模型下发 opts.temperature ?? config.llm.temperature ?? 0.3（缺省 0.3）。 */
    temperature?: number;
  };
  /** xBloom 云端账号 */
  xbloom: {
    email: string;
    password: string;
  };
  /** 出站代理（可选） */
  httpsProxy: string;
  /** 本地 SearXNG 聚合搜索基址（任务 #30；空串 = 禁用，回退百度/Bing） */
  searxngUrl: string;
  /** 小红书 MCP 直连基址（任务 #82；空串 = 禁用，回退 site: 定向 + 域名过滤） */
  xhsMcpUrl: string;
  /** Firecrawl API key（任务 #85，可选；空串 = keyless 模式，按 IP 日限额） */
  firecrawlApiKey: string;
  /** Firecrawl 接入开关（任务 #85；默认开，FIRECRAWL_ENABLED=false 关闭） */
  firecrawlEnabled: boolean;
  /** 多候选生成并发数（任务 #106）：[1,5]，缺省 3；1 = 回滚开关（现状行为） */
  generateCandidates: number;
  /** 候选采用分数阈值（任务 #131）：低于此分的获胜候选触发重调研，缺省 70 */
  candidateScoreThreshold: number;
  /** 调研重试最大轮数（任务 #131）：低分/不一致时换源重调研，缺省 1 */
  researchRetryMaxRounds: number;
}

export const config: AppConfig = {
  host: "127.0.0.1",
  port: num(process.env.PORT, 8787),
  llm: {
    baseUrl: envText(process.env.LLM_BASE_URL, "https://api.openai.com/v1"),
    provider: modelProvider(
      process.env.LLM_PROVIDER,
      envText(process.env.LLM_BASE_URL, "https://api.openai.com/v1"),
    ),
    apiKey: process.env.LLM_API_KEY ?? "",
    fallbackApiKey: process.env.LLM_FALLBACK_API_KEY ?? "",
    model: envText(process.env.LLM_MODEL, "gpt-5.6-sol"),
    fallbackModel: envText(process.env.LLM_FALLBACK_MODEL, "claude-opus-5-thinking"),
    thirdModel: process.env.LLM_THIRD_MODEL ?? "",
    reasoningEffort: envText(process.env.LLM_REASONING_EFFORT, "high"),
    temperature: optNum(process.env.LLM_TEMPERATURE),
  },
  xbloom: {
    email: process.env.XBLOOM_EMAIL ?? "",
    password: process.env.XBLOOM_PASSWORD ?? "",
  },
  httpsProxy: process.env.HTTPS_PROXY ?? "",
  searxngUrl: process.env.SEARXNG_URL ?? "http://127.0.0.1:8899",
  xhsMcpUrl: process.env.XHS_MCP_URL ?? "http://127.0.0.1:18060",
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY ?? "",
  firecrawlEnabled: (process.env.FIRECRAWL_ENABLED ?? "true").trim().toLowerCase() !== "false",
  generateCandidates: parseGenerateCandidates(process.env.GENERATE_CANDIDATES),
  candidateScoreThreshold: num(process.env.CANDIDATE_SCORE_THRESHOLD, 70),
  researchRetryMaxRounds: num(process.env.RESEARCH_RETRY_MAX_ROUNDS, 1),
};
