import { ok, fail } from '@helm/shared';
import type { MemoireOpportunityRow, MemoireReader } from '@helm/integration-runtime';
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
 *
 * The integration fabric reads through `createMemoireOpportunityReader()` below: the same read side, as the adapter's port —
 * rows strictly after a cursor, oldest first, under the caller's own RLS. It is READ-ONLY; HELM never writes into Memoire.
 *
 * Live side (ADR-0034): `subscribeToMemoireOpportunities()` listens for Supabase Realtime notices that one of the
 * signed-in user's opportunities changed. Realtime applies the same RLS, so a user hears only their own rows. The
 * notice's payload is IGNORED: it only wakes the live sync, which re-reads through the reader above.
 */

const READ_COLUMNS = 'id, account_id, account_name, opportunity_name, title, stage, estimated_value, currency, pipeline_probability, status, expected_close_period, updated_at';

/** The Memoire read port of the integration fabric, over the signed-in user's own `opportunities` (RLS scopes it). */
export function createMemoireOpportunityReader(): MemoireReader {
  return {
    async listOpportunities(_scope, after, limit) {
      if (!supabaseClient) return fail('integration.no_client', 'Memoire cannot be read: no database client is configured.');
      let q = supabaseClient.from('opportunities').select(READ_COLUMNS).order('updated_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
      // Postgres keeps microseconds; the cursor is the row's time to the millisecond (as every HELM time is). "After
      // (T, id)" therefore means a later millisecond, or the same millisecond and a greater id — comparing the raw
      // column with T would re-read the cursor's own row forever (its .771936 is "greater than" .771).
      if (after) {
        const nextMs = new Date(Date.parse(after.updatedAt) + 1).toISOString();
        q = q.or(`updated_at.gte.${nextMs},and(updated_at.gte.${after.updatedAt},updated_at.lt.${nextMs},id.gt.${after.id})`);
      }
      const { data, error } = await q;
      if (error) return fail('integration.read_failed', `Reading Memoire opportunities failed: ${error.message}`);
      return ok(((data ?? []) as unknown as MemoireOpportunityRow[]).map((r) => ({ ...r, updated_at: new Date(r.updated_at).toISOString() })));
    },
  };
}

/**
 * Hear that the signed-in user's Memoire opportunities changed. `notify` receives nothing — HELM re-reads, it never
 * applies a change event. `listening` says whether notices are reaching HELM. Returns the way to stop listening.
 */
export function subscribeToMemoireOpportunities(userId: string, notify: () => void, listening: (on: boolean) => void): () => void {
  const client = supabaseClient;
  if (!client || !userId) {
    listening(false);
    return () => {};
  }
  const channel = client
    .channel(`helm-memoire-opportunities-${userId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'opportunities', filter: `user_id=eq.${userId}` }, () => notify())
    .subscribe((status) => listening(status === 'SUBSCRIBED'));
  return () => {
    listening(false);
    void client.removeChannel(channel);
  };
}
