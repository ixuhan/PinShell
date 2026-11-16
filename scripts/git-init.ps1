$ErrorActionPreference = 'Continue'
$git = 'D:\Git\bin\git.exe'
Set-Location 'f:\PinShell'
if (Test-Path '.git') {
  'repo already initialized'
} else {
  & $git init -q
  'initialized'
}
& $git add -A
& $git -c user.name=ixuhan -c user.email=964850509@qq.com commit -q -m "chore: M0 skeleton (Tauri 2 + xterm 6 + ConPTY) with design docs and prototype"
& $git log --oneline -1
& $git status --short | Select-Object -First 10
