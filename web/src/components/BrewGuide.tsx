/**
 * 引导式冲煮计时器（任务 #95，对标 Filtru/timer.coffee 的核心体验）：
 * 全屏沉浸引导 —— 全局正计时 mm:ss + 大字号当前指令（注至 Xml / 等待 Ns），
 * 步骤清单已完成打勾淡化、当前段 acc-soft 高亮，结束态核对总时长与总水量。
 *
 * 计时引擎：setInterval + performance.now() 差值累计（accRef 累积暂停前秒数），
 * 暂停/恢复不跳秒；组件卸载清理 interval，无内存泄漏。
 * 提示音默认不做（保持极简，任务要求默认关）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildBrewGuide, guideStateAt } from "../lib/brew-guide.js";
import type { Recipe } from "../lib/recipe-schema.js";
import { formatDuration } from "../lib/curve-math.js";
import { btnGhost, btnPrimary } from "./ui.js";

type Phase = "ready" | "running" | "paused" | "done";

export interface BrewGuideProps {
  recipe: Recipe;
  onClose: () => void;
}

export default function BrewGuide({ recipe, onClose }: BrewGuideProps) {
  const guide = useMemo(() => buildBrewGuide(recipe.pours), [recipe]);
  const total = guide.totalDuration;
  const bypassEnabled = recipe.bypassEnabled === true;
  const bypassVolume = recipe.bypassVolume ?? 5;
  const bypassTemp = recipe.bypassTemp ?? 85;
  const finalWater = guide.totalVolume + (bypassEnabled ? bypassVolume : 0);

  const [phase, setPhase] = useState<Phase>("ready");
  const [elapsed, setElapsed] = useState(0);
  /** 暂停前已累计的秒数；恢复时只重打时间戳，保证不跳秒 */
  const accRef = useRef(0);
  /** 本轮 running 起始时间戳（performance.now ms） */
  const stampRef = useRef(0);

  // 计时引擎：仅 running 期间挂 interval，卸载/停止即清理
  useEffect(() => {
    if (phase !== "running") return;
    if (total <= 0) {
      accRef.current = 0;
      setElapsed(0);
      setPhase("done");
      return;
    }
    stampRef.current = performance.now();
    const id = setInterval(() => {
      const t = accRef.current + (performance.now() - stampRef.current) / 1000;
      if (t >= total) {
        accRef.current = total;
        setElapsed(total);
        setPhase("done");
      } else {
        setElapsed(t);
      }
    }, 100);
    return () => clearInterval(id);
  }, [phase, total]);

  // 防御：引导进行中配方被替换导致 elapsed 越界 → 直接进入完成态
  useEffect(() => {
    if ((phase === "running" || phase === "paused") && total > 0 && elapsed > total) {
      accRef.current = total;
      setElapsed(total);
      setPhase("done");
    }
  }, [phase, elapsed, total]);

  const start = useCallback(() => {
    accRef.current = 0;
    setElapsed(0);
    setPhase("running");
  }, []);

  const pause = useCallback(() => {
    accRef.current += (performance.now() - stampRef.current) / 1000;
    setPhase("paused");
  }, []);

  const reset = useCallback(() => {
    accRef.current = 0;
    setElapsed(0);
    setPhase("ready");
  }, []);

  // ESC 退出引导
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const state = guideStateAt(guide, elapsed);
  const activeStep = state.stepIndex >= 0 ? guide.steps[state.stepIndex] : null;
  const progress = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
  const pourLabel = activeStep ? `第 ${activeStep.pourIndex}/${guide.pourCount} 段` : "";

  return (
    <div
      className="brewguide-immersive fixed inset-0 z-50 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="引导式冲煮"
    >
      {/* 顶栏：配方名 + 退出（恒定暗色沉浸，任务 #108 P1） */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3.5 sm:px-8">
        <div className="min-w-0">
          <p className="eyebrow">Guided Brew · 引导冲煮</p>
          <h2 className="truncate font-display text-[16px] font-semibold tracking-[-0.01em]">
            {recipe.name}
            <span className="tnum ml-2 font-body text-[12px] font-normal text-[var(--tx-3)]">
              {recipe.doseGrams}g · {guide.totalVolume}ml
            </span>
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--line-strong)] px-3 text-xs font-medium text-[var(--tx-2)] transition-colors duration-150 hover:bg-[var(--bg-inset)] hover:text-[var(--tx-1)]"
        >
          退出引导
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden
          >
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {/* 主体：可滚动（时钟 + 指令 + 步骤清单） */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-xl flex-col px-5 pb-8 pt-8 sm:pt-12">
          {phase === "ready" ? (
            /* 待开始：配方速览 + 大按钮 */
            <div className="animate-fade-up flex flex-col items-center text-center">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--tx-3)]">
                Ready
              </p>
              <p className="tnum mt-3 text-[56px] font-semibold leading-none tracking-tight sm:text-[72px]">
                0:00
              </p>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                <GuideChip text={`${guide.pourCount} 段注水`} />
                <GuideChip text={`${guide.totalVolume}ml 总水量`} />
                <GuideChip text={`计划 ${formatDuration(total)}`} />
              </div>
              <p className="mt-5 max-w-sm text-xs leading-relaxed text-[var(--tx-3)]">
                按步骤跟随提示注水：每段显示目标累计水量与水温，段间停顿单独倒计时。
              </p>
              <button
                type="button"
                onClick={start}
                className={`${btnPrimary} mt-8 h-14 w-full max-w-xs text-[15px]`}
              >
                <IconPlay /> 开始冲煮
              </button>
            </div>
          ) : phase === "done" ? (
            /* 结束态：金色细圈对勾 + 总时长/总水量核对（任务 #108 P1） */
            <div className="animate-fade-up flex flex-col items-center text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--acc-line)] text-[var(--acc)]">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden
                >
                  <path d="M5 12.5l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <p className="mt-4 text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--tx-3)]">
                Brew Complete
              </p>
              <p className="tnum mt-2 text-[56px] font-semibold leading-none tracking-tight sm:text-[72px]">
                {formatDuration(elapsed)}
              </p>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                <GuideChip
                  text={`${bypassEnabled ? "机器注水" : "总注水"} ${guide.totalVolume}ml`}
                  tone="water"
                />
                {bypassEnabled && (
                  <GuideChip text={`冲煮结束后加入 ${bypassVolume}ml / ${bypassTemp}℃`} />
                )}
                <GuideChip
                  text={
                    bypassEnabled
                      ? `最终总水量 ${finalWater}ml`
                      : Math.abs(guide.totalVolume - recipe.grandWater) < 0.05
                        ? `与配方 ${recipe.grandWater}ml 一致 ✓`
                        : `配方 ${recipe.grandWater}ml · 实际 ${guide.totalVolume}ml`
                  }
                />
              </div>
              <p className="mt-5 text-xs text-[var(--tx-3)]">移开滤杯，享用这一杯。</p>
              <div className="mt-8 flex w-full max-w-xs flex-col gap-2.5">
                <button type="button" onClick={start} className={`${btnPrimary} h-12`}>
                  再冲一杯
                </button>
                <button type="button" onClick={onClose} className={`${btnGhost} h-11`}>
                  退出引导
                </button>
              </div>
            </div>
          ) : (
            /* 进行中 / 已暂停：大时钟 + 当前指令 */
            <div className="flex flex-col items-center text-center">
              {phase === "paused" && (
                <span className="mb-3 rounded-full border border-[var(--acc-line)] bg-[var(--acc-soft)] px-3 py-1 text-[11px] font-medium text-[var(--acc)]">
                  已暂停 · 计时已保留
                </span>
              )}
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--tx-3)]">
                {pourLabel || "进行中"}
              </p>
              <p
                className={`tnum mt-2 text-[68px] font-semibold leading-none tracking-tight sm:text-[92px] ${
                  phase === "paused" ? "text-[var(--tx-3)]" : ""
                }`}
              >
                {formatDuration(elapsed)}
              </p>

              {/* 当前指令卡 */}
              {activeStep && (
                <div
                  key={state.stepIndex}
                  className={`animate-pop-in mt-7 w-full rounded-2xl border px-6 py-5 ${
                    activeStep.kind === "pause"
                      ? "border-[var(--line)] bg-[var(--bg-inset)]"
                      : "border-[var(--acc-line)] bg-[var(--acc-soft)]"
                  }`}
                >
                  {activeStep.kind === "pause" ? (
                    <>
                      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--tx-3)]">
                        段间停顿 · 浸泡等待
                      </p>
                      <p className="mt-1.5 font-display text-[30px] font-semibold leading-tight tracking-[-0.01em] sm:text-[36px]">
                        等待{" "}
                        <span className="tnum animate-blink text-[var(--acc)]">
                          {Math.ceil(state.stepRemaining)}s
                        </span>
                      </p>
                      <p className="tnum mt-1.5 text-[12px] text-[var(--tx-3)]">
                        当前累计 {activeStep.targetVolume}ml · 水温{" "}
                        {lastPourTemp(guide, state.stepIndex) ?? "—"}℃
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--acc)]">
                        {activeStep.label} · 注水中
                      </p>
                      <p className="mt-1.5 font-display text-[30px] font-semibold leading-tight tracking-[-0.01em] sm:text-[36px]">
                        注至{" "}
                        <span className="tnum text-[var(--acc)]">{activeStep.targetVolume}ml</span>
                      </p>
                      <p className="tnum mt-1.5 text-[12px] text-[var(--tx-2)]">
                        本段 {activeStep.volume}ml · 水温 {activeStep.temperature}℃ · 剩约{" "}
                        {Math.ceil(state.stepRemaining)}s
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* 总进度条：香槟金渐变（任务 #108 P1） */}
              <div className="mt-7 w-full">
                <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--line)]">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(90deg,#DCA963,#B47A33)] transition-[width] duration-200 ease-linear"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="tnum mt-1.5 flex justify-between text-[11px] text-[var(--tx-3)]">
                  <span>{formatDuration(elapsed)}</span>
                  <span>{formatDuration(total)}</span>
                </div>
              </div>
            </div>
          )}

          {/* 步骤清单：ready/进行中/完成 均展示 */}
          {guide.steps.length > 0 && (
            <ol className="mt-9">
              {guide.steps.map((step, i) => {
                const active = state.stepIndex === i;
                const done = state.finished || i < state.stepIndex;
                const dim = done;
                return (
                  <li
                    key={i}
                    className={`flex items-center gap-3 border-b border-[var(--line)] px-3 py-3 transition-colors duration-150 last:border-b-0 ${
                      active ? "rounded-xl border-b-0 bg-[var(--acc-soft)]" : ""
                    } ${dim ? "opacity-55" : ""}`}
                  >
                    {/* 状态圆 */}
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                        active
                          ? "bg-[var(--tx-1)] text-[var(--bg-card)]"
                          : done
                            ? "bg-[var(--tx-1)] text-[var(--bg-card)]"
                            : "border border-[var(--line-strong)] text-[var(--tx-3)]"
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
                          <path
                            d="M5 12.5l4.5 4.5L19 7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : step.kind === "pause" ? (
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          aria-hidden
                        >
                          <rect x="7" y="5" width="3.4" height="14" rx="1" />
                          <rect x="13.6" y="5" width="3.4" height="14" rx="1" />
                        </svg>
                      ) : (
                        <span className="tnum">{step.pourIndex}</span>
                      )}
                    </span>

                    {/* 名称与参数 */}
                    <div className="min-w-0 flex-1">
                      <p
                        className={`truncate text-[13px] font-semibold ${active ? "text-[var(--tx-1)]" : "text-[var(--tx-2)]"}`}
                      >
                        {step.kind === "pause" ? `停顿 · ${step.label}` : step.label}
                        {active && step.kind === "pour" && (
                          // 状态徽章（任务 #114）：迁移到 .eyebrow 统一类 + --acc 变体，
                          // var 令牌在 brewguide-immersive 恒定暗色作用域下正常解析
                          <span className="eyebrow eyebrow--acc ml-2">注水中</span>
                        )}
                        {active && step.kind === "pause" && (
                          <span className="tnum ml-2 text-[11px] font-medium text-[var(--acc)]">
                            剩 {Math.ceil(state.stepRemaining)}s
                          </span>
                        )}
                      </p>
                      {step.kind === "pour" && (
                        <p className="tnum mt-0.5 text-[11px] text-[var(--tx-3)]">
                          {step.volume}ml · 水温 {step.temperature}℃ · {step.duration}s
                        </p>
                      )}
                      {step.kind === "pause" && (
                        <p className="tnum mt-0.5 text-[11px] text-[var(--tx-3)]">
                          {step.duration}s 浸泡
                        </p>
                      )}
                    </div>

                    {/* 目标累计水量 / 时间点 */}
                    <div className="tnum shrink-0 text-right">
                      <p
                        className={`text-[12px] font-medium ${active ? "text-[var(--curve-water)]" : "text-[var(--tx-2)]"}`}
                      >
                        注至 {step.targetVolume}ml
                      </p>
                      <p className="text-[11px] text-[var(--tx-3)]">
                        @ {formatDuration(step.endAt)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>

      {/* 底部控制条：开始/暂停/继续/重置 */}
      {(phase === "running" || phase === "paused") && (
        <div className="shrink-0 border-t border-[var(--line)] bg-[var(--bg-card)] px-5 py-4 sm:px-8">
          <div className="mx-auto flex w-full max-w-xl items-center gap-3">
            {phase === "running" ? (
              <button type="button" onClick={pause} className={`${btnPrimary} h-12 flex-1`}>
                <IconPause /> 暂停
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setPhase("running")}
                className={`${btnPrimary} h-12 flex-1`}
              >
                <IconPlay /> 继续
              </button>
            )}
            <button type="button" onClick={reset} className={`${btnGhost} h-12 px-5`}>
              重置
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 停顿步展示用：取其前一段注水的水温 */
function lastPourTemp(guide: ReturnType<typeof buildBrewGuide>, pauseIndex: number): number | null {
  for (let i = pauseIndex - 1; i >= 0; i--) {
    const s = guide.steps[i];
    if (s.kind === "pour") return s.temperature;
  }
  return null;
}

function GuideChip({ text, tone }: { text: string; tone?: "water" }) {
  return (
    <span
      className={`tnum inline-flex items-center rounded-full border px-3 py-1.5 text-[12px] ${
        tone === "water"
          ? "border-[color-mix(in_srgb,var(--curve-water)_36%,transparent)] bg-[color-mix(in_srgb,var(--curve-water)_10%,transparent)] text-[var(--curve-water)]"
          : "border-[var(--line)] bg-[var(--bg-inset)] text-[var(--tx-2)]"
      }`}
    >
      {text}
    </span>
  );
}

function IconPlay() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5.5v13a1 1 0 0 0 1.53.85l10.2-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
