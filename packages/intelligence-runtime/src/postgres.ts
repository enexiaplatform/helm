/**
 * PostgresAiRunStore — the AiRunStore over Supabase.
 *
 * The I/O boundary of @helm/intelligence-runtime, held to the same conformance
 * suite as the in-memory store. The database enforces the integrity rules
 * (helm_ai_runs guard and CHECKs): write-once, record time stamped by the
 * database, and a shape that cannot hold a reasoning trace.
 *
 * Reads are RLS-shaped: a user reads their own runs, an org admin reads all.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fail, ok, type Result, type Scope } from '@helm/shared';
import type { AiRunStore } from './port.ts';
import { IntelligenceErrors, type AiRun } from './types.ts';

export type PostgresAiRunStoreOptions = { client: SupabaseClient };

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string).toISOString();

const toRun = (r: Row): AiRun => ({
  id: String(r.id),
  orgId: String(r.org_id),
  userId: String(r.user_id),
  task: String(r.task),
  templateId: String(r.template_id),
  templateVersion: String(r.template_version),
  promptHash: String(r.prompt_hash),
  provider: r.provider as AiRun['provider'],
  toolCalls: (r.tool_calls as AiRun['toolCalls']) ?? [],
  evidenceRefs: (r.evidence_refs as AiRun['evidenceRefs']) ?? [],
  grounding: r.grounding as AiRun['grounding'],
  output: r.output as AiRun['output'],
  resultMeta: r.result_meta as AiRun['resultMeta'],
  recordedAt: iso(r.recorded_at),
});

type Q = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

async function one<T>(q: Q, map: (r: Row) => T, what: string): Promise<Result<T>> {
  const { data, error } = await q;
  if (error) return fail(IntelligenceErrors.INVALID, `${what}: ${error.message}`);
  if (!data) return fail(IntelligenceErrors.INVALID, `${what}: nothing was returned (refused by policy).`);
  return ok(map(data as Row));
}

export function createPostgresAiRunStore(opts: PostgresAiRunStoreOptions): AiRunStore {
  const db = opts.client;
  const org = (s: Scope) => s.orgId as string;
  return {
    insertRun: (scope, r) =>
      one(
        db
          .from('helm_ai_runs')
          .insert({
            org_id: org(scope),
            user_id: r.userId,
            task: r.task,
            template_id: r.templateId,
            template_version: r.templateVersion,
            prompt_hash: r.promptHash,
            provider: r.provider,
            tool_calls: r.toolCalls,
            evidence_refs: r.evidenceRefs,
            grounding: r.grounding,
            output: r.output,
            result_meta: r.resultMeta,
          })
          .select('*')
          .single(),
        toRun,
        'Recording the AI run',
      ),
    async getRun(scope, id) {
      const { data, error } = await db.from('helm_ai_runs').select('*').eq('org_id', org(scope)).eq('id', id).maybeSingle();
      if (error) return fail(IntelligenceErrors.INVALID, `Reading the run: ${error.message}`);
      return ok(data ? toRun(data as Row) : null);
    },
    async listRuns(scope, filter) {
      let q = db.from('helm_ai_runs').select('*').eq('org_id', org(scope)).order('recorded_at', { ascending: true });
      if (filter?.userId) q = q.eq('user_id', filter.userId);
      if (filter?.task) q = q.eq('task', filter.task);
      const { data, error } = await q;
      if (error) return fail(IntelligenceErrors.INVALID, `Listing runs: ${error.message}`);
      return ok(((data as Row[]) ?? []).map(toRun));
    },
  };
}
