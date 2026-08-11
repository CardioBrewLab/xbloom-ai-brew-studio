# 变更记录

## 0.2.1 — 2026-08-11

### 修复

- Windows PowerShell 5.1 安装链改用内置 .NET 完成 SHA-256、受限 PSD1 读取和 ZIP 解压，修复部分全新 Windows 主机的 `Expand-Archive` 失败。
- EdgeOne API 入口改为 Node.js Cloud Function，并增加 Cloudflare Pages Relay，避免直连 `workers.dev` 时出现 504 或出站网络失败。
- Hosted 页面断开云端时不再提示运行本机 `npm run dev`，并每 10 秒自动重试；本地版仍保留准确的启动指引。
- 公开部署默认严格使用用户自己的 BYOK；部署者共享模型保持未启用状态。

### 验证

- Windows 兼容辅助函数、源码干净安装、EdgeOne Relay、Pages Relay、Hosted 多用户隔离和全量 `npm run verify` 纳入发布门禁。

## 0.2.0 — 2026-08-11

### 新增

- Hosted 账号注册和登录，以及按用户隔离的配方、豆子、历史记录、模型设置和外部会话。
- 支持 OpenAI/GPT、Claude、Kimi、DeepSeek、Qwen、Gemini 和自定义 OpenAI-compatible 端点的个人 BYOK 模型配置。
- 保存个人模型设置前进行模型发现和连接测试。
- 每个用户独立的 xBloom 云端登录、配方上传和云端配方管理。
- EdgeOne 前端/API Relay 加 Cloudflare Worker/D1 的中国入口说明。
- Hosted 用户可选的本地小红书助手配对流程。

### 变更

- Hosted 密码改用浏览器端 600,000 次 PBKDF2 + Worker 独立 pepper 校验，适配 Free 套餐 CPU 配额并避免提交明文密码。
- Hosted 部署文档现在以账号自己的 BYOK 为默认方式；部署者共享模型（guest model）作为可选备用连接。
- 公开文档现在区分 Hosted 云端版和 Windows 本地版，并说明凭证归属、隐私边界和全新电脑安装步骤。
- Windows 安装说明改为按解压目录计算路径，覆盖空格、中文路径和 exFAT/FAT 依赖处理，不要求固定盘符。
- xBloom 文档同时说明 Hosted 每用户云端同步和 Windows 本地流程。
- 配置、架构、功能、发布和中国部署链接按 0.2 流程整理。

### 验证

- 使用 `npm run verify`，测试数量以当前检出版本的实际输出为准；本文不固定测试总数。

## 0.1.1 — 2026-08-11

- MAX 三候选使用不同策略提示与独立随机种子，并按可执行参数指纹查重；重复槽位定向重生，候选卡直接展示粉水比、研磨、转速和注水段。
- 单候选遭遇临时网络错误时原槽位补发一次，保留既有 3→2→1 网关限流降载逻辑，并隐藏底层 `fetch failed` 文案。
- Cloudflare Worker 对齐桌面版三模式 SSE 契约、候选去重与重试逻辑，完成 D1 迁移和在线部署。
- Windows 安装器新增 exFAT/FAT 物理依赖布局，保留 NTFS/ReFS 标准 workspace；跨目录空账号安装和守护进程启动进入 CI/Release 门禁。
