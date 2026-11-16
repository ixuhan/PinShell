$ErrorActionPreference = 'Continue'
$git = 'D:\Git\bin\git.exe'
Set-Location 'f:\PinShell'
foreach ($f in 'scripts/push-setup.ps1','scripts/fix-path.ps1','scripts/check-git.ps1','scripts/git-init.ps1') {
  if (Test-Path $f) { Remove-Item $f -Force; 'removed ' + $f }
}
& $git add -A
& $git -c user.name=ixuhan -c user.email=964850509@qq.com commit -q -m 'chore: tidy dev scripts'
& $git log --oneline -3
'--- push ---'
$sw = [Diagnostics.Stopwatch]::StartNew()
& $git push -u origin main 2>&1
$code = $LASTEXITCODE
$sw.Stop()
'push exit code: ' + $code + ' in ' + [math]::Round($sw.Elapsed.TotalSeconds,1) + ' s'
