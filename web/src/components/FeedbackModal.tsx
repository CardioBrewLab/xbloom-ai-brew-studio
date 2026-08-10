/**
 * 冲煮日志反馈弹窗：
 * - 打开时回显该配方已有的反馈日志列表（时间 + 评分 + 标签 + 备注，含追溯徽标）
 * - 星级（1–5）+ 口味标签（五味型 + 香气/风味/甜感三枚风味维度）+ 备注
 * - 保存反馈（POST /api/recipes/:id/feedback → { feedbackId }）
 * - "AI 按反馈调参" → 以 baseRecipe + feedback + feedbackId 调 generate，驱动版本链迭代
 */
import { useEffect, useState } from "react";
import { api, TASTE_TAGS, type BrewFeedback, type SavedFeedback } from "../lib/api.js";
import type { Recipe } from "../lib/recipe-schema.js";
import { btnGhost, btnPrimary, Field, inputCls, Modal, Spinner } from "./ui.js";

export interface FeedbackModalProps {
  open: boolean;
  onClose: () => void;
  /** 本地配方库 ID（可为空：云端/对比来源） */
  recipeId?: string;
  recipe: Recipe | null;
  /** 该配方已有的反馈日志（外层传入，保存后由外层刷新） */
  feedbacks?: SavedFeedback[];
  /** 反馈保存成功后回调（外层刷新历史列表） */
  onSaved?: () => void;
  /** AI 按反馈调参：外层切换工作台并发起 generate（feedbackId 用于版本链追溯） */
  onRegenerate: (feedback: BrewFeedback, feedbackId?: string) => void;
}

export default function FeedbackModal({
  open,
  onClose,
  recipeId,
  recipe,
  feedbacks = [],
  onSaved,
  onRegenerate,
}: FeedbackModalProps) {
  const [rating, setRating] = useState(4);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // 每次打开（或切换配方）时重置表单，避免上一条记录残留
  useEffect(() => {
    if (open) {
      setRating(4);
      setTags([]);
      setNote("");
      setError("");
      setSaved(false);
      setSaving(false);
    }
  }, [open, recipeId]);

  if (!recipe) return null;

  const toggleTag = (t: string) =>
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const feedback = (): BrewFeedback => ({
    rating,
    taste: tags,
    note: note.trim() || undefined,
  });

  const saveOnly = async () => {
    setSaving(true);
    setError("");
    try {
      if (recipeId) await api.postFeedback(recipeId, feedback());
      onSaved?.();
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        onClose();
      }, 900);
    } catch (e) {
      setError(`${(e as Error).message}（反馈已在本页保留，可直接用"AI 调参"）`);
    } finally {
      setSaving(false);
    }
  };

  const regen = async () => {
    setSaving(true);
    setError("");
    try {
      // 先落盘拿到 feedbackId，作为本轮迭代的追溯锚点；失败时不阻断调参
      const res = recipeId
        ? await api.postFeedback(recipeId, feedback()).catch(() => undefined)
        : undefined;
      onSaved?.();
      onRegenerate(feedback(), res?.feedbackId);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const history = [...feedbacks].reverse(); // 最新在前

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="冲煮日志"
      sub={`记录「${recipe.name}」这一杯的实际表现`}
    >
      <div className="space-y-4">
        {/* 已有反馈日志回显 */}
        {history.length > 0 && (
          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--tx-3)]">
              历史反馈（{history.length} 条）
            </p>
            <ul className="max-h-32 space-y-1.5 overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] p-2.5">
              {history.map((fb, i) => (
                <li key={fb.id ?? i} className="text-[11px] leading-relaxed text-[var(--tx-2)]">
                  <span className="tnum text-[var(--tx-3)]">
                    {new Date(fb.createdAt).toLocaleString("zh-CN", { hour12: false })}
                  </span>
                  <span className="ml-1.5 text-[var(--acc)]">{"★".repeat(fb.rating)}</span>
                  <span className="ml-1.5">
                    {fb.taste.map((t) => (
                      <span
                        key={t}
                        className="mr-1 inline-block rounded-full border border-[var(--line-strong)] px-1.5 py-px text-[10px] text-[var(--tx-2)]"
                      >
                        {t}
                      </span>
                    ))}
                  </span>
                  {fb.note && <span className="ml-1 text-[var(--tx-3)]">「{fb.note}」</span>}
                  {fb.resultingRecipeId && (
                    <span className="ml-1.5 rounded-full bg-[var(--acc-soft)] px-1.5 py-px text-[10px] text-[var(--acc)]">
                      → 已生成新版
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 星级 */}
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--tx-3)]">
            整体评分
          </p>
          <div className="flex items-center gap-1.5">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`${n} 星`}
                onClick={() => setRating(n)}
                className={`text-2xl transition-transform hover:scale-110 ${
                  n <= rating ? "text-[var(--acc)]" : "text-[var(--tx-3)] opacity-40"
                }`}
              >
                ★
              </button>
            ))}
            <span className="tnum ml-2 text-sm text-[var(--tx-2)]">{rating}/5</span>
          </div>
        </div>

        {/* 口味标签：五味型 + 风味维度 */}
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--tx-3)]">
            口味表现（可多选）
          </p>
          <div className="flex flex-wrap gap-2">
            {TASTE_TAGS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => toggleTag(t)}
                className={`rounded-full border px-3 py-1 text-xs transition-all active:scale-95 ${
                  tags.includes(t)
                    ? "border-[var(--acc-line)] bg-[var(--acc-soft)] text-[var(--acc)]"
                    : "border-[var(--line-strong)] text-[var(--tx-2)] hover:border-[var(--acc-line)]"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <Field label="备注" hint="可选">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="例如：前段酸质明亮但尾韵偏短，下次想更甜感…"
            className={`${inputCls} resize-none`}
          />
        </Field>

        {error && <p className="text-[11px] text-[var(--bad)]">⚠ {error}</p>}

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => void regen()}
            disabled={saving || tags.length === 0}
            className={`${btnPrimary} flex-1`}
            title={tags.length === 0 ? "至少选择一个口味标签" : undefined}
          >
            {saving ? <Spinner /> : "✦"} AI 按反馈调参重新生成
          </button>
          <button
            type="button"
            onClick={() => void saveOnly()}
            disabled={saving}
            className={btnGhost}
          >
            {saved ? "✓ 已保存" : "仅保存日志"}
          </button>
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--tx-3)]">
          "AI 调参"将把当前配方作为
          baseRecipe、连同评分与口味标签一起提交，在原方案基础上生成针对性微调的新版本（自动保存并记入迭代链）。
        </p>
      </div>
    </Modal>
  );
}
