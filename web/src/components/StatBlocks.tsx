/**
 * 大数字统计条：粉量 / 总注水（含旁路）/ 粉水比 / 水温区间。
 * 一行排列，块间 1px 竖分隔线（不包卡片），11px 标签 + 32px tnum 数字。
 */
import type { Recipe } from "../lib/recipe-schema.js";
import { buildCurve, formatDuration } from "../lib/curve-math.js";

export default function StatBlocks({ recipe }: { recipe: Recipe }) {
  const curve = buildCurve(recipe);
  const temps = recipe.pours.map((p) => p.temperature);
  const tMin = Math.min(...temps);
  const tMax = Math.max(...temps);
  const bypass = recipe.bypassEnabled ? recipe.bypassVolume : 0;
  const finalRatio = (recipe.grandWater + bypass) / recipe.doseGrams;

  const blocks: { label: string; value: string; unit: string; sub: string }[] = [
    {
      label: "粉量",
      value: String(recipe.doseGrams),
      unit: "g",
      sub: `研磨 ${recipe.grinderSize} · ${recipe.rpm}rpm`,
    },
    {
      label: "总注水",
      value: String(recipe.grandWater),
      unit: "ml",
      sub: bypass > 0 ? `含旁路水 +${bypass}ml` : `${recipe.pours.length} 段注水`,
    },
    {
      label: "粉水比",
      value: `1:${finalRatio.toFixed(1)}`,
      unit: "",
      sub: bypass > 0 ? "含旁路的最终比" : "总水 ÷ 粉量",
    },
    {
      label: "水温区间",
      value: tMin === tMax ? `${tMin}` : `${tMin}–${tMax}`,
      unit: "℃",
      sub: `总时长 ${formatDuration(curve.totalDuration)}`,
    },
  ];

  return (
    <div className="card-surface animate-fade-up flex flex-wrap items-stretch divide-x divide-[var(--line)] rounded-[14px] border border-[var(--line)] bg-[var(--bg-card)] px-2">
      {blocks.map((b) => (
        <div key={b.label} className="min-w-[140px] flex-1 px-5 py-5">
          {/* 标签 eyebrow 化（任务 #108 P1）：11px uppercase 0.08em */}
          <p className="eyebrow">{b.label}</p>
          <p className="tnum mt-1.5 flex items-baseline gap-1">
            {/* 大数字负字距（任务 #108 P1） */}
            <span className="text-[32px] font-semibold leading-none tracking-[-0.02em] text-[var(--tx-1)]">
              {b.value}
            </span>
            {b.unit && <span className="text-xs text-[var(--tx-3)]">{b.unit}</span>}
          </p>
          <p className="tnum mt-1.5 truncate text-[11px] leading-4 text-[var(--tx-3)]">{b.sub}</p>
        </div>
      ))}
    </div>
  );
}
