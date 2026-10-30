/** Test-only remote `python` wrapper: injects fixture code into the adapter source, then STREAMS the
 * rest of stdin to the real interpreter. A persistent exec channel never sends EOF between requests,
 * so a wrapper that buffers stdin to EOF would stall it; this one works for per-request and
 * persistent channels alike. Each adapter launch appends `<pid>` to `<pidLog>` (fixture evidence
 * for cleanup checks). Non-adapter invocations (the exec challenge) exec python directly. */
import { writeFileSync } from 'node:fs'
export function streamingPythonWrapper(wrapper: string, injection: string, pidLog: string, baseline = ''): string {
  const script = wrapper + '.py'
  writeFileSync(script, `import os, sys, subprocess
injection = ${JSON.stringify(injection)}
baseline = ${JSON.stringify(baseline)}
args = [sys.executable] + sys.argv[1:]
if '-u' not in sys.argv[1:]:
    os.execv(sys.executable, args)
inp = sys.stdin.buffer
head = inp.readline()
if not head:
    sys.exit(subprocess.run(args, stdin=subprocess.DEVNULL).returncode)
n = int(head)
source = inp.read(n).decode()
if baseline:
    with open(baseline) as f:
        source = f.read()
source = source.replace("if __name__ == '__main__':", injection + "\\nif __name__ == '__main__':", 1).encode()
child = subprocess.Popen(args, stdin=subprocess.PIPE)
with open(${JSON.stringify(pidLog)}, 'a') as log:
    log.write(str(child.pid) + '\\n')
try:
    child.stdin.write(str(len(source)).encode() + b'\\n' + source)
    child.stdin.flush()
    while True:
        chunk = inp.read1(65536)
        if not chunk:
            break
        child.stdin.write(chunk)
        child.stdin.flush()
except BrokenPipeError:
    pass
finally:
    try:
        child.stdin.close()
    except BrokenPipeError:
        pass
sys.exit(child.wait())
`, { mode: 0o600 })
  writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/python3 -B -I '${script}' "$@"\n`, { mode: 0o700 })
  return wrapper
}
