$ErrorActionPreference = 'Continue'
$machine = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$user = Get-ItemProperty 'HKCU:\Environment'
$env:PATH = $machine.Path + ';' + $user.Path
$g = Get-Command git -ErrorAction SilentlyContinue
if ($g) { 'git: ' + $g.Source; & git --version } else { 'git: NOT on PATH' }
'--- global config ---'
& git config --global --list 2>&1
'--- init.defaultBranch / autocrlf ---'
'init.defaultBranch = ' + (& git config --global init.defaultBranch 2>&1)
'core.autocrlf     = ' + (& git config --global core.autocrlf 2>&1)
'--- temp repo test ---'
$tmp = Join-Path $env:TEMP ('gitprobe_' + [guid]::NewGuid().ToString('N').Substring(0,6))
New-Item -ItemType Directory -Path $tmp | Out-Null
Push-Location $tmp
& git init -q 2>&1
& git -c user.name=probe -c user.email=probe@local commit -q --allow-empty -m probe 2>&1
$log = & git log --oneline -1 2>&1
'commit: ' + $log
Pop-Location
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
