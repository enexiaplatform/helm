/**
 * verify:genome-scope — a pattern holds where it was recorded, nowhere else.
 *
 * A pattern is anchored on entities (or enterprise-wide with a stated reason);
 * an episode outside its scope or conditions neither supports nor contradicts
 * it — it is contextual, and HELM says so; a stance must agree with what HELM
 * observed in the episode's own records; "have we seen this before?" is
 * agreement on named features, and a situation nobody has faced is not thereby
 * new. A condition is a situation feature — never a person.
 */

import { buildGenomeStory, contract, expectFail, unwrap } from './lib/genomeStack.mjs';

const c = contract('verify:genome-scope');
const s = await buildGenomeStory();
const g = s.genomeStory;
const e = s.governance.entities;
const anchor = (x, label) => ({ entityId: x.entityId, label, dimension: '' });
const pharma = { kind: 'ANCHORED', anchors: [anchor(e.buPharma, 'Pharma BU')] };
const base = { title: 't', scope: pharma, characteristic: { kind: 'PROCESS_FEATURE', feature: 'CHALLENGE_OPEN_AT_COMMITMENT' }, statement: 's', limitations: 'l', authoredByLabel: 'contract' };

// Scope is required and never global by default.
const unscoped = await s.genome.proposePattern(s.scope, { ...base, scope: { kind: 'ANCHORED', anchors: [] } });
c.check('scoped', !unscoped.ok && unscoped.error.code === 'genome.invalid_input', 'an unscoped pattern was accepted');
const unjustified = await s.genome.proposePattern(s.scope, { ...base, scope: { kind: 'ENTERPRISE_WIDE', justification: 'yes' } });
c.check('scoped', !unjustified.ok, 'an enterprise-wide pattern was accepted without a reason');
const wide = await s.genome.proposePattern(s.scope, { ...base, scope: { kind: 'ENTERPRISE_WIDE', justification: 'A process feature that does not depend on any business unit.' } });
c.check('scoped', wide.ok, 'an enterprise-wide pattern with a stated reason was refused');
const bogus = await s.genome.openEpisode(s.scope, { decisionId: g.episodes.E2.episode.decisionId, title: 'x', scope: { kind: 'ANCHORED', anchors: [{ entityId: 'no-such-entity', label: 'Nowhere', dimension: '' }] }, authoredByLabel: 'contract' });
c.check('scoped', !bogus.ok, 'an episode was scoped to an entity that did not exist');

// Limitations are required; conditions and characteristics are observable; no person.
const noLimits = await s.genome.proposePattern(s.scope, { ...base, limitations: '' });
c.check('limitations', !noLimits.ok && /limitations.*not optional/.test(noLimits.error.message), 'a pattern was accepted without stating its limitations');
for (const person of ['committedBy', 'owner', 'manager', 'author', 'reviewer']) {
  const r = await s.genome.proposePattern(s.scope, { ...base, conditions: { [person]: ['Country GM'] } });
  c.check('no-person', !r.ok && /not a feature a pattern may condition on/.test(r.error.message), `a pattern conditioned on a person (${person})`);
}
const invented = await s.genome.proposePattern(s.scope, { ...base, characteristic: { kind: 'MANAGER_JUDGEMENT', level: 'good' } });
c.check('observable', !invented.ok && /Unknown characteristic kind/.test(invented.error.message), 'a pattern carried a characteristic HELM cannot observe');

// Contextual episodes neither support nor contradict.
const p1 = g.patterns.P1;
const ctx = new Set(p1.contextual.map((x) => x.episode.episode.id));
c.check('contextual', ctx.has(g.episodes.E2.episode.id) && ctx.has(g.episodes.E3.episode.id), 'the planned call-off and the Thailand episode are not contextual for P1');
c.check('contextual', p1.contextual.every((x) => x.evidence.observed === 'OUT_OF_SCOPE'), 'a contextual episode was classified as supporting or contradicting');
const thai = unwrap(await s.genome.classifyEpisode(s.scope, p1.pattern.id, g.episodes.E3.episode.id), 'thai');
c.check('classification', thai.classification === 'OUT_OF_SCOPE' && thai.reasons.length > 0, `Thailand against a Vietnam Pharma pattern is ${thai.classification}`);
const own = unwrap(await s.genome.classifyEpisode(s.scope, p1.pattern.id, g.episodes.E1.episode.id), 'own');
c.check('classification', own.classification === 'SUPPORTS' || own.classification === 'CONTRADICTS', `an episode inside the scope was classified ${own.classification}`);

// A stance must agree with what HELM observed.
const fresh = unwrap(await s.genome.proposePattern(s.scope, { ...base, title: 'stance', conditions: { decisionType: ['INVENTORY_ALLOCATION'] }, characteristic: { kind: 'PROCESS_FEATURE', feature: 'ALTERNATIVE_UNMODELLED' } }), 'fresh');
const observed = unwrap(await s.genome.classifyEpisode(s.scope, fresh.pattern.id, g.episodes.E1.episode.id), 'observed').classification;
const wrong = observed === 'SUPPORTS' ? 'CONTRADICTORY_EPISODE' : 'SUPPORTING_EPISODE';
const refused = await s.genome.linkEpisode(s.scope, fresh.pattern.id, g.episodes.E1.episode.id, wrong, 'I would like it to.');
c.check('stance-agrees', !refused.ok && refused.error.code === 'genome.inconsistent_stance', `a stance that disagrees with the observation (${observed}) was recorded as ${wrong}`);
const thaiLink = await s.genome.linkEpisode(s.scope, p1.pattern.id, g.episodes.E3.episode.id, 'SUPPORTING_EPISODE', 'Thailand too.');
c.check('stance-agrees', !thaiLink.ok, 'an episode outside the pattern was linked as support');

// Similarity is agreement on named features.
const sim = unwrap(await s.genome.findSimilar(s.scope, { episodeId: g.episodes.E1.episode.id, require: ['decisionType', 'businessUnit', 'triggerType'] }), 'similar');
c.check('similarity', sim.required.length === 3 && sim.episodes.every((x) => x.agreements.length === 3), 'similarity is not stated feature by feature');
const noFeatures = await s.genome.findSimilar(s.scope, { episodeId: g.episodes.E1.episode.id, require: [] });
c.check('similarity', !noFeatures.ok, 'similarity was asked for with no required feature: everything is similar to everything');
const person = await s.genome.findSimilar(s.scope, { episodeId: g.episodes.E1.episode.id, require: ['committedBy'] });
c.check('no-person', !person.ok, 'similarity was asked for on a person');
// Absence of information is not similarity: an unstated feature agrees with nothing, and the answer says so.
const notStated = unwrap(await s.genome.findSimilar(s.scope, { episodeId: g.episodes.E4.episode.id, require: ['constraintKind'] }), 'not stated');
c.check('not-stated', notStated.episodes.length === 0 && JSON.stringify(notStated.unstatedInTarget) === '["constraintKind"]', 'a feature the situation does not state was matched, or not reported as unstated');
c.check('not-stated', /does not state constraintKind/.test(notStated.statement) && /cannot tell/.test(notStated.statement), 'an empty result on an unstated feature does not say "cannot tell"');
c.check('not-stated', sim.unstatedInTarget.length === 0, 'a stated feature was reported as unstated');

c.finish('no unscoped pattern, limitations required, no person condition, observable characteristics only; out-of-scope episodes contextual; stance must agree with HELM; similarity by named features, never by a person');
