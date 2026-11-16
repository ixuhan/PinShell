# 调研四：pwsh 的 OSC 133 可行性实测

> 时间：2026-11-16 20:50 · 环境：Windows 11 + pwsh 7.6.6 + portable-pty 0.9.0（ConPTY）
> 方法：独立探针（临时 Cargo 工程 + `pwsh -NoLogo -NoExit -Command ". script"`），**不碰主工程、不启动 app**。
> 目的：验证 ADR 0003 依赖的信号源是否真的能从 pwsh 稳定拿到。

## 结论先行

**可行。** `133;A/B/C/D` 与 `OSC 7`（CWD）全部能穿过 ConPTY 稳定到达，顺序正确。但有三个坑，不按下面的形状写就会得到空转或错码。

## 实测矩阵

| 场景 | 期望 | 实测 |
|---|---|---|
| 启动首个提示符 | `A` + `7`，不得有 `D` | ✅ 只有 A/7 |
| `echo hi` | `C` → 输出 → `D;0` → `A/7` | ✅ |
| `cmd /c exit 7` | `D;7` | ✅ |
| `Write-Error 'boom'` | `D;1` | ✅（取码逻辑修正后；未修正时错报 7） |
| 失败后 `echo ok` | `D;0` | ✅（同上，未修正时错报 7） |
| `Start-Sleep 2` | `C` 立即出现，`D` 延迟约 2 s | ✅ |
| 运行中按 Ctrl+C | `D;1` | ✅ pwsh 会补发 `D`，比 bash 可靠 |
| `cd 'C:\Program Files'` | OSC 7 带 `%20` | ✅ `file://HANK/C:/Program%20Files` |
| `exit` | `B` + `C`，然后流结束、无 `D` | ✅ 可接受（会话结束） |

## 三个坑

### 1. 必须调用「原来的」`PSConsoleHostReadLine` 函数

直接调静态方法 `[Microsoft.PowerShell.PSConsoleHostReadLine]::ReadLine($Host.Runspace, $ExecutionContext)` 会让宿主立刻拿到 `$null` 并重新调 `prompt`：**实测 3 秒内产生 4531 个标记（约 1500 次/秒）**，进程空转、屏幕刷屏。

正确写法是捕获 `$function:PSConsoleHostReadLine` 再 `& $orig`。

### 2. `prompt` 返回空串会在输出流里留下 `PS>`

`prompt` 里手动写提示符、再 `return ''`，流里会多出 `PS>`；改成 `return ' '` 只是把那两个字符换成一个空格。两种都会污染屏幕。

正确做法：**保留用户原来的 `prompt` 函数**（捕获后调用，返回它的文本），把 `133;B` 延后到 `PSConsoleHostReadLine` 返回时、`133;C` 之前发出。屏幕上顺序仍是 `A → 提示符文本 → B → C`，既无残字也不吃掉用户主题（oh-my-posh 这类返回字符串的提示符照样工作）。

### 3. `$LASTEXITCODE` 会陈旧

`Write-Error` 之后 `$LASTEXITCODE` 仍是上一条原生命令留下的 `7`；直接取它会把 `echo ok` 也报成 `7`。正确取码：

- `$?` 为真 → `0`
- 否则：`LASTEXITCODE` 与「提交命令时的快照」不同 → 用它；相同（说明是陈旧值）→ `1`

## 另外两条必须记住的事实

- **启动时 pwsh 先发 `ESC[6n`（查询光标位置）并等回答**。不回答就停在原地（探针第一版因此一个字都收不到）。xterm.js 默认会回答 DSR，但自写的集成测试客户端必须模拟 `ESC[1;1R`，否则 L1 集成测试会假死。
- CWD 用 `OSC 7 ; file://<host>/C:/path`，空格被百分号编码。解析侧要 percent-decode 并去掉 `file://<host>`，盘符保留前导 `/`（`/C:/...`）。

## 推荐的脚本形状（实测通过）

```powershell
$Global:__ps = @{ Seen = $false; PrevEx = $null }
$Global:__e = [char]27
$Global:__bel = [char]7

function Global:__ps_emit([string]$body) {
    [Console]::Out.Write("$($Global:__e)]$body$($Global:__bel)"); [Console]::Out.Flush()
}

function Global:__ps_cwd_uri {
    $p = (Get-Location).ProviderPath -replace '\\', '/'
    if ($p -notmatch '^/') { $p = '/' + $p }
    'file://' + [Environment]::MachineName + [Uri]::EscapeUriString($p)
}

$Global:__ps_orig_prompt = $function:prompt

function Global:prompt {
    $ok = $?; $ex = $Global:LASTEXITCODE
    if ($Global:__ps.Seen) {
        if ($ok) { $code = 0 }
        elseif ($null -ne $ex -and $ex -ne $Global:__ps.PrevEx) { $code = [int]$ex }
        else { $code = 1 }
        __ps_emit "133;D;$code"; $Global:__ps.Seen = $false
    }
    __ps_emit '133;A'
    __ps_emit ('7;' + (__ps_cwd_uri))
    & $Global:__ps_orig_prompt        # 返回用户自己的提示符文本
}

Import-Module PSReadLine -ErrorAction SilentlyContinue
$Global:__ps_orig_rl = $function:PSConsoleHostReadLine

function Global:PSConsoleHostReadLine {
    $line = & $Global:__ps_orig_rl   # 不能直接调静态方法，见坑 1
    if ($null -ne $line) {
        __ps_emit '133;B'            # B 延后到这里，见坑 2
        $Global:__ps.PrevEx = $Global:LASTEXITCODE
        __ps_emit '133;C'
        $Global:__ps.Seen = $true
    }
    $line
}
```

## 对 M1 的影响

- ADR 0003 的 `A/B/C/D` 信号可直接用，**不需要私有扩展**；「未知」仍是一等状态（脚本未注入时自然成立）。
- 注入方式沿用 ADR 0003：只对我们启动的进程注入（`-NoLogo -NoExit -Command ". <path>"`）。实测该方式下用户 profile 已加载，`prompt` 可安全包装。
- 待补验证：备用屏 `?1049h/l`（本机无 vim，未测）；Git Bash（`D:\Git\bin\bash.exe`）；密码提示等「无信号可解」场景维持 ADR 的降级做法。
- 给测试方案加一条：L1 集成测试的假终端必须回答 `ESC[6n`。

> 探针与四个变体的脚本在 `%TEMP%\pinshell-osc-spike\`，可随时删除。
