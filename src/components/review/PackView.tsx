import type { ReactNode } from 'react';
import type { ReviewPack } from '@helm/review-runtime';
import { SectionHead } from '../ui/SectionHead.tsx';
import { Pill } from '../ui/Pill.tsx';

const day = (iso: string): string => iso.slice(0, 10);

function Block({ title, note, children, count }: { title: string; note?: string | null; children: ReactNode; count: number }) {
  return (
    <section className="mt-8">
      <SectionHead title={title} meta={String(count)} caveat={note ?? undefined} size="section-sm" />
      {count === 0 ? <p className="mt-3 text-dense text-ink-500">{note ?? 'Nothing.'}</p> : <div className="mt-2">{children}</div>}
    </section>
  );
}

/**
 * What a review is prepared with, assembled from the kernel — in kernel order, never by importance.
 * The seven questions management asks at every review, each answered from records that already exist.
 */
export function PackView({ pack, limit = 12 }: { pack: ReviewPack; limit?: number }) {
  return (
    <div>
      <p className="text-dense text-ink-700">{pack.statement}</p>
      <p className="mt-1 font-mono text-meta text-ink-500">pack {pack.fingerprint} · read at {pack.lens.recordedThrough.slice(0, 16).replace('T', ' ')} UTC{pack.since ? ` · since ${pack.since.recordedThrough.slice(0, 16).replace('T', ' ')} UTC` : ' · first review'}</p>

      <Block title="What changed?" count={pack.changed.changes.length} note={pack.changed.statement}>
        <p className="font-mono text-meta text-ink-500">{Object.entries(pack.changed.counts).map(([k, v]) => `${v} ${k}`).join(' · ')}{pack.changed.warnings.length > 0 ? ` · ${pack.changed.warnings.join('; ')}` : ''}</p>
        <ul>
          {pack.changed.changes.slice(0, limit).map((c) => (
            <li key={`${c.itemKey}-${c.change}`} className="border-b border-ink-200 py-2">
              <span className="font-mono text-meta text-ink-500">{c.category} · {c.change}</span>
              <span className="block text-dense text-ink-900">{c.statement}</span>
            </li>
          ))}
        </ul>
        {pack.changed.changes.length > limit && <p className="mt-2 font-mono text-meta text-ink-500">{limit} of {pack.changed.changes.length}, in kernel order — not the most important.</p>}
      </Block>

      <Block title="What requires attention?" count={pack.attention.items.length} note={pack.attention.note}>
        <ul>
          {pack.attention.items.map((a) => (
            <li key={a.itemKey} className="border-b border-ink-200 py-2">
              <Pill tone="open">{a.condition.replaceAll('_', ' ')}</Pill>
              <span className="mt-1 block text-dense text-ink-900">{a.statement}</span>
            </li>
          ))}
        </ul>
      </Block>

      <Block title="What decisions are needed?" count={pack.decisionsNeeded.items.length} note={pack.decisionsNeeded.note}>
        <ul>
          {pack.decisionsNeeded.items.map((d) => (
            <li key={d.decisionId} className="border-b border-ink-200 py-2">
              <span className="block text-dense text-ink-900">{d.title}</span>
              <span className="block font-serif text-panel italic text-ink-700">{d.question}</span>
              <span className="block font-mono text-meta text-ink-500">opened {day(d.openedAt)}</span>
            </li>
          ))}
        </ul>
      </Block>

      <Block title="What commitments are off-track?" count={pack.commitmentsOffTrack.items.length} note={pack.commitmentsOffTrack.note}>
        <ul>
          {pack.commitmentsOffTrack.items.map((o) => (
            <li key={o.commitmentId} className="border-b border-ink-200 py-2">
              <span className="block text-dense font-medium text-ink-900">{o.title}</span>
              {o.lines.map((l) => (
                <span key={l.label} className="block font-mono text-meta text-ink-700">{l.label}: committed {l.committed ?? '—'} · now {l.current ?? '—'} · difference {l.difference ?? '—'}{l.unit ? ` ${l.unit}` : ''}</span>
              ))}
              {o.unresolved.map((u) => <span key={u} className="block text-meta text-red-700">{u}</span>)}
            </li>
          ))}
        </ul>
      </Block>

      <Block title="What assumptions changed?" count={pack.assumptionsChanged.items.length} note={pack.assumptionsChanged.note}>
        <ul>
          {pack.assumptionsChanged.items.map((a) => (
            <li key={a.assumptionId + a.reviewedAt} className="border-b border-ink-200 py-2">
              <span className={a.outcome === 'DISPROVED' ? 'font-mono text-meta text-red-700' : 'font-mono text-meta text-ink-500'}>{a.outcome} · {day(a.reviewedAt)}</span>
              <span className="block text-dense text-ink-900">{a.statement}</span>
            </li>
          ))}
        </ul>
      </Block>

      <Block title="What outcomes arrived?" count={pack.outcomesArrived.items.length} note={pack.outcomesArrived.note}>
        <ul>
          {pack.outcomesArrived.items.map((o) => (
            <li key={o.outcomeReviewId} className="border-b border-ink-200 py-2">
              <span className="block font-mono text-meta text-ink-500">outcome review {day(o.reviewedAt)}</span>
              {o.variances.map((v) => <span key={v.label} className="block font-mono text-meta text-ink-800">{v.label}: expected {v.expected ?? '—'} · actual {v.actual ?? '—'} · variance {v.variance ?? '—'}</span>)}
            </li>
          ))}
        </ul>
      </Block>

      <Block title="What did we learn?" count={pack.learning.episodes.items.length + pack.learning.patterns.items.length + pack.learning.lessons.items.length + pack.learning.counterfactuals.items.length}>
        <ul>
          {pack.learning.episodes.items.map((e) => <li key={e.id} className="border-b border-ink-200 py-2"><span className="font-mono text-meta text-ink-500">management episode · {e.status}</span><span className="block text-dense text-ink-900">{e.title}</span></li>)}
          {pack.learning.patterns.items.map((e) => <li key={e.id} className="border-b border-ink-200 py-2"><span className="font-mono text-meta text-ink-500">pattern · {e.status}</span><span className="block text-dense text-ink-900">{e.title}</span></li>)}
          {pack.learning.lessons.items.map((e) => <li key={e.id} className="border-b border-ink-200 py-2"><span className="font-mono text-meta text-ink-500">lesson · {e.status}</span><span className="block text-dense text-ink-900">{e.claim}</span></li>)}
          {pack.learning.counterfactuals.items.map((e) => <li key={e.id} className="border-b border-ink-200 py-2"><span className="font-mono text-meta text-ink-500">counterfactual case · {e.status}</span><span className="block text-dense text-ink-900">{e.title}</span></li>)}
        </ul>
      </Block>

      <Block title="What causal beliefs changed?" count={pack.causalChanges.items.length} note={pack.causalChanges.note}>
        <ul>
          {pack.causalChanges.items.map((c) => (
            <li key={c.claimId} className="border-b border-ink-200 py-2">
              <span className="font-mono text-meta text-ink-500">revision {c.revision} · {c.status} · {day(c.recordedAt)}</span>
              <span className="block text-dense text-ink-900">{c.statement}</span>
            </li>
          ))}
        </ul>
      </Block>

      {pack.unavailable.length > 0 && (
        <p className="mt-6 text-dense text-red-700">Not available to this pack: {pack.unavailable.join('; ')}.</p>
      )}
    </div>
  );
}
