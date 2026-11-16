# PinShell test gate (ASCII only; Windows PowerShell 5.1 safe).
#
# Purpose: let an agent or a human run tests at any moment WITHOUT interrupting foreground
# work. The always-run set (L0) lives in its own crate with its own target dir, so it is
# always safe. The integration layer (L1) needs the main target dir, which is shared with
# `tauri dev` and whose exe is locked while the app runs, so it is refused unless dev is
# stopped.
#
# Every run also lands two reports, so results never depend on someone watching the console:
#   tests/report/latest.json  machine-readable (layers, per-case status, skip reasons)
#   docs/test-report.md       human-readable, appended, keeps the last 10 runs
#
# Usage:
#   .\scripts\test-guard.ps1              # L0 only (always safe)
#   .\scripts\test-guard.ps1 -Layer it    # L1 only (requires dev stopped)
#   .\scripts\test-guard.ps1 -Layer all   # L0, then L1 when safe
#   .\scripts\test-guard.ps1 -Layer all -Force   # override the check (not recommended)
#
# Exit code: 0 = all selected layers passed or were skipped with a reason, 1 = a layer failed
# or a layer was explicitly requested but could not run.

param(
  [ValidateSet('l0', 'it', 'all')][string]$Layer = 'l0',
  [switch]$Force
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root 'src-tauri\core-domain\Cargo.toml'
$reportDir = Join-Path $root 'tests\report'
$reportJson = Join-Path $reportDir 'latest.json'
$reportDoc = Join-Path $root 'docs\test-report.md'

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

# Runs cargo test at below-normal priority so typing stays responsive, captures the output
# (the human still sees it), and parses per-case results.
function Invoke-CargoTest {
  param([string[]]$CargoArgs)

  $outFile = [IO.Path]::GetTempFileName()
  $errFile = [IO.Path]::GetTempFileName()
  $cases = New-Object System.Collections.ArrayList
  $passed = 0
  $failed = 0
  $ignored = 0
  $sawSummary = $false

  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $proc = Start-Process -FilePath 'cargo' -ArgumentList $CargoArgs -NoNewWindow -PassThru `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    try { $proc.PriorityClass = 'BelowNormal' } catch { }
    $proc.WaitForExit()
    $sw.Stop()

    $stdout = if (Test-Path $outFile) { [IO.File]::ReadAllText($outFile) } else { '' }
    $stderr = if (Test-Path $errFile) { [IO.File]::ReadAllText($errFile) } else { '' }
    foreach ($text in @($stdout, $stderr)) {
      if ($text -and $text.Trim().Length -gt 0) { Write-Output $text.TrimEnd() }
    }

    foreach ($line in ($stdout -split "`r?`n")) {
      $case = [regex]::Match($line, '^test (.+?) \.\.\. (ok|FAILED|ignored)\s*$')
      if ($case.Success) {
        $status = $case.Groups[2].Value.ToLower()
        [void]$cases.Add([ordered]@{ name = $case.Groups[1].Value; status = $status })
        continue
      }
      $summary = [regex]::Match($line, 'test result: .*\. (\d+) passed; (\d+) failed; (\d+) ignored')
      if ($summary.Success) {
        $sawSummary = $true
        $passed += [int]$summary.Groups[1].Value
        $failed += [int]$summary.Groups[2].Value
        $ignored += [int]$summary.Groups[3].Value
      }
    }
  } catch {
    $sw.Stop()
    Write-Output ('[guard] cargo failed to run: {0}' -f $_.Exception.Message)
  } finally {
    Remove-Item -LiteralPath $outFile, $errFile -ErrorAction SilentlyContinue
  }

  # A compile error exits non-zero without any "test result" line: never report that as ok.
  $exitCode = if ($sawSummary) { $proc.ExitCode } else { 1 }

  return @{
    Code = $exitCode
    Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    Cases = @($cases)
    Passed = $passed
    Failed = $failed
    Ignored = $ignored
  }
}

# Writes both reports: the machine-readable JSON and one appended row in the markdown log.
function Write-TestReport {
  param(
    [string]$LayerOption,
    [string]$Result,
    [object[]]$Layers
  )

  $generated = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
  $detail = @()
  $failNames = @()
  foreach ($l in $Layers) {
    if ($l.status -eq 'skipped') {
      $detail += ('{0} {1}: skipped ({2})' -f $l.id, $l.label, $l.skip_reason)
    } else {
      $detail += ('{0} {1}: {2} {3}s ({4} passed, {5} failed)' -f $l.id, $l.label, $l.status, $l.seconds, $l.passed, $l.failed)
      foreach ($c in $l.cases) {
        if ($c.status -eq 'failed') { $failNames += ('{0}/{1}' -f $l.id, $c.name) }
      }
    }
  }

  $payload = [ordered]@{
    generated_at = $generated
    layer_option = $LayerOption
    result = $Result
    layers = @($Layers)
  }
  if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Force -Path $reportDir | Out-Null }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($reportJson, ($payload | ConvertTo-Json -Depth 6), $utf8)

  $failedCell = if ($failNames.Count -gt 0) { $failNames -join ', ' } else { '-' }
  $row = '| {0} | {1} | {2} | {3} | {4} |' -f `
    $generated, $LayerOption, ($detail -join '<br>'), $Result.ToUpper(), $failedCell

  $header = New-Object System.Collections.Generic.List[string]
  $rows = New-Object System.Collections.Generic.List[string]
  if (Test-Path $reportDoc) {
    foreach ($line in (Get-Content -LiteralPath $reportDoc -Encoding UTF8)) {
      if ($line -match '^\| \d{4}-\d{2}-\d{2}T') { $rows.Add($line) }
      elseif ($rows.Count -eq 0) { $header.Add($line) }
    }
  } else {
    foreach ($line in @(
        '# Test report (last 10 runs)',
        '',
        '> Appended by `scripts/test-guard.ps1`. Machine-readable copy: `tests/report/latest.json`.',
        '',
        '| when | layer | detail | result | failed cases |',
        '|---|---|---|---|---|'
      )) { $header.Add($line) }
  }
  while ($header.Count -gt 0 -and $header[$header.Count - 1] -eq '') { $header.RemoveAt($header.Count - 1) }
  $rows.Add($row)
  while ($rows.Count -gt 10) { $rows.RemoveAt(0) }

  $content = (($header + @($rows)) -join "`r`n") + "`r`n"
  [IO.File]::WriteAllText($reportDoc, $content, $utf8)

  Write-Output ('[guard] report: {0}' -f $reportJson)
}

if (-not (Resolve-RustEnv)) {
  Write-Output '[guard] SKIP: cargo not found (set CARGO_HOME or put cargo on PATH)'
  exit 0
}

$failedRun = $false
$notRun = $false
$layers = New-Object System.Collections.ArrayList

if ($Layer -eq 'l0' -or $Layer -eq 'all') {
  $r = Invoke-CargoTest @('test', '--lib', '--offline', '--manifest-path', $manifest)
  $status = if ($r.Code -eq 0) { 'ok' } else { 'failed' }
  if ($r.Code -ne 0) { $failedRun = $true }
  Write-Output ("[guard] L0 core-domain      {0,-7} {1}s" -f $status, $r.Seconds)
  [void]$layers.Add([ordered]@{
      id = 'L0'; label = 'core-domain'; status = $status; seconds = $r.Seconds;
      skip_reason = $null; forced = $false;
      passed = $r.Passed; failed = $r.Failed; ignored = $r.Ignored; cases = @($r.Cases)
    })
}

if ($Layer -eq 'it' -or $Layer -eq 'all') {
  $reasons = Get-DevBusyReasons
  if ($reasons.Count -gt 0 -and -not $Force) {
    $reason = $reasons -join '; '
    Write-Output ('[guard] L1 shell markers    skipped ({0})' -f $reason)
    [void]$layers.Add([ordered]@{
        id = 'L1'; label = 'shell markers'; status = 'skipped'; seconds = $null;
        skip_reason = $reason; forced = $false;
        passed = 0; failed = 0; ignored = 0; cases = @()
      })
    if ($Layer -eq 'it') {
      # 明确要求跑 L1 却没跑，不能算通过
      Write-Output '[guard] stop the dev instance, or pass -Force to run anyway'
      $notRun = $true
    }
  } else {
    $r = Invoke-CargoTest @('test', '--test', 'pwsh_markers', '--test', 'bash_markers', '--offline', '--manifest-path', $manifest)
    $status = if ($r.Code -eq 0) { 'ok' } else { 'failed' }
    if ($r.Code -ne 0) { $failedRun = $true }
    Write-Output ("[guard] L1 shell markers    {0,-7} {1}s" -f $status, $r.Seconds)
    [void]$layers.Add([ordered]@{
        id = 'L1'; label = 'shell markers'; status = $status; seconds = $r.Seconds;
        skip_reason = $null; forced = [bool]$Force;
        passed = $r.Passed; failed = $r.Failed; ignored = $r.Ignored; cases = @($r.Cases)
      })

    # 主 crate 的单元测试：目前是持久化（原子写、.bak 回退、数据目录选择）
    $appManifest = Join-Path $root 'src-tauri\Cargo.toml'
    $p = Invoke-CargoTest @('test', '--bin', 'pinshell', '--offline', '--manifest-path', $appManifest)
    $pStatus = if ($p.Code -eq 0) { 'ok' } else { 'failed' }
    if ($p.Code -ne 0) { $failedRun = $true }
    Write-Output ("[guard] L1 persistence      {0,-7} {1}s" -f $pStatus, $p.Seconds)
    [void]$layers.Add([ordered]@{
        id = 'L1'; label = 'persistence'; status = $pStatus; seconds = $p.Seconds;
        skip_reason = $null; forced = [bool]$Force;
        passed = $p.Passed; failed = $p.Failed; ignored = $p.Ignored; cases = @($p.Cases)
      })
  }
}

if ($failedRun) { $result = 'fail' } elseif ($notRun) { $result = 'not_run' } else { $result = 'pass' }
Write-TestReport -LayerOption $Layer -Result $result -Layers @($layers)

if ($failedRun) {
  Write-Output '[guard] result: FAIL'
  exit 1
}
if ($notRun) {
  Write-Output '[guard] result: NOT RUN'
  exit 1
}
Write-Output '[guard] result: PASS'
exit 0
