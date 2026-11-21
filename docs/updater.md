# M6 更新发布

更新源使用 GitHub Releases 的静态 `latest.json`，支持 Windows x64 的 NSIS 与 MSI。Tauri updater 对更新包执行 minisign 验签；开发和普通本地构建不会启用 updater 插件或生成更新包。

## 首次配置

1. 在安全的发布机上生成密钥，私钥保存在仓库之外：
   `npm run tauri -- signer generate -- -w "$HOME/.tauri/pinshell.key"`
2. 将命令输出的公钥保存为 GitHub Actions secret `TAURI_SIGNING_PUBLIC_KEY`。
3. 将私钥文件内容保存为 secret `TAURI_SIGNING_PRIVATE_KEY`；有密码时同时保存 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。不要把私钥、密码或生成的 `.key` 文件提交到仓库。
4. 发布工作流尚未实现；需要完成签名构建、生成 `latest.json` 并上传安装包及签名后，才能发布更新。

私钥丢失意味着无法为已发布公钥签发后续更新；需妥善备份并限制 CI secret 访问。更换公钥会让已经安装旧公钥的客户端无法验证新密钥签发的更新，需单独设计密钥轮换版本。

## 当前限制

- 尚未配置任何签名密钥，也没有真实的安装包发布；因此设置中的更新入口保持禁用，不能把模板清单当作有效发布。
- 安装版数据目录目前沿用已有规则：先尝试 exe 同级便携 `data`，不可写才回退 `%APPDATA%\PinShell`。只有目标不可写且发现明确旧数据的迁移策略与中断恢复验收完成后，才可宣称旧安装数据自动迁移。
- 自动升级端到端验收需要至少两个带真实签名的 release（旧版安装包及新版更新包），并在隔离 Windows 用户/虚拟机中执行。单元测试不能代替实际 NSIS/MSI 更新验证。
