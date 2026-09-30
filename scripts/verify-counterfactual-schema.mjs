/**
 * verify:counterfactual-schema — the database says what ADR-0029 says.
 *
 *   - three counterfactual tables (case, world, review), every one append-only
 *     with the record time stamped by the database, RLS on, reachable only
 *     through helm_private helpers;
 *   - a case is anchored to the past and to one decision; the two retrospective
 *     lenses are stored apart and a hindsight world carries hindsight inputs;
 *   - the method is MODEL_COUNTERFACTUAL and an estimate is ESTIMATED or
 *     NOT_ESTIMABLE — no probability, score, regret or verdict is stored;
 *   - a world that cannot be estimated says why; a review is pinned to the
 *     comparison it read and states its limitations;
 *   - a case is read whole: its units, every class of what it compares and
 *     declares, the decision it reviews;
 *   - the genome may reference a case, and only the case of its own decision.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { contract } from './lib/twinStack.mjs';

const c = contract('verify:counterfactual-schema');
const path = join(process.cwd(), 'supabase', 'migrations', '20260930120000_helm_counterfactuals.sql');
c.check('migration', existsSync(path), 'the counterfactual migration is missing');
const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
const sql = raw.replace(/--[^\r\n]*/g, ' ');
const table = (name) => {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${name} \\(([\\s\\S]*?)\\r?\\n\\);`).exec(sql);
  return m ? m[1] : '';
};
const fn = (name) => new RegExp(`FUNCTION ${name}\\([\\s\\S]*?\\$fn\\$([\\s\\S]*?)\\$fn\\$`).exec(sql)?.[1] ?? '';

const TABLES = ['helm_counterfactual_cases', 'helm_counterfactual_worlds', 'helm_counterfactual_reviews'];
for (const t of TABLES) {
  c.check('tables', table(t).length > 0, `${t} is not created`);
  c.check('rls', new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`).test(sql), `${t} does not enable RLS`);
  c.check('append-only', new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON public\\.${t} FOR EACH ROW EXECUTE FUNCTION public\\.helm_counterfactual_record_guard\\(\\)`).test(sql), `${t} is not guarded write-once`);
  c.check('record-time', /recorded_at timestamptz NOT NULL/.test(table(t)), `${t} has no record time`);
  c.check('no-delete-policy', !new RegExp(`ON public\\.${t}\\s+FOR (DELETE|UPDATE|ALL)`).test(sql), `${t} has an UPDATE, DELETE or ALL policy`);
  for (const col of ['status', 'quality', 'score', 'rating', 'verdict', 'rank', 'regret', 'confidence', 'probability', 'winner']) {
    c.check('derived-not-stored', !new RegExp(`^\\s*${col}\\b`, 'm').test(table(t)), `${t} stores a ${col}: it is derived at a lens, or it is not HELM's to say`);
  }
  c.check('no-person-dimension', !/\b(committed_by|owner_id|owner_user|manager|performance|rated_by)\b/i.test(table(t)), `${t} has a column about a person's standing`);
}
const guard = fn('public\\.helm_counterfactual_record_guard');
c.check('append-only', /TG_OP <> 'INSERT'[\s\S]*RAISE EXCEPTION/.test(guard), 'the record guard does not refuse UPDATE and DELETE');
c.check('record-time', /NEW\.recorded_at := now\(\);/.test(guard), 'the record time is not stamped by the database — a client could back-date memory');

const cases = table('helm_counterfactual_cases');
c.check('case-shape', /decision_id uuid NOT NULL REFERENCES public\.helm_decisions\(id\) ON DELETE RESTRICT/.test(cases), 'a case does not review a decision by reference');
c.check('case-shape', /helm_counterfactual_cases_boundary_ordered CHECK \(boundary_effective <= boundary_recorded\)/.test(cases), 'a case can be known before it happened');
c.check('anchored-in-the-past', /helm_counterfactual_cases_anchored_in_the_past CHECK \(anchor_recorded <= boundary_recorded\)/.test(cases), 'a case can be anchored to a state recorded AFTER the decision: hindsight as the starting point');
c.check('case-shape', /helm_counterfactual_cases_scoped CHECK/.test(cases) && /ENTERPRISE_WIDE[\s\S]*>= 12/.test(cases), 'a case can be stored unscoped');
c.check('case-shape', /intervention jsonb NOT NULL CHECK/.test(cases) && /CHOOSE_ALTERNATIVE/.test(cases) && /OVERRIDES/.test(cases), 'a case can be stored without a stated intervention');
c.check('classes-derived', /sensitivity_classes text\[\] NOT NULL CHECK \(sensitivity_classes <@ ARRAY\['GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED'\]\)/.test(cases), 'a case can carry a sensitivity class outside the five');
const caseGuard = fn('public\\.helm_counterfactual_cases_guard');
c.check('case-guard', /helm_decisions/.test(caseGuard) && /RAISE EXCEPTION/.test(caseGuard), 'a case is not checked against the decision it reviews');

const worlds = table('helm_counterfactual_worlds');
c.check('lens', /lens text NOT NULL CHECK \(lens IN \('AS_KNOWN_THEN', 'WITH_HINDSIGHT'\)\)/.test(worlds), 'the retrospective lenses are not exactly AS_KNOWN_THEN and WITH_HINDSIGHT');
c.check('method', /method text NOT NULL CHECK \(method = 'MODEL_COUNTERFACTUAL'\)/.test(worlds), 'a world can claim a method other than a model counterfactual');
c.check('estimability', /estimability text NOT NULL CHECK \(estimability IN \('ESTIMATED', 'NOT_ESTIMABLE'\)\)/.test(worlds), 'estimability is not ESTIMATED or NOT_ESTIMABLE');
c.check('lenses-apart', /helm_counterfactual_worlds_lenses_apart CHECK/.test(worlds) && /hindsight_inputs/.test(worlds), 'the lenses are not kept apart by the schema');
c.check('says-why', /helm_counterfactual_worlds_says_why CHECK \(estimability = 'ESTIMATED' OR jsonb_array_length\(not_estimable_reasons\) >= 1\)/.test(worlds), 'a world that cannot be estimated can omit why');
c.check('has-a-run', /helm_counterfactual_worlds_estimated_has_a_run CHECK/.test(worlds), 'an estimated world can exist without a run');
c.check('uncertainty', /uncertainty jsonb NOT NULL CHECK \(jsonb_typeof\(uncertainty\) = 'array' AND jsonb_array_length\(uncertainty\) >= 1\)/.test(worlds), 'a world can omit its uncertainty');
c.check('fingerprint', /fingerprint text NOT NULL/.test(worlds), 'a world has no content fingerprint');
c.check('no-interval', !/\b(lower_bound|upper_bound|interval|std|variance|p_value)\b/i.test(worlds), 'a world stores an interval or a statistic: the uncertainty is a list, not a number');
const worldGuard = fn('public\\.helm_counterfactual_worlds_guard');
c.check('world-guard', /RAISE EXCEPTION/.test(worldGuard), 'the world guard refuses nothing');

const reviews = table('helm_counterfactual_reviews');
c.check('review-pinned', /comparison_fingerprint text NOT NULL/.test(reviews), 'a review is not pinned to the comparison it read');
c.check('review-limitations', /limitations text NOT NULL CHECK \(char_length\(btrim\(limitations\)\) >= 1\)/.test(reviews), 'a review can omit its limitations');
const reviewGuard = fn('public\\.helm_counterfactual_reviews_guard');
c.check('review-needs-world', /helm_counterfactual_worlds/.test(reviewGuard) && /RAISE EXCEPTION/.test(reviewGuard), 'a review can be recorded with no world to read');

const own = table('helm_counterfactual_cases') + table('helm_counterfactual_worlds') + table('helm_counterfactual_reviews');
for (const t of ['helm_calculation', 'helm_calculation_runs', 'helm_value_observations', 'helm_scenario_overrides', 'helm_causal_claims', 'helm_authority_rules', 'helm_genome_episodes']) {
  c.check('no-reach', !new RegExp(`\\b${t}\\b`).test(own), `a counterfactual table references ${t} by foreign key: a case points at artifacts by reference, in the record`);
}

// A world's lineage IS the run it read: the one foreign key into the model, and it cannot be deleted from under the world.
c.check('lineage', /scenario_run_id uuid REFERENCES public\.helm_scenario_runs\(id\) ON DELETE RESTRICT/.test(worlds), 'a world does not point at the run it read, or that run can be deleted from under it');

const rule = fn('helm_private\\.counterfactual_case_row_visible');
c.check('security', /LANGUAGE sql\s+STABLE SECURITY DEFINER/.test(/FUNCTION helm_private\.counterfactual_case_row_visible[\s\S]*?AS \$fn\$/.exec(sql)?.[0] ?? ''), 'the case rule is not a SECURITY DEFINER helper in helm_private');
c.check('security', /NOT EXISTS \(SELECT 1 FROM unnest\(p_classes\) k WHERE NOT helm_private\.has_clearance\(p_org, k\)\)/.test(rule), 'a case is readable without clearance for every class it carries');
c.check('security', /helm_private\.can_see_decision\(p_decision\)/.test(rule), 'a case is readable by someone who cannot see the decision it reviews');
c.check('security', /visible_org_units/.test(rule), 'a restricted case is not scoped to its units');
const casePolicy = /CREATE POLICY "Scoped read counterfactual cases" ON public\.helm_counterfactual_cases\s+FOR SELECT[^;]*;/.exec(sql)?.[0] ?? '';
c.check('returning', casePolicy.length > 0 && !/can_see_counterfactual_case\(id\)/.test(casePolicy), 'the case read policy re-reads its own row by id — INSERT … RETURNING would be refused');
c.check('append-only', /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE[\s\S]*?helm_counterfactual_reviews\s+FROM authenticated;/.test(sql), 'signed-in clients keep the default UPDATE and DELETE privileges on counterfactual tables');
c.check('security', /CREATE POLICY "Members open counterfactual cases"[\s\S]*can_see_decision\(decision_id\)[\s\S]*has_clearance\(org_id, k\)/.test(sql), 'a case can be opened by someone who cannot read what it reviews');
c.check('security', /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helm_private FROM PUBLIC, anon/.test(sql), 'the counterfactual helpers are callable by anon');

c.check('genome-role', /role IN \('SITUATION_SNAPSHOT', 'COMMITTED_FUTURE', 'OUTCOME_SNAPSHOT', 'CAUSAL_CONTEXT', 'GOVERNANCE_EVALUATION', 'OUTCOME_REVIEW', 'COUNTERFACTUAL_CASE'\)/.test(sql), 'the genome cannot reference a counterfactual case');
const refGuard = fn('public\\.helm_genome_episode_refs_guard');
c.check('genome-guard', /COUNTERFACTUAL_CASE/.test(refGuard) && /decision_id/.test(refGuard) && /sensitivity_classes/.test(refGuard), 'an episode can reference a case of another decision, or one carrying a class the episode does not');
c.check('additive', !/\b(DROP TABLE|TRUNCATE TABLE)\b/i.test(sql) && !/ALTER TABLE public\.(accounts|opportunities|contacts|activities)\b/i.test(sql), 'the migration touches a Memoire object or drops a table');

c.finish('3 append-only tables, database record time, anchored to the past, lenses apart, MODEL_COUNTERFACTUAL only, no stored score/verdict/interval, reviews pinned and limited, read whole, references only');
