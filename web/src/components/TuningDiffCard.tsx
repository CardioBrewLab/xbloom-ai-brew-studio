/**
 * 反馈调参 Diff 摘要卡：调参生成完成后（有 baseRecipe 时）
 * 对上一版与新配方做字段级 diff（研磨/水温/粉水比/各段水量/bypass/转速），
 * 以卡片展示"本轮调整：研磨 46→70、水温 95→93℃…"并附 changeNotes。
 * 风格沿用现有亮色官网风（Card/CardHeader + CSS 变量）。
 */
import type { Recipe } from "../lib/recipe-schema.js";
import { Card, CardHeader } from "./ui.js";

export interface DiffItem {
  label: string;
  from: string;
  to: string;
}

/** 最终粉水比（bypass 计入），保留一位小数 */
function finalRatio(r: Recipe): number {
  return (
    Math.round(((r.grandWater + (r.bypassEnabled ? r.bypassVolume : 0)) / r.doseGrams) * 10) / 10
  );
}

function bypassText(r: Recipe): string {
  return r.bypassEnabled ? `开 · ${r.bypassVolume}ml/${r.bypassTemp}℃` : "关";
}

/** 字段级 diff：仅返回发生变化的项（浮点按 1e-6 容差） */
export function diffRecipes(base: Recipe, next: Recipe): DiffItem[] {
  const items: DiffItem[] = [];
  const num = (label: string, a: number, b: number, unit = "") => {
    if (Math.abs(a - b) > 1e-6) items.push({ label, from: `${a}${unit}`, to: `${b}${unit}` });
  };

  num("研磨度", base.grinderSize, next.grinderSize);
  num("转速", base.rpm, next.rpm);
  num("粉量", base.doseGrams, next.doseGrams, "g");
  num("总水量", base.grandWater, next.grandWater, "ml");

  const ra = finalRatio(base);
  const rb = finalRatio(next);
  if (Math.abs(ra - rb) > 1e-6) items.push({ label: "粉水比", from: `1:${ra}`, to: `1:${rb}` });

  if (bypassText(base) !== bypassText(next)) {
    items.push({ label: "旁路水", from: bypassText(base), to: bypassText(next) });
  }

  if (base.pours.length !== next.pours.length) {
    items.push({
      label: "分段结构",
      from: `${base.pours.length} 段`,
      to: `${next.pours.length} 段`,
    });
  } else {
    base.pours.forEach((p, i) => {
      const q = next.pours[i];
      const tag = i === 0 ? "闷蒸" : `第${i + 1}段`;
      num(`${tag}注水`, p.volume, q.volume, "ml");
      num(`${tag}水温`, p.temperature, q.temperature, "℃");
      if (i === 0) num("闷蒸停顿", p.pausing, q.pausing, "s");
    });
  }
  return items;
}

export interface TuningDiffCardProps {
  items: DiffItem[];
  /** LLM changeNotes（≤60 字调整理由） */
  changeNotes?: string;
  /** 本次迭代自动保存后的版本号 */
  version?: number;
}

export default function TuningDiffCard({ items, changeNotes, version }: TuningDiffCardProps) {
  return (
    <Card className="animate-fade-up overflow-hidden">
      <CardHeader
        icon={<IconDial />}
        title="本轮调整"
        sub={
          version
            ? `基于反馈的针对性微调 · 已保存为 v${version}`
            : "基于反馈的针对性微调（dial-in）"
        }
        right={
          <span className="rounded-full border border-[var(--acc-line)] bg-[var(--acc-soft)] px-2.5 py-1 text-[10px] font-medium tracking-wide text-[var(--acc)]">
            {items.length > 0 ? `${items.length} 项参数变化` : "骨架保留 · 细节优化"}
          </span>
        }
      />
      <div className="space-y-3 p-5">
        {items.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {items.map((it) => (
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
            关键参数保持不变，本轮仅优化段名、节奏细节等软性结构。
          </p>
        )}
        {changeNotes && (
          <p className="rounded-lg border border-[var(--acc-line)] bg-[var(--acc-soft)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--tx-2)]">
            <span className="font-medium text-[var(--acc)]">调整理由：</span>
            {changeNotes}
          </p>
        )}
      </div>
    </Card>
  );
}

function IconDial() {
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
      <circle cx="12" cy="12" r="8" />
      <path d="M12 12l3.5-3.5M12 4v2M20 12h-2M12 20v-2M4 12h2" strokeLinecap="round" />
    </svg>
  );
}
