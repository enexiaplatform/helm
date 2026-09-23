/**
 * Decision Memory — what management committed to, and how it turned out.
 *
 * Phase 5 preserves the material a Management Genome will later need: for every
 * commitment, the question, what was chosen, what was given up, what it rested
 * on, and — once someone looks — expected against actual.
 *
 * It does NOT learn from it. No pattern is detected, no decision is scored, and
 * nothing here says a decision was good or bad. A well-reasoned decision can
 * produce a poor outcome and a careless one can get lucky; keeping the two
 * apart is the whole point of recording both
 * (docs/architecture/decision-quality-vs-outcome.md). Learning is Phase 9.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import type { DecisionCommitment, DecisionOutcomeReview } from '@helm/decision-runtime';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { PanelCard, EmptyState } from '../components/ui.tsx';
import { displayInstant, displayValue, readable, resolveDecisionContext } from '../services/decisionRuntime.ts';
import { loadDecisions, loadWorkspace } from '../services/decisionWorkspace.ts';

type Entry = {
  decisionId: string;
  question: string;
  chosenLabel: string;
  commitment: DecisionCommitment;
  reviews: readonly DecisionOutcomeReview[];
  assumptionsSettled: number;
  assumptionsTotal: number;
};

export function MemoryPage() {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scope = useMemo(
    () => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null),
    [mode, activeOrgId, userId, myRole],
  );

  useEffect(() => {
    let live = true;
    if (!scope) return;
    void (async () => {
      try {
        const ctx = await resolveDecisionContext(mode ?? 'demo', scope);
        if (!live || !ctx) {
          if (live) setError('The decision runtime is unavailable in this mode.');
          return;
        }
        const list = await loadDecisions(ctx);
        const out: Entry[] = [];
        for (const item of list.filter((d) => d.committed)) {
          const view = await loadWorkspace(ctx, item.decision.id);
          const commitment = view.workspace.commitment;
          if (!commitment) continue;
          out.push({
            decisionId: item.decision.id,
            question: item.decision.managementQuestion,
            chosenLabel:
              view.workspace.alternatives.find((a) => a.id === commitment.chosenAlternativeId)?.label ?? 'an alternative',
            commitment,
            reviews: view.workspace.outcomeReviews,
            assumptionsSettled: view.workspace.assumptions.filter((a) => a.outcome !== 'PENDING').length,
            assumptionsTotal: view.workspace.assumptions.length,
          });
        }
        if (live) setEntries(out);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope]);

  if (error) return <EmptyState title="Decision memory could not be opened" detail={error} />;
  if (!entries) return <p className="p-6 text-sm text-ink-500">Reading the record…</p>;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <BookOpen className="h-5 w-5" /> Decision Memory
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-600">
          Every commitment, with what it rested on and how it turned out. HELM keeps the reasoning and the outcome apart
          on purpose: a careful decision can still go badly, and a careless one can get lucky. Learning from this record
          is a later phase; preserving it honestly is this one.
        </p>
      </header>

      {entries.length === 0 ? (
        <EmptyState
          title="Nothing has been committed yet"
          detail="Once management commits to an alternative, the question, the reasoning, the accepted trade-offs and the expected outcomes are preserved here."
          action={
            <Link to="/decisions" className="btn-secondary">
              Go to decisions
            </Link>
          }
        />
      ) : (
        <div className="space-y-4">
          {entries.map((e) => (
            <PanelCard
              key={e.decisionId}
              title={
                <Link to={`/decisions/${e.decisionId}`} className="hover:underline">
                  {e.question}
                </Link>
              }
              action={
                <span className="text-2xs text-ink-400" title={e.commitment.fingerprint}>
                  {readable(e.commitment.authorship)} · {displayInstant(e.commitment.committedAt)}
                </span>
              }>
              <p className="text-sm font-medium text-ink-900">{e.chosenLabel}</p>
              <p className="mt-1 text-xs text-ink-700">{e.commitment.summary}</p>

              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <div>
                  <p className="text-2xs font-semibold uppercase tracking-wide text-ink-500">Accepted at the time</p>
                  <ul className="mt-1 space-y-1 text-xs text-ink-700">
                    {e.commitment.acceptedTradeOffs.map((t, i) => (
                      <li key={i}>{t.statement}</li>
                    ))}
                    {e.commitment.acceptedTradeOffs.length === 0 && (
                      <li className="text-ink-400">No trade-off was recorded as accepted.</li>
                    )}
                  </ul>
                </div>
                <div>
                  <p className="text-2xs font-semibold uppercase tracking-wide text-ink-500">Expected</p>
                  <ul className="mt-1 space-y-1 text-xs">
                    {e.commitment.expectedOutcomes.map((o, i) => (
                      <li key={i} className="flex items-baseline justify-between gap-2">
                        <span className="text-ink-600">{o.label}</span>
                        <span className="text-right font-mono text-ink-900" title={o.expectedValue ?? undefined}>
                          {o.expectedValue === null
                            ? (o.statement ?? '—')
                            : displayValue(o.expectedValue, o.unit, o.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="mt-3 border-t border-ink-100 pt-2">
                <p className="text-2xs font-semibold uppercase tracking-wide text-ink-500">How it turned out</p>
                {e.reviews.length === 0 ? (
                  <p className="mt-1 text-xs text-ink-400">
                    Not reviewed yet. {e.assumptionsSettled} of {e.assumptionsTotal} assumptions have been settled.
                  </p>
                ) : (
                  e.reviews.map((r) => (
                    <div key={r.id} className="mt-1">
                      <table className="w-full text-left text-xs">
                        <thead className="text-2xs text-ink-400">
                          <tr>
                            <th className="py-1">Value</th>
                            <th className="text-right">Expected</th>
                            <th className="text-right">Actual</th>
                            <th className="text-right">Variance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.variances.map((v, i) => (
                            <tr key={i} className="border-t border-ink-100">
                              <td className="py-1 text-ink-700">{v.label}</td>
                              <td className="text-right font-mono text-ink-600" title={v.expected ?? undefined}>
                                {displayValue(v.expected, v.unit, v.currency)}
                              </td>
                              <td className="text-right font-mono text-ink-900" title={v.actual ?? undefined}>
                                {displayValue(v.actual, v.unit, v.currency)}
                              </td>
                              <td className="text-right font-mono text-ink-700" title={v.variance ?? undefined}>
                                {displayValue(v.variance, v.unit, v.currency)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {r.assumptionResults.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-2xs text-ink-600">
                          {r.assumptionResults.map((a) => (
                            <li key={a.assumptionId}>
                              <span className="font-medium">{readable(a.outcome)}</span> — {a.statement}
                              {a.note && ` (${a.note})`}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-1 text-2xs text-ink-400">
                        {r.reviewedByLabel} · {displayInstant(r.reviewedAt)} — {r.statement}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </PanelCard>
          ))}
        </div>
      )}
    </div>
  );
}
