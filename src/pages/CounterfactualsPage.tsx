/**
 * Counterfactual worlds — the technical instrument.
 *
 * What might have happened under a different intervention, GIVEN what actually
 * happened: an ex-post question anchored to the state at the decision boundary,
 * answered in two retrospective lenses that are never blended, estimated by the
 * executable model and labelled as such, with causal support judged separately
 * from the Causal Graph. The world that happened and the world that did not are
 * drawn unmistakably apart. There is no regret figure, no verdict and no ranking.
 *
 *     Scenario ≠ Counterfactual · As known then ≠ With hindsight
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CaseView, ComparedRow, ComparisonCell, CounterfactualComparison, CounterfactualWorld, ProjectedCounterfactuals, WorldView } from '@helm/counterfactual-runtime';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { caseTone, comparisonOf, counterfactualsForViewer, resolveCounterfactualContext, supportTone, type CounterfactualContext } from '../services/counterfactualRuntime.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { FactRow } from '../components/ui/FactRow.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { Button } from '../components/ui/Button.tsx';
import { IntelligencePanel } from '../components/intelligence/IntelligencePanel.tsx';
import { cn } from '../lib/cn.ts';

const day = (iso: string): string => iso.slice(0, 10);
const stamp = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const cellText = (c: ComparisonCell): string => (c.status === 'READ' && c.value !== null ? `${c.value}${c.unit && c.unit !== 'currency' ? ` ${c.unit}` : ''}${c.currency ? ` ${c.currency}` : ''}` : 'not read');

function Cell({ c, dashed }: { c: ComparisonCell; dashed?: boolean }) {
  return (
    <td className={cn('px-3 py-2 align-top', dashed && 'border-l border-dashed border-ink-300 bg-ink-50/60')}>
      <span className={cn('block font-mono text-dense', c.status === 'READ' ? 'text-ink-950' : 'text-red-700')}>{cellText(c)}</span>
      <span className="block text-meta text-ink-500">{c.status === 'READ' ? c.source : c.reason}</span>
    </td>
  );
}

function Diff({ v, label, first }: { v: string | null; label: string; first?: boolean }) {
  return (
    <td className={cn('px-3 py-2 align-top', first && 'border-l border-ink-200')}>
      <span className={cn('block font-mono text-dense', v === null ? 'text-ink-400' : 'text-ink-950')}>{v ?? '—'}</span>
      <span className="block text-meta text-ink-500">{label}</span>
    </td>
  );
}

function ComparisonTable({ cmp }: { cmp: CounterfactualComparison }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-ink-200 bg-white">
      <table className="w-full min-w-[980px] border-collapse text-left">
        <thead>
          <tr className="border-b border-ink-200 align-bottom">
            <th className="px-3 py-3 helm-label">Compared metric</th>
            <th colSpan={2} className="px-3 py-3">
              <span className="helm-label block text-navy">The world that happened</span>
              <span className="text-meta font-normal normal-case text-ink-500">expected at commitment · actual</span>
            </th>
            <th colSpan={2} className="border-l border-dashed border-ink-300 bg-ink-50/60 px-3 py-3">
              <span className="helm-label block text-indigo-900">A world that did not happen — a model estimate</span>
              <span className="text-meta font-normal normal-case text-ink-500">{cmp.intervention.label}: as known then · with hindsight</span>
            </th>
            <th colSpan={2} className="border-l border-ink-200 px-3 py-3">
              <span className="helm-label block">The only two differences</span>
              <span className="text-meta font-normal normal-case text-ink-500">each between layers of the same kind</span>
            </th>
          </tr>
          <tr className="border-b border-ink-200 font-mono text-tag uppercase text-ink-500">
            <th className="px-3 py-1" />
            <th className="px-3 py-1">Expected at commitment</th>
            <th className="px-3 py-1">Actual</th>
            <th className="border-l border-dashed border-ink-300 px-3 py-1">Alternative, as known then</th>
            <th className="px-3 py-1">Alternative, with hindsight</th>
            <th className="border-l border-ink-200 px-3 py-1">Alt. then − expected</th>
            <th className="px-3 py-1">Alt. hindsight − actual</th>
          </tr>
        </thead>
        <tbody>
          {cmp.rows.map((r: ComparedRow) => (
            <tr key={r.metric.metricKey} className="border-b border-ink-200 last:border-b-0">
              <td className="px-3 py-2 align-top text-dense font-medium text-ink-900">{r.metric.label}</td>
              <Cell c={r.expected} />
              <Cell c={r.actual} />
              <Cell c={r.alternativeThen} dashed />
              <Cell c={r.alternativeWithHindsight} />
              <Diff v={r.alternativeThenMinusExpected} label="ex ante with ex ante" first />
              <Diff v={r.alternativeWithHindsightMinusActual} label="ex post with ex post" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorldCard({ title, w, empty }: { title: string; w: WorldView | null; empty: string }) {
  if (!w) {
    return (
      <div className="rounded-xl border border-dashed border-ink-300 bg-ink-50/60 px-4 py-3">
        <p className="helm-label">{title}</p>
        <p className="mt-1 text-dense text-ink-600">{empty}</p>
      </div>
    );
  }
  const world: CounterfactualWorld = w.world;
  return (
    <div className="rounded-xl border border-dashed border-ink-300 bg-ink-50/60 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="helm-label">{title}</p>
        <Pill tone={world.estimability === 'ESTIMATED' ? 'counterfactual' : 'blocked'}>{world.estimability}</Pill>
        <Pill tone={supportTone(w.causal.level)}>causal support · {w.causal.level}</Pill>
      </div>
      <p className="mt-2 text-dense text-ink-800">{world.statement}</p>
      <FactRow
        className="mt-3"
        facts={[
          { label: 'Method', value: world.method, mono: true },
          { label: 'Model', value: world.model ? `${world.model.engineVersion} · ${world.model.calculations.length} calculations` : 'none — never modelled', mono: true },
          { label: 'State anchored at', value: stamp(world.anchorFork.recordedThrough), mono: true },
          { label: 'Information read through', value: stamp(world.knowledge.recordedThrough), mono: true },
          { label: 'World fingerprint', value: world.fingerprint, mono: true },
        ]}
      />
      {world.notEstimableReasons.length > 0 && (
        <ul className="mt-3 grid gap-1">{world.notEstimableReasons.map((r, i) => <li key={i} className="text-dense text-red-700">{r}</li>)}</ul>
      )}
      {world.movedInputs.length > 0 && (
        <div className="mt-4">
          <p className="helm-label">What the intervention moved — stated inputs</p>
          <ul className="mt-2 grid gap-2">
            {world.movedInputs.map((m) => (
              <li key={`${m.nodeId}-${m.source}`} className="border-l border-ink-300 pl-3">
                <span className="block font-mono text-meta text-ink-500">{m.source === 'HINDSIGHT' ? 'HINDSIGHT' : 'INTERVENTION'} · {m.metricKey} · {m.provenanceKind}</span>
                <span className="block text-dense text-ink-900">{m.nodeLabel}: {m.baselineValue ?? '—'} → <span className="font-mono">{m.value}</span></span>
                <span className="block text-meta text-ink-600">{m.rationale}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {world.hindsightInputs.length > 0 && (
        <div className="mt-4">
          <p className="helm-label">What was learned after the decision boundary</p>
          <ul className="mt-2 grid gap-2">
            {world.hindsightInputs.map((h, i) => (
              <li key={i} className="border-l border-indigo-800 pl-3">
                <span className="block text-dense text-ink-900">{h.label}</span>
                <span className="block font-mono text-meta text-ink-500">{h.source.kind} {h.source.ref} · learned {day(h.learnedAt)}</span>
                <span className="block text-meta text-ink-700">A person states why this is news about the world, not a consequence of the choice: “{h.exogeneity}”</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4">
        <p className="helm-label">Causal support — a statement about evidence, never a probability</p>
        <p className="mt-1 text-dense text-ink-800">{w.causal.statement}</p>
        <ul className="mt-2 grid gap-1">
          {w.causal.pairs.slice(0, 6).map((p, i) => (
            <li key={i} className="font-mono text-meta text-ink-600">
              {p.input.nodeLabel} → {p.compared.label}: {p.state}{p.modelDependency ? ` · model dependency shown apart: ${p.modelDependency}` : ''}
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-4">
        <p className="helm-label">Uncertainty — a list, never an interval</p>
        <ul className="mt-1 grid gap-1">{world.uncertainty.map((u, i) => <li key={i} className="text-dense text-ink-700">{u}</li>)}</ul>
      </div>
    </div>
  );
}

function ReviewForm({ ctx, c, onDone }: { ctx: CounterfactualContext; c: CaseView; onDone: () => void }) {
  const [statement, setStatement] = useState('');
  const [limitations, setLimitations] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const field = 'w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-ui';
  const submit = async () => {
    const r = await ctx.counterfactual.recordReview(ctx.scope, c.case.id, { statement, limitations, reviewedByLabel: ctx.mode === 'demo' ? 'Reviewer (demo)' : 'Reviewer' });
    if (r.ok) {
      setStatement('');
      setLimitations('');
      onDone();
    } else setErr(r.error.message);
  };
  return (
    <div className="mt-4 grid gap-2">
      <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1"><span className="helm-label">Your reading of the comparison as it stands</span><textarea className={field} rows={2} value={statement} onChange={(e) => setStatement(e.target.value)} /></label>
      <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1"><span className="helm-label">What it does not show</span><textarea className={field} rows={2} value={limitations} onChange={(e) => setLimitations(e.target.value)} /></label>
      {err && <p className="text-dense text-red-700">{err}</p>}
      <div><Button variant="secondary" size="sm" onClick={() => void submit()} disabled={!statement.trim() || !limitations.trim()}>Record a reading</Button></div>
    </div>
  );
}

function Row({ children, onClick, selected }: { children: ReactNode; onClick?: () => void; selected?: boolean }) {
  return (
    <li className={cn('border-b border-ink-200 py-3', onClick && 'cursor-pointer transition-colors duration-160 ease-helm hover:bg-ink-50', selected && 'bg-ink-50')} onClick={onClick}>
      {children}
    </li>
  );
}

export function CounterfactualsPage() {
  const mode = useHelmStore((st) => st.mode);
  const activeOrgId = useHelmStore((st) => st.activeOrgId);
  const userId = useHelmStore((st) => st.userId);
  const myRole = useHelmStore((st) => st.myRole);
  const scope = useMemo(() => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null), [mode, activeOrgId, userId, myRole]);

  const [ctx, setCtx] = useState<CounterfactualContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerKey, setViewerKey] = useState('');
  const [lensKey, setLensKey] = useState('now');
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ key: string; value: ProjectedCounterfactuals } | null>(null);
  const [cmpState, setCmpState] = useState<{ key: string; value: CounterfactualComparison | null; error: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    if (!scope) return;
    void (async () => {
      try {
        const c = await resolveCounterfactualContext(mode ?? 'demo', scope);
        if (!c) throw new Error('Counterfactual worlds are unavailable in this mode.');
        if (!live) return;
        setCtx(c);
        setViewerKey(c.viewers.find((v) => v.key === 'countryGM')?.key ?? c.viewers[0]?.key ?? '');
        if (c.story) setSelected(c.story.cases.CF1.case.id);
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
        const p = await counterfactualsForViewer(ctx, viewer, lens);
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
  const chosen = projected?.cases.find((c) => c.case.id === selected) ?? null;
  const cmpKey = `${key}|${chosen?.case.id ?? ''}`;

  useEffect(() => {
    let live = true;
    if (!ctx || !chosen) return;
    void (async () => {
      try {
        const cmp = await comparisonOf(ctx, chosen.case.id, lens);
        if (live) setCmpState({ key: cmpKey, value: cmp, error: null });
      } catch (e) {
        if (live) setCmpState({ key: cmpKey, value: null, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [ctx, chosen, lens, cmpKey]);

  if (error) return <EmptyState title="Counterfactual worlds could not be opened" detail={error} />;
  if (!ctx || !viewer) return <p className="text-ui text-ink-500">Reading the counterfactual worlds…</p>;

  const cmp = cmpState && cmpState.key === cmpKey ? cmpState.value : null;
  const select = 'max-w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-ui';

  return (
    <>
      <PageHeader
        kicker="Kernel instrument · Counterfactual worlds"
        size="instrument"
        title="Counterfactual worlds"
        lede="What might have happened under a different intervention, given what actually happened — anchored to the state at the decision boundary, estimated by the model and labelled as an estimate. The world that happened and the world that did not are kept apart, and there is no regret figure, no verdict and no ranking."
      />

      {ctx.story && (
        <Notice tone="neutral" label="Demo counterfactual review" className="mt-6">
          The cases, hindsight inputs and readings below are illustrative. None came from a company's books; they enter HELM through the kernels exactly as real ones would, and every one is labelled DEMO at its source.
        </Notice>
      )}
      <Notice tone="neutral" label="A scenario is not a counterfactual" className="mt-4">
        A scenario explores a future before a decision. A counterfactual is an ex-post alternative world, anchored to the past. As known then uses only what management could have known;
        with hindsight adds later facts, each one stated and sourced — and neither is a claim about what would have happened.
      </Notice>

      <div className="mt-6 flex flex-wrap items-end gap-4">
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1">
          <span className="helm-label">Read as</span>
          <select className={select} value={viewerKey} onChange={(e) => setViewerKey(e.target.value)}>{ctx.viewers.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}</select>
        </label>
        <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1">
          <span className="helm-label">As known on</span>
          <select className={select} value={lensKey} onChange={(e) => setLensKey(e.target.value)}>{ctx.lenses.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</select>
        </label>
      </div>

      <div className="mt-9 flex flex-wrap gap-10">
        <div className="min-w-0 flex-[1_1_560px]">
          <section>
            <SectionHead title="Cases" meta={projected ? `${projected.cases.length} visible · ${projected.withheld} withheld` : '…'} caveat="a case is read whole or not at all" />
            {projected && projected.withheld > 0 && <p className="mt-3 text-dense text-ink-600">{projected.statement}</p>}
            {projected && projected.cases.length === 0 && <p className="mt-3 text-ui text-ink-500">No case is known at this point in time, or none is readable by this reader.</p>}
            <ul>
              {(projected?.cases ?? []).map((c) => (
                <Row key={c.case.id} onClick={() => setSelected(c.case.id)} selected={selected === c.case.id}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Pill tone={caseTone(c.status)}>{c.status}</Pill>
                    <span className="text-dense text-ink-900">{c.case.title}</span>
                  </div>
                  <p className="mt-1 font-serif text-panel italic text-ink-700">{c.case.question}</p>
                  <p className="mt-1 font-mono text-meta text-ink-500">
                    decision: {c.decisionTitle} · chose {c.chosenLabel ?? '—'} · asks about {c.interventionLabel} · {c.worlds.asKnownThen ? 'as known then' : 'no world then'} · {c.worlds.withHindsight ? 'with hindsight' : 'no hindsight world'}
                  </p>
                </Row>
              ))}
            </ul>
          </section>

          {chosen && (
            <section className="mt-10">
              <SectionHead title="The four layers, side by side" meta={cmp ? `comparison ${cmp.fingerprint}` : '…'} caveat="the difference between two layers of the same kind — never one number for everything" />
              {cmpState && cmpState.key === cmpKey && cmpState.error && <p role="alert" className="mt-3 text-dense text-red-700">{cmpState.error}</p>}
              {cmp && (
                <>
                  <ComparisonTable cmp={cmp} />
                  <p className="mt-3 text-dense text-ink-700">{cmp.statement}</p>
                  <p className="helm-caveat mt-2">{cmp.important}</p>
                  {cmp.modelChangedSinceThen === true && <p className="mt-2 text-dense text-red-700">The model that computed the two worlds is not the same one.</p>}
                </>
              )}
            </section>
          )}

          {chosen && (
            <section className="mt-10">
              <SectionHead title="The two worlds that did not happen" meta="each estimated for its own lens" caveat="never blended" />
              <div className="mt-4 grid gap-4">
                <WorldCard title="As known then" w={chosen.worlds.asKnownThen} empty="No world as known then is recorded at this point in time." />
                <WorldCard title="With hindsight" w={chosen.worlds.withHindsight} empty="No hindsight world is recorded at this point in time: nothing was learned, or nobody has stated it yet." />
              </div>
            </section>
          )}
        </div>

        <aside className="w-full max-w-[360px] flex-[0_1_360px]">
          <SectionHead title="The question and its anchor" size="section-sm" />
          {!chosen && <p className="mt-3 text-ui text-ink-500">Choose a case to see what was asked, at which boundary, and what a person concluded.</p>}
          {chosen && (
            <div className="mt-3">
              <p className="font-serif text-panel italic text-ink-900">{chosen.case.question}</p>
              <FactRow
                className="mt-3"
                facts={[
                  { label: 'Decision', value: chosen.decisionTitle },
                  { label: 'Actual world: chose', value: chosen.chosenLabel ?? '—' },
                  { label: 'Alternative world', value: chosen.interventionLabel },
                  { label: 'Decided under knowledge through', value: stamp(chosen.case.boundary.recordedThrough), mono: true },
                  { label: 'Anchored to the state as of', value: stamp(chosen.case.anchor.lens.recordedThrough), mono: true },
                  { label: 'Carries classes', value: chosen.case.sensitivityClasses.join(', '), mono: true },
                ]}
              />
              <p className="helm-label mt-5">A person&apos;s reading</p>
              {chosen.reviews.length === 0 && <p className="mt-2 text-dense text-ink-600">No one has recorded a reading of this comparison.</p>}
              {chosen.reviews.map((r) => (
                <div key={r.id} className="mt-2 border-l border-ink-300 pl-3">
                  <span className="block font-mono text-meta text-ink-500">{r.reviewedByLabel} · {day(r.recordedAt)} · read {r.comparisonFingerprint}</span>
                  <span className="block text-dense text-ink-900">{r.statement}</span>
                  <span className="helm-caveat block">What it does not show: {r.limitations}</span>
                </div>
              ))}
              {ctx.mode === 'demo' && <ReviewForm ctx={ctx} c={chosen} onDone={() => setTick((t) => t + 1)} />}
              <IntelligencePanel task="EXPLAIN_COUNTERFACTUAL" params={{ caseId: chosen.case.id }} viewer={viewer} label="Explain this comparison" detail="A grounded reading of the comparison above: what was expected, what happened and what the model estimates — as an estimate, never a verdict." />
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
