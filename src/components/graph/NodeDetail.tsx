import type { ReactNode } from 'react';
import { Pill, type PillTone } from '../ui/Pill.tsx';
import { FactRow, type Fact } from '../ui/FactRow.tsx';
import { SectionHead } from '../ui/SectionHead.tsx';
import { DIM_PILL, type Dimension } from './NodeIndex.tsx';

export interface GraphLink { id: string; label: string; type: string; weight?: number | null; confidence: number | null }
export interface Observation { kind: string; value: string; when: string; source: string; confidence: string; scenario?: string }
interface Props {
  dimension: Dimension; metricKey: string; label: string; description: string; facts: Fact[];
  contention?: string; up: GraphLink[]; down: GraphLink[]; observations: Observation[];
  onSelect: (id: string) => void;
  /** Further sections under the observations: the linked entity, the value chain. */
  children?: ReactNode;
}
const KT: Record<string, PillTone> = { ACTUAL: 'actual', FORECAST: 'forecast', TARGET: 'target', SCENARIO: 'scenario', ESTIMATE: 'estimate', DERIVED: 'derived', ASSUMPTION: 'assumption' };

function Links({ title, items, empty, onSelect }: { title: string; items: GraphLink[]; empty: string; onSelect: (id: string) => void }) {
  return (
    <div>
      <SectionHead title={title} size="section-sm" className="pb-2" />
      {items.map((k) => (
        <button key={k.id + k.type} type="button" onClick={() => onSelect(k.id)} className="grid w-full gap-[2px] border-b border-ink-200 py-[10px] text-left text-ink-950 hover:text-accent-800">
          <span className="text-ui font-medium">{k.label}</span>
          <span className="helm-meta">{k.type}{k.weight != null && ' · weight ' + k.weight} · confidence {k.confidence == null ? '—' : k.confidence.toFixed(2)}</span>
        </button>
      ))}
      {!items.length && <p className="mt-[10px] text-dense text-ink-500">{empty}</p>}
    </div>
  );
}

/* Right column of the Value Graph. Dimension pill + metric key → serif 26/33 label → description →
   FactRow (unit, aggregation, direction, time, horizon, subject) → optional ochre contention notice →
   Driven by | Drives → Observations table (kinds never blended). */
export function NodeDetail(p: Props) {
  return (
    <div className="min-w-0 flex-[1_1_560px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={'rounded-full px-2 py-px font-mono text-tag font-semibold ' + DIM_PILL[p.dimension]}>{p.dimension}</span>
        <span className="helm-meta font-medium">{p.metricKey}</span>
      </div>
      <h2 className="mt-2 text-[26px] leading-[33px] tracking-[-0.01em]">{p.label}</h2>
      <p className="mt-[6px] max-w-reading text-read text-ink-700">{p.description}</p>
      <FactRow facts={p.facts} className="mt-[18px] gap-x-8 border-b border-ink-200 pb-[18px]" />
      {p.contention && (
        <div className="mt-[18px] grid gap-1 rounded-xl border border-amber-200 bg-amber-50 px-[18px] py-[14px]">
          <span className="font-sans text-label font-medium uppercase text-amber-800">Contended resource</span>
          <span className="text-base font-medium text-amber-900">{p.contention}</span>
        </div>
      )}
      <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-x-10 gap-y-6">
        <Links title="Driven by" items={p.up} empty="A source value — nothing in the graph drives it." onSelect={p.onSelect} />
        <Links title="Drives" items={p.down} empty="Nothing in the graph is linked downstream of it — no position is declared to depend on it yet." onSelect={p.onSelect} />
      </div>
      <div className="mt-8">
        <SectionHead title="Observations" size="section-sm" caveat="each kind kept separate, never blended" className="pb-2" />
        {p.observations.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse">
              <thead><tr>{['Kind', 'Value', 'When', 'Source', 'Confidence'].map((h, i) => <th key={h} className={'helm-label px-3 pb-2 pt-[10px] first:pl-0 last:pr-0 ' + (i === 1 || i === 4 ? 'text-right' : 'text-left')}>{h}</th>)}</tr></thead>
              <tbody>
                {p.observations.map((o, i) => (
                  <tr key={i} className="border-t border-ink-200">
                    <td className="py-[10px] pr-3"><Pill tone={KT[o.kind] ?? 'neutral'}>{o.kind}</Pill>{o.scenario && <span className="helm-meta ml-2">scenario {o.scenario}</span>}</td>
                    <td className="px-3 py-[10px] text-right font-mono text-ui font-medium">{o.value}</td>
                    <td className="px-3 py-[10px] font-mono text-meta text-ink-600">{o.when}</td>
                    <td className="px-3 py-[10px] font-mono text-meta text-ink-600">{o.source}</td>
                    <td className="py-[10px] pl-3 text-right font-mono text-dense">{o.confidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-base text-ink-600">No observations recorded. This value exists only inside a scenario run, where it is computed from the nodes that drive it.</p>
        )}
      </div>
      {p.children}
    </div>
  );
}
