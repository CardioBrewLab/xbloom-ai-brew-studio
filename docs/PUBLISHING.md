# 发布和验收

本文说明 0.2.1 Windows 安装包和多用户 Hosted 云端版的发布流程。它是发布检查清单，不是线上部署结果记录；最终发布说明请使用本次命令的真实输出。

## 0.2 发布范围

- Hosted 账号注册、登录和按账号隔离的数据。
- 个人 BYOK 模型设置，支持 OpenAI/GPT、Claude、Kimi、DeepSeek、Qwen、Gemini 和自定义 OpenAI-compatible 端点。
- 保存个人模型设置前进行模型发现和连接测试。
- 每个用户独立的 xBloom 云端登录、配方上传和配方管理。
- Hosted 用户的网站内小红书扫码、按用户加密会话和辅助调研。
- EdgeOne 前端/API Relay 加 Cloudflare Worker/D1 的中国入口。
- Windows 本地安装包，包含项目内运行时、本地 data、可选调研工具和可选 BLE 设置。

## Maintainer 发布前检查

在干净的发布分支上从仓库根目录执行。凭证放在当前检出版本和发布产物之外。

```powershell
npm ci
npm run verify
git diff --check -- README.md cloudflare/README.md docs/CONFIGURATION.md docs/FEATURES.md docs/ARCHITECTURE.md docs/PUBLISHING.md CHANGELOG.md
git status --short
```

本文刻意不写固定的验证数量。请把 `npm run verify` 的实际结果记录到发布记录中。打包前检查 `git status --short`，确保 `.env`、本地 data、运行时状态、Cookie 和生成的私密资料留在发布产物之外。

仓库现有的发布检查也要运行：

```powershell
npm run check:release
```

发布门禁使用 `package.json` 中已有的 `verify` 和发布脚本；不要额外假设一个不存在的测试命令。

## Hosted 云端部署

### 默认的账号 BYOK

默认 Cloudflare 部署使用每个账号自己的模型设置。用户注册和配置个人模型连接时，不需要部署者先准备共享模型密钥。

```powershell
npx wrangler login
.\cloudflare\deploy-cloudflare.ps1
```

常规升级时保持 `APP_SESSION_SECRET`、`APP_PASSWORD_PEPPER` 和 `APP_DATA_ENCRYPTION_KEY` 不变。三者分别用于会话签名、账号校验值的独立 pepper，以及加密用户模型 API Key/xBloom 外部会话载荷；都保存在 Worker 密钥存储中。

### 可选共享模型（guest model）

如果公开访客流程需要部署级备用连接，可以单独配置，并在发布说明中标明它属于部署运营者：

```powershell
.\cloudflare\deploy-cloudflare.ps1 `
  -LlmBaseUrl https://YOUR_MODEL_HOST/v1 `
  -LlmModel YOUR_MODEL `
  -ConfigureSharedGuestModel
```

guest 密钥由部署脚本通过安全输入读取，和账号个人 BYOK 分开保存。使用 `-SkipDeploy` 可以先做本地配置和 dry-run（演练）检查。

### 中国入口

按[中国部署说明](DEPLOY_CHINA.md)完成 EdgeOne 静态托管、`/api/*` Relay、`CLOUDFLARE_WORKER_ORIGIN`、`EDGE_PROXY_SECRET`、自定义域名以及 D1/Worker 验收。稳定的中国大陆域名需要已备案的自定义域名。

正式发布前必须使用无查询参数的自定义域名执行：

```powershell
npm run check:hosted-url -- https://YOUR_PUBLIC_DOMAIN/
```

带 EdgeOne 临时预览令牌的成功结果只计入部署预览，不计入公开上线验收。

## 发布产物验收

### Windows 全新电脑矩阵

在全新的 Windows 用户配置文件或全新 Windows 电脑上运行安装包。至少覆盖一个包含空格和中文的路径，以及一个非开发目录的可写卷。项目路径应由安装包自己计算，不依赖维护者电脑的路径。

| 检查                              | 预期现象                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| 解压压缩包                        | 文件解压到指定可写目录，不要求维护者专用路径                                          |
| 第一次运行 `install-windows.bat`  | 项目内 Node.js 运行时、依赖、工作区构建、空白本地 `.env` 和启动准备完成               |
| 重复运行安装器                    | 受管理的运行时/依赖可以再次构建；本地用户设置仍在项目边界内                           |
| 启动快捷方式 / `start-xbloom.bat` | UI 打开本地地址，API 监听文档中的回环端口                                             |
| 模型设置                          | 用户填写个人端点/密钥，并完成发现、测试和保存                                         |
| 生成                              | FAST/PRO/MAX 按当前模型生成预期的结构化配方                                           |
| xBloom 云端                       | 用户从 Cloud 页面登录并上传/管理配方                                                  |
| Hosted 小红书                     | 两个账号分别扫码/退出，确认 Cookie、昵称与调研来源不串号                              |
| 手机/电脑界面                     | 手机 UA 自动显示移动导航；电脑显示三栏；手动覆盖刷新后保持                            |
| 可选 BLE                          | Python/设备设置与 xBloom 云端上传流程分开                                             |
| 停止                              | `stop-xbloom.bat` 停止本地服务；再次启动可以恢复本地流程                              |
| 卸载/清理                         | 发布说明明确列出本地 data、`.env`、`.runtime`、助手状态和桌面快捷方式等用户自行管理项 |

安装器针对 exFAT/FAT 提供物理工作区依赖路径。升级一致性验收仍优先使用本机可写的 NTFS 目录。

### Hosted 多用户矩阵

使用两个合成测试账号 `USER_A` 和 `USER_B`，分别配置不同的测试模型连接。请使用测试账号，不要使用维护者账号或真实生产凭证。

| 检查          | 预期现象                                                                      |
| ------------- | ----------------------------------------------------------------------------- |
| 注册/登录     | 两个账号各自获得独立会话                                                      |
| 保存个人模型  | `USER_A` 和 `USER_B` 可以保存不同的服务商/模型                                |
| 模型发现/测试 | 每次测试使用当前账号自己的端点和密钥                                          |
| 配方隔离      | `USER_A` 保存的配方不出现在 `USER_B` 的列表中                                 |
| 豆子/历史隔离 | 豆子记录和历史记录按账号保存                                                  |
| xBloom 隔离   | 两个账号的 xBloom 会话和云端操作彼此独立                                      |
| 生成          | 每个账号使用自己的模型设置；共享模型（guest model）只覆盖未配置个人模型的账号 |
| 退出/会话     | 退出当前浏览器会话，不影响另一个账号                                          |
| 中国 Relay    | EdgeOne 可以把 API、Cookie 和流式路径转发到 Worker                            |
| Hosted 小红书 | D1 只保存 AES-GCM 密文；二维码会话和 Cookie 均以 owner 隔离                   |

## 发布流程

1. 更新版本化公开文档和 `CHANGELOG.md`。
2. 运行 `npm run verify`、`npm run check:release` 以及 Windows/Hosted 验收矩阵。
3. 检查 `git diff --check` 和 `git status --short`。
4. 创建与根 `package.json` 完全一致的 tag（当前为 `v0.2.1`），并使用仓库已有的发布 workflow 发布 GitHub Release。workflow 会拒绝版本不匹配的 tag，并从 tag 对应版本打包被 Git 跟踪的文件；打 tag 前确认所有公开文档都已被 Git 跟踪。
5. 发布 workflow 生成 Windows 压缩包和 checksum 时，将它们附在 GitHub Release 中。
6. 发布说明写入实际验证输出；标记为 `NOT RUN` 的项目同时列出人工跟进项。

## 隐私和回滚

- 发布压缩包只包含公开源码、文档、示例和构建输入；`.env`、本地 data、浏览器配置文件、xBloom/Xiaohongshu 会话、Worker 密钥和 EdgeOne 密钥都留在各自的配置边界。
- 常规 Hosted 升级保留两把应用密钥。需要轮换时，先定义迁移和回滚方案，再更新密钥。
- Windows 安装包回滚时，把用户本地 data 和 `.env` 与替换的压缩包分开保存；清理前先备份用户自己的本地数据。
- 发布门禁失败时，在发布产物说明中记录失败项，处理完成后再宣布版本。
