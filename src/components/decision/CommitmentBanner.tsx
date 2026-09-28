import { Pill } from '../ui/Pill.tsx';

interface Props { chosen: string; summary: string; committedAt: string; by: string; fingerprint: string }

/* The one navy surface inside a page: what management committed to.
   Only rendered when state === COMMITTED (or later). */
export function CommitmentBanner({ chosen, summary, committedAt, by, fingerprint }: Props) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 rounded-xl bg-navy px-6 py-[22px] text-paper">
      <Pill tone="committed" className="row-span-3 self-start">Committed</Pill>
      <p className="font-serif text-figure-sm font-medium">{chosen}</p>
      <p className="max-w-[760px] text-base text-accent-100">{summary}</p>
      <p className="mt-[6px] font-mono text-meta text-accent-300">{committedAt} · {by} · {fingerprint}</p>
    </div>
  );
}
