# oasis-code — technical reference

The friend-facing guide is the [README](../README.md) (Chinese; [English summary](../README.en.md)). This page is
the technical reference: how the pieces run, what the defaults are, and where in the source each behaviour lives.
It describes the code as it stands; it is not a release note, and nothing here is promised beyond macOS on Apple
silicon, the only platform it has been used on.

## The pieces

| Folder | What it is |
|---|---|
| `contract/` | The shared zod schemas (API, events, modes, mentions, UI surfaces) |
| `backend-ts/` | The backend, TypeScript on Bun: model routes, the agent loop and tools, permissions, the SQLite database, the director (MCP), the remote-access gateway, SSH transport |
| `frontend/` | The UI, React + Vite, served by the backend from `frontend/dist` |
| `desktop/` | The Electron shell (Electron 44): starts the backend, holds the agent's browser and the ChatGPT page, remote access |

## Running it

The desktop app is the way to use it day to day: one window, the backend started and stopped with it.

```sh
(cd backend-ts && bun install --frozen-lockfile)   # its postinstall installs ../contract and links it
(cd frontend && npm ci)
(cd desktop && npm ci)
(cd desktop && npm start)
```

`npm start` runs the backend from the source tree with Bun (`bun` on the terminal's `PATH`) and builds the UI once
when `frontend/dist` is missing — only then, so after pulling new code run `npm run build` in `frontend/`. On macOS
it runs Electron from `desktop/.dev/oasis-code.app`, a clone of Electron's bundle with the product's name and icon,
made on first start. The app attaches to a backend already answering on `127.0.0.1:8321` instead of starting a
second one — only the backend of its own data directory: before it sends that directory's session token it asks
the backend to prove it holds the same token (an HMAC of a fresh challenge, `/api/meta/build?challenge=…`), and
refuses another data directory's backend, or anything else, on the port. It writes the backend's log to
`~/.oasis-code/logs/desktop.log`. Electron's profile (window state, the sign-ins of the pages the app shows, the
single-instance lock) is in `~/Library/Application Support/oasis-code` on macOS; `OASIS_CODE_USER_DATA` names
another, and an app started with a data directory other than `~/.oasis-code` keeps it in `electron/` there.

`npm run smoke` in `desktop/` is the app's headless self-test (renders the app, checks the preload bridge, writes a
screenshot, quits) on a data directory, profile and free port of its own in a temporary folder — never your profile,
data or running backend.

`npm run dist` in `desktop/` packages the app for the machine it runs on into `desktop/dist` (a `.dmg` on macOS),
with the backend compiled into one binary (`bun run build` → `backend-ts/dist/oasis-code`) and the UI built in.
The package is unsigned and not notarized; build it on the OS you will run it on.

### The backend alone, in a browser

```sh
(cd frontend && npm run build)
cd backend-ts && bun run start
```

The server binds `127.0.0.1:8321` and prints `http://127.0.0.1:8321/?token=…` (the whole link on a terminal; into a
pipe or a file it prints `?token=<token>` and where the token is kept — `<data dir>/session-token`, 0600). Open that
URL once (it sets an HttpOnly cookie for 30 days). A program sends the token in the `x-oasis-code-token` header;
state-changing requests must be same-origin. One backend runs per data directory: a second one on the same data, or
on a port already taken, says so in one line and exits 1.

## Sign-in and model routes

**Accounts** (bottom of the left rail) → *Subscriptions*: **Codex** (ChatGPT Plus/Pro) or **Claude** (Pro/Max) →
*Sign in*. The browser opens the provider's page and the loopback callback finishes the sign-in (or paste the final
redirect URL); the grant lands in `~/.oasis-code/auth.json` (0600, plain JSON). Sign-in is offered only on a local
page. *API keys* → *Add key* saves a pay-as-you-go key; a route can also read the environment variable it names.
The command line has the same flows (`backend-ts/src/auth/cli.ts`):

```sh
cd backend-ts
bun run auth login anthropic        # or openai-codex; --device (headless Codex) or --paste
bun run auth status | usage | logout <provider> | smoke <provider:model>
```

The built-in routes are `DEFAULT_MODELS` in `backend-ts/src/config.ts`: subscription routes `anthropic:…` and
`openai:…`, pay-as-you-go routes `anthropic-api:…`, `openai-api:…` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) and
`google:gemini-4-argon` (`GEMINI_API_KEY`). The default model is `default_model` in `config.json`, else
`OASIS_CODE_DEFAULT_MODEL`, else the first route (`anthropic:claude-opus-5-5`). A `models` list in `config.json`
replaces the built-in list as a whole.

Data lives in `~/.oasis-code` (`OASIS_CODE_DATA`), config in `~/.oasis-code/config.json` (`OASIS_CODE_CONFIG`):
model routes (`provider`, `model`, `base_url`, `api_key_env`, `context_window`, `cache_ttl`, `concurrency`,
`pricing`), the default model, `context_window_fallback_tokens`, `protected_paths` (default `.git/**`,
`.oasis-code/**`), `command_env_passthrough`, command timeouts and output caps, and the project checks. Every
variable is prefixed `OASIS_CODE_`. `bun run cache-probe <route>` sends three small requests and prints the
provider's prompt-cache figures.

Before an upgrade changes the database's schema, the backend copies it whole beside itself —
`~/.oasis-code/index.db.v<old version>.bak` — and says so in the startup log. Only the latest copy is kept. An older
build refuses a newer schema, so this copy is the way back: quit the app, put the copy in place of `index.db`
(remove `index.db-wal` and `index.db-shm`), start the older build. A copy that cannot be made stops the upgrade.

## Where commands run, and what is asked

Two independent settings per session (`contract/src/modes.ts`):

- **Access** — `full` (the default for a session made by the app or the REST API): commands run as the user,
  outside any sandbox, with the user's HOME, login-shell environment, network and files; `sandbox`: inside the OS
  isolation runtime (macOS Seatbelt; the workspace writable, credential stores and the harness's data unreadable,
  the network as the session grants it). The first Full access command on a machine asks *Run commands as you on
  this computer?* in the conversation (`backend-ts/src/agent/ui_inputs.ts`); a yes confirms the machine and is not
  asked again, *Use the sandbox* moves that session to the sandbox. `full_access_confirmed: true` in `config.json`
  confirms without asking. A session in the sandbox shows an access chip in the composer to go back to Full access
  while nothing of it is running. SSH sessions are Full only. Bubblewrap on Linux is probed but not claimed.
- **Mode** — `auto` (the default: edit, run, use the network without asking), `approve` (*Ask before changes*:
  read freely, every edit and command proposed for your approval), `plan` (read and search only; enforced at the
  tool boundary). The UI shows *Switch to Auto* on a session not in Auto; there is no UI control to leave Auto in
  this version — `PUT /api/sessions/:id/mode` with `{"mode": "approve" | "plan" | "auto"}` does it (refused with 409
  while a run is active).

Checkpoints and undo cover the working folder only, in both accesses.

## How a folder is opened: in place, a copy, or attached

A project names a folder in one of three ways (`mode` on `POST /api/projects`):

- **direct — edited in place.** Nothing is copied; sessions work in the folder itself (the workspace lock makes
  writers take turns). A file tool's write is journalled first, so a run's file changes can be undone (*Undo file
  changes*, `POST /api/runs/:id/undo`) as long as the file is still as the run left it; a command's writes are its
  own, as in any terminal. The folder's Git metadata is never written; checkpoints and integration are refused.
- **snapshot — a copy.** The folder is snapshotted into the project's base (a repository: its HEAD, cloned
  shallow), and each session works in a workspace of its own with checkpoints and integration. A plain folder over
  2 GB or 20,000 files (`OASIS_CODE_SNAPSHOT_MAX_BYTES`, `OASIS_CODE_SNAPSHOT_MAX_FILES`) is refused.
- **attached — read where it stands.** The folder is mounted read-only inside the session's workspace under its own
  name; whatever the agent writes lands in the workspace. The `attached_write` grant lets patches and commands change
  the attached folder itself (nothing there is undone by a checkpoint).

The page opens a folder `direct` (or `attached`, offered as *Attach it read-only* when a folder cannot be taken in),
and so does the director's `open_project`. The REST API's default, when a request names no `mode`, is `snapshot`.

## Several agents on one message

Agents are named in the composer with `@` (a model route; the same route can be named twice — two participants,
`contract/src/mentions.ts`). With two or more named, the orchestration chip offers (`frontend/src/state/interaction.ts`):

| Choice | What runs |
|---|---|
| *Guided* | the session's director reads the words once and commits a plan; the harness runs it |
| *Independently, then I choose* | N agents work alone (own copies of the files, or in place taking turns); you compare |
| *Discuss* | N agents answer alone, then read each other's complete answers and respond, 1–4 exchanges |
| *Take turns* | the agents take turns in the order named, 1–3 rounds (a relay) |

The same menu sets runs in all, runs at once (1–4) and the files policy. With one agent, *Separate task* starts an
agent with its own conversation and its own output folder or copy, shown on a card; *Main agent* continues the
session's conversation. The **Director** chip sends the words to the session's own director (a model route of this
harness), which answers and has agents do the work.

## SSH remote folders

An agent connects a host on the person's yes (tools `ssh_connect`, `ssh_directories`, `open_ssh_session`,
`forward_port`; `backend-ts/src/agent/tools/ssh.ts`): the question shows the host key's fingerprint, and nothing is
saved, trusted or dialed before the answer. The transport (`backend-ts/src/remote/transport.ts`) runs the system
`ssh` with `-F /dev/null` (the person's `ssh_config` is never read), `BatchMode=yes`, `StrictHostKeyChecking=yes`,
no agent forwarding; key authentication only. On the host a Python standard-library adapter
(`backend-ts/src/remote/adapter.py`, Python ≥ 3.9, Linux or macOS) serves file operations and commands; model calls,
the database and approvals stay on this machine. A port of a remote session is forwarded to this machine's loopback
and can be opened in the Browser card.

A session an agent opens on a host is never wider than the run that opens it (`backend-ts/src/policy/delegation.ts`):
it gets the caller's mode ("Ask before changes" when the caller's run pauses any gated action, a pause scoped to that
run included) and no more than its grants; a run in the Sandbox, under a work order, with any hard budget line set
on its row (requests, total tokens, wall-clock seconds, tool calls) or in Plan is refused, as a run
whose work order or grant has the network off is refused any host tool. The app's API knows these requests for the
agent's (`x-oasis-agent-run-id`, checked against the live runs): the run they start names the calling run in its
origin, the record says `agent`, and such a request reaches only the routes that open a session there.

## Intelligent UI

An agent can show a surface in the conversation (`present_ui`; schema `contract/src/ui.ts`): native elements —
stack, row, card, text, metric, table, bar and line charts, inputs, selects, sliders, checkboxes, buttons — or an
isolated HTML document (a sandboxed frame with no access to the app, its API or credentials; it talks to the host
only through `window.oasisUI`). Actions either put a prompt in the person's draft (`draft`) or start a run whose
progress comes back to the surface (`run`). `request_input` shows a native form and waits for the answer. A surface
can be scoped to the session and updated in place by later runs (`scope: 'session'` with `expected_revision`).

**File-backed line charts.** A line chart may take `source: { path, format: 'jsonl' | 'csv', x, series: [...] }`
instead of inline points: the app reads the file itself while the surface is shown — after the run too — so the
data never passes through the model and has no point limit. A record counts at its newline; JSON `null` or a
non-number is a gap, a missing key or empty CSV cell is no observation; x must increase within a series. Reads go
through `GET /api/sessions/:sid/ui/:run/:surface/sources/:element`, checked each time against the scope of the run
that wrote the surface (workspace, roots, protected paths, symlinks resolved), for local and SSH workspaces alike;
a truncated, replaced or rewritten file is read again from the start
(`frontend/src/state/uiChartFeed.ts`, `backend-ts/src/agent/ui_chart_sources.ts`).

## Direct it from ChatGPT (or any MCP client)

A model outside this program can be the director — it plans and judges; the harness's agents do the coding. The
director is an MCP server (`backend-ts/src/director/`); its newest tool surface (`surfaces/director.v11.json`) has
25 tools, thin over the REST API: `current_session`, `list_models`, `list_projects`, `open_project`,
`list_ssh_targets`, `connect_ssh`, `ssh_directories`, `forward_port`, `set_project_config`, `create_session`,
`get_session`, `get_collaboration`, `post_director_note`, `start_run`, `start_relay`, `attach_image`, `get_run`,
`cancel_run`, `steer_run`, `get_workspace`, `read_file`, `bash`, `start_interaction`, `schedule`, `integrate`.
`open_project` with `worktree` makes a new Git worktree of a local repository on a new branch (beside the repository
by default) and opens it in direct mode. `read_file` shows a connector's model a PNG, JPEG or WebP file as an MCP image
(up to 5 MB, fitted to 2048 px on its long side; a remote folder's images too).
Older surfaces stay frozen for connectors made against them. Every refusal is the harness's. A run's receipt records
what the harness measured (status, tool calls, commands and exit codes, files changed, checks, cost) beside the
agent's final text; it carries no verdict of its own.

### Remote access: the standing gateway (desktop app, macOS)

The *Remote access* card in the Accounts panel turns on a per-user launchd agent for this data directory
(`desktop/gateway_agent.js`, `desktop/remote.js`) that runs the backend's `gateway run`
(`backend-ts/src/gateway/`), listening on `127.0.0.1:8324` (`OASIS_CODE_GATEWAY_PORT`). It keeps running when the
app quits; turning the card off removes it. The connector URL is `https://<host>/<gateway secret>/mcp/current` (the
newest tool surface); the secret is the gateway's own (`<data dir>/gateway/secret`, 0600), and only a revoke
changes it. The tunnel in front of it is one of:

- a **Cloudflare quick tunnel** (the default with nothing set up; needs `cloudflared`; its hostname changes when the
  gateway restarts — cloudflared is run with its own config, over HTTP/2);
- a **Cloudflare named tunnel** (its token; its public hostname routed to the gateway in Cloudflare's dashboard);
- an **ngrok** fixed domain (the account's authtoken);
- **external**: a fixed HTTPS hostname some other tunnel the person runs brings to the gateway's port — for
  example Tailscale Funnel (`tailscale funnel --bg 8324`, then the `*.ts.net` name in the card). The gateway starts
  nothing for it and touches nothing of Tailscale.

The hostname must be a public DNS name (no IP, port, path or private suffix); the gateway answers under it only.

### The director by hand

```sh
backend-ts/scripts/director_tunnel.sh             # a Cloudflare quick tunnel + the director, prints the connector URL
cd backend-ts
bun run director --allow-host <tunnel host>       # Streamable HTTP on 127.0.0.1:8322
bun run director --transport stdio                # for a client that spawns the server
```

Over HTTP the director serves the current tool surface (the URL it prints names it); over stdio it serves
`director.v1` unless `--surface` names another. The director token lives in `~/.oasis-code/director-token` (0600); the endpoint answers only under its token and
only for the loopback and the hosts named with `--allow-host` (or `OASIS_CODE_DIRECTOR_ALLOWED_HOSTS`).

## Computer use: the agent's browser and the ChatGPT page

With the desktop app running, an agent can look at and act on two pages the app holds: its own browser (the Browser
card) and the person's signed-in ChatGPT page (`computer_observe`, `computer_act`; named in the composer as
`@Computer`). What a look hands the model, and keeps in the session's history: the screenshot; the outline of the
page's controls with the values typed into fields — except password fields; the page's text when read; console
errors and warnings, failed request addresses, the title and the URL. Cookies and password values are not sent.

The agent's browser has one profile for the whole app; each agent run works in its own tabs (it sees and acts on no
other run's tab; two runs work at the same time), and the Browser card shows whichever tab you pick. The Browser
card's *Clear data* closes every tab and removes the profile's cookies, site storage and cache after asking. Downloads are moved into the workspace's temporary folder. In *Ask before changes*
every action on a page is proposed and re-checked when approved (network grant, work order, and whether the page
still shows what the look showed). The agent's browser never reaches oasis-code's own API: the desktop app marks
everything that browser sends to this machine's loopback, and the backend refuses every request so marked.
Automating a web product you are signed in to is your own use of it: check it is within that product's terms.

## Tests

```sh
cd backend-ts
bun test                 # unit + integration; every provider is a scripted fetch, no cloud call
bun run typecheck
cd ../frontend && npm test && npm run build
cd ../desktop && npm test
```

The backend suite's preload (`backend-ts/tests/preload.ts`) makes the global fetch refuse every host but the
loopback and points the data and credential directory at a temporary directory, so no test reaches a cloud or reads
`~/.oasis-code`. The end-to-end tests (`frontend/e2e/`, headless Chrome through `playwright-core` against a real
backend on a temporary data directory) need `npm run build` first and are run one file at a time, e.g.
`OASIS_CODE_E2E_PORT=8399 node --test e2e/<file>.e2e.ts`.
