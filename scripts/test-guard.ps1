# PinShell test gate (ASCII only; Windows PowerShell 5.1 safe).
#
# Purpose: let an agent or a human run tests at any moment WITHOUT interrupting foreground
# work. The always-run set (L0) lives in its own crate with its own target dir, so it is
# always safe. The integration layer (L1) needs the main target dir, which is shared with
# `tauri dev` and whose exe is locked while the app runs, so it is refused unless dev is
# stopped.
#
# Usage:
#   .\scripts\test-guard.ps1              # L0 only (always safe)
#   .\scripts\test-guard.ps1 -Layer it    # L1 only (requires dev stopped)
#   .\scripts\test-guard.ps1 -Layer all   # L0, then L1 when safe
#   .\scripts\test-guard.ps1 -Layer all -Force   # override the check (not recommended)
#
# Exit code: 0 = all selected layers passed or were skipped with a reason, 1 = a layer failed.

param(
  [ValidateSet('l0', 'it', 'all')][string]$Layer = 'l0',
  [switch]$Force
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root 'src-tauri\core-domain\Cargo.toml'

function Resolve-RustEnv {
  if ($env:CARGO_HOME -and (Test-Path (Join-Path $env:CARGO_HOME 'bin\cargo.exe'))) { return $true }
  $candidates = @('F:\.toolchain\cargo', (Join-Path $env:USERPROFILE '.cargo'))
  foreach ($home in $candidates) {
    $cargo = Join-Path $home 'bin\cargo.exe'
    if (-not (Test-Path $cargo)) { continue }
    $env:CARGO_HOME = $home
    $rustup = Join-Path (Split-Path $home) 'rustup'
    if (Test-Path $rustup) { $env:RUSTUP_HOME = $rustup }
    $env:PATH = (Join-Path $home 'bin') + ';' + $env:PATH
    return $true
  }
  return $false
}

# Reports every reason the heavy layer would disturb the user right now.
function Get-DevBusyReasons {
  $reasons = @()

  if (Get-Process -Name pinshell -ErrorAction SilentlyContinue) {
    $reasons += 'pinshell.exe is running'
  }

  $exe = Join-Path $root 'src-tauri\target\debug\pinshell.exe'
  if (Test-Path $exe) {
    try {
      $fs = [IO.File]::Open($exe, 'Open', 'Write', 'None')
      $fs.Dispose()
    } catch {
      $reasons += 'target\debug\pinshell.exe is locked by a running app'
    }
  }

  $dev = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'tauri(\.js)?["'']?\s+dev' }
  if ($dev) { $reasons += 'tauri dev is running' }

  return $reasons
}

# Runs cargo test at below-normal priority so typing stays responsive.
function Invoke-CargoTest {
  param([string[]]$CargoArgs)

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath 'cargo' -ArgumentList $CargoArgs -NoNewWindow -PassThru
  try { $proc.PriorityClass = 'BelowNormal' } catch { }
  $proc.WaitForExit()
  $sw.Stop()
  return @{ Code = $proc.ExitCode; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
}

if (-not (Resolve-RustEnv)) {
  Write-Output '[guard] SKIP: cargo not found (set CARGO_HOME or put cargo on PATH)'
  exit 0
}

$failed = $false

if ($Layer -eq 'l0' -or $Layer -eq 'all') {
  $r = Invoke-CargoTest @('test', '--lib', '--offline', '--manifest-path', $manifest)
  if ($r.Code -eq 0) {
    Write-Output ("[guard] L0 core-domain      ok      {0}s" -f $r.Seconds)
  } else {
    Write-Output ("[guard] L0 core-domain      FAILED  {0}s" -f $r.Seconds)
    $failed = $true
  }
}

if ($Layer -eq 'it' -or $Layer -eq 'all') {
  $reasons = Get-DevBusyReasons
  if ($reasons.Count -gt 0 -and -not $Force) {
    Write-Output ('[guard] L1 shell markers    skipped ({0})' -f ($reasons -join '; '))
    if ($Layer -eq 'it') {
      # 明确要求跑 L1 却没跑，不能算通过
      Write-Output '[guard] stop the dev instance, or pass -Force to run anyway'
      Write-Output '[guard] result: NOT RUN'
      exit 1
    }
  } else {
    $r = Invoke-CargoTest @('test', '--test', 'pwsh_markers', '--test', 'bash_markers', '--offline', '--manifest-path', $manifest)
    if ($r.Code -eq 0) {
      Write-Output ("[guard] L1 shell markers    ok      {0}s" -f $r.Seconds)
    } else {
      Write-Output ("[guard] L1 shell markers    FAILED  {0}s" -f $r.Seconds)
      $failed = $true
    }
  }
}

if ($failed) {
  Write-Output '[guard] result: FAIL'
  exit 1
}
Write-Output '[guard] result: PASS'
exit 0
