import { attributionDetail, attributionWord, type AttributionView } from '../state/attribution'

/** Beside a run's measured changes: "partial" or "not attributable", the reason and the paths left out on hover (and to
 *  a screen reader). Nothing for exact changes. */
export function AttributionMark({ view }: { view: AttributionView }) {
  const word = attributionWord(view)
  if (!word) return null
  const detail = attributionDetail(view)
  return (
    <span className="attribution-mark" tabIndex={0} role="note" title={detail} aria-label={`${word}: ${detail}`}
          data-testid="attribution-mark" data-attribution={view.kind}>{word}</span>
  )
}
