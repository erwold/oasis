#!/usr/bin/env python3
"""The summary of a FileJournal grouping A/B (journal_grouping_ab.sh): per scale, scenario and read, the median over
the paired rounds of each side's p50 (and p95), the range of the p50s, and base/fix. The undo counts must be the same
on both sides in every round (the same work was timed), or the summary says MISMATCH. Aggregates only: labels of the
bench's own scenarios and numbers; writes summary.json beside the runs and prints the Markdown table."""

import argparse
import json
import os
import re
import statistics
import sys

READS = ["runChanges", "folderChanges", "status", "diff"]


def load(out):
    runs = []
    root = os.path.join(out, "journal")
    for scale in sorted(os.listdir(root)):
        for d in sorted(os.listdir(os.path.join(root, scale))):
            m = re.fullmatch(r"r(\d+)-(base|fix)", d)
            if not m:
                continue
            with open(os.path.join(root, scale, d, f"file_journal_bench_{scale}.json")) as f:
                runs.append({"scale": scale, "round": int(m.group(1)), "side": m.group(2), "result": json.load(f)})
    return runs


def key(sc):
    return f"{sc['scenario']} {sc['writes']}x{sc['file_bytes']}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    out = ap.parse_args().out
    runs = load(out)
    table = {}
    undo_counts = {}
    for r in runs:
        for sc in r["result"]["scenarios"]:
            if "skipped" in sc:
                continue
            k = (r["scale"], key(sc))
            for read in READS:
                for q in ("p50", "p95"):
                    table.setdefault(k + (read, q), {"base": [], "fix": []})[r["side"]].append(sc[read]["ms"][q])
            table.setdefault(k + ("undoRun", "once"), {"base": [], "fix": []})[r["side"]].append(sc["undoRun"]["ms"])
            table.setdefault(k + ("write", "p50"), {"base": [], "fix": []})[r["side"]].append(sc["write_ms"]["p50"])
            counts = (sc["undoRun"]["restored"], sc["undoRun"]["removed"], sc["undoRun"]["conflicts"])
            undo_counts.setdefault(k, set()).add(counts)
    summary = []
    for (scale, scenario, read, q), sides in sorted(table.items()):
        b, f = sides["base"], sides["fix"]
        if not b or not f:
            continue
        mb, mf = statistics.median(b), statistics.median(f)
        summary.append({
            "scale": scale, "scenario": scenario, "read": read, "stat": q, "rounds": min(len(b), len(f)),
            "base_median": round(mb, 3), "base_min": round(min(b), 3), "base_max": round(max(b), 3),
            "fix_median": round(mf, 3), "fix_min": round(min(f), 3), "fix_max": round(max(f), 3),
            "base_over_fix": round(mb / mf, 2) if mf > 0 else None,
        })
    mismatch = {f"{s} {k}": sorted(list(c)) for (s, k), c in undo_counts.items() if len(c) != 1}
    with open(os.path.join(out, "summary.json"), "w") as fh:
        json.dump({"rows": summary, "undo_count_mismatch": mismatch}, fh, indent=2)
        fh.write("\n")
    print("| scale | scenario | read | stat | rounds | base median (min–max) ms | fix median (min–max) ms | base/fix |")
    print("|---|---|---|---|---|---|---|---|")
    for s in summary:
        print(f"| {s['scale']} | {s['scenario']} | {s['read']} | {s['stat']} | {s['rounds']} | {s['base_median']} ({s['base_min']}–{s['base_max']}) | {s['fix_median']} ({s['fix_min']}–{s['fix_max']}) | {s['base_over_fix']} |")
    print()
    print("undo counts (restored, removed, conflicts) the same on both sides in every round: " + ("yes" if not mismatch else f"MISMATCH {mismatch}"))
    return 1 if mismatch else 0


if __name__ == "__main__":
    sys.exit(main())
