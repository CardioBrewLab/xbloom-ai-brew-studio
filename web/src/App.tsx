/**
 * xBloom AI Brew Studio —— 状态编排与页签导航。
 * 页签：工作台（三栏）/ 豆库 / 云端配方 / 对比。
 * 专业桌面工作台布局，亮色默认，暗色可选，持久化 localStorage。
 * 后端离线时不白屏：顶部友好提示，各面板自行降级。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import BeanForm from "./components/BeanForm.js";
import BlePanel from "./components/BlePanel.js";
import AppHeader, { type AppTab } from "./components/AppHeader.js";
import BrewRationaleCard from "./components/BrewRationaleCard.js";
import BrewTimeline from "./components/BrewTimeline.js";
import CandidatePickCard from "./components/CandidatePickCard.js";
import ErrorBoundary from "./components/ErrorBoundary.js";
import HistoryList from "./components/HistoryList.js";
import PublishPanel from "./components/PublishPanel.js";
import RecipeEditor from "./components/RecipeEditor.js";
import ResultActionBar from "./components/ResultActionBar.js";
import StatBlocks from "./components/StatBlocks.js";
import StepCards from "./components/StepCards.js";
import StreamPanel from "./components/StreamPanel.js";
import TuningDiffCard, { diffRecipes, type DiffItem } from "./components/TuningDiffCard.js";
import { btnPrimarySm, Card, CardHeader, StatusDot } from "./components/ui.js";
import {
  api,
  streamGenerate,
  type Bean,
  type BrewFeedback,
  type BrewRationaleItem,
  type CloudStatus,
  type GenerateRequest,
  type ResearchSource,
  type ReviewFinding,
  type SavedRecipe,
  type ServerConfig,
} from "./lib/api.js";
import { buildCurve, curveStateAt } from "./lib/curve-math.js";
import {
  CANDIDATES_IDLE,
  candidatesDoneNote,
  candidatesErrorReset,
  candidatesProgressText,
  contentChunkOf,
  reduceCandidatesEvent,
  shouldShowWinnerJson,
  type CandidatesState,
} from "./lib/candidates.js";
import { missingRecipeMessage } from "./lib/generation-run.js";
import type { Recipe } from "./lib/recipe-schema.js";
import {
  improvedRecipeName,
  reduceVariantEvent,
  VARIANT_IDLE,
  type VariantState,
} from "./lib/variant.js";
import { saveCompletionIsCurrent } from "./lib/save-state.js";

// Heavy charts, QR generation, secondary pages and modal workflows stay out of
// the initial desktop shell. This keeps the first workbench paint small while
// preserving every workflow once the user opens it.
const ApiSettingsModal = lazy(() => import("./components/ApiSettingsModal.js"));
const BrewGuide = lazy(() => import("./components/BrewGuide.js"));
const CurveChart = lazy(() => import("./components/CurveChart.js"));
const FeedbackModal = lazy(() => import("./components/FeedbackModal.js"));
const PublishPreviewModal = lazy(() => import("./components/PublishPreviewModal.js"));
const VariantCompareCard = lazy(() => import("./components/VariantCompareCard.js"));
const BeansPage = lazy(() => import("./pages/BeansPage.js"));
const CloudPage = lazy(() => import("./pages/CloudPage.js"));
const ComparePage = lazy(() => import("./pages/ComparePage.js"));

/** 联网调研进度（任务 #22：research SSE 事件聚合后的展示态） */
export interface ResearchInfo {
  phase: "idle" | "searching" | "done";
  /** 当前状态文案（如“正在联网调研：xxx”） */
  message: string;
  sources: ResearchSource[];
  /** done 时是否调研成功（false = 降级走知识库） */
  ok?: boolean;
  /** 调研摘要文本（保存配方时透传持久化，任务 #35） */
  summary?: string;
  /** 任务 #131：重调研轮次（round>0 = 第 N 轮重调研） */
  round?: number;
}

const RESEARCH_IDLE: ResearchInfo = { phase: "idle", message: "", sources: [] };

/** 自动 AI 审查展示态（任务 #36：review SSE 事件聚合） */
export interface ReviewInfo {
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

const REVIEW_IDLE: ReviewInfo = { phase: "idle", findings: [], fixed: false };

/** 多候选生成展示态（任务 #106）：candidates 事件聚合；N=1 时恒为 idle */
const CANDIDATES_RESET: CandidatesState = CANDIDATES_IDLE;

/** 生成阶段元数据（任务 #35/#36/#50）：保存配方时透传 refUrls/豆信息原文/调研摘要/审查结果/豆库关联持久化 */
interface GenMeta {
  refUrls?: string[];
  beanSnapshot?: string;
  researchSummary?: string;
  reviewFindings?: ReviewFinding[];
  /** 本次生成所选豆库豆档案 ID（仅当已选豆库豆时非空） */
  beanId?: string;
  /** 本次生成用户粘贴的烘焙商参考方案原文（任务 #57，仅当非空时存在） */
  roasterReference?: string;
  /** 方案解读（任务 #72，仅当 recipe 事件携带时存在） */
  brewRationale?: BrewRationaleItem[];
}

/** 反馈调参迭代上下文：记录 source={recipeId, feedbackId} 与基础配方，避免上下文丢失 */
interface RegenContext {
  baseRecipeId: string;
  feedbackId?: string;
  base: Recipe;
  /** 预期新版本号（服务端会按 parent 重新推导，以响应为准） */
  version: number;
}

/** 调参 Diff 展示态 */
interface TuningDiff {
  items: DiffItem[];
  changeNotes?: string;
  version?: number;
}

const THEME_KEY = "xbloom-theme";

export default function App() {
  // ---- 主题（亮色默认，持久化） ----
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "dark" ? "dark" : "light";
  });
  // 属性在渲染期同步：子组件（如 CurveChart 从 CSS 变量读色板）同帧即可取到新主题值（任务 #108）
  if (document.documentElement.dataset.theme !== theme) {
    document.documentElement.dataset.theme = theme;
  }
  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // ---- 页签 ----
  const [tab, setTab] = useState<AppTab>("workbench");

  // ---- 后端能力 / 连接状态 ----
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [backendUp, setBackendUp] = useState(true);

  const refreshConfig = useCallback(async () => {
    try {
      const next = await api.getConfig();
      setConfig(next);
      setBackendUp(true);
    } catch {
      setBackendUp(false);
    }
  }, []);

  const refreshCloud = useCallback(() => {
    api
      .cloudStatus()
      .then(setCloud)
      .catch(() => setCloud(null));
  }, []);

  useEffect(() => {
    void refreshConfig();
    refreshCloud();
  }, [refreshCloud, refreshConfig]);

  // ---- 豆库（三态：loading/ready/failed，失败才显示离线提示，任务 #65） ----
  const [beans, setBeans] = useState<Bean[] | null>(null);
  const [beansStatus, setBeansStatus] = useState<"loading" | "ready" | "failed">("loading");
  const refreshBeans = useCallback(() => {
    setBeansStatus("loading");
    api
      .listBeans()
      .then((res) => {
        setBeans(res.beans ?? []);
        setBeansStatus("ready");
      })
      .catch(() => {
        setBeans(null);
        setBeansStatus("failed");
      });
  }, []);
  useEffect(() => {
    refreshBeans();
  }, [refreshBeans]);

  // ---- 冲煮历史（与对比页共享） ----
  const [history, setHistory] = useState<SavedRecipe[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [saveRevision, setSaveRevision] = useState(0);

  const refreshHistory = useCallback(async () => {
    try {
      const res = await api.listRecipes();
      setHistory(res.recipes ?? []);
      setHistoryError("");
    } catch (e) {
      setHistory(null);
      setHistoryError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory, saveRevision]);

  // ---- 生成流 ----
  const [generating, setGenerating] = useState(false);
  const [reasoning, setReasoning] = useState("");
  const [content, setContent] = useState("");
  const [streamError, setStreamError] = useState("");
  const [research, setResearch] = useState<ResearchInfo>(RESEARCH_IDLE);
  const [review, setReview] = useState<ReviewInfo>(REVIEW_IDLE);
  /** 多候选生成状态机（任务 #106）：进度行 + 优选明细卡的数据源 */
  const [candidates, setCandidates] = useState<CandidatesState>(CANDIDATES_IDLE);
  /** 获胜 recipe 事件载荷 JSON（任务 #111 O3）：N>1 无 content 流，供 StreamPanel 渲染折叠卡 */
  const [winnerJson, setWinnerJson] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  /** 本次生成是否收到过 content 事件（任务 #114）：winnerJson 兜底卡仅在始终无 content 时渲染，防重复 JSON 卡 */
  const contentSeenRef = useRef(false);
  /** 生成会话 ID：每次发起递增，过期流的回调一律忽略（防竞态） */
  const generationIdRef = useRef(0);

  // ---- 配方 ----
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  /** 生成/载入配方后收起长表单，桌面结果区获得更多横向空间。 */
  const [inputCollapsed, setInputCollapsed] = useState(false);
  /** 豆仓 → 工作台的选豆意图；递增 revision 允许连续选择同一支豆。 */
  const [beanPrefill, setBeanPrefill] = useState<{ beanId: string; revision: number }>();
  const beanPrefillRevisionRef = useRef(0);
  const [clamped, setClamped] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  /** 当前本地历史条目；用于把回读确认后的云端 tableId 原子绑定到正确条目。 */
  const [localRecipeId, setLocalRecipeId] = useState<string | null>(null);
  /** 单配方保存请求与配方修订号：切换、编辑或重生成后，旧请求不得回写当前状态。 */
  const recipeRevisionRef = useRef(0);
  const saveRequestIdRef = useRef(0);
  const saveInFlightRef = useRef(false);
  /** 云端来源 tableId：从云端导入时记录，发布时存在则走更新（PUT）而非新建 */
  const [cloudTableId, setCloudTableId] = useState<string | null>(null);
  /** 反馈调参上下文（ref：generate 闭包内读取，避免状态过期） */
  const regenCtxRef = useRef<RegenContext | null>(null);
  /** 调参 Diff 摘要（有 baseRecipe 的生成完成后展示） */
  const [tuningDiff, setTuningDiff] = useState<TuningDiff | null>(null);
  /** 迭代版本自动落库后的提示（如“已保存为第 2 版”） */
  const [autoSavedNote, setAutoSavedNote] = useState("");
  /** 本次生成的调研/豆信息元数据（保存时透传持久化，任务 #35） */
  const [genMeta, setGenMeta] = useState<GenMeta | null>(null);
  /** 最近一次 generate 请求（取 beans 自由文本作为 beanSnapshot） */
  const lastGenReqRef = useRef<GenerateRequest | null>(null);
  /** research done 事件携带的调研摘要（ref：recipe 事件回调中读取避免状态过期） */
  const researchSummaryRef = useRef("");
  /** beanMatch 事件匹配到的 beanId（任务 #130：ref，recipe 事件回调中读取避免状态过期） */
  const matchedBeanIdRef = useRef<string | undefined>(undefined);

  // ---- 小红书账号（任务 #83）：调研事件检出登录失效时置警示态，非阻断 ----
  const [xhsExpired, setXhsExpired] = useState(false);
  // 任务 #99：稳定化回调——内联箭头会随每次渲染（含流式 delta）换身份，
  // 拖垮 XhsAccount 内依赖它的轮询 effect（interval 反复拆除重建 → 轮询饥饿）
  const clearXhsExpired = useCallback(() => setXhsExpired(false), []);

  // ---- 双方案对比（任务 #62）：variant 事件状态机，无 roasterReference 时恒为 idle ----
  const [variant, setVariant] = useState<VariantState>(VARIANT_IDLE);
  /** 烘焙师原版快照：采用改进版后可切回；新一轮生成重置 */
  const [originalRecipe, setOriginalRecipe] = useState<Recipe | null>(null);
  const [originalClamped, setOriginalClamped] = useState<string[]>([]);
  /** 方案解读（任务 #72）：当前采用方案的 brewRationale；缺失时 undefined 不渲染卡片 */
  const [brewRationale, setBrewRationale] = useState<BrewRationaleItem[] | undefined>(undefined);
  /** 原版方案解读快照：采用改进版后可随切回原版恢复 */
  const [originalBrewRationale, setOriginalBrewRationale] = useState<
    BrewRationaleItem[] | undefined
  >(undefined);
  /** 当前工作台采用的方案：编辑器/保存/发布/BLE 均跟随主 recipe 状态 */
  const [activeVariant, setActiveVariant] = useState<"original" | "improved">("original");
  const [savingPair, setSavingPair] = useState(false);

  // ---- 时间线播放头 ----
  const [playTime, setPlayTime] = useState(0);
  const [playheadOn, setPlayheadOn] = useState(false);
  const timelineChange = useCallback((t: number) => {
    setPlayTime(t);
    setPlayheadOn(true);
  }, []);

  // ---- 引导式冲煮（任务 #95）：全屏引导计时器开关 ----
  const [guideOpen, setGuideOpen] = useState(false);

  const invalidatePendingSave = useCallback(() => {
    saveRequestIdRef.current += 1;
    saveInFlightRef.current = false;
    setSaving(false);
  }, []);

  const replaceActiveRecipe = useCallback(
    (next: Recipe) => {
      recipeRevisionRef.current += 1;
      invalidatePendingSave();
      setRecipe(next);
    },
    [invalidatePendingSave],
  );

  /** 编辑已保存配方后重新标记为待保存；云端来源绑定保持不变，后续上传仍更新同一条记录。 */
  const handleRecipeChange = useCallback(
    (next: Recipe) => {
      replaceActiveRecipe(next);
      setSavedAt(undefined);
      setLocalRecipeId(null);
    },
    [replaceActiveRecipe],
  );

  /** 豆仓推荐/豆卡直达工作台，保留 BeanForm 现有输入并只替换所选豆。 */
  const startFromBean = useCallback((beanId: string) => {
    beanPrefillRevisionRef.current += 1;
    setBeanPrefill({ beanId, revision: beanPrefillRevisionRef.current });
    setInputCollapsed(false);
    setTab("workbench");
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }, []);

  const generate = useCallback(
    (req: GenerateRequest) => {
      abortRef.current?.abort();
      invalidatePendingSave();
      const controller = new AbortController();
      abortRef.current = controller;
      const genId = ++generationIdRef.current;
      /** 过期流的回调一律丢弃：只有当前会话才允许更新状态 */
      const stale = () => generationIdRef.current !== genId;
      let receivedRecipe = false;
      let receivedError = false;
      const failGeneration = (message: string) => {
        receivedError = true;
        setStreamError(message);
        setGenerating(false);
        setInputCollapsed(false);
        setResearch((state) =>
          state.phase === "searching"
            ? { ...state, phase: "done", ok: false, message: "调研随本次生成结束" }
            : state,
        );
        setReview((state) => (state.phase === "reviewing" ? { ...state, phase: "done" } : state));
        setCandidates((state) => candidatesErrorReset(state));
        setVariant((state) =>
          state.phase === "running"
            ? { ...state, phase: "failed", message: "改进方案随本次生成结束" }
            : state,
        );
      };
      const finishGeneration = () => {
        setGenerating(false);
        const message = missingRecipeMessage(receivedRecipe, receivedError);
        if (message) failGeneration(message);
      };

      setGenerating(true);
      setReasoning("");
      setContent("");
      setStreamError("");
      setResearch(RESEARCH_IDLE);
      setReview(REVIEW_IDLE);
      setCandidates(CANDIDATES_RESET);
      setWinnerJson("");
      // 双方案对比状态全部重置（任务 #62）：新一轮生成从零开始
      setVariant(VARIANT_IDLE);
      setOriginalRecipe(null);
      setOriginalClamped([]);
      setBrewRationale(undefined);
      setOriginalBrewRationale(undefined);
      setActiveVariant("original");
      setSavingPair(false);
      lastGenReqRef.current = req;
      researchSummaryRef.current = "";
      contentSeenRef.current = false;
      matchedBeanIdRef.current = undefined;
      if (!req.baseRecipe) regenCtxRef.current = null; // 非调参生成 → 清理残留上下文
      setPlayTime(0);
      setPlayheadOn(false);
      setGuideOpen(false); // 新一轮生成 → 关闭旧配方的引导冲煮（任务 #95）

      void streamGenerate(
        req,
        {
          onEvent: (event) => {
            if (stale()) return;
            switch (event.type) {
              // 任务 #130：beanMatch 事件——自由文本匹配到豆仓豆，存储 beanId 供 recipe 事件建 genMeta 用
              case "beanMatch":
                matchedBeanIdRef.current = event.beanId;
                break;
              case "research":
                if (event.stage === "start") {
                  setResearch((previous) => ({
                    phase: "searching",
                    message: event.query ? `正在联网调研：${event.query}` : "正在联网调研…",
                    sources: event.round && event.round > 0 ? previous.sources : [],
                    ...(event.round ? { round: event.round } : {}),
                  }));
                } else if (event.stage === "source") {
                  setResearch((r) =>
                    r.phase === "idle" || !event.title || !event.url
                      ? r
                      : {
                          ...r,
                          sources: r.sources.some((s) => s.url === event.url)
                            ? r.sources
                            : [
                                ...r.sources,
                                {
                                  title: event.title,
                                  url: event.url,
                                  ...(event.snippet ? { snippet: event.snippet } : {}),
                                },
                              ],
                        },
                  );
                } else {
                  if (event.summary) {
                    const roundLabel = `第 ${(event.round ?? 0) + 1} 轮调研`;
                    const block = `${roundLabel}\n${event.summary}`;
                    if (!researchSummaryRef.current.includes(block)) {
                      researchSummaryRef.current = [researchSummaryRef.current, block]
                        .filter(Boolean)
                        .join("\n\n");
                    }
                  }
                  // 小红书登录失效（任务 #83）：顶栏徽标转警示态，不打断生成流程
                  if (event.xhsLoginExpired) setXhsExpired(true);
                  setResearch((r) => ({
                    phase: "done",
                    message:
                      event.message ?? (event.ok ? "调研完成" : "未找到公开资料，基于知识库生成"),
                    sources: [...r.sources, ...(event.sources ?? [])].filter(
                      (source, index, all) =>
                        all.findIndex((item) => item.url === source.url) === index,
                    ),
                    ok: event.ok ?? false,
                    summary: event.summary,
                    ...(event.round ? { round: event.round } : {}),
                  }));
                }
                break;
              case "reasoning":
                // 带 variant:"improved" 的增量不并入主思考流，静默累计进对比卡缓冲（任务 #62）
                if (event.variant === "improved") {
                  setVariant((s) => reduceVariantEvent(s, event));
                  break;
                }
                setReasoning((r) => r + event.delta);
                break;
              case "review":
                // 自动审查事件（任务 #36）：start → 审查中；findings → 首轮问题清单；fixed → 终结态
                if (event.stage === "start") {
                  setReview({ phase: "reviewing", findings: [], fixed: false });
                } else if (event.stage === "findings") {
                  setReview((r) => ({ ...r, preFindings: event.findings ?? [] }));
                } else {
                  setReview((r) => ({
                    phase: "done",
                    findings: event.findings ?? [],
                    preFindings: event.preFindings ?? r.preFindings,
                    fixed: event.fixed ?? false,
                    dimensions: event.dimensions,
                  }));
                }
                break;
              case "content":
                if (event.variant === "improved") {
                  setVariant((s) => reduceVariantEvent(s, event));
                  break;
                }
                // 标准渲染路径（任务 #114）：收到 content 即标记，recipe 事件不再捕获 winnerJson 兜底卡
                contentSeenRef.current = true;
                // 载荷二选一（任务 #116）：N=1 增量在 delta，N>1 补发正文在 content 字段，回退空串防 "undefined" 脏文本
                setContent((c) => c + contentChunkOf(event));
                break;
              case "variant":
                // variant:start → running；variant:result 按 ok → ready/failed（任务 #62）
                setVariant((s) => reduceVariantEvent(s, event));
                break;
              case "candidates":
                // 多候选生成事件（任务 #106）：start/progress/picked 聚合进状态机
                setCandidates((s) => reduceCandidatesEvent(s, event));
                break;
              case "recipe":
                receivedRecipe = true;
                // 新结果真正到达后再解绑旧结果。请求失败时，旧配方及其保存/云端
                // 关联保持完整，避免页面显示旧配方却丢失其原始元数据。
                setClamped([]);
                setSavedAt(undefined);
                setLocalRecipeId(null);
                setCloudTableId(null);
                setTuningDiff(null);
                setAutoSavedNote("");
                setGenMeta(null);
                // recipe 事件可能携带 candidateScore（任务 #106）：同步进状态机
                setCandidates((s) => reduceCandidatesEvent(s, event));
                // 获胜载荷快照（任务 #111 O3；#114 互斥）：仅 N>1 且本次始终未收到 content 事件时兜底；
                // content 到达后走标准 splitSegments/RecipeJsonCard 路径，两卡不得同时出现
                setWinnerJson(
                  shouldShowWinnerJson(Boolean(event.candidateScore), contentSeenRef.current)
                    ? JSON.stringify(event.recipe)
                    : "",
                );
                replaceActiveRecipe(event.recipe);
                // 结果真实到达后再收起输入；请求失败或流中断时输入始终留在眼前。
                setInputCollapsed(true);
                setClamped(event.clamped);
                // 原版快照落存：供对比卡 diff/切回（任务 #62）
                setOriginalRecipe(event.recipe);
                setOriginalClamped(event.clamped);
                // 方案解读（任务 #72）：缺失/空数组时置 undefined，卡片不渲染
                const rationale = event.brewRationale?.length ? event.brewRationale : undefined;
                setBrewRationale(rationale);
                setOriginalBrewRationale(rationale);
                setActiveVariant("original");
                // 生成元数据（任务 #35）：refUrls 来自 recipe 事件，豆原文/调研摘要取自本次请求与 research 聚合
                {
                  const meta: GenMeta = {
                    ...(event.refUrls?.length ? { refUrls: event.refUrls } : {}),
                    ...(lastGenReqRef.current?.beans?.trim()
                      ? { beanSnapshot: lastGenReqRef.current.beans.trim() }
                      : {}),
                    ...(researchSummaryRef.current
                      ? { researchSummary: researchSummaryRef.current }
                      : {}),
                    ...(event.reviewFindings?.length
                      ? { reviewFindings: event.reviewFindings }
                      : {}),
                    // 豆库关联落库（任务 #50/#130）：beanMatch 事件匹配的 beanId 优先（粘贴 AI 归类路径），
                    // 回退到用户手选的 beanId（选豆库豆路径）——修复 AI 归类清空 beanId 后关联断裂根因
                    ...((matchedBeanIdRef.current ?? lastGenReqRef.current?.beanId)
                      ? { beanId: (matchedBeanIdRef.current ?? lastGenReqRef.current?.beanId)! }
                      : {}),
                    // 烘焙商参考方案原文（任务 #57）：照 beanSnapshot 写法，仅当非空时透传
                    ...(lastGenReqRef.current?.roasterReference?.trim()
                      ? { roasterReference: lastGenReqRef.current.roasterReference.trim() }
                      : {}),
                    // 方案解读（任务 #72）：照 reviewFindings 写法，仅当非空时透传
                    ...(event.brewRationale?.length ? { brewRationale: event.brewRationale } : {}),
                  };
                  setGenMeta(Object.keys(meta).length > 0 ? meta : null);
                }
                // 反馈调参流程：展示 Diff + 自动保存为新版本（跳过手动保存引导）并回填追溯
                {
                  const ctx = regenCtxRef.current;
                  if (ctx) {
                    regenCtxRef.current = null;
                    const newRecipe = event.recipe;
                    setTuningDiff({
                      items: diffRecipes(ctx.base, newRecipe),
                      changeNotes: event.changeNotes,
                    });
                    void (async () => {
                      const name = `${ctx.base.name} · v${ctx.version}`;
                      try {
                        const res = await api.saveRecipe(newRecipe, {
                          name,
                          parentId: ctx.baseRecipeId,
                          ...(ctx.feedbackId ? { sourceFeedbackId: ctx.feedbackId } : {}),
                          ...(event.changeNotes ? { changeNotes: event.changeNotes } : {}),
                          // 调研/豆信息快照同步落库（任务 #35）
                          ...(event.refUrls?.length ? { refUrls: event.refUrls } : {}),
                          ...(lastGenReqRef.current?.beans?.trim()
                            ? { beanSnapshot: lastGenReqRef.current.beans.trim() }
                            : {}),
                          ...(researchSummaryRef.current
                            ? { researchSummary: researchSummaryRef.current }
                            : {}),
                          // 审查遗留 findings 同步落库（任务 #36）
                          ...(event.reviewFindings?.length
                            ? { reviewFindings: event.reviewFindings }
                            : {}),
                          // 豆库关联落库（任务 #50/#130）：beanMatch 优先，回退到手选 beanId
                          ...((matchedBeanIdRef.current ?? lastGenReqRef.current?.beanId)
                            ? {
                                beanId: (matchedBeanIdRef.current ??
                                  lastGenReqRef.current?.beanId)!,
                              }
                            : {}),
                          // 烘焙商参考方案原文同步落库（任务 #57）
                          ...(lastGenReqRef.current?.roasterReference?.trim()
                            ? { roasterReference: lastGenReqRef.current.roasterReference.trim() }
                            : {}),
                          // 方案解读同步落库（任务 #72）
                          ...(event.brewRationale?.length
                            ? { brewRationale: event.brewRationale }
                            : {}),
                        });
                        if (stale()) return;
                        // 双保险回填：POST 时已自动回填，PATCH 兼容 feedbackId 晚到/丢失场景
                        if (ctx.feedbackId) {
                          await api
                            .patchFeedbackResulting(ctx.baseRecipeId, ctx.feedbackId, res.id)
                            .catch(() => undefined);
                        }
                        if (stale()) return;
                        const v = res.version ?? ctx.version;
                        setTuningDiff((d) => (d ? { ...d, version: v } : d));
                        setSavedAt(Date.now()); // 已落库 → 跳过手动保存引导
                        setLocalRecipeId(res.id);
                        setAutoSavedNote(`已保存为第 ${v} 版「${name}」，可在冲煮历史中查看迭代链`);
                        setSaveRevision((r) => r + 1);
                      } catch (e) {
                        if (stale()) return;
                        setStreamError(`调参版本自动保存失败：${(e as Error).message}`);
                      }
                    })();
                  }
                }
                break;
              case "error":
                failGeneration(event.message);
                break;
              case "done":
                finishGeneration();
                break;
            }
          },
          onError: (message) => {
            if (stale()) return;
            failGeneration(message);
          },
          onDone: () => {
            if (stale()) return;
            finishGeneration();
          },
        },
        controller.signal,
      );
    },
    [invalidatePendingSave, replaceActiveRecipe],
  );

  const saveRecipe = useCallback(async () => {
    if (!recipe || saveInFlightRef.current) return;
    const requestId = ++saveRequestIdRef.current;
    const recipeRevision = recipeRevisionRef.current;
    const isCurrentSave = () =>
      saveCompletionIsCurrent(
        requestId,
        recipeRevision,
        saveRequestIdRef.current,
        recipeRevisionRef.current,
      );
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const res = await api.saveRecipe(recipe, {
        ...(genMeta?.refUrls?.length ? { refUrls: genMeta.refUrls } : {}),
        ...(genMeta?.beanSnapshot ? { beanSnapshot: genMeta.beanSnapshot } : {}),
        ...(genMeta?.researchSummary ? { researchSummary: genMeta.researchSummary } : {}),
        ...(genMeta?.reviewFindings?.length ? { reviewFindings: genMeta.reviewFindings } : {}),
        // 豆库关联落库（任务 #50）：仅当本次生成已选豆库豆时非空
        ...(genMeta?.beanId ? { beanId: genMeta.beanId } : {}),
        // 烘焙商参考方案原文（任务 #57）：仅当本次生成非空时透传
        ...(genMeta?.roasterReference ? { roasterReference: genMeta.roasterReference } : {}),
        // 方案解读（任务 #72）：照 changeNotes 保存模式，仅当非空时透传持久化
        ...(genMeta?.brewRationale?.length ? { brewRationale: genMeta.brewRationale } : {}),
        // 双方案对比（任务 #62）：单独保存时标记当前采用方案的 variant（行为不变，仅多一个标识字段）
        variant: activeVariant,
      });
      if (!isCurrentSave()) return;
      if (res.warning) console.info(`[xBloom] 保存提示：${res.warning}`);
      setSavedAt(Date.now());
      setLocalRecipeId(res.id);
      setSaveRevision((r) => r + 1);
    } catch (e) {
      if (!isCurrentSave()) return;
      setStreamError(`保存失败：${(e as Error).message}`);
    } finally {
      if (saveRequestIdRef.current === requestId) {
        saveInFlightRef.current = false;
        setSaving(false);
      }
    }
  }, [recipe, genMeta, activeVariant]);

  /** 采用改进版（任务 #62）：improved 载入主 recipe 状态，编辑器/保存/发布/BLE 全走现有链路 */
  const adoptImproved = useCallback(() => {
    if (!variant.improved) return;
    replaceActiveRecipe(variant.improved.recipe);
    setClamped(variant.improved.clamped);
    // 方案解读（任务 #73）：改进版载荷携带时展示其解读；缺失时置空避免展示原版的过期解读
    setBrewRationale(
      variant.improved.brewRationale?.length ? variant.improved.brewRationale : undefined,
    );
    setActiveVariant("improved");
    setSavedAt(undefined); // 新方案未落库，恢复保存引导
    setLocalRecipeId(null);
    setCloudTableId(null); // 新方案与云端来源解绑，发布走新建
  }, [replaceActiveRecipe, variant.improved]);

  /** 切回原版（任务 #62）：两份状态均保留，随时往返 */
  const revertOriginal = useCallback(() => {
    if (!originalRecipe) return;
    replaceActiveRecipe(originalRecipe);
    setClamped(originalClamped);
    setBrewRationale(originalBrewRationale);
    setActiveVariant("original");
    setSavedAt(undefined);
    setLocalRecipeId(null);
    setCloudTableId(null);
  }, [originalRecipe, originalClamped, originalBrewRationale, replaceActiveRecipe]);

  /** 保存两个方案（任务 #62）：先存原版（variant:"original"），成功后存改进版（name 附后缀、pairId=原版 id） */
  const saveBoth = useCallback(async () => {
    if (!originalRecipe || !variant.improved || savingPair) return;
    const genId = generationIdRef.current;
    setSavingPair(true);
    try {
      // 共享透传：beanId/beanSnapshot/researchSummary/roasterReference/refUrls 等既有元数据
      const shared = {
        ...(genMeta?.beanSnapshot ? { beanSnapshot: genMeta.beanSnapshot } : {}),
        ...(genMeta?.researchSummary ? { researchSummary: genMeta.researchSummary } : {}),
        ...(genMeta?.beanId ? { beanId: genMeta.beanId } : {}),
        ...(genMeta?.roasterReference ? { roasterReference: genMeta.roasterReference } : {}),
      };
      const resOriginal = await api.saveRecipe(originalRecipe, {
        ...shared,
        ...(genMeta?.refUrls?.length ? { refUrls: genMeta.refUrls } : {}),
        ...(genMeta?.reviewFindings?.length ? { reviewFindings: genMeta.reviewFindings } : {}),
        // 方案解读随原版落库（任务 #72）
        ...(genMeta?.brewRationale?.length ? { brewRationale: genMeta.brewRationale } : {}),
        variant: "original",
      });
      if (generationIdRef.current !== genId) return; // 已发起新一轮生成，弃置本次保存
      const improvedName = improvedRecipeName(originalRecipe.name);
      const resImproved = await api.saveRecipe(variant.improved.recipe, {
        name: improvedName,
        ...shared,
        ...(variant.improved.refUrls?.length ? { refUrls: variant.improved.refUrls } : {}),
        ...(variant.improved.reviewFindings?.length
          ? { reviewFindings: variant.improved.reviewFindings }
          : {}),
        // 改进版方案解读同步落库（任务 #73）：与原版条目各自携带自己的 brewRationale
        ...(variant.improved.brewRationale?.length
          ? { brewRationale: variant.improved.brewRationale }
          : {}),
        variant: "improved",
        pairId: resOriginal.id,
      });
      if (generationIdRef.current !== genId) return;
      setSavedAt(Date.now());
      setLocalRecipeId(activeVariant === "improved" ? resImproved.id : resOriginal.id);
      setAutoSavedNote(
        `已保存双方案：「${originalRecipe.name}」与「${improvedName}」，可在冲煮历史中查看`,
      );
      setSaveRevision((r) => r + 1);
    } catch (e) {
      if (generationIdRef.current !== genId) return;
      setStreamError(`保存失败：${(e as Error).message}`);
    } finally {
      if (generationIdRef.current === genId) setSavingPair(false);
    }
  }, [originalRecipe, variant.improved, genMeta, savingPair, activeVariant]);

  const loadHistoryRecipe = useCallback(
    (r: Recipe, tableId?: string, storedId?: string) => {
      // 历史/云端载入优先于正在进行的生成：中断旧流并让过期回调全部失效。
      abortRef.current?.abort();
      abortRef.current = null;
      generationIdRef.current += 1;
      setGenerating(false);
      setReasoning("");
      setContent("");
      setStreamError("");
      setResearch(RESEARCH_IDLE);
      setReview(REVIEW_IDLE);
      setCandidates(CANDIDATES_RESET);
      setWinnerJson("");
      contentSeenRef.current = false;
      researchSummaryRef.current = "";
      matchedBeanIdRef.current = undefined;
      replaceActiveRecipe(r);
      setInputCollapsed(true);
      setClamped([]);
      // 本地历史/豆仓关联配方本来就已落库；云端导入尚未保存到本地。
      setSavedAt(storedId ? Date.now() : undefined);
      setLocalRecipeId(storedId ?? null);
      setCloudTableId(tableId ?? null);
      setTuningDiff(null);
      setAutoSavedNote("");
      setGenMeta(null); // 历史配方不带本次生成元数据，避免误附旧调研信息
      // 历史载入与双方案对比无关，清理残留（任务 #62）
      setVariant(VARIANT_IDLE);
      setOriginalRecipe(null);
      setOriginalClamped([]);
      setBrewRationale(undefined);
      setOriginalBrewRationale(undefined);
      setActiveVariant("original");
      setPlayTime(0);
      setPlayheadOn(false);
      setGuideOpen(false); // 历史载入 → 关闭上一份配方的引导冲煮（任务 #95）
      setTab("workbench");
      requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    },
    [replaceActiveRecipe],
  );

  const loadStoredRecipe = useCallback(
    (entry: SavedRecipe) => loadHistoryRecipe(entry.recipe, entry.cloudTableId, entry.id),
    [loadHistoryRecipe],
  );

  const bindVerifiedCloudRecipe = useCallback(
    async (tableId: string) => {
      if (localRecipeId) {
        await api.bindRecipeCloud(localRecipeId, tableId);
      } else if (recipe) {
        const saved = await api.saveRecipe(recipe, {
          ...(genMeta?.refUrls?.length ? { refUrls: genMeta.refUrls } : {}),
          ...(genMeta?.beanSnapshot ? { beanSnapshot: genMeta.beanSnapshot } : {}),
          ...(genMeta?.researchSummary ? { researchSummary: genMeta.researchSummary } : {}),
          ...(genMeta?.reviewFindings?.length ? { reviewFindings: genMeta.reviewFindings } : {}),
          ...(genMeta?.beanId ? { beanId: genMeta.beanId } : {}),
          ...(genMeta?.roasterReference ? { roasterReference: genMeta.roasterReference } : {}),
          ...(genMeta?.brewRationale?.length ? { brewRationale: genMeta.brewRationale } : {}),
          variant: activeVariant,
          cloudTableId: tableId,
        });
        setLocalRecipeId(saved.id);
        setSavedAt(Date.now());
      }
      setCloudTableId(tableId);
      setSaveRevision((revision) => revision + 1);
    },
    [activeVariant, genMeta, localRecipeId, recipe],
  );

  const deleteHistory = useCallback(async (id: string) => {
    try {
      await api.deleteRecipe(id);
      setCompareIds((ids) => ids.filter((x) => x !== id));
      setSaveRevision((r) => r + 1);
    } catch (e) {
      setHistoryError((e as Error).message);
    }
  }, []);

  // ---- 对比选择（至多 2 个，超出替换第二个） ----
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const toggleCompare = useCallback((id: string) => {
    setCompareIds((ids) => {
      if (ids.includes(id)) return ids.filter((x) => x !== id);
      if (ids.length >= 2) return [ids[0], id];
      return [...ids, id];
    });
  }, []);
  const compareEntries = useMemo(
    () =>
      compareIds
        .map((id) => history?.find((h) => h.id === id))
        .filter((x): x is SavedRecipe => !!x),
    [compareIds, history],
  );

  // ---- 冲煮日志反馈闭环（多轮迭代：记录 source={recipeId, feedbackId} 与 baseRecipe 上下文） ----
  const [feedbackEntry, setFeedbackEntry] = useState<SavedRecipe | null>(null);
  const handleRegenerate = useCallback(
    (feedback: BrewFeedback, feedbackId?: string) => {
      const entry = feedbackEntry;
      const base = entry?.recipe;
      if (!entry || !base) return;
      const version = (entry.version ?? 1) + 1;
      regenCtxRef.current = { baseRecipeId: entry.id, feedbackId, base, version };
      const tasteText = feedback.taste.length > 0 ? feedback.taste.join("、") : "整体可接受";
      generate({
        description:
          `根据冲煮反馈对配方「${base.name}」进行针对性调参。` +
          `实际表现为：${tasteText}（评分 ${feedback.rating}/5）。` +
          (feedback.note ? `冲煮者备注：${feedback.note}。` : "") +
          `请在保留原配方风格骨架的前提下调整参数，并解释调整逻辑。`,
        baseRecipe: base,
        feedback,
        baseRecipeId: entry.id,
        cupType: base.cupType,
        // 父版豆库关联透传（任务 #65）：迭代版本自动保存时带上 beanId，
        // 修复版本链关联断裂；同时带入豆快照供 prompt 上下文与后端落档判定
        ...(entry.beanId ? { beanId: entry.beanId } : {}),
        ...(entry.beanSnapshot ? { beans: entry.beanSnapshot } : {}),
      });
      setTab("workbench");
    },
    [feedbackEntry, generate],
  );

  // ---- 发布预览 ----
  const [previewOpen, setPreviewOpen] = useState(false);

  // ---- 本机模型接口设置 ----
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ---- 中栏曲线模型 ----
  const curve = useMemo(() => (recipe ? buildCurve(recipe) : null), [recipe]);
  const playState = curve && playheadOn ? curveStateAt(curve, playTime) : null;
  const showStreamPanel =
    !recipe ||
    generating ||
    Boolean(reasoning || content || streamError || winnerJson) ||
    research.phase !== "idle" ||
    review.phase !== "idle" ||
    candidates.phase !== "idle";
  const workbenchGridClass = inputCollapsed
    ? "xl:grid-cols-[232px_minmax(0,1fr)_360px]"
    : "xl:grid-cols-[360px_minmax(0,1fr)_360px]";

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--bg-page)] text-[var(--tx-1)]">
      {/* 紧凑桌面栏：导航、连接状态和设置保持在单行，不挤占工作画布。 */}
      <AppHeader
        activeTab={tab}
        onTabChange={setTab}
        compareCount={compareIds.length}
        backendUp={backendUp}
        cloud={cloud}
        xhsExpired={xhsExpired}
        onClearXhsExpired={clearXhsExpired}
        onOpenSettings={() => setSettingsOpen(true)}
        theme={theme}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
      />

      {/* 离线提示：单行浅色 banner */}
      {!backendUp && (
        <div className="border-b border-[var(--line)] bg-[var(--bg-inset)]">
          <div className="mx-auto flex h-11 max-w-[1600px] items-center gap-2 px-6 text-xs text-[var(--tx-2)]">
            <StatusDot tone="warn" />
            <span>
              后端服务未启动，界面以离线模式展示 —— 请在仓库根目录运行{" "}
              <code className="rounded bg-[var(--bg-card)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--tx-1)]">
                npm run dev
              </code>{" "}
              后刷新页面。
            </span>
          </div>
        </div>
      )}

      {/* ============================ 工作台 ============================ */}
      {/* 工作台保持挂载，以保留长表单输入；每个页签使用独立错误边界。 */}
      <ErrorBoundary>
        <main
          hidden={tab !== "workbench"}
          className={`workbench-shell animate-fade-up grid w-full grid-cols-1 gap-4 p-4 lg:grid-cols-2 xl:gap-0 xl:p-0 ${workbenchGridClass}`}
        >
          {/* 左：输入区 */}
          <div className="workspace-column workspace-rail space-y-4">
            <BeanForm
              models={config?.models ?? []}
              defaultModel={config?.defaultModel ?? ""}
              generating={generating}
              onGenerate={generate}
              beans={beans ?? []}
              onOpenBeans={() => setTab("beans")}
              collapsed={inputCollapsed}
              onExpand={() => setInputCollapsed(false)}
              activeRecipeName={recipe?.name}
              prefillBean={beanPrefill}
            />
          </div>

          {/* 中：AI 思考 + 统计块 + 曲线 + 播放器 + 步骤卡 + 编辑器 */}
          <div className="workspace-column workspace-canvas space-y-4">
            {recipe && !generating && (
              <ResultActionBar
                recipeName={recipe.name}
                canBrew={recipe.pours.length > 0}
                saving={saving}
                saved={savedAt !== undefined}
                cloudLoggedIn={cloud?.loggedIn ?? false}
                cloudTableId={cloudTableId ?? undefined}
                onUpload={() => setPreviewOpen(true)}
                onBrew={() => setGuideOpen(true)}
                onSave={() => void saveRecipe()}
                onEditInput={() => setInputCollapsed(false)}
              />
            )}

            {showStreamPanel && (
              <StreamPanel
                reasoning={reasoning}
                content={content}
                streaming={generating}
                error={streamError}
                research={research}
                review={review}
                candidatesProgress={
                  candidates.phase === "running"
                    ? candidatesProgressText(candidates)
                    : candidates.phase === "picked" && !recipe
                      ? `优选完成 · 采用候选 ${(candidates.winner ?? 0) + 1}，审查中…`
                      : ""
                }
                doneNote={candidatesDoneNote(candidates) || undefined}
                recipeJson={winnerJson || undefined}
              />
            )}

            {autoSavedNote && (
              <div className="animate-fade-up flex items-center gap-2 rounded-xl border border-[var(--acc-line)] bg-[var(--acc-soft)] px-4 py-3 text-xs font-medium text-[var(--acc)]">
                <span aria-hidden>✓</span>
                <span>{autoSavedNote}</span>
              </div>
            )}

            {tuningDiff && (
              <TuningDiffCard
                items={tuningDiff.items}
                changeNotes={tuningDiff.changeNotes}
                version={tuningDiff.version}
              />
            )}

            {/* 双方案对比卡（任务 #62）：recipe 交付后且出现过 variant 事件才渲染 */}
            {recipe && originalRecipe && variant.phase !== "idle" && (
              <Suspense fallback={<PanelLoading label="正在打开双方案对比" />}>
                <VariantCompareCard
                  phase={variant.phase}
                  original={originalRecipe}
                  improved={variant.improved}
                  failMessage={variant.message}
                  buffer={variant.buffer}
                  activeVariant={activeVariant}
                  savingPair={savingPair}
                  theme={theme}
                  onAdoptImproved={adoptImproved}
                  onRevertOriginal={revertOriginal}
                  onSaveBoth={() => void saveBoth()}
                />
              </Suspense>
            )}

            {/* 方案解读卡（任务 #72）：recipe 事件携带 brewRationale 时才渲染，空态不占位 */}
            {recipe && brewRationale && brewRationale.length > 0 && (
              <BrewRationaleCard items={brewRationale} />
            )}

            {recipe && (
              <>
                {/* 结果揭示 stagger（任务 #108 P2）：StreamPanel → StatBlocks → 曲线 → 步骤，40ms × index */}
                <div className="animate-fade-up" style={{ animationDelay: "40ms" }}>
                  <StatBlocks recipe={recipe} />
                </div>

                <Card className="overflow-hidden" style={{ animationDelay: "80ms" }}>
                  <CardHeader
                    title="冲煮曲线"
                    sub={`${recipe.pours.length} 段注水 · ${recipe.grandWater}ml · 点击曲线可定位播放头`}
                    right={
                      <div className="flex shrink-0 items-center gap-2.5">
                        <CurveLegend />
                        {/* 引导冲煮入口（任务 #95）：有 pours 才可用 */}
                        <button
                          type="button"
                          onClick={() => setGuideOpen(true)}
                          disabled={recipe.pours.length === 0}
                          className={btnPrimarySm}
                        >
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            aria-hidden
                          >
                            <path d="M8 5.5v13a1 1 0 0 0 1.53.85l10.2-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5z" />
                          </svg>
                          开始冲煮
                        </button>
                      </div>
                    }
                  />
                  <div className="p-5">
                    <Suspense
                      fallback={
                        <div
                          className="h-[280px] animate-pulse rounded-lg bg-[var(--bg-inset)]"
                          aria-label="冲煮曲线加载中"
                        />
                      }
                    >
                      <CurveChart
                        entries={[{ recipe }]}
                        playTime={playheadOn ? playTime : null}
                        onSeek={timelineChange}
                        theme={theme}
                        height={280}
                      />
                    </Suspense>
                  </div>
                  {curve && (
                    <div className="px-5 pb-5">
                      <BrewTimeline curve={curve} time={playTime} onTime={timelineChange} />
                    </div>
                  )}
                </Card>

                <div className="animate-fade-up" style={{ animationDelay: "120ms" }}>
                  <StepCards
                    recipe={recipe}
                    activeIndex={playheadOn ? playState?.segmentIndex : undefined}
                    inPause={playState?.inPause}
                    onJump={(t) => timelineChange(t)}
                  />
                </div>
              </>
            )}

            {clamped.length > 0 && (
              <div className="animate-fade-up rounded-xl border border-[var(--acc-line)] bg-[var(--acc-soft)] px-4 py-3 text-xs leading-relaxed text-[var(--tx-2)]">
                <p className="font-medium text-[var(--acc)]">
                  AI 已自动修正越界参数（钳位至安全区间）：
                </p>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-[11px]">
                  {clamped.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* 优选明细卡（任务 #106）：仅多候选（N>1）生成携带 candidateScore 时渲染 */}
            {recipe && candidates.detail && (
              <CandidatePickCard
                detail={candidates.detail}
                scores={candidates.scores}
                winner={candidates.winner}
              />
            )}

            {recipe && (
              <RecipeEditor
                recipe={recipe}
                onChange={handleRecipeChange}
                onSave={() => void saveRecipe()}
                saving={saving}
                savedAt={savedAt}
              />
            )}
          </div>

          {/* 右：发布 / 历史 / BLE */}
          <div className="workspace-column workspace-rail space-y-4 lg:col-span-2 xl:col-span-1">
            <PublishPanel
              recipe={recipe}
              cloud={cloud}
              onCloudChanged={refreshCloud}
              onOpenPreview={() => setPreviewOpen(true)}
              cloudTableId={cloudTableId ?? undefined} // 已发布徽标绑定当前配方（任务 #118）
            />
            <HistoryList
              items={history}
              error={historyError}
              onLoad={loadStoredRecipe}
              onDelete={(id) => void deleteHistory(id)}
              compareIds={compareIds}
              onToggleCompare={toggleCompare}
              onFeedback={setFeedbackEntry}
            />
            <BlePanel recipe={recipe} />
          </div>
        </main>
      </ErrorBoundary>

      {/* ============================ 其他页签 ============================ */}
      {tab === "beans" && (
        <ErrorBoundary key="beans">
          <main className="animate-fade-up">
            <Suspense fallback={<PageLoading label="正在打开豆库" />}>
              <BeansPage
                beans={beans}
                beansStatus={beansStatus}
                onChanged={refreshBeans}
                recipes={history}
                onLoad={loadStoredRecipe}
                theme={theme}
                onRecipesChanged={() => setSaveRevision((r) => r + 1)}
                onUseBean={startFromBean}
              />
            </Suspense>
          </main>
        </ErrorBoundary>
      )}

      {tab === "cloud" && (
        <ErrorBoundary key="cloud">
          <main className="animate-fade-up">
            <Suspense fallback={<PageLoading label="正在打开云端配方" />}>
              <CloudPage cloud={cloud} onCloudChanged={refreshCloud} onImport={loadHistoryRecipe} />
            </Suspense>
          </main>
        </ErrorBoundary>
      )}

      {tab === "compare" && (
        <ErrorBoundary key="compare">
          <main className="animate-fade-up">
            <Suspense fallback={<PageLoading label="正在打开配方对比" />}>
              <ComparePage entries={compareEntries} theme={theme} />
            </Suspense>
          </main>
        </ErrorBoundary>
      )}

      <footer
        className={`${tab === "workbench" ? "hidden" : ""} space-y-1.5 border-t border-[var(--line)] py-6 text-center`}
      >
        <p className="text-[11px] tracking-[0.06em] text-[var(--tx-3)]">
          XBLOOM AI BREW STUDIO · POUR OVER, POUR WITH INTENTION
        </p>
      </footer>

      {/* 弹窗 */}
      {/* 引导式冲煮计时器（任务 #95）：全屏覆盖层，有配方且有 pours 才允许开启 */}
      {recipe && recipe.pours.length > 0 && guideOpen && (
        <Suspense fallback={<ModalLoading label="正在打开冲煮引导" />}>
          <BrewGuide recipe={recipe} onClose={() => setGuideOpen(false)} />
        </Suspense>
      )}
      {previewOpen && (
        <Suspense fallback={<ModalLoading label="正在打开上传预览" />}>
          <PublishPreviewModal
            open
            onClose={() => setPreviewOpen(false)}
            recipe={recipe}
            cloud={cloud}
            onLoggedIn={refreshCloud}
            cloudTableId={cloudTableId ?? undefined}
            onPublished={bindVerifiedCloudRecipe}
          />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={<ModalLoading label="正在打开模型接口设置" />}>
          <ApiSettingsModal open onClose={() => setSettingsOpen(false)} onApplied={refreshConfig} />
        </Suspense>
      )}
      {feedbackEntry !== null && (
        <Suspense fallback={<ModalLoading label="正在打开反馈调参" />}>
          <FeedbackModal
            open
            onClose={() => setFeedbackEntry(null)}
            recipeId={feedbackEntry.id}
            recipe={feedbackEntry.recipe}
            feedbacks={feedbackEntry.feedbacks ?? []}
            onSaved={() => void refreshHistory()}
            onRegenerate={handleRegenerate}
          />
        </Suspense>
      )}
    </div>
  );
}

/** 曲线 legend 胶囊（与 echarts 内置 legend 并存，卡片标题右侧） */
function CurveLegend() {
  const items = [
    { label: "注水", color: "var(--curve-water)" },
    { label: "水温", color: "var(--curve-temp)" },
    { label: "流速", color: "var(--curve-flow)" },
    { label: "旁路", color: "var(--curve-bypass)" },
  ];
  return (
    <div className="hidden items-center gap-1.5 sm:flex">
      {items.map((it) => (
        <span
          key={it.label}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg-card)] px-2.5 py-1 text-[11px] leading-none text-[var(--tx-2)]"
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function PanelLoading({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-card)] p-5" role="status">
      <div className="h-4 w-36 animate-pulse rounded bg-[var(--bg-inset)]" />
      <p className="mt-3 text-xs text-[var(--tx-3)]">{label}</p>
    </div>
  );
}

function PageLoading({ label }: { label: string }) {
  return (
    <div className="mx-auto max-w-[1600px] p-6" role="status">
      <PanelLoading label={label} />
    </div>
  );
}

function ModalLoading({ label }: { label: string }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="status"
    >
      <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-card)] px-6 py-5 text-sm text-[var(--tx-2)] shadow-2xl">
        {label}
      </div>
    </div>
  );
}
