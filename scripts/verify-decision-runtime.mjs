/**
 * verify:decision-runtime — the canonical Rohto decision, end to end, and the
 * things HELM refuses to do with it.
 *
 * Proves:
 *   1. One management question, five alternatives, four of them bound to
 *      scenario futures the propagation engine computed and one honestly not.
 *   2. Criteria are evaluated as facts against the lines management drew —
 *      SATISFIED, MISSES_TARGET, STATED, ASSESSED, UNKNOWN — with no total.
 *   3. A blocked metric stays blocked, and its alternative stays in the decision.
 *   4. Qualitative criteria come only from authored assessments.
 *   5. The trade-off space names gains and concessions and ranks nothing;
 *      factual dominance is stated and nothing is concluded from it.
 *   6. Readiness is named gaps, never a score, and never a winner.
 *   7. The commitment is management's: authored, reasoned, with its trade-offs
 *      accepted explicitly and its expected outcomes READ from the chosen
 *      future state.
 *   8. Nothing anywhere recommends, scores or ranks an alternative.
 */

import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { buildSeedRegistry } from '@helm/ontology';
import { createInMemoryGraphStore, buildCanonicalScenario } from '@helm/graph-store';
import {
  buildCanonicalScenarioExtension,
  buildCanonicalValueChain,
  buildSeedValueRegistry,
  createInMemoryValueGraph,
} from '@helm/value-graph';
import {
  createCalculationRegistry,
  createInMemoryCalculationStore,
  createPropagationEngine,
  meridianValueModelV1_1,
} from '@helm/propagation-engine';
import {
  buildMeridianScenarios,
  createInMemoryScenarioStore,
  createScenarioRuntime,
  meridianConstraintsV1,
  meridianStateFrame,
} from '@helm/scenario-runtime';
import { buildMeridianDecision, createDecisionRuntime, createInMemoryDecisionStore } from '@helm/decision-runtime';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};
const unwrap = (r, what) => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code} — ${r.error.message}`);
  return r.value;
};

const clock = (() => {
  let t = Date.parse('2026-09-19T08:00:00.000Z');
  return { now: () => new Date((t += 1000)) };
})();
const idGen = seqIdGen('v');
const orgId = asOrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const scope = {
  orgId,
  actorId: asUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};

const ontology = buildSeedRegistry();
const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
const metrics = buildSeedValueRegistry();
const valueGraph = createInMemoryValueGraph({ metrics, ontology, graphStore, clock, idGen });
unwrap(await buildCanonicalScenario(graphStore, scope), 'entity graph');
const chain = unwrap(await buildCanonicalValueChain(valueGraph, graphStore, scope), 'value chain');
const ext = unwrap(await buildCanonicalScenarioExtension(valueGraph, graphStore, scope, chain.nodeIds), 'extension');
const registry = unwrap(createCalculationRegistry(meridianValueModelV1_1, metrics), 'registry');
const engine = unwrap(
  createPropagationEngine({
    registry,
    valueGraph,
    graphStore,
    ontology,
    store: createInMemoryCalculationStore({ clock, idGen }),
    clock,
  }),
  'engine',
);
const scenarios = createScenarioRuntime({
  engine,
  registry,
  valueGraph,
  graphStore,
  store: createInMemoryScenarioStore({ clock, idGen }),
  clock,
  constraints: meridianConstraintsV1,
  stateFrame: meridianStateFrame,
});
const decisions = createDecisionRuntime({
  store: createInMemoryDecisionStore({ clock, idGen }),
  scenarios,
  clock,
});

const fork = {
  effectiveAsOf: '2026-09-19T12:00:00.000Z',
  recordedThrough: clock.now().toISOString(),
  policy: 'SOURCE_TRUTH',
};
const built = unwrap(
  await buildMeridianScenarios(scenarios, scope, { ...chain.nodeIds, ...ext.nodeIds }, { fork }),
  'canonical scenarios',
);
const scenarioIds = {};
for (const [key, { scenario }] of Object.entries(built)) {
  scenarioIds[key] = scenario.id;
  unwrap(await scenarios.execute(scope, scenario.id), `simulate ${key}`);
}

const decision = unwrap(await buildMeridianDecision(decisions, scope, scenarioIds), 'canonical decision');
const workspace = unwrap(await decisions.getWorkspace(scope, decision.decision.id, decision.revisionId), 'workspace');
const evaluations = workspace.evaluations;
const evalOf = (criterionKey, labelPart) =>
  evaluations.find((e) => e.criterionKey === criterionKey && e.alternativeLabel.includes(labelPart));

// 1. one question, five alternatives, four futures
check('question', /^How should Meridian fulfil the Rohto order/.test(decision.decision.managementQuestion),
  'the decision does not ask a management question');
check('alternatives', workspace.alternatives.length === 5, `expected 5 alternatives, found ${workspace.alternatives.length}`);
{
  const modelled = workspace.alternatives.filter((a) => a.status === 'MODELLED');
  check('alternatives', modelled.length === 4, `expected 4 modelled alternatives, found ${modelled.length}`);
  check('alternatives', modelled.every((a) => a.scenarioRunId && a.scenarioRevisionId),
    'a modelled alternative does not reference the simulation that computed its future');
  const unmodelled = workspace.alternatives.find((a) => a.status === 'UNMODELLED');
  check('alternatives', unmodelled !== undefined && unmodelled.scenarioRunId === null,
    'the unmodelled alternative carries a future state it should not have');
  check('alternatives', unmodelled !== undefined && (unmodelled.unmodelledReason ?? '').length > 40,
    'the unmodelled alternative does not explain why its consequences are not computed');
}

// 2. criteria evaluated as facts
{
  const cases = [
    ['customer-service', 'Expedite', 'SATISFIED', '96.8858'],
    ['customer-service', 'Reallocate', 'SATISFIED', '96.8858'],
    ['customer-service', 'alternative analyzer', 'SATISFIED', '91.3495'],
    ['gross-margin', 'Expedite', 'MISSES_TARGET', '30.517'],
    ['gross-margin', 'Reallocate', 'MISSES_TARGET', '32.3878'],
    ['gross-margin', 'alternative analyzer', 'MISSES_TARGET', '22.9048'],
    ['cash-impact', 'Expedite', 'STATED', '-1790500000'],
    ['cash-impact', 'Reallocate', 'STATED', '-1735500000'],
    ['feasibility', 'Reallocate', 'MISSES_TARGET', '0.385714'],
  ];
  for (const [key, label, outcome, value] of cases) {
    const e = evalOf(key, label);
    check('criterion-evaluation', e !== undefined, `${key} was not evaluated for ${label}`);
    if (!e) continue;
    check('criterion-evaluation', e.outcome === outcome, `${key} / ${label}: expected ${outcome}, got ${e.outcome}`);
    check('criterion-evaluation', e.value === value, `${key} / ${label}: expected ${value}, got ${e.value}`);
    check('criterion-evaluation', typeof e.explanation === 'string' && e.explanation.length > 10,
      `${key} / ${label} does not explain itself`);
  }
}

// 3. a blocked metric stays blocked
{
  const delayMargin = evalOf('gross-margin', 'Delay');
  check('blocked', delayMargin?.outcome === 'UNKNOWN', 'a blocked metric was given an outcome');
  check('blocked', delayMargin?.value === null && delayMargin?.origin === 'BLOCKED', 'a blocked metric was given a value');
  check('blocked', workspace.alternatives.some((a) => a.label.includes('Delay')),
    'the alternative with a blocked metric was dropped from the decision');
}

// 4. qualitative criteria come from people
{
  const assessed = evalOf('inventory-optionality', 'Reallocate');
  check('qualitative', assessed?.outcome === 'ASSESSED' && assessed.assessment?.author.label.length > 0,
    'a qualitative criterion has no author behind it');
  const unassessed = evalOf('inventory-optionality', 'Replace the distributor');
  check('qualitative', unassessed?.outcome === 'NOT_ASSESSED' && unassessed.assessment === null,
    'HELM produced a qualitative rating nobody authored');
}

// 5. trade-offs and dominance
{
  const space = unwrap(
    await decisions.tradeOffSpace(scope, decision.revisionId, decision.alternatives['expedite'].id),
    'trade-offs',
  );
  const reallocate = space.columns.find((c) => c.alternativeLabel.includes('Reallocate'));
  check('trade-off', reallocate?.gains.some((g) => g.metricKey === 'GrossMarginPct' && g.delta === '1.8708'),
    'reallocation does not show its margin gain against expediting');
  check('trade-off', reallocate?.gains.some((g) => g.metricKey === 'CashImpact' && g.delta === '55000000'),
    'reallocation does not show its cash gain against expediting');
  check('trade-off', reallocate?.concessions.some((c) => c.label === 'Inventory optionality'),
    'reallocation does not show what it gives up');
  check('trade-off', /does not decide which concession is acceptable/i.test(space.statement),
    'the trade-off space does not say that HELM decides nothing');

  const dominance = space.dominance;
  check('dominance', dominance.length > 0, 'no factual dominance statement was produced at all');
  check('dominance', dominance.every((d) => !/\b(choose|recommend|should|best)\b/i.test(d.statement)),
    'a dominance statement tells the reader what to do');
  check('dominance', dominance.every((d) => /Under the current model/.test(d.statement)),
    'a dominance statement does not state its own limits');
  for (const d of dominance) {
    const reverse = dominance.find((x) => x.alternativeId === d.overAlternativeId && x.overAlternativeId === d.alternativeId);
    check('dominance', reverse === undefined, 'dominance runs both ways between the same pair');
  }
  check('dominance', !dominance.some((d) => d.alternativeId === decision.alternatives['reallocate'].id),
    'the committed alternative was reported as dominant — the canonical proof needs it not to be');
}

// 6. readiness is gaps, not a score
{
  const readiness = workspace.readiness;
  check('readiness', readiness.state === 'READY_WITH_GAPS', `expected READY_WITH_GAPS, got ${readiness.state}`);
  check('readiness', !('score' in readiness) && !('percentage' in readiness), 'readiness carries a number');
  const codes = readiness.gaps.map((g) => g.code);
  for (const wanted of ['alternative-unmodelled', 'critical-assumption-unowned', 'open-challenge']) {
    check('readiness', codes.includes(wanted), `readiness does not report ${wanted}`);
  }
  check('readiness', readiness.gaps.every((g) => g.message.length > 20), 'a readiness gap does not explain itself');
}

// 7. the commitment is management's
{
  const c = workspace.commitment;
  check('commitment', c !== null, 'the canonical decision was not committed');
  check('commitment', c?.authorship === 'MANAGEMENT_AUTHORED_DEMO',
    'the seeded commitment is not marked as management-authored demonstration input');
  check('commitment', c?.authorityStatus === 'NOT_EVALUATED', 'Phase 5 produced an authority verdict');
  check('commitment', /^dfp_[0-9a-f]{16}_\d+$/.test(c?.fingerprint ?? ''), 'the commitment has no deterministic fingerprint');
  check('commitment', (c?.rationale.length ?? 0) >= 4, 'the rationale does not say why this one and why not the others');
  check('commitment', c?.rationale.some((r) => r.label.startsWith('Why not')), 'the rationale never says why not the others');
  check('commitment', (c?.acceptedTradeOffs.length ?? 0) >= 1, 'no trade-off was accepted explicitly');
  check('commitment', c?.acceptedTradeOffs.every((t) => t.givenUp && t.inFavourOf),
    'an accepted trade-off does not say what was given up in favour of what');
  const gm = c?.expectedOutcomes.find((e) => e.metricKey === 'GrossMarginPct');
  check('commitment', gm?.expectedValue === '32.3878' && gm.nodeId !== null,
    'an expected outcome was typed in rather than read from the chosen future state');
  const snapshot = unwrap(await decisions.getCommitmentSnapshot(scope, c.id), 'snapshot');
  check('commitment', /^dsn_[0-9a-f]{16}_\d+$/.test(snapshot.fingerprint), 'the evidence manifest has no fingerprint');
  check('commitment', snapshot.alternatives.filter((a) => a.chosen).length === 1, 'the manifest does not name exactly one chosen alternative');
  check('commitment', snapshot.alternatives.length === 5, 'the manifest does not record every alternative that was on the table');
  check('commitment', snapshot.openChallenges.length === 1, 'the manifest does not record the challenge management decided over');
}

// 8. nothing recommends, scores or ranks
{
  const banned = ['score', 'rank', 'ranking', 'recommended', 'recommendation', 'winner', 'best'];
  const walk = (value, path) => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (banned.includes(k.toLowerCase())) {
        failures.push({ rule: 'no-ranking', detail: `${path}.${k} exists — the decision layer must not score or rank` });
      }
      walk(v, `${path}.${k}`);
    }
  };
  walk(workspace, 'workspace');
  const explained = unwrap(await decisions.explainDecision(scope, decision.decision.id), 'explain');
  walk(explained, 'explanation');
  check('no-ranking', /does not rank/i.test(explained.statement), 'the explanation does not state that HELM does not rank');
}

if (failures.length === 0) {
  console.log(
    'verify:decision-runtime — ok (one question, 5 alternatives over 4 computed futures, criteria evaluated as facts, ' +
      'trade-offs stated, commitment authored by management, nothing ranked)',
  );
  process.exit(0);
}
console.error(`verify:decision-runtime — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
