export type InterfaceMode = "auto" | "mobile" | "desktop";

export const INTERFACE_MODE_STORAGE_KEY = "xbloom-interface-mode";

export interface DeviceSignals {
  viewportWidth: number;
  userAgent: string;
  coarsePointer: boolean;
  maxTouchPoints: number;
}

const PHONE_USER_AGENT =
  /Android.*Mobile|iPhone|iPod|IEMobile|Windows Phone|BlackBerry|Opera Mini|Mobile Safari/i;

export function isPhoneDevice(signals: DeviceSignals): boolean {
  if (PHONE_USER_AGENT.test(signals.userAgent)) return true;
  if (signals.viewportWidth <= 720) return true;
  return signals.coarsePointer && signals.maxTouchPoints > 0 && signals.viewportWidth <= 900;
}

export function resolveInterfaceMode(
  mode: InterfaceMode,
  signals: DeviceSignals,
): "mobile" | "desktop" {
  return mode === "auto" ? (isPhoneDevice(signals) ? "mobile" : "desktop") : mode;
}

export function readInterfaceMode(storage: Pick<Storage, "getItem"> | null): InterfaceMode {
  try {
    const value = storage?.getItem(INTERFACE_MODE_STORAGE_KEY);
    return value === "mobile" || value === "desktop" ? value : "auto";
  } catch {
    return "auto";
  }
}
