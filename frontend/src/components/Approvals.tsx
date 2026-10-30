import { useState } from 'react'
import { api } from '../api/client'
import type { ActionProposal } from '../api/types'
import { approvalFacts, proposalTitle } from '../state/approvals'
import { useStore } from '../state/store'

/** What waits for the person, in one place: the actions the agent proposed (Ask before changes) and the permissions
 *  it asked for, each as what it would do — a computer action whole (its element or point, text, keys, the dialog it
 *  answers), a permission with every parameter an "Approve once" lets through. Nothing waits: nothing shows. */
export function Approvals() {
  const session = useStore((s) => s.session)
  const proposals = useStore((s) => s.proposals)
  const liveRunId = useStore((s) => s.liveRunId)
  const decide = useStore((s) => s.decide)
  const decideProposal = useStore((s) => s.decideProposal)
  const showToast = useStore((s) => s.showToast)
  const [busy, setBusy] = useState<string | null>(null)
  if (!session) return null
  const pending = proposals.filter((p) => p.status === 'pending')
  if (!pending.length && !session.pending_approvals.length) return null
  const fail = (e: unknown) => showToast(e instanceof Error ? e.message : String(e))
  const decideOne = async (p: ActionProposal, decision: 'approve' | 'reject') => {
    setBusy(p.proposal_asset_id)
    try {
      const status = await decideProposal(p.proposal_asset_id, decision)
      showToast(decision === 'approve' ? `Approved: ${status}` : 'Rejected')
    } catch (e) { fail(e) } finally { setBusy(null) }
  }
  return (
    <div className="panel approvals" data-testid="approvals">
      <b className="small">Waiting for you</b>
      {pending.map((p) => (
        <div key={p.proposal_asset_id} className="approval-item">
          <div className="approval" data-testid={`proposal-${p.proposal_asset_id}`}>
            <span><b data-testid="proposal-label">{proposalTitle(p)}</b> <span className="dim small">proposed by the agent</span></span>
            <button className="btn tiny" disabled={busy !== null || !!liveRunId} onClick={() => void decideOne(p, 'approve')} data-testid="approve-proposal">Approve</button>
            <button className="btn tiny" disabled={busy !== null} onClick={() => void decideOne(p, 'reject')}>Reject</button>
          </div>
          <ProposalDetails id={p.proposal_asset_id} />
        </div>
      ))}
      {session.pending_approvals.map((a) => (
        <div key={a.id} className="approval" data-testid={`approval-${a.id}`}>
          <span><b>{a.action}</b>{' '}
            <span className="dim small">{approvalFacts(a.params).map((f) => `${f.name}: ${f.value}`).join(' · ')}</span>
          </span>
          <button className="btn tiny" onClick={() => void decide(a, true).catch(fail)}>Approve once</button>
          <button className="btn tiny" onClick={() => void decide(a, false).catch(fail)}>Deny</button>
        </div>
      ))}
    </div>
  )
}

function ProposalDetails({ id }: { id: string }) {
  const [value, setValue] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const load = async () => {
    if (value || loading) return
    setLoading(true); setError(null)
    try { setValue((await api.proposal(id)).payload) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }
  return <details className="small" onToggle={(e) => { if (e.currentTarget.open) void load() }}>
    <summary>What exactly</summary>
    {loading && <p className="dim">Loading…</p>}
    {error && <p role="alert">{error} <button className="btn tiny" onClick={() => void load()}>Retry</button></p>}
    {value && <pre className="detail" data-testid="proposal-details">{JSON.stringify(value.validated_args ?? value, null, 2)}</pre>}
    {value && value.context != null && <pre className="detail" data-testid="proposal-context">{JSON.stringify(value.context, null, 2)}</pre>}
  </details>
}
