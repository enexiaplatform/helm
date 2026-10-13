import { Lock } from 'lucide-react';

interface Props { chosen: string; summary: string; committedAt: string; by: string; fingerprint: string }

/* What management committed to: a white sheet with an emerald lock in its title, the stamp as the header caption.
   Only rendered when state === COMMITTED (or later). */
export function CommitmentBanner({ chosen, summary, committedAt, by, fingerprint }: Props) {
  return (
    <section className="rounded-xl border border-ink-200 bg-white shadow-panel">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-ink-100 px-4 py-[10px]">
        <h2 className="flex items-center gap-2 font-sans text-panel font-semibold text-ink-900">
          <Lock size={16} aria-hidden className="text-emerald-700" />
          What management committed to
        </h2>
        <span className="font-mono text-meta text-ink-500">{committedAt} · {by} · {fingerprint}</span>
      </header>
      <div className="grid gap-1 p-4">
        <p className="font-serif text-section font-semibold text-ink-950">{chosen}</p>
        <p className="max-w-[760px] text-base text-ink-700">{summary}</p>
      </div>
    </section>
  );
}
