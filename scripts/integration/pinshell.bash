# PinShell shell integration for bash (bash 4.4+). ASCII only.
#
# Loaded by the app as:  bash --init-file '<this file>' -i
#
# It reports prompt / command boundaries and CWD back to the terminal via OSC:
#   133;A            prompt starts
#   133;B            prompt ends (user can type)
#   133;C            command starts running
#   133;D[;code]     command finished
#   7;file://...     working directory
#
# Design notes (see docs/adr/0003-input-ownership.md):
#   1. --init-file replaces the normal startup files, so /etc/profile and ~/.bashrc are
#      read here first and the prompt is wrapped afterwards. Nothing is written to the
#      user's dotfiles.
#   2. Markers placed in PS1 are wrapped in \[ \] so readline does not count their bytes
#      as visible width (otherwise cursor math breaks on long lines).
#   3. 133;C needs PS0, which exists since bash 4.4. On older shells we simply do not
#      report C: the input bar then never takes over, which is the honest degradation.
#   4. 133;D is emitted on every prompt, including the first one. The state machine maps
#      D to "prompt ready", which is what the following A would say anyway.

if [ -n "${__pinshell_loaded:-}" ]; then
    return 0 2>/dev/null || exit 0
fi
__pinshell_loaded=1
__pinshell_version=1

if [ -f /etc/profile ]; then
    . /etc/profile
fi
if [ -f "${HOME:-}/.bashrc" ]; then
    . "${HOME}/.bashrc"
fi

# --- markers ---------------------------------------------------------------
__pinshell_a=$'\033]133;A\007'
__pinshell_b=$'\033]133;B\007'
__pinshell_c=$'\033]133;C\007'

# --- CWD -------------------------------------------------------------------
__pinshell_cwd() {
    local p=$PWD
    # MSYS/Cygwin paths (/c/Program Files) are not Windows paths; ask cygpath when present.
    if command -v cygpath >/dev/null 2>&1; then
        p=$(cygpath -m "$PWD" 2>/dev/null) || p=$PWD
    fi
    printf '\033]7;file://%s%s\007' "${HOSTNAME:-localhost}" "$p"
}

# --- 133;D (command finished) ---------------------------------------------
__pinshell_precmd() {
    local code=$?
    printf '\033]133;D;%s\007' "$code"
    __pinshell_cwd
}

# PROMPT_COMMAND may be a string or an array (bash 5.1+). Normalise to one string and
# put our hook first so $? still belongs to the command the user just ran.
__pinshell_old_pc=""
for __pinshell_one in "${PROMPT_COMMAND[@]:-}"; do
    if [ -n "$__pinshell_one" ]; then
        __pinshell_old_pc="${__pinshell_old_pc:+$__pinshell_old_pc; }$__pinshell_one"
    fi
done
if [ -n "$__pinshell_old_pc" ]; then
    PROMPT_COMMAND="__pinshell_precmd; $__pinshell_old_pc"
else
    PROMPT_COMMAND="__pinshell_precmd"
fi
unset __pinshell_old_pc __pinshell_one

# --- 133;A / 133;B (prompt boundaries) ------------------------------------
case "${PS1:-}" in
    *']133;A'*) ;;
    *) PS1="\[${__pinshell_a}\]${PS1:-\\s-\\v\\\$ }\[${__pinshell_b}\]" ;;
esac

# --- 133;C (command starts) -----------------------------------------------
if [ "${BASH_VERSINFO[0]:-0}" -gt 4 ] ||
    { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 4 ]; }; then
    PS0="${PS0:-}${__pinshell_c}"
fi
