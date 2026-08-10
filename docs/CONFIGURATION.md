# 配置说明

## 推荐方式：在页面设置

首次打开时，设置窗口会提示填写模型连接：

| 字段         | 必填 | 示例                              |
| ------------ | ---- | --------------------------------- |
| API 地址     | 是   | `https://your-gateway.example/v1` |
| 主模型       | 是   | `your-model-id`                   |
| 主 API Key   | 是   | 由接口服务商提供                  |
| 备用模型     | 否   | `your-fallback-model-id`          |
| 备用 API Key | 否   | 备用渠道使用                      |
| 第三模型     | 否   | 与主渠道共用 Key                  |

接口需要兼容 OpenAI Chat Completions：

```http
POST {API_ADDRESS}/chat/completions
Authorization: Bearer {API_KEY}
Content-Type: application/json
```

至少应支持 `model`、`messages`、`stream` 与 `max_tokens`。本项目的豆档案解析和候选生成使用文本输入，不依赖图片输入能力。

“保存并测试”会使用当前主模型发出一个最多 32 tokens 的小请求。HTTP 错误正文与 Key 不会进入浏览器响应。

## 文件方式：`.env`

需要固定部署参数时，把 `.env.example` 复制为 `.env`。所有值默认留空，填写自己的内容：

```dotenv
LLM_BASE_URL=https://your-gateway.example/v1
LLM_API_KEY=YOUR_KEY
LLM_MODEL=YOUR_MODEL_ID
```

页面保存的本机设置优先于 `.env`。在设置窗口选择“恢复环境设置”后，会重新使用 `.env`。

### 模型链

```dotenv
LLM_FALLBACK_API_KEY=
LLM_FALLBACK_MODEL=
LLM_THIRD_MODEL=
LLM_REASONING_EFFORT=high
LLM_TEMPERATURE=0.3
```

- 主模型失败且尚未输出正文时，依次尝试备用模型与第三模型。
- 名称以 `claude` 开头的模型优先使用备用 Key；其他模型使用主 Key。
- GPT 系模型发送 `reasoning_effort`，并省略 `temperature`；其他模型使用配置温度。

## xBloom 云端

最省事的方式是在发布面板手动登录。也可在只由自己使用的电脑上配置自动登录：

```dotenv
XBLOOM_EMAIL=
XBLOOM_PASSWORD=
XBLOOM_REGION=global
```

区域值：

- `global`：全球区
- `cn`：中国区

页面手动登录不会把密码写入会话文件；本机缓存 memberId、邮箱，以及由 Windows DPAPI 绑定当前用户后的 Token 密文。`.env` 中的自动登录凭据属于明文配置，因此该文件始终保持 Git 忽略状态。

## 小红书

默认地址：

```dotenv
XHS_MCP_URL=http://127.0.0.1:18060
```

一键安装会下载并启动固定版本、固定 SHA-256 的本地 MCP。用户通过页面扫码建立自己的会话，Cookies 写入 `tools/xhs-mcp/runtime/cookies.json`，该私有运行目录不会进入 Git。自定义部署时可通过 `XHS_COOKIES_PATH` 指定后端 Cookie 导入文件，并保证 MCP 的 `COOKIES_PATH` 指向同一位置。

## 联网调研

```dotenv
SEARXNG_URL=http://127.0.0.1:8899
FIRECRAWL_ENABLED=true
FIRECRAWL_API_KEY=
```

- SearXNG 是可选的本地聚合搜索服务；未运行时会继续尝试其他来源。
- Firecrawl Key 留空时走其可用的 keyless 路径；填写后使用 Bearer 认证。
- 小红书已登录时会作为豆子调研的优先来源之一。

## 候选策略

```dotenv
GENERATE_CANDIDATES=3
CANDIDATE_SCORE_THRESHOLD=70
RESEARCH_RETRY_MAX_ROUNDS=2
```

- 候选数范围 1–5；设为 1 时使用单候选路径。
- 最佳候选低于阈值时更换调研角度。
- 重调研轮数用于控制时间和模型费用。

## 代理与端口

```dotenv
HTTPS_PROXY=
ALL_PROXY=
PORT=8787
WEB_PORT=5180
```

前端默认运行在 `localhost:5180`，后端固定绑定 `127.0.0.1:8787`，小红书 MCP 使用 `127.0.0.1:18060`，SearXNG 默认使用 `127.0.0.1:8899`。端口冲突时可同时调整 `PORT` 与 `WEB_PORT`；Windows 守护程序和 Vite 代理会读取同一份配置。

## BLE 实验配置

```dotenv
XBLOOM_DEVICE_NAME=
XBLOOM_BLE_SCAN_TIMEOUT_MS=15000
```

BLE 依赖作为可选依赖安装。常规工作流不需要填写这些字段。
