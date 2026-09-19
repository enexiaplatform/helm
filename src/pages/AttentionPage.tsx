import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCheck, EyeOff } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { PanelCard, SeverityBadge, StatusChip, EmptyState, Stat } from '../components/ui.tsx';
import { buildMarginLadder } from '../domain/engines/economics.ts';
import { formatMoney, formatDate, formatPercent } from '../domain/format.ts';
import type { Signal } from '../domain/types.ts';
import { decisionTypeLabels } from '../domain/types.ts';

/**
 * Attention: the answer to "what requires me in the next ten minutes".
 * Open signals ranked by severity, decisions waiting on the user, and a thin
 * health strip — deliberately not a dashboard.
 */
export function AttentionPage() {
  const navigate = useNavigate();
  const signals = useHelmStore((s) => s.signals);
  const decisions = useHelmStore((s) => s.decisions);
  const costObjects = useHelmStore((s) => s.costObjects);
  const economics = useHelmStore((s) => s.economics);
  const currency = useHelmStore((s) => s.currency)();
  const setSignalStatus = useHelmStore((s) => s.setSignalStatus);
  const createDecision = useHelmStore((s) => s.createDecision);
  const [expanded, setExpanded] = useState<string | null>(null);

  const openSignals = signals.filter((x) => x.status === 'open' || x.status === 'acknowledged');

  const needsMe = useMemo(() => {
    const waiting = decisions.filter((d) => d.status === 'pending_approval');
    const inFlight = decisions.filter((d) => d.status === 'analyzing' || d.status === 'draft');
    const reviewDue = decisions.filter(
      (d) =>
        (d.status === 'monitoring' || d.status === 'executing') &&
        d.reviewAfter !== null &&
        new Date(d.reviewAfter) <= new Date(),
    );
    return { waiting, inFlight, reviewDue };
  }, [decisions]);

  const health = useMemo(() => {
    const company = costObjects.find((c) => c.kind === 'company');
    if (!company) return null;
    const units = costObjects.filter((c) => c.kind === 'business_unit');
    const ladders = units.map((u) => buildMarginLadder(u, economics));
    const revenue = ladders.reduce((s, l) => s + l.revenue, 0);
    const cm = ladders.reduce((s, l) => s + l.contributionMargin, 0);
    const segment = ladders.reduce((s, l) => s + l.segmentMargin, 0);
    return { revenue, cm, cmRatio: revenue > 0 ? cm / revenue : null, segment };
  }, [costObjects, economics]);

  const convertSignal = async (sg: Signal) => {
    const id = await createDecision({
      decisionType: sg.suggestedDecisionType ?? 'custom',
      title: sg.title,
      context: `${sg.reason}\n\nEvidence at detection:\n${sg.evidence.map((e) => `• ${e.label}: ${e.value}`).join('\n')}`,
      problem: sg.reason,
      signalId: sg.id,
    });
    if (id) navigate(`/decisions/${id}`);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Attention</h1>
          <p className="text-sm text-ink-500">
            {openSignals.length === 0
              ? 'Nothing is on fire.'
              : `${openSignals.length} signal${openSignals.length === 1 ? '' : 's'} and ${
                  needsMe.waiting.length + needsMe.reviewDue.length
                } decision item${needsMe.waiting.length + needsMe.reviewDue.length === 1 ? '' : 's'} need a manager.`}
          </p>
        </div>
      </header>

      {health && (
        <div className="grid grid-cols-2 gap-4 rounded-lg border border-ink-200 bg-white px-5 py-4 shadow-panel sm:grid-cols-4">
          <Stat label="Revenue (3 mo)" value={formatMoney(health.revenue, currency)} />
          <Stat
            label="Contribution margin"
            value={formatMoney(health.cm, currency)}
            sub={health.cmRatio !== null ? `${formatPercent(health.cmRatio)} of revenue` : undefined}
          />
          <Stat label="Segment margin" value={formatMoney(health.segment, currency)} tone={health.segment >= 0 ? 'good' : 'bad'} />
          <Stat label="Open decisions" value={decisions.filter((d) => !['closed', 'rejected'].includes(d.status)).length} />
        </div>
      )}

      <PanelCard title="Signals" action={<span className="text-2xs text-ink-400">deterministic rules · every signal shows its evidence</span>}>
        {openSignals.length === 0 ? (
          <EmptyState
            title="No open signals"
            detail="The rule engine found nothing above threshold. Signals appear when economics, inventory, capacity, or decision reviews cross their limits."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {openSignals.map((sg) => (
              <li key={sg.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-3">
                  <SeverityBadge severity={sg.severity} />
                  <div className="min-w-0 flex-1">
                    <button
                      className="text-left text-sm font-medium text-ink-950 hover:text-accent-700"
                      onClick={() => setExpanded(expanded === sg.id ? null : sg.id)}
                    >
                      {sg.title}
                    </button>
                    <p className="mt-0.5 text-xs text-ink-500">{sg.reason}</p>
                    {expanded === sg.id && (
                      <div className="mt-2 rounded-md border border-ink-100 bg-ink-50 p-3 text-xs">
                        <p className="mb-1 text-2xs text-ink-400">
                          Rule <span className="font-mono font-semibold text-ink-600">{sg.ruleCode}</span> · threshold:{' '}
                          {sg.thresholdLabel} · measured: {sg.measuredLabel}
                        </p>
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                          {sg.evidence.map((e) => (
                            <div key={e.label}>
                              <dt className="text-2xs text-ink-400">{e.label}</dt>
                              <dd className="font-medium tabular-nums">{e.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button className="btn-primary px-2.5 py-1 text-xs" onClick={() => void convertSignal(sg)}>
                      Open decision
                      <ArrowRight size={13} />
                    </button>
                    {sg.status === 'open' && (
                      <button
                        className="btn-ghost px-2 py-1 text-xs"
                        title="Acknowledge — keep visible, I have seen it"
                        onClick={() => void setSignalStatus(sg.id, 'acknowledged')}
                      >
                        <CheckCheck size={14} />
                      </button>
                    )}
                    <button
                      className="btn-ghost px-2 py-1 text-xs"
                      title="Dismiss"
                      onClick={() => void setSignalStatus(sg.id, 'dismissed')}
                    >
                      <EyeOff size={14} />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PanelCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <PanelCard title="Waiting for approval">
          {needsMe.waiting.length === 0 ? (
            <p className="text-xs text-ink-400">Nothing pending.</p>
          ) : (
            <ul className="space-y-2">
              {needsMe.waiting.map((d) => (
                <li key={d.id}>
                  <Link
                    to={`/decisions/${d.id}`}
                    className="flex items-center justify-between gap-3 rounded-md border border-ink-100 px-3 py-2 hover:border-accent-300 hover:bg-accent-50/40"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{d.title}</p>
                      <p className="text-2xs text-ink-500">
                        {decisionTypeLabels[d.decisionType]}
                        {d.amountAtStake !== null && <> · {formatMoney(d.amountAtStake, d.currency ?? '')} at stake</>}
                        {d.dueDate && <> · due {formatDate(d.dueDate)}</>}
                      </p>
                    </div>
                    <StatusChip status={d.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </PanelCard>

        <PanelCard title="Reviews due & analysis in flight">
          {needsMe.reviewDue.length === 0 && needsMe.inFlight.length === 0 ? (
            <p className="text-xs text-ink-400">Nothing in flight.</p>
          ) : (
            <ul className="space-y-2">
              {[...needsMe.reviewDue, ...needsMe.inFlight].map((d) => (
                <li key={d.id}>
                  <Link
                    to={`/decisions/${d.id}`}
                    className="flex items-center justify-between gap-3 rounded-md border border-ink-100 px-3 py-2 hover:border-accent-300 hover:bg-accent-50/40"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{d.title}</p>
                      <p className="text-2xs text-ink-500">
                        {needsMe.reviewDue.includes(d)
                          ? `Outcome review due since ${formatDate(d.reviewAfter)}`
                          : decisionTypeLabels[d.decisionType]}
                      </p>
                    </div>
                    <StatusChip status={d.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </PanelCard>
      </div>
    </div>
  );
}
