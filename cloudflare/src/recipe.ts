export interface HostedPour {
  volume: number;
  temperature: number;
  flowRate: number;
  pattern: "center" | "circular" | "spiral";
  pausing: number;
  vibBefore: boolean;
  vibAfter: boolean;
  theName?: string;
}

export interface HostedRecipe {
  name: string;
  cupType: "xdripper" | "other";
  doseGrams: number;
  grinderSize: number;
  rpm: 60 | 70 | 80 | 90 | 100 | 110 | 120;
  grandWater: number;
  pours: HostedPour[];
  bypassEnabled: boolean;
  bypassVolume: number;
  bypassTemp: number;
  isSetGrinderSize: 1 | 2;
  theColor: string;
}

const rpms = [60, 70, 80, 90, 100, 110, 120] as const;
const patterns = new Set(["center", "circular", "spiral"]);
const number = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
const round1 = (value: number): number => Math.round(value * 10) / 10;

export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate.trim()) throw new Error("模型响应中没有配方 JSON");
  return JSON.parse(candidate);
}

export function normalizeRecipe(input: unknown, fallbackName = "AI Brew"): HostedRecipe {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("配方不是对象");
  const raw = input as Record<string, unknown>;
  const doseGrams = round1(clamp(number(raw.doseGrams, 15), 5, 18));
  const rawPours = Array.isArray(raw.pours) ? raw.pours.slice(0, 6) : [];
  if (rawPours.length === 0) throw new Error("配方缺少注水段");
  const pours = rawPours.map((item, index): HostedPour => {
    const pour = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const pattern =
      typeof pour.pattern === "string" && patterns.has(pour.pattern) ? pour.pattern : "center";
    return {
      volume: round1(clamp(number(pour.volume, index === 0 ? 45 : 95), 1, 300)),
      temperature: round1(clamp(number(pour.temperature, 92), 60, 95)),
      flowRate: round1(clamp(number(pour.flowRate, 3.2), 3, 3.5)),
      pattern: pattern as HostedPour["pattern"],
      pausing: round1(clamp(number(pour.pausing, index === 0 ? 35 : 5), 0, 255)),
      vibBefore: Boolean(pour.vibBefore),
      vibAfter: Boolean(pour.vibAfter),
      theName:
        typeof pour.theName === "string" && pour.theName.trim()
          ? pour.theName.trim().slice(0, 48)
          : index === 0
            ? "Bloom"
            : `Pour ${index + 1}`,
    };
  });
  const grandWater = round1(pours.reduce((sum, pour) => sum + pour.volume, 0));
  const requestedRpm = number(raw.rpm, 80);
  const rpm = rpms.reduce((best, value) =>
    Math.abs(value - requestedRpm) < Math.abs(best - requestedRpm) ? value : best,
  );
  const color =
    typeof raw.theColor === "string" && /^#[0-9a-f]{6}$/i.test(raw.theColor)
      ? raw.theColor
      : "#C9D5B8";
  return {
    name:
      typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : fallbackName,
    cupType: raw.cupType === "other" ? "other" : "xdripper",
    doseGrams,
    grinderSize: round1(clamp(number(raw.grinderSize, 72), 40, 120)),
    rpm,
    grandWater,
    pours,
    bypassEnabled: Boolean(raw.bypassEnabled),
    bypassVolume: Math.round(clamp(number(raw.bypassVolume, 5), 5, 100)),
    bypassTemp: round1(clamp(number(raw.bypassTemp, 85), 40, 95)),
    isSetGrinderSize: raw.isSetGrinderSize === 2 ? 2 : 1,
    theColor: color,
  };
}

export function scoreRecipe(recipe: HostedRecipe): number {
  let score = 100;
  const ratio = recipe.grandWater / recipe.doseGrams;
  if (ratio < 13 || ratio > 19) score -= 24;
  if (recipe.pours[0].pausing < 30) score -= 12;
  if (recipe.pours.length > 4) score -= 5;
  return Math.max(0, score);
}
