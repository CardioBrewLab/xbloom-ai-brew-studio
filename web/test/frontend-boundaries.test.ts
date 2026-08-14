import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { clampRatioSliderValue, validC40Clicks } from "../src/components/BrewControls.tsx";
import { hasBaseUrlBoundaryChanged } from "../src/components/ApiSettingsModal.tsx";
import { createAbortScope } from "../src/lib/abort.ts";
import { normalizeSettingsBaseUrl } from "../src/lib/llm-settings.ts";
import { createRequestId } from "../src/lib/request-id.ts";

const source = (path: string) =>
  readFileSync(new URL(`../src/components/${path}`, import.meta.url), "utf8");

describe("前端边界修复", () => {
  it("C40 超范围输入明确拒绝，比例滑杆独立钳位", () => {
    assert.equal(validC40Clicks("41"), null);
    assert.equal(validC40Clicks("-1"), null);
    assert.equal(validC40Clicks("22.5"), null);
    assert.equal(validC40Clicks("22"), 22);
    assert.equal(clampRatioSliderValue(11.4), 12);
    assert.equal(clampRatioSliderValue(20.6), 20);
    assert.equal(clampRatioSliderValue(15.64), 15.6);
  });

  it("跨模型端点凭据边界时清空备用模型", () => {
    assert.equal(hasBaseUrlBoundaryChanged("https://a.example/v1", "https://b.example/v1"), true);
    assert.equal(hasBaseUrlBoundaryChanged("https://a.example/v1", "https://a.example/v2"), true);
    assert.equal(hasBaseUrlBoundaryChanged("https://a.example", "https://a.example/v1"), false);
    assert.equal(hasBaseUrlBoundaryChanged("https://a.example/v1", "invalid"), false);
  });

  it("公网模型地址强制 HTTPS，本机调试与旧 WebView 请求 ID 保持兼容", () => {
    assert.throws(() => normalizeSettingsBaseUrl("http://api.example.com/v1"), /HTTPS/);
    assert.equal(normalizeSettingsBaseUrl("http://127.0.0.1:8787/v1"), "http://127.0.0.1:8787/v1");
    assert.match(
      createRequestId(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("请求取消组合不依赖 AbortSignal.any/timeout", async () => {
    const parent = new AbortController();
    const scope = createAbortScope([parent.signal], 15);
    parent.abort("manual");
    assert.equal(scope.signal.aborted, true);
    assert.equal(scope.signal.reason, "manual");
    assert.equal(scope.timedOut(), false);
    scope.cleanup();

    const timeoutScope = createAbortScope([], 5);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(timeoutScope.signal.aborted, true);
    assert.equal(timeoutScope.timedOut(), true);
    timeoutScope.cleanup();
  });

  it("Modal 与流式区域保留无障碍和滚动契约", () => {
    const ui = source("ui.tsx");
    const stream = source("StreamPanel.tsx");
    assert.match(ui, /aria-labelledby=\{titleId\}/);
    assert.match(ui, /event\.key !== "Tab"/);
    assert.match(ui, /document\.body\.style\.overflow = "hidden"/);
    assert.match(ui, /previouslyFocused\.focus\(\)/);
    assert.match(stream, /aria-live="polite"/);
    assert.match(
      stream,
      /candidateDisplayCount\(candState\) > 1/,
      "单槽补发期间仍应保留完整候选卡",
    );
    assert.match(stream, /role="alert"/);
    assert.match(stream, /requestAnimationFrame/);
    assert.match(stream, /scrollHeight - el\.scrollTop - el\.clientHeight <= 48/);
    const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
    assert.match(api, /protocolError = true;\s+callbacks\.onError/);
  });

  it("移动端顶栏控件达到 44px 触控目标，供应商切换清空备用模型", () => {
    const header = source("AppHeader.tsx");
    const xhs = source("XhsAccount.tsx");
    const settings = source("ApiSettingsModal.tsx");
    assert.match(header, /className="flex h-11 w-11/);
    assert.match(header, /compact \? "h-11" : "h-8"/);
    assert.match(xhs, /compact \? "h-11 w-11/);
    assert.match(settings, /fallbackModel: ""/);
    assert.match(settings, /thirdModel: ""/);
  });

  it("desktop and mobile navigation expose the current page", () => {
    const header = source("AppHeader.tsx");
    assert.match(header, /aria-label="桌面端主导航"/);
    assert.equal((header.match(/aria-current=\{active \? "page" : undefined\}/g) ?? []).length, 2);
  });

  it("cloud region reaches preview APIs and pending writes reuse the update path", () => {
    const modal = source("PublishPreviewModal.tsx");
    const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    assert.match(modal, /cloudPublishPreview\(previewSrc, undefined, selectedCloudRegion\)/);
    assert.match(modal, /pendingPublishForAccount\(/);
    assert.match(modal, /activePendingCloudPublish \?\? recoveredPendingCloudPublish/);
    assert.match(modal, /onPendingPublished\?\.\(\{/);
    assert.doesNotMatch(app, /pendingCloudPublish\.recipeKey === JSON\.stringify\(recipe\)/);
    assert.equal((modal.match(/recipeKey: JSON\.stringify\(recipe\)/g) ?? []).length, 3);
    assert.equal((modal.match(/accountKey: currentCloudAccountKey/g) ?? []).length, 2);
    assert.doesNotMatch(modal, /recipeKey: JSON\.stringify\(draft\)/);
    assert.match(api, /cloudPublish:[\s\S]*clientRequestId\?: string/);
    assert.match(modal, /cloudPublish\(\s*checkpoint\.recipe,[\s\S]*checkpoint\.requestId/);
    assert.match(modal, /prepareCloudPublishRequest\(/);
    assert.match(modal, /markCloudPublishRequestCreated\(/);
    assert.equal((modal.match(/clearCloudPublishRequestCheckpoint\(/g) ?? []).length, 3);
    assert.match(
      modal,
      /\[cloud\?\.region, cloudRegionProp, currentCloudAccountKey, open, recipe\]/,
    );
    assert.match(app, /publishRequestId=\{cloudPublishRequestId\}/);
    const sourceCapture = app.indexOf("const publishedSourceRecipe = activeRecipeRef.current");
    const cloudBind = app.indexOf("await bindVerifiedCloudRecipe(tableId)", sourceCapture);
    assert.ok(sourceCapture > 0 && cloudBind > sourceCapture);
    assert.match(
      app.slice(cloudBind),
      /clearPersistentCloudPublishRequestId\(\s*publishedSourceRecipe/,
    );
    const generateStart = app.indexOf("const generate = useCallback");
    const recipeEvent = app.indexOf('case "recipe":', generateStart);
    const pendingClear = app.indexOf("setPendingCloudPublish(null)", generateStart);
    assert.ok(recipeEvent > generateStart && pendingClear > recipeEvent);
    assert.match(api, /cloudRecipes: \(region\?: CloudRegion\)/);
    const cloudPage = readFileSync(new URL("../src/pages/CloudPage.tsx", import.meta.url), "utf8");
    assert.match(cloudPage, /\[cloudAccountIdentity, loggedIn, refresh\]/);
    const publishPanel = source("PublishPanel.tsx");
    assert.match(publishPanel, /cloudLogin\(email\.trim\(\), password, cloudRegion\)/);
    assert.match(publishPanel, /aria-label="xBloom 账号区域"/);
    assert.match(app, /saveWarning=\{serverSaveWarning\}/);
  });

  it("冲煮结束态区分机器注水、旁路补水与最终总水量", () => {
    const guide = source("BrewGuide.tsx");
    assert.match(guide, /冲煮结束后加入/);
    assert.match(guide, /最终总水量/);
    assert.match(guide, /机器注水/);
  });
});
