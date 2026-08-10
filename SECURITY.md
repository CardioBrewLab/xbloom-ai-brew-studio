# Security Policy

## Supported version

安全修复以最新 GitHub Release 为准。

## 报告方式

请通过 GitHub 仓库的 **Security → Report a vulnerability** 私下提交，附复现步骤、影响范围和最小化样例。公开 Issue 适合一般 Bug，不适合粘贴 API Key、Cookie、Token、邮箱、会话文件或完整日志。

## 本地敏感数据

- 模型 Key 由设置页保存时使用 Windows DPAPI 绑定当前用户。
- xBloom 云端密码不写入本地会话文件；会话 Token 使用 Windows DPAPI 绑定当前用户后写入已忽略的 `data/session.json`。
- 小红书会话保存在已忽略的 `tools/xhs-mcp/runtime/cookies.json`，运行目录使用仅当前用户、SYSTEM 与管理员可访问的 ACL。
- 服务默认仅监听本机回环地址。

提交前运行 `npm run check:release`，并在 GitHub 仓库设置中开启 Secret scanning 与 Push protection。
