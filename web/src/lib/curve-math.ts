/**
 * 冲煮曲线数学推算：
 * 按各段 volume/flowRate 推算注水时长，加上段后停顿，得出累计时间轴；
 * CurveChart（绘图）与 RecipeEditor（总时长展示 / 自动配平）共用本模块。
 */
import type { Pour, PourPattern, Recipe } from "./recipe-schema.js";

export const PATTERN_LABELS: Record<PourPattern, string> = {
  center: "中心",
  circular: "环形",
  spiral: "螺旋",
};

/** 分段色板（琥珀金主调的暖色渐变序列） */
export const SEGMENT_COLORS = [
  "#f59e0b",
  "#d4a24e",
  "#b45309",
  "#fbbf24",
  "#a16207",
  "#fde68a",
] as const;

export interface SegmentPoint {
  /** 段序号（从 1 开始） */
  index: number;
  pour: Pour;
  /** 本段注水耗时（s）= volume / flowRate */
  pourDuration: number;
  /** 注水结束时的累计时间（s） */
  pourEndTime: number;
  /** 本段结束（含停顿）时的累计时间（s） */
  segmentEndTime: number;
  /** 注水结束时的累计水量（ml） */
  cumulativeVolume: number;
}

export interface CurveModel {
  segments: SegmentPoint[];
  /** 总冲煮时长（s，含所有停顿） */
  totalDuration: number;
  /** 各段水量之和（ml） */
  sumVolume: number;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 由配方推算完整时间轴模型 */
export function buildCurve(recipe: Recipe): CurveModel {
  let t = 0;
  let vol = 0;
  const segments: SegmentPoint[] = recipe.pours.map((pour, i) => {
    const pourDuration = pour.flowRate > 0 ? pour.volume / pour.flowRate : 0;
    t += pourDuration;
    vol += pour.volume;
    const pourEndTime = t;
    t += pour.pausing;
    return {
      index: i + 1,
      pour,
      pourDuration: round1(pourDuration),
      pourEndTime: round1(pourEndTime),
      segmentEndTime: round1(t),
      cumulativeVolume: round1(vol),
    };
  });
  return {
    segments,
    totalDuration: round1(t),
    sumVolume: round1(vol),
  };
}

/** 秒 → "m:ss" 展示 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 时间轴插值：给定播放头时刻 t，返回当时的累计注水量与所处段信息。
 * 时间线模拟播放器与曲线上悬浮读数共用。
 */
export interface PlayheadInfo {
  /** 当前累计注水量（ml） */
  volume: number;
  /** 当前所处段序号（1 起） */
  segmentIndex: number;
  /** 是否处于段后停顿（浸泡等待）阶段 */
  inPause: boolean;
  /** 剩余总时长（s） */
  remaining: number;
}

export function curveStateAt(curve: CurveModel, t: number): PlayheadInfo {
  const clamped = Math.max(0, Math.min(t, curve.totalDuration));
  let prevEnd = 0;
  let prevVol = 0;
  for (const seg of curve.segments) {
    const segStart = prevEnd;
    const pourEnd = seg.pourEndTime;
    if (clamped <= pourEnd) {
      const progress = pourEnd - segStart > 0 ? (clamped - segStart) / (pourEnd - segStart) : 1;
      return {
        volume: round1(prevVol + seg.pour.volume * Math.max(0, Math.min(1, progress))),
        segmentIndex: seg.index,
        inPause: false,
        remaining: round1(curve.totalDuration - clamped),
      };
    }
    if (clamped <= seg.segmentEndTime) {
      return {
        volume: seg.cumulativeVolume,
        segmentIndex: seg.index,
        inPause: seg.segmentEndTime > pourEnd,
        remaining: round1(curve.totalDuration - clamped),
      };
    }
    prevEnd = seg.segmentEndTime;
    prevVol = seg.cumulativeVolume;
  }
  return {
    volume: curve.sumVolume,
    segmentIndex: curve.segments.length,
    inPause: false,
    remaining: 0,
  };
}

// ---------------------------------------------------------------------------
// 双标尺研磨度：云端 40-120 ↔ BLE 1-80
// ---------------------------------------------------------------------------

/** 云端研磨度 → BLE 标尺（官方换算：ble = round(1 + (cloud-40) × 79/80)） */
export function cloudToBleGrind(cloud: number): number {
  return Math.round(1 + ((cloud - 40) * 79) / 80);
}

/** BLE 标尺 → 云端研磨度（换算公式反解） */
export function bleToCloudGrind(ble: number): number {
  return Math.round(40 + ((ble - 1) * 80) / 79);
}

// ---------------------------------------------------------------------------
// 手磨刻度换算：Comandante C40 格数 ↔ 云端 grinderSize
// 依据 xBloom 官方帮助中心 C40 换算表推导（同向：数值越小越细）。
// 官方锚点：C40 11格=40；18格≈59；22格≈70（600µm 推荐校准点）；25格≈79；40格=120。
// 官方表在 .5 处向下取整（如 18格→59.5→59、22格→70.5→70），故用 roundHalfDown。
// ---------------------------------------------------------------------------

/** .5 向下取整的四舍五入（与官方 C40 换算表一致） */
function roundHalfDown(value: number): number {
  const rounded = Math.round(value);
  return rounded - value === 0.5 ? rounded - 1 : rounded;
}

/** C40 格数 → 云端研磨度：clamp(round(10 + 2.75 × clicks), 40, 120) */
export function c40ToCloud(clicks: number): number {
  const raw = roundHalfDown(10 + 2.75 * clicks);
  return Math.max(40, Math.min(120, raw));
}

/** 云端研磨度 → C40 格数：clamp(round((cloud − 10) / 2.75), 0, 40) */
export function cloudToC40(cloud: number): number {
  const raw = Math.round((cloud - 10) / 2.75);
  return Math.max(0, Math.min(40, raw));
}

/** 研磨度文字描述（粗细语义） */
export function grindDescription(cloud: number): string {
  if (cloud < 48) return "Extra Fine";
  if (cloud < 58) return "Fine";
  if (cloud < 70) return "Medium-Fine";
  if (cloud < 84) return "Medium";
  if (cloud < 98) return "Medium-Coarse";
  if (cloud < 111) return "Coarse";
  return "Extra Coarse";
}

export const GRIND_LABELS_ZH: Record<string, string> = {
  "Extra Fine": "极细研磨",
  Fine: "细研磨",
  "Medium-Fine": "中细研磨",
  Medium: "中研磨",
  "Medium-Coarse": "中粗研磨",
  Coarse: "粗研磨",
  "Extra Coarse": "极粗研磨",
};

/**
 * 自动配平：按现有各段比例缩放 volume，使总和等于 grandWater。
 * 误差分配给仍有调整空间的分段，保证总和精确相等；每段遵守 1ml 设备下限。
 */
export function balancePours(pours: Pour[], grandWater: number): Pour[] {
  const sum = pours.reduce((s, p) => s + p.volume, 0);
  if (sum <= 0 || pours.length === 0) return pours;
  const scale = grandWater / sum;
  const minimumTotal = pours.length;
  if (grandWater < minimumTotal) return pours;

  const next = pours.map((p) => ({ ...p, volume: Math.max(1, round1(p.volume * scale)) }));
  let diffTenths = Math.round((grandWater - round1(next.reduce((s, p) => s + p.volume, 0))) * 10);
  // 以 0.1ml 为单位逐段分配残差。减量时优先从大段扣除且不越过 1ml；
  // 加量时优先补到原占比最大的段，结果稳定且不会把误差压到末段。
  const order = next.map((_, index) => index).sort((a, b) => next[b].volume - next[a].volume);
  while (diffTenths !== 0) {
    const direction = Math.sign(diffTenths);
    const index = order.find((candidate) => direction > 0 || next[candidate].volume > 1);
    if (index === undefined) return pours;
    next[index] = { ...next[index], volume: round1(next[index].volume + direction * 0.1) };
    diffTenths -= direction;
  }
  return next;
}
