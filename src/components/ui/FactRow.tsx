import { cn } from '../../lib/cn.ts';

export interface Fact { label: string; value: string; mono?: boolean }

/* Inline definition list: label (12px ink-500) over value (14px/500).
   Values that are dates, IDs, quantities or money → mono. */
export function FactRow({ facts, className }: { facts: Fact[]; className?: string }) {
  return (
    <dl className={cn('flex flex-wrap gap-x-9 gap-y-[10px]', className)}>
      {facts.map((f) => (
        <div key={f.label} className="grid">
          <dt className="text-meta text-ink-500">{f.label}</dt>
          <dd className={cn('text-ui font-medium', f.mono && 'font-mono')}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
