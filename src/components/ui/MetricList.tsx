import type { ReactNode } from 'react';
import { Pill, type PillTone } from './Pill.tsx';

export interface Metric { label: string; sub?: string; value: string; unit?: string; tone?: 'neutral' | 'good' | 'bad' | 'warn' }
const TONE = { neutral: 'text-ink-950', good: 'text-emerald-700', bad: 'text-red-700', warn: 'text-amber-700' };

/* Side panel of headline figures. Replaces the v1 StatStrip on management pages.
   Figures are serif with lining tabular numerals; unit is mono 12px. */
export function MetricList({ title, kind, metrics }: { title: ReactNode; kind?: { label: string; tone: PillTone }; metrics: Metric[] }) {
  return (
    <section className="rounded-xl border border-ink-200 bg-white">
      <div className="flex items-baseline justify-between gap-3 border-b border-ink-200 px-5 py-[14px]">
        <h2 className="text-panel">{title}</h2>
        {kind && <Pill tone={kind.tone}>{kind.label}</Pill>}
      </div>
      <div className="px-5 pb-2 pt-[6px]">
        {metrics.map((m, i) => (
          <div key={m.label} className={'flex items-baseline justify-between gap-3 py-3' + (i < metrics.length - 1 ? ' border-b border-ink-100' : '')}>
            <span className="text-dense text-ink-600">
              {m.label}
              {m.sub && <span className="block font-mono text-meta text-ink-500">{m.sub}</span>}
            </span>
            <span className={'tabular font-serif text-figure-sm font-medium ' + TONE[m.tone ?? 'neutral']}>
              {m.value}{m.unit && <span className="ml-1 font-mono text-meta font-normal text-ink-500">{m.unit}</span>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
