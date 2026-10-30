#!/usr/bin/env bash
# The director behind a Cloudflare quick tunnel, in one go: start the tunnel to the director's port, read the
# hostname it was given (a new one on every start), start the director with that hostname allowed, print the URL
# to paste into the MCP client. Both stop when this script does (Ctrl+C). Runs beside a running harness.
#
#   backend-ts/scripts/director_tunnel.sh            # harness on OASIS_CODE_PORT (8321), director on OASIS_CODE_DIRECTOR_PORT (8322)
#   backend-ts/scripts/director_tunnel.sh -- --harness http://127.0.0.1:8391   # anything after -- goes to the director
set -euo pipefail

port="${OASIS_CODE_DIRECTOR_PORT:-8322}"
data_dir="${OASIS_CODE_DATA:-$HOME/.oasis-code}"
log_dir="${TMPDIR:-/tmp}"
tunnel_log="$log_dir/cloudflared.log"
director_log="$log_dir/oasis-code-director.log"
backend="$(cd "$(dirname "$0")/.." && pwd)"
extra=()
if [ "${1:-}" = "--" ]; then shift; extra=("$@"); fi

command -v cloudflared >/dev/null || { echo "cloudflared is not installed (brew install cloudflared)" >&2; exit 1; }
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $port is already in use; stop the other director first" >&2; exit 1
fi

cloudflared tunnel --url "http://127.0.0.1:$port" >"$tunnel_log" 2>&1 &
tunnel_pid=$!
director_pid=""
stop() { kill "$director_pid" "$tunnel_pid" 2>/dev/null || true; wait 2>/dev/null || true; }
trap stop EXIT INT TERM

host=""
for _ in $(seq 1 60); do
  host="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$tunnel_log" | head -1 | sed 's#https://##')"
  [ -n "$host" ] && break
  kill -0 "$tunnel_pid" 2>/dev/null || { echo "cloudflared exited; see $tunnel_log" >&2; exit 1; }
  sleep 1
done
[ -n "$host" ] || { echo "no tunnel hostname after 60 s; see $tunnel_log" >&2; exit 1; }

(cd "$backend" && exec bun run src/director/main.ts --port "$port" --allow-host "$host" "${extra[@]}") >"$director_log" 2>&1 &
director_pid=$!
for _ in $(seq 1 60); do
  grep -q "oasis-code director on http" "$director_log" 2>/dev/null && break
  kill -0 "$director_pid" 2>/dev/null || { cat "$director_log" >&2; exit 1; }
  sleep 0.5
done
grep -q "oasis-code director on http" "$director_log" || { echo "the director did not start; see $director_log" >&2; exit 1; }

token="$(cat "$data_dir/director-token")"
echo "director:  http://127.0.0.1:$port/$token/mcp/v2   (log $director_log)"
echo "tunnel:    https://$host   (log $tunnel_log)"
echo "connector: https://$host/$token/mcp/v2   (tool surface director.v2)"
echo "           https://$host/$token/mcp      (tool surface director.v1: a connector already configured with it keeps its tools)"
echo "leave this running; Ctrl+C stops the director and the tunnel"
wait "$director_pid"
