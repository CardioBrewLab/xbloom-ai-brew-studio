/**
 * 联网调研模块测试（node:test + assert，纯函数、无网络依赖）：
 * - extractEstateTokens：庄园/地块词提取（任务 #70，纯函数）
 * - buildResearchQueries：豆信息 → 分层搜索词（任务 #70：庄园→豆名→小红书→产区→国家兜底；任务 #76：小红书查询改为 site:xiaohongshu.com 定向语法；任务 #80：至多 8 条，新增 site:reddit.com 论坛定向；无信息 → 空）
 * - isXhsDirectedQuery / filterXhsDomainSources：小红书 site: 定向查询识别与域名过滤（任务 #76）
 * - isRedditDirectedQuery / filterRedditDomainSources / redditFetchUrl / isForumSource：Reddit 定向识别、域名过滤（含仿冒反例）、old.reddit 重写、论坛域名加权（任务 #80）
 * - parseDdgResults / parseDdgLiteResults：DuckDuckGo html/lite 端点结果解析（任务 #80 重新接入，含 snippet 提取）
 * - parseBingResults：Bing 结果解析（兜底渠道；b_results 容器限定 + /ck/a 解码，任务 #30）
 * - parseBaiduResults：百度结果解析（任务 #30 主渠道）
 * - scoreSourceRelevance / filterRelevantSources：相关性打分与过滤（任务 #30：域词命中即弱相关保留；任务 #70：庄园词 +5 / 小红书域名 +3 且保留）
 * - coffeeExcerpt：提炼失败回退时仅保留咖啡相关段落
 * - researchBean：无豆信息时立即降级返回（不触网）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { config } from "../src/config.js";
import {
  assertPublicAddress,
  assertPublicUrl,
  beanNameTermsOf,
  beanTokens,
  buildResearchQueries,
  coffeeExcerpt,
  createResearchBudgets,
  extractEstateTokens,
  filterRedditCoffeeSources,
  filterRedditDomainSources,
  filterRelevantSources,
  filterXhsDomainSources,
  firecrawlScrape,
  firecrawlSearch,
  foreignBeanTitleSignal,
  foreignDripperTitleSignal,
  FOREIGN_DRIPPER_WORDS,
  isCloudflareChallenge,
  isFirecrawlBenefitDomain,
  isForumSource,
  isOfficialXbloomSource,
  isRedditCoffeeRelevant,
  isRedditDirectedQuery,
  isXhsDirectedQuery,
  isXhsSearchTimeoutError,
  dedupeSourcesByTitle,
  isRedirectLinkSource,
  narrowSubjectTokens,
  freeTextNameSegment,
  freeTextOriginSegment,
  isNearDuplicateTitle,
  titleTokenJaccard,
  pickFetchQuota,
  xhsNoteRelevant,
  xhsTimeoutFallbackKeyword,
  titleSimilarity,
  originTokens,
  parseBaiduResults,
  parseBingResults,
  parseDdgLiteResults,
  parseDdgResults,
  parseFirecrawlSearchResults,
  parseSearxngResults,
  redditFetchUrl,
  redditSubOf,
  researchBean,
  resolvePublicHost,
  roasterTextSignalHit,
  scoreSourceRelevance,
  searchWeb,
  searchXiaohongshuDirected,
  tightExemptionBeanWords,
  xhsKeywordLadder,
  xhsMcpKeyword,
  XBLOOM_DRIPPER_WORDS,
  type BeanResearchInput,
  type ResearchSource,
} from "../src/lib/research.js";

describe("SSRF 地址与 DNS 固定", () => {
  it("拒绝私网、链路本地、文档网段与 IPv4-mapped IPv6", () => {
    for (const address of [
      "127.0.0.1",
      "10.2.3.4",
      "169.254.169.254",
      "192.0.2.1",
      "::1",
      "fc00::1",
      "::ffff:127.0.0.1",
    ]) {
      assert.throws(() => assertPublicAddress(address), /拒绝/);
    }
  });

  it("接纳公开字面量并拒绝解析到私网的域名", async () => {
    assert.doesNotThrow(() => assertPublicAddress("8.8.8.8"));
    assert.doesNotThrow(() => assertPublicUrl("https://1.1.1.1/path"));
    await assert.rejects(
      resolvePublicHost("TARGET", async () => [{ address: "10.0.0.9", family: 4 }]),
      /拒绝/,
    );
    const publicResult = await resolvePublicHost("TARGET", async () => [
      { address: "8.8.4.4", family: 4 },
    ]);
    assert.equal(publicResult[0].address, "8.8.4.4");
  });
});

describe("buildResearchQueries 搜索词构造", () => {
  it("带烘焙商与豆名时产出中英混合短查询（至多八条）", () => {
    const queries = buildResearchQueries({
      roaster: "Fisher",
      name: "耶加雪菲 G1",
      origin: "埃塞俄比亚",
      process: "水洗",
    });
    assert.ok(queries.length >= 3 && queries.length <= 8);
    assert.ok(queries[0].includes("Fisher"));
    assert.ok(queries[0].includes("耶加雪菲 G1"));
    // 短中文兜底：仅产地+豆名+咖啡
    assert.ok(queries.some((q) => q.includes("埃塞俄比亚") && q.includes("咖啡")));
    // 英文查询：英文产地 + 拉丁词元 + 处理法英文
    assert.ok(
      queries.some((q) => q.includes("Ethiopia") && q.includes("G1") && q.includes("washed")),
    );
    assert.ok(queries.some((q) => q.includes("pour over recipe")));
    // 任务 #26：单条查询不再全字段拼接（避免搜索引擎降级泛结果）
    for (const q of queries) {
      assert.ok(!(q.includes("Fisher") && q.includes("埃塞俄比亚") && q.includes("水洗")));
    }
  });

  it("任务 #30：埃塞 Testi Adorsi 水洗产出品种/处理站名英文查询", () => {
    const queries = buildResearchQueries({
      name: "Testi Adorsi",
      origin: "埃塞俄比亚",
      process: "水洗",
    });
    assert.ok(
      queries.some((q) => q.includes("Ethiopia") && q.includes("Adorsi") && q.includes("washed")),
    );
    assert.ok(queries.some((q) => q.includes("Adorsi") && q.includes("pour over recipe")));
  });

  it("QA 回归用例：肯尼亚 林波波 水洗 SL28（freeText）产出短查询而非整句拼接", () => {
    const queries = buildResearchQueries({ freeText: "肯尼亚 林波波 水洗 SL28 浅烘" });
    assert.ok(queries.length >= 2 && queries.length <= 8);
    // 中文查询：主题词取前 3 个词，不拼入整句
    assert.ok(queries.some((q) => q.includes("林波波") && q.includes("咖啡豆 冲煮建议")));
    assert.ok(queries.some((q) => q.includes("林波波") && q.includes("手冲")));
    // 英文查询：拉丁词元（SL28）参与检索
    assert.ok(queries.some((q) => q.includes("SL28") && q.includes("recipe")));
    // 任何一条查询都不应过长（短查询保证搜索引擎精度）
    for (const q of queries) {
      assert.ok(q.split(/\s+/).length <= 8, `查询过长：${q}`);
    }
  });

  it("仅有手动自由文本也能产出搜索词（· 分隔符被清洗）", () => {
    const queries = buildResearchQueries({ freeText: "埃塞俄比亚 · 水洗 · 浅烘" });
    assert.ok(queries.length >= 1);
    assert.ok(queries.some((q) => q.includes("埃塞俄比亚")));
    assert.ok(!queries.some((q) => q.includes("·")));
  });

  it("无任何豆信息时返回空数组（调用方跳过调研）", () => {
    assert.deepEqual(buildResearchQueries({}), []);
    assert.deepEqual(buildResearchQueries({ tastingNotes: "" }), []);
  });

  it("搜索词至多八条、去重，且标点被清洗", () => {
    const queries = buildResearchQueries({
      roaster: "A",
      name: "B，豆（限定）",
      origin: "C",
      freeText: "D、风味描述",
    });
    assert.ok(queries.length <= 8);
    assert.equal(new Set(queries).size, queries.length);
    for (const q of queries) {
      assert.ok(!q.includes("，"));
      assert.ok(!q.includes("（"));
    }
  });
});

describe("extractEstateTokens 庄园词提取（任务 #70）", () => {
  it("庄园/Finca/Estate/处理站等指示词命中", () => {
    assert.deepEqual(extractEstateTokens({ name: "云间庄园 花魁" }), ["云间庄园"]);
    assert.deepEqual(extractEstateTokens({ name: "Finca El Paraiso" }), ["Finca"]);
    assert.deepEqual(extractEstateTokens({ name: "Guji Estate Lot 3" }), ["Estate"]);
    // freeText 与 varietal 字段同样参与提取
    assert.deepEqual(extractEstateTokens({ freeText: "Adorsi 处理站 水洗" }), ["处理站"]);
    assert.deepEqual(extractEstateTokens({ varietal: "Kochere Farm Selection" }), ["Farm"]);
  });

  it("无庄园指示词时返回空数组（不降级为泛词）", () => {
    assert.deepEqual(extractEstateTokens({ name: "耶加雪菲 G1", origin: "埃塞俄比亚" }), []);
    assert.deepEqual(extractEstateTokens({ name: "Heirloom", varietal: "SL28" }), []);
    assert.deepEqual(extractEstateTokens({}), []);
  });

  it("多字段重复庄园词去重", () => {
    const tokens = extractEstateTokens({
      name: "云间庄园 花魁",
      freeText: "云间庄园 日晒 花魁",
      varietal: "云间庄园 Heirloom",
    });
    assert.deepEqual(tokens, ["云间庄园"]);
  });

  it("任务 #86：origin「国家-庄园」拆分——剩余非国家段作为庄园/地块候选词", () => {
    assert.deepEqual(extractEstateTokens({ origin: "埃塞俄比亚-阿朵斯" }), ["阿朵斯"]);
    assert.deepEqual(extractEstateTokens({ origin: "巴拿马-翡翠庄园" }), ["翡翠庄园"]);
    // 英文国家名同样被剥离
    assert.deepEqual(extractEstateTokens({ origin: "Ethiopia Adorsi" }), ["Adorsi"]);
    // 指示词命中的 token 优先，origin 候选词附后
    assert.deepEqual(extractEstateTokens({ name: "云间庄园 花魁", origin: "埃塞俄比亚-阿朵斯" }), [
      "云间庄园",
      "阿朵斯",
    ]);
  });

  it("任务 #86：纯国家名 / 国家+大产区 origin 不产出假庄园词（保守原则）", () => {
    assert.deepEqual(extractEstateTokens({ origin: "埃塞俄比亚" }), []);
    assert.deepEqual(extractEstateTokens({ origin: "哥伦比亚" }), []);
    assert.deepEqual(extractEstateTokens({ origin: "埃塞俄比亚 耶加雪菲" }), []);
    assert.deepEqual(extractEstateTokens({ origin: "哥伦比亚-慧兰" }), []);
    // 等级/品种噪声词不作为庄园词
    assert.deepEqual(extractEstateTokens({ origin: "肯尼亚 AA" }), []);
    assert.deepEqual(extractEstateTokens({ origin: "Ethiopia Yirgacheffe G1" }), []);
  });

  it("任务 #86：用户实测场景——埃塞俄比亚-阿朵斯 查询列表含庄园词，不再全落国家级兜底", () => {
    const queries = buildResearchQueries({
      origin: "埃塞俄比亚-阿朵斯",
      process: "水洗",
      varietal: "原生种",
    });
    assert.ok(queries.some((q) => q.includes("阿朵斯")));
    // Tier 1 庄园级置顶（无烘焙商时庄园词 + 冲煮参数）
    assert.equal(queries[0], "阿朵斯 冲煮参数");
  });
});

describe("buildResearchQueries 分层降级顺序（任务 #70）", () => {
  const fullBean = {
    name: "云间庄园 花魁",
    roaster: "M2M",
    origin: "埃塞俄比亚",
    process: "日晒",
    varietal: "Heirloom",
  };

  it("完整豆档案产出 8 条：首条庄园级、末条国家级兜底，逐层精确断言", () => {
    const queries = buildResearchQueries(fullBean);
    assert.equal(queries.length, 8);
    // Tier 1 庄园级置顶：庄园词 + 烘焙商 + 冲煮参数
    assert.equal(queries[0], "云间庄园 M2M 冲煮参数");
    // Tier 2 豆名层紧随其后
    assert.equal(queries[1], "M2M 云间庄园 花魁 咖啡豆 冲煮建议");
    assert.equal(queries[2], "M2M 云间庄园 花魁 手冲");
    // 论坛定向（任务 #80）：位于 Tier 3 之后、国家级兜底之前
    assert.equal(queries[6], "site:reddit.com 云间庄园 brew recipe");
    // Tier 4 国家级兜底排末位（池满时天然不被执行）
    assert.equal(queries[7], "埃塞俄比亚 云间庄园 花魁 咖啡");
    // Tier 3 英文产区 + 拉丁词元 + 处理法英文（日晒 → natural）
    assert.ok(
      queries.some(
        (q) => q.includes("Ethiopia") && q.includes("Heirloom") && q.includes("natural"),
      ),
    );
  });

  it("小红书平台定向查询为 site: 定向语法（任务 #76）：有庄园词时以庄园词为主体，无庄园词时以豆名为主体", () => {
    const queries = buildResearchQueries(fullBean);
    assert.ok(queries.includes("site:xiaohongshu.com 云间庄园 冲煮参数"));
    const noEstate = buildResearchQueries({ name: "耶加雪菲 G1", roaster: "Fisher" });
    assert.ok(noEstate.includes("site:xiaohongshu.com 耶加雪菲 G1 冲煮参数"));
    // 不再把“小红书”当普通关键词拼进查询（那是旧方案：召回的是含该词的博客而非笔记）
    assert.ok(!queries.some((q) => q.includes("小红书")));
  });

  it("Reddit 论坛定向查询为 site: 定向语法（任务 #80）：恰好一条，庄园词优先于豆名作主体", () => {
    const queries = buildResearchQueries(fullBean);
    const directed = queries.filter(isRedditDirectedQuery);
    assert.equal(directed.length, 1, "恰好一条 Reddit 定向查询（中英文各一条以内）");
    assert.equal(directed[0], "site:reddit.com 云间庄园 brew recipe");
    // 无庄园词时以豆名为主体
    const noEstate = buildResearchQueries({ name: "耶加雪菲 G1", roaster: "Fisher" });
    assert.ok(noEstate.includes("site:reddit.com 耶加雪菲 G1 brew recipe"));
  });

  it("无拉丁词元时国家级英文兜底也排在末位", () => {
    const queries = buildResearchQueries({ name: "花魁", origin: "埃塞俄比亚", process: "日晒" });
    assert.ok(queries.length >= 3);
    // 无拉丁词元 → Tier 4 追加英文产地宽松兜底，且位于数组末尾
    assert.ok(
      queries[queries.length - 1].includes("Ethiopia") &&
        queries[queries.length - 1].includes("pour over recipe"),
    );
    assert.ok(
      queries[queries.length - 2].includes("埃塞俄比亚") &&
        queries[queries.length - 2].includes("咖啡"),
    );
  });
});

describe("小红书定向查询识别与域名过滤（任务 #76）", () => {
  it("isXhsDirectedQuery：仅识别带 site:xiaohongshu.com 的查询", () => {
    assert.equal(isXhsDirectedQuery("site:xiaohongshu.com 花魁 冲煮参数"), true);
    assert.equal(isXhsDirectedQuery("SITE:XIAOHONGSHU.COM 花魁"), true);
    assert.equal(isXhsDirectedQuery("花魁 小红书 冲煮参数"), false);
    assert.equal(isXhsDirectedQuery("Fisher 耶加雪菲 G1 手冲"), false);
  });

  it("filterXhsDomainSources：仅保留 xiaohongshu.com / xhslink.com 域名，丢弃其他与非法 URL", () => {
    const pool = [
      {
        title: "花魁冲煮笔记",
        url: "https://www.xiaohongshu.com/explore/abc",
        snippet: "粉水比 1:15",
      },
      { title: "短链分享", url: "https://xhslink.com/xyz" },
      { title: "博客搬运", url: "https://blog.example/xiaohongshu-post" },
      { title: "百科", url: "https://baike.baidu.com/item/花魁" },
      { title: "非法 URL", url: "not-a-url" },
    ];
    const kept = filterXhsDomainSources(pool);
    assert.equal(kept.length, 2);
    assert.ok(kept[0].url.includes("xiaohongshu.com"));
    // 标题+snippet 完整保留（小红书正文登录墙，标题+摘要即素材）
    assert.equal(kept[0].snippet, "粉水比 1:15");
    assert.ok(kept[1].url.includes("xhslink.com"));
    // 子域名同样命中；仿冒域名（xiaohongshu.com.evil）不命中
    const sub = filterXhsDomainSources([
      { title: "a", url: "https://edith.xiaohongshu.com/prerank/notes" },
      { title: "b", url: "https://xiaohongshu.com.evil.com/fake" },
    ]);
    assert.equal(sub.length, 1);
    assert.ok(sub[0].url.includes("edith.xiaohongshu.com"));
  });

  it("任务 #98 防仿冒：后缀相似域名（notxiaohongshu.com / notxhslink.com）不得绕过域名过滤", () => {
    const spoof = filterXhsDomainSources([
      { title: "a", url: "https://notxiaohongshu.com/fake-note" },
      { title: "b", url: "https://notxhslink.com/xyz" },
      { title: "c", url: "https://evixiaohongshu.com/abc" },
      { title: "真裸域", url: "https://xiaohongshu.com/explore/ok" },
      { title: "真短链子域", url: "https://go.xhslink.com/abc" },
    ]);
    assert.equal(spoof.length, 2);
    assert.ok(
      spoof.every((s) => ["xiaohongshu.com", "go.xhslink.com"].includes(new URL(s.url).hostname)),
    );
  });

  it("任务 #98 防仿冒：标题提及 xiaohongshu.com 不再误判为小红书来源（打分 +3 仅限真域名）", () => {
    // 旧 isXiaohongshu 是 url+title 拼接子串匹配，标题提及即误判；现改为解析后 hostname 精确判定
    const titleMention = {
      title: "xiaohongshu.com 上的花魁笔记汇总（第三方博客）",
      url: "https://blog.example/xhs-roundup",
    };
    assert.equal(scoreSourceRelevance(titleMention, []).score, 0, "标题提及不得触发小红书域名 +3");
    assert.equal(scoreSourceRelevance(titleMention, []).kept, false);
    // 真小红书域名仍 +3
    const real = { title: "周末探店笔记", url: "https://www.xiaohongshu.com/explore/abc" };
    assert.equal(scoreSourceRelevance(real, []).score, 3);
  });

  it("buildResearchQueries 产出的平台查询能被 isXhsDirectedQuery 识别", () => {
    const queries = buildResearchQueries({ name: "花魁", roaster: "M2M" });
    const directed = queries.filter(isXhsDirectedQuery);
    assert.equal(directed.length, 1, "恰好一条小红书定向查询");
    assert.ok(directed[0].startsWith("site:xiaohongshu.com"));
  });
});

describe("parseDdgResults 搜索结果解析", () => {
  it("解析 result__a 锚点并解码 uddg 跳转链接", () => {
    const html = `
      <div class="result">
        <a rel="nofollow" class="result__a"
           href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Fbrew&amp;rut=abc">
          Example <b>Coffee</b> Roaster
        </a>
      </div>`;
    const results = parseDdgResults(html);
    assert.equal(results.length, 1);
    assert.equal(results[0].url, "https://www.example.com/brew");
    assert.ok(results[0].title.includes("Example Coffee Roaster"));
  });

  it("任务 #80：同时提取 result__snippet 摘要（reddit 帖正文抓取失败时兜底）", () => {
    const html = `
      <div class="result">
        <a rel="nofollow" class="result__a" href="https://www.reddit.com/r/pourover/comments/abc/">V60 recipe?</a>
        <a class="result__snippet" href="#">I use <b>15g</b> coffee, 250g water, 93C...</a>
      </div>`;
    const results = parseDdgResults(html);
    assert.equal(results.length, 1);
    assert.equal(results[0].snippet, "I use 15g coffee, 250g water, 93C...");
  });

  it("无结果页面返回空数组", () => {
    assert.deepEqual(parseDdgResults("<html><body>no results</body></html>"), []);
  });
});

describe("parseDdgLiteResults lite 端点解析（任务 #80）", () => {
  it("解析 result-link 锚点（含 uddg 跳转解码）", () => {
    const html = `
      <table>
        <tr><td><a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fold.reddit.com%2Fr%2Fpourover%2Fcomments%2Fxyz%2F">Grind size for V60</a></td></tr>
        <tr><td><a class="result-link" href="https://www.home-barista.com/pour-over/t1.html">Home barista thread</a></td></tr>
      </table>`;
    const results = parseDdgLiteResults(html);
    assert.equal(results.length, 2);
    assert.equal(results[0].url, "https://old.reddit.com/r/pourover/comments/xyz/");
    assert.equal(results[1].url, "https://www.home-barista.com/pour-over/t1.html");
  });

  it("202 限流/空页面返回空数组（静默降级不抛错）", () => {
    assert.deepEqual(parseDdgLiteResults("<html><body>Anomaly detected</body></html>"), []);
    assert.deepEqual(parseDdgLiteResults(""), []);
  });
});

describe("Reddit 定向识别、域名过滤与 old.reddit 重写（任务 #80）", () => {
  it("isRedditDirectedQuery：仅识别带 site:reddit.com 的查询", () => {
    assert.equal(isRedditDirectedQuery("site:reddit.com 花魁 brew recipe"), true);
    assert.equal(isRedditDirectedQuery("SITE:REDDIT.COM Gesha"), true);
    assert.equal(isRedditDirectedQuery("reddit 花魁 冲煮"), false);
    assert.equal(isRedditDirectedQuery("site:xiaohongshu.com 花魁"), false);
  });

  it("filterRedditDomainSources：仅保留 reddit.com 及子域，仿冒域名不命中", () => {
    const pool = [
      {
        title: "V60 recipe",
        url: "https://www.reddit.com/r/pourover/comments/a/",
        snippet: "15g/250g",
      },
      { title: "旧前端帖", url: "https://old.reddit.com/r/espresso/comments/b/" },
      { title: "裸域帖", url: "https://reddit.com/r/coffee/comments/c/" },
      { title: "仿冒域名", url: "https://reddit.com.evil.com/fake" },
      { title: "相似域名", url: "https://www.notreddit.com/post" },
      { title: "无关博客", url: "https://blog.example/reddit-brew" },
      { title: "非法 URL", url: "not-a-url" },
    ];
    const kept = filterRedditDomainSources(pool);
    assert.equal(kept.length, 3);
    // 标题+snippet 完整保留（正文抓取失败时 snippet 即素材）
    assert.equal(kept[0].snippet, "15g/250g");
    assert.ok(kept.every((s) => new URL(s.url).hostname.endsWith("reddit.com")));
  });

  it("redditFetchUrl：仅 www.reddit.com 重写为 old.reddit.com，其余原样返回", () => {
    assert.equal(
      redditFetchUrl("https://www.reddit.com/r/pourover/comments/abc/?sort=top"),
      "https://old.reddit.com/r/pourover/comments/abc/?sort=top",
    );
    // old. 子域与其他域名不改写
    assert.equal(
      redditFetchUrl("https://old.reddit.com/r/espresso/"),
      "https://old.reddit.com/r/espresso/",
    );
    assert.equal(
      redditFetchUrl("https://www.home-barista.com/x"),
      "https://www.home-barista.com/x",
    );
    // 非法 URL 原样返回（不抛错）
    assert.equal(redditFetchUrl("not-a-url"), "not-a-url");
  });

  it("isForumSource：reddit 子域与 home-barista.com 命中，仿冒域名不命中", () => {
    assert.equal(isForumSource({ title: "a", url: "https://old.reddit.com/r/pourover/" }), true);
    assert.equal(isForumSource({ title: "b", url: "https://www.home-barista.com/" }), true);
    assert.equal(isForumSource({ title: "c", url: "https://reddit.com.evil.com/" }), false);
    assert.equal(isForumSource({ title: "d", url: "https://brew.example/" }), false);
    assert.equal(isForumSource({ title: "e", url: "not-a-url" }), false);
  });
});

describe("parseBingResults 兜底搜索解析", () => {
  it("解析 <h2><a> 结构", () => {
    const html = `<li class="b_algo"><h2><a href="https://roaster.example/page">Roaster 冲煮建议</a></h2></li>`;
    const results = parseBingResults(html);
    assert.equal(results.length, 1);
    assert.equal(results[0].url, "https://roaster.example/page");
    assert.equal(results[0].title, "Roaster 冲煮建议");
  });

  it("任务 #30：限定 b_results 容器，不把侧栏/推荐位的 <h2> 误当结果", () => {
    const html = `
      <div id="b_content">
        <ol id="b_results">
          <li class="b_algo"><h2><a href="https://roaster.example/a">真实结果 A</a></h2></li>
          <li class="b_algo"><h2><a href="https://roaster.example/b">真实结果 B</a></h2></li>
        </ol>
        <div id="b_context"><h2><a href="https://hot.example/trend">热搜推荐位</a></h2></div>
      </div>`;
    const results = parseBingResults(html);
    assert.equal(results.length, 2);
    assert.ok(!results.some((r) => r.title.includes("热搜")));
  });

  it("任务 #30：/ck/a 跳转链接解码为真实 URL（u=a1<base64url>）", () => {
    // u=a1 + base64url("https://example.com/brew")
    const target = "https://example.com/brew";
    const b64 = Buffer.from(target).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    const html = `<ol id="b_results"><li><h2><a href="https://www.bing.com/ck/a?u=a1${b64}&p=xxx">Example Brew</a></h2></li></ol>`;
    const results = parseBingResults(html);
    assert.equal(results.length, 1);
    assert.equal(results[0].url, target);
  });
});

describe("parseBaiduResults 主渠道解析（任务 #30）", () => {
  it("解析 <h3><a> 结构（含 baidu.com/link 跳转链接）", () => {
    const html = `
      <h3 class="c-title"><a href="http://www.baidu.com/link?url=abc123">前街咖啡 | 肯尼亚 咖啡叫初恋</a></h3>
      <h3 class="c-title"><a href="https://qianjiecoffee.com/brew">前街咖啡冲煮教程</a></h3>`;
    const results = parseBaiduResults(html);
    assert.equal(results.length, 2);
    assert.equal(results[0].url, "http://www.baidu.com/link?url=abc123");
    assert.ok(results[0].title.includes("前街咖啡"));
    assert.equal(results[1].url, "https://qianjiecoffee.com/brew");
  });

  it("无结果页面返回空数组", () => {
    assert.deepEqual(parseBaiduResults("<html><body>验证页面</body></html>"), []);
  });
});

describe("parseSearxngResults SearXNG 解析（任务 #30）", () => {
  it("提取 results 的 url/title，忽略非法条目与非法 URL", () => {
    const json = {
      results: [
        {
          url: "https://ablebrewing.com/blog/testi-adorsi",
          title: "Featured Coffee: Testi Adorsi",
        },
        { url: "javascript:alert(1)", title: "非法协议" },
        { title: "缺 url" },
        null,
        { url: "https://bodega.coffee/adorsi", title: "Ethiopia <b>Adorsi</b>" },
      ],
    };
    const results = parseSearxngResults(json);
    assert.equal(results.length, 2);
    assert.equal(results[0].url, "https://ablebrewing.com/blog/testi-adorsi");
    assert.ok(results[1].title.includes("Ethiopia Adorsi"));
  });

  it("非法/空输入返回空数组", () => {
    assert.deepEqual(parseSearxngResults(null), []);
    assert.deepEqual(parseSearxngResults({}), []);
    assert.deepEqual(parseSearxngResults({ results: "nope" }), []);
  });
});

describe("相关性打分与过滤（任务 #26 / #30 放宽）", () => {
  const input = { name: "林波波", origin: "肯尼亚", process: "水洗", varietal: "SL28" };

  it("beanTokens 拆分豆名为独立关键词（≥2 字符，去重）", () => {
    const tokens = beanTokens(input);
    assert.ok(tokens.includes("林波波"));
    assert.ok(tokens.includes("肯尼亚"));
    assert.ok(tokens.includes("sl28"));
  });

  it("QA 反例：canva可画 - 百度知道 类无关结果直接判负丢弃", () => {
    const src = {
      title: "canva可画的功能 - 百度知道",
      url: "https://zhidao.baidu.com/question/123",
    };
    const { score, kept } = scoreSourceRelevance(src, beanTokens(input));
    assert.ok(score < 0);
    assert.equal(kept, false);
  });

  it("豆词命中的来源保留（豆商商品页）", () => {
    const src = {
      title: "肯尼亚 林波波 SL28 水洗 浅烘 咖啡豆",
      url: "https://roaster.example/kenya-limpopo",
    };
    const { beanHits, kept } = scoreSourceRelevance(src, beanTokens(input));
    assert.ok(beanHits >= 2);
    assert.equal(kept, true);
  });

  it("任务 #30：命中任一咖啡域词即弱相关保留（不要求豆词）；零域词才丢弃", () => {
    const enough = { title: "手冲咖啡冲煮指南：研磨与水温", url: "https://brew.example/guide" };
    assert.equal(scoreSourceRelevance(enough, beanTokens(input)).kept, true);
    // 单个域词（brew）命中也保留：英文烘焙商页标题往往不含中文豆词
    const weak = {
      title: "Kekundu AA — Single Origin Series",
      url: "https://roaster.example/brew-guide",
    };
    const weakResult = scoreSourceRelevance(weak, beanTokens(input));
    assert.equal(weakResult.beanHits, 0);
    assert.equal(weakResult.kept, true);
    const none = { title: "今日新闻速览", url: "https://news.example/today" };
    assert.equal(scoreSourceRelevance(none, beanTokens(input)).kept, false);
  });

  it("任务 #70：庄园词命中加权 +5（高于豆词），传入 estateTokens 后分数与排名提升", () => {
    const src = { title: "云间庄园 花魁 冲煮参数分享", url: "https://roaster.example/yunjian" };
    const tokens = beanTokens({ name: "云间庄园 花魁", roaster: "M2M" });
    const without = scoreSourceRelevance(src, tokens);
    const withEstate = scoreSourceRelevance(src, tokens, ["云间庄园"]);
    assert.equal(withEstate.beanHits, without.beanHits + 1, "庄园词命中计入 beanHits");
    assert.ok(withEstate.score - without.score >= 5, "庄园词命中至少 +5");
    // 庄园词命中的来源排在同池纯域词来源之前（filterRelevantSources 透传庄园词）
    const pool = [
      { title: "手冲咖啡冲煮指南：研磨与水温", url: "https://brew.example/guide" },
      src,
    ];
    const { kept } = filterRelevantSources(pool, { name: "云间庄园 花魁" });
    assert.equal(kept.length, 2);
    assert.ok(kept[0].title.includes("云间庄园"));
  });

  it("任务 #70：小红书域名命中 +3 且零域词也直接保留（登录墙页面不被过滤）", () => {
    // 标题不含豆词与咖啡域词，隔离验证域名加权本身
    const xhs = { title: "周末探店笔记", url: "https://www.xiaohongshu.com/explore/abc123" };
    const res = scoreSourceRelevance(xhs, beanTokens({ name: "花魁" }));
    assert.equal(res.score, 3);
    assert.equal(res.kept, true);
    // 同样的标题与 URL 换成非小红书域名：零域词命中 → 不保留
    const same = { title: "周末探店笔记", url: "https://blog.example/abc123" };
    const sameRes = scoreSourceRelevance(same, beanTokens({ name: "花魁" }));
    assert.equal(sameRes.score, 0);
    assert.equal(sameRes.kept, false);
    // xhslink 短链同样命中
    const short = { title: "探店记录", url: "https://xhslink.com/xyz" };
    assert.equal(scoreSourceRelevance(short, []).kept, true);
  });

  it("任务 #80：reddit.com / home-barista.com 论坛域名 +3 且零域词也直接保留（防误杀）", () => {
    // 标题与 URL 均不含豆词/咖啡域词（避开“冲煮”“pourover”等域词干扰），隔离验证域名加权本身
    const reddit = { title: "周末闲聊帖", url: "https://www.reddit.com/r/xyz/comments/abc/" };
    const res = scoreSourceRelevance(reddit, beanTokens({ name: "花魁" }));
    assert.equal(res.score, 3);
    assert.equal(res.kept, true);
    // home-barista.com 同样命中（轻量纳入：不新增抓取，仅保留名单放行）
    const hb = { title: "新人报道", url: "https://www.home-barista.com/forums/t123.html" };
    assert.equal(scoreSourceRelevance(hb, []).kept, true);
    // 仿冒域名 reddit.com.evil.com 不命中：零域词 → 不保留
    const fake = { title: "周末闲聊帖", url: "https://reddit.com.evil.com/abc" };
    const fakeRes = scoreSourceRelevance(fake, beanTokens({ name: "花魁" }));
    assert.equal(fakeRes.score, 0);
    assert.equal(fakeRes.kept, false);
  });

  it("任务 #86：小红书笔记零咖啡域词标题仍保留（MCP 真召回不在过滤环节丢失）", () => {
    // 实测 MCP 召回的笔记标题如「☕️2」「深夜手冲10g浆一杯」不含咖啡域词表词条
    const note = { title: "☕️2", url: "https://www.xiaohongshu.com/explore/note1" };
    const res = scoreSourceRelevance(
      note,
      beanTokens({ origin: "埃塞俄比亚-阿朵斯", process: "水洗" }),
      ["阿朵斯"],
      { process: "水洗" },
    );
    assert.equal(res.kept, true);
    // 但标题级处理法冲突仍能覆盖小红书直接保留（水洗豆遇厌氧主题笔记）
    const conflict = {
      title: "厌氧发酵处理法教学笔记",
      url: "https://www.xiaohongshu.com/explore/note2",
    };
    const conflictRes = scoreSourceRelevance(conflict, [], [], { process: "水洗" });
    assert.equal(conflictRes.kept, false);
  });

  it("filterRelevantSources：混合池只留相关项，按分数降序，计数丢弃数", () => {
    const pool = [
      { title: "canva可画的功能 - 百度知道", url: "https://zhidao.baidu.com/question/1" },
      { title: "今日新闻速览", url: "https://news.example/today" },
      { title: "肯尼亚 林波波 SL28 咖啡豆", url: "https://roaster.example/kenya-limpopo" },
      { title: "手冲咖啡冲煮指南：研磨与水温", url: "https://brew.example/guide" },
    ];
    const { kept, filtered } = filterRelevantSources(pool, input);
    assert.equal(kept.length, 2);
    assert.equal(filtered, 2);
    // 豆词命中的来源排在纯域词来源之前
    assert.ok(kept[0].title.includes("林波波"));
  });

  it("过滤后为空 → kept 为空数组（调用方走降级而不是注入垃圾）", () => {
    const pool = [
      { title: "canva可画的功能 - 百度知道", url: "https://zhidao.baidu.com/question/1" },
      { title: "PPT 模板下载", url: "https://ppt.example/download" },
    ];
    const { kept, filtered } = filterRelevantSources(pool, input);
    assert.equal(kept.length, 0);
    assert.equal(filtered, 2);
  });
});

describe("处理法冲突过滤（任务 #86）", () => {
  const adorsi = { origin: "埃塞俄比亚-阿朵斯", process: "水洗", varietal: "原生种" };

  it("用户实测场景：水洗豆遇「厌氧发酵法」主题标题 → 强降权并过滤", () => {
    const src = {
      title: "2026 咖啡界最热话题！一个post教你6大厌氧发酵法",
      url: "https://blog.example/anaerobic-guide",
    };
    const res = scoreSourceRelevance(src, beanTokens(adorsi), extractEstateTokens(adorsi), {
      process: adorsi.process,
      originTokens: originTokens(adorsi),
    });
    assert.ok(res.score < 0, "标题级冲突总分应为负");
    assert.equal(res.kept, false, "厌氧主题对水洗豆应被过滤");
    // 同样的来源若处理法未知则不受影响（保守：不启用冲突逻辑）
    const noProcess = scoreSourceRelevance(src, beanTokens({ origin: "埃塞俄比亚-阿朵斯" }), []);
    assert.equal(noProcess.kept, true);
  });

  it("日晒豆对水洗主题标题同样降权过滤（对称）", () => {
    const bean = { name: "花魁", process: "日晒" };
    const src = { title: "水洗处理法咖啡冲煮指南", url: "https://brew.example/washed-guide" };
    const res = scoreSourceRelevance(src, beanTokens(bean), [], { process: "日晒" });
    assert.ok(res.score < 0);
    assert.equal(res.kept, false);
  });

  it("匹配处理法出现在标题：加分（相对不传处理法时 +3）", () => {
    const bean = { name: "耶加雪菲", process: "水洗" };
    const src = { title: "耶加雪菲 水洗 冲煮参数详解", url: "https://brew.example/yirg" };
    const tokens = beanTokens(bean);
    const base = scoreSourceRelevance(src, tokens, []);
    const withProcess = scoreSourceRelevance(src, tokens, [], { process: "水洗" });
    assert.equal(withProcess.score, base.score + 3);
    assert.equal(withProcess.kept, true);
  });

  it("标题冲突 vs 摘要顺带提及：前者死刑后者仅降权（不误杀对比文）", () => {
    const bean = { name: "耶加雪菲", process: "水洗" };
    const tokens = beanTokens(bean);
    // 冲突词在标题：强降权 + 过滤
    const inTitle = scoreSourceRelevance(
      { title: "日晒处理法完全指南", url: "https://brew.example/natural" },
      tokens,
      [],
      { process: "水洗" },
    );
    assert.equal(inTitle.kept, false);
    // 同样内容移到摘要（标题是正常冲煮文）：保留，仅比无冲突时低 3 分
    const snippetSrc = {
      title: "耶加雪菲手冲冲煮指南",
      url: "https://brew.example/yirg-guide",
      snippet: "文末顺带对比了日晒与蜜处理的风味差异",
    };
    const inSnippet = scoreSourceRelevance(snippetSrc, tokens, [], { process: "水洗" });
    assert.equal(inSnippet.kept, true);
    const noConflict = scoreSourceRelevance(
      { title: snippetSrc.title, url: snippetSrc.url },
      tokens,
      [],
      { process: "水洗" },
    );
    assert.equal(inSnippet.score, noConflict.score - 3);
  });

  it("无法识别的处理法文本不启用冲突逻辑（保守）", () => {
    const res = scoreSourceRelevance(
      { title: "厌氧发酵咖啡冲煮要点", url: "https://brew.example/anaerobic" },
      [],
      [],
      { process: "特殊定制处理法" },
    );
    assert.equal(res.kept, true);
    assert.ok(res.score > 0, "识别不了处理法时不做冲突降权");
  });
});

describe("国家级泛文降权与用户实测集成（任务 #86）", () => {
  const adorsi = { origin: "埃塞俄比亚-阿朵斯", process: "水洗", varietal: "原生种" };

  it("庄园词已提取时：纯国家级泛文分数明显低于含庄园词的精确来源", () => {
    const tokens = beanTokens(adorsi);
    const estates = extractEstateTokens(adorsi);
    const origins = originTokens(adorsi);
    assert.deepEqual(estates, ["阿朵斯"]);
    const opts = { process: "水洗", originTokens: origins };
    const generic = scoreSourceRelevance(
      { title: "埃塞俄比亚咖啡品种有啥不同", url: "https://blog.example/ethiopia-generic" },
      tokens,
      estates,
      opts,
    );
    const precise = scoreSourceRelevance(
      { title: "阿朵斯 水洗 咖啡豆冲煮参数", url: "https://roaster.example/adorsi" },
      tokens,
      estates,
      opts,
    );
    assert.equal(generic.kept, true, "国家级泛文保留但降级（零精确来源时仍可兜底）");
    assert.ok(
      precise.score - generic.score >= 6,
      `精确来源应明显领先（precise=${precise.score}, generic=${generic.score}）`,
    );
    // 未提取到庄园词时不降权（行为与旧版一致）
    const noEstate = scoreSourceRelevance(
      { title: "埃塞俄比亚咖啡品种有啥不同", url: "https://blog.example/ethiopia-generic" },
      beanTokens({ origin: "埃塞俄比亚", process: "水洗" }),
      [],
      { process: "水洗", originTokens: ["埃塞俄比亚"] },
    );
    assert.ok(noEstate.score > generic.score);
  });

  it("用户实测场景集成：截图 4 条来源——厌氧条被过滤，过滤数如实计入", () => {
    const pool = [
      { title: "埃塞俄比亚肯尼亚咖啡品种有啥不同，一篇看懂", url: "https://blog.example/1" },
      { title: "埃塞咖啡有几种口味 品牌 产区盘点", url: "https://blog.example/2" },
      { title: "埃塞耶加雪菲咖啡豆入门介绍", url: "https://blog.example/3" },
      { title: "2026 咖啡界最热话题！一个post教你6大厌氧发酵法", url: "https://blog.example/4" },
    ];
    const { kept, filtered } = filterRelevantSources(pool, adorsi);
    assert.ok(!kept.some((s) => s.title.includes("厌氧")), "处理法冲突来源必须被过滤");
    assert.equal(filtered, 1);
    assert.equal(kept.length, 3);
  });

  it("精确来源与厌氧泛文同池：filterRelevantSources 排序把精确来源排第一", () => {
    const pool = [
      { title: "埃塞俄比亚咖啡产区入门介绍", url: "https://blog.example/generic" },
      {
        title: "2026 咖啡界最热话题！一个post教你6大厌氧发酵法",
        url: "https://blog.example/anaerobic",
      },
      { title: "阿朵斯处理站 水洗批次冲煮分享", url: "https://xhs.example/adorsi" },
    ];
    const { kept, filtered } = filterRelevantSources(pool, adorsi);
    assert.equal(filtered, 1, "厌氧条被过滤");
    assert.equal(kept.length, 2);
    assert.ok(kept[0].title.includes("阿朵斯"), "庄园词精确来源排第一");
  });
});

describe("coffeeExcerpt 回退摘录", () => {
  it("仅保留含咖啡域词且足够长的段落", () => {
    const text = [
      "首页 导航 关于我们 联系方式",
      "这款肯尼亚咖啡豆建议研磨度中细，水温 92℃，粉水比 1:15 冲煮。",
      "无关的推荐位广告内容，与主题毫无关系的一段话。",
      "brewing recipe: grind medium-fine, 93C water.",
    ].join("\n");
    const excerpt = coffeeExcerpt(text);
    assert.ok(excerpt.includes("研磨度中细"));
    assert.ok(excerpt.includes("brewing recipe"));
    assert.ok(!excerpt.includes("导航"));
    assert.ok(!excerpt.includes("推荐位"));
  });

  it("无任何咖啡段落时返回空串", () => {
    assert.equal(
      coffeeExcerpt("完全无关的一段足够长的文本，内容涉及天气与新闻，没有任何领域词命中。"),
      "",
    );
  });
});

describe("researchBean 降级路径", () => {
  it("无豆信息时立即返回 ok:false（不触网、不发事件，filtered=0）", async () => {
    let emitted = 0;
    const outcome = await researchBean({}, () => {
      emitted += 1;
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.summaryText, "");
    assert.equal(outcome.sources.length, 0);
    assert.equal(outcome.filtered, 0);
    assert.equal(outcome.distilled, false);
    assert.equal(emitted, 0);
  });
});

describe("小红书 MCP 直连渠道（任务 #82）", () => {
  const realFetch = globalThis.fetch;

  /** 按序消费的 fetch 队列 mock：超出预期的请求直接报错（防漏测） */
  function mockFetchQueue(responses: Array<(url: string) => Response>): { calls: string[] } {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const next = responses.shift();
      if (!next) throw new Error(`意外的 fetch 调用：${url}`);
      return next(url);
    }) as typeof fetch;
    return { calls };
  }

  const mcpOk = (): Response => new Response("ok");
  const mcpInit = (): Response =>
    new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "xhs" } } }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  const mcpFeeds = (feeds: unknown[]): Response =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: JSON.stringify({ feeds, count: feeds.length }) }],
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  const mcpDetail = (desc: string): Response =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ desc, noteCard: { title: "深取笔记" } }) },
          ],
        },
      }),
      { headers: { "content-type": "application/json" } },
    );

  it("xhsMcpKeyword：剥离 site:xiaohongshu.com 前缀（大小写不敏感），保留主题词", () => {
    assert.equal(xhsMcpKeyword("site:xiaohongshu.com 花魁 冲煮参数"), "花魁 冲煮参数");
    assert.equal(
      xhsMcpKeyword("SITE:XIAOHONGSHU.COM 耶加雪菲 G1 冲煮参数"),
      "耶加雪菲 G1 冲煮参数",
    );
    assert.equal(xhsMcpKeyword("site:xiaohongshu.com"), "");
  });

  it("MCP 在线：路径 0 命中真实笔记结构（标题+链接，点赞最高一条深取补足正文 snippet）", async () => {
    const feeds = [
      {
        id: "note-a",
        xsecToken: "tok-a",
        noteCard: { displayTitle: "花魁冲煮日记", interactInfo: { likedCount: "3" } },
      },
      {
        id: "note-b",
        xsecToken: "tok-b",
        noteCard: { displayTitle: "保姆级分段萃取公式", interactInfo: { likedCount: "40" } },
      },
      { id: "缺标题被忽略", xsecToken: "tok-c", noteCard: {} },
    ];
    const { calls } = mockFetchQueue([
      () => mcpOk(), // /health
      () => mcpInit(), // initialize（search_feeds）
      () => mcpFeeds(feeds), // tools/call search_feeds
      () => mcpInit(), // initialize（get_feed_detail，点赞最高的 note-b）
      () => mcpDetail("粉水比 1:15，水温 92 度，三段式注水。"),
    ]);
    try {
      const outcome = await searchXiaohongshuDirected(
        "site:xiaohongshu.com 花魁 冲煮参数",
        new AbortController().signal,
      );
      assert.equal(outcome.via, "mcp");
      assert.equal(outcome.mcpOnline, true, "任务 #98：search_feeds 正常返回即证明连接建立");
      assert.equal(outcome.sources.length, 2);
      assert.ok(outcome.sources.every((s) => new URL(s.url).hostname.endsWith("xiaohongshu.com")));
      assert.ok(outcome.sources[0].url.includes("note-a"));
      // 点赞最高的 note-b 深取补足正文 snippet
      const deep = outcome.sources.find((s) => s.url.includes("note-b"));
      assert.ok(deep?.snippet?.includes("粉水比 1:15"));
      // 探活 + 两轮 JSON-RPC ×2（搜索与深取各一次 initialize+call）
      assert.equal(calls.filter((c) => c.includes("/health")).length, 1);
      assert.equal(calls.filter((c) => c.endsWith("/mcp")).length, 4);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("MCP 离线：探活失败静默回退 site: 透传/域名过滤路径（行为与任务 #76 一致）", async () => {
    mockFetchQueue([
      () => new Response("", { status: 503 }), // /health 非 2xx → 离线
      () =>
        new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        }), // SearXNG 零结果
      () => new Response("<html></html>"), // 百度零结果
      () => new Response("<html></html>"), // Bing 零结果
    ]);
    try {
      const outcome = await searchXiaohongshuDirected(
        "site:xiaohongshu.com 花魁 冲煮参数",
        new AbortController().signal,
      );
      assert.equal(outcome.via, "fallback");
      assert.deepEqual(outcome.sources, []);
      assert.equal(outcome.mcpOnline, false, "任务 #98：探活失败从未建立连接，不得宣称在线");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("MCP 报错：search_feeds 抛错时静默回退，不向上传播", async () => {
    mockFetchQueue([
      () => mcpOk(), // /health
      () => mcpInit(), // initialize
      () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 2, error: { message: "login required" } }),
          {
            headers: { "content-type": "application/json" },
          },
        ), // tools/call 报错
      () =>
        new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        }), // SearXNG 零结果
      () => new Response("<html></html>"), // 百度
      () => new Response("<html></html>"), // Bing
    ]);
    try {
      const outcome = await searchXiaohongshuDirected(
        "site:xiaohongshu.com 花魁 冲煮参数",
        new AbortController().signal,
      );
      assert.equal(outcome.via, "fallback");
      assert.deepEqual(outcome.sources, []);
      assert.equal(outcome.mcpOnline, false, "任务 #98：首个变体即报错，未成功建立过连接");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("已中止信号：不发起 MCP 调用，直接返回空（via=fallback）", async () => {
    mockFetchQueue([
      // 仅剩 SearXNG 一次探测（已中止信号下 fetch 立即抛错）
      () => {
        throw new Error("aborted");
      },
    ]);
    try {
      const outcome = await searchXiaohongshuDirected(
        "site:xiaohongshu.com 花魁 冲煮参数",
        AbortSignal.abort(),
      );
      assert.deepEqual(outcome.sources, []);
      assert.equal(outcome.via, "fallback");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("任务 #86/#102：xhsKeywordLadder 四档变体（庄园词→庄园词→产地+处理法→兜底放宽档）", () => {
    const ladder = xhsKeywordLadder({
      origin: "埃塞俄比亚-阿朵斯",
      process: "水洗",
      varietal: "原生种",
    });
    assert.deepEqual(ladder, ["阿朵斯 冲煮参数", "阿朵斯 手冲", "埃塞俄比亚 水洗 手冲"]);
    // 豆名优先于庄园词；放宽档剥离庄园/地块词避免窄词重复；兜底档与既有档重复时被去重消除
    const named = xhsKeywordLadder({ name: "花魁", origin: "埃塞俄比亚-阿朵斯", process: "日晒" });
    // 任务 #117：庄园词独立档——豆名≠庄园词时庄园词进入梯队（波切萨/阿贝格纳场景同款）
    assert.deepEqual(named, [
      "花魁 冲煮参数",
      "花魁 手冲",
      "阿朵斯 冲煮参数",
      "埃塞俄比亚 日晒 手冲",
    ]);
    // 任务 #102-P1：无 origin 时第三档无法构造，兜底放宽档（subject 首词+手冲）必须存在
    assert.deepEqual(xhsKeywordLadder({ name: "耶加雪菲 G1" }), [
      "耶加雪菲 G1 冲煮参数",
      "耶加雪菲 G1 手冲",
      "耶加雪菲 手冲",
    ]);
    assert.deepEqual(xhsKeywordLadder({}), []);
  });

  it("任务 #102-P1：长豆名/整句 origin 分词去重限词，不产生超长重复关键词（阿朵斯实测场景）", () => {
    // 实测缺陷：name=阿朵斯、origin=埃塞俄比亚-阿朵斯 整句、无 process 时
    // subject 拼成「阿朵斯 埃塞俄比亚 阿朵斯 水洗」式超长重复词令 MCP 挂死
    const ladder = xhsKeywordLadder({ name: "阿朵斯", origin: "埃塞俄比亚-阿朵斯" });
    assert.deepEqual(ladder, ["阿朵斯 冲煮参数", "阿朵斯 手冲", "埃塞俄比亚 手冲"]);
    // 豆名分词去重限词：重复词只留一份，最多前 3 个有效词
    assert.deepEqual(narrowSubjectTokens("阿朵斯 埃塞俄比亚 阿朵斯 水洗"), [
      "阿朵斯",
      "埃塞俄比亚",
      "水洗",
    ]);
    assert.deepEqual(narrowSubjectTokens("花魁 花魁 花魁 日晒 日晒"), ["花魁", "日晒"]);
    assert.deepEqual(narrowSubjectTokens("a b c d e"), ["a", "b", "c"]);
    assert.deepEqual(narrowSubjectTokens(undefined), []);
    // 多词豆名：兜底档用首词，放宽档不重复主题词（origin 词已在 subject 中时
    // 第三档被剥离后无法构造，由兜底档接手，不产生重复关键词）
    const multi = xhsKeywordLadder({
      name: "哥伦比亚 天堂庄园 双重发酵",
      origin: "哥伦比亚",
      process: "水洗",
    });
    assert.deepEqual(multi, [
      "哥伦比亚 天堂庄园 双重发酵 冲煮参数",
      "哥伦比亚 天堂庄园 双重发酵 手冲",
      "哥伦比亚 手冲",
    ]);
  });

  it("任务 #86：梯队首档零召回 → 次档命中即停（不再尝试后续变体）", async () => {
    const feeds = [
      {
        id: "note-a",
        xsecToken: "tok-a",
        noteCard: {
          displayTitle: "水洗埃塞手冲记录",
          interactInfo: { likedCount: "5" },
          desc: "粉水比 1:15",
        },
      },
    ];
    const { calls } = mockFetchQueue([
      () => mcpOk(), // /health
      () => mcpInit(),
      () => mcpFeeds([]), // 变体 1 零召回
      () => mcpInit(),
      () => mcpFeeds(feeds), // 变体 2 命中即停
    ]);
    try {
      const outcome = await searchXiaohongshuDirected(
        "site:xiaohongshu.com 阿朵斯 冲煮参数",
        new AbortController().signal,
        ["阿朵斯 冲煮参数", "阿朵斯 手冲", "埃塞俄比亚 水洗 手冲"],
      );
      assert.equal(outcome.via, "mcp");
      assert.equal(outcome.mcpOnline, true, "任务 #98：变体 2 正常返回即证明在线");
      assert.equal(outcome.mcpKeywordUsed, "阿朵斯 手冲", "如实记录命中变体");
      assert.deepEqual(outcome.mcpTried, ["阿朵斯 冲煮参数", "阿朵斯 手冲"]);
      assert.equal(outcome.sources.length, 1);
      assert.equal(calls.filter((c) => c.endsWith("/mcp")).length, 4, "两轮 RPC，未尝试第三变体");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("任务 #102-P2/#109：单变体超时置冷却并跳出梯队，仅多一次末档兜底（仍超时才降级），带尝试记录", async () => {
    // 场景 A：变体 1 执行超时 → 冷却 + 一次末档兜底（任务 #109-P4），兜底仍超时 → break，梯队其余变体不再发起
    const budgets = createResearchBudgets();
    mockFetchQueue([
      () => mcpOk(),
      () => {
        throw new Error("The operation was aborted due to timeout"); // 变体 1 执行超时
      },
      () => {
        throw new Error("The operation was aborted due to timeout"); // 兜底档（末档短词）也超时
      },
      () =>
        new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        }),
      () => new Response("<html></html>"),
      () => new Response("<html></html>"),
    ]);
    try {
      const a = await searchXiaohongshuDirected(
        "site:xiaohongshu.com 阿朵斯 冲煮参数",
        new AbortController().signal,
        ["阿朵斯 冲煮参数", "阿朵斯 手冲"],
        budgets,
      );
      assert.equal(a.via, "fallback", "超时后降级链照常执行");
      assert.deepEqual(
        a.mcpTried,
        ["阿朵斯 冲煮参数", "阿朵斯 手冲"],
        "超时后仅多一次末档兜底，梯队其余变体不尝试",
      );
      assert.equal(a.mcpSearchTimeout, true, "披露据此写「MCP 搜索执行超时」");
      assert.equal(a.mcpOnline, false);
      assert.equal(budgets.xhsMcpSearchCooled, true, "冷却标记由 ResearchBudgets 携带");
    } finally {
      globalThis.fetch = realFetch;
    }
    // 场景 B：同一调研内第二次调用已冷却 → 完全跳过 MCP（不探活不打 /mcp）直接降级
    const { calls: callsB } = mockFetchQueue([
      () =>
        new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        }),
      () => new Response("<html></html>"),
      () => new Response("<html></html>"),
    ]);
    try {
      const b = await searchXiaohongshuDirected(
        "site:xiaohongshu.com 阿朵斯 冲煮参数",
        new AbortController().signal,
        ["阿朵斯 冲煮参数", "阿朵斯 手冲"],
        budgets,
      );
      assert.equal(b.via, "fallback");
      assert.equal(b.mcpOnline, false);
      assert.equal(
        callsB.some((u) => u.includes("/health") || u.includes("/mcp")),
        false,
        "冷却后不得再发起任何 MCP 调用（服务端残留请求串行阻塞，连环超时只会拖垮预算）",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // 场景 C：冷却仅限本次调研——新建预算后 MCP 梯队恢复可用（零召回走降级，mcpTried 如实记录）
    mockFetchQueue([
      () => mcpOk(),
      () => mcpInit(),
      () => mcpFeeds([]),
      () => mcpInit(),
      () => mcpFeeds([]),
      () =>
        new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        }),
      () => new Response("<html></html>"),
      () => new Response("<html></html>"),
    ]);
    try {
      const c = await searchXiaohongshuDirected(
        "site:xiaohongshu.com 阿朵斯 冲煮参数",
        new AbortController().signal,
        ["阿朵斯 冲煮参数", "阿朵斯 手冲"],
        createResearchBudgets(),
      );
      assert.equal(c.via, "fallback");
      assert.deepEqual(c.sources, []);
      assert.equal(
        c.mcpOnline,
        true,
        "任务 #98：零召回但连接成功建立 → 披露可用「MCP 在线但零召回」措辞",
      );
      assert.deepEqual(c.mcpTried, ["阿朵斯 冲煮参数", "阿朵斯 手冲"], "尝试记录供总结如实披露");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("任务 #86：登录失效报错时跳出梯队（不重试后续变体）", async () => {
    mockFetchQueue([
      () => mcpOk(),
      () => mcpInit(),
      () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 2, error: { message: "login required" } }),
          {
            headers: { "content-type": "application/json" },
          },
        ),
      () =>
        new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        }),
      () => new Response("<html></html>"),
      () => new Response("<html></html>"),
    ]);
    try {
      const outcome = await searchXiaohongshuDirected(
        "site:xiaohongshu.com 阿朵斯 冲煮参数",
        new AbortController().signal,
        ["阿朵斯 冲煮参数", "阿朵斯 手冲", "埃塞俄比亚 水洗 手冲"],
      );
      assert.equal(outcome.loginExpired, true);
      assert.equal(outcome.mcpOnline, false, "任务 #98：首次调用即报登录失效，未成功建立过连接");
      assert.deepEqual(outcome.mcpTried, ["阿朵斯 冲煮参数"], "登录失效后不重试后续变体");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("任务 #98/#102/#109：首个变体执行超时 → 冷却 + 一次末档兜底，mcpOnline===false 且 mcpSearchTimeout===true（披露不宣称在线）", async () => {
    const budgets = createResearchBudgets();
    mockFetchQueue([
      () => mcpOk(), // /health 在线
      () => {
        throw new Error("The operation was aborted due to timeout"); // 变体 1 执行超时
      },
      () => {
        throw new Error("The operation was aborted due to timeout"); // 任务 #109-P4：兜底档也超时
      },
      () =>
        new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        }), // SearXNG 零结果
      () => new Response("<html></html>"), // 百度
      () => new Response("<html></html>"), // Bing
    ]);
    try {
      const outcome = await searchXiaohongshuDirected(
        "site:xiaohongshu.com 花魁 冲煮参数",
        new AbortController().signal,
        ["花魁 冲煮参数", "花魁 手冲"],
        budgets,
      );
      assert.equal(outcome.via, "fallback");
      assert.equal(outcome.mcpOnline, false, "从未有一次 MCP 调用成功建立连接");
      assert.equal(
        outcome.mcpSearchTimeout,
        true,
        "披露据此写「MCP 搜索执行超时」而非「连接超时/报错」",
      );
      assert.deepEqual(outcome.mcpTried, ["花魁 冲煮参数", "花魁 手冲"], "冷却后仅多一次末档兜底");
      assert.equal(budgets.xhsMcpSearchCooled, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("任务 #98：researchBean 失败出口透传 xhsLoginExpired", () => {
  const realFetch = globalThis.fetch;

  it("MCP 报登录过期后调研走失败出口：outcome.xhsLoginExpired===true 且 message 含重新扫码提示", async () => {
    // 路由式 mock：MCP 登录过期 + 全渠道零召回，逼 researchBean 走到 fail("未找到公开资料") 出口
    let mcpRpc = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response("ok"); // MCP 探活在线
      if (url.endsWith("/mcp")) {
        mcpRpc += 1;
        if (mcpRpc % 2 === 1) {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "xhs" } } }),
            {
              headers: { "content-type": "application/json" },
            },
          ); // initialize
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 2, error: { message: "login required" } }),
          {
            headers: { "content-type": "application/json" },
          },
        ); // tools/call 报登录过期
      }
      if (url === `${config.searxngUrl}/`) return new Response("ok"); // SearXNG liveness 在线
      if (url.startsWith(`${config.searxngUrl}/search`)) {
        return new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("<html></html>"); // 百度/Bing/DDG 全部零结果
    }) as typeof fetch;
    try {
      const outcome = await researchBean({ name: "花魁" });
      assert.equal(outcome.ok, false, "全渠道零召回应走失败出口");
      assert.equal(
        outcome.xhsLoginExpired,
        true,
        "失败出口必须透传 xhsLoginExpired（任务 #98 Critical）",
      );
      assert.ok(
        outcome.message.includes("小红书登录已过期"),
        `message 缺少过期提示：${outcome.message}`,
      );
      assert.ok(
        outcome.message.includes("重新扫码"),
        `message 缺少重新扫码指引：${outcome.message}`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("Reddit 领域护栏（任务 #86）", () => {
  it("redditSubOf：从 URL 路径提取版块名（大小写不敏感，非法 URL 空串）", () => {
    assert.equal(redditSubOf("https://www.reddit.com/r/pourover/comments/abc/"), "pourover");
    assert.equal(
      redditSubOf("https://old.reddit.com/r/JamesHoffmann/comments/x/"),
      "jameshoffmann",
    );
    assert.equal(redditSubOf("https://reddit.com/"), "");
    assert.equal(redditSubOf("not-a-url"), "");
  });

  it("isRedditCoffeeRelevant：鸡尾酒帖拒绝（含 brew 泛词也不算）", () => {
    // 用户实测混入的来源：r/cocktails 鸡尾酒食谱，仅靠域名过滤拦不住
    const cocktail = {
      title: "鸡尾酒食谱大全",
      url: "https://www.reddit.com/r/cocktails/comments/abc/",
      snippet: "home brew recipe with rum",
    };
    assert.equal(isRedditCoffeeRelevant(cocktail), false);
    // 英文反信号词：espresso martini 也是鸡尾酒（即使含 espresso）
    const martini = {
      title: "Best espresso martini cocktail?",
      url: "https://www.reddit.com/r/cocktails/comments/x/",
    };
    assert.equal(isRedditCoffeeRelevant(martini), false);
    // brew 泛词单独出现不足以通过（非咖啡版块、无咖啡强信号词）
    const brewOnly = {
      title: "my brew ratio attempts",
      url: "https://www.reddit.com/r/something/comments/y/",
    };
    assert.equal(isRedditCoffeeRelevant(brewOnly), false);
  });

  it("isRedditCoffeeRelevant：咖啡版块直接放行；非咖啡版块需强信号词", () => {
    // r/pourover 帖标题未必含咖啡词（版块即领域承诺）
    assert.equal(
      isRedditCoffeeRelevant({
        title: "新手求推荐器具",
        url: "https://www.reddit.com/r/pourover/comments/a/",
      }),
      true,
    );
    assert.equal(
      isRedditCoffeeRelevant({
        title: " weekly chat ",
        url: "https://www.reddit.com/r/Coffee/comments/b/",
      }),
      true,
    );
    // 非咖啡版块但标题/snippet 含咖啡强信号词 → 放行
    assert.equal(
      isRedditCoffeeRelevant({
        title: "V60 recipe?",
        url: "https://www.reddit.com/r/AskUK/comments/c/",
        snippet: "pour over",
      }),
      true,
    );
    assert.equal(
      isRedditCoffeeRelevant({
        title: "手冲研磨求教",
        url: "https://www.reddit.com/r/China/comments/d/",
      }),
      true,
    );
  });

  it("filterRedditCoffeeSources：域名 + 领域双重过滤（仿冒域名与非咖啡帖都丢弃）", () => {
    const pool = [
      {
        title: "鸡尾酒食谱",
        url: "https://www.reddit.com/r/cocktails/comments/a/",
        snippet: "brew it",
      },
      { title: "V60 recipe?", url: "https://www.reddit.com/r/pourover/comments/b/" },
      { title: "无领域词闲聊", url: "https://www.reddit.com/r/gaming/comments/c/" },
      { title: "咖啡冲煮", url: "https://reddit.com.evil.com/fake" },
      { title: "coffee brew guide", url: "https://old.reddit.com/r/espresso/comments/d/" },
    ];
    const kept = filterRedditCoffeeSources(pool);
    assert.equal(kept.length, 2);
    assert.ok(kept.every((s) => new URL(s.url).hostname.endsWith("reddit.com")));
    assert.ok(kept.some((s) => s.title.includes("V60")));
    assert.ok(kept.some((s) => s.url.includes("old.reddit.com")));
  });
});

describe("Firecrawl 有限接入（任务 #85）", () => {
  const realFetch = globalThis.fetch;
  const realKey = config.firecrawlApiKey;
  const realEnabled = config.firecrawlEnabled;

  interface Call {
    url: string;
    init?: RequestInit;
  }
  /** 按 URL 路由的 fetch mock，记录每次 url+init（供请求头断言）；超出预期返回 404 */
  function mockFetch(responder: (url: string, init?: RequestInit) => Response): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return responder(url, init);
    }) as typeof fetch;
    return calls;
  }
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fcScrapeOk = (markdown: string): Response => json({ success: true, data: { markdown } });
  const fcSearchOk = (items: unknown[]): Response => json({ success: true, data: { web: items } });

  it("isCloudflareChallenge：Just a moment / Checking your browser 壳页特征命中（任意状态码）", () => {
    assert.equal(isCloudflareChallenge(200, "<title>Just a moment...</title>"), true);
    assert.equal(isCloudflareChallenge(200, "Checking your browser before accessing"), true);
    assert.equal(isCloudflareChallenge(403, "Attention Required! | Cloudflare"), true);
  });

  it("isCloudflareChallenge：403/503 + Cloudflare 指纹命中；无指纹的 403 与正常页不命中", () => {
    assert.equal(isCloudflareChallenge(403, "<html>error code: 1020 cf-ray:abc</html>"), true);
    assert.equal(isCloudflareChallenge(503, "server: cloudflare"), true);
    // 403 但非 CF（普通拒绝页）→ 不命中
    assert.equal(isCloudflareChallenge(403, "<html><body>Forbidden</body></html>"), false);
    // 200 正常咖啡正文 → 不命中
    assert.equal(
      isCloudflareChallenge(200, "# V60 recipe\nGrind medium-fine, 93C water, pour over."),
      false,
    );
  });

  it("isFirecrawlBenefitDomain：home-barista.com 及子域命中，仿冒/其他域名不命中", () => {
    assert.equal(isFirecrawlBenefitDomain("https://www.home-barista.com/pour-over/t1.html"), true);
    assert.equal(isFirecrawlBenefitDomain("https://home-barista.com/"), true);
    // 仿冒域名（后缀不匹配）与其他域名不命中；非法 URL 返回 false
    assert.equal(isFirecrawlBenefitDomain("https://home-barista.com.evil.com/x"), false);
    assert.equal(isFirecrawlBenefitDomain("https://blog.example/home-barista"), false);
    assert.equal(isFirecrawlBenefitDomain("not-a-url"), false);
  });

  it("parseFirecrawlSearchResults：实测 data.web 结构解析 url/title/description，非法输入空数组", () => {
    // 实测真实结构：data 为对象，web 数组（{ url, title, description, position }）
    const results = parseFirecrawlSearchResults({
      success: true,
      data: {
        web: [
          {
            url: "https://www.home-barista.com/pour-over/t1.html",
            title: "V60 technique",
            description: "Grind fine, 93C water.",
            position: 1,
          },
          { url: "javascript:alert(1)", title: "非法协议" },
          { title: "缺 url" },
          null,
        ],
      },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].url, "https://www.home-barista.com/pour-over/t1.html");
    assert.ok(results[0].title.includes("V60 technique"));
    assert.equal(results[0].snippet, "Grind fine, 93C water.");
    // 兼容 data 直接为数组与 results 字段两种变体
    assert.equal(
      parseFirecrawlSearchResults({ data: [{ url: "https://a.example/", title: "A" }] }).length,
      1,
    );
    assert.equal(
      parseFirecrawlSearchResults({ results: [{ url: "https://a.example/", title: "A" }] }).length,
      1,
    );
    assert.deepEqual(parseFirecrawlSearchResults(null), []);
    assert.deepEqual(parseFirecrawlSearchResults({}), []);
  });

  it("keyless：不带 Authorization 头；有 key：Bearer 认证（请求头断言）", async () => {
    let budgets = createResearchBudgets();
    // keyless
    config.firecrawlApiKey = "";
    const keylessCalls = mockFetch(() => fcScrapeOk("# body"));
    try {
      await firecrawlScrape(
        "https://www.home-barista.com/x",
        new AbortController().signal,
        budgets,
      );
      const h = (keylessCalls[0].init?.headers ?? {}) as Record<string, string>;
      assert.equal(h.authorization, undefined, "keyless 不应带 Authorization 头");
      assert.equal(h["content-type"], "application/json");
    } finally {
      globalThis.fetch = realFetch;
    }
    // 有 key
    budgets = createResearchBudgets();
    config.firecrawlApiKey = "fc-test-key";
    const keyedCalls = mockFetch(() => fcScrapeOk("# body"));
    try {
      await firecrawlScrape(
        "https://www.home-barista.com/x",
        new AbortController().signal,
        budgets,
      );
      const h = (keyedCalls[0].init?.headers ?? {}) as Record<string, string>;
      assert.equal(h.authorization, "Bearer fc-test-key");
    } finally {
      globalThis.fetch = realFetch;
      config.firecrawlApiKey = realKey;
    }
  });

  it("firecrawlScrape：成功取 data.markdown 作正文；非 2xx/空正文静默返回空串不抛错", async () => {
    let budgets = createResearchBudgets();
    config.firecrawlEnabled = true;
    mockFetch(() => fcScrapeOk("# V60\nGrind medium-fine, 93C, pour over."));
    try {
      const md = await firecrawlScrape(
        "https://www.home-barista.com/x",
        new AbortController().signal,
        budgets,
      );
      assert.ok(md.includes("Grind medium-fine"));
    } finally {
      globalThis.fetch = realFetch;
    }
    // 非 2xx
    budgets = createResearchBudgets();
    mockFetch(() => json({ error: "rate limited" }, 429));
    try {
      assert.equal(
        await firecrawlScrape(
          "https://www.home-barista.com/x",
          new AbortController().signal,
          budgets,
        ),
        "",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // 开关关闭 → 直接空串，不发起请求
    budgets = createResearchBudgets();
    config.firecrawlEnabled = false;
    const off = mockFetch(() => fcScrapeOk("# body"));
    try {
      assert.equal(
        await firecrawlScrape(
          "https://www.home-barista.com/x",
          new AbortController().signal,
          budgets,
        ),
        "",
      );
      assert.equal(off.length, 0, "开关关闭时不应发起请求");
    } finally {
      globalThis.fetch = realFetch;
      config.firecrawlEnabled = realEnabled;
    }
  });

  it("任务 #98：预算是局部对象——两份独立预算互不清零（并发调研隔离）", async () => {
    config.firecrawlEnabled = true;
    const budgetsA = createResearchBudgets();
    const budgetsB = createResearchBudgets();
    mockFetch(() => fcScrapeOk("# body"));
    try {
      const sig = new AbortController().signal;
      // A 耗尽自己的 scrape 预算
      assert.notEqual(await firecrawlScrape("https://www.home-barista.com/a1", sig, budgetsA), "");
      assert.notEqual(await firecrawlScrape("https://www.home-barista.com/a2", sig, budgetsA), "");
      assert.equal(
        await firecrawlScrape("https://www.home-barista.com/a3", sig, budgetsA),
        "",
        "A 预算耗尽",
      );
      // B 不受 A 影响（旧模块级实现里 B 会被 A 的耗尽/reset 波及）
      assert.notEqual(await firecrawlScrape("https://www.home-barista.com/b1", sig, budgetsB), "");
      assert.notEqual(await firecrawlScrape("https://www.home-barista.com/b2", sig, budgetsB), "");
      assert.equal(budgetsA.fcScrape, 0);
      assert.equal(budgetsB.fcScrape, 0);
      assert.equal(budgetsA.fcScrapeUsed, 2);
      assert.equal(budgetsB.fcScrapeUsed, 2);
    } finally {
      globalThis.fetch = realFetch;
      config.firecrawlEnabled = realEnabled;
    }
  });

  it("预算护栏：scrape/search 各 ≤2 次，超限静默停用（不再发起请求）", async () => {
    let budgets = createResearchBudgets();
    config.firecrawlEnabled = true;
    const scrapeCalls = mockFetch(() => fcScrapeOk("# body"));
    try {
      const sig = new AbortController().signal;
      assert.notEqual(await firecrawlScrape("https://www.home-barista.com/1", sig, budgets), "");
      assert.notEqual(await firecrawlScrape("https://www.home-barista.com/2", sig, budgets), "");
      assert.equal(
        await firecrawlScrape("https://www.home-barista.com/3", sig, budgets),
        "",
        "第 3 次 scrape 应被预算拦下",
      );
      assert.equal(scrapeCalls.length, 2, "仅发起 2 次 scrape 请求");
    } finally {
      globalThis.fetch = realFetch;
    }
    budgets = createResearchBudgets();
    const searchCalls = mockFetch(() =>
      fcSearchOk([{ url: "https://a.example/", title: "A brew" }]),
    );
    try {
      const sig = new AbortController().signal;
      assert.equal((await firecrawlSearch("q1", sig, budgets)).length, 1);
      assert.equal((await firecrawlSearch("q2", sig, budgets)).length, 1);
      assert.deepEqual(
        await firecrawlSearch("q3", sig, budgets),
        [],
        "第 3 次 search 应被预算拦下",
      );
      assert.equal(searchCalls.length, 2, "仅发起 2 次 search 请求");
    } finally {
      globalThis.fetch = realFetch;
      config.firecrawlEnabled = realEnabled;
    }
  });

  it("search 备援：SearXNG 在线时绝不触发 Firecrawl（省 credits）", async () => {
    const budgets = createResearchBudgets();
    config.firecrawlEnabled = true;
    let firecrawlHit = false;
    mockFetch((url) => {
      if (url === `${config.searxngUrl}/`) return new Response("ok", { status: 200 }); // liveness 在线
      if (url.startsWith(`${config.searxngUrl}/search`))
        return json({
          results: [{ url: "https://brew.example/guide", title: "手冲咖啡冲煮指南" }],
        });
      if (url.includes("api.firecrawl.dev")) {
        firecrawlHit = true;
        return fcSearchOk([]);
      }
      return new Response("", { status: 404 });
    });
    try {
      const results = await searchWeb("花魁 手冲", new AbortController().signal, budgets);
      assert.ok(results.length >= 1);
      assert.ok(results[0].url.includes("brew.example"));
      assert.equal(firecrawlHit, false, "SearXNG 在线时不得调用 Firecrawl search");
    } finally {
      globalThis.fetch = realFetch;
      config.firecrawlEnabled = realEnabled;
    }
  });

  it("search 备援：SearXNG 离线（liveness 探测失败）时转投 Firecrawl search", async () => {
    const budgets = createResearchBudgets();
    config.firecrawlEnabled = true;
    let firecrawlHit = false;
    mockFetch((url) => {
      if (url === `${config.searxngUrl}/`) throw new Error("ECONNREFUSED"); // liveness 失败 → 离线
      if (url.includes("api.firecrawl.dev/v2/search")) {
        firecrawlHit = true;
        return fcSearchOk([
          {
            url: "https://www.home-barista.com/pour-over/t1.html",
            title: "V60 brew recipe",
            description: "coffee pour over",
          },
        ]);
      }
      return new Response("", { status: 404 });
    });
    try {
      const results = await searchWeb("home-barista V60", new AbortController().signal, budgets);
      assert.equal(firecrawlHit, true, "SearXNG 离线时应调用 Firecrawl search");
      assert.ok(results.length >= 1);
      assert.ok(results[0].url.includes("home-barista.com"));
    } finally {
      globalThis.fetch = realFetch;
      config.firecrawlEnabled = realEnabled;
    }
  });
});

describe("任务 #101：小红书定向渠道在总时间盒内必然获得执行机会", () => {
  const realFetch = globalThis.fetch;

  /** 挂起请求直到 signal 中止（模拟前序渠道慢耗时间预算）；无 signal 时立即报错防测试死锁 */
  function hangUntilAbort(signal: AbortSignal | undefined): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) {
        reject(new Error("挂起请求缺少 signal（测试防死锁）"));
        return;
      }
      if (signal.aborted) {
        reject(new Error("The operation was aborted."));
        return;
      }
      const timer = setTimeout(() => reject(new Error("挂起超过 30s（测试不应到达此处）")), 30_000);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("The operation was aborted."));
        },
        { once: true },
      );
    });
  }

  const mcpInit = (): Response =>
    new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "xhs" } } }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  const mcpFeeds = (feeds: unknown[]): Response =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: JSON.stringify({ feeds, count: feeds.length }) }],
        },
      }),
      { headers: { "content-type": "application/json" } },
    );

  it("前序渠道全部挂起耗尽总盒 → 小红书定向仍被执行（并行分支 MCP 直连命中）", async () => {
    const calls: string[] = [];
    let mcpRpc = 0;
    const feeds = [
      {
        id: "note-a",
        xsecToken: "tok-a",
        noteCard: {
          displayTitle: "阿朵斯水洗手冲记录",
          interactInfo: { likedCount: "12" },
          desc: "粉水比 1:15，水温 92 度，三段式注水，咖啡风味明亮",
        },
      },
    ];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith(config.xhsMcpUrl)) {
        if (url.endsWith("/health")) return new Response("ok"); // MCP 在线
        mcpRpc += 1;
        return mcpRpc % 2 === 1 ? mcpInit() : mcpFeeds(feeds); // initialize → tools/call
      }
      return hangUntilAbort(init?.signal); // 其余所有渠道（SearXNG/百度/Bing/Firecrawl/LLM）挂起
    }) as typeof fetch;
    try {
      const started = Date.now();
      const outcome = await researchBean(
        { name: "阿朵斯", origin: "埃塞俄比亚-阿朵斯", process: "水洗" },
        undefined,
        undefined,
        { totalTimeoutMs: 2500 }, // 缩短总盒便于测试；前序渠道必然耗尽它
      );
      const elapsed = Date.now() - started;
      assert.ok(
        mcpRpc >= 2,
        `小红书 MCP 应完成 initialize+tools/call（实际 ${mcpRpc} 次 /mcp 调用）——被执行而非被饿死`,
      );
      assert.equal(outcome.ok, true, "小红书并行分支命中，调研应成功");
      assert.ok(
        outcome.sources.some((s) => s.url.includes("xiaohongshu.com")),
        "来源应含小红书笔记",
      );
      assert.ok(outcome.summaryText.includes("小红书笔记（MCP 直连）"), "披露如实：MCP 直连命中");
      assert.ok(elapsed < 15_000, `应按缩短的总盒及时返回（实际 ${elapsed}ms）`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("前序渠道挂起 + MCP 离线 → 定向降级路径仍被执行，超时后如实降级不伪造来源", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === `${config.xhsMcpUrl}/health`) return new Response("", { status: 503 }); // MCP 离线
      return hangUntilAbort(init?.signal); // 其余全部挂起
    }) as typeof fetch;
    try {
      const outcome = await researchBean(
        { name: "阿朵斯", origin: "埃塞俄比亚-阿朵斯", process: "水洗" },
        undefined,
        undefined,
        { totalTimeoutMs: 2500 },
      );
      assert.equal(outcome.ok, false);
      assert.ok(outcome.message.includes("联网调研超时"));
      assert.equal(outcome.summaryText, "", "失败路径不伪造摘要");
      // 关键断言：小红书定向降级路径（SearXNG site: 透传）确实被发起过
      // （旧缺陷：前序渠道耗尽总盒后此调用从不出现）
      assert.ok(
        calls.some((u) => u.startsWith(`${config.searxngUrl}/search`) && u.includes("xiaohongshu")),
        "小红书定向查询应在总盒开启时即被发起",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("回归：池满短路（≥12 条来源）行为不变——低层查询不执行，小红书定向仍照常执行并如实披露", async () => {
    const calls: string[] = [];
    const baiduQueries: string[] = [];
    const searxngQueries: string[] = [];
    // 每条查询返回 6 条 URL 互不相同、标题差异度足够大的结果（按查询序号隔离），
    // 否则入池 URL 去重会让池永远填不满、短路永不触发；标题不可近重复，
    // 否则任务 #102-P3 标题相似度去重会拦下（保留先入者）
    let baiduSeq = 0;
    const topics = [
      "手冲粉水比调整笔记",
      "研磨度与萃取率实测",
      "冲煮水温对风味的影响",
      "手冲三段式注水手法解析",
      "手冲闷蒸时间对比实验",
      "咖啡滤杯材质差异评测",
      "咖啡冲煮水质与 TDS 关系",
      "手冲流速控制心得",
      "咖啡浅烘萃取策略",
      "咖啡日晒处理法记录",
      "手冲滤纸滤网对比",
      "手冲咖啡入门心得",
    ];
    const baiduPage = (): Response => {
      baiduSeq += 1;
      const seq = baiduSeq;
      const items = Array.from({ length: 6 }, (_, i) => {
        const title = topics[((seq - 1) * 6 + i) % topics.length];
        return `<h3 class="t"><a href="https://www.example.com/huakui/${seq}/${i}">${title}</a></h3>`;
      }).join("");
      return new Response(`<html><body>${items}</body></html>`);
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === `${config.xhsMcpUrl}/health`) return new Response("", { status: 503 }); // MCP 离线，走降级路径
      if (url === `${config.searxngUrl}/`) return new Response("ok"); // SearXNG liveness 在线
      if (url.startsWith(`${config.searxngUrl}/search`)) {
        searxngQueries.push(new URL(url).searchParams.get("q") ?? "");
        return new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        }); // 零结果 → 普通查询回退百度
      }
      if (url.startsWith("https://www.baidu.com/s?")) {
        const wd = new URL(url).searchParams.get("wd") ?? "";
        baiduQueries.push(wd);
        if (wd.includes("小红书")) return new Response("<html></html>"); // 定向降级普通查询零召回
        return baiduPage(); // 每条 Tier 查询返回 6 条 → 两条即池满 12
      }
      if (url.startsWith("https://www.example.com/")) {
        return new Response(
          "<html><body><p>手冲咖啡冲煮参数 粉水比 1:15 水温 92 度研磨中细</p></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.includes("/chat/completions")) return new Response("", { status: 500 }); // 提炼失败 → 回退摘录
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const outcome = await researchBean(
        {
          name: "云间庄园 花魁",
          roaster: "M2M",
          origin: "埃塞俄比亚",
          process: "日晒",
          varietal: "Heirloom",
        },
        undefined,
        undefined,
        { totalTimeoutMs: 20_000 },
      );
      assert.equal(outcome.ok, true);
      assert.ok(outcome.sources.length >= 1);
      // 池满短路：Tier1 + Tier2 首条即填满 12 条，低层查询（Tier2 次条/Tier3/Reddit/Tier4）不执行
      assert.equal(
        baiduQueries.filter((q) => !q.includes("小红书")).length,
        2,
        `池满短路后仅应执行两条普通查询，实际：${baiduQueries.join(" | ")}`,
      );
      assert.ok(baiduQueries.some((q) => q.includes("云间庄园 M2M 冲煮参数")));
      assert.ok(baiduQueries.some((q) => q.includes("咖啡豆 冲煮建议")));
      assert.ok(!baiduQueries.some((q) => q.includes("埃塞俄比亚")), "Tier4 国家级兜底不应被执行");
      assert.ok(
        !calls.some((u) => u.includes("cn.bing.com") && !decodeURIComponent(u).includes("小红书")),
        "池满后非小红书定向路径的 Bing 兜底不应被执行（小红书定向降级链百度零召回时试 Bing 属正常行为）",
      );
      assert.ok(!searxngQueries.some((q) => q.includes("reddit")), "池满后 Reddit 定向不应被执行");
      assert.ok(
        !searxngQueries.some((q) => q.includes("brew recipe")),
        "池满后 Tier3 英文查询不应被执行",
      );
      // 小红书定向不受池满短路影响：降级路径（SearXNG site: 透传 + 百度普通查询）照常执行
      assert.ok(
        searxngQueries.some((q) => q.includes("site:xiaohongshu.com")),
        "小红书 site: 定向应被执行",
      );
      assert.ok(
        baiduQueries.some((q) => q.includes("小红书")),
        "小红书降级普通查询应被执行",
      );
      // 披露如实：执行了但零召回（xhsNote 零召回/降级措辞，不伪造来源）
      assert.ok(outcome.summaryText.includes("小红书定向检索"), "零召回时如实披露小红书定向受限");
      assert.ok(!outcome.summaryText.includes("xiaohongshu.com/explore"), "未伪造小红书来源链接");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("任务 #102-P2：国别一致性校验（产地张冠李戴修复）", () => {
  it("冲突国为标题主题 → 强降权，总分不达标即过滤（哥伦比亚豆遇玻利维亚笔记）", () => {
    const src: ResearchSource = {
      title: "玻利维亚瓦利基手冲冲煮参数",
      url: "https://www.xiaohongshu.com/explore/note1",
    };
    const r = scoreSourceRelevance(src, beanTokens({ name: "阿朵斯", origin: "哥伦比亚" }), [], {
      origin: "哥伦比亚",
    });
    assert.equal(r.originMismatch, true, "冲突来源被标记供披露");
    assert.equal(
      r.kept,
      false,
      "小红书域名直接保留也被国别冲突过滤覆盖（实测缺陷：同类笔记被保留 3 条）",
    );
  });

  it("标题同时提及豆国与冲突国（对比/综述文）→ 中等降权不判死刑", () => {
    const src: ResearchSource = {
      title: "哥伦比亚与玻利维亚手冲咖啡对比",
      url: "https://example.com/x",
    };
    const r = scoreSourceRelevance(src, ["阿朵斯"], [], { origin: "哥伦比亚" });
    assert.ok(r.kept, "混合提及不判死刑（同 PROCESS_GROUPS 混合模式）");
    assert.equal(r.originMismatch, undefined);
  });

  it("仅摘要提及冲突国 → 降权但保留并标记 originMismatch（披露提示交叉验证）", () => {
    const src: ResearchSource = {
      title: "阿朵斯手冲冲煮参数分享",
      url: "https://example.com/y",
      snippet: "这支玻利维亚瓦利基的豆子风味不错",
    };
    const r = scoreSourceRelevance(src, beanTokens({ name: "阿朵斯", origin: "哥伦比亚" }), [], {
      origin: "哥伦比亚",
    });
    assert.ok(r.kept, "摘要提及不判死刑");
    assert.equal(r.originMismatch, true);
  });

  it("产地一致或未提供 origin 时不受影响（向后兼容）", () => {
    const src: ResearchSource = { title: "哥伦比亚手冲咖啡冲煮记录", url: "https://example.com/z" };
    const withOrigin = scoreSourceRelevance(
      src,
      beanTokens({ name: "阿朵斯", origin: "哥伦比亚" }),
      [],
      {
        origin: "哥伦比亚",
      },
    );
    const without = scoreSourceRelevance(
      src,
      beanTokens({ name: "阿朵斯", origin: "哥伦比亚" }),
      [],
      {},
    );
    assert.equal(withOrigin.score, without.score, "产地一致时不降权");
    assert.equal(withOrigin.originMismatch, undefined);
  });

  it("filterRelevantSources 返回 originMismatches，且过滤确定性（同分同源同行为，同分保持输入顺序）", () => {
    const input = { name: "花魁", origin: "埃塞俄比亚", process: "日晒" };
    const sources: ResearchSource[] = [
      { title: "手冲咖啡冲煮记录甲", url: "https://example.com/a" },
      { title: "手冲咖啡冲煮记录乙", url: "https://example.com/b" },
      { title: "玻利维亚瓦利基手冲冲煮参数", url: "https://www.xiaohongshu.com/explore/c" },
      {
        title: "花魁日晒手冲分享",
        url: "https://example.com/d",
        snippet: "肯尼亚同款处理法也适用",
      },
    ];
    const r1 = filterRelevantSources(sources, input);
    const r2 = filterRelevantSources(sources, input);
    assert.deepEqual(r1, r2, "同输入必同输出（无随机/时间依赖）");
    assert.deepEqual(r1.originMismatches, ["花魁日晒手冲分享"], "摘要冲突国来源被标记");
    assert.ok(!r1.kept.some((s) => s.url.includes("/c")), "标题级国别冲突低分来源被过滤");
    assert.equal(r1.filtered, 1);
  });
});

describe("任务 #102-P3：标题近重复去重与跳转链接降权", () => {
  it("titleSimilarity：相等=1、包含按长度比、SEO 近重复 >0.8、不同主题 <0.8", () => {
    assert.equal(titleSimilarity("阿朵斯手冲冲煮参数", "阿朵斯手冲冲煮参数"), 1);
    assert.ok(
      titleSimilarity("阿朵斯手冲", "阿朵斯手冲冲煮参数详解") > 0.4,
      "包含关系按短/长长度比计相似度",
    );
    // 实测缺陷：波切萨两条同基址不同后缀百度 SEO 页标题近重复
    assert.ok(
      titleSimilarity(
        "阿朵斯咖啡手冲冲煮参数推荐冲煮指南",
        "阿朵斯咖啡手冲冲煮参数推荐冲煮指南 - 咖啡百科",
      ) > 0.8,
    );
    assert.ok(titleSimilarity("花魁日晒处理记录", "肯尼亚 AA 手冲方案") < 0.8);
  });

  it("dedupeSourcesByTitle：保留先入者，后到近重复丢弃", () => {
    const out = dedupeSourcesByTitle([
      { title: "阿朵斯咖啡手冲冲煮参数指南", url: "https://a.example.com/1" },
      { title: "阿朵斯咖啡手冲冲煮参数指南 - 百科", url: "https://a.example.com/1?p=2" },
      { title: "花魁日晒处理记录", url: "https://b.example.com/2" },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].url, "https://a.example.com/1", "先入者保留");
    assert.equal(out[1].url, "https://b.example.com/2");
  });

  it("isRedirectLinkSource：baidu.com/link、ddg /l/、bing /ck/a 命中；正常页/仿冒域名不命中", () => {
    assert.ok(isRedirectLinkSource("https://www.baidu.com/link?url=abc"));
    assert.ok(isRedirectLinkSource("https://duckduckgo.com/l/?uddg=x"));
    assert.ok(isRedirectLinkSource("https://www.bing.com/ck/a?u=x"));
    assert.ok(!isRedirectLinkSource("https://www.baidu.com/s?wd=咖啡"));
    assert.ok(!isRedirectLinkSource("https://baidu.com.evil.com/link?url=x"));
    assert.ok(!isRedirectLinkSource("不是 URL"));
  });

  it("跳转链接来源仅降权不硬删（避免误杀）", () => {
    const plain = scoreSourceRelevance(
      { title: "手冲咖啡冲煮记录", url: "https://example.com/a" },
      [],
    );
    const redirect = scoreSourceRelevance(
      { title: "手冲咖啡冲煮记录", url: "https://www.baidu.com/link?url=x" },
      [],
    );
    assert.equal(redirect.score, plain.score - 3, "降权 3 分");
    assert.equal(redirect.kept, plain.kept, "保留状态不变（不硬删）");
  });

  it("isXhsSearchTimeoutError：识别超时，不误判登录失效/一般报错", () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    assert.ok(isXhsSearchTimeoutError(timeoutErr));
    assert.ok(isXhsSearchTimeoutError(new Error("request timed out")));
    assert.ok(!isXhsSearchTimeoutError(new Error("login required")));
    assert.ok(!isXhsSearchTimeoutError(null));
  });
});

describe("任务 #117：手动豆 freeText 分段 / 梯队庄园词档 / 近重复 Jaccard", () => {
  const FREE = "波切萨 74158 · 埃塞俄比亚 阿贝格纳 / Natural 日晒 / 浅焙 · 百香果 凤梨 菠萝蜜 荔枝";

  it("freeText 分段：seg0 豆名候选段、含国别词段产地候选段；处理法/风味段不作产地", () => {
    assert.equal(freeTextNameSegment(FREE), "波切萨 74158");
    assert.equal(freeTextOriginSegment(FREE), "埃塞俄比亚 阿贝格纳");
    assert.equal(freeTextOriginSegment("波切萨 74158 / Natural 日晒 / 浅焙"), "");
    assert.equal(freeTextNameSegment(undefined), "");
  });

  it("extractEstateTokens/beanTokens：无结构化字段也能提取庄园词与豆词", () => {
    assert.deepEqual(extractEstateTokens({ freeText: FREE }), ["阿贝格纳"]);
    const tokens = beanTokens({ freeText: FREE });
    for (const t of ["波切萨", "74158", "埃塞俄比亚", "阿贝格纳"]) {
      assert.ok(tokens.includes(t), `缺豆词 ${t}`);
    }
  });

  it("narrowSubjectTokens 数字豁免：数字型号与豆名组合保留短形态、不挤占槽位", () => {
    assert.deepEqual(narrowSubjectTokens("波切萨 74158"), ["波切萨 74158"]);
    assert.deepEqual(narrowSubjectTokens("波切萨74158"), ["波切萨74158"], "汉字部分 ≤6 整体保留");
    assert.deepEqual(narrowSubjectTokens("波切萨 74158 埃塞俄比亚 阿贝格纳", 3), [
      "波切萨 74158",
      "埃塞俄比亚",
      "阿贝格纳",
    ]);
  });

  it("xhsKeywordLadder：首档为实测命中短词、庄园词独立档、末档豆名短词", () => {
    const ladder = xhsKeywordLadder({ freeText: FREE, process: "Natural 日晒" });
    assert.equal(ladder[0], "波切萨 74158 冲煮参数");
    assert.ok(ladder.includes("阿贝格纳 冲煮参数"), "庄园词进入 search_feeds 梯队");
    assert.equal(ladder[ladder.length - 1], "波切萨 手冲");
  });

  it("xhsNoteRelevant：仅含豆名（不含型号）的真实笔记不被复合短词误拦", () => {
    const note = { title: "西东｜埃塞波切萨日晒", url: "https://www.xiaohongshu.com/explore/x" };
    assert.ok(xhsNoteRelevant(note, { freeText: FREE }));
  });

  it("titleTokenJaccard/isNearDuplicateTitle：截图两条 SEO 标题判近重复（Dice≈0.67 漏网场景）", () => {
    const a = "74158 日晒 咖啡冲煮 攻略";
    const b = "日晒 74158咖啡 , 冲煮 秘籍";
    assert.ok(titleSimilarity(a, b) < 0.8, "bigram Dice 不达 0.8（漏网根因）");
    assert.ok(titleTokenJaccard(a, b) > 0.6);
    assert.ok(isNearDuplicateTitle(a, b));
    // 反例：不同主题不误判
    assert.ok(!isNearDuplicateTitle("波切萨 74158 冲煮参数", "阿贝格纳 冲煮参数"));
    assert.ok(!isNearDuplicateTitle("埃塞俄比亚 波切萨 日晒", "哥伦比亚 水洗 手冲记录"));
  });

  it("dedupeSourcesByTitle：截图两条 SEO 模板页不得同时入池，第三条不同主题保留", () => {
    const out = dedupeSourcesByTitle([
      { title: "74158 日晒 咖啡冲煮 攻略", url: "https://seo.example.com/1" },
      { title: "日晒 74158咖啡 , 冲煮 秘籍", url: "https://seo.example.com/2" },
      {
        title: "埃塞俄比亚西达摩班莎哈马修处理厂 日晒 74158 风味怎么样",
        url: "https://seo.example.com/3",
      },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].url, "https://seo.example.com/1", "先入者保留");
    assert.equal(out[1].url, "https://seo.example.com/3");
  });
});

describe("任务 #102-P3：披露集成（搜索执行超时三态 / 未及执行 / 产地不符提示）", () => {
  const realFetch = globalThis.fetch;

  const exampleBody = (): Response =>
    new Response(
      "<html><body><p>手冲咖啡冲煮参数 粉水比 1:15 水温 92 度研磨中细 闷蒸 30 秒</p></body></html>",
      { headers: { "content-type": "text/html" } },
    );

  it("MCP 探活在线但 search_feeds 执行超时 → 披露写「MCP 搜索执行超时」而非「连接超时/报错」", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${config.xhsMcpUrl}/health`) return new Response("ok"); // 探活在线
      if (url.includes("/mcp")) throw new Error("The operation was aborted due to timeout"); // search_feeds 执行超时
      if (url === `${config.searxngUrl}/`) return new Response("ok");
      if (url.startsWith(`${config.searxngUrl}/search`))
        return new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        });
      if (url.startsWith("https://www.baidu.com/s?")) {
        return new Response(
          '<html><body><h3 class="t"><a href="https://www.example.com/huakui/1">花魁日晒手冲冲煮参数记录</a></h3></body></html>',
        );
      }
      if (url.startsWith("https://www.example.com/")) return exampleBody();
      if (url.includes("/chat/completions")) return new Response("", { status: 500 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const outcome = await researchBean(
        { name: "花魁", origin: "埃塞俄比亚", process: "日晒" },
        undefined,
        undefined,
        { totalTimeoutMs: 20_000 },
      );
      assert.equal(outcome.ok, true);
      assert.ok(
        outcome.summaryText.includes("MCP 搜索执行超时"),
        "披露措辞精确：search_feeds 执行超时",
      );
      assert.ok(!outcome.summaryText.includes("连接超时/报错"), "不再使用不准确的旧措辞");
      assert.ok(
        outcome.summaryText.includes("MCP 在线但零召回") === false,
        "未命中时不宣称零召回措辞",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("搜索阶段被时间盒截断时，Reddit 定向未及执行在披露中如实注明", async () => {
    let servedSources = false;
    const hang = (signal: AbortSignal | undefined): Promise<Response> =>
      new Promise((_resolve, reject) => {
        if (!signal) return reject(new Error("无 signal，防测试死锁"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${config.xhsMcpUrl}/health`) return new Response("", { status: 503 }); // MCP 离线
      if (url === `${config.searxngUrl}/`) return new Response("ok");
      if (url.startsWith(`${config.searxngUrl}/search`)) {
        const q = new URL(url).searchParams.get("q") ?? "";
        if (q.includes("site:xiaohongshu.com"))
          return new Response(JSON.stringify({ results: [] }), {
            headers: { "content-type": "application/json" },
          });
        if (q.includes("reddit")) return hang(init?.signal); // Reddit 槽位挂起（截断后未及执行）
        if (!servedSources) {
          servedSources = true;
          return new Response(
            JSON.stringify({
              results: [
                {
                  title: "花魁日晒手冲冲煮参数记录",
                  url: "https://www.example.com/hk1",
                  content: "粉水比 1:15",
                },
                {
                  title: "花魁咖啡豆烘焙与冲煮建议",
                  url: "https://www.example.com/hk2",
                  content: "水温 92 度",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return hang(init?.signal); // 第二条起挂起，耗尽时间盒
      }
      if (url.startsWith("https://www.baidu.com/s?")) return new Response("<html></html>");
      if (url.startsWith("https://www.example.com/")) return exampleBody();
      if (url.includes("/chat/completions")) return new Response("", { status: 500 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const outcome = await researchBean(
        { name: "花魁", origin: "埃塞俄比亚", process: "日晒" },
        undefined,
        undefined,
        { totalTimeoutMs: 2000 }, // 缩短总盒：首条查询命中后时间盒耗尽，Reddit 槽位未及执行
      );
      assert.equal(outcome.ok, true);
      assert.ok(outcome.summaryText.includes("Reddit 论坛定向检索"), "披露提及 Reddit 渠道");
      assert.ok(outcome.summaryText.includes("未及执行"), "如实注明未及执行（截断披露）");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("保留来源产地与豆档案不符时，摘要披露提示交叉验证；标题级冲突低分来源被过滤", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${config.xhsMcpUrl}/health`) return new Response("", { status: 503 }); // MCP 离线
      if (url === `${config.searxngUrl}/`) return new Response("ok");
      if (url.startsWith(`${config.searxngUrl}/search`)) {
        const q = new URL(url).searchParams.get("q") ?? "";
        if (q.includes("site:xiaohongshu.com") || q.includes("reddit"))
          return new Response(JSON.stringify({ results: [] }), {
            headers: { "content-type": "application/json" },
          });
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "阿朵斯哥伦比亚手冲冲煮参数记录",
                url: "https://www.example.com/ad1",
                content: "粉水比 1:15 水温 92 度手冲冲煮",
              },
              {
                title: "阿朵斯手冲冲煮参数分享",
                url: "https://www.example.com/ad2",
                content: "有人说是玻利维亚瓦利基的豆子 不过风味确实好 手冲咖啡",
              },
              {
                title: "玻利维亚瓦利基手冲冲煮参数",
                url: "https://www.example.com/ad3",
                content: "手冲咖啡冲煮参数记录",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://www.baidu.com/s?")) return new Response("<html></html>");
      if (url.startsWith("https://www.example.com/")) return exampleBody();
      if (url.includes("/chat/completions")) return new Response("", { status: 500 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const outcome = await researchBean(
        { name: "阿朵斯", origin: "哥伦比亚", process: "水洗" },
        undefined,
        undefined,
        { totalTimeoutMs: 20_000 },
      );
      assert.equal(outcome.ok, true);
      assert.equal(outcome.sources.length, 2, "标题级国别冲突低分来源被过滤，其余 2 条保留");
      assert.ok(!outcome.sources.some((s) => s.url.includes("ad3")), "张冠李戴来源不入引用列表");
      assert.ok(outcome.summaryText.includes("产地与豆档案不符"), "保留但不符的来源在摘要中披露");
      assert.ok(outcome.summaryText.includes("阿朵斯手冲冲煮参数分享"), "披露点名不符来源标题");
      assert.ok(outcome.filtered >= 1, "冲突来源计入过滤数");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("任务 #109-P3：长复合豆名收敛（瑰夏村金标Oma地块152）", () => {
  it("narrowSubjectTokens：>6 字整词优先收敛为庄园词；无庄园词时截断前 6 字；短词不受影响", () => {
    // 有庄园词：改用与 site: 定向查询一致的庄园词
    assert.deepEqual(narrowSubjectTokens("瑰夏村金标Oma地块152", 3, ["瑰夏村"]), ["瑰夏村"]);
    // 无庄园词：按字符截断前 6 字（含拉丁字母按 1 字符计）
    assert.deepEqual(narrowSubjectTokens("瑰夏村金标Oma地块152"), ["瑰夏村金标O"]);
    // 短词不变（庄园词参数不影响正常豆名）
    assert.deepEqual(narrowSubjectTokens("花魁", 3, ["云间庄园"]), ["花魁"]);
    // 庄园词本身超长（>6 字）不采用，仍走截断
    assert.deepEqual(narrowSubjectTokens("ABCDEFGHIJ", 3, ["超长庄园词示例名称"]), ["ABCDEF"]);
  });

  it("xhsKeywordLadder：梯队首档为庄园词短词，不再出现 13 字整词", () => {
    const ladder = xhsKeywordLadder({
      name: "瑰夏村金标Oma地块152",
      origin: "巴拿马-瑰夏村",
      process: "水洗",
    });
    assert.deepEqual(ladder, ["瑰夏村 冲煮参数", "瑰夏村 手冲", "巴拿马 水洗 手冲"]);
    assert.ok(!ladder.some((k) => k.includes("瑰夏村金标")), "任何档位不得含超长复合词");
  });

  it("buildResearchQueries：查询词同步收敛，site: 定向查询与庄园词一致", () => {
    const queries = buildResearchQueries({
      name: "瑰夏村金标Oma地块152",
      origin: "巴拿马-瑰夏村",
      process: "水洗",
    });
    assert.ok(
      !queries.some((q) => q.includes("瑰夏村金标")),
      "查询词不得含超长复合词（防 search_feeds 挂死）",
    );
    assert.ok(
      queries.some((q) => q.includes("瑰夏村")),
      "收敛后的庄园词应进入查询",
    );
    const directed = queries.find(isXhsDirectedQuery);
    assert.ok(
      directed && directed.includes("瑰夏村"),
      "site:xiaohongshu.com 定向查询使用庄园词短词",
    );
  });
});

describe("任务 #109-P2：小红书假命中拦截（xhsNoteRelevant）", () => {
  const input = { name: "沐乐果" };
  it("咖啡域词命中但豆名/主题词缺失 → 拦截（Vibe coding/xbloom 机主类无关笔记）", () => {
    assert.equal(
      xhsNoteRelevant(
        { title: "Vibe coding 咖啡冲煮程序", url: "https://www.xiaohongshu.com/explore/a" },
        input,
      ),
      false,
    );
    assert.equal(
      xhsNoteRelevant(
        { title: "xbloom 机主日常", url: "https://www.xiaohongshu.com/explore/b" },
        input,
      ),
      false,
    );
  });

  it("豆名在标题或正文命中 → 放行", () => {
    assert.ok(
      xhsNoteRelevant(
        { title: "沐乐果手冲记录", url: "https://www.xiaohongshu.com/explore/c" },
        input,
      ),
    );
    assert.ok(
      xhsNoteRelevant(
        {
          title: "今日手冲分享",
          snippet: "冲了一支沐乐果的豆子",
          url: "https://www.xiaohongshu.com/explore/d",
        },
        input,
      ),
    );
  });

  it("无任何信号词（无豆名/庄园词）→ 保守放行不误杀", () => {
    assert.ok(
      xhsNoteRelevant({ title: "咖啡冲煮记录", url: "https://www.xiaohongshu.com/explore/e" }, {}),
    );
  });
});

describe("任务 #109-P4：超时兜底档（xhsTimeoutFallbackKeyword + 集成）", () => {
  const realFetch = globalThis.fetch;

  /** 按序消费的 fetch 队列 mock（超出预期的请求直接报错防漏测） */
  function mockFetchQueue(responses: Array<(url: string) => Response>): { calls: string[] } {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const next = responses.shift();
      if (!next) throw new Error(`意外的 fetch 调用：${url}`);
      return next(url);
    }) as typeof fetch;
    return { calls };
  }

  const mcpOk = (): Response => new Response("ok");
  const mcpInit = (): Response =>
    new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "xhs" } } }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  const mcpFeeds = (feeds: unknown[]): Response =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: JSON.stringify({ feeds, count: feeds.length }) }],
        },
      }),
      { headers: { "content-type": "application/json" } },
    );

  it("纯函数：取梯队末档；末档已尝试/梯队为空时返回空串（不重复）", () => {
    assert.equal(
      xhsTimeoutFallbackKeyword(
        ["阿朵斯 冲煮参数", "阿朵斯 手冲", "埃塞俄比亚 水洗 手冲"],
        ["阿朵斯 冲煮参数"],
      ),
      "埃塞俄比亚 水洗 手冲",
    );
    assert.equal(
      xhsTimeoutFallbackKeyword(["花魁 冲煮参数", "花魁 手冲"], ["花魁 冲煮参数", "花魁 手冲"]),
      "",
      "末档已在尝试列表（超时发生在末档本身）时不重复",
    );
    assert.equal(xhsTimeoutFallbackKeyword([], []), "");
  });

  it("首档超时 → 兜底档（末档短词）命中即返回，仅多这一次（mcpTried 如实记录两档）", async () => {
    const budgets = createResearchBudgets();
    const feeds = [
      {
        id: "note-a",
        xsecToken: "tok-a",
        noteCard: {
          displayTitle: "阿朵斯手冲记录",
          interactInfo: { likedCount: "7" },
          desc: "粉水比 1:15 水温 92 度",
        },
      },
    ];
    mockFetchQueue([
      () => mcpOk(), // /health
      () => {
        throw new Error("The operation was aborted due to timeout"); // 首档执行超时
      },
      () => mcpInit(), // 兜底档 initialize
      () => mcpFeeds(feeds), // 兜底档命中
    ]);
    try {
      const outcome = await searchXiaohongshuDirected(
        "site:xiaohongshu.com 阿朵斯 冲煮参数",
        new AbortController().signal,
        ["阿朵斯 冲煮参数", "阿朵斯 手冲"],
        budgets,
      );
      assert.equal(outcome.via, "mcp", "兜底档命中即恢复 MCP 直连路径");
      assert.equal(outcome.mcpKeywordUsed, "阿朵斯 手冲", "如实披露命中档为末档短词");
      assert.deepEqual(outcome.mcpTried, ["阿朵斯 冲煮参数", "阿朵斯 手冲"]);
      assert.equal(outcome.mcpSearchTimeout, true);
      assert.equal(outcome.mcpOnline, true, "兜底档成功返回即证明连接建立");
      assert.equal(outcome.sources.length, 1);
      assert.equal(
        budgets.xhsMcpSearchCooled,
        true,
        "冷却标记已置，同一调研内不再进 MCP（只多这一次）",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("任务 #109-P1：抓取名额提权（pickFetchQuota）", () => {
  const web = (i: number): ResearchSource => ({
    title: `网页来源 ${i}`,
    url: `https://web.example.com/${i}`,
  });
  const xhsSrc = (i: number): ResearchSource => ({
    title: `小红书笔记 ${i}`,
    url: `https://www.xiaohongshu.com/explore/n${i}`,
  });

  it("小红书来源排在末位也至少占 min(命中数,2) 席（MCP 笔记不被 web 泛页挤出）", () => {
    const x1 = xhsSrc(1);
    const x2 = xhsSrc(2);
    const kept = [web(1), web(2), web(3), web(4), x1, x2];
    const picked = pickFetchQuota(kept, 4);
    assert.equal(picked.length, 4);
    assert.ok(picked.includes(x1) && picked.includes(x2), "两条小红书来源均占得抓取名额");
    assert.equal(
      picked.filter((s) => s.url.startsWith("https://web.example.com/")).length,
      2,
      "其余名额按原分数顺序补足两条 web（末位两条让出席位）",
    );
  });

  it("无小红书来源或候选不超名额时行为与 slice(0, maxFetch) 一致", () => {
    const w = [web(1), web(2), web(3), web(4), web(5), web(6)];
    assert.deepEqual(pickFetchQuota(w, 4), w.slice(0, 4));
    assert.deepEqual(
      pickFetchQuota([web(1), web(2)], 4).map((s) => s.url),
      ["https://web.example.com/1", "https://web.example.com/2"],
    );
  });

  it("任务 #113：保留席仅在分数不低于边界来源时才顶替（防低质笔记挤出高分来源）", () => {
    // 注意：web()/xhsSrc() 每次调用新建对象，Map 键必须与 kept 元素同引用，故先固化实例
    const w1 = web(1);
    const w2 = web(2);
    const w3 = web(3);
    const w4 = web(4);
    const x1 = xhsSrc(1);
    const x2 = xhsSrc(2);
    const kept = [w1, w2, w3, w4, x1, x2];
    // 笔记分数（3）低于边界来源 w4（6）→ 不占保留席，行为退回分数序 slice
    const lowScores = new Map<ResearchSource, number>([
      [w1, 9],
      [w2, 8],
      [w3, 7],
      [w4, 6],
      [x1, 3],
      [x2, 3],
    ]);
    assert.deepEqual(
      pickFetchQuota(kept, 4, lowScores),
      kept.slice(0, 4),
      "低分笔记不得顶替更高分的边界来源",
    );
    // 笔记分数不低于边界来源（同分或更高）→ 照旧保留
    const okScores = new Map<ResearchSource, number>([
      [w1, 9],
      [w2, 8],
      [w3, 7],
      [w4, 4],
      [x1, 6],
      [x2, 4],
    ]);
    const picked = pickFetchQuota(kept, 4, okScores);
    assert.ok(picked.includes(x1) && picked.includes(x2), "分数达标时保留席照旧生效");
    assert.equal(picked.length, 4);
    // 部分达标：只有 x1（6）≥ 边界（4），x2（2）不达标 → 只保留一席
    const mixedScores = new Map<ResearchSource, number>([
      [w1, 9],
      [w2, 8],
      [w3, 7],
      [w4, 4],
      [x1, 6],
      [x2, 2],
    ]);
    const mixed = pickFetchQuota(kept, 4, mixedScores);
    assert.ok(mixed.includes(x1), "达标笔记占得一席");
    assert.ok(!mixed.includes(x2), "不达标笔记不顶替高分来源");
    assert.deepEqual(mixed.slice(1), [w1, w2, w3], "其余名额按原分数顺序补足");
  });
});

describe("任务 #109-P6：tight 模式收紧 Tier2+ 泛来源", () => {
  it("域词命中但无豆名/产地/品种信号：单域词直接丢弃，双域词降权 2 分", () => {
    const tokens = beanTokens({ name: "花魁" });
    const futures = { title: "咖啡期货行情速报", url: "https://news.example.com/f" };
    const tight = scoreSourceRelevance(futures, tokens, [], { tight: true });
    const loose = scoreSourceRelevance(futures, tokens, []);
    assert.equal(tight.kept, false, "tight 下仅 1 个域词的泛文不再保留");
    assert.equal(loose.kept, true, "非 tight 行为不变（向后兼容）");

    const blend = { title: "意式拼配咖啡豆入门指南", url: "https://news.example.com/b" };
    const blendTight = scoreSourceRelevance(blend, tokens, [], { tight: true });
    const blendLoose = scoreSourceRelevance(blend, tokens, []);
    assert.equal(blendTight.kept, true, "域词命中 ≥2 仍保留（只降权不判死）");
    assert.equal(blendTight.score, blendLoose.score - 2, "泛文降权 2 分让位给豆相关来源");
  });

  it("小红书/论坛来源与豆词命中来源不受 tight 影响（不误杀 MCP 真召回）", () => {
    const tokens = beanTokens({ name: "花魁" });
    const xhs = { title: "咖啡冲煮记录", url: "https://www.xiaohongshu.com/explore/z" };
    assert.equal(scoreSourceRelevance(xhs, tokens, [], { tight: true }).kept, true);
    assert.equal(
      scoreSourceRelevance(xhs, tokens, [], { tight: true }).score,
      scoreSourceRelevance(xhs, tokens, []).score,
      "小红书域名直接保留不受 tight 降权",
    );
    const beanHit = { title: "花魁日晒咖啡豆冲煮记录", url: "https://blog.example.com/h" };
    assert.equal(
      scoreSourceRelevance(beanHit, tokens, [], { tight: true }).score,
      scoreSourceRelevance(beanHit, tokens, []).score,
      "豆词命中来源不降权",
    );
  });

  it("任务 #113：官方/烘焙商来源在 tight 模式下与小红书/论坛同等豁免", () => {
    const tokens = beanTokens({ name: "花魁" });
    // 官方冲煮指南不含豆名：仅 1 个域词，tight 下不降权不丢弃
    const official = { title: "冲煮指南", url: "https://xbloom.com/guide" };
    const offTight = scoreSourceRelevance(official, tokens, [], { tight: true });
    assert.equal(offTight.kept, true, "官方来源 tight 下保留");
    assert.equal(
      offTight.score,
      scoreSourceRelevance(official, tokens, []).score,
      "官方来源不受 tight 降权",
    );
    // 子域（分享配方页）同样命中
    assert.equal(
      scoreSourceRelevance(
        { title: "分享一个冲煮配方", url: "https://share-h5.xbloom.com/r/1" },
        tokens,
        [],
        { tight: true },
      ).kept,
      true,
    );
    // 烘焙商名命中：参数表不含豆名但标题含豆词信号，传 roaster 后豁免保留
    // （任务 #119：无本豆豆词信号的烘焙商页不再豁免，故标题补豆名「花魁」）
    const roasterPage = { title: "Fisher 花魁 萃取参数表", url: "https://fisher.example.com/p" };
    assert.equal(
      scoreSourceRelevance(roasterPage, tokens, [], { tight: true, roaster: "Fisher" }).kept,
      true,
      "烘焙商名命中且含本豆豆词的来源 tight 下豁免保留",
    );
    assert.equal(
      scoreSourceRelevance(roasterPage, tokens, [], { tight: true }).kept,
      false,
      "不传 roaster 时行为不变（无信号不豁免）",
    );
    // 直接保留仅 tight 生效：零域词的官方页非 tight 仍按原规则丢弃（逐字节不变）
    const officialNoDomain = { title: "官方公告", url: "https://xbloom.com/news" };
    assert.equal(
      scoreSourceRelevance(officialNoDomain, tokens, []).kept,
      false,
      "非 tight 行为不变",
    );
    assert.equal(scoreSourceRelevance(officialNoDomain, tokens, [], { tight: true }).kept, true);
  });

  it("任务 #113：isOfficialXbloomSource / roasterTextSignalHit 防仿冒与边界", () => {
    assert.equal(isOfficialXbloomSource("https://xbloom.com/a"), true);
    assert.equal(isOfficialXbloomSource("https://share-h5.xbloom.com/a"), true);
    assert.equal(isOfficialXbloomSource("https://notxbloom.com/a"), false, "后缀仿冒不命中");
    assert.equal(isOfficialXbloomSource("https://xbloom.com.evil.com/a"), false, "子域仿冒不命中");
    assert.equal(isOfficialXbloomSource("not a url"), false);

    const src = { title: "Tim Wendelboe 冲煮建议", url: "https://x.example.com/1" };
    assert.equal(roasterTextSignalHit(src, "Tim Wendelboe"), true);
    assert.equal(
      roasterTextSignalHit({ ...src, snippet: "由 tim wendelboe 烘焙" }, "Tim Wendelboe"),
      true,
      "摘要命中也算",
    );
    assert.equal(roasterTextSignalHit(src, "另一家烘焙商"), false);
    assert.equal(roasterTextSignalHit(src, undefined), false);
    assert.equal(roasterTextSignalHit(src, ""), false);
  });
});

describe("任务 #119：tight 官方/烘焙商豁免加冲突国/他豆约束（奇洛索场景）", () => {
  // 用户投诉豆：实跑来源混入他豆（翡翠庄园瑰夏/大肚脐）与烘焙商营销泛页
  const chiroso: BeanResearchInput = {
    name: "水洗卡杜拉奇洛索",
    origin: "哥伦比亚 橙子庄园 埃尔金小农",
    process: "水洗",
    roastLevel: "浅焙",
    roaster: "Light wave",
  };

  it("tightExemptionBeanWords：复合豆名汉字三元滑窗产出「奇洛索」等豆词信号", () => {
    const terms = beanNameTermsOf(chiroso);
    assert.ok(
      terms.some((t) => t.includes("卡杜拉")),
      "豆名词元含卡杜拉",
    );
    const words = tightExemptionBeanWords(beanTokens(chiroso), extractEstateTokens(chiroso), {
      roaster: chiroso.roaster,
      beanNameTerms: terms,
    });
    assert.ok(words.length > 0, "存在本豆豆词信号");
    assert.ok(
      words.some((w) => w.includes("奇洛索")),
      "滑窗产出奇洛索子词",
    );
    assert.ok(!words.includes("水洗"), "处理法词不作豆词信号");
    assert.ok(!words.some((w) => w === "哥伦比亚"), "国别词不作豆词信号");
  });

  it("foreignBeanTitleSignal：他豆专名且无本豆豆词 → 他豆信号；本豆组成/含豆词 → 否", () => {
    const terms = beanNameTermsOf(chiroso);
    const words = tightExemptionBeanWords(beanTokens(chiroso), extractEstateTokens(chiroso), {
      roaster: chiroso.roaster,
      beanNameTerms: terms,
    });
    // 他豆①：巴拿马瑰夏（瑰夏为他豆专名，标题无奇洛索/卡杜拉）
    const gesha = { title: "巴拿马翡翠 庄园 绿标瑰夏 咖啡豆中煮", url: "https://a.example.com/1" };
    assert.equal(foreignBeanTitleSignal(gesha, words, terms), true, "瑰夏他豆强信号");
    // 他豆②：大肚脐（他豆专名，标题无本豆豆词）
    const bigBelly = {
      title: "哥伦比亚大肚脐 咖啡豆 是什么品种?分界线 庄园 大肚脐怎么冲?",
      url: "https://a.example.com/2",
    };
    assert.equal(foreignBeanTitleSignal(bigBelly, words, terms), true, "大肚脐他豆强信号");
    // 本豆：标题含奇洛索 → 非他豆
    const self = { title: "Light wave 奇洛索 冲煮参数", url: "https://a.example.com/3" };
    assert.equal(foreignBeanTitleSignal(self, words, terms), false, "含本豆豆词不判他豆");
    // 豆词集为空 → 保守不拦
    assert.equal(foreignBeanTitleSignal(gesha, [], terms), false, "无豆词信号保守返回 false");
  });

  it("本豆名含他豆专名不误判（圣妮佐庄园瑰夏的「瑰夏」是本豆组成部分）", () => {
    const geshaBean: BeanResearchInput = {
      name: "圣妮佐庄园瑰夏",
      origin: "巴拿马",
      process: "水洗",
    };
    const terms = beanNameTermsOf(geshaBean);
    const words = tightExemptionBeanWords(beanTokens(geshaBean), extractEstateTokens(geshaBean), {
      beanNameTerms: terms,
    });
    const self = { title: "圣妮佐庄园瑰夏 手冲参数", url: "https://a.example.com/g" };
    assert.equal(foreignBeanTitleSignal(self, words, terms), false, "瑰夏是本豆名组成部分不判他豆");
  });

  it("filterRelevantSources(tight)：「巴拿马翡翠庄园绿标瑰夏」必须被过滤不保留", () => {
    const foreign = {
      title: "巴拿马翡翠 庄园 绿标瑰夏 咖啡豆中煮",
      url: "https://roaster.example.com/gesha",
      snippet: "Light wave 出品，巴拿马翡翠庄园绿标瑰夏",
    };
    const { kept } = filterRelevantSources([foreign], chiroso, { tight: true });
    assert.equal(
      kept.some((s) => s.url === foreign.url),
      false,
      "冲突国+他豆强信号剥夺豁免被过滤",
    );
  });

  it("filterRelevantSources(tight)：本豆烘焙商页（含奇洛索/Chiroso）仍保留", () => {
    const selfRoaster = {
      title: "Light wave 水洗卡杜拉奇洛索 冲煮参数表",
      url: "https://roaster.example.com/chiroso",
      snippet: "哥伦比亚橙子庄园，粉水比 1:15",
    };
    const selfShort = {
      title: "Light wave 奇洛索 Chiroso 手冲建议",
      url: "https://roaster.example.com/c2",
      snippet: "橙子庄园埃尔金小农",
    };
    const { kept } = filterRelevantSources([selfRoaster, selfShort], chiroso, { tight: true });
    assert.equal(
      kept.some((s) => s.url === selfRoaster.url),
      true,
      "含完整豆名的本豆烘焙商页保留",
    );
    assert.equal(
      kept.some((s) => s.url === selfShort.url),
      true,
      "仅含奇洛索的本豆烘焙商页保留",
    );
  });

  it("filterRelevantSources(tight)：烘焙商营销泛页（无本豆豆词）被丢弃", () => {
    const marketing = {
      title: "当咖啡遇上实验室：红酒|烘焙|抹茶|芒果|冰滴",
      url: "https://roaster.example.com/marketing",
      snippet: "Light wave 品牌活动",
    };
    const { kept } = filterRelevantSources([marketing], chiroso, { tight: true });
    assert.equal(
      kept.some((s) => s.url === marketing.url),
      false,
      "营销泛页 tight 下丢弃",
    );
  });

  it("filterRelevantSources(tight)：「哥伦比亚大肚脐」他豆被过滤", () => {
    const bigBelly = {
      title: "哥伦比亚大肚脐 咖啡豆 是什么品种?分界线 庄园 大肚脐怎么冲?",
      url: "https://roaster.example.com/bigbelly",
      snippet: "Light wave 大肚脐冲煮",
    };
    const { kept } = filterRelevantSources([bigBelly], chiroso, { tight: true });
    assert.equal(
      kept.some((s) => s.url === bigBelly.url),
      false,
      "大肚脐他豆信号被过滤",
    );
  });

  it("filterRelevantSources(tight)：无 roaster 信号的普通网页他豆（同国国名拿到 beanHits）仍被硬过滤", () => {
    // 复测暴露的真实缺口：标题含豆国「哥伦比亚」拿到 beanHits，但标题是他豆「大肚脐」
    const genericForeign = {
      title: "哥伦比亚大肚脐 咖啡豆 是什么品种?分界线 庄园 大肚脐怎么冲?",
      url: "https://blog.example.com/bigbelly",
    };
    const { kept } = filterRelevantSources([genericForeign], chiroso, { tight: true });
    assert.equal(
      kept.some((s) => s.url === genericForeign.url),
      false,
      "同国他豆页 tight 下零保留",
    );
    // 非 tight 行为不变（不受他豆硬过滤影响）
    const { kept: keptLoose } = filterRelevantSources([genericForeign], chiroso);
    assert.equal(
      keptLoose.some((s) => s.url === genericForeign.url),
      true,
      "非 tight 仍按原规则保留",
    );
  });
});

describe("任务 #109-P2/H：researchBean 集成假命中拦截披露（沐乐果场景）", () => {
  const realFetch = globalThis.fetch;

  it("MCP 召回中与豆无关的笔记不入池不计命中，披露点名拦截数且不含无关标题", async () => {
    let mcpRpc = 0;
    let servedFeeds = false; // 一次性投递：串行循环二次进 MCP 时零召回，拦截数确定性为 2
    const feeds = [
      {
        id: "note-a",
        xsecToken: "tok-a",
        noteCard: {
          displayTitle: "沐乐果手冲记录",
          interactInfo: { likedCount: "9" },
          desc: "粉水比 1:15，水温 91 度，三段式注水",
        },
      },
      {
        id: "note-b",
        xsecToken: "tok-b",
        noteCard: { displayTitle: "Vibe coding 咖啡冲煮程序", interactInfo: { likedCount: "88" } },
      },
      {
        id: "note-c",
        xsecToken: "tok-c",
        noteCard: { displayTitle: "xbloom 机主日常", interactInfo: { likedCount: "77" } },
      },
    ];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${config.xhsMcpUrl}/health`) return new Response("ok");
      if (url.includes("/mcp")) {
        mcpRpc += 1;
        if (mcpRpc % 2 === 1)
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "xhs" } } }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        const list = servedFeeds ? [] : feeds;
        servedFeeds = true;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: {
              content: [
                { type: "text", text: JSON.stringify({ feeds: list, count: list.length }) },
              ],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${config.searxngUrl}/`) return new Response("ok");
      if (url.startsWith(`${config.searxngUrl}/search`))
        return new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        });
      if (url.startsWith("https://www.baidu.com/s?")) return new Response("<html></html>");
      if (url.includes("xiaohongshu.com"))
        return new Response(
          "<html><body><p>沐乐果手冲 粉水比 1:15 水温 91 度 咖啡冲煮参数</p></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      if (url.includes("/chat/completions")) return new Response("", { status: 500 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const outcome = await researchBean(
        { name: "沐乐果", origin: "哥伦比亚", process: "水洗" },
        undefined,
        undefined,
        { totalTimeoutMs: 20_000 },
      );
      assert.equal(outcome.ok, true);
      assert.ok(
        outcome.summaryText.includes("命中 1 条真实笔记"),
        `只统计通过相关性判定的笔记：${outcome.summaryText}`,
      );
      assert.ok(
        outcome.summaryText.includes("另有 2 条与豆无关的召回笔记已拦截"),
        "拦截数如实披露",
      );
      assert.ok(
        !outcome.sources.some((s) => s.title.includes("Vibe coding")),
        "无关笔记不入引用来源",
      );
      assert.ok(
        !outcome.sources.some((s) => s.title.includes("xbloom 机主")),
        "无关笔记不入引用来源",
      );
      assert.ok(
        outcome.sources.some((s) => s.title.includes("沐乐果手冲记录")),
        "真命中笔记保留",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("任务 #109-P5：产地不符披露名单与最终引用取交集", () => {
  const realFetch = globalThis.fetch;

  it("不符来源被候选名额截掉时，摘要不再点名（披露与最终引用一致）", async () => {
    let servedHk = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${config.xhsMcpUrl}/health`) return new Response("", { status: 503 }); // MCP 离线
      if (url === `${config.searxngUrl}/`) return new Response("ok");
      if (url.startsWith(`${config.searxngUrl}/search`)) {
        const q = new URL(url).searchParams.get("q") ?? "";
        if (q.includes("site:xiaohongshu.com") || q.includes("reddit"))
          return new Response(JSON.stringify({ results: [] }), {
            headers: { "content-type": "application/json" },
          });
        if (!servedHk && (q.includes("云间庄园") || q.includes("花魁"))) {
          servedHk = true;
          return new Response(
            JSON.stringify({
              results: [
                {
                  title: "花魁手冲参数全解",
                  url: "https://www.example.com/hk1",
                  content: "手冲咖啡冲煮参数 粉水比 1:15",
                },
                {
                  title: "云间庄园日晒手冲风味评测",
                  url: "https://www.example.com/hk2",
                  content: "花魁咖啡豆手冲冲煮记录",
                },
                {
                  title: "花魁日晒豆研磨度调整实录",
                  url: "https://www.example.com/hk3",
                  content: "咖啡研磨与手冲萃取记录",
                },
                {
                  title: "埃塞俄比亚花魁手冲水温实验",
                  url: "https://www.example.com/hk4",
                  content: "手冲咖啡冲煮水温对比",
                },
                {
                  title: "云间庄园花魁冲煮水质 TDS 对比",
                  url: "https://www.example.com/hk5",
                  content: "手冲咖啡水质记录",
                },
                {
                  title: "花魁配方三段注水手法讲解",
                  url: "https://www.example.com/hk6",
                  content: "手冲咖啡闷蒸与注水",
                },
                {
                  title: "花魁日晒手冲分享",
                  url: "https://www.example.com/hk7",
                  content: "肯尼亚同款处理法也适用 手冲咖啡冲煮",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://www.baidu.com/s?")) return new Response("<html></html>");
      if (url.startsWith("https://www.example.com/"))
        return new Response(
          "<html><body><p>花魁手冲咖啡冲煮参数 粉水比 1:15 水温 92 度 研磨中细 闷蒸 30 秒</p></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      if (url.includes("/chat/completions")) return new Response("", { status: 500 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const outcome = await researchBean(
        { name: "花魁", origin: "埃塞俄比亚-云间庄园", process: "日晒" },
        undefined,
        undefined,
        { totalTimeoutMs: 20_000 },
      );
      assert.equal(outcome.ok, true);
      assert.ok(outcome.sources.length >= 4, "高分来源照常保留");
      assert.ok(
        !outcome.sources.some((s) => s.url.includes("hk7")),
        "不符来源被候选名额截掉不入引用",
      );
      assert.ok(
        !outcome.summaryText.includes("产地与豆档案不符"),
        `未入引用的条目不得被点名：${outcome.summaryText}`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("任务 #125：他滤杯拦截与 dripperSignal 标记", () => {
  // 测试用豆：波切萨 74158（埃塞俄比亚阿贝格纳，手动豆）
  const bochesa: BeanResearchInput = {
    name: "波切萨 74158",
    origin: "埃塞俄比亚 阿贝格纳",
    process: "水洗",
    roastLevel: "浅焙",
  };

  it("foreignDripperTitleSignal：纯 V60 泛攻略（无本豆豆词）→ pure", () => {
    const terms = beanNameTermsOf(bochesa);
    const words = tightExemptionBeanWords(beanTokens(bochesa), extractEstateTokens(bochesa), {
      beanNameTerms: terms,
    });
    // 纯 V60 泛攻略：标题不含本豆豆词
    const pureV60 = {
      title: "V60 手冲入门指南：研磨与水温",
      url: "https://blog.example.com/v60-guide",
    };
    const result = foreignDripperTitleSignal(pureV60, words, terms);
    assert.equal(result.kind, "pure", "纯 V60 泛攻略判为 pure");
    if (result.kind === "pure") {
      assert.ok(result.dripper.includes("v60"), "命中 v60 滤杯词");
    }
  });

  it("foreignDripperTitleSignal：含本豆名+V60 策略 → mixed", () => {
    const terms = beanNameTermsOf(bochesa);
    const words = tightExemptionBeanWords(beanTokens(bochesa), extractEstateTokens(bochesa), {
      beanNameTerms: terms,
    });
    const mixedV60 = {
      title: "波切萨 74158 V60 冲煮参数",
      url: "https://blog.example.com/bochesa-v60",
    };
    const result = foreignDripperTitleSignal(mixedV60, words, terms);
    assert.equal(result.kind, "mixed", "含豆名+V60 判为 mixed");
    if (result.kind === "mixed") {
      assert.ok(result.dripper.includes("v60"), "命中 v60 滤杯词");
    }
  });

  it("foreignDripperTitleSignal：xBloom 官方滤杯词 → none（豁免）", () => {
    const terms = beanNameTermsOf(bochesa);
    const words = tightExemptionBeanWords(beanTokens(bochesa), extractEstateTokens(bochesa), {
      beanNameTerms: terms,
    });
    // xBloom 官方滤杯词豁免
    const official = {
      title: "波切萨 74158 xBloom xdripper 冲煮",
      url: "https://xbloom.com/recipe/1",
    };
    const result = foreignDripperTitleSignal(official, words, terms);
    assert.equal(result.kind, "none", "xBloom 官方滤杯词豁免判为 none");
  });

  it("foreignDripperTitleSignal：无他滤杯词 → none", () => {
    const terms = beanNameTermsOf(bochesa);
    const words = tightExemptionBeanWords(beanTokens(bochesa), extractEstateTokens(bochesa), {
      beanNameTerms: terms,
    });
    const normal = {
      title: "波切萨 74158 手冲参数",
      url: "https://blog.example.com/normal",
    };
    const result = foreignDripperTitleSignal(normal, words, terms);
    assert.equal(result.kind, "none", "无他滤杯词判为 none");
  });

  it("foreignDripperTitleSignal：空豆词集保守返回 none", () => {
    const pureV60 = {
      title: "V60 手冲入门指南",
      url: "https://blog.example.com/v60",
    };
    const result = foreignDripperTitleSignal(pureV60, [], []);
    assert.equal(result.kind, "none", "无豆词信号保守返回 none");
  });

  it("foreignDripperTitleSignal：Kalita/Orea/Chemex 均命中", () => {
    const terms = beanNameTermsOf(bochesa);
    const words = tightExemptionBeanWords(beanTokens(bochesa), extractEstateTokens(bochesa), {
      beanNameTerms: terms,
    });
    const kalita = {
      title: "波切萨 74158 Kalita Wave 冲煮",
      url: "https://blog.example.com/k",
    };
    assert.equal(foreignDripperTitleSignal(kalita, words, terms).kind, "mixed");

    const orea = {
      title: "Orea 手冲咖啡冲煮指南",
      url: "https://blog.example.com/o",
    };
    assert.equal(foreignDripperTitleSignal(orea, words, terms).kind, "pure");

    const chemex = {
      title: "Chemex 手冲入门",
      url: "https://blog.example.com/c",
    };
    assert.equal(foreignDripperTitleSignal(chemex, words, terms).kind, "pure");
  });

  it("scoreSourceRelevance(tight)：纯 V60 泛攻略被过滤（kept=false）", () => {
    const tokens = beanTokens(bochesa);
    const estates = extractEstateTokens(bochesa);
    const terms = beanNameTermsOf(bochesa);
    const pureV60 = {
      title: "V60 手冲入门指南：研磨与水温",
      url: "https://blog.example.com/v60-guide",
    };
    const tight = scoreSourceRelevance(pureV60, tokens, estates, {
      tight: true,
      beanNameTerms: terms,
      roaster: bochesa.roaster,
    });
    assert.equal(tight.kept, false, "纯 V60 泛攻略 tight 下被过滤");
  });

  it("scoreSourceRelevance(tight)：含豆名+V60 策略保留且 dripperSignal 标记", () => {
    const tokens = beanTokens(bochesa);
    const estates = extractEstateTokens(bochesa);
    const terms = beanNameTermsOf(bochesa);
    const mixedV60 = {
      title: "波切萨 74158 V60 冲煮参数",
      url: "https://blog.example.com/bochesa-v60",
    };
    const tight = scoreSourceRelevance(mixedV60, tokens, estates, {
      tight: true,
      beanNameTerms: terms,
      roaster: bochesa.roaster,
    });
    assert.equal(tight.kept, true, "含豆名+V60 策略 tight 下保留");
    assert.ok(tight.dripperSignal, "dripperSignal 标记存在");
    assert.ok(tight.dripperSignal!.includes("v60"), "dripperSignal 含 v60");
  });

  it("scoreSourceRelevance(tight)：xBloom 官方滤杯词豁免不判为他滤杯", () => {
    const tokens = beanTokens(bochesa);
    const estates = extractEstateTokens(bochesa);
    const terms = beanNameTermsOf(bochesa);
    const official = {
      title: "波切萨 74158 xBloom xdripper 冲煮",
      url: "https://xbloom.com/recipe/1",
    };
    const tight = scoreSourceRelevance(official, tokens, estates, {
      tight: true,
      beanNameTerms: terms,
      roaster: bochesa.roaster,
    });
    assert.equal(tight.kept, true, "xBloom 官方滤杯词豁免保留");
    assert.equal(tight.dripperSignal, undefined, "不判为他滤杯、无 dripperSignal");
  });

  it("filterRelevantSources(tight)：纯 V60 泛攻略被过滤，含豆名 V60 策略保留且带 dripperSignal", () => {
    const pureV60 = {
      title: "V60 手冲入门指南：研磨与水温",
      url: "https://blog.example.com/v60-guide",
    };
    const mixedV60 = {
      title: "波切萨 74158 V60 冲煮参数",
      url: "https://blog.example.com/bochesa-v60",
    };
    const normal = {
      title: "波切萨 74158 手冲参数",
      url: "https://blog.example.com/normal",
    };
    const { kept } = filterRelevantSources([pureV60, mixedV60, normal], bochesa, {
      tight: true,
    });
    // 纯 V60 泛攻略被过滤
    assert.equal(
      kept.some((s) => s.url === pureV60.url),
      false,
      "纯 V60 泛攻略被过滤",
    );
    // 含豆名+V60 策略保留且带 dripperSignal
    const mixed = kept.find((s) => s.url === mixedV60.url);
    assert.ok(mixed, "含豆名+V60 策略保留");
    assert.ok(mixed!.dripperSignal?.includes("v60"), "dripperSignal 标记 v60");
    // 普通来源保留且无 dripperSignal
    const norm = kept.find((s) => s.url === normal.url);
    assert.ok(norm, "普通来源保留");
    assert.equal(norm!.dripperSignal, undefined, "无他滤杯词的来源无 dripperSignal");
  });

  it("v60 不再当 COFFEE_DOMAIN_WORDS 正向域词加分", () => {
    // v60 已从 COFFEE_DOMAIN_WORDS 移除：标题仅含 v60 不再拿到域词加分
    const tokens = beanTokens(bochesa);
    const v60Only = {
      title: "V60 手冲",
      url: "https://blog.example.com/v60",
    };
    const noDomain = {
      title: "手冲",
      url: "https://blog.example.com/normal",
    };
    const scoreV60 = scoreSourceRelevance(v60Only, tokens, []);
    const scoreNoDomain = scoreSourceRelevance(noDomain, tokens, []);
    // 两者都不含豆词，域词命中数应相同（v60 不再算域词）
    assert.equal(scoreV60.beanHits, scoreNoDomain.beanHits, "v60 不再产生 beanHits");
    assert.equal(scoreV60.score, scoreNoDomain.score, "v60 不再产生域词加分");
  });

  it("FOREIGN_DRIPPER_WORDS 与 XBLOOM_DRIPPER_WORDS 词表非空", () => {
    assert.ok(FOREIGN_DRIPPER_WORDS.length >= 9, "FOREIGN_DRIPPER_WORDS 至少 9 词");
    assert.ok(FOREIGN_DRIPPER_WORDS.includes("v60"), "含 v60");
    assert.ok(FOREIGN_DRIPPER_WORDS.includes("kalita"), "含 kalita");
    assert.ok(FOREIGN_DRIPPER_WORDS.includes("chemex"), "含 chemex");
    assert.ok(FOREIGN_DRIPPER_WORDS.includes("aeropress"), "含 aeropress");
    assert.ok(XBLOOM_DRIPPER_WORDS.includes("xbloom"), "豁免表含 xbloom");
    assert.ok(XBLOOM_DRIPPER_WORDS.includes("xdripper"), "豁免表含 xdripper");
  });
});
