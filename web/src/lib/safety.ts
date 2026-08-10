/** Browser-compatible safety entry point backed by the shared workspace. */
export {
  DURATION_WARN_SECONDS,
  clampRecipe,
  durationWarning,
  estimateTotalSeconds,
  validateBaseForTarget as validateForTarget,
} from "@xbloom/shared/safety";
export type { BrewTarget, ClampResult } from "@xbloom/shared/safety";
