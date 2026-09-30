/**
 * verify:counterfactual-security — who may read a case, and where every number
 * came from.
 *
 *   - a case is read whole or not at all: its unit audience, every sensitivity
 *     class of what it compares AND declares, and the decision it reviews;
 *   - an estimate that would show a class the case does not carry is refused;
 *   - visibility is not authority: the runtime never consults the authority
 *     engine, and nothing groups cases, worlds or reviews by a person;
 *   - lineage: a world names the run, the model and the calculations it read,
 *     and a hindsight input names its source — HELM never states a figure it
 *     cannot trace.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canSeeDecision } from '@helm/authority-runtime';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, USERS, buildCounterfactualStory, contract, rohtoAlternatives, unwrap } from './lib/counterfactualStack.mjs';

const c = contract('verify:counterfactual-security');
const s = await buildCounterfactualStory();
const g = s.counterfactualStory;

const clearance = (userId, sensitivity) => ({ id: `${userId}-${sensitivity}`, orgId: 'o', userId, sensitivity, validFrom: '2026-01-01T00:00:00.000Z', validTo: null, reason: 'contract', grantedBy: ADMIN, recordedAt: '2026-01-01T00:00:00.000Z' });
const viewer = (userId, classes = [], orgRole = 'member') => ({ userId, orgRole, memberUnitIds: MEMBERSHIP[userId] ?? [], clearances: classes.map((k) => clearance(userId, k)) });
const project = async (v, decisionVisible = () => true) => unwrap(await s.counterfactual.projectForViewer(s.scope, v, DEMO_UNITS, { decisionVisible }), 'project');
const BOTH = ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL'];

// ---- read whole or not at all.
const none = await project(viewer(USERS.industrialHead));
c.check('whole', none.cases.length === 0 && none.withheld === 3 && /read whole or not at all/.test(none.statement), 'an uncleared viewer read part of a case, or was not told it was withheld');
const fin = await project(viewer(USERS.financeDirector, ['FINANCIAL_SENSITIVE']));
c.check('classes', fin.cases.length === 1 && fin.cases[0].case.id === g.cases.CF3.case.id, 'a viewer cleared for FINANCIAL only read a case that also carries COMMERCIAL_CONFIDENTIAL');
const both = await project(viewer(USERS.countryGM, BOTH));
c.check('classes', both.cases.length === 3 && both.withheld === 0, 'a viewer cleared for both did not read all three');
c.check('admin', (await project(viewer(ADMIN, [], 'admin'), () => false)).cases.length === 3, 'an admin needs no decision grant');
const blind = await project(viewer(USERS.countryGM, BOTH), (id) => id !== s.story.decisionId);
c.check('decision-visibility', blind.cases.length === 0 && blind.withheld === 3, 'a case reviewing a decision the viewer cannot see was shown');

// ---- the real decision-visibility rule, not a stub.
const visibleTo = async (v) => {
  const set = new Set();
  for (const d of unwrap(await s.decisionStore.listDecisions(s.scope), 'decisions')) {
    const grants = await s.authorityStore.listVisibility(s.scope, d.id);
    const grantedUnitIds = grants.ok ? grants.value.map((x) => x.orgUnitId) : [];
    if (canSeeDecision({ userId: v.userId, orgRole: v.orgRole, memberUnitIds: v.memberUnitIds }, { createdBy: d.createdBy, grantedUnitIds }, DEMO_UNITS).visible) set.add(d.id);
  }
  return (id) => set.has(id);
};
const gm = viewer(USERS.countryGM, BOTH);
c.check('unshared', (await project(gm, await visibleTo(gm))).cases.length === 0, 'an unshared decision\'s counterfactual cases were readable by someone the decision was never shared with');

// ---- an estimate never shows a class the case does not carry.
const alts = await rohtoAlternatives(s);
const narrow = unwrap(
  await s.counterfactual.openCase(s.scope, {
    decisionId: s.story.decisionId,
    title: 'narrow',
    question: 'Narrow?',
    intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.delay.id },
    anchorSnapshotId: s.story.S0.snapshot.id,
    scope: { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] },
    authoredByLabel: 'contract',
  }),
  'narrow',
);
const est = await s.counterfactual.estimate(s.scope, narrow.case.id, { lens: 'AS_KNOWN_THEN', byLabel: 'contract' });
c.check('no-leak', !est.ok && /COMMERCIAL_CONFIDENTIAL/.test(est.error.message), 'a case that does not carry COMMERCIAL_CONFIDENTIAL estimated an alternative that moves a commercial value');
const scenariosAfter = unwrap(await s.scenarios.listScenarios(s.scope), 'scenarios').filter((x) => x.key.startsWith(`cf-${narrow.case.id}`));
c.check('no-leak', scenariosAfter.every((x) => x.status === 'ARCHIVED'), 'a refused estimate left a live scenario behind');

// ---- visibility is not authority; nobody is scored.
const dir = join(process.cwd(), 'packages', 'counterfactual-runtime', 'src');
const strip = (f) => readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');
for (const f of ['runtime.ts', 'policy.ts']) c.check('not-authority', !/evaluateAuthority|createAuthorityRuntime|recordApproval|\.evaluate\(/.test(strip(f)), `${f} consults the authority engine: visibility is not authority`);
for (const m of Object.keys(s.counterfactual)) c.check('no-person-view', !/byPerson|byManager|byAuthor|byOwner|leaderboard|performance|regret|rank/i.test(m), `the runtime offers ${m}`);
for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
  c.check('no-person-view', !/\b(managerScore|personScore|performanceRating|leaderboard|regretScore|regretOf)\w*/i.test(strip(f)), `${f} scores a person or a decision`);
}

// ---- lineage: every world names what it read.
for (const [name, w] of Object.entries({ cf1Then: g.worlds.cf1Then.world, cf1Hindsight: g.worlds.cf1Hindsight.world, cf2Then: g.worlds.cf2Then.world })) {
  c.check('lineage', !!w.scenario && !!w.scenario.runId && !!w.model && w.model.calculations.length > 0 && !!w.model.engineVersion, `${name} does not name the run, engine and calculations it read`);
  c.check('lineage', !!w.fingerprint && /^cfw_/.test(w.fingerprint), `${name} has no content fingerprint`);
  c.check('lineage', w.movedInputs.every((m) => m.rationale && m.provenanceKind), `${name} has an input with no rationale or provenance kind`);
}
c.check('lineage', g.worlds.cf1Hindsight.world.hindsightInputs.every((h) => h.source && h.source.ref), 'a hindsight input does not name its source');
const runs = unwrap(await s.scenarios.listRuns(s.scope), 'runs');
c.check('lineage', runs.some((r) => r.id === g.worlds.cf1Then.world.scenario.runId), 'the run a world names does not exist in the scenario runtime');

c.finish('read whole or not at all by unit, class and decision; an estimate never shows what its readers may not read; visibility is not authority; nobody is scored; every world names its run, model and inputs');
