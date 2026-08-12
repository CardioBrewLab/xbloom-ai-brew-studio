import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { api } from "../src/lib/api.js";
import type { Recipe } from "../src/lib/recipe-schema.js";

const recipe: Recipe = {
  name: "区域回归",
  cupType: "xdripper",
  doseGrams: 15,
  grinderSize: 60,
  rpm: 80,
  grandWater: 225,
  pours: [],
  bypassEnabled: false,
  bypassVolume: 0,
  bypassTemp: 85,
  isSetGrinderSize: 1,
  theColor: "#111111",
};

describe("cloud region propagation", () => {
  it("keeps the selected region on cloud writes and reads", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      requests.push({ url, body });
      const payload = url.includes("publish-preview")
        ? {
            ok: true,
            adjustments: [],
            alignedGrandWater: 225,
            cloudRatio: 15,
            pours: [],
          }
        : url.includes("/recipes?")
          ? { ok: true, recipes: [] }
          : {
              ok: true,
              shareUrl: "https://share.example/1",
              tableId: "1",
              verification: { state: "verified", message: "ok" },
            };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await api.cloudPublish(recipe, undefined, "global");
      await api.cloudPublishPreview(recipe, undefined, "global");
      await api.cloudRecipes("global");
      await api.cloudUpdateRecipe("1", { recipe }, "cn");
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests[0].body.region, "global");
    assert.equal(requests[1].body.region, "global");
    assert.match(requests[2].url, /\/api\/cloud\/recipes\?region=global$/);
    assert.equal(requests[3].body.region, "cn");
  });
});
