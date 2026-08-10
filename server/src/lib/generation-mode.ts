export type GenerationMode = "fast" | "pro" | "max";

export interface GenerationDefaults {
  candidateCount: number;
  maxResearchRounds: number;
}

export interface GenerationPlan {
  mode: GenerationMode | "legacy";
  research: boolean;
  candidateCount: number;
  maxResearchRounds: number;
}

function isGenerationMode(value: unknown): value is GenerationMode {
  return value === "fast" || value === "pro" || value === "max";
}

/**
 * 新客户端使用显式模式；旧客户端继续沿用 research + 环境配置契约。
 * 旧请求关闭调研时同步关闭重调研轮次，避免在同一上下文上重复生成。
 */
export function resolveGenerationPlan(
  mode: unknown,
  legacyResearch: unknown,
  defaults: GenerationDefaults,
): GenerationPlan {
  const candidateCount = Math.max(1, Math.trunc(defaults.candidateCount));
  const maxResearchRounds = Math.max(0, Math.trunc(defaults.maxResearchRounds));

  if (!isGenerationMode(mode)) {
    const research = legacyResearch !== false;
    return {
      mode: "legacy",
      research,
      candidateCount,
      maxResearchRounds: research ? maxResearchRounds : 0,
    };
  }

  if (mode === "fast") {
    return { mode, research: false, candidateCount: 1, maxResearchRounds: 0 };
  }
  if (mode === "pro") {
    return { mode, research: true, candidateCount: 1, maxResearchRounds: 0 };
  }
  // MAX 是产品层明确承诺的“三份优选”。环境变量只保留给 legacy 请求，
  // 避免界面显示 3 份而服务端实际生成 1/2/4/5 份。
  return { mode, research: true, candidateCount: 3, maxResearchRounds };
}
