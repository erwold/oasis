#!/bin/bash
# Start/stop this fixture's own ssh-agent (debug log: it records each signature) and a non-root loopback sshd.
# Only PIDs recorded here, and only while their command line still names this fixture, are ever signalled.
# usage: fixture-services.sh start|stop|status <fixture-dir>
set -uo pipefail
ACTION=${1:?start|stop|status}; FX=$(cd "${2:?fixture}" && pwd -P)
SOCK=$(cat "$FX/sockdir")
QA_DIR=$(cd "$(dirname "$0")" && pwd -P)
owned() { # pid pattern
  local pid=$1 pat=$2
  [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
  # /bin/ps is setuid root and its exec is denied under the outer sandbox here; pgrep (not setuid) reads the command lines
  pgrep -f -- "$pat" 2>/dev/null | grep -qx -- "$pid"
}
stop_one() { # pidfile pattern
  local f=$1 pat=$2 pid
  [ -f "$f" ] || return 0
  pid=$(cat "$f")
  if owned "$pid" "$pat"; then kill -TERM "$pid" 2>/dev/null; sleep 0.3; owned "$pid" "$pat" && kill -KILL "$pid" 2>/dev/null; echo "stopped $pid ($pat)"; fi
  rm -f "$f"
}
case "$ACTION" in
start)
  rm -f "$SOCK/a"
  # -d: debug, stays in the foreground, logs every request (sign requests are the evidence)
  env -i PATH=/usr/bin:/bin /usr/bin/ssh-agent -d -a "$SOCK/a" > "$FX/logs/ssh-agent.log" 2>&1 &
  echo $! > "$FX/ssh/agent.pid"
  for i in $(seq 50); do [ -S "$SOCK/a" ] && break; sleep 0.1; done
  [ -S "$SOCK/a" ] || { echo "agent socket missing"; cat "$FX/logs/ssh-agent.log"; exit 1; }
  env -i PATH=/usr/bin:/bin SSH_AUTH_SOCK="$SOCK/a" /usr/bin/ssh-add "$FX/ssh/agent-only/k" 2>&1
  env -i PATH=/usr/bin:/bin SSH_AUTH_SOCK="$SOCK/a" /usr/bin/ssh-add -l 2>&1
  if [ "${QA_SSHD:-node}" = system ]; then
    # system sshd (non-root): its preauth Seatbelt sandbox fails under the outer sandbox here (BLOCKED), kept for reruns elsewhere
    /usr/sbin/sshd -t -f "$FX/ssh/sshd_config" || { echo "sshd -t failed"; exit 1; }
    env -i PATH=/usr/bin:/bin /usr/sbin/sshd -D -e -f "$FX/ssh/sshd_config" > "$FX/logs/sshd.log" 2>&1 &
  else
    env -i PATH=/usr/bin:/bin:/opt/homebrew/bin "$(command -v node)" "$QA_DIR/sshserver/server.js" "$FX" > "$FX/logs/sshd.log" 2>&1 &
  fi
  echo $! > "$FX/ssh/sshd.mypid"
  PORT=$(cat "$FX/ssh/port")
  for i in $(seq 50); do nc -z 127.0.0.1 "$PORT" 2>/dev/null && break; sleep 0.1; done
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then echo "sshd listening 127.0.0.1:$PORT pid=$(cat "$FX/ssh/sshd.mypid")"; else echo "sshd not listening"; cat "$FX/logs/sshd.log"; exit 1; fi
  ;;
stop)
  stop_one "$FX/ssh/sshd.mypid" "$FX"
  stop_one "$FX/ssh/agent.pid" "$SOCK/a"
  ;;
status)
  pgrep -lf -- "$FX" ; pgrep -lf -- "$SOCK"; true
  ;;
esac
