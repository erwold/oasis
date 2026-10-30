#!/bin/bash
# Run qa_full_access.mac.ts (as tests/qa_full_access.test.ts) in a COPY of a source tree (baseline or candidate)
# against a fresh fixture. usage: QA_ROOT=<scratch> run-product-fixture.sh <tree-copy-under-QA_ROOT> <label>
# The tree must be a copy under $QA_ROOT (product source is never edited; only the test file is copied into tests/).
set -uo pipefail
. "$(dirname "$0")/env.sh"
TREE=$(cd "${1:?tree}" && pwd -P); LABEL=${2:?label}
case "$TREE" in "$QA_ROOT"/*) ;; *) echo "refuse: $TREE is not a copy under $QA_ROOT"; exit 2 ;; esac
FX=$QA_ROOT/fixtures/$LABEL; LOG=$QA_ROOT/logs/fixture-$LABEL.log
"$QA_DIR/make-fixture.sh" "$FX" > /dev/null || exit 1
SOCK=$(cat "$FX/sockdir")
"$QA_DIR/fixture-services.sh" start "$FX" || { "$QA_DIR/fixture-services.sh" stop "$FX"; exit 1; }
# the terminal starts from the same PATH the backend is started with (as both inherit the session's launchd PATH)
START_PATH="/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v bun)"):$(dirname "$(command -v node)")"
QA_START_PATH="$START_PATH" "$QA_DIR/terminal-reference.sh" "$FX" > "$FX/reference.txt"; echo "terminal-reference exit=$?"
# drop the pty section (blocked here) so the reference is the no-pty login+interactive dump
sed -n '/## no pty/,$p' "$FX/reference.txt" > "$FX/reference.nopty.txt"
cp "$QA_DIR/qa_full_access.mac.ts" "$TREE/backend-ts/tests/qa_full_access.test.ts"
V27=""; [ -d "$QA_ROOT/fixtures/v27/data" ] && V27="$QA_ROOT/fixtures/v27/data"
: > "$FX/logs/rc-runs.log"
# the backend's environment as a terminal/desktop would give it: fixture HOME/TMPDIR/XDG, the fixture agent, zsh;
# no ZDOTDIR/BASH_ENV/ENV, no real SSH_AUTH_SOCK
( cd "$TREE/backend-ts" && env -i HOME="$FX/home" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/zsh \
    PATH="$START_PATH" LANG=en_US.UTF-8 \
    TMPDIR="$FX/tmp/" SSH_AUTH_SOCK="$SOCK/a" XDG_CONFIG_HOME="$FX/xdg/config" XDG_CACHE_HOME="$FX/xdg/cache" \
    XDG_DATA_HOME="$FX/xdg/data" XDG_STATE_HOME="$FX/xdg/state" BUN_INSTALL_CACHE_DIR="$QA_ROOT/env/cache/bun" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    OASIS_CODE_TEST_HOST=process QA_FX="$FX" QA_SOCK="$SOCK" QA_REFERENCE="$FX/reference.nopty.txt" QA_V27_DATA="$V27" \
    bun test --timeout 120000 tests/qa_full_access.test.ts ) > "$LOG" 2>&1
RC=$?
echo "bun test exit=$RC (log $LOG)"
grep -E "^\((pass|fail|skip)\)|^ *[0-9]+ (pass|fail|skip)" "$LOG"
"$QA_DIR/fixture-services.sh" stop "$FX"
left=$(pgrep -f -- "$FX" ; pgrep -f -- "$SOCK"); [ -n "$left" ] && echo "LEFT RUNNING: $left" || echo "no fixture process left"
exit $RC
