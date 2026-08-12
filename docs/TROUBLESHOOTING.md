# 常见问题

## 页面没有自动打开

1. 再双击一次 `start-xbloom.bat`；守护程序有单实例保护。
2. 手动打开 `http://localhost:5180`。
3. 查看 `data/xbloom-watchdog.log`、`data/xbloom-backend.log`、`data/xbloom-backend-error.log`、`data/xbloom-frontend.log` 与 `data/xbloom-frontend-error.log`。
4. 运行 `stop-xbloom.bat` 后重新启动，释放由本项目拥有的 8787/5180 进程。

若端口已被其他软件占用，可在 `.env` 调整后重启：

```dotenv
PORT=18787
WEB_PORT=15180
```

watchdog 会把 API 目标同步到 Vite 的 `VITE_API_PROXY_TARGET`。如果该变量被手动设置，必须使用绝对 HTTP/HTTPS 地址，不能带凭据、查询参数或片段；非法值会在 Vite 启动前给出错误。

小红书助手和桌面快捷方式属于可选步骤。助手下载、校验、杀毒软件或桌面权限失败时，安装器会保留核心应用并显示警告；也可以显式运行 `.\scripts\install-windows.ps1 -SkipXhs -SkipShortcut -SkipLaunch`。

若 `.env` 中的 `SEARXNG_URL` 或 `XHS_MCP_URL` 指向远端或其他本机端口，watchdog 会跳过固定 8899/18060 的本地自愈，避免启动无关的 Docker 或助手进程。

## 模型连接测试失败

### HTTP 401 / 403

核对 API Key、账号额度以及该 Key 是否有权调用所填模型。

### HTTP 404

常见原因是 API 地址缺少 `/v1`，或服务商采用了其他兼容路径。最终请求地址为：

```text
{你填写的 API 地址}/chat/completions
```

### HTTP 400

核对模型 ID 是否与服务商控制台完全一致。部分网关对 `reasoning_effort`、`seed` 或 `max_tokens` 有自己的要求，可先用其文档中的最小 Chat Completions 样例确认。

### 连接超时

检查网络、代理和网关域名；需要代理时在 `.env` 填写 `HTTPS_PROXY` 或 `ALL_PROXY`，再重启工作台。

## 小红书二维码一直加载

首次运行会下载浏览器组件，时间明显长于日常启动。可查看：

```text
tools/xhs-mcp/xhs-mcp.out.log
tools/xhs-mcp/xhs-mcp.err.log
```

也可手动执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\xhs-mcp\start-xhs-mcp.ps1
```

脚本会核对随仓库发布的 Windows 修订版 SHA-256，并等待 `http://127.0.0.1:18060/health` 就绪。该修订处理了 go-rod 的 leakless 辅助进程在 Windows 上未回传 PID、导致登录检查停在加载中的情况。默认使用无窗口模式；排查网站兼容问题时可在 `.env` 写入 `XHS_HEADLESS=false` 后重启。

若日志停在 `fingerprint enabled`，重新运行 `install-windows.bat` 会从校验过的内置副本恢复修订版，不会改动 `tools/xhs-mcp/runtime/cookies.json`。

## 小红书扫码后仍显示未登录

- 手机网页点击登录后会经小红书官方入口唤起 App；在 App 内确认，再返回原网页；
- 电脑网页继续使用二维码，扫码后在手机 App 内完成确认；
- 页面会立即补查并持续轮询；移动系统重载页面时，后端也会从仍有效的云端浏览器会话继续确认；
- 顶栏显示“确认中”时保留当前会话，不要重新取码；到期后再获取新会话；
- 使用页面提供的 Cookie 导入入口后再次验证；
- 退出账号会删除本机 Cookies，下一次需要重新扫码。

## 上传后手机 App 里没看到配方

1. 确认发布面板显示上传成功，并记录返回的分享链接或云端条目。
2. 核对工作台与手机 App 是否使用同一个 xBloom 账号。
3. 核对区域：全球区使用 `XBLOOM_REGION=global`，中国区使用 `XBLOOM_REGION=cn`。
4. 在手机 App 中刷新配方列表，必要时重新进入账号页面。
5. 若配方来自云端载入，工作台会更新原条目；若是新生成配方，则会创建新条目。

## SearXNG 显示离线

SearXNG 是可选来源。Docker Desktop 和 `xbloom-searxng` 容器可用时，守护程序会尝试恢复它；即使该来源离线，调研仍会继续尝试小红书、Firecrawl 和网页搜索。

## Windows 蓝牙列表里找不到 xBloom

xBloom 设备通过 BLE 广播，Windows“添加设备”页面未必会像耳机一样列出它；本项目的设备实验室使用 Python Bleak 主动扫描厂商服务 UUID。先确认机器已通电、靠近电脑，并退出正在占用设备连接的手机 xBloom App，再运行：

```powershell
.\install-ble.ps1
```

重启工作台后展开“设备实验室”并扫描。它是协议实验入口；稳定日常路径是将配方上传到手机 xBloom App。协议参考与归因见 `THIRD_PARTY_NOTICES.md`。

## 停止服务

双击 `stop-xbloom.bat`。脚本会核对当前副本的完整入口命令与可执行文件路径，再停止后端、前端和本副本的小红书 MCP。SearXNG 容器与 Docker Desktop 属于用户管理的共享服务，会继续运行。

## 重新安装本地运行环境

先关闭工作台，再将 `.runtime` 和 `node_modules` 移到备份目录，然后重新运行 `install-windows.bat`。`data/` 与 `tools/xhs-mcp/runtime/cookies.json` 是用户数据，保留它们即可延续本地记录与登录态。

## 安装在 exFAT 移动盘或数据盘

安装器会读取目标磁盘格式。NTFS/ReFS 使用标准 npm workspace 目录链接；exFAT/FAT 自动安装物理依赖并生成本地 `@xbloom/shared` 包，因此项目目录可继续放在该数据盘。启动守护程序也会按磁盘格式选择对应构建命令。

发布前的跨电脑回归命令如下，它会创建一份不带账号和历史数据的隔离副本：

```powershell
npm run test:install
```
