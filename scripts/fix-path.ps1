$ErrorActionPreference = 'Stop'
$bin = 'F:\.toolchain\cargo\bin'
$cur = (Get-ItemProperty 'HKCU:\Environment').Path
$parts = $cur.Split(';') | Where-Object { $_.Trim() -ne '' }

$already = $false
foreach ($p in $parts) { if ($p.Trim().TrimEnd('\') -ieq $bin.TrimEnd('\')) { $already = $true } }

if ($already) {
  'already present, nothing to do'
} else {
  $new = ($parts + $bin) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $new, 'User')
  'appended: ' + $bin
}
'--- user PATH now ---'
(Get-ItemProperty 'HKCU:\Environment').Path
'--- simulate fresh shell ---'
$machine = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$env:CARGO_HOME = $machine.CARGO_HOME
$env:RUSTUP_HOME = $machine.RUSTUP_HOME
$env:PATH = ($machine.Path + ';' + (Get-ItemProperty 'HKCU:\Environment').Path)
$resolved = Get-Command rustc -ErrorAction SilentlyContinue
if ($resolved) { 'resolved rustc -> ' + $resolved.Source } else { 'rustc still not resolved' }
& rustc -V
& cargo -V
