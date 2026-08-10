# Cloudflare 常在线版

这个目录把同一套 React 桌面界面发布为 Cloudflare Worker Static Assets，并用 D1 保存每个浏览器自己的豆仓与配方。模型请求由 Worker Secret 发出，部署者的 API Key 不进入浏览器。

## 当前云端能力

- FAST / PRO / MAX 三模式生成；MAX 固定三案并行、规则评分后选择；
- 配方历史、豆仓、库存扣减、杯测记录的 D1 持久化；
- 同源写保护、签名 HttpOnly 浏览器身份、浏览器/网络/全站三级每小时生成限额、请求体与模型超时边界；
- 静态界面和生成接口由 Cloudflare 托管，Windows 主机离线时仍在线。

手机 xBloom App 上传、小红书扫码调研与 BLE 设备实验依赖各用户自己的账号会话或本机硬件，继续由 Windows 本地完整版执行。云端状态接口会如实返回这些能力的状态，避免网页假装已连接。

## 一键部署

先安装 Node.js 22.12+，登录 Wrangler：

```powershell
cd cloudflare
npx wrangler login
.\deploy-cloudflare.ps1 -LlmBaseUrl 'https://YOUR_GATEWAY/v1' -LlmModel 'YOUR_MODEL'
```

脚本会构建前端、创建独立 D1、应用迁移、交互式写入两个 Worker Secret、执行 dry-run，再部署 Worker。生成的 `wrangler.generated.jsonc` 只属于本机并被 Git 忽略。

只做部署前演练：

```powershell
.\deploy-cloudflare.ps1 -LlmBaseUrl 'https://YOUR_GATEWAY/v1' -LlmModel 'YOUR_MODEL' -SkipDeploy
```

实现依据：[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/binding/)、[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)、[D1 Worker API](https://developers.cloudflare.com/d1/worker-api/)。
