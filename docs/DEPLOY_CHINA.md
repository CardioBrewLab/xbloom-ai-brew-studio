# 中国网络入口（EdgeOne Makers + Cloudflare Worker）

## 先看结论

`*.workers.dev` 是 Cloudflare 的全球技术入口，不应直接作为中国大陆客户网址；部分大陆运营商网络会连接超时或要求切换网络。EdgeOne 的 `*.edgeone.cool` 系统项目域名也不是正式公开域名：中国大陆或全球（含中国大陆）项目只接受约 3 小时有效的预览令牌，全球（不含中国大陆）项目会在大陆网络返回 401。

长期公开入口使用以下组合：

1. 自有域名完成 ICP 备案；
2. 域名绑定到 EdgeOne Makers 的中国大陆或全球（含中国大陆）环境；
3. 静态界面与 `/api/*` 继续走本页的 EdgeOne → Pages Relay → Worker 链路；
4. Worker、D1、Browser Run 和每位用户自己的 BYOK 配置保持不变。

这不是前端代码或浏览器 UA 造成的故障，替换页面跳转脚本也不会改变线路结果。腾讯云官方同样把 CloudBase 默认域名限定为开发测试，并要求生产环境使用已备案自定义域名。尚在备案期时，EdgeOne 预览链接只用于短时验收，不写入发布文案。

这套部署把职责拆成四段，全部运行在云端：

- **EdgeOne Makers**：返回 `web/dist` 静态界面，并由 Cloud Function 接收 `/api/*`；
- **Cloudflare Pages Relay**：解决 EdgeOne 到 `workers.dev` 的网络兼容问题，只透传 API；
- **Cloudflare Worker + D1 + Browser Run**：注册登录、账号隔离、模型 API Key/xBloom/小红书凭据加密、豆仓、历史、生成、xBloom 云端上传和小红书辅助检索。

电脑关机后各层仍由云平台运行。每位用户登录自己的工作台账号，再保存自己的模型接口与 xBloom 账号；小红书可直接在网站扫码，Cookie 按匿名浏览器或注册账号加密隔离。

## 1. 先部署 Worker

在仓库根目录运行：

```powershell
.\deploy-cloudflare.bat
```

脚本会创建/复用 D1、应用全部迁移、补齐数据加密与代理密钥，再部署 Worker。新站点无需配置部署者的模型 Key；每位用户进站后自行选择模型服务。

## 2. 部署 Pages API Relay

在仓库根目录运行：

```powershell
.\cloudflare-pages-relay\deploy-relay.ps1 `
  -ProjectName YOUR_RELAY_PROJECT `
  -UpstreamOrigin https://YOUR_WORKER.workers.dev
```

脚本会创建或复用 Pages 项目，在系统临时目录生成一次性部署包并注入 Worker 地址，然后部署 `cloudflare-pages-relay/_worker.js`；上传完成后临时包立即删除。仓库和浏览器都不会获得部署者的 Worker 地址配置。记录输出的稳定地址：

```text
https://YOUR_RELAY_PROJECT.pages.dev
```

Pages Relay 不保存数据，也不解密模型 Key；账号、配方、豆库和凭据仍由 Worker + D1 按用户处理。

## 3. 建立 EdgeOne Makers 项目

1. 将仓库导入 EdgeOne Makers；
2. 构建设置由根目录 `edgeone.json` 自动读取；
3. 在 Production 环境添加：
   - `CLOUDFLARE_WORKER_ORIGIN=https://YOUR_RELAY_PROJECT.pages.dev`
   - `EDGE_PROXY_SECRET=与 Worker 完全相同的随机值`
4. 触发一次新部署；旧部署不会自动获得刚添加的环境变量。

变量名 `CLOUDFLARE_WORKER_ORIGIN` 为保持旧部署兼容而保留，此处实际填写 Pages Relay 地址。`cloud-functions/api/[[default]].js` 会清理伪造的代理头，写入受共享密钥保护的来源标记，并原样转发 SSE 与 `Set-Cookie`。

## 4. 选择访问区域

- 选择中国大陆或全球（含中国大陆）区域时，系统项目域名只接受控制台生成的预览链接，链接有效期约 3 小时；令牌过期或去掉查询参数后返回 401；
- 选择全球（不含中国大陆）区域时，系统项目域名可从中国大陆以外网络直接访问，中国大陆网络访问会返回 401；
- 稳定公开使用需要绑定自己的域名；选择中国大陆或全球（含中国大陆）节点时，域名需先完成 ICP 备案；
- 尚无备案域名时，可先将自定义域名关联到全球（不含中国大陆）环境，并保留 Cloudflare 地址作为技术验收入口。

### 没有域名时的测试入口

腾讯云 SCF Web 函数会生成默认函数 URL，并原生支持 SSE，适合在备案期间做大陆网络短期验收。它属于按量计费服务：截至 2026-08 的官方价格中，中国大陆 Web 函数响应/外网流量为 `0.80 元/GB`，响应流量不在免费额度内，因此它不作为本项目默认的公开入口。正式发布仍使用已备案自定义域名 + EdgeOne。

官方依据：

- [EdgeOne 接入与中国大陆备案要求](https://edgeone.ai/document/zh/54208)
- [EdgeOne Pages 自定义域名说明](https://edgeone.ai/document/159687579672338432)
- [CloudBase 默认域名与生产环境边界](https://cloud.tencent.com/document/product/876/130728)
- [SCF Web 函数 SSE 支持](https://cloud.tencent.com/document/product/583/90617)
- [SCF 当前计费项与价格](https://cloud.tencent.com/document/product/583/12281)

不要把 `*.edgeone.cool` 的无令牌地址写进发布文案或当作客户入口。控制台表格中的预览 URL 含临时访问凭据，也不要提交到仓库、issue 或截图。

绑定正式域名后，从未登录浏览器执行公开性检查：

```powershell
npm run check:hosted-url -- https://YOUR_PUBLIC_DOMAIN/
```

该命令会拒绝带 `eo_token`/`eo_time` 的预览 URL，并要求匿名首页和 `/api/status` 同时返回成功状态。

## 5. 费用边界

- 默认不设置部署者的 `LLM_API_KEY`、`LLM_BASE_URL` 和 `LLM_MODEL`；用户登录后填写自己的模型连接，模型费用归用户自己的供应商账号；
- EdgeOne Makers、Cloudflare Pages、Workers、D1 和 Browser Run 都可从免费套餐开始；Browser Run 免费计划当前为每日 10 分钟、最多 3 个并发浏览器，公开运营前按官方当期额度评估；
- 域名购买及中国大陆节点所需的备案由部署者自行处理。

## 6. 验收

依次检查：

1. 注册两个测试账号；
2. 两个账号分别保存不同模型地址，并执行“识别模型”“保存并测试”；
3. A 账号创建豆档案/配方，B 账号列表保持独立；
4. FAST、PRO、MAX 各生成一次，MAX 三份参数快照应互不重复；
5. 登录个人 xBloom 账号，执行发布预演、上传和列表回读；
6. 小红书不登录时生成照常；网站内扫码后，PRO/MAX 显示真实笔记来源与小红书状态。
7. 用手机和电脑各打开一次：手机应自动显示底部导航，电脑应显示三栏工作台；手动版本切换可持久保存。

额外执行自动化门禁：

```powershell
npm run test:hosting
npm run verify
```
