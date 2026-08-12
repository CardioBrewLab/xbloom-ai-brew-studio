const XHS_LOGIN_SCHEME = "xhsdiscover:";
const XHS_LOGIN_HOST = "rn";
const XHS_LOGIN_PATH = "/app-settings/login/scan";
const XHS_OFFICIAL_OPEN_ENDPOINT = "https://oia.xiaohongshu.com/oia";

export interface MobileSurfaceInput {
  userAgent: string;
  innerWidth: number;
  maxTouchPoints?: number;
}

/** 覆盖 Android、iPhone/iPad、鸿蒙兼容浏览器与 iPadOS 桌面 UA。 */
export function isMobileLoginSurface(input: MobileSurfaceInput): boolean {
  const ua = input.userAgent;
  const explicitMobile = /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(ua);
  const ipadDesktopUa = /Macintosh/i.test(ua) && (input.maxTouchPoints ?? 0) > 1;
  return explicitMobile || ipadDesktopUa;
}

export function normalizeXhsLoginLaunchUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096) return "";
  const candidate = value.trim();
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== XHS_LOGIN_SCHEME ||
      parsed.hostname !== XHS_LOGIN_HOST ||
      parsed.pathname !== XHS_LOGIN_PATH ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash
    ) {
      return "";
    }
    if (
      !parsed.searchParams.get("qrId") ||
      !parsed.searchParams.get("code") ||
      !parsed.searchParams.get("timestamp")
    ) {
      return "";
    }
    return candidate;
  } catch {
    return "";
  }
}

/** 小红书官方 OIA 页面统一处理 iOS Universal Link、Android App Link 与安装回退。 */
export function xhsOfficialOpenUrl(launchUrl: unknown): string {
  const normalized = normalizeXhsLoginLaunchUrl(launchUrl);
  if (!normalized) return "";
  const url = new URL(XHS_OFFICIAL_OPEN_ENDPOINT);
  url.searchParams.set("deeplink", normalized);
  return url.toString();
}
