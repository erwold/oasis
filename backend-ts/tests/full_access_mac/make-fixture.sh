#!/bin/bash
# QA fixture for Full access (agent-qa only). Builds a private HOME with zsh rc files, a private TMPDIR, fresh SSH
# keys and configs, and workspaces. Never reads or writes the real ~ (passwd home), the real ssh-agent or keychain.
# usage: make-fixture.sh <fixture-dir>     (dir must be inside $QA_ROOT; it is recreated)
set -euo pipefail
FX=${1:?fixture dir}
: "${QA_ROOT:?set QA_ROOT (source env.sh)}"
case "$FX" in "$QA_ROOT"/*) ;; *) echo "refuse: $FX not under $QA_ROOT" >&2; exit 2 ;; esac
rm -rf "$FX"; mkdir -p "$FX"
FX=$(cd "$FX" && pwd -P)
H=$FX/home
# unix sockets (agent, ssh control) need a short path (macOS: 104 bytes): $QA_ROOT/s/<fixture name>
SOCK=$QA_ROOT/s/$(basename "$FX"); rm -rf "$SOCK"; mkdir -p "$SOCK"; chmod 700 "$SOCK"; echo "$SOCK" > "$FX/sockdir"
mkdir -p "$H/zprofile-bin" "$H/zshrc-bin" "$FX/tmp" "$FX/outside" "$FX/ws-a" "$FX/ws-b" "$FX/ssh" "$FX/logs" "$FX/xdg/config" "$FX/xdg/cache" "$FX/xdg/data" "$FX/xdg/state"
chmod 700 "$H" "$FX/ssh"

# tools only the rc files put on PATH: found by name only when the login+interactive shell ran
printf '#!/bin/sh\necho QA_ZPROFILE_TOOL_OK\n' > "$H/zprofile-bin/qa-zprofile-tool"
printf '#!/bin/sh\necho QA_ZSHRC_TOOL_OK\n' > "$H/zshrc-bin/qa-zshrc-tool"
chmod +x "$H/zprofile-bin/qa-zprofile-tool" "$H/zshrc-bin/qa-zshrc-tool"

# every rc file logs one line per run (what read it: pid, ppid, execution id) — Plan/Ask must add none
cat > "$H/.zshenv" <<EOF
export QA_ZSHENV_MARK=zshenv-$$
print -r -- "zshenv pid=\$\$ ppid=\$PPID xid=\${OASIS_CODE_EXECUTION_ID:-none} o=\$-" >> "$FX/logs/rc-runs.log"
EOF
cat > "$H/.zprofile" <<EOF
# login shells only
export QA_ZPROFILE_MARK=zprofile-login
export PATH="$H/zprofile-bin:\$PATH"
export QA_SECRET_LIKE_TOKEN=rc-exported-user-value
print -r -- "zprofile pid=\$\$ ppid=\$PPID xid=\${OASIS_CODE_EXECUTION_ID:-none}" >> "$FX/logs/rc-runs.log"
echo "zprofile noise on stdout"
echo "zprofile noise on stderr" >&2
EOF
cat > "$H/.zshrc" <<EOF
# interactive shells only
[[ -o interactive ]] && export QA_ZSHRC_MARK=zshrc-interactive
export PATH="$H/zshrc-bin:\$PATH"
alias qa_alias='echo alias-not-exported'
print -r -- "zshrc pid=\$\$ ppid=\$PPID xid=\${OASIS_CODE_EXECUTION_ID:-none}" >> "$FX/logs/rc-runs.log"
echo "zshrc noise on stdout"
# a slow rc on demand (the supervisor's timeout must reach it): $FX/slow-rc holds a unique sleep length
if [[ -e "$FX/slow-rc" ]]; then sleep "\$(<$FX/slow-rc)"; fi
EOF
: > "$H/.zlogin"
: > "$FX/logs/rc-runs.log"

# --- SSH: fresh keys only; private client key moved where no option/config names it ---
ssh-keygen -q -t ed25519 -N '' -C qa-client-fixture -f "$FX/ssh/client_key"
mkdir -p "$FX/ssh/agent-only"; chmod 700 "$FX/ssh/agent-only"
mv "$FX/ssh/client_key" "$FX/ssh/agent-only/k"           # ssh-add reads it from here; no client config names this path
ssh-keygen -q -t ed25519 -N '' -C qa-host-fixture -f "$FX/ssh/host_key"
cp "$FX/ssh/client_key.pub" "$FX/ssh/authorized_keys"
chmod 600 "$FX/ssh/authorized_keys"
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
echo "$PORT" > "$FX/ssh/port"
echo "[127.0.0.1]:$PORT $(cut -d' ' -f1,2 "$FX/ssh/host_key.pub")" > "$FX/ssh/known_hosts"
cat > "$FX/ssh/sshd_config" <<EOF
# non-root test sshd: loopback only, this fixture's host key and authorized key only, no shells, no user rc
ListenAddress 127.0.0.1
Port $PORT
HostKey $FX/ssh/host_key
PidFile $FX/ssh/sshd.pid
AuthorizedKeysFile $FX/ssh/authorized_keys
AuthorizedKeysCommand none
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
PermitUserRC no
PermitUserEnvironment no
AllowUsers $(id -un)
AllowTcpForwarding no
X11Forwarding no
PermitTTY no
ForceCommand /bin/echo QA_SSH_FORCECOMMAND
LogLevel VERBOSE
EOF
cat > "$FX/ssh/config" <<EOF
# client config for -F only (no system or ~ config is read with -F)
Host qa-fixture
  HostName 127.0.0.1
  Port $PORT
  User $(id -un)
  IdentityAgent \${SSH_AUTH_SOCK}
  IdentityFile $FX/ssh/client_key.pub
  IdentitiesOnly yes
  UserKnownHostsFile $FX/ssh/known_hosts
  GlobalKnownHostsFile /dev/null
  StrictHostKeyChecking yes
  UpdateHostKeys no
  BatchMode yes
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  PubkeyAuthentication yes
  UseKeychain no
  AddKeysToAgent no
  ForwardAgent no
  SessionType none
  ConnectTimeout 5
EOF
# the command an agent runs: guards that the agent is this fixture's, then a real handshake with no remote shell
cat > "$FX/ssh/handshake.sh" <<EOF
#!/bin/sh
case "\${SSH_AUTH_SOCK:-}" in
  "$SOCK"/*) ;;
  *) echo "QA_SSH_NO_FIXTURE_AGENT sock='\${SSH_AUTH_SOCK:-}'"; exit 3 ;;
esac
# -f -N: background after authentication, no session (no remote shell reads any rc); a control socket ends it
ssh -F "$FX/ssh/config" -vv -f -N -M -S "$SOCK/c\$\$" qa-fixture 2> "$FX/logs/ssh-client.\$\$.log"
rc=\$?
ssh -F "$FX/ssh/config" -S "$SOCK/c\$\$" -O check qa-fixture 2>&1 | sed 's/^/control: /'
ssh -F "$FX/ssh/config" -S "$SOCK/c\$\$" -O exit qa-fixture 2>&1 | sed 's/^/control: /'
grep -E 'Server accepts key|Authenticated to|Authentications that can continue|no such identity|agent' "$FX/logs/ssh-client.\$\$.log" | sed 's/^/client: /'
echo "QA_SSH_EXIT=\$rc"
EOF
chmod +x "$FX/ssh/handshake.sh"
echo "fixture ready: $FX port=$PORT"
