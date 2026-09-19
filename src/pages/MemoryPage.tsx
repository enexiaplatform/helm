import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { BookOpenCheck } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { PanelCard, EmptyState } from '../components/ui.tsx';
import { detectPatterns, buildOutcomeLedger } from '../domain/engines/decisionMemory.ts';
import { formatDate } from '../domain/format.ts';
import { decisionTypeLabels, type OutcomeScore } from '../domain/types.ts';

const scoreStyles: Record<OutcomeScore, string> = {
  better: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  as_expected: 'bg-ink-50 text-ink-600 border-ink-200',
  worse: 'bg-red-50 text-red-700 border-red-200',
  mixed: 'bg-amber-50 text-amber-800 border-amber-200',
};

const scoreLabels: Record<OutcomeScore, string> = {
  better: 'Better',
  as_expected: 'As expected',
  worse: 'Worse',
  mixed: 'Mixed',
};

/**
 * Decision Memory: the closed-decision ledger (expected vs actual vs lesson)
 * and the deterministic patterns detected across it. This is the seed of the
 * long-term moat — the organization learning from its own decisions.
 */
export function MemoryPage() {
  const decisions = useHelmStore((s) => s.decisions);
  const patterns = useMemo(() => detectPatterns(decisions), [decisions]);
  const ledger = useMemo(() => buildOutcomeLedger(decisions), [decisions]);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <h1 className="text-xl font-semibold">Decision Memory</h1>
        <p className="text-sm text-ink-500">What was decided, why, what happened, and what the organization learned.</p>
      </header>

      {patterns.length > 0 && (
        <PanelCard title="Detected patterns" action={<span className="text-2xs text-ink-400">deterministic · min. 3 closed decisions</span>}>
          <ul className="space-y-3">
            {patterns.map((p) => (
              <li key={p.code} className="rounded-md border border-violet-200 bg-violet-50/60 p-3">
                <p className="flex items-center gap-2 text-sm font-semibold text-violet-900">
                  <BookOpenCheck size={15} />
                  {p.title}
                </p>
                <p className="mt-1 text-xs text-violet-800">{p.detail}</p>
                <p className="mt-1.5 text-2xs text-violet-600">
                  Evidence:{' '}
                  {p.evidenceDecisionIds.map((id, i) => {
                    const d = decisions.find((x) => x.id === id);
                    return (
                      <span key={id}>
                        {i > 0 && ' · '}
                        <Link to={`/decisions/${id}`} className="underline hover:text-violet-900">
                          {d?.title ?? id}
                        </Link>
                      </span>
                    );
                  })}
                </p>
              </li>
            ))}
          </ul>
        </PanelCard>
      )}

      <PanelCard title="Outcome ledger">
        {ledger.length === 0 ? (
          <EmptyState
            title="No closed decisions yet"
            detail="When a decision closes with its actual outcome and lesson, it appears here — and patterns emerge across them."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {ledger.map((row) => (
              <li key={row.decisionId} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link to={`/decisions/${row.decisionId}`} className="text-sm font-medium hover:text-accent-700">
                      {row.title}
                    </Link>
                    <p className="text-2xs text-ink-400">
                      {decisionTypeLabels[row.decisionType]} · closed {formatDate(row.closedAt)}
                    </p>
                  </div>
                  {row.outcomeScore && (
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-2xs font-semibold ${scoreStyles[row.outcomeScore]}`}>
                      {scoreLabels[row.outcomeScore]}
                    </span>
                  )}
                </div>
                <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
                  <div>
                    <p className="field-label">Expected</p>
                    <p className="text-ink-600">{row.expectedOutcome || '—'}</p>
                  </div>
                  <div>
                    <p className="field-label">Actual</p>
                    <p className="text-ink-600">{row.actualOutcome || '—'}</p>
                  </div>
                  <div>
                    <p className="field-label">Lesson</p>
                    <p className="font-medium text-ink-800">{row.lesson || '—'}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PanelCard>
    </div>
  );
}
