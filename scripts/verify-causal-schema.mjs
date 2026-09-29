/**
 * verify:causal-schema — the Phase 8 database says what ADR-0026 says.
 *
 *   - eight causal tables, every one append-only with the record time stamped
 *     by the database, RLS on, reachable only through helm_private helpers;
 *   - no CAUSES in the vocabulary; no unscoped claim; judgement labelled;
 *     a contradictory case never supports; a correction supersedes once;
 *   - no stored status or confidence (both are derived at a lens);
 *   - CALCULATION_DEPENDENCY ≠ CAUSAL_RELATIONSHIP: nothing references a
 *     calculation, a run, an observation or a scenario output;
 *   - a claim is read whole: its classes, its evidence's classes and the
 *     decisions it rests on, all checked.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { contract } from './lib/twinStack.mjs';

const c = contract('verify:causal-schema');
const path = join(process.cwd(), 'supabase', 'migrations', '20260930090000_helm_causal_graph.sql');
c.check('migration', existsSync(path), 'the Phase 8 migration is missing');
const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
const sql = raw.replace(/--[^\n]*/g, ' ');
const table = (name) => {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${name} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
  return m ? m[1] : '';
};

const TABLES = [
  'helm_causal_variables',
  'helm_causal_claims',
  'helm_causal_claim_revisions',
  'helm_causal_evidence',
  'helm_causal_evidence_links',
  'helm_correlation_findings',
  'helm_causal_questions',
  'helm_causal_question_candidates',
];
for (const t of TABLES) {
  c.check('tables', table(t).length > 0, `${t} is not created`);
  c.check('rls', new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`).test(sql), `${t} does not enable RLS`);
  c.check('append-only', new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON public\\.${t} FOR EACH ROW EXECUTE FUNCTION public\\.helm_causal_record_guard\\(\\)`).test(sql), `${t} is not guarded write-once`);
  c.check('record-time', /recorded_at timestamptz NOT NULL/.test(table(t)), `${t} has no record time`);
  c.check('no-delete-policy', !new RegExp(`ON public\\.${t}\\s+FOR (DELETE|UPDATE|ALL)`).test(sql), `${t} has an UPDATE, DELETE or ALL policy`);
}
const guard = /FUNCTION public\.helm_causal_record_guard\(\)[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/.exec(sql)?.[1] ?? '';
c.check('append-only', /TG_OP <> 'INSERT'[\s\S]*RAISE EXCEPTION/.test(guard), 'the record guard does not refuse UPDATE and DELETE');
c.check('record-time', /NEW\.recorded_at := now\(\);/.test(guard), 'the record time is not stamped by the database — a client could back-date knowledge');

const claims = table('helm_causal_claims');
c.check('vocabulary', /relationship_type text NOT NULL CHECK \(relationship_type IN \('INCREASES', 'DECREASES', 'ENABLES', 'CONSTRAINS', 'DELAYS', 'ACCELERATES', 'MEDIATES', 'MODERATES'\)\)/.test(claims), 'the relationship vocabulary is not the eight ADR-0026 verbs');
c.check('vocabulary', !/'CAUSES'/.test(sql), 'the schema can store an unconditional CAUSES');
c.check('scoped', /CONSTRAINT helm_causal_claims_scoped CHECK[\s\S]*jsonb_array_length\(scope->'anchors'\) >= 1[\s\S]*ENTERPRISE_WIDE[\s\S]*>= 12/.test(claims), 'a claim can be stored without a scope, or enterprise-wide without a justification');
c.check('qualifier', /helm_causal_claims_qualifier_coherent CHECK \(\(relationship_type IN \('MEDIATES', 'MODERATES'\)\) = \(target_claim_id IS NOT NULL\)\)/.test(claims), 'a MEDIATES/MODERATES claim need not name what it qualifies');
for (const col of ['status', 'confidence', 'score']) {
  c.check('derived-not-stored', !new RegExp(`^\\s*${col}\\b`, 'm').test(claims) && !new RegExp(`^\\s*${col}\\b`, 'm').test(table('helm_causal_claim_revisions')), `a claim stores a ${col}: status and confidence are derived at a lens`);
}
const evidence = table('helm_causal_evidence');
c.check('judgement', /helm_causal_evidence_judgement_labelled CHECK \(\(type = 'MANAGEMENT_EXPERTISE'\) = \(provenance->>'method' = 'JUDGEMENT'\)\)/.test(evidence), 'management judgement is not forced to be labelled JUDGEMENT');
c.check('provenance', /provenance jsonb NOT NULL CHECK[\s\S]*sourceSystem[\s\S]*sourceReference[\s\S]*assertedByLabel/.test(evidence), 'evidence can be stored without its provenance');
c.check('statistics', /helm_causal_evidence_statistics_stated[\s\S]*limitations/.test(evidence), 'a statistical analysis can omit its limitations');
c.check('supersession', /CREATE UNIQUE INDEX IF NOT EXISTS helm_causal_evidence_superseded_once ON public\.helm_causal_evidence \(supersedes_id\) WHERE supersedes_id IS NOT NULL/.test(sql), 'an item of evidence can be superseded twice');
const links = /FUNCTION public\.helm_causal_links_guard\(\)[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/.exec(sql)?.[1] ?? '';
c.check('contradictory-case', /ev\.type = 'CONTRADICTORY_CASE' AND NEW\.stance = 'SUPPORTS'[\s\S]*RAISE EXCEPTION/.test(links), 'a contradictory case can be linked as support');
c.check('correlation-separate', /evidence_id uuid NOT NULL REFERENCES public\.helm_causal_evidence\(id\)/.test(table('helm_causal_evidence_links')), 'a link can point at something other than evidence');
c.check('correlation-separate', !/correlation/i.test(table('helm_causal_claims')) && !/correlation/i.test(table('helm_causal_evidence_links')), 'a claim or a link references a correlation finding');
const revisions = /FUNCTION public\.helm_causal_revisions_guard\(\)[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/.exec(sql)?.[1] ?? '';
c.check('revisions', /NEW\.revision <> coalesce\(last_rev, 0\) \+ 1/.test(revisions), 'revisions are not forced to be sequential');
c.check('revisions', /last_retired[\s\S]*RAISE EXCEPTION/.test(revisions), 'a retired claim can be revised');

// CALCULATION_DEPENDENCY ≠ CAUSAL_RELATIONSHIP.
for (const t of ['helm_calculation', 'helm_calculation_runs', 'helm_calculation_steps', 'helm_value_observations', 'helm_scenario_runs', 'helm_scenario_overrides', 'helm_value_links']) {
  c.check('causal-vs-calculation', !new RegExp(`\\b${t}\\b`).test(sql), `the causal schema references ${t}`);
}

// Read whole or not at all.
const rowHelper = /FUNCTION helm_private\.causal_claim_row_visible\([\s\S]*?\$fn\$([\s\S]*?)\$fn\$/.exec(sql)?.[1] ?? '';
c.check('security', /LANGUAGE sql\s+STABLE SECURITY DEFINER/.test(/FUNCTION helm_private\.causal_claim_row_visible[\s\S]*?AS \$fn\$/.exec(sql)?.[0] ?? ''), 'the claim rule is not a SECURITY DEFINER helper in helm_private');
c.check('security', /AND helm_private\.has_clearance\(p_org, p_sensitivity\)/.test(rowHelper), 'a claim is readable without clearance for its own class');
c.check('security', /helm_causal_variables v[\s\S]*?NOT helm_private\.has_clearance\(p_org, v\.sensitivity\)/.test(rowHelper), 'a claim does not inherit its variables\' classes');
c.check('security', /WHERE e\.id IN \(SELECT helm_private\.causal_claim_evidence\(p_claim\)\) AND NOT helm_private\.has_clearance\(p_org, e\.sensitivity\)/.test(rowHelper), 'a claim does not inherit its evidence\'s classes');
c.check('security', /helm_private\.causal_claim_decisions\(p_claim\) d WHERE NOT helm_private\.can_see_decision\(d\)/.test(rowHelper), 'a claim is readable by someone who cannot see the decision it rests on');
c.check('security', /visible_org_units/.test(rowHelper), 'a restricted claim is not scoped to its units');
c.check('security', /CREATE POLICY "Scoped read causal claims" ON public\.helm_causal_claims\s+FOR SELECT TO authenticated\s+USING \(public\.is_org_member\(org_id\) AND helm_private\.causal_claim_row_visible\(org_id, id, visibility, authored_by, granted_unit_ids, sensitivity, cause_key, effect_key\)\)/.test(sql), 'the claim read policy does not apply the row rule');
// A SELECT policy that re-reads its own row by id refuses INSERT … RETURNING (found live in Phase 8).
for (const [table, helper] of [['helm_causal_claims', 'can_see_causal_claim'], ['helm_causal_evidence', 'can_see_causal_evidence'], ['helm_causal_questions', 'can_see_causal_question']]) {
  const policy = new RegExp(`CREATE POLICY "[^"]+" ON public\\.${table}\\s+FOR SELECT[^;]*;`).exec(sql)?.[0] ?? '';
  c.check('returning', policy.length > 0 && !new RegExp(`${helper}\\(id\\)`).test(policy), `the ${table} read policy re-reads its own row by id — INSERT … RETURNING would be refused`);
}
c.check('append-only', /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE[\s\S]*?helm_causal_question_candidates\s+FROM authenticated;/.test(sql), 'signed-in clients keep the default UPDATE and DELETE privileges on causal tables');
c.check('security', /CREATE POLICY "Scoped read causal links"[\s\S]*can_see_causal_claim\(claim_id\) AND helm_private\.can_see_causal_evidence\(evidence_id\)/.test(sql), 'a link is readable without both its claim and its evidence');
c.check('security', /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helm_private FROM PUBLIC, anon/.test(sql), 'the causal helpers are callable by anon');
c.check('security', /FUNCTION public\.helm_record_causal_claim\(p_claim jsonb, p_revision jsonb\)[\s\S]*?SECURITY INVOKER/.test(sql), 'the claim writer is not SECURITY INVOKER');

c.finish('8 append-only causal tables, database record time, no CAUSES, scoped claims, judgement labelled, no stored status, nothing referencing the calculation model, claims read whole');
