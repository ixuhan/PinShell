# M6 更新发布

更新源使用 GitHub Releases 的静态 `latest.json`，支持 Windows x64 的 NSIS 与 MSI。Tauri updater 对更新包执行 minisign 验签；开发和普通本地构建不会启用 updater 插件或生成更新包。

## 两条流水线

| 工作流 | 触发 | 做什么 |
| --- | --- | --- |
| `build.yml` | push `main` / 手动 | 只做构建验证，安装包留在 Actions artifact，**不写 Releases** |
| `release.yml` | push `v*` tag | 构建 + 签名更新包 + 创建 GitHub Release（安装包、`.sig`、`latest.json`） |

`Releases` 里出现新版本，靠的是 `release.yml`：只 push 代码不会产生 Release，必须打 tag。

## 发一个版本

1. 改版本号：`package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 保持同一版本，例如 `0.1.2`。
2. 提交并 push 到 `main`（顺带触发一次构建验证）。
3. 打 tag 并推送：`git tag v0.1.2 && git push origin v0.1.2`。
4. `release.yml` 跑完后到 Releases 检查：`PinShell_0.1.2_x64-setup.exe`、`PinShell_0.1.2_x64_en-US.msi`、对应的 `.sig`，以及 `latest.json`。

`latest.json` 由 tauri-action 依据签名生成，客户端 `GET .../releases/latest/download/latest.json` 读它做版本比较。`updaterJsonPreferNsis: true` 表示 Windows 更新走 NSIS 安装包（对应 `installMode: passive`）。

## 签名密钥

发布构建必须带 `TAURI_SIGNING_PRIVATE_KEY`，否则 `tauri build` 会在签名更新包这步直接失败——宁可不发，也不发客户端验不了签的更新。

已配置的仓库 secret：

- `TAURI_SIGNING_PRIVATE_KEY`：minisign 私钥全文（当前无密码）。
- `TAURI_SIGNING_PUBLIC_KEY`：公钥全文；同时用于发布构建时把公钥编译进二进制。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：留空/未设置即无密码。

公钥另外写死在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，打包时用它校验私钥是否配错；运行时插件由 `main.rs` 的 `updater_pubkey()` 取环境变量，取不到再退到编译期烧进去的那一份（`option_env!`），所以发布包里更新入口可用、本地开发里默认关闭。

重建密钥（会让已装客户端无法验签，除非同时轮换发版）：
`npm run tauri -- signer generate -w "$HOME/.tauri/pinshell.key"`，把 `.pub` 内容写进配置和 secret。私钥文件不要进仓库，丢了就无法再给已发布公钥签更新。

## 本地构建

`src-tauri/tauri.release.conf.json` 只在发布流水线用 `--config` 叠加，开了 `bundle.createUpdaterArtifacts`。本地 `npm run app:build` 不叠加它，所以照常产出普通 NSIS/MSI，不需要签名密钥。

如果要在本地验证签名产物：`$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$HOME\.tauri\pinshell.key" -Raw`，再 `npm run app:build -- --config src-tauri/tauri.release.conf.json`。

## 当前限制

- 自动升级的端到端验收需要至少两个真实签名的 Release（旧版安装包 + 新版更新包），并在隔离 Windows 用户或虚拟机里实测安装、下载、验签、替换全过程；单元测试和 CI 构建都不能代替这一步。`v0.1.0` 是不带签名的旧包，不能作为升级基线。
- 安装版数据目录沿用已有规则：先尝试 exe 同级便携 `data`，不可写才回退 `%APPDATA%\PinShell`。旧安装数据自动迁移仍需单独设计与验收。
- 只发 Windows x64；其它平台没有构建矩阵。
