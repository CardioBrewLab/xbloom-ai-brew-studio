/**
 * 冲煮步骤时间轴：左侧 24px 序号圆 + 1px 连接线，段名与描述 + 右侧 tnum 数值。
 * 进行中黑底白字 / 未开始描边 / 完成黑色对勾；当前行 acc-soft 底 + 左侧 2px acc。
 * 点击任一行将播放头跳转至该段起点。
 */
import { pourName } from "../lib/recipe-schema.js";
import type { PourPattern, Recipe } from "../lib/recipe-schema.js";
import { buildCurve, PATTERN_LABELS } from "../lib/curve-math.js";
import { Card, CardHeader } from "./ui.js";

/** 注水图案图标：中心 / 环形 / 螺旋 */
export function PatternIcon({ pattern, size = 13 }: { pattern: PourPattern; size?: number }) {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    "aria-hidden": true,
  } as const;
  if (pattern === "center") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="8" opacity="0.35" />
        <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (pattern === "circular") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="7.5" />
        <path d="M12 4.5a7.5 7.5 0 0 1 7.5 7.5" strokeWidth="3.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <path
        d="M12 12m-1 0a1 1 0 1 0 2 0a3 3 0 1 0-6 0a5 5 0 1 0 10 0a7 7 0 1 0-14 0"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface StepCardsProps {
  recipe: Recipe;
  /** 播放中的当前段（1 起），undefined = 无高亮 */
  activeIndex?: number;
  /** 是否处于停顿等待 */
  inPause?: boolean;
  onJump?: (segmentStartSecond: number) => void;
}

export default function StepCards({ recipe, activeIndex, inPause, onJump }: StepCardsProps) {
  const curve = buildCurve(recipe);

  return (
    <Card className="overflow-hidden">
      <CardHeader title="冲煮步骤" sub={`${curve.segments.length} 段 · 点击任意段跳转播放头`} />
      <ol className="p-5">
        {curve.segments.map((seg, i) => {
          const active = activeIndex === seg.index;
          const done = activeIndex !== undefined && seg.index < activeIndex;
          const start = i === 0 ? 0 : curve.segments[i - 1].segmentEndTime;
          const p = seg.pour;
          const isLast = i === curve.segments.length - 1;

          return (
            <li key={i} className="relative flex gap-4">
              {/* 左侧：连接线 */}
              {!isLast && (
                <span
                  aria-hidden
                  className="absolute left-[12px] top-[28px] bottom-0 w-px bg-[var(--line-strong)]"
                />
              )}

              {/* 序号圆 */}
              <button
                type="button"
                onClick={() => onJump?.(start)}
                aria-label={`跳转到第 ${seg.index} 段`}
                className={`relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors ${
                  active
                    ? "bg-[var(--tx-1)] text-[var(--bg-card)]"
                    : done
                      ? "bg-[var(--tx-1)] text-[var(--bg-card)]"
                      : "border border-[var(--line-strong)] bg-[var(--bg-card)] text-[var(--tx-3)]"
                }`}
              >
                {done ? (
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    aria-hidden
                  >
                    <path d="M5 12.5l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <span className="tnum">{seg.index}</span>
                )}
              </button>

              {/* 主体行 */}
              <button
                type="button"
                onClick={() => onJump?.(start)}
                className={`group -ml-0 mb-1 min-w-0 flex-1 rounded-xl px-4 py-3 text-left transition-colors duration-150 ${
                  active
                    ? "border-l-2 border-l-[var(--acc)] bg-[var(--acc-soft)]"
                    : "hover:bg-[var(--bg-inset)]"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={`truncate text-[14px] font-semibold tracking-[-0.01em] ${active ? "text-[var(--tx-1)]" : "text-[var(--tx-1)]"}`}
                    >
                      {pourName(p, i)}
                    </span>
                    {active && (
                      // 状态徽章（任务 #114）：迁移到 .eyebrow 统一类 + --acc 变体，
                      // 不再内联 text-[10px] uppercase tracking-[0.1em]
                      <span className="eyebrow eyebrow--acc shrink-0">
                        {inPause ? "浸泡等待" : "注水中"}
                      </span>
                    )}
                  </span>
                  <span className="tnum shrink-0 text-[12px] text-[var(--tx-3)]">
                    {seg.pourDuration}s
                  </span>
                </div>

                {/* 描述：图案 + 参数 */}
                <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-[18px] text-[var(--tx-2)]">
                  <span className="flex items-center gap-1">
                    <span className={active ? "text-[var(--acc)]" : "text-[var(--tx-3)]"}>
                      <PatternIcon pattern={p.pattern} />
                    </span>
                    {PATTERN_LABELS[p.pattern]}注水
                  </span>
                  {p.pausing > 0 && <span className="text-[var(--tx-3)]">停顿 {p.pausing}s</span>}
                  {(p.vibBefore || p.vibAfter) && (
                    <span className="text-[var(--tx-3)]">
                      振动{p.vibBefore ? "·前" : ""}
                      {p.vibAfter ? "·后" : ""}
                    </span>
                  )}
                </p>

                {/* 右侧 tnum 数值行 */}
                <div className="tnum mt-2 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[12px]">
                  <span className="text-[var(--curve-water)]">{p.volume}ml</span>
                  <span className="text-[var(--curve-temp)]">{p.temperature}℃</span>
                  <span className="text-[var(--curve-flow)]">{p.flowRate}ml/s</span>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
