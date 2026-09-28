import { cn } from '../../lib/cn.ts';

export type Dimension = 'FINANCIAL' | 'COMMERCIAL' | 'CUSTOMER' | 'OPERATIONAL' | 'CAPITAL' | 'RISK' | 'STRATEGIC' | 'RESOURCE' | 'RESILIENCE';
export const DIM_SWATCH: Record<Dimension, string> = {
  FINANCIAL: 'bg-emerald-500', COMMERCIAL: 'bg-accent-500', CUSTOMER: 'bg-violet-700', OPERATIONAL: 'bg-sky-700',
  CAPITAL: 'bg-amber-500', RISK: 'bg-red-500', STRATEGIC: 'bg-indigo-800', RESOURCE: 'bg-teal-800', RESILIENCE: 'bg-lime-800',
};
export const DIM_PILL: Record<Dimension, string> = {
  FINANCIAL: 'bg-emerald-50 text-emerald-800', COMMERCIAL: 'bg-accent-50 text-accent-800', CUSTOMER: 'bg-violet-50 text-violet-800',
  OPERATIONAL: 'bg-sky-50 text-sky-800', CAPITAL: 'bg-amber-50 text-amber-800', RISK: 'bg-red-50 text-red-700',
  STRATEGIC: 'bg-indigo-50 text-indigo-800', RESOURCE: 'bg-teal-50 text-teal-800', RESILIENCE: 'bg-lime-50 text-lime-800',
};
export interface IndexNode { id: string; label: string; dimension: Dimension }

/* Left column of the Value Graph (300px). Grouped by value dimension: 8px swatch + 11px label,
   then node buttons 13/19. Selected = accent-50 bg, accent-800 text, 600. */
export function NodeIndex({ nodes, selected, onSelect, order }: { nodes: IndexNode[]; selected: string; onSelect: (id: string) => void; order: Dimension[] }) {
  return (
    <nav className="grid min-w-[240px] flex-[0_1_300px] gap-[18px]">
      {order.map((dim) => {
        const list = nodes.filter((n) => n.dimension === dim);
        if (!list.length) return null;
        return (
          <div key={dim}>
            <p className="helm-label mb-[6px] flex items-center gap-2"><span className={cn('h-2 w-2 rounded-[2px]', DIM_SWATCH[dim])} />{dim.toLowerCase()}</p>
            {list.map((n) => (
              <button key={n.id} type="button" onClick={() => onSelect(n.id)}
                className={cn('block w-full rounded-lg px-[10px] py-[7px] text-left text-dense leading-[19px] hover:bg-ink-100', n.id === selected ? 'bg-accent-50 font-semibold text-accent-800' : 'text-ink-800')}>
                {n.label}
              </button>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
