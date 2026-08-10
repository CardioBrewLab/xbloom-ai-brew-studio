# 2026-08-11 Release Readiness Review

## 结论

**PASS**。独立 reviewer 的首轮审查发现 4 项 Medium；全部完成修复、定向测试和全量回归，复审结果为 PASS，剩余 High/Medium 为 0。

## 四视角审查

| 视角              | 审查重点                                                                      | 结论与证据                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 手冲咖啡从业者    | 粉量、粉水比、研磨、水温、流速、分段、闷蒸、旁路水、冲煮时长与风味目标        | 共享 RecipeSchema、硬件边界、分段配平、7 维评分与 AI review 共同约束；服务端全量测试 546/546。                            |
| xBloom 第三方设计 | 官方云端写入、读回校验、云端 ID 绑定、手机 App 主链、BLE 边界                 | 主流程保持“电脑生成与复核 → 官方云端 → 手机 xBloom App”；BLE 仅作默认折叠实验；写入与读回、App 可达值、幂等重试均有测试。 |
| 手冲爱好者        | Fast / Pro / Max、豆仓、历史、曲线、计时引导、原版与 AI 版比较、登录反馈      | 桌面三栏工作台和三模式已完成浏览器回归；小红书与 xBloom 状态实测在线且登录有效；界面控制台无 error/warning。              |
| 代码审核者        | 凭证、会话、输入、超时、并发写、路径、进程归属、开源脱敏、Cloudflare 滥用成本 | 发布安全扫描通过；根项目和 Cloudflare `npm audit` 均为 0；XHS 二进制固定 SHA-256；会话、代理和三级配额问题已关闭。        |

## 独立审查问题闭环

1. **xBloom Token 落盘**：`server/src/lib/xbloom-cloud.ts:212-287` 使用 Windows DPAPI 保护完整会话；历史明文格式兼容读取后原位升级，Token、邮箱和 memberId 不再明文出现。测试：`server/test/xbloom-cloud.test.ts:459`。
2. **XHS Cookie 路径不一致**：`server/src/lib/xhs-cookie-import.ts:56-62` 与启动脚本统一到 Git 忽略且 ACL 收紧的 `tools/xhs-mcp/runtime/cookies.json`。测试：`server/test/xhs-cookie-import.test.ts:61`。
3. **代理凭证暴露**：`server/src/lib/xbloom-cloud.ts:1161-1169` 的状态文案只报告代理是否启用，不回传代理 URL 或 userinfo。
4. **Hosted 配额绕过**：`cloudflare/src/session.ts:19` 对 Cloudflare 边缘 IP 做 HMAC 分组；`cloudflare/src/index.ts:135-160` 同时执行浏览器 20、网络 60、全站 500 次/小时三级限额。测试：`cloudflare/test/session.test.ts:7`。

## 终验命令

```powershell
npm run verify
npm audit --json
npm --prefix cloudflare audit --json
```

- `npm run verify`：Prettier、198 文件发布安全扫描、server 546、web 142、Cloudflare 4 项测试、完整构建、Wrangler dry-run 全通过。
- 依赖审计：根项目与 Cloudflare 均为 0 vulnerability。
- Windows 修复版 XHS MCP SHA-256：`C8A8A4905C38727A244D5AE0F10743A9BB558B031B147DD142A302758743E10A`。
- 完整日志：`.codex/test_open_source_release_after_review_20260811.log`。
