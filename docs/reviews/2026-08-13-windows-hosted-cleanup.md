# Windows Hosted Integration Cleanup Review

**日期：** 2026-08-13

**范围：** Cloudflare 托管集成测试退出清理、Dependabot 编译器大版本策略

**结论：** PASS

## 根因与修复

GitHub Actions 的 Windows runner 偶发在 `workerd` 进程树退出前清理 Wrangler 持久化目录，触发 `EBUSY`。测试现改为先等待子进程退出，再使用 Node.js `fs.rm` 的有界重试窗口回收目录。依赖自动更新继续覆盖 TypeScript 的 minor/patch，编译器 major 留给单独迁移与完整回归。

## 审查清单

- 进程退出监听在终止命令之前注册，避免漏接快速退出事件。
- 等待有 10 秒上限，不会让 CI 无限挂起。
- 临时目录删除保留 `recursive` 与 `force`，并仅对短暂文件锁执行有界重试。
- Windows 使用 `taskkill /T /F` 结束完整进程树；其他平台维持 `SIGTERM` 路径。
- 修改仅位于测试基础设施与 Dependabot 配置，未触及业务接口、用户数据、登录态或线上运行代码。

## 验证

| 门禁                              | 结果                         |
| --------------------------------- | ---------------------------- |
| 托管集成测试连续 3 轮             | 3/3 PASS；每轮临时目录残留 0 |
| `npm run verify`                  | PASS                         |
| Prettier                          | PASS                         |
| 发布安全扫描                      | 286 个文件；PASS             |
| 服务端 / 网页端 / Cloudflare 测试 | PASS                         |
| Wrangler dry-run                  | PASS                         |
| `git diff --check`                | PASS                         |

详细日志保存在本地 `.codex/test_hosted_cleanup_repeat_20260813.log` 与 `.codex/test_verify_windows_cleanup_20260813.log`。外部 CLI reviewer 的两次调用均停在本机 ChatGPT 插件认证 401，原始记录保存在 `.codex/auto_review_windows_cleanup_round1*.log`；随后按上述清单完成本地严格审查，未发现 high、medium 或 low 问题。
