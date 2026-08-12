# 配置说明

0.2 版本有两套配置入口，请根据当前运行方式选择。

| 运行方式       | 设置位置                         | 主要隔离边界                                |
| -------------- | -------------------------------- | ------------------------------------------- |
| Hosted 云端版  | 账号设置页面和 Hosted Cloud 页面 | 账号会话、用户数据行、按用户加密的外部设置  |
| Windows 本地版 | 本地设置页面和/或项目 `.env`     | 当前 Windows 用户、回环服务、本地 data 目录 |

## Hosted 云端版配置

### 1. 创建账号

打开 Hosted URL，选择 **注册** 并登录。密码至少 10 个字符；浏览器先完成 PBKDF2-HMAC-SHA256（600,000 次）再发送登录凭据，明文密码不进入站点请求。账号拥有自己的配方、豆子、历史记录、模型设置和 xBloom 云端会话。

### 2. 添加个人模型连接

打开 **Settings → Model**：

1. 选择预设，或选择 **Custom OpenAI-compatible**。
2. 预设不匹配时填写端点 URL。
3. 填写当前用户自己持有的 API key。
4. 服务商支持模型列表时，点击 **Discover models**。
5. 选择模型，点击 **Test**，确认连接后点击 **Save**。

支持的用户预设如下：

| 预设         | Hosted 服务使用的协议 | 常见端点类型                    |
| ------------ | --------------------- | ------------------------------- |
| OpenAI / GPT | OpenAI-compatible     | OpenAI `/v1`                    |
| Kimi         | OpenAI-compatible     | Moonshot `/v1`                  |
| DeepSeek     | OpenAI-compatible     | DeepSeek `/v1`                  |
| Qwen         | OpenAI-compatible     | DashScope compatible mode `/v1` |
| Claude       | Anthropic             | Anthropic API                   |
| Gemini       | Gemini                | Google Generative Language API  |
| Custom       | OpenAI-compatible     | 用户填写的 HTTPS 端点           |

预设决定服务商协议，模型名称可以从列表选择，也可以手动填写。Hosted 端点必须使用公开 HTTPS，并且能从 Worker 网络访问。`127.0.0.1` 这类浏览器本机地址属于 Windows 本地版，不作为 Worker 的模型目标。

设置 API 会返回服务商元数据和测试结果，但不会在保存后返回 API key。用户可以在同一页面替换或移除当前连接。每个账号使用自己的模型设置；部署者配置的共享模型（guest model）只为尚未配置 BYOK 的用户提供备用连接。

### 3. 连接 xBloom 云端

打开 **Cloud → xBloom**，选择部署显示的区域，使用当前用户自己的 xBloom 账号登录，然后上传或管理配方。Hosted Worker 会把外部会话按当前账号加密保存。退出或移除连接只影响当前账号的 xBloom 会话。

中国入口使用 EdgeOne 托管前端和 API Relay，Cloudflare Worker/D1 提供 Hosted API。稳定的中国大陆地址需要已备案的自定义域名。部署变量和验收步骤见 [DEPLOY_CHINA.md](DEPLOY_CHINA.md)。

### 4. 使用网站内小红书调研

Hosted 页面通过 Cloudflare Browser Run 直接完成小红书扫码和辅助检索。点击顶栏的小红书状态，取二维码后用手机 App 扫码；Cookie 使用 `APP_DATA_ENCRYPTION_KEY` 加密并按匿名浏览器或注册账号隔离。注册登录时，当前匿名浏览器的小红书会话会迁移到该账号。小红书登录是可选项，未登录时基础生成和 xBloom 上传照常使用。

### 5. 选择手机或电脑界面

默认 **自动** 模式综合手机 UA、触屏能力和视口宽度选择界面。手机版使用紧凑顶栏与底部导航，电脑版保留三栏工作台。用户可在顶栏选择 **手机版** 或 **电脑版**，偏好保存在当前浏览器。

## Windows 本地版配置

### 本地服务地址

Windows launcher 使用以下默认值：

| 服务            | 默认地址                 | 用途               |
| --------------- | ------------------------ | ------------------ |
| Web UI          | `http://localhost:5180`  | 浏览器工作台       |
| API             | `http://127.0.0.1:8787`  | 本地服务和助手配对 |
| Xiaohongshu MCP | `http://127.0.0.1:18060` | 可选本地调研服务   |
| SearXNG         | `http://127.0.0.1:8899`  | 可选本地搜索服务   |

启动器前可以用 `PORT` 修改本地 API 端口，用 `WEB_PORT` 修改 UI 端口。除非已经完成局域网暴露设计，请让本地服务保持回环监听。

watchdog 会把同一个 API 端口写入 `VITE_API_PROXY_TARGET`，因此 UI 会跟随 `PORT` 转发 `/api` 请求。该值必须是绝对的 HTTP/HTTPS 地址，且不带用户名、密码、查询参数或片段；非法值会在 Vite 启动前报错。

`SEARXNG_URL` 和 `XHS_MCP_URL` 可以指向远程或其他本机端口。watchdog 只有在它们仍是默认回环地址（8899/18060）时才执行本地 Docker/XHS 自愈；自定义地址由用户自己的服务管理。

### 本地状态权限

安装器在 NTFS/ReFS 上会为 `.env`、`data`、XHS runtime 和已存在的 Edge proxy secret 收紧 ACL，仅保留当前用户、LocalSystem 与本机 Administrators。exFAT/FAT 没有可靠的按用户 ACL，安装器会显示醒目的安全警告；请将整个项目目录放在当前用户私有位置。

### `.env` 参考

如果本地没有 `.env`，安装器会从 `.env.example` 创建空白文件。以下变量属于本地用户配置：

| 变量                               | 含义                                         | 值的形状                     |
| ---------------------------------- | -------------------------------------------- | ---------------------------- |
| `LLM_BASE_URL`                     | 模型网关 URL                                 | `https://YOUR_MODEL_HOST/v1` |
| `LLM_PROVIDER`                     | `openai-compatible`、`anthropic` 或 `gemini` | `openai-compatible`          |
| `LLM_API_KEY`                      | 本地主要模型密钥                             | `YOUR_MODEL_KEY`             |
| `LLM_MODEL`                        | 本地主要模型名称                             | `YOUR_MODEL`                 |
| `LLM_FALLBACK_API_KEY`             | 可选备用密钥                                 | `YOUR_FALLBACK_KEY`          |
| `LLM_FALLBACK_MODEL`               | 可选备用模型                                 | `YOUR_FALLBACK_MODEL`        |
| `LLM_THIRD_MODEL`                  | 可选第三模型名称                             | `YOUR_THIRD_MODEL`           |
| `LLM_REASONING_EFFORT`             | 本地生成路径使用的 reasoning 策略            | `high`                       |
| `LLM_TEMPERATURE`                  | 生成 temperature                             | `0.3`                        |
| `LLM_REQUEST_TIMEOUT_MS`           | 单次模型请求截止时间                         | `120000`                     |
| `GENERATION_TIMEOUT_MS`            | 整体生成截止时间                             | `300000`                     |
| `GENERATE_CANDIDATES`              | 旧 API 的候选数量；桌面模式有自己的策略      | `3`                          |
| `CANDIDATE_SCORE_THRESHOLD`        | 候选评分阈值                                 | `70`                         |
| `RESEARCH_RETRY_MAX_ROUNDS`        | 调研重试轮数                                 | `1`                          |
| `XBLOOM_REGION`                    | xBloom API 区域，`global` 或 `cn`            | `global`                     |
| `XBLOOM_EMAIL` / `XBLOOM_PASSWORD` | 可选本地 xBloom 自动登录                     | 留空或用户自己的值           |
| `HTTPS_PROXY` / `ALL_PROXY`        | 可选出站 proxy                               | 留空或 proxy URL             |
| `XBLOOM_DEVICE_NAME`               | 可选 BLE 设备名称                            | 留空或设备名称               |
| `XBLOOM_BLE_SCAN_TIMEOUT_MS`       | BLE 扫描截止时间                             | `15000`                      |
| `SEARXNG_URL`                      | 可选 SearXNG 服务                            | `http://127.0.0.1:8899`      |
| `XHS_MCP_URL`                      | 可选 Xiaohongshu MCP 服务                    | `http://127.0.0.1:18060`     |
| `XHS_HEADLESS`                     | 本地助手的无头浏览器模式                     | `true` 或 `false`            |
| `FIRECRAWL_API_KEY`                | 可选调研服务密钥                             | 留空或用户自己的值           |
| `FIRECRAWL_ENABLED`                | 是否启用可选服务                             | `true` 或 `false`            |
| `PORT` / `WEB_PORT`                | 本地 API/UI 端口                             | `8787` / `5180`              |

本地配置优先使用设置页面填写模型 URL、服务商、模型和密钥；需要重复启动时也可以使用 `.env`。`.env` 只放在本地项目目录，并从 commit 和发布压缩包中排除。

### 服务商和端点说明

- OpenAI、Kimi、DeepSeek 和 Qwen 使用 OpenAI-compatible 请求格式；端点和模型标识以各服务商当前文档为准。
- 选择对应协议时，Claude 使用 Anthropic，Gemini 使用 Google 的原生协议。
- 使用 Custom OpenAI-compatible 服务时，先确认服务端支持 `/models` 和 chat/completions，再使用模型发现和测试。
- 模型凭证会发送给所选模型服务，与 xBloom 和小红书凭证分开管理。

### 小红书和调研

Hosted 版直接在网站内启动 Cloudflare Browser Run 取码和检索；扫码不是使用工作台的前提，登录后才会在 Pro/Max 生成中加入小红书来源。Cookie 由 Worker 使用 `APP_DATA_ENCRYPTION_KEY` 加密，并按匿名浏览器或站内账号的 owner 隔离。Windows 本地版继续使用可选的本地助手，登录状态留在当前电脑。

个人演示默认使用 `XHS_BROWSER_PROFILE=free`：全站每天 3 次扫码/登录校验和 20 次小红书检索，每个 owner 分别为 3 次和 10 次。Workers Paid 的公开运营部署可用 `-XhsBrowserProfile scale`，默认提高到全站 2500/20000、单 owner 8/100；也可用四个 `XHS_BROWSER_*_DAILY_LIMIT` 变量精确覆盖。有效二维码会复用，执行异常会退回站内计数；公开笔记检索结果默认缓存 24 小时，缓存键是关键词摘要，不保存搜索原文或用户身份。

SearXNG 和 Firecrawl 是独立的调研服务。只配置当前流程需要的服务，并确认发送给每个服务的数据范围。助手或调研服务离线时，可以直接使用冲煮目标和模型连接。

### BLE 和 xBloom App

Windows 安装器在检测到 Python 3.10+ 时，可以准备可选 BLE 设备实验室。BLE 设置只影响本地流程。常规 xBloom App 上传走 xBloom 云端 API，与直接 BLE 连接分开。

## 凭证归属清单

- **个人模型密钥**：归当前账号/用户所有，保存在账号设置或本地 `.env`。
- **xBloom 账号**：归当前用户所有，从 Cloud 页面重新连接，不复制其他用户的会话。
- **小红书登录**：Hosted 版按当前 owner 加密保存在 D1；Windows 本地版归当前电脑的助手运行时。
- **运营方密钥**：`APP_SESSION_SECRET`、`APP_PASSWORD_PEPPER`、`APP_DATA_ENCRYPTION_KEY` 和 EdgeOne Relay 密钥属于部署运营方，保存在 Worker/EdgeOne 密钥存储中。

这些值请放在对应的配置边界中，不要出现在 README 示例、截图、issue、发布压缩包或共享浏览器配置文件中。从一种运行方式切换到另一种运行方式时，在新的配置边界中重新填写凭证。
