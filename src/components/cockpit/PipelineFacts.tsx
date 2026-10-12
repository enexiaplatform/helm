import { pipelineFacts, readPipeline, type TwinItem } from '@helm/twin-runtime';
import { displayValue, rollUpItems } from '../../services/scenarioRuntime.ts';
import { SectionHead } from '../ui/SectionHead.tsx';

/**
 * The pipeline as Memoire states it, on the Cockpit (audit 2026-10-12): the figures a manager looks for first, and what
 * the data itself leaves open — opportunities with a value of 0, without a probability, without a close period. These
 * are facts about the data, counted; not an attention condition, not a score, and nothing here is ranked.
 */
export function PipelineFacts({ items }: { items: readonly TwinItem[] }) {
  const rows = readPipeline(items);
  if (rows.length === 0) return null;
  const f = pipelineFacts(rows);
  const figures = [
    ...rollUpItems(items, 'OpportunityValue', 'ACTUAL').map((r) => ({ label: 'Pipeline', sub: 'source fact', r })),
    ...rollUpItems(items, 'ExpectedRevenue', 'MODELLED').map((r) => ({ label: `Expected revenue${r.period ? ` · ${r.period}` : ''}`, sub: 'model result', r })),
  ];
  const open = [
    f.zeroValue > 0 && `${f.zeroValue} of ${f.opportunities} opportunities state a value of 0 in Memoire, so they add nothing to the pipeline until a value is entered there.`,
    f.noValue > 0 && `${f.noValue} state no value at all.`,
    f.noProbability > 0 && `${f.noProbability} carry no probability, so the model cannot compute their expected revenue; ${f.modelled} carry both and are modelled.`,
    f.noClosePeriod > 0 && `${f.noClosePeriod} state no expected close period, so no question about a quarter can include them.`,
    f.withoutCustomer > 0 && `${f.withoutCustomer} are held by no customer HELM can read.`,
  ].filter((x): x is string => typeof x === 'string');
  return (
    <section className="mt-10">
      <SectionHead title="The pipeline, as Memoire states it" meta={String(f.opportunities)} caveat="counted, never ranked" />
      <dl className="mt-3 flex flex-wrap gap-x-10 gap-y-3">
        {figures.map(({ label, sub, r }) => (
          <div key={`${r.metricKey}|${r.period}`} className="min-w-0">
            <dt className="text-meta text-ink-500">{label}</dt>
            <dd className="font-serif text-figure-sm text-ink-950" title={r.value ? `${r.value}${r.currency ? ` ${r.currency}` : ''}` : (r.note ?? '')}>
              {r.value === null ? '—' : displayValue(r.value, r.unit, r.currency)}
            </dd>
            <dd className="font-mono text-meta text-ink-500">{r.value === null ? r.note : `${sub} · Σ of ${r.counted}`}</dd>
          </div>
        ))}
      </dl>
      {open.length > 0 && (
        <div className="mt-4">
          <p className="helm-label">What the data leaves open</p>
          <ul className="mt-1 grid max-w-reading gap-1">
            {open.map((t) => (
              <li key={t} className="text-dense text-ink-800">{t}</li>
            ))}
          </ul>
          <p className="mt-2 text-meta text-ink-600">Ask HELM which ones — for example “Which opportunities have a value of 0?” — and correct them in Memoire; HELM reads the change by itself.</p>
        </div>
      )}
    </section>
  );
}
