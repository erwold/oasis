import { useReplay } from '../state/replay'
import { SPEEDS, clock } from '../state/replayState'

/** The replay's transport (carried from the oasis ReplayBar), in place of the composer: play / pause, the speed, a
 *  scrubber over the session's time, the clock, and the way back to the live session. */
export function ReplayBar() {
  const { active, playing, speed, t0, t1, cursor, play, pause, stop, seek, setSpeed, body } = useReplay()
  if (!active) return null
  const span = Math.max(1, t1 - t0)
  const at = new Date(cursor)
  return (
    <div className="replay-bar" role="toolbar" aria-label="Replay" data-testid="replay-bar">
      <button className="btn tiny" onClick={() => (playing ? pause() : play())} data-testid="replay-play">{playing ? 'Pause' : 'Play'}</button>
      <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Speed">
        {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <input className="replay-scrub" type="range" min={0} max={1000} value={Math.round(((cursor - t0) / span) * 1000)}
             onChange={(e) => seek(t0 + (Number(e.target.value) / 1000) * span)} data-testid="replay-scrub" aria-label="Replay position" />
      <span className="replay-clock dim small" title={at.toLocaleString()} data-testid="replay-clock">
        {clock(cursor - t0)} / {clock(span)} · {body?.events.length ?? 0} events
      </span>
      <button className="btn tiny" onClick={stop} data-testid="replay-exit">Back to live</button>
    </div>
  )
}
