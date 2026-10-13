import { pipelineFacts, readPipeline, type PipelineReadable, type TwinItem } from '@helm/twin-runtime';
import { displayValue, rollUpItems } from '../../services/scenarioRuntime.ts';
import { SectionHead } from '../ui/SectionHead.tsx';

/**
 * The pipeline as its source states it, on the Cockpit (audit 2026-10-12): the figures a manager looks for first, and
 * what the data itself leaves open — opportunities with a value of 0, without a probability, without a close period.
 * These are facts about the data, counted; not an attention condition, not a score, and nothing here is ranked.
 *
 * A reading the reader may not see is said to be withheld, never missing (audit 2026-10-13): telling an analyst to
 * "correct Memoire" about values that only sit above their clearance would send them to fix data that is right.
 */
export function PipelineFacts({ items, readable, source }: { items: readonly TwinItem[]; readable: PipelineReadable; source: string }) {
  const rows = readPipeline(items);
  if (rows.length === 0) return null;
  const f = pipelineFacts(rows, readable);
  const figures = [
    ...(readable.value ? rollUpItems(items, 'OpportunityValue', 'ACTUAL').map((r) => ({ label: 'Pipeline', sub: 'source fact', r })) : []),
    ...(readable.value && readable.probability ? rollUpItems(items, 'ExpectedRevenue', 'MODELLED').map((r) => ({ label: `Expected revenue${r.period ? ` · ${r.period}` : ''}`, sub: 'model result', r })) : []),
  ];
  const withheld = [
    f.valueWithheld > 0 && 'values',
    f.probabilityWithheld > 0 && 'probabilities',
  ].filter((x): x is string => typeof x === 'string');
  const open = [
    f.zeroValue > 0 && { text: `${f.zeroValue} of ${f.opportunities} state a value of 0, so they add nothing to the pipeline until a value is entered in ${source}.`, ask: 'Which opportunities have a value of 0?' },
    f.noValue > 0 && { text: `${f.noValue} have no value at all.`, ask: 'Which opportunities have no value?' },
    f.noProbability > 0 && { text: `${f.noProbability} carry no probability, so the model cannot compute their expected revenue; ${f.modelled} carry both and are modelled.`, ask: 'Which opportunities have no probability?' },
    f.noClosePeriod > 0 && { text: `${f.noClosePeriod} have no expected close period, so no question about a quarter can include them.`, ask: null },
    f.withoutCustomer > 0 && { text: `${f.withoutCustomer} are held by no customer HELM can read.`, ask: null },
  ].filter((x): x is { text: string; ask: string | null } => typeof x === 'object' && x !== null);
  const example = open.find((o) => o.ask)?.ask ?? null;
  return (
    <section id="pipeline" className="mt-10 scroll-mt-6">
      <SectionHead title="The pipeline, as its source states it" meta={String(f.opportunities)} caveat="counted, never ranked" />
      {figures.length > 0 && (
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
      )}
      {withheld.length > 0 && (
        <p className="mt-3 max-w-reading text-dense text-ink-800">
          {f.opportunities} {f.opportunities === 1 ? 'opportunity is' : 'opportunities are'} visible to you; their {withheld.join(' and ')} are commercial-confidential and above your clearance, so they are withheld here — not missing in {source}.
        </p>
      )}
      {open.length > 0 && (
        <div className="mt-4">
          <p className="helm-label">What the data leaves open</p>
          <ul className="mt-1 grid max-w-reading gap-1">
            {open.map((o) => (
              <li key={o.text} className="text-dense text-ink-800">{o.text}</li>
            ))}
          </ul>
          <p className="mt-2 text-meta text-ink-600">
            {example ? <>Ask HELM which ones — “{example}” — and </> : 'To close a gap, '}correct them in {source}; HELM reads the change by itself.
          </p>
        </div>
      )}
    </section>
  );
}
