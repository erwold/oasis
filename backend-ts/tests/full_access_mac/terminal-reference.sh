#!/bin/bash
# What a terminal of the fixture's user sees: a login + interactive zsh on a pty (script(1)), started from a clean
# environment with the fixture HOME/TMPDIR and this fixture's agent; ZDOTDIR/BASH_ENV/ENV are absent, XDG point
# into the fixture. Prints the dump (same script the agent command runs). usage: terminal-reference.sh <fixture>
set -euo pipefail
FX=$(cd "${1:?fixture}" && pwd -P); SOCK=$(cat "$FX/sockdir")
cat > "$FX/dump.sh" <<'EOF'
#!/bin/sh
printf 'QA_DUMP_BEGIN\n'
for v in HOME PATH TMPDIR SSH_AUTH_SOCK SHELL USER LOGNAME ZDOTDIR BASH_ENV ENV XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME QA_ZSHENV_MARK QA_ZPROFILE_MARK QA_ZSHRC_MARK QA_SECRET_LIKE_TOKEN; do
  printf '%s=%s\n' "$v" "$(printenv "$v")"
done
printf 'UID=%s\nGID=%s\n' "$(id -u)" "$(id -g)"
printf 'TOOL_ZPROFILE=%s\n' "$(qa-zprofile-tool 2>/dev/null)"
printf 'TOOL_ZSHRC=%s\n' "$(qa-zshrc-tool 2>/dev/null)"
printf 'QA_DUMP_END\n'
EOF
chmod +x "$FX/dump.sh"
cleanenv=(env -i HOME="$FX/home" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/zsh PATH="${QA_START_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  TERM=xterm-256color LANG=en_US.UTF-8 TMPDIR="$FX/tmp/" SSH_AUTH_SOCK="$SOCK/a"
  XDG_CONFIG_HOME="$FX/xdg/config" XDG_CACHE_HOME="$FX/xdg/cache" XDG_DATA_HOME="$FX/xdg/data" XDG_STATE_HOME="$FX/xdg/state")
echo "## pty (script) zsh -l -i"
if ! "${cleanenv[@]}" /usr/bin/script -q /dev/null /bin/zsh -l -i -c "$FX/dump.sh" < /dev/null > "$FX/logs/ref-pty.out" 2>&1; then
  echo "BLOCKED: pty unavailable here ($(head -c 200 "$FX/logs/ref-pty.out"))"
else tr -d '\r' < "$FX/logs/ref-pty.out" | sed -n '/QA_DUMP_BEGIN/,/QA_DUMP_END/p'; fi
echo "## no pty zsh -l -i"
"${cleanenv[@]}" /bin/zsh -l -i -c "$FX/dump.sh" < /dev/null 2>/dev/null | sed -n '/QA_DUMP_BEGIN/,/QA_DUMP_END/p'
