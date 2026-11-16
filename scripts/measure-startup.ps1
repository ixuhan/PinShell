$ErrorActionPreference = 'Stop'

function Measure-ShellStart {
  param([string]$Exe, [string]$Args, [int]$Runs = 3)
  $times = @()
  for ($i = 0; $i -lt $Runs; $i++) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = $Args
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($psi)
    $line = $p.StandardOutput.ReadLine()
    while ($line -ne $null -and $line.Trim() -ne 'READY') { $line = $p.StandardOutput.ReadLine() }
    $sw.Stop()
    $times += [math]::Round($sw.Elapsed.TotalMilliseconds)
    if (-not $p.HasExited) { $p.Kill() }
    $p.Dispose()
  }
  return $times
}

$pwshNoProfile = Measure-ShellStart 'pwsh' '-NoLogo -NoProfile -Command "Write-Output READY"'
$pwshProfile  = Measure-ShellStart 'pwsh' '-NoLogo -Command "Write-Output READY"'
$cmd          = Measure-ShellStart 'cmd.exe' '/c echo READY'

'pwsh -NoProfile : ' + ($pwshNoProfile -join ' / ') + ' ms'
'pwsh (profile)  : ' + ($pwshProfile -join ' / ') + ' ms'
'cmd /c          : ' + ($cmd -join ' / ') + ' ms'

$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if ($dotnet) { 'dotnet: ' + (& dotnet --version) } else { 'dotnet: not installed' }
$link = Get-Command link.exe -ErrorAction SilentlyContinue
if ($link) { 'link.exe: ' + $link.Source } else { 'link.exe: not in PATH (MSVC build tools may be missing)' }
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswhere) {
  'VS: ' + (& $vswhere -latest -products * -property displayName 2>$null)
} else { 'VS: vswhere not found' }
