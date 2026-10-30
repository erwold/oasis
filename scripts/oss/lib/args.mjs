// A strict command-line reader shared by the scripts under scripts/oss: an unknown option, a missing value, a value that is
// itself an option, a repeated option or a stray word is an error with its own message — never silently ignored.

export class UsageError extends Error {}

/** argv -> { flags: Set, values: { name: string } }. `flags` take no value, `values` take exactly one. */
export function parseCli(argv, { flags = [], values = [] } = {}) {
  const out = { flags: new Set(), values: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (flags.includes(a)) {
      if (out.flags.has(a)) throw new UsageError(`${a} given twice`)
      out.flags.add(a)
    } else if (values.includes(a)) {
      const v = argv[i + 1]
      if (v === undefined || v === '' || v.startsWith('--')) throw new UsageError(`${a} needs a value`)
      if (a in out.values) throw new UsageError(`${a} given twice`)
      out.values[a] = v
      i++
    } else if (a.startsWith('-')) {
      throw new UsageError(`unknown option ${a} (known: ${[...flags, ...values].join(', ') || 'none'})`)
    } else {
      throw new UsageError(`unexpected argument ${a}`)
    }
  }
  return out
}
