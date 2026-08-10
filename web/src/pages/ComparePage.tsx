/**
 * 配方对比页：
 * - 曲线叠加模式（多配方水量/水温并绘，语义色区分）
 * - 并排参数差异表：不一致项高亮，逐段对齐（缺段显示 —）
 */
import { useMemo } from "react";
import type { SavedRecipe } from "../lib/api.js";
import type { Pour, Recipe } from "../lib/recipe-schema.js";
import { pourName } from "../lib/recipe-schema.js";
import { buildCurve, formatDuration, PATTERN_LABELS } from "../lib/curve-math.js";
import CurveChart, { OVERLAY_COLORS, type CurveEntry } from "../components/CurveChart.js";
import { Card, CardHeader } from "../components/ui.js";

export interface ComparePageProps {
  /** 勾选的本地配方（0–2 条） */
  entries: SavedRecipe[];
  theme: "dark" | "light";
}

export default function ComparePage({ entries, theme }: ComparePageProps) {
  const curveEntries: CurveEntry[] = useMemo(
    () =>
      entries.map((e, i) => ({
        recipe: e.recipe,
        label: e.recipe.name,
        color: OVERLAY_COLORS[i % OVERLAY_COLORS.length],
      })),
    [entries],
  );

  if (entries.length < 2) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <Card>
          <div className="flex flex-col items-center gap-3 p-12 text-center">
            <IconCompare />
            <h2 className="text-sm font-medium text-[var(--tx-1)]">选择两个配方进行对比</h2>
            <p className="max-w-sm text-xs leading-relaxed text-[var(--tx-2)]">
              回到「工作台」，在冲煮历史中勾选 2 个配方，即可在此查看并排参数差异与曲线叠加。
            </p>
          </div>
        </Card>
      </div>
    );
  }

  const [a, b] = entries;
  const ra = a.recipe;
  const rb = b.recipe;
  const ca = buildCurve(ra);
  const cb = buildCurve(rb);

  const ratioOf = (r: Recipe) =>
    (r.grandWater + (r.bypassEnabled ? r.bypassVolume : 0)) / r.doseGrams;
  const tempsOf = (r: Recipe) => {
    const ts = r.pours.map((p) => p.temperature);
    return Math.min(...ts) === Math.max(...ts)
      ? `${Math.min(...ts)}℃`
      : `${Math.min(...ts)}–${Math.max(...ts)}℃`;
  };

  const globalRows: { label: string; a: string; b: string }[] = [
    { label: "粉量", a: `${ra.doseGrams}g`, b: `${rb.doseGrams}g` },
    { label: "总水量", a: `${ra.grandWater}ml`, b: `${rb.grandWater}ml` },
    {
      label: "粉水比（含旁路）",
      a: `1:${ratioOf(ra).toFixed(2)}`,
      b: `1:${ratioOf(rb).toFixed(2)}`,
    },
    { label: "研磨度", a: `${ra.grinderSize}`, b: `${rb.grinderSize}` },
    { label: "转速", a: `${ra.rpm}rpm`, b: `${rb.rpm}rpm` },
    { label: "水温区间", a: tempsOf(ra), b: tempsOf(rb) },
    {
      label: "旁路水",
      a: ra.bypassEnabled ? `${ra.bypassVolume}ml · ${ra.bypassTemp}℃` : "关闭",
      b: rb.bypassEnabled ? `${rb.bypassVolume}ml · ${rb.bypassTemp}℃` : "关闭",
    },
    { label: "注水段数", a: `${ra.pours.length}`, b: `${rb.pours.length}` },
    { label: "总时长", a: formatDuration(ca.totalDuration), b: formatDuration(cb.totalDuration) },
    {
      label: "磨豆模式",
      a: ra.isSetGrinderSize === 2 ? "预磨粉" : "本机磨豆",
      b: rb.isSetGrinderSize === 2 ? "预磨粉" : "本机磨豆",
    },
  ];

  const maxSegs = Math.max(ra.pours.length, rb.pours.length);
  const segRows: { label: string; cell: (p: Pour) => string }[] = [
    { label: "水量", cell: (p) => `${p.volume}ml` },
    { label: "水温", cell: (p) => `${p.temperature}℃` },
    { label: "流速", cell: (p) => `${p.flowRate}ml/s` },
    { label: "图案", cell: (p) => PATTERN_LABELS[p.pattern] },
    { label: "停顿", cell: (p) => `${p.pausing}s` },
    {
      label: "振动",
      cell: (p) =>
        [p.vibBefore ? "前" : "", p.vibAfter ? "后" : ""].filter(Boolean).join("+") || "—",
    },
  ];

  const diffCls = (diff: boolean) =>
    diff ? "bg-[var(--bg-inset)] font-semibold text-[var(--tx-1)]" : "text-[var(--tx-2)]";

  return (
    <div className="mx-auto max-w-[1440px] space-y-6 px-6 py-8">
      {/* 页面级标题（Fraunces） */}
      <div className="space-y-3">
        <h2 className="font-display text-[32px] font-medium leading-10 tracking-[-0.02em] text-[var(--tx-1)]">
          配方对比
        </h2>
        <p className="text-sm leading-[22px] text-[var(--tx-2)]">
          {ra.name} vs {rb.name} · 曲线叠加 + 逐项参数差异
        </p>
      </div>
      {/* 曲线叠加 */}
      <Card className="overflow-hidden">
        <CardHeader icon={<IconCurve />} title="曲线叠加" sub={`${ra.name}  vs  ${rb.name}`} />
        <div className="p-3">
          <CurveChart entries={curveEntries} theme={theme} height={320} />
        </div>
      </Card>

      {/* 全局参数差异 */}
      <Card>
        <CardHeader icon={<IconDiff />} title="参数差异" sub="高亮项为两者不一致" />
        <div className="p-5">
          <table className="tnum w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--tx-3)]">
                <th className="w-1/3 pb-2 font-medium">参数</th>
                <th className="pb-2 font-medium">
                  <span
                    className="mr-1.5 inline-block h-2 w-2 rounded-full"
                    style={{ background: OVERLAY_COLORS[0] }}
                  />
                  {ra.name}
                </th>
                <th className="pb-2 font-medium">
                  <span
                    className="mr-1.5 inline-block h-2 w-2 rounded-full"
                    style={{ background: OVERLAY_COLORS[1] }}
                  />
                  {rb.name}
                </th>
              </tr>
            </thead>
            <tbody>
              {globalRows.map((row) => {
                const diff = row.a !== row.b;
                return (
                  <tr key={row.label} className="border-t border-[var(--line)]">
                    <td className="py-1.5 text-[var(--tx-3)]">{row.label}</td>
                    <td className={`rounded-l-md py-1.5 pl-2 ${diffCls(diff)}`}>{row.a}</td>
                    <td className={`rounded-r-md py-1.5 pl-2 ${diffCls(diff)}`}>{row.b}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* 逐段对比 */}
          <h3 className="mb-2 mt-6 text-[11px] font-medium uppercase tracking-wider text-[var(--tx-3)]">
            逐段对比（按序号对齐）
          </h3>
          <div className="overflow-x-auto">
            <table className="tnum w-full min-w-[520px] text-[11px]">
              <thead>
                <tr className="text-left text-[var(--tx-3)]">
                  <th className="pb-2 font-medium">段</th>
                  <th className="pb-2 font-medium" colSpan={2}>
                    {ra.name}
                  </th>
                  <th className="pb-2 font-medium" colSpan={2}>
                    {rb.name}
                  </th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: maxSegs }).map((_, i) => {
                  const pa = ra.pours[i];
                  const pb = rb.pours[i];
                  return (
                    <FragmentRow
                      key={i}
                      index={i}
                      nameA={pa ? pourName(pa, i) : undefined}
                      nameB={pb ? pourName(pb, i) : undefined}
                      rows={segRows.map((row) => ({
                        label: row.label,
                        a: pa ? row.cell(pa) : "—",
                        b: pb ? row.cell(pb) : "—",
                      }))}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** 单个段的对比行组 */
function FragmentRow({
  index,
  nameA,
  nameB,
  rows,
}: {
  index: number;
  nameA?: string;
  nameB?: string;
  rows: { label: string; a: string; b: string }[];
}) {
  return (
    <>
      <tr className="border-t border-[var(--line-strong)]">
        <td className="py-1.5 text-[var(--tx-3)]">第 {index + 1} 段</td>
        <td className="py-1.5 font-medium text-[var(--tx-1)]" colSpan={2}>
          {nameA ?? "—（无此段）"}
        </td>
        <td className="py-1.5 font-medium text-[var(--tx-1)]" colSpan={2}>
          {nameB ?? "—（无此段）"}
        </td>
      </tr>
      {rows.map((row) => {
        const diff = row.a !== row.b;
        const cls = diff
          ? "bg-[var(--bg-inset)] font-semibold text-[var(--tx-1)]"
          : "text-[var(--tx-2)]";
        return (
          <tr key={row.label} className="border-t border-[var(--line)]">
            <td className="py-1 pl-2 text-[var(--tx-3)]">{row.label}</td>
            <td className={`rounded-l-md py-1 pl-2 ${cls}`} colSpan={2}>
              {row.a}
            </td>
            <td className={`rounded-r-md py-1 pl-2 ${cls}`} colSpan={2}>
              {row.b}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function IconCompare() {
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
      <path d="M8 3v18M16 3v18" strokeLinecap="round" />
      <path d="M3 8h5M3 16h5M16 8h5M16 16h5" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

function IconCurve() {
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
      <path d="M3 20h18M4 16l4-2v-3l5-4 4 3 3-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconDiff() {
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
      <path d="M9 3v18M15 3v18M3 9h4M3 15h4M17 9h4M17 15h4" strokeLinecap="round" />
    </svg>
  );
}
