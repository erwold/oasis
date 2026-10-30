/** A small ring that reads a fraction at a glance; the track is a hairline,
 * the value arc takes the tone. Nothing inside: the number sits beside it. */
export function ProgressRing({ fraction, tone = 'accent', size = 18 }: {
  fraction: number | null
  tone?: 'accent' | 'green' | 'orange' | 'red' | 'neutral'
  size?: number
}) {
  const stroke = 2.25
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const value = fraction === null ? 0 : Math.min(1, Math.max(0, fraction))
  return (
    <svg className={`ring ring-${tone}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth={stroke} />
      {fraction !== null && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke}
        strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
    </svg>
  )
}
