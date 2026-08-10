export type GenerationMode = "fast" | "pro" | "max";

export interface GenerationModeOption {
  id: GenerationMode;
  eyebrow: "FAST" | "PRO" | "MAX";
  name: string;
  summary: string;
  detail: string;
}

export const GENERATION_MODES: readonly GenerationModeOption[] = [
  {
    id: "fast",
    eyebrow: "FAST",
    name: "快手出杯",
    summary: "不联网 · 1 份",
    detail: "直接用豆子信息和本地知识库，最快拿到一份可继续微调的起点。",
  },
  {
    id: "pro",
    eyebrow: "PRO",
    name: "稳妥手冲",
    summary: "联网 · 1 份",
    detail: "先查豆商、官网与公开冲煮资料，再整理成一份完整方案。",
  },
  {
    id: "max",
    eyebrow: "MAX",
    name: "细调风味",
    summary: "联网 · 3 份优选",
    detail: "并行比较三份方案；分数偏低时会换一批来源继续优选。",
  },
] as const;

export function isGenerationMode(value: unknown): value is GenerationMode {
  return value === "fast" || value === "pro" || value === "max";
}

export function generationModeOption(mode: GenerationMode): GenerationModeOption {
  return GENERATION_MODES.find((option) => option.id === mode) ?? GENERATION_MODES[2];
}
