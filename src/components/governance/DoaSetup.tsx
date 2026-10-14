import { useMemo, useState } from 'react';
import type { AuthorityPolicy, AuthorityRule, DecisionTypeDefinition, RoleOccupancy } from '@helm/authority-runtime';
import type { UserId } from '@helm/shared';
import { useHelmStore } from '../../services/helmStore.ts';
import type { GovernanceContext } from '../../services/authorityRuntime.ts';
import { Button } from '../ui/Button.tsx';
import { SectionHead } from '../ui/SectionHead.tsx';

/**
 * Delegation of authority, set up by an administrator (audit 2026-10-13, GM: "a simple DoA table — decision type ×
 * value line → approver — entered in the UI"). Two steps: name the seats and who holds them; then, per seat, what it may
 * commit and up to which computed line, and who decides beyond it. Saving records a new policy version that supersedes
 * the previous one; nothing earlier is changed, so a past commitment is still judged by the policy in force then.
 *
 * The lines are on COMPUTED consequences (a decision's chosen future), never on a number someone types into the decision.
 */

const METRICS = [
  { key: 'ExpectedRevenue', label: 'Expected revenue' },
  { key: 'OpportunityValue', label: 'Opportunity value' },
] as const;

type Line = {
  roleId: string;
  kind: 'COMMIT_UP_TO' | 'APPROVE_ABOVE';
  types: string[];
  metricKey: string;
  threshold: string;
  currency: string;
  escalateTo: string;
};

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const control = 'max-w-full rounded-md border border-ink-200 bg-white px-2 py-[6px] text-dense';

export function DoaSetup({ ctx, policies, rules, occupancies, types, onSaved }: {
  ctx: GovernanceContext;
  policies: readonly AuthorityPolicy[];
  rules: readonly AuthorityRule[];
  occupancies: readonly RoleOccupancy[];
  types: readonly Pick<DecisionTypeDefinition, 'key' | 'name'>[];
  onSaved: () => void;
}) {
  const members = useHelmStore((s) => s.members);
  const latest = useMemo(() => [...policies].filter((p) => !p.demo).sort((a, b) => b.version - a.version)[0] ?? null, [policies]);
  const roles = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of occupancies) m.set(o.roleId, o.roleLabel);
    for (const r of rules) if (r.holder.kind === 'ROLE') m.set(r.holder.roleId, r.holder.label);
    return [...m.entries()].map(([id, label]) => ({ id, label }));
  }, [occupancies, rules]);

  // Lines start from the policy in force, so an edit is a revision, not a retyping.
  const [lines, setLines] = useState<Line[]>(() =>
    rules
      .filter((r) => latest && r.policyId === latest.id && r.holder.kind === 'ROLE' && r.effect !== 'RESTRICT')
      .map((r) => ({
        roleId: r.holder.kind === 'ROLE' ? r.holder.roleId : '',
        kind: r.effect === 'REQUIRE_APPROVAL' ? 'APPROVE_ABOVE' : 'COMMIT_UP_TO',
        types: [...r.decisionTypes],
        metricKey: r.conditions[0]?.metricKey ?? 'ExpectedRevenue',
        threshold: r.conditions[0]?.threshold ?? '',
        currency: r.conditions[0]?.currency ?? 'SGD',
        escalateTo: r.escalationRoleId ?? '',
      })),
  );
  const [roleName, setRoleName] = useState('');
  const [holder, setHolder] = useState('');
  const [reference, setReference] = useState(latest?.reference ?? 'DOA');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const runtime = ctx.runtime;
  const graph = ctx.decisions.scenarios.graphs.graphStore;
  const labelOf = (id: string) => roles.find((r) => r.id === id)?.label ?? '';

  const addSeat = async () => {
    const name = roleName.trim();
    const member = members.find((m) => m.userId === holder);
    if (name.length < 3 || !member) return;
    setBusy(true);
    setMessage(null);
    try {
      const role = await graph.upsertEntity(ctx.scope, { entityTypeKey: 'Role', canonicalKey: `helm:role:${slug(name)}`, name, sourceSystem: 'helm', attributes: { title: name } });
      if (!role.ok) throw new Error(role.error.message);
      const occ = await runtime.recordOccupancy(ctx.scope, {
        roleId: role.value.entity.id,
        userId: member.userId as UserId,
        personLabel: member.displayName || member.email || member.userId,
        kind: 'SUBSTANTIVE',
        validFrom: new Date().toISOString(),
        basis: 'Recorded in HELM by an administrator',
      });
      if (!occ.ok) throw new Error(occ.error.message);
      setRoleName('');
      setHolder('');
      setMessage({ text: `${name} is held by ${member.displayName || member.email}.`, failed: false });
      onSaved();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), failed: true });
    } finally {
      setBusy(false);
    }
  };

  const valid = lines.length > 0 && lines.every((l) => l.roleId && l.types.length > 0 && /^-?\d+(\.\d+)?$/.test(l.threshold.trim()) && l.currency.trim().length === 3);
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await runtime.recordPolicy(ctx.scope, {
        key: 'org-doa',
        version: (latest?.version ?? 0) + 1,
        title: 'Delegation of authority',
        reference: reference.trim() || 'DOA',
        source: 'DOA_DOCUMENT',
        demo: false,
        rationale: 'Recorded in HELM by an administrator.',
        validFrom: new Date().toISOString(),
        supersedesPolicyId: latest?.id ?? null,
        rules: lines.map((l, i) => {
          const metric = METRICS.find((m) => m.key === l.metricKey)!;
          const up = l.kind === 'COMMIT_UP_TO';
          return {
            key: `line-${i + 1}-${slug(labelOf(l.roleId))}`,
            holder: { kind: 'ROLE' as const, roleId: l.roleId, label: labelOf(l.roleId) },
            effect: up ? ('GRANT' as const) : ('REQUIRE_APPROVAL' as const),
            decisionTypes: l.types,
            acts: up ? (['PREPARE', 'RECOMMEND', 'COMMIT', 'APPROVE', 'EXECUTE'] as const) : (['COMMIT'] as const),
            scope: [],
            conditions: [{ metricKey: l.metricKey, label: metric.label, comparator: up ? ('LTE' as const) : ('GT' as const), threshold: l.threshold.trim(), unit: 'currency' as const, currency: l.currency.trim().toUpperCase() }],
            escalationRoleId: up && l.escalateTo ? l.escalateTo : null,
            escalationRoleLabel: up && l.escalateTo ? labelOf(l.escalateTo) : null,
            approvalIndependence: 'INDEPENDENT_OF_COMMITTER' as const,
            rationale: up
              ? `${labelOf(l.roleId)} may commit up to ${l.threshold} ${l.currency} of ${metric.label.toLowerCase()}${l.escalateTo ? `; beyond it, ${labelOf(l.escalateTo)} decides` : ''}.`
              : `Above ${l.threshold} ${l.currency} of ${metric.label.toLowerCase()}, ${labelOf(l.roleId)} must also approve.`,
          };
        }),
      });
      if (!r.ok) throw new Error(r.error.message);
      setMessage({ text: `Version ${r.value.policy.version} recorded, in force from now. Earlier commitments keep the version they were made under.`, failed: false });
      onSaved();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), failed: true });
    } finally {
      setBusy(false);
    }
  };

  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <section className="mt-9">
      <SectionHead title="Set up the delegation of authority" caveat="administrators only" />

      <div className="mt-4">
        <p className="helm-label">1 · Seats and who holds them</p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <input className={control} value={roleName} onChange={(e) => setRoleName(e.target.value)} placeholder="Role, e.g. Sales Manager" />
          <select className={control} value={holder} onChange={(e) => setHolder(e.target.value)}>
            <option value="">Held by…</option>
            {members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName || m.email || m.userId}</option>)}
          </select>
          <Button variant="secondary" size="sm" onClick={() => void addSeat()} disabled={busy || roleName.trim().length < 3 || !holder}>Add seat</Button>
        </div>
      </div>

      <div className="mt-6">
        <p className="helm-label">2 · What each seat may decide</p>
        {roles.length === 0 ? (
          <p className="mt-2 text-dense text-ink-600">Add a seat first.</p>
        ) : (
          <ul className="mt-2">
            {lines.map((l, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 border-b border-ink-200 py-2 text-dense">
                <select className={control} value={l.roleId} onChange={(e) => set(i, { roleId: e.target.value })}>
                  <option value="">Seat…</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                <select className={control} value={l.kind} onChange={(e) => set(i, { kind: e.target.value as Line['kind'] })}>
                  <option value="COMMIT_UP_TO">may commit up to</option>
                  <option value="APPROVE_ABOVE">must approve above</option>
                </select>
                <input className={`${control} w-32 font-mono`} value={l.threshold} onChange={(e) => set(i, { threshold: e.target.value })} placeholder="50000" />
                <input className={`${control} w-16 font-mono uppercase`} value={l.currency} onChange={(e) => set(i, { currency: e.target.value })} maxLength={3} />
                <span>of</span>
                <select className={control} value={l.metricKey} onChange={(e) => set(i, { metricKey: e.target.value })}>
                  {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label.toLowerCase()}</option>)}
                </select>
                <span>for</span>
                {types.map((t) => (
                  <label key={t.key} className="flex items-center gap-1">
                    <input type="checkbox" checked={l.types.includes(t.key)} onChange={(e) => set(i, { types: e.target.checked ? [...l.types, t.key] : l.types.filter((x) => x !== t.key) })} />
                    {t.name.toLowerCase()}
                  </label>
                ))}
                {l.kind === 'COMMIT_UP_TO' && (
                  <select className={control} value={l.escalateTo} onChange={(e) => set(i, { escalateTo: e.target.value })}>
                    <option value="">beyond it: nobody named</option>
                    {roles.filter((r) => r.id !== l.roleId).map((r) => <option key={r.id} value={r.id}>beyond it: {r.label}</option>)}
                  </select>
                )}
                <button type="button" className="ml-auto text-meta text-ink-500 hover:text-red-700" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        {roles.length > 0 && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <button type="button" className="text-dense font-medium text-accent-700 hover:underline" onClick={() => setLines((ls) => [...ls, { roleId: '', kind: 'COMMIT_UP_TO', types: types.some((t) => t.key === 'PRICING') ? ['PRICING'] : [], metricKey: 'ExpectedRevenue', threshold: '', currency: 'SGD', escalateTo: '' }])}>
              + Add a line
            </button>
            <label className="grid gap-1">
              <span className="helm-label">Policy reference</span>
              <input className={`${control} font-mono`} value={reference} onChange={(e) => setReference(e.target.value)} />
            </label>
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy || !valid}>
              {busy ? 'Recording…' : latest ? `Record version ${latest.version + 1}` : 'Record the policy'}
            </Button>
          </div>
        )}
      </div>
      {message && <p role="status" className={message.failed ? 'mt-3 text-dense text-red-700' : 'mt-3 text-dense text-ink-700'}>{message.text}</p>}
    </section>
  );
}
