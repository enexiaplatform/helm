/**
 * verify:causal-temporality — what management believed, and when.
 *
 * The causal view is reconstructed at a lens from append-only records: H1 was
 * a HYPOTHESIS on 19 Jan and is SUPPORTED after 20 Jan, and 19 Jan stays 19 Jan;
 * a claim recorded later does not exist earlier; revisions keep their earlier
 * wording; a future knowledge boundary is refused; the twin's own lens is
 * reused rather than copied.
 */

import { MERIDIAN_CAUSAL_TIMES as T } from '../packages/causal-runtime/src/index.ts';
import { at, buildCausalStory, contract, unwrap } from './lib/causalStack.mjs';

const c = contract('verify:causal-temporality');
const s = await buildCausalStory();
const k = s.causalStory.claims;

const t1 = unwrap(await s.causal.getClaim(s.scope, k.H1.claim.id, at(T.beforeScmEvidence)), 'T1');
const t2 = unwrap(await s.causal.getClaim(s.scope, k.H1.claim.id), 'T2');
c.check('historical', t1.evaluation.status === 'HYPOTHESIS', `H1 on 19 Jan reads ${t1.evaluation.status}`);
c.check('historical', t2.evaluation.status === 'SUPPORTED', `H1 now reads ${t2.evaluation.status}`);
const again = unwrap(await s.causal.getClaim(s.scope, k.H1.claim.id, at(T.beforeScmEvidence)), 'T1 again');
c.check('historical', JSON.stringify(again.evaluation) === JSON.stringify(t1.evaluation), 'later evidence rewrote what was believed on 19 Jan');

const early = await s.causal.getClaim(s.scope, k.D1.claim.id, at(T.beforeScmEvidence));
c.check('knowledge-boundary', !early.ok && early.error.code === 'causal.not_known_at_lens', 'a claim recorded later was visible at an earlier boundary');
const atS2 = unwrap(await s.causal.viewAt(s.scope, s.story.S2.snapshot.spec.lens), 'S2 lens');
c.check('twin-lens', atS2.claims.length === 0, `at the S2 snapshot's knowledge boundary ${atS2.claims.length} causal claims already existed`);
const future = await s.causal.viewAt(s.scope, at(new Date(s.clock.peek().getTime() + 86_400_000).toISOString()));
c.check('knowledge-boundary', !future.ok && future.error.code === 'causal.knowledge_in_future', 'a knowledge boundary in the future was accepted');

const ex = unwrap(await s.causal.explainClaim(s.scope, k.H1.claim.id), 'history');
c.check('history', ex.history[0].status === 'HYPOTHESIS' && ex.history[ex.history.length - 1].status === 'SUPPORTED', 'the claim history does not show the belief changing');

const beforeRevision = s.clock.now().toISOString();
unwrap(await s.causal.reviseClaim(s.as(k.C3.claim.authoredBy), k.C3.claim.id, { statement: 'Reworded.' }), 'revise');
const oldWording = unwrap(await s.causal.getClaim(s.scope, k.C3.claim.id, at(beforeRevision)), 'old');
c.check('versioned', oldWording.revision.revision === 1 && oldWording.revision.statement !== 'Reworded.', 'a revision rewrote the earlier wording');

// Evidence that already existed, linked later: the link is knowledge too.
const lateClaim = unwrap(await s.causal.createClaim(s.scope, { causeKey: 'DELIVERY_SPEED', effectKey: 'CUSTOMER_SATISFACTION', relationshipType: 'INCREASES', scope: { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] }, authoredByLabel: 'contract', statement: 'late link', rationale: 'r' }), 'late claim');
const beforeLink = s.clock.now().toISOString();
unwrap(await s.causal.supportClaim(s.scope, lateClaim.claim.id, s.causalStory.evidence.E3.id, 'linked later'), 'late link');
const unlinked = unwrap(await s.causal.getClaim(s.scope, lateClaim.claim.id, at(beforeLink)), 'before link');
c.check('link-is-knowledge', unlinked.evaluation.counts.supporting === 0, 'a link made later counted at an earlier knowledge boundary, although the evidence itself already existed');

const period = unwrap(await s.causal.getClaim(s.scope, k.H4.claim.id, { effectiveAsOf: '2027-02-01T00:00:00.000Z', recordedThrough: T.coincidence }), 'period');
c.check('business-time', period.evaluation.applicableAtEffective === false, 'a Q4 claim was reported as applicable in February');

c.finish('H1 HYPOTHESIS on 19 Jan, SUPPORTED after 20 Jan, and 19 Jan unchanged; later claims unknown earlier; revisions keep their wording; no future knowledge; the twin lens reused');
