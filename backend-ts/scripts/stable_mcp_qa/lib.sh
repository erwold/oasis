# Source me. Isolated env + PID ledger for QA runs. Never kills by pattern; only PIDs this run recorded.
set -u
QA_ROOT="${QA_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
QA_RUN="${QA_RUN:-${TMPDIR:?}/qa-run-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$QA_RUN"/{data,user,logs}; chmod 700 "$QA_RUN"
export OASIS_CODE_DATA="$QA_RUN/data" OASIS_CODE_USER_DATA="$QA_RUN/user"
PIDS="$QA_RUN/pids"; touch "$PIDS"
FORBIDDEN_PORTS="8321 8322 8323"

port_free() { # exit 0 when nothing listens on 127.0.0.1:$1 (lsof + a connect probe; never to 8321-8323)
  local p=$1
  for f in $FORBIDDEN_PORTS; do [ "$p" = "$f" ] && { echo "refused: $p is a production port" >&2; return 2; }; done
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then return 1; fi
  if nc -z -G 1 127.0.0.1 "$p" >/dev/null 2>&1; then return 1; fi
  return 0
}
pick_ports() { # QA_PORT(backend)=8399 for e2e; others chosen free and recorded
  port_free 8399 || { echo "8399 busy: another e2e? refusing" >&2; return 1; }
  export OASIS_CODE_PORT=8399
  local cands=(18431 18432 18433 18434 18435 18436 18437 18438) got=()
  for p in "${cands[@]}"; do port_free "$p" && got+=("$p"); [ ${#got[@]} -ge 3 ] && break; done
  [ ${#got[@]} -ge 3 ] || { echo "no free ports" >&2; return 1; }
  export OASIS_CODE_BRIDGE_PORT=${got[0]} OASIS_CODE_DIRECTOR_PORT=${got[1]} QA_GATEWAY_PORT=${got[2]}
  echo "ports: backend=$OASIS_CODE_PORT bridge=$OASIS_CODE_BRIDGE_PORT director=$OASIS_CODE_DIRECTOR_PORT gateway=$QA_GATEWAY_PORT" | tee -a "$QA_RUN/logs/ports"
}
spawn_bg() { # spawn_bg <name> <cmd...>: background, logs to $QA_RUN/logs/<name>.log, PID recorded
  local name=$1; shift
  ( exec "$@" ) >"$QA_RUN/logs/$name.log" 2>&1 &
  local pid=$!; echo "$pid $name $(date +%s)" >>"$PIDS"; echo "$pid"
}
kill_recorded() { # kill_recorded <name>: SIGTERM then SIGKILL, only that recorded PID (and only if still the same command)
  local name=$1 pid
  pid=$(awk -v n="$name" '$2==n{p=$1} END{print p}' "$PIDS")
  [ -n "$pid" ] || { echo "no recorded pid for $name" >&2; return 1; }
  kill -0 "$pid" 2>/dev/null || { echo "$name ($pid) already gone"; return 0; }
  kill -TERM "$pid"; for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || { echo "$name ($pid) stopped"; return 0; }; sleep 0.1; done
  kill -KILL "$pid" 2>/dev/null; echo "$name ($pid) killed"
}
cleanup_all() { awk '{print $2}' "$PIDS" | sort -u | while read -r n; do kill_recorded "$n"; done; }
redact() { sed -E 's#(https?://[^/ ]+/)[A-Za-z0-9_-]{16,}(/mcp)#\1<redacted>\2#g'; }
