import { Link } from 'react-router-dom';
import { pipelineFacts, readQuarter, type PipelinePosition, type PipelineReadable } from '@helm/twin-runtime';
import { SectionHead } from '../ui/SectionHead.tsx';
import { quarterLabel } from './QuarterPanel.tsx';

/**
 * "Fix in Memoire" (Phase 1, 2026-10-16): every gap in the source's own data, in one place, each with the list of the
 * deals it names. HELM never fixes the source — it is read-only — so each line says what to correct there. Counts of
 * facts, never a score; a line HELM cannot link to a list says so by having no link.
 */

type Line = { readonly text: string; readonly to: string | null };

export function fixLines(rows: readonly PipelinePosition[], quarter: string, readable: PipelineReadable, unclassifiedCustomers = 0): Line[] {
  const open = rows.filter((r) => r.state === 'OPEN');
  const f = pipelineFacts(open, readable);
  const q = readQuarter(rows, quarter);
  const label = quarterLabel(quarter);
  // One brand typed two ways is counted apart (live audit 2026-10-16: "MicronView" and "MicronVIew"). Only spellings that
  // differ by case or spacing are said to be one brand; anything looser would be HELM guessing, so it is left alone.
  const spellings = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.brand) continue;
    const key = r.brand.trim().replace(/\s+/g, ' ').toLowerCase();
    spellings.set(key, (spellings.get(key) ?? new Set()).add(r.brand));
  }
  const twoWays = [...spellings.values()].filter((v) => v.size > 1).map((v) => [...v].map((b) => `“${b}”`).join(' and '));
  const noNextStep = open.filter((r) => r.nextActionDate === null).length;
  const lines: (Line | false)[] = [
    f.zeroValue > 0 && { text: `${f.zeroValue} open ${f.zeroValue === 1 ? 'deal states' : 'deals state'} a value of 0`, to: '/pipeline?fix=zero' },
    f.noValue > 0 && { text: `${f.noValue} ${f.noValue === 1 ? 'has' : 'have'} no value`, to: '/pipeline?fix=novalue' },
    q.inQuarter.noProbability > 0 && { text: `${q.inQuarter.noProbability} of the deals due in ${label} ${q.inQuarter.noProbability === 1 ? 'has' : 'have'} no probability, so ${q.inQuarter.noProbability === 1 ? 'it adds' : 'they add'} nothing to the weighted figure`, to: '/pipeline?when=quarter&fix=noprob' },
    f.noProbability > q.inQuarter.noProbability && { text: `${f.noProbability} open ${f.noProbability === 1 ? 'deal has' : 'deals have'} no probability in all`, to: '/pipeline?fix=noprob' },
    f.noClosePeriod > 0 && { text: `${f.noClosePeriod} ${f.noClosePeriod === 1 ? 'has' : 'have'} no close period`, to: '/pipeline?fix=noclose' },
    q.inQuarter.yearNotStated > 0 && { text: `${q.inQuarter.yearNotStated} ${q.inQuarter.yearNotStated === 1 ? 'states' : 'state'} “Q${quarter.slice(-1)}” without a year; HELM counts ${q.inQuarter.yearNotStated === 1 ? 'it' : 'them'} in ${label}`, to: '/pipeline?when=quarter' },
    noNextStep > 0 && { text: `${noNextStep} of ${open.length} open deals state no next step, so “This week” cannot say when they are due`, to: null },
    f.withoutCustomer > 0 && { text: `${f.withoutCustomer} ${f.withoutCustomer === 1 ? 'has' : 'have'} no customer`, to: '/pipeline?fix=nocustomer' },
    unclassifiedCustomers > 0 && { text: `${unclassifiedCustomers} ${unclassifiedCustomers === 1 ? 'customer has' : 'customers have'} no key-account flag`, to: null },
    ...twoWays.map((w) => ({ text: `${w} are one brand written two ways, so their deals are counted apart`, to: null })),
  ];
  return lines.filter((x): x is Line => x !== false);
}

export function FixInSource({ rows, quarter, readable, source, unclassifiedCustomers = 0 }: { rows: readonly PipelinePosition[]; quarter: string; readable: PipelineReadable; source: string; unclassifiedCustomers?: number }) {
  const lines = fixLines(rows, quarter, readable, unclassifiedCustomers);
  return (
    <section className="mt-10">
      <SectionHead title={`Fix in ${source}`} meta={String(lines.length)} caveat="HELM reads the source and never writes to it" />
      {lines.length === 0 ? (
        <p className="mt-3 max-w-reading text-ui text-ink-500">Nothing to fix: every open deal states a value, a probability, a close period, a customer and a next step.</p>
      ) : (
        <ul className="mt-1">
          {lines.map((l) => (
            <li key={l.text} className="border-b border-ink-200 py-2 text-dense text-ink-800">
              {l.text}. {l.to && <Link to={l.to} className="whitespace-nowrap font-medium text-accent-700 hover:underline">List →</Link>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
