import { useEffect, useState, type CSSProperties } from 'react'
import { BOT_HEX, botSrc, inkOn, type BotState } from '../state/outline'
import { BotImage } from './BotImage'
import { botAt, useReel } from '../state/reel'

/** The product's name: oasis, the family, with "code" as a chip — this is oasis's code product. The mark is the
 *  bot reel (no lead bot: the set's bots take turns). `size` scales the wordmark; the reel's bot is no run's, so it
 *  plays idle wherever it stands (the rail's head, the start screen's title); the chip wears the bot's colour. */
export function Brand({ size = 'rail' }: { size?: 'rail' | 'hero' }) {
  const bot = useReel((s) => botAt(s.order, s.index))
  // the chip takes the colour of the bot the reel is turning to, fading over the slide
  const chip = { '--chip': BOT_HEX[bot], '--chip-ink': inkOn(BOT_HEX[bot]) } as CSSProperties
  return (
    <span className={`brand brand-${size}`} data-testid="brand">
      <BotReel px={size === 'hero' ? 52 : 26} />
      <span className="brand-word">oasis<span className="brand-chip" style={chip} data-bot={bot}>code</span></span>
    </span>
  )
}

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/** The reel's window: the bot at rest, and, when the reel turns, the next one sliding up into its place (a slot
 *  machine's stop, with a little overshoot). The following bot is fetched ahead so the slide never shows a blank. */
export function BotReel({ px, state = 'idle' }: { px: number; state?: BotState }) {
  const order = useReel((s) => s.order)
  const index = useReel((s) => s.index)
  const watch = useReel((s) => s.watch)
  const [shown, setShown] = useState(index)
  const [sliding, setSliding] = useState(false)
  useEffect(() => watch(), [watch])
  useEffect(() => {
    if (index === shown) return
    if (reduced()) { setShown(index); setSliding(false); return }
    setSliding(true)
  }, [index, shown])
  useEffect(() => {
    const ahead = new Image()
    ahead.src = botSrc(botAt(order, shown + 1), state)
  }, [order, shown, state])
  const current = botAt(order, shown)
  const next = botAt(order, index)
  return (
    <span className="bot-reel brand-mark" style={{ width: px, height: px }} data-testid="bot-reel" data-bot={current}>
      <span className={`bot-reel-strip${sliding ? ' sliding' : ''}`} onTransitionEnd={() => { setShown(index); setSliding(false) }}>
        <BotImage bot={current} state={state} size={px} />
        {sliding && <BotImage bot={next} state={state} size={px} />}
      </span>
    </span>
  )
}
