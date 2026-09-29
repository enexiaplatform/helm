import { useState } from 'react';
import { SectionHead } from '../ui/SectionHead.tsx';
import { Button } from '../ui/Button.tsx';
import { Pill, type PillTone } from '../ui/Pill.tsx';
import { Notice } from '../ui/Notice.tsx';
import { cn } from '../../lib/cn.ts';

export interface GovernanceRequirementView {
  id: string;
  role: string;
  kind: string;
  sequence: number;
  status: 'PENDING' | 'APPROVE' | 'REJECT' | 'RETURN_FOR_RECONSIDERATION';
  occupants: string;
  independentOf: string | null;
  reason: string;
  act?: { by: string; at: string; basis: string; comments: string; note?: string | null };
}

export interface ApprovalRequestView {
  question: string;
  chosen: string;
  committedBy: string;
  consequences: { label: string; value: string }[];
  tradeOffs: { label: string; statement: string }[];
  uncertainty: string[];
  reason: string[];
}

export interface GovernanceView {
  state: string;
  policyResult: string | null;
  progress: string;
  headline: string;
  alarm: boolean;
  statement: string;
  basis: string;
  actor: string;
  fingerprint: string;
  evaluatedAt: string;
  consequences: { label: string; value: string }[];
  why: string[];
  requirements: GovernanceRequirementView[];
  gaps: { message: string; blocking: boolean }[];
}

interface Props {
  view: GovernanceView | null;
  /** Demo only: whose seat an act is recorded from. Empty in the cloud — the signed-in user acts. */
  identities: { userId: string; label: string; seat: string }[];
  request: ApprovalRequestView | null;
  onOpenRequest: (requirementId: string) => void;
  onEvaluate: () => void;
  onAct: (requirementId: string, decision: 'APPROVE' | 'REJECT' | 'RETURN_FOR_RECONSIDERATION', comments: string, asUserId: string | null) => void;
  refusal: string | null;
  busy: boolean;
}

const STATE_TONE: Record<string, PillTone> = {
  AUTHORIZED: 'actual',
  APPROVED: 'committed',
  PENDING_APPROVAL: 'accepted',
  ESCALATED: 'accepted',
  RETURNED: 'accepted',
  REJECTED: 'open',
  NOT_AUTHORIZED: 'open',
  INDETERMINATE: 'blocked',
  NOT_EVALUATED: 'neutral',
};

const read = (v: string) => v.replaceAll('_', ' ').toLowerCase();

/* The Governance section of the Decision Workspace. A policy RESULT and the
   approval PROGRESS are shown side by side, never merged; "why" is a first-
   class interaction, not a tooltip. The commitment above it is never changed. */
export function GovernancePanel({ view, identities, request, onOpenRequest, onEvaluate, onAct, refusal, busy }: Props) {
  const [showWhy, setShowWhy] = useState(false);
  const [comments, setComments] = useState('');
  const [asUser, setAsUser] = useState<string>(identities[0]?.userId ?? '');

  if (!view) {
    return (
      <section className="mt-11">
        <SectionHead title="Was this within authority?" meta="not evaluated" caveat="authority is judged apart from the commitment" />
        <p className="mt-3 max-w-reading text-base text-ink-600">
          No authority evaluation exists for this commitment. HELM evaluates it from the scope it touches and the consequences
          the model computed for it, under the authority policy in force when it was made.
        </p>
        <Button className="mt-4" onClick={onEvaluate} disabled={busy}>Evaluate authority</Button>
      </section>
    );
  }

  const pending = view.requirements.filter((r) => r.status === 'PENDING');
  return (
    <section className="mt-11">
      <SectionHead
        title="Was this within authority?"
        meta={<Pill tone={STATE_TONE[view.state] ?? 'neutral'}>{read(view.state)}</Pill>}
        caveat="the commitment above is unchanged by any of this"
      />
      <p className={cn('mt-4 max-w-reading font-serif text-lede', view.alarm ? 'text-red-700' : 'text-ink-950')}>{view.headline}</p>
      <dl className="mt-4 flex flex-wrap gap-x-9 gap-y-[10px]">
        {[
          ['Policy result', view.policyResult ?? '—'],
          ['Approvals', read(view.progress)],
          ['Authority in force', view.basis],
          ['Committed by', view.actor],
          ['Evaluated', view.evaluatedAt],
        ].map(([k, v]) => (
          <div key={k} className="grid">
            <dt className="text-meta text-ink-500">{k}</dt>
            <dd className="font-mono text-ui font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 helm-meta">evaluation {view.fingerprint}</p>

      {view.consequences.length > 0 && (
        <div className="mt-5 max-w-[640px]">
          <p className="helm-label mb-1">Read from the chosen future, not typed</p>
          {view.consequences.map((c) => (
            <div key={c.label} className="flex items-baseline justify-between gap-4 border-t border-ink-200 py-2">
              <span className="text-dense text-ink-600">{c.label}</span>
              <span className="font-mono text-dense font-medium">{c.value}</span>
            </div>
          ))}
        </div>
      )}

      <button type="button" onClick={() => setShowWhy((x) => !x)} className="mt-5 text-dense font-medium text-accent-700 hover:underline">
        {showWhy ? 'Hide the reasoning' : view.requirements.length > 0 ? 'Why does this require approval? →' : 'Why is this the answer? →'}
      </button>
      {showWhy && (
        <ol className="mt-2 max-w-reading">
          {view.why.map((line, i) => (
            <li key={i} className="border-t border-ink-200 py-2 text-dense text-ink-700">{line}</li>
          ))}
        </ol>
      )}

      {view.gaps.length > 0 && (
        <Notice tone={view.gaps.some((g) => g.blocking) ? 'error' : 'warning'} label="What HELM does not know" className="mt-5">
          {view.gaps.map((g, i) => <p key={i}>{g.message}</p>)}
        </Notice>
      )}

      {view.requirements.length > 0 && (
        <div className="mt-7">
          <p className="mb-[6px] text-dense font-semibold">Approvals the policy requires</p>
          {view.requirements.map((r) => (
            <div key={r.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t border-ink-200 py-3">
              <span className="text-ui font-medium">
                {r.role}
                <span className="ml-2 helm-meta">{read(r.kind)} · order {r.sequence} · held by {r.occupants || 'nobody'}</span>
              </span>
              <span className={cn('font-mono text-meta font-semibold', r.status === 'APPROVE' ? 'text-emerald-700' : r.status === 'PENDING' ? 'text-amber-700' : 'text-red-700')}>
                {r.status === 'APPROVE' ? 'APPROVED' : r.status === 'PENDING' ? 'PENDING' : r.status === 'REJECT' ? 'REJECTED' : 'RETURNED'}
              </span>
              <span className="col-span-2 text-meta text-ink-500">
                {r.reason}
                {r.independentOf && ` Must come from someone other than ${r.independentOf}.`}
              </span>
              {r.act && (
                <span className="col-span-2 text-dense text-ink-700">
                  {r.act.by} · <span className="font-mono text-meta">{r.act.at}</span> · {r.act.basis}
                  {r.act.comments && <span className="block font-serif italic text-ink-800">“{r.act.comments}”</span>}
                  {r.act.note && <span className="block text-meta text-red-700">{r.act.note}</span>}
                </span>
              )}
              {r.status === 'PENDING' && (
                <button type="button" onClick={() => onOpenRequest(r.id)} className="col-span-2 justify-self-start text-meta font-medium text-accent-700 hover:underline">
                  Read the approval request →
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {request && (
        <div className="mt-5 rounded-xl border border-ink-200 bg-white px-[18px] py-[14px]">
          <p className="helm-label">Approval request</p>
          <p className="mt-1 font-serif text-panel">{request.question}</p>
          <p className="mt-1 text-dense text-ink-700">
            Chosen: <span className="font-medium">{request.chosen}</span> · committed by {request.committedBy}
          </p>
          <div className="mt-3 grid gap-x-10 gap-y-3 md:grid-cols-2">
            <div>
              <p className="text-meta font-semibold">Key consequences</p>
              {request.consequences.map((c) => (
                <p key={c.label} className="flex justify-between gap-3 border-t border-ink-100 py-1 text-dense">
                  <span className="text-ink-600">{c.label}</span>
                  <span className="font-mono">{c.value}</span>
                </p>
              ))}
            </div>
            <div>
              <p className="text-meta font-semibold">Accepted trade-offs</p>
              {request.tradeOffs.length === 0 ? (
                <p className="text-dense text-ink-500">None stated.</p>
              ) : (
                request.tradeOffs.map((t) => (
                  <p key={t.label} className="border-t border-ink-100 py-1 text-dense text-ink-700">
                    <span className="font-medium">{t.label}.</span> {t.statement}
                  </p>
                ))
              )}
            </div>
          </div>
          {request.uncertainty.length > 0 && (
            <div className="mt-3">
              <p className="text-meta font-semibold">Uncertainty the approver inherits</p>
              {request.uncertainty.map((u, i) => (
                <p key={i} className="border-t border-ink-100 py-1 text-dense text-red-700">{u}</p>
              ))}
            </div>
          )}
          <div className="mt-3">
            <p className="text-meta font-semibold">Why this approval</p>
            {request.reason.map((u, i) => (
              <p key={i} className="border-t border-ink-100 py-1 text-dense text-ink-700">{u}</p>
            ))}
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <div className="mt-6 grid max-w-[640px] gap-3">
          {identities.length > 0 && (
            <label className="grid gap-1">
              <span className="text-meta text-ink-500">Demo: record the act as</span>
              <select value={asUser} onChange={(e) => setAsUser(e.target.value)} className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-dense">
                {identities.map((i) => (
                  <option key={i.userId} value={i.userId}>{i.label} — {i.seat}</option>
                ))}
              </select>
              <span className="text-meta text-ink-500">
                Fictional demo people. HELM resolves their seat from occupancy; choosing a person who does not hold the required seat is refused.
              </span>
            </label>
          )}
          <label className="grid gap-1">
            <span className="text-meta text-ink-500">Comments (a rejection or a return must say why)</span>
            <textarea value={comments} onChange={(e) => setComments(e.target.value)} rows={2} className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-dense" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy} onClick={() => onAct(pending[0].id, 'APPROVE', comments, identities.length > 0 ? asUser : null)}>
              Approve as {pending[0].role}
            </Button>
            <Button disabled={busy} onClick={() => onAct(pending[0].id, 'RETURN_FOR_RECONSIDERATION', comments, identities.length > 0 ? asUser : null)}>
              Return for reconsideration
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => onAct(pending[0].id, 'REJECT', comments, identities.length > 0 ? asUser : null)}>
              Reject
            </Button>
          </div>
          {refusal && <Notice tone="error" label="Refused">{refusal}</Notice>}
        </div>
      )}
      <p className="mt-6 max-w-reading font-serif text-base italic text-ink-600">“{view.statement}”</p>
    </section>
  );
}
