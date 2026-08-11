# Cloudflare Pages API Relay

该中转只接受 `/api` 路径，用于解决部分 EdgeOne Cloud Function 无法直接访问 `workers.dev` 的网络兼容问题。它不会保存用户数据、模型密钥或登录 Cookie；请求仍由主 Cloudflare Worker 和 D1 处理。

在已完成主 Worker 部署后运行：

```powershell
.\cloudflare-pages-relay\deploy-relay.ps1 `
  -ProjectName YOUR_RELAY_PROJECT `
  -UpstreamOrigin https://YOUR_WORKER.workers.dev
```

脚本只在系统临时目录生成一次性部署包并注入上游地址，上传结束后立即删除临时包；仓库不会记录部署者的 URL。部署完成后，把返回的 `https://YOUR_RELAY_PROJECT.pages.dev` 填入 EdgeOne 的 `CLOUDFLARE_WORKER_ORIGIN`。
