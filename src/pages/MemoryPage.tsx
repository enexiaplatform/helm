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
import { Link, useNavigate } from 'react-router-dom';
import type { DecisionWorkspace } from '@helm/decision-runtime';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { MemoryEntry, type MemoryView } from '../components/memory/MemoryEntry.tsx';
import {
  displayDate,
  displayInstant,
  displayValue,
  readable,
  resolveDecisionContext,
} from '../services/decisionRuntime.ts';
import { loadDecisions, loadWorkspace } from '../services/decisionWorkspace.ts';

const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const word = (n: number) => NUM[n] ?? String(n);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function toView(workspace: DecisionWorkspace): MemoryView | null {
  const { decision, commitment } = workspace;
  if (!commitment) return null;
  const review = workspace.outcomeReviews.at(-1);
  const settled = workspace.assumptions.filter((a) => a.outcome !== 'PENDING').length;
  return {
    id: decision.id,
    meta: [
      `committed ${displayInstant(commitment.committedAt)}`,
      commitment.committedByLabel,
      readable(commitment.authorship),
      commitment.fingerprint.slice(0, 12),
    ].join(' · '),
    question: decision.managementQuestion,
    chosen: workspace.alternatives.find((a) => a.id === commitment.chosenAlternativeId)?.label ?? 'an alternative',
    summary: commitment.summary,
    accepted:
      commitment.acceptedTradeOffs.length > 0
        ? commitment.acceptedTradeOffs.map((t) => t.statement)
        : ['No trade-off was recorded as accepted.'],
    expected: commitment.expectedOutcomes.map((o) => ({
      label: o.label,
      value: o.expectedValue === null ? (o.statement ?? '—') : displayValue(o.expectedValue, o.unit, o.currency),
    })),
    after: workspace.evidence
      .filter((e) => e.recordedAt > commitment.committedAt)
      .map((e) => ({ title: e.title, recordedAt: `recorded ${displayInstant(e.recordedAt)} · ${e.sourceSystem}` })),
    review: review && {
      variances: review.variances.map((v) => ({
        label: v.label,
        expected: displayValue(v.expected, v.unit, v.currency),
        actual: displayValue(v.actual, v.unit, v.currency),
        variance: displayValue(v.variance, v.unit, v.currency),
      })),
      assumptions: review.assumptionResults.map((a) => ({
        outcome: a.outcome,
        statement: a.statement,
        note: a.note ?? undefined,
      })),
      statement: review.statement,
      by: `${review.reviewedByLabel} · ${displayInstant(review.reviewedAt)}`,
    },
    pendingNote: `${word(settled)} of ${workspace.assumptions.length} assumptions settled. Review due ${displayDate(decision.horizon.reviewDate)}.`,
  };
}

export function MemoryPage() {
  const navigate = useNavigate();
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);
  const [entries, setEntries] = useState<MemoryView[] | null>(null);
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
        const out: MemoryView[] = [];
        for (const item of list.filter((d) => d.committed)) {
          const view = toView((await loadWorkspace(ctx, item.decision.id)).workspace);
          if (view) out.push(view);
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
  if (!entries) return <p className="text-ui text-ink-500">Reading the record…</p>;

  const reviewed = entries.filter((e) => e.review).length;
  const headline =
    entries.length === 0
      ? 'Nothing is on record yet.'
      : `${word(entries.length)} ${plural(entries.length, 'commitment', 'commitments')} on record. ` +
        (reviewed === 0
          ? 'None has been looked at again yet.'
          : `${word(reviewed)} ${plural(reviewed, 'has', 'have')} been looked at again.`);

  return (
    <>
      <PageHeader
        kicker="Management · Memory"
        title={headline}
        lede="HELM keeps the reasoning and the outcome apart on purpose: a careful decision can still go badly, and a careless one can get lucky."
      />
      {entries.length === 0 ? (
        <div className="mt-9 grid justify-items-start gap-3">
          <p className="max-w-reading text-read text-ink-600">
            Nothing has been committed yet. Once management commits to an alternative, the question, the reasoning, the
            accepted trade-offs and the expected outcomes are kept here.
          </p>
          <Link to="/decisions" className="text-dense font-medium">Go to decisions →</Link>
        </div>
      ) : (
        entries.map((m) => <MemoryEntry key={m.id} m={m} onOpen={(id) => navigate(`/decisions/${id}`)} />)
      )}
    </>
  );
}
