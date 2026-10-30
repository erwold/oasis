# Live read-only session sharing

One session can be watched while it works, read-only, through a link the person makes. The live view follows the same
rules as the offline share (`contract/src/share.ts`): the same field whitelist, the same sanitizer, and the same
sensitive-source rules. The difference is that it shows runs that are still queued or running, and answers that are
still being written. The contract is `contract/src/live_share.ts`. The offline snapshot formats V1 and V2 are frozen,
and the live state does not use them: it is its own format, `oasis-code.session-live`, version 1 — and version 2
(protocol 2, below: the Agent Teams card and a task's sessions).

## Why this shape

The shape follows from what nearby tools do:

- A static snapshot, taken once: the Codex desktop app's shared links (<https://learn.chatgpt.com/docs/use-chatgpt>).
- The latest state when the link is opened, but no real-time updates: Claude Code's cloud session sharing
  (<https://code.claude.com/docs/en/claude-code-on-the-web>).
- Remote-control tools that also let the viewer act: Claude Code Remote Control
  (<https://code.claude.com/docs/en/remote-control>), and Visual Studio Live Share, whose read-only mode still lets
  guests do some things (<https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security>).
- View-only public traces that can be revoked: LangSmith (<https://docs.langchain.com/langsmith/manage-trace>).

oasis-code takes the view-only, revocable model and adds liveness. A viewer never reaches anything that can change the
session, and never receives anything but projected, sanitized states.

## The pieces

### The share-only listener

The listener is a `Bun.serve` of its own inside the backend process (`backend-ts/src/share/live/service.ts`).

- **Off by default.** It listens only while the person has it turned on in Settings (`GET` / `PUT
  /api/settings/live-share`): when the app starts with it on (`start()`), or at once when a saved setting turns it on
  (`applySettings`). Building the app's state never listens.
- **Default bind is loopback** (127.0.0.1, port 8325). `lan` binds 0.0.0.0 and must be chosen explicitly.
- **Transport-agnostic.** A Cloudflare named tunnel or a LAN address; see "Setting it up" below. Cloudflare Quick
  Tunnels are **not supported**: they do not carry Server-Sent Events
  (<https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/>), and the live view is an SSE stream.
- **It serves exactly five GET paths:**
  - `/live/`: an HTML shell the backend writes.
  - `/live/assets/live-share.js` and `/live/assets/live-share.css`: read from exactly
    `<FRONTEND_DIST>/live-share/`. The frontend build copies them there, so they ship with the app.
  - `/live/api/stream`
  - `/live/api/image/<resource>`
- **How a path is matched.** The listener compares the request URL's parsed pathname (WHATWG URL parsing) against
  these five exact strings, and nothing else. Parsing resolves dot segments before the comparison, including their
  `%2e` forms. So `/x/../live/` or `/live/assets/./live-share.js` reach the same resource as the exact path; they can
  never reach anything else, because the allowlist has no prefix match and no path ever reaches a filesystem lookup
  (the two assets are fixed file names). No other escape is decoded: `%2f`, `%5c`, `%6C`, a doubled slash, a trailing
  slash or a different case all get 404. The raw probe is `handoff/logs/listener-raw-path-probe.log` (not committed).
- **Everything else is refused:**
  - any other parsed path, and any query string: 404;
  - any other method, OPTIONS and HEAD included: 405;
  - an `Upgrade` header, a request body, or the agent-browser header: 403.
- **It never touches the app's router or credentials.** It never calls the app's router, the gateway, or a proxy. It
  never reads or sets the app's cookie (cookies are not port-scoped, so a LAN browser may send it; it is ignored).
- **Response headers.** Every response carries `no-store`, `nosniff`, `no-referrer`, `CORP: same-origin` and
  `X-Frame-Options: DENY`. It also carries a viewer-only CSP: `script-src 'self'`, `connect-src 'self'`,
  `img-src 'self' blob: data:`, `frame-ancestors 'none'`, with base, form and object all denied. The app's own CSP is
  not changed.
- **Unexpected errors.** `Bun.serve` runs with `development: false`, so Bun's own error page (the error, its stack, source
  paths) is never sent. A request that throws, and Bun's `error` handler, both answer a fixed `503 {"error":"unavailable"}`
  with the listener's headers: no message, stack or path. What failed goes to this machine's log only, redacted, under a
  reference.
- **One lifecycle queue.** Applying settings, the start and the close run one step at a time, in the order asked. Two
  applies never interleave: the last one asked holds. After the close, nothing opens the listener again.
- **Bind errors.** A port that is taken leaves `enabled` as the person set it and reports the error in the status.
  Nothing retries.

### Links and capabilities

Links live in the table `share_links` (schema v34). Owner routes:

- `POST` / `GET /api/sessions/:id/share-links`
- `POST /api/share-links/:id/reveal`
- `POST /api/share-links/:id/revoke`

Every owner route, GET included, refuses:

- an agent run;
- a connector;
- a director tool surface, director session or director turn;
- the agent's browser;
- any peer that is not the loopback.

This matters because agents may otherwise GET any route. (The offline `share-snapshot` route keeps its existing
behaviour; the share listener never routes it.)

Link properties:

- **Options are fixed** when the link is made: tool details, images, and excluded run ids (stored sorted and
  deduplicated).
- **Expiry is required**: 5 minutes to 30 days. The UI defaults to one day.
- **Capability:** HMAC-SHA256(share key, `"oasis-code live share v1\0" ‖ link id`), base64url (256 bits). The share
  key is 32 random bytes in `<data dir>/live-share-key` (mode 0600). It is never the session token and never derived
  from it.
- **The table stores only sha256(capability).** A request is checked in this order: the header's shape first, then the
  hash lookup, then a constant-time comparison with the capability derived again.
- **Reveal** derives the same capability again, so a link can be copied after the dialog closes or the app restarts.
  It is a POST, owner-only, and only for an active link whose hash still matches.
- **URL:** `<origin>/live/#<capability>`.
  - Browsers do not send the fragment in the request URL, so it is not in request lines or URL logs.
  - The viewer sends the capability as `Authorization: Bearer …` on `fetch`. EventSource cannot set headers, and a
    query string would end up in URL logs.
  - The header does reach the origin, and every hop that terminates TLS or HTTP on the way. With a Cloudflare tunnel
    that includes Cloudflare's edge. The capability is protected by the transport's encryption, not hidden from the
    services that carry it. Over plain-HTTP LAN it travels unencrypted.
- **Key trade-off.**
  - The database alone yields no capability.
  - Whoever reads both the key file and the database can derive every active link. That is the whole data folder,
    which already holds the session token and every session.
  - A missing or damaged key means existing links can no longer be revealed, and new connections with them are refused
    (401). It does NOT end streams already open: ending a link is what revoke does.
  - The key is never replaced silently while any link is active: the check covers every session's links
    (`anyActiveLink`), not only the session being shared. While any link of any session is still active, creation is
    refused with 409 `share_key_unavailable` and a message saying to revoke those links; the dialog shows only a generic
    refusal (409). Every such link must be revoked through the ordinary revoke route, or reach its expiry; new links are
    then made under a new key. A reveal of such a link answers 410 `share_link_inactive`.
  - Deleting the key file is not a revocation mechanism. Revoke (per link) is. There is no rotate operation; revoke and
    create a new link instead.

### Projection: one producer per session × options

- **Shared work.** Links with the same session and canonical options share one producer, however many viewers they
  have. The first viewer of a projection starts it; a resource guess on the image route never does.
- **Triggers.** A producer is marked dirty by:
  - the run hub: `SessionEventHub.watch`, which only sets a mark (nothing is projected on the runner's emit);
  - a cheap fingerprint query, polled every 2 s while the session is watched. It covers what the run hub does not
    carry: titles, director turns and notes, relays, interactions, group notes and participants. The fingerprint
    baseline is captured before each build.
- **Coalescing.** Rebuilds wait about 400 ms after a change. They never run more often than
  max(1 s, 5 × the last build's cost, a failure back-off), and only one runs at a time. Every connect also asks for a
  refresh when the producer may be behind; for example, words arrived while nobody watched.
- **Off the event loop.** Builds run in the projector worker (`projector_worker.ts`):
  - It opens the database read-only (`query_only`) and builds no app state and no credential store.
  - It receives only the paths, the model labels and the session token (for the sanitizer only; never logged, never
    returned).
  - It projects with the snapshot's own code (`buildLiveSnapshot` in `share/snapshot.ts`), validates the result
    against the strict `LiveSnapshotSchema`, and serializes it once.
  - A build whose content hash (computed without `generated_at`) is unchanged is not a new revision and is sent to
    nobody.
- **Near-budget evidence.** With about 90 MB of synthetic stored records, the app's event loop was held at most 12 ms
  (first build) and 36 ms (rebuilds) with the worker, against 256 / 231 ms in process. The test is
  `backend-ts/tests/test_live_share_load.test.ts`, run with `LIVE_SHARE_LOAD=1`. The compiled binary carries the
  worker as an extra entry point (`bun run build`).
- **Fan-out.** Each viewer gets a tiny per-link prefix (epoch, revision, expiry) and suffix around the same snapshot
  bytes. A viewer holds at most one queued frame and one pending frame; the latest replaces an older pending one. A
  viewer that has not drained for 60 s is closed, and its client reconnects. A broadcast or a pull that throws for one
  viewer ends that viewer alone: it is counted out, its stream is cut without a message, the error is logged locally,
  and the other viewers go on. A keep-alive that cannot be written detaches that viewer.
- **Background build failures.** A build runs on a timer, outside any request. Anything it throws is caught and logged
  locally, never an unhandled rejection. A failed build (thrown, or the worker's error reply) marks the producer dirty
  and is asked again after a back-off of 2ⁿ s (n = consecutive failures, counted up to 5; at most 30 s). A good build
  resets n.
- **Idle disposal.** A producer whose last viewer left is disposed after a short grace period (5 s). With no producer
  left, the worker thread is stopped.

### Wire protocol

There are three kinds of frames:

- `event: state`, `id: <epoch>.<revision>`, with data `{epoch, revision, expires_at, snapshot}`: the whole latest safe
  state.
- `event: ended`, with data `{reason}`, then the stream closes. Reasons:
  - `revoked`, `expired`, `session_deleted`: permanent.
  - `disabled`, `server_closing`: retry later.
- A `: keep-alive` comment every 15 s.

There are no item patches and no replay. Item keys are positional, so every connect and reconnect starts with a whole
safe state. A projection kept through a short absence (its viewers gone for less than the idle grace) may first send
its cached safe full state; the coalesced rebuilt full state then catches up on the same stream with whatever happened
meanwhile. A new epoch, for example after a restart, means a reset.

### What may be shown while a run works

- **Run status.** Watched runs are read from their persisted events, up to the seq the open answer was taken at (one
  cut), never from their lagging record. Status is `queued` or `running`.
- **The open answer (`message_open`)** shows only completed lines:
  - The line being written is withheld.
  - Everything from the opening line of an unclosed multi-line structure is withheld: a private key block without its
    END line, a PuTTY key without its MAC line, a triple-quoted literal, or a YAML block scalar under a secret-named
    key.
  - The shown part, sanitized, must be exactly how the sanitized text so far begins. If it is not, it steps back line
    by line, and if it never is, nothing is shown.
  - The text is then sanitized by the projection's own sanitizer.
  - Tests check every prefix of adversarial texts (split tokens, auth headers, credential assignments, private keys,
    emails, home paths, the session token) against the finished answer: `test_live_share_stream_text.test.ts`.
- **Tool calls** appear only once complete (`tool_call`):
  - While the run works, a call shows its name, target, status and the whitelisted result fields its result event
    carries (an exit code, a duration, byte counts) — never its output. A result event holds no output, and a working
    run's record is not read. The output preview (sanitized) arrives once the run has finished and its record is read,
    as the offline share reads it.
  - `tool_call_progress`, thinking and partial arguments are never shown.
  - A call known only from its event whose metadata may have been cut (300 characters) is withheld as a sensitive
    source.
  - A source-reading tool whose call names no source at all is withheld.
  - A command known only so marks its execution sensitive, so polling its output (`bash_output`) is withheld too.

### Pictures

Images are only included when the link includes them. They are the session's own attachment images, with the same
ownership checks as the offline share. What a viewer receives is not the source bytes: it is a structural rewrite with
strict validation (`share/live/images.ts`):

- **PNG**
  - IHDR exactly once and first, PLTE and tRNS checked against the colour type, IEND empty.
  - The IDAT stream is inflated, checked for its exact size and filter bytes, and deflated again.
  - Ancillary chunks are dropped; unknown critical chunks and animations are refused.
- **JPEG**
  - SOF0–2 only, 8-bit, 1 or 3 components.
  - DQT, DHT and DRI are parsed to their exact length.
  - APPn and COM are dropped; anything after EOI is dropped; other markers are refused.
- **WebP**
  - VP8 or VP8L, or still VP8X with ALPH.
  - Reserved bits and padding must be zero; the canvas must match the image.
  - ICCP, EXIF and XMP are dropped; animation is refused.

This is metadata stripping, **not a re-encode, and not equivalent to one**:

- The pixels are the source's; what a screenshot shows is shared as shown.
- PNG's compressed stream is rebuilt (inflated and deflated again), so nothing survives in zlib slack or after its
  end.
- JPEG and WebP payloads are kept as they are. Their table values (DQT, DHT), entropy-coded scans and VP8 / VP8L
  bitstreams are carried as validated structure, not decoded. Data hidden inside them (steganography, bytes an encoder
  appended within a bitstream) is not promised to be removed.

Images are served by an opaque resource id: an HMAC under the producer's random salt over the asset and its stripped
digest. It is never an asset id or a positional key. A resource is answered only when it is in the link's current
projection. The link is checked again after the bytes are read, so a link revoked or expired meanwhile gets 410.

### Ends

- **Revoke, session deletion, the listener turned off.** The link (or the listener) is invalid first, both in the row
  and in memory. Then each stream gets `ended` if its queue is empty, or is aborted if not, so nothing queued earlier is
  delivered.
- **Expiry** ends streams by itself, on a timer at the nearest expiry (capped to the timer's range) plus the heartbeat
  sweep.
- **Every write is guarded.** Every send, every pending frame released on drain, and every image answer checks the
  link again right before it goes.
- **Restart.** A restart gives a new epoch: viewers reconnect to the latest state, and revoked links stay revoked.
- **What revocation cannot do.** Ending a link stops what is sent from then on. A state a viewer has already received
  (on screen, in a saved page, in a screenshot) cannot be recalled.

## Protocol 2: the Agent Teams card and a task's sessions

Protocol 1 (above) is frozen: its links, capabilities, frames and state format version 1 are exactly as described, and
an old link keeps working with the new viewer page. Protocol 2 is new and separate (`contract/src/live_share.ts`, after
"v2"; the offline counterpart is snapshot V3 in `contract/src/share.ts`).

### What a v2 state adds

- **The Agent Teams card** of every session shown (`team`, `contract/src/agent_teams.ts`): the outline's rows, folded as
  the app folds them (the whole tree, so a run left out never changes another row's bot), action rows out, each row
  only its key, parent and dependency keys, kind, name (sanitized), bot, model label, status, the glyph's verdict, the
  participant's badge, how many runs, its start and end, and the run key of the turn a click scrolls to. No receipt,
  work order, request text, waiting holder or real id.
- **Faces**: every run carries the bot its turn wears (`bot`, `enclosed`), and every session the rail's stacked bots
  (`bots`). Bots are computed on this machine from the real ids with the app's own identity code, moved to
  `contract/src/bots.ts` (the app's `state/outline.ts` re-exports it); only bot names leave. The functions are locked to
  the baseline outline's answers by frozen golden vectors (`contract/src/bots_golden.ts`).
- **A task**: a link made with `include_task_sessions` shows every session of the session's task that is not deleted
  (`sessions.task_root_id` relation only, any project), in the rail's order (the task's first session, then the others by
  latest activity). The task is fixed when the link is made (`share_links.task_root_id`, schema v35).

### Links

- Owner routes, owner-only exactly as v1: `POST` / `GET /api/sessions/:id/share-links/v2`,
  `POST /api/share-links/:id/v2/reveal`, `POST /api/share-links/:id/v2/revoke`. The v1 routes keep their shapes (a v2
  link appears in a v1 list with v1's fields).
- `share_links.protocol` (schema v35, 1 for every older row) selects the capability's HMAC domain:
  `"oasis-code live share v2\0" ‖ id` for protocol 2; v1's domain is unchanged, and a capability of one protocol never
  verifies as the other's. `options_json` keeps v1's three keys only.
- **Deletion.** A link of one session (v1 or v2) is revoked with the session, as before. A task link is NOT ended by
  the deletion of the session it was made from or of the task's first session: the deleted session leaves the view at
  once (not on the next poll). When no session of the task is left, the task's links are revoked
  (`session_deleted`). A task link stays the person's to list, reveal and revoke whatever became of the session it was
  made from. Revocation and expiry end the whole view.

### Parts, projections and the budget

- **Part** = one session × canonical options, projected (in the worker, one part per request) into the session's
  piece of a v2 state. A part carries no key of a frame's, so its bytes are the same in every frame: a v2 link of the
  session alone and a link of its task share ONE part.
- **Projection** = one per (scope × canonical options), `session:<id>` or `task:<task root>`; links of one task made from
  different sessions share one projection, whose output does not depend on which link connected first (`current` is the
  task's first session while not deleted, else the first session listed). Each link's own starting session is the
  per-viewer `start` in the frame's head.
- **Budget.** `max_projections` (8) now counts v1 producers plus distinct v2 parts (a part shared by several projections
  counts once). A new connection that would need more is answered `503 busy` and nothing is made. A task that grows past
  the budget while watched is never shown with a session missing: its streams end with `ended{reason:"busy"}` (v2 only,
  not permanent: the viewer retries), the projection and the parts only it used are let go.
- **Bytes.** A part is at most `max_part_bytes` = floor((16 MiB − 64 KiB) / 8) = 2 088 960 bytes, whatever frame it is
  in; a frame's own fields at most 64 KiB; so a frame (at most 8 parts) stays within 16 MiB. A part past its bound
  drops its latest items (`stats.items_truncated`), then its card's last rows (`team.truncated`); a part that does not
  fit even so is refused: every projection showing it ends `busy`, and the session is refused at once (no build) until
  its records change — never rebuilt in a loop.
- **Coalescing**, per part, as v1's producer: dirtied by the run hub and the session's 2 s fingerprint, a build about
  400 ms after a change and never sooner than max(1 s, 5 × the last build's cost, the failure back-off) after the last,
  one at a time; an unchanged part hash changes no frame, an unchanged frame hash is no revision.

### What is never sent

- **Not every session ready**: a frame is put together only when every session shown has its part; while a new
  session's part is built, nobody — a viewer already there or a new one — gets a state.
- **A session that left**: when the set of sessions changes, the cached frame is dropped, no pending frame of the old
  set is released, and a viewer that still has a removed session's bytes queued is cut (its client reconnects). Every
  send and every pending release reads the set again first.
- **A part sanitized under stale folders**: each session's sanitizer knows the folders of every session of its task (a
  member's words naming another member's project folder are masked). A part records the task folders' key it was made
  under; a part whose key no longer matches (another project's session joined, a root changed) is dropped with every
  frame made of it — the task's and any one-session link sharing it — and built again before anything is sent; a build
  during which the key changed is discarded.
- **Another spelling of a known folder**: the sanitizer (every version, offline and live) matches each folder it knows
  — a project's, a workspace's, a root, the data folder, a home — under both of macOS's spellings of the system's
  temporary and variable folders (`/tmp` ↔ `/private/tmp`, `/var` ↔ `/private/var`, `/etc` ↔ `/private/etc`), in both
  directions: the app stores a folder by its real path while words name it either way (`share/path_alias.ts`). Only
  known folders are matched, at a path boundary, without a filesystem lookup; other absolute paths are left as written.
- **Pictures** are served only for a resource of the projection's current frame, of a session it still shows and that
  is not deleted, checked before and after the bytes are read. A v2 resource id is bound to its session
  (`oasis-code live image v2\0<session>\0<asset>\0<digest>` under the part's salt); a v1 link never serves one.

## Setting it up

The listener is configured in the app under **Settings > Connections > Live sharing**. Nothing here was set up in
Cloudflare or on a real LAN while building this feature; these are the steps a person follows.

### Through a Cloudflare named tunnel (recommended for anyone outside your network)

1. In **Live sharing**, turn it on with bind **loopback** (`127.0.0.1`), port `8325`, and the public URL set to the
   tunnel's hostname, for example `https://share.example.com`.
2. In Cloudflare, give a named tunnel a **dedicated** public hostname whose service is `http://127.0.0.1:8325`, and end
   the tunnel's ingress rules with a catch-all `http_status:404`. Never route this hostname to the app's port (8321) or
   to the gateway (8324), and never reuse the gateway's hostname.
3. To restrict who can open links, configure Cloudflare Access yourself: add a self-hosted application for that
   hostname with an Allow policy for specific emails (one-time PIN login), and turn on **Protect with Access** for the
   hostname
   (<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/>).
   The capability is still required on top of Access.
4. Make a link in the session's Share dialog and copy it: `https://share.example.com/live/#<capability>`.

### On a local network

1. In **Live sharing**, choose bind **lan** explicitly; this listens on `0.0.0.0`, every interface.
2. Set the public URL to this machine's LAN address and the port, for example `http://192.0.2.20:8325`. That address is
   a documentation placeholder: replace it with your machine's actual LAN IP.
3. This is plain HTTP: the session's contents and the capability travel unencrypted on that network.
4. While bind is `lan`, the listener is also reachable directly on the network, so a Cloudflare Access policy in front
   of a tunnel hostname does not protect it. Anyone on the LAN who holds a link's capability can open it.

## What is not promised

- Redaction of free prose is best-effort, as in the offline share: a secret in an unknown shape, encoded, or inside an
  image is not promised to be found.
- The listener has no rate limit beyond its viewer and projection bounds. A public hostname should sit behind the
  tunnel provider's own protections; Cloudflare Access can be put in front of a named tunnel.
- The live view shows what the projection shows, at most every second or so; it is not a replay of the run.
