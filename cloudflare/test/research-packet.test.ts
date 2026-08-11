import assert from "node:assert/strict";
import test from "node:test";
import { hostedResearchPacket } from "../src/index.ts";

test("Hosted 调研包只接纳有限的公开 HTTP(S) 来源并裁剪长文本", () => {
  const packet = hostedResearchPacket({
    ok: true,
    sources: [
      { title: "  xBloom reference  ", url: "https://example.com/a", snippet: "a".repeat(900) },
      { title: "local file", url: "file:///C:/private.txt" },
      { title: "script", url: "javascript:alert(1)" },
      ...Array.from({ length: 10 }, (_, index) => ({
        title: `source-${index}`,
        url: `https://example.org/${index}`,
      })),
    ],
    summaryText: "s".repeat(20_000),
    message: "m".repeat(900),
    filtered: 100_000,
    distilled: true,
    xhsLoginExpired: true,
  });

  assert.ok(packet);
  assert.equal(packet.ok, true);
  assert.equal(packet.sources.length, 6); // 前 8 项中，两项非法协议被剔除。
  assert.equal(packet.sources[0].title, "xBloom reference");
  assert.equal(packet.sources[0].snippet?.length, 600);
  assert.equal(packet.summaryText.length, 16_000);
  assert.equal(packet.message.length, 500);
  assert.equal(packet.filtered, 1_000);
  assert.equal(packet.distilled, true);
  assert.equal(packet.xhsLoginExpired, true);
});

test("空值与伪造成功状态按无有效调研处理", () => {
  assert.equal(hostedResearchPacket(null), null);
  const packet = hostedResearchPacket({ ok: true, sources: [], summaryText: "" });
  assert.ok(packet);
  assert.equal(packet.ok, false);
  assert.equal(packet.message, "本次未取得可用的公开资料");
});
