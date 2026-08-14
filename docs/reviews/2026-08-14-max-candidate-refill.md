# Code Review Summary: MAX Candidate Refill

**Date:** 2026-08-14

**Project:** xBloom AI Brew Studio 0.2.2

**Reviewers:** Luna Max read-only reviewer + primary implementation agent

**Result:** PASS

## Overview

本轮修复 MAX 首轮并发生成出现“部分成功、部分网关限流”时留下失败候选的问题。本地服务与 Hosted Worker 都保留已经成功的方案，只对可恢复的失败槽位串行补发；前端持续展示完整的三候选列表，并按候选下标更新补发结果。

## Root Cause

- 本地服务原有 `3→2→1` 降并发逻辑只在首轮全部失败时执行，部分成功会直接进入评分。
- Hosted 高分获胜方案会跳过低分改进轮，因此 `1 成功 + 2 失败` 会原样显示。
- 补发轮的 `n/total` 表示本轮工作量，旧前端却用它决定完整候选卡的行数与渲染门。

## Review Rounds

### Round 1

**Issues Found:** 2（medium: 1，low: 1）

| Severity | Issue                                                  | Resolution                                                                                                     |
| -------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| medium   | Hosted 畸形 JSON 的 `SyntaxError` 未进入可恢复补发分类 | 新增统一 `isHostedCandidateRetryable` 判定，覆盖 `SyntaxError`、瞬时 HTTP 和传输错误；404 等永久错误保持原分类 |
| low      | 补发 `n=1/2` 时候选卡按本轮数量隐藏首轮结果            | 新增 `candidateDisplayCount`，按完整候选下标计算展示槽位                                                       |

### Round 2

**Issues Found:** 1（low: 1）

| Severity | Issue                                                                            | Resolution                                                     |
| -------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| low      | `CandidatePickCard` 已修正，但 `StreamPanel` 父级仍按 `total > 1` 隐藏单槽补发卡 | 父级渲染门同步使用 `candidateDisplayCount`，并加入源码契约测试 |

### Round 3

**Issues Found:** 0

**Verdict:** PASS

## Implemented Behavior

- 首轮仍并发生成三份方案，保持正常网关下的速度。
- 出现部分 429、瞬时网络错误或可恢复格式错误时，成功候选原位保留，失败槽位按下标串行补发。
- 补发提示会携带新的 `round`，前端保留旧结果，并用新结果覆盖同一候选下标。
- 补发成功后仍执行差异去重与评分选择；永久端点错误不做重复请求。
- Hosted 补发受独立预算与整体 112 秒预算共同约束，继续位于 EdgeOne 120 秒 Relay 上限内。

## Verification

- 本地定向回归：Server 16/16、Web candidate state 36/36、Cloudflare 75/75。
- 审查修复回归：Web 202/202、Cloudflare 77/77。
- 最终 `npm run verify`：见 `.codex/test_verify_max_candidate_refill_final_20260814.log`。
- 最终 `git diff --check` 与独立审查：PASS；结构化结果见 `.codex/review.result.json`。

## Final Result

最终 diff 的 high、medium、low 可执行问题均已清零，独立审查结果为 `PASS`。
