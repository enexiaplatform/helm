/**
 * A mutation harness for the kernel, counterfactual, integration, review, intelligence and council contracts.
 *
 * A verifier that passes proves nothing on its own: it might assert nothing at
 * all, or assert something that cannot fail. So each contract is also run
 * against deliberately broken code. For every mutation below, the named
 * verifier MUST fail — if it still passes, the assertion it was supposed to
 * make is vacuous and the contract is a decoration.
 *
 * Mutations are applied to the file on disk and reverted immediately, whatever
 * happens. Nothing is left behind: `git status` is unchanged after a run.
 *
 * Usage: node scripts/lib/mutate.mjs [verifier-name-substring]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const K = 'packages/decision-runtime/src';
const A = 'packages/authority-runtime/src';
const MIGRATION = 'supabase/migrations/20260923100000_helm_decision_runtime.sql';
const MIGRATION6 = 'supabase/migrations/20260928100000_helm_decision_authority.sql';
const MIGRATION7 = 'supabase/migrations/20260929090000_helm_management_twin.sql';
const T = 'packages/twin-runtime/src';
const MIGRATION8 = 'supabase/migrations/20260930090000_helm_causal_graph.sql';
const C8 = 'packages/causal-runtime/src';
const MIGRATION9 = 'supabase/migrations/20260930110000_helm_management_genome.sql';
const G9 = 'packages/genome-runtime/src';
const MIGRATION_INT = 'supabase/migrations/20260930130000_helm_integration_fabric.sql';
const MIGRATION_REV = 'supabase/migrations/20260930140000_helm_management_reviews.sql';
const MIGRATION_AI = 'supabase/migrations/20260930150000_helm_intelligence_audit.sql';
const INT = 'packages/integration-runtime/src';
const REV = 'packages/review-runtime/src';
const AI = 'packages/intelligence-runtime/src';
const AG = 'packages/agent-runtime/src';

/**
 * Each mutation: which contract must catch it, which invariant it attacks, and
 * the smallest edit that breaks that invariant.
 */
const MUTATIONS = [
  // -------------------------------------------------- verify:decision-schema
  {
    verifier: 'verify-decision-schema.mjs',
    invariant: 'a commitment cannot be edited after the fact',
    file: MIGRATION,
    from: "    RAISE EXCEPTION 'helm_decision_commitments: a commitment is what management decided; it is never edited or deleted';",
    to: '    RETURN COALESCE(NEW, OLD);',
  },
  {
    verifier: 'verify-decision-schema.mjs',
    invariant: 'the database cannot store an authority verdict',
    file: MIGRATION,
    from: "CHECK (authority_status = 'NOT_EVALUATED')",
    to: "CHECK (authority_status IN ('NOT_EVALUATED', 'AUTHORIZED'))",
    all: true,
  },
  {
    verifier: 'verify-decision-schema.mjs',
    invariant: 'a MODELLED alternative must reference the simulation behind it',
    file: MIGRATION,
    from: '      AND scenario_id IS NOT NULL AND scenario_revision_id IS NOT NULL AND scenario_run_id IS NOT NULL',
    to: '      AND TRUE',
  },
  {
    verifier: 'verify-decision-schema.mjs',
    invariant: 'a weight exists only where management asked for one',
    file: MIGRATION,
    from: 'CONSTRAINT helm_decision_criteria_weight_coherent CHECK',
    to: 'CONSTRAINT helm_decision_criteria_weight_relaxed CHECK',
  },
  {
    verifier: 'verify-decision-schema.mjs',
    invariant: 'the migration is additive',
    file: MIGRATION,
    from: '-- ---------------------------------------------------------------------- RLS',
    to: 'ALTER TABLE public.helm_decisions DROP COLUMN IF EXISTS context;\n-- ---------------------------------------------------------------------- RLS',
  },

  // ------------------------------------------------- verify:decision-runtime
  {
    verifier: 'verify-decision-runtime.mjs',
    invariant: 'HELM does not rate a qualitative criterion nobody assessed',
    file: `${K}/criteria.ts`,
    from: "        const outcome = assessment ? ('ASSESSED' as const) : ('NOT_ASSESSED' as const);",
    to: "        const outcome = 'ASSESSED' as const;",
  },
  {
    verifier: 'verify-decision-runtime.mjs',
    invariant: 'a blocked metric stays blocked instead of becoming a zero',
    file: `${K}/criteria.ts`,
    from: '      const v = criterion.metricKey ? pickCriterionValue(state, criterion, period) : undefined;',
    to: '      const v0 = criterion.metricKey ? pickCriterionValue(state, criterion, period) : undefined;\n      const v = v0 && v0.value === null ? { ...v0, value: \'0\' } : v0;',
  },
  {
    verifier: 'verify-decision-runtime.mjs',
    invariant: 'readiness names each gap by its own code',
    file: `${K}/readiness.ts`,
    from: "        code: 'alternative-unmodelled',",
    to: "        code: 'noted',",
  },
  {
    verifier: 'verify-decision-runtime.mjs',
    invariant: 'no dominance statement tells the reader what to do',
    file: `${K}/tradeoff.ts`,
    from: '          `Under the current model, ${x.alternative.label} is better than ${y.alternative.label} on ` +',
    to: '          `Under the current model, you should choose ${x.alternative.label} over ${y.alternative.label} on ` +',
  },
  {
    verifier: 'verify-decision-runtime.mjs',
    invariant: 'nothing in the decision layer carries a score',
    file: `${K}/readiness.ts`,
    from: '  return {\n    decisionId: input.decisionId,\n    revisionId: input.revisionId,\n    state,',
    to: '  return {\n    score: 100 - gaps.length * 10,\n    decisionId: input.decisionId,\n    revisionId: input.revisionId,\n    state,',
  },

  // ------------------------------------------------- verify:decision-lineage
  {
    verifier: 'verify-decision-lineage.mjs',
    invariant: 'an expected outcome names the value node it was read from',
    file: `${K}/runtime.ts`,
    from: "        kind: 'MODELLED',\n        nodeId: value.nodeId,",
    to: "        kind: 'MODELLED',\n        nodeId: null,",
  },
  {
    verifier: 'verify-decision-lineage.mjs',
    invariant: 'a criterion evaluation carries the node and period behind its value',
    file: `${K}/criteria.ts`,
    from: '        nodeId: v.nodeId,\n        period: v.period,',
    to: '        nodeId: null,\n        period: null,',
  },
  {
    verifier: 'verify-decision-lineage.mjs',
    invariant: 'an expected outcome agrees with the chosen future state',
    file: `${K}/runtime.ts`,
    from: '        expectedValue: value.value,\n        unit: value.unit,',
    to: "        expectedValue: value.value === null ? null : '0',\n        unit: value.unit,",
  },

  // -------------------------------------------- verify:decision-immutability
  {
    verifier: 'verify-decision-immutability.mjs',
    invariant: 'a sealed revision refuses every edit',
    file: `${K}/inMemoryStore.ts`,
    from: "    if (r.state === 'SEALED') {\n      return {\n        error: fail(",
    to: '    if (r.state === (\'NEVER\' as unknown as typeof r.state)) {\n      return {\n        error: fail(',
  },
  {
    verifier: 'verify-decision-immutability.mjs',
    invariant: 'reconsidering opens a new revision that links back to what it reconsiders',
    file: `${K}/runtime.ts`,
    from: "        reason: 'RECONSIDERED',",
    to: "        reason: 'REVISED',",
  },
  {
    verifier: 'verify-decision-immutability.mjs',
    invariant: 'an outcome review reports variance without passing judgement',
    file: `${K}/runtime.ts`,
    from: "          'Expected against actual, and how the assumptions turned out. This is not a verdict on the ' +",
    to: "          'Expected against actual. This says whether the decision was good. ' +",
  },

  // -------------------------------------- verify:decision-scenario-binding
  {
    verifier: 'verify-decision-scenario-binding.mjs',
    invariant: 'a criterion value is read from its own alternative’s simulation',
    file: `${K}/criteria.ts`,
    from: '  for (const criterion of criteria) {\n    for (const { alternative, state } of alternatives) {',
    to: '  for (const criterion of criteria) {\n    for (const [i, { alternative }] of alternatives.entries()) {\n      const state = alternatives[(i + 1) % alternatives.length].state;',
  },
  {
    verifier: 'verify-decision-scenario-binding.mjs',
    invariant: 'mixed knowledge boundaries are surfaced, not silently compared',
    file: `${K}/readiness.ts`,
    from: "      code: 'mixed-knowledge-boundaries',",
    to: "      code: 'noted',",
  },

  // ================================================================ Phase 6

  // ------------------------------------------------- verify:authority-schema
  {
    verifier: 'verify-authority-schema.mjs',
    invariant: 'the committer cannot be their own independent approval (separation of duties)',
    file: MIGRATION6,
    from: '  IF req.independent_of_user_id IS NOT NULL AND NEW.approver_user_id = req.independent_of_user_id THEN',
    to: '  IF false THEN',
  },
  {
    verifier: 'verify-authority-schema.mjs',
    invariant: 'an authority evaluation is never edited',
    file: MIGRATION6,
    from: "    RAISE EXCEPTION 'helm_authority_evaluations: an evaluation is a record of a judgement; it is never edited or deleted';",
    to: '    RETURN COALESCE(NEW, OLD);',
  },
  {
    verifier: 'verify-authority-schema.mjs',
    invariant: 'an approval is recorded only as the authenticated caller',
    file: MIGRATION6,
    from: '    AND approver_user_id = (select auth.uid())\n',
    to: '',
  },
  {
    verifier: 'verify-authority-schema.mjs',
    invariant: 'a decision is no longer readable by every organization member',
    file: MIGRATION6,
    from: '  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND public.helm_can_see_decision(id));',
    to: '  FOR SELECT TO authenticated USING (public.is_org_member(org_id));',
  },
  {
    verifier: 'verify-authority-schema.mjs',
    invariant: 'no typed economics in the authority schema',
    file: MIGRATION6,
    from: "  comments text NOT NULL DEFAULT '',",
    to: "  approval_amount numeric,\n  comments text NOT NULL DEFAULT '',",
  },

  // ------------------------------------------------ verify:authority-runtime
  {
    verifier: 'verify-authority-runtime.mjs',
    invariant: 'the actor is the identity that committed, not whoever evaluates',
    file: `${A}/runtime.ts`,
    from: '        actor: { userId: committer, label: seat?.personLabel ?? c.commitment.committedByLabel },',
    to: '        actor: { userId: scope.actorId, label: seat?.personLabel ?? c.commitment.committedByLabel },',
  },
  {
    verifier: 'verify-authority-runtime.mjs',
    invariant: 'an escalated approval must be independent of the committer',
    file: `${A}/engine.ts`,
    from: "    rule.approvalIndependence === 'INDEPENDENT_OF_COMMITTER' ? input.committerUserId : null;",
    to: '    null;',
  },
  {
    verifier: 'verify-authority-runtime.mjs',
    invariant: 'a pending approval is not reported as approved',
    file: `${A}/state.ts`,
    from: "  else progress = 'PENDING';",
    to: "  else progress = 'APPROVED';",
  },

  // -------------------------------------------------- verify:authority-scope
  {
    verifier: 'verify-authority-scope.mjs',
    invariant: 'scope is derived through the portfolio owner, not typed',
    file: `${A}/scope.ts`,
    from: "  { relationshipTypeKey: 'OWNS', direction: 'in', reads: 'is owned by' },",
    to: '',
  },
  {
    verifier: 'verify-authority-scope.mjs',
    invariant: 'a touched entity outside the rule\u2019s scope is noticed',
    file: `${A}/scope.ts`,
    from: '          const stray = here.filter((r) => !allowed.has(r.entityId));',
    to: '          const stray = here.filter((r) => !allowed.has(r.entityId) && false);',
  },
  {
    verifier: 'verify-authority-scope.mjs',
    invariant: 'an entity anchored above a rule\u2019s level is outside it',
    file: `${A}/scope.ts`,
    from: '        if (above) outside.push(`${t.label} (sits above ${readableDimension(d)} level)`);',
    to: '        if (above) unknown.push(t.label);',
  },

  // ---------------------------------------------- verify:authority-threshold
  {
    verifier: 'verify-authority-threshold.mjs',
    invariant: 'the line itself is inside a ≥ line (exact boundary)',
    file: `${A}/conditions.ts`,
    from: '      return cmp >= 0;',
    to: '      return cmp > 0;',
  },
  {
    verifier: 'verify-authority-threshold.mjs',
    invariant: 'an UNKNOWN line never passes',
    file: `${A}/conditions.ts`,
    from: "  if (checks.some((c) => c.outcome === 'UNKNOWN')) return 'UNKNOWN';",
    to: "  if (checks.some((c) => c.outcome === 'UNKNOWN')) return 'PASS';",
  },
  {
    verifier: 'verify-authority-threshold.mjs',
    invariant: 'thresholds compare exact decimals, not floats',
    file: `${A}/conditions.ts`,
    from: '  const cmp = compare(decimal(v.value), decimal(condition.threshold));',
    to: '  const cmp = Math.sign(Number(v.value) - Number(condition.threshold)) as -1 | 0 | 1;',
  },

  // --------------------------------------------- verify:authority-delegation
  {
    verifier: 'verify-authority-delegation.mjs',
    invariant: 'delegated authority is intersected with the delegator\u2019s own',
    file: `${A}/engine.ts`,
    from: '  const checks = [...own.deciding.conditionChecks, ...checkConditions(d.conditions, input.consequences)];',
    to: '  const checks = [...checkConditions(d.conditions, input.consequences)];',
  },
  {
    verifier: 'verify-authority-delegation.mjs',
    invariant: 'outside its window a delegation does not exist',
    file: `${A}/engine.ts`,
    from: '  if (!openAt(d.validFrom, d.validTo, at)) {',
    to: '  if (false) {',
  },
  {
    verifier: 'verify-authority-delegation.mjs',
    invariant: 'a delegation cannot reach beyond the delegator\u2019s scope',
    file: `${A}/delegation.ts`,
    from: '        const scope = constraintsWithin(draft.scope, rule.scope, input.ancestry);',
    to: '        const scope = { within: true, problems: [] as string[] };',
  },

  // ------------------------------------------------ verify:approval-lineage
  {
    verifier: 'verify-approval-lineage.mjs',
    invariant: 'an approval resolves to the value lineage of its consequences',
    file: `${A}/runtime.ts`,
    from: '        if (l.ok) valueLineage.push(l.value);',
    to: '        void l;',
  },
  {
    verifier: 'verify-approval-lineage.mjs',
    invariant: 'the authority evaluation is on the decision timeline',
    file: `${A}/runtime.ts`,
    from: "      await event(scope, c.decisionId, 'AUTHORITY_EVALUATED', {",
    to: "      await event(scope, c.decisionId, 'EVALUATED', {",
  },

  // ---------------------------------------------- verify:decision-visibility
  {
    verifier: 'verify-decision-visibility.mjs',
    invariant: 'unit membership reaches the units below it',
    file: `${A}/visibility.ts`,
    from: '    stack.push(...(children.get(id) ?? []));',
    to: '    void children;',
  },
  {
    verifier: 'verify-decision-visibility.mjs',
    invariant: 'the server-side helper admits only admins, the creator and granted units',
    file: MIGRATION6,
    from: '        OR d.created_by = auth.uid()',
    to: '        OR true',
  },

  // --------------------------------------------------- verify:boundaries
  {
    verifier: 'verify-boundaries.mjs',
    invariant: 'nothing approves automatically',
    file: `${A}/engine.ts`,
    from: 'const MAX_ESCALATION_STEPS = 6;',
    to: 'const MAX_ESCALATION_STEPS = 6;\nconst autoApproveBelow = 0;',
  },
  {
    verifier: 'verify-boundaries.mjs',
    invariant: 'the decision runtime knows nothing of authority',
    file: `${K}/index.ts`,
    from: "export type { MeridianDecisionResult } from './meridianDecision.ts';",
    to: "export type { MeridianDecisionResult } from './meridianDecision.ts';\nexport type { AuthorityEvaluation } from '@helm/authority-runtime';",
  },
  // ===================================================== Phase 7
  // -------------------------------------------------- verify:twin-schema
  {
    verifier: 'verify-twin-schema.mjs',
    invariant: 'a snapshot cannot know what was recorded after it was built',
    file: MIGRATION7,
    from: '  CHECK (recorded_through <= created_at),',
    to: '  CHECK (true),',
  },
  {
    verifier: 'verify-twin-schema.mjs',
    invariant: 'every twin item names a kernel object',
    file: MIGRATION7,
    from: "  refs jsonb NOT NULL CHECK (jsonb_typeof(refs) = 'array' AND jsonb_array_length(refs) > 0),",
    to: '  refs jsonb NOT NULL,',
  },
  {
    verifier: 'verify-twin-schema.mjs',
    invariant: 'an item is read only where its class is cleared',
    file: MIGRATION7,
    from: '    AND helm_private.has_clearance(org_id, sensitivity)\n  );',
    to: '  );',
  },
  {
    verifier: 'verify-twin-schema.mjs',
    invariant: 'the database classifies metrics exactly as the kernel does',
    file: `${T}/sensitivity.ts`,
    from: "  Opex: 'FINANCIAL_SENSITIVE',",
    to: "  Opex: 'GENERAL_MANAGEMENT',",
  },
  {
    verifier: 'verify-twin-schema.mjs',
    invariant: 'binding a scenario to a decision captures it',
    file: MIGRATION7,
    from: "          s.visibility = 'ORG_WIDE'\n          AND NOT EXISTS (SELECT 1 FROM public.helm_decision_alternatives a WHERE a.scenario_id = s.id)",
    to: "          s.visibility = 'ORG_WIDE'",
  },
  // ------------------------------------------------ verify:twin-snapshot
  {
    verifier: 'verify-twin-snapshot.mjs',
    invariant: 'the committed future is read from the frozen run',
    file: `${T}/compose.ts`,
    from: '    if (!enterprise && !(v.subjectEntityId && view.inScope.has(v.subjectEntityId))) continue;',
    to: '    continue;',
  },
  {
    verifier: 'verify-twin-snapshot.mjs',
    invariant: 'a committed decision reads as committed',
    file: `${T}/management.ts`,
    from: "    else if (e.eventType === 'COMMITTED' || e.eventType === 'RECONSIDERED') state = 'COMMITTED';",
    to: "    else if (e.eventType === 'RECONSIDERED') state = 'COMMITTED';",
  },
  // --------------------------------------------- verify:twin-temporality
  {
    verifier: 'verify-twin-temporality.mjs',
    invariant: 'an entity is read as it was believed at the knowledge boundary',
    file: `${T}/structure.ts`,
    from: '    if (ms(current.updatedAt) > T) {',
    to: '    if (false) {',
  },
  {
    verifier: 'verify-twin-temporality.mjs',
    invariant: 'an occupancy end learned later is not applied to an earlier boundary',
    file: `${T}/management.ts`,
    from: '(o.endedAt === null || known(o.endedAt, Tknow))',
    to: '(true)',
  },
  {
    verifier: 'verify-twin-temporality.mjs',
    invariant: 'an act after the business instant is not part of it',
    file: `${T}/management.ts`,
    from: '  const T = Math.min(ms(lens.recordedThrough), E);',
    to: '  const T = ms(lens.recordedThrough);',
  },
  {
    verifier: 'verify-twin-temporality.mjs',
    invariant: 'the same business instant known later differs only in knowledge',
    file: `${T}/delta.ts`,
    from: '  if (ms(from.snapshot.spec.lens.effectiveAsOf) === ms(to.snapshot.spec.lens.effectiveAsOf)) return true;',
    to: '',
  },
  // ---------------------------------------------------- verify:twin-diff
  {
    verifier: 'verify-twin-diff.mjs',
    invariant: 'a change of role holder is structural',
    file: `${T}/delta.ts`,
    from: "  ROLE_OCCUPANCY: 'STRUCTURAL_CHANGE',",
    to: "  ROLE_OCCUPANCY: 'GOVERNANCE_CHANGE',",
  },
  {
    verifier: 'verify-twin-diff.mjs',
    invariant: 'after the committed period it is expected against actual, before it distance to intent',
    file: `${T}/trajectory.ts`,
    from: 'horizonMs <= E ?',
    to: 'horizonMs > E ?',
  },
  {
    verifier: 'verify-twin-diff.mjs',
    invariant: 'a committed future off track by the stated line is raised',
    file: `${T}/attention.ts`,
    from: "    if (isMaterial(delta, s(cf, 'unit') as string | null) !== true) continue;",
    to: '    continue;',
  },
  // ------------------------------------------------- verify:twin-lineage
  {
    verifier: 'verify-twin-lineage.mjs',
    invariant: 'attribution walks the trace down to the input that moved',
    file: `${T}/explain.ts`,
    from: '        if (sa && sb) because = attribute(sa, ca, sb, cb, depth + 1);',
    to: '        if (sa && sb) because = [];',
  },
  {
    verifier: 'verify-twin-lineage.mjs',
    invariant: 'attention reaches a kernel object through its cause',
    file: `${T}/attention.ts`,
    from: "...c.refs.filter((r) => r.kind !== 'TWIN_ITEM').slice(0, 1)",
    to: '...c.refs.slice(0, 0)',
  },
  // ------------------------------------------------ verify:twin-security
  {
    verifier: 'verify-twin-security.mjs',
    invariant: 'a restricted class needs a clearance',
    file: `${T}/sensitivity.ts`,
    from: "  if (viewer.orgRole === 'admin') return true;",
    to: '  return true;',
  },
  {
    verifier: 'verify-twin-security.mjs',
    invariant: 'a scenario bound to a decision is captured by it',
    file: `${T}/sensitivity.ts`,
    from: "  if (facts.boundDecisions.length === 0 && facts.visibility === 'ORG_WIDE') {",
    to: "  if (facts.visibility === 'ORG_WIDE') {",
  },
  {
    verifier: 'verify-twin-security.mjs',
    invariant: 'the twin does not rely on a client-computed verdict',
    file: `${T}/management.ts`,
    from: "      if (e.evaluator.kind !== 'TRUSTED_SERVICE') {",
    to: '      if (false) {',
  },
  // --------------------------------------------- verify:authority-server
  {
    verifier: 'verify-authority-server.mjs',
    invariant: 'a request supplying a fact is refused',
    file: `${A}/trusted.ts`,
    from: '      if (supplied.length > 0) {',
    to: '      if (false) {',
  },
  {
    verifier: 'verify-authority-server.mjs',
    invariant: 'an unverified future gets no verdict',
    file: `${A}/trusted.ts`,
    from: '          if (!verified.value.verified) {',
    to: '          if (false) {',
  },
  {
    verifier: 'verify-authority-server.mjs',
    invariant: 'a recorded output must re-derive from its inputs',
    file: 'packages/propagation-engine/src/verify.ts',
    from: '    if (!same(normalized.normalizedText, step.outputValue)) {',
    to: '    if (false) {',
  },
  {
    verifier: 'verify-authority-server.mjs',
    invariant: 'the database stores only trusted verdicts',
    file: MIGRATION7,
    from: "    CHECK (evaluator->>'kind' = 'TRUSTED_SERVICE');",
    to: "    CHECK (evaluator->>'kind' IN ('TRUSTED_SERVICE', 'CLIENT_RUNTIME'));",
  },
  // ------------------------------------------ verify:boundaries (Phase 7)
  {
    verifier: 'verify-boundaries.mjs',
    invariant: 'the twin writes nothing below itself',
    file: `${T}/runtime.ts`,
    from: 'export function createTwinRuntime(opts: TwinRuntimeOptions): TwinRuntime {',
    to: 'export function createTwinRuntime(opts: TwinRuntimeOptions): TwinRuntime {\n  void opts.sources.valueGraph.recordObservation(null as never, null as never);',
  },
  {
    verifier: 'verify-boundaries.mjs',
    invariant: 'attention is never scored',
    file: `${T}/attention.ts`,
    from: 'export const ATTENTION_RULES_VERSION',
    to: 'export const attentionScore = 0;\nexport const ATTENTION_RULES_VERSION',
  },
  // ------------------------------------------------ verify:causal-schema (Phase 8)
  {
    verifier: "verify-causal-schema.mjs",
    invariant: "the database stamps the record time of causal knowledge",
    file: MIGRATION8,
    from: "  NEW.recorded_at := now();\n  RETURN NEW;\nEND;\n$fn$;\n\nCREATE OR REPLACE FUNCTION public.helm_causal_claims_guard()",
    to: "  RETURN NEW;\nEND;\n$fn$;\n\nCREATE OR REPLACE FUNCTION public.helm_causal_claims_guard()",
  },
  {
    verifier: "verify-causal-schema.mjs",
    invariant: "there is no unconditional CAUSES",
    file: MIGRATION8,
    from: "'MEDIATES', 'MODERATES')),\n  target_claim_id",
    to: "'MEDIATES', 'MODERATES', 'CAUSES')),\n  target_claim_id",
  },
  {
    verifier: "verify-causal-schema.mjs",
    invariant: "a claim is never unscoped",
    file: MIGRATION8,
    from: "jsonb_array_length(scope->'anchors') >= 1)",
    to: "jsonb_array_length(scope->'anchors') >= 0)",
  },
  {
    verifier: "verify-causal-schema.mjs",
    invariant: "judgement is labelled as judgement",
    file: MIGRATION8,
    from: "CONSTRAINT helm_causal_evidence_judgement_labelled CHECK ((type = 'MANAGEMENT_EXPERTISE') = (provenance->>'method' = 'JUDGEMENT')),",
    to: "CONSTRAINT helm_causal_evidence_judgement_labelled CHECK (true),",
  },
  {
    verifier: "verify-causal-schema.mjs",
    invariant: "a claim is readable only with clearance for every class it carries",
    file: MIGRATION8,
    from: "          WHERE e.id IN (SELECT helm_private.causal_claim_evidence(p_claim)) AND NOT helm_private.has_clearance(p_org, e.sensitivity)\n",
    to: "          WHERE false\n",
  },
  {
    verifier: "verify-causal-schema.mjs",
    invariant: "a claim is withheld from whoever cannot see its decision",
    file: MIGRATION8,
    from: "        AND NOT EXISTS (SELECT 1 FROM helm_private.causal_claim_decisions(p_claim) d WHERE NOT helm_private.can_see_decision(d))\n",
    to: "        AND true\n",
  },
  {
    verifier: "verify-causal-schema.mjs",
    invariant: "a contradictory case never supports",
    file: MIGRATION8,
    from: "  IF ev.type = 'CONTRADICTORY_CASE' AND NEW.stance = 'SUPPORTS' THEN",
    to: "  IF false THEN",
  },
  // ------------------------------------------------ verify:causal-runtime (Phase 8)
  {
    verifier: "verify-causal-runtime.mjs",
    invariant: "HELM never proposes a cause",
    file: `${C8}/runtime.ts`,
    from: "if (v.claim.effectKey !== question.target.variableKey || candidates.some(",
    to: "if (candidates.some(",
  },
  {
    verifier: "verify-causal-runtime.mjs",
    invariant: "traversal is bounded",
    file: `${C8}/runtime.ts`,
    from: "if (!Number.isInteger(input.maxDepth) || input.maxDepth < 1 || input.maxDepth > MAX_DEPTH) {",
    to: "if (false) {",
  },
  {
    verifier: "verify-causal-runtime.mjs",
    invariant: "a path is as supported as its weakest claim",
    file: `${C8}/runtime.ts`,
    from: "STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b))[0];",
    to: "STATUS_ORDER.indexOf(b) - STATUS_ORDER.indexOf(a))[0];",
  },
  // ------------------------------------------------ verify:causal-evidence (Phase 8)
  {
    verifier: "verify-causal-evidence.mjs",
    invariant: "judgement is capped at LOW",
    file: `${C8}/policy.ts`,
    from: "  MANAGEMENT_EXPERTISE: 'LOW',\n};",
    to: "  MANAGEMENT_EXPERTISE: 'MEDIUM',\n};",
  },
  {
    verifier: "verify-causal-evidence.mjs",
    invariant: "count never decides",
    file: `${C8}/policy.ts`,
    from: "if (maxSupport === 'HIGH' || mediumTypes.size >= 2) {",
    to: "if (maxSupport === 'HIGH' || supports.length >= 2) {",
  },
  {
    verifier: "verify-causal-evidence.mjs",
    invariant: "a cause after its effect counts against the claim",
    file: `${C8}/policy.ts`,
    from: "if (temporal === 'TEMPORAL_CONFLICT' && countedAs === 'SUPPORT') {",
    to: "if (false) {",
  },
  {
    verifier: "verify-causal-evidence.mjs",
    invariant: "a correlation cited as evidence is LOW",
    file: `${C8}/policy.ts`,
    from: "if (e.correlationFindingId !== null && ceiling !== 'LOW') {",
    to: "if (false) {",
  },
  {
    verifier: "verify-causal-evidence.mjs",
    invariant: "a credible contradiction is not outvoted",
    file: `${C8}/policy.ts`,
    from: "if (materialAgainst && materialSupport) {",
    to: "if (materialAgainst && materialSupport && against.length >= supports.length) {",
  },
  {
    verifier: "verify-causal-evidence.mjs",
    invariant: "a correction supersedes",
    file: `${C8}/runtime.ts`,
    from: "    const next = evidenceAtT.find((x) => x.supersedesId === head.id);",
    to: "    const next = undefined as CausalEvidence | undefined;",
  },
  // ------------------------------------------------ verify:causal-temporality (Phase 8)
  {
    verifier: "verify-causal-temporality.mjs",
    invariant: "evidence learned later never rewrites earlier belief",
    file: `${C8}/runtime.ts`,
    from: "  const links = known(r.links, T)\n",
    to: "  const links = [...r.links]\n",
  },
  {
    verifier: "verify-causal-temporality.mjs",
    invariant: "no knowledge from the future",
    file: `${C8}/runtime.ts`,
    from: "if (ms(l.recordedThrough) > clock.now().getTime()) {",
    to: "if (false) {",
  },
  {
    verifier: "verify-causal-temporality.mjs",
    invariant: "a claim does not exist before it was recorded",
    file: `${C8}/runtime.ts`,
    from: "    if (ms(claim.recordedAt) > T) {\n      return fail(CausalErrors.NOT_KNOWN_AT_LENS",
    to: "    if (false) {\n      return fail(CausalErrors.NOT_KNOWN_AT_LENS",
  },
  // ------------------------------------------------ verify:causal-scope (Phase 8)
  {
    verifier: "verify-causal-scope.mjs",
    invariant: "a claim does not generalize sideways",
    file: `${C8}/scope.ts`,
    from: "    else conflicts.push(a.label);",
    to: "    else silent.push(a.label);",
  },
  {
    verifier: "verify-causal-scope.mjs",
    invariant: "nothing is global by default",
    file: `${C8}/runtime.ts`,
    from: "if (!Array.isArray(s.anchors) || s.anchors.length === 0) {",
    to: "if (!Array.isArray(s.anchors)) {",
  },
  // ------------------------------------------------ verify:causal-vs-calculation (Phase 8)
  {
    verifier: "verify-causal-vs-calculation.mjs",
    invariant: "a calculation dependency is never evidence",
    file: `${C8}/runtime.ts`,
    from: "    return ok({ claim, revision: revs[revs.length - 1], cause, effect, evaluation: evaluateAt(claim, r, lens) });",
    to: "    const ev0 = evaluateAt(claim, r, lens);\n    return ok({ claim, revision: revs[revs.length - 1], cause, effect, evaluation: modelDependencyOf(cause, effect) && ev0.assessments.length === 0 ? { ...ev0, status: 'SUPPORTED' as const } : ev0 });",
  },
  {
    verifier: "verify-causal-vs-calculation.mjs",
    invariant: "a causal claim never writes the model",
    file: `${C8}/runtime.ts`,
    from: "      const s = await checkScope(scope, input.scope);\n      if (!s.ok) return s;\n      const period",
    to: "      const s = await checkScope(scope, input.scope);\n      if (!s.ok) return s;\n      if (input.statement === 'never') await opts.graph.upsertEntity(scope, {} as never);\n      const period",
  },
  // ------------------------------------------------ verify:causal-lineage (Phase 8)
  {
    verifier: "verify-causal-lineage.mjs",
    invariant: "a claim's lineage reaches its evidence's sources",
    file: `${C8}/runtime.ts`,
    from: "        ...a.flatMap((x) => x.evidence.refs),\n",
    to: "",
  },
  {
    verifier: "verify-causal-lineage.mjs",
    invariant: "demo evidence is labelled demo",
    file: `${C8}/meridianCausal.ts`,
    from: "const demo = (ref: string) => `${DEMO_CAUSAL_LABEL} · ${ref}`;",
    to: "const demo = (ref: string) => ref;",
  },
  // ------------------------------------------------ verify:causal-security (Phase 8)
  {
    verifier: "verify-causal-security.mjs",
    invariant: "evidence restricts the claim it supports",
    file: `${C8}/runtime.ts`,
    from: "  for (const e of evidenceChain(v.claim.id, r)) out.add(e.sensitivity);\n",
    to: "",
  },
  {
    verifier: "verify-causal-security.mjs",
    invariant: "a claim resting on an invisible decision is withheld",
    file: `${C8}/runtime.ts`,
    from: "const decisionsOk = viewer.orgRole === 'admin' || decisions.every((d) => facts.decisionVisible(d));",
    to: "const decisionsOk = viewer.orgRole === 'admin' || decisions.length >= 0;",
  },
  {
    verifier: "verify-causal-security.mjs",
    invariant: "a restricted claim stays with its units",
    file: `${C8}/runtime.ts`,
    from: "          v.claim.visibility === 'ORG_WIDE' ||\n",
    to: "          true ||\n",
  },
  // ------------------------------------------------ verify:boundaries (Phase 8)
  {
    verifier: "verify-boundaries.mjs",
    invariant: "the twin knows nothing of the causal graph",
    file: "packages/twin-runtime/src/types.ts",
    from: "import type { OrgId, UserId } from '@helm/shared';",
    to: "import type { OrgId, UserId } from '@helm/shared';\nimport type { CausalClaim } from '@helm/causal-runtime';\nexport type CausalItem = CausalClaim;",
  },
  {
    verifier: "verify-boundaries.mjs",
    invariant: "no path probability, no causal score",
    file: `${C8}/policy.ts`,
    from: "export const CAUSAL_EVIDENCE_POLICY",
    to: "export const pathProbability = 0;\nexport const CAUSAL_EVIDENCE_POLICY",
  },
  {
    verifier: 'verify-causal-schema.mjs',
    invariant: "a read policy never re-reads its own row by id (INSERT … RETURNING)",
    file: MIGRATION8,
    from: "  USING (public.is_org_member(org_id) AND helm_private.causal_claim_row_visible(org_id, id, visibility, authored_by, granted_unit_ids, sensitivity, cause_key, effect_key));",
    to: "  USING (public.is_org_member(org_id) AND helm_private.can_see_causal_claim(id));",
  },
  {
    verifier: 'verify-causal-schema.mjs',
    invariant: "signed-in clients hold no UPDATE or DELETE on causal tables",
    file: MIGRATION8,
    from: "REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE",
    to: "REVOKE REFERENCES, TRIGGER ON TABLE",
  },
  {
    verifier: "verify-schema.mjs",
    invariant: "a read policy never re-reads its own row by id (INSERT … RETURNING)",
    file: "supabase/migrations/20260930100000_helm_rls_row_visibility.sql",
    from: "USING (public.is_org_member(org_id) AND helm_private.twin_snapshot_row_visible(org_id, built_by, granted_unit_ids));",
    to: "USING (public.is_org_member(org_id) AND helm_private.can_see_twin_snapshot(id));",
  },
  // ------------------------------------------------ verify:genome-schema (Phase 9)
  {
    verifier: 'verify-genome-schema.mjs',
    invariant: 'a person cannot record a stance HELM did not observe',
    file: MIGRATION9,
    from: "    (stance = 'SUPPORTING_EPISODE' AND observed = 'SUPPORTS')\n    OR (stance = 'CONTRADICTORY_EPISODE' AND observed = 'CONTRADICTS')",
    to: "    (stance = 'SUPPORTING_EPISODE')\n    OR (stance = 'CONTRADICTORY_EPISODE')",
  },
  {
    verifier: 'verify-genome-schema.mjs',
    invariant: 'an author cannot endorse their own lesson',
    file: MIGRATION9,
    from: "IF NEW.status = 'ENDORSED' AND NEW.reviewed_by IS NOT NULL AND NEW.reviewed_by = author THEN",
    to: 'IF FALSE THEN',
  },
  {
    verifier: 'verify-genome-schema.mjs',
    invariant: "an episode read policy never re-reads its own row by id (INSERT … RETURNING)",
    file: MIGRATION9,
    from: '  USING (public.is_org_member(org_id) AND helm_private.genome_episode_row_visible(org_id, decision_id, visibility, authored_by, granted_unit_ids, sensitivity_classes));',
    to: '  USING (public.is_org_member(org_id) AND helm_private.can_see_genome_episode(id));',
  },
  {
    verifier: 'verify-genome-schema.mjs',
    invariant: 'signed-in clients hold no UPDATE or DELETE on genome tables',
    file: MIGRATION9,
    from: 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE',
    to: 'REVOKE REFERENCES, TRIGGER ON TABLE',
  },
  {
    verifier: 'verify-genome-schema.mjs',
    invariant: 'a pattern is withheld when it rests on an episode the viewer cannot read',
    file: MIGRATION9,
    from: 'WHERE e.pattern_id = p_pattern AND NOT helm_private.can_see_genome_episode(e.episode_id)',
    to: 'WHERE e.pattern_id = p_pattern AND false',
  },
  {
    verifier: 'verify-genome-schema.mjs',
    invariant: 'an episode needs clearance for every class it carries',
    file: MIGRATION9,
    from: 'AND NOT EXISTS (SELECT 1 FROM unnest(p_classes) k WHERE NOT helm_private.has_clearance(p_org, k))',
    to: 'AND TRUE',
  },
  {
    verifier: 'verify-genome-schema.mjs',
    invariant: 'record time is stamped by the database, never by the client',
    file: MIGRATION9,
    from: '  NEW.recorded_at := now();\n',
    to: '',
  },
  {
    verifier: 'verify-genome-schema.mjs',
    invariant: 'the genome stores no score',
    file: MIGRATION9,
    from: '  CONSTRAINT helm_genome_patterns_scoped CHECK (',
    to: '  score numeric,\n  CONSTRAINT helm_genome_patterns_scoped CHECK (',
  },
  {
    verifier: 'verify-genome-schema.mjs',
    invariant: 'a pattern always states its limitations',
    file: MIGRATION9,
    from: '  limitations text NOT NULL CHECK (char_length(btrim(limitations)) >= 1),',
    to: '  limitations text,',
  },
  {
    verifier: 'verify-genome-schema.mjs',
    invariant: 'a lesson rests on the genome, not on free text',
    file: MIGRATION9,
    from: "      RAISE EXCEPTION 'helm_genome_lessons: a lesson rests on episodes or patterns of this genome, not on a %', r->>'kind';",
    to: '      NULL;',
  },
  {
    verifier: 'verify-schema.mjs',
    invariant: 'a genome table permits no DELETE',
    file: MIGRATION9,
    from: 'DROP POLICY IF EXISTS "Scoped read genome lessons" ON public.helm_genome_lessons;',
    to: 'DROP POLICY IF EXISTS "Scoped read genome lessons" ON public.helm_genome_lessons;\nCREATE POLICY "Erase lessons" ON public.helm_genome_lessons FOR DELETE TO authenticated USING (public.is_org_member(org_id));',
  },
  // ------------------------------------------------ verify:genome-runtime (Phase 9)
  {
    verifier: 'verify-genome-runtime.mjs',
    invariant: 'a contradictory episode does not vanish under a majority',
    file: `${G9}/policy.ts`,
    from: '  if (c > 0) {',
    to: '  if (c > s) {',
  },
  {
    verifier: 'verify-genome-runtime.mjs',
    invariant: 'an episode says process quality is not outcome quality',
    file: `${G9}/runtime.ts`,
    from: "        'neither judges the other (Decision Process Quality ≠ Outcome Quality).',",
    to: "        '',",
  },
  // ------------------------------------------------ verify:genome-temporality (Phase 9)
  {
    verifier: 'verify-genome-temporality.mjs',
    invariant: 'a snapshot recorded after the decision is hindsight, not the situation',
    file: `${G9}/situation.ts`,
    from: 'if (ms(snap.value.snapshot.spec.lens.recordedThrough) > ms(boundary.recordedThrough)) {',
    to: 'if (false) {',
  },
  {
    verifier: 'verify-genome-temporality.mjs',
    invariant: 'hindsight cannot be bound to an existing episode as its situation',
    file: `${G9}/runtime.ts`,
    from: "if (role === 'SITUATION_SNAPSHOT' && lensT > T0)",
    to: "if (false && role === 'SITUATION_SNAPSHOT' && lensT > T0)",
  },
  {
    verifier: 'verify-genome-temporality.mjs',
    invariant: 'an episode recorded later did not exist at an earlier knowledge boundary',
    file: `${G9}/runtime.ts`,
    from: '    if (ms(episode.recordedAt) > T) {\n      return fail(GenomeErrors.NOT_KNOWN_AT_LENS, `This episode was first recorded on',
    to: '    if (false) {\n      return fail(GenomeErrors.NOT_KNOWN_AT_LENS, `This episode was first recorded on',
  },
  // ------------------------------------------------ verify:genome-scope (Phase 9)
  {
    verifier: 'verify-genome-scope.mjs',
    invariant: 'a stance must agree with what HELM observed (policy AND store)',
    file: `${G9}/policy.ts`,
    from: "  if (stance === 'CONTEXTUAL_EPISODE') return { ok: true, message: '' };",
    to: "  return { ok: true, message: '' };",
    also: [
      {
        file: `${G9}/inMemoryStore.ts`,
        from: "      if (!agrees) return fail(GenomeErrors.INCONSISTENT_STANCE, 'The stance must agree with what HELM observed in the episode.');",
        to: '',
      },
    ],
  },
  {
    verifier: 'verify-genome-scope.mjs',
    invariant: 'absence of information is not similarity',
    file: `${G9}/situation.ts`,
    from: '    const agrees = stated && a.some((v) => b.includes(v));',
    to: '    const agrees = !stated || a.some((v) => b.includes(v));',
  },
  // ------------------------------------------------ verify:genome-security (Phase 9)
  {
    verifier: 'verify-genome-security.mjs',
    invariant: 'an uncleared viewer reads no episode carrying a class they lack',
    file: `${G9}/runtime.ts`,
    from: 'v.episode.sensitivityClasses.every((c) => isCleared(viewer, c, at)) && ',
    to: '',
  },
  {
    verifier: 'verify-genome-security.mjs',
    invariant: 'a pattern or lesson is read whole or not at all',
    file: `${G9}/runtime.ts`,
    from: '[...p.supporting, ...p.contradictory, ...p.contextual].every((x) => visibleEpisode.has(x.episode.episode.id))',
    to: 'true',
  },
  {
    verifier: 'verify-genome-security.mjs',
    invariant: 'an episode resting on an invisible decision is withheld',
    file: `${G9}/runtime.ts`,
    from: '(isAdmin || facts.decisionVisible(v.episode.decisionId))',
    to: '(isAdmin || true)',
  },
  // ------------------------------------------------ verify:genome-lineage (Phase 9)
  {
    verifier: 'verify-genome-lineage.mjs',
    invariant: 'demo episodes are labelled demo',
    file: `${G9}/meridianGenome.ts`,
    from: 'await genome.openEpisode(gm, { decisionId, title: `${title} (demo)`, scope,',
    to: 'await genome.openEpisode(gm, { decisionId, title, scope,',
  },
  // ------------------------------------------------ verify:genome-process-outcome (Phase 9)
  {
    verifier: 'verify-genome-process-outcome.mjs',
    invariant: 'no view carries a quality, score or verdict',
    file: `${G9}/runtime.ts`,
    from: '      decisionTitle: facts.value.decision.title,\n',
    to: "      decisionTitle: facts.value.decision.title,\n      quality: 'GOOD',\n",
  },
  {
    verifier: 'verify-genome-process-outcome.mjs',
    invariant: 'the genome discovers no pattern by itself',
    file: `${G9}/runtime.ts`,
    from: '    async findSimilar(scope, input) {',
    to: '    async discoverPatterns() {\n      return ok([]);\n    },\n\n    async findSimilar(scope, input) {',
  },
  // ------------------------------------------------ verify:boundaries (Phase 9)
  {
    verifier: 'verify-boundaries.mjs',
    invariant: 'the causal graph knows nothing of the genome above it',
    file: `${C8}/types.ts`,
    from: "import type { OrgId, UserId } from '@helm/shared';",
    to: "import type { OrgId, UserId } from '@helm/shared';\nimport type { ManagementEpisode } from '@helm/genome-runtime';\nexport type EpisodeItem = ManagementEpisode;",
  },
  {
    verifier: 'verify-boundaries.mjs',
    invariant: 'no decision-quality judgement, anywhere',
    file: `${G9}/policy.ts`,
    from: 'export const GENOME_PATTERN_POLICY',
    to: 'export const decisionQuality = 0;\nexport const GENOME_PATTERN_POLICY',
  },
  {
    verifier: 'verify-boundaries.mjs',
    invariant: 'the genome remembers the kernel and never writes it',
    file: `${G9}/runtime.ts`,
    from: "      const isAdmin = viewer.orgRole === 'admin';\n",
    to: "      const isAdmin = viewer.orgRole === 'admin';\n      sources.decisions.commit();\n",
  },

  // ============================================ integration, reviews, intelligence, council
  {
    verifier: 'verify-integration-schema.mjs',
    invariant: 'v1 writes nothing to an operational system: the mode is pinned to DRY_RUN',
    file: MIGRATION_INT,
    from: "mode text NOT NULL CHECK (mode = 'DRY_RUN'),",
    to: "mode text NOT NULL CHECK (mode IN ('DRY_RUN', 'LIVE')),",
  },
  {
    verifier: 'verify-integration-schema.mjs',
    invariant: 'a blocked or failed run leaves the checkpoint where it was',
    file: MIGRATION_INT,
    from: "    outcome NOT IN ('BLOCKED_BY_DRIFT', 'FAILED') OR cursor_after IS NOT DISTINCT FROM cursor_before",
    to: "    true OR cursor_after IS NOT DISTINCT FROM cursor_before",
  },
  {
    verifier: 'verify-integration-schema.mjs',
    invariant: 'a write derives only from an action intent of its own commitment',
    file: MIGRATION_INT,
    from: "    WHERE a.id = NEW.action_intent_id AND a.org_id = NEW.org_id AND a.commitment_id = NEW.commitment_id",
    to: "    WHERE a.id = NEW.action_intent_id AND a.org_id = NEW.org_id",
  },
  {
    verifier: 'verify-integration-runtime.mjs',
    invariant: 'ingestion is idempotent by content: an unchanged observation is not recorded again',
    file: `${INT}/pipeline.ts`,
    from: 'else counts.observationsUnchanged += 1;',
    to: 'else counts.observationsRecorded += 1;',
  },
  {
    verifier: 'verify-integration-runtime.mjs',
    invariant: 'breaking drift blocks the object type instead of guessing',
    file: `${INT}/pipeline.ts`,
    from: "if (report.status === 'BREAKING') blockedTypes.add(objectType);",
    to: 'void report;',
  },
  {
    verifier: 'verify-writeback-dry-run.mjs',
    invariant: 'a commitment governance does not permit cannot be written',
    file: `${INT}/writeback.ts`,
    from: "const EXECUTABLE_STATES = ['AUTHORIZED', 'APPROVED'] as const;",
    to: "const EXECUTABLE_STATES = ['AUTHORIZED', 'APPROVED', 'PENDING_APPROVAL'] as const;",
  },
  {
    verifier: 'verify-writeback-dry-run.mjs',
    invariant: 'a dry run says nothing was sent',
    file: `${INT}/writeback.ts`,
    from: 'dryRun: true, sent: false,',
    to: 'dryRun: true, sent: true,',
  },
  {
    verifier: 'verify-review-schema.mjs',
    invariant: 'a closure covers every item with exactly one disposition',
    file: MIGRATION_REV,
    from: "WHERE d->>'itemId' = i.id::text) <> 1",
    to: "WHERE d->>'itemId' = i.id::text) < 0",
  },
  {
    verifier: 'verify-review-schema.mjs',
    invariant: 'a review is read whole: every class it carries',
    file: MIGRATION_REV,
    from: "        AND NOT EXISTS (SELECT 1 FROM unnest(p_classes) k WHERE NOT helm_private.has_clearance(p_org, k))\n      )",
    to: "        AND true\n      )",
  },
  {
    verifier: 'verify-review-runtime.mjs',
    invariant: 'a review follows a closed review',
    file: `${REV}/runtime.ts`,
    from: 'if (!closedIds.has(p.value.id)) return fail(ReviewErrors.PREVIOUS_NOT_CLOSED',
    to: 'if (false) return fail(ReviewErrors.PREVIOUS_NOT_CLOSED',
    also: [{ file: `${REV}/inMemoryStore.ts`, from: 'if (!x.closures.some((c) => c.reviewId === p.id)) return fail(ReviewErrors.PREVIOUS_NOT_CLOSED', to: 'if (false) return fail(ReviewErrors.PREVIOUS_NOT_CLOSED' }],
  },
  {
    verifier: 'verify-review-runtime.mjs',
    invariant: 'nothing is left hanging at close',
    file: `${REV}/runtime.ts`,
    from: 'if (missing.length > 0) return fail(ReviewErrors.OPEN_ITEMS',
    to: 'if (false && missing.length > 0) return fail(ReviewErrors.OPEN_ITEMS',
    also: [{ file: `${REV}/inMemoryStore.ts`, from: 'if (missing.length > 0) return fail(ReviewErrors.OPEN_ITEMS', to: 'if (false && missing.length > 0) return fail(ReviewErrors.OPEN_ITEMS' }],
  },
  {
    verifier: 'verify-review-security.mjs',
    invariant: 'a pack is prepared only for a viewer cleared for every class',
    file: `${REV}/runtime.ts`,
    from: 'const classesOk = (rv.sensitivityClasses as readonly SensitivityClass[]).every((c) => isCleared(viewer, c, at));',
    to: 'const classesOk = true;',
  },
  {
    verifier: 'verify-review-security.mjs',
    invariant: 'a review is projected only to a viewer cleared for every class',
    file: `${REV}/runtime.ts`,
    from: 'const classesOk = (r.sensitivityClasses as readonly SensitivityClass[]).every((c) => isCleared(viewer, c, at));',
    to: 'const classesOk = true;',
  },
  {
    verifier: 'verify-intelligence-schema.mjs',
    invariant: 'the audit trail has nowhere to keep a reasoning trace',
    file: MIGRATION_AI,
    from: "AND (output - 'statements' - 'questions' - 'unknowns') = '{}'::jsonb",
    to: '',
  },
  {
    verifier: 'verify-intelligence-schema.mjs',
    invariant: 'a person reads their own AI runs only',
    file: MIGRATION_AI,
    from: "USING (public.is_org_member(org_id) AND (user_id = (select auth.uid()) OR public.has_org_role(org_id, 'admin')));",
    to: 'USING (public.is_org_member(org_id));',
  },
  {
    verifier: 'verify-intelligence-grounding.mjs',
    invariant: 'a recommendation is removed however it is classed',
    file: `${AI}/grounding.ts`,
    from: 'if (RECOMMENDATION.test(text)) {',
    to: 'if (false && RECOMMENDATION.test(text)) {',
  },
  {
    verifier: 'verify-intelligence-grounding.mjs',
    invariant: 'a figure no cited evidence returned is a fabricated figure',
    file: `${AI}/grounding.ts`,
    from: 'if (ungrounded.length > 0) {',
    to: 'if (false && ungrounded.length > 0) {',
  },
  {
    verifier: 'verify-intelligence-grounding.mjs',
    invariant: 'a hypothesis stays a hypothesis',
    file: `${AI}/grounding.ts`,
    from: "if (finalClass === 'CAUSAL_CLAIM') {",
    to: "if (false && finalClass === 'CAUSAL_CLAIM') {",
  },
  {
    verifier: 'verify-intelligence-governed.mjs',
    invariant: 'a tool outside the catalogue cannot run',
    file: `${AI}/gather.ts`,
    from: '    if (!t) {\n      calls.push({ tool: String(call.tool), args: call.args, outcome: \'REFUSED\'',
    to: '    if (false) {\n      calls.push({ tool: String(call.tool), args: call.args, outcome: \'REFUSED\'',
  },
  {
    verifier: 'verify-intelligence-governed.mjs',
    invariant: 'a plan is bounded',
    file: `${AI}/gather.ts`,
    from: 'plan.slice(0, MAX_TOOL_CALLS)',
    to: 'plan.slice(0, 1000)',
  },
  {
    verifier: 'verify-intelligence-governed.mjs',
    invariant: 'the AI reads as the caller: decision visibility',
    file: `${AI}/tools.ts`,
    from: 'const canSeeDecision = (c: ToolContext, id: string) => isAdmin(c) || c.facts.decisionVisible(id);',
    to: 'const canSeeDecision = (c: ToolContext, id: string) => true || isAdmin(c) || c.facts.decisionVisible(id);',
  },
  {
    verifier: 'verify-intelligence-governed.mjs',
    invariant: 'the AI explains no value above the clearance of the caller',
    file: `${AI}/tools.ts`,
    from: 'if (!isCleared(ctx.viewer, item.sensitivity, ctx.now)) return done(',
    to: 'if (false) return done(',
  },
  {
    verifier: 'verify-intelligence-governed.mjs',
    invariant: 'the AI compares no change above the clearance of the caller',
    file: `${AI}/tools.ts`,
    from: 'const visible = all.filter((c) => isCleared(ctx.viewer, (c.after ?? c.before)!.sensitivity, ctx.now));',
    to: 'const visible = all;',
  },
  {
    verifier: 'verify-council.mjs',
    invariant: 'People is never spoken for',
    file: `${AG}/perspectives.ts`,
    from: "        : { supported: false, reason: 'HELM holds no people data:",
    to: "        : { supported: true, reason: 'HELM holds no people data:",
  },
  {
    verifier: 'verify-council.mjs',
    invariant: 'disagreement is preserved, never netted',
    file: `${AG}/council.ts`,
    from: 'The two are shown side by side: nothing is netted, and HELM does not say which is right.',
    to: 'The two are weighed and the balance is positive.',
  },
  {
    verifier: 'verify-council.mjs',
    invariant: 'a perspective sees relevance, not everything: the evidence subset is its own',
    file: `${AG}/council.ts`,
    from: "const subset = evidence.filter((e) => relevantTo(p, e));",
    to: "const subset = evidence;",
  },
  {
    verifier: 'verify-boundaries.mjs',
    invariant: 'the AI layer writes nothing below itself',
    file: `${AI}/gather.ts`,
    from: 'export const MAX_TOOL_CALLS = 8;',
    to: 'export const MAX_TOOL_CALLS = 8;\nvoid ((x: { commit(): void }) => x.commit());',
  },
  {
    verifier: 'verify-boundaries.mjs',
    invariant: 'the council never votes',
    file: `${AG}/council.ts`,
    from: '/** Where perspectives pull apart, as a FACT about an alternative — never netted, never ranked. */',
    to: 'const tallyVotes = () => 0; void tallyVotes;',
  },
  {
    verifier: 'verify-boundaries.mjs',
    invariant: 'the integration fabric never decides',
    file: `${INT}/pipeline.ts`,
    from: 'const blockedTypes = new Set<string>();',
    to: 'const blockedTypes = new Set<string>();\n      void ((x: { recordApproval(): void }) => x.recordApproval());',
  },
  {
    verifier: 'verify-boundaries.mjs',
    invariant: 'no health score, anywhere',
    file: `${REV}/pack.ts`,
    from: 'export async function computePack',
    to: 'export const healthScore = 0;\nexport function computePack',
  },
  {
    verifier: 'verify-memoire-boundary.mjs',
    invariant: 'HELM never writes to Memoire, from the bridge or anywhere else',
    file: 'src/services/memoireBridge.ts',
    from: 'const READ_COLUMNS =',
    to: "const probeWrite = () => supabaseClient?.from('opportunities').update({});\nvoid probeWrite;\nconst READ_COLUMNS =",
  },
  {
    verifier: 'verify-boundaries.mjs',
    invariant: 'a review knows nothing of the AI layer above it',
    file: `${REV}/types.ts`,
    from: "import type { UserId } from '@helm/shared';",
    to: "import type { UserId } from '@helm/shared';\nimport type { AiRun } from '@helm/intelligence-runtime';\nexport type RunItem = AiRun;",
  },
];

const only = process.argv[2] ?? '';
const selected = MUTATIONS.filter((m) => m.verifier.includes(only));
const results = [];

for (const m of selected) {
  // A mutation is one edit, or — where an invariant is held by two independent layers — several
  // (`also`): breaking one layer must be survived by the other, so both are broken to prove the
  // contract notices the invariant is gone.
  const edits = [{ file: m.file, from: m.from, to: m.to, all: m.all }, ...(m.also ?? [])];
  const originals = [];
  let skipped = null;
  const prepared = [];
  for (const e of edits) {
    const path = join(root, e.file);
    const original = readFileSync(path, 'utf8');
    // The repository is mixed CRLF/LF (Windows development), so a multi-line
    // pattern is written with \n and adapted to whatever the file actually uses.
    const crlf = original.includes('\r\n');
    const from = crlf ? e.from.replaceAll('\n', '\r\n') : e.from;
    const to = crlf ? e.to.replaceAll('\n', '\r\n') : e.to;
    const count = original.split(from).length - 1;
    if (count === 0 || (!e.all && count > 1)) {
      skipped = `the target text in ${e.file} appears ${count} time(s)`;
      break;
    }
    originals.push({ path, original });
    prepared.push({ path, mutated: e.all ? original.split(from).join(to) : original.replace(from, to) });
  }
  if (skipped) {
    results.push({ ...m, outcome: 'NOT_APPLIED', note: skipped });
    continue;
  }
  let outcome;
  let note = '';
  try {
    for (const { path, mutated } of prepared) writeFileSync(path, mutated);
    const r = spawnSync(process.execPath, [join('scripts', m.verifier)], { cwd: root, encoding: 'utf8' });
    outcome = r.status === 0 ? 'SURVIVED' : 'CAUGHT';
    const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n');
    note = outcome === 'CAUGHT' ? (lines.find((l) => /^\s*\[/.test(l)) ?? lines[0] ?? '').trim() : '';
  } finally {
    for (const { path, original } of originals) writeFileSync(path, original);
  }
  results.push({ ...m, outcome, note });
}

const pad = (s, n) => String(s).padEnd(n);
const survived = results.filter((r) => r.outcome !== 'CAUGHT');
const contracts = new Set(results.map((r) => r.verifier)).size;
console.log(`\nmutation testing — ${results.length} mutation(s) across ${contracts} contract(s)\n`);
for (const r of results) {
  const mark = r.outcome === 'CAUGHT' ? 'caught  ' : r.outcome === 'SURVIVED' ? 'SURVIVED' : 'skipped ';
  console.log(`  ${mark} ${pad(r.verifier.replace(/^verify-|\.mjs$/g, ''), 26)} ${r.invariant}`);
  if (r.note) console.log(`           ↳ ${r.note}`);
}
console.log();
if (survived.length === 0) {
  console.log('mutation testing — ok (every mutation was caught by the contract that claims to cover it)');
  process.exit(0);
}
console.error(`mutation testing — ${survived.length} mutation(s) were not caught:`);
for (const r of survived) console.error(`  [${r.outcome}] ${r.verifier}: ${r.invariant}${r.note ? ` — ${r.note}` : ''}`);
process.exit(1);
