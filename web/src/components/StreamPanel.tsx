/**
 * 中栏流式渲染区：
 * - 联网调研状态卡（research 事件：搜索中文案 + 来源列表，任务 #22）
 * - “AI 思考过程”折叠面板（reasoning 流，小字自动滚动）
 * - 正文流式 Markdown 风格渲染（轻量实现：标题/粗体/斜体/行内代码/列表）
 * - 围栏代码块：配方 JSON 渲染为默认折叠的「云端配方数据」核对卡（任务 #87），
 *   折叠态一行摘要（豆名/粉量/总水/段数），展开才显示缩进美化的 JSON
 * - 自动 AI 审查卡（review 事件：审查中/通过/发现问题并自动修正/遗留问题，任务 #36）
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from "react";
import type { ResearchSource, ReviewFinding } from "../lib/api.js";
import { parseCandidatesNote } from "../lib/candidates.js";
import CandidatePickCard from "./CandidatePickCard.js";
import { Card, CardHeader, Spinner } from "./ui.js";

/** 联网调研展示态（与 App 的 ResearchInfo 结构一致） */
export interface StreamResearch {
  phase: "idle" | "searching" | "done";
  message: string;
  sources: ResearchSource[];
  ok?: boolean;
  /** done 事件携带的调研摘要原文（任务 #122：提取小红书 MCP 三态披露行） */
  summary?: string;
  /** 任务 #131：重调研轮次（round>0 = 第 N 轮重调研） */
  round?: number;
}

/** 自动审查展示态（与 App 的 ReviewInfo 结构一致，任务 #36） */
export interface StreamReview {
  phase: "idle" | "reviewing" | "done";
  /** 最终 findings（修正后再审结果；空数组 = 审查通过） */
  findings: ReviewFinding[];
  /** 修正前的问题清单（发生过自动修正时才有） */
  preFindings?: ReviewFinding[];
  /** 是否已自动修正一轮 */
  fixed: boolean;
  /** 本次审查执行的检查维度数 */
  dimensions?: number;
}

export interface StreamPanelProps {
  reasoning: string;
  content: string;
  streaming: boolean;
  error?: string;
  notice?: string;
  research?: StreamResearch;
  review?: StreamReview;
  /** 多候选生成进度文案（任务 #106：如「正在并行生成 3 份方案…(1/3)」）；空串不渲染 */
  candidatesProgress?: string;
  /** 完成态副标题（任务 #111 O4：如「3 选 1 完成 · 得分 94」）；缺失时回退原文案 */
  doneNote?: string;
  /** 获胜配方 JSON 载荷（任务 #111 O3：N>1 无 content 流，直接渲染折叠卡）；缺失不渲染 */
  recipeJson?: string;
}

export default function StreamPanel({
  reasoning,
  content,
  streaming,
  error,
  notice,
  research,
  review,
  candidatesProgress,
  doneNote,
  recipeJson,
}: StreamPanelProps) {
  const [showThinking, setShowThinking] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);

  // 任务 #120：doneNote 字符串通道解出结构化候选状态；N>1 时中栏始终渲染优选明细卡
  const candNote = parseCandidatesNote(doneNote);
  const candState = candNote.state;
  const showPickCard = !!candState && candState.total > 1;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoScrollRef.current) return;
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (current && autoScrollRef.current) current.scrollTop = current.scrollHeight;
      scrollFrameRef.current = null;
    });
  }, [reasoning]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    },
    [],
  );

  const handleReasoningScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  };

  const empty =
    !reasoning &&
    !content &&
    !error &&
    !notice &&
    !candidatesProgress &&
    !recipeJson &&
    (!research || research.phase === "idle") &&
    (!review || review.phase === "idle");

  return (
    <Card className={`overflow-hidden ${empty ? "brew-empty-canvas xl:min-h-full" : ""}`}>
      <CardHeader
        icon={<IconBrain />}
        title="配方工作区"
        sub={streaming ? "正在流式输出…" : candNote.text || (content ? "输出完成" : "等待生成")}
        right={streaming ? <Spinner className="text-[var(--acc)]" /> : undefined}
      />
      <div className="space-y-4 p-5">
        {empty && (
          <div className="flex min-h-[420px] flex-col justify-between py-4 xl:min-h-[calc(100vh-10.5rem)]">
            <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center text-center">
              <div className="mb-6 w-full max-w-lg px-4" aria-hidden>
                <svg viewBox="0 0 520 150" className="h-auto w-full overflow-visible">
                  <defs>
                    <linearGradient id="brew-line" x1="0" x2="1">
                      <stop offset="0" stopColor="var(--tx-3)" stopOpacity="0.25" />
                      <stop offset="0.45" stopColor="var(--acc)" />
                      <stop offset="1" stopColor="var(--tx-3)" stopOpacity="0.22" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M18 123 C72 120 82 92 126 94 S190 38 242 53 S304 116 357 88 S418 33 502 44"
                    fill="none"
                    stroke="url(#brew-line)"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                  />
                  {[18, 126, 242, 357, 502].map((x, index) => (
                    <circle
                      key={x}
                      cx={x}
                      cy={[123, 94, 53, 88, 44][index]}
                      r="4.5"
                      fill="var(--bg-card)"
                      stroke={index === 2 ? "var(--acc)" : "var(--tx-3)"}
                      strokeWidth="2"
                    />
                  ))}
                  <path d="M18 135H502" stroke="var(--line)" strokeWidth="1" />
                </svg>
              </div>
              <p className="mb-2 inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--bg-card)] px-3 py-1 text-[11px] font-medium text-[var(--tx-2)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--ok)]" aria-hidden />
                工作台已就绪
              </p>
              <h3 className="text-xl font-semibold tracking-[-0.025em] text-[var(--tx-1)]">
                从左边定一杯咖啡
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--tx-2)]">
                豆子、风味和豆量按需填写。配方生成后，在右侧一键上传到手机 xBloom App。
              </p>
            </div>

            <div className="mx-auto grid w-full max-w-2xl grid-cols-1 border-t border-[var(--line)] pt-4 text-left sm:grid-cols-3 sm:divide-x sm:divide-[var(--line)]">
              {[
                ["输入", "豆子与目标风味"],
                ["检查", "曲线、参数与注水段"],
                ["上传", "手机 xBloom App 直接使用"],
              ].map(([title, desc], index) => (
                <div key={title} className="flex gap-3 px-4 py-2 first:pl-0 last:pr-0">
                  <span className="tnum text-[11px] font-semibold text-[var(--acc)]">
                    0{index + 1}
                  </span>
                  <div>
                    <p className="text-xs font-medium text-[var(--tx-1)]">{title}</p>
                    <p className="mt-0.5 text-[11px] leading-4 text-[var(--tx-3)]">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="animate-fade-up rounded-lg border border-[var(--bad)]/50 bg-[color-mix(in_srgb,var(--bad)_10%,transparent)] px-4 py-3 text-sm text-[var(--bad)]"
          >
            ⚠ {error}
          </div>
        )}

        {notice && (
          <div className="animate-fade-up rounded-lg border border-[var(--acc-line)] bg-[var(--acc-soft)] px-4 py-3 text-sm text-[var(--tx-2)]">
            {notice}
          </div>
        )}

        {research && research.phase !== "idle" && <ResearchBlock research={research} />}

        {/* 多候选并行生成进度行（任务 #106）：替代/补充思考流位置；N=1 时永不下发；
            #120：优选明细卡激活时进度信息并入卡片，避免双行重复 */}
        {candidatesProgress && !showPickCard && (
          <div
            aria-live="polite"
            className="animate-fade-up rounded-xl border border-[var(--acc-line)] bg-[var(--acc-soft)] px-4 py-3"
          >
            <p className="flex items-center gap-2 text-xs font-medium text-[var(--tx-1)]">
              <Spinner className="text-[var(--acc)]" />
              <span>{candidatesProgress}</span>
              <span className="animate-blink text-[var(--acc)]">●</span>
            </p>
          </div>
        )}

        {/* 优选明细卡（任务 #120）：N>1 始终渲染——running 逐候选实时状态，picked 打分/否决/失败原因 + 获胜高亮 */}
        {showPickCard && candState && <CandidatePickCard state={candState} />}

        {reasoning && (
          <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-inset)]">
            <button
              type="button"
              onClick={() => setShowThinking((v) => !v)}
              aria-expanded={showThinking}
              className="flex w-full items-center justify-between px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-[var(--tx-3)] transition-colors duration-150 hover:text-[var(--tx-1)]"
            >
              <span className="flex items-center gap-2">
                <span
                  className={streaming ? "animate-blink text-[var(--acc)]" : "text-[var(--tx-3)]"}
                >
                  ●
                </span>
                思考过程
              </span>
              <span
                className={`transition-transform duration-300 ${showThinking ? "rotate-180" : ""}`}
              >
                ▼
              </span>
            </button>
            {/* 折叠：grid-template-rows 0fr→1fr 400ms（任务 #108 P2），替代瞬开渲染 */}
            <div className="collapser" data-open={showThinking}>
              <div className="collapser-inner">
                <div
                  ref={scrollRef}
                  onScroll={handleReasoningScroll}
                  className="max-h-40 overflow-y-auto whitespace-pre-wrap px-4 pb-3 font-mono text-[11px] leading-relaxed text-[var(--tx-3)]"
                >
                  {reasoning}
                  {streaming && <span className="animate-blink text-[var(--acc)]">▍</span>}
                </div>
              </div>
            </div>
          </div>
        )}

        {content && (
          <article className="animate-fade-up space-y-2 text-sm leading-relaxed text-[var(--tx-2)]">
            <MarkdownLite text={content} streaming={streaming} />
            {streaming && (
              <span className="animate-blink inline-block h-4 w-2 bg-[var(--acc)] align-middle" />
            )}
          </article>
        )}

        {/* 获胜配方 JSON 折叠卡（任务 #111 O3；#114 互斥兜底）：仅当本次生成始终未收到
            content 事件时渲染（App 层已拦截；此处叠加 !content 双保险，两卡不得同时出现） */}
        {recipeJson && !content && (
          <div className="animate-fade-up text-sm leading-relaxed text-[var(--tx-2)]">
            <RecipeJsonCard code={recipeJson} streaming={false} />
          </div>
        )}

        {review && review.phase !== "idle" && <ReviewBlock review={review} />}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 自动 AI 审查卡（任务 #36）
// ---------------------------------------------------------------------------

function ReviewBlock({ review }: { review: StreamReview }) {
  // 审查中：Spinner + 检查维度预告
  if (review.phase === "reviewing") {
    return (
      <div
        aria-live="polite"
        className="animate-fade-up rounded-xl border border-[var(--acc-line)] bg-[var(--acc-soft)] px-4 py-3"
      >
        <p className="flex items-center gap-2 text-xs font-medium text-[var(--tx-1)]">
          <Spinner className="text-[var(--acc)]" />
          <span>方案校验中 · 检查水温、研磨、闷蒸、粉水比与总时长…</span>
          <span className="animate-blink text-[var(--acc)]">●</span>
        </p>
      </div>
    );
  }

  const { findings, preFindings, fixed, dimensions } = review;
  const passed = findings.length === 0;
  const dimText = dimensions ? ` · 已检查 ${dimensions} 个维度` : "";

  return (
    <div
      aria-live="polite"
      className={`animate-fade-up rounded-xl border px-4 py-3 ${
        passed
          ? "border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-[color-mix(in_srgb,var(--ok)_9%,transparent)]"
          : "border-[color-mix(in_srgb,var(--warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)]"
      }`}
    >
      <p className="flex items-center gap-2 text-xs font-medium text-[var(--tx-1)]">
        <span className={passed ? "text-[var(--ok)]" : "text-[var(--warn)]"} aria-hidden>
          {passed ? "✓" : "⚠"}
        </span>
        <span className="min-w-0 flex-1">
          {passed
            ? fixed
              ? `自动审查 · 发现问题并已自动修正，复审通过${dimText}`
              : `自动审查通过${dimText}`
            : `自动审查 · ${fixed ? "已自动修正一轮，仍有" : "发现"} ${findings.length} 项遗留问题`}
        </span>
      </p>

      {/* 修正前要点：仅发生过自动修正时展示 */}
      {fixed && preFindings && preFindings.length > 0 && (
        <div className="mt-2 border-t border-[var(--line)] pt-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--tx-3)]">
            修正前发现的问题
          </p>
          <ul className="mt-1 space-y-1">
            {preFindings.map((f, i) => (
              <li
                key={i}
                className="flex items-baseline gap-1.5 text-[11px] leading-relaxed text-[var(--tx-2)]"
              >
                <span className="shrink-0 text-[var(--ok)]" aria-hidden>
                  ✓
                </span>
                <span>
                  <span className={f.level === "error" ? "font-medium text-[var(--bad)]" : ""}>
                    [{f.level === "error" ? "违规" : "提醒"}]
                  </span>{" "}
                  {f.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 遗留问题清单（黄色警告列表；error 级标红） */}
      {!passed && (
        <ul className="mt-2 space-y-1.5 border-t border-[var(--line)] pt-2">
          {findings.map((f, i) => (
            <li key={i} className="text-[11px] leading-relaxed">
              <p className="flex items-baseline gap-1.5 text-[var(--tx-1)]">
                <span
                  className={`shrink-0 ${f.level === "error" ? "text-[var(--bad)]" : "text-[var(--warn)]"}`}
                  aria-hidden
                >
                  {f.level === "error" ? "●" : "○"}
                </span>
                <span className={f.level === "error" ? "font-medium" : ""}>{f.message}</span>
              </p>
              <p className="pl-4 text-[var(--tx-3)]">建议：{f.suggestion}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 联网调研状态卡（任务 #22；#94：来源类别徽章 + snippet 摘要）
// ---------------------------------------------------------------------------

/** 调研来源类别（任务 #94：域名/关键词启发式粗分，不求全） */
export type SourceCategory = "小红书" | "Reddit" | "论坛" | "官方" | "烘焙商" | "媒体" | "网页";

/** 烘焙商启发式词（域名+标题粗分，命中即归类） */
const ROASTER_WORDS = [
  "roaster",
  "roastery",
  "烘焙",
  "coffee co",
  "豆商",
  "咖啡工房",
  "coffee lab",
];
/** 咖啡媒体/内容站启发式词 */
const MEDIA_WORDS = [
  "magazine",
  "news",
  "blog",
  "media",
  "sprudge",
  "baristahustle",
  "perfectdailygrind",
  "perfect daily",
  "coffee tv",
  "评测",
  "媒体",
  "杂志",
  "咖啡沙龙",
];

/**
 * 来源类别启发式判定（任务 #94，纯函数可测）：
 * xiaohongshu/xhslink → 小红书；reddit → Reddit 社区；home-barista → 专业论坛；
 * xbloom 系域名 → 官方；其余按标题/域名关键词粗分烘焙商/媒体，都不命中归网页。
 * URL 非法也不抛错，降级为网页。
 */
export function sourceCategoryOf(url: string, title = ""): SourceCategory {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (host.endsWith("xiaohongshu.com") || host.includes("xhslink")) return "小红书";
  if (host.endsWith("reddit.com") || host.endsWith("redd.it")) return "Reddit";
  if (host.endsWith("home-barista.com")) return "论坛";
  if (host.includes("xbloom")) return "官方";
  if (host.endsWith(".coffee")) return "烘焙商"; // .coffee 顶级域多为烘焙商官网
  const text = `${host} ${title}`.toLowerCase();
  if (ROASTER_WORDS.some((w) => text.includes(w))) return "烘焙商";
  if (MEDIA_WORDS.some((w) => text.includes(w))) return "媒体";
  return "网页";
}

/** snippet 展示前归一化（任务 #94）：空白折叠为单空格、去首尾、截断 160 字符 */
export function cleanSnippet(raw: string | undefined): string {
  if (!raw) return "";
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/**
 * 小红书命中数前端统计（任务 #122，纯函数可测）：
 * 对 sources 按徽章类别（sourceCategoryOf）统计「小红书」条数，
 * 与列表徽章口径完全一致（xiaohongshu.com / xhslink 短链）。
 */
export function countXhsSources(sources: ResearchSource[]): number {
  return sources.filter((s) => sourceCategoryOf(s.url, s.title) === "小红书").length;
}

/**
 * 从调研摘要原文提取小红书 MCP 三态披露行（任务 #122，纯函数可测）：
 * summaryText 中小红书渠道披露独占一行（「小红书笔记（MCP 直连）命中 N 条…」/
 * 「小红书定向检索：…」「小红书登录已过期：…」），取首个「小红书」起首行；
 * 缺失返回空串（K=0 且无披露时计数行不附原文）。
 */
export function extractXhsDisclosure(summary: string | undefined): string {
  if (!summary) return "";
  const line = summary
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("小红书"));
  return line ?? "";
}

/** 来源类别徽章（任务 #94；#108：最小 10px，hairline 描边不加底色，官方类保留 acc-soft） */
function SourceBadge({ category }: { category: SourceCategory }) {
  const official = category === "官方";
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] leading-4 ${
        official
          ? "border-[var(--acc-line)] bg-[var(--acc-soft)] text-[var(--acc)]"
          : "border-[var(--line-strong)] text-[var(--tx-3)]"
      }`}
    >
      {category}
    </span>
  );
}

function ResearchBlock({ research }: { research: StreamResearch }) {
  const searching = research.phase === "searching";
  const degraded = research.phase === "done" && research.ok === false;
  // 任务 #122：小红书命中数前端统计；K=0 时同行附 MCP 三态披露原文
  const xhsHits = countXhsSources(research.sources);
  const xhsDisclosure = xhsHits === 0 ? extractXhsDisclosure(research.summary) : "";
  return (
    <div
      aria-live="polite"
      className={`animate-fade-up rounded-xl border px-4 py-3 ${
        degraded
          ? "border-[var(--line)] bg-[var(--bg-inset)]"
          : "border-[var(--acc-line)] bg-[var(--acc-soft)]"
      }`}
    >
      <p className="flex items-center gap-2 text-xs font-medium text-[var(--tx-1)]">
        {searching ? (
          <Spinner className="text-[var(--acc)]" />
        ) : (
          <span className={degraded ? "text-[var(--tx-3)]" : "text-[var(--acc)]"}>
            {degraded ? "○" : "✓"}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate" title={research.message}>
          {searching ? research.message : `联网调研·${research.message}`}
          {research.round && research.round > 0 && (
            <span className="ml-1.5 rounded-full border border-[var(--acc-line)] px-1.5 py-px text-[10px] leading-4 text-[var(--acc)]">
              第 {research.round} 轮重调研
            </span>
          )}
        </span>
        {searching && <span className="animate-blink text-[var(--acc)]">●</span>}
      </p>
      {/* 小红书命中计数行（任务 #122）：完成态始终显式展示，K=0 附 MCP 三态披露原文 */}
      {!searching && (
        <p className="mt-2 border-t border-[var(--line)] pt-2 text-[11px] leading-relaxed text-[var(--tx-2)]">
          <span className="tnum font-medium text-[var(--tx-1)]">小红书命中 {xhsHits} 条</span>
          {xhsDisclosure && <span className="text-[var(--tx-3)]"> · {xhsDisclosure}</span>}
        </p>
      )}
      {research.sources.length > 0 && (
        <ol className="mt-2 space-y-1.5 border-t border-[var(--line)] pt-2">
          {research.sources.map((s, i) => {
            const snippet = cleanSnippet(s.snippet);
            return (
              <li key={s.url} className="text-[11px] leading-relaxed">
                <div className="flex items-baseline gap-2">
                  <span className="tnum shrink-0 font-mono text-[var(--tx-3)]">{i + 1}.</span>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={s.url}
                    className="min-w-0 flex-1 truncate text-[var(--acc)] underline-offset-2 hover:underline"
                  >
                    {s.title}
                  </a>
                  <SourceBadge category={sourceCategoryOf(s.url, s.title)} />
                </div>
                {/* snippet 摘要（任务 #94；#108：caption 下限 11px），灰度小字 1-2 行截断，缺失不占位 */}
                {snippet && (
                  <p className="mt-0.5 line-clamp-2 pl-5 text-[11px] leading-snug text-[var(--tx-3)]">
                    {snippet}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 轻量 Markdown 渲染（含围栏代码块 → 折叠 JSON 卡，任务 #87）
// ---------------------------------------------------------------------------

type MdSegment =
  { kind: "text"; text: string } | { kind: "code"; lang: string; code: string; closed: boolean };

/** 把正文切成「普通文本 / 围栏代码块」两类片段；流式中未闭合的围栏标记 closed=false */
function splitSegments(text: string): MdSegment[] {
  // 兜底：整段就是一个裸 JSON 对象（无围栏）→ 直接按代码块处理
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && !trimmed.includes("```")) {
    return [{ kind: "code", lang: "json", code: trimmed, closed: trimmed.endsWith("}") }];
  }

  const segs: MdSegment[] = [];
  let buffer: string[] = [];
  let fence: { lang: string; lines: string[] } | null = null;

  const flushText = () => {
    if (buffer.length > 0) {
      segs.push({ kind: "text", text: buffer.join("\n") });
      buffer = [];
    }
  };

  for (const line of text.split("\n")) {
    if (fence) {
      if (/^```\s*$/.test(line)) {
        segs.push({ kind: "code", lang: fence.lang, code: fence.lines.join("\n"), closed: true });
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    const m = /^```(\S*)\s*$/.exec(line);
    if (m) {
      flushText();
      fence = { lang: m[1] || "", lines: [] };
      continue;
    }
    buffer.push(line);
  }
  // 流式中围栏未闭合：保留为未关闭代码块
  if (fence)
    segs.push({ kind: "code", lang: fence.lang, code: fence.lines.join("\n"), closed: false });
  flushText();
  return segs;
}

function MarkdownLite({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const segments = useMemo(() => splitSegments(text), [text]);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "code") {
          const isJson = seg.lang === "json" || looksLikeJson(seg.code);
          return isJson ? (
            <RecipeJsonCard
              key={`code-${i}`}
              code={seg.code}
              streaming={streaming && !seg.closed}
            />
          ) : (
            <PlainCodeBlock key={`code-${i}`} code={seg.code} />
          );
        }
        return <MarkdownLines key={`md-${i}`} text={seg.text} />;
      })}
    </>
  );
}

function MarkdownLines({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let listBuffer: string[] = [];
  let key = 0;

  const flushList = () => {
    if (listBuffer.length === 0) return;
    blocks.push(
      <ul key={`ul-${key++}`} className="space-y-1 pl-1">
        {listBuffer.map((item, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--acc)]" />
            <span>{renderInline(item)}</span>
          </li>
        ))}
      </ul>,
    );
    listBuffer = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*•]\s+/.test(line)) {
      listBuffer.push(line.replace(/^\s*[-*•]\s+/, ""));
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    if (line.startsWith("#### ")) {
      blocks.push(
        <h5 key={key++} className="pt-1 text-[13px] font-semibold text-[var(--tx-1)]">
          {renderInline(line.slice(5))}
        </h5>,
      );
    } else if (line.startsWith("### ")) {
      blocks.push(
        <h4 key={key++} className="pt-1 text-sm font-semibold text-[var(--tx-1)]">
          {renderInline(line.slice(4))}
        </h4>,
      );
    } else if (line.startsWith("## ")) {
      blocks.push(
        <h3
          key={key++}
          className="pt-2 text-base font-semibold tracking-[-0.01em] text-[var(--tx-1)]"
        >
          {renderInline(line.slice(3))}
        </h3>,
      );
    } else if (line.startsWith("# ")) {
      blocks.push(
        <h2
          key={key++}
          className="pt-2 font-display text-xl font-medium tracking-[-0.01em] text-[var(--tx-1)]"
        >
          {renderInline(line.slice(2))}
        </h2>,
      );
    } else {
      blocks.push(<p key={key++}>{renderInline(line)}</p>);
    }
  }
  flushList();
  return <>{blocks}</>;
}

// ---------------------------------------------------------------------------
// 折叠代码 / JSON 卡（任务 #87：默认折叠，避免原始 JSON 铺满整屏）
// ---------------------------------------------------------------------------

/** 粗判一段文本是否像 JSON 对象（围栏未标语言时的兜底识别） */
function looksLikeJson(code: string): boolean {
  const t = code.trim();
  if (!t.startsWith("{") || !/"\w+"\s*:/.test(t)) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return /"(grandWater|pours|doseGrams|flowRate|vibBefore)"/.test(t);
  }
}

/** 从不完整 JSON 文本里尽量提取摘要字段（流式中亦可显示） */
function summarizeRecipe(code: string): string[] {
  const parts: string[] = [];
  const name = /"name"\s*:\s*"([^"]+)"/.exec(code)?.[1];
  const dose = /"doseGrams"\s*:\s*([\d.]+)/.exec(code)?.[1];
  const water = /"grandWater"\s*:\s*([\d.]+)/.exec(code)?.[1];
  const pours =
    (code.match(/"theName"\s*:/g) ?? []).length || (code.match(/"volume"\s*:/g) ?? []).length;
  if (name) parts.push(name);
  if (dose) parts.push(`${dose}g${water ? ` / ${water}ml` : ""}`);
  if (pours > 0) parts.push(`${pours} 段注水`);
  return parts;
}

/** 云端配方 JSON：默认折叠一行摘要，展开核对缩进美化的完整数据 */
function RecipeJsonCard({ code, streaming }: { code: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeRecipe(code);
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(code.trim()), null, 2);
    } catch {
      return code;
    }
  }, [code]);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-inset)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--bg-card)_55%,transparent)]"
      >
        <span
          className="tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--acc-line)] bg-[var(--acc-soft)] font-mono text-[11px] font-semibold text-[var(--acc)]"
          aria-hidden
        >
          {"{}"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-[var(--tx-1)]">云端配方数据</span>
          <span className="tnum mt-0.5 block truncate text-[11px] text-[var(--tx-3)]">
            {streaming ? "正在生成…" : summary.length > 0 ? summary.join(" · ") : "完整上传载荷"}
          </span>
        </span>
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-[var(--acc)]">
          {streaming ? "生成中" : open ? "收起" : "展开核对"}
        </span>
        <span
          className={`shrink-0 text-[11px] text-[var(--tx-3)] transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          ▼
        </span>
      </button>
      {/* 折叠：grid-template-rows 0fr→1fr 400ms（任务 #108 P2） */}
      <div className="collapser" data-open={open}>
        <div className="collapser-inner">
          <pre className="tnum max-h-72 overflow-auto border-t border-[var(--line)] px-4 py-3 font-mono text-[11px] leading-relaxed text-[var(--tx-2)]">
            <code>{pretty}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}

/** 非 JSON 围栏代码：等宽滚动块（同样限高，不铺屏） */
function PlainCodeBlock({ code }: { code: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] px-4 py-3 font-mono text-[11px] leading-relaxed text-[var(--tx-2)]">
      <code>{code}</code>
    </pre>
  );
}

/** 行内：**粗体**、*斜体*、`代码` */
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-[var(--tx-1)]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <em key={i} className="text-[var(--tx-1)]">
          {part.slice(1, -1)}
        </em>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded bg-[var(--bg-inset)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--acc)]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

function IconBrain() {
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
        d="M12 3v18M12 3a4 4 0 0 0-4 4c-2 0-3.5 1.5-3.5 3.5S6 14 8 14a3 3 0 0 0 4 3M12 3a4 4 0 0 1 4 4c2 0 3.5 1.5 3.5 3.5S18 14 16 14a3 3 0 0 1-4 3"
        strokeLinecap="round"
      />
    </svg>
  );
}
