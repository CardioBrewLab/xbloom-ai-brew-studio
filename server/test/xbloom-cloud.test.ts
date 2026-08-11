/**
 * xBloom 云端模块单测（不依赖网络）：
 * - shareId ↔ base64(tableId) 往返
 * - RSA 加密输出 base64 可解码且分块长度正确（RSA-1024：每块密文 128 字节）
 * - 内部配方 → 云端 payload 映射（pattern 1/2/3、grandWater 语义 = 粉水比）
 * - parseRecipeVo 对样例 recipeVo JSON 的解析
 */
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { makeValidRecipe } from "./fixtures.js";

// 单测固定全球区：先占位 XBLOOM_REGION（dotenv 不覆盖已存在变量），再动态导入云端模块
// 同时占位凭据为空：保证 ensureSession/withSessionRetry 走确定性的"无凭据"分支，绝不触网
process.env.XBLOOM_REGION = "";
process.env.XBLOOM_EMAIL = "";
process.env.XBLOOM_PASSWORD = "";
const {
  API_BASE,
  AuthExpiredError,
  RSA_CHUNK_CIPHER,
  alignIntegerPours,
  buildShareUrl,
  clearSession,
  ensureSession,
  getSessionFile,
  hasAutoLoginCredentials,
  isAuthFailureResponse,
  loadSession,
  maskEmail,
  parseRecipeVo,
  postJson,
  rsaEncrypt,
  saveSession,
  shareIdToTableId,
  tableIdToShareId,
  toCloudPayload,
  withSessionRetry,
} = await import("../src/lib/xbloom-cloud.js");

// 会话相关用例会写 data/session.json：先备份真实文件，全部跑完后原样还原
const sessionFile = getSessionFile();
const sessionBackup = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, "utf-8") : null;
after(() => {
  if (sessionBackup !== null) fs.writeFileSync(sessionFile, sessionBackup, "utf-8");
  else if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
});

describe("shareId ↔ base64(tableId) 往返", () => {
  it("tableId → shareId 与 btoa(String(tableId)) 一致", () => {
    assert.equal(tableIdToShareId(12345), Buffer.from("12345").toString("base64")); // MTIzNDU=
    assert.equal(tableIdToShareId(12345), "MTIzNDU=");
  });

  it("shareId → tableId 往返一致", () => {
    for (const tableId of [1, 42, 12345, 987654321]) {
      const shareId = tableIdToShareId(tableId);
      assert.equal(shareIdToTableId(shareId), String(tableId));
    }
  });

  it("非法 shareId（解码结果非数字）抛错", () => {
    assert.throws(() => shareIdToTableId(Buffer.from("abc").toString("base64")));
  });

  it("分享链接格式为 share-h5.xbloom.com/?id=<base64>", () => {
    assert.equal(buildShareUrl(12345), "https://share-h5.xbloom.com/?id=MTIzNDU%3D");
  });
});

describe("rsaEncrypt 分块与输出格式", () => {
  it("输出是合法 base64 且密文长度 = ceil(明文/117) × 128", () => {
    // 短 payload：明文 < 117 字节 → 单块 128 字节
    const small = { hello: "world" };
    const smallB64 = rsaEncrypt(small);
    const smallBytes = Buffer.from(smallB64, "base64");
    assert.equal(smallBytes.length, RSA_CHUNK_CIPHER);
    // base64 往返无损
    assert.equal(smallBytes.toString("base64"), smallB64);

    // 长 payload：pourDataJSONStr 风格，明文 > 117 字节 → 多块
    const big = {
      theName: "多块测试配方",
      pourDataJSONStr: JSON.stringify(
        Array.from({ length: 6 }, (_, i) => ({
          theName: `Pour ${i + 1}`,
          volume: 40 + i,
          temperature: 90,
          flowRate: 3.2,
          pattern: 2,
          pausing: 5,
        })),
      ),
    };
    const plainLen = Buffer.byteLength(JSON.stringify(big), "utf-8");
    const expectedChunks = Math.ceil(plainLen / 117);
    assert.ok(plainLen > 117, "样例必须超过单块容量才有意义");
    const bigBytes = Buffer.from(rsaEncrypt(big), "base64");
    assert.equal(bigBytes.length, expectedChunks * RSA_CHUNK_CIPHER);
  });

  it("加密结果不确定（PKCS1 随机填充），但长度稳定", () => {
    const payload = { v: 1 };
    const a = rsaEncrypt(payload);
    const b = rsaEncrypt(payload);
    assert.notEqual(a, b);
    assert.equal(Buffer.from(a, "base64").length, Buffer.from(b, "base64").length);
  });
});

describe("任务 #98：postJson 幂等重试纪律（非幂等写操作绝不重试）", () => {
  // 前置条件：本测试环境无出站代理（HTTPS_PROXY/ALL_PROXY 为空），getDispatcher() 返回 null，
  // postJson 走 undici 全局 dispatcher → 可用 setGlobalDispatcher(MockAgent) 拦截请求。
  const realDispatcher = getGlobalDispatcher();
  const jsonBody = (obj: unknown) => JSON.stringify(obj);

  it("非幂等写操作（默认 idempotent:false）：500 时不重试，仅 1 次请求", async () => {
    const agent = new MockAgent();
    setGlobalDispatcher(agent);
    try {
      // 只挂 1 个一次性 interceptor：若发生重试（第 2 次请求）会因无匹配而报错
      agent
        .get(new URL(API_BASE).origin)
        .intercept({ path: "/tuRecipeAdd.tuhtml", method: "POST" })
        .reply(500, jsonBody({ result: "fail", msg: "server exploded" }), {
          headers: { "content-type": "application/json" },
        });
      const resp = await postJson("tuRecipeAdd.tuhtml", "encrypted-payload");
      assert.equal(resp.result, "fail", "首次 500 的响应体原样返回，由上层处理");
      assert.equal(resp.msg, "server exploded");
      agent.assertNoPendingInterceptors(); // 恰好 1 次请求，无重试
    } finally {
      setGlobalDispatcher(realDispatcher);
      await agent.close();
    }
  });

  it("非幂等写操作：404 时也不重试（防「首次 404 但后端已落库」时重复创建）", async () => {
    const agent = new MockAgent();
    setGlobalDispatcher(agent);
    try {
      agent
        .get(new URL(API_BASE).origin)
        .intercept({ path: "/tuRecipeAdd.tuhtml", method: "POST" })
        .reply(404, jsonBody({ result: "fail", msg: "not found" }), {
          headers: { "content-type": "application/json" },
        });
      const resp = await postJson("tuRecipeAdd.tuhtml", "encrypted-payload");
      assert.equal(resp.result, "fail");
      agent.assertNoPendingInterceptors();
    } finally {
      setGlobalDispatcher(realDispatcher);
      await agent.close();
    }
  });

  it("幂等调用（idempotent:true）：404/5xx 仍有限重试直到成功", async () => {
    const agent = new MockAgent();
    setGlobalDispatcher(agent);
    try {
      const origin = new URL(API_BASE).origin;
      agent
        .get(origin)
        .intercept({ path: "/tMemberLogin.thtml", method: "POST" })
        .reply(500, jsonBody({ result: "fail" }), {
          headers: { "content-type": "application/json" },
        });
      agent
        .get(origin)
        .intercept({ path: "/tMemberLogin.thtml", method: "POST" })
        .reply(404, jsonBody({ result: "fail" }), {
          headers: { "content-type": "application/json" },
        });
      agent
        .get(origin)
        .intercept({ path: "/tMemberLogin.thtml", method: "POST" })
        .reply(200, jsonBody({ result: "success" }), {
          headers: { "content-type": "application/json" },
        });
      const resp = await postJson("tMemberLogin.thtml", { email: "a@b.c" }, { idempotent: true });
      assert.equal(resp.result, "success", "重试后拿到成功响应");
      agent.assertNoPendingInterceptors(); // 三个 interceptor 全部消费（共 3 次请求）
    } finally {
      setGlobalDispatcher(realDispatcher);
      await agent.close();
    }
  });
});

describe("内部配方 → 云端 payload 映射", () => {
  const recipe = makeValidRecipe(); // 15g 粉，234ml 总水，pattern: center + circular

  it("grandWater 字段语义是粉水比（234/15 = 15.6）而非总水量", () => {
    const { payload } = toCloudPayload(recipe);
    assert.equal(payload.grandWater, 15.6);
    assert.equal(payload.dose, 15);
  });

  it("pattern 编码：center→1, spiral→2, circular→3", () => {
    const pours = JSON.parse(toCloudPayload(recipe).payload.pourDataJSONStr as string) as {
      pattern: number;
    }[];
    assert.equal(pours.length, 2);
    assert.equal(pours[0].pattern, 1); // center
    assert.equal(pours[1].pattern, 3); // circular

    const spiralRecipe = {
      ...recipe,
      pours: [
        { volume: 234, temperature: 90, flowRate: 3.2, pattern: "spiral" as const, pausing: 0 },
      ],
    };
    const spiralPours = JSON.parse(
      toCloudPayload(spiralRecipe).payload.pourDataJSONStr as string,
    ) as {
      pattern: number;
    }[];
    assert.equal(spiralPours[0].pattern, 2); // spiral
  });

  it("基础字段直传且 name 可覆盖", () => {
    const { payload } = toCloudPayload(recipe, "覆盖名");
    assert.equal(payload.theName, "覆盖名");
    assert.equal(payload.grinderSize, 60);
    assert.equal(payload.rpm, 90);
    assert.equal(payload.cupType, 2); // xdripper
    assert.equal(toCloudPayload({ ...recipe, cupType: "other" }).payload.cupType, 3);
    // pourDataJSONStr 是 JSON 字符串而非对象
    assert.equal(typeof payload.pourDataJSONStr, "string");
  });

  it("bypass 关闭：isEnableBypassWater=2 且照发官方默认 85.0 / 5.0", () => {
    const { payload } = toCloudPayload(recipe);
    assert.equal(payload.isEnableBypassWater, 2);
    assert.equal(payload.bypassTemp, 85.0);
    assert.equal(payload.bypassVolume, 5.0);
  });

  it("bypass 启用：isEnableBypassWater=1 且透传自定义量/温", () => {
    const { payload } = toCloudPayload({
      ...recipe,
      bypassEnabled: true,
      bypassVolume: 40,
      bypassTemp: 88,
    });
    assert.equal(payload.isEnableBypassWater, 1);
    assert.equal(payload.bypassVolume, 40);
    assert.equal(payload.bypassTemp, 88);
  });

  it("段内 vib 映射 1开/2关，theName 缺省按 Bloom/Pour n 补齐", () => {
    const { payload } = toCloudPayload({
      ...recipe,
      pours: [
        { ...recipe.pours[0], vibBefore: true, theName: "闷蒸" },
        { ...recipe.pours[1], vibAfter: true },
      ],
    });
    const pours = JSON.parse(payload.pourDataJSONStr as string) as {
      theName: string;
      isEnableVibrationBefore: number;
      isEnableVibrationAfter: number;
    }[];
    assert.equal(pours[0].theName, "闷蒸");
    assert.equal(pours[0].isEnableVibrationBefore, 1);
    assert.equal(pours[0].isEnableVibrationAfter, 2);
    assert.equal(pours[1].theName, "Pour 2");
    assert.equal(pours[1].isEnableVibrationBefore, 2);
    assert.equal(pours[1].isEnableVibrationAfter, 1);
  });

  it("isSetGrinderSize 与 theColor 透传（缺省 1 / #C9D5B8）", () => {
    assert.equal(toCloudPayload(recipe).payload.isSetGrinderSize, 1);
    assert.equal(toCloudPayload(recipe).payload.theColor, "#C9D5B8");
    const { payload } = toCloudPayload({ ...recipe, isSetGrinderSize: 2, theColor: "#AABBCC" });
    assert.equal(payload.isSetGrinderSize, 2);
    assert.equal(payload.theColor, "#AABBCC");
  });

  it("浇注指令对齐：Σ分段 ≠ 可达总水时自动对齐到最近可达点并留痕", () => {
    // 245/15 → ratio 0.1 步进下 15×16.3=244.5≠245，官方拒收（实测 T1）；
    // 最近的可达整数总水是 246（15×16.4=246 精确）
    const misaligned = {
      ...recipe,
      grandWater: 245,
      pours: [
        { volume: 50, temperature: 90, flowRate: 3.2, pattern: "center" as const, pausing: 10 },
        { volume: 65, temperature: 89, flowRate: 3.2, pattern: "circular" as const, pausing: 5 },
        { volume: 65, temperature: 88, flowRate: 3.2, pattern: "circular" as const, pausing: 5 },
        { volume: 65, temperature: 87, flowRate: 3.2, pattern: "center" as const, pausing: 0 },
      ],
    };
    const result = toCloudPayload(misaligned);
    const ratio = result.payload.grandWater as number;
    const pours = JSON.parse(result.payload.pourDataJSONStr as string) as { volume: number }[];
    const sum = pours.reduce((s, p) => s + p.volume, 0);
    // 不变式：上传的 Σ 各段必须与 dose×round1(ratio) 精确相等（任务#45：App 侧零容差）
    assert.equal(sum, Math.round(15 * ratio * 10) / 10);
    // 任务#45：各段必须全部为整数毫升（等比缩放产生的小数段会被 App 拒）
    assert.ok(pours.every((p) => Number.isInteger(p.volume) && p.volume >= 1));
    // ratio 一位小数（0.1 步进），且总水就近对齐（245 → 246，偏差 ≤ 1ml）
    assert.equal(ratio, Math.round(ratio * 10) / 10);
    assert.equal(ratio, 16.4);
    assert.equal(sum, 246);
    assert.ok(result.adjustments.length > 0);
    // 留痕含总水与分段整数化两条
    assert.ok(result.adjustments.some((a) => a.includes("总水量")));
    assert.ok(result.adjustments.some((a) => a.includes("分段水量")));
    assert.equal(result.alignedGrandWater, sum);
    assert.equal(result.alignedPours.length, 4);
    assert.ok(result.alignedPours.every((p) => Number.isInteger(p.volume)));
  });

  it("浇注指令对齐：本来就一致的配方不做调整（无留痕）", () => {
    const result = toCloudPayload(recipe); // 234 = 15 × 15.6 精确（0.1 步进可达）
    assert.deepEqual(result.adjustments, []);
    assert.equal(result.alignedGrandWater, 234);
    assert.equal(result.payload.grandWater, 15.6);
    const pours = JSON.parse(result.payload.pourDataJSONStr as string) as { volume: number }[];
    assert.equal(pours[0].volume, 100);
    assert.equal(pours[1].volume, 134);
  });

  it("浇注指令对齐：dose=12/200ml 不可达时就近圆整（任务#41 林波波案例）", () => {
    // 12g 配任何 0.1 步进 ratio 都得不到整数 200ml（12×16.7=200.4），
    // 就近可达：198=12×16.5（向下距离 2）优于 204=12×17（向上距离 4）
    const limpopo = {
      ...recipe,
      doseGrams: 12,
      grandWater: 200,
      pours: [
        { volume: 40, temperature: 93, flowRate: 3.0, pattern: "center" as const, pausing: 30 },
        { volume: 40, temperature: 93, flowRate: 3.0, pattern: "circular" as const, pausing: 8 },
        { volume: 40, temperature: 92, flowRate: 3.0, pattern: "circular" as const, pausing: 17 },
        { volume: 40, temperature: 92, flowRate: 3.0, pattern: "spiral" as const, pausing: 14 },
        { volume: 40, temperature: 91, flowRate: 3.0, pattern: "center" as const, pausing: 0 },
      ],
    };
    const result = toCloudPayload(limpopo);
    assert.equal(result.payload.grandWater, 16.5);
    assert.equal(result.alignedGrandWater, 198);
    const pours = JSON.parse(result.payload.pourDataJSONStr as string) as { volume: number }[];
    const sum = pours.reduce((s, p) => s + p.volume, 0);
    assert.equal(sum, 198);
    // 任务#45：各段必须为整数毫升（旧版产生 39.6ml 小数段被 App 拒）
    assert.ok(pours.every((p) => Number.isInteger(p.volume) && p.volume >= 1));
    // 等比分摊 198/5：三段 40 + 两段 39
    assert.deepEqual(
      [...pours.map((p) => p.volume)].sort((a, b) => b - a),
      [40, 40, 40, 39, 39],
    );
    assert.ok(result.adjustments.length > 0);
  });

  it("任务#45：总水已对齐但分段含小数时仍整数化（App 拒收小数段）", () => {
    // T12 教训：Σ 与 dose×ratio 只差 0.04 云端能收录，但 App 仍拒——必须精确相等且整数
    const decimals = {
      ...recipe,
      grandWater: 234,
      pours: [
        { volume: 99.5, temperature: 93, flowRate: 3.0, pattern: "center" as const, pausing: 30 },
        { volume: 134.5, temperature: 90, flowRate: 3.0, pattern: "circular" as const, pausing: 0 },
      ],
    };
    const result = toCloudPayload(decimals);
    assert.equal(result.payload.grandWater, 15.6);
    assert.equal(result.alignedGrandWater, 234);
    const pours = JSON.parse(result.payload.pourDataJSONStr as string) as { volume: number }[];
    assert.ok(pours.every((p) => Number.isInteger(p.volume)));
    assert.equal(
      pours.reduce((s, p) => s + p.volume, 0),
      234,
    );
    assert.ok(result.adjustments.some((a) => a.includes("分段水量")));
    // 总水未变 → 不应出现总水留痕
    assert.ok(!result.adjustments.some((a) => a.includes("总水量")));
  });

  it("任务#45：alignIntegerPours 最大余数法/保底/上限/不可行边界", () => {
    // 最大余数：小数部分大的优先补 1
    assert.deepEqual(alignIntegerPours([10.1, 10.7, 10.2], 32), [10, 11, 11]);
    // 保底 1ml：缩放后归零的段至少 1，从最大段扣回
    assert.deepEqual(alignIntegerPours([0.2, 9.8], 10), [1, 9]);
    // 单段上限 300：超限搬到最小段，Σ 不变
    const capped = alignIntegerPours([500, 50], 550);
    assert.equal(Math.max(...capped), 300);
    assert.equal(
      capped.reduce((s, v) => s + v, 0),
      550,
    );
    // 不可行：总水分不够每段至少 1ml
    assert.throws(() => alignIntegerPours([1, 1, 1], 2));
    // 不可行：总水超过段数×上限
    assert.throws(() => alignIntegerPours([200, 200], 700));
  });

  it("任务#45：边界粉量 dose=1 与 dose=18、极小水量的对齐不变式", () => {
    // dose=1（CLOUD_LIMITS 下限）：16ml → ratio 16.0 可达，分段整数
    const tiny = {
      ...recipe,
      doseGrams: 1,
      grandWater: 16,
      pours: [
        { volume: 8, temperature: 93, flowRate: 3.0, pattern: "center" as const, pausing: 10 },
        { volume: 8, temperature: 90, flowRate: 3.0, pattern: "circular" as const, pausing: 0 },
      ],
    };
    const r1Result = toCloudPayload(tiny);
    assert.equal(r1Result.payload.grandWater, 16);
    assert.equal(r1Result.alignedGrandWater, 16);
    assert.deepEqual(r1Result.adjustments, []);
    // dose=18：300ml 不可达（18×16.7=300.6），就近向下 297=18×16.5
    const big = {
      ...recipe,
      doseGrams: 18,
      grandWater: 300,
      pours: [
        { volume: 100, temperature: 93, flowRate: 3.0, pattern: "center" as const, pausing: 30 },
        { volume: 100, temperature: 91, flowRate: 3.0, pattern: "circular" as const, pausing: 10 },
        { volume: 100, temperature: 89, flowRate: 3.0, pattern: "circular" as const, pausing: 0 },
      ],
    };
    const r2Result = toCloudPayload(big);
    assert.equal(r2Result.payload.grandWater, 16.5);
    assert.equal(r2Result.alignedGrandWater, 297);
    const r2Pours = JSON.parse(r2Result.payload.pourDataJSONStr as string) as { volume: number }[];
    assert.ok(r2Pours.every((p) => Number.isInteger(p.volume) && p.volume >= 1));
    assert.equal(
      r2Pours.reduce((s, p) => s + p.volume, 0),
      297,
    );
    // 极小水量：dose=2、4ml（2段各 2ml），ratio 2.0 数学上可达且分段整数
    const micro = {
      ...recipe,
      doseGrams: 2,
      grandWater: 4,
      pours: [
        { volume: 2, temperature: 93, flowRate: 3.0, pattern: "center" as const, pausing: 5 },
        { volume: 2, temperature: 90, flowRate: 3.0, pattern: "circular" as const, pausing: 0 },
      ],
    };
    const r3Result = toCloudPayload(micro);
    assert.equal(r3Result.alignedGrandWater, 4);
    const r3Pours = JSON.parse(r3Result.payload.pourDataJSONStr as string) as { volume: number }[];
    assert.ok(r3Pours.every((p) => Number.isInteger(p.volume) && p.volume >= 1));
    assert.equal(
      r3Pours.reduce((s, p) => s + p.volume, 0),
      4,
    );
  });
});

describe("自动登录：ensureSession / withSessionRetry / 鉴权失效识别", () => {
  const fakeSession = { memberId: 999, token: "fake-token", email: "unit@test.local" };

  it("会话落盘使用当前 Windows 用户 DPAPI，不出现 Token、邮箱或 memberId 明文", () => {
    clearSession();
    saveSession(fakeSession);
    const raw = fs.readFileSync(sessionFile, "utf8");
    const stored = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(stored.version, 2);
    assert.equal(stored.algorithm, "windows-dpapi");
    assert.equal(typeof stored.ciphertext, "string");
    assert.equal(Object.hasOwn(stored, "token"), false);
    assert.equal(Object.hasOwn(stored, "email"), false);
    assert.equal(Object.hasOwn(stored, "memberId"), false);
    assert.equal(raw.includes(fakeSession.token), false);
    assert.equal(raw.includes(fakeSession.email), false);
    // A short numeric ID can occur by chance inside randomized Base64 ciphertext.
    // Check for the plaintext JSON field instead of an unrelated digit substring.
    assert.equal(raw.includes(`"memberId":${fakeSession.memberId}`), false);
  });

  it("历史明文会话兼容读取后原位升级为 DPAPI 密文", () => {
    clearSession();
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify(fakeSession), "utf8");
    assert.deepEqual(loadSession(), fakeSession);
    const upgraded = fs.readFileSync(sessionFile, "utf8");
    assert.equal(upgraded.includes(fakeSession.token), false);
    assert.equal(JSON.parse(upgraded).algorithm, "windows-dpapi");
  });

  it("凭据未配置时 hasAutoLoginCredentials 为 false，且邮箱脱敏逻辑正确", () => {
    assert.equal(hasAutoLoginCredentials(), false);
    assert.equal(maskEmail("brew-user@example.com"), "b***@example.com");
    assert.equal(maskEmail("ab@example.com"), "a***@example.com");
    assert.equal(maskEmail("a@example.com"), "***@example.com");
    assert.equal(maskEmail("not-an-email"), "***");
  });

  it("有缓存会话时 ensureSession 直接返回缓存，不触网", async () => {
    saveSession(fakeSession);
    assert.deepEqual(await ensureSession(), fakeSession);
    assert.deepEqual(loadSession(), fakeSession);
  });

  it("无会话且无凭据时 ensureSession 抛错并明确提示手动登录", async () => {
    clearSession();
    assert.equal(loadSession(), null);
    await assert.rejects(() => ensureSession(), /未配置 XBLOOM_EMAIL\/XBLOOM_PASSWORD.*手动登录/);
  });

  it("isAuthFailureResponse：token/未登录/过期类失败命中，业务失败不命中", () => {
    assert.equal(isAuthFailureResponse({ result: "success" }), false);
    assert.equal(isAuthFailureResponse({ result: "fail", code: 401 }), true);
    assert.equal(isAuthFailureResponse({ result: "fail", msg: "token已过期，请重新登录" }), true);
    assert.equal(isAuthFailureResponse({ result: "fail", message: "用户未登录" }), true);
    assert.equal(isAuthFailureResponse({ result: "fail", errorMsg: "unauthorized request" }), true);
    // 普通业务失败不应误判为鉴权失效（避免无谓重登）
    assert.equal(isAuthFailureResponse({ result: "fail", msg: "配方名称不能为空" }), false);
    assert.equal(isAuthFailureResponse({ result: "fail" }), false);
  });

  it("withSessionRetry：op 一次成功则不重试，直接返回结果", async () => {
    saveSession(fakeSession);
    let calls = 0;
    const out = await withSessionRetry(async (s) => {
      calls++;
      assert.deepEqual(s, fakeSession);
      return "done";
    });
    assert.equal(out, "done");
    assert.equal(calls, 1);
  });

  it("withSessionRetry：非鉴权错误原样透传，不触发重登重试", async () => {
    saveSession(fakeSession);
    let calls = 0;
    await assert.rejects(
      () =>
        withSessionRetry(async () => {
          calls++;
          throw new Error("普通失败");
        }),
      /普通失败/,
    );
    assert.equal(calls, 1);
  });

  it("withSessionRetry：token 失效且无凭据 → 提示手动重新登录（不无限重试）", async () => {
    saveSession(fakeSession);
    let calls = 0;
    await assert.rejects(
      () =>
        withSessionRetry(async () => {
          calls++;
          throw new AuthExpiredError("token已过期");
        }),
      /登录态已失效.*手动重新登录/,
    );
    assert.equal(calls, 1); // 无凭据不能重试
  });

  it("withSessionRetry：优先使用调用方传入的会话", async () => {
    clearSession();
    const preferred = { memberId: 7, token: "t7", email: "p@test.local" };
    const out = await withSessionRetry(async (s) => s.memberId, preferred);
    assert.equal(out, 7);
  });
});

describe("parseRecipeVo 解析云端样例 recipeVo", () => {
  // 写死的样例：模拟 POST /RecipeDetail.html 返回的 recipeVo（grandWater=15.6 为粉水比）
  const sampleRecipeVo = {
    tableId: 12345,
    theName: "云端样例配方",
    dose: 15,
    grandWater: 15.6,
    grinderSize: 60,
    rpm: 90,
    cupType: 2,
    pourList: [
      {
        theName: "Bloom",
        volume: 100,
        temperature: 90,
        flowRate: 3.2,
        pattern: 1,
        pausing: 10,
        isEnableVibrationBefore: 2,
        isEnableVibrationAfter: 2,
      },
      {
        theName: "Pour 2",
        volume: 134,
        temperature: 88,
        flowRate: 3.2,
        pattern: 3,
        pausing: 5,
      },
    ],
  };

  it("还原为内部模型：总水 = dose × ratio，pattern 反解为语义值", () => {
    const recipe = parseRecipeVo(sampleRecipeVo);
    assert.equal(recipe.name, "云端样例配方");
    assert.equal(recipe.cupType, "xdripper");
    assert.equal(recipe.doseGrams, 15);
    assert.equal(recipe.grinderSize, 60);
    assert.equal(recipe.rpm, 90);
    assert.equal(recipe.grandWater, 234); // 15 × 15.6
    assert.equal(recipe.pours.length, 2);
    assert.equal(recipe.pours[0].pattern, "center"); // 1
    assert.equal(recipe.pours[1].pattern, "circular"); // 3
    assert.equal(recipe.pours[1].volume, 134);
    assert.equal(recipe.pours[0].pausing, 10);
  });

  it("新字段往返：bypass / vib / theColor / isSetGrinderSize 反向解析", () => {
    const vo = {
      ...sampleRecipeVo,
      isEnableBypassWater: 1,
      bypassTemp: 88,
      bypassVolume: 40,
      isSetGrinderSize: 2,
      theColor: "#AABBCC",
      pourList: [
        {
          theName: "Bloom",
          volume: 234,
          temperature: 90,
          flowRate: 3.2,
          pattern: 1,
          pausing: 10,
          isEnableVibrationBefore: 1,
          isEnableVibrationAfter: 2,
        },
      ],
    };
    const recipe = parseRecipeVo(vo);
    assert.equal(recipe.bypassEnabled, true);
    assert.equal(recipe.bypassVolume, 40);
    assert.equal(recipe.bypassTemp, 88);
    assert.equal(recipe.isSetGrinderSize, 2);
    assert.equal(recipe.theColor, "#AABBCC");
    assert.equal(recipe.pours[0].vibBefore, true);
    assert.equal(recipe.pours[0].vibAfter, false);
  });

  it("bypass 关闭（isEnableBypassWater=2）解析为 bypassEnabled=false", () => {
    const recipe = parseRecipeVo({
      ...sampleRecipeVo,
      isEnableBypassWater: 2,
      bypassVolume: 5,
      bypassTemp: 85,
    });
    assert.equal(recipe.bypassEnabled, false);
  });

  it("pourList 为 JSON 字符串时同样可解析", () => {
    const vo = { ...sampleRecipeVo, pourList: JSON.stringify(sampleRecipeVo.pourList) };
    const recipe = parseRecipeVo(vo);
    assert.equal(recipe.pours.length, 2);
    assert.equal(recipe.pours[0].pattern, "center");
  });

  it("缺少 pourList 时抛错（宁可失败也不静默降级）", () => {
    assert.throws(() => parseRecipeVo({ ...sampleRecipeVo, pourList: [] }));
  });

  it("未知 pattern 编码抛错", () => {
    const bad = {
      ...sampleRecipeVo,
      pourList: [{ ...sampleRecipeVo.pourList[0], pattern: 9 }],
    };
    assert.throws(() => parseRecipeVo(bad));
  });
});
