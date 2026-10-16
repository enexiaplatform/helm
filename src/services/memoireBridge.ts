import { ok, fail } from '@helm/shared';
import type { MemoireOpportunityRow, MemoireOrderCostReader, MemoireOrderCostRow, MemoireReader } from '@helm/integration-runtime';
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

// The account's key-account flag is read through the opportunity's own foreign key, under the same RLS.
const READ_COLUMNS = 'id, account_id, account_name, opportunity_name, title, stage, estimated_value, currency, pipeline_probability, status, expected_close_period, updated_at, brand, channel, last_touch_at, next_action_date, closed_on, account:accounts(ka_flag)';

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
      type Read = Omit<MemoireOpportunityRow, 'account_ka_flag'> & { account: { ka_flag: boolean | null } | null };
      return ok(
        ((data ?? []) as unknown as Read[]).map(({ account, ...r }) => ({ ...r, updated_at: new Date(r.updated_at).toISOString(), account_ka_flag: account?.ka_flag ?? null })),
      );
    },
  };
}

/**
 * The Memoire read port for order costs (step 3, 2026-10-17): the signed-in user's own `order_costs` (RLS scopes it),
 * rows strictly after a cursor, oldest first. Memoire keeps each cost as a payload; only the fields the order-cost
 * contract names are read out of it. Read-only.
 */
export function createMemoireOrderCostReader(): MemoireOrderCostReader {
  return {
    async listOrderCosts(_scope, after, limit) {
      if (!supabaseClient) return fail('integration.no_client', 'Memoire cannot be read: no database client is configured.');
      let q = supabaseClient.from('order_costs').select('id, payload, created_at, updated_at').order('updated_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
      // The same millisecond cursor as the opportunities' (see above).
      if (after) {
        const nextMs = new Date(Date.parse(after.updatedAt) + 1).toISOString();
        q = q.or(`updated_at.gte.${nextMs},and(updated_at.gte.${after.updatedAt},updated_at.lt.${nextMs},id.gt.${after.id})`);
      }
      const { data, error } = await q;
      if (error) return fail('integration.read_failed', `Reading Memoire order costs failed: ${error.message}`);
      type Read = { id: string; payload: Record<string, unknown> | null; created_at: string; updated_at: string };
      const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
      const amt = (v: unknown): number | string | null => (typeof v === 'number' || typeof v === 'string' ? v : null);
      return ok(
        ((data ?? []) as Read[]).map((r): MemoireOrderCostRow => {
          const p = r.payload ?? {};
          return {
            id: r.id,
            opportunity_id: str(p['opportunityId']) ?? '',
            amount: amt(p['amount']),
            currency: str(p['currency']),
            duty_amount: amt(p['dutyAmount']),
            freight_amount: amt(p['freightAmount']),
            other_amount: amt(p['otherAmount']),
            extras_currency: str(p['extrasCurrency']),
            is_sample: typeof p['isSample'] === 'boolean' ? (p['isSample'] as boolean) : null,
            created_at: new Date(r.created_at).toISOString(),
            updated_at: new Date(r.updated_at).toISOString(),
          };
        }),
      );
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

/**
 * Memoire's own profile rows for the given users, by id — the email and name Settings shows for a member. RLS on
 * `user_profiles` (Memoire's table) shows each reader only their own row; the others come back absent, and the caller
 * names them by id. Read-only, like everything else here.
 */
export async function readMemoireProfiles(userIds: readonly string[]): Promise<ReadonlyMap<string, { email: string; displayName: string | null }>> {
  if (!supabaseClient || userIds.length === 0) return new Map();
  const { data } = await supabaseClient.from('user_profiles').select('id, email, display_name').in('id', [...userIds]);
  return new Map(((data as { id: string; email: string; display_name: string | null }[] | null) ?? []).map((p) => [p.id, { email: p.email, displayName: p.display_name }]));
}
