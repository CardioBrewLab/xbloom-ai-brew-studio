/**
 * 参数微调编辑器（全参数版）：
 * - 配方名 / 杯型 / 粉量 / 转速 / 总水量（SAFE_LIMITS 边界提示）
 * - 研磨度双标尺（云端 40–120 ↔ BLE 1–80）+ 粉水比计算器（拖 ratio 出总水）
 * - Bypass 编辑器（开关 + 水量 + 温度 + 最终粉水比实时显示）
 * - 磨豆模式（本机磨豆 / 预磨粉）
 * - 每段：段名 / 水量 / 水温 / 流速 / 停顿 / 图案 / 振动四态，可增删（1–6 段）
 * - 各段之和 ≠ grandWater 时红字警告 + 一键自动配平
 */
import { useEffect, useRef, useState } from "react";
import {
  POUR_PATTERNS,
  RPM_OPTIONS,
  SAFE_LIMITS,
  type CupType,
  type GrinderMode,
  type Pour,
  type PourPattern,
  type Recipe,
  type Rpm,
} from "../lib/recipe-schema.js";
import {
  balancePours,
  buildCurve,
  formatDuration,
  PATTERN_LABELS,
  round1,
} from "../lib/curve-math.js";
import { BypassEditor, GrinderScale, RatioCalculator, VibrationToggle } from "./BrewControls.js";
import { btnGhost, Card, CardHeader, Field, inputCls, Toggle } from "./ui.js";

const CUP_LABELS: Record<CupType, string> = {
  xdripper: "xDripper 手冲",
  other: "其他手冲器具",
};

function within(value: number, range: { min: number; max: number }): boolean {
  return value >= range.min && value <= range.max;
}

function rangeText(range: { min: number; max: number }, unit: string): string {
  return `${range.min}–${range.max}${unit}`;
}

/** 数字输入：内部文本态，合法时实时上抛 */
function NumInput({
  value,
  onChange,
  invalid,
  step = 1,
  suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  invalid?: boolean;
  step?: number;
  suffix?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  return (
    <div className="relative">
      <input
        type="number"
        value={text}
        step={step}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (!Number.isNaN(n) && e.target.value.trim() !== "") onChange(round1(n));
        }}
        className={`${inputCls} tnum pr-9 text-[13px] ${
          invalid
            ? "border-[var(--bad)] ring-2 ring-[color-mix(in_srgb,var(--bad)_25%,transparent)]"
            : ""
        }`}
      />
      {suffix && (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-[var(--tx-3)]">
          {suffix}
        </span>
      )}
    </div>
  );
}

export interface RecipeEditorProps {
  recipe: Recipe;
  onChange: (recipe: Recipe) => void;
  onSave: () => void;
  saving: boolean;
  savedAt?: number;
}

export default function RecipeEditor({
  recipe,
  onChange,
  onSave,
  saving,
  savedAt,
}: RecipeEditorProps) {
  const [draft, setDraft] = useState<Recipe>(recipe);
  /** 最近一次与父级同步（上抛或接收）的配方引用：用于区分"父级回显"与"外部新配方" */
  const lastSyncedRef = useRef<Recipe>(recipe);

  // 外部配方变化（新生成 / 历史加载 / 调参新版到达）时重置草稿；
  // 父级仅是回显本组件上抛的 draft（引用相同）时跳过，避免 draft↔recipe 互相投喂形成更新闭环
  useEffect(() => {
    if (recipe !== lastSyncedRef.current) {
      lastSyncedRef.current = recipe;
      setDraft(recipe);
    }
  }, [recipe]);

  // 草稿是否合法可上抛（段和 = 总水 且结构完整）
  const isEmitable = (r: Recipe): boolean => {
    const sum = round1(r.pours.reduce((s, p) => s + p.volume, 0));
    const balanced = Math.abs(sum - r.grandWater) <= 0.001;
    const structOk =
      r.name.trim().length > 0 &&
      r.doseGrams > 0 &&
      r.grandWater > 0 &&
      r.pours.length >= 1 &&
      r.pours.every((p) => p.volume > 0 && p.flowRate > 0 && p.pausing >= 0);
    return balanced && structOk;
  };

  // 草稿变更一律在事件处理中同步上抛（取代原 effect 回传）：
  // 事件驱动不依赖渲染快照，结构上消除"effect 读到过期 draft → 回抛旧值"的乒乓循环
  const apply = (next: Recipe) => {
    setDraft(next);
    if (isEmitable(next) && JSON.stringify(next) !== JSON.stringify(recipe)) {
      lastSyncedRef.current = next;
      onChange(next);
    }
  };

  const set = (patch: Partial<Recipe>) => apply({ ...draft, ...patch });
  const setPour = (i: number, patch: Partial<Pour>) =>
    apply({ ...draft, pours: draft.pours.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  const sum = round1(draft.pours.reduce((s, p) => s + p.volume, 0));
  const mismatch = Math.abs(sum - draft.grandWater) > 0.001;
  const curve = buildCurve({ ...draft, grandWater: Math.max(draft.grandWater, sum) });

  const addPour = () => {
    if (draft.pours.length >= 6) return;
    const last = draft.pours[draft.pours.length - 1];
    apply({
      ...draft,
      pours: [
        ...draft.pours,
        {
          volume: 50,
          temperature: last.temperature,
          flowRate: last.flowRate,
          pattern: last.pattern,
          pausing: 5,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    });
  };
  const removePour = (i: number) => {
    if (draft.pours.length <= 1) return;
    apply({ ...draft, pours: draft.pours.filter((_, j) => j !== i) });
  };

  return (
    <Card>
      <CardHeader
        icon={<IconKnob />}
        title="配方微调"
        sub={`总时长约 ${formatDuration(curve.totalDuration)} · 安全区间 = 云端 ∩ BLE`}
        right={
          <button type="button" onClick={onSave} disabled={saving || mismatch} className={btnGhost}>
            {saving ? "保存中…" : savedAt ? "✓ 已保存 · 再次保存" : "保存到历史"}
          </button>
        }
      />
      {/* 总时长超 3:00 警告（任务 #35）：仅提示不拦截 */}
      {curve.totalDuration > 180 && (
        <div className="mx-5 mt-4 rounded-lg border border-[var(--acc-line)] bg-[var(--acc-soft)] px-3 py-2 text-[11px] leading-relaxed text-[var(--tx-2)]">
          <span className="font-medium text-[var(--acc)]">⚠ 时长提示：</span>
          估算总时长约 {formatDuration(curve.totalDuration)}，超过 3:00
          建议线，粉床易堵塞/过萃，可考虑调粗研磨、减少段数或缩短段间停顿。
        </div>
      )}
      <div className="space-y-5 p-5">
        {/* 全局参数 */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="配方名">
            <input
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              className={inputCls}
              placeholder="我的配方"
            />
          </Field>
          <Field label="杯型">
            <span className={`${inputCls} flex items-center text-[var(--tx-2)]`}>
              {CUP_LABELS[draft.cupType] ?? draft.cupType}
            </span>
          </Field>
          <Field label="粉量" hint={rangeText(SAFE_LIMITS.doseGrams, "g")}>
            <NumInput
              value={draft.doseGrams}
              step={0.5}
              suffix="g"
              invalid={!within(draft.doseGrams, SAFE_LIMITS.doseGrams)}
              onChange={(v) => set({ doseGrams: v })}
            />
          </Field>
          <Field label="转速">
            <select
              value={draft.rpm}
              onChange={(e) => set({ rpm: Number(e.target.value) as Rpm })}
              className={inputCls}
            >
              {RPM_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r} rpm
                </option>
              ))}
            </select>
          </Field>
          <Field label="总水量" hint={rangeText(SAFE_LIMITS.totalWater, "ml")}>
            <NumInput
              value={draft.grandWater}
              step={5}
              suffix="ml"
              invalid={!within(draft.grandWater, SAFE_LIMITS.totalWater)}
              onChange={(v) => set({ grandWater: v })}
            />
          </Field>
          <Field label="磨豆模式">
            <select
              value={draft.isSetGrinderSize}
              onChange={(e) => set({ isSetGrinderSize: Number(e.target.value) as GrinderMode })}
              className={inputCls}
            >
              <option value={1}>本机磨豆</option>
              <option value={2}>预磨粉</option>
            </select>
          </Field>
          <div className="col-span-2 flex items-center justify-between gap-3 rounded-lg border border-[var(--line-strong)] px-3 py-2">
            <span className="text-[11px] uppercase tracking-wider text-[var(--tx-3)]">
              自动配平状态
            </span>
            {mismatch ? (
              <span className="tnum flex items-center gap-2 text-[11px] text-[var(--bad)]">
                ⚠ 各段 {sum}ml ≠ 总水 {draft.grandWater}ml
                <button
                  type="button"
                  onClick={() =>
                    apply({ ...draft, pours: balancePours(draft.pours, draft.grandWater) })
                  }
                  className="rounded border border-[var(--bad)]/60 px-2 py-0.5 text-[11px] transition-colors hover:bg-[color-mix(in_srgb,var(--bad)_14%,transparent)]"
                >
                  一键配平
                </button>
              </span>
            ) : (
              <span className="tnum text-[11px] text-[var(--ok)]">✓ 各段之和 = {sum}ml</span>
            )}
          </div>
        </div>

        {/* 粉水比计算器 + 研磨双标尺 */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <RatioCalculator
            doseGrams={draft.doseGrams}
            grandWater={draft.grandWater}
            onGrandWater={(ml) => set({ grandWater: ml })}
          />
          <GrinderScale value={draft.grinderSize} onChange={(v) => set({ grinderSize: v })} />
        </div>

        {/* Bypass 编辑器 */}
        <BypassEditor recipe={draft} onChange={set} />

        {/* 分段编辑 */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-medium uppercase tracking-wider text-[var(--tx-3)]">
              注水段（{draft.pours.length}/6）
            </h3>
            <button
              type="button"
              onClick={addPour}
              disabled={draft.pours.length >= 6}
              className={btnGhost}
            >
              ＋ 添加段
            </button>
          </div>

          {draft.pours.map((pour, i) => (
            <div
              key={i}
              className="animate-fade-up rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] p-3"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="tnum flex h-5 w-5 items-center justify-center rounded-full border border-[var(--line-strong)] bg-[var(--bg-card)] text-[10px] font-semibold text-[var(--tx-2)]">
                    {i + 1}
                  </span>
                  <input
                    value={pour.theName ?? ""}
                    onChange={(e) => setPour(i, { theName: e.target.value })}
                    placeholder={i === 0 ? "Bloom" : `Pour ${i + 1}`}
                    className="w-28 rounded border border-transparent bg-transparent px-1 text-xs font-semibold text-[var(--tx-1)] outline-none focus:border-[var(--line-strong)]"
                    aria-label={`第 ${i + 1} 段段名`}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <VibrationToggle
                    vibBefore={pour.vibBefore ?? false}
                    vibAfter={pour.vibAfter ?? false}
                    onChange={(b, a) => setPour(i, { vibBefore: b, vibAfter: a })}
                  />
                  <button
                    type="button"
                    onClick={() => removePour(i)}
                    disabled={draft.pours.length <= 1}
                    className="text-[11px] text-[var(--tx-3)] transition-colors hover:text-[var(--bad)] disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    ✕ 删除
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                <Field label="水量" hint="ml">
                  <NumInput
                    value={pour.volume}
                    step={5}
                    invalid={!within(pour.volume, SAFE_LIMITS.pourVolume)}
                    onChange={(v) => setPour(i, { volume: v })}
                  />
                </Field>
                <Field label="水温" hint="℃">
                  <NumInput
                    value={pour.temperature}
                    invalid={!within(pour.temperature, SAFE_LIMITS.waterTemperature)}
                    onChange={(v) => setPour(i, { temperature: v })}
                  />
                </Field>
                <Field label="流速" hint="mL/s">
                  <NumInput
                    value={pour.flowRate}
                    step={0.1}
                    invalid={!within(pour.flowRate, SAFE_LIMITS.flowRate)}
                    onChange={(v) => setPour(i, { flowRate: v })}
                  />
                </Field>
                <Field label="停顿" hint="s">
                  <NumInput
                    value={pour.pausing}
                    invalid={!within(pour.pausing, SAFE_LIMITS.pausing)}
                    onChange={(v) => setPour(i, { pausing: v })}
                  />
                </Field>
                <Field label="图案">
                  <select
                    value={pour.pattern}
                    onChange={(e) => setPour(i, { pattern: e.target.value as PourPattern })}
                    className={inputCls}
                  >
                    {POUR_PATTERNS.map((p) => (
                      <option key={p} value={p}>
                        {PATTERN_LABELS[p]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between rounded-lg border border-[var(--line)] px-3 py-2 text-[11px] leading-relaxed text-[var(--tx-3)]">
          <span>
            安全边界：粉量 {rangeText(SAFE_LIMITS.doseGrams, "g")} · 研磨{" "}
            {rangeText(SAFE_LIMITS.grinderSize, "")} · 水温{" "}
            {rangeText(SAFE_LIMITS.waterTemperature, "℃")} · 流速{" "}
            {rangeText(SAFE_LIMITS.flowRate, "mL/s")} · 停顿 {rangeText(SAFE_LIMITS.pausing, "s")}
          </span>
          <label className="flex shrink-0 items-center gap-1.5">
            <span>预磨粉模式</span>
            <Toggle
              checked={draft.isSetGrinderSize === 2}
              onChange={(v) => set({ isSetGrinderSize: v ? 2 : 1 })}
              label="预磨粉模式"
            />
          </label>
        </div>
      </div>
    </Card>
  );
}

function IconKnob() {
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
      <path d="M4 8h10M18 8h2M4 16h2M10 16h10" strokeLinecap="round" />
      <circle cx="16" cy="8" r="2" />
      <circle cx="8" cy="16" r="2" />
    </svg>
  );
}
