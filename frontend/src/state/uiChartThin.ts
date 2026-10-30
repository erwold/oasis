/** Thinning a run of a line to what a pixel column can show (pure, no imports: uiChart and uiChartDense share it). */

/** A drawn point: its position in plot units and its index among the series' points (its order in the data). */
export interface PlotPoint { x: number; y: number; i: number }

/** One run of the pen (points with a value, no gap between them), thinned to at most four points per column of
 *  `column` plot units: the first, the lowest, the highest and the last of each column, in the data's own order. A
 *  column with four points or fewer keeps them all, so a sparse run is drawn exactly as it is. Columns are taken in
 *  the run's order; a point whose column differs from the one before starts a new column (a run that goes back on x
 *  is never merged across). */
export function thinRun(run: readonly PlotPoint[], column: number): PlotPoint[] {
  if (run.length <= 4 || !(column > 0) || !Number.isFinite(column)) return run.slice()
  const out: PlotPoint[] = []
  let start = 0
  const flush = (end: number) => {
    // run[start..end) share one column
    const n = end - start
    if (n <= 4) { for (let k = start; k < end; k += 1) out.push(run[k]!); return }
    let lo = start, hi = start
    for (let k = start + 1; k < end; k += 1) {
      if (run[k]!.y < run[lo]!.y) lo = k
      if (run[k]!.y > run[hi]!.y) hi = k
    }
    const keep = [...new Set([start, lo, hi, end - 1])].sort((a, b) => a - b)
    for (const k of keep) out.push(run[k]!)
  }
  let col = Math.floor(run[0]!.x / column)
  for (let k = 1; k < run.length; k += 1) {
    const c = Math.floor(run[k]!.x / column)
    if (c !== col) { flush(k); start = k; col = c }
  }
  flush(run.length)
  return out
}
