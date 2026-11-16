param([switch]$SkipTests)

$ErrorActionPreference = 'Continue'
$git = 'D:\Git\bin\git.exe'

# 本地门禁：先跑常跑集（L0），失败就不推（见 docs/adr/0005-test-layering.md）
if (-not $SkipTests) {
  & (Join-Path $PSScriptRoot 'test-guard.ps1') -Layer l0
  if ($LASTEXITCODE -ne 0) {
    'L0 failed -> push aborted (use -SkipTests to override)'
    return
  }
}

& $git config --global credential.helper manager
'helper: ' + (& $git config --global credential.helper)
Set-Location (Split-Path -Parent $PSScriptRoot)
$sw = [Diagnostics.Stopwatch]::StartNew()
& $git push -u origin main 2>&1
$code = $LASTEXITCODE
$sw.Stop()
'push exit code: ' + $code + ' in ' + [math]::Round($sw.Elapsed.TotalSeconds,1) + ' s'
