import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { PanelCard, StatusChip, TabBar, Modal, Field, EmptyState } from '../components/ui.tsx';
import { compareAlternatives } from '../domain/engines/relevantCost.ts';
import { requiresApproval, isEditable } from '../domain/decisionStates.ts';
import { formatDate, formatMoney } from '../domain/format.ts';
import {
  decisionTypeLabels,
  financialLineKinds,
  orgRoleRank,
  type Decision,
  type DecisionAlternative,
  type FinancialLine,
  type OutcomeScore,
} from '../domain/types.ts';

const lineKindLabels: Record<FinancialLine['kind'], string> = {
  incremental_revenue: 'Incremental revenue',
  relevant_cost: 'Relevant cost',
  opportunity_cost: 'Opportunity cost',
  sunk_ignored: 'Sunk — shown, excluded',
  allocated_ignored: 'Allocated — shown, excluded',
};

type TabId = 'frame' | 'analysis' | 'scenarios' | 'governance' | 'outcome';

export function DecisionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const decision = useHelmStore((s) => s.decisions.find((d) => d.id === id));
  const [tab, setTab] = useState<TabId>('frame');
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  // Reset the transition error when the user moves tab or decision — adjusted
  // during render, per React's "adjusting state when props change" pattern.
  const errorScope = `${id}:${tab}`;
  const [prevErrorScope, setPrevErrorScope] = useState(errorScope);
  if (prevErrorScope !== errorScope) {
    setPrevErrorScope(errorScope);
    setTransitionError(null);
  }

  if (!decision) {
    return (
      <EmptyState
        title="Decision not found"
        action={
          <Link to="/decisions" className="btn-secondary">
            Back to decisions
          </Link>
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <DecisionHeader
        decision={decision}
        onTransitionError={setTransitionError}
        onApprove={() => setApproveOpen(true)}
        onReject={() => setRejectOpen(true)}
        onGoOutcome={() => setTab('outcome')}
      />
      {transitionError && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{transitionError}</p>
      )}
      <TabBar<TabId>
        tabs={[
          { id: 'frame', label: 'Frame' },
          { id: 'analysis', label: 'Analysis' },
          { id: 'scenarios', label: 'Scenarios' },
          { id: 'governance', label: 'Governance' },
          { id: 'outcome', label: 'Outcome' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'frame' && <FrameTab decision={decision} />}
      {tab === 'analysis' && <AnalysisTab decision={decision} />}
      {tab === 'scenarios' && <ScenariosTab decision={decision} />}
      {tab === 'governance' && <GovernanceTab decision={decision} />}
      {tab === 'outcome' && <OutcomeTab decision={decision} />}

      {approveOpen && <ApproveModal decision={decision} onClose={() => setApproveOpen(false)} />}
      {rejectOpen && <RejectModal decision={decision} onClose={() => setRejectOpen(false)} />}
      <p className="pb-2 text-2xs text-ink-400">
        <button className="hover:text-ink-700" onClick={() => navigate('/decisions')}>
          <ArrowLeft size={11} className="mr-1 inline" />
          All decisions
        </button>
      </p>
    </div>
  );
}

// -------------------------------------------------------------------- header

function DecisionHeader({
  decision,
  onTransitionError,
  onApprove,
  onReject,
  onGoOutcome,
}: {
  decision: Decision;
  onTransitionError: (e: string | null) => void;
  onApprove: () => void;
  onReject: () => void;
  onGoOutcome: () => void;
}) {
  const approvalRules = useHelmStore((s) => s.approvalRules);
  const myRole = useHelmStore((s) => s.myRole)();
  const transitionDecision = useHelmStore((s) => s.transitionDecision);

  const needsApproval = requiresApproval(decision.amountAtStake, decision.decisionType, approvalRules);

  const doTransition = async (to: Parameters<typeof transitionDecision>[1]) => {
    onTransitionError(await transitionDecision(decision.id, to));
  };

  const primaryActions: { label: string; onClick: () => void }[] = [];
  if (decision.status === 'draft') primaryActions.push({ label: 'Start analysis', onClick: () => void doTransition('analyzing') });
  if (decision.status === 'analyzing') {
    if (needsApproval) primaryActions.push({ label: 'Submit for approval', onClick: () => void doTransition('pending_approval') });
    else primaryActions.push({ label: 'Decide & approve', onClick: onApprove });
  }
  if (decision.status === 'pending_approval') {
    const matching = approvalRules.filter(
      (r) => r.active && (r.decisionType === null || r.decisionType === decision.decisionType) && Math.abs(decision.amountAtStake ?? 0) >= r.thresholdAmount,
    );
    const needed = matching.some((r) => r.requiredRole === 'admin') ? 'admin' : 'manager';
    if (orgRoleRank[myRole] >= orgRoleRank[needed]) {
      primaryActions.push({ label: 'Approve', onClick: onApprove });
      primaryActions.push({ label: 'Reject', onClick: onReject });
    }
  }
  if (decision.status === 'approved') primaryActions.push({ label: 'Start execution', onClick: () => void doTransition('executing') });
  if (decision.status === 'executing') primaryActions.push({ label: 'Move to monitoring', onClick: () => void doTransition('monitoring') });
  if (decision.status === 'monitoring') primaryActions.push({ label: 'Review outcome & close', onClick: onGoOutcome });
  if (decision.status === 'rejected') primaryActions.push({ label: 'Rework analysis', onClick: () => void doTransition('analyzing') });

  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-xl font-semibold">{decision.title}</h1>
          <StatusChip status={decision.status} />
        </div>
        <p className="mt-0.5 text-sm text-ink-500">
          {decisionTypeLabels[decision.decisionType]}
          {decision.amountAtStake !== null && <> · {formatMoney(decision.amountAtStake, decision.currency ?? '')} at stake</>}
          {decision.dueDate && <> · decide by {formatDate(decision.dueDate)}</>}
          {needsApproval && isEditable(decision.status) && <> · requires approval</>}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {primaryActions.map((a, i) => (
          <button key={a.label} className={i === 0 ? 'btn-primary' : 'btn-secondary'} onClick={a.onClick}>
            {a.label}
          </button>
        ))}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- frame tab

function useDraftField(initial: string, save: (v: string) => void) {
  const [value, setValue] = useState(initial);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (prevInitial !== initial) {
    setPrevInitial(initial);
    setValue(initial);
  }
  return {
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value),
    onBlur: () => {
      if (value !== initial) save(value);
    },
  };
}

function FrameTab({ decision }: { decision: Decision }) {
  const updateDecision = useHelmStore((s) => s.updateDecision);
  const editable = isEditable(decision.status);
  const save = (fields: Parameters<typeof updateDecision>[1]) => void updateDecision(decision.id, fields);

  const title = useDraftField(decision.title, (v) => save({ title: v }));
  const context = useDraftField(decision.context, (v) => save({ context: v }));
  const problem = useDraftField(decision.problem, (v) => save({ problem: v }));
  const objective = useDraftField(decision.objective, (v) => save({ objective: v }));
  const recommendation = useDraftField(decision.recommendation, (v) => save({ recommendation: v }));
  const amount = useDraftField(decision.amountAtStake?.toString() ?? '', (v) =>
    save({ amountAtStake: v === '' ? null : Number(v) }),
  );

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <PanelCard title="Framing">
          <div className="space-y-3">
            <Field label="Title">
              <input className="field-input" {...title} disabled={!editable} maxLength={300} />
            </Field>
            <Field label="Context" hint="What is going on, for a reader two years from now.">
              <textarea className="field-input min-h-24" {...context} disabled={!editable} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Problem">
                <textarea className="field-input min-h-20" {...problem} disabled={!editable} />
              </Field>
              <Field label="Objective">
                <textarea className="field-input min-h-20" {...objective} disabled={!editable} />
              </Field>
            </div>
            <Field label="Working recommendation" hint="Kept honest by the analysis tab — update it as the numbers land.">
              <textarea className="field-input min-h-20" {...recommendation} disabled={!editable} />
            </Field>
          </div>
        </PanelCard>
      </div>
      <div className="space-y-4">
        <PanelCard title="Parameters">
          <div className="space-y-3">
            <Field label={`Amount at stake (${decision.currency ?? ''})`} hint="Drives the approval threshold.">
              <input className="field-input tabular-nums" type="number" {...amount} disabled={!editable} />
            </Field>
            <Field label="Decide by">
              <input
                className="field-input"
                type="date"
                value={decision.dueDate ?? ''}
                onChange={(e) => save({ dueDate: e.target.value || null })}
                disabled={!editable}
              />
            </Field>
            <Field label="Review outcome after" hint="HELM raises a signal when this date passes.">
              <input
                className="field-input"
                type="date"
                value={decision.reviewAfter ?? ''}
                onChange={(e) => save({ reviewAfter: e.target.value || null })}
              />
            </Field>
          </div>
        </PanelCard>
        {decision.contextSnapshot && (
          <PanelCard title="Context snapshot">
            <p className="mb-2 text-2xs text-ink-400">
              Captured when the decision was framed — immutable, even as the live record changes.
            </p>
            <dl className="space-y-1 text-xs">
              {Object.entries(decision.contextSnapshot).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-ink-500">{k}</dt>
                  <dd className="text-right font-medium">{typeof v === 'number' ? v.toLocaleString('en-US') : String(v)}</dd>
                </div>
              ))}
            </dl>
          </PanelCard>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- analysis tab

function AnalysisTab({ decision }: { decision: Decision }) {
  const alternatives = useHelmStore((s) => s.alternatives.filter((a) => a.decisionId === decision.id));
  const assumptions = useHelmStore((s) => s.assumptions.filter((a) => a.decisionId === decision.id));
  const addAlternative = useHelmStore((s) => s.addAlternative);
  const addAssumption = useHelmStore((s) => s.addAssumption);
  const updateAssumption = useHelmStore((s) => s.updateAssumption);
  const removeAssumption = useHelmStore((s) => s.removeAssumption);
  const editable = isEditable(decision.status);

  const sorted = [...alternatives].sort((a, b) => a.sort - b.sort);
  const comparison = useMemo(() => compareAlternatives(sorted), [sorted]);
  const currency = decision.currency ?? '';

  return (
    <div className="space-y-4">
      {sorted.length >= 2 && (
        <PanelCard title="Incremental comparison" action={<span className="text-2xs text-ink-400">relevant costs only · sunk and allocated lines excluded</span>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-ink-100">
                  <th className="table-th">Alternative</th>
                  <th className="table-th text-right">Incremental revenue</th>
                  <th className="table-th text-right">Relevant costs</th>
                  <th className="table-th text-right">Opportunity cost</th>
                  <th className="table-th text-right">Net relevant benefit</th>
                </tr>
              </thead>
              <tbody>
                {comparison.evaluations.map((ev) => {
                  const best = ev.alternativeId === comparison.bestAlternativeId;
                  return (
                    <tr key={ev.alternativeId} className={`border-b border-ink-50 last:border-0 ${best ? 'bg-emerald-50/60' : ''}`}>
                      <td className="table-td font-medium">
                        {ev.name}
                        {best && <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-2xs font-semibold text-emerald-800">Best</span>}
                      </td>
                      <td className="table-td text-right tabular-nums">{formatMoney(ev.incrementalRevenue, currency)}</td>
                      <td className="table-td text-right tabular-nums">({formatMoney(ev.relevantCosts, currency)})</td>
                      <td className="table-td text-right tabular-nums">({formatMoney(ev.opportunityCost, currency)})</td>
                      <td className={`table-td text-right font-semibold tabular-nums ${ev.netRelevantBenefit >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                        {formatMoney(ev.netRelevantBenefit, currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {comparison.advantageOverNext !== null && comparison.bestAlternativeId !== null && (
            <p className="mt-2 text-xs text-ink-500">
              Advantage over the next-best option:{' '}
              <span className="font-semibold text-ink-800">{formatMoney(comparison.advantageOverNext, currency)}</span> — the
              cost of choosing wrong.
            </p>
          )}
        </PanelCard>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {sorted.map((alt) => (
          <AlternativeCard key={alt.id} alt={alt} currency={currency} editable={editable} />
        ))}
        {editable && (
          <button
            className="flex min-h-32 items-center justify-center gap-2 rounded-lg border border-dashed border-ink-300 text-sm font-medium text-ink-500 hover:border-accent-400 hover:text-accent-700"
            onClick={() => void addAlternative(decision.id, `Option ${String.fromCharCode(65 + sorted.length)}`)}
          >
            <Plus size={15} /> Add alternative
          </button>
        )}
      </div>

      <PanelCard
        title="Assumptions"
        action={
          editable ? (
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void addAssumption(decision.id, 'New assumption')}>
              <Plus size={13} /> Add
            </button>
          ) : undefined
        }
      >
        {assumptions.length === 0 ? (
          <p className="text-xs text-ink-400">
            No explicit assumptions yet. Every number above rests on one — write them down so the outcome review can
            test them.
          </p>
        ) : (
          <ul className="divide-y divide-ink-50">
            {assumptions.map((a) => (
              <li key={a.id} className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1 space-y-1">
                  <input
                    className="w-full bg-transparent text-sm font-medium focus:outline-none disabled:text-ink-800"
                    defaultValue={a.statement}
                    disabled={!editable}
                    onBlur={(e) => e.target.value !== a.statement && void updateAssumption(a.id, { statement: e.target.value })}
                  />
                  <input
                    className="w-full bg-transparent text-xs text-ink-500 focus:outline-none"
                    placeholder="Basis / evidence…"
                    defaultValue={a.basis}
                    disabled={!editable}
                    onBlur={(e) => e.target.value !== a.basis && void updateAssumption(a.id, { basis: e.target.value })}
                  />
                </div>
                <select
                  className="rounded border border-ink-200 px-1.5 py-1 text-2xs"
                  value={a.sensitivity}
                  disabled={!editable}
                  onChange={(e) => void updateAssumption(a.id, { sensitivity: e.target.value as typeof a.sensitivity })}
                  title="Sensitivity: how much the decision hinges on this"
                >
                  <option value="low">low sensitivity</option>
                  <option value="medium">medium sensitivity</option>
                  <option value="high">high sensitivity</option>
                </select>
                <select
                  className={`rounded border px-1.5 py-1 text-2xs ${
                    a.validated === 'failed' ? 'border-red-200 bg-red-50 text-red-700' : a.validated === 'held' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-ink-200'
                  }`}
                  value={a.validated}
                  onChange={(e) => void updateAssumption(a.id, { validated: e.target.value as typeof a.validated })}
                  title="Reviewed at close: did the assumption hold?"
                >
                  <option value="pending">unreviewed</option>
                  <option value="held">held</option>
                  <option value="failed">failed</option>
                </select>
                {editable && (
                  <button className="btn-ghost px-1.5 py-1" onClick={() => void removeAssumption(a.id)} aria-label="Remove assumption">
                    <Trash2 size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </PanelCard>
    </div>
  );
}

function AlternativeCard({ alt, currency, editable }: { alt: DecisionAlternative; currency: string; editable: boolean }) {
  const updateAlternative = useHelmStore((s) => s.updateAlternative);
  const removeAlternative = useHelmStore((s) => s.removeAlternative);

  const saveLines = (lines: FinancialLine[]) => void updateAlternative(alt.id, { financialLines: lines });

  const setLine = (i: number, patch: Partial<FinancialLine>) => {
    const lines = alt.financialLines.map((l, j) => (j === i ? { ...l, ...patch } : l));
    saveLines(lines);
  };

  return (
    <PanelCard
      title={
        <span className="flex items-center gap-2">
          <input
            className="bg-transparent font-semibold focus:outline-none"
            defaultValue={alt.name}
            disabled={!editable}
            onBlur={(e) => e.target.value !== alt.name && void updateAlternative(alt.id, { name: e.target.value })}
          />
          {alt.isRecommended && (
            <span className="rounded bg-accent-100 px-1.5 py-0.5 text-2xs font-semibold text-accent-800">Recommended</span>
          )}
        </span>
      }
      action={
        editable ? (
          <span className="flex items-center gap-1">
            <button
              className="btn-ghost px-2 py-1 text-2xs"
              onClick={() => void updateAlternative(alt.id, { isRecommended: !alt.isRecommended })}
            >
              {alt.isRecommended ? 'Unmark' : 'Recommend'}
            </button>
            <button className="btn-ghost px-1.5 py-1" onClick={() => void removeAlternative(alt.id)} aria-label="Remove alternative">
              <Trash2 size={13} />
            </button>
          </span>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <table className="w-full text-xs">
          <tbody>
            {alt.financialLines.map((l, i) => {
              const excluded = l.kind === 'sunk_ignored' || l.kind === 'allocated_ignored';
              return (
                <tr key={i} className={excluded ? 'text-ink-400' : ''}>
                  <td className="w-[45%] py-1 pr-2">
                    <input
                      className={`w-full bg-transparent focus:outline-none ${excluded ? 'line-through' : ''}`}
                      defaultValue={l.label}
                      disabled={!editable}
                      title={l.note ?? undefined}
                      onBlur={(e) => e.target.value !== l.label && setLine(i, { label: e.target.value })}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <select
                      className="w-full rounded border border-ink-200 bg-white px-1 py-0.5 text-2xs"
                      value={l.kind}
                      disabled={!editable}
                      onChange={(e) => setLine(i, { kind: e.target.value as FinancialLine['kind'] })}
                    >
                      {financialLineKinds.map((k) => (
                        <option key={k} value={k}>
                          {lineKindLabels[k]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="w-28 py-1 text-right">
                    <input
                      className={`w-full bg-transparent text-right tabular-nums focus:outline-none ${excluded ? 'line-through' : ''}`}
                      type="number"
                      defaultValue={l.amount}
                      disabled={!editable}
                      onBlur={(e) => Number(e.target.value) !== l.amount && setLine(i, { amount: Number(e.target.value) })}
                    />
                  </td>
                  {editable && (
                    <td className="w-6 py-1 text-right">
                      <button
                        className="text-ink-300 hover:text-red-600"
                        onClick={() => saveLines(alt.financialLines.filter((_, j) => j !== i))}
                        aria-label="Remove line"
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {editable && (
          <button
            className="text-2xs font-medium text-accent-700 hover:text-accent-800"
            onClick={() => saveLines([...alt.financialLines, { label: 'New line', kind: 'relevant_cost', amount: 0 }])}
          >
            + Add financial line
          </button>
        )}
        <div className="grid gap-2 text-xs">
          <LabeledText label="Qualitative" value={alt.qualitative} editable={editable} onSave={(v) => void updateAlternative(alt.id, { qualitative: v })} />
          <LabeledText label="Strategic" value={alt.strategic} editable={editable} onSave={(v) => void updateAlternative(alt.id, { strategic: v })} />
          <LabeledText label="Risks" value={alt.risks} editable={editable} onSave={(v) => void updateAlternative(alt.id, { risks: v })} />
        </div>
        <p className="text-2xs text-ink-400">
          Struck-through lines are shown for honesty but excluded from the incremental math — {currency} amounts.
        </p>
      </div>
    </PanelCard>
  );
}

function LabeledText({
  label,
  value,
  editable,
  onSave,
}: {
  label: string;
  value: string;
  editable: boolean;
  onSave: (v: string) => void;
}) {
  return (
    <div>
      <span className="field-label">{label}</span>
      <textarea
        className="field-input min-h-12 text-xs"
        defaultValue={value}
        disabled={!editable}
        onBlur={(e) => e.target.value !== value && onSave(e.target.value)}
      />
    </div>
  );
}

// ------------------------------------------------------------ scenarios tab

function ScenariosTab({ decision }: { decision: Decision }) {
  const navigate = useNavigate();
  const scenarios = useHelmStore((s) => s.scenarios.filter((sc) => sc.decisionId === decision.id));
  const createScenario = useHelmStore((s) => s.createScenario);

  const newScenario = async () => {
    const id = await createScenario({
      name: `${decision.title} — what-if`,
      decisionId: decision.id,
      baseline: {
        label: 'Baseline',
        currency: decision.currency ?? 'USD',
        unitPrice: 0,
        unitsPerPeriod: 0,
        variableCostPerUnit: 0,
        fixedCostsPerPeriod: 0,
      },
    });
    if (id) navigate(`/scenarios/${id}`);
  };

  return (
    <PanelCard
      title="Attached scenarios"
      action={
        <button className="btn-secondary px-2.5 py-1 text-xs" onClick={() => void newScenario()}>
          <Plus size={13} /> New scenario
        </button>
      }
    >
      {scenarios.length === 0 ? (
        <EmptyState
          title="No scenarios attached"
          detail="Test the high-sensitivity assumptions before deciding — price, volume, cost moves."
        />
      ) : (
        <ul className="space-y-2">
          {scenarios.map((sc) => (
            <li key={sc.id}>
              <Link
                to={`/scenarios/${sc.id}`}
                className="flex items-center justify-between rounded-md border border-ink-100 px-3 py-2 text-sm hover:border-accent-300 hover:bg-accent-50/40"
              >
                <span className="font-medium">{sc.name}</span>
                <span className="text-2xs text-ink-500">{sc.variants.length} variant{sc.variants.length === 1 ? '' : 's'}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  );
}

// ----------------------------------------------------------- governance tab

function GovernanceTab({ decision }: { decision: Decision }) {
  const approvalRules = useHelmStore((s) => s.approvalRules);
  const events = useHelmStore((s) => s.events.filter((e) => e.decisionId === decision.id));
  const actions = useHelmStore((s) => s.actions.filter((a) => a.decisionId === decision.id));
  const members = useHelmStore((s) => s.members);
  const addAction = useHelmStore((s) => s.addAction);
  const setActionStatus = useHelmStore((s) => s.setActionStatus);
  const [newAction, setNewAction] = useState({ title: '', owner: '', due: '' });

  const matching = approvalRules.filter(
    (r) => r.active && (r.decisionType === null || r.decisionType === decision.decisionType) && Math.abs(decision.amountAtStake ?? 0) >= r.thresholdAmount,
  );

  const actorLabel = (id: string) => members.find((m) => m.userId === id)?.displayName ?? 'Member';

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <PanelCard title="Approval">
          {matching.length === 0 ? (
            <p className="text-xs text-ink-500">
              No approval rule matches this decision — the owner can decide within their autonomy.
            </p>
          ) : (
            <ul className="space-y-1 text-xs">
              {matching.map((r) => (
                <li key={r.id} className="flex justify-between gap-3">
                  <span className="text-ink-600">
                    {r.decisionType ? decisionTypeLabels[r.decisionType] : 'Any decision'} ≥{' '}
                    {formatMoney(r.thresholdAmount, decision.currency ?? '')}
                  </span>
                  <span className="font-medium">requires {r.requiredRole}</span>
                </li>
              ))}
            </ul>
          )}
          {decision.approvedAt && (
            <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              Approved {formatDate(decision.approvedAt)}
              {decision.approvedBy && <> by {actorLabel(decision.approvedBy)}</>}
              {decision.decisionRationale && <> — “{decision.decisionRationale}”</>}
            </p>
          )}
          {decision.status === 'rejected' && decision.rejectedReason && (
            <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">Rejected — {decision.rejectedReason}</p>
          )}
        </PanelCard>

        <PanelCard title="Execution actions">
          {actions.length === 0 && <p className="mb-2 text-xs text-ink-400">Who does what by when once this is approved.</p>}
          <ul className="space-y-1.5">
            {actions.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-ink-950"
                  checked={a.status === 'done'}
                  onChange={(e) => void setActionStatus(a.id, e.target.checked ? 'done' : 'open')}
                  aria-label={`Mark "${a.title}" ${a.status === 'done' ? 'open' : 'done'}`}
                />
                <span className={`flex-1 ${a.status === 'done' ? 'text-ink-400 line-through' : ''}`}>{a.title}</span>
                <span className="text-2xs text-ink-500">{a.ownerLabel}</span>
                <span className="text-2xs text-ink-400">{formatDate(a.dueDate)}</span>
              </li>
            ))}
          </ul>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newAction.title) return;
              void addAction(decision.id, newAction.title, newAction.owner, newAction.due || null);
              setNewAction({ title: '', owner: '', due: '' });
            }}
          >
            <input
              className="field-input flex-1"
              placeholder="Action…"
              value={newAction.title}
              onChange={(e) => setNewAction({ ...newAction, title: e.target.value })}
            />
            <input
              className="field-input w-28"
              placeholder="Owner"
              value={newAction.owner}
              onChange={(e) => setNewAction({ ...newAction, owner: e.target.value })}
            />
            <input
              className="field-input w-36"
              type="date"
              value={newAction.due}
              onChange={(e) => setNewAction({ ...newAction, due: e.target.value })}
            />
            <button className="btn-secondary px-2.5">Add</button>
          </form>
          {(decision.memoireOpportunityId || decision.memoireAccountId) && (
            <p className="mt-2 text-2xs text-ink-400">
              On execution start, HELM appends a decision event to the linked Memoire timeline (provenance:
              helm://decision/{decision.id.slice(0, 8)}…).
            </p>
          )}
        </PanelCard>
      </div>

      <PanelCard title="Audit trail" action={<span className="text-2xs text-ink-400">append-only</span>}>
        {events.length === 0 ? (
          <p className="text-xs text-ink-400">No events yet.</p>
        ) : (
          <ol className="relative space-y-3 border-l border-ink-200 pl-4">
            {[...events]
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .map((e) => (
                <li key={e.id} className="relative">
                  <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-ink-300" />
                  <p className="text-xs font-medium text-ink-800">
                    {e.eventType.replace(/_/g, ' ')}
                    {typeof e.payload.from === 'string' && typeof e.payload.to === 'string' && (
                      <span className="text-ink-500"> — {String(e.payload.from)} → {String(e.payload.to)}</span>
                    )}
                  </p>
                  <p className="text-2xs text-ink-400">
                    {formatDate(e.createdAt)} · {e.actorLabel ?? actorLabel(e.actorId)}
                    {typeof e.payload.rationale === 'string' && <> · “{String(e.payload.rationale)}”</>}
                    {typeof e.payload.reason === 'string' && <> · {String(e.payload.reason)}</>}
                  </p>
                </li>
              ))}
          </ol>
        )}
      </PanelCard>
    </div>
  );
}

// -------------------------------------------------------------- outcome tab

function OutcomeTab({ decision }: { decision: Decision }) {
  const updateDecision = useHelmStore((s) => s.updateDecision);
  const transitionDecision = useHelmStore((s) => s.transitionDecision);
  const alternatives = useHelmStore((s) => s.alternatives.filter((a) => a.decisionId === decision.id));
  const [actual, setActual] = useState(decision.actualOutcome);
  const [score, setScore] = useState<OutcomeScore | ''>(decision.outcomeScore ?? '');
  const [lesson, setLesson] = useState(decision.lesson);
  const [error, setError] = useState<string | null>(null);

  const chosen = alternatives.find((a) => a.id === decision.decidedAlternativeId);
  const canClose = decision.status === 'monitoring';

  const close = async () => {
    if (!score) {
      setError('Score the outcome before closing.');
      return;
    }
    setError(await transitionDecision(decision.id, 'closed', { actualOutcome: actual, outcomeScore: score, lesson }));
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PanelCard title="Expected">
        {chosen && (
          <p className="mb-2 text-xs text-ink-600">
            Chosen alternative: <span className="font-semibold">{chosen.name}</span>
          </p>
        )}
        <p className="whitespace-pre-wrap text-sm">{decision.expectedOutcome || <span className="text-ink-400">No expected outcome was written down.</span>}</p>
        {decision.expectedMetrics.length > 0 && (
          <table className="mt-3 w-full text-xs">
            <thead>
              <tr className="border-b border-ink-100">
                <th className="table-th">Metric</th>
                <th className="table-th">Expected</th>
                <th className="table-th">Actual</th>
              </tr>
            </thead>
            <tbody>
              {decision.expectedMetrics.map((m, i) => (
                <tr key={i} className="border-b border-ink-50 last:border-0">
                  <td className="table-td">{m.metric}</td>
                  <td className="table-td">{m.expected}</td>
                  <td className="table-td">
                    <input
                      className="w-full bg-transparent focus:outline-none"
                      defaultValue={m.actual ?? ''}
                      placeholder="—"
                      onBlur={(e) => {
                        const next = decision.expectedMetrics.map((x, j) => (j === i ? { ...x, actual: e.target.value } : x));
                        void updateDecision(decision.id, { expectedMetrics: next });
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </PanelCard>

      <PanelCard title="Actual & lesson">
        <div className="space-y-3">
          <Field label="What actually happened">
            <textarea className="field-input min-h-20" value={actual} onChange={(e) => setActual(e.target.value)} />
          </Field>
          <Field label="Against expectation">
            <select className="field-input" value={score} onChange={(e) => setScore(e.target.value as OutcomeScore)}>
              <option value="">—</option>
              <option value="better">Better than expected</option>
              <option value="as_expected">As expected</option>
              <option value="worse">Worse than expected</option>
              <option value="mixed">Mixed</option>
            </select>
          </Field>
          <Field label="Lesson" hint="What the organization should do differently next time. This feeds Decision Memory.">
            <textarea className="field-input min-h-20" value={lesson} onChange={(e) => setLesson(e.target.value)} />
          </Field>
          {error && <p className="text-xs text-red-600">{error}</p>}
          {canClose ? (
            <button className="btn-primary" onClick={() => void close()}>
              Close decision with this outcome
            </button>
          ) : decision.status === 'closed' ? (
            <p className="text-xs text-ink-400">Closed {formatDate(decision.closedAt)} — the record is final.</p>
          ) : (
            <p className="text-xs text-ink-400">The outcome can be closed once the decision reaches monitoring.</p>
          )}
        </div>
      </PanelCard>
    </div>
  );
}

// ------------------------------------------------------------------- modals

function ApproveModal({ decision, onClose }: { decision: Decision; onClose: () => void }) {
  const alternatives = useHelmStore((s) => s.alternatives.filter((a) => a.decisionId === decision.id));
  const updateDecision = useHelmStore((s) => s.updateDecision);
  const transitionDecision = useHelmStore((s) => s.transitionDecision);
  const comparison = useMemo(() => compareAlternatives(alternatives), [alternatives]);
  const [alternativeId, setAlternativeId] = useState(
    decision.decidedAlternativeId ??
      alternatives.find((a) => a.isRecommended)?.id ??
      comparison.bestAlternativeId ??
      alternatives[0]?.id ??
      '',
  );
  const [rationale, setRationale] = useState('');
  const [expected, setExpected] = useState(decision.expectedOutcome);
  const [reviewAfter, setReviewAfter] = useState(decision.reviewAfter ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateDecision(decision.id, { expectedOutcome: expected, reviewAfter: reviewAfter || null });
    const err = await transitionDecision(decision.id, 'approved', {
      decidedAlternativeId: alternativeId || null,
      decisionRationale: rationale,
    });
    if (err) setError(err);
    else onClose();
  };

  return (
    <Modal title="Approve decision" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Chosen alternative">
          <select className="field-input" value={alternativeId} onChange={(e) => setAlternativeId(e.target.value)}>
            {alternatives.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.id === comparison.bestAlternativeId ? ' (best by relevant cost)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rationale" hint="Why this option — recorded in the audit trail forever.">
          <textarea className="field-input min-h-16" required value={rationale} onChange={(e) => setRationale(e.target.value)} />
        </Field>
        <Field label="Expected outcome" hint="What success looks like. The outcome review judges against this.">
          <textarea className="field-input min-h-16" required value={expected} onChange={(e) => setExpected(e.target.value)} />
        </Field>
        <Field label="Review outcome after">
          <input className="field-input" type="date" value={reviewAfter} onChange={(e) => setReviewAfter(e.target.value)} />
        </Field>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary">Approve</button>
        </div>
      </form>
    </Modal>
  );
}

function RejectModal({ decision, onClose }: { decision: Decision; onClose: () => void }) {
  const transitionDecision = useHelmStore((s) => s.transitionDecision);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = await transitionDecision(decision.id, 'rejected', { rejectedReason: reason });
    if (err) setError(err);
    else onClose();
  };

  return (
    <Modal title="Reject decision" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Reason" hint="Sent back for rework with this note.">
          <textarea className="field-input min-h-16" required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-danger">Reject</button>
        </div>
      </form>
    </Modal>
  );
}
