#!/usr/bin/env bash
# Stable MCP gateway QA (docs/stable-mcp-qa.md): isolated backend + `gateway run --quick` (its own single cloudflared) + real public MCP checks + backend
# restart / session-token change / revoke. Kills only PIDs recorded here. Never touches 8321-8323, launchd, ~/.oasis-code.
# Every step's exit code is recorded in $QA_RUN/steps.tsv (no `| tail` masking). The secret is never printed.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${REPO:-$(cd "$HERE/../../.." && pwd)}
export QA_RUN=${QA_RUN:-$TMPDIR/qa-b1-$(date +%Y%m%d-%H%M%S)}
source "$HERE/lib.sh"
BK="$REPO/backend-ts"
STEPS="$QA_RUN/steps.tsv"; : >"$STEPS"
EV="$QA_RUN/evidence"; mkdir -p "$EV"
step() { local name=$1; shift; "$@" >"$EV/$name.out" 2>"$EV/$name.err"; local rc=$?; printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$name" "$rc" >>"$STEPS"; echo "[$(date +%T)] $name rc=$rc"; return 0; }
trap 'echo "[cleanup]"; cleanup_all; ' EXIT

# ports: explicit, checked free, none of 8321-8323 (8399 is reserved for the later e2e)
cands=(18441 18442 18443 18444 18445 18446 18447 18448 18449 18450); got=()
for p in "${cands[@]}"; do port_free "$p" && got+=("$p"); [ ${#got[@]} -ge 4 ] && break; done
[ ${#got[@]} -ge 4 ] || { echo "no free ports"; exit 1; }
export OASIS_CODE_PORT=${got[0]} OASIS_CODE_BRIDGE_PORT=${got[1]} OASIS_CODE_DIRECTOR_PORT=${got[2]} OASIS_CODE_GATEWAY_PORT=${got[3]}
unset OASIS_CODE_SESSION_TOKEN OASIS_CODE_DIRECTOR_TOKEN
echo "ports backend=$OASIS_CODE_PORT bridge=$OASIS_CODE_BRIDGE_PORT director=$OASIS_CODE_DIRECTOR_PORT gateway=$OASIS_CODE_GATEWAY_PORT data=$OASIS_CODE_DATA" | tee "$EV/env.txt"
GW_DIR="$OASIS_CODE_DATA/gateway"

wait_backend() { for _ in $(seq 1 120); do curl -fsS -m 2 "http://127.0.0.1:$OASIS_CODE_PORT/api/meta/build" >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
start_backend() { local n=$1; local pid; pid=$(cd "$BK" && spawn_bg "$n" bun run src/index.ts); wait_backend; local rc=$?; echo "$n pid=$pid listener=$(lsof -nP -t -iTCP:$OASIS_CODE_PORT -sTCP:LISTEN 2>/dev/null | tr '\n' ' ') at $(date +%FT%T%z)" | tee -a "$EV/pids.txt"; return $rc; }
tokhash() { shasum -a 256 "$OASIS_CODE_DATA/session-token" | cut -c1-12; }
st() { cat "$GW_DIR/status.json" 2>/dev/null; }
stj() { bun -e "const s=JSON.parse(require('fs').readFileSync('$GW_DIR/status.json','utf8'));console.log(s$1 ?? '')" 2>/dev/null; }

# 1 backend (+ an internal director token file, so the "director token is not a public key" check is real)
mkdir -p "$OASIS_CODE_DATA"; openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n' >"$OASIS_CODE_DATA/director-token"; chmod 600 "$OASIS_CODE_DATA/director-token"
step backend1_up start_backend backend1
echo "session-token sha256[:12] backend1=$(tokhash)" | tee -a "$EV/pids.txt"
TOKEN=$(cat "$OASIS_CODE_DATA/session-token")
MARK="qa-b1-marker-$(openssl rand -hex 4)"; mkdir -p "$QA_RUN/$MARK"; echo hi >"$QA_RUN/$MARK/README.md"
step marker_project curl -sS -m 60 -X POST -H "x-oasis-code-token: $TOKEN" -H 'content-type: application/json' --data "{\"source_path\":\"$QA_RUN/$MARK\",\"name\":\"$MARK\"}" "http://127.0.0.1:$OASIS_CODE_PORT/api/projects"
echo "$MARK" >"$EV/marker.txt"; unset TOKEN

# 2 gateway --quick with a hostile ambient environment (must not reach cloudflared)
GWPID=$(cd "$BK" && spawn_bg gateway env TUNNEL_TOKEN=qa-ambient-bogus-token TUNNEL_ORIGIN_CERT=/nonexistent CLOUDFLARE_API_TOKEN=qa-bogus bun run src/index.ts gateway run --quick)
echo "gateway pid=$GWPID" | tee -a "$EV/pids.txt"
HOST=""; for _ in $(seq 1 120); do HOST=$(stj .host); [ -n "$HOST" ] && break; sleep 1; done
[ -n "$HOST" ] || { echo "no quick host"; st; exit 1; }
cfchild() { for c in $(pgrep -P "$GWPID"); do lsof -nP -p "$c" 2>/dev/null | awk 'NR==2{print $1}' | grep -q '^cloudflar' && echo "$c"; done; }
CFPID=$(cfchild)
echo "cloudflared child pid=$CFPID (ppid $GWPID)" | tee -a "$EV/pids.txt"
[ -n "$CFPID" ] && echo "$CFPID cloudflared-child $(date +%s)" >>"$PIDS"
# ps is not permitted in this sandbox: the child's settings come from cloudflared's own "Settings: map[...]" log line
# (a TUNNEL_TOKEN that reached it would show there as token:...), and its argv from the gateway's "starting" line
for _ in $(seq 1 90); do [ "$(stj .public)" = connected ] && break; sleep 2; done
st | sed -E 's/"instance": "[^"]+"/"instance": "<i>"/' >"$EV/status_after_start.json"
SECRET=$(cat "$GW_DIR/secret"); URL="https://$HOST/$SECRET/mcp/current"; SECRET_SHA=$(printf %s "$SECRET" | shasum -a 256 | cut -c1-12)
echo "host=$HOST path=/<secret sha256[:12]=$SECRET_SHA>/mcp/current" | tee "$EV/url.txt"
sleep 5   # quick tunnel DNS propagation

probe() { (cd "$BK" && bun "$HERE/mcp_probe.ts" "$1" --repo "$REPO" --surface director.v6); }
callt() { (cd "$BK" && bun "$HERE/mcp_call.ts" "$@"); }
retry_probe() { for i in 1 2 3 4 5 6; do probe "$1" && return 0; sleep 5; done; return 1; }

# 3 public: initialize / initialized / tools/list, a real read-only tool call, negatives
step pub1_probe retry_probe "$URL"
step pub1_list_projects callt "$URL" list_projects
step pub1_list_models callt "$URL" list_models
step pub1_v6_path probe "https://$HOST/$SECRET/mcp/v6"
step pub1_v1_path_frozen bash -c "cd '$BK' && bun '$HERE/mcp_probe.ts' 'https://$HOST/$SECRET/mcp' --repo '$REPO' --surface director.v1"
step pub_wrong_secret curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "https://$HOST/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/mcp/current"
step pub_director_token_path curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST -H 'content-type: application/json' --data '{}' "https://$HOST/$(cat "$OASIS_CODE_DATA/director-token" 2>/dev/null || echo none)/mcp/current"
ST=$(cat "$OASIS_CODE_DATA/session-token"); step pub_session_token_path curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST -H 'content-type: application/json' --data '{}' "https://$HOST/$ST/mcp/current"; unset ST
step pub_evil_origin callt "$URL" list_models --origin https://evil.example
step pub_healthz curl -sS -m 20 "https://$HOST/healthz"
step pub_trailing_slash curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST -H 'content-type: application/json' --data '{}' "https://$HOST/$SECRET/mcp/current/"

# 4 backend stopped: gateway + tunnel untouched
step backend1_stop kill_recorded backend1
sleep 2
step pub2_probe_backend_down probe "$URL"
step pub2_call_backend_down callt "$URL" list_projects
sleep 17; st | sed -E 's/"instance": "[^"]+"/"instance": "<i>"/' >"$EV/status_backend_down.json"
echo "gateway alive=$(kill -0 $GWPID 2>/dev/null && echo yes || echo no) cloudflared alive=$(kill -0 $CFPID 2>/dev/null && echo yes || echo no)" | tee -a "$EV/pids.txt"

# 5 same backend, same data dir
step backend2_up start_backend backend2
echo "session-token sha256[:12] backend2=$(tokhash)" | tee -a "$EV/pids.txt"
step pub3_probe probe "$URL"
step pub3_call_recovered callt "$URL" list_projects

# 6 only the internal session token changes (file removed -> backend mints a new one)
step backend2_stop kill_recorded backend2
mv "$OASIS_CODE_DATA/session-token" "$QA_RUN/session-token.old"
step backend3_up start_backend backend3
echo "session-token sha256[:12] backend3=$(tokhash) (old=$(shasum -a 256 "$QA_RUN/session-token.old" | cut -c1-12))" | tee -a "$EV/pids.txt"
step pub4_call_new_session_token callt "$URL" list_projects
echo "host after restarts=$(stj .host) secret sha=$(printf %s "$(cat "$GW_DIR/secret")" | shasum -a 256 | cut -c1-12)" | tee -a "$EV/url.txt"

# 7 revoke while running: old URL 404 at once, new one answers, same host
step revoke bash -c "cd '$BK' && bun run src/index.ts gateway revoke >/dev/null"
NEWSECRET=$(cat "$GW_DIR/secret"); NEWURL="https://$HOST/$NEWSECRET/mcp/current"
echo "after revoke: host=$HOST new secret sha=$(printf %s "$NEWSECRET" | shasum -a 256 | cut -c1-12)" | tee -a "$EV/url.txt"
step pub5_old_url_after_revoke curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$URL"
step pub5_new_url_probe probe "$NEWURL"

# 8 secrets never in logs / status / argv
{
  for s in "$NEWSECRET" "$SECRET" "$(cat "$OASIS_CODE_DATA/session-token")" "$(cat "$QA_RUN/session-token.old")"; do
    printf 'secret sha=%s occurrences in logs+status+evidence: ' "$(printf %s "$s" | shasum -a 256 | cut -c1-12)"
    grep -rlF -- "$s" "$QA_RUN/logs" "$GW_DIR/status.json" "$EV" 2>/dev/null | wc -l | tr -d ' '
  done
  echo "modes:"; stat -f '%Sp %N' "$GW_DIR" "$GW_DIR"/* | sed "s#$QA_RUN#\$QA_RUN#"
} >"$EV/secrets_audit.txt" 2>&1
unset SECRET NEWSECRET URL NEWURL

# 8b the tunnel child dies (exact PID): the gateway restarts it; a quick tunnel comes back under a NEW name
OLDHOST=$HOST
step tunnel_child_kill kill -TERM "$CFPID"
for _ in $(seq 1 60); do NEWCF=$(cfchild); [ -n "$NEWCF" ] && [ "$NEWCF" != "$CFPID" ] && break; sleep 1; done
echo "tunnel child restarted: old=$CFPID new=${NEWCF:-none}" | tee -a "$EV/pids.txt"
[ -n "${NEWCF:-}" ] && echo "$NEWCF cloudflared-child2 $(date +%s)" >>"$PIDS"
sleep 40
NEWQ=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$QA_RUN/logs/gateway.log" | sort -u | sed 's#https://##' | grep -v "^$OLDHOST$" | head -1)
echo "after tunnel restart: status.host=$(stj .host) status.public=$(stj .public) new quick name in log=${NEWQ:-none}" | tee -a "$EV/url.txt"
st | sed -E 's/"instance": "[^"]+"/"instance": "<i>"/' >"$EV/status_after_tunnel_restart.json"
if [ -n "${NEWQ:-}" ]; then S2=$(cat "$GW_DIR/secret"); step pub6_new_quick_name curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "https://$NEWQ/$S2/mcp/current"; unset S2; fi

# 9 cleanup by exact PID: gateway (should stop its cloudflared child), then verify the child is gone
step backend3_stop kill_recorded backend3
step gateway_stop kill_recorded gateway
sleep 4
for c in "$CFPID" "${NEWCF:-}"; do [ -n "$c" ] && echo "after gateway stop: cloudflared $c alive=$(kill -0 $c 2>/dev/null && echo yes || echo no)" | tee -a "$EV/pids.txt"; done
kill -0 "$CFPID" 2>/dev/null && kill_recorded cloudflared-child
[ -n "${NEWCF:-}" ] && kill -0 "$NEWCF" 2>/dev/null && kill_recorded cloudflared-child2
trap - EXIT
echo "DONE $QA_RUN"
