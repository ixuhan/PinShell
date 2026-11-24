# Dev run for the current checkout (ASCII only; Windows PowerShell 5.1 safe).
# Repo root = parent of this script, so the same script works from F:\PinShell
# and from any git worktree; it no longer hard-codes f:\PinShell.
$env:CARGO_HOME = 'F:\.toolchain\cargo'
$env:RUSTUP_HOME = 'F:\.toolchain\rustup'
$env:PATH = 'F:\.toolchain\cargo\bin;' + $env:PATH
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path 'node_modules')) {
  Write-Output '[run-dev] node_modules not found in this checkout; run: npm install'
  exit 1
}
Write-Output ('[run-dev] repo root: ' + (Get-Location).Path)
npm run app:dev
