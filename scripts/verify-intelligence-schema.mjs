/**
 * verify:intelligence-schema — the AI audit trail cannot hold what it must never hold.
 *
 *   - one append-only table, record time stamped by the database; a person reads their own runs, an admin reads all;
 *   - the provider is an identity (id, model, modelVersion) and nothing vendor-specific;
 *   - the output is statements, questions and unknowns — there is nowhere to keep a chain of thought;
 *   - the result meta is counts and a fingerprint, nothing else;
 *   - every run names its template and version and the hash of what was asked, its tool calls and its evidence;
 *   - the AI has no write path into any enterprise table: this migration creates no policy or grant on one.
 */

import { contract } from './lib/twinStack.mjs';
import { appendOnly, loadMigration } from './lib/schemaContract.mjs';

const c = contract('verify:intelligence-schema');
const m = loadMigration(c, '20260930150000_helm_intelligence_audit.sql', 'AI audit');
appendOnly(c, m, ['helm_ai_runs'], 'helm_ai_runs_guard');
const t = m.table('helm_ai_runs');

c.check('provider-neutral', /\(provider - 'id' - 'model' - 'modelVersion'\) = '\{\}'::jsonb/.test(t), 'the provider column can hold a vendor-specific payload');
c.check('no-reasoning-trace', /\(output - 'statements' - 'questions' - 'unknowns'\) = '\{\}'::jsonb/.test(t), 'the output column can hold a chain of thought or anything but statements, questions and unknowns');
c.check('no-reasoning-trace', !/\b(reasoning|thoughts?|chain_of_thought|scratchpad|raw_response|completion)\b/i.test(t), 'a column can hold a reasoning trace or a raw model response');
c.check('meta-is-counts', /\(result_meta - 'statementsByClass' - 'evidenceCount' - 'fingerprint'\) = '\{\}'::jsonb/.test(t), 'the result meta can hold more than counts and a fingerprint');
c.check('reproducible-ask', /template_id text NOT NULL/.test(t) && /template_version text NOT NULL/.test(t) && /prompt_hash text NOT NULL/.test(t), 'a run does not name its template, its version and the hash of what was asked');
c.check('governed', /tool_calls jsonb NOT NULL/.test(t) && /evidence_refs jsonb NOT NULL/.test(t) && /grounding jsonb NOT NULL/.test(t), 'a run does not record its tool calls, evidence and grounding');
c.check('tasks', ['EXPLAIN_TWIN_CHANGE', 'EXPLAIN_DECISION', 'DRAFT_MANAGEMENT_BRIEF', 'ASK_HELM', 'COUNCIL'].every((k) => t.includes(`'${k}'`)), 'the AI task vocabulary is not the governed one');
c.check('asked-as', /user_id uuid NOT NULL REFERENCES auth\.users\(id\)/.test(t), 'a run does not record who it read as');
c.check('own-runs', /user_id = \(select auth\.uid\(\)\) OR public\.has_org_role\(org_id, 'admin'\)/.test(m.sql), 'a person can read another person\'s AI runs');
c.check('insert-as-self', /user_id = \(select auth\.uid\(\)\)/.test(m.policy('Record own AI runs')), 'a run can be recorded in someone else\'s name');
c.check('no-write-path', [...m.sql.matchAll(/(?:CREATE POLICY[^;]*?ON|GRANT[^;]*?ON TABLE|ALTER TABLE)\s+public\.([a-z_]+)/g)].every((x) => x[1] === 'helm_ai_runs'), 'the AI migration touches a table other than its own audit trail');
c.check('no-enterprise-truth', !/REFERENCES public\.helm_(?:decisions|value_|twin_|causal_|genome_|counterfactual_|management_)/.test(m.sql), 'an AI run is joined to enterprise truth by foreign key: interpretation is not truth, and it references evidence by content only');

c.finish('one append-only audit table with database record time; provider-neutral identity; statements, questions and unknowns only — no reasoning trace; counts and a fingerprint as meta; own runs read by their asker, admins read all; no write path into enterprise truth');
