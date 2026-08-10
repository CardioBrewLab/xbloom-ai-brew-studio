# Third-party notices

## xiaohongshu-mcp

一键安装脚本使用 [`xpzouying/xiaohongshu-mcp`](https://github.com/xpzouying/xiaohongshu-mcp) `v2.4.3` 源码构建的 Windows 修订版，并对随仓库发布的二进制核对 SHA-256。修订仅在 Windows 上关闭 go-rod 的 leakless 辅助进程，改由 MCP 服务直接管理浏览器生命周期，以修复辅助进程未回传 PID 时工具调用长期等待的问题。可复现构建脚本见 `tools/xhs-mcp/build-windows-fixed.ps1`。该组件及其依赖按原许可证发布；浏览器运行目录与每位使用者的 Cookies 均保持在 Git 忽略目录。

## xbloom-agent

xBloom 云端协议实现曾参考 [`denull0/xbloom-agent`](https://github.com/denull0/xbloom-agent) 的公开实现。该项目采用 MIT License。此处保留来源说明，便于后续核对协议变化。

## npm dependencies

React、Vite、Express、Zod、ECharts、Tailwind CSS、QRCode、Undici 及其他 npm 依赖分别遵循其上游许可证；精确版本记录在 `package-lock.json`。

## Trademarks

xBloom、小红书及其他产品名称和商标归各自权利人所有。本项目为独立社区项目。
