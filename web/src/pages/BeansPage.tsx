/**
 * 豆仓页（任务 #51）：豆档案 CRUD + 豆仓库存系统。
 * - 顶部 AI 推荐卡（Top3，规则兜底标注，失败优雅降级）
 * - 豆卡片：库存条 + 冲一杯扣减 + 三态养豆倒计时胶囊 + 关联冲煮方案折叠区（同豆曲线叠加）
 * - 日期/库存运算一律走 lib/bean-math 纯函数，本页只负责渲染。
 */
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { api, type Bean, type BeanRecommendation, type SavedRecipe } from "../lib/api.js";
import { brewsLeft, DEFAULT_DOSE_GRAMS, freshness } from "../lib/bean-math.js";
import CurveChart, { OVERLAY_COLORS, type CurveEntry } from "../components/CurveChart.js";
import {
  btnGhost,
  btnPrimary,
  Card,
  CardHeader,
  Field,
  inputCls,
  Spinner,
  chipCls,
} from "../components/ui.js";

const ROAST_LEVELS = ["浅焙", "中浅焙", "中焙", "中深焙", "深焙"] as const;

/** 库存条可视化基准（g）：按一袋 250g 折算进度，仅表达水位，不代表真实容量 */
const STOCK_BAR_REF = 250;

const EMPTY_FORM = {
  name: "",
  roaster: "",
  origin: "",
  process: "",
  varietal: "",
  roastLevel: "",
  tastingNotes: "",
  stockGrams: "",
  roastDate: "",
  restDays: "",
};

/** 养豆天数建议（按烘焙度）：浅焙 7 / 中焙 5 / 深焙 3，可覆盖 */
function restDaysHint(roastLevel: string): string {
  if (roastLevel === "浅焙" || roastLevel === "中浅焙") return "浅焙建议 7 天，可覆盖";
  if (roastLevel === "中焙" || roastLevel === "中深焙") return "中焙建议 5 天，可覆盖";
  if (roastLevel === "深焙") return "深焙建议 3 天，可覆盖";
  return "浅焙 7 / 中焙 5 / 深焙 3，可覆盖";
}

/**
 * 豆名规范化（前端版，与后端 normalizeBeanName 同口径，任务 #130）：
 * 去括号及括号内后缀（含未闭合括号）、去品种号（4 位以上纯数字）、去多余空格、小写化。
 * 用于 relatedOf fallback 匹配与空壳检测，保留原 name 用于显示。
 */
export function normalizeBeanNameFE(s: string): string {
  let result = s.replace(/[（(][^）)]*[）)]?/g, "");
  result = result.replace(/\s*\d{4,}\s*/g, " ");
  return result.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * 空壳豆检测（任务 #130）：仅有 name + rawDescription（可选），无任何其他有效字段。
 * 这类记录由旧版 ensureBeanFromFreeText 每次生成时创建（匹配失败 → 建空壳）。
 */
export function isShellBean(bean: Bean): boolean {
  return (
    !bean.roaster &&
    !bean.origin &&
    !bean.process &&
    !bean.varietal &&
    !bean.roastLevel &&
    !bean.tastingNotes &&
    !bean.stockGrams &&
    !bean.roastDate &&
    !bean.restDays &&
    !bean.peakWindowDays
  );
}

/**
 * 关联配方匹配（任务 #130）：
 * - L1：beanId 精确匹配（主路径，新配方由 beanMatch 事件保证带 beanId）
 * - L2：fallback——beanSnapshot 包含豆名核心 token（兜底匹配旧配方，任务 #65 曾去掉
 *   snapshot 兜底，任务 #130 重新引入：beanMatch 机制已保证新配方带 beanId，
 *   但旧配方（无 beanId）需靠 snapshot 兜底才能在豆卡中展示关联）
 * 按创建时间倒序排列，L1 与 L2 之间去重。
 */
export function relatedOf(bean: Bean, recipes: SavedRecipe[]): SavedRecipe[] {
  const byId = recipes.filter((r) => r.beanId === bean.id);
  const byIdSet = new Set(byId.map((r) => r.id));
  const normalized = normalizeBeanNameFE(bean.name);
  const bySnapshot = normalized
    ? recipes.filter(
        (r) =>
          !byIdSet.has(r.id) &&
          !r.beanId &&
          r.beanSnapshot &&
          normalizeBeanNameFE(r.beanSnapshot).includes(normalized),
      )
    : [];
  return [...byId, ...bySnapshot].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );
}

/** 未关联到任何豆的配方（手动关联下拉用，任务 #130） */
function unrelatedRecipes(bean: Bean, recipes: SavedRecipe[]): SavedRecipe[] {
  return recipes
    .filter((r) => r.beanId !== bean.id)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export interface BeansPageProps {
  beans: Bean[] | null;
  /** 豆库加载三态（任务 #65）：失败才显示离线提示，加载中不误导 */
  beansStatus?: "loading" | "ready" | "failed";
  /** 豆库变化后通知外层（工作台选豆列表同步刷新） */
  onChanged: () => void;
  /** 本地配方库（关联冲煮方案过滤用） */
  recipes?: SavedRecipe[] | null;
  /** 载入配方回工作台 */
  onLoad?: (entry: SavedRecipe) => void;
  theme: "dark" | "light";
  /** 配方列表刷新回调（手动关联/合并后触发，任务 #130） */
  onRecipesChanged?: () => void;
  /** 选择这支豆并返回工作台制定新配方。 */
  onUseBean?: (beanId: string) => void;
}

export default function BeansPage({
  beans,
  beansStatus,
  onChanged,
  recipes,
  onLoad,
  theme,
  onRecipesChanged,
  onUseBean,
}: BeansPageProps) {
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  /** 编辑态字段触碰记录（任务 #65）：区分「未触碰（保持原值）」与「清空（发 null 删除字段）」 */
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // 兼容旧调用方（无 beansStatus）：beans===null 视为失败态
  const loadFailed = beansStatus ? beansStatus === "failed" : beans === null;

  useEffect(() => {
    onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set =
    (key: keyof typeof EMPTY_FORM) =>
    (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setForm((f) => ({ ...f, [key]: value }));
      setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
    };

  const closeForm = () => {
    setShowForm(false);
    setEditId(null);
    setForm({ ...EMPTY_FORM });
    setError("");
    setTouched({});
  };

  const startEdit = (b: Bean) => {
    setForm({
      name: b.name,
      roaster: b.roaster ?? "",
      origin: b.origin ?? "",
      process: b.process ?? "",
      varietal: b.varietal ?? "",
      roastLevel: b.roastLevel ?? "",
      tastingNotes: b.tastingNotes ?? "",
      stockGrams: typeof b.stockGrams === "number" ? String(b.stockGrams) : "",
      roastDate: b.roastDate ?? "",
      restDays: typeof b.restDays === "number" ? String(b.restDays) : "",
    });
    setEditId(b.id);
    setShowForm(true);
    setError("");
    setTouched({});
  };

  /**
   * 表单数值字段解析：非空解析为数字；编辑态触碰后清空 → null（后端删除字段，任务 #65）；
   * 未触碰/新建态空串 → undefined（不发送，保持原值）。非法值返回错误文案。
   */
  const parseNumerics = (): { stockGrams?: number | null; restDays?: number | null } | string => {
    const out: { stockGrams?: number | null; restDays?: number | null } = {};
    if (form.stockGrams.trim() !== "") {
      const v = Number(form.stockGrams);
      if (!Number.isFinite(v) || v < 0) return "剩余克数需为不小于 0 的数字";
      out.stockGrams = v;
    } else if (editId && touched.stockGrams) {
      out.stockGrams = null;
    }
    if (form.restDays.trim() !== "") {
      const v = Number(form.restDays);
      if (!Number.isFinite(v) || v < 0) return "养豆天数需为不小于 0 的数字";
      out.restDays = v;
    } else if (editId && touched.restDays) {
      out.restDays = null;
    }
    return out;
  };

  const save = async () => {
    if (!form.name.trim()) return;
    const nums = parseNumerics();
    if (typeof nums === "string") {
      setError(nums);
      return;
    }
    setSaving(true);
    setError("");
    const fields = {
      name: form.name.trim(),
      roaster: form.roaster.trim() || undefined,
      origin: form.origin.trim() || undefined,
      process: form.process.trim() || undefined,
      varietal: form.varietal.trim() || undefined,
      roastLevel: form.roastLevel || undefined,
      tastingNotes: form.tastingNotes.trim() || undefined,
      stockGrams: nums.stockGrams,
      // 编辑态触碰后清空 → 显式 null，后端删除字段（任务 #65）
      roastDate: form.roastDate || (editId && touched.roastDate ? null : undefined),
      restDays: nums.restDays,
    };
    try {
      if (editId) {
        await api.patchBean(editId, fields);
      } else {
        await api.createBean(fields);
      }
      closeForm();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteBean(id);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-[1440px] space-y-6 px-6 py-8">
      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold leading-8 tracking-[-0.025em] text-[var(--tx-1)]">
          豆库
        </h2>
        <p className="max-w-2xl text-sm leading-[22px] text-[var(--tx-2)]">
          {loadFailed
            ? "豆库接口暂不可用，启动后端后自动恢复"
            : beans
              ? `${beans.length} 款豆档案 · 库存与养豆状态一目了然，生成配方时可选豆带入`
              : "加载中…"}
        </p>
      </div>

      <RecommendCard beansReady={!loadFailed && beans !== null} onUseBean={onUseBean} />

      <Card>
        <CardHeader
          icon={<IconBean />}
          title="豆档案"
          sub="产地 / 处理法 / 烘焙度 / 库存 / 养豆窗口"
          right={
            <button
              type="button"
              onClick={() => (showForm ? closeForm() : setShowForm(true))}
              className={btnGhost}
            >
              {showForm ? "收起" : "＋ 新建豆档案"}
            </button>
          }
        />

        {showForm && (
          <div className="animate-fade-up space-y-3 border-b border-[var(--line)] p-5">
            {editId && (
              <p className="text-[11px] text-[var(--tx-3)]">
                正在编辑「{form.name || "…"}
                」，未触碰的字段保持原值；清空烘焙日期/剩余克数/养豆天数输入将删除对应字段
              </p>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="豆名 *">
                <input
                  value={form.name}
                  onChange={set("name")}
                  placeholder="耶加雪菲 G1 科契尔"
                  className={inputCls}
                />
              </Field>
              <Field label="烘焙商">
                <input
                  value={form.roaster}
                  onChange={set("roaster")}
                  placeholder="某烘焙工坊"
                  className={inputCls}
                />
              </Field>
              <Field label="产地">
                <input
                  value={form.origin}
                  onChange={set("origin")}
                  placeholder="埃塞俄比亚 · 耶加雪菲"
                  className={inputCls}
                />
              </Field>
              <Field label="处理法">
                <input
                  value={form.process}
                  onChange={set("process")}
                  placeholder="水洗 / 日晒 / 蜜处理"
                  className={inputCls}
                />
              </Field>
              <Field label="品种">
                <input
                  value={form.varietal}
                  onChange={set("varietal")}
                  placeholder="原生种 / SL28 / 瑰夏"
                  className={inputCls}
                />
              </Field>
              <Field label="烘焙度">
                <select value={form.roastLevel} onChange={set("roastLevel")} className={inputCls}>
                  <option value="">未标注</option>
                  {ROAST_LEVELS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {/* 豆仓三字段：库存 / 烘焙日期 / 养豆天数（任务 #51） */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="剩余克数" hint="选填">
                <input
                  type="number"
                  min={0}
                  value={form.stockGrams}
                  onChange={set("stockGrams")}
                  placeholder="如 200"
                  className={`${inputCls} tnum`}
                />
              </Field>
              <Field label="烘焙日期" hint="选填">
                <input
                  type="date"
                  value={form.roastDate}
                  onChange={set("roastDate")}
                  className={`${inputCls} tnum`}
                />
              </Field>
              <Field label="养豆天数" hint={restDaysHint(form.roastLevel)}>
                <input
                  type="number"
                  min={0}
                  value={form.restDays}
                  onChange={set("restDays")}
                  placeholder="按烘焙度建议，可覆盖"
                  className={`${inputCls} tnum`}
                />
              </Field>
            </div>
            <Field label="风味笔记">
              <textarea
                value={form.tastingNotes}
                onChange={set("tastingNotes")}
                rows={2}
                placeholder="茉莉花香、柑橘、红茶尾韵…"
                className={`${inputCls} resize-none`}
              />
            </Field>
            {error && <p className="text-xs text-[var(--bad)]">⚠ {error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeForm} className={btnGhost}>
                取消
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !form.name.trim()}
                className={btnPrimary}
              >
                {saving ? <Spinner /> : editId ? "保存修改" : "保存豆档案"}
              </button>
            </div>
          </div>
        )}

        <div className="p-5">
          {!loadFailed && beans === null && (
            <div
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
              aria-label="豆库加载中"
            >
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <div
                  key={index}
                  className="rounded-xl border border-[var(--line)] bg-[var(--bg-card)] p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="skeleton h-4 w-28" />
                    <span className="skeleton h-4 w-12" />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <span className="skeleton h-5 w-14 rounded-full" />
                    <span className="skeleton h-5 w-16 rounded-full" />
                  </div>
                  <span className="skeleton mt-5 block h-3 w-20" />
                  <span className="skeleton mt-3 block h-1 w-full rounded-full" />
                </div>
              ))}
            </div>
          )}
          {loadFailed && (
            <p className="rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-4 py-3 text-center text-xs text-[var(--tx-3)]">
              豆库接口暂不可用（后端离线或尚未实现 /api/beans），启动 server 后自动恢复。
            </p>
          )}
          {!loadFailed && beans !== null && beans.length === 0 && !showForm && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <IconBeanBig />
              <p className="text-sm font-medium text-[var(--tx-1)]">豆库还是空的</p>
              <p className="text-xs leading-relaxed text-[var(--tx-2)]">
                点右上角「新建豆档案」录入你的第一支豆，记录库存与烘焙日期，生成配方时一键带入
              </p>
              <button type="button" onClick={() => setShowForm(true)} className={btnGhost}>
                ＋ 新建豆档案
              </button>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(beans ?? []).map((b) => (
              <BeanCard
                key={b.id}
                bean={b}
                related={recipes ? relatedOf(b, recipes) : []}
                theme={theme}
                onChanged={onChanged}
                onLoad={onLoad}
                onEdit={() => startEdit(b)}
                onDelete={() => void remove(b.id)}
                allBeans={beans ?? []}
                unrelated={recipes ? unrelatedRecipes(b, recipes) : []}
                onRecipesChanged={onRecipesChanged}
                onUseBean={onUseBean}
              />
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI 推荐卡（任务 #51：进入页面拉取 Top3，失败/空优雅降级，绝不阻塞页面）
// ---------------------------------------------------------------------------

function RecommendCard({
  beansReady,
  onUseBean,
}: {
  beansReady: boolean;
  onUseBean?: (beanId: string) => void;
}) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [items, setItems] = useState<BeanRecommendation[]>([]);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (!beansReady) return;
    let alive = true;
    api
      .recommendBeans()
      .then((res) => {
        if (!alive) return;
        setItems(res.recommendations ?? []);
        setFallback(res.fallback === true);
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("failed");
      });
    return () => {
      alive = false;
    };
  }, [beansReady]);

  // 后端未就绪时隐藏整卡（任务 #65）：避免离线/加载中永久骨架；请求失败同样不展示
  if (!beansReady || state === "failed") return null;

  return (
    <Card>
      <CardHeader
        icon={<IconSpark />}
        title="今天冲哪支"
        sub={
          state === "ready" && items.length > 0
            ? "按养豆状态、库存和冲煮记录排出三支"
            : "综合养豆窗口 / 库存水位 / 冲煮反馈"
        }
        right={
          fallback && state === "ready" ? (
            <span className="text-[11px] text-[var(--tx-3)]">按新鲜度/库存规则推荐</span>
          ) : undefined
        }
      />
      <div className="p-5">
        {state === "loading" && (
          <div className="space-y-3" aria-label="推荐加载中">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="skeleton h-4 w-28" />
                <div className="skeleton h-1.5 flex-1" />
                <div className="skeleton h-4 w-10" />
              </div>
            ))}
          </div>
        )}
        {state === "ready" && items.length === 0 && (
          <p className="py-2 text-center text-xs text-[var(--tx-3)]">
            暂无可推荐 —— 录入烘焙日期与库存后推荐会更准
          </p>
        )}
        {state === "ready" && items.length > 0 && (
          <ul className="space-y-4">
            {items.map((it, i) => (
              <li key={it.beanId ?? i} className="animate-fade-up">
                <div className="flex items-center gap-3">
                  <span className="tnum w-4 shrink-0 text-center font-display text-sm font-semibold text-[var(--acc)]">
                    {i + 1}
                  </span>
                  <span
                    className="w-32 shrink-0 truncate text-[13px] font-medium text-[var(--tx-1)]"
                    title={it.beanName}
                  >
                    {it.beanName}
                  </span>
                  {/* 评分条：咖啡金细条 */}
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-inset)]">
                    <span
                      className="block h-full rounded-full bg-[var(--acc)] transition-[width] duration-300"
                      style={{ width: `${Math.round(Math.min(1, Math.max(0, it.score)) * 100)}%` }}
                    />
                  </span>
                  <span className="tnum w-10 shrink-0 text-right text-[11px] text-[var(--tx-3)]">
                    {Math.round(Math.min(1, Math.max(0, it.score)) * 100)}
                  </span>
                  {onUseBean && (
                    <button
                      type="button"
                      onClick={() => onUseBean(it.beanId)}
                      className="shrink-0 rounded-md border border-[var(--line-strong)] px-2 py-1 text-[11px] font-medium text-[var(--tx-2)] transition-colors hover:bg-[var(--bg-inset)] hover:text-[var(--tx-1)]"
                    >
                      用这支豆
                    </button>
                  )}
                </div>
                <div className="ml-7 mt-1.5">
                  {it.summary ? (
                    <p className="text-[11px] leading-relaxed text-[var(--tx-2)]">{it.summary}</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {(it.reasons ?? []).map((r, j) => (
                        <span key={j} className={chipCls}>
                          {r}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 豆卡片：库存条 + 冲一杯 + 养豆倒计时胶囊 + 关联冲煮方案折叠区
// ---------------------------------------------------------------------------

interface BeanCardProps {
  bean: Bean;
  related: SavedRecipe[];
  theme: "dark" | "light";
  onChanged: () => void;
  onLoad?: (entry: SavedRecipe) => void;
  onEdit: () => void;
  onDelete: () => void;
  /** 全部豆档案（空壳检测与匹配用，任务 #130） */
  allBeans: Bean[];
  /** 未关联到此豆的配方（手动关联下拉用，任务 #130） */
  unrelated: SavedRecipe[];
  /** 配方列表刷新回调（手动关联/合并后触发，任务 #130） */
  onRecipesChanged?: () => void;
  onUseBean?: (beanId: string) => void;
}

function BeanCard({
  bean,
  related,
  theme,
  onChanged,
  onLoad,
  onEdit,
  onDelete,
  allBeans,
  unrelated,
  onRecipesChanged,
  onUseBean,
}: BeanCardProps) {
  const [consuming, setConsuming] = useState(false);
  const [notice, setNotice] = useState<{ tone: "warn" | "bad" | "ok"; text: string } | null>(null);
  const [showRelated, setShowRelated] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  /** 手动关联进行中（任务 #130） */
  const [linking, setLinking] = useState(false);
  /** 空壳合并进行中（任务 #130） */
  const [shellMerging, setShellMerging] = useState(false);

  const fresh = freshness(bean);
  /** 参考粉量：该豆最近关联配方的 doseGrams，缺省 15g */
  const doseRef = related[0]?.recipe.doseGrams ?? DEFAULT_DOSE_GRAMS;
  const brews = brewsLeft(bean.stockGrams, doseRef);
  const low = typeof bean.stockGrams === "number" && bean.stockGrams < doseRef;

  const consume = async () => {
    setConsuming(true);
    setNotice(null);
    try {
      const res = await api.consumeBean(bean.id, { grams: doseRef });
      onChanged();
      setNotice(
        res.warning
          ? { tone: "warn", text: res.warning }
          : { tone: "ok", text: `已冲一杯，剩 ${res.remainingGrams}g` },
      );
    } catch (e) {
      setNotice({ tone: "bad", text: (e as Error).message });
    } finally {
      setConsuming(false);
    }
  };

  const overlayEntries: CurveEntry[] = useMemo(
    () =>
      related.map((r, i) => ({
        recipe: r.recipe,
        label: `${r.recipe.name} v${r.version ?? 1}`,
        color: OVERLAY_COLORS[i % OVERLAY_COLORS.length],
      })),
    [related],
  );

  /** 空壳检测与匹配（任务 #130） */
  const isShell = isShellBean(bean);
  const shellMatch = isShell
    ? allBeans.find(
        (b) =>
          b.id !== bean.id &&
          !isShellBean(b) &&
          normalizeBeanNameFE(b.name) === normalizeBeanNameFE(bean.name),
      )
    : undefined;

  /** 手动关联配方到当前豆（任务 #130） */
  const linkRecipe = async (recipeId: string) => {
    if (!recipeId) return;
    setLinking(true);
    try {
      await api.linkRecipeBean(recipeId, bean.id);
      onChanged();
      onRecipesChanged?.();
    } catch (e) {
      setNotice({ tone: "bad", text: (e as Error).message });
    } finally {
      setLinking(false);
    }
  };

  /** 空壳合并到完整记录（任务 #130）：把空壳的配方 beanId 改指完整记录后删空壳 */
  const mergeShell = async () => {
    if (!shellMatch) return;
    setShellMerging(true);
    try {
      for (const r of related) {
        if (r.beanId === bean.id) {
          await api.linkRecipeBean(r.id, shellMatch.id);
        }
      }
      await api.deleteBean(bean.id);
      onChanged();
      onRecipesChanged?.();
    } catch (e) {
      setNotice({ tone: "bad", text: (e as Error).message });
    } finally {
      setShellMerging(false);
    }
  };

  return (
    /* 豆档案小卡（任务 #111 O1）：14px 圆角 + card-surface 阴影栈；hover 抬升 surface-2 + 边框加深，整卡不位移 */
    <div className="card-surface animate-fade-up flex flex-col rounded-[14px] border border-[var(--line)] bg-[var(--bg-card)] p-4 transition-[background-color,border-color] duration-150 hover:border-[var(--line-strong)] hover:bg-[var(--bg-card-2)]">
      {/* 标题行 */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-[-0.01em] text-[var(--tx-1)]">
            {bean.name}
          </p>
          {bean.roaster && <p className="mt-0.5 text-[11px] text-[var(--tx-3)]">{bean.roaster}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="text-[11px] text-[var(--tx-3)] transition-colors hover:text-[var(--tx-1)]"
          >
            编辑
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="text-[11px] text-[var(--tx-3)] transition-colors hover:text-[var(--bad)]"
          >
            ✕ 删除
          </button>
        </div>
      </div>

      {/* 空壳清理提示（任务 #130）：检测到空壳记录且有同名完整记录时提示合并 */}
      {isShell && shellMatch && (
        <div className="animate-fade-up mt-2 flex items-center gap-2 rounded-md border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-2.5 py-1.5 text-[11px] leading-relaxed text-[var(--tx-2)]">
          <span>空壳记录 · 可合并到「{shellMatch.name}」</span>
          <button
            type="button"
            onClick={() => void mergeShell()}
            disabled={shellMerging}
            className="ml-auto shrink-0 rounded border border-[var(--line-strong)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--tx-2)] transition-colors hover:bg-[var(--bg-inset)] hover:text-[var(--tx-1)] disabled:opacity-40"
          >
            {shellMerging ? <Spinner className="h-3 w-3" /> : "合并"}
          </button>
        </div>
      )}
      {isShell && !shellMatch && (
        <div className="mt-2 rounded-md border border-[var(--line)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-[11px] leading-relaxed text-[var(--tx-3)]">
          空壳记录 · 无同名完整豆可合并，可直接删除或补充档案信息
        </div>
      )}

      {/* 档案 chips（任务 #111 O1）：元信息标签 eyebrow 化 —— 11px / uppercase / 0.08em 字距 */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {bean.roastLevel && (
          <span className={`${chipCls} uppercase tracking-[0.08em] text-[var(--acc)]`}>
            {bean.roastLevel}
          </span>
        )}
        {bean.origin && (
          <span className={`${chipCls} uppercase tracking-[0.08em]`}>{bean.origin}</span>
        )}
        {bean.process && (
          <span className={`${chipCls} uppercase tracking-[0.08em]`}>{bean.process}</span>
        )}
        {bean.varietal && (
          <span className={`${chipCls} uppercase tracking-[0.08em]`}>{bean.varietal}</span>
        )}
      </div>

      {/* 养豆倒计时胶囊（三态语义色 / 未记录 tx-3） */}
      <div className="mt-2.5">
        <FreshnessPill fresh={fresh} />
      </div>

      {/* 库存区 */}
      <div className="mt-3">
        {typeof bean.stockGrams === "number" ? (
          <>
            <div className="flex items-baseline justify-between">
              <p className="tnum text-[13px] font-semibold text-[var(--tx-1)]">
                剩 {bean.stockGrams}g
                {brews !== null && (
                  <span className="ml-1.5 text-[11px] font-normal text-[var(--tx-3)]">
                    还可冲 {brews} 次
                  </span>
                )}
              </p>
              <button
                type="button"
                onClick={() => void consume()}
                disabled={consuming}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--line-strong)] bg-[var(--bg-card)] px-2 text-[11px] font-medium text-[var(--tx-2)] transition-colors duration-150 hover:bg-[var(--bg-inset)] hover:text-[var(--tx-1)] disabled:pointer-events-none disabled:opacity-40"
              >
                {consuming ? <Spinner className="h-3 w-3" /> : null}
                冲一杯 −{doseRef}g
              </button>
            </div>
            {/* 细进度条：咖啡金，低于一杯量转 --bad */}
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--bg-inset)]">
              <div
                className="h-full rounded-full transition-[width,background-color] duration-300"
                style={{
                  width: `${Math.round(Math.min(1, bean.stockGrams / STOCK_BAR_REF) * 100)}%`,
                  backgroundColor: low ? "var(--bad)" : "var(--acc)",
                }}
              />
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-[var(--tx-3)]">未录入库存</p>
            <button
              type="button"
              onClick={onEdit}
              className="text-[11px] font-medium text-[var(--acc)] underline-offset-4 hover:underline"
            >
              补录
            </button>
          </div>
        )}
        {notice && (
          <p
            className={`animate-fade-up mt-2 rounded-md px-2.5 py-1.5 text-[11px] leading-relaxed ${
              notice.tone === "warn"
                ? "bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] text-[var(--warn)]"
                : notice.tone === "bad"
                  ? "bg-[color-mix(in_srgb,var(--bad)_10%,transparent)] text-[var(--bad)]"
                  : "bg-[var(--sage-soft)] text-[var(--sage-deep)]"
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>

      {bean.tastingNotes && (
        <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--tx-2)]">{bean.tastingNotes}</p>
      )}

      {onUseBean && (
        <button
          type="button"
          onClick={() => onUseBean(bean.id)}
          className="mt-3 inline-flex h-9 w-full items-center justify-center rounded-lg border border-[var(--acc-line)] bg-[var(--acc-soft)] px-3 text-xs font-medium text-[var(--acc)] transition-colors duration-150 hover:border-[var(--acc)]"
        >
          用这支豆制定配方
        </button>
      )}

      {/* 关联冲煮方案折叠区 */}
      <div className="mt-3 border-t border-[var(--line)] pt-2.5">
        <button
          type="button"
          onClick={() => setShowRelated((v) => !v)}
          className="flex w-full items-center justify-between text-[11px] font-medium text-[var(--tx-3)] transition-colors duration-150 hover:text-[var(--tx-1)]"
        >
          <span>关联冲煮方案{related.length > 0 ? ` · ${related.length}` : ""}</span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden
            className={`transition-transform duration-200 ${showRelated ? "rotate-180" : ""}`}
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {showRelated && (
          <div className="animate-fade-up mt-2 space-y-2">
            {related.length === 0 && (
              <p className="text-[11px] leading-relaxed text-[var(--tx-3)]">
                暂无关联配方 —— 生成时选择这支豆，保存后自动关联
              </p>
            )}
            {related.map((r) => {
              const rating = r.feedbacks?.length
                ? r.feedbacks[r.feedbacks.length - 1].rating
                : undefined;
              return (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-medium text-[var(--tx-1)]">
                      {r.recipe.name}
                      <span className="ml-1 text-[var(--tx-3)]">v{r.version ?? 1}</span>
                    </p>
                    <p className="tnum mt-0.5 text-[11px] text-[var(--tx-3)]">
                      {rating !== undefined ? `★ ${rating}/5 · ` : ""}
                      {(r.createdAt ?? "").slice(0, 10)}
                    </p>
                  </div>
                  {onLoad && (
                    <button
                      type="button"
                      onClick={() => onLoad(r)}
                      className={`${btnGhost} h-7 shrink-0 px-2.5 text-[11px]`}
                    >
                      载入
                    </button>
                  )}
                </div>
              );
            })}
            {/* 手动关联配方（任务 #130）：下拉选择未关联的配方，选中后 PATCH */}
            {unrelated.length > 0 && (
              <div className="mt-2 border-t border-[var(--line)] pt-2">
                <label className="mb-1 block text-[10px] text-[var(--tx-3)]">手动关联配方</label>
                <select
                  value=""
                  onChange={(e) => void linkRecipe(e.target.value)}
                  disabled={linking}
                  className={`${inputCls} h-8 py-1 text-[11px]`}
                >
                  <option value="">{linking ? "关联中…" : "选择配方…"}</option>
                  {unrelated.slice(0, 20).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.recipe.name} v{r.version ?? 1}
                      {r.beanId ? " · 已关联其他豆" : " · 未关联"}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {/* 同豆 ≥2 方案：曲线叠加对比 */}
            {related.length >= 2 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowOverlay((v) => !v)}
                  className="text-[11px] font-medium text-[var(--acc)] underline-offset-4 hover:underline"
                >
                  {showOverlay ? "收起曲线叠加" : "曲线叠加对比"}
                </button>
                {showOverlay && (
                  <div className="animate-fade-up mt-2 rounded-lg border border-[var(--line)] p-2">
                    <CurveChart entries={overlayEntries} theme={theme} height={200} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 养豆倒计时胶囊（三态）
// ---------------------------------------------------------------------------

function FreshnessPill({ fresh }: { fresh: ReturnType<typeof freshness> }) {
  if (fresh.phase === "unknown") {
    return <span className="text-[11px] text-[var(--tx-3)]">未记录烘焙日期</span>;
  }
  const style = {
    resting:
      "border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] text-[var(--warn)]",
    prime:
      "border-[color-mix(in_srgb,var(--ok)_35%,transparent)] bg-[var(--sage-soft)] text-[var(--sage-deep)]",
    fading:
      "border-[color-mix(in_srgb,var(--bad)_35%,transparent)] bg-[color-mix(in_srgb,var(--bad)_10%,transparent)] text-[var(--bad)]",
  }[fresh.phase];
  const text = {
    resting: `养豆中 · 距适饮还有 ${fresh.daysToReady} 天`,
    prime: fresh.daysLeft > 0 ? `适饮期 · 剩 ${fresh.daysLeft} 天` : "适饮期 · 最后一天",
    fading: "已过适饮窗口",
  }[fresh.phase];
  return (
    <span
      className={`tnum inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 ${style}`}
    >
      <span className="h-1 w-1 rounded-full bg-current" aria-hidden />
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 图标
// ---------------------------------------------------------------------------

function IconBean() {
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
      <ellipse cx="12" cy="12" rx="7" ry="9" transform="rotate(35 12 12)" />
      <path d="M8.5 6.5c3 3.5 4 7.5 7 11" strokeLinecap="round" />
    </svg>
  );
}

function IconBeanBig() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--tx-3)"
      strokeWidth="1.5"
      aria-hidden
    >
      <ellipse cx="12" cy="12" rx="7" ry="9" transform="rotate(35 12 12)" />
      <path d="M8.5 6.5c3 3.5 4 7.5 7 11" strokeLinecap="round" />
    </svg>
  );
}

function IconSpark() {
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
        d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"
        strokeLinejoin="round"
      />
      <path
        d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z"
        strokeLinejoin="round"
        opacity="0.6"
      />
    </svg>
  );
}
