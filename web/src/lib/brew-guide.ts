/**
 * 引导式冲煮步骤模型（任务 #95）：
 * 由配方 pours 生成逐步引导序列 —— 每段注水一步，pausing>0 的段后追加停顿一步；
 * 每步携带目标累计水量 / 水温提示 / 计划时长与累计时间点，供引导计时器展示与单测。
 * 纯函数、无副作用：BrewGuide 组件与 web/test 共用。
 */
import type { Pour } from "./recipe-schema.js";
import { pourName } from "./recipe-schema.js";

export type GuideStepKind = "pour" | "pause";

export interface GuideStep {
  /** 步骤类型：注水 / 段间停顿 */
  kind: GuideStepKind;
  /** 所属段序号（1 起）；停顿步归属于其前一段 */
  pourIndex: number;
  /** 步骤名（注水 = 段名；停顿 = "等待 Ns"） */
  label: string;
  /** 本步注水量（ml）；停顿步恒为 0 */
  volume: number;
  /** 本步结束时的目标累计注水量（ml）；停顿步等于前段累计 */
  targetVolume: number;
  /** 水温提示（℃）；停顿步为 null */
  temperature: number | null;
  /** 本步计划时长（s）：注水 = volume/flowRate（flowRate<=0 记 0），停顿 = pausing */
  duration: number;
  /** 本步开始的累计时间（s） */
  startAt: number;
  /** 本步结束的累计时间（s） */
  endAt: number;
}

export interface BrewGuide {
  steps: GuideStep[];
  /** 各段水量之和（ml） */
  totalVolume: number;
  /** 计划总时长（s，含全部停顿） */
  totalDuration: number;
  /** 注水段数 */
  pourCount: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 由 pours 生成引导步骤序列与时间点。
 * 空数组安全：返回空 steps、零总量。
 */
export function buildBrewGuide(pours: Pour[]): BrewGuide {
  const steps: GuideStep[] = [];
  let t = 0;
  let vol = 0;

  pours.forEach((pour, i) => {
    const pourDuration = pour.flowRate > 0 ? pour.volume / pour.flowRate : 0;
    const name = pourName(pour, i);
    const startAt = t;
    t += pourDuration;
    vol += pour.volume;
    steps.push({
      kind: "pour",
      pourIndex: i + 1,
      label: name,
      volume: round1(pour.volume),
      targetVolume: round1(vol),
      temperature: pour.temperature,
      duration: round1(pourDuration),
      startAt: round1(startAt),
      endAt: round1(t),
    });

    // 段间停顿：仅 pausing>0 时插入独立一步，目标水量不变
    if (pour.pausing > 0) {
      const pauseStart = t;
      t += pour.pausing;
      steps.push({
        kind: "pause",
        pourIndex: i + 1,
        label: `等待 ${round1(pour.pausing)}s`,
        volume: 0,
        targetVolume: round1(vol),
        temperature: null,
        duration: round1(pour.pausing),
        startAt: round1(pauseStart),
        endAt: round1(t),
      });
    }
  });

  return {
    steps,
    totalVolume: round1(vol),
    totalDuration: round1(t),
    pourCount: pours.length,
  };
}

/**
 * 给定已进行秒数，返回当时所处步骤与插值读数（纯函数）。
 * elapsed 超出总时长一律按完成态处理。
 */
export interface GuideState {
  /** 当前步骤下标（0 起）；无步骤或已完成时为 -1 */
  stepIndex: number;
  /** 是否已全部完成 */
  finished: boolean;
  /** 当前步骤剩余秒数（完成后为 0） */
  stepRemaining: number;
  /** 当前累计注水量（ml，注水中按时间线性插值） */
  volume: number;
}

export function guideStateAt(guide: BrewGuide, elapsed: number): GuideState {
  const t = Math.max(0, elapsed);
  if (guide.steps.length === 0 || t >= guide.totalDuration) {
    return { stepIndex: -1, finished: true, stepRemaining: 0, volume: guide.totalVolume };
  }
  for (let i = 0; i < guide.steps.length; i++) {
    const step = guide.steps[i];
    if (t < step.endAt) {
      const prevTarget = i > 0 ? guide.steps[i - 1].targetVolume : 0;
      const volume =
        step.kind === "pause"
          ? step.targetVolume
          : step.duration > 0
            ? round1(prevTarget + step.volume * ((t - step.startAt) / step.duration))
            : step.targetVolume;
      return {
        stepIndex: i,
        finished: false,
        stepRemaining: round1(step.endAt - t),
        volume,
      };
    }
  }
  return { stepIndex: -1, finished: true, stepRemaining: 0, volume: guide.totalVolume };
}
