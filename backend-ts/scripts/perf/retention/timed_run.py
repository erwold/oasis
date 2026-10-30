#!/usr/bin/env python3
"""timed_run.py <record_file> <cwd> <stdout_file> <stderr_file> -- cmd...
Runs cmd once (env inherited from the caller) and appends to record_file: start/end UTC, the monotonic elapsed of
that one subprocess (both readings taken in this process, around subprocess.run), and its actual return code.
Exits with that return code (a signal-killed child: 128 + signal)."""
import datetime, subprocess, sys, time

record, cwd, out_path, err_path = sys.argv[1:5]
assert sys.argv[5] == '--'
cmd = sys.argv[6:]
utc = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')
with open(out_path, 'wb') as out, open(err_path, 'wb') as err:
    start = utc()
    t0 = time.monotonic_ns()
    proc = subprocess.run(cmd, cwd=cwd, stdout=out, stderr=err)
    t1 = time.monotonic_ns()
    end = utc()
code = proc.returncode if proc.returncode >= 0 else 128 - proc.returncode
with open(record, 'a') as f:
    f.write(f'start_utc={start}\nend_utc={end}\nmonotonic_elapsed_ns={t1 - t0}\n'
            f'elapsed_basis=time.monotonic_ns() around subprocess.run in one python process (includes bun process spawn and exit)\n'
            f'returncode_raw={proc.returncode}\nexit={code}\n')
sys.exit(code)
