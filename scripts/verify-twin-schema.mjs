/**
 * verify:twin-schema — the Phase 7 database invariants, against the migration.
 *
 *   1. Snapshots and their items are RLS-protected, write-once (no UPDATE or
 *      DELETE policy; guards that raise), and a snapshot cannot know what was
 *      recorded after it was built.
 *   2. Every item names a kernel object (refs is a non-empty array).
 *   3. The manifest is complete at commit: item count and derived sensitivity
 *      label match the header (a deferred constraint trigger).
 *   4. An item is read only where its snapshot is visible AND its class cleared.
 *   5. The visibility helpers are SECURITY DEFINER in helm_private — not in the
 *      API-exposed public schema — every policy uses them, and the public ones
 *      are dropped.
 *   6. The metric classes in the migration are exactly the kernel's METRIC_SENSITIVITY.
 *   7. Scenario visibility captures on binding; values, runs and steps follow
 *      the scenario and the class.
 *   8. Decision types: system + organization extension, never a redefinition.
 *   9. The save function writes under the caller's own RLS (SECURITY INVOKER).
 */

import { readFileSync } from 'node:fs';
import { METRIC_SENSITIVITY } from '@helm/twin-runtime';
import { contract } from './lib/twinStack.mjs';

const { check, finish } = contract('verify:twin-schema');
const sql = readFileSync('supabase/migrations/20260929090000_helm_management_twin.sql', 'utf8');
const fnBody = (name) => {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name.replace('.', '\\.')}\\([^)]*\\)[\\s\\S]*?\\$fn\\$([\\s\\S]*?)\\$fn\\$`, 'i').exec(sql);
  return m ? m[0] : '';
};

// 1–2
for (const t of ['helm_twin_snapshots', 'helm_twin_snapshot_items', 'helm_sensitivity_clearances', 'helm_scenario_visibility']) {
  check('rls', new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`).test(sql), `${t} has no RLS`);
}
for (const t of ['helm_twin_snapshots', 'helm_twin_snapshot_items']) {
  check('write-once', !new RegExp(`ON public\\.${t}\\s+FOR\\s+(UPDATE|DELETE)`, 'i').test(sql), `${t} has an UPDATE or DELETE policy`);
}
check('write-once', /IF TG_OP <> 'INSERT' THEN\s+RAISE EXCEPTION 'helm_twin_snapshots: a snapshot is immutable/.test(sql), 'a snapshot can be updated or deleted');
check('write-once', /IF TG_OP <> 'INSERT' THEN\s+RAISE EXCEPTION 'helm_twin_snapshot_items: a manifest item is immutable/.test(sql), 'a manifest item can be updated or deleted');
check('two-time', /CHECK \(recorded_through <= created_at\)/.test(sql), 'a snapshot may claim knowledge recorded after it was built');
check('two-time', /effective_as_of timestamptz NOT NULL,\s*recorded_through timestamptz NOT NULL/.test(sql), 'a snapshot does not carry both lenses');
check('lineage', /refs jsonb NOT NULL CHECK \(jsonb_typeof\(refs\) = 'array' AND jsonb_array_length\(refs\) > 0\)/.test(sql), 'an item may name no kernel object');
// 3
check('manifest', /CREATE CONSTRAINT TRIGGER helm_twin_snapshot_complete_guard[\s\S]{0,120}DEFERRABLE INITIALLY DEFERRED/.test(sql), 'the manifest completeness is not checked at commit');
check('manifest', /n <> NEW\.item_count/.test(fnBody('public.helm_twin_snapshot_complete_guard')) && /sensitivity label is derived/.test(sql), 'the item count or derived label is not enforced');
check('chain', /prev\.kind <> 'CURRENT' OR NEW\.kind <> 'CURRENT' OR prev\.scope_key <> NEW\.scope_key/.test(sql) && /prev\.recorded_through > NEW\.recorded_through/.test(sql), 'the CURRENT chain is not enforced');
// 4
check('items', /"Scoped read twin items"[\s\S]{0,300}helm_private\.can_see_twin_snapshot\(snapshot_id\)[\s\S]{0,80}helm_private\.has_clearance\(org_id, sensitivity\)/.test(sql), 'an item is not read through snapshot visibility AND its class');
check('items', /"Builders write twin items"[\s\S]{0,300}s\.built_by = \(select auth\.uid\(\)\)/.test(sql), 'items can be written into someone else\'s snapshot');
// 5
for (const f of ['visible_org_units', 'can_see_decision', 'can_see_revision', 'has_clearance', 'can_see_scenario', 'can_see_twin_snapshot']) {
  const body = fnBody(`helm_private.${f}`);
  check('private', body.length > 0 && /SECURITY DEFINER/.test(body) && /SET search_path TO 'public', 'pg_temp'/.test(body), `helm_private.${f} is missing, not SECURITY DEFINER, or has no pinned search_path`);
}
check('private', /REVOKE ALL ON SCHEMA helm_private FROM PUBLIC/.test(sql) && /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helm_private FROM PUBLIC, anon/.test(sql), 'helm_private is reachable by PUBLIC or anon');
for (const f of ['helm_can_see_revision', 'helm_can_see_decision', 'helm_visible_org_units']) {
  check('private', new RegExp(`DROP FUNCTION IF EXISTS public\\.${f}\\(uuid\\)`).test(sql), `public.${f} is not dropped`);
}
const repointed = (sql.match(/helm_private\.can_see_decision\(/g) ?? []).length;
check('private', repointed >= 20, `only ${repointed} references to helm_private.can_see_decision — the Phase 6 policies were not all re-pointed`);
check('private', !/public\.helm_can_see_decision\(p_|public\.helm_can_see_decision\((decision_)?id\)/.test(sql), 'a Phase 7 policy still calls the public helper');
// 6
const classesIn = (cls) => {
  const m = new RegExp(`SET sensitivity = '${cls}'\\s+WHERE org_id IS NULL AND key IN \\(([^)]*)\\)`).exec(sql);
  return m ? m[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort() : [];
};
for (const cls of ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'STRATEGIC_RESTRICTED']) {
  const kernel = Object.entries(METRIC_SENSITIVITY).filter(([, c]) => c === cls).map(([k]) => k).sort();
  check('sensitivity', JSON.stringify(classesIn(cls)) === JSON.stringify(kernel), `${cls}: the migration classifies [${classesIn(cls)}] but the kernel [${kernel}]`);
}
check('sensitivity', /coalesce\(p_sensitivity, 'GENERAL_MANAGEMENT'\) = 'GENERAL_MANAGEMENT'/.test(sql) && /public\.has_org_role\(p_org, 'admin'\)/.test(fnBody('helm_private.has_clearance')), 'GENERAL needs a clearance, or admins lack one');
// 7
const scen = fnBody('helm_private.can_see_scenario');
check('scenario', /helm_decision_alternatives a\s+WHERE a\.scenario_id = s\.id AND helm_private\.can_see_decision\(a\.decision_id\)/.test(scen), 'a bound scenario does not inherit the decision\'s audience');
check('scenario', /s\.visibility = 'ORG_WIDE'\s+AND NOT EXISTS \(SELECT 1 FROM public\.helm_decision_alternatives/.test(scen), 'binding does not capture an org-wide scenario');
check('scenario', /"Scoped read value observations"[\s\S]{0,300}has_clearance\(org_id, helm_private\.node_sensitivity\(node_id\)\)[\s\S]{0,120}can_see_scenario_entity\(org_id, scenario_entity_id\)/.test(sql), 'a value does not follow its class and its scenario');
check('scenario', /"Scoped read calculation steps"[\s\S]{0,300}step_cleared\(org_id, output_node_id, inputs\)/.test(sql), 'a calculation step leaks its input values');
check('scenario', /DROP POLICY IF EXISTS "Members read helm_scenarios"/.test(sql) && /DROP POLICY IF EXISTS helm_value_observations_read/.test(sql), 'an org-wide read policy survives on scenarios or observations');
// 8
check('types', /CREATE UNIQUE INDEX IF NOT EXISTS helm_decision_types_system_key ON public\.helm_decision_types \(key\) WHERE org_id IS NULL/.test(sql)
  && /CREATE UNIQUE INDEX IF NOT EXISTS helm_decision_types_org_key ON public\.helm_decision_types \(org_id, key\) WHERE org_id IS NOT NULL/.test(sql), 'decision-type keys are not system-unique and organization-unique');
check('types', /is a HELM system type; an organization extends the registry, it does not redefine it/.test(sql), 'an organization may redefine a system decision type');
check('types', /t\.key = NEW\.decision_type_key AND \(t\.org_id IS NULL OR t\.org_id = NEW\.org_id\)/.test(sql), 'a profile or evaluation may name another organization\'s type');
// 9
check('save', /FUNCTION public\.helm_save_twin_snapshot\(p_header jsonb, p_items jsonb\)[\s\S]{0,120}SECURITY INVOKER/.test(sql), 'the save function does not run under the caller\'s RLS');

finish('write-once twin manifests, per-item sensitivity, private helpers re-pointed, scenario capture, decision-type tenancy');
