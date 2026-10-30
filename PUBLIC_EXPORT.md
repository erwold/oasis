# Public export

How a public copy of this repository is made, and what is checked first. Everything here runs locally, reads only
committed git objects, and never pushes, creates a remote or touches the network.

## The three tools

| Tool | What it does |
|---|---|
| `node scripts/oss/scan-secrets.mjs --snapshot REV` | Scans every file of one commit for likely secrets and privacy markers. |
| `node scripts/oss/scan-secrets.mjs --history REV` | Scans every version of every file reachable from REV, plus commit authors and messages. A finding shows whether it is still in the snapshot or in history only. |
| `node scripts/oss/export-public.mjs --commit REV` | Plans a history-less public tree from that commit. Dry run by default. |

Findings name the rule, path, line, blob, commit and a redacted shape (first characters and length), never the value.
Keep reports outside the repository (`--report /somewhere/else/report.json`); they name paths and commits.

`--markers FILE` (both tools) takes a local file of private literals (your user name, real names, private host names),
one per line. Matches are reported as `marker #N`. Keep that file outside the repository.

## What the export takes

The policy is `scripts/oss/public-export.json`, **read from the commit being exported** (an uncommitted edit has no
effect; the report records the policy blob's sha256). Review a change to it like code.

- Only committed files of the named commit: no working tree, no untracked files, no `.git`, no history, no authors,
  no remotes.
- Only paths in `include`. `docs/` is never taken wholesale: each public document and each test data file under
  `docs/` is named.
- Media files (images, fonts) only as exact entries with the sha256 of the reviewed content. A new or changed media
  file is left out, or fails the export, until it is reviewed and listed. Any other binary file fails the export.
  The listed media have had a privacy review of exactly that content (metadata and text in the images, animation
  frames included); nobody needs to look through them again unless a file changes. This is a privacy check, not a
  statement about rights: where third-party names and logos appear, they are attributed in `NOTICE`. (An entry can
  also be marked `pending-owner-review`; it is exported and counted in the report.)
- Never: `node_modules/`, `dist/`, `.env*` (except `.env.example`), `.claude/`, `.oasis-code/`, runtime data,
  `reports/`, logs, databases, archives, signing material; internal QA tools that depend on private machines or on
  data that is not exported (listed under `exclude`).

## What stops the export

- A likely secret, or a privacy marker, not covered by an exact reviewed entry in `allow` (path + rule + sha256 of
  the file; folder-wide or hash-less entries are refused). Today there are two: the throwaway TLS key of the
  pinned-certificate tests, and the authors' e-mail addresses inside the license texts of `THIRD_PARTY_NOTICES.md`
  (regenerating that file changes its hash, so the entry must be reviewed again).
- An exported file that depends on a file the export leaves out: a module import, a quoted path, a data file, a
  relative Markdown link (or a Markdown link to nothing).
- A required file missing (`LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, the license texts, package files and locks).
- A symbolic link, gitlink, unsafe path or case collision anywhere in the commit's tree.

Every git call runs with an isolated environment (ambient `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
`GIT_CONFIG_*` and global / system configuration are ignored; no hooks, no signing).

## Making a local candidate

```sh
node scripts/oss/export-public.mjs --commit <full-sha> --report /tmp/export-report.json          # dry run
node scripts/oss/export-public.mjs --commit <full-sha> --write --out /path/to/new-folder \
  --report /tmp/export-report.json                                                                # write
# optional: make it a fresh local repository (no remote); add --git-author to make one root commit
node scripts/oss/export-public.mjs --commit <full-sha> --write --out /path/to/new-folder --git-init \
  --git-author "Name <email>"
```

`--out` must not exist yet and must lie outside the source repository; the report must not land inside it. Nothing is
overwritten or removed. Each written file is read back and compared with its committed blob.

Where and how the candidate is published (a new repository, its name, its visibility, whether any history is kept)
is the owner's decision; the tools do not make it.

## Third-party notices

`THIRD_PARTY_NOTICES.md` is generated from the lock files, the installed packages and the real build inputs:

```sh
node scripts/oss/notices.mjs --work-dir /tmp/new-folder --write   # regenerate
node scripts/oss/notices.mjs --work-dir /tmp/new-folder --check   # CI: fails when out of date
```

Material kept in the repository itself (Lucide icons, the Fraunces and KaTeX fonts, beautiful-ui) is listed in
`NOTICE`, with license texts under `licenses/`. A packaged desktop app carries `LICENSE`, `NOTICE`,
`THIRD_PARTY_NOTICES.md`, `licenses/` and Electron's own license files under `Resources/licenses/`; the packaging hook
(`desktop/scripts/verify_pack.js`) fails the build when one is missing.

## What is left to the owner

Two things only, both outside these tools:

- **Where the code goes public:** making the existing repository public (its full history comes with it) or a clean
  new repository started from an exported candidate. The history scan (`--history`) shows what older commits contain;
  for this repository it finds personal paths, contributor identities and internal machine details in history, so a
  clean new repository is the recommended route.
- **The publishing itself:** creating the repository, its name and visibility, and pushing. The tools never do any
  of this.
