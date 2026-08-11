/**
 * 优选明细卡（任务 #106；#120 重构；#121 维度加权明细）：多候选生成（N>1）「自动打分、多中选一」过程的可折叠展示。
 * - #120 主入口：`state`（CandidatesState）。N>1（total>1）时**始终**渲染——running 阶段
 *   逐候选实时展示 生成中/成功待评分/失败原因；picked 后逐候选展示 得分与关键扣分项 /
 *   否决项 / 失败原因，获胜行 accent 高亮「已采用」；仅 1 个成功时明示其余候选失败原因。
 * - #121：得分改为多维 rubric 加权（满分 100），头部/行文案为「得分 NN · 维度加权」；
 *   获胜行可展开逐维度明细（label + score/weight + note）；失败/否决行保持现状。
 * - 旧入口（App.tsx 传 detail/scores/winner）已被 StreamPanel 内的主入口取代，
 *   返回 null 避免同屏双卡；N=1 时两入口均不渲染，UI 逐字节不变。
 * 视觉遵循 Espresso Craft：eyebrow 标签、11px 下限、card-surface、accent 高亮获胜行。
 */
import { useState, type ReactNode } from "react";
import type { CandidateScoreDetail, CandidateScoreSummary } from "../lib/api.js";
import {
  candidateDimensionLines,
  candidateHasDistinctScoreTie,
  candidatePickHeadline,
  candidateRecipeSummaryLines,
  candidateRowScoreText,
  candidatesSoloWinNote,
  type CandidateResultEntry,
  type CandidatesState,
} from "../lib/candidates.js";
import { Spinner } from "./ui.js";

export interface CandidatePickCardProps {
  /** #120 主入口：完整状态机（StreamPanel 渲染，N>1 始终出卡） */
  state?: CandidatesState;
  /** 旧入口（任务 #106 App.tsx）：已被主入口取代，仅保留签名兼容 */
  detail?: CandidateScoreDetail;
  scores?: CandidateScoreSummary[];
  winner?: number;
}

export default function CandidatePickCard({ state }: CandidatePickCardProps) {
  const [open, setOpen] = useState(true);
  /** 任务 #121：获胜行逐维度明细展开开关 */
  const [dimsOpen, setDimsOpen] = useState(false);
  // 旧入口（detail/scores/winner）让位于 StreamPanel 主入口，避免同屏双卡
  if (!state || state.total <= 1) return null;

  const running = state.phase === "running";
  const winnerIndex = state.winner ?? state.detail?.winner;
  const winnerVetoed =
    state.detail?.vetoed ?? state.results.find((r) => r.index === winnerIndex)?.vetoed ?? false;
  const headline = state.detail
    ? candidatePickHeadline(state.detail)
    : running
      ? `正在生成并评分 ${state.total} 份方案…(${state.done}/${state.total})`
      : winnerIndex !== undefined
        ? `已采用候选 ${winnerIndex + 1}`
        : "择优中…";
  const soloNote = candidatesSoloWinNote(state);

  return (
    <div className="animate-fade-up overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-inset)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--bg-card)_55%,transparent)]"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            className={
              running
                ? "shrink-0"
                : winnerVetoed
                  ? "shrink-0 text-[var(--warn)]"
                  : "shrink-0 text-[var(--ok)]"
            }
            aria-hidden
          >
            {running ? <Spinner className="text-[var(--acc)]" /> : winnerVetoed ? "⚠" : "◆"}
          </span>
          <span className="min-w-0">
            <span className="eyebrow block">Candidate Selection</span>
            <span className="block truncate text-xs font-medium text-[var(--tx-1)]">
              优选明细｜{headline}
            </span>
          </span>
        </span>
        <span
          className={`ml-2 shrink-0 text-[10px] text-[var(--tx-3)] transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          ▼
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--line)] px-4 pb-3">
          <ul>
            {Array.from({ length: state.total }, (_, i) => {
              const entry = state.results.find((r) => r.index === i);
              const isWinner = state.phase === "picked" && i === winnerIndex;
              const hasDistinctScoreTie = candidateHasDistinctScoreTie(entry, state.results);
              return (
                <CandidateRow
                  key={i}
                  index={i}
                  entry={entry}
                  phase={state.phase}
                  isWinner={isWinner}
                  hasDistinctScoreTie={hasDistinctScoreTie}
                  dimsOpen={dimsOpen}
                  onToggleDims={() => setDimsOpen((v) => !v)}
                />
              );
            })}
          </ul>
          {soloNote && (
            <p className="mt-2 border-t border-[var(--line)] pt-2 text-[11px] leading-relaxed text-[var(--warn)]">
              ⚠ {soloNote}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 逐候选行（任务 #120）
// ---------------------------------------------------------------------------

function CandidateRow({
  index,
  entry,
  phase,
  isWinner,
  hasDistinctScoreTie,
  dimsOpen,
  onToggleDims,
}: {
  index: number;
  entry?: CandidateResultEntry;
  phase: CandidatesState["phase"];
  isWinner: boolean;
  hasDistinctScoreTie: boolean;
  /** 任务 #121：获胜行维度明细展开态 */
  dimsOpen: boolean;
  onToggleDims: () => void;
}) {
  const picked = phase === "picked";

  // 状态判定：picked 以 results 全量为准；running 时未到达的候选 = 生成中
  let marker: ReactNode;
  let badge: { text: string; cls: string } | null = null;
  let detailText = "";

  if (!picked && !entry) {
    marker = (
      <span className="animate-blink text-[var(--acc)]" aria-hidden>
        ●
      </span>
    );
    detailText = "生成中…";
  } else if (entry?.status === "failed") {
    marker = (
      <span className="text-[var(--bad)]" aria-hidden>
        ✕
      </span>
    );
    badge = {
      text: "失败",
      cls: "border-[color-mix(in_srgb,var(--bad)_45%,transparent)] text-[var(--bad)]",
    };
    detailText = entry.failReason ?? "生成失败";
  } else if (entry?.status === "ok" && picked && entry.vetoed) {
    marker = (
      <span className="text-[var(--warn)]" aria-hidden>
        ⚠
      </span>
    );
    badge = {
      text: "一票否决",
      cls: "border-[color-mix(in_srgb,var(--warn)_45%,transparent)] text-[var(--warn)]",
    };
    detailText =
      entry.vetoReasons && entry.vetoReasons.length > 0
        ? entry.vetoReasons.slice(0, 2).join("；")
        : "触发一票否决";
  } else if (entry?.status === "ok" && picked) {
    marker = isWinner ? (
      <span className="text-[var(--acc)]" aria-hidden>
        ✓
      </span>
    ) : (
      <span className="text-[var(--tx-3)]" aria-hidden>
        ○
      </span>
    );
    // 任务 #121：维度加权语义；旧形态（无 dimensions）由 candidateRowScoreText 回退警告/修正文案
    detailText = candidateRowScoreText(entry);
    if (hasDistinctScoreTie) detailText += " · 同分但参数不同";
    if (entry.deductions && entry.deductions.length > 0) {
      detailText += `（${entry.deductions.slice(0, 2).join("；")}）`;
    }
  } else {
    // running 且已返回成功：待评分
    marker = (
      <span className="text-[var(--ok)]" aria-hidden>
        ✓
      </span>
    );
    detailText = "生成成功，等待评分";
  }

  if (isWinner)
    badge = {
      text: "已采用",
      cls: "border-[var(--acc-line)] bg-[var(--acc-soft)] text-[var(--acc)]",
    };

  // 任务 #121：获胜行逐维度明细（label + score/weight + note）；失败/否决行不可展开
  const dims = isWinner && picked ? candidateDimensionLines(entry) : [];
  const recipeLines = picked && entry?.status === "ok" ? candidateRecipeSummaryLines(entry) : [];

  return (
    <li
      className={`-mx-2 flex items-start gap-2 rounded-lg px-2 py-2 text-[11px] leading-relaxed ${
        isWinner ? "bg-[var(--acc-soft)] shadow-[inset_2px_0_0_var(--acc)]" : ""
      }`}
    >
      <span className="mt-px w-3 shrink-0 text-center">{marker}</span>
      <span className="min-w-0 flex-1">
        <span
          className={`flex items-center gap-1.5 ${isWinner ? "font-medium text-[var(--tx-1)]" : "text-[var(--tx-2)]"}`}
        >
          <span className="tnum shrink-0">候选 {index + 1}</span>
          {badge && (
            <span
              className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] leading-4 ${badge.cls}`}
            >
              {badge.text}
            </span>
          )}
        </span>
        <span
          className={`mt-0.5 block ${entry?.status === "failed" ? "text-[var(--bad)]" : "text-[var(--tx-3)]"}`}
        >
          {detailText}
        </span>
        {recipeLines.length > 0 && (
          <span className="mt-1 block rounded-md border border-[var(--line)] bg-[color-mix(in_srgb,var(--bg-card)_55%,transparent)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--tx-2)]">
            <span className="tnum block">{recipeLines[0]}</span>
            <span className="tnum mt-0.5 block text-[var(--tx-3)]">{recipeLines[1]}</span>
          </span>
        )}
        {dims.length > 0 && (
          <span className="mt-1 block">
            <button
              type="button"
              onClick={onToggleDims}
              aria-expanded={dimsOpen}
              className="text-[11px] text-[var(--acc)] transition-colors duration-150 hover:text-[var(--tx-1)]"
            >
              {dimsOpen ? "▴ 收起维度明细" : "▾ 逐维度明细"}
            </button>
            {dimsOpen && (
              <ul className="mt-1 space-y-1 border-l border-[color-mix(in_srgb,var(--acc)_35%,transparent)] pl-2">
                {dims.map((d) => (
                  <li key={d.key} className="text-[11px] leading-relaxed">
                    <span className="text-[var(--tx-2)]">{d.label}</span>{" "}
                    <span className="tnum font-medium text-[var(--acc)]">
                      {d.score}/{d.weight}
                    </span>
                    <span className="block text-[var(--tx-3)]">{d.note}</span>
                  </li>
                ))}
              </ul>
            )}
          </span>
        )}
      </span>
      {picked && entry?.status === "ok" && typeof entry.score === "number" && (
        <span
          className={`tnum shrink-0 ${isWinner ? "font-semibold text-[var(--acc)]" : "text-[var(--tx-3)]"}`}
        >
          {entry.score}
        </span>
      )}
    </li>
  );
}
