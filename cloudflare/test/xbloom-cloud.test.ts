import assert from "node:assert/strict";
import { it } from "node:test";
import { handleXbloomRoute, parseStoredXbloomSession } from "../src/xbloom-cloud.ts";

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
