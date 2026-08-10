/**
 * 参考资料抓取：若用户请求带 refUrls（豆商/评测页 URL），
 * 服务端 fetch 抓取、剥离 HTML 标签、截断后注入 user message 上下文。
 * 抓取失败只记录占位说明，绝不阻塞配方生成。
 *
 * SSRF 防护（任务 #15-P2-9）：
 * - 仅允许 http/https 协议；
 * - fetch 前用 new URL 校验 hostname，拒绝环回/私网/链路本地等 IP 字面量与 localhost；
 * - redirect 设 manual，每一跳的 Location 都重新走一次同样的校验（最多 MAX_REDIRECTS 跳）。
 *
 * xBloom 分享链接（share-h5.xbloom.com）优先走 fetchSharedRecipe 结构化解析注入，
 * 失败回退通用抓取（任务 #15 加分项）。
 *
 * 主动联网调研（任务 #22；#26 质量提升；#30 命中率修复；#70 分层降级+小红书+snippet；
 * #76 小红书 site: 定向真召回；#80 Reddit 渠道接入；#82 小红书 MCP 直连；
 * #86 处理法冲突过滤 + origin「国家-庄园」拆分 + 国家级泛文降权）：
 * researchBean 根据豆信息构造至多 8 组分层的搜索词（中英混合，按精确度降序：
 * 庄园/地块 → 豆名 → 小红书定向 → 产区+品种 → Reddit 论坛定向 → 国家级兜底），
 * 调搜索引擎（SearXNG 主渠道 / 百度 / Bing / DuckDuckGo 末位兜底）找豆商/官网/评测页；小红书平台查询形如 `site:xiaohongshu.com <主题> 冲煮参数`，
 * 任务 #76 实测：百度对 site: 语法返回验证码页（wappass）、Bing 返回零结果/拒绝页、
 * 本地 SearXNG 实例离线（ECONNREFUSED），免 key 渠道对 site: 均零召回；
 * 故该查询走专用通道 searchXiaohongshuDirected：最高优先级为小红书 MCP 直连
 * （xhs-mcp.ts，search_feeds/get_feed_detail，离线/超时静默降级）；任务 #86：MCP 路径带
 * 关键词变体梯队（豆名/庄园词+冲煮参数 → +手冲 → 产地+处理法+手冲，任一命中即停，
 * 全部落空才降级，search_feeds 偶发长时挂起由 25s 单变体时间盒+梯队续跑吸收）；SearXNG 在线时透传 site: 语法，
 * 否则降级为普通查询 + 域名过滤（仅保留 xiaohongshu.com / xhslink 结果），
 * 召回为 0 时在总结报告中如实标注「小红书定向召回受限」，绝不伪造来源。
 * 任务 #80：Reddit（r/pourover、r/espresso 等）是手冲参数内容密度最高的论坛，
 * 新增 `site:reddit.com` 定向查询走 searchRedditDirected：SearXNG 透传 site:，
 * 任务 #86：Reddit 结果除 reddit.com 域名过滤外另加领域护栏（咖啡版块放行 /
 * 标题摘要需含咖啡强信号词，brew 等泛词单独不算，cocktail/鸡尾酒反信号词直接拒），
 * 防 r/cocktails 等非咖啡版块帖混入；
 * 否则走 DDG html/lite 端点（实测 site:reddit.com 召回率高，但连发约 3 次后 202 限流，
 * 仅 Reddit 定向 + 全渠道零结果末位兜底使用，绝不设为主渠道）；
 * www.reddit.com 正文抓取前重写为 old.reddit.com（静态 HTML 免登录墙，新壳页对 bot UA 403），
 * 抓取失败走 snippet 兜底；home-barista.com 仅在域名保留名单层面放行（snippet 兜底标注）。
 * 搜索结果先过轻量相关性打分过滤（域词命中即弱相关保留），
 * 无关条目直接丢弃；抓取正文后优先用一次低成本 LLM 调用提炼为结构化要点
 * （失败回退“仅取咖啡相关段落”的截断注入），只把提炼结果注入提示词。
 * 整体时间盒 RESEARCH_TOTAL_TIMEOUT_MS，任何失败都降级为 ok:false，绝不阻塞生成。
 * 任务 #101：小红书定向查询在总时间盒开启时即与 Tier1/Tier2 串行梯队并行发起，
 * 保证其在总盒内必然获得执行机会（修复前序渠道耗时耗尽总盒、signal.aborted
 * 导致排在梯队后段的小红书定向从未执行的确定性缺陷）；池满短路、查询上限、
 * 总时间盒与同输入同行为语义不变，结果按 URL 去重合池。
 * 任务 #102：豆仓全豆实测（任务 #93）调研问题修复——
 * ① 手动豆小红书零命中：xhsKeywordLadder 主题词分词去重限词（实测超长重复
 * 关键词令 MCP search_feeds 服务端挂死 1m+），并补「纯豆名/subject 首词 + 手冲」
 * 兜底放宽档（origin/process 缺失致第三档无法构造时的最后防线）；
 * ② 产地张冠李戴：scoreSourceRelevance 增国别一致性校验（冲突国名出现在标题
 * 强降权乃至过滤、仅摘要提及降权不判死刑、保留但不符者在摘要中披露）；
 * ③ MCP search_feeds 超时后本次调研内冷却（ResearchBudgets.xhsMcpSearchCooled
 * 携带，后续变体不再打 MCP——服务端残留请求串行阻塞，连环超时只会拖垮预算）；
 * ④ 披露三态措辞精确化（在线但零召回 / 搜索执行超时 / 未能连接）；
 * ⑤ 入池前标题近重复去重（保留先入者）+ baidu.com/link 等跳转链接降权；
 * ⑥ 搜索阶段被时间盒截断时披露「未及执行」的渠道（如 Reddit 定向）。
 * 任务 #109：4 豆实测（任务 #103）小红书命中质量修复——
 * ① MCP 命中笔记被挤出抓取名额：xhs 来源补入候选名单 + pickFetchQuota
 * 保证 MCP 命中至少占 min(命中数,2) 个抓取名额；披露文案以实际进入摘要的
 * 来源数为准，不再笼统声称「正文经 get_feed_detail 补充」；
 * ② 假命中拦截：xhs 渠道来源入池/计命中前要求豆名/主题词（narrowSubjectTokens
 * 产物/庄园词）在标题或正文命中（xhsNoteRelevant），不满足者不入池不计命中；
 * ③ 长复合豆名收敛：narrowSubjectTokens 单 token >6 字视为复合名，优先改用
 * extractEstateTokens 庄园词（与 site: 定向查询一致），无庄园词按字符截断；
 * ④ 首档超时不再整梯尽废：冷却后允许一次更短的兜底档（梯队末档短词）调用，
 * 仍超时才彻底放弃渠道（兜底档同样受冷却标记保护，只多这一次）；
 * ⑤ summaryText 产地不符名单与最终引用来源取交集（被截掉的不点名）；
 * ⑥ Tier2+ 泛来源收紧：域词命中但无任何豆词信号时降权 -2 且保留阈值提高到
 * ≥2 个域词（researchBean 以 tight 模式过滤，小红书/论坛直接保留不受影响）。
 * 任务 #117：手动豆「波切萨 74158 · 埃塞俄比亚 阿贝格纳」（freeText、无结构化字段）
 * 小红书零命中 + 两条词序互换的百度 SEO 模板页同时入池修复——
 * ① freeText 结构分段：seg0 作豆名候选段、含国别词的段作产地候选段
 * （freeTextNameSegment/freeTextOriginSegment），庄园词提取/豆词打分/梯队主题不再依赖结构化字段；
 * ② narrowSubjectTokens 数字豁免+数字型号并入（「波切萨 74158」整体算一个有效短词槽位）；
 * ③ xhsKeywordLadder 增庄园词独立档（「阿贝格纳」式庄园词真正进入 search_feeds 梯队）；
 * ④ 近重复去重增 token-set Jaccard 维度（isNearDuplicateTitle：Dice>0.8 或 Jaccard>0.6），
 * 接入入池合并与 dedupeSourcesByTitle（实测截图两条 SEO 标题 Dice≈0.67 漏网）。
 * 任务 #119：手动豆「水洗卡杜拉奇洛索 · 哥伦比亚 橙子庄园」实跑来源 3 条无小红书且
 * 混入他豆（哥伦比亚大肚脐、巴拿马翡翠庄园绿标瑰夏、烘焙商营销泛页）——根因是
 * #113 的 tight 官方/烘焙商豁免过宽：他豆烘焙商页与营销泛页因 roasterTextSignalHit
 * 被无条件豁免保留。豁免加约束：① 标题/摘要命中国别冲突（COUNTRY_GROUPS，豆国
 * 同时出现属对比文不判冲突）的来源不享受官方/烘焙商豁免（官方域豁免同理）；
 * ② 标题命中他豆强信号（FOREIGN_BEAN_NAME_WORDS 品种/豆名专词且非本豆豆名组成部分、
 * 标题不含本豆任何豆词）不享受烘焙商豁免；③ 烘焙商名命中但标题/摘要无本豆豆词
 * 信号（营销泛页）tight 下直接丢弃；本豆烘焙商页（含豆名/庄园词，含长复合豆名的
 * 汉字三元滑窗子词如「奇洛索」）仍豁免保留。非 tight 行为逐字节不变。
 */
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";
import { config } from "../config.js";

/** 测试会临时替换 global fetch；真实运行保持此引用不变并启用 DNS 固定。 */
const NATIVE_FETCH = globalThis.fetch;
import { streamChat, type ChatMessage } from "./llm.js";
import { fetchSharedRecipe } from "./xbloom-cloud.js";
import {
  getFeedDetailText,
  isXhsLoginExpiredError,
  searchXhsMcp,
  xhsMcpHealthy,
  xhsNoteToSource,
  type XhsMcpNote,
} from "./xhs-mcp.js";

const PER_PAGE_LIMIT = 8000; // 单页截断字符数（约 8000）
const MAX_PAGES = 3; // 最多抓取页面数
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

// ---- 主动调研参数（任务 #22） ----
const RESEARCH_TOTAL_TIMEOUT_MS = 40_000; // 单次调研总时间盒（40 秒上限）
const RESEARCH_MAX_SOURCES = 6; // 过滤后保留的候选来源上限（任务 #30：4 → 6）
const RESEARCH_MAX_FETCH = 4; // 实际抓取正文的页面数（任务 #30：3 → 4）
const RESEARCH_PAGE_LIMIT = 3000; // 回退截断注入的单页上限
const SEARCH_CHANNEL_TIMEOUT_MS = 8_000; // 单渠道搜索请求时间盒（避免单渠道挂死拖垮时间预算）
// 任务 #101：搜索完成后的正文抓取/提炼阶段独立时间盒——搜索阶段耗尽 40s 总盒时
// 不连累已入池来源的正文获取（单页自带 FETCH_TIMEOUT_MS、提炼自带 DISTILL_TIMEOUT_MS，
// 此盒为阶段级兑底，约束最坏总时长 ≤ 40s 搜索 + 30s 素材处理）
const POST_SEARCH_TIMEOUT_MS = 30_000;

// ---- 调研质量参数（任务 #26） ----
const RESEARCH_MAX_QUERIES = 8; // 每豆最多构造的搜索词数（任务 #80：7 → 8，新增 Reddit 论坛定向槽位）
const RESEARCH_RAW_POOL = 6; // 每条查询保留的原始结果池大小
const RELEVANCE_DOMAIN_ONLY_MIN = 1; // 无豆词命中时的保留阈值（任务 #30：3 → 1，命中任一咖啡域词即弱相关保留）
// 任务 #109-P6：tight 模式（researchBean 专用）下，域词命中但无任何豆词信号时的收紧参数——
// 降权 GENERIC_DOMAIN_ONLY_PENALTY 且保留阈值提高到 ≥TIGHT_DOMAIN_ONLY_MIN 个域词，
// 防期货新闻/意式拼配泛文等挤占摘要席位（实测豆1 泛来源占 3/4 摘要席位）
const GENERIC_DOMAIN_ONLY_PENALTY = -2;
const TIGHT_DOMAIN_ONLY_MIN = 2;
// 任务 #109-P3：单 token 超过该长度视为复合豆名（如「瑰夏村金标Oma地块152」13 字整词），
// 收敛为庄园词或截断短词，避免首档超长词打 search_feeds 挂死
const NARROW_TOKEN_MAX_LEN = 6;
// 任务 #109-P1：抓取名额分配时 MCP 命中（小红书）来源至少保留的席位数（min(命中数, 该值)）
const XHS_FETCH_RESERVED_SEATS = 2;
const DISTILL_TIMEOUT_MS = 20_000; // LLM 提炼单次时间盒
const DISTILL_PAGE_LIMIT = 2000; // 喂给提炼 LLM 的单页正文截断
const EXCERPT_LINE_MIN = 15; // 回退摘录的最短行长
const EXCERPT_MAX_LINES = 6; // 回退摘录每页最多保留行数
const EXCERPT_LINE_LIMIT = 200; // 回退摘录单行截断

export interface ResearchSource {
  title: string;
  url: string;
  /** 搜索引擎返回的结果摘要（任务 #70：正文抓取失败时的兜底素材；可选，向后兼容） */
  snippet?: string;
  /** 任务 #125：他滤杯策略标记——含本豆名+他滤杯词时保留但标记，供 generate.ts 转换标注 */
  dripperSignal?: string;
}

/** 调研输入：豆档案字段 + 自由文本（手动豆信息/口味描述） */
export interface BeanResearchInput {
  name?: string;
  roaster?: string;
  origin?: string;
  process?: string;
  varietal?: string;
  roastLevel?: string;
  tastingNotes?: string;
  freeText?: string;
}

export interface ResearchOutcome {
  /** 是否抓到可用来源 */
  ok: boolean;
  sources: ResearchSource[];
  /** 可注入 user message 的调研文本块（ok=false 时为空串） */
  summaryText: string;
  /** 面向用户的结论描述（done 事件 message） */
  message: string;
  /** 被相关性过滤丢弃的低相关来源数（任务 #26） */
  filtered: number;
  /** 注入文本是否经 LLM 提炼（false = 回退咖啡相关段落截断） */
  distilled: boolean;
  /** 任务 #83：小红书 MCP 报未登录/凭证失效（仅标记提醒，降级链不受影响） */
  xhsLoginExpired?: boolean;
}

const BLOCKED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  // IPv4-mapped IPv6 versions of the blocked IPv4 ranges.
  ["::ffff:0:0", 104],
  ["::ffff:a00:0", 104],
  ["::ffff:6440:0", 106],
  ["::ffff:7f00:0", 104],
  ["::ffff:a9fe:0", 112],
  ["::ffff:ac10:0", 108],
  ["::ffff:c000:0", 120],
  ["::ffff:c000:200", 120],
  ["::ffff:c0a8:0", 112],
  ["::ffff:c612:0", 111],
  ["::ffff:c633:6400", 120],
  ["::ffff:cb00:7100", 120],
  ["::ffff:e000:0", 100],
  ["::ffff:f000:0", 100],
] as const)
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");

/** DNS 与字面量共用的地址判定，覆盖 IPv4-mapped IPv6。 */
export function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (family === 0) throw new Error(`DNS 返回了无效地址（${address}）`);
  if (BLOCKED_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6")) {
    throw new Error(`拒绝抓取内网/保留地址（${address}）`);
  }
}

type HostResolver = (
  hostname: string,
  options: { all: true; order: "verbatim" },
) => Promise<LookupAddress[]>;

/** 解析并验证全部 A/AAAA；任一结果落入受限网段即拒绝该主机。 */
export async function resolvePublicHost(
  hostname: string,
  resolver: HostResolver = dnsLookup as HostResolver,
): Promise<LookupAddress[]> {
  const addresses = await resolver(hostname, { all: true, order: "verbatim" });
  if (addresses.length === 0) throw new Error(`域名没有可用地址（${hostname}）`);
  for (const item of addresses) assertPublicAddress(item.address);
  return addresses;
}

function pinnedDispatcher(addresses: LookupAddress[]): Agent {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const requestedFamily = typeof options.family === "number" ? options.family : 0;
    const candidates =
      requestedFamily === 0
        ? addresses
        : addresses.filter((item) => item.family === requestedFamily);
    if (candidates.length === 0) {
      const error = Object.assign(new Error("没有匹配的公开 DNS 地址"), { code: "ENOTFOUND" });
      callback(error, "", 0);
      return;
    }
    if (options.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  };
  return new Agent({ connect: { lookup }, pipelining: 0, maxResponseSize: 2 * 1024 * 1024 });
}

/**
 * 校验 URL 是否允许抓取。非法（协议/内网地址）时抛错，由调用方降级为占位说明。
 * 拒绝清单：非 http/https 协议、localhost、IPv6 环回 ::1、以及 IPv4 字面量的
 * 127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、169.254.0.0/16、0.0.0.0。
 */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`不是合法的 URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`仅允许 http/https 链接（收到 ${url.protocol}）`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("拒绝抓取本机地址（localhost）");
  }
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") {
    throw new Error("拒绝抓取本机地址（IPv6 环回）");
  }
  if (isIP(host)) assertPublicAddress(host);
  return url;
}

/** 剥离 HTML 标签与脚本样式，压缩空白为可读文本 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|table|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  // 解码常见实体
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
  // 压缩连续空白
  text = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return text;
}

/**
 * 带 SSRF 防护的单次抓取：redirect=manual，对每一跳 Location 重新校验。
 * signal 可选：传入时优先（调用方负责自带超时），否则用默认单页超时。
 */
async function safeFetch(raw: string, signal?: AbortSignal): Promise<Response> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = assertPublicUrl(current);
    // 既有单元测试用内存 fetch fixture 驱动调研流程；fixture 不经过公网 DNS。
    if (globalThis.fetch !== NATIVE_FETCH) {
      const fixtureResponse = await globalThis.fetch(current, {
        redirect: "manual",
        signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; xBloom-BrewBot/1.0; +https://xbloom.com)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
      });
      if (fixtureResponse.status >= 300 && fixtureResponse.status < 400) {
        const location = fixtureResponse.headers.get("location");
        if (!location) throw new Error(`重定向响应（HTTP ${fixtureResponse.status}）缺少 Location`);
        current = new URL(location, current).toString();
        continue;
      }
      return fixtureResponse;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const literalFamily = isIP(host);
    const addresses = literalFamily
      ? [{ address: host, family: literalFamily } as LookupAddress]
      : await resolvePublicHost(host);
    const dispatcher = pinnedDispatcher(addresses);
    try {
      const res = await globalThis.fetch(current, {
        dispatcher,
        redirect: "manual",
        signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; xBloom-BrewBot/1.0; +https://xbloom.com)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
      } as unknown as RequestInit);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        await dispatcher.close();
        if (!location) throw new Error(`重定向响应（HTTP ${res.status}）缺少 Location`);
        current = new URL(location, current).toString();
        continue;
      }
      // 先读完再关闭专用 dispatcher，返回内存 Response 给现有调用方消费。
      const bytes = await res.arrayBuffer();
      await dispatcher.close();
      return new Response(bytes.byteLength > 0 ? bytes : null, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (error) {
      await dispatcher.destroy().catch(() => undefined);
      throw error;
    }
  }
  throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次上限`);
}

/** xBloom 分享链接 → 结构化配方文本；失败抛错由调用方回退通用抓取 */
async function fetchXbloomShare(url: string): Promise<string> {
  const { recipe } = await fetchSharedRecipe(url);
  return `（xBloom 官方分享配方，结构化解析）\n${JSON.stringify(recipe, null, 2)}`;
}

/**
 * 抓取一组参考 URL，返回可直接拼入 user message 的文本块。
 * 每个页面独立 try/catch：失败不阻塞其他页面，也不阻塞生成流程。
 */
export async function fetchReferences(urls?: string[]): Promise<string> {
  if (!urls || urls.length === 0) return "";
  const blocks: string[] = [];

  for (const url of urls.slice(0, MAX_PAGES)) {
    // share-h5.xbloom.com 链接优先走结构化解析（失败回退通用抓取）
    if (url.includes("share-h5.xbloom.com")) {
      try {
        const text = await fetchXbloomShare(url);
        blocks.push(`【参考资料：${url}】\n${text}`);
        continue;
      } catch {
        /* 结构化解析失败 → 走下方通用抓取兜底 */
      }
    }
    try {
      const res = await safeFetch(url);
      if (!res.ok) {
        blocks.push(`【参考资料 ${url}】抓取失败：HTTP ${res.status}`);
        continue;
      }
      const raw = await res.text();
      const contentType = res.headers.get("content-type") ?? "";
      const text = contentType.includes("text/html")
        ? htmlToText(raw)
        : raw.replace(/\s+/g, " ").trim();
      blocks.push(
        `【参考资料：${url}】\n${text.slice(0, PER_PAGE_LIMIT)}` +
          (text.length > PER_PAGE_LIMIT ? "\n…（内容过长已截断）" : ""),
      );
    } catch (err) {
      blocks.push(`【参考资料 ${url}】抓取失败：${(err as Error).message}`);
    }
  }

  return blocks.length > 0 ? blocks.join("\n\n") : "";
}

// ---------------------------------------------------------------------------
// 主动联网调研（任务 #22）
// ---------------------------------------------------------------------------

/** 调研来源事件回调：stage=start（含 query）/ source（逐条来源） */
export type ResearchEmit = (
  stage: "start" | "source",
  payload: { query?: string; title?: string; url?: string },
) => void;

/** 从自由文本中提取关键词：去标点（含 · / - 分隔符）、压缩空白、截断至 60 字 */
function keywords(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[，。；：、！？,.:;!?（）()【】\[\]“”"'「」·・\-—_/\\]/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * 豆名/主题词去重收窄（任务 #102-P1，纯函数可测）：分词、去重（大小写不敏感）、
 * 限制最多 maxTokens 个有效词。实测缺陷：手动豆「阿朵斯」把豆名+产地+处理法叠出
 * 「阿朵斯 埃塞俄比亚 阿朵斯 水洗 冲煮参数」式超长重复关键词，小红书 MCP
 * search_feeds 服务端挂死 1m+；而短词「阿朵斯」实测可召回 19 条。
 * 任务 #109-P3：单 token 长度 >NARROW_TOKEN_MAX_LEN 视为复合豆名（实测
 * 「瑰夏村金标Oma地块152」无空格分词后仍是 1 个 13 字整词，首档超长词打
 * search_feeds 挂死 1m）：优先改用 estateTokens 庄园词（与 site: 定向查询的
 * extractEstateTokens 策略一致），无可用庄园词时按字符截断至前 NARROW_TOKEN_MAX_LEN 字。
 * 任务 #117：数字豁免——长度判定剔除数字串（「波切萨74158」汉字部分 3 字 ≤6
 * 视为有效短词整体保留，不再被庄园词替换/截断）；纯数字型号词并入前一个
 * 豆名词合成一个复合短词（「波切萨 74158」只占一个槽位），避免数字串消耗
 * maxTokens 名额挤掉庄园/产地词。
 */
export function narrowSubjectTokens(
  text: string | undefined,
  maxTokens = 3,
  estateTokens: string[] = [],
): string[] {
  const out: string[] = [];
  for (const t of keywords(text).split(/\s+/)) {
    if (!t) continue;
    const key = t.toLowerCase();
    if (out.some((x) => x.toLowerCase() === key)) continue; // 分词去重
    // 任务 #117：数字豁免——型号数字不计入长度（「波切萨74158」汉字部分 3 字算有效短词）
    const effLen = t.replace(/\d+/g, "").length;
    if (effLen > NARROW_TOKEN_MAX_LEN) {
      // 任务 #109-P3：复合名收敛——优先 ≤6 字庄园词，否则截断前 6 字
      const estate = estateTokens.find((e) => e.length >= 2 && e.length <= NARROW_TOKEN_MAX_LEN);
      const shortened = estate ?? t.slice(0, NARROW_TOKEN_MAX_LEN);
      const sKey = shortened.toLowerCase();
      if (!out.some((x) => x.toLowerCase() === sKey)) out.push(shortened);
    } else if (/^\d+$/.test(t) && out.length > 0) {
      // 任务 #117：纯数字型号并入前一豆名合成一个复合短词（不占独立槽位）
      out[out.length - 1] = `${out[out.length - 1]} ${t}`;
    } else {
      out.push(t);
    }
    if (out.length >= maxTokens) break; // 限制词数
  }
  return out;
}

/** 产地中文 → 英文映射（任务 #30：英文查询需要英文产地名） */
// 注：extractEstateTokens 定义于 buildResearchQueries 之前（庄园词是最高优先级搜索主体）
const ORIGIN_EN: Record<string, string> = {
  埃塞俄比亚: "Ethiopia",
  埃塞: "Ethiopia",
  耶加雪菲: "Ethiopia Yirgacheffe",
  肯尼亚: "Kenya",
  哥伦比亚: "Colombia",
  哥斯达黎加: "Costa Rica",
  巴拿马: "Panama",
  危地马拉: "Guatemala",
  洪都拉斯: "Honduras",
  萨尔瓦多: "El Salvador",
  尼加拉瓜: "Nicaragua",
  巴西: "Brazil",
  秘鲁: "Peru",
  墨西哥: "Mexico",
  印度尼西亚: "Indonesia",
  印尼: "Indonesia",
  曼特宁: "Sumatra Mandheling",
  云南: "China Yunnan",
  中国: "China",
};

/** 处理法中文 → 英文关键词（任务 #30：品种/处理法词是英文资料的核心检索词） */
function processEnglish(process?: string): string {
  if (!process) return "";
  const parts: string[] = [];
  if (/厌氧/.test(process)) parts.push("anaerobic");
  if (/二氧化碳|CO2|carbonic/i.test(process)) parts.push("carbonic maceration");
  if (/水洗/.test(process)) parts.push("washed");
  if (/日晒/.test(process)) parts.push("natural");
  if (/蜜/.test(process)) parts.push("honey");
  if (/湿刨/.test(process)) parts.push("wet hulled");
  return parts.join(" ");
}

// ---- 处理法同义词族与冲突检测（任务 #86） ----
/**
 * 处理法族：每族覆盖中英文常见写法。豆档案处理法已知时，
 * 来源以「其他族」为主题（冲突词出现在标题）即强降权乃至过滤；
 * 仅摘要顺带提及冲突处理法（对比语境）只降权不判死刑。
 */
const PROCESS_GROUPS: { id: string; patterns: RegExp[] }[] = [
  { id: "washed", patterns: [/水洗/, /\bwashed\b/i] },
  { id: "natural", patterns: [/日晒/, /\bnatural\b/i, /\bsun[- ]?dried\b/i] },
  { id: "honey", patterns: [/蜜处理/, /[白黄红黑金]蜜/, /\bhoney\b/i] },
  { id: "anaerobic", patterns: [/厌氧/, /无氧发酵/, /双重发酵/, /\banaerobic\b/i] },
  { id: "carbonic", patterns: [/二氧化碳浸渍/, /\bcarbonic\b/i, /\bco2\b/i] },
  { id: "wethulled", patterns: [/湿刨/, /\bwet[- ]?hull/i] },
];

const PROCESS_MATCH_TITLE_BONUS = 3; // 匹配处理法出现在标题：加分
const PROCESS_CONFLICT_TITLE_PENALTY = -12; // 冲突处理法出现在标题（主题级）：强降权
const PROCESS_CONFLICT_MIXED_PENALTY = -6; // 标题同时含匹配与冲突处理法（对比文）：中等降权、不判死刑
const PROCESS_CONFLICT_SNIPPET_PENALTY = -3; // 冲突处理法仅出现在摘要：降权不作死刑
const PROCESS_CONFLICT_KEEP_THRESHOLD = 6; // 标题级冲突时总分低于该阈值即过滤
const GENERIC_ORIGIN_PENALTY = -4; // 庄园词已知但来源只有国家/大产区泛词：降权让位精确来源

// ---- 产地国别一致性校验（任务 #102-P2） ----
/**
 * 国别族：每族覆盖该国中英文常见写法（模式均按小写文本测试）。
 * 豆档案产地可归入某族时，来源标题/摘要以「其他族」国别为主题即强降权乃至过滤，
 * 仅摘要顺带提及冲突国别（对比语境）只降权不判死刑——模式同 PROCESS_GROUPS。
 * 实测缺陷：哥伦比亚豆保留了摘要明写「玻利维亚瓦利基」的笔记，即缺此校验。
 */
const COUNTRY_GROUPS: { id: string; patterns: RegExp[] }[] = [
  { id: "ethiopia", patterns: [/埃塞俄比亚|埃塞/, /\bethiopia\b/i] },
  { id: "kenya", patterns: [/肯尼亚/, /\bkenya\b/i] },
  { id: "colombia", patterns: [/哥伦比亚/, /\bcolombia\b/i] },
  { id: "bolivia", patterns: [/玻利维亚/, /\bbolivia\b/i] },
  { id: "brazil", patterns: [/巴西/, /\bbrazil\b/i] },
  { id: "panama", patterns: [/巴拿马/, /\bpanama\b/i] },
  { id: "guatemala", patterns: [/危地马拉/, /\bguatemala\b/i] },
  { id: "costarica", patterns: [/哥斯达黎加/, /\bcosta\s*rica\b/i] },
  { id: "honduras", patterns: [/洪都拉斯/, /\bhonduras\b/i] },
  { id: "elsalvador", patterns: [/萨尔瓦多/, /\bel\s*salvador\b/i] },
  { id: "nicaragua", patterns: [/尼加拉瓜/, /\bnicaragua\b/i] },
  { id: "peru", patterns: [/秘鲁/, /\bperu\b/i] },
  { id: "mexico", patterns: [/墨西哥/, /\bmexico\b/i] },
  { id: "indonesia", patterns: [/印度尼西亚|印尼|苏门答腊/, /\bindonesia\b/i, /\bsumatra\b/i] },
  { id: "yemen", patterns: [/也门/, /\byemen\b/i] },
  { id: "rwanda", patterns: [/卢旺达/, /\brwanda\b/i] },
  { id: "burundi", patterns: [/布隆迪/, /\bburundi\b/i] },
  { id: "tanzania", patterns: [/坦桑尼亚/, /\btanzania\b/i] },
  { id: "uganda", patterns: [/乌干达/, /\buganda\b/i] },
  { id: "china", patterns: [/云南|中国/, /\bchina\b/i, /\byunnan\b/i] },
];

const ORIGIN_CONFLICT_TITLE_PENALTY = -12; // 冲突国别出现在标题（主题级）：强降权
const ORIGIN_CONFLICT_MIXED_PENALTY = -6; // 标题同时含豆档案国别与冲突国别（对比文）：中等降权、不判死刑
const ORIGIN_CONFLICT_SNIPPET_PENALTY = -3; // 冲突国别仅出现在摘要：降权不作死刑（但标注不符）
const ORIGIN_CONFLICT_KEEP_THRESHOLD = 6; // 标题级国别冲突时总分低于该阈值即过滤
const REDIRECT_LINK_PENALTY = -3; // 搜索引擎跳转链接（baidu.com/link 等无法溯源）：降权不硬删

// ---- tight 官方/烘焙商豁免收紧（任务 #119） ----
/**
 * 他豆品种/豆名专名词表（任务 #119，纯函数可测）：标题命中其一且该词并非本豆
 * 豆名/品种组成部分、标题又不含本豆任何豆词时视为他豆强信号——不享受 tight
 * 模式的烘焙商豁免（实测「巴拿马翡翠庄园绿标瑰夏」「哥伦比亚大肚脐」因命中
 * 烘焙商名被 #113 豁免保留）。词表不求全，覆盖市售常见他豆专名；拉丁词元按
 * 词边界匹配（gesha 不误伤 gesha village）。
 */
export const FOREIGN_BEAN_NAME_WORDS = [
  // 中文品种/豆名专名
  "瑰夏",
  "大肚脐",
  "曼特宁",
  "耶加雪菲",
  "西达摩",
  "西达莫",
  "花魁",
  "波旁",
  "铁皮卡",
  "象豆",
  "帕卡马拉",
  "帕拉伊内马",
  "粉波旁",
  "黄波旁",
  "尖身波旁",
  // 拉丁品种词（词边界匹配）
  "gesha",
  "geisha",
  "pacamara",
  "parainema",
  "maragogype",
  "laurina",
  "sl28",
  "sl34",
];
/** tight 豁免豆词信号判定时排除的处理法词（处理法词区分度低，不作本豆豆词信号） */
const TIGHT_EXEMPT_PROCESS_WORDS = [
  "水洗",
  "日晒",
  "蜜处理",
  "厌氧",
  "无氧发酵",
  "双重发酵",
  "湿刨",
  "控温发酵",
  "washed",
  "natural",
  "honey",
  "anaerobic",
  "carbonic",
];

/** 国别/大产区词判定（任务 #119）：REGION_WORDS 或可归入 COUNTRY_GROUPS 的词——
 * 区分度低（他豆标题同样常含同国国名），tight 豁免的本豆豆词信号判定时排除 */
export function isRegionLikeWord(word: string): boolean {
  const w = word.toLowerCase();
  if (REGION_WORDS.includes(w)) return true;
  return COUNTRY_GROUPS.some((g) => g.patterns.some((p) => p.test(w)));
}

/**
 * tight 豁免判定的本豆豆词信号集（任务 #119，纯函数可测）：豆词 tokens + 庄园词，
 * 排除处理法词、国别/大产区词与烘焙商名拆词（light/wave 等无区分度）。
 * opts.beanNameTerms 中长度 >6 汉字的复合豆名追加汉字三元滑窗子词——
 * 「水洗卡杜拉奇洛索」产出「卡杜拉」「奇洛索」等窗口，使标题仅含「奇洛索」的
 * 本豆烘焙商页也命中豆词信号（任务硬指标：含奇洛索/Chiroso 的本豆页仍保留）。
 * 纯拉丁复合名（Gesha Village 等）按空格分词即可，不做滑窗。
 */
export function tightExemptionBeanWords(
  tokens: string[],
  estateTokens: string[],
  opts: { roaster?: string; beanNameTerms?: string[] } = {},
): string[] {
  const roasterWords = new Set(
    keywords(opts.roaster)
      .split(/\s+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length >= 2),
  );
  const out: string[] = [];
  const push = (w: string): void => {
    if (w.length >= 2 && !out.includes(w)) out.push(w);
  };
  for (const t of [...tokens, ...estateTokens.map((e) => e.toLowerCase())]) {
    const w = t.toLowerCase();
    if (w.length < 2 || roasterWords.has(w)) continue;
    if (TIGHT_EXEMPT_PROCESS_WORDS.includes(w)) continue;
    if (isRegionLikeWord(w)) continue;
    push(w);
  }
  for (const term of opts.beanNameTerms ?? []) {
    const han = term.toLowerCase().replace(/[^\p{Script=Han}]/gu, "");
    if (han.length > 6) {
      for (let i = 0; i + 3 <= han.length; i += 1) push(han.slice(i, i + 3));
    }
  }
  return out;
}

/**
 * 他豆强信号判定（任务 #119，纯函数可测）：标题命中 FOREIGN_BEAN_NAME_WORDS 其一
 * （拉丁词按词边界），且该词并非本豆豆名/品种/freeText 豆名段的组成部分
 * （圣妮佐庄园瑰夏的「瑰夏」不算他豆）、标题不含本豆任何豆词信号时返回 true。
 * 豆词信号集为空时无判定依据，保守返回 false（与 xhsNoteRelevant 同哲学）。
 */
export function foreignBeanTitleSignal(
  src: ResearchSource,
  beanWords: string[],
  beanNameTerms: string[] = [],
): boolean {
  const title = src.title.toLowerCase();
  const selfText = beanNameTerms.join(" ").toLowerCase();
  const hits = FOREIGN_BEAN_NAME_WORDS.filter((w) => {
    const lw = w.toLowerCase();
    return /[a-z0-9]/.test(lw)
      ? new RegExp(`\\b${lw.replace(/\s+/g, "\\s+")}\\b`, "i").test(title)
      : title.includes(lw);
  });
  const trulyForeign = hits.filter((w) => !selfText.includes(w.toLowerCase()));
  if (trulyForeign.length === 0) return false;
  if (beanWords.length === 0) return false; // 无豆词信号可判：保守不拦
  return !beanWords.some((w) => title.includes(w));
}

// ---- 他滤杯拦截（任务 #125） ----
/**
 * 他滤杯/器具专名词表（任务 #125，纯函数可测）：标题命中其一即判为他滤杯来源。
 * 用户滤杯是 xBloom 官方滤杯（Omni Dripper，平底+底部限流孔，灵感 Kalita Wave），
 * 非 V60 锥形。含本豆名的他滤杯策略来源保留但打 dripperSignal 标记供转换标注；
 * 纯他滤杯泛攻略（不含本豆豆词）tight 下硬拦截。词表不求全，覆盖市售常见手冲器具。
 * 拉丁词元按词边界匹配（v60 不误伤 v600 等）。
 */
export const FOREIGN_DRIPPER_WORDS = [
  // 英文滤杯/器具专名（词边界匹配）
  "v60",
  "kalita",
  "origami",
  "chemex",
  "aeropress",
  "orea",
  "pulsar",
  "melitta",
  "espro",
  // 中文滤杯名/形态词
  "v60滤杯",
  "v-60",
  "kalita滤杯",
  "卡莉塔",
  "origami滤杯",
  "chemex滤杯",
  "锥形滤杯",
  "折纸滤杯",
  "蛋糕滤杯",
];

/** xBloom 官方滤杯词（任务 #125）：标题命中即豁免，不判为他滤杯来源 */
export const XBLOOM_DRIPPER_WORDS = [
  "xbloom",
  "xdripper",
  "omni dripper",
  "omnidripper",
  "官方滤杯",
];

/** 他滤杯信号判定结果 */
export type ForeignDripperSignal =
  | { kind: "none" }
  | { kind: "pure"; dripper: string } // 纯他滤杯泛攻略（不含本豆豆词）→ tight 硬拦截
  | { kind: "mixed"; dripper: string }; // 含本豆名+他滤杯策略 → 保留但打 dripperSignal

/**
 * 他滤杯强信号判定（任务 #125，纯函数可测）：标题命中 FOREIGN_DRIPPER_WORDS 其一
 * （拉丁词按词边界），且标题不含 XBLOOM_DRIPPER_WORDS（官方滤杯豁免）时：
 * - 标题不含本豆任何豆词 → pure（tight 下硬拦截，同 foreignBeanTitleSignal 处置）；
 * - 标题含本豆豆词 → mixed（保留但打 dripperSignal 标记供 generate.ts 转换标注）。
 * 豆词信号集为空时无判定依据，保守返回 none（与 foreignBeanTitleSignal 同哲学）。
 * 不享受烘焙商/官方豁免（同 foreignBeanTitleSignal 处置）。
 */
export function foreignDripperTitleSignal(
  src: ResearchSource,
  beanWords: string[],
  beanNameTerms: string[] = [],
): ForeignDripperSignal {
  const title = src.title.toLowerCase();
  // xBloom 官方滤杯词豁免
  if (XBLOOM_DRIPPER_WORDS.some((w) => title.includes(w.toLowerCase()))) {
    return { kind: "none" };
  }
  const hits = FOREIGN_DRIPPER_WORDS.filter((w) => {
    const lw = w.toLowerCase();
    return /[a-z0-9]/.test(lw)
      ? new RegExp(`\\b${lw.replace(/\s+/g, "\\s+")}\\b`, "i").test(title)
      : title.includes(lw);
  });
  if (hits.length === 0) return { kind: "none" };
  if (beanWords.length === 0) return { kind: "none" }; // 无豆词信号可判：保守不拦
  const hasBean = beanWords.some((w) => title.includes(w));
  return hasBean ? { kind: "mixed", dripper: hits[0] } : { kind: "pure", dripper: hits[0] };
}

/**
 * 豆名/品种词元（任务 #119，纯函数可测）：豆名/品种/freeText 豆名候选段的分词，
 * 供 tightExemptionBeanWords 复合豆名滑窗与 foreignBeanTitleSignal 本豆组成部分判定。
 */
export function beanNameTermsOf(input: BeanResearchInput): string[] {
  const out: string[] = [];
  for (const raw of [input.name, input.varietal, freeTextNameSegment(input.freeText)]) {
    for (const t of keywords(raw).split(/\s+/)) {
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** 文本 → 命中的国别族（可多个，如「埃塞俄比亚 肯尼亚」）；无法归族返回空（保守：不启用冲突逻辑） */
export function countryGroupsOf(text: string): { id: string; patterns: RegExp[] }[] {
  const lower = text.toLowerCase();
  return COUNTRY_GROUPS.filter((g) => g.patterns.some((p) => p.test(lower)));
}

/** 处理法文本 → 处理法族（可多个，如“水洗 双重发酵”）；无法识别返回空（保守：不启用冲突逻辑） */
function processGroupsOf(process: string): { id: string; patterns: RegExp[] }[] {
  return PROCESS_GROUPS.filter((g) => g.patterns.some((p) => p.test(process)));
}

/** 庄园/处理站指示词：token 含任一词即视为庄园/地块主体（任务 #70） */
const ESTATE_INDICATORS = [
  "庄园",
  "处理站",
  "农场",
  "合作社",
  "finca",
  "farm",
  "estate",
  "plantation",
  "hacienda",
  "station",
  "mill",
];

/**
 * 已知国家/大产区词表（任务 #86）：origin 拆分时先剥离这些词，
 * 剩余非空段才作为庄园/地块候选词。词表不求全，但覆盖常见产销区；
 * 保守原则——宁可不提，也不把国家名当庄园。
 */
const REGION_WORDS = [
  // 国家（中文）
  "埃塞俄比亚",
  "埃塞",
  "肯尼亚",
  "哥伦比亚",
  "哥斯达黎加",
  "巴拿马",
  "危地马拉",
  "洪都拉斯",
  "萨尔瓦多",
  "尼加拉瓜",
  "巴西",
  "秘鲁",
  "墨西哥",
  "印度尼西亚",
  "印尼",
  "也门",
  "卢旺达",
  "布隆迪",
  "坦桑尼亚",
  "乌干达",
  "苏门答腊",
  "云南",
  "中国",
  // 大产区（中文）
  "耶加雪菲",
  "西达摩",
  "西达莫",
  "古吉",
  "罕贝拉",
  "利姆",
  "曼特宁",
  "亚齐",
  "慧兰",
  "惠兰",
  "娜玲珑",
  "塔拉珠",
  "波奎特",
  "圣塔安娜",
  "安提瓜",
  "薇拉",
  // 国家（英文）
  "ethiopia",
  "kenya",
  "colombia",
  "costa rica",
  "panama",
  "guatemala",
  "honduras",
  "el salvador",
  "nicaragua",
  "brazil",
  "peru",
  "mexico",
  "indonesia",
  "sumatra",
  "yemen",
  "rwanda",
  "burundi",
  "tanzania",
  "uganda",
  "china",
  "yunnan",
  // 大产区（英文）
  "yirgacheffe",
  "sidamo",
  "sidama",
  "guji",
  "huila",
  "tarrazu",
  "boquete",
  "antigua",
];

/** 等级/品种等噪声词：origin 剩余段命中时不作为庄园词（防把分级词当庄园） */
const ESTATE_STOP_WORDS = [
  "aa",
  "ab",
  "pb",
  "g1",
  "g2",
  "g3",
  "g4",
  "peaberry",
  "supremo",
  "excelso",
  "heirloom",
  "sl28",
  "sl34",
  "sl24",
  "gesha",
  "geisha",
  "bourbon",
  "caturra",
  "catuai",
  "typica",
  "lot",
  "grade",
  "原生种",
  "混种",
];

/**
 * freeText 结构分段（任务 #117，纯函数可测）：手动豆描述常按
 * 「豆名/型号 · 产地庄园 / 处理法 / 焙度 · 风味」惯例书写，以 · / , 等分隔符切段。
 * seg0 作豆名候选段（freeTextNameSegment），首段之后含已知国别词的段作产地
 * 候选段（freeTextOriginSegment）——无结构化字段时也能提取庄园词与豆名短词。
 */
export function freeTextSegments(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[·・/|／,，;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** freeText 的豆名候选段（任务 #117）：首段（如「波切萨 74158」）；无则空串 */
export function freeTextNameSegment(text: string | undefined): string {
  return freeTextSegments(text)[0] ?? "";
}

/**
 * freeText 的产地候选段（任务 #117，纯函数可测）：首段之后第一个含已知国家/
 * 大产区词的段（如「埃塞俄比亚 阿贝格纳」）视为产地段；「Natural 日晒」等
 * 不含国别词的段不作产地（保守：宁可不提，也不把处理法/风味段当庄园词源）。
 */
export function freeTextOriginSegment(text: string | undefined): string {
  for (const seg of freeTextSegments(text).slice(1)) {
    const lower = seg.toLowerCase();
    if (REGION_WORDS.some((w) => lower.includes(w))) return seg;
  }
  return "";
}

/**
 * 从 origin 字段提取庄园/地块候选词（任务 #86，纯函数）：
 * 「埃塞俄比亚-阿朵斯」这类「国家-庄园/地块」格式，剥离已知国家/大产区词后，
 * 剩余非空段（长度 ≥2、非纯数字、不在等级/品种噪声词表）作为候选词。
 * 保守处理：剥离后无剩余即返回空数组，绝不把国家名当庄园。
 */
function estateCandidatesFromOrigin(origin?: string): string[] {
  if (!origin) return [];
  let text = origin
    .replace(/[·•|｜（）()[\]【】]/g, " ")
    .replace(/[-—_/\\,，、:;；]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return [];
  for (const w of REGION_WORDS) {
    if (/[a-z]/i.test(w)) {
      // 英文词按词边界移除（大小写不敏感，多词如 costa rica 允许空白）
      text = text.replace(new RegExp(`\\b${w.replace(/\s+/g, "\\s+")}\\b`, "gi"), " ");
    } else {
      text = text.split(w).join(" ");
    }
  }
  const out: string[] = [];
  for (const seg of text.split(/\s+/)) {
    const t = seg.trim();
    if (t.length < 2) continue;
    if (/^\d+$/.test(t)) continue;
    if (ESTATE_STOP_WORDS.includes(t.toLowerCase())) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * 从豆名/自由文本/品种字段中提取庄园/地块词（任务 #70，纯函数导出便于测试）：
 * 先清洗标点，再按空白切词，保留含庄园/处理站等指示词的 token
 * （如 “云间庄园”、“Finca El Paraiso”、“Adorsi 处理站”），去重后返回。
 * 任务 #86：追加 origin「国家-庄园」拆分候选词（见 estateCandidatesFromOrigin），
 * 指示词命中的 token 优先（更可靠），origin 候选词附后。
 * 庄园词是最高优先级搜索主体——比“哥伦比亚”式国家级泛词精准得多。
 */
export function extractEstateTokens(input: BeanResearchInput): string[] {
  const out: string[] = [];
  for (const raw of [input.name, input.freeText, input.varietal]) {
    for (const token of keywords(raw).split(/\s+/)) {
      if (!token) continue;
      if (!ESTATE_INDICATORS.some((w) => token.toLowerCase().includes(w))) continue;
      if (!out.includes(token)) out.push(token);
    }
  }
  // 任务 #117：无结构化 origin 时回退 freeText 产地候选段（手动豆庄园词提取）
  const originLike = input.origin || freeTextOriginSegment(input.freeText);
  for (const token of estateCandidatesFromOrigin(originLike)) {
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/** origin 字段拆出的全部豆词（小写，任务 #86）：供打分区分“精确命中”与“国家级泛词命中” */
export function originTokens(input: BeanResearchInput): string[] {
  // 任务 #117：手动豆无结构化 origin 时回退 freeText 产地候选段
  const origin = input.origin || freeTextOriginSegment(input.freeText);
  if (!origin) return [];
  return keywords(origin)
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
}

/**
 * 根据豆信息构造分层搜索词（任务 #70 重构、#80 扩容至 8 条，按精确度降序排列）。
 * researchBean 的搜索循环按数组顺序执行、结果池满即短路，因此分层顺序即降级顺序：
 * 高精确层先命中时，低层兜底天然不会被执行（避免总停在“哥伦比亚”级泛查询）。
 * - Tier 1（庄园/地块）：庄园词 + 烘焙商 + “冲煮参数”（仅当 extractEstateTokens 命中）；
 * - Tier 2（豆名）：烘焙商 + 豆名 + “冲煮建议” / “手冲”；
 * - 平台定向：`site:xiaohongshu.com` + 主题词 + “冲煮参数”（任务 #70 引入、#76 改为 site: 定向语法，
 *   置于 Tier 2 之后）。执行时走专用通道 searchXiaohongshuDirected（任务 #76）：
 *   SearXNG 在线时透传 site: 语法，百度/Bing 实测对 site: 零召回（验证码/拒绝页）不浪费配额，
 *   降级为普通查询 + 域名过滤，仅保留 xiaohongshu.com/xhslink 结果；
 *   小红书笔记正文有登录墙，抓取失败时由搜索 snippet 兜底（见 researchBean）；
 * - Tier 3（产区+品种）：英文产地 + 拉丁词元 + 处理法 + "brew recipe"，
 *   及引号短语锁定词元 + "pour over recipe"；
 * - 论坛定向（任务 #80）：`site:reddit.com` + 主题词 + "brew recipe"（中英文各一条以内，
 *   当前仅英文一条），执行时走 searchRedditDirected（SearXNG 透传 / DDG html+lite 端点，
 *   结果仅保留 reddit.com 域名）；置于 Tier 3 之后、国家级兜底之前；
 * - Tier 4（国家级兜底）：产地 + 主题词 + "咖啡"、无拉丁词元时的英文产地兜底，移到最后。
 * 主题词 = 豆名；无豆名时取自由文本前 3 个词（而非整句）。
 * 无任何有效信息时返回空数组（调用方跳过调研）。
 */
export function buildResearchQueries(input: BeanResearchInput, queryAngle = 0): string[] {
  const tier1: string[] = []; // 庄园/地块（最精确）
  const tier2: string[] = []; // 豆名 + 烘焙商
  const platform: string[] = []; // 平台定向（小红书）
  const forum: string[] = []; // 论坛定向（Reddit，任务 #80）
  const tier3: string[] = []; // 产区 + 品种（英文）
  const tier4: string[] = []; // 国家级兜底（最后执行）

  // 任务 #109-P3：庄园词一次提取贯穿 Tier1/site: 定向/豆名收敛（与 xhsKeywordLadder 一致）
  const estateList = extractEstateTokens(input);
  const estate = estateList[0] ?? "";
  // 任务 #102-P1：豆名分词去重限词；任务 #109-P3：长复合豆名收敛为庄园词/截断短词
  const name = narrowSubjectTokens(input.name, 3, estateList).join(" ");
  const roaster = keywords(input.roaster);
  // 任务 #117：手动豆取 freeText 豆名候选段作主题源（避免产地/处理法词混入主题）
  const free = keywords(freeTextNameSegment(input.freeText) || input.freeText);
  // 主题词：豆名优先；否则取自由文本前 3 个词（避免整句拼接降级到泛结果），同样分词去重（任务 #102-P1）与收敛（任务 #109-P3）
  const subject = name || narrowSubjectTokens(free, 3, estateList).join(" ");

  // 任务 #131：queryAngle 换源重调研策略——
  // angle0 = 默认现状；angle1 = 处理法+产地英文侧重（Tier3 提前、加 washed/natural/anaerobic+产地英）；
  // angle2 = 风味+品种英文侧重（加 tastingNotes+varietal 英、提升 Reddit 优先级）；
  // 字段缺失降级（无 varietal/tastingNotes 时 angle2 回退 angle1 策略）
  if (queryAngle === 1) {
    // angle1：处理法+产地英文侧重——Tier3 前置、注入处理法英文关键词
    const procEn1 = processEnglish(input.process);
    const originEn1 = ORIGIN_EN[keywords(input.origin)] ?? "";
    if (procEn1 || originEn1) {
      tier3.unshift([originEn1, procEn1, "brew recipe", "pour over"].filter(Boolean).join(" "));
    }
  }
  const angle2Effective = queryAngle === 2 && (!!input.varietal || !!input.tastingNotes);
  if (angle2Effective) {
    // angle2：风味+品种英文侧重——加 tastingNotes+varietal 英文关键词、提升 Reddit 优先级
    const tastingEn = (input.tastingNotes ?? "")
      .split(/[、，,；;\/\s]+/)
      .map((t) => t.trim())
      .filter((t) => /[a-z]{3,}/i.test(t));
    const varietalEn = (input.varietal ?? "").split(/\s+/).filter((t) => /[a-z0-9]{2,}/i.test(t));
    if (tastingEn.length > 0 || varietalEn.length > 0) {
      tier3.unshift(
        [...varietalEn.slice(0, 2), ...tastingEn.slice(0, 2), "coffee", "brew recipe"]
          .filter(Boolean)
          .join(" "),
      );
    }
  }

  // ---- Tier 1：庄园/地块词（最高优先级搜索主体，任务 #70）----
  if (estate) {
    tier1.push([estate, roaster, "冲煮参数"].filter(Boolean).join(" "));
  }

  // ---- Tier 2：豆名层（原查询 1、2）----
  if (roaster || subject) {
    tier2.push([roaster, subject, "咖啡豆 冲煮建议"].filter(Boolean).join(" "));
    tier2.push([roaster, subject, "手冲"].filter(Boolean).join(" "));
  }

  // ---- 平台定向：小红书（任务 #70 引入；任务 #76 改为 site: 定向语法；任务 #82 执行时 MCP 直连优先）----
  // 查询串带 site:xiaohongshu.com 前缀，执行阶段由 searchXiaohongshuDirected 专用通道处理：
  // 最高优先级 MCP 直连（search_feeds）；SearXNG 透传 site: 语法；百度/Bing 实测对 site: 零召回（验证码/拒绝页），
  // 自动降级为普通查询 + 域名过滤（仅保留 xiaohongshu.com/xhslink 结果）。
  if (subject || estate) {
    platform.push([XHS_SITE_QUERY, estate || subject, "冲煮参数"].filter(Boolean).join(" "));
  }

  // 拉丁词元：品种/型号/处理站名等（如 SL28/Chiroso/Adorsi），英文资料检索的核心
  const latinTokens = (text: string | undefined): string[] =>
    (text ?? "").split(/\s+/).filter((t) => /[a-z0-9]{2,}/i.test(t));
  const latin = [
    ...new Set([...latinTokens(input.varietal), ...latinTokens(name), ...latinTokens(free)]),
  ];

  // ---- Tier 3：产区 + 品种（英文查询，英文公开资料远多于中文）----
  const originEn = ORIGIN_EN[keywords(input.origin)] ?? "";
  const procEn = processEnglish(input.process);
  if (latin.length > 0) {
    tier3.push([originEn, ...latin.slice(0, 3), procEn, "brew recipe"].filter(Boolean).join(" "));
    // 引号短语锁定品种/处理站名，避免搜索引擎拆词降级到泛结果（任务 #30）
    tier3.push(
      [
        latin.slice(0, 2).length > 1 ? `"${latin.slice(0, 2).join(" ")}"` : latin[0],
        "coffee",
        procEn,
        "pour over recipe",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  // ---- 论坛定向：Reddit（任务 #80）----
  // 中英文各一条以内（Reddit 内容以英文为主，当前仅英文一条；中文主题对 site:reddit.com 无增益）。
  // 查询串带 site:reddit.com 前缀，执行阶段由 searchRedditDirected 专用通道处理。
  if (estate || subject) {
    forum.push([REDDIT_SITE_QUERY, estate || subject, "brew recipe"].filter(Boolean).join(" "));
  }

  // ---- Tier 4：国家级兜底（任务 #70：移到最后，池满时天然不被执行）----
  if (roaster || subject) {
    // 短中文兜底：仅产地+豆名+咖啡，避免修饰词过多拖垮中文搜索召回
    // 任务 #117：手动豆无结构化 origin 时回退 freeText 产地候选段
    tier4.push(
      [keywords(input.origin || freeTextOriginSegment(input.freeText)), subject, "咖啡"]
        .filter(Boolean)
        .join(" "),
    );
  }
  if (latin.length === 0 && originEn) {
    // 无拉丁词元时退一步：英文产地 + 处理法 + pour over（宽松英文召回）
    tier4.push([originEn, procEn, "pour over recipe"].filter(Boolean).join(" "));
  }

  // angle2 生效时提升 Reddit 优先级（论坛定向前置），angle1 不调整 Reddit 位置
  const queries = angle2Effective
    ? [...tier1, ...tier2, ...forum, ...platform, ...tier3, ...tier4]
    : [...tier1, ...tier2, ...platform, ...tier3, ...forum, ...tier4];
  return [...new Set(queries)].slice(0, RESEARCH_MAX_QUERIES);
}

// ---------------------------------------------------------------------------
// 相关性打分与过滤（任务 #26）
// ---------------------------------------------------------------------------

/** 咖啡/冲煮域词：命中加分，用于识别“这是咖啡内容” */
export const COFFEE_DOMAIN_WORDS = [
  "咖啡",
  "咖啡豆",
  "烘焙",
  "冲煮",
  "手冲",
  "研磨",
  "水温",
  "粉水比",
  "风味",
  "产区",
  "处理法",
  "coffee",
  "brew",
  "brewing",
  "roast",
  "recipe",
  "grind",
  "pour over",
  "pourover",
  "espresso",
  "cupping",
  "flavor",
  "specialty",
  // 任务 #125：v60/aeropress/chemex/kalita 等他滤杯词从域词移除——
  // 这些是特定器具专名而非泛咖啡域词，作为域词会与 foreignDripperTitleSignal 拦截冲突
  // （纯 V60 泛攻略因 v60 域词加分被保留，与拦截逻辑矛盾）
];

/** 明显无关的平台/通用词：命中直接判无关（“canva可画 - 百度知道”类垃圾结果） */
export const RESEARCH_BLACKLIST_WORDS = [
  "canva",
  "可画",
  "百度知道",
  "知乎",
  "csdn",
  "博客园",
  "视频模板",
  "简历",
  "ppt",
  "壁纸",
  "小说",
  "招聘",
  "weather",
  "股票",
];

/** 豆词集合：豆名/烘焙商/产地/处理法/品种去重后的关键词 */
export function beanTokens(input: BeanResearchInput): string[] {
  const tokens: string[] = [];
  // 任务 #117：手动豆（仅 freeText）无结构化字段——豆名候选段+产地候选段词
  // 并入豆词，否则 tight 模式把所有来源当泛来源（beanHits=0），SEO 泛页凭
  // 2 域词阈值留存、含豆名精确来源的排序优势也丧失
  for (const raw of [
    input.name,
    input.roaster,
    input.origin,
    input.process,
    input.varietal,
    freeTextNameSegment(input.freeText),
    freeTextOriginSegment(input.freeText),
  ]) {
    if (!raw) continue;
    for (const t of keywords(raw)
      .split(/\s+/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length >= 2)) {
      if (!tokens.includes(t)) tokens.push(t);
    }
  }
  return tokens;
}

/** 小红书域名定向语法前缀（任务 #76）：buildResearchQueries 的平台查询以此为开头 */
export const XHS_SITE_QUERY = "site:xiaohongshu.com";

/**
 * 小红书域名精确判定（任务 #98 防仿冒）：仅 xiaohongshu.com / xhslink.com 本身
 * 或其真子域命中；notxiaohongshu.com、xiaohongshu.com.evil.com 等仿冒域名不命中，
 * 非法 URL 返回 false。
 */
function isXhsHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "xiaohongshu.com" ||
      host.endsWith(".xiaohongshu.com") ||
      host === "xhslink.com" ||
      host.endsWith(".xhslink.com")
    );
  } catch {
    return false;
  }
}

/**
 * 判断来源是否为小红书（任务 #70；任务 #98：改为解析后 hostname 精确判定——
 * 旧实现 url+title 拼接子串匹配，标题提及 xiaohongshu.com 即误判）。
 */
function isXiaohongshu(src: ResearchSource): boolean {
  return isXhsHost(src.url);
}

/** 判断查询是否为小红书 site: 定向查询（任务 #76，纯函数可测） */
export function isXhsDirectedQuery(query: string): boolean {
  return query.toLowerCase().includes(XHS_SITE_QUERY);
}

/**
 * site: 定向查询 → MCP search_feeds 关键词（任务 #82，纯函数可测）：
 * 去掉 `site:xiaohongshu.com` 前缀（MCP 平台内搜索不需要 site: 语法），
 * 保留豆名/庄园词 + 冲煮参数等主题词。
 */
export function xhsMcpKeyword(siteQuery: string): string {
  return siteQuery
    .replace(new RegExp(XHS_SITE_QUERY.replace(/\./g, "\\."), "i"), "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 小红书定向检索结果（任务 #82）：via 记录实际命中的渠道，供如实披露 */
export interface XhsDirectedOutcome {
  sources: ResearchSource[];
  /** mcp = MCP 直连命中；fallback = site: 透传/域名过滤渠道 */
  via: "mcp" | "fallback";
  /** 任务 #83：MCP 报未登录/凭证失效类错误（前端据此提醒扫码续期） */
  loginExpired?: boolean;
  /** 任务 #86：MCP 直连实际命中的关键词变体（如实披露） */
  mcpKeywordUsed?: string;
  /** 任务 #86：MCP 直连尝试过的关键词变体列表（未命中时供总结如实披露） */
  mcpTried?: string[];
  /**
   * 任务 #98：是否至少一次 MCP 调用成功建立连接（search_feeds 正常返回，
   * 含零召回）。披露文案据此区分「MCP 在线但零召回」与「尝试连接即超时/失败」，
   * 绝不预设在未建立过连接时宣称在线。
   */
  mcpOnline: boolean;
  /**
   * 任务 #102-P3：是否因 search_feeds 执行超时终止 MCP 梯队（披露措辞据此
   * 精确区分「探活在线但搜索执行超时」与「未能连接/报错」；
   * 任务 #98 前统一写「连接超时/报错」不准确）。
   */
  mcpSearchTimeout?: boolean;
}

/**
 * 小红书 MCP 关键词变体梯队（任务 #86，纯函数可测；任务 #102-P1 加固）：
 * 窄词零召回时逐级放宽——① 豆名/庄园词+冲煮参数 → ② 豆名/庄园词+手冲
 * → ③ 产地（剥离庄园/地块词与主题词，避免窄词重复）+处理法+手冲
 * → ④ 兜底放宽档：纯豆名（或 subject 首词）+手冲（任务 #102-P1：origin/process
 * 缺失或第三档因字段缺失无法构造时的最后防线）。梯队任一命中即停，
 * 顺序语义：精确档在前、放宽档在后；主题词经 narrowSubjectTokens 去重限词
 * （实测超长重复关键词令 search_feeds 服务端挂死 1m+，短词「阿朵斯」反而召回 19 条）。
 */
export function xhsKeywordLadder(input: BeanResearchInput): string[] {
  const estates = extractEstateTokens(input);
  const estate = estates[0] ?? "";
  // 豆名优先于庄园词：豆名是小红书等平台的主检索词（如「花魁」「阿朵斯」），
  // 庄园/地块词更精确但检索命中率低，仅在无豆名时作主题；豆名分词去重限词（任务 #102-P1）；
  // 任务 #109-P3：长复合豆名收敛为庄园词（与 site: 定向查询的庄园词一致），梯队首档同步使用该收敛结果
  const name = narrowSubjectTokens(input.name, 3, estates).join(" ");
  // 任务 #117：手动豆无结构化豆名——取 freeText 豆名候选段（如「波切萨 74158」）
  // 作主题；庄园词不作 subject（实测庄园词作主题召回率低于豆名短词），改走独立档
  const free = narrowSubjectTokens(
    freeTextNameSegment(input.freeText) || input.freeText,
    3,
    estates,
  ).join(" ");
  const subject = name || free || estate;
  const ladder: string[] = [];
  if (subject) {
    ladder.push(`${subject} 冲煮参数`);
    ladder.push(`${subject} 手冲`);
  }
  // 任务 #117：庄园词独立档——「阿贝格纳」式庄园词进入 MCP 梯队
  // （此前仅出现在 site: 查询串，search_feeds 从未尝试过庄园词）
  if (estate && !subject.split(/\s+/).includes(estate)) ladder.push(`${estate} 冲煮参数`);
  // 放宽档：产地剥离庄园/地块词与主题词（避免「阿朵斯 埃塞俄比亚 阿朵斯」式重复）+ 处理法 + 手冲
  const estateSet = new Set(estates.map((e) => e.toLowerCase()));
  const subjectSet = new Set(
    subject
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.toLowerCase()),
  );
  // 任务 #117：手动豆无结构化 origin 时回退 freeText 产地候选段
  const originLike = input.origin || freeTextOriginSegment(input.freeText);
  const originBroad = keywords(originLike)
    .split(/\s+/)
    .filter((t) => t && !estateSet.has(t.toLowerCase()) && !subjectSet.has(t.toLowerCase()))
    .join(" ");
  const proc = keywords(input.process);
  const broad = [originBroad, proc, "手冲"].filter(Boolean).join(" ");
  if (originBroad) ladder.push(broad);
  // 兜底放宽档（任务 #102-P1）：纯豆名/subject 首词 + 手冲——与既有档重复时由去重消除
  const first = subject.split(/\s+/).filter(Boolean)[0] ?? "";
  if (first) ladder.push(`${first} 手冲`);
  return [...new Set(ladder)];
}

/**
 * 超时冷却后的一次兜底档关键词（任务 #109-P4，纯函数可测）：取梯队末档
 * （xhsKeywordLadder 保证末档为「纯豆名/庄园词 + 手冲」短词档，≤NARROW_TOKEN_MAX_LEN
 * 主题词）。实测缺陷：冷却语义使首档超时后剩余各档（含短词档）全部放弃，
 * 3/4 豆因此零命中；故超时后允许再打一次兜底档，仍超时才彻底放弃渠道。
 * 末档已在已尝试变体中（如超时发生在末档本身）时返回空串（不重复）。
 */
export function xhsTimeoutFallbackKeyword(variants: string[], tried: string[]): string {
  const last = variants[variants.length - 1] ?? "";
  if (!last || tried.includes(last)) return "";
  return last;
}

/**
 * 小红书渠道来源假命中判定（任务 #109-P2，纯函数可测）：入池/计命中前，
 * 相关性在咖啡域词之上额外要求豆名或主题词（narrowSubjectTokens 产物/庄园词）
 * 在标题或正文（snippet）命中；不满足者不入池、不计入 xhsHits（实测缺陷：
 * 「沐乐果」搜出「Vibe coding 咖啡冲煮程序」「xbloom 机主」等与豆无关笔记
 * 仍计入「命中 6 条」）。无任何可用信号词时保守放行（无判定依据不误杀）。
 */
export function xhsNoteRelevant(src: ResearchSource, input: BeanResearchInput): boolean {
  const estates = extractEstateTokens(input);
  const signals: string[] = [];
  for (const t of [
    ...narrowSubjectTokens(input.name, 3, estates),
    ...narrowSubjectTokens(freeTextNameSegment(input.freeText) || input.freeText, 3, estates),
    ...estates,
  ]) {
    // 任务 #117：复合短词（「波切萨 74158」）拆出子词一并作信号，
    // 防仅含豆名（不含型号）的真实笔记被假命中判定误拦
    for (const part of [t, ...t.split(/\s+/).filter((p) => p !== t)]) {
      const k = part.trim().toLowerCase();
      if (k.length >= 2 && !signals.includes(k)) signals.push(k);
    }
  }
  if (signals.length === 0) return true; // 无信号词可要求：保守不拦截
  const text = `${src.title}\n${src.snippet ?? ""}`.toLowerCase();
  return signals.some((t) => text.includes(t));
}

/**
 * 抓取名额分配（任务 #109-P1，纯函数可测）：kept 按分数降序，小红书（MCP 命中）
 * 来源优先占用抓取名额——至少占 min(小红书来源数, XHS_FETCH_RESERVED_SEATS) 席，
 * 其余名额按原分数顺序补足（实测缺陷：沐乐果 MCP 直连召回 6 条笔记入池但排在
 * web 结果之后，RESEARCH_MAX_FETCH=4 被 FB/IG 泛页占满，笔记正文从未进入摘要）。
 * 无小红书来源或候选数 ≤ 名额时行为与 slice(0, maxFetch) 一致。
 * 任务 #113：可选传入 scores（来源→相关性分数，由 filterRelevantSources 产出）时，
 * 保留席仅在其分数不低于将被顶替的边界来源（kept[maxFetch-1]）分数时才顶替，
 * 避免低质笔记挤出高分权威来源；池中无更高分竞争者时（同分或更高）照旧保留。
 * 不传 scores 时行为与任务 #109-P1 一致（向后兼容）。
 */
export function pickFetchQuota(
  kept: ResearchSource[],
  maxFetch: number,
  scores?: ReadonlyMap<ResearchSource, number>,
): ResearchSource[] {
  if (kept.length <= maxFetch) return kept.slice(0, maxFetch);
  const xhs = kept.filter(isXiaohongshu);
  if (xhs.length === 0) return kept.slice(0, maxFetch);
  // 任务 #113：分数保护——只有分数不低于边界来源的小红书来源才有资格占保留席
  let reservedPool = xhs;
  if (scores) {
    const boundaryScore = scores.get(kept[maxFetch - 1]) ?? Number.NEGATIVE_INFINITY;
    reservedPool = xhs.filter((s) => (scores.get(s) ?? Number.NEGATIVE_INFINITY) >= boundaryScore);
  }
  const reserved = Math.min(reservedPool.length, XHS_FETCH_RESERVED_SEATS);
  if (reserved === 0) return kept.slice(0, maxFetch);
  const picked = reservedPool.slice(0, reserved);
  const headSet = new Set<ResearchSource>(picked);
  for (const s of kept) {
    if (picked.length >= maxFetch) break;
    if (headSet.has(s)) continue;
    picked.push(s);
  }
  return picked;
}

/**
 * Reddit 域名定向语法前缀（任务 #80）：buildResearchQueries 的论坛查询以此为开头。
 * Reddit 是手冲参数内容密度最高的论坛（r/pourover、r/espresso、r/coffee）。
 */
export const REDDIT_SITE_QUERY = "site:reddit.com";

/** 判断查询是否为 Reddit site: 定向查询（任务 #80，纯函数可测） */
export function isRedditDirectedQuery(query: string): boolean {
  return query.toLowerCase().includes(REDDIT_SITE_QUERY);
}

/**
 * 判断来源是否为论坛域名（任务 #80）：reddit.com（含 old./www 等子域）或 home-barista.com。
 * 仿冒域名（reddit.com.evil.com 等）不命中——按域名后缀匹配而非字符串包含。
 */
export function isForumSource(src: ResearchSource): boolean {
  try {
    const host = new URL(src.url).hostname.toLowerCase();
    return (
      host === "reddit.com" || host.endsWith(".reddit.com") || host.endsWith("home-barista.com")
    );
  } catch {
    return false;
  }
}

/**
 * xBloom 官方域名判定（任务 #113，纯函数可测）：官网本身或其真子域
 * （如 share-h5.xbloom.com 分享配方页）；notxbloom.com、
 * xbloom.com.evil.com 等仿冒域名不命中；非法 URL 返回 false。
 */
export function isOfficialXbloomSource(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "xbloom.com" || host.endsWith(".xbloom.com");
  } catch {
    return false;
  }
}

/**
 * 烘焙商文本信号（任务 #113，纯函数可测）：烘焙商名经 keywords 同款归一化拆词
 * （≥2 字符）后，任一词出现在标题/摘要即命中。用于 tight 模式豁免：
 * 烘焙商官网参数表标题未必含豆名，但含烘焙商名本身即是强相关信号。
 * 未提供烘焙商或拆词为空时返回 false（无信号不豁免）。
 */
export function roasterTextSignalHit(src: ResearchSource, roaster: string | undefined): boolean {
  const words = keywords(roaster)
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 2);
  if (words.length === 0) return false;
  const text = `${src.title}\n${src.snippet ?? ""}`.toLowerCase();
  return words.some((w) => text.includes(w));
}

/**
 * Reddit 结果域名过滤（任务 #80）：仅保留 URL 域名为 reddit.com 及其子域的结果
 * （www./old. 均命中；仿冒域名 reddit.com.evil.com 不命中）。
 * site: 语法在免 key 渠道零召回时的替代方案——只让真 Reddit 帖子进入来源池。
 * 任务 #86：域名过滤之上另加领域护栏 filterRedditCoffeeSources（版块+内容相关性），
 * 防 r/cocktails 等非咖啡版块帖混入。
 */
export function filterRedditDomainSources(sources: ResearchSource[]): ResearchSource[] {
  return sources.filter((src) => {
    try {
      const host = new URL(src.url).hostname.toLowerCase();
      return host === "reddit.com" || host.endsWith(".reddit.com");
    } catch {
      return false;
    }
  });
}

/** 咖啡主题版块（任务 #86）：来自这些 r/ 的帖子直接放行（版块即领域承诺） */
export const COFFEE_SUBREDDITS = ["pourover", "coffee", "espresso", "jameshoffmann", "barista"];

/**
 * 咖啡强信号词（任务 #86）：标题/摘要命中任一即视为咖啡内容。
 * 注意不含 brew/brewing/recipe 等泛词——鸡尾酒帖也讲 brew，
 * 泛词单独出现不足以通过，要求咖啡上下文共现（或来自咖啡版块）。
 */
export const REDDIT_COFFEE_STRONG_WORDS = [
  "coffee",
  "咖啡",
  "pour over",
  "pourover",
  "v60",
  "espresso",
  "aeropress",
  "chemex",
  "kalita",
  "origami",
  "手冲",
  "冲煮",
  "研磨",
  "粉水比",
];

/** 非咖啡主题反信号词（任务 #86）：命中即拒绝（“espresso martini cocktail”类鸡尾酒帖） */
export const REDDIT_ANTI_WORDS = ["cocktail", "鸡尾酒"];

/** URL 路径中的版块名（/r/<sub>/...，纯函数可测）；非 reddit 路径返回空串 */
export function redditSubOf(url: string): string {
  try {
    const m = new URL(url).pathname.match(/\/r\/([^/]+)/i);
    return m ? m[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * Reddit 来源咖啡领域相关性（任务 #86，纯函数可测）：
 * 反信号词（cocktail/鸡尾酒）命中即拒；咖啡版块直接放行；
 * 其余要求标题/摘要含咖啡强信号词（brew 等泛词不算）。
 */
export function isRedditCoffeeRelevant(src: ResearchSource): boolean {
  const text = `${src.title} ${src.snippet ?? ""}`.toLowerCase();
  if (REDDIT_ANTI_WORDS.some((w) => text.includes(w))) return false;
  if (COFFEE_SUBREDDITS.includes(redditSubOf(src.url))) return true;
  return REDDIT_COFFEE_STRONG_WORDS.some((w) => text.includes(w));
}

/**
 * Reddit 领域护栏过滤（任务 #86）：域名过滤 + 咖啡相关性双重约束。
 * 实测 r/cocktails「鸡尾酒食谱」仅过域名关就混入来源第一位，
 * 故加此护栏：非咖啡版块且标题/摘要无咖啡强信号词的帖子丢弃。
 */
export function filterRedditCoffeeSources(sources: ResearchSource[]): ResearchSource[] {
  return filterRedditDomainSources(sources).filter(isRedditCoffeeRelevant);
}

/**
 * 正文抓取 URL 重写（任务 #80）：www.reddit.com → old.reddit.com。
 * www 新壳页对 bot UA 返回 403/JS 空壳，old. 旧前端提供静态 HTML 免 key 可读正文；
 * 仅 Reddit 域名生效，其他 URL 原样返回（纯函数可测）。
 */
export function redditFetchUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.hostname.toLowerCase() === "www.reddit.com") {
      u.hostname = "old.reddit.com";
      return u.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

/**
 * 小红书结果域名过滤（任务 #76）：仅保留 URL 域名含 xiaohongshu.com / xhslink 的结果。
 * site: 语法在免 key 渠道零召回时的替代方案——普通查询结果中混入的
 * 博客/百科/游戏站等噪声被丢弃，只有真小红书笔记（标题+snippet）进入来源池。
 */
export function filterXhsDomainSources(sources: ResearchSource[]): ResearchSource[] {
  // 任务 #98：isXhsHost 精确域名判定，notxiaohongshu.com 等后缀仿冒域名不再绕过
  return sources.filter((src) => isXhsHost(src.url));
}

/**
 * 单条来源相关性打分（纯函数，可测）：
 * - 黑名单词命中（标题+URL）→ -100，必丢；
 * - 庄园/地块词命中：每个 +5（任务 #70，高于豆词，确保庄园级精准来源排前）；
 * - 豆词命中：每个 +2（首个 +3），标题权重高于 URL；
 * - 处理法信号（任务 #86）：匹配处理法出现在标题 +3；冲突处理法出现在标题
 *   -12（主题级强降权，总分低于阈值即过滤）；标题同时含匹配与冲突处理法（对比文）
 *   -6 不判死刑；冲突处理法仅出现在摘要 -3（顺带提及不误杀）；
 * - 国家级泛文降权（任务 #86）：庄园词已提取但来源只有国家/大产区泛词命中
 *   （无庄园/豆名精确命中）→ -4，确保过滤名额与截取名额优先给精确来源；
 * - 小红书域名命中（xiaohongshu.com / xhslink）：+3（任务 #70），且直接保留；
 * - 咖啡域词命中：每个 +1；
 * 保留规则（任务 #30 放宽）：域名不在黑名单且标题/摘要含任一咖啡域词即保留为
 * 弱相关（不要求同时命中豆词）；黑名单与零域词命中才丢弃；任务 #86：
 * 标题级处理法冲突且总分低于阈值时即使有域词命中也强制丢弃（小红书/论坛保留同样被覆盖）。
 * 排序仍按总分降序，豆词命中的高分来源自然排前，由 RESEARCH_MAX_SOURCES 截断取 top N。
 * estateTokens 为可选参数（向后兼容），由 filterRelevantSources 传入；
 * opts.process 启用处理法冲突检测，opts.originTokens 用于区分精确命中与国家级泛词命中；
 * opts.tight（任务 #109-P6，researchBean 专用）：Tier2+ 泛来源收紧——域词命中但
 * 无任何豆词信号（beanHits=0，即无豆名/产地/品种任一信号）时降权 -2 且保留阈值
 * 提高到 ≥2 个域词，防泛文（期货新闻/意式拼配科普等）挤占摘要席位；
 * 小红书（假命中已在入池前拦截）与论坛直接保留不受影响；不传时行为与任务 #30 一致；
 * 任务 #113：opts.roaster 启用 tight 模式的官方/烘焙商豁免——xBloom 官方域
 * （isOfficialXbloomSource）或烘焙商名命中（roasterTextSignalHit）的来源与
 * 小红书/论坛同等待遇，不含豆名的官方冲煮指南/烘焙商参数表不被丢弃；
 * 任务 #119：豁免加约束——标题/摘要命中国别冲突（opts.origin 归族，豆国同时
 * 出现属对比文不判冲突）的来源不享受官方/烘焙商豁免；标题命中他豆强信号
 * （foreignBeanTitleSignal）不享受烘焙商豁免；烘焙商名命中但标题/摘要无本豆
 * 豆词信号（tightExemptionBeanWords，营销泛页）tight 下直接丢弃；
 * opts.beanNameTerms（filterRelevantSources 透传 beanNameTermsOf 产物）供复合豆名滑窗与组成部分判定；
 * 任务 #102-P2：opts.origin 启用国别一致性校验（实测哥伦比亚豆混入产地为
 * 玻利维亚的小红书笔记 3 条）——冲突国名出现在标题强降权乃至过滤、
 * 仅摘要提及降权不判死刑、保留但不符者返回 originMismatch 供摘要披露。
 */
export function scoreSourceRelevance(
  src: ResearchSource,
  tokens: string[],
  estateTokens: string[] = [],
  opts: {
    process?: string;
    originTokens?: string[];
    origin?: string;
    tight?: boolean;
    /** 烘焙商名（任务 #113）：tight 模式官方/烘焙商豁免的文本信号来源 */
    roaster?: string;
    /** 豆名/品种词元（任务 #119）：豁免收紧的复合豆名滑窗与他豆组成部分判定 */
    beanNameTerms?: string[];
  } = {},
): {
  score: number;
  beanHits: number;
  kept: boolean;
  originMismatch?: boolean;
  dripperSignal?: string;
} {
  const title = src.title.toLowerCase();
  const url = src.url.toLowerCase();
  if (RESEARCH_BLACKLIST_WORDS.some((w) => title.includes(w) || url.includes(w))) {
    return { score: -100, beanHits: 0, kept: false };
  }
  let beanHits = 0;
  let estateHits = 0;
  let preciseHits = 0; // 庄园/豆名精确命中（排除 origin 国家级泛词），任务 #86
  let score = 0;
  // 任务 #102-P3：跳转链接来源（baidu.com/link 等无法溯源）降权不硬删，避免误杀
  if (isRedirectLinkSource(src.url)) score += REDIRECT_LINK_PENALTY;
  // 庄园/地块词命中加权（任务 #70）：+5/个，高于豆词的 +2/+3
  for (const e of estateTokens) {
    const t = e.toLowerCase();
    if (title.includes(t) || url.includes(t)) {
      beanHits += 1;
      estateHits += 1;
      preciseHits += 1;
      score += 5 + (title.includes(t) ? 1 : 0);
    }
  }
  const originSet = (opts.originTokens ?? []).map((t) => t.toLowerCase());
  for (const t of tokens) {
    const inTitle = title.includes(t);
    const inUrl = url.includes(t);
    if (inTitle || inUrl) {
      beanHits += 1;
      score += (beanHits === 1 ? 3 : 2) + (inTitle ? 1 : 0);
      if (!originSet.includes(t)) preciseHits += 1;
    }
  }
  // 国家级泛文降权（任务 #86）：庄园词已知但来源无任何精确命中 → 明显低于精确来源
  if (estateTokens.length > 0 && estateHits === 0 && preciseHits === 0) {
    score += GENERIC_ORIGIN_PENALTY;
  }
  let domainHits = 0;
  for (const w of COFFEE_DOMAIN_WORDS) {
    if (title.includes(w) || url.includes(w)) domainHits += 1;
  }
  score += domainHits;
  // 处理法冲突检测（任务 #86）：标题级冲突强降权；仅摘要提及只降权不判死刑
  let titleConflictHard = false;
  if (opts.process) {
    const beanGroups = processGroupsOf(opts.process);
    if (beanGroups.length > 0) {
      const snippet = (src.snippet ?? "").toLowerCase();
      const conflictGroups = PROCESS_GROUPS.filter((g) => !beanGroups.includes(g));
      const titleMatch = beanGroups.some((g) => g.patterns.some((p) => p.test(title)));
      const titleConflict = conflictGroups.some((g) => g.patterns.some((p) => p.test(title)));
      if (titleMatch) score += PROCESS_MATCH_TITLE_BONUS;
      if (titleConflict) {
        if (titleMatch) {
          // 标题同时提及自身处理法（对比/综述文）：中等降权，不判死刑
          score += PROCESS_CONFLICT_MIXED_PENALTY;
        } else {
          // 冲突处理法为主题：强降权，总分不达标即过滤（如水洗豆遇“厌氧发酵法”标题）
          score += PROCESS_CONFLICT_TITLE_PENALTY;
          titleConflictHard = true;
        }
      } else if (conflictGroups.some((g) => g.patterns.some((p) => p.test(snippet)))) {
        // 摘要顺带提及冲突处理法（对比语境）：降权不作死刑
        score += PROCESS_CONFLICT_SNIPPET_PENALTY;
      }
    }
  }
  // 国别/产地一致性校验（任务 #102-P2）：模式同 PROCESS_GROUPS 冲突降权——
  // 标题级冲突强降权（总分不达标即过滤）；标题同时提及豆国（对比/综述文）中等降权
  // 不判死刑；仅摘要提及冲突国降权并标记 originMismatch 供摘要披露提示交叉验证
  let originConflictHard = false;
  let originMismatch = false;
  if (opts.origin) {
    const beanCountries = countryGroupsOf(opts.origin);
    if (beanCountries.length > 0) {
      const snippet = (src.snippet ?? "").toLowerCase();
      const conflictCountries = COUNTRY_GROUPS.filter((g) => !beanCountries.includes(g));
      const titleConflict = conflictCountries.some((g) => g.patterns.some((p) => p.test(title)));
      if (titleConflict) {
        const beanInText = beanCountries.some((g) => g.patterns.some((p) => p.test(title)));
        if (beanInText) {
          // 标题同时提及豆国与冲突国（对比/综述文）：中等降权，不判死刑
          score += ORIGIN_CONFLICT_MIXED_PENALTY;
        } else {
          // 冲突国为主题：强降权，总分不达标即过滤（如哥伦比亚豆遇「玻利维亚瓦利基」标题）
          score += ORIGIN_CONFLICT_TITLE_PENALTY;
          originConflictHard = true;
          originMismatch = true;
        }
      } else if (conflictCountries.some((g) => g.patterns.some((p) => p.test(snippet)))) {
        // 摘要提及冲突国（产地与豆档案不符）：降权不作死刑，保留但披露提示
        score += ORIGIN_CONFLICT_SNIPPET_PENALTY;
        originMismatch = true;
      }
    }
  }
  // 小红书域名加权（任务 #70）：平台定向查询的预期来源，+3 且直接保留
  const xhs = isXiaohongshu(src);
  if (xhs) score += 3;
  // 论坛域名加权（任务 #80）：reddit.com / home-barista.com 真论坛结果 +3 且直接保留，
  // 防误杀——论坛帖标题未必命中豆词/咖啡域词，但内容是高价值冲煮参数讨论
  const forum = isForumSource(src);
  if (forum) score += 3;
  // 任务 #86：小红书笔记标题常不含咖啡域词（如「☕️2」「深夜手冲10g浆一杯」），
  // 域名命中即保留是其设计意图（见上注 +3 且直接保留），否则 MCP 真召回会在过滤环节全部被丢弃
  // 任务 #109-P6：tight 模式下，非小红书/论坛来源域词命中但无任何豆词信号（豆名/产地/品种）
  // → 降权且保留阈值提高，防泛文挤占摘要（小红书假命中已在入池前由 xhsNoteRelevant 拦截）
  // 任务 #113：官方/烘焙商来源与小红书/论坛同等待遇——xBloom 官方域（冲煮指南常不含
  // 豆名）与烘焙商名命中来源（参数表常只含烘焙商名）在 tight 模式下豁免泛来源收紧，
  // 避免不含豆名的官方冲煮指南/烘焙商参数表被丢弃
  // 任务 #119：豁免加约束（实测他豆烘焙商页与营销泛页因 #113 无条件豁免混入来源）：
  // ① 标题/摘要命中国别冲突（豆国同时出现属对比文不判冲突）不享受官方/烘焙商豁免；
  // ② 标题命中他豆强信号（他豆品种/豆名专词且标题无本豆任何豆词）不享受烘焙商豁免；
  // ③ 烘焙商名命中但无任何本豆豆词信号（营销泛页）tight 下直接丢弃；
  // 本豆烘焙商页（含豆名/庄园词，含长复合豆名三元滑窗子词如「奇洛索」）仍豁免保留
  // 任务 #125：他滤杯拦截——foreignDripperTitleSignal：
  // pure（纯他滤杯泛攻略，不含本豆豆词）tight 下硬拦截，不享受烘焙商/官方豁免；
  // mixed（含本豆名+他滤杯策略）保留但打 dripperSignal 标记供 generate.ts 转换标注；
  // xBloom 官方滤杯词豁免不判为他滤杯。
  const lowerText = `${title}\n${(src.snippet ?? "").toLowerCase()}`;
  const beanCountryGroups = opts.origin ? countryGroupsOf(opts.origin) : [];
  const exemptOriginConflict =
    beanCountryGroups.length > 0 &&
    COUNTRY_GROUPS.filter((g) => !beanCountryGroups.includes(g)).some((g) =>
      g.patterns.some((p) => p.test(lowerText)),
    ) &&
    !beanCountryGroups.some((g) => g.patterns.some((p) => p.test(lowerText)));
  const exemptionBeanWords = tightExemptionBeanWords(tokens, estateTokens, {
    roaster: opts.roaster,
    beanNameTerms: opts.beanNameTerms,
  });
  // 无豆词信号可判时保守不拦（豁免照旧、不判他豆、不丢营销页）
  const exemptionBeanHitText =
    exemptionBeanWords.length === 0 ? true : exemptionBeanWords.some((w) => lowerText.includes(w));
  // foreignBeanTitleSignal 内部已对空豆词集保守返回 false，无需额外守卫
  const foreignBeanSignal = foreignBeanTitleSignal(src, exemptionBeanWords, opts.beanNameTerms);
  // 任务 #125：他滤杯信号判定（同 foreignBeanTitleSignal 的豁免加约束哲学）
  const dripperSignal = foreignDripperTitleSignal(src, exemptionBeanWords, opts.beanNameTerms);
  const roasterHit = roasterTextSignalHit(src, opts.roaster);
  const officialExempt = isOfficialXbloomSource(src.url) && !exemptOriginConflict;
  const roasterExempt =
    roasterHit && exemptionBeanHitText && !exemptOriginConflict && !foreignBeanSignal;
  const officialOrRoaster = officialExempt || roasterExempt;
  const genericOnly = opts.tight === true && !xhs && !forum && !officialOrRoaster && beanHits === 0;
  if (genericOnly) score += GENERIC_DOMAIN_ONLY_PENALTY;
  let kept = xhs || forum || domainHits >= RELEVANCE_DOMAIN_ONLY_MIN; // 任务 #30：任一域词命中即弱相关保留
  // 任务 #113：tight 下官方/烘焙商来源直接保留（仅 tight 生效，非 tight 行为逐字节不变）
  // 任务 #119：仅已通过上述约束的豁免来源才直接保留
  if (opts.tight === true && officialOrRoaster) kept = true;
  if (genericOnly && domainHits < TIGHT_DOMAIN_ONLY_MIN) kept = false;
  // 任务 #119：烘焙商营销泛页——烘焙商名命中但标题/摘要无任何本豆豆词信号（如
  // 「当咖啡遇上实验室…红酒|烘焙|抹茶|芒果|冰滴」）tight 下直接丢弃（非 tight 不变）
  if (
    opts.tight === true &&
    !xhs &&
    !forum &&
    roasterHit &&
    exemptionBeanWords.length > 0 &&
    !exemptionBeanHitText
  ) {
    kept = false;
  }
  // 任务 #119：他豆强信号硬过滤——标题命中他豆品种/豆名专词且不含本豆任何豆词信号
  // （foreignBeanTitleSignal，如「巴拿马翡翠庄园绿标瑰夏」「哥伦比亚大肚脐」）。此类来源
  // 即便因同国国名/咖啡域词拿到 beanHits/domainHits 也应零保留——标题明确指向另一支豆，
  // 对本豆冲煮无参考价值。foreignBeanTitleSignal 对空豆词集已保守返回 false，不误杀。
  // 仅 tight（researchBean）生效，非 tight 行为逐字节不变。
  if (opts.tight === true && foreignBeanSignal) kept = false;
  // 任务 #125：他滤杯硬过滤——纯他滤杯泛攻略（不含本豆任何豆词）tight 下零保留。
  // 此类来源标题明确指向他滤杯通用攻略（如「V60 冲煮入门指南」），对本豆冲煮无参考价值；
  // foreignDripperTitleSignal 对空豆词集已保守返回 none，不误杀；
  // xBloom 官方滤杯词豁免不判为他滤杯。仅 tight 生效，非 tight 逐字节不变。
  if (opts.tight === true && dripperSignal.kind === "pure") kept = false;
  // 任务 #125：含本豆名+他滤杯策略来源保留但打 dripperSignal 标记——
  // tight 下不拦截（标题含本豆豆词说明确实与本豆相关），标记透传给 generate.ts 转换标注。
  // 非 tight 下也保留但返回 dripperSignal（向后兼容：字段可选，不影响现有逻辑）。
  const dripperTag = dripperSignal.kind === "mixed" ? dripperSignal.dripper : undefined;
  // 任务 #86：标题级处理法冲突且总分低于阈值 → 强制丢弃（覆盖小红书/论坛直接保留）
  if (titleConflictHard && score < PROCESS_CONFLICT_KEEP_THRESHOLD) kept = false;
  // 任务 #102-P2：标题级国别冲突且总分低于阈值 → 强制丢弃（同上，覆盖直接保留）
  if (originConflictHard && score < ORIGIN_CONFLICT_KEEP_THRESHOLD) kept = false;
  return {
    score,
    beanHits,
    kept,
    ...(originMismatch ? { originMismatch: true } : {}),
    ...(dripperTag ? { dripperSignal: dripperTag } : {}),
  };
}

/**
 * 过滤+按分数降序排序；返回保留集、丢弃数与产地不符来源标题（任务 #102-P2）。
 * opts.tight（任务 #109-P6）透传 scoreSourceRelevance 的泛来源收紧模式。
 * 任务 #113：另返回 scores（来源→分数映射），供 pickFetchQuota 保留席分数保护使用。
 * 确定性（同分同源行为一致）：排序仅按分数降序，同分保持输入顺序（稳定排序）；
 * scoreSourceRelevance 为纯函数，同输入必同输出，不存在随机/时间依赖。
 */
export function filterRelevantSources(
  sources: ResearchSource[],
  input: BeanResearchInput,
  opts: { tight?: boolean } = {},
): {
  kept: ResearchSource[];
  filtered: number;
  originMismatches: string[];
  scores: Map<ResearchSource, number>;
} {
  const tokens = beanTokens(input);
  const estates = extractEstateTokens(input);
  const origins = originTokens(input);
  // 任务 #119：豆名/品种词元透传（豁免收紧的复合豆名滑窗与他豆组成部分判定）
  const nameTerms = beanNameTermsOf(input);
  const scored = sources.map((src) => ({
    src,
    ...scoreSourceRelevance(src, tokens, estates, {
      process: input.process,
      originTokens: origins,
      origin: input.origin,
      tight: opts.tight,
      roaster: input.roaster,
      beanNameTerms: nameTerms,
    }),
  }));
  // 任务 #125：含本豆名+他滤杯策略来源保留但打 dripperSignal 标记——
  // 在 map 阶段把 dripperSignal 写入来源对象，透传到 researchBean summaryText 与 generate.ts
  const kept = scored
    .filter((s) => s.kept)
    .sort((a, b) => b.score - a.score)
    .map((s) => (s.dripperSignal ? { ...s.src, dripperSignal: s.dripperSignal } : s.src));
  const originMismatches = scored.filter((s) => s.kept && s.originMismatch).map((s) => s.src.title);
  const scores = new Map<ResearchSource, number>();
  for (const s of scored) scores.set(s.src, s.score);
  return { kept, filtered: sources.length - kept.length, originMismatches, scores };
}

/** 回退摘录：仅保留含咖啡域词的段落（提炼失败时的降级注入，避免整页垃圾） */
export function coffeeExcerpt(text: string, limit = RESEARCH_PAGE_LIMIT): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= EXCERPT_LINE_MIN)
    .filter((l) => {
      const lower = l.toLowerCase();
      return COFFEE_DOMAIN_WORDS.some((w) => lower.includes(w));
    })
    .slice(0, EXCERPT_MAX_LINES)
    .map((l) => (l.length > EXCERPT_LINE_LIMIT ? `${l.slice(0, EXCERPT_LINE_LIMIT)}…` : l));
  return lines.join("\n").slice(0, limit);
}

/**
 * 标题归一化（任务 #102-P3 去重用）：小写、去空白与标点，仅保留中文/字母/数字，
 * 使「阿朵斯 冲煮参数！」与「阿朵斯冲煮参数」视为同候选。
 */
export function normalizeTitleForDedupe(title: string): string {
  return title.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]/gu, "");
}

/** 标题近重复判定阈值（任务 #102-P3）：归一化后相似度超过即视为重复 */
export const TITLE_NEAR_DUPLICATE_THRESHOLD = 0.8;

/**
 * 标题相似度（任务 #102-P3，纯函数可测）：归一化后——完全相等=1；
 * 一方包含另一方时按 短/长 长度比（前缀截断式 SEO 标题如「阿朵斯冲煮」vs
 * 「阿朵斯冲煮参数详解」）；否则按字符级 bigram Dice 系数。
 */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitleForDedupe(a);
  const y = normalizeTitleForDedupe(b);
  if (x.length === 0 && y.length === 0) return 1;
  if (x.length === 0 || y.length === 0) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    return Math.min(x.length, y.length) / Math.max(x.length, y.length);
  }
  const bigrams = (s: string): string[] => {
    if (s.length < 2) return [s];
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const ba = bigrams(x);
  const bb = bigrams(y);
  const counts = new Map<string, number>();
  for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1);
  let shared = 0;
  for (const g of bb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      shared += 1;
      counts.set(g, c - 1);
    }
  }
  return (2 * shared) / (ba.length + bb.length);
}

/** 标题 token-set Jaccard 阈值（任务 #117）：超过即视为近重复（与 bigram Dice 互补） */
export const TITLE_TOKEN_JACCARD_THRESHOLD = 0.6;

/**
 * 标题 token-set Jaccard（任务 #117，纯函数可测）：token = 数字串/拉丁串/单个汉字。
 * 与 bigram Dice 互补：词序调换+换后缀的 SEO 模板标题（「74158 日晒 咖啡冲煮 攻略」
 * vs 「日晒 74158咖啡 , 冲煮 秘籍」）归一化后 Dice≈0.67 不达 0.8，
 * 但 token-set Jaccard≈0.64 达本阈值，判近重复。
 */
export function titleTokenJaccard(a: string, b: string): number {
  const toks = (s: string): Set<string> =>
    new Set(normalizeTitleForDedupe(s).match(/\d+|[a-z]+|\p{Script=Han}/gu) ?? []);
  const x = toks(a);
  const y = toks(b);
  if (x.size === 0 && y.size === 0) return 1;
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter += 1;
  return inter / (x.size + y.size - inter);
}

/**
 * 标题近重复判定（任务 #117，纯函数可测）：bigram Dice >0.8 或 token-set
 * Jaccard >0.6 任一命中即近重复。两维度各自保守、组合覆盖词序调换与换后缀两类模板。
 */
export function isNearDuplicateTitle(a: string, b: string): boolean {
  return (
    titleSimilarity(a, b) > TITLE_NEAR_DUPLICATE_THRESHOLD ||
    titleTokenJaccard(a, b) > TITLE_TOKEN_JACCARD_THRESHOLD
  );
}

/**
 * 标题近重复去重（任务 #102-P3）：保留先入者（确定性：遍历顺序 = 入池顺序），
 * 后到来源与任一已保留来源近重复（isNearDuplicateTitle）即丢弃（实测同基址
 * 不同后缀的百度 SEO 页标题近重复同时入池）。
 */
export function dedupeSourcesByTitle(sources: ResearchSource[]): ResearchSource[] {
  const kept: ResearchSource[] = [];
  for (const src of sources) {
    if (kept.some((k) => isNearDuplicateTitle(k.title, src.title))) {
      continue;
    }
    kept.push(src);
  }
  return kept;
}

/**
 * 跳转链接来源判定（任务 #102-P3，纯函数可测）：baidu.com/link、
 * duckduckgo.com/l/、bing.com/ck/a 等无法溯源的中转链接；命中仅降权不硬删，
 * 避免误杀真实可达来源。仿冒域名按后缀匹配不命中。
 */
export function isRedirectLinkSource(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isBaidu = host === "baidu.com" || host === "www.baidu.com" || host.endsWith(".baidu.com");
    if (isBaidu && u.pathname.startsWith("/link")) return true;
    const isDdg = host === "duckduckgo.com" || host.endsWith(".duckduckgo.com");
    if (isDdg && u.pathname.startsWith("/l/")) return true;
    const isBing = host === "bing.com" || host === "www.bing.com" || host.endsWith(".bing.com");
    if (isBing && u.pathname.startsWith("/ck/a")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 识别小红书 MCP search_feeds 超时类错误（任务 #102-P2，纯函数可测）：
 * AbortSignal.timeout 抛出的 TimeoutError（name="TimeoutError"，
 * message 含 "aborted due to timeout"）及常见超时文案；用于区分
 * 「执行超时（应冷却）」与一般报错（可继续梯队）。
 */
export function isXhsSearchTimeoutError(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  if (!err) return false;
  if (err.name === "TimeoutError") return true;
  const msg = err.message ?? "";
  return /timed ?out|timeout|aborted due to timeout|operation was aborted/i.test(msg);
}

/** 解码 DDG 跳转链接（//duckduckgo.com/l/?uddg=...）为真实 URL；非法返回空串 */
function resolveDdgHref(href: string): string {
  try {
    const absolute = href.startsWith("//") ? `https:${href}` : href;
    const u = new URL(absolute);
    if (/duckduckgo\.com$/.test(u.hostname) && u.pathname.startsWith("/l/")) {
      const uddg = u.searchParams.get("uddg");
      return uddg ?? "";
    }
    return absolute;
  } catch {
    return "";
  }
}

/**
 * 解析 DuckDuckGo HTML 版搜索结果页（result__a 锚点 + result__snippet 摘要）。
 * 任务 #30 因 GFW 封锁从主渠道链移除；任务 #80 重新接入为 Reddit 定向与
 * 全渠道零结果时的末位兜底（当前出口实测可达，但可能波动，失败静默降级）。
 */
export function parseDdgResults(html: string): ResearchSource[] {
  const out: ResearchSource[] = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = resolveDdgHref(m[1].replace(/&amp;/g, "&"));
    const title = htmlToText(m[2]).slice(0, 120);
    if (!(url && title && /^https?:/.test(url))) continue;
    // 任务 #80：保留结果摘要（result__snippet，正文抓取失败时兜底）
    const after = html.slice(m.index, m.index + 6000);
    const sm =
      /<(?:a|div|span)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(
        after,
      );
    const snippet = sm ? htmlToText(sm[1]).slice(0, 500).trim() : "";
    out.push({ title, url, ...(snippet ? { snippet } : {}) });
    if (out.length >= RESEARCH_RAW_POOL * 2) break;
  }
  return out;
}

/**
 * 解析 DuckDuckGo Lite 端点（lite.duckduckgo.com/lite）结果页（任务 #80）：
 * 极简表格结构，结果链接为 class="result-link" 锚点，无摘要字段。
 * 作为 html 端点被反爬/降级时的备用入口。
 */
export function parseDdgLiteResults(html: string): ResearchSource[] {
  const out: ResearchSource[] = [];
  const re =
    /<a[^>]+(?:rel="nofollow"\s+)?class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = resolveDdgHref(m[1].replace(/&amp;/g, "&"));
    const title = htmlToText(m[2]).slice(0, 120);
    if (!(url && title && /^https?:/.test(url))) continue;
    out.push({ title, url });
    if (out.length >= RESEARCH_RAW_POOL * 2) break;
  }
  return out;
}

/**
 * 解析 Bing 搜索结果页（<h2><a> 结构）作为兜底。
 * 任务 #30：限定在主结果容器 <ol id="b_results"> 内提取——实测不限定容器时
 * 会把页面推荐位/热搜榜的 <h2> 误当结果（cn.bing 冷门查询降级时尤其严重）。
 * /ck/a 跳转链接解码为真实 URL（u=a1<base64url>）。
 */
export function parseBingResults(html: string): ResearchSource[] {
  // 限定主结果容器：<ol id="b_results"> 开始，到侧栏 <... id="b_context" 截止
  const start = html.search(/<ol[^>]*id="b_results"/i);
  let container = html;
  if (start >= 0) {
    const rest = html.slice(start);
    const end = rest.search(/<[a-z]+[^>]*id="b_context"/i);
    container = end >= 0 ? rest.slice(0, end) : rest;
  }
  const out: ResearchSource[] = [];
  const re = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(container)) !== null) {
    const url = decodeBingHref(m[1].replace(/&amp;/g, "&"));
    const title = htmlToText(m[2]).slice(0, 120);
    if (!title || !/^https?:/.test(url)) continue;
    // 任务 #70：尽力保留结果摘要（b_caption 内的 <p>，正文抓取失败时兜底）
    const after = container.slice(m.index, m.index + 3000);
    const sm = /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(
      after,
    );
    const snippet = sm ? htmlToText(sm[1]).slice(0, 500).trim() : "";
    out.push({ title, url, ...(snippet ? { snippet } : {}) });
  }
  return out;
}

/** 解码 Bing /ck/a 跳转链接（u=a1<base64url>）为真实 URL；非法/非跳转时原样返回 */
function decodeBingHref(href: string): string {
  try {
    const u = new URL(href, "https://cn.bing.com");
    if (/bing\.com$/.test(u.hostname) && u.pathname === "/ck/a") {
      const up = u.searchParams.get("u");
      if (up && up.startsWith("a1")) {
        const b64 = up.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        return Buffer.from(b64, "base64").toString("utf8");
      }
    }
    return u.toString();
  } catch {
    return href;
  }
}

/**
 * 解析百度搜索结果页（<h3><a> 结构），任务 #30 新增主渠道：
 * 中国大陆网络下 DuckDuckGo 被 GFW 全面封锁（GreatFire 实测 100% 阻断）、
 * cn.bing 冷门查询严重降级，百度是实测唯一稳定的高质量免 key 渠道。
 * 返回的 baidu.com/link 跳转链接由后续 safeFetch 逐跳重定向解析到真实页面。
 */
export function parseBaiduResults(html: string): ResearchSource[] {
  const out: ResearchSource[] = [];
  const re = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, "&");
    const title = htmlToText(m[2]).slice(0, 120);
    // 排除百度图片聚合卡与推荐位（实测会把图片搜索页误当来源，抓取无正文）
    if (/image\.baidu\.com|baiduimage/.test(url)) continue;
    if (!(url && title && /^https?:/.test(url))) continue;
    // 任务 #70：尽力保留结果摘要（c-abstract 摘要块，正文抓取失败时兜底）
    const after = html.slice(m.index, m.index + 4000);
    const sm = /<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(after);
    const snippet = sm ? htmlToText(sm[1]).slice(0, 500).trim() : "";
    out.push({ title, url, ...(snippet ? { snippet } : {}) });
  }
  return out;
}

/** 搜索渠道使用的浏览器 UA（实测百度对 bot UA 返回 https→http 降级页，必须用浏览器 UA） */
const SEARCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

/** 单渠道搜索请求：带渠道级时间盒，失败返回空数组 */
async function fetchSearchPage(url: string, outerSignal: AbortSignal): Promise<string | null> {
  const channelTimeout = AbortSignal.timeout(SEARCH_CHANNEL_TIMEOUT_MS);
  const signal = AbortSignal.any([channelTimeout, outerSignal]);
  try {
    assertPublicUrl(url);
    const res = await fetch(url, { redirect: "manual", headers: SEARCH_HEADERS, signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ---- DuckDuckGo 渠道（任务 #80）----
// 任务 #30 时 DDG 在宿主网络被 GFW 封锁而移除；#80 实测当前出口 html/lite 端点可达，
// 且对 site:reddit.com 召回率高（6/6 真实 r/pourover 帖子）。已知限制：连发约 3 次后
// 返回 202 限流零结果，出口可能波动——故设调研级请求预算（3 次），仅用于 Reddit 定向
// 与全渠道零结果时的末位兜底，绝不设为主渠道；任何失败/202/零结果都静默降级。
// 任务 #98：预算不再用模块级 let + 入口 reset（并发调研会互清零），
// 改由 createResearchBudgets 创建局部预算对象贯穿本次调研全链路。
const DDG_BUDGET = 3;

/**
 * DuckDuckGo 搜索（html 端点优先，零结果时降级 lite 端点，各计一次预算）。
 * 请求失败 / 202 限流（fetchSearchPage 非 2xx 返回 null）/ 零结果一律返回空数组，
 * 不抛错、不向上传播，由调用方静默降级。
 */
async function searchDdg(
  query: string,
  signal: AbortSignal,
  budgets: ResearchBudgets,
): Promise<ResearchSource[]> {
  if (budgets.ddg <= 0 || signal.aborted) return [];
  budgets.ddg -= 1;
  const q = encodeURIComponent(query);
  const html = await fetchSearchPage(`https://html.duckduckgo.com/html/?q=${q}`, signal);
  if (html) {
    const results = parseDdgResults(html);
    if (results.length > 0) return results;
  }
  if (budgets.ddg <= 0 || signal.aborted) return [];
  budgets.ddg -= 1;
  const lite = await fetchSearchPage(`https://lite.duckduckgo.com/lite/?q=${q}`, signal);
  return lite ? parseDdgLiteResults(lite) : [];
}

// ---- Firecrawl 有限接入（任务 #85）----
// 调研结论（#84 实测）：v2 REST——POST /v2/scrape（约 1 credit/页，可穿透 Cloudflare，
// home-barista.com 本地直抓 403 而 Firecrawl 返回完整 markdown）与 POST /v2/search
// （2 credits/次，结构化 results，可作 SearXNG 掉线备援）。Keyless 可用：不带
// Authorization 头按 IP 日限额；有 key 时 Bearer 认证。
// 实测无效面：小红书（登录墙）/ Reddit（官方黑名单 403）不下发给 Firecrawl。
const FIRECRAWL_BASE = "https://api.firecrawl.dev";
const FIRECRAWL_SCRAPE_TIMEOUT_MS = 20_000; // scrape 单次时间盒
const FIRECRAWL_SEARCH_TIMEOUT_MS = 12_000; // search 单次时间盒
const FIRECRAWL_SEARCH_LIMIT = 5; // search 每次返回条数
const FIRECRAWL_SEARCH_BUDGET = 2; // 单次调研 search 调用上限
const FIRECRAWL_SCRAPE_BUDGET = 2; // 单次调研 scrape 调用上限

// 预算护栏（任务 #98：局部预算对象，每次调研经 createResearchBudgets 独立创建）：
// 单次调研 Firecrawl 调用总数上限 ≤4（search ≤2 + scrape ≤2），超限静默停用该渠道。
// 旧实现是模块级计数器 + researchBean 入口 reset——双方案对比并行跑两条生成链时，
// 请求 B 的 reset 会清零请求 A 进行中的预算，导致 A 超预算触发 DDG 202 限流；
// 现每条调研链持有独立预算对象，互不干扰，「同输入同行为」语义不变。
export interface ResearchBudgets {
  /** DuckDuckGo 剩余请求次数（限流防护） */
  ddg: number;
  /** Firecrawl /v2/search 剩余调用次数 */
  fcSearch: number;
  /** Firecrawl /v2/scrape 剩余调用次数 */
  fcScrape: number;
  /** 披露用：本次调研 Firecrawl search 是否实际命中 */
  fcSearchUsed: boolean;
  /** 披露用：本次调研 Firecrawl scrape 成功页数 */
  fcScrapeUsed: number;
  /** SearXNG liveness 缓存（单次调研只探一次，避免每条查询重复探测） */
  searxngHealth: { probed: boolean; online: boolean };
  /**
   * 任务 #102-P2：小红书 MCP search_feeds 超时冷却标记——本次调研内任一
   * search_feeds 超时后置 true，后续变体不再打 MCP 直接走降级（实测客户端
   * 25s 放弃后服务端残留请求仍跑 1m-2m36s 串行阻塞后续调用，连环超时只会
   * 拖垮预算）。冷却仅限本次调研：每次调研经 createResearchBudgets 独立创建，
   * 下一次调研从 false 重新起步。
   */
  xhsMcpSearchCooled: boolean;
}

/** 创建一次调研的全套预算（确定性初始值；并发调研各持一份，互不干扰） */
export function createResearchBudgets(): ResearchBudgets {
  return {
    ddg: DDG_BUDGET,
    fcSearch: FIRECRAWL_SEARCH_BUDGET,
    fcScrape: FIRECRAWL_SCRAPE_BUDGET,
    fcSearchUsed: false,
    fcScrapeUsed: 0,
    searxngHealth: { probed: false, online: false },
    xhsMcpSearchCooled: false,
  };
}

/**
 * scrape 兜底受益域名（可扩展常量表，home-barista.com 起步）：本地直抓被 Cloudflare
 * 挑战壳页拦下的站点，命中即允许走 /v2/scrape 穿透。仿冒域名按后缀匹配不命中。
 */
export const FIRECRAWL_BENEFIT_DOMAINS = ["home-barista.com"];

/** URL 是否命中 scrape 兜底受益域名（纯函数可测；非法 URL 返回 false） */
export function isFirecrawlBenefitDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return FIRECRAWL_BENEFIT_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * 识别 Cloudflare 挑战壳页（纯函数可测）：Just a moment / Checking your browser 等
 * 挑战文案（任意状态码），或 403/503 + Cloudflare 指纹（cloudflare / cf-ray / __cf_chl）。
 * 命中即视为本地抓取拿不到正文，改由 /v2/scrape 穿透。
 */
export function isCloudflareChallenge(status: number, body: string): boolean {
  const text = body.slice(0, 4000).toLowerCase();
  if (
    text.includes("just a moment") ||
    text.includes("checking your browser") ||
    text.includes("attention required") ||
    text.includes("cf-browser-verification") ||
    text.includes("challenge-platform")
  ) {
    return true;
  }
  if (status === 403 || status === 503) {
    if (text.includes("cloudflare") || text.includes("cf-ray") || text.includes("__cf_chl"))
      return true;
  }
  return false;
}

/** Firecrawl 请求头：keyless 不带 Authorization（按 IP 日限额）；有 key 时 Bearer 认证 */
function firecrawlHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.firecrawlApiKey) headers.authorization = `Bearer ${config.firecrawlApiKey}`;
  return headers;
}

/**
 * 解析 Firecrawl /v2/search 响应（纯函数可测）：实测返回结构为
 * `{ success, data: { web: [ { url, title, description, position } ] } }`（data 为对象，
 * web 数组）；兼容 data 直接为数组与 results 数组两种变体。接入既有 ResearchSource
 * 结构供后续域名过滤与相关性打分。非法输入返回空数组。
 */
export function parseFirecrawlSearchResults(json: unknown): ResearchSource[] {
  const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  if (!obj) return [];
  const data = obj.data;
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { web?: unknown }).web)
      ? (data as { web: unknown[] }).web
      : Array.isArray(obj.results)
        ? obj.results
        : [];
  const out: ResearchSource[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { url, title, description } = item as {
      url?: unknown;
      title?: unknown;
      description?: unknown;
    };
    if (typeof url !== "string" || typeof title !== "string") continue;
    if (!/^https?:/.test(url)) continue;
    const snippet =
      typeof description === "string" ? htmlToText(description).slice(0, 500).trim() : "";
    out.push({
      title: htmlToText(title).slice(0, 120),
      url,
      ...(snippet ? { snippet } : {}),
    });
    if (out.length >= RESEARCH_RAW_POOL * 2) break;
  }
  return out;
}

/**
 * Firecrawl /v2/scrape：formats:["markdown"]，超时 20s，返回 markdown 正文（trim）。
 * 预算耗尽/开关关/已中止/非 2xx/解析失败一律静默返回空串，不抛错，由调用方回退 snippet。
 * 成功（非空正文）计入 firecrawlScrapeUsed 供披露。
 */
export async function firecrawlScrape(
  url: string,
  signal: AbortSignal,
  budgets: ResearchBudgets,
): Promise<string> {
  if (!config.firecrawlEnabled) return "";
  if (budgets.fcScrape <= 0 || signal.aborted) return "";
  budgets.fcScrape -= 1;
  try {
    const combined = AbortSignal.any([AbortSignal.timeout(FIRECRAWL_SCRAPE_TIMEOUT_MS), signal]);
    const res = await fetch(`${FIRECRAWL_BASE}/v2/scrape`, {
      method: "POST",
      headers: firecrawlHeaders(),
      body: JSON.stringify({ url, formats: ["markdown"] }),
      signal: combined,
    });
    if (!res.ok) return "";
    const json = (await res.json()) as { data?: { markdown?: unknown } };
    const md = json?.data?.markdown;
    const text = typeof md === "string" ? md.trim() : "";
    if (text) budgets.fcScrapeUsed += 1;
    return text;
  } catch {
    return "";
  }
}

/**
 * Firecrawl /v2/search：limit 5，超时 12s，返回结构化 results（接入既有解析管线）。
 * 仅在 SearXNG 离线时由 searchWeb 下发（小红书/Reddit site: 定向查询不经过此函数）。
 * 预算耗尽/开关关/已中止/非 2xx 一律静默返回空数组，不抛错；命中计入 firecrawlSearchUsed。
 */
export async function firecrawlSearch(
  query: string,
  signal: AbortSignal,
  budgets: ResearchBudgets,
): Promise<ResearchSource[]> {
  if (!config.firecrawlEnabled) return [];
  if (budgets.fcSearch <= 0 || signal.aborted) return [];
  budgets.fcSearch -= 1;
  try {
    const combined = AbortSignal.any([AbortSignal.timeout(FIRECRAWL_SEARCH_TIMEOUT_MS), signal]);
    const res = await fetch(`${FIRECRAWL_BASE}/v2/search`, {
      method: "POST",
      headers: firecrawlHeaders(),
      body: JSON.stringify({ query, limit: FIRECRAWL_SEARCH_LIMIT }),
      signal: combined,
    });
    if (!res.ok) return [];
    const results = parseFirecrawlSearchResults(await res.json());
    if (results.length > 0) budgets.fcSearchUsed = true;
    return results;
  } catch {
    return [];
  }
}

/**
 * SearXNG liveness 探测（任务 #85）：本地实例无 /health 端点（实测 404），故以根路径
 * 200 作为在线信号（离线为 ECONNREFUSED，fetch 抛错）。回环地址不走 assertPublicUrl。
 */
async function searxngHealthy(signal: AbortSignal): Promise<boolean> {
  if (!config.searxngUrl) return false;
  try {
    const combined = AbortSignal.any([AbortSignal.timeout(3_000), signal]);
    const res = await fetch(`${config.searxngUrl}/`, { signal: combined, redirect: "manual" });
    return res.ok;
  } catch {
    return false;
  }
}

/** 单次调研内缓存 SearXNG liveness（首查探测，后续查询复用，避免重复探测；任务 #98：缓存挂在局部预算对象上） */
async function ensureSearxngOnline(
  signal: AbortSignal,
  budgets: ResearchBudgets,
): Promise<boolean> {
  if (budgets.searxngHealth.probed) return budgets.searxngHealth.online;
  budgets.searxngHealth.probed = true;
  budgets.searxngHealth.online = await searxngHealthy(signal);
  return budgets.searxngHealth.online;
}

/**
 * 解析 SearXNG JSON API 响应（任务 #30 主渠道）：取 results 的 url/title，
 * 任务 #70 起同时保留 content 摘要到 snippet（小红书等登录墙页面正文抓不到时的兜底）；
 * score 等其余字段不用——来源进入后续正文抓取与相关性过滤。
 * 纯函数可测；非法输入返回空数组。
 */
export function parseSearxngResults(json: unknown): ResearchSource[] {
  const out: ResearchSource[] = [];
  const results =
    json && typeof json === "object" && Array.isArray((json as { results?: unknown }).results)
      ? (json as { results: unknown[] }).results
      : [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const { url, title, content } = item as {
      url?: unknown;
      title?: unknown;
      content?: unknown;
    };
    if (typeof url !== "string" || typeof title !== "string") continue;
    if (!/^https?:/.test(url)) continue;
    // 任务 #70：保留搜索引擎返回的摘要（snippet/content），不再丢弃
    const snippet = typeof content === "string" ? htmlToText(content).slice(0, 500).trim() : "";
    out.push({
      title: htmlToText(title).slice(0, 120),
      url,
      ...(snippet ? { snippet } : {}),
    });
    if (out.length >= RESEARCH_RAW_POOL * 2) break;
  }
  return out;
}

/**
 * SearXNG 聚合搜索请求（任务 #30）：本地自托管 SearXNG（config.searxngUrl，
 * 默认 http://127.0.0.1:8899）聚合 DuckDuckGo/Brave/Google CSE 等多引擎，
 * JSON API 直返结构化结果，是本环境实测质量最高的渠道。未配置/不可达时返回空，
 * 由调用方回退百度/Bing。回环地址不走 assertPublicUrl（仅限本机服务）。
 */
async function searchSearxng(query: string, signal: AbortSignal): Promise<ResearchSource[]> {
  if (!config.searxngUrl) return [];
  const channelTimeout = AbortSignal.timeout(SEARCH_CHANNEL_TIMEOUT_MS);
  const combined = AbortSignal.any([channelTimeout, signal]);
  try {
    const res = await fetch(
      `${config.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json`,
      { signal: combined, headers: { accept: "application/json" } },
    );
    if (!res.ok) return [];
    return parseSearxngResults(await res.json());
  } catch {
    return [];
  }
}

/**
 * HTML 渠道链（百度 → Bing，任务 #76 从 searchWeb 拆出，供小红书定向降级路径复用）：
 * 1) 百度（免部署兜底：中文豆资料命中率高，实测可达、无反爬）；
 * 2) cn.bing.com（末位兜底：限定 b_results 容器 + /ck/a 链接解码）。
 * DDG 不在此链：202 限流风险高，仅在 searchWeb 全渠道零结果时受预算约束兜底（任务 #80）。
 */
async function searchHtmlChannels(query: string, signal: AbortSignal): Promise<ResearchSource[]> {
  const attempts: { url: string; parse: (html: string) => ResearchSource[] }[] = [
    { url: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`, parse: parseBaiduResults },
    { url: `https://cn.bing.com/search?q=${encodeURIComponent(query)}`, parse: parseBingResults },
  ];
  for (const attempt of attempts) {
    if (signal.aborted) return [];
    const html = await fetchSearchPage(attempt.url, signal);
    if (!html) continue;
    const results = attempt.parse(html);
    if (results.length > 0) return results;
  }
  return [];
}

/**
 * 单次搜索（任务 #30 重排渠道，全部先实测后写死；任务 #85 接入 Firecrawl search 备援）：
 * 1) 本地 SearXNG（主渠道：多引擎聚合 JSON API，实测命中质量最高；未部署时自动跳过）；
 * 2) 任务 #85：SearXNG 在线时绝不触发 Firecrawl（省 credits）；离线（liveness 探测失败）
 *    时把普通查询转投 /v2/search 结构化备援（受预算约束；site: 定向的小红书/Reddit 查询
 *    不经过此函数）；
 * 3) HTML 渠道链（百度 → Bing）兜底；
 * 4) DDG 末位兜底（任务 #80）：仅当前几路全部零结果时尝试，受调研级预算约束，
 *    失败/限流静默返回空，不阻塞不抛错。
 * 小红书/Reddit site: 定向查询不走此函数，见 searchXiaohongshuDirected / searchRedditDirected。
 */
export async function searchWeb(
  query: string,
  signal: AbortSignal,
  budgets: ResearchBudgets,
): Promise<ResearchSource[]> {
  // 任务 #85：SearXNG 在线时走主渠道；离线时先试 Firecrawl search 备援，仍空再降 HTML 渠道
  if (await ensureSearxngOnline(signal, budgets)) {
    const searxng = await searchSearxng(query, signal);
    if (searxng.length > 0 || signal.aborted) return searxng;
  } else {
    const fc = await firecrawlSearch(query, signal, budgets);
    if (fc.length > 0 || signal.aborted) return fc;
  }
  const html = await searchHtmlChannels(query, signal);
  if (html.length > 0 || signal.aborted) return html;
  return searchDdg(query, signal, budgets);
}

/**
 * 小红书 site: 定向检索专用通道（任务 #76 召回路径；任务 #82 新增 MCP 路径 0）：
 * 0) 小红书 MCP 直连（最高优先级，任务 #82）：config.xhsMcpUrl 配置且
 *    /health 探活在线时调 search_feeds（平台内搜索，召回真实笔记标题+链接，
 *    天然 xiaohongshu.com 域名）；search_feeds 不带正文摘要时仅对互动最高的
 *    1 条笔记深取 get_feed_detail 补足 snippet（控制调用次数与时间盒）；
 *    实测首次调用偶发 ~60s 挂死，xhs-mcp.ts 内置独立超时，超时即降级；
 * 1) SearXNG（config.searxngUrl）聚合 Google/DDG 等引擎、原生支持 site: 语法，
 *    在线时直接透传定向查询，结果再做域名过滤防串站；
 * 2) 百度对 site: 语法实测返回 wappass 验证码页、Bing 实测返回零结果/拒绝页——
 *    不向其下发 site: 查询浪费配额与时间预算，降级为普通查询
 *    （把 `site:xiaohongshu.com` 前缀替换为“小红书”关键词）+ 域名过滤：
 *    仅保留 URL 域名为 xiaohongshu.com / xhslink.com 的结果（标题+snippet 保留）。
 * MCP 离线/超时/报错/零结果均静默回退路径 1、2；全部零召回时返回空数组，
 * 由 researchBean 在总结中如实标注召回受限。
 * 任务 #102-P2：budgets.xhsMcpSearchCooled 超时冷却——本次调研内任一 search_feeds
 * 超时后置位，后续调用不再进 MCP 梯队（服务端残留请求串行阻塞，连环超时只会
 * 拖垮预算），冷却仅限本次调研。
 * 任务 #109-P4：首档超时不再整梯尽废——冷却后允许一次更短的兜底档（梯队末档
 * 「纯豆名/庄园词 + 手冲」短词）调用，仍超时/报错才彻底放弃渠道；
 * 兜底档调用同样受冷却标记保护（冷却已在超时时置位，只多这一次）。
 */
export async function searchXiaohongshuDirected(
  siteQuery: string,
  signal: AbortSignal,
  ladder?: string[],
  budgets?: ResearchBudgets,
): Promise<XhsDirectedOutcome> {
  // 任务 #83：MCP 报未登录/凭证失效时置位（降级链照常走，仅额外提醒前端扫码续期）
  let loginExpired = false;
  // 任务 #98：至少一次 MCP 调用成功建立连接（search_feeds 正常返回，含零召回）才置 true；
  // 首个变体即连接超时/报错时保持 false，披露文案不得宣称「MCP 在线」
  let mcpOnline = false;
  // 任务 #102-P3：search_feeds 执行超时标记（披露措辞三态区分）
  let mcpSearchTimeout = false;
  // 任务 #102-P2：本次调研内 MCP 已超时冷却 → 跳过整个 MCP 梯队直接走降级路径
  const cooled = budgets?.xhsMcpSearchCooled === true;
  // 路径 0：小红书 MCP 直连（任务 #82）——先探活再调用，离线直接跳过不浪费等待
  if (config.xhsMcpUrl && !cooled && !signal.aborted && (await xhsMcpHealthy({ signal }))) {
    // 任务 #86：关键词变体梯队——窄词零召回/超时时逐级放宽，任一命中即停；
    // 全部落空才走下方 site: 透传/域名过滤降级路径（总结如实披露各变体召回情况）
    const variants = ladder && ladder.length > 0 ? ladder : [xhsMcpKeyword(siteQuery)];
    const tried: string[] = [];
    // 命中出口：笔记 → 来源；无摘要时对互动最高的 1 条深取 get_feed_detail 补足 snippet。
    // 时间盒确定性：health 3s + 搜索单变体 25s（任务 #86 放宽）+ 深取 18s，
    // 由调研级 signal（总时间盒 40s）合并兌底；深取若触发中止则 catch 降级，仅保留标题级来源。
    const hitOutcome = async (kw: string, notes: XhsMcpNote[]): Promise<XhsDirectedOutcome> => {
      const sources = notes.map(xhsNoteToSource);
      if (!sources.some((s) => s.snippet) && !signal.aborted) {
        const top = [...notes].sort((a, b) => b.likedCount - a.likedCount)[0];
        try {
          const body = await getFeedDetailText(top.id, top.xsecToken, { signal });
          const idx = sources.findIndex((s) => s.url.includes(top.id));
          if (idx >= 0) sources[idx] = { ...sources[idx], snippet: body };
        } catch {
          /* 深取失败不影响标题级来源 */
        }
      }
      return {
        sources,
        via: "mcp",
        mcpKeywordUsed: kw,
        mcpTried: tried,
        mcpOnline,
        ...(mcpSearchTimeout ? { mcpSearchTimeout: true } : {}),
      };
    };
    for (const kw of variants) {
      if (signal.aborted) break;
      tried.push(kw);
      try {
        const notes = await searchXhsMcp(kw, { signal });
        mcpOnline = true; // 调用正常返回（含零召回）即证明连接成功建立
        if (notes.length > 0) return await hitOutcome(kw, notes);
      } catch (e) {
        /* 单个变体报错 → 尝试下一变体；任务 #83：错误特征命中未登录/凭证失效时
           标记并跳出（重试无意义）；任务 #102-P2：执行超时时置冷却标记并跳出
           梯队（服务端残留请求串行阻塞，后续变体继续打 MCP 只会连环超时）；
           任务 #109-P4：超时后先试一次兜底档再放弃 */
        if (isXhsLoginExpiredError(e)) {
          loginExpired = true;
          break;
        }
        if (isXhsSearchTimeoutError(e)) {
          mcpSearchTimeout = true;
          if (budgets) budgets.xhsMcpSearchCooled = true;
          // 任务 #109-P4：冷却后的一次兜底档（梯队末档短词）——仍超时/报错才彻底放弃渠道；
          // 冷却标记已置位，后续调用（含同一调研内其他定向查询）不再进 MCP，只多这一次
          const fallbackKw = xhsTimeoutFallbackKeyword(variants, tried);
          if (fallbackKw && !signal.aborted) {
            tried.push(fallbackKw);
            try {
              const notes = await searchXhsMcp(fallbackKw, { signal });
              mcpOnline = true;
              if (notes.length > 0) return await hitOutcome(fallbackKw, notes);
            } catch (fe) {
              if (isXhsLoginExpiredError(fe)) loginExpired = true;
              /* 兜底档也超时/报错 → 彻底放弃 MCP 渠道，走下方降级路径 */
            }
          }
          break;
        }
      }
      if (signal.aborted) break;
    }
    if (signal.aborted)
      return {
        sources: [],
        via: "fallback",
        mcpTried: tried,
        mcpOnline,
        ...(loginExpired ? { loginExpired: true } : {}),
        ...(mcpSearchTimeout ? { mcpSearchTimeout: true } : {}),
      };
    // 任务 #86：梯队全部零召回/报错 → 带着尝试记录继续下方降级路径（任务 #98：mcpOnline 一并透传供如实披露）
    const miss = {
      mcpTried: tried,
      mcpOnline,
      ...(loginExpired ? { loginExpired: true } : {}),
      ...(mcpSearchTimeout ? { mcpSearchTimeout: true } : {}),
    };
    // 路径 1：SearXNG 透传 site: 语法（未配置/离线时 searchSearxng 返回 []）
    if (config.searxngUrl) {
      const directed = filterXhsDomainSources(await searchSearxng(siteQuery, signal));
      if (directed.length > 0 || signal.aborted)
        return { sources: directed, via: "fallback", ...miss };
    }
    // 路径 2：百度/Bing 普通查询 + 域名过滤（site: 语法实测零召回，不下发）
    const plainQuery = siteQuery
      .replace(new RegExp(XHS_SITE_QUERY.replace(/\./g, "\\."), "i"), "小红书")
      .replace(/\s+/g, " ")
      .trim();
    const plain = await searchHtmlChannels(plainQuery, signal);
    return { sources: filterXhsDomainSources(plain), via: "fallback", ...miss };
  }
  // MCP 未配置/离线：直接走降级路径（不带梯队尝试记录，总结按「MCP 离线」口径披露；mcpOnline 恒 false）
  // 路径 1：SearXNG 透传 site: 语法（未配置/离线时 searchSearxng 返回 []）
  if (config.searxngUrl) {
    const directed = filterXhsDomainSources(await searchSearxng(siteQuery, signal));
    if (directed.length > 0 || signal.aborted)
      return { sources: directed, via: "fallback", mcpOnline: false };
  }
  // 路径 2：百度/Bing 普通查询 + 域名过滤（site: 语法实测零召回，不下发）
  const plainQuery = siteQuery
    .replace(new RegExp(XHS_SITE_QUERY.replace(/\./g, "\\."), "i"), "小红书")
    .replace(/\s+/g, " ")
    .trim();
  const plain = await searchHtmlChannels(plainQuery, signal);
  return { sources: filterXhsDomainSources(plain), via: "fallback", mcpOnline: false };
}
/**
 * Reddit site: 定向检索专用通道（任务 #80，仿 searchXiaohongshuDirected 结构与降级纪律）：
 * 1) SearXNG 在线时直接透传 site: 语法，结果做 reddit.com 域名过滤防串站；
 * 2) 否则走 DDG html/lite 端点——实测对 site:reddit.com 召回率高（6/6 真实帖子），
 *    结果同样域名过滤（仅保留 reddit.com 及其子域）；DDG 202 限流/零结果时静默返回空；
 * 3) DDG 也不出结果时最后退一步：普通查询（去掉 site: 前缀）走百度/Bing + 域名过滤。
 * 全部零召回时返回空数组，由 researchBean 在总结中如实标注 Reddit 渠道未命中。
 */
async function searchRedditDirected(
  siteQuery: string,
  signal: AbortSignal,
  budgets: ResearchBudgets,
): Promise<ResearchSource[]> {
  // 任务 #86：三条路径统一走领域护栏 filterRedditCoffeeSources（域名 + 咖啡相关性），
  // 实测 r/cocktails「鸡尾酒食谱」仅过域名关即混入来源第一位，故增加版块/内容约束
  // 路径 1：SearXNG 透传 site: 语法（未配置/离线时 searchSearxng 返回 []）
  if (config.searxngUrl) {
    const directed = filterRedditCoffeeSources(await searchSearxng(siteQuery, signal));
    if (directed.length > 0 || signal.aborted) return directed;
  }
  // 路径 2：DDG html/lite 端点（对 site:reddit.com 实测高召回；受调研级预算约束）
  const ddg = filterRedditCoffeeSources(await searchDdg(siteQuery, signal, budgets));
  if (ddg.length > 0 || signal.aborted) return ddg;
  // 路径 3：百度/Bing 普通查询 + 域名过滤（site: 语法对百度/Bing 实测零召回，不下发）
  const plainQuery = siteQuery
    .replace(new RegExp(REDDIT_SITE_QUERY.replace(/\./g, "\\."), "i"), "reddit")
    .replace(/\s+/g, " ")
    .trim();
  const plain = await searchHtmlChannels(plainQuery, signal);
  return filterRedditCoffeeSources(plain);
}

/**
 * 一次低成本 LLM 提炼：把抓取到的页面正文提炼为结构化要点
 * （产地/处理法/风味/烘焙商冲煮建议）。走 config 默认模型链，
 * 时间盒 DISTILL_TIMEOUT_MS；失败抛错由调用方回退截断注入。
 */
async function distillPages(blocks: string[], signal: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(DISTILL_TIMEOUT_MS);
  const combined = AbortSignal.any([timeout, signal]);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `你是咖啡资料提炼助手。把用户给出的网页正文摘录提炼为结构化要点，` +
        `只输出以下四个小节（无相关信息就写“未提及”，不要编造）：\n` +
        `产地：\n处理法：\n风味描述：\n冲煮建议：\n` +
        `要求：忠于原文、简体中文、总计不超过 300 字；` +
        `忽略与咖啡无关的内容（导航/广告/推荐位）；不得输出正文以外的任何内容。`,
    },
    { role: "user", content: blocks.join("\n\n").slice(0, DISTILL_PAGE_LIMIT * 3 + 500) },
  ];
  let content = "";
  for await (const chunk of streamChat(messages, { signal: combined, temperature: 0 })) {
    if (combined.aborted) break;
    if (chunk.type === "content") content += chunk.delta;
  }
  const text = content.trim();
  if (!text) throw new Error("提炼结果为空");
  return text.slice(0, 1200);
}

/**
 * 主动联网调研：搜索 → 相关性过滤 → 透出来源 → 抓取正文 → LLM 提炼（失败回退摘录）。
 * 总时间盒 40 秒；任何异常/超时/无相关结果都返回 ok:false，由调用方降级继续生成。
 * emit 回调用于向前端实时透出 start/source 事件（done 由调用方发送）。
 * opts.totalTimeoutMs：总时间盒覆盖（任务 #101，供测试缩短；生产调用方不传，
 * 默认 RESEARCH_TOTAL_TIMEOUT_MS=40s 不变）。
 */
export async function researchBean(
  input: BeanResearchInput,
  emit?: ResearchEmit,
  outerSignal?: AbortSignal,
  opts?: { totalTimeoutMs?: number; excludeUrls?: Set<string>; queryAngle?: number },
): Promise<ResearchOutcome> {
  // 任务 #83/#98：小红书登录过期标记先于 fail 声明——三处 fail 出口都必须透传该提醒
  // （小红书登录过期恰恰极易导致调研走到失败出口，最需要「重新扫码」提醒的场景不能丢）
  let xhsLoginExpired = false;
  const fail = (
    message: string,
    sources: ResearchSource[] = [],
    filtered = 0,
  ): ResearchOutcome => ({
    ok: false,
    sources,
    summaryText: "",
    // 任务 #98：登录过期时附加重新扫码提示，并透传 xhsLoginExpired 供前端顶栏提醒
    message: xhsLoginExpired
      ? `${message}（小红书登录已过期，请在顶栏「小红书」入口重新扫码）`
      : message,
    filtered,
    distilled: false,
    ...(xhsLoginExpired ? { xhsLoginExpired: true } : {}),
  });

  const queries = buildResearchQueries(input, opts?.queryAngle ?? 0);
  if (queries.length === 0) return fail("缺少豆信息，跳过联网调研");

  // 任务 #98：调研级预算（DDG/Firecrawl/SearXNG liveness）局部化——每次调研独立创建，
  // 并发调研（双方案对比并行两条生成链）互不清零（旧实现模块级计数器 + 入口 reset 会互清零）
  const budgets = createResearchBudgets();

  // 任务 #86：小红书 MCP 关键词变体梯队（窄词零召回/超时时逐级放宽，任一命中即停）
  const xhsLadder = xhsKeywordLadder(input);

  // 总时间盒 + 客户端断开双重约束（任务 #101：总盒可经 opts.totalTimeoutMs 覆盖，仅测试用）
  const deadline = AbortSignal.timeout(opts?.totalTimeoutMs ?? RESEARCH_TOTAL_TIMEOUT_MS);
  const signal = outerSignal ? AbortSignal.any([deadline, outerSignal]) : deadline;
  const timedOut = () => signal.aborted && !outerSignal?.aborted;

  emit?.("start", { query: queries[0] });

  // --- 搜索原始结果池（每条查询取前几条，去重） ---
  // 任务 #76：小红书 site: 定向查询走专用通道（SearXNG 透传 site: 语法，
  // 百度/Bing 降级普通查询 + 域名过滤），并统计真实召回数供总结如实披露；
  // 任务 #80：Reddit site: 定向查询同理走 searchRedditDirected（SearXNG/DDG/域名过滤）
  const pool: ResearchSource[] = [];
  let xhsDirectedRan = false;
  let xhsHits = 0;
  // 任务 #109-P2：被假命中判定（xhsNoteRelevant）拦下的小红书召回笔记数（不入池不计命中，披露如实说明）；
  // 按 URL 去重——同一 outcome 会被串行循环与并行分支各合并一次，拦截数不得重复计数
  let xhsBlocked = 0;
  const xhsBlockedUrls = new Set<string>();
  // 任务 #82：小红书定向实际命中渠道（mcp 直连 / fallback 搜索引擎），供总结如实披露
  let xhsVia: "mcp" | "fallback" | null = null;
  let redditDirectedRan = false;
  let redditHits = 0;
  // 任务 #86：被 Reddit 领域护栏（版块/内容相关性）拦下的帖子数，供总结如实披露
  let redditGuardBlocked = 0;
  // 任务 #86：小红书 MCP 梯队尝试记录与命中变体，供总结如实披露
  let xhsMcpTriedAll: string[] = [];
  let xhsMcpKeywordUsed: string | null = null;
  // 任务 #98：是否至少一次 MCP 调用成功建立连接（披露文案不得预设在未连接时宣称在线）
  let xhsMcpOnline = false;
  // 任务 #102-P3：MCP search_feeds 执行超时标记（披露措辞三态区分）
  let xhsMcpSearchTimeout = false;

  // 任务 #101：小红书定向查询前置——不再在串行梯队中排到 Tier1/Tier2 之后等时间预算，
  // 而是在总时间盒开启的瞬间并行发起，防前序渠道（SearXNG/百度/Bing 分层查询）耗时
  // 耗尽总盒、signal.aborted 后小红书定向从未执行（实测缺陷：xhs-mcp 零 /mcp 调用）。
  // 串行循环行至该查询槽位时直接取并行分支结果（不重复发起），池满短路/提前中止时
  // 并行分支也已确保执行机会；入池按 URL 去重，同一来源不重复计入。
  const xhsQuery = queries.find(isXhsDirectedQuery);
  const xhsDirectedPromise: Promise<XhsDirectedOutcome> | null = xhsQuery
    ? searchXiaohongshuDirected(xhsQuery, signal, xhsLadder, budgets)
    : null;
  if (xhsDirectedPromise) xhsDirectedRan = true;
  // SearXNG liveness 预探测（任务 #98 缓存挂在预算对象上）：并行分支与串行循环共享
  // 同一 budgets 对象，先完成探测写缓存，避免两分支并发竞态重复进入 searxngHealthy
  await ensureSearxngOnline(signal, budgets);

  // 入池合并逻辑（串行循环与并行分支共用）：URL 去重 + 标题近重复去重（任务 #102-P3：
  // 保留先入者）+ 原始池上限 + 渠道命中统计；任务 #109-P2：xhs 渠道来源入池前
  // 先过假命中判定（豆名/主题词在标题或正文命中），不满足者不入池、不计入 xhsHits
  const mergeIntoPool = (
    results: ResearchSource[],
    kind: "xhs" | "reddit" | "web",
    outcome: XhsDirectedOutcome | null,
  ): void => {
    for (const r of results.slice(0, RESEARCH_RAW_POOL)) {
      // 任务 #131：重调研换源——排除前轮已用 URL，强制换源池
      if (opts?.excludeUrls?.has(r.url)) continue;
      if (kind === "xhs" && !xhsNoteRelevant(r, input)) {
        // 任务 #109-P2：假命中拦截（披露的「命中 N 条真实笔记」不含此类）
        if (!xhsBlockedUrls.has(r.url)) {
          xhsBlockedUrls.add(r.url);
          xhsBlocked += 1;
        }
        continue;
      }
      if (pool.some((c) => c.url === r.url)) continue;
      // 任务 #117：近重复判定升级为 isNearDuplicateTitle（Dice>0.8 或 Jaccard>0.6）
      if (pool.some((c) => isNearDuplicateTitle(c.title, r.title))) continue;
      pool.push(r);
      if (kind === "xhs" && isXiaohongshu(r)) {
        xhsHits += 1;
        if (outcome) xhsVia = outcome.via;
      }
      if (kind === "reddit" && isForumSource(r)) redditHits += 1;
    }
  };

  for (const query of queries) {
    if (signal.aborted || pool.length >= RESEARCH_MAX_SOURCES * 2) break;
    const directed = isXhsDirectedQuery(query);
    const redditDirected = isRedditDirectedQuery(query);
    if (redditDirected) redditDirectedRan = true;
    let outcome: XhsDirectedOutcome | null = null;
    let results: ResearchSource[];
    if (directed) {
      // 任务 #101：小红书定向已由并行分支在总盒开启时发起，此处仅取其结果
      outcome = xhsDirectedPromise ? await xhsDirectedPromise : null;
      results = outcome ? outcome.sources : [];
    } else if (redditDirected) {
      results = await searchRedditDirected(query, signal, budgets);
    } else {
      results = await searchWeb(query, signal, budgets);
    }
    // 任务 #86：Reddit 护栏拦截统计（域名命中但非咖啡主题的帖，如 r/cocktails）
    if (redditDirected) {
      const domainOnly = results.filter((r) => {
        try {
          const host = new URL(r.url).hostname.toLowerCase();
          return host === "reddit.com" || host.endsWith(".reddit.com");
        } catch {
          return false;
        }
      });
      redditGuardBlocked += domainOnly.filter((r) => !isRedditCoffeeRelevant(r)).length;
    }
    mergeIntoPool(results, directed ? "xhs" : redditDirected ? "reddit" : "web", outcome);
  }
  // 任务 #101：并行分支兜底合池——即使串行循环因池满短路/信号中止从未走到小红书槽位，
  // 其结果（与披露字段：登录过期/MCP 在线/梯队尝试记录）也在此如实记录并入池（URL 去重）
  if (xhsDirectedPromise) {
    const outcome = await xhsDirectedPromise;
    // 任务 #83：无论降级后是否命中，只要 MCP 报过登录失效就置位（提醒优先）
    if (outcome.loginExpired) xhsLoginExpired = true;
    // 任务 #98：MCP 连接成功建立过即记为在线（披露文案不得预设）
    if (outcome.mcpOnline) xhsMcpOnline = true;
    // 任务 #102-P3：search_feeds 执行超时标记透传（披露措辞三态区分）
    if (outcome.mcpSearchTimeout) xhsMcpSearchTimeout = true;
    // 任务 #86：梯队尝试记录与命中变体（如实披露）
    if (outcome.mcpTried) xhsMcpTriedAll = outcome.mcpTried;
    if (outcome.mcpKeywordUsed) xhsMcpKeywordUsed = outcome.mcpKeywordUsed;
    mergeIntoPool(outcome.sources, "xhs", outcome);
  }

  // 任务 #101：搜索完成后的正文抓取/提炼专用信号——从搜索阶段结束起算，不受调研
  // deadline（40s 搜索总盒）约束：总盒被搜索阶段耗尽时不得连累已入池来源的正文获取，
  // 否则小红书并行分支命中也会因 pages 为空而功亏一篑；由独立阶段盒
  // POST_SEARCH_TIMEOUT_MS + 客户端断开约束，各请求自带独立时间盒
  // （safeFetch FETCH_TIMEOUT_MS / firecrawlScrape / distillPages DISTILL_TIMEOUT_MS）
  const postSearchDeadline = AbortSignal.timeout(opts?.totalTimeoutMs ?? POST_SEARCH_TIMEOUT_MS);
  const postSearchSignal: AbortSignal = outerSignal
    ? AbortSignal.any([postSearchDeadline, outerSignal])
    : postSearchDeadline;

  if (pool.length === 0) {
    return fail(timedOut() ? "联网调研超时" : "未找到公开资料");
  }

  // --- 相关性过滤（任务 #26）：无关条目直接丢弃，宁缺毋滥；
  // 任务 #102-P2：一并返回产地不符来源标题供摘要如实披露；
  // 任务 #109-P6：tight 模式收紧 Tier2+ 泛来源（域词命中但无豆词信号时降权+提高阈值） ---
  const { kept, filtered, originMismatches, scores } = filterRelevantSources(pool, input, {
    tight: true,
  });
  if (kept.length === 0) {
    return fail("未找到与该豆相关的公开资料（已过滤全部低相关来源）", [], filtered);
  }

  const candidates = kept.slice(0, RESEARCH_MAX_SOURCES);
  // 任务 #109-P1：MCP 命中笔记不得被先到的 web 结果挤出候选名单——kept 中被 top N
  // 截掉的小红书来源补入候选（实测沐乐果 6 条 MCP 笔记排在 web 泛页之后全被截掉）
  for (const s of kept) {
    if (isXiaohongshu(s) && !candidates.includes(s)) candidates.push(s);
  }
  for (const src of candidates) emit?.("source", { title: src.title, url: src.url });

  // --- 抓取正文（独立容错：单页失败不影响其他页） ---
  // 任务 #109-P1：抓取名额分配对小红书来源提权——MCP 命中笔记至少占 min(命中数,2) 席，
  // 不再被 FB/IG 泛页占满名额导致笔记正文从未进入摘要
  // 任务 #113：透传分数映射——保留席仅在分数不低于边界来源时才顶替，防低质笔记挤出高分来源
  const picked = pickFetchQuota(candidates, RESEARCH_MAX_FETCH, scores);
  const pages: {
    src: ResearchSource;
    text: string;
    snippetOnly?: boolean;
    xhsVia?: "mcp" | "fallback";
  }[] = [];
  // 任务 #70：正文抓取失败时，若搜索返回带 snippet 则拼入提炼输入，不再整条丢弃
  // （小红书笔记正文有登录墙，主要靠此兜底；任务 #82：MCP 直连的 snippet 即笔记正文）
  const fallbackSnippet = (src: ResearchSource): void => {
    if (src.snippet)
      pages.push({
        src,
        text: src.snippet,
        snippetOnly: true,
        xhsVia: isXiaohongshu(src) ? (xhsVia ?? undefined) : undefined,
      });
  };
  for (const src of picked) {
    if (postSearchSignal.aborted) break;
    // 任务 #85：受益域名（home-barista.com 等）遇 Cloudflare 挑战壳页/抓取失败时走 /v2/scrape 穿透
    const benefit = isFirecrawlBenefitDomain(src.url);
    let text = "";
    let fetched = false;
    try {
      // 任务 #80：www.reddit.com 重写为 old.reddit.com（静态 HTML 可读正文，新壳页 403）
      // 任务 #101：正文抓取用 postSearchSignal（调研 deadline 不连累已入池来源）
      const res = await safeFetch(redditFetchUrl(src.url), postSearchSignal);
      const raw = await res.text().catch(() => "");
      const contentType = res.headers.get("content-type") ?? "";
      const isCf = benefit && isCloudflareChallenge(res.status, raw);
      if (res.ok && !isCf) {
        text = contentType.includes("text/html")
          ? htmlToText(raw)
          : raw.replace(/\s+/g, " ").trim();
        fetched = text.trim().length > 0;
      }
    } catch {
      /* safeFetch 抛错（断连/超时/CF 断连）：受益域名交由下方 Firecrawl 兜底 */
    }
    // 任务 #85：受益域名未取到正文（失败 / CF 壳页 / 空正文）→ /v2/scrape，成功用其 markdown；
    // 失败静默回退 snippet 兜底，不抛错（来源标注不变）
    if (!fetched && benefit) {
      const md = await firecrawlScrape(src.url, postSearchSignal, budgets);
      if (md) {
        text = md;
        fetched = true;
      }
    }
    if (fetched) {
      pages.push({ src, text, xhsVia: isXiaohongshu(src) ? (xhsVia ?? undefined) : undefined });
    } else {
      /* 单页抓取失败 → snippet 兜底，无 snippet 才跳过 */
      fallbackSnippet(src);
    }
  }

  if (pages.length === 0) {
    return fail(
      timedOut() ? "联网调研超时" : "未找到可用的公开资料（页面抓取失败）",
      candidates,
      filtered,
    );
  }

  const fetched = pages.map((p) => p.src);
  const filterNote = filtered > 0 ? `，已过滤 ${filtered} 条低相关来源` : "";

  // --- 注入文本：优先 LLM 提炼，失败回退“仅咖啡相关段落”摘录 ---
  // 任务 #70：小红书来源或仅有 snippet 的来源标注“仅标题摘要，正文受限”，
  // 提醒提炼 LLM 不要过度解读受限素材；任务 #82：MCP 直连带正文 snippet 的
  // 小红书笔记不再标注受限（snippet 即真实正文截取）
  const sourceHeader = (p: {
    src: ResearchSource;
    snippetOnly?: boolean;
    xhsVia?: "mcp" | "fallback";
  }): string => {
    const mcpFull = p.xhsVia === "mcp" && !p.snippetOnly;
    const limited = !mcpFull && (p.snippetOnly || isXiaohongshu(p.src));
    return `【来源：${p.src.title}${limited ? "（仅标题摘要，正文受限）" : ""}】(${p.src.url})`;
  };
  let body = "";
  let distilled = false;
  try {
    const distillBlocks = pages.map(
      (p) => `${sourceHeader(p)}\n${p.text.slice(0, DISTILL_PAGE_LIMIT)}`,
    );
    // 任务 #101：提炼同样用 postSearchSignal（内部自带 DISTILL_TIMEOUT_MS 时间盒），
    // 调研 deadline 耗尽不阻断对已入池素材的提炼
    body = await distillPages(distillBlocks, postSearchSignal);
    distilled = true;
  } catch {
    /* 提炼失败/超时 → 回退咖啡相关段落截断注入 */
  }
  if (!distilled) {
    body = pages
      .map((p) => {
        const excerpt = coffeeExcerpt(p.text, RESEARCH_PAGE_LIMIT);
        return `${sourceHeader(p)}\n${excerpt || "（未提取到咖啡相关段落）"}`;
      })
      .join("\n\n");
  }

  // 任务 #76：小红书定向召回情况如实披露；任务 #82：MCP 直连命中时区分说明
  // 来源（笔记标题+正文经 MCP 直连获取），MCP 离线/超时已降级时同样如实标注，
  // 绝不伪造来源；任务 #83：登录失效时优先明确说明「小红书登录已过期」；
  // 任务 #109-P1：披露文案以「实际进入摘要的来源」为准（xhsInSummary/xhsMcpFullText），
  // 不再笼统声称「正文经 get_feed_detail 补充」；任务 #109-P2：假命中拦截数一并披露
  const xhsInSummary = pages.filter((p) => isXiaohongshu(p.src)).length;
  const xhsMcpFullText = pages.filter((p) => p.xhsVia === "mcp" && !p.snippetOnly).length;
  const xhsBlockedNote =
    xhsBlocked > 0 ? `，另有 ${xhsBlocked} 条与豆无关的召回笔记已拦截（不计命中）` : "";
  const xhsNote = !xhsDirectedRan
    ? ""
    : xhsLoginExpired
      ? `\n小红书登录已过期：MCP 凭证失效，小红书笔记本次未能获取（其余渠道不受影响，已照常降级检索）。请在应用顶栏「小红书」入口重新扫码登录或切换账号。`
      : xhsVia === "mcp"
        ? `\n小红书笔记（MCP 直连）命中 ${xhsHits} 条真实笔记${xhsBlockedNote}（检索词「${xhsMcpKeywordUsed ?? xhsMcpKeyword(queries.find(isXhsDirectedQuery) ?? "")}」，命中均已通过豆名/主题词相关性判定），其中 ${xhsInSummary} 条进入最终引用来源${xhsMcpFullText > 0 ? `（${xhsMcpFullText} 条笔记正文经 get_feed_detail 补充）` : "（笔记正文受登录墙限制，仅标题摘要可用）"}，域名 xiaohongshu.com。`
        : xhsHits > 0
          ? `\n小红书定向检索：命中 ${xhsHits} 条 xiaohongshu.com 来源${xhsBlockedNote}，其中 ${xhsInSummary} 条进入最终引用来源（MCP 离线/超时已降级，经搜索引擎 site: 透传或域名过滤渠道命中）。`
          : xhsMcpTriedAll.length > 0
            ? xhsMcpOnline
              ? `\n小红书定向检索：MCP 在线但关键词变体梯队（${xhsMcpTriedAll.map((k) => `「${k}」`).join(" → ")}）均零召回，免 key 渠道对 site:xiaohongshu.com 语法零召回（实测百度返回验证码页、Bing 零结果），已降级为结果域名过滤（仅保留 xiaohongshu.com / xhslink），本次未命中真实小红书笔记，小红书冲煮经验暂缺。`
              : xhsMcpSearchTimeout
                ? `\n小红书定向检索：MCP 搜索执行超时（探活在线、JSON-RPC 已建立，但关键词变体梯队（${xhsMcpTriedAll.map((k) => `「${k}」`).join(" → ")}）的 search_feeds 未能在时间盒内返回，服务端残留请求串行阻塞，已在本次调研内冷却，后续变体直接降级），免 key 渠道对 site:xiaohongshu.com 语法零召回（实测百度返回验证码页、Bing 零结果），已降级为结果域名过滤（仅保留 xiaohongshu.com / xhslink），本次未命中真实小红书笔记，小红书冲煮经验暂缺。`
                : `\n小红书定向检索：MCP 渠道未能连接或执行报错（关键词变体梯队（${xhsMcpTriedAll.map((k) => `「${k}」`).join(" → ")}）尝试后），免 key 渠道对 site:xiaohongshu.com 语法零召回（实测百度返回验证码页、Bing 零结果），已降级为结果域名过滤（仅保留 xiaohongshu.com / xhslink），本次未命中真实小红书笔记，小红书冲煮经验暂缺。`
            : "\n小红书定向检索：MCP 离线/超时/零结果，免 key 渠道对 site:xiaohongshu.com 语法零召回（实测百度返回验证码页、Bing 零结果），已降级为结果域名过滤（仅保留 xiaohongshu.com / xhslink），本次未命中真实小红书笔记，小红书冲煮经验暂缺。";
  // 任务 #80：Reddit 渠道命中/未命中如实披露（DDG 限流/出口波动时静默降级，不伪造来源）；
  // 任务 #86：领域护栏拦截数一并披露（非咖啡版块帖不进来源池）
  const redditGuardNote =
    redditGuardBlocked > 0
      ? `；领域护栏已拦截 ${redditGuardBlocked} 条非咖啡主题帖（如鸡尾酒版块）`
      : "";
  const redditNote = redditDirectedRan
    ? redditHits > 0
      ? `\nReddit 论坛定向检索：命中 ${redditHits} 条 reddit.com 咖啡帖（正文经 old.reddit.com 静态页抓取，失败项已降级为搜索摘要${redditGuardNote}）。`
      : `\nReddit 论坛定向检索：DDG/免 key 渠道本次未命中 reddit.com 咖啡帖（可能为 DDG 202 限流或出口波动，已静默降级${redditGuardNote}），Reddit 冲煮参数暂缺。`
    : queries.some(isRedditDirectedQuery)
      ? "\nReddit 论坛定向检索：搜索阶段被时间盒截断（或池满短路），未及执行。"
      : "";
  // 任务 #102-P2：保留但产地与豆档案不符的来源（已降权）→ 摘要如实披露提示交叉验证；
  // 任务 #109-P5：名单与最终引用来源取交集——被候选/抓取名额截掉未入引用的条目不点名
  // （实测缺陷：豆1 披露点名的 21 财经条目被 picked 截掉，披露名单与最终引用不一致）
  const fetchedTitles = new Set(fetched.map((s) => s.title));
  const mismatchesInSummary = originMismatches.filter((t) => fetchedTitles.has(t));
  const originMismatchNote =
    mismatchesInSummary.length > 0
      ? `\n注意：${mismatchesInSummary.length} 条引用来源所述产地与豆档案不符（${mismatchesInSummary
          .slice(0, 3)
          .map((t) => `「${t}」`)
          .join("、")}${mismatchesInSummary.length > 3 ? "等" : ""}），引用其冲煮参数前请交叉验证。`
      : "";
  // 任务 #125：含本豆名+他滤杯策略来源的 dripperSignal 标记透传到摘要——
  // 提示 LLM 这些来源参数须按 xBloom 官方滤杯转换表修正
  const dripperSources = fetched
    .map((s, i) => ({ i, dripper: s.dripperSignal }))
    .filter((s) => s.dripper);
  const dripperNote =
    dripperSources.length > 0
      ? `\n注意：来源 ${dripperSources.map((s) => s.i + 1).join("、")} 为他滤杯（${dripperSources
          .map((s) => s.dripper)
          .filter((v, i, a) => a.indexOf(v) === i)
          .join("/")}）策略，参数须按知识库 §9 滤杯转换表修正后采纳。`
      : "";
  // 任务 #85：用到 Firecrawl 时如实标注（正文穿透 / search 备援），未用到不提
  const firecrawlNote =
    budgets.fcScrapeUsed > 0 || budgets.fcSearchUsed
      ? `\n部分资料经 Firecrawl 抓取${
          budgets.fcScrapeUsed > 0
            ? `（${budgets.fcScrapeUsed} 页正文穿透 Cloudflare 挑战壳页）`
            : ""
        }${budgets.fcSearchUsed ? "（SearXNG 离线，/v2/search 结构化备援）" : ""}。`
      : "";
  const summaryText =
    `【联网调研摘要（实时检索${distilled ? "，已经 LLM 提炼" : ""}，供你参考交叉验证）】\n` +
    `搜索词：${queries.join(" | ")}\n` +
    `引用来源：\n${fetched.map((s, i) => `${i + 1}. ${s.title} — ${s.url}`).join("\n")}\n` +
    xhsNote +
    redditNote +
    originMismatchNote +
    dripperNote +
    firecrawlNote +
    `\n\n${body}`;

  return {
    ok: true,
    sources: fetched,
    summaryText,
    message: `调研完成，参考 ${fetched.length} 个公开来源${distilled ? "（已提炼要点）" : ""}${filterNote}`,
    filtered,
    distilled,
    ...(xhsLoginExpired ? { xhsLoginExpired: true } : {}),
  };
}
