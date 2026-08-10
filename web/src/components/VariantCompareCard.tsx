/**
 * 双方案对比卡（任务 #62）：recipe 交付后、variant 事件出现时渲染于工作台中栏。
 * - running：「正在生成 AI 改进版…」进度态（动效 + 改进版思考缓冲折叠查看）；
 * - failed：降级提示条「改进版生成失败，已交付原版」+ message；
 * - ready：分段选择器 + diffRecipes 参数差异网格 + 双曲线叠加 + improvementNotes 卡片
 *   + 操作区（采用改进版 / 切回原版 / 保存两个方案）。
 * 全部复用既有 CSS 变量令牌，暗色模式零适配成本。
 */
import { useMemo, useState } from "react";
import type { ImprovementNote } from "../lib/api.js";
import type { Recipe } from "../lib/recipe-schema.js";
import type { ImprovedPayload, VariantPhase } from "../lib/variant.js";
import CurveChart, { OVERLAY_COLORS } from "./CurveChart.js";
import { diffRecipes } from "./TuningDiffCard.js";
import { Card, CardHeader } from "./ui.js";

export interface VariantCompareCardProps {
  phase: VariantPhase;
  /** 烘焙师原版配方（recipe 事件已交付） */
  original: Recipe;
  /** AI 改进版载荷（phase=ready 时非空） */
  improved: ImprovedPayload | null;
  /** 失败文案（phase=failed） */
  failMessage?: string;
  /** 改进版 reasoning/content 静默累计缓冲（进度态折叠查看） */
  buffer?: string;
  /** 当前工作台采用的方案 */
  activeVariant: "original" | "improved";
  savingPair?: boolean;
  theme: "dark" | "light";
  onAdoptImproved: () => void;
  onRevertOriginal: () => void;
  onSaveBoth: () => void;
}

export default function VariantCompareCard({
  phase,
  original,
  improved,
  failMessage,
  buffer = "",
  activeVariant,
  savingPair = false,
  theme,
  onAdoptImproved,
  onRevertOriginal,
  onSaveBoth,
}: VariantCompareCardProps) {
  const [focus, setFocus] = useState<"original" | "improved">("improved");
  const [showBuffer, setShowBuffer] = useState(false);

  const diffs = useMemo(
    () => (improved ? diffRecipes(original, improved.recipe) : []),
    [original, improved],
  );

  return (
    <Card className="animate-fade-up overflow-hidden">
      <CardHeader
        icon={<IconPair />}
        title="双方案对比"
        sub={
          phase === "ready"
            ? `${original.name} · 烘焙师原版 vs AI 改进版`
            : phase === "failed"
              ? "改进版生成失败 · 已交付原版"
              : "基于烘焙商参考方案的 AI 改进"
        }
        right={
          <span
            className={`rounded-full border px-2.5 py-1 text-[10px] font-medium tracking-wide ${
              phase === "ready"
                ? "border-[color-mix(in_srgb,var(--ok)_45%,transparent)] bg-[color-mix(in_srgb,var(--ok)_10%,transparent)] text-[var(--ok)]"
                : phase === "failed"
                  ? "border-[var(--line-strong)] bg-[var(--bg-inset)] text-[var(--tx-3)]"
                  : "border-[var(--acc-line)] bg-[var(--acc-soft)] text-[var(--acc)]"
            }`}
          >
            {phase === "ready" ? "双方案就绪" : phase === "failed" ? "已降级" : "生成中"}
          </span>
        }
      />

      <div className="space-y-5 p-5">
        {/* ---------------- 失败：降级提示条 ---------------- */}
        {phase === "failed" && (
          <div className="animate-fade-up rounded-xl border border-[color-mix(in_srgb,var(--warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] px-4 py-3">
            <p className="flex items-center gap-2 text-xs font-medium text-[var(--tx-1)]">
              <span className="text-[var(--warn)]" aria-hidden>
                ⚠
              </span>
              改进版生成失败，已交付原版
            </p>
            {failMessage && (
              <p className="mt-1 pl-5 text-[11px] leading-relaxed text-[var(--tx-2)]">
                {failMessage}
              </p>
            )}
          </div>
        )}

        {/* ---------------- 生成中：进度态 ---------------- */}
        {phase === "running" && (
          <div className="animate-fade-up space-y-3 rounded-xl border border-[var(--acc-line)] bg-[var(--acc-soft)] px-4 py-3.5">
            <p className="flex items-center gap-2 text-xs font-medium text-[var(--tx-1)]">
              <span className="flex gap-1" aria-hidden>
                <span className="h-1.5 w-1.5 animate-blink rounded-full bg-[var(--acc)]" />
                <span className="h-1.5 w-1.5 animate-blink rounded-full bg-[var(--acc)] [animation-delay:0.2s]" />
                <span className="h-1.5 w-1.5 animate-blink rounded-full bg-[var(--acc)] [animation-delay:0.4s]" />
              </span>
              正在生成 AI 改进版…
              <span className="tnum text-[var(--tx-3)]">原版已就绪</span>
            </p>
            {/* 流光进度条（纯 CSS，无新依赖） */}
            <div
              className="h-1 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--acc)_16%,transparent)]"
              aria-hidden
            >
              <div
                className="animate-shimmer h-full w-full rounded-full"
                style={{
                  backgroundImage:
                    "linear-gradient(90deg, transparent, var(--acc) 45%, transparent 55%, transparent)",
                  backgroundSize: "200% 100%",
                }}
              />
            </div>
            {buffer && (
              <>
                <button
                  type="button"
                  onClick={() => setShowBuffer((v) => !v)}
                  className="text-[11px] font-medium uppercase tracking-wider text-[var(--tx-3)] transition-colors hover:text-[var(--acc)]"
                >
                  {showBuffer ? "收起改进版思考 ▴" : "查看改进版思考 ▾"}
                </button>
                {showBuffer && (
                  <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--line)] bg-[var(--bg-card)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--tx-3)]">
                    {buffer}
                    <span className="animate-blink text-[var(--acc)]">▍</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ---------------- 就绪：对比视图 ---------------- */}
        {phase === "ready" && improved && (
          <>
            {/* 分段选择器：--acc-soft 胶囊 + Fraunces 标题风格 */}
            <div className="flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--bg-inset)] p-1">
              <SegmentButton
                active={focus === "original"}
                dotColor={OVERLAY_COLORS[0]}
                label="烘焙师原版"
                badge={activeVariant === "original" ? "采用中" : undefined}
                onClick={() => setFocus("original")}
              />
              <SegmentButton
                active={focus === "improved"}
                dotColor={OVERLAY_COLORS[1]}
                label="AI 改进版"
                badge={activeVariant === "improved" ? "采用中" : undefined}
                onClick={() => setFocus("improved")}
              />
            </div>

            {/* 参数差异网格（复用 TuningDiffCard 的 diffRecipes 与样式语言） */}
            {diffs.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {diffs.map((it) => (
                  <div
                    key={it.label}
                    className="rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-3 py-2"
                  >
                    <p className="text-[11px] uppercase tracking-wider text-[var(--tx-3)]">
                      {it.label}
                    </p>
                    <p className="tnum mt-1 text-[13px] font-medium text-[var(--tx-2)]">
                      <span className="line-through decoration-[var(--line-strong)] opacity-60">
                        {it.from}
                      </span>
                      <span className="mx-1.5 text-[var(--tx-3)]">→</span>
                      <span className="text-[var(--acc)]">{it.to}</span>
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-[var(--tx-3)]">
                关键参数保持一致，AI 改进版仅优化节奏与细节表达。
              </p>
            )}

            {/* 双曲线叠加 */}
            <div className="rounded-xl border border-[var(--line)] p-2">
              <CurveChart
                entries={[
                  { recipe: original, label: "烘焙师原版", color: OVERLAY_COLORS[0] },
                  { recipe: improved.recipe, label: "AI 改进版", color: OVERLAY_COLORS[1] },
                ]}
                theme={theme}
                height={260}
              />
            </div>

            {/* improvementNotes 逐条卡片 */}
            {improved.improvementNotes && improved.improvementNotes.length > 0 && (
              <div className="space-y-2.5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--tx-3)]">
                  改进依据 · {improved.improvementNotes.length} 项
                </p>
                <ol className="space-y-2.5">
                  {improved.improvementNotes.map((n, i) => (
                    <NoteCard key={`${n.param}-${i}`} note={n} index={i + 1} />
                  ))}
                </ol>
              </div>
            )}

            {/* 改进版钳位与警告 */}
            {improved.clamped.length > 0 && (
              <div className="rounded-lg border border-[var(--acc-line)] bg-[var(--acc-soft)] px-3.5 py-2.5 text-[11px] leading-relaxed text-[var(--tx-2)]">
                <p className="font-medium text-[var(--acc)]">改进版已自动修正越界参数：</p>
                <ul className="mt-0.5 list-inside list-disc space-y-0.5">
                  {improved.clamped.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {improved.warning && (
              <p className="rounded-lg border border-[color-mix(in_srgb,var(--warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] px-3.5 py-2.5 text-[11px] leading-relaxed text-[var(--tx-2)]">
                <span className="font-medium text-[var(--warn)]">提示：</span>
                {improved.warning}
              </p>
            )}

            {/* 操作区 */}
            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-4">
              {activeVariant === "original" ? (
                <button
                  type="button"
                  onClick={onAdoptImproved}
                  className="rounded-lg bg-[var(--btn-bg)] px-4 py-2 text-xs font-medium text-[var(--btn-fg)] transition-colors duration-150 hover:bg-[var(--btn-bg-hover)]"
                >
                  采用改进版
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onRevertOriginal}
                  className="rounded-lg bg-[var(--btn-bg)] px-4 py-2 text-xs font-medium text-[var(--btn-fg)] transition-colors duration-150 hover:bg-[var(--btn-bg-hover)]"
                >
                  切回原版
                </button>
              )}
              <button
                type="button"
                onClick={onSaveBoth}
                disabled={savingPair}
                className="rounded-lg border border-[var(--acc-line)] bg-[var(--acc-soft)] px-4 py-2 text-xs font-medium text-[var(--acc)] transition-colors duration-150 hover:border-[var(--acc)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingPair ? "保存中…" : "保存两个方案"}
              </button>
              <span className="text-[11px] text-[var(--tx-3)]">
                {focus === "original"
                  ? "预览：烘焙师原版（编辑器/保存/BLE 随「采用中」方案联动）"
                  : "预览：AI 改进版（编辑器/保存/BLE 随「采用中」方案联动）"}
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 分段选择器按钮
// ---------------------------------------------------------------------------

function SegmentButton({
  active,
  dotColor,
  label,
  badge,
  onClick,
}: {
  active: boolean;
  dotColor: string;
  label: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-2 rounded-full px-4 py-2 text-xs font-medium transition-all duration-200 ${
        active
          ? "bg-[var(--acc-soft)] text-[var(--tx-1)] shadow-[inset_0_0_0_1px_var(--acc-line)]"
          : "text-[var(--tx-3)] hover:text-[var(--tx-1)]"
      }`}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: dotColor }}
        aria-hidden
      />
      <span className={active ? "font-display text-[13px] tracking-[-0.01em]" : ""}>{label}</span>
      {badge && (
        <span className="rounded-full bg-[var(--btn-bg)] px-1.5 py-px text-[10px] font-medium text-[var(--btn-fg)]">
          {badge}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 改进依据卡片：序号徽标 + 渐变细线 + 参数 from → to · 依据 · 预期风味收益
// ---------------------------------------------------------------------------

function NoteCard({ note, index }: { note: ImprovementNote; index: number }) {
  return (
    <li className="relative overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-card)] px-4 py-3">
      {/* 顶部渐变细线（克制点缀，暗色随令牌自适应） */}
      <span
        className="absolute inset-x-0 top-0 h-px"
        style={{
          backgroundImage:
            "linear-gradient(90deg, transparent, color-mix(in srgb, var(--acc) 55%, transparent), transparent)",
        }}
        aria-hidden
      />
      <div className="flex items-start gap-3">
        <span className="tnum mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--acc-line)] bg-[var(--acc-soft)] text-[10px] font-semibold text-[var(--acc)]">
          {index}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="tnum text-xs font-medium text-[var(--tx-1)]">
            {note.param}
            <span className="mx-1.5 text-[var(--tx-3)]">·</span>
            <span className="text-[var(--tx-3)] line-through decoration-[var(--line-strong)]">
              {note.from}
            </span>
            <span className="mx-1.5 text-[var(--tx-3)]">→</span>
            <span className="text-[var(--acc)]">{note.to}</span>
          </p>
          <p className="text-[11px] leading-relaxed text-[var(--tx-2)]">{note.rationale}</p>
          {note.expectedFlavor && (
            <p className="text-[11px] leading-relaxed text-[var(--tx-3)]">
              <span className="text-[var(--acc)]">预期风味收益：</span>
              {note.expectedFlavor}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function IconPair() {
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
      <rect x="3" y="5" width="7.5" height="14" rx="2" />
      <rect x="13.5" y="5" width="7.5" height="14" rx="2" />
      <path d="M6.75 9.5v3M17.25 9.5v3" strokeLinecap="round" opacity="0.55" />
    </svg>
  );
}
