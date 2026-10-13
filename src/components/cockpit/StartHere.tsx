import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { pipelineFacts, readPipeline, type PipelineReadable, type TwinItem } from '@helm/twin-runtime';
import type { ReviewView } from '@helm/review-runtime';
import { cn } from '../../lib/cn.ts';
import { ASKED_KEY, DISMISSED_KEY, GUIDE_EVENT, read, write } from './gettingStarted.ts';

/**
 * Getting started — what a new manager does first, on the page they land on.
 *
 * Audit 2026-10-12: "I log in and still don't know how to use it", then "the guide is bad" — a wall of paragraphs.
 * Modelled on the first-run patterns of products like Stripe's setup guide and Linear's empty states: a short list (four
 * items), one line each, one verb per item, done items checked off by the organization's own records, progress shown,
 * dismissible, gone once everything is done. It guides the instrument; it never says which deal or future to choose.
 */

const COMMITTED_OR_OPEN = ['DRAFT', 'INVESTIGATING', 'MODELLING', 'READY_FOR_DECISION', 'COMMITTED', 'EXECUTING', 'COMPLETED', 'REVIEWED'];

const quarterOf = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
};

type Item = { key: string; title: string; detail: string; done: boolean; cta: { label: string; to?: string; onClick?: () => void } };

export function StartHere({ items, readable, reviews, now, onDismiss }: { items: readonly TwinItem[]; readable: PipelineReadable; reviews: readonly ReviewView[]; now: string; onDismiss?: () => void }) {
  const [dismissed, setDismissed] = useState(() => read(DISMISSED_KEY));
  // Ask HELM lives elsewhere on the page: its first answer checks its item off here without a reload.
  const [asked, setAsked] = useState(() => read(ASKED_KEY));
  useEffect(() => {
    const on = () => setAsked(read(ASKED_KEY));
    globalThis.addEventListener(GUIDE_EVENT, on);
    return () => globalThis.removeEventListener(GUIDE_EVENT, on);
  }, []);

  const f = pipelineFacts(readPipeline(items), readable);
  const gaps = [
    f.zeroValue > 0 && `${f.zeroValue} at a value of 0`,
    f.noProbability > 0 && `${f.noProbability} without a probability`,
    f.noClosePeriod > 0 && `${f.noClosePeriod} without a close period`,
  ].filter((x): x is string => typeof x === 'string');
  const decisions = items.filter((i) => i.kind === 'DECISION' && COMMITTED_OR_OPEN.includes(String((i.state as { state?: string }).state ?? '')));
  const quarter = quarterOf(now);
  const review = reviews.find((r) => r.review.periodLabel === quarter) ?? null;
  const scrollTo = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const list: Item[] = [
    {
      key: 'pipeline',
      title: 'Check the pipeline',
      detail: f.opportunities === 0 ? 'No opportunities read from Memoire yet' : gaps.length > 0 ? `${f.opportunities} opportunities · ${gaps.join(' · ')}` : `${f.opportunities} opportunities, complete`,
      done: f.opportunities > 0 && gaps.length === 0,
      cta: { label: 'Review', onClick: scrollTo('pipeline') },
    },
    {
      key: 'ask',
      title: 'Ask HELM a question',
      detail: 'Answers name the deals that meet a condition — never a ranking',
      done: asked,
      cta: { label: 'Try one', onClick: scrollTo('ask-helm') },
    },
    {
      key: 'decision',
      title: 'Frame a decision on a deal',
      detail: decisions.length > 0 ? `${decisions.length} decision${decisions.length === 1 ? '' : 's'} on record` : 'Compare futures from Scenarios, then commit one',
      done: decisions.length > 0,
      cta: { label: 'Frame', to: '/decisions?frame=1' },
    },
    {
      key: 'review',
      title: `Open the ${quarter} review`,
      detail: review ? `${review.status === 'OPEN' ? 'Open' : 'Closed'} · carries forward what is left open` : 'Captures where the quarter stands',
      done: !!review,
      // The form that opens a review is at the foot of a long page: the link lands on it, period already set.
      cta: { label: review?.status === 'OPEN' ? 'Continue' : 'Open', to: review ? '/reviews' : `/reviews?open=${quarter}#open-review` },
    },
  ];
  const done = list.filter((i) => i.done).length;
  if (dismissed || done === list.length) return null;
  const next = list.find((i) => !i.done)?.key;

  return (
    <section className="mt-6 rounded-xl border border-ink-200 bg-white" aria-labelledby="getting-started">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-200 px-5 py-3">
        <h2 id="getting-started" className="font-serif text-panel text-ink-950">Getting started</h2>
        <span className="font-mono text-meta text-ink-500">{done} of {list.length}</span>
        <span className="h-[3px] w-24 overflow-hidden rounded-full bg-ink-100" aria-hidden>
          <span className="block h-full rounded-full bg-accent-800 transition-colors ease-helm" style={{ width: `${(done / list.length) * 100}%` }} />
        </span>
        <button
          type="button"
          onClick={() => {
            write(DISMISSED_KEY, true);
            setDismissed(true);
            onDismiss?.();
          }}
          className="ml-auto text-meta text-ink-500 hover:text-ink-900"
        >
          Dismiss
        </button>
      </div>
      <ol>
        {list.map((i, n) => {
          const isNext = i.key === next;
          const ctaClass = cn('shrink-0 text-meta font-medium', isNext ? 'rounded-lg bg-accent-800 px-3 py-1 text-white hover:bg-accent-700 hover:no-underline' : 'text-accent-700 hover:underline');
          return (
            <li key={i.key} className="flex items-center gap-3 border-b border-ink-200 px-5 py-[10px] last:border-b-0">
              <span
                aria-label={i.done ? 'done' : `step ${n + 1}`}
                className={cn(
                  'grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[11px]',
                  i.done ? 'bg-accent-800 text-white' : 'border border-ink-300 text-ink-500',
                )}
              >
                {i.done ? '✓' : n + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('text-ui font-medium', i.done ? 'text-ink-500 line-through decoration-ink-300' : 'text-ink-950')}>{i.title}</span>
                <span className="ml-2 text-meta text-ink-500">{i.detail}</span>
              </span>
              {!i.done &&
                (i.cta.to ? (
                  <Link to={i.cta.to} className={ctaClass}>{i.cta.label}</Link>
                ) : (
                  <button type="button" onClick={i.cta.onClick} className={ctaClass}>{i.cta.label}</button>
                ))}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
