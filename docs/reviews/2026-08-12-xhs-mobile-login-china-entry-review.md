# Code Review Summary: 小红书手机登录与中国入口

**Date:** 2026-08-12

**Project:** xBloom AI Brew Studio

**Reviewer:** Codex 主代理 + 独立差异审查

**Result:** PASS

## Overview

本次审查覆盖 Hosted 小红书取码、Browser Run 会话、登录完成判定、Cookie 加密持久化、手机 App 跳转、返回网页续查，以及中国大陆公开入口文档。

## Findings and resolutions

| 级别   | 发现                                                    | 处理                                                                      |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Medium | 扫码成功只检查头像 DOM，页面时序或改版会漏判            | 同时校验完整会话 Cookie、页面用户状态与 DOM，并在 App 返回/页面重载时续查 |
| Medium | 手机网页仍展示二维码，没有使用登录响应中的原生 deeplink | 捕获小红书取码接口返回的扫码 deeplink，经官方 OIA HTTPS 入口唤起 App      |
| Medium | 任意轮询连接异常都会清空二维码会话                      | 有效期内保留会话与 `pendingLogin`，到期后再关闭 Browser Run 会话          |
| Medium | 取码失败也会占用站内日预算                              | Browser Run 启动前失败时回退本次预算；平台 429 显示额度边界               |
| Low    | 窄桌面窗口可能被误判成手机并触发 App 跳转               | 跳转判定只依据真实移动 UA / iPadOS 触控特征                               |
| Low    | 自定义协议校验未显式拒绝端口                            | 前后端白名单同时拒绝端口、凭据、片段和非登录路径                          |

## Verification

- `npm run verify`：PASS；格式、发布安全、server/web/hosting/Cloudflare 测试、构建、集成和 dry-run 全部通过。
- Web：172 tests passed。
- Cloudflare：43 tests passed。
- Hosted integration：`PASS: auth, sessions, CSRF/proxy, per-user data isolation, provider onboarding and xBloom preview`。
- `npm run check:hosted-url -- https://xbloom-ai-brew-studio.lacy-yarn.workers.dev/`：首页 200、API 200、部署类型 `cloudflare`。
- Cloudflare production version：`80a146d4-5b17-427a-b4ea-aba15c43c103`。

## Runtime boundary

最终线上取码探测准确返回 Browser Run 额度提示；本回合多次真实取码测试已用完 Free 计划当日 10 分钟，完整手机扫码确认链路需在日额度恢复后做一次人工 App 确认。该限制来自平台用量，不改变已通过的 API、状态机、跳转白名单和持久化测试结论。

## Final verdict

`PASS`：最终差异未发现 high/medium 遗留问题。
