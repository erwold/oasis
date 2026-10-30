/** The one sensitive-source classifier (src/share/sensitive.ts) a share snapshot uses for an agent's tool call and for
 *  a connector's or the person's command alike: what it withholds, and ordinary commands it leaves alone. A finite,
 *  conservative reading of the words — never a shell evaluator. Synthetic commands only. */

import { expect, test } from 'bun:test'
import { sensitiveTool } from '../src/share/sensitive.ts'

// a synthetic user's name, put into its home path at run time: the committed source holds no literal home path for the
// repository's privacy scan to find (scripts/oss/lib/scan.mjs)
const SYNTH = 'synth'

const bash = (command: string, cwd: string | null = null) => sensitiveTool('bash', { command, cwd })

test('environment dumps: bare, through a prefix or a shell -c, assignment-only env, any variable printed', () => {
  for (const c of [
    'env', 'set', 'export', 'export -p', 'declare -x', 'compgen -v', 'printenv', 'printenv HOME', '/usr/bin/env -0 | sort', 'env --null | sort -z',
    'sudo env', 'sudo -E env | sort', 'command env', 'exec set', 'nohup env > out.txt', 'time env',
    // assignment-only env (no program: it prints the environment), and assignments before it
    'env SHARE_TEST=ordinary', 'env -i foo=bar', 'env -i', 'env -u PATH X=1 > out.txt', "env A='x y' B=\"z\"", 'SHARE_TEST=1 env', 'A=1 B=2 /usr/bin/env', 'FOO="a b" env | sort', 'ls; env FOO=1',
    "sh -c 'env'", 'bash -lc "printenv | sort"', "zsh -c 'set'", "/bin/sh -c 'env FOO=1'", 'sh -c "export"',
    'echo $HOME', 'echo $my_custom_var', 'echo "${lower_name}"', 'print $f', "printf '%s\\n' \"$custom_lower\"", 'printf "%s" "${AWS_PROFILE}"', "printf '%s' $Mixed_Case",
    'node -e "console.log(process.env)"', "node -e \"console.log(process['env'])\"", 'bun -e "Bun[\'env\']"', 'python -c "import os; print(os.environ)"', 'cat /proc/self/environ',
  ]) expect([c, bash(c)]).toEqual([c, true])
})

test('credential sources: files, quoted / escaped fragments of their names, a credential folder as cwd', () => {
  for (const c of ['cat .env', 'cat ".env.local"', "cat '.env'", 'cat .e"nv"', "cat '.en'v", 'cat .en\\v', 'cat .e\\n\\v', 'cat ~/.aws/credentials', 'cat id_rsa', 'gh auth token'])
    expect([c, bash(c)]).toEqual([c, true])
  expect(bash('cat config', `/home/${SYNTH}/.aws`)).toBe(true)
  expect(bash('ls', `/home/${SYNTH}/.ssh`)).toBe(true)
})

test('ordinary commands stay ordinary: env running a program, set options, assignments, plain words', () => {
  for (const c of [
    'env FOO=1 bun run build', 'env -i PATH=/usr/bin make', 'FOO=1 bun test', 'export FOO=bar', 'set -e; make', 'set -euo pipefail', 'git status', 'ls -la',
    'echo done', 'echo "no variables here"', 'printf "plain\\n"', 'git commit -m "set things"', 'grep -r environment src', 'cat config', 'npm run envoy',
    "sh -c 'make test'", 'echo $?', 'echo $1',
  ]) expect([c, bash(c)]).toEqual([c, false])
  expect(bash('ls', `/home/${SYNTH}/project`)).toBe(false)
})

test('env ended by `--` with no program dumps the environment; with a program after it, it runs that program', () => {
  for (const c of ['env --', 'env FOO=1 --', 'env -u TOKEN --', 'env -i --', 'env -- | sort', '/usr/bin/env -0 -- > dump.txt', 'X=1 env --'])
    expect([c, bash(c)]).toEqual([c, true])
  for (const c of ['env -- bun run build', 'env FOO=1 -- bun run build', 'env -u TOKEN -- make', 'env -i -- /bin/true'])
    expect([c, bash(c)]).toEqual([c, false])
})

test('assignment values read as the shell joins them: quoted and unquoted fragments, escapes, a quote left open', () => {
  // no program after them: the environment is printed (a fragment joined to another is one value, never a program)
  for (const c of [
    "env A=a'b'", 'env A="x"y', 'env A=x"y z"', `env A='x'"y"z B=1`, 'env A=a\\ b', 'env A=\\"x\\"', 'env A="x\\"y"', "env A='a b'c'd e'",
    `A=1 B='two words' C="x"'y' env`, "env A=x'y z' | sort", 'env A="x y"z > out.txt', 'env A="open quote', "env A='open quote", 'env A=x\\',
  ]) expect([c, bash(c)]).toEqual([c, true])
  // the same values with a program after them: it runs the program
  for (const c of [
    "env A=a'b' bun run build", 'env A="x"y make', 'env A=x"y z" make', `env A='x'"y"z B=1 make`, 'env A=a\\ b make', 'env A="x\\" y" make',
    "env A='a b'c'd e' make", `A=1 B='two words' C="x"'y' make`, 'FOO="a;b" bun test',
  ]) expect([c, bash(c)]).toEqual([c, false])
  // quotes span lines and a backslash continues one, as in the shell
  for (const c of ["V0='\n' env", 'env A="line one\nline two"', 'A=x\\\ny env', "env A='a\nb' B=\"c\nd\"\n"]) expect([c, bash(c)]).toEqual([c, true])
  for (const c of ['env A="a\nb" make', "A='x\ny' bun run build"]) expect([c, bash(c)]).toEqual([c, false])
  // a quote never closed: the value runs to the end of the command — an env with nothing after it dumps; a command the
  // shell refuses to run at all (its open quote swallows the rest) prints nothing
  expect(bash("env A='open quote then words")).toBe(true)
  expect(bash("V0=' V1= V2= env")).toBe(false)
})

test('long lists of quoted assignments are read in linear time, with or without a program, and a dump after them is still found', () => {
  const list = (n: number, v: string) => Array.from({ length: n }, (_, i) => `A${i}=${v}`).join(' ')
  const timed = (c: string) => { const t = performance.now(); const r = bash(c); return { r, ms: performance.now() - t } }
  for (const v of ["'x'", '"x"', `a'b'"c"d`, "'x y'", '"x\\"y"']) {
    for (const n of [24, 64, 512]) {
      // a backtracking blow-up was ~1 s per command from 24 assignments on (and the engine then gave up: no match)
      const program = timed(`env ${list(n, v)} bun run build`)
      expect([n, v, program.r]).toEqual([n, v, false])
      expect(program.ms).toBeLessThan(250)
      expect(timed(`${list(n, v)} bun run build`).r).toBe(false)
      expect(bash(`env ${list(n, v)}`)).toBe(true)
      expect(bash(`${list(n, v)} env`)).toBe(true)
      // the dump after a long harmless command: found (before, the engine's backtracking budget ran out and missed it)
      const after = timed(`env ${list(n, v)} bun run build; env`)
      expect([n, v, after.r]).toEqual([n, v, true])
      expect(after.ms).toBeLessThan(250)
      expect(bash(`${list(n, v)} make; set`)).toBe(true)
    }
  }
})

test('ANSI-C quoted values ($\'…\', backslash escapes inside) end where the shell ends them: no dump hidden behind one', () => {
  for (const c of [
    "A=$'x\\'y' env", "env A=$'x\\'y'", "A=$'\\'' env", "env A=$'it\\'s' B=$'q'", "env A=$'a\\\\'b", `A=x$'y'"z"$HOME env`,
    "A=$'line\\nnext' env", "A=$'two\nlines' env", "env A=$'open", 'env A=$HOME', `env A=$"t" B=$'q'`, 'A=$ env', "env A=$'x\\'y' | sort",
  ]) expect([c, bash(c)]).toEqual([c, true])
  for (const c of [
    "A=$'x\\'y' make", "env A=$'x\\'y z' bun run build", "A=$'a\\\\' make", `A=x$'y'"z"$HOME make`, "A=$'two\nlines' make",
    'env A=$HOME make', `env A=$"t" B=$'q' make`, 'A=x$ make',
  ]) expect([c, bash(c)]).toEqual([c, false])
  const list = (n: number) => Array.from({ length: n }, (_, i) => `A${i}=$'x\\'y'`).join(' ')
  for (const n of [24, 64, 512]) {
    const t = performance.now()
    expect([n, bash(`env ${list(n)} bun run build`)]).toEqual([n, false])
    expect([n, bash(`env ${list(n)} bun run build; env`)]).toEqual([n, true])
    expect([n, bash(`${list(n)} env`)]).toEqual([n, true])
    expect([n, bash(`env ${list(n)}`)]).toEqual([n, true])
    expect(performance.now() - t).toBeLessThan(250)
  }
})
