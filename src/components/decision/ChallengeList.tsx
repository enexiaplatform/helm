import { Pill } from '../ui/Pill.tsx';

export interface ChallengeView { id: string; author: string; status: 'OPEN' | 'ACCEPTED_RISK' | 'RESOLVED' | 'REJECTED'; concern: string; target: string; resolution?: string }
const TONE = { OPEN: 'open', ACCEPTED_RISK: 'accepted', RESOLVED: 'neutral', REJECTED: 'neutral' } as const;

/* "Who disagreed". Author 13/600 + status pill → the concern quoted in italic serif → target · resolution. */
export function ChallengeList({ items }: { items: ChallengeView[] }) {
  return (
    <div>
      {items.map((c) => (
        <div key={c.id} className="grid gap-[6px] border-b border-ink-200 py-4">
          <div className="flex flex-wrap items-center gap-x-[10px] gap-y-2">
            <span className="text-dense font-semibold leading-[18px]">{c.author}</span>
            <Pill tone={TONE[c.status]}>{c.status.replace('_', ' ')}</Pill>
          </div>
          <p className="font-serif text-read italic leading-[23px] text-ink-800">“{c.concern}”</p>
          <p className="text-meta text-ink-500">on {c.target}{c.resolution ? ' · ' + c.resolution : ' · unresolved'}</p>
        </div>
      ))}
    </div>
  );
}
