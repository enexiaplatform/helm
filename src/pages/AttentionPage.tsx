import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { MetricList, type Metric } from '../components/ui/MetricList.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { Field, controlClass } from '../components/ui/Field.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { SignalArticle, type SignalView } from '../components/attention/SignalArticle.tsx';
import { SignalLine } from '../components/attention/SignalLine.tsx';
import { buildMarginLadder } from '../domain/engines/economics.ts';
import { formatMoney, formatPercent } from '../domain/format.ts';
import type { Signal, SignalSeverity } from '../domain/types.ts';
import { displayDate, resolveDecisionContext } from '../services/decisionRuntime.ts';
import { loadDecisionSummaries, type DecisionSummary } from '../services/decisionWorkspace.ts';

/**
 * Attention: the answer to "what requires me in the next ten minutes".
 *
 * The headline says it in words; critical signals get a full editorial row,
 * lesser ones a single line. A signal is not a decision: framing one as a
 * management question is a human act, so the only thing HELM does here is
 * carry the signal across as the TRIGGER of a decision somebody then has to
 * frame.
 */

const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const word = (n: number) => NUM[n] ?? String(n);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "13.5B VND" → figure and unit, so the unit can sit in mono beside a serif figure. */
function splitMoney(text: string): { value: string; unit?: string } {
  const i = text.lastIndexOf(' ');
  return i > 0 ? { value: text.slice(0, i), unit: text.slice(i + 1) } : { value: text };
}

const toView = (s: Signal): SignalView => ({
  id: s.id,
  severity: s.severity,
  ruleCode: s.ruleCode,
  status: s.status === 'acknowledged' ? 'acknowledged' : 'open',
  title: s.title,
  reason: s.reason,
  thresholdLabel: s.thresholdLabel,
  measuredLabel: s.measuredLabel,
  evidence: s.evidence.map((e) => ({ label: e.label, value: e.value })),
});

const SEVERITY_ORDER: SignalSeverity[] = ['warning', 'watch', 'info'];

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
  const [framing, setFraming] = useState<Signal | null>(null);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<DecisionSummary[]>([]);

  const live = signals.filter((x) => x.status === 'open' || x.status === 'acknowledged');
  const critical = live.filter((s) => s.severity === 'critical');
  const rest = live
    .filter((s) => s.severity !== 'critical')
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  // One signal open at a time; the first critical one opens on arrival.
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  const expanded = open === undefined ? (critical[0]?.id ?? null) : open;
  const toggle = (id: string) => setOpen(expanded === id ? null : id);

  const scope = useMemo(
    () => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null),
    [mode, activeOrgId, userId, myRole],
  );

  useEffect(() => {
    if (!scope) return;
    let live = true;
    void (async () => {
      try {
        const ctx = await resolveDecisionContext(mode ?? 'demo', scope);
        if (!ctx || !live) return;
        const all = await loadDecisionSummaries(ctx);
        if (live) setInFlight(all.filter((d) => d.committed && !d.reviewedAt));
      } catch {
        // The aside is a convenience; the signals above stand without it.
        if (live) setInFlight([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope]);

  const health = useMemo((): Metric[] | null => {
    const company = costObjects.find((c) => c.kind === 'company');
    if (!company) return null;
    const units = costObjects.filter((c) => c.kind === 'business_unit');
    const ladders = units.map((u) => buildMarginLadder(u, economics));
    const revenue = ladders.reduce((s, l) => s + l.revenue, 0);
    const cm = ladders.reduce((s, l) => s + l.contributionMargin, 0);
    const segment = ladders.reduce((s, l) => s + l.segmentMargin, 0);
    return [
      { label: 'Revenue', ...splitMoney(formatMoney(revenue, currency)) },
      {
        label: 'Contribution margin',
        sub: revenue > 0 ? `${formatPercent(cm / revenue)} of revenue` : undefined,
        ...splitMoney(formatMoney(cm, currency)),
      },
      { label: 'Segment margin', tone: segment >= 0 ? 'good' : 'bad', ...splitMoney(formatMoney(segment, currency)) },
    ];
  }, [costObjects, economics, currency]);

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

  const startFraming = (id: string) => {
    const s = live.find((x) => x.id === id);
    if (!s) return;
    setFraming(s);
    setQuestion('');
    setFrameError(null);
  };
  const acknowledge = (s: Signal) =>
    s.status === 'open' ? () => void setSignalStatus(s.id, 'acknowledged') : undefined;
  const dismiss = (s: Signal) => () => void setSignalStatus(s.id, 'dismissed');

  const headline =
    live.length === 0
      ? 'Nothing needs a manager right now.'
      : critical.length === 0
        ? `Nothing cannot wait. ${word(rest.length)} ${plural(rest.length, 'signal needs', 'signals need')} a look this week.`
        : `${word(critical.length)} ${plural(critical.length, 'signal cannot', 'signals cannot')} wait.` +
          (rest.length > 0 ? ` ${word(rest.length)} ${plural(rest.length, 'needs', 'need')} a look this week.` : '');

  const restMeta = SEVERITY_ORDER.map((sev) => [sev, rest.filter((s) => s.severity === sev).length] as const)
    .filter(([, n]) => n > 0)
    .map(([sev, n]) => `${sev} · ${n}`)
    .join(' · ');

  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <>
      <PageHeader
        kicker={`Management · Attention · ${today}`}
        title={headline}
        lede="Every signal is a deterministic rule that crossed its threshold. Each one carries the rule, the measurement and the evidence that tripped it."
      />
      <div className="mt-9 flex flex-wrap items-start gap-10">
        <div className="grid min-w-0 flex-[1_1_560px] gap-9">
          {live.length === 0 && (
            <EmptyState
              title="No open signals"
              detail="The rule engine found nothing above threshold. Signals appear when economics, inventory or capacity cross their limits."
            />
          )}
          {critical.length > 0 && (
            <section>
              <SectionHead dot="critical" title="Cannot wait" meta={`critical · ${critical.length}`} />
              {critical.map((s) => (
                <SignalArticle
                  key={s.id}
                  signal={toView(s)}
                  expanded={expanded === s.id}
                  onToggle={() => toggle(s.id)}
                  onFrame={() => startFraming(s.id)}
                  onAcknowledge={acknowledge(s)}
                  onDismiss={dismiss(s)}
                />
              ))}
            </section>
          )}
          {rest.length > 0 && (
            <section>
              <SectionHead dot="warning" title="This week" meta={restMeta} />
              {rest.map((s) => (
                <SignalLine
                  key={s.id}
                  signal={toView(s)}
                  expanded={expanded === s.id}
                  onToggle={() => toggle(s.id)}
                  onFrame={() => startFraming(s.id)}
                  onAcknowledge={acknowledge(s)}
                  onDismiss={dismiss(s)}
                />
              ))}
            </section>
          )}
        </div>
        <aside className="grid max-w-[360px] flex-[1_1_280px] gap-7">
          {health && (
            <MetricList title="The enterprise, last 3 months" kind={{ label: 'Actual', tone: 'actual' }} metrics={health} />
          )}
          <div>
            <h2 className="mb-1 text-panel">Decisions in flight</h2>
            <p className="helm-caveat mb-[10px]">what management has already committed to</p>
            {inFlight.length === 0 ? (
              <p className="text-dense text-ink-500">Nothing is committed and awaiting its review.</p>
            ) : (
              <div className="grid gap-2">
                {inFlight.map((d) => (
                  <Link
                    key={d.decision.id}
                    to={`/decisions/${d.decision.id}`}
                    className="grid gap-1 rounded-xl border border-ink-200 bg-white px-4 py-[14px] text-ink-950 no-underline hover:border-ink-300 hover:text-ink-950 hover:no-underline"
                  >
                    <span className="text-ui font-semibold">{d.decision.title}</span>
                    {d.chosenLabel && <span className="text-meta text-ink-600">Committed to {d.chosenLabel}</span>}
                    <span className="helm-meta">
                      review {displayDate(d.decision.horizon.reviewDate)} · {d.decision.owner?.label ?? 'no owner'}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {framing && (
        <Modal title="Frame a decision" onClose={() => setFraming(null)}>
          <p className="text-base text-ink-700">
            The signal becomes the trigger. What management is actually deciding is a question only a person can write,
            so HELM asks for it rather than inventing one.
          </p>
          <p className="helm-meta border-y border-ink-200 py-2">
            {framing.ruleCode} · {framing.title}
          </p>
          <Field label="Management question">
            <input
              className={controlClass}
              autoFocus
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="How should we …?"
            />
          </Field>
          {frameError && <p className="text-dense text-red-700">{frameError}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setFraming(null)}>Cancel</Button>
            <Button variant="primary" disabled={busy || question.trim().length < 12} onClick={() => void frameDecision()}>
              Open the decision
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
