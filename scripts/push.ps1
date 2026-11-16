$ErrorActionPreference = 'Continue'
$git = 'D:\Git\bin\git.exe'
& $git config --global credential.helper manager
'helper: ' + (& $git config --global credential.helper)
Set-Location 'f:\PinShell'
$sw = [Diagnostics.Stopwatch]::StartNew()
& $git push -u origin main 2>&1
$code = $LASTEXITCODE
$sw.Stop()
'push exit code: ' + $code + ' in ' + [math]::Round($sw.Elapsed.TotalSeconds,1) + ' s'
