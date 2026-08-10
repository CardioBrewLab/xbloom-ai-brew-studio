/**
 * 任务 #118（契约来源 #113/#116）：N>1 content 补发事件集成测试 —— 独立运行。
 *
 * 前置：本地 server 已启动（start-xbloom.bat / npm run dev:server），
 *       且根 .env 的 GENERATE_CANDIDATES > 1（当前为 3）。
 * 用法：node web/test/t116-content-contract.test.mjs
 *       可用环境变量 XBLOOM_BASE 覆盖服务地址（默认 http://127.0.0.1:$PORT，PORT 缺省 8787）。
 *
 * 断言（与 server/test/generate-candidates.test.ts 的服务端契约对齐）：
 *  1. recipe 事件之前恰好补发一条非 improved 的 content 事件，载荷在 `content` 字段（非 delta）；
 *  2. recipe 事件携带 candidateScore（N>1 路径）；
 *  3. recipe 事件之后绝不再出现 candidates 事件；
 *  4. 流正常以 done 收尾。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---- 读取仓库根 .env（不依赖 dotenv 包）：PORT / GENERATE_CANDIDATES 等 ----
const ROOT = path.resolve(import.meta.dirname, "..", "..");
try {
  const envText = readFileSync(path.join(ROOT, ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {
  /* 无 .env 时按缺省值继续 */
}

const BASE = process.env.XBLOOM_BASE || `http://127.0.0.1:${process.env.PORT || "8787"}`;
const TIMEOUT_MS = 6 * 60 * 1000; // N=3 并行 LLM 生成可能耗时数分钟

/** 解析 SSE 文本块流为事件对象数组（data: JSON 行） */
function parseSse(text) {
  const events = [];
  for (const block of text.split(/\n\n+/)) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        events.push(JSON.parse(payload));
      } catch {
        /* 非法 JSON 行不吞错，交由后续断言暴露 */
        events.push({ type: "__unparsed__", raw: payload });
      }
    }
  }
  return events;
}

async function main() {
  // ---- 前置探活：server 未启动时给出明确指引而非静默失败 ----
  try {
    const cfg = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(5000) });
    assert.ok(cfg.ok, `/api/config 返回 ${cfg.status}`);
  } catch (e) {
    console.error(
      `[t116-contract] FAIL：后端不可达（${BASE}）—— 请先启动 server（start-xbloom.bat 或 npm run dev:server）后重跑。`,
    );
    console.error(`  原因：${e.message}`);
    process.exit(2);
  }

  console.log(
    `[t116-contract] 后端就绪：${BASE}（GENERATE_CANDIDATES=${process.env.GENERATE_CANDIDATES ?? "未设置(缺省3)"}）`,
  );
  console.log("[t116-contract] 发起 N>1 生成请求（真实 LLM 流，可能耗时数分钟）…");

  const res = await fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: "一杯简单快测的浅烘手冲：明亮酸质、花香，参数保守即可。",
      cupType: "xdripper",
      research: false, // 跳过联网调研，缩短链路
      candidateScore: 2, // 契约标记：期望走多候选路径（服务端实际 N 由 GENERATE_CANDIDATES 决定）
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  assert.ok(res.ok, `/api/generate 返回 ${res.status}`);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/, "响应应为 SSE 流");

  const events = parseSse(await res.text());
  assert.ok(events.length > 0, "SSE 流为空");

  const unparsed = events.filter((e) => e.type === "__unparsed__");
  assert.equal(unparsed.length, 0, `存在非法 JSON 事件行：${unparsed[0]?.raw}`);

  const recipeIdx = events.findIndex((e) => e.type === "recipe");
  assert.ok(recipeIdx >= 0, "未收到 recipe 事件");
  const recipe = events[recipeIdx];

  // ---- 断言 2：recipe 携带 candidateScore（确认实际走了 N>1 路径） ----
  assert.ok(
    recipe.candidateScore,
    "recipe 事件未携带 candidateScore —— 服务端可能运行在 N=1（检查 .env GENERATE_CANDIDATES）",
  );
  assert.ok(recipe.candidateScore.n >= 2, `candidateScore.n=${recipe.candidateScore.n}，期望 ≥2`);
  console.log(
    `[t116-contract] ✓ recipe 携带 candidateScore：${recipe.candidateScore.n} 选 1，得分 ${recipe.candidateScore.score}`,
  );

  // ---- 断言 1：recipe 之前恰好一条非 improved 的 content 补发事件，载荷在 content 字段 ----
  const contentEvents = events
    .slice(0, recipeIdx)
    .filter((e) => e.type === "content" && e.variant !== "improved");
  assert.equal(
    contentEvents.length,
    1,
    `recipe 前 content 事件数为 ${contentEvents.length}，期望恰好 1`,
  );
  const ce = contentEvents[0];
  assert.equal(
    typeof ce.content,
    "string",
    "补发 content 事件的载荷应在 content 字段（任务 #113 固化契约）",
  );
  assert.ok(ce.content.length > 0, "补发 content 事件的 content 字段为空");
  assert.ok(!ce.content.includes("undefined"), "补发正文不应包含 undefined 脏文本");
  console.log(
    `[t116-contract] ✓ recipe 前恰好 1 条 content 补发事件（content 字段，${ce.content.length} 字符）`,
  );

  // ---- 断言 3：recipe 之后绝不再出现 candidates 事件 ----
  const lateCandidates = events.slice(recipeIdx + 1).filter((e) => e.type === "candidates");
  assert.equal(
    lateCandidates.length,
    0,
    `recipe 之后仍出现 ${lateCandidates.length} 条 candidates 事件`,
  );
  console.log("[t116-contract] ✓ recipe 之后无 candidates 事件");

  // ---- 断言 4：流正常收尾 ----
  const doneIdx = events.findIndex((e) => e.type === "done");
  assert.ok(doneIdx > recipeIdx, "未在 recipe 之后收到 done 事件");
  console.log("[t116-contract] ✓ 流以 done 正常收尾");

  console.log(`[t116-contract] PASS：共 ${events.length} 条事件，N>1 content 补发契约全部满足`);
}

main().catch((e) => {
  console.error(`[t116-contract] FAIL：${e.message}`);
  process.exit(1);
});
