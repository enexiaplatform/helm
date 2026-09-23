import { supabaseClient } from '../lib/supabaseClient.ts';

/**
 * The Memoire ↔ HELM bridge.
 *
 * Read side: the signed-in user's Memoire opportunities (RLS scopes the query
 * to their own workspace — HELM never sees anyone else's commercial data).
 *
 * Write side: RETIRED in Phase 5. The pre-kernel bridge wrote a
 * `commercial_events` row into Memoire when a decision was approved. Phase 5
 * writes nothing outward: a commitment produces ACTION INTENTS naming the
 * system that will do the work, and `DecisionCommittedEvent` defines the
 * payload a connector would carry. Building that connector is a later phase
 * (§58); the architecture is the deliverable here, not the automation.
 *
 * HELM never copies Memoire entities — it stores references.
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
