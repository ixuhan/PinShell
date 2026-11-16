# PinShell integration script (PowerShell 7+). ASCII only.
#
# Loaded by the app as:  pwsh -NoLogo -NoExit -Command ". '<this file>'"
# It reports prompt / command boundaries and CWD back to the terminal via OSC:
#   133;A            prompt starts
#   133;B            prompt ends (user can type)
#   133;C            command starts running
#   133;D[;code]     command finished
#   7;file://...     working directory
#
# Design notes (verified experimentally, see docs/research/04-osc-pwsh-probe.md):
#   1. The original PSConsoleHostReadLine FUNCTION must be called. Calling the static
#      PSConsoleHostReadLine::ReadLine method directly makes the host re-prompt in a
#      tight loop (~1500 prompts/second).
#   2. The original prompt function is preserved and called; 133;B is emitted lazily when
#      the submitted line is known. Returning an empty prompt string leaks a stray "PS>".
#   3. $LASTEXITCODE goes stale after a cmdlet writes an error, so it is only trusted when
#      it changed since the command was submitted.

if ($Global:__pinshell_loaded -eq 1) { return }
$Global:__pinshell_loaded = 1
$Global:__pinshell_version = 1

$Global:__pinshell_seen = $false
$Global:__pinshell_prev_exit = $null
$Global:__pinshell_esc = [char]27
$Global:__pinshell_bel = [char]7

function Global:__pinshell_emit([string]$body) {
    [Console]::Out.Write("$($Global:__pinshell_esc)]$body$($Global:__pinshell_bel)")
    [Console]::Out.Flush()
}

function Global:__pinshell_cwd_uri {
    $p = (Get-Location).ProviderPath -replace '\\', '/'
    if ($p -notmatch '^/') { $p = '/' + $p }
    'file://' + [Environment]::MachineName + [Uri]::EscapeUriString($p)
}

$Global:__pinshell_orig_prompt = $function:prompt

function Global:prompt {
    $ok = $?
    $ex = $Global:LASTEXITCODE
    if ($Global:__pinshell_seen) {
        if ($ok) { $code = 0 }
        elseif ($null -ne $ex -and $ex -ne $Global:__pinshell_prev_exit) { $code = [int]$ex }
        else { $code = 1 }
        __pinshell_emit "133;D;$code"
        $Global:__pinshell_seen = $false
    }
    __pinshell_emit '133;A'
    __pinshell_emit ('7;' + (__pinshell_cwd_uri))
    & $Global:__pinshell_orig_prompt
}

Import-Module PSReadLine -ErrorAction SilentlyContinue
$Global:__pinshell_orig_readline = $function:PSConsoleHostReadLine

function Global:PSConsoleHostReadLine {
    if ($Global:__pinshell_orig_readline) {
        $line = & $Global:__pinshell_orig_readline
    } else {
        $line = [Microsoft.PowerShell.PSConsoleReadLine]::ReadLine($Host.Runspace, $ExecutionContext)
    }
    if ($null -ne $line) {
        __pinshell_emit '133;B'
        $Global:__pinshell_prev_exit = $Global:LASTEXITCODE
        __pinshell_emit '133;C'
        $Global:__pinshell_seen = $true
    }
    $line
}
