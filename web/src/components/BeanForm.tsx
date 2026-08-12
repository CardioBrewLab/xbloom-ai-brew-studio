/**
 * 左栏输入区：自然语言描述 + 快捷模板 + 豆选择器（combobox，底部可手动输入）+ 高级选项。
 * 纯手冲场景（cupType 固定 xdripper）。
 * 手动填写保障：描述 textarea 始终可用；豆名手动项始终可编辑（输入即清除选豆）；
 * 生成按钮仅要求有描述文本，不强制选豆。
 */
import { useEffect, useRef, useState } from "react";
import { parseBeanInfo, type Bean, type GenerateRequest, type ParsedBeanInfo } from "../lib/api.js";
import { brewsLeft, DEFAULT_DOSE_GRAMS } from "../lib/bean-math.js";
import { hostedPage } from "../lib/companion.js";
import {
  GENERATION_MODES,
  generationModeOption,
  isGenerationMode,
  type GenerationMode,
} from "../lib/generation-mode.js";
import BeanCombobox from "./BeanCombobox.js";
import {
  btnGhost,
  btnPrimary,
  btnPrimarySm,
  Card,
  CardHeader,
  Field,
  inputCls,
  Spinner,
} from "./ui.js";

const TEMPLATES: { label: string; text: string }[] = [
  { label: "浅焙明亮", text: "浅烘焙水洗豆，想要明亮活泼的酸质、花香与茶感，口感干净" },
  { label: "深焙浓郁", text: "深烘焙豆，想要浓郁醇厚、低酸、黑巧克力与焦糖尾韵" },
  {
    label: "Kasuya 4:6",
    text: "按 Tetsu Kasuya 4:6 手法：前两刀决定酸甜，后三刀决定浓度，节奏舒缓",
  },
  { label: "甜感平衡", text: "中烘焙蜜处理，突出甜感与圆润 Body，酸甜平衡不刺激" },
  { label: "旁路柔化", text: "主体浓缩萃取、尾段用旁路水柔化，得到干净又圆润的杯中表现" },
];

/** 豆档案 → 生成上下文文本 */
export function beanToContext(bean: Bean): string {
  const parts = [
    bean.origin,
    bean.process,
    bean.varietal,
    bean.roastLevel,
    bean.tastingNotes,
  ].filter(Boolean);
  return parts.length > 0 ? `${bean.name}（${parts.join("，")}）` : bean.name;
}

/** 从豆仓进入工作台时给出一条可直接修改的自然语言起点，仅在描述框原本为空时使用。 */
export function beanGenerationDescription(bean: Bean): string {
  const notes = bean.tastingNotes?.trim();
  if (notes) return `用这支豆，想把${notes}表现得更清楚，整体干净、平衡。`;
  const traits = [bean.origin, bean.process, bean.roastLevel].filter(Boolean).join("、");
  return traits
    ? `用这支${traits}的豆子，想冲得干净、平衡，把它本身的特点表现出来。`
    : "用这支豆，想冲得干净、平衡，把它本身的特点表现出来。";
}

/** 模型设置刷新后只保留仍在可用列表中的显式选择；空串会自动跟随新的默认模型。 */
export function reconcileModelSelection(selected: string, models: readonly string[]): string {
  return selected && models.includes(selected) ? selected : "";
}

/**
 * 可用豆量输入解析（任务 #58）：留空 = 按 AI 推荐粉量；
 * 非数字或越出 1-200 克时仅给轻提示（hint），不阻塞生成，该字段不随请求发送。
 */
export function parseAvailableDose(text: string): { grams?: number; hint?: string } {
  const t = text.trim();
  if (t === "") return {};
  const n = Number(t);
  if (!Number.isFinite(n) || n < 1 || n > 200) {
    return { hint: "请输入 1~200 之间的数字；留空则按 AI 推荐粉量" };
  }
  return { grams: n };
}

// ---------------------------------------------------------------------------
// 豆信息粘贴 AI 智能解析归类（任务 #118）：纯函数层（状态机 / 应用映射），供单测
// ---------------------------------------------------------------------------

/** 结构化卡片的字段展示元数据（固定顺序 = 渲染顺序） */
export const PARSED_FIELD_META: Array<{ key: keyof ParsedBeanInfo; label: string }> = [
  { key: "name", label: "豆名" },
  { key: "roaster", label: "烘焙商" },
  { key: "origin", label: "产地" },
  { key: "estate", label: "庄园" },
  { key: "process", label: "处理法" },
  { key: "varietal", label: "品种" },
  { key: "roastLevel", label: "烘焙度" },
  { key: "tastingNotes", label: "风味笔记" },
  { key: "altitude", label: "海拔" },
  { key: "notes", label: "备注" },
];

/** 解析粘贴区的状态机相位 */
export type BeanParsePhase = "idle" | "loading" | "done" | "error" | "applied";

export interface BeanParseState {
  phase: BeanParsePhase;
  error?: string;
}

const PARSE_ACTION_FROM: Record<string, readonly BeanParsePhase[]> = {
  PARSE_START: ["idle", "done", "error", "applied"],
  PARSE_OK: ["loading"],
  PARSE_FAIL: ["loading"],
  APPLY: ["done", "applied"],
  RESET: ["done", "error", "applied"],
};

/**
 * 解析状态机转移（纯函数）：非法转移保持原态，绝不抛错。
 * idle --PARSE_START--> loading --PARSE_OK--> done --APPLY--> applied；
 * loading --PARSE_FAIL--> error；done/error/applied --RESET--> idle（原文变更时回到可重新解析态）。
 * 任务 #123：PARSE_OK 后由组件侧自动串联 APPLY（解析成功即应用，无需手动点击）。
 */
export function beanParseTransition(
  s: BeanParseState,
  action: string,
  error?: string,
): BeanParseState {
  const allowed = PARSE_ACTION_FROM[action];
  if (!allowed || !allowed.includes(s.phase)) return s;
  switch (action) {
    case "PARSE_START":
      return { phase: "loading" };
    case "PARSE_OK":
      return { phase: "done" };
    case "PARSE_FAIL":
      return { phase: "error", error: error ?? "解析失败，请重试" };
    case "APPLY":
      return { phase: "applied" };
    case "RESET":
      return { phase: "idle" };
    default:
      return s;
  }
}

/** 解析成功即自动应用（任务 #123）：loading --PARSE_OK--> done --APPLY--> applied 一步到位（纯函数） */
export function beanParseAutoApply(s: BeanParseState): BeanParseState {
  return beanParseTransition(beanParseTransition(s, "PARSE_OK"), "APPLY");
}

/** 解析结果字段值 → 编辑行文本（tastingNotes 用顿号连接，null 归空串） */
export function parsedFieldToText(parsed: ParsedBeanInfo, key: keyof ParsedBeanInfo): string {
  const v = parsed[key];
  if (Array.isArray(v)) return v.join("、");
  return v ?? "";
}

/**
 * 应用映射（纯函数）：结构化解析结果 → 表单「豆子信息」上下文文本。
 * 豆名打头，非空元信息「 · 」串联，风味笔记收尾；全空 → undefined（不覆盖表单）。
 */
export function mapParsedToBeanFields(parsed: ParsedBeanInfo): string | undefined {
  const parts: string[] = [];
  if (parsed.roaster) parts.push(parsed.roaster);
  const origin = [parsed.origin, parsed.estate].filter(Boolean).join(" · ");
  if (origin) parts.push(origin);
  if (parsed.process) parts.push(parsed.process);
  if (parsed.varietal) parts.push(parsed.varietal);
  if (parsed.roastLevel) parts.push(parsed.roastLevel);
  if (parsed.altitude) parts.push(parsed.altitude);
  const middle = parts.join(" · ");
  const notesText = parsed.tastingNotes.join("、");
  const name = parsed.name ?? "";
  if (name && middle && notesText) return `${name}（${middle} · 风味：${notesText}）`;
  if (name && middle) return `${name}（${middle}）`;
  if (name && notesText) return `${name}（风味：${notesText}）`;
  if (middle && notesText) return `${middle} · 风味：${notesText}`;
  const single = name || middle || notesText;
  return single || undefined;
}

/** draft 覆盖层合并到解析结果（纯函数，任务 #123 提取供单测）：编辑后文本覆盖 AI 归类值 */
export function mergeParsedDraft(
  parsed: ParsedBeanInfo,
  draft: Partial<Record<keyof ParsedBeanInfo, string>>,
): ParsedBeanInfo {
  const merged: ParsedBeanInfo = { ...parsed };
  for (const meta of PARSED_FIELD_META) {
    const d = draft[meta.key];
    if (d === undefined) continue;
    if (meta.key === "tastingNotes") {
      merged.tastingNotes = d
        .split(/[、,，;；\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      (merged as unknown as Record<string, string | null>)[meta.key] = d.trim() || null;
    }
  }
  return merged;
}

/** 核心可应用字段（name/roaster/origin/process/varietal/roastLevel/tastingNotes）中的缺失键 */
export function missingCoreFields(parsed: ParsedBeanInfo): Array<keyof ParsedBeanInfo> {
  const core: Array<keyof ParsedBeanInfo> = [
    "name",
    "roaster",
    "origin",
    "process",
    "varietal",
    "roastLevel",
    "tastingNotes",
  ];
  return core.filter((k) => parsedFieldToText(parsed, k).trim() === "");
}

export interface BeanFormProps {
  models: string[];
  defaultModel: string;
  generating: boolean;
  onGenerate: (req: GenerateRequest) => void;
  onCancel: () => void;
  /** 豆库列表（由外层统一拉取） */
  beans: Bean[];
  /** 跳转豆库管理页 */
  onOpenBeans: () => void;
  /** 生成/载入结果后收起长表单，为配方结果留出桌面宽度 */
  collapsed?: boolean;
  /** 恢复完整输入表单 */
  onExpand?: () => void;
  /** 收起态展示的当前配方名 */
  activeRecipeName?: string;
  /** 从豆仓发起的选豆意图；revision 让同一支豆可重复触发。 */
  prefillBean?: { beanId: string; revision: number };
}

export default function BeanForm({
  models,
  defaultModel,
  generating,
  onGenerate,
  onCancel,
  beans,
  onOpenBeans,
  collapsed = false,
  onExpand,
  activeRecipeName,
  prefillBean,
}: BeanFormProps) {
  const [description, setDescription] = useState("");
  const [beanId, setBeanId] = useState("");
  const [manualBeans, setManualBeans] = useState("");
  const [taste, setTaste] = useState("");
  const [refUrls, setRefUrls] = useState("");
  const [generationMode, setGenerationMode] = useState<GenerationMode>(() => {
    if (typeof window === "undefined") return "max";
    try {
      const saved = window.localStorage.getItem("xbloom-generation-mode");
      return isGenerationMode(saved) ? saved : "max";
    } catch {
      return "max";
    }
  });
  const [model, setModel] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  /** 可用豆量覆盖输入（任务 #58）：留空 = 按 AI 推荐粉量 */
  const [doseText, setDoseText] = useState("");
  /** 烘焙商参考方案原文（任务 #38）：折叠态本地维护 */
  const [roasterReference, setRoasterReference] = useState("");
  const [showRoaster, setShowRoaster] = useState(false);

  // ---- 豆信息粘贴 AI 解析归类（任务 #118）----
  const [showParse, setShowParse] = useState(false);
  /** 原始粘贴文本：应用后保留，供修改后重解析 */
  const [pasteText, setPasteText] = useState("");
  const [parseState, setParseState] = useState<BeanParseState>({ phase: "idle" });
  const [parsed, setParsed] = useState<ParsedBeanInfo | null>(null);
  /** 用户逐字段编辑覆盖层（key → 编辑后文本），未触碰的字段保持 AI 归类值 */
  const [draft, setDraft] = useState<Partial<Record<keyof ParsedBeanInfo, string>>>({});
  /** 手动「补充」加行的 null 字段 */
  const [extraRows, setExtraRows] = useState<ReadonlySet<keyof ParsedBeanInfo>>(new Set());
  const appliedPrefillRevisionRef = useRef<number | null>(null);

  useEffect(() => {
    if (!prefillBean || appliedPrefillRevisionRef.current === prefillBean.revision) return;
    const bean = beans.find((item) => item.id === prefillBean.beanId);
    if (!bean) return;
    appliedPrefillRevisionRef.current = prefillBean.revision;
    setBeanId(bean.id);
    setManualBeans("");
    setDescription((current) => current.trim() || beanGenerationDescription(bean));
  }, [beans, prefillBean]);

  useEffect(() => {
    setModel((current) => reconcileModelSelection(current, models));
  }, [models]);

  useEffect(() => {
    try {
      window.localStorage.setItem("xbloom-generation-mode", generationMode);
    } catch {
      // 浏览器禁用存储时仍保留本次页面选择。
    }
  }, [generationMode]);

  const effectiveModel = model || defaultModel;
  const selectedBean = beans.find((b) => b.id === beanId);
  const doseParsed = parseAvailableDose(doseText);
  const selectedMode = generationModeOption(generationMode);

  const parsePhase = parseState.phase;
  const showParsedCard = (parsePhase === "done" || parsePhase === "applied") && parsed !== null;

  /** draft 覆盖后的完整解析结果（自动应用与实时同步共用） */
  const mergedDraft = (): ParsedBeanInfo | null =>
    parsed ? mergeParsedDraft(parsed, draft) : null;

  /**
   * 同步写入表单豆通道（任务 #123）：解析豆 → manualBeans，清除豆库选中。
   * composed 为空（全字段被清空）时不覆盖表单，保留最后一次有效值。
   */
  const syncBeanChannel = (merged: ParsedBeanInfo) => {
    const composed = mapParsedToBeanFields(merged);
    if (!composed) return;
    setManualBeans(composed);
    setBeanId("");
  };

  /** 原文变更 → 回到可重新解析态（结果卡片不再代表当前文本） */
  const onPasteChange = (v: string) => {
    setPasteText(v);
    if (parsePhase === "done" || parsePhase === "applied" || parsePhase === "error") {
      setParseState(beanParseTransition(parseState, "RESET"));
    }
  };

  const runAiParse = async () => {
    if (!pasteText.trim() || parsePhase === "loading") return;
    setParseState(beanParseTransition(parseState, "PARSE_START"));
    const res = await parseBeanInfo(pasteText.trim());
    if (res.ok && res.parsed) {
      setParsed(res.parsed);
      setDraft({});
      setExtraRows(new Set());
      // 解析成功即自动应用（任务 #123）：无需手动点「应用到表单」
      if (mapParsedToBeanFields(res.parsed)) {
        setManualBeans(mapParsedToBeanFields(res.parsed)!);
        setBeanId("");
        setParseState(beanParseAutoApply({ phase: "loading" }));
      } else {
        // 极端情况：AI 归类全空 → 无内容可应用，停在 done 态供补充
        setParseState(beanParseTransition({ phase: "loading" }, "PARSE_OK"));
      }
    } else {
      setParseState(beanParseTransition({ phase: "loading" }, "PARSE_FAIL", res.error));
    }
  };

  /** 可编辑卡片逐字段修改（任务 #123）：onChange 即重跑映射，实时同步回表单豆通道 */
  const onDraftChange = (key: keyof ParsedBeanInfo, value: string) => {
    const nextDraft = { ...draft, [key]: value };
    setDraft(nextDraft);
    if (parsed) syncBeanChannel(mergeParsedDraft(parsed, nextDraft));
  };

  const submit = () => {
    if (!description.trim() || generating) return;
    const urls = refUrls
      .split(/[\n,;，；\s]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    onGenerate({
      description: description.trim(),
      mode: generationMode,
      beans: selectedBean ? beanToContext(selectedBean) : manualBeans.trim() || undefined,
      beanId: selectedBean?.id,
      taste: taste.trim() || undefined,
      cupType: "xdripper",
      model: effectiveModel || undefined,
      refUrls: urls.length > 0 ? urls : undefined,
      // 兼容旧版后端；新版后端以 mode 为唯一策略来源。
      research: generationMode !== "fast",
      roasterReference: roasterReference.trim() || undefined,
      // 可用豆量（任务 #58）：仅合法值随请求发送；留空/非法（undefined）不发送
      availableDoseGrams: doseParsed.grams,
    });
  };

  if (collapsed) {
    return (
      <Card className="overflow-hidden xl:sticky xl:top-0">
        <div className="space-y-4 p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--tx-2)]">
            <span
              className={`h-2 w-2 rounded-full ${
                generating ? "animate-pulse bg-[var(--acc)]" : "bg-[var(--ok)]"
              }`}
              aria-hidden
            />
            {generating ? `${selectedMode.eyebrow} 正在生成` : "当前配方"}
          </div>
          <p className="line-clamp-2 text-sm font-semibold leading-5 text-[var(--tx-1)]">
            {generating ? "正在整理参数与冲煮节奏…" : activeRecipeName || "输入已收起"}
          </p>
          <p className="text-[11px] leading-5 text-[var(--tx-3)]">
            表单内容仍保留，需要调整时再展开。
          </p>
          <button type="button" onClick={onExpand} className={`${btnGhost} w-full`}>
            返回输入
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="xl:sticky xl:top-0 xl:flex xl:h-full xl:max-h-none xl:flex-col xl:overflow-hidden">
      <CardHeader title="配方输入" sub="描述风味、选择豆子，再决定这次的生成方式" />
      <div className="space-y-4 p-4 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          rows={4}
          placeholder="想要一杯明亮干净的浅烘手冲，柑橘酸质、茉莉花香，尾韵带茶感…"
          className={`${inputCls} h-auto resize-none py-2.5 leading-relaxed`}
        />

        {/* 快捷模板 chips */}
        <div className="flex flex-wrap gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() => setDescription(t.text)}
              className="rounded-full border border-[var(--line-strong)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-medium text-[var(--tx-2)] transition-colors duration-150 hover:bg-[var(--bg-inset)] hover:text-[var(--tx-1)]"
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 三档生成策略放在首屏：选择会直接决定是否联网、候选数与低分换源。 */}
        <div className="space-y-2.5 rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-[var(--tx-1)]">生成方式</p>
            <span className="text-[10px] text-[var(--tx-3)]">{selectedMode.summary}</span>
          </div>
          <div
            role="radiogroup"
            aria-label="生成模式"
            className="grid grid-cols-3 gap-1 rounded-lg border border-[var(--line)] bg-[var(--bg-card)] p-1"
          >
            {GENERATION_MODES.map((option) => {
              const active = generationMode === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setGenerationMode(option.id)}
                  className={`rounded-md px-2 py-2 text-center transition-all duration-150 ${
                    active
                      ? "bg-[var(--btn-bg)] text-[var(--btn-fg)] shadow-sm"
                      : "text-[var(--tx-3)] hover:bg-[var(--bg-inset)] hover:text-[var(--tx-1)]"
                  }`}
                >
                  <span className="block text-[9px] font-semibold tracking-[0.1em] opacity-70">
                    {option.eyebrow}
                  </span>
                  <span className="mt-0.5 block text-[11px] font-medium">
                    {option.name.replace("配方", "")}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] leading-4 text-[var(--tx-3)]">{selectedMode.detail}</p>
        </div>

        {/* 豆选择器（combobox：选豆库 或 手动输入） */}
        <Field label="选择豆子" hint={beans.length === 0 ? undefined : `${beans.length} 款在库`}>
          <BeanCombobox
            beans={beans}
            value={beanId}
            onSelect={(id) => {
              setBeanId(id);
              if (id) setManualBeans("");
            }}
            manualText={manualBeans}
            onManual={(text) => {
              setManualBeans(text);
              setBeanId("");
            }}
            onOpenBeans={onOpenBeans}
          />
        </Field>
        {selectedBean && (
          <p className="animate-fade-up -mt-2 rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[11px] leading-relaxed text-[var(--tx-2)]">
            <span className="font-medium text-[var(--tx-1)]">{selectedBean.name}</span>
            {" · "}
            {[selectedBean.origin, selectedBean.process, selectedBean.roastLevel]
              .filter(Boolean)
              .join(" / ") || "无更多档案信息"}
            {selectedBean.tastingNotes && <> · {selectedBean.tastingNotes}</>}
            {/* 豆仓余量预览（任务 #51）：有库存时显示，未录入不显示 */}
            {typeof selectedBean.stockGrams === "number" && (
              <>
                <br />
                <span className="tnum text-[var(--acc)]">
                  剩 {selectedBean.stockGrams}g
                  {(() => {
                    const n = brewsLeft(selectedBean.stockGrams, DEFAULT_DOSE_GRAMS);
                    return n !== null ? ` · 还能冲 ${n} 次` : "";
                  })()}
                </span>
              </>
            )}
          </p>
        )}

        {/* 豆信息粘贴 AI 智能解析归类（任务 #118/#123）：乱信息粘贴 → AI 归类 → 自动应用到表单，可编辑实时同步 */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-inset)]">
          <button
            type="button"
            onClick={() => setShowParse((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-xs font-medium text-[var(--tx-2)] transition-colors duration-150 hover:text-[var(--tx-1)]"
          >
            <span>
              豆子信息太散？粘贴后自动整理字段
              <span
                className={
                  parsePhase === "applied"
                    ? "ml-2 font-normal text-[var(--sage-deep)]"
                    : parsePhase === "error"
                      ? "ml-2 font-normal text-[var(--bad)]"
                      : "ml-2 font-normal text-[var(--tx-3)]"
                }
              >
                {parsePhase === "applied"
                  ? "✓ 已应用 · 可修改"
                  : parsePhase === "done"
                    ? "已归类，可编辑"
                    : parsePhase === "error"
                      ? "解析失败"
                      : pasteText.trim()
                        ? `${pasteText.trim().length} 字待归类`
                        : "未填写"}
              </span>
            </span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden
              className={`transition-transform duration-200 ${showParse ? "rotate-180" : ""}`}
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="collapser" data-open={showParse}>
            <div className="collapser-inner">
              <div className="space-y-3 border-t border-[var(--line)] bg-[var(--bg-card)] p-4">
                <textarea
                  value={pasteText}
                  onChange={(e) => onPasteChange(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  placeholder={
                    "把烘焙商文案 / 聊天记录 / 包装袋标签原样粘贴进来，格式不限\n例：埃塞 耶加雪菲G1 科契尔 XX烘焙坊 水洗浅烘 茉莉花柑橘 海拔1900以上"
                  }
                  aria-label="豆信息原文粘贴区"
                  className={`${inputCls} h-auto resize-y py-2.5 text-xs leading-relaxed`}
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] leading-4 text-[var(--tx-3)]">
                    只抽取文中明确出现的信息，未知字段留空不编造
                  </p>
                  <button
                    type="button"
                    onClick={() => void runAiParse()}
                    disabled={parsePhase === "loading" || !pasteText.trim()}
                    className={`${btnPrimarySm} shrink-0`}
                  >
                    {parsePhase === "loading" ? (
                      <>
                        <Spinner className="h-3 w-3" /> 正在整理…
                      </>
                    ) : (
                      "整理字段"
                    )}
                  </button>
                </div>
                {parsePhase === "error" && (
                  <p className="animate-fade-up rounded-lg border border-[color-mix(in_srgb,var(--bad)_35%,transparent)] bg-[color-mix(in_srgb,var(--bad)_8%,transparent)] px-3 py-2 text-[11px] leading-relaxed text-[var(--bad)]">
                    ⚠ {parseState.error ?? "解析失败，请重试"}
                  </p>
                )}
                {showParsedCard &&
                  parsed &&
                  (() => {
                    const merged = mergedDraft()!;
                    const visibleRows = PARSED_FIELD_META.filter(
                      (m) => parsedFieldToText(parsed, m.key).trim() !== "" || extraRows.has(m.key),
                    );
                    const hiddenRows = PARSED_FIELD_META.filter((m) => !visibleRows.includes(m));
                    const composed = mapParsedToBeanFields(merged);
                    return (
                      <div className="animate-fade-up space-y-2.5 rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] p-3.5">
                        <div className="flex items-center justify-between">
                          <span className="eyebrow">AI 归类结果 · 可修改</span>
                          {parsePhase === "applied" && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-[var(--sage-soft)] px-2 py-0.5 text-[11px] leading-4 text-[var(--sage-deep)]">
                              ✓ 已应用 · 可修改
                            </span>
                          )}
                        </div>
                        {visibleRows.map((m) => (
                          <div key={m.key}>
                            <span className="eyebrow mb-1 block">{m.label}</span>
                            <input
                              value={draft[m.key] ?? parsedFieldToText(parsed, m.key)}
                              onChange={(e) => onDraftChange(m.key, e.target.value)}
                              aria-label={m.label}
                              className={`${inputCls} h-9 text-[13px]`}
                            />
                          </div>
                        ))}
                        {hiddenRows.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5 pt-1">
                            <span className="text-[11px] text-[var(--tx-3)]">补充</span>
                            {hiddenRows.map((m) => (
                              <button
                                key={m.key}
                                type="button"
                                onClick={() => setExtraRows((s) => new Set(s).add(m.key))}
                                className="rounded-full border border-dashed border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--tx-3)] transition-colors duration-150 hover:border-[var(--tx-2)] hover:text-[var(--tx-1)]"
                              >
                                + {m.label}
                              </button>
                            ))}
                          </div>
                        )}
                        {/* 任务 #123：解析成功即自动应用，编辑实时同步，无需应用按钮 */}
                        <p className="pt-1 text-center text-[11px] leading-4 text-[var(--tx-3)]">
                          {parsePhase === "applied"
                            ? composed
                              ? "✓ 已自动应用到表单，改动实时同步"
                              : "字段被清空，补充内容后自动恢复同步"
                            : "归类结果为空，补充字段后自动同步到表单"}
                        </p>
                      </div>
                    );
                  })()}
              </div>
            </div>
          </div>
        </div>

        {/* 可用豆量覆盖（可选，任务 #58）：不填 = 按 AI 推荐粉量 */}
        <Field label="可用豆量（克）" hint="可选 · 库存不够时按此克数制定">
          <input
            value={doseText}
            onChange={(e) => setDoseText(e.target.value)}
            inputMode="decimal"
            placeholder="不填 = 按 AI 推荐粉量"
            aria-label="可用豆量（克）"
            className={inputCls}
          />
        </Field>
        {doseParsed.hint && (
          <p className="animate-fade-up -mt-3 text-[11px] leading-4 text-[var(--warn)]">
            {doseParsed.hint}
          </p>
        )}

        {/* 烘焙商参考方案（可选，任务 #38）：原文粘贴区，折叠态显示摘要 */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-inset)]">
          <button
            type="button"
            onClick={() => setShowRoaster((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-xs font-medium text-[var(--tx-2)] transition-colors duration-150 hover:text-[var(--tx-1)]"
          >
            <span>
              烘焙商参考方案（可选）
              <span className="ml-2 font-normal text-[var(--tx-3)]">
                {roasterReference.trim() ? `已填 ${roasterReference.trim().length} 字` : "未填写"}
              </span>
            </span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden
              className={`transition-transform duration-200 ${showRoaster ? "rotate-180" : ""}`}
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="collapser" data-open={showRoaster}>
            <div className="collapser-inner">
              <div className="border-t border-[var(--line)] bg-[var(--bg-card)] p-4">
                <textarea
                  value={roasterReference}
                  onChange={(e) => setRoasterReference(e.target.value)}
                  rows={6}
                  placeholder={
                    "直接粘贴烘焙商冲煮建议原文，时间轴/分段描述均可\n例：12g粉-200g水\n95°C C40 #20-25格\n0.00 注水到30克\n0.30 注水到70克\n…"
                  }
                  aria-label="烘焙商参考方案原文"
                  className={`${inputCls} h-auto resize-y py-2.5 font-mono text-xs leading-relaxed`}
                />
                <p className="mt-2 text-[11px] leading-4 text-[var(--tx-3)]">
                  烘焙商给什么格式就贴什么格式，AI
                  会优先尊重其时间轴与比例；与处理法/焙度规则冲突时会说明取舍
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* 高级选项折叠区（各项始终可手动编辑） */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-inset)]">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-xs font-medium text-[var(--tx-2)] transition-colors duration-150 hover:text-[var(--tx-1)]"
          >
            <span>高级选项</span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden
              className={`transition-transform duration-200 ${showAdvanced ? "rotate-180" : ""}`}
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="collapser" data-open={showAdvanced}>
            <div className="collapser-inner">
              <div className="grid grid-cols-2 gap-3 border-t border-[var(--line)] bg-[var(--bg-card)] p-4">
                <div className="col-span-2">
                  <Field label="豆子信息（手动）" hint="选豆后仍可修改覆盖">
                    <input
                      value={manualBeans}
                      onChange={(e) => {
                        setManualBeans(e.target.value);
                        if (e.target.value) setBeanId("");
                      }}
                      placeholder="埃塞俄比亚 · 水洗 · 浅烘 · 茉莉花与柑橘"
                      className={inputCls}
                    />
                  </Field>
                </div>
                <Field label="口味偏好">
                  <input
                    value={taste}
                    onChange={(e) => setTaste(e.target.value)}
                    placeholder="柑橘酸 / 高甜感"
                    className={inputCls}
                  />
                </Field>
                <Field label="器具">
                  <input
                    value="xDripper 手冲"
                    readOnly
                    aria-label="器具（固定为 xDripper 手冲）"
                    className={`${inputCls} cursor-default text-[var(--tx-2)]`}
                  />
                </Field>
                <div className="col-span-2">
                  <Field
                    label="模型"
                    hint={
                      models.length === 0
                        ? hostedPage()
                          ? "尚未配置模型接口，登录后可设置"
                          : "尚未配置模型接口，可从右上角打开设置"
                        : undefined
                    }
                  >
                    <select
                      value={effectiveModel}
                      onChange={(e) => setModel(e.target.value)}
                      className={`${inputCls} appearance-none`}
                    >
                      {models.length === 0 ? (
                        <option value="">默认模型</option>
                      ) : (
                        models.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))
                      )}
                    </select>
                  </Field>
                </div>
                <div className="col-span-2">
                  <Field label="参考配方 URL" hint="多个用空格分隔">
                    <input
                      value={refUrls}
                      onChange={(e) => setRefUrls(e.target.value)}
                      placeholder="粘贴 xBloom 官方分享链接或冲煮记录页面"
                      className={inputCls}
                    />
                  </Field>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="shrink-0 space-y-2 border-t border-[var(--line)] bg-[var(--bg-card)] p-4">
        <button
          type="button"
          onClick={generating ? onCancel : submit}
          disabled={!generating && !description.trim()}
          className={`${generating ? btnGhost : btnPrimary} w-full ${generating ? "h-12" : ""}`}
        >
          {generating ? "停止本次生成" : `用 ${selectedMode.eyebrow} 生成配方`}
        </button>
        <p className="text-center text-[11px] text-[var(--tx-3)]">
          Ctrl / ⌘ + Enter 快速生成 · 无需选豆，有描述即可
        </p>
      </div>
    </Card>
  );
}
