import { supabaseClient } from '../lib/supabaseClient.ts';
import type { Decision, DecisionAction } from '../domain/types.ts';

/**
 * The Memoire ↔ HELM bridge.
 *
 * Read side: the signed-in user's Memoire opportunities (RLS scopes the query
 * to their own workspace — HELM never sees anyone else's commercial data).
 *
 * Write side: when a decision moves into execution, HELM appends a
 * `commercial_events` row into the deciding user's Memoire workspace. The
 * event carries `source_type: 'system_rule'` and a `helm://decision/<id>`
 * source URL, so Memoire's timeline shows the decision provenance without
 * Memoire needing any HELM-specific code.
 *
 * HELM never copies Memoire entities — it stores references plus an immutable
 * context snapshot on the decision itself.
 */

export type MemoireOpportunity = {
  id: string;
  accountId: string | null;
  accountName: string;
  title: string;
  value: number | null;
  currency: string;
  stage: string;
};

export async function listMemoireOpportunities(): Promise<MemoireOpportunity[]> {
  if (!supabaseClient) return [];
  const { data, error } = await supabaseClient
    .from('opportunities')
    .select('id, account_id, account_name, title, opportunity_name, estimated_value, currency, stage, status')
    .neq('status', 'archived')
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id as string,
    accountId: (r.account_id as string | null) ?? null,
    accountName: (r.account_name as string | null) || '—',
    title: (r.opportunity_name as string | null) || (r.title as string | null) || 'Untitled opportunity',
    value: (r.estimated_value as number | null) ?? null,
    currency: (r.currency as string | null) || 'USD',
    stage: (r.stage as string | null) || '—',
  }));
}

export async function writebackDecisionToMemoire(
  decision: Decision,
  chosenAlternativeName: string | null,
  actions: DecisionAction[],
): Promise<{ eventId: string } | null> {
  if (!supabaseClient) return null;
  const { data: userData } = await supabaseClient.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return null;

  const eventId = `helm-decision-${decision.id}`;
  const { error } = await supabaseClient.from('commercial_events').upsert(
    {
      id: eventId,
      user_id: userId,
      event_type: 'helm_decision_approved',
      occurred_at: decision.approvedAt ?? new Date().toISOString(),
      account_id: decision.memoireAccountId,
      opportunity_id: decision.memoireOpportunityId,
      summary: `HELM decision: ${decision.title}${chosenAlternativeName ? ` — chosen: ${chosenAlternativeName}` : ''}`,
      structured_payload: {
        helmDecisionId: decision.id,
        decisionType: decision.decisionType,
        chosenAlternative: chosenAlternativeName,
        expectedOutcome: decision.expectedOutcome,
        actions: actions.map((a) => ({ title: a.title, owner: a.ownerLabel, dueDate: a.dueDate })),
      },
      idempotency_key: eventId,
      source_type: 'system_rule',
      source_id: decision.id,
      source_url: `helm://decision/${decision.id}`,
    },
    { onConflict: 'user_id,id' },
  );
  if (error) throw new Error(`Memoire write-back failed: ${error.message}`);
  return { eventId };
}
