/** A unified patch cut per file, for a file chip's preview: each file's lines after its headers, marked added,
 *  removed, context or a hunk head; and a new SVG put back together from its added lines so the preview can show
 *  the picture rather than its source. */

export interface PatchLine { text: string; tone: 'add' | 'del' | 'ctx' | 'hunk' }
export interface FilePatch { lines: PatchLine[]; binary: boolean; created: boolean }

export function filePatches(patch: string): Map<string, FilePatch> {
  const out = new Map<string, FilePatch>()
  let current: FilePatch | null = null
  for (const raw of patch.split('\n')) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(raw)
    if (head) { current = { lines: [], binary: false, created: false }; out.set(head[2]!, current); continue }
    if (!current) continue
    if (raw.startsWith('new file mode')) { current.created = true; continue }
    if (raw.startsWith('Binary files')) { current.binary = true; continue }
    if (/^(index |--- |\+\+\+ |deleted file mode|old mode|new mode|similarity index|rename from|rename to)/.test(raw)) continue
    if (raw.startsWith('@@')) current.lines.push({ text: raw, tone: 'hunk' })
    else if (raw.startsWith('+')) current.lines.push({ text: raw.slice(1), tone: 'add' })
    else if (raw.startsWith('-')) current.lines.push({ text: raw.slice(1), tone: 'del' })
    else if (raw.startsWith(' ')) current.lines.push({ text: raw.slice(1), tone: 'ctx' })
  }
  return out
}

/** A created SVG file's source (its added lines), when the patch holds the whole file; otherwise null. */
export function createdSvg(path: string, file: FilePatch | undefined): string | null {
  if (!file || !file.created || file.binary || !/\.svg$/i.test(path)) return null
  const body = file.lines.filter((l) => l.tone === 'add').map((l) => l.text).join('\n')
  return /<svg[\s>]/i.test(body) ? body : null
}

/** A line of a file as the code view shows it: its number in the file as it stands (none for a removed line) and in
 *  the file before (none for an added one), or a fold standing for a run of unchanged lines left out. */
export type ViewLine =
  | { kind: 'line'; text: string; tone: 'add' | 'del' | 'ctx'; oldNo: number | null; newNo: number | null }
  | { kind: 'fold'; count: number }

/** Unchanged lines kept around each change when a file is too long to show whole. */
const FOLD_KEEP = 40

/** The file's lines numbered from its hunk heads (a patch made with the whole file as context has one hunk, so every
 *  line of the file stands in order). Past `maxLines`, runs of unchanged lines far from any change fold, so a long
 *  file still shows every change. */
export function viewLines(file: FilePatch, maxLines = 20_000): ViewLine[] {
  const out: ViewLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const l of file.lines) {
    if (l.tone === 'hunk') {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l.text)
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]) }
      continue
    }
    if (l.tone === 'add') out.push({ kind: 'line', text: l.text, tone: 'add', oldNo: null, newNo: newNo++ })
    else if (l.tone === 'del') out.push({ kind: 'line', text: l.text, tone: 'del', oldNo: oldNo++, newNo: null })
    else out.push({ kind: 'line', text: l.text, tone: 'ctx', oldNo: oldNo++, newNo: newNo++ })
  }
  if (out.length <= maxLines) return out
  const near = new Array<boolean>(out.length).fill(false)
  out.forEach((l, i) => {
    if (l.kind === 'line' && l.tone !== 'ctx') for (let k = Math.max(0, i - FOLD_KEEP); k <= Math.min(out.length - 1, i + FOLD_KEEP); k += 1) near[k] = true
  })
  const folded: ViewLine[] = []
  let skipped = 0
  out.forEach((l, i) => {
    if (near[i]) {
      if (skipped) folded.push({ kind: 'fold', count: skipped })
      skipped = 0
      folded.push(l)
    } else skipped += 1
  })
  if (skipped) folded.push({ kind: 'fold', count: skipped })
  return folded
}

/** Where each change starts in the view: the first line of every run of added or removed lines. */
export function changeStarts(lines: ViewLine[]): number[] {
  const starts: number[] = []
  lines.forEach((l, i) => {
    const changed = l.kind === 'line' && l.tone !== 'ctx'
    const before = lines[i - 1]
    const wasChanged = before !== undefined && before.kind === 'line' && before.tone !== 'ctx'
    if (changed && !wasChanged) starts.push(i)
  })
  return starts
}

/** One file's unified diff (a write's or an edit's own, with or without its `---`/`+++` heads) as the code view reads
 *  a file patch. */
export function patchOf(diff: string): FilePatch {
  const lines: PatchLine[] = []
  for (const raw of diff.split('\n')) {
    if (/^(--- |\+\+\+ |diff --git |index |new file mode|deleted file mode)/.test(raw)) continue
    if (raw.startsWith('@@')) lines.push({ text: raw, tone: 'hunk' })
    else if (raw.startsWith('+')) lines.push({ text: raw.slice(1), tone: 'add' })
    else if (raw.startsWith('-')) lines.push({ text: raw.slice(1), tone: 'del' })
    else if (raw.startsWith(' ')) lines.push({ text: raw.slice(1), tone: 'ctx' })
  }
  return { lines, binary: false, created: false }
}
