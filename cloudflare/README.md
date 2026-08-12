# Cloudflare Hosted 部署

本目录用于部署 xBloom AI Brew Studio 的 Hosted 云端版。0.2 版本是多用户服务：访客可以注册，每个账号拥有隔离的配方、豆子、历史记录和个人模型设置，也可以连接自己的 xBloom 云端会话。

## Worker 提供的能力

- 账号注册、登录、签名 `HttpOnly` 会话 Cookie 和按用户隔离的数据。
- 个人 BYOK 模型设置，支持 OpenAI/GPT、Claude、Kimi、DeepSeek、Qwen、Gemini 和自定义 OpenAI-compatible 端点。
- 保存模型设置前先进行模型发现和连接测试。
- 使用部署的应用数据密钥，加密保存个人模型 API Key、xBloom 登录凭据和小红书 Cookie。
- 配方生成、配方历史、豆子记录，以及每个用户自己的 xBloom 云端登录和上传。
- Cloudflare Browser Run 提供网站内小红书扫码、登录态保存和 PRO/MAX 辅助检索。
- 同一套前端自动识别手机/电脑，也允许用户手动固定界面版本。BLE 属于 Windows 本地能力，不属于 Worker 能力。

默认账号流程不要求部署者准备共享模型密钥。共享模型（guest model）是可选项，应当作为单独的运营方凭证管理。

## 前置条件

- 有 Workers、D1 和 Browser Run 权限的 Cloudflare 账号。
- Node.js `>=22.12.0`、npm，以及用于安装依赖和运行 Wrangler 的网络连接。
- 可用的 Worker 名称和 D1 数据库名称。
- Hosted 请求需要公开 HTTPS 模型端点。Worker 调用时使用公开地址，不使用私网、回环地址或本地网络模型地址。

除非命令特别说明，以下命令都在仓库根目录执行。

## 默认 BYOK 部署

1. 登录 Wrangler：

   ```powershell
   npx wrangler login
   ```

2. 不带 LLM 参数运行部署脚本：

   ```powershell
   .\cloudflare\deploy-cloudflare.ps1
   ```

   脚本会构建应用、创建或复用 D1 数据库、应用迁移，并准备应用 secrets。部署完成后，用户在账号设置页面填写自己的模型连接。

3. 打开部署 URL，注册两个测试账号，并按[发布验收](../docs/PUBLISHING.md)完成验收矩阵。

需要自定义 Worker 名称时使用 `-WorkerName`。使用 `-SkipDeploy` 可以生成配置并运行本地 dry-run（演练）检查，不发布 Worker，也不改变远程资源：

```powershell
.\cloudflare\deploy-cloudflare.ps1 -WorkerName TARGET_WORKER -SkipDeploy
```

## 可选共享模型（guest model）

如果部署希望为尚未配置个人模型的访客提供默认体验，可以单独配置一个共享模型。它属于部署者管理的配置，不替代账号 BYOK。

```powershell
.\cloudflare\deploy-cloudflare.ps1 `
  -LlmBaseUrl https://YOUR_MODEL_HOST/v1 `
  -LlmModel YOUR_MODEL `
  -ConfigureSharedGuestModel
```

请把密钥保留在命令历史和源码之外。脚本会通过 PowerShell 的安全输入方式读取密钥，再通过 Wrangler 保存为 Worker 密钥。`-LlmBaseUrl` 和 `-LlmModel` 需要成对提供。

## 密钥和数据边界

| 项目                             | 所属方 / 用途                     | 保存边界                                        |
| -------------------------------- | --------------------------------- | ----------------------------------------------- |
| `APP_SESSION_SECRET`             | 部署的会话签名                    | Worker 密钥；升级时保持稳定                     |
| `APP_PASSWORD_PEPPER`            | 账号校验值的独立 pepper           | Worker 密钥；升级时保持稳定                     |
| `APP_DATA_ENCRYPTION_KEY`        | 加密模型、xBloom 和小红书登录凭据 | Worker 密钥；保持稳定，或提前规划密钥轮换/迁移  |
| `EDGE_PROXY_SECRET`              | 验证 EdgeOne 到 Worker 的 Relay   | Worker 密钥和 EdgeOne 环境；两边的值保持一致    |
| `XHS_BROWSER_QR_DAILY_LIMIT`     | 全站每日扫码/登录校验次数         | 普通变量；免费部署默认 `3`                      |
| `XHS_BROWSER_SEARCH_DAILY_LIMIT` | 全站每日小红书检索次数            | 普通变量；免费部署默认 `20`                     |
| 共享模型（guest model）密钥      | 可选的部署者备用配置              | Worker 密钥；不要放进浏览器代码或公开文档       |
| 个人模型密钥                     | 账号持有者的 BYOK 凭证            | 密钥正文加密；URL 和模型名为 D1 业务字段        |
| xBloom 凭据                      | 账号持有者的 xBloom 登录信息      | 外部会话载荷按用户加密                          |
| 小红书 Cookie                    | 当前浏览器或账号的调研登录态      | D1 只保存 AES-GCM 密文；浏览器会话按 owner 隔离 |

Worker 运营者掌握 Worker、D1、密钥配置和运行日志。模型服务商会看到请求中的提示词和上下文。用户应避免把无关的个人信息放进冲煮笔记。账号 Cookie 和外部会话都属于当前浏览器/账号边界；共享电脑使用结束后请退出登录。

## 中国入口：EdgeOne + Cloudflare

面向中国大陆时，可以把静态前端和 `/api/*` Relay 部署到 EdgeOne，再转发到本 Worker。Relay 会注入共享的 `EDGE_PROXY_SECRET`，并转发会话 Cookie 和流式响应。稳定的中国大陆域名需要已备案的自定义域名；临时平台 URL 不满足这一运营要求。

请按[中国部署说明](../docs/DEPLOY_CHINA.md)操作。该文档涵盖 Worker 源站、EdgeOne 环境变量、Relay 密钥、自定义域名和双账号验收。

## 升级和验收

- 常规升级时保持 `APP_SESSION_SECRET`、`APP_PASSWORD_PEPPER` 和 `APP_DATA_ENCRYPTION_KEY` 稳定，让已有会话、账号校验和加密记录继续可用。
- 升级后检查注册、登录、模型发现/测试/保存、手机/电脑界面、账号隔离、配方生成、xBloom 登录/上传和网站内小红书扫码。
- 一个用户的模型设置、xBloom 会话和小红书 Cookie 应独立于另一个用户。发布前用两个账号验证这一点。
- 模型服务和 xBloom 端点需要能从 Worker 的网络路径访问；浏览器本机的 localhost 地址属于本地版设置，不是 Hosted 模型目标。

Browser Run 有独立的并发、分钟数和计费额度。状态查询通常只读 D1；存在待确认会话时会补查一次。取码、登录确认和实际检索会消耗浏览器时间。Workers Free 当前为每日 10 分钟，适合个人试用；Workers Paid 当前含每月 10 小时，超出部分为每浏览器小时 0.09 美元，同时还需计算 Workers 套餐本身。公开运营前请按 [Cloudflare Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/) 核对当期价格。
