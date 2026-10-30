#!/usr/bin/env bash
# freeze_check.sh <clone>: director.v1..v6.json byte-identical to baseline f5bd7dc; v7 (if any) reported; git diff of v1-v6 empty.
set -euo pipefail
R=${1:?clone}; S=$R/backend-ts/src/director/surfaces
cat >"${TMPDIR:-/tmp}/qa-freeze.expected" <<'EOF'
8ec11fb06f389624c98cdc13e87c019bf4902a6098cbe270855ab4c3df4dd1e0  director.v1.json
221781d2b46fa9f421a64931c282d3bc93b833400b4d83750b9519d5d076001d  director.v2.json
6678d3c214e8e8cbedd0202d68e62966b32f46f6789e92f283618a5e380616f3  director.v3.json
40c44e20eeba5a278a55b0ad76430b69fb91bcef299000f40b7d95d4e331787f  director.v4.json
a8cced986b19254c6fc7838c1d010771d9645a8208de8a766e4430f34cd8d7ab  director.v5.json
e00773497bccb513a2c1a52453de2a996a24c146dbdca3f8b51faecf9d855fea  director.v6.json
EOF
(cd "$S" && shasum -a 256 -c "${TMPDIR:-/tmp}/qa-freeze.expected")
git -C "$R" diff --exit-code --stat f5bd7dc14cd7637ee120648fc917a3cc6fd9da7e -- $(for v in 1 2 3 4 5 6; do echo backend-ts/src/director/surfaces/director.v$v.json; done) && echo "v1-v6: no git diff vs baseline"
ls "$S"/director.v7.json 2>/dev/null && { echo "v7 present: must be produced twice by scripts/director_surface_snapshot.ts identically and checked by test_director_surface_freeze"; } || echo "no v7 (tool descriptions must then be unchanged)"
