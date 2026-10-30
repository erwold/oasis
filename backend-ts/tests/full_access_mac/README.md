# Full access on a real macOS host — fixture run

What `tests/test_full_access.test.ts` asserts in-process, on real processes of a private host. Scripts by the QA
agent of the Full access work, made portable here. They never read or write the real HOME (passwd home), the real
ssh-agent, the keychain or the person's data; everything goes under `$QA_ROOT`, a scratch folder of your own.

- `env.sh` — source it with `QA_ROOT` set: HOME, TMPDIR, XDG, `OASIS_CODE_DATA`, caches under `$QA_ROOT/env`.
- `make-fixture.sh <dir>` — a private HOME with `.zshenv/.zprofile/.zshrc` (each logs one line per run with its pid and
  `OASIS_CODE_EXECUTION_ID`), tools only the rc files put on PATH, a private TMPDIR, a fresh ed25519 client key (the
  private key only in `ssh/agent-only/k`, referenced by nothing; the client config names `client_key.pub` only) and a
  host key; `ssh -F` configs only, so no system or `~` configuration is read.
- `fixture-services.sh start|stop|status <dir>` — the fixture's own `ssh-agent -d` (logs every signature) and a loopback
  SSH server: `sshserver/server.js` (ssh2, real protocol, accepts a publickey only after verifying the signature; no
  session, exec or forwarding) or `QA_SSHD=system` for a non-root `/usr/sbin/sshd`. Signals only pids it recorded and
  whose command line still names the fixture.
- `terminal-reference.sh <dir>` — what a login + interactive zsh of the fixture's user prints (with a pty where one can
  be opened, and without).
- `qa_full_access.mac.ts` — the product-level checks (HOME/PATH/TMPDIR/SSH_AUTH_SOCK/UID against the terminal reference,
  rc runs inside the supervised command, agent signature verified by the server, Plan/Ask read no rc, idle-only switch,
  slow rc in the timeout, director v5 vs v6, v27 migration). Not picked up by `bun test`; the runner copies it into a
  tree copy as `tests/qa_full_access.test.ts`.
- `run-product-fixture.sh <tree-copy-under-QA_ROOT> <label>` — builds a fixture, starts its services, starts `bun test`
  with the environment a desktop app or a terminal gives the backend (`env -i`, the fixture HOME/TMPDIR/XDG, the
  fixture agent, zsh), stops the services, checks no fixture process is left.
- `make_v27_db.ts <baseline-tree-root> <out-data-dir> <project-folder>` — a v27 database made by the baseline tree.

```sh
export QA_ROOT=/path/to/scratch            # never your HOME
. tests/full_access_mac/env.sh
(cd tests/full_access_mac/sshserver && npm ci --ignore-scripts)   # ssh2, next to server.js (node_modules is not part of the source)
rsync -a --exclude node_modules <baseline-tree>/ "$QA_ROOT/base/" && (cd "$QA_ROOT/base/backend-ts" && bun install --frozen-lockfile)
rsync -a --exclude node_modules <candidate-tree>/ "$QA_ROOT/cand/" && (cd "$QA_ROOT/cand/backend-ts" && bun install --frozen-lockfile)
(cd "$QA_ROOT/base/backend-ts" && bun run "$QA_DIR/make_v27_db.ts" "$QA_ROOT/base" "$QA_ROOT/fixtures/v27/data" "$QA_ROOT/fixtures/v27/proj")
tests/full_access_mac/run-product-fixture.sh "$QA_ROOT/base" baseline   # expected: every case fails by behaviour
tests/full_access_mac/run-product-fixture.sh "$QA_ROOT/cand" cand       # expected: every case passes
```

Limits, as measured where these were written: a sandbox around the run itself may refuse a nested Seatbelt (the
Sandbox side's write refusal is then not observable), `/bin/ps` (setuid), a pty, the system sshd's own preauth sandbox
and `.git`; a command run without a pty is not every transient state of another terminal. The ssh check proves the
agent signature path under the `-F` configuration only, not OpenSSH's default discovery of `~/.ssh/config` (by the
passwd home).
