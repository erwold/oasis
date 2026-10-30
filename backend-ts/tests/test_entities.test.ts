/** What a person can point at: the workspace's files and the definitions in them for the @ picker, and the mention
 *  tokens a message carries. */

import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findEntities, mentionTokens, resolveMentions, symbolsOf } from '../src/workspace/entities.ts'
import { PathPolicy } from '../src/workspace/paths.ts'
import { pyDefinitions } from '../src/workspace/pysyntax.ts'
import { tempDir } from './helpers.ts'

test('symbols and the fuzzy query', () => {
  const py = 'class Calc:\n    def add(self, a, b):\n        return a + b\n\n\ndef helper():\n    pass\n'
  expect(symbolsOf('calc.py', py).map((s) => [s.name, s.line])).toEqual([['Calc', 1], ['Calc.add', 2], ['helper', 6]])
  const ts = 'export function loadRows(id: string) {\n}\n\nexport class Store {}\n'
  expect(symbolsOf('api.ts', ts).map((s) => [s.name, s.line])).toEqual([['loadRows', 1], ['Store', 4]])
  expect(symbolsOf('broken.py', 'def (:\n')).toEqual([])
  const root = tempDir()
  writeFileSync(join(root, 'calc.py'), py)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'api.ts'), ts)
  const files = ['calc.py', 'src/api.ts', 'test_calc.py', 'README.md']
  const found = findEntities(files, root, 'calc')
  expect(found.paths.slice(0, 2)).toEqual(['calc.py', 'test_calc.py'])
  expect(findEntities(files, root, 'add').symbols[0]!.name).toBe('Calc.add')
  expect(findEntities(files, root, 'src::load').symbols.map((s) => s.name)).toEqual(['loadRows'])
  expect([...findEntities(files, root, '').paths].sort()).toEqual([...files].sort())
  expect(findEntities(files, root, '').symbols).toEqual([])
  expect(findEntities(files, root, 'zzz').paths).toEqual([])
  expect(mentionTokens('fix @calc.py::add and see @src/api.ts, not @someone or e@mail.com').map((m) => [m.path, m.symbol])).toEqual([
    ['calc.py', 'add'], ['src/api.ts', null]])
  // mentions are resolved through the policy and pinned by sha256; one that does not resolve is no mention (its words
  // stay text: pasted notes say "@400/500" or "@torch.no_grad"), and never refuses the message
  const policy = PathPolicy.forWorkspace(root)
  const resolved = resolveMentions(policy, [{ path: 'calc.py', symbol: 'add' }, { path: 'src/api.ts' }])
  expect(resolved[0]).toMatchObject({ path: 'calc.py', symbol: 'Calc.add', line: 2 })
  expect(resolved[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
  const stray = [{ path: '../etc/passwd' }, { path: 'nope.py' }, { path: 'calc.py', symbol: 'divide' }, { path: '400/500/1000' }, { path: 'torch.no_grad' }]
  expect(resolveMentions(policy, [...stray, { path: 'src/api.ts' }]).map((m) => m.path)).toEqual(['src/api.ts'])
})

test('the Python reader follows nesting, decorators, annotations and multi-line headers', () => {
  const text = `import x

@dataclass(frozen=True)
class Point(Base, metaclass=Meta):
    x: int = 0

    @property
    def norm(self) -> float:
        return (self.x ** 2) ** 0.5

    async def fetch(
        self,
        url: str,
        *,
        retries: int = 3,
    ) -> "Point":
        async def inner():
            pass
        return self


def top(a, b=1, *args, c: int = 2, **kw) -> None: pass
`
  const defs = pyDefinitions(text)
  expect(defs.map((d) => [d.name, d.kind, d.line])).toEqual([
    ['Point', 'class', 4], ['Point.norm', 'function', 8], ['Point.fetch', 'function', 11], ['Point.fetch.inner', 'function', 17], ['top', 'function', 22],
  ])
  expect(defs[0]!.signature).toBe('@dataclass(frozen=True) class Point(Base, metaclass=Meta)')
  expect(defs[1]!.signature).toBe('@property def norm(self) -> float')
  expect(defs[2]!.signature).toBe("async def fetch(self, url: str, *, retries: int = 3) -> 'Point'".replace("'Point'", '"Point"'))
  expect(defs[4]!.signature).toBe('def top(a, b=1, *args, c: int = 2, **kw) -> None')
  expect(defs[1]!.source).toBe('    def norm(self) -> float:\n        return (self.x ** 2) ** 0.5')
  expect(defs[0]!.source.endsWith('        return self')).toBe(true)
  expect(() => pyDefinitions('def broken(:\n')).toThrow()
  expect(() => pyDefinitions('class :\n')).toThrow()
})
