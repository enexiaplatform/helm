import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { PanelCard, StatusChip, EmptyState, Modal, Field } from '../components/ui.tsx';
import { formatDate, formatMoney } from '../domain/format.ts';
import {
  decisionTypeLabels,
  decisionTypes,
  type DecisionType,
} from '../domain/types.ts';

const templateHints: Record<DecisionType, string> = {
  pricing: 'Discounts, list changes, deal pricing. Watch the price ladder, not just this deal.',
  special_order: 'Below-list one-off volume. Relevant when capacity is idle; opportunity cost when it is not.',
  make_or_buy: 'Insource vs outsource a component or service. Avoided cost vs purchase cost plus freed capacity.',
  keep_or_drop: 'Segment, product, or customer exit. Segment margin decides — never allocated overhead.',
  hire_or_outsource: 'Permanent vs flexible capacity for a demand step.',
  replace_or_retain: 'Equipment or supplier replacement. Old book value is sunk.',
  investment: 'Capital commitment against a hurdle rate.',
  inventory_commitment: 'Stock builds and service-level changes. Stock-out cost vs carrying and expiry cost.',
  resource_allocation: 'People, budget, or capacity across competing uses.',
  market_entry_exit: 'Entering or leaving a market or channel.',
  custom: 'Any structured decision that deserves alternatives, assumptions, and a recorded outcome.',
};

export function DecisionsPage() {
  const navigate = useNavigate();
  const decisions = useHelmStore((s) => s.decisions);
  const memoireOpportunities = useHelmStore((s) => s.memoireOpportunities);
  const createDecision = useHelmStore((s) => s.createDecision);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<'active' | 'all' | 'closed'>('active');
  const [template, setTemplate] = useState<DecisionType>('pricing');
  const [title, setTitle] = useState('');
  const [fromOpportunity, setFromOpportunity] = useState<string>('');

  const visible = useMemo(() => {
    const sorted = [...decisions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (filter === 'all') return sorted;
    if (filter === 'closed') return sorted.filter((d) => d.status === 'closed' || d.status === 'rejected');
    return sorted.filter((d) => d.status !== 'closed' && d.status !== 'rejected');
  }, [decisions, filter]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const opp = memoireOpportunities.find((o) => o.id === fromOpportunity);
    const id = await createDecision({
      decisionType: template,
      title: title || (opp ? `${opp.accountName}: ${opp.title}` : decisionTypeLabels[template]),
      amountAtStake: opp?.value ?? null,
      memoireOpportunityId: opp?.id ?? null,
      memoireAccountId: opp?.accountId ?? null,
      contextSnapshot: opp
        ? {
            source: 'memoire',
            account: opp.accountName,
            opportunity: opp.title,
            value: opp.value,
            currency: opp.currency,
            stage: opp.stage,
            capturedAt: new Date().toISOString(),
          }
        : null,
      context: opp
        ? `From Memoire: ${opp.accountName} — ${opp.title} (${opp.stage}), value ${
            opp.value !== null ? formatMoney(opp.value, opp.currency) : 'unknown'
          }. Snapshot captured at analysis time; the live record stays in Memoire.`
        : undefined,
    });
    setCreating(false);
    if (id) navigate(`/decisions/${id}`);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Decisions</h1>
          <p className="text-sm text-ink-500">Durable decision records — context, alternatives, assumptions, outcome.</p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          <Plus size={15} />
          New decision
        </button>
      </header>

      <div className="flex gap-1">
        {(['active', 'closed', 'all'] as const).map((f) => (
          <button
            key={f}
            className={`rounded-md px-3 py-1 text-xs font-medium ${
              filter === f ? 'bg-ink-950 text-white' : 'text-ink-500 hover:bg-ink-100'
            }`}
            onClick={() => setFilter(f)}
          >
            {f === 'active' ? 'Active' : f === 'closed' ? 'Closed & rejected' : 'All'}
          </button>
        ))}
      </div>

      <PanelCard>
        {visible.length === 0 ? (
          <EmptyState
            title="No decisions here yet"
            detail="Open one from a signal on the Attention page, or start from a template."
            action={
              <button className="btn-primary" onClick={() => setCreating(true)}>
                <Plus size={15} /> New decision
              </button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-ink-100">
                  <th className="table-th">Decision</th>
                  <th className="table-th">Type</th>
                  <th className="table-th">At stake</th>
                  <th className="table-th">Owner</th>
                  <th className="table-th">Due</th>
                  <th className="table-th">Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((d) => (
                  <tr key={d.id} className="border-b border-ink-50 last:border-0 hover:bg-ink-50/60">
                    <td className="table-td">
                      <Link to={`/decisions/${d.id}`} className="font-medium text-ink-950 hover:text-accent-700">
                        {d.title}
                      </Link>
                      {d.memoireOpportunityId !== null || d.contextSnapshot?.source === 'memoire-demo' ? (
                        <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-2xs font-medium text-ink-500">
                          Memoire
                        </span>
                      ) : null}
                    </td>
                    <td className="table-td text-ink-600">{decisionTypeLabels[d.decisionType]}</td>
                    <td className="table-td tabular-nums">
                      {d.amountAtStake !== null ? formatMoney(d.amountAtStake, d.currency ?? '') : '—'}
                    </td>
                    <td className="table-td text-ink-600">{d.ownerLabel ?? '—'}</td>
                    <td className="table-td text-ink-600">{formatDate(d.dueDate)}</td>
                    <td className="table-td">
                      <StatusChip status={d.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelCard>

      {creating && (
        <Modal title="New decision" onClose={() => setCreating(false)} wide>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <span className="field-label">Template</span>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {decisionTypes.map((t) => (
                  <button
                    type="button"
                    key={t}
                    onClick={() => setTemplate(t)}
                    className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                      template === t
                        ? 'border-accent-500 bg-accent-50 text-ink-950'
                        : 'border-ink-200 text-ink-600 hover:border-ink-300'
                    }`}
                  >
                    <span className="block font-semibold">{decisionTypeLabels[t]}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-ink-500">{templateHints[template]}</p>
            </div>
            <Field label="Title">
              <input
                className="field-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={decisionTypeLabels[template]}
                maxLength={300}
              />
            </Field>
            {memoireOpportunities.length > 0 && (
              <Field
                label="Pull context from Memoire (optional)"
                hint="Stores a reference plus an immutable snapshot of what you saw — the live record stays in Memoire."
              >
                <select className="field-input" value={fromOpportunity} onChange={(e) => setFromOpportunity(e.target.value)}>
                  <option value="">No linked opportunity</option>
                  {memoireOpportunities.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.accountName} — {o.title}
                      {o.value !== null ? ` (${formatMoney(o.value, o.currency)})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="btn-primary">Create draft</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
