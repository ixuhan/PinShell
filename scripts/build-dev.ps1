$ErrorActionPreference = 'Continue'
$env:CARGO_HOME = 'F:\.toolchain\cargo'
$env:RUSTUP_HOME = 'F:\.toolchain\rustup'
$env:PATH = 'F:\.toolchain\cargo\bin;' + $env:PATH
# Build the src-tauri crate of the checkout this script lives in (worktree safe).
Set-Location (Join-Path (Split-Path $PSScriptRoot -Parent) 'src-tauri')
$sw = [Diagnostics.Stopwatch]::StartNew()
& cargo build 2>&1 | Select-Object -Last 40
$sw.Stop()
'--- build finished in ' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + ' s, exit ' + $LASTEXITCODE
