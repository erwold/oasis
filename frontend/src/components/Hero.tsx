import { Brand } from './Brand'
import { Composer } from './Composer'
import { SshAsks } from './SshAsks'

/** The start screen (after oasis's Hero): the mark, one line, one composer. A task starts from whatever you say
 *  and the folder you point at; the sessions already begun live in the rail on the left. */
export function Hero() {
  return (
    <div className="hero" data-testid="hero">
      <div className="hero-brand">
        <h1 className="hero-title"><Brand size="hero" /></h1>
        <p className="hero-tagline">What do you want to build?</p>
      </div>
      <div className="hero-composer">
        <SshAsks />
        <Composer hero autoFocus />
      </div>
    </div>
  )
}
