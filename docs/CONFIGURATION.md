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

### 4. 使用可选的小红书助手

Hosted 页面可以调用同一台 Windows 电脑上的本地助手进行小红书调研。点击 **Connect local assistant**，确认本地服务打开的配对窗口。助手 token 只用于本地配对流程，小红书 Cookie 保留在本地助手运行时。助手是可选项；助手离线时，基础冲煮流程仍可直接使用。

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
| `GENERATION_TIMEOUT_MS`            | 整体生成截止时间                             | `600000`                     |
| `GENERATE_CANDIDATES`              | 旧 API 的候选数量；桌面模式有自己的策略      | `3`                          |
| `CANDIDATE_SCORE_THRESHOLD`        | 候选评分阈值                                 | `70`                         |
| `RESEARCH_RETRY_MAX_ROUNDS`        | 调研重试轮数                                 | `2`                          |
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

本地助手是可选的调研渠道。需要时启动打包的助手，把登录状态保留在当前电脑，并从工作台完成连接。Hosted 请求只通过配对后的本地 API 调用助手；Worker 不会接收本地 Cookie 存储。

SearXNG 和 Firecrawl 是独立的调研服务。只配置当前流程需要的服务，并确认发送给每个服务的数据范围。助手或调研服务离线时，可以直接使用冲煮目标和模型连接。

### BLE 和 xBloom App

Windows 安装器在检测到 Python 3.10+ 时，可以准备可选 BLE 设备实验室。BLE 设置只影响本地流程。常规 xBloom App 上传走 xBloom 云端 API，与直接 BLE 连接分开。

## 凭证归属清单

- **个人模型密钥**：归当前账号/用户所有，保存在账号设置或本地 `.env`。
- **xBloom 账号**：归当前用户所有，从 Cloud 页面重新连接，不复制其他用户的会话。
- **小红书登录**：归本地助手运行时所在的当前电脑，保留在本地。
- **运营方密钥**：`APP_SESSION_SECRET`、`APP_PASSWORD_PEPPER`、`APP_DATA_ENCRYPTION_KEY` 和 EdgeOne Relay 密钥属于部署运营方，保存在 Worker/EdgeOne 密钥存储中。

这些值请放在对应的配置边界中，不要出现在 README 示例、截图、issue、发布压缩包或共享浏览器配置文件中。从一种运行方式切换到另一种运行方式时，在新的配置边界中重新填写凭证。
