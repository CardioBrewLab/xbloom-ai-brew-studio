# 2026-08-12 模型配置、Companion 与豆信息解析终审

## 范围

- 自定义模型根地址自动识别 `/v1`、模型发现、连接测试与 API Key 复用边界。
- Hosted 页面连接本机小红书助手的配对、Origin、令牌升级与撤销链路。
- 豆信息 AI 解析的超时、推理强度和 token 参数。
- OpenAI GPT-5+、o1/o3/o4 与普通兼容模型的请求参数分流。

## 已关闭问题

1. 根地址返回网页时，模型发现会在同一时间预算内尝试同源 `/v1`，错误文案不再误报请求体 JSON。
2. 模型识别、测试与保存只在“等价地址 + 相同 provider”范围内复用已保存 Key。
3. Companion 配对按网页 Origin 隔离，磁盘仅保存随机令牌的 SHA-256 摘要；非 HTTP(S) 回环来源被拒绝。
4. Companion 网页存储升级到 v3，旧 v1/v2 配对项主动清理；401 会立即回到可重新连接的离线态。
5. 豆信息解析使用 60 秒任务时限、低推理强度与 700 token 上限；真实 UTF-8 输入已完成联调。
6. GPT-5+ 与 o1/o3/o4 使用 `max_completion_tokens` 并省略 `temperature`，普通兼容模型保持原参数契约。

## 验证

| 门禁                                         | 结果                                           |
| -------------------------------------------- | ---------------------------------------------- |
| `npm run verify`                             | PASS                                           |
| Server                                       | 563/563                                        |
| Web                                          | 151/151                                        |
| EdgeOne / Hosted URL / Relay                 | 6/6、8/8、3/3                                  |
| Cloudflare 单测 / 集成 / typecheck / dry-run | 30/30；集成 PASS；typecheck 与 dry-run PASS    |
| Release safety                               | 243 个文件，未发现会话、运行产物或常见密钥模式 |
| D 盘本地版 Server                            | build PASS；558/558                            |
| 独立审查                                     | PASS；high/medium = 0                          |

测试证据：

- `.codex/test_verify_final_pass.log`
- `.codex/test_targeted_final_review_round.log`
- `D:\CodexProjects\xbloom-ai-brew-studio\.codex\test_server_build_final_review_fixes.log`
- `D:\CodexProjects\xbloom-ai-brew-studio\.codex\test_server_full_final_review_fixes.log`
- `D:\CodexProjects\xbloom-ai-brew-studio\.codex\test_live_bean_parse_utf8_after_low_reasoning.log`

## 结论

最终 diff 通过格式、测试、构建、敏感信息扫描、Cloudflare dry-run 与独立代码审查，可进入部署和发布流程。
