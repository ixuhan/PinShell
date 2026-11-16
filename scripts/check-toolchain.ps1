# PinShell toolchain check (ASCII only; Windows PowerShell 5.1 safe)
# Reports: Rust, MSVC linker, Windows SDK, Node, WebView2, git, and optionally runs a probe build.

$ErrorActionPreference = 'Continue'
$ok = 'OK  '
$bad = 'MISS'

$machine = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$user = Get-ItemProperty 'HKCU:\Environment'
$pathAll = ($machine.Path + ';' + $user.Path)
$cargoHome = $machine.CARGO_HOME
$rustupHome = $machine.RUSTUP_HOME

if (-not $cargoHome) { $cargoHome = $user.CARGO_HOME }
if (-not $rustupHome) { $rustupHome = $user.RUSTUP_HOME }

$bin = if ($cargoHome) { Join-Path $cargoHome 'bin' } else { $null }

Write-Output '--- env ---'
Write-Output ("CARGO_HOME   : {0}" -f $(if ($cargoHome) { $cargoHome } else { '(unset)' }))
Write-Output ("RUSTUP_HOME  : {0}" -f $(if ($rustupHome) { $rustupHome } else { '(unset)' }))
$onPath = $false
if ($bin) {
  foreach ($p in $pathAll.Split(';')) { if ($p.Trim().TrimEnd('\') -ieq $bin.TrimEnd('\')) { $onPath = $true } }
}
Write-Output ("cargo\bin on PATH : {0}" -f $onPath)
if (-not $onPath) {
  $fix = "[Environment]::SetEnvironmentVariable('Path', (Get-ItemProperty 'HKCU:\Environment').Path + ';" + $bin + "', 'User')"
  Write-Output ("  FIX (no admin needed, then reopen the terminal):")
  Write-Output ("  " + $fix)
}

Write-Output '--- versions ---'
if ($cargoHome) { $env:CARGO_HOME = $cargoHome }
if ($rustupHome) { $env:RUSTUP_HOME = $rustupHome }
foreach ($tool in 'rustc', 'cargo', 'rustup') {
  $exe = if ($bin) { Join-Path $bin "$tool.exe" } else { $null }
  if ($exe -and (Test-Path $exe)) {
    $v = & $exe -V 2>&1 | Select-Object -First 1
    if ($v -match "^(rustc|cargo|rustup)\s") { Write-Output ("{0} {1}: {2}" -f $ok, $tool, $v) }
    else { Write-Output ("{0} {1}: shim ran but no toolchain -> {2}" -f $bad, $tool, $v) }
  } else { Write-Output ("{0} {1}: binary not found" -f $bad, $tool) }
}
foreach ($tool in 'node', 'npm', 'git', 'pwsh') {
  $c = Get-Command $tool -ErrorAction SilentlyContinue
  if ($c) { Write-Output ("{0} {1}: {2}" -f $ok, $tool, (& $tool --version 2>&1 | Select-Object -First 1)) }
  else { Write-Output ("{0} {1}" -f $bad, $tool) }
}

Write-Output '--- MSVC / SDK ---'
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswhere) {
  $vs = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($vs) { Write-Output ("{0} MSVC: {1}" -f $ok, ($vs -join '; ')) } else { Write-Output ("{0} MSVC C++ tools" -f $bad) }
} else { Write-Output ("{0} vswhere" -f $bad) }
$sdk = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Lib' -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
if ($sdk) { Write-Output ("{0} Windows SDK: {1}" -f $ok, ($sdk -join ', ')) } else { Write-Output ("{0} Windows SDK" -f $bad) }

Write-Output '--- WebView2 ---'
$wv = Get-ChildItem 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application' -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
if ($wv) { Write-Output ("{0} WebView2: {1}" -f $ok, ($wv -join ', ')) } else { Write-Output ("{0} WebView2" -f $bad) }

if ($args -contains '-Probe' -and $bin -and (Test-Path (Join-Path $bin 'cargo.exe'))) {
  Write-Output '--- probe build ---'
  $env:CARGO_HOME = $cargoHome
  $env:RUSTUP_HOME = $rustupHome
  $proj = Join-Path $env:TEMP ('pinprobe_' + [guid]::NewGuid().ToString('N').Substring(0, 6))
  & (Join-Path $bin 'cargo.exe') new $proj --bin --vcs none 2>&1 | Out-Null
  if (Test-Path $proj) {
    Push-Location $proj
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & (Join-Path $bin 'cargo.exe') build --quiet 2>&1 | Out-Null
    $sw.Stop()
    Write-Output ("{0} cargo build: {1} s" -f $ok, [math]::Round($sw.Elapsed.TotalSeconds, 1))
    Pop-Location
    Remove-Item $proj -Recurse -Force -ErrorAction SilentlyContinue
  }
}
