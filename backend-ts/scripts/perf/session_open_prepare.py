#!/usr/bin/env python3
"""Create a fresh private evidence root using SQLite mode=ro + consistent backup.
No permission changes, source writes, app recovery, asset copying or service startup.
Migrate this COPY separately with the chosen build before starting session_open_server.ts.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import time
from urllib.parse import quote

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True, help='authorized frozen SQLite database')
parser.add_argument('--root', required=True, help='new private temporary evidence directory')
args = parser.parse_args()
os.umask(0o077)
source, root = Path(args.source).resolve(strict=True), Path(args.root).resolve()
if root.exists():
    raise SystemExit('refuse an existing evidence root')
if source == root / 'data' / 'index.db':
    raise SystemExit('source must not be the destination')
for directory in ['data', 'home', 'logs', 'traces']:
    (root / directory).mkdir(parents=True, exist_ok=True)
start = time.monotonic()
with sqlite3.connect('file:' + quote(str(source)) + '?mode=ro', uri=True) as src:
    src.execute('PRAGMA query_only=ON')
    with sqlite3.connect(root / 'data' / 'index.db') as dst:
        src.backup(dst)
        schema = dst.execute('PRAGMA user_version').fetchone()[0]
        runs = dst.execute('SELECT count(*) FROM runs').fetchone()[0]
(root / '.benchmark-copy').write_text('SQLite mode=ro consistent backup; source is not benchmark data\n')
result = {'schema': schema, 'runs': runs, 'backup_ms': (time.monotonic() - start) * 1000,
          'copy_bytes': (root / 'data' / 'index.db').stat().st_size}
(root / 'logs' / 'prepare.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
