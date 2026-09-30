/**
 * verify:genome-schema — the Phase 9 database says what ADR-0028 says.
 *
 *   - seven genome tables, every one append-only with the record time stamped
 *     by the database, RLS on, reachable only through helm_private helpers;
 *   - an episode references the kernel and copies none of it: no numbers, no
 *     scores; its sensitivity classes are a derived, checked set;
 *   - no stored status, quality, score or rating — a pattern's status and a
 *     lesson's review status are derived at a lens;
 *   - no person as a feature: nothing about who committed, owned or reviewed;
 *   - a pattern is scoped, states its limitations and one characteristic HELM
 *     can observe; a link's stance must agree with what HELM observed;
 *   - a lesson rests on episodes or patterns and cannot be endorsed by its
 *     author;
 *   - an episode, pattern or lesson is read whole: its units, its classes,
 *     the decision it wraps and every episode it rests on, all checked.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { contract } from './lib/twinStack.mjs';

const c = contract('verify:genome-schema');
const path = join(process.cwd(), 'supabase', 'migrations', '20260930110000_helm_management_genome.sql');
c.check('migration', existsSync(path), 'the Phase 9 migration is missing');
const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
const sql = raw.replace(/--[^\r\n]*/g, ' ');
const table = (name) => {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${name} \\(([\\s\\S]*?)\\r?\\n\\);`).exec(sql);
  return m ? m[1] : '';
};

const TABLES = [
  'helm_genome_episodes',
  'helm_genome_episode_refs',
  'helm_genome_patterns',
  'helm_genome_pattern_revisions',
  'helm_genome_pattern_evidence',
  'helm_genome_lessons',
  'helm_genome_lesson_reviews',
];
for (const t of TABLES) {
  c.check('tables', table(t).length > 0, `${t} is not created`);
  c.check('rls', new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`).test(sql), `${t} does not enable RLS`);
  c.check('append-only', new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON public\\.${t} FOR EACH ROW EXECUTE FUNCTION public\\.helm_genome_record_guard\\(\\)`).test(sql), `${t} is not guarded write-once`);
  c.check('record-time', /recorded_at timestamptz NOT NULL/.test(table(t)), `${t} has no record time`);
  c.check('no-delete-policy', !new RegExp(`ON public\\.${t}\\s+FOR (DELETE|UPDATE|ALL)`).test(sql), `${t} has an UPDATE, DELETE or ALL policy`);
  for (const col of ['status', 'quality', 'score', 'rating', 'verdict', 'rank', 'confidence', 'probability']) {
    // A lesson review's status is the recorded act itself; it is the LESSON's status that is derived from the reviews.
    if (t === 'helm_genome_lesson_reviews' && col === 'status') continue;
    c.check('derived-not-stored', !new RegExp(`^\\s*${col}\\b`, 'm').test(table(t)), `${t} stores a ${col}: it is derived at a lens, or it is not HELM's to say`);
  }
  c.check('no-person-dimension', !/\b(committed_by|owner_id|owner_user|manager|performance|rated_by)\b/i.test(table(t)), `${t} has a column about a person's standing`);
}
const guard = /FUNCTION public\.helm_genome_record_guard\(\)[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/.exec(sql)?.[1] ?? '';
c.check('append-only', /TG_OP <> 'INSERT'[\s\S]*RAISE EXCEPTION/.test(guard), 'the record guard does not refuse UPDATE and DELETE');
c.check('record-time', /NEW\.recorded_at := now\(\);/.test(guard), 'the record time is not stamped by the database — a client could back-date memory');

const episodes = table('helm_genome_episodes');
c.check('episode-shape', /decision_id uuid NOT NULL REFERENCES public\.helm_decisions\(id\) ON DELETE RESTRICT/.test(episodes), 'an episode does not wrap a decision by reference');
c.check('episode-shape', /helm_genome_episodes_one_per_commitment ON public\.helm_genome_episodes \(commitment_id\) WHERE commitment_id IS NOT NULL/.test(sql), 'a commitment can have two episodes');
c.check('episode-shape', /helm_genome_episodes_boundary_ordered CHECK \(boundary_effective <= boundary_recorded\)/.test(episodes), 'an episode can be known before it happened');
c.check('episode-shape', /helm_genome_episodes_scoped CHECK/.test(episodes) && /ENTERPRISE_WIDE[\s\S]*>= 12/.test(episodes), 'an episode can be stored unscoped');
c.check('classes-derived', /sensitivity_classes text\[\] NOT NULL CHECK \(sensitivity_classes <@ ARRAY\['GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED'\]\)/.test(episodes), 'an episode can carry a sensitivity class outside the five');
c.check('references-only', !/\b(numeric|double precision|real)\b/.test(episodes) && !/\b(numeric|double precision|real)\b/.test(table('helm_genome_episode_refs')), 'an episode or its reference row stores a number: an episode copies nothing');
const refs = table('helm_genome_episode_refs');
c.check('ref-roles', /role text NOT NULL CHECK \(role IN \('SITUATION_SNAPSHOT', 'COMMITTED_FUTURE', 'OUTCOME_SNAPSHOT', 'CAUSAL_CONTEXT', 'GOVERNANCE_EVALUATION', 'OUTCOME_REVIEW'\)\)/.test(refs), 'the reference roles are not the six of ADR-0028');
// ADR-0029 widens the set by one — a counterfactual case of the episode's own decision — in the counterfactual migration.
const cfPath = join(process.cwd(), 'supabase', 'migrations', '20260930120000_helm_counterfactuals.sql');
const cfSql = existsSync(cfPath) ? readFileSync(cfPath, 'utf8').replace(/--[^\r\n]*/g, ' ') : '';
c.check('ref-roles', /helm_genome_episode_refs_role_check\s+CHECK \(role IN \('SITUATION_SNAPSHOT', 'COMMITTED_FUTURE', 'OUTCOME_SNAPSHOT', 'CAUSAL_CONTEXT', 'GOVERNANCE_EVALUATION', 'OUTCOME_REVIEW', 'COUNTERFACTUAL_CASE'\)\)/.test(cfSql), 'the reference roles are not the seven of ADR-0028 and ADR-0029');
c.check('ref-once', /helm_genome_episode_refs_once ON public\.helm_genome_episode_refs \(episode_id, role, \(ref->>'id'\)\)/.test(sql), 'the same reference can be bound twice in one role');

const patterns = table('helm_genome_patterns');
c.check('pattern-scoped', /helm_genome_patterns_scoped CHECK[\s\S]*jsonb_array_length\(scope->'anchors'\) >= 1[\s\S]*ENTERPRISE_WIDE[\s\S]*>= 12/.test(patterns), 'a pattern can be stored without a scope, or enterprise-wide without a justification');
c.check('pattern-observable', /characteristic jsonb NOT NULL CHECK \(characteristic->>'kind' IN \('OUTCOME_VS_EXPECTATION', 'ASSUMPTION_OUTCOME', 'PROCESS_FEATURE'\)\)/.test(patterns), 'a pattern can carry a characteristic HELM cannot observe');
c.check('pattern-limitations', /limitations text NOT NULL CHECK \(char_length\(btrim\(limitations\)\) >= 1\)/.test(table('helm_genome_pattern_revisions')), 'a pattern revision can omit its limitations');
c.check('pattern-revisions', /UNIQUE \(pattern_id, revision\)/.test(table('helm_genome_pattern_revisions')), 'revisions are not unique per pattern');
const revisions = /FUNCTION public\.helm_genome_pattern_revisions_guard\(\)[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/.exec(sql)?.[1] ?? '';
c.check('pattern-revisions', /NEW\.revision <> coalesce\(last_rev, 0\) \+ 1/.test(revisions), 'revisions are not forced to be sequential');
c.check('pattern-revisions', /coalesce\(last_retired, false\)[\s\S]*RAISE EXCEPTION/.test(revisions), 'a retired pattern can be revised');
c.check('pattern-complete', /CREATE CONSTRAINT TRIGGER helm_genome_pattern_complete_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED/.test(sql), 'a pattern can be recorded without its first revision');
const evidence = table('helm_genome_pattern_evidence');
c.check('stance-agrees', /helm_genome_pattern_evidence_stance_agrees CHECK \(\s*\(stance = 'SUPPORTING_EPISODE' AND observed = 'SUPPORTS'\)\s*OR \(stance = 'CONTRADICTORY_EPISODE' AND observed = 'CONTRADICTS'\)\s*OR stance = 'CONTEXTUAL_EPISODE'\s*\)/.test(evidence), 'a person can record a stance HELM did not observe');
c.check('link-once', /UNIQUE \(pattern_id, episode_id\)/.test(evidence), 'a stance can be rewritten by linking the same episode again');
const evGuard = /FUNCTION public\.helm_genome_pattern_evidence_guard\(\)[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/.exec(sql)?.[1] ?? '';
c.check('retired-takes-nothing', /coalesce\(latest_retired, false\)[\s\S]*RAISE EXCEPTION/.test(evGuard), 'a retired pattern takes further episodes');

const lessons = table('helm_genome_lessons');
c.check('lesson-evidence', /jsonb_array_length\(evidence\) >= 1/.test(lessons), 'a lesson can rest on nothing');
const lessonGuard = /FUNCTION public\.helm_genome_lessons_guard\(\)[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/.exec(sql)?.[1] ?? '';
c.check('lesson-evidence', /MANAGEMENT_EPISODE[\s\S]*MANAGEMENT_PATTERN[\s\S]*a lesson rests on episodes or patterns of this genome/.test(lessonGuard), 'a lesson can rest on something other than genome episodes and patterns');
c.check('lesson-review', /status text NOT NULL CHECK \(status IN \('ENDORSED', 'DISPUTED', 'RETIRED'\)\)/.test(table('helm_genome_lesson_reviews')), 'PROPOSED is stored: it is the absence of a review');
const reviewGuard = /FUNCTION public\.helm_genome_lesson_reviews_guard\(\)[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/.exec(sql)?.[1] ?? '';
c.check('self-endorsement', /NEW\.status = 'ENDORSED' AND NEW\.reviewed_by IS NOT NULL AND NEW\.reviewed_by = author[\s\S]*RAISE EXCEPTION/.test(reviewGuard), 'an author can endorse their own lesson');

// The genome points at the model; it never reaches into it by foreign key.
for (const t of ['helm_calculation', 'helm_calculation_runs', 'helm_calculation_steps', 'helm_value_observations', 'helm_scenario_runs', 'helm_scenario_overrides', 'helm_value_links', 'helm_causal_claims', 'helm_authority_rules']) {
  c.check('no-reach', !new RegExp(`\\b${t}\\b`).test(sql), `the genome schema references ${t}: an episode points at artifacts by reference, in the record, not by foreign key`);
}

// Read whole or not at all.
const episodeRule = /FUNCTION helm_private\.genome_episode_row_visible\([\s\S]*?\$fn\$([\s\S]*?)\$fn\$/.exec(sql)?.[1] ?? '';
c.check('security', /LANGUAGE sql\s+STABLE SECURITY DEFINER/.test(/FUNCTION helm_private\.genome_episode_row_visible[\s\S]*?AS \$fn\$/.exec(sql)?.[0] ?? ''), 'the episode rule is not a SECURITY DEFINER helper in helm_private');
c.check('security', /NOT EXISTS \(SELECT 1 FROM unnest\(p_classes\) k WHERE NOT helm_private\.has_clearance\(p_org, k\)\)/.test(episodeRule), 'an episode is readable without clearance for every class it carries');
c.check('security', /helm_private\.can_see_decision\(p_decision\)/.test(episodeRule), 'an episode is readable by someone who cannot see the decision it wraps');
c.check('security', /visible_org_units/.test(episodeRule), 'a restricted episode is not scoped to its units');
const patternRule = /FUNCTION helm_private\.genome_pattern_row_visible\([\s\S]*?\$fn\$([\s\S]*?)\$fn\$/.exec(sql)?.[1] ?? '';
c.check('security', /helm_genome_pattern_evidence e[\s\S]*NOT helm_private\.can_see_genome_episode\(e\.episode_id\)/.test(patternRule), 'a pattern is readable by someone who cannot read every episode it rests on');
const lessonRule = /FUNCTION helm_private\.genome_lesson_row_visible\([\s\S]*?\$fn\$([\s\S]*?)\$fn\$/.exec(sql)?.[1] ?? '';
c.check('security', /can_see_genome_episode\(\(r->>'id'\)::uuid\)[\s\S]*can_see_genome_pattern\(\(r->>'id'\)::uuid\)/.test(lessonRule), 'a lesson is readable by someone who cannot read every episode and pattern it rests on');
// A SELECT policy that re-reads its own row by id refuses INSERT … RETURNING.
for (const [tbl, helper] of [['helm_genome_episodes', 'can_see_genome_episode'], ['helm_genome_patterns', 'can_see_genome_pattern'], ['helm_genome_lessons', 'can_see_genome_lesson']]) {
  const policy = new RegExp(`CREATE POLICY "[^"]+" ON public\\.${tbl}\\s+FOR SELECT[^;]*;`).exec(sql)?.[0] ?? '';
  c.check('returning', policy.length > 0 && !new RegExp(`${helper}\\(id\\)`).test(policy), `the ${tbl} read policy re-reads its own row by id — INSERT … RETURNING would be refused`);
}
c.check('append-only', /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE[\s\S]*?helm_genome_lesson_reviews\s+FROM authenticated;/.test(sql), 'signed-in clients keep the default UPDATE and DELETE privileges on genome tables');
c.check('security', /CREATE POLICY "Scoped read genome pattern evidence"[\s\S]*can_see_genome_pattern\(pattern_id\) AND helm_private\.can_see_genome_episode\(episode_id\)/.test(sql), 'a link is readable without both its pattern and its episode');
c.check('security', /CREATE POLICY "Members open genome episodes"[\s\S]*authored_by = \(select auth\.uid\(\)\)[\s\S]*can_see_decision\(decision_id\)[\s\S]*has_clearance\(org_id, k\)/.test(sql), 'an episode can be opened by someone who cannot read what it wraps, or in another name');
c.check('security', /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helm_private FROM PUBLIC, anon/.test(sql), 'the genome helpers are callable by anon');
c.check('security', /FUNCTION public\.helm_record_genome_pattern\(p_pattern jsonb, p_revision jsonb\)[\s\S]*?SECURITY INVOKER/.test(sql), 'the pattern writer is not SECURITY INVOKER');
c.check('additive', !/\b(DROP TABLE|TRUNCATE TABLE)\b/i.test(sql) && !/ALTER TABLE public\.(accounts|opportunities|contacts|activities)\b/i.test(sql), 'the migration touches a Memoire object or drops a table');

c.finish('7 append-only genome tables, database record time, no stored status/score/rating, no person feature, scoped observable patterns, stance agrees with HELM, no self-endorsement, references only, read whole');
