/**
 * ECharts 冲煮曲线（升级版）：
 * - 双 Y 轴：左轴 = 累计注水量（面积阶梯）与水温（折线）共用；右轴 = 流速
 * - 曲线语义色：水温 #E5B96B · 累计水量 #7FB2A0 · 流速 #A8A29E · 旁路水 #8FA3C8
 * - 段边界竖虚线 + 段标签（Bloom / Pour 2…）；pausing 阴影区块；旁路水终点标记
 * - 冲煮时间线播放头：markLine 沿时间轴移动（merge 更新，60fps 不重建）
 * - 对比叠加模式：多配方水量曲线并绘 + 图例
 */
import { init, use, type ECharts } from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useMemo, useRef } from "react";
import type { EChartsOption } from "echarts";
import type { Recipe } from "../lib/recipe-schema.js";
import { pourName } from "../lib/recipe-schema.js";
import { buildCurve, formatDuration } from "../lib/curve-math.js";

use([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  CanvasRenderer,
]);

// ---------------------------------------------------------------------------
// 主题调色板：运行时从 index.css CSS 令牌读取（getComputedStyle，任务 #108 P3），
// 消除双份硬编码；theme 参数仅用于触发重算与无 CSS 环境兜底。
// ---------------------------------------------------------------------------

export interface ChartPalette {
  text2: string;
  text3: string;
  grid: string;
  axis: string;
  tooltipBg: string;
  water: string;
  temp: string;
  flow: string;
  bypass: string;
  acc: string;
  pause: string;
}

export function getChartPalette(theme: "dark" | "light"): ChartPalette {
  const css = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const v = (name: string, fallback: string) => {
    const raw = css?.getPropertyValue(name).trim();
    return raw || fallback;
  };
  return {
    text2: v("--tx-2", theme === "dark" ? "#a8a29e" : "#57534e"),
    text3: v("--tx-3", theme === "dark" ? "#78716c" : "#8f8a80"),
    grid: v("--chart-grid", theme === "dark" ? "rgba(231,229,228,0.07)" : "rgba(17,17,16,0.06)"),
    axis: v("--chart-axis", theme === "dark" ? "#78716c" : "rgba(17,17,16,0.18)"),
    tooltipBg: v("--tooltip-bg", theme === "dark" ? "rgba(23,20,18,0.97)" : "#ffffff"),
    water: v("--curve-water", theme === "dark" ? "#7fb2a0" : "#4e8d77"),
    temp: v("--curve-temp", theme === "dark" ? "#dca963" : "#b47a33"),
    flow: v("--curve-flow", theme === "dark" ? "#a8a29e" : "#8f8a80"),
    bypass: v("--curve-bypass", theme === "dark" ? "#8fa3c8" : "#5f7db0"),
    acc: v("--acc", theme === "dark" ? "#dca963" : "#b47a33"),
    // pause 阴影无对应 CSS 变量，保留主题分支
    pause: theme === "dark" ? "rgba(231,229,228,0.05)" : "rgba(17,17,16,0.05)",
  };
}

/** 对比叠加模式的语义色板（咖啡金 / 水绿 / 蓝灰 / 赫红） */
export const OVERLAY_COLORS = ["#B47A33", "#4E8D77", "#5F7DB0", "#C0453E"] as const;

export interface CurveEntry {
  recipe: Recipe;
  color?: string;
  label?: string;
}

// ---------------------------------------------------------------------------
// option 构建
// ---------------------------------------------------------------------------

function waterDataOf(recipe: Recipe): [number, number][] {
  const curve = buildCurve(recipe);
  const data: [number, number][] = [[0, 0]];
  for (const seg of curve.segments) data.push([seg.pourEndTime, seg.cumulativeVolume]);
  return data;
}

function buildOption(
  entries: CurveEntry[],
  palette: ChartPalette,
  playTime: number | null,
): EChartsOption {
  const single = entries.length === 1;

  const maxWater = Math.max(...entries.map((e) => e.recipe.grandWater), 10);
  const maxTemp = Math.max(...entries.flatMap((e) => e.recipe.pours.map((p) => p.temperature)), 90);
  const maxDuration = Math.max(...entries.map((e) => buildCurve(e.recipe).totalDuration), 10);

  const series: EChartsOption["series"] = [];

  entries.forEach((entry, i) => {
    const r = entry.recipe;
    const c = buildCurve(r);
    const color = single
      ? palette.water
      : (entry.color ?? OVERLAY_COLORS[i % OVERLAY_COLORS.length]);
    const label = entry.label ?? r.name;

    // 累计注水：阶梯面积
    series.push({
      name: single ? "累计注水量" : `${label} · 注水`,
      type: "line",
      step: "end",
      data: waterDataOf(r),
      symbol: "circle",
      symbolSize: 5,
      showSymbol: true,
      lineStyle: { color, width: 2 },
      itemStyle: { color },
      areaStyle: single
        ? {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: hexA(color, 0.08) },
                { offset: 1, color: hexA(color, 0) },
              ],
            },
          }
        : { color: hexA(color, 0.05) },
      z: 3,
    });

    // 水温折线（每段注水中点）
    const tempData = c.segments.map((s) => [
      roundTo(s.pourEndTime - s.pourDuration / 2),
      s.pour.temperature,
    ]);
    series.push({
      name: single ? "水温" : `${label} · 水温`,
      type: "line",
      data: tempData,
      symbol: "diamond",
      symbolSize: 9,
      showSymbol: true,
      lineStyle: { color: single ? palette.temp : hexA(color, 0.55), width: 1.2, type: "dashed" },
      itemStyle: { color: single ? palette.temp : color },
      label: single
        ? {
            show: true,
            position: "top",
            color: palette.temp,
            fontSize: 10,
            formatter: (p) => `${(p.value as number[])[1]}℃`,
          }
        : { show: false },
      z: 4,
    });

    // 单配方专属：段边界 + pausing 阴影 + 旁路标记 + 流速
    if (single) {
      // 边界标签指向「下一段」：最后一段没有下一段，formatter 必须条件求值，
      // 否则 show:false 也阻止不了表达式立即求值导致 segments[idx+1] 越界崩溃。
      const boundaryData = c.segments.map((s, idx) => ({
        xAxis: s.segmentEndTime,
        label: {
          show: idx < c.segments.length - 1,
          formatter: idx + 1 < c.segments.length ? pourName(c.segments[idx + 1].pour, idx + 1) : "",
          position: "insideEndTop" as const,
          color: palette.text3,
          fontSize: 9,
        },
        lineStyle: { color: palette.grid, type: "dashed" as const, width: 1 },
      }));
      // 首段起点标签（segments 为空时不生成，杜绝 segments[0] 越界）
      if (c.segments.length > 0) {
        boundaryData.unshift({
          xAxis: 0,
          label: {
            show: true,
            formatter: pourName(c.segments[0].pour, 0),
            position: "insideEndTop" as const,
            color: palette.text3,
            fontSize: 9,
          },
          lineStyle: { color: "transparent", type: "dashed" as const, width: 0 },
        });
      }

      const pauseAreas = c.segments
        .filter((s) => s.segmentEndTime > s.pourEndTime)
        .map((s) => [
          { xAxis: s.pourEndTime, itemStyle: { color: palette.pause } },
          { xAxis: s.segmentEndTime },
        ]);

      // 把边界与阴影挂到水量系列（series[0]）
      const waterSeries = series[0] as Record<string, unknown>;
      waterSeries.markLine = { silent: true, symbol: "none", animation: false, data: boundaryData };
      waterSeries.markArea = { silent: true, data: pauseAreas };

      if (r.bypassEnabled) {
        waterSeries.markPoint = {
          symbol: "pin",
          symbolSize: 34,
          animation: false,
          itemStyle: { color: palette.bypass },
          label: { color: "#fff", fontSize: 9, formatter: "旁路" },
          data: [{ coord: [c.totalDuration, r.grandWater] }],
        };
      }

      // 流速系列（右轴）
      const flowData = c.segments.map((s) => [
        roundTo(s.pourEndTime - s.pourDuration / 2),
        s.pour.flowRate,
      ]);
      series.push({
        name: "流速",
        type: "line",
        yAxisIndex: 1,
        data: flowData,
        symbol: "triangle",
        symbolSize: 8,
        showSymbol: true,
        lineStyle: { color: hexA(palette.flow, 0.5), width: 1, type: "dotted" },
        itemStyle: { color: palette.flow },
        label: {
          show: true,
          position: "bottom",
          color: palette.flow,
          fontSize: 9,
          formatter: (p) => `${(p.value as number[])[1]}`,
        },
        z: 4,
      });
    }
  });

  // 播放头系列（恒定存在，markLine 数据 merge 更新）
  series.push({
    name: "__playhead",
    type: "line",
    data: [],
    silent: true,
    animation: false,
    markLine: {
      silent: true,
      symbol: ["circle", "none"],
      symbolSize: [8, 0],
      animation: false,
      lineStyle: { color: palette.acc, width: 1.6 },
      itemStyle: { color: palette.acc },
      label: {
        show: playTime !== null,
        position: "end",
        color: palette.acc,
        fontSize: 10,
        formatter: playTime !== null ? formatDuration(playTime) : "",
      },
      data: playTime !== null ? [{ xAxis: playTime }] : [],
    },
    z: 6,
  });

  return {
    backgroundColor: "transparent",
    animationDuration: 500,
    animationDurationUpdate: 400,
    textStyle: { fontFamily: '"Inter Tight", "PingFang SC", "Microsoft YaHei", sans-serif' },
    legend: {
      top: 4,
      right: 8,
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 6,
      textStyle: { color: palette.text2, fontSize: 11 },
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: palette.tooltipBg,
      borderColor: "rgba(128,120,110,0.2)",
      borderWidth: 1,
      borderRadius: 12,
      padding: [8, 12],
      extraCssText: "box-shadow: 0 12px 32px -12px rgba(0,0,0,0.16);",
      textStyle: { color: palette.text2, fontSize: 11 },
      valueFormatter: (v) => (typeof v === "number" ? String(v) : String(v ?? "")),
    },
    grid: { left: 46, right: 48, top: 44, bottom: 40 },
    xAxis: {
      type: "value",
      name: "时间 s",
      nameLocation: "middle",
      nameGap: 26,
      nameTextStyle: { color: palette.text3, fontSize: 11 },
      max: Math.ceil(maxDuration * 1.06),
      axisLine: { lineStyle: { color: palette.axis } },
      axisLabel: { color: palette.text3, fontSize: 11 },
      splitLine: { lineStyle: { color: palette.grid } },
    },
    yAxis: [
      {
        type: "value",
        name: "ml / ℃",
        nameTextStyle: { color: palette.text3, fontSize: 11 },
        max: Math.max(maxWater, maxTemp) * 1.18,
        axisLabel: { color: palette.text3, fontSize: 11 },
        splitLine: { lineStyle: { color: palette.grid } },
      },
      {
        type: "value",
        name: "mL/s",
        show: single,
        min: 0,
        max: 4.2,
        nameTextStyle: { color: palette.text3, fontSize: 11 },
        splitLine: { show: false },
        axisLabel: { color: palette.text3, fontSize: 11 },
      },
    ],
    series,
  };
}

function roundTo(v: number): number {
  return Math.round(v * 10) / 10;
}

function hexA(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export interface CurveChartProps {
  /** 一条或多条曲线；多条时进入叠加对比模式 */
  entries: CurveEntry[];
  /** 播放头时刻（s）；null = 不显示 */
  playTime?: number | null;
  /** 点击图表定位播放头 */
  onSeek?: (t: number) => void;
  theme: "dark" | "light";
  height?: number;
  /** 空态文案 */
  emptyText?: string;
}

export default function CurveChart({
  entries,
  playTime = null,
  onSeek,
  theme,
  height = 288,
  emptyText = "曲线将在配方就绪后呈现",
}: CurveChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const palette = useMemo(() => getChartPalette(theme), [theme]);
  const entriesKey = useMemo(() => JSON.stringify(entries), [entries]);

  // 初始化与销毁（React StrictMode 双挂载安全）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = init(el);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);

    if (onSeek) {
      chart.getZr().on("click", (e) => {
        const chart2 = chartRef.current;
        if (!chart2 || entriesRef.current.length === 0) return;
        try {
          const t = chart2.convertFromPixel("xAxis", e.offsetX) as number;
          if (Number.isFinite(t) && t >= 0) onSeek(Math.round(t * 10) / 10);
        } catch {
          /* 点击在绘图区外 */
        }
      });
    }

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // entries / 主题变化 → 整体重建
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    entriesRef.current = entries;
    if (entries.length > 0) {
      chart.setOption(buildOption(entries, palette, playTime), { notMerge: true });
    } else {
      chart.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesKey, palette]);

  // 播放头移动 → 仅 merge 播放头系列，避免整图重建
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || entries.length === 0) return;
    const seriesCount = (chart.getOption()?.series as unknown[] | undefined)?.length ?? 0;
    if (seriesCount === 0) return;
    const patch: Record<string, unknown>[] = Array.from({ length: seriesCount - 1 }, () => ({}));
    patch.push({
      markLine: {
        animation: false,
        label: {
          show: playTime !== null,
          formatter: playTime !== null ? formatDuration(playTime) : "",
        },
        data: playTime !== null ? [{ xAxis: playTime }] : [],
      },
    });
    chart.setOption({ series: patch });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playTime]);

  const entriesRef = useRef<CurveEntry[]>(entries);
  entriesRef.current = entries;

  return (
    <div className="relative">
      <div ref={containerRef} className="w-full" style={{ height }} />
      {entries.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-xs text-[var(--tx-3)]">{emptyText}</p>
        </div>
      )}
    </div>
  );
}
