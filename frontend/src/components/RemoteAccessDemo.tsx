import type { ReactNode } from 'react'
import { compileDemo, type DemoFrame } from '../state/demoTimeline'
import { REMOTE_DEMO_SCRIPT, REMOTE_DEMO_URL } from '../state/remoteDemoScript'
import { DemoStage } from './DemoStage'
import './RemoteAccessDemo.css'

/** Connect ChatGPT, drawn: the Remote access card's walkthrough (loaded when the person opens it). A picture of
 *  the steps, not the card itself: its address is the walkthrough's own placeholder (REMOTE_DEMO_URL), it reads no
 *  status and calls nothing of the desktop shell. */
const TIMELINE = compileDemo(REMOTE_DEMO_SCRIPT)

export default function RemoteAccessDemo({ onClose }: { onClose: () => void }) {
  return <DemoStage timeline={TIMELINE} scene={drawScene} label="Connect ChatGPT demo" onClose={onClose} testId="remote-demo" />
}

const T = (id: string) => ({ 'data-demo-target': id })

function drawScene(id: string, f: DemoFrame): ReactNode {
  const v = f.values
  switch (id) {
    case 'oasis':
      return (
        <Win title="oasis-code" kind="oasis">
          <div className="rdemo-card">
            <div className="rdemo-row">
              <b>Remote access</b>
              <i className={`rdemo-dot${v.on ? ' is-on' : ''}`} />
              <span className="rdemo-muted">{v.on ? (v.address ? 'Ready' : 'Starting…') : 'Off'}</span>
              <span className={`rdemo-btn${v.on ? '' : ' is-ink'}`} {...T('toggle')}>{v.on ? 'Turn off' : 'Turn on'}</span>
            </div>
            <div className={`rdemo-row rdemo-url${v.address ? ' is-shown' : ''}`}>
              <code>{REMOTE_DEMO_URL}</code>
              <span className={`rdemo-btn${v.copied ? ' is-done' : ''}`} {...T('copy')}>{v.copied ? '✓ Copied' : 'Copy'}</span>
            </div>
          </div>
        </Win>
      )
    case 'plugins':
      return (
        <Win title="ChatGPT" side={v.plugins ? 'plugins' : 'home'}>
          {v.plugins
            ? <>
                <div className="rdemo-head"><b>Plugins</b><span className="rdemo-icon-btn" {...T('plus')}>+</span></div>
                <div className="rdemo-tiles"><span /><span /><span /></div>
                {v.menu && <div className="rdemo-menu"><span {...T('add-custom')}>Add custom MCP server</span></div>}
              </>
            : <div className="rdemo-home"><b>What can I help with?</b><span className="rdemo-input">Ask anything</span></div>}
        </Win>
      )
    case 'server':
      return (
        <Win title="ChatGPT" side="plugins" dim>
          <div className="rdemo-dialog">
            <b>Add custom MCP server</b>
            <Field label="Name" target="name" value={v.name} />
            <Field label="Description" target="desc" value={v.desc} />
            <Field label="Connection · Server URL" target="server-url" value={v['server-url'] ? REMOTE_DEMO_URL : ''} mono />
            <Field label="Authentication" target="auth" value={v.auth ? 'No authentication' : ''} select />
          </div>
        </Win>
      )
    case 'risk':
      return (
        <Win title="ChatGPT" side="plugins" dim>
          <div className="rdemo-dialog">
            <b>Add custom MCP server</b>
            <div className="rdemo-warn"><i>!</i><span /><span /></div>
            <label className="rdemo-check" {...T('risk')}><i className={v.risk ? 'is-on' : ''}>{v.risk ? '✓' : ''}</i>I understand and want to continue</label>
            <div className="rdemo-actions">
              <span className={`rdemo-btn is-ink${v.risk ? '' : ' is-off'}${v.created ? ' is-done' : ''}`} {...T('create')}>{v.created ? '✓ Created' : 'Create as a plugin'}</span>
            </div>
          </div>
        </Win>
      )
    case 'install':
      return (
        <Win title="ChatGPT" side="plugins">
          <div className="rdemo-head"><b>Plugins</b><span className="rdemo-tab is-on">Personal</span></div>
          {v.open
            ? <div className="rdemo-plugin is-open">
                <span className="rdemo-logo">oc</span><span className="rdemo-name"><b>oasis-code</b><em>Code on my Mac</em></span>
                {v.installed && <span className="rdemo-badge">Installed</span>}
                <span className={`rdemo-icon-btn${v.installed ? ' is-done' : ''}`} {...T('install')}>{v.installed ? '✓' : '+'}</span>
              </div>
            : <div className="rdemo-plugin" {...T('plugin-card')}><span className="rdemo-logo">oc</span><span className="rdemo-name"><b>oasis-code</b><em>Code on my Mac</em></span></div>}
        </Win>
      )
    default:
      return (
        <Win title="ChatGPT" side={v.fresh ? 'home' : 'chat'}>
          {!v.fresh
            ? <div className="rdemo-thread"><span className="is-me" /><span /><span className="is-short" /></div>
            : <div className="rdemo-home">
            <span className="rdemo-seg"><span className={v.work ? '' : 'is-on'}>Chat</span><span className={v.work ? 'is-on' : ''} {...T('tab-work')}>Work</span></span>
            <span className="rdemo-input is-wide" {...T('composer')}>
              {v.picked ? <><span className="rdemo-chip">@oasis-code</span><span className="rdemo-caret" /></> : v.prompt ? <>{v.prompt}<span className="rdemo-caret" /></> : 'Ask anything'}
            </span>
            {v.mention && !v.picked && <div className="rdemo-menu is-below"><span {...T('mention-item')}><span className="rdemo-logo">oc</span>oasis-code</span></div>}
            {v.picked && <span className="rdemo-done">✓</span>}
          </div>}
        </Win>
      )
  }
}

function Win({ title, kind, side, dim, children }: { title: string; kind?: 'oasis'; side?: 'home' | 'plugins' | 'chat'; dim?: boolean; children: ReactNode }) {
  return (
    <div className={`rdemo-win${kind ? ` is-${kind}` : ''}`}>
      <div className="rdemo-title"><i /><i /><i /><span>{title}</span></div>
      <div className="rdemo-body">
        {side && (
          <div className="rdemo-side">
            <span className={side === 'home' ? 'is-on' : ''} {...T('new-chat')}>New chat</span>
            <span className={side === 'plugins' ? 'is-on' : ''} {...T('nav-plugins')}>Plugins</span>
          </div>
        )}
        <div className="rdemo-main">{dim && <div className="rdemo-scrim" />}{children}</div>
      </div>
    </div>
  )
}

function Field({ label, target, value, mono, select }: { label: string; target: string; value?: string; mono?: boolean; select?: boolean }) {
  return (
    <div className={`rdemo-field${mono || select ? ' is-wide' : ''}`}>
      <span>{label}</span>
      <span className={`rdemo-input${mono ? ' is-mono' : ''}${value ? ' is-filled' : ''}`} {...T(target)}>{value || (select ? 'Choose…' : '')}{select && <em>▾</em>}</span>
    </div>
  )
}
