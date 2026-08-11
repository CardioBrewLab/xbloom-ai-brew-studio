# 中国网络入口（EdgeOne Makers + Cloudflare Worker）

这套部署把职责拆成两层：

- **EdgeOne Makers**：返回 `web/dist` 静态界面，并把 `/api/*` 流式转发到后端；
- **Cloudflare Worker + D1**：注册登录、账号隔离、模型 API Key 与 xBloom 凭据加密、豆仓、历史、生成和 xBloom 云端上传。

电脑关机后两层仍由云平台运行。每位用户登录自己的工作台账号，再保存自己的模型接口与 xBloom 账号；小红书是可选的本地助手，Cookie 留在用户电脑。

## 1. 先部署 Worker

在仓库根目录运行：

```powershell
.\deploy-cloudflare.bat
```

脚本会创建/复用 D1、应用全部迁移、补齐数据加密与代理密钥，再部署 Worker。新站点无需配置部署者的模型 Key；每位用户进站后自行选择模型服务。

## 2. 建立 EdgeOne Makers 项目

1. 将仓库导入 EdgeOne Makers；
2. 构建设置由根目录 `edgeone.json` 自动读取；
3. 在 Production 环境添加：
   - `CLOUDFLARE_WORKER_ORIGIN=https://你的-worker.workers.dev`
   - `EDGE_PROXY_SECRET=与 Worker 完全相同的随机值`
4. 触发一次新部署；旧部署不会自动获得刚添加的环境变量。

`edge-functions/api/[[default]].js` 会清理伪造的代理头，写入受共享密钥保护的来源标记，并原样转发 SSE 与 `Set-Cookie`。

## 3. 选择访问区域

- 日常测试可先使用平台预览地址；
- 稳定公开使用建议绑定自己的域名；
- 选择中国大陆或全球（含中国大陆）节点时，域名需先完成 ICP 备案；
- 尚无备案域名时，可先选全球（不含中国大陆）并保留 Cloudflare 地址作为备用入口。

## 4. 验收

依次检查：

1. 注册两个测试账号；
2. 两个账号分别保存不同模型地址，并执行“识别模型”“保存并测试”；
3. A 账号创建豆档案/配方，B 账号列表保持独立；
4. FAST、PRO、MAX 各生成一次，MAX 三份参数快照应互不重复；
5. 登录个人 xBloom 账号，执行发布预演、上传和列表回读；
6. 小红书不登录时生成照常；连接本地助手后，PRO/MAX 显示公开来源与小红书状态。
