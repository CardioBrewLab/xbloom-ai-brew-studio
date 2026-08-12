import assert from "node:assert/strict";
import { it } from "node:test";
import {
  isMobileLoginSurface,
  normalizeXhsLoginLaunchUrl,
  xhsOfficialOpenUrl,
} from "../src/lib/xhs-mobile-login.ts";

const LOGIN_LINK =
  "xhsdiscover://rn/app-settings/login/scan?qrId=qr-1&ruleId=4&code=code-1&timestamp=1700000000";

it("识别常见手机系统与 iPadOS 桌面 UA", () => {
  assert.equal(
    isMobileLoginSurface({ userAgent: "Mozilla/5.0 (Linux; Android 15)", innerWidth: 412 }),
    true,
  );
  assert.equal(
    isMobileLoginSurface({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
      innerWidth: 1024,
      maxTouchPoints: 5,
    }),
    true,
  );
  assert.equal(
    isMobileLoginSurface({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", innerWidth: 1440 }),
    false,
  );
  assert.equal(
    isMobileLoginSurface({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", innerWidth: 390 }),
    false,
  );
});

it("只接受小红书扫码登录接口返回的 deeplink", () => {
  assert.equal(normalizeXhsLoginLaunchUrl(LOGIN_LINK), LOGIN_LINK);
  assert.equal(normalizeXhsLoginLaunchUrl("xhsdiscover://scan"), "");
  assert.equal(normalizeXhsLoginLaunchUrl("https://attacker.example/login"), "");
  assert.equal(
    normalizeXhsLoginLaunchUrl(
      "xhsdiscover://rn:443/app-settings/login/scan?qrId=qr-1&code=code-1&timestamp=1700000000",
    ),
    "",
  );
  assert.equal(
    normalizeXhsLoginLaunchUrl(
      "xhsdiscover://rn/app-settings/login/scan?qrId=qr-1&timestamp=1700000000",
    ),
    "",
  );
});

it("通过小红书官方 OIA 页面生成跨系统 App 入口", () => {
  const openUrl = new URL(xhsOfficialOpenUrl(LOGIN_LINK));
  assert.equal(openUrl.origin, "https://oia.xiaohongshu.com");
  assert.equal(openUrl.pathname, "/oia");
  assert.equal(openUrl.searchParams.get("deeplink"), LOGIN_LINK);
});
