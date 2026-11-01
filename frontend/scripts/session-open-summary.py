#!/usr/bin/env python3
"""Summarize private session-open-bench logs without copying ids, content, URLs or trace payload into reports.
Usage: python3 session-open-summary.py EVIDENCE_ROOT PREFIX
Raw timing values, medians and ranges remain together; 0 in thresholded observer fields means no observation,
NOT a zero-length stall. Exact renderer RunTask maxima are read separately from the already saved traces.
"""
import json
from pathlib import Path
import statistics
import sys

root, prefix = Path(sys.argv[1]), sys.argv[2]
rows = []
for side in ['before', 'after']:
    for path in sorted((root / side / 'logs').glob(prefix + '-*.json')):
        value = json.loads(path.read_text())
        if not isinstance(value, dict) or 'click' not in value or 'tailPaint' not in value:
            continue
        x = value
        start, end = x['click'], x['end']
        group = 'paired' if '-paired-' in path.name else 'shared'
        tasks = [t['duration'] for t in x['long'] if t['start'] <= end and t['start'] + t['duration'] >= start]
        gaps = [g['duration'] for g in x['rafGaps'] if start <= g['at'] <= end]
        resources = x['resources']
        trace_path = root / side / 'traces' / path.name
        trace_max, trace_cpu_max = None, None
        if trace_path.exists():
            trace = json.loads(trace_path.read_text())['traceEvents']
            click = next(e for e in trace if e['name'] == 'bench-click')
            boundary = click['ts'] + (end - start) * 1000
            run_tasks = [e for e in trace if e['name'] == 'RunTask' and e.get('pid') == click['pid'] and e.get('tid') == click['tid']
                         and e.get('ph') == 'X' and e['ts'] <= boundary and e['ts'] + e.get('dur', 0) >= click['ts']]
            trace_max = max((e.get('dur', 0) / 1000 for e in run_tasks), default=0)
            trace_cpu_max = max((e.get('tdur', 0) / 1000 for e in run_tasks), default=0)
        rows.append({'side': side, 'group': group, 'label': x['label'], 'mode': x['mode'],
                     'tail_ms': x['tailPaint'] - start, 'body_dom_ms': x['content'] - start, 'body_raf_ms': x['contentPaint'] - start,
                     'stable_ms': max(x['lastMutation'], x['lastLong'], x['lastResource'], x['contentPaint'], x['tailPaint']) - start,
                     'quiet_confirmed_ms': end - start, 'longtask_over50_max_ms': max(tasks, default=0),
                     'frame_gap_over50_max_ms': max(gaps, default=0), 'renderer_task_max_ms': trace_max, 'renderer_cpu_task_max_ms': trace_cpu_max,
                     'requests': len(x['requests']), 'transcript_requests': sum(r['path'].endswith('/transcript') for r in x['requests']),
                     'transfer_bytes': sum(r['transfer'] for r in resources), 'encoded_bytes': sum(r['encoded'] for r in resources),
                     'decoded_bytes': sum(r['decoded'] for r in resources),
                     'http_body_bytes': sum(r.get('sizes', {}).get('responseBodySize', 0) for r in x['requests']),
                     'pending_at_end': x['pendingAtEnd'], 'tail_proof': x['tailProof'], 'stable_tail_proof': x['stableTailProof']})
summary = []
for key in sorted({(x['group'], x['label'], x['mode'], x['side']) for x in rows}):
    selected = [x for x in rows if (x['group'], x['label'], x['mode'], x['side']) == key]
    metrics = {}
    for name, value in selected[0].items():
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            values = [x[name] for x in selected]
            metrics[name] = {'raw': values, 'median': statistics.median(values), 'min': min(values), 'max': max(values)}
    summary.append({'group': key[0], 'label': key[1], 'mode': key[2], 'side': key[3], 'n': len(selected), 'metrics': metrics})
result = {'prefix': prefix, 'cases': len(rows), 'summary': summary, 'rows': rows}
(root / (prefix + '-summary.json')).write_text(json.dumps(result, indent=2))
for s in summary:
    m = s['metrics']
    print(s['group'], s['label'], s['mode'], s['side'], 'tail', round(m['tail_ms']['median'], 1),
          'range', [round(m['tail_ms'][k], 1) for k in ['min', 'max']], 'stable', round(m['stable_ms']['median'], 1),
          'task_max', round(m['renderer_task_max_ms']['max'], 1), 'requests', m['requests']['raw'])
