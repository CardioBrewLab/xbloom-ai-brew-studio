# 贡献指南

感谢你愿意改进 xBloom AI Brew Studio。本项目优先接受边界清楚、可复现、带验证结果的改动。

## 开发环境

- Windows 10/11
- Node.js 22.12.0+
- npm 10+

```powershell
npm ci
npm run build
npm run test:all
```

## 项目约定

1. **保留现有能力。** PR 若调整接口、字段、页面入口、数据格式或启停脚本，需要给出兼容策略和回归测试。
2. **先复用再新增。** 配方 Schema 放在 `shared/`；通用前端组件放在 `web/src/components/`；外部服务访问集中在后端 `lib/`。
3. **本地数据不进仓库。** `.env`、`data/`、小红书 Cookies、xBloom 会话、日志、下载的程序和浏览器目录都只留在本机。
4. **外部调用有边界。** 校验输入，设置超时，错误响应中隐藏 Key、Cookie、Token 与上游正文。
5. **避免把配置写死。** 模型 URL、模型 ID、Key、账号和区域均通过设置页或环境变量提供。

## 提交前检查

```powershell
npm run format
npm run verify
```

PR 请写清：

- 解决的问题与使用场景
- 影响的模块、接口和本地数据
- 兼容性与回退方式
- 实际执行的测试命令及结果
- 涉及界面时附桌面截图

## Issue 建议

Bug 请附版本、Windows 版本、复现步骤、期望结果与脱敏后的相关日志。功能建议请先描述实际冲煮流程，再说明希望减少哪一步操作。
