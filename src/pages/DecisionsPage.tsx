/**
 * Decisions — the list of management questions this organization is deciding
 * or has decided.
 *
 * It shows the question, not a title; the state of the preparation, not an
 * approval status; and whether a commitment exists, not whether HELM likes it.
 * Opening one leads to the Decision Workspace.
 *
 * Replaces the pre-kernel decision list (retired in Phase 5 — see
 * docs/architecture/decision-engine-assessment.md).
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Scale } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { PageHeader, PanelCard, EmptyState } from '../components/ui.tsx';
import { displayDate, readable, resolveDecisionContext } from '../services/decisionRuntime.ts';
import { loadDecisions, type DecisionListItem } from '../services/decisionWorkspace.ts';

const stateTone: Record<string, string> = {
  DRAFT: 'bg-ink-100 text-ink-600',
  INVESTIGATING: 'bg-accent-100 text-accent-800',
  MODELLING: 'bg-violet-100 text-violet-800',
  READY_FOR_DECISION: 'bg-amber-100 text-amber-800',
  COMMITTED: 'bg-emerald-100 text-emerald-800',
  EXECUTING: 'bg-accent-100 text-accent-800',
  COMPLETED: 'bg-ink-100 text-ink-600',
  REVIEWED: 'bg-ink-100 text-ink-500',
  CANCELLED: 'bg-ink-100 text-ink-500',
};

export function DecisionsPage() {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);
  const [items, setItems] = useState<DecisionListItem[] | null>(null);
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
        if (!live) return;
        if (!ctx) {
          setError('The decision runtime is unavailable in this mode.');
          return;
        }
        setItems(await loadDecisions(ctx));
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope]);

  if (error) return <EmptyState title="Decisions could not be opened" detail={error} />;
  if (!items) return <p className="p-6 text-sm text-ink-500">Opening decisions…</p>;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        icon={Scale}
        title="Decisions"
        description="One management question each, with the alternatives that were considered, the futures the model computed for them, what mattered, who disagreed, and what was committed. HELM preserves the reasoning; it does not do the deciding."
      />

      {items.length === 0 ? (
        <EmptyState
          title="No decisions yet"
          detail="A decision starts with a question — not a topic. Open a scenario branch first, then frame what is being decided between those futures."
          action={
            <Link to="/scenarios" className="btn-secondary">
              Go to scenarios
            </Link>
          }
        />
      ) : (
        <PanelCard title={`${items.length} decision${items.length === 1 ? '' : 's'}`}>
          <ul className="divide-y divide-ink-100">
            {items.map(({ decision, latestRevision, committed }) => (
              <li key={decision.id} className="py-3 first:pt-0 last:pb-0">
                <Link to={`/decisions/${decision.id}`} className="group block">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 text-sm font-medium text-ink-900 group-hover:underline">
                      {decision.managementQuestion}
                    </p>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium ${
                        stateTone[decision.state] ?? 'bg-ink-100 text-ink-600'
                      }`}>
                      {readable(decision.state)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-2xs text-ink-500">
                    {decision.scope || decision.title} · {readable(decision.triggerType)} ·{' '}
                    {decision.owner?.label ?? 'no owner'} · decide by {displayDate(decision.horizon.decisionDeadline)}
                    {latestRevision && ` · r${latestRevision.revisionNumber}`}
                    {committed && ' · committed'}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </PanelCard>
      )}
    </div>
  );
}
