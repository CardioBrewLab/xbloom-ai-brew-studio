/**
 * 冲煮时间线模拟播放器：
 * 播放/暂停 + 倍速（1×/2×/4×）+ 拖动定位；实时显示累计时间、剩余时间、
 * 当前段名、累计注水量与剩余水量倒计时。播放头同步驱动曲线 markLine。
 */
import { useEffect, useRef, useState } from "react";
import type { CurveModel } from "../lib/curve-math.js";
import { curveStateAt, formatDuration } from "../lib/curve-math.js";
import { pourName } from "../lib/recipe-schema.js";
import { Slider } from "./ui.js";

export interface BrewTimelineProps {
  curve: CurveModel;
  /** 当前播放头（s） */
  time: number;
  onTime: (t: number) => void;
}

const SPEEDS = [1, 2, 4] as const;

export default function BrewTimeline({ curve, time, onTime }: BrewTimelineProps) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const timeRef = useRef(time);
  timeRef.current = time;

  // rAF 播放引擎：到终点自动停止
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * speed;
      last = now;
      const next = timeRef.current + dt;
      if (next >= curve.totalDuration) {
        onTime(curve.totalDuration);
        setPlaying(false);
        return;
      }
      onTime(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, curve.totalDuration, onTime]);

  // 配方切换后播放头越界 → 复位
  useEffect(() => {
    if (time > curve.totalDuration) {
      setPlaying(false);
      onTime(0);
    }
  }, [curve.totalDuration, time, onTime]);

  const state = curveStateAt(curve, time);
  // 防御：segments 为空时 segmentIndex 为 0，segments[-1] 为 undefined，不可直接解引用
  const seg =
    curve.segments[
      Math.min(Math.max(state.segmentIndex - 1, 0), Math.max(curve.segments.length - 1, 0))
    ];
  const progress = curve.totalDuration > 0 ? (time / curve.totalDuration) * 100 : 0;
  const remainingWater = Math.max(0, Math.round((curve.sumVolume - state.volume) * 10) / 10);

  const toggle = () => {
    if (!playing && time >= curve.totalDuration) onTime(0);
    setPlaying((p) => !p);
  };

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] px-4 py-3">
      <div className="flex items-center gap-3">
        {/* 播放/暂停（黑白系） */}
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "暂停" : "播放"}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--btn-bg)] text-[var(--btn-fg)] transition-all duration-150 hover:bg-[var(--btn-bg-hover)] hover:-translate-y-px active:translate-y-0"
        >
          {playing ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5.5v13a1 1 0 0 0 1.53.85l10.2-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5z" />
            </svg>
          )}
        </button>

        {/* 时间读数 */}
        <div className="tnum shrink-0 text-[13px] font-semibold text-[var(--tx-1)]">
          {formatDuration(time)}
          <span className="mx-1 text-[var(--tx-3)]">/</span>
          <span className="text-[var(--tx-2)]">{formatDuration(curve.totalDuration)}</span>
        </div>

        {/* 滑杆 */}
        <div className="min-w-0 flex-1">
          <Slider
            min={0}
            max={Math.max(curve.totalDuration, 0.1)}
            step={0.1}
            value={Math.min(time, curve.totalDuration)}
            onChange={(t) => {
              setPlaying(false);
              onTime(t);
            }}
          />
          {/* 段落刻度 */}
          <div className="relative mt-0.5 h-1">
            {curve.segments.map((s) => (
              <span
                key={s.index}
                className="absolute top-0 h-1 w-px bg-[var(--line-strong)]"
                style={{ left: `${(s.segmentEndTime / curve.totalDuration) * 100}%` }}
              />
            ))}
          </div>
        </div>

        {/* 倍速 */}
        <div className="flex shrink-0 gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              className={`tnum rounded-md px-2 py-1 text-[11px] font-medium transition-colors duration-150 ${
                speed === s
                  ? "bg-[var(--tx-1)] text-[var(--bg-card)]"
                  : "text-[var(--tx-3)] hover:text-[var(--tx-1)]"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      {/* 实时读数行 */}
      <div className="tnum mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--tx-2)]">
        <span>
          进度 <span className="text-[var(--tx-1)]">{progress.toFixed(0)}%</span>
        </span>
        <span>
          当前段{" "}
          <span className="font-medium text-[var(--acc)]">
            {seg ? pourName(seg.pour, seg.index - 1) : "—"}
            {state.inPause ? " · 浸泡等待" : ""}
          </span>
        </span>
        <span>
          已注水 <span className="text-[var(--curve-water)]">{state.volume}ml</span>
        </span>
        <span>
          剩余 <span className="text-[var(--tx-1)]">{remainingWater}ml</span> ·{" "}
          <span className="text-[var(--tx-1)]">{formatDuration(state.remaining)}</span>
        </span>
      </div>
    </div>
  );
}
