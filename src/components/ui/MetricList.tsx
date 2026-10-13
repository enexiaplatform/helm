import type { ReactNode } from 'react';
import { Pill, type PillTone } from './Pill.tsx';

export interface Metric { label: string; sub?: string; value: string; unit?: string; tone?: 'neutral' | 'good' | 'bad' | 'warn' }
const TONE = { neutral: 'text-ink-950', good: 'text-emerald-700', bad: 'text-red-700', warn: 'text-amber-700' };

/* A white sheet of headline figures (the Stat): sans 14 semibold title over a hairline,
   12px label, 18px semibold tabular value, unit and provenance in mono. */
export function MetricList({ title, kind, metrics }: { title: ReactNode; kind?: { label: string; tone: PillTone }; metrics: Metric[] }) {
  return (
    <section className="rounded-xl border border-ink-200 bg-white shadow-panel">
      <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-[10px]">
        <h2 className="font-sans text-panel font-semibold text-ink-900">{title}</h2>
        {kind && <Pill tone={kind.tone}>{kind.label}</Pill>}
      </div>
      <div className="px-4 py-1">
        {metrics.map((m, i) => (
          <div key={m.label} className={'flex items-baseline justify-between gap-3 py-[10px]' + (i < metrics.length - 1 ? ' border-b border-ink-100' : '')}>
            <span className="text-dense text-ink-600">
              {m.label}
              {m.sub && <span className="block font-mono text-meta text-ink-400">{m.sub}</span>}
            </span>
            <span className={'tabular text-figure-sm font-semibold ' + TONE[m.tone ?? 'neutral']}>
              {m.value}{m.unit && <span className="ml-1 font-mono text-meta font-normal text-ink-500">{m.unit}</span>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
