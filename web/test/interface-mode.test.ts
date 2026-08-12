import assert from "node:assert/strict";
import { it } from "node:test";
import {
  isPhoneDevice,
  readInterfaceMode,
  resolveInterfaceMode,
} from "../src/lib/interface-mode.ts";

const desktop = {
  viewportWidth: 1440,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  coarsePointer: false,
  maxTouchPoints: 0,
};

it("自动模式按手机 UA 切换移动版", () => {
  assert.equal(
    isPhoneDevice({
      ...desktop,
      viewportWidth: 932,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148",
    }),
    true,
  );
});

it("窄窗口和触屏平板边界采用移动版", () => {
  assert.equal(isPhoneDevice({ ...desktop, viewportWidth: 640 }), true);
  assert.equal(
    isPhoneDevice({ ...desktop, viewportWidth: 860, coarsePointer: true, maxTouchPoints: 5 }),
    true,
  );
  assert.equal(isPhoneDevice(desktop), false);
});

it("手动选择优先于自动识别", () => {
  assert.equal(resolveInterfaceMode("mobile", desktop), "mobile");
  assert.equal(
    resolveInterfaceMode("desktop", { ...desktop, viewportWidth: 390, userAgent: "iPhone Mobile" }),
    "desktop",
  );
});

it("本地偏好只接受三种已知状态", () => {
  assert.equal(readInterfaceMode({ getItem: () => "desktop" }), "desktop");
  assert.equal(readInterfaceMode({ getItem: () => "unexpected" }), "auto");
});
