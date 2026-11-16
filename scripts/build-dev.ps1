$ErrorActionPreference = 'Continue'
$env:CARGO_HOME = 'F:\.toolchain\cargo'
$env:RUSTUP_HOME = 'F:\.toolchain\rustup'
$env:PATH = 'F:\.toolchain\cargo\bin;' + $env:PATH
Set-Location 'f:\PinShell\src-tauri'
$sw = [Diagnostics.Stopwatch]::StartNew()
& cargo build 2>&1 | Select-Object -Last 40
$sw.Stop()
'--- build finished in ' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + ' s, exit ' + $LASTEXITCODE
