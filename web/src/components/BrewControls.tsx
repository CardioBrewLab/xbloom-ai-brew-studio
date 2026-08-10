/**
 * 参数控件组：
 * - BypassEditor：旁路水开关 + 水量滑杆（5–100ml）+ 温度（40–95℃），
 *   实时显示最终粉水比 (grandWater + bypassVolume) / dose，越界提醒
 * - GrinderScale：研磨度双标尺（云端 40–120 ↔ BLE 1–80）+ C40 手磨刻度读数/反向换算 + 粗细文字描述
 * - RatioCalculator：粉水比计算器，拖 ratio 实时出总水并可应用
 * - VibrationToggle：每段振动选择（无/前/后/前后 四态分段控件）
 */
import { useState } from "react";
import { CLOUD_LIMITS, BYPASS_RATIO_RANGE, type Recipe } from "../lib/recipe-schema.js";
import {
  bleToCloudGrind,
  c40ToCloud,
  cloudToBleGrind,
  cloudToC40,
  grindDescription,
  GRIND_LABELS_ZH,
} from "../lib/curve-math.js";
import { Slider, Toggle, chipCls } from "./ui.js";

// ---------------------------------------------------------------------------
// 1. Bypass 编辑器
// ---------------------------------------------------------------------------

export function BypassEditor({
  recipe,
  onChange,
}: {
  recipe: Recipe;
  onChange: (patch: Partial<Recipe>) => void;
}) {
  const finalWater = recipe.grandWater + (recipe.bypassEnabled ? recipe.bypassVolume : 0);
  const ratio = finalWater / recipe.doseGrams;
  const outOfRange = ratio < BYPASS_RATIO_RANGE.min || ratio > BYPASS_RATIO_RANGE.max;

  return (
    <div className="rounded-xl border border-[var(--curve-bypass)]/30 bg-[var(--bg-inset)] p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[var(--curve-bypass)]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--tx-1)]">
            旁路水 Bypass
          </span>
          <span className="text-[11px] text-[var(--tx-3)]">滤杯外直接补稀释水</span>
        </div>
        <Toggle
          checked={recipe.bypassEnabled}
          onChange={(v) => onChange({ bypassEnabled: v })}
          label="启用旁路水"
        />
      </div>

      {recipe.bypassEnabled && (
        <div className="animate-fade-up mt-3 space-y-3">
          <div>
            <div className="mb-1 flex items-baseline justify-between text-[11px]">
              <span className="text-[var(--tx-3)]">旁路水量</span>
              <span className="tnum font-medium text-[var(--curve-bypass)]">
                {recipe.bypassVolume}ml
                <span className="ml-1 text-[var(--tx-3)]">（5–100）</span>
              </span>
            </div>
            <Slider
              min={5}
              max={100}
              value={recipe.bypassVolume}
              onChange={(v) => onChange({ bypassVolume: Math.round(v) })}
            />
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between text-[11px]">
              <span className="text-[var(--tx-3)]">旁路水温</span>
              <span className="tnum font-medium text-[var(--curve-bypass)]">
                {recipe.bypassTemp}℃<span className="ml-1 text-[var(--tx-3)]">（40–95）</span>
              </span>
            </div>
            <Slider
              min={40}
              max={95}
              value={recipe.bypassTemp}
              onChange={(v) => onChange({ bypassTemp: Math.round(v) })}
            />
          </div>
          <div
            className={`tnum flex items-center justify-between rounded-lg border px-3 py-2 text-xs ${
              outOfRange
                ? "border-[var(--bad)]/50 bg-[color-mix(in_srgb,var(--bad)_10%,transparent)] text-[var(--bad)]"
                : "border-[var(--line-strong)] text-[var(--tx-2)]"
            }`}
          >
            <span>
              最终粉水比（{recipe.grandWater}+{recipe.bypassVolume}）÷ {recipe.doseGrams}g
            </span>
            <span className="font-semibold text-[var(--tx-1)]">
              1:{ratio.toFixed(2)}
              {outOfRange && (
                <span className="ml-2 font-sans text-[11px]">
                  超出建议区间 1:{BYPASS_RATIO_RANGE.min}–1:{BYPASS_RATIO_RANGE.max}
                </span>
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. 双标尺研磨度
// ---------------------------------------------------------------------------

const CLOUD_TICKS = [40, 60, 80, 100, 120] as const;

/** BLE 安全交集上限（超出仅影响 BLE 通道，云端发布不受影响） */
const BLE_SAFE_MAX = 80;

export function GrinderScale({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const clamped = Math.max(
    CLOUD_LIMITS.grinderSize.min,
    Math.min(CLOUD_LIMITS.grinderSize.max, value),
  );
  const ble = cloudToBleGrind(clamped);
  const c40 = cloudToC40(clamped);
  const desc = grindDescription(clamped);
  const fill = ((clamped - 40) / 80) * 100;

  // C40 反向换算输入（回车/失焦应用）
  const [c40Input, setC40Input] = useState("");
  const [c40Note, setC40Note] = useState<string | null>(null);

  function applyC40() {
    const clicks = Math.round(Number(c40Input));
    if (c40Input.trim() === "" || !Number.isFinite(clicks) || clicks < 0) {
      setC40Note("请输入有效的 C40 格数（0-40）");
      return;
    }
    const cloud = c40ToCloud(clicks);
    const notes: string[] = [];
    if (clicks < 11) notes.push("细于机器最细档，已按 40 处理");
    if (cloud > BLE_SAFE_MAX) notes.push("超出 BLE 安全交集，云端发布不受影响");
    setC40Note(notes.length > 0 ? notes.join("；") : `已设为 ${cloud}（≈C40 ${clicks} 格）`);
    onChange(cloud);
  }

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--tx-1)]">
          研磨度 · 双标尺
        </span>
        <span className="tnum text-sm font-semibold text-[var(--tx-1)]">
          {clamped} <span className="font-normal text-[var(--tx-3)]">—</span> {desc}
          <span className="ml-1.5 text-[11px] font-normal text-[var(--tx-3)]">
            {GRIND_LABELS_ZH[desc]}
          </span>
        </span>
      </div>

      {/* 粗细渐变轨道 + 指针 */}
      <div className="relative mt-3">
        <div className="h-1.5 rounded-full bg-gradient-to-r from-[var(--tx-2)] via-[var(--tx-3)] to-[var(--line-strong)] opacity-60" />
        <div
          className="absolute -top-[5px] h-4 w-4 -translate-x-1/2 rounded-full border-2 border-[var(--bg-card)] bg-[var(--tx-1)] shadow-[0_0_0_1px_var(--line-strong)] transition-[left] duration-100"
          style={{ left: `${fill}%` }}
        />
        <Slider min={40} max={120} value={clamped} onChange={onChange} />
      </div>

      {/* 云端刻度 */}
      <div className="tnum mt-1 flex justify-between text-[11px] text-[var(--tx-3)]">
        {CLOUD_TICKS.map((t) => (
          <span key={t} className={t === clamped ? "font-bold text-[var(--acc)]" : ""}>
            {t}
          </span>
        ))}
      </div>
      <div className="tnum flex justify-between text-[11px] text-[var(--tx-3)]">
        {CLOUD_TICKS.map((t) => (
          <span key={t}>≈BLE {cloudToBleGrind(t)}</span>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
        <span className="text-[var(--tx-3)]">细 ← 云端 40–120 → 粗</span>
        <div className="flex items-center gap-1.5">
          <span className={chipCls}>
            BLE 标尺 ≈ <span className="tnum font-semibold text-[var(--acc)]">{ble}</span> / 80
          </span>
          <span className={chipCls} title="Comandante C40 手磨刻度（官方换算，同向：越小越细）">
            ≈C40 <span className="tnum font-semibold text-[var(--acc)]">{c40}</span> 格
          </span>
        </div>
      </div>

      {/* C40 反向换算：输入格数 → 一键设置研磨度 */}
      <div className="mt-3 border-t border-[var(--line)] pt-3">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-[var(--tx-3)]">C40 格数 →</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={40}
            value={c40Input}
            placeholder="如 20"
            aria-label="输入 Comandante C40 格数"
            onChange={(e) => {
              setC40Input(e.target.value);
              setC40Note(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyC40();
            }}
            onBlur={() => {
              if (c40Input.trim() !== "") applyC40();
            }}
            className="tnum h-8 w-20 rounded-lg border border-[var(--line-strong)] bg-[var(--bg-card)] px-2 text-center text-xs text-[var(--tx-1)] outline-none transition-[border-color] duration-150 placeholder:text-[var(--tx-3)] focus:border-[var(--tx-1)]"
          />
          <button
            type="button"
            onClick={applyC40}
            className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-[var(--btn-bg)] px-3 text-[11px] font-medium text-[var(--btn-fg)] transition-colors duration-150 hover:bg-[var(--btn-bg-hover)]"
          >
            设置研磨度
          </button>
          <span className="truncate text-[11px] text-[var(--tx-3)]">
            回车即应用 · 常见手冲 20-25 格
          </span>
        </div>
        {c40Note && <p className="mt-1.5 text-[11px] text-[var(--tx-2)]">{c40Note}</p>}
      </div>
    </div>
  );
}

/** BLE 标尺拖动 → 换算回云端刻度（反向编辑入口） */
export function bleGrindToCloud(ble: number): number {
  return bleToCloudGrind(ble);
}

// ---------------------------------------------------------------------------
// 3. 粉水比计算器
// ---------------------------------------------------------------------------

export function RatioCalculator({
  doseGrams,
  grandWater,
  onGrandWater,
}: {
  doseGrams: number;
  grandWater: number;
  onGrandWater: (ml: number) => void;
}) {
  const ratio = doseGrams > 0 ? grandWater / doseGrams : 15.6;
  const displayRatio = Math.max(12, Math.min(20, Math.round(ratio * 10) / 10));

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--tx-1)]">
          粉水比计算器
        </span>
        <span className="tnum text-sm font-semibold text-[var(--tx-1)]">
          1:{displayRatio.toFixed(1)}
          <span className="ml-2 text-[11px] font-normal text-[var(--tx-3)]">
            {doseGrams}g → {grandWater}ml
          </span>
        </span>
      </div>
      <div className="mt-3">
        <Slider
          min={12}
          max={20}
          step={0.1}
          value={displayRatio}
          onChange={(r) => onGrandWater(Math.round(doseGrams * r * 10) / 10)}
        />
        <div className="tnum mt-1 flex justify-between text-[11px] text-[var(--tx-3)]">
          <span>1:12 浓郁</span>
          <span>1:15.6 经典</span>
          <span>1:20 清爽</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. 每段振动四态选择器
// ---------------------------------------------------------------------------

const VIB_OPTIONS: { key: string; label: string; before: boolean; after: boolean }[] = [
  { key: "none", label: "无", before: false, after: false },
  { key: "before", label: "前", before: true, after: false },
  { key: "after", label: "后", before: false, after: true },
  { key: "both", label: "前后", before: true, after: true },
];

export function VibrationToggle({
  vibBefore,
  vibAfter,
  onChange,
}: {
  vibBefore: boolean;
  vibAfter: boolean;
  onChange: (before: boolean, after: boolean) => void;
}) {
  const current =
    VIB_OPTIONS.find((o) => o.before === vibBefore && o.after === vibAfter) ?? VIB_OPTIONS[0];
  return (
    <div
      className="flex items-center overflow-hidden rounded-lg border border-[var(--line-strong)]"
      role="radiogroup"
      aria-label="振动搅拌"
    >
      {VIB_OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={current.key === o.key}
          title={`振动：${o.label}`}
          onClick={() => onChange(o.before, o.after)}
          className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors duration-150 ${
            current.key === o.key
              ? "bg-[var(--tx-1)] text-[var(--bg-card)]"
              : "text-[var(--tx-3)] hover:text-[var(--tx-1)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
