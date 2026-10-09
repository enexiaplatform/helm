/**
 * Management reviews — the operating cadence.
 *
 * A weekly, monthly, quarterly or strategic review is a first-class object that
 * binds the opening twin state, what changed since the previous review, attention,
 * decisions, commitments, assumptions, outcomes, learning and the closing twin state
 * — by reference, prepared from the kernel and never retyped into a slide. What is
 * left open is carried forward as the same objects; a closed review stays exactly
 * what management saw, and HELM can prove it.
 *
 * A review binds; it never decides. Deciding, committing and governing happen in
 * their own instruments.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { cadences, type Cadence, type ProjectedReviews, type ReviewPack, type ReviewView } from '@helm/review-runtime';
import { parsePeriodText, periodContaining, periodKey, quarterPeriod, type Period } from '@helm/shared';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { packForViewer, reproduce, resolveReviewContext, reviewsForViewer, statusTone, type ReviewContext } from '../services/reviewRuntime.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { ReaderSelect } from '../components/ui/ReaderSelect.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { FactRow } from '../components/ui/FactRow.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { Button } from '../components/ui/Button.tsx';
import { PackView } from '../components/review/PackView.tsx';
import { IntelligencePanel } from '../components/intelligence/IntelligencePanel.tsx';
import { CouncilPanel } from '../components/intelligence/CouncilPanel.tsx';
import { cn } from '../lib/cn.ts';

const stamp = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

type Which = 'PREPARATION' | 'CLOSING';

/** The twin reads value state by quarter: a month reads its quarter, a year its four. */
function quartersOf(p: Period): string[] {
  if (p.grain === 'QUARTER') return [periodKey(p)];
  if (p.grain === 'YEAR') {
    const y = new Date(p.start).getUTCFullYear();
    return ([1, 2, 3, 4] as const).map((q) => periodKey(quarterPeriod(y, q)));
  }
  return [periodKey(periodContaining(p.start, 'QUARTER'))];
}

function OpenForm({ ctx, onOpened }: { ctx: ReviewContext; onOpened: (id: string) => void }) {
  const current = periodKey(periodContaining(new Date(), 'QUARTER'));
  const [cadence, setCadence] = useState<Cadence>('QUARTERLY');
  const [title, setTitle] = useState('');
  const [period, setPeriod] = useState(current);
  const [err, setErr] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const field = 'rounded-lg border border-ink-200 bg-white px-3 py-2 text-ui';
  const parsed = parsePeriodText(period);
  const reads = parsed.ok ? quartersOf(parsed.value) : null;
  const submit = async () => {
    const scopeOf = ctx.genome.causal.twin.scopes[0];
    if (!scopeOf) return;
    if (!parsed.ok) {
      setErr(parsed.error.message);
      return;
    }
    setOpening(true);
    setErr(null);
    try {
      const r = await ctx.review.openReview(ctx.scope, { title, cadence, periodLabel: periodKey(parsed.value), periods: reads ?? undefined, scope: scopeOf, grantedUnitIds: ctx.genome.causal.twin.units.filter((u) => u.parentId === null).map((u) => u.id), openedByLabel: ctx.mode === 'demo' ? 'Country GM Vietnam (demo)' : 'Reviewer' });
      if (r.ok) onOpened(r.value.review.id);
      else setErr(r.error.message);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className="mt-4 grid gap-3">
      <p className="text-dense text-ink-600">Opening a review composes the twin state now, prepares the pack from the kernel and carries forward what the previous review of this scope left open.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1"><span className="helm-label">Cadence</span><select className={field} value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>{cadences.map((c) => <option key={c} value={c}>{c.toLowerCase()}</option>)}</select></label>
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1"><span className="helm-label">Period</span><input className={field} placeholder={current} value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
        <label className="grid min-w-[220px] flex-1 gap-1"><span className="helm-label">Title</span><input className={field} placeholder={`${cadence.charAt(0)}${cadence.slice(1).toLowerCase()} business review — ${current}`} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <Button variant="secondary" onClick={() => void submit()} disabled={opening || !title.trim() || !period.trim()}>{opening ? 'Opening the review…' : 'Open the review'}</Button>
      </div>
      <p className={cn('font-mono text-meta', parsed.ok ? 'text-ink-500' : 'text-red-700')}>
        {parsed.ok ? `period ${periodKey(parsed.value)} · the opening state reads value state for ${reads!.join(', ')}` : parsed.error.message}
      </p>
      {opening && <p className="text-dense text-ink-600">Composing the twin state and preparing the pack from the kernel…</p>}
      {err && <p role="alert" className="text-dense text-red-700">{err}</p>}
    </div>
  );
}

function OpenReviewActions({ ctx, v, onChanged }: { ctx: ReviewContext; v: ReviewView; onChanged: () => void }) {
  const [question, setQuestion] = useState('');
  const [summary, setSummary] = useState('');
  const [disp, setDisp] = useState<Record<string, 'RESOLVED' | 'CARRIED_FORWARD' | 'DROPPED'>>({});
  const [err, setErr] = useState<string | null>(null);
  const field = 'w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-ui';
  const label = () => (ctx.mode === 'demo' ? 'Country GM Vietnam (demo)' : 'Reviewer');
  const raise = async () => {
    const r = await ctx.review.addItem(ctx.scope, v.review.id, { kind: 'QUESTION', note: question });
    if (r.ok) {
      setQuestion('');
      setErr(null);
      onChanged();
    } else setErr(r.error.message);
  };
  const close = async () => {
    const r = await ctx.review.closeReview(ctx.scope, v.review.id, { summary, closedByLabel: label(), dispositions: v.items.map((i) => ({ itemId: i.id, disposition: disp[i.id] ?? 'RESOLVED', reason: disp[i.id] === 'CARRIED_FORWARD' ? 'Carried to the next review.' : disp[i.id] === 'DROPPED' ? 'Not pursued.' : 'Addressed in this review.' })) });
    if (r.ok) {
      setErr(null);
      onChanged();
    } else setErr(r.error.message);
  };
  return (
    <div className="mt-6 grid gap-4">
      <div className="grid gap-2">
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1"><span className="helm-label">Raise a question</span><input className={field} value={question} onChange={(e) => setQuestion(e.target.value)} /></label>
        <div><Button variant="secondary" size="sm" onClick={() => void raise()} disabled={question.trim().length < 8}>Raise it</Button></div>
      </div>
      <div className="grid gap-2">
        <p className="helm-label">Close the review — every item is resolved, carried forward or dropped</p>
        {v.items.map((i) => (
          <label key={i.id} className="flex flex-wrap items-baseline gap-3 text-dense">
            <select className="rounded-lg border border-ink-200 bg-white px-2 py-1 text-meta" value={disp[i.id] ?? 'RESOLVED'} onChange={(e) => setDisp((d) => ({ ...d, [i.id]: e.target.value as 'RESOLVED' | 'CARRIED_FORWARD' | 'DROPPED' }))}>
              <option value="RESOLVED">resolved</option>
              <option value="CARRIED_FORWARD">carry forward</option>
              <option value="DROPPED">drop</option>
            </select>
            <span className="font-mono text-meta text-ink-500">{i.kind}</span>
            <span className="text-ink-900">{i.ref?.label ?? i.note}</span>
          </label>
        ))}
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1"><span className="helm-label">What management concluded</span><textarea className={field} rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
        <div><Button variant="secondary" size="sm" onClick={() => void close()} disabled={!summary.trim()}>Close the review</Button></div>
      </div>
      {err && <p role="alert" className="text-dense text-red-700">{err}</p>}
    </div>
  );
}

export function ReviewsPage() {
  const mode = useHelmStore((st) => st.mode);
  const activeOrgId = useHelmStore((st) => st.activeOrgId);
  const userId = useHelmStore((st) => st.userId);
  const myRole = useHelmStore((st) => st.myRole);
  const scope = useMemo(() => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null), [mode, activeOrgId, userId, myRole]);

  const [ctx, setCtx] = useState<ReviewContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerKey, setViewerKey] = useState('');
  const [lensKey, setLensKey] = useState('now');
  const [selected, setSelected] = useState<string | null>(null);
  const [which, setWhich] = useState<Which>('PREPARATION');
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ key: string; value: ProjectedReviews } | null>(null);
  const [packState, setPackState] = useState<{ key: string; pack: ReviewPack | null; withheld: number; statement: string } | null>(null);
  const [repro, setRepro] = useState<{ key: string; lines: string[] } | null>(null);

  useEffect(() => {
    let live = true;
    if (!scope) return;
    void (async () => {
      try {
        const c = await resolveReviewContext(mode ?? 'demo', scope);
        if (!c) throw new Error('Management reviews are unavailable in this mode.');
        if (!live) return;
        setCtx(c);
        setViewerKey(c.viewers.find((v) => v.key === 'countryGM')?.key ?? c.viewers[0]?.key ?? '');
        if (c.story) setSelected(c.story.second.review.id);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope]);

  const viewer = ctx?.viewers.find((v) => v.key === viewerKey)?.viewer ?? null;
  const lens = ctx?.lenses.find((l) => l.key === lensKey)?.lens ?? null;
  const key = `${viewerKey}|${lensKey}|${tick}`;

  useEffect(() => {
    let live = true;
    if (!ctx || !viewer) return;
    void (async () => {
      try {
        const p = await reviewsForViewer(ctx, viewer, lens);
        if (live) setState({ key, value: p });
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ctx, viewer, lens, key]);

  const projected = state && state.key === key ? state.value : null;
  const chosen: ReviewView | null = projected?.reviews.find((r) => r.review.id === selected) ?? null;
  const packKey = `${key}|${chosen?.review.id ?? ''}|${which}`;

  useEffect(() => {
    let live = true;
    if (!ctx || !viewer || !chosen) return;
    void (async () => {
      try {
        const p = await packForViewer(ctx, chosen.review.id, which, viewer);
        if (live) setPackState({ key: packKey, ...p });
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ctx, viewer, chosen, which, packKey]);

  if (error) return <EmptyState title="Management reviews could not be opened" detail={error} />;
  if (!ctx || !viewer) return <p className="text-ui text-ink-500">Reading the management reviews…</p>;

  const pack = packState && packState.key === packKey ? packState : null;
  const select = 'max-w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-ui';
  const runRepro = async () => {
    if (!chosen) return;
    const lines: string[] = [];
    for (const w of ['PREPARATION', 'CLOSING'] as const) {
      if (w === 'CLOSING' && chosen.status === 'OPEN') continue;
      const r = await reproduce(ctx, chosen.review.id, w);
      lines.push(`${w === 'PREPARATION' ? 'Preparation' : 'Closing'} — ${r.identical ? 'IDENTICAL' : 'DIFFERS'}: stored ${r.storedFingerprint} · recomputed ${r.recomputedFingerprint}. ${r.statement}`);
    }
    setRepro({ key: chosen.review.id, lines });
  };
  const openReview = projected?.reviews.find((r) => r.status === 'OPEN') ?? null;

  return (
    <>
      <PageHeader
        kicker="Management · Review loop"
        size="title"
        title={
          projected && projected.reviews.length > 0
            ? `${projected.reviews.length} review${projected.reviews.length === 1 ? '' : 's'} on record${openReview ? `; ${openReview.review.periodLabel} is open` : '; none is open'}. What was open at the last one has been carried forward, not retyped.`
            : 'No review is on record yet. The first one opens with the twin state as it stands.'
        }
        lede="A review is prepared from the kernel — what changed, what needs attention, what decisions are needed, which commitments are off-track, what was learned — so nobody rebuilds it in a slide. It records what management touched, by reference; deciding, committing and governing happen in their own instruments."
      />

      {ctx.story && (
        <Notice tone="neutral" label="Demo management reviews" className="mt-6">
          Review 1 was lived alongside the Rohto decision in September 2026; Review 2 follows it in April 2027, after the outcome, the causal evidence, the episode, its pattern and the counterfactual review exist. Illustrative; every record is labelled DEMO.
        </Notice>
      )}

      <div className="mt-6 flex flex-wrap items-end gap-4">
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1"><span className="helm-label">Read as</span><ReaderSelect className={select} viewers={ctx.viewers} value={viewerKey} onChange={setViewerKey} /></label>
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1"><span className="helm-label">As known on</span><select className={select} value={lensKey} onChange={(e) => setLensKey(e.target.value)}>{ctx.lenses.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</select></label>
      </div>

      <div className="mt-9 flex flex-wrap gap-10">
        <div className="min-w-0 flex-[1_1_560px]">
          <section>
            <SectionHead title="Reviews" meta={projected ? `${projected.reviews.length} visible · ${projected.withheld} withheld` : '…'} caveat="a review is read whole or not at all" />
            {projected && projected.withheld > 0 && <p className="mt-3 text-dense text-ink-600">{projected.statement}</p>}
            <ul>
              {(projected?.reviews ?? []).map((v) => (
                <li key={v.review.id} className={cn('cursor-pointer border-b border-ink-200 py-3 transition-colors duration-160 ease-helm hover:bg-ink-50', selected === v.review.id && 'bg-ink-50')} onClick={() => setSelected(v.review.id)}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Pill tone={statusTone(v.status)}>{v.status}</Pill>
                    <span className="font-mono text-tag uppercase text-ink-500">{v.review.cadence}</span>
                    <span className="text-dense text-ink-900">{v.review.title}</span>
                  </div>
                  <p className="mt-1 font-mono text-meta text-ink-500">
                    {v.review.periodLabel} · opened {stamp(v.review.openingLens.recordedThrough)}{v.closure ? ` · closed ${stamp(v.closure.closingLens.recordedThrough)}` : ''} · {v.items.length} item(s){v.previous ? ` · follows ${v.previous.periodLabel}` : ' · first review'}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          {chosen && (
            <section className="mt-10">
              <SectionHead title="Prepared from the kernel" meta={chosen.review.periodLabel} caveat="kernel order — never ranked" />
              <div className="mt-3 flex gap-2">
                {(['PREPARATION', 'CLOSING'] as const).map((w) => (
                  <button key={w} type="button" disabled={w === 'CLOSING' && chosen.status === 'OPEN'} onClick={() => setWhich(w)} className={cn('rounded-full border px-3 py-1 font-mono text-meta transition-colors ease-helm disabled:opacity-40', which === w ? 'border-ink-950 bg-ink-950 text-paper' : 'border-ink-300 text-ink-700 hover:bg-ink-100')}>
                    {w === 'PREPARATION' ? 'as it opened' : 'as it closed'}
                  </button>
                ))}
              </div>
              {pack?.pack ? (
                <div className="mt-4">
                  {pack.withheld > 0 && <p className="mb-3 text-dense text-ink-600">{pack.statement}</p>}
                  <PackView pack={pack.pack} />
                </div>
              ) : (
                <p className="mt-4 text-dense text-ink-600">{pack?.statement ?? 'Reading the pack…'}</p>
              )}
            </section>
          )}
        </div>

        <aside className="w-full max-w-[360px] flex-[0_1_360px]">
          <SectionHead title="What management touched" size="section-sm" />
          {!chosen && <p className="mt-3 text-ui text-ink-500">Choose a review to see what it bound, what it carried forward and how it closed.</p>}
          {chosen && (
            <div className="mt-3">
              <FactRow
                facts={[
                  { label: 'Cadence', value: chosen.review.cadence.toLowerCase() },
                  { label: 'Opening twin state', value: chosen.review.openingSnapshotId, mono: true },
                  { label: 'Closing twin state', value: chosen.closure ? chosen.closure.closingSnapshotId : 'still open', mono: !!chosen.closure },
                ]}
              />
              <ul className="mt-4">
                {chosen.items.map((i) => {
                  const d = chosen.closure?.dispositions.find((x) => x.itemId === i.id);
                  return (
                    <li key={i.id} className="border-b border-ink-200 py-2">
                      <span className="block font-mono text-meta text-ink-500">{i.kind} · {i.role}{i.carriedFromItemId ? ' · carried forward — the same object' : ''}</span>
                      <span className="block text-dense text-ink-900">{i.ref?.label ?? i.note}</span>
                      {i.ref && i.note && <span className="block text-meta text-ink-600">{i.note}</span>}
                      {d && <span className={cn('block font-mono text-meta', d.disposition === 'CARRIED_FORWARD' ? 'text-amber-700' : 'text-ink-500')}>{d.disposition.replaceAll('_', ' ')} — {d.reason}</span>}
                    </li>
                  );
                })}
              </ul>
              {chosen.closure && <p className="mt-4 font-serif text-panel italic text-ink-900">{chosen.closure.summary}</p>}
              {chosen.changeDuringReview && <p className="mt-3 text-meta text-ink-600">{chosen.changeDuringReview.statement}</p>}
              <p className="mt-4 text-meta text-ink-600">
                Decisions are framed, committed and governed in <Link to="/decisions" className="text-accent-700 underline">Decisions</Link> and <Link to="/governance" className="text-accent-700 underline">Governance</Link>; the review only records that it happened here.
              </p>

              <div className="mt-6">
                <Button variant="secondary" size="sm" onClick={() => void runRepro()}>Check that it is still what management saw</Button>
                {repro && repro.key === chosen.review.id && <ul className="mt-2 grid gap-1">{repro.lines.map((l, i) => <li key={i} className="text-meta text-ink-700">{l}</li>)}</ul>}
              </div>

              {chosen.status === 'OPEN' && <OpenReviewActions ctx={ctx} v={chosen} onChanged={() => setTick((t) => t + 1)} />}

              <IntelligencePanel task="DRAFT_MANAGEMENT_BRIEF" params={{ reviewId: chosen.review.id }} viewer={viewer} label="Draft the management brief" detail="What changed, what matters, what is off-track, what is uncertain, which decisions are required, which assumptions are challenged and which outcomes arrived — each statement grounded in this review's pack." />
            </div>
          )}
        </aside>
      </div>

      {chosen && <CouncilPanel question={`What does each management function make of ${chosen.review.title}?`} request={{ reviewId: chosen.review.id, ...(chosen.items.find((i) => i.kind === 'DECISION') ? { decisionId: chosen.items.find((i) => i.kind === 'DECISION')!.ref!.id } : {}) }} viewer={viewer} />}

      {(!openReview || ctx.mode === 'demo') && (
        <section className="mt-10">
          <SectionHead title="Open the next review" caveat="what the previous review left open is carried forward by reference" />
          {openReview ? <p className="mt-3 text-dense text-ink-600">{openReview.review.title} is open; close it before opening the next of its cadence.</p> : null}
          <OpenForm ctx={ctx} onOpened={(id) => { setSelected(id); setTick((t) => t + 1); }} />
        </section>
      )}
    </>
  );
}
