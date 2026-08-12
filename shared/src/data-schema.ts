/**
 * 用户持久化数据的跨运行时契约。
 *
 * 本地 Express 与 Hosted Worker 必须复用同一组 schema，避免同一份豆档案、
 * 冲煮反馈在两个部署形态下出现不同的校验结果。
 */
import { z } from "zod";

export const TASTE_TAGS = [
  "偏酸",
  "偏苦",
  "偏弱",
  "过强",
  "平衡",
  "香气不足",
  "风味不突出",
  "甜感不足",
] as const;

/** 单个配方保留有限条结构化反馈，避免 JSON 记录长期无界增长。 */
export const MAX_FEEDBACKS_PER_RECIPE = 50;

export const FeedbackInputSchema = z.object({
  rating: z.number().int().min(1).max(5),
  taste: z
    .array(z.enum(TASTE_TAGS))
    .min(1)
    .max(TASTE_TAGS.length)
    .refine((values) => new Set(values).size === values.length, "口味标签请勿重复"),
  note: z.string().max(2_000).optional(),
});

export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;

/** 严格按 YYYY-MM-DD 验证，排除 2026-02-30 一类 Date 自动进位值。 */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const optionalText = z.string().max(4_000).optional();
const roastDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "roastDate 格式应为 YYYY-MM-DD")
  .refine(isCalendarDate, "roastDate 不是真实存在的日历日期");

export const BeanInputSchema = z.object({
  name: z.string().min(1, "name 不能为空").max(200),
  roaster: optionalText,
  origin: optionalText,
  process: optionalText,
  varietal: optionalText,
  roastLevel: optionalText,
  tastingNotes: optionalText,
  rawDescription: z.string().max(12_000).optional(),
  stockGrams: z.number().min(0, "stockGrams 不能为负").optional(),
  roastDate: roastDateSchema.optional(),
  restDays: z.number().min(0, "restDays 不能为负").optional(),
  peakWindowDays: z.number().min(1, "peakWindowDays 至少为 1").optional(),
});

export const BeanPatchSchema = BeanInputSchema.partial().extend({
  roastDate: roastDateSchema.nullable().optional(),
  stockGrams: BeanInputSchema.shape.stockGrams.nullable().optional(),
  restDays: BeanInputSchema.shape.restDays.nullable().optional(),
  peakWindowDays: BeanInputSchema.shape.peakWindowDays.nullable().optional(),
});

export type BeanInput = z.infer<typeof BeanInputSchema>;
