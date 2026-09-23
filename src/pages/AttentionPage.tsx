import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCheck, EyeOff } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { PanelCard, SeverityBadge, EmptyState, Stat, Modal, Field } from '../components/ui.tsx';
import { buildMarginLadder } from '../domain/engines/economics.ts';
import { formatMoney, formatPercent } from '../domain/format.ts';
import type { Signal } from '../domain/types.ts';
import { resolveDecisionContext } from '../services/decisionRuntime.ts';

/**
 * Attention: the answer to "what requires me in the next ten minutes".
 *
 * Open signals by severity and a thin health strip. A signal is not a
 * decision: framing one as a management question is a human act, so the only
 * thing HELM does here is carry the signal across as the TRIGGER of a decision
 * somebody then has to frame.
 */
export function AttentionPage() {
  const navigate = useNavigate();
  const signals = useHelmStore((s) => s.signals);
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);
  const costObjects = useHelmStore((s) => s.costObjects);
  const economics = useHelmStore((s) => s.economics);
  const currency = useHelmStore((s) => s.currency)();
  const setSignalStatus = useHelmStore((s) => s.setSignalStatus);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [framing, setFraming] = useState<Signal | null>(null);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);

  const openSignals = signals.filter((x) => x.status === 'open' || x.status === 'acknowledged');

  const scope = useMemo(
    () => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null),
    [mode, activeOrgId, userId, myRole],
  );

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

  /** Carries the signal across as a decision TRIGGER. It frames nothing itself. */
  const frameDecision = async () => {
    if (!framing || !scope) return;
    setBusy(true);
    setFrameError(null);
    try {
      const ctx = await resolveDecisionContext(mode ?? 'demo', scope);
      if (!ctx) throw new Error('The decision runtime is unavailable in this mode.');
      const created = await ctx.runtime.createDecision(scope, {
        title: framing.title,
        managementQuestion: question.trim(),
        context: `What ${framing.ruleCode} saw when it fired:\n${framing.evidence
          .map((e) => `• ${e.label}: ${e.value}`)
          .join('\n')}`,
        problem: framing.reason,
        triggerType: 'SIGNAL',
        triggerRefs: [{ kind: 'SIGNAL', ref: framing.id, label: `${framing.ruleCode} — ${framing.title}` }],
      });
      if (!created.ok) throw new Error(created.error.message);
      setFraming(null);
      navigate(`/decisions/${created.value.decision.id}`);
    } catch (e) {
      setFrameError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Attention</h1>
          <p className="text-sm text-ink-500">
            {openSignals.length === 0
              ? 'Nothing is on fire.'
              : `${openSignals.length} signal${openSignals.length === 1 ? '' : 's'} need a manager.`}
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
          <Stat label="Open signals" value={openSignals.length} />
        </div>
      )}

      <PanelCard title="Signals" action={<span className="text-2xs text-ink-400">deterministic rules · every signal shows its evidence</span>}>
        {openSignals.length === 0 ? (
          <EmptyState
            title="No open signals"
            detail="The rule engine found nothing above threshold. Signals appear when economics, inventory or capacity cross their limits."
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
                    <button
                      className="btn-primary px-2.5 py-1 text-xs"
                      onClick={() => {
                        setFraming(sg);
                        setQuestion('');
                        setFrameError(null);
                      }}>
                      Frame a decision
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

      {framing && (
        <Modal title="Frame a decision" onClose={() => setFraming(null)}>
          <p className="text-xs text-ink-600">
            The signal becomes the trigger. What management is actually deciding is a question only a person can write,
            so HELM asks for it rather than inventing one.
          </p>
          <p className="mt-2 rounded-md border border-ink-200 bg-ink-50 px-2 py-1.5 text-2xs text-ink-600">
            {framing.ruleCode} · {framing.title}
          </p>
          <Field label="Management question">
            <input
              className="field-input"
              autoFocus
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="How should we …?"
            />
          </Field>
          {frameError && <p className="mt-1 text-xs text-red-700">{frameError}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setFraming(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || question.trim().length < 12}
              onClick={() => void frameDecision()}>
              Open the decision
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
