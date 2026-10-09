/**
 * Decision authoring — the management acts that put a decision on the table and take it off.
 *
 * Until the 2026-10-09 audit nothing in the app could frame a decision: the decision runtime had createDecision,
 * alternatives, criteria, assumptions and commit, and no page called any of them, so a real organization could read
 * the decision loop and never enter it. Everything here is a person's act, recorded through the runtime with their
 * name on it. HELM writes no question, proposes no alternative, sets no threshold and chooses nothing; it only
 * says, before committing, what the runtime will refuse and why.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  decisionTransitions,
  type CriterionStyle,
  type DecisionState,
  type DecisionTriggerType,
  type DecisionWorkspace,
  type ReadinessReport,
} from '@helm/decision-runtime';
import type { Scenario, ScenarioRun } from '@helm/scenario-runtime';
import type { UserId } from '@helm/shared';
import type { DecisionWorkspaceContext } from '../../services/decisionRuntime.ts';
import { valueMetrics } from '../../services/ontologyGraph.ts';
import { Modal } from '../ui/Modal.tsx';
import { Field, controlClass } from '../ui/Field.tsx';
import { Button } from '../ui/Button.tsx';
import { SectionHead } from '../ui/SectionHead.tsx';
import { cn } from '../../lib/cn.ts';

export type Author = { readonly label: string; readonly userId: UserId | null };

type Simulated = { readonly scenario: Scenario; readonly run: ScenarioRun };

/** Scenarios with a completed simulation — the only ones an alternative can be bound to. */
function useSimulatedScenarios(ctx: DecisionWorkspaceContext): Simulated[] | null {
  const [list, setList] = useState<Simulated[] | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const { runtime, scope } = ctx.scenarios;
      const [scenarios, runs] = await Promise.all([runtime.listScenarios(scope), runtime.listRuns(scope)]);
      if (!live) return;
      if (!scenarios.ok || !runs.ok) {
        setList([]);
        return;
      }
      const out: Simulated[] = [];
      for (const s of scenarios.value.filter((x) => x.status !== 'ARCHIVED' && x.status !== 'INVALIDATED')) {
        const run = runs.value.filter((r) => r.scenarioId === s.id && r.status !== 'RUNNING').at(-1);
        if (run) out.push({ scenario: s, run });
      }
      setList(out);
    })();
    return () => {
      live = false;
    };
  }, [ctx]);
  return list;
}

const TRIGGERS: readonly { value: DecisionTriggerType; label: string }[] = [
  { value: 'MANUAL', label: 'raised by management' },
  { value: 'OPPORTUNITY', label: 'an opportunity' },
  { value: 'RISK', label: 'a risk' },
  { value: 'ISSUE', label: 'an issue' },
  { value: 'PLANNED_REVIEW', label: 'a planned review' },
  { value: 'STRATEGIC_INITIATIVE', label: 'a strategic initiative' },
  { value: 'EXCEPTION', label: 'an exception' },
];

const asMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ======================================================== framing a decision

export function FrameDecisionModal({
  ctx,
  author,
  onClose,
  onFramed,
}: {
  ctx: DecisionWorkspaceContext;
  author: Author;
  onClose: () => void;
  onFramed: (decisionId: string) => void;
}) {
  const scenarios = useSimulatedScenarios(ctx);
  const [question, setQuestion] = useState('');
  const [title, setTitle] = useState('');
  const [trigger, setTrigger] = useState<DecisionTriggerType>('MANUAL');
  const [decideBy, setDecideBy] = useState('');
  const [bound, setBound] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = question.trim().length < 12;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = (scenarios ?? []).filter((s) => bound.has(s.scenario.id));
      const created = await ctx.runtime.createDecision(ctx.scope, {
        title: title.trim() || question.trim().slice(0, 80),
        managementQuestion: question.trim(),
        triggerType: trigger,
        triggerRefs: chosen.map((s) => ({ kind: 'SCENARIO' as const, ref: s.scenario.id, label: s.scenario.name })),
        owner: { kind: 'PERSON', label: author.label, userId: author.userId },
        horizon: decideBy ? { decisionDeadline: new Date(`${decideBy}T00:00:00.000Z`).toISOString() } : undefined,
      });
      if (!created.ok) {
        setError(created.error.message);
        return;
      }
      // Each scenario chosen here becomes an alternative bound to its latest simulation — the futures it decides between.
      for (const s of chosen) {
        const alt = await ctx.runtime.addAlternative(ctx.scope, created.value.revision.id, { label: s.scenario.name, scenarioId: s.scenario.id });
        if (!alt.ok) {
          setError(`The decision was framed, but ${s.scenario.name} could not be bound: ${alt.error.message}`);
          onFramed(created.value.decision.id);
          return;
        }
      }
      onFramed(created.value.decision.id);
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Frame a decision" onClose={onClose} wide>
      <form
        className="grid gap-[14px]"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="The management question" hint='A question, not a topic: "How should we price the Tailin renewal given the competing quote?", not "Pricing".'>
          <textarea className={controlClass} rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} required minLength={12} autoFocus />
        </Field>
        <div className="grid gap-[14px] sm:grid-cols-2">
          <Field label="Short title" hint="optional — the question's first words otherwise">
            <input className={controlClass} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="What raised it">
            <select className={controlClass} value={trigger} onChange={(e) => setTrigger(e.target.value as DecisionTriggerType)}>
              {TRIGGERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Decide by" hint="optional">
            <input type="date" className={controlClass} value={decideBy} onChange={(e) => setDecideBy(e.target.value)} />
          </Field>
          <Field label="Owner">
            <input className={controlClass} value={author.label} readOnly />
          </Field>
        </div>
        <div className="grid gap-[6px]">
          <span className="text-meta font-medium text-ink-600">The futures it would choose between</span>
          {scenarios === null && <span className="text-meta text-ink-500">Reading the simulated scenarios…</span>}
          {scenarios !== null && scenarios.length === 0 && (
            <span className="text-meta text-ink-500">
              No scenario has been simulated yet. You can frame the question now and bind alternatives later, once their futures are branched on{' '}
              <a href="/scenarios" className="text-accent-700 underline">Scenarios</a>.
            </span>
          )}
          {(scenarios ?? []).map((s) => (
            <label key={s.scenario.id} className="inline-flex items-center gap-2 text-dense">
              <input
                type="checkbox"
                checked={bound.has(s.scenario.id)}
                onChange={() =>
                  setBound((b) => {
                    const next = new Set(b);
                    if (next.has(s.scenario.id)) next.delete(s.scenario.id);
                    else next.add(s.scenario.id);
                    return next;
                  })
                }
              />
              {s.scenario.name} <span className="font-mono text-meta text-ink-500">run {s.run.id.slice(0, 8)}</span>
            </label>
          ))}
        </div>
        <p className="text-meta text-ink-500">HELM records the question and the futures; it does not decide, and it does not write the question for you.</p>
        {error && <p role="alert" className="text-dense text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || tooShort}>
            {busy ? 'Framing…' : 'Frame the decision'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ================================================ preparing an open decision

type Panel = 'alternative' | 'criterion' | 'assumption' | 'assess' | 'commit' | null;

/** The measurable metrics a criterion may read, by name. */
const CRITERION_METRICS = ['ExpectedRevenue', 'OpportunityValue', 'OpportunityProbability', 'GrossMargin', 'GrossMarginPct', 'CashImpact', 'RevenueAtRisk', 'DemandCoverage'];

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'criterion';

export function DecisionAuthoring({
  ctx,
  workspace,
  author,
  onChanged,
}: {
  ctx: DecisionWorkspaceContext;
  workspace: DecisionWorkspace;
  author: Author;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { revision, decision } = workspace;
  // Where the preparation stands is management's to say: DRAFT → INVESTIGATING / MODELLING → READY_FOR_DECISION. Only
  // READY_FOR_DECISION can be committed, and commit itself is the step to COMMITTED, so it is not offered here.
  const moves = decisionTransitions[decision.state].filter((s) => s !== 'COMMITTED');
  const readable = (s: DecisionState) => s.replaceAll('_', ' ').toLowerCase();

  /** Runs one act, then reloads the workspace; a refusal is shown in the runtime's own words. */
  const act = async (what: string, fn: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await fn();
      if (!r.ok) setError(r.error?.message ?? 'Refused.');
      else {
        setDone(what);
        setOpen(null);
        onChanged();
      }
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const tab = (key: Exclude<Panel, null>, label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setOpen(open === key ? null : key)}
      aria-expanded={open === key}
      className={cn('rounded-full border px-3 py-1 text-meta transition-colors ease-helm', open === key ? 'border-ink-950 bg-ink-950 text-paper' : 'border-ink-300 text-ink-700 hover:bg-ink-100')}
    >
      {label}
    </button>
  );

  return (
    <section className="mt-10">
      <SectionHead title="Prepare the decision" meta={`r${revision.revisionNumber} · draft`} caveat="each act is yours, recorded with your name" />
      <ReadinessLine readiness={workspace.readiness} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-dense text-ink-700">
          It is <span className="font-mono">{readable(decision.state)}</span>
          {decision.state !== 'READY_FOR_DECISION' ? ' — only a decision marked ready for decision can be committed.' : ' — it can be committed.'}
        </span>
        {moves.map((m) => (
          <Button key={m} size="sm" variant={m === 'READY_FOR_DECISION' ? 'primary' : 'secondary'} disabled={busy} onClick={() => void act(`Marked ${readable(m)}.`, () => ctx.runtime.setState(ctx.scope, decision.id, m))}>
            {m === 'CANCELLED' ? 'Cancel the decision' : `Mark ${readable(m)}`}
          </Button>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {tab('alternative', '+ Alternative')}
        {tab('criterion', '+ Criterion')}
        {tab('assumption', '+ Assumption')}
        {workspace.criteria.some((c) => c.style === 'QUALITATIVE') && tab('assess', 'Assess')}
        {tab('commit', 'Commit')}
      </div>
      <div className="mt-4">
        {open === 'alternative' && <AlternativeForm ctx={ctx} busy={busy} onSubmit={(input) => act('Alternative added.', () => ctx.runtime.addAlternative(ctx.scope, revision.id, input))} />}
        {open === 'criterion' && <CriterionForm ctx={ctx} busy={busy} author={author} onSubmit={(input) => act('Criterion written down.', () => ctx.runtime.addCriterion(ctx.scope, revision.id, input))} />}
        {open === 'assumption' && <AssumptionForm busy={busy} author={author} onSubmit={(input) => act('Assumption written down.', () => ctx.runtime.addAssumption(ctx.scope, revision.id, input))} />}
        {open === 'assess' && <AssessForm workspace={workspace} busy={busy} author={author} onSubmit={(input) => act('Assessment recorded.', () => ctx.runtime.recordAssessment(ctx.scope, input))} />}
        {open === 'commit' && <CommitForm workspace={workspace} busy={busy} author={author} onSubmit={(input) => act('Committed.', () => ctx.runtime.commit(ctx.scope, revision.id, input))} />}
      </div>
      {busy && <p className="mt-3 text-dense text-ink-600">Recording it…</p>}
      {done && !busy && <p className="mt-3 text-dense text-ink-700">{done}</p>}
      {error && <p role="alert" className="mt-3 text-dense text-red-700">{error}</p>}
    </section>
  );
}

function ReadinessLine({ readiness }: { readiness: ReadinessReport }) {
  const blocking = readiness.gaps.filter((g) => g.severity === 'BLOCKING');
  if (blocking.length === 0) return <p className="mt-3 text-dense text-ink-600">Nothing blocks a commitment. What management chooses, and why, is recorded when it happens.</p>;
  return (
    <div className="mt-3">
      <p className="text-dense text-ink-700">Before it can be committed:</p>
      <ul className="mt-1 grid gap-1">
        {blocking.map((g) => (
          <li key={g.code + (g.alternativeId ?? '')} className="text-dense text-red-700">
            {g.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FormShell({ children, onSubmit, busy, label }: { children: ReactNode; onSubmit: () => void; busy: boolean; label: string }) {
  return (
    <form
      className="grid gap-[14px] rounded-xl border border-ink-200 bg-white p-5 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
      <div className="flex justify-end sm:col-span-2">
        <Button size="sm" variant="primary" type="submit" disabled={busy}>
          {label}
        </Button>
      </div>
    </form>
  );
}

function AlternativeForm({
  ctx,
  busy,
  onSubmit,
}: {
  ctx: DecisionWorkspaceContext;
  busy: boolean;
  onSubmit: (input: { label: string; description?: string; scenarioId?: string | null; unmodelledReason?: string | null }) => void;
}) {
  const scenarios = useSimulatedScenarios(ctx);
  const [label, setLabel] = useState('');
  const [scenarioId, setScenarioId] = useState('');
  const [reason, setReason] = useState('');
  const chosen = scenarios?.find((s) => s.scenario.id === scenarioId) ?? null;
  return (
    <FormShell
      busy={busy}
      label="Add the alternative"
      onSubmit={() =>
        onSubmit({
          label: label.trim() || chosen?.scenario.name || '',
          scenarioId: scenarioId || null,
          unmodelledReason: scenarioId ? null : reason.trim() || 'No scenario is bound yet, so this alternative has no computed future state.',
        })
      }
    >
      <Field label="Its future" className="sm:col-span-2" hint="bind a simulated scenario, or leave it unmodelled and say why">
        <select className={controlClass} value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
          <option value="">— unmodelled: no computed future —</option>
          {(scenarios ?? []).map((s) => (
            <option key={s.scenario.id} value={s.scenario.id}>
              {s.scenario.name} · run {s.run.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Name it" className="sm:col-span-2">
        <input className={controlClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={chosen?.scenario.name ?? 'Keep the current price'} required={!chosen} />
      </Field>
      {!scenarioId && (
        <Field label="Why it has no modelled future" className="sm:col-span-2">
          <input className={controlClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Not modelled yet — the inputs it would change are not in the model." />
        </Field>
      )}
    </FormShell>
  );
}

function CriterionForm({
  ctx,
  busy,
  author,
  onSubmit,
}: {
  ctx: DecisionWorkspaceContext;
  busy: boolean;
  author: Author;
  onSubmit: (input: Parameters<DecisionWorkspaceContext['runtime']['addCriterion']>[2]) => void;
}) {
  const [name, setName] = useState('');
  const [style, setStyle] = useState<CriterionStyle>('TARGET');
  const [metricKey, setMetricKey] = useState('ExpectedRevenue');
  const [subject, setSubject] = useState('');
  const [threshold, setThreshold] = useState('');
  const [direction, setDirection] = useState<'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER' | 'NONE'>('HIGHER_IS_BETTER');
  const [rationale, setRationale] = useState('');
  const [required, setRequired] = useState(true);
  const [positions, setPositions] = useState<string[]>([]);
  const qualitative = style === 'QUALITATIVE';
  const metric = valueMetrics.metric(metricKey);

  // Which position the criterion reads: in a real organization a metric sits on many subjects, and the first one is
  // an arbitrary one. The reader names it; HELM matches it by the position's label.
  useEffect(() => {
    if (qualitative) return;
    let live = true;
    void ctx.scenarios.graphs.valueGraph.findValueNodes(ctx.scope, { metricKeys: [metricKey], limit: 1000 }).then((r) => {
      if (!live) return;
      const subjects = r.ok ? [...new Set(r.value.map((n) => n.label.split(' — ').slice(1).join(' — ')).filter(Boolean))].sort() : [];
      setPositions(subjects);
    });
    return () => {
      live = false;
    };
  }, [ctx, metricKey, qualitative]);
  const subjectOk = qualitative || positions.length <= 1 || subject.trim().length > 0;

  return (
    <FormShell
      busy={busy || !subjectOk}
      label="Write the criterion down"
      onSubmit={() =>
        onSubmit({
          key: slug(name),
          name: name.trim(),
          style,
          required,
          metricKey: qualitative ? null : metricKey,
          subjectHint: qualitative ? null : subject.trim() || null,
          threshold: style === 'TARGET' || style === 'HARD_CONSTRAINT' ? threshold.trim() || null : null,
          unit: qualitative ? null : (metric?.unitType ?? null),
          direction,
          author: { kind: 'PERSON', label: author.label, userId: author.userId },
          rationale: rationale.trim(),
        })
      }
    >
      <Field label="What matters" className="sm:col-span-2">
        <input className={controlClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Expected revenue on the Tailin deal" required />
      </Field>
      <Field label="How it is judged">
        <select className={controlClass} value={style} onChange={(e) => setStyle(e.target.value as CriterionStyle)}>
          <option value="TARGET">a target to reach</option>
          <option value="HARD_CONSTRAINT">a line that must hold</option>
          <option value="PREFERENCE">a direction, no line</option>
          <option value="QUALITATIVE">judged by a person</option>
        </select>
      </Field>
      <Field label="Better is">
        <select className={controlClass} value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
          <option value="HIGHER_IS_BETTER">higher</option>
          <option value="LOWER_IS_BETTER">lower</option>
          <option value="NONE">neither</option>
        </select>
      </Field>
      {!qualitative && (
        <>
          <Field label="It reads">
            <select className={controlClass} value={metricKey} onChange={(e) => { setMetricKey(e.target.value); setSubject(''); }}>
              {CRITERION_METRICS.map((k) => (
                <option key={k} value={k}>
                  {valueMetrics.metric(k)?.name ?? k}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`On which position${positions.length > 0 ? ` · ${positions.length}` : ''}`} hint={positions.length === 0 ? 'no position carries it yet — it will read UNKNOWN until one does' : undefined}>
            <input className={controlClass} list="criterion-positions" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={positions[0] ?? ''} required={positions.length > 1} />
            <datalist id="criterion-positions">
              {positions.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>
          {(style === 'TARGET' || style === 'HARD_CONSTRAINT') && (
            <Field label={`The line${metric ? ` · ${metric.unitType}` : ''}`}>
              <input className={controlClass + ' font-mono'} value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="20000" required inputMode="decimal" />
            </Field>
          )}
        </>
      )}
      <Field label="Why it matters" className="sm:col-span-2" hint="a criterion is someone's, with a reason — never a system default">
        <input className={controlClass} value={rationale} onChange={(e) => setRationale(e.target.value)} required minLength={8} />
      </Field>
      <label className="inline-flex items-center gap-2 text-dense sm:col-span-2">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> required before committing
      </label>
    </FormShell>
  );
}

function AssumptionForm({
  busy,
  author,
  onSubmit,
}: {
  busy: boolean;
  author: Author;
  onSubmit: (input: Parameters<DecisionWorkspaceContext['runtime']['addAssumption']>[2]) => void;
}) {
  const [statement, setStatement] = useState('');
  const [owner, setOwner] = useState(author.label);
  const [criticality, setCriticality] = useState<'CRITICAL' | 'MATERIAL' | 'MINOR'>('MATERIAL');
  const [confidence, setConfidence] = useState('0.6');
  return (
    <FormShell
      busy={busy}
      label="Write the assumption down"
      onSubmit={() =>
        onSubmit({
          statement: statement.trim(),
          owner: { kind: 'PERSON', label: owner.trim() || author.label, userId: owner.trim() === author.label ? author.userId : null },
          criticality,
          confidence: confidence === '' ? null : Number(confidence),
          source: 'management',
        })
      }
    >
      <Field label="What this rests on" className="sm:col-span-2">
        <input className={controlClass} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="Tailin confirms the renewal before the end of the quarter." required minLength={8} />
      </Field>
      <Field label="Who stands behind it">
        <input className={controlClass} value={owner} onChange={(e) => setOwner(e.target.value)} required />
      </Field>
      <Field label="If it is wrong">
        <select className={controlClass} value={criticality} onChange={(e) => setCriticality(e.target.value as typeof criticality)}>
          <option value="CRITICAL">the choice changes</option>
          <option value="MATERIAL">the outcome changes materially</option>
          <option value="MINOR">little changes</option>
        </select>
      </Field>
      <Field label="Confidence (0–1)">
        <input className={controlClass + ' font-mono'} value={confidence} onChange={(e) => setConfidence(e.target.value)} inputMode="decimal" />
      </Field>
    </FormShell>
  );
}

/** A person's judgement of one alternative against one qualitative criterion, with a reason. HELM never makes one. */
function AssessForm({
  workspace,
  busy,
  author,
  onSubmit,
}: {
  workspace: DecisionWorkspace;
  busy: boolean;
  author: Author;
  onSubmit: (input: Parameters<DecisionWorkspaceContext['runtime']['recordAssessment']>[1]) => void;
}) {
  const criteria = workspace.criteria.filter((c) => c.style === 'QUALITATIVE');
  const alternatives = workspace.alternatives.filter((a) => a.status !== 'WITHDRAWN');
  const [criterionId, setCriterionId] = useState(criteria[0]?.id ?? '');
  const [alternativeId, setAlternativeId] = useState(alternatives[0]?.id ?? '');
  const [rating, setRating] = useState<'STRONG_SUPPORT' | 'SUPPORT' | 'NEUTRAL' | 'CONCERN' | 'STRONG_CONCERN'>('NEUTRAL');
  const [rationale, setRationale] = useState('');
  return (
    <FormShell
      busy={busy}
      label="Record the assessment"
      onSubmit={() => onSubmit({ criterionId, alternativeId, rating, rationale: rationale.trim(), author: { kind: 'PERSON', label: author.label, userId: author.userId } })}
    >
      <Field label="Criterion">
        <select className={controlClass} value={criterionId} onChange={(e) => setCriterionId(e.target.value)}>
          {criteria.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Alternative">
        <select className={controlClass} value={alternativeId} onChange={(e) => setAlternativeId(e.target.value)}>
          {alternatives.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Your judgement" className="sm:col-span-2">
        <select className={controlClass} value={rating} onChange={(e) => setRating(e.target.value as typeof rating)}>
          <option value="STRONG_SUPPORT">strongly supports it</option>
          <option value="SUPPORT">supports it</option>
          <option value="NEUTRAL">neither</option>
          <option value="CONCERN">raises a concern</option>
          <option value="STRONG_CONCERN">raises a strong concern</option>
        </select>
      </Field>
      <Field label="Why" className="sm:col-span-2">
        <input className={controlClass} value={rationale} onChange={(e) => setRationale(e.target.value)} required minLength={8} />
      </Field>
    </FormShell>
  );
}

function CommitForm({
  workspace,
  busy,
  author,
  onSubmit,
}: {
  workspace: DecisionWorkspace;
  busy: boolean;
  author: Author;
  onSubmit: (input: Parameters<DecisionWorkspaceContext['runtime']['commit']>[2]) => void;
}) {
  const candidates = useMemo(() => workspace.alternatives.filter((a) => a.status !== 'WITHDRAWN'), [workspace]);
  const [chosen, setChosen] = useState(candidates[0]?.id ?? '');
  const [summary, setSummary] = useState('');
  const [why, setWhy] = useState('');
  const [tradeOff, setTradeOff] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const openChallenges = workspace.challenges.filter((c) => c.status === 'OPEN');
  const notReadyState = workspace.decision.state !== 'READY_FOR_DECISION';
  const blocked = workspace.readiness.state === 'NOT_READY' || notReadyState;
  const choice = candidates.find((a) => a.id === chosen);
  return (
    <FormShell
      busy={busy || blocked || (openChallenges.length > 0 && !acknowledge)}
      label={`Commit as ${author.label}`}
      onSubmit={() =>
        onSubmit({
          chosenAlternativeId: chosen,
          authorship: 'MANAGEMENT_AUTHORED',
          committedByLabel: author.label,
          summary: summary.trim(),
          rationale: [{ kind: 'JUDGEMENT', ref: null, label: 'Management judgement', statement: why.trim() }],
          acceptedTradeOffs: tradeOff.trim() ? [{ label: 'Accepted trade-off', statement: tradeOff.trim(), criterionId: null, metricKey: null, givenUp: null, inFavourOf: choice?.label ?? null }] : [],
          acknowledgeOpenChallenges: openChallenges.length > 0 ? acknowledge : undefined,
        })
      }
    >
      {workspace.readiness.state === 'NOT_READY' && <p className="text-dense text-red-700 sm:col-span-2">This decision is not ready: the gaps above block a commitment.</p>}
      {notReadyState && <p className="text-dense text-red-700 sm:col-span-2">Mark it ready for decision above first; a commitment is made from that state only.</p>}
      <Field label="The alternative management chooses" className="sm:col-span-2">
        <select className={controlClass} value={chosen} onChange={(e) => setChosen(e.target.value)}>
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} · {a.status.toLowerCase()}
            </option>
          ))}
        </select>
      </Field>
      <Field label="In one sentence" className="sm:col-span-2">
        <input className={controlClass} value={summary} onChange={(e) => setSummary(e.target.value)} required minLength={8} />
      </Field>
      <Field label="Why this one" className="sm:col-span-2">
        <textarea className={controlClass} rows={2} value={why} onChange={(e) => setWhy(e.target.value)} required minLength={8} />
      </Field>
      <Field label="What management accepts by choosing it" className="sm:col-span-2" hint="optional — what is given up">
        <input className={controlClass} value={tradeOff} onChange={(e) => setTradeOff(e.target.value)} />
      </Field>
      {openChallenges.length > 0 && (
        <label className="inline-flex items-start gap-2 text-dense text-red-700 sm:col-span-2">
          <input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} className="mt-1" />
          {openChallenges.length} challenge{openChallenges.length === 1 ? ' is' : 's are'} still open. Commit over {openChallenges.length === 1 ? 'it' : 'them'}, on the record.
        </label>
      )}
      <p className="text-meta text-ink-500 sm:col-span-2">
        The commitment is sealed with what was on the table and carries no authority verdict: whether you were allowed to make it is judged apart, in Governance.
      </p>
    </FormShell>
  );
}
