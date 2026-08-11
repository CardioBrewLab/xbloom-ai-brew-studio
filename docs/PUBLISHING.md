# 发布到 GitHub

这份仓库已经包含许可证、CI、Release 打包、Issue/PR 模板、依赖更新和发布前凭据扫描。首次公开时按下面顺序操作。

## 1. 发布前检查

```powershell
npm ci
npm run verify
npm run test:install
npm audit
git diff --cached --check
git status --short
```

再确认 Git 实际跟踪内容中没有本机会话：

```powershell
git ls-files .env data tools/xhs-mcp
```

预期只会看到 `tools/xhs-mcp` 下的两个 PowerShell 脚本与发布校验清单；`.env`、`data/`、Cookie、下载的 EXE 和日志都不会出现。

## 2. 创建公开仓库

在 GitHub 新建一个空仓库，例如 `xbloom-ai-brew-studio`。创建时不要额外勾选 README、License 或 `.gitignore`，本地版本已经齐全。

使用 Git：

```powershell
git remote add origin https://github.com/YOUR_ACCOUNT/xbloom-ai-brew-studio.git
git push -u origin main
```

也可以使用 GitHub CLI：

```powershell
gh auth login
gh repo create xbloom-ai-brew-studio --public --source . --remote origin --push
```

## 3. 仓库设置

建议在 GitHub 网页完成这些设置：

1. **Settings → Code security and analysis**：开启 Secret scanning 与 Push protection；
2. **Settings → Rules → Rulesets**：保护 `main`，要求 Pull Request 与 `CI / verify` 通过；
3. **Settings → Actions → General**：允许仓库工作流运行，并允许 Release 工作流获得 `contents: write`；
4. **Settings → Security → Private vulnerability reporting**：开启私密漏洞报告；
5. 在仓库 About 中添加截图、项目描述和 `xbloom`、`coffee`、`react`、`typescript`、`windows` 等 Topics。

## 4. 发布首个安装包

确认 `main` 的 CI 通过后推送版本标签：

```powershell
git tag -a v0.1.1 -m "xBloom AI Brew Studio v0.1.1"
git push origin v0.1.1
```

`.github/workflows/release.yml` 会先在只读权限的验证任务中安装锁定依赖、执行全部测试和发布安全检查；通过后，独立的发布任务只归档已验证提交，不再执行仓库脚本，并生成：

- `xbloom-ai-brew-studio-v0.1.1-windows.zip`
- 对应的 `.sha256` 校验文件
- GitHub Release 与自动生成的变更说明

下载 ZIP 后在一台干净 Windows 用户环境中再走一遍 `install-windows.bat`，随后检查三处首次配置入口：模型 URL/Key、小红书扫码、xBloom 自有账号登录。

## 5. 后续版本

每次发布前更新版本号和变更说明，再使用新的语义化标签。账号、Token、Cookie 或 Key 如果曾进入 Git 历史，应立即轮换对应凭据，并在公开前清理历史；只删除当前文件并不能清除旧提交。

参考：

- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [Repository rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Secret scanning push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection)
