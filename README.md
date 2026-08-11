# xBloom AI Brew Studio

> Version 0.2.1 · Windows 本地版 + 多用户 Hosted 云端版 · BYOK

xBloom AI Brew Studio 会把咖啡目标、豆子、风味偏好和调研信息整理成可执行的 xBloom 配方。项目提供两种使用方式：

- **Hosted 云端版**：浏览器直接使用，支持多用户、账号隔离、个人模型配置和每个用户自己的 xBloom 云端同步。
- **Windows 本地版**：适合保存本地文件、使用本地调研工具、运行可选的小红书助手和可选的 Bluetooth 设备实验室。

新用户优先使用 Hosted 云端版即可完成主要流程；需要本地数据、本地工具或 BLE 设备时，再使用 Windows 本地版。

## 先选择使用方式

| 能力           | Hosted 云端版                                                                                          | Windows 本地版                                       |
| -------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 账号           | 注册并登录；数据按账号隔离                                                                             | 本机浏览器配置和本地文件                             |
| 模型接入       | 个人 BYOK，支持 OpenAI/GPT、Claude、Kimi、DeepSeek、Qwen、Gemini 和自定义 OpenAI-compatible 服务       | 通过本地 `.env` 或设置页面配置，同样支持这些模型协议 |
| 模型发现/测试  | 设置页面支持                                                                                           | 端点支持时可用                                       |
| xBloom         | 登录 xBloom 云端并按账号上传、管理配方                                                                 | 通过本地工作台登录并使用本地流程                     |
| 小红书         | 可选连接本机助手                                                                                       | 可选本地助手                                         |
| BLE 设备实验室 | Worker 不包含此能力                                                                                    | 可选 Windows/Python 设置                             |
| 数据链路       | 中国入口使用 EdgeOne、Pages API Relay、Cloudflare Worker 和 D1；见[中国部署说明](docs/DEPLOY_CHINA.md) | `127.0.0.1` 本地服务和项目数据                       |

## Hosted 云端版：第一次使用

1. 打开部署者提供的 Hosted URL。
2. 选择 **注册**，创建账号并登录。请使用至少 10 个字符的独立密码；高强度密码计算在浏览器本机完成，服务端只接收一次性登录凭据。
3. 打开 **Settings → Model**，选择模型预设或 **Custom OpenAI-compatible**。
4. 填入自己持有的模型 API key；需要时填写端点 URL。点击 **Discover models**，选择模型，点击 **Test**，最后点击 **Save**。
5. 填写冲煮目标并生成配方。当前账号的模型连接会用于这次请求。
6. 打开 **Cloud → xBloom**，选择服务显示的区域，使用自己的 xBloom 账号登录，然后上传或管理配方。
7. 如果调研需要小红书，在同一台 Windows 电脑上安装并启动本地助手，然后点击 **Connect local assistant**。助手是可选项；没有助手时，基础冲煮流程仍可使用。

### 支持的个人模型连接

账号设置页面提供以下预设：

- OpenAI / GPT
- Anthropic / Claude
- Kimi
- DeepSeek
- Qwen
- Google Gemini
- Custom OpenAI-compatible 服务

Kimi、DeepSeek 和 Qwen 使用 OpenAI-compatible 协议。Hosted Worker 调用自定义模型时，需要使用公开 HTTPS URL。模型测试或生成时，API key 会发送给所选模型服务；设置 API 不会再次返回已保存的 key。

### Hosted 凭证和隐私边界

- 模型 API key 归当前账号所有。每个账号都有独立的模型设置和 xBloom 云端会话。
- Hosted 服务会使用部署的应用数据密钥，加密保存模型 API Key 和 xBloom 登录凭据；模型 URL、模型名、配方与豆档案等业务字段保存在 D1。平台运营者仍掌握 Worker、D1、部署配置和运行日志，因此部署者属于独立的信任边界。
- 所选模型服务商会收到请求中的提示词和上下文。冲煮笔记中请只放本次任务需要的信息。
- xBloom 凭据只用于当前账号的 xBloom 云端操作。小红书凭据留在可选的本地助手流程中。
- 浏览器 Cookie 用于维持当前会话。在共享电脑上使用后请退出登录；不同用户使用独立浏览器配置文件。
- 默认部署不提供共享模型，用户使用自己的 BYOK。部署者只有主动配置 guest model 时才会承担该共享连接的模型费用。

## Windows 本地版：新电脑安装

发布包会根据自己的解压目录计算项目路径，不依赖开发者的源码目录或固定盘符。

### 安装前准备

- Windows 10 或更高版本，并可使用 PowerShell。
- 首次安装需要网络，用来下载项目内的 Node.js 运行时和依赖。
- 一个当前用户可写的本地目录。包含空格或中文的路径可按安装器的路径计算方式使用；可移动介质建议先复制到本机可写的 NTFS 目录，以减少文件权限和链接差异。
- 只有使用可选 BLE 设备实验室时才需要 Python 3.10+。xBloom App 上传流程不需要 BLE。

### 安装和启动

1. 下载 Windows 发布压缩包，解压到可写目录。
2. 在解压目录中双击 `install-windows.bat`，或运行：

   ```powershell
   .\install-windows.bat
   ```

   安装器会准备项目内的 Node.js 运行时，安装锁定依赖，构建各工作区，在需要时创建空白本地 `.env`，安装可选的小红书助手；如果电脑已经有 Python，也会尝试准备可选 BLE 环境。

3. 安装完成后会启动应用。如果浏览器没有自动打开，可以使用桌面快捷方式或运行：

   ```powershell
   .\start-xbloom.bat
   ```

4. 本地浏览器界面默认地址是 `http://localhost:5180`，API 默认监听 `127.0.0.1:8787`。小红书助手第一次启动时可能还会下载浏览器运行时。停止本地服务请运行 `stop-xbloom.bat`。

安装器针对 exFAT/FAT 提供物理依赖布局，不依赖 Windows 工作区链接；升级时仍建议把发布目录放在本机可写的 NTFS 卷上。重复运行安装器会刷新受管理的运行时、依赖并重新构建应用；清理文件时请保留用户自己的数据和 `.env`。

### 配置 Windows 本地版

1. 打开本地界面的设置页面。
2. 填写模型端点、模型名称和 API key；可以使用本地 `.env`，也可以使用支持的设置页面。
3. 在 Cloud 页面选择对应的 xBloom 区域，登录并上传配方。
4. 需要小红书调研时，启动本地助手并从页面完成配对。助手的登录状态保存在本机运行时目录中。
5. 只有在使用兼容的 Windows/Python 设备流程时才运行 BLE 设置；它和 xBloom App 云端上传是两条独立流程。

本地服务端默认绑定回环地址。`data/`、`.env`、`.runtime/` 和助手运行时目录都属于当前 Windows 用户的本地数据，请从其他人的电脑或发布压缩包中重新配置，不要直接复制会话状态。

## 开发和验证

从源码运行时使用 Node.js `>=22.12.0` 和仓库锁定的依赖：

```powershell
npm ci
npm run verify
```

本文不固定测试数量；当前检出版本的测试数量以 `npm run verify` 实际输出为准。

## 文档索引

- [配置说明](docs/CONFIGURATION.md) — Hosted 和本地模型、xBloom、小红书、调研与 BLE 设置。
- [功能说明](docs/FEATURES.md) — 能力矩阵和流程边界。
- [架构说明](docs/ARCHITECTURE.md) — 本地/Hosted 请求链路与凭证边界。
- [发布说明](docs/PUBLISHING.md) — 发布、全新电脑和多用户验收步骤。
- [中国部署说明](docs/DEPLOY_CHINA.md) — EdgeOne 前端/API Relay 加 Cloudflare Worker/D1。
- [Cloudflare 部署说明](cloudflare/README.md) — Worker/D1 部署和可选共享模型（guest model）。
- [变更记录](CHANGELOG.md) — 版本历史。

## 隐私和使用范围

这是冲煮工作台，不是统一的凭证管理器。模型、xBloom 和小红书账号都应属于当前用户；密钥、Cookie、恢复码和其他私密信息放在本地配置或服务的密钥存储中，避免出现在 issue、截图、commit 和发布压缩包中。使用个人数据前，请分别评估部署运营者、模型服务商、EdgeOne Relay 和本地助手这几个信任边界。

## License

见 [LICENSE](LICENSE)。
