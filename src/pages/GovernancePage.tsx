/**
 * Governance — a technical instrument over the Phase 6 authority runtime, not
 * an executive cockpit.
 *
 * It shows the authority structure as recorded: which roles exist and who
 * occupies them, the policy versions and their rules (scope, acts, lines on
 * computed consequences, escalation), delegations, every authority evaluation
 * and every approval act. Everything is read from the runtime; nothing here
 * decides, ranks or approves.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  describeCondition,
  type ApprovalAct,
  type AuthorityEvaluation,
  type AuthorityPolicy,
  type AuthorityRule,
  type Delegation,
  type RoleOccupancy,
} from '@helm/authority-runtime';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { resolveGovernanceContext } from '../services/authorityRuntime.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Pill, type PillTone } from '../components/ui/Pill.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { cn } from '../lib/cn.ts';

type Loaded = {
  policies: readonly AuthorityPolicy[];
  rules: readonly AuthorityRule[];
  occupancies: readonly RoleOccupancy[];
  delegations: readonly Delegation[];
  evaluations: readonly AuthorityEvaluation[];
  acts: readonly ApprovalAct[];
  types: readonly { key: string; name: string; description: string }[];
};

const RESULT_TONE: Record<string, PillTone> = {
  AUTHORIZED: 'actual',
  REQUIRES_APPROVAL: 'accepted',
  ESCALATED: 'accepted',
  NOT_AUTHORIZED: 'open',
  INDETERMINATE: 'blocked',
};

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

function Table({ head, children, min = 860 }: { head: string[]; children: ReactNode; min?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" style={{ minWidth: min }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={cn('helm-label pb-2 pt-[14px] text-left', i > 0 && 'pl-3')}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const cell = 'py-3 pl-3 align-top text-dense text-ink-700';
const mono = 'whitespace-nowrap py-3 pl-3 align-top font-mono text-meta text-ink-700';

export function GovernancePage() {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scope = useMemo(
    () => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null),
    [mode, activeOrgId, userId, myRole],
  );

  useEffect(() => {
    let live = true;
    if (!scope) return;
    void (async () => {
      try {
        const ctx = await resolveGovernanceContext(mode ?? 'demo', scope);
        if (!ctx) throw new Error('The authority runtime is unavailable in this mode.');
        const r = ctx.runtime;
        const [policies, rules, occupancies, delegations, evaluations, acts, types] = await Promise.all([
          r.listPolicies(scope),
          r.listRules(scope),
          r.listOccupancies(scope),
          r.listDelegations(scope),
          r.listEvaluations(scope, {}),
          r.listApprovalActs(scope, {}),
          r.listDecisionTypes(scope),
        ]);
        for (const x of [policies, rules, occupancies, delegations, evaluations, acts, types]) {
          if (!x.ok) throw new Error(x.error.message);
        }
        if (live) {
          setData({
            policies: policies.ok ? policies.value : [],
            rules: rules.ok ? rules.value : [],
            occupancies: occupancies.ok ? occupancies.value : [],
            delegations: delegations.ok ? delegations.value : [],
            evaluations: evaluations.ok ? evaluations.value : [],
            acts: acts.ok ? acts.value : [],
            types: types.ok ? types.value : [],
          });
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope]);

  if (error) return <EmptyState title="Governance could not be opened" detail={error} />;
  if (!data) return <p className="text-ui text-ink-500">Reading the authority structure…</p>;

  const latest = [...data.policies].sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
  const title = latest ? `Decision authority — ${latest.reference} v${latest.version}${latest.demo ? ' (demo policy)' : ''}` : 'Decision authority — no policy recorded';

  return (
    <>
      <PageHeader
        kicker="Kernel instrument · Governance"
        size="instrument"
        title={title}
        lede="Who may commit which management decision, over which enterprise scope, under which computed consequences — and whose authority a commitment needs when it goes further. Authority attaches to roles; people occupy them. Nothing here is ranked, weighted or totalled."
      />

      {mode === 'cloud' && !latest && (
        <Notice tone="warning" label="Nothing governs a commitment here yet" className="mt-6">
          No delegation-of-authority policy, role or occupancy is recorded for this organization, so every commitment made in{' '}
          <Link to="/decisions" className="underline">Decisions</Link> carries authority NOT EVALUATED. Recording them is an
          administrator&rsquo;s act the authority runtime accepts, but this page does not record them yet; and the verdicts and
          approval acts themselves are written only by the trusted authority service, which is not deployed to this environment.
        </Notice>
      )}

      <section className="mt-9">
        <SectionHead title="Roles and who occupies them" meta={`${data.occupancies.length} occupancies`} caveat="authority follows the seat, not the person" />
        <Table head={['Role', 'Occupied by', 'Kind', 'From', 'To', 'Basis', 'Recorded']}>
          {data.occupancies.map((o) => (
            <tr key={o.id} className="border-t border-ink-200">
              <td className="py-3 pr-3 align-top text-ui font-medium">{o.roleLabel}</td>
              <td className={cell}>{o.personLabel}</td>
              <td className={mono}>{o.kind}</td>
              <td className={mono}>{day(o.validFrom)}</td>
              <td className={mono}>{day(o.validTo)}</td>
              <td className={cell}>{o.basis}</td>
              <td className={mono}>{day(o.recordedAt)}</td>
            </tr>
          ))}
        </Table>
      </section>

      {[...data.policies]
        .sort((a, b) => a.key.localeCompare(b.key) || b.version - a.version)
        .map((p) => (
          <section key={p.id} className="mt-11">
            <SectionHead
              title={`${p.reference} v${p.version} — ${p.title}`}
              meta={`${p.source} · valid from ${day(p.validFrom)} · recorded ${day(p.recordedAt)}`}
              caveat={p.demo ? 'DEMO GOVERNANCE POLICY — not a HELM default' : undefined}
            />
            <p className="mt-3 max-w-reading text-base text-ink-600">{p.rationale}</p>
            <Table head={['Rule', 'Holder', 'Effect', 'Acts', 'Scope', 'Lines on computed consequences', 'Beyond it']} min={1100}>
              {data.rules
                .filter((r) => r.policyId === p.id)
                .map((r) => (
                  <tr key={r.id} className="border-t border-ink-200">
                    <td className="py-3 pr-3 align-top font-mono text-meta font-semibold">{r.key}</td>
                    <td className={cell}>{r.holder.label}</td>
                    <td className={mono}>{r.effect}</td>
                    <td className={mono}>{r.acts.join(' · ')}</td>
                    <td className={cell}>
                      {r.scope.length === 0 ? 'enterprise-wide' : r.scope.map((s) => `${s.dimension.replaceAll('_', ' ').toLowerCase()} ${s.entities.map((e) => e.label).join(', ')}`).join(' · ')}
                    </td>
                    <td className={mono}>{r.conditions.length === 0 ? 'no line' : r.conditions.map(describeCondition).join(' AND ')}</td>
                    <td className={cell}>
                      {r.escalationRoleLabel ?? (r.effect === 'GRANT' && r.conditions.length > 0 ? 'names nobody' : '—')}
                      {r.approvalIndependence === 'INDEPENDENT_OF_COMMITTER' && r.effect !== 'GRANT' && (
                        <span className="block text-meta text-ink-500">independent of the committer</span>
                      )}
                    </td>
                  </tr>
                ))}
            </Table>
          </section>
        ))}

      <section className="mt-11">
        <SectionHead title="Delegations" meta={`${data.delegations.length}`} caveat="never more than the delegator holds" />
        {data.delegations.length === 0 ? (
          <p className="mt-3 text-base text-ink-600">No authority is delegated.</p>
        ) : (
          <Table head={['From', 'To', 'Acts', 'Scope', 'Lines', 'Window', 'Reason', 'Revoked']}>
            {data.delegations.map((d) => (
              <tr key={d.id} className="border-t border-ink-200">
                <td className={cell}>{d.delegatorLabel} · {d.delegatorRoleLabel}</td>
                <td className={cell}>{d.delegateLabel}</td>
                <td className={mono}>{d.acts.join(' · ')}</td>
                <td className={cell}>{d.scope.map((s) => s.entities.map((e) => e.label).join(', ')).join(' · ')}</td>
                <td className={mono}>{d.conditions.map(describeCondition).join(' AND ') || 'the delegator’s own'}</td>
                <td className={mono}>{day(d.validFrom)} → {day(d.validTo)}</td>
                <td className={cell}>{d.reason}</td>
                <td className={mono}>{d.revokedAt ? day(d.revokedAt) : '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="mt-11">
        <SectionHead title="Authority evaluations" meta={`${data.evaluations.length}`} caveat="each judges one commitment fingerprint, and is never rewritten" />
        <Table head={['Commitment', 'Actor', 'Act at', 'Result', 'Required', 'Governability', 'Evaluation']} min={1000}>
          {data.evaluations.map((e) => (
            <tr key={e.id} className="border-t border-ink-200">
              <td className="py-3 pr-3 align-top">
                <Link to={`/decisions/${e.decisionId}`} className="font-mono text-meta">{e.commitmentFingerprint.slice(0, 22)}</Link>
                {e.supersedesEvaluationId && <span className="block text-meta text-ink-500">supersedes an earlier evaluation</span>}
              </td>
              <td className={cell}>{e.actorLabel}</td>
              <td className={mono}>{day(e.actAt)}</td>
              <td className="py-3 pl-3 align-top"><Pill tone={RESULT_TONE[e.result] ?? 'neutral'}>{e.result.replaceAll('_', ' ')}</Pill></td>
              <td className={cell}>{e.requiredAuthorities.map((r) => r.roleLabel).join(', ') || '—'}</td>
              <td className={cn(mono, e.governability === 'NOT_GOVERNABLE' && 'text-red-700')}>{e.governability}</td>
              <td className={mono}>{e.fingerprint.slice(0, 22)}</td>
            </tr>
          ))}
        </Table>
      </section>

      <section className="mt-11">
        <SectionHead title="Approval acts" meta={`${data.acts.length}`} caveat="the approver’s seat is resolved, never typed" />
        {data.acts.length === 0 ? (
          <p className="mt-3 text-base text-ink-600">No approval act has been recorded.</p>
        ) : (
          <Table head={['Approver', 'As', 'Response', 'Basis', 'When', 'Commitment']}>
            {data.acts.map((a) => (
              <tr key={a.id} className="border-t border-ink-200">
                <td className={cell}>{a.approverLabel}</td>
                <td className={cell}>{a.approverRoleLabel}</td>
                <td className={cn(mono, a.decision !== 'APPROVE' && 'text-red-700')}>{a.decision}</td>
                <td className={mono}>{a.basis.kind}</td>
                <td className={mono}>{a.actedAt.slice(0, 16).replace('T', ' ')}</td>
                <td className="py-3 pl-3 align-top"><Link to={`/decisions/${a.decisionId}`} className="font-mono text-meta">{a.commitmentFingerprint.slice(0, 22)}</Link></td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="mt-11">
        <SectionHead title="Decision types" meta={`${data.types.length}`} caveat="registry data; a decision without one is INDETERMINATE" />
        {data.types.map((t) => (
          <div key={t.key} className="grid grid-cols-[220px_minmax(0,1fr)] gap-x-4 border-b border-ink-200 py-2">
            <span className="font-mono text-meta font-semibold">{t.key}</span>
            <span className="text-dense text-ink-700">{t.description}</span>
          </div>
        ))}
      </section>
    </>
  );
}
