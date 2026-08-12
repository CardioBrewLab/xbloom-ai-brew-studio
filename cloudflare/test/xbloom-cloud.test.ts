import assert from "node:assert/strict";
import { it } from "node:test";
import {
  cloudReadbackCompletenessErrors,
  handleXbloomRoute,
  normalizeXbloomWriteRequestId,
  newestCloudRecipeId,
  paginateRecipePages,
  parseRecipeVo,
  parseStoredXbloomSession,
  shareUrl,
  verifyCloudRecipeReadback,
  xbloomWriteAccountScope,
} from "../src/xbloom-cloud.ts";

const user = { id: "user-1", loginName: "audit", displayName: "Audit" };
const validRecipe = {
  name: "Boundary Brew",
  cupType: "xdripper",
  doseGrams: 15,
  grinderSize: 70,
  rpm: 80,
  grandWater: 225,
  pours: [
    {
      volume: 225,
      temperature: 93,
      flowRate: 3.2,
      pattern: "center",
      pausing: 0,
      vibBefore: false,
      vibAfter: false,
    },
  ],
  bypassEnabled: false,
  bypassVolume: 5,
  bypassTemp: 85,
  isSetGrinderSize: 1,
  theColor: "#C9D5B8",
};

it("Hosted xBloom 幂等记录按区域与 App 账号共同隔离", () => {
  assert.equal(xbloomWriteAccountScope("cn", 42), "cn:42");
  assert.notEqual(xbloomWriteAccountScope("cn", 42), xbloomWriteAccountScope("global", 42));
  assert.notEqual(xbloomWriteAccountScope("cn", 42), xbloomWriteAccountScope("cn", 43));
});

it("Hosted 恢复遇到多个相同新记录时选定一个而非再次创建", () => {
  assert.equal(newestCloudRecipeId([]), null);
  assert.equal(newestCloudRecipeId([{ tableId: 51 }, { tableId: 53 }, { tableId: 52 }]), 53);
});

it("Hosted xBloom 写入仅接受规范 UUID 幂等号", () => {
  assert.equal(
    normalizeXbloomWriteRequestId("550E8400-E29B-41D4-A716-446655440000"),
    "550e8400-e29b-41d4-a716-446655440000",
  );
  assert.equal(normalizeXbloomWriteRequestId("same-request"), null);
  assert.equal(normalizeXbloomWriteRequestId(undefined), null);
});

it("旧会话载荷迁移时剔除第三方密码", () => {
  const result = parseStoredXbloomSession({
    region: "cn",
    email: "user@example.com",
    password: "legacy-secret",
    session: { memberId: 1, token: "session-token", email: "user@example.com" },
  });
  assert.equal(result.containedLegacyPassword, true);
  assert.equal("password" in result.stored, false);
  assert.equal(result.stored.session.token, "session-token");
});

it("Hosted 发布预演拒绝超出 xBloom 云端范围的参数", async () => {
  const responsePromise = handleXbloomRoute(
    new Request("https://brew.example/api/cloud/publish-preview", {
      method: "POST",
      body: JSON.stringify({
        recipe: {
          ...validRecipe,
          pours: [{ ...validRecipe.pours[0], temperature: 120 }],
        },
      }),
    }),
    { DB: {} as D1Database, APP_DATA_ENCRYPTION_KEY: "test-secret" },
    user,
  );
  await assert.rejects(responsePromise, /配方超出 xBloom 云端范围.*temperature/);
});

it("Hosted 发布预演保留合法配方的对齐结果", async () => {
  const response = await handleXbloomRoute(
    new Request("https://brew.example/api/cloud/publish-preview", {
      method: "POST",
      body: JSON.stringify({ recipe: validRecipe }),
    }),
    { DB: {} as D1Database, APP_DATA_ENCRYPTION_KEY: "test-secret" },
    user,
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { ok: boolean; alignedGrandWater: number };
  assert.equal(payload.ok, true);
  assert.equal(payload.alignedGrandWater, 225);
});

it("Hosted 列表分页有上限并按 tableId 去重", async () => {
  const requestedPages: number[] = [];
  const rows = await paginateRecipePages(
    async (pageNumber, countPerPage) => {
      requestedPages.push(pageNumber);
      assert.equal(countPerPage, 2);
      const pages: Record<string, unknown>[][] = [
        [{ tableId: 1 }, { tableId: 2 }],
        [{ tableId: 2 }, { tableId: 3 }],
        [{ tableId: 4 }],
      ];
      return pages[pageNumber - 1] ?? [];
    },
    { countPerPage: 2, maxPages: 5 },
  );
  assert.deepEqual(
    rows.map((row) => row.tableId),
    [1, 2, 3, 4],
  );
  assert.deepEqual(requestedPages, [1, 2, 3]);
});

it("Hosted 中国区缺少官方分享链接时返回空值", () => {
  assert.equal(shareUrl("cn", { tableId: 42 }), "");
  assert.equal(
    shareUrl("cn", { tableId: 42, shareRecipeLink: "https://share.example/official" }),
    "https://share.example/official",
  );
  assert.equal(shareUrl("global", { tableId: 42 }), "https://share-h5.xbloom.com/?id=NDI%3D");
});

it("Hosted 解析器使用 Bloom / Pour 2 段名规则", () => {
  const recipe = parseRecipeVo({
    dose: 15,
    grandWater: 15.6,
    grinderSize: 70,
    rpm: 80,
    cupType: 2,
    pourList: [
      { volume: 100, temperature: 93, flowRate: 3.2, pattern: 1, pausing: 30 },
      { volume: 134, temperature: 92, flowRate: 3.2, pattern: 3, pausing: 0 },
    ],
  });
  assert.deepEqual(
    recipe.pours.map((pour) => pour.theName),
    ["Bloom", "Pour 2"],
  );
});

it("Hosted 写入回读逐字段比较 payload，缺字段不标记 verified", () => {
  const payload = {
    theName: "Boundary Brew",
    dose: 15,
    grandWater: 15.6,
    grinderSize: 70,
    rpm: 80,
    cupType: 2,
    isEnableBypassWater: 2,
    isSetGrinderSize: 1,
    theColor: "#C9D5B8",
    bypassTemp: 85,
    bypassVolume: 5,
    pourDataJSONStr: JSON.stringify([
      {
        theName: "Bloom",
        volume: 100,
        temperature: 93,
        flowRate: 3.2,
        pattern: 1,
        pausing: 30,
        isEnableVibrationBefore: 2,
        isEnableVibrationAfter: 2,
      },
      {
        theName: "Pour 2",
        volume: 134,
        temperature: 92,
        flowRate: 3.2,
        pattern: 3,
        pausing: 0,
        isEnableVibrationBefore: 2,
        isEnableVibrationAfter: 2,
      },
    ]),
  };
  const row = { ...payload, pourList: payload.pourDataJSONStr, tableId: 42 };
  assert.deepEqual(cloudReadbackCompletenessErrors(row), []);
  assert.deepEqual(verifyCloudRecipeReadback(row, payload), {
    ok: true,
    complete: true,
    message: "云端回读与上传 payload 全字段一致",
  });
  const mismatch = {
    ...row,
    pourList: JSON.stringify([
      ...JSON.parse(payload.pourDataJSONStr),
      // Keep the row length stable while changing an executable field.
    ]).replace('"volume":100', '"volume":101'),
  };
  assert.equal(verifyCloudRecipeReadback(mismatch, payload).complete, true);
  assert.equal(verifyCloudRecipeReadback(mismatch, payload).ok, false);
  const incomplete = { ...row, rpm: undefined };
  assert.equal(verifyCloudRecipeReadback(incomplete, payload).complete, false);
});
