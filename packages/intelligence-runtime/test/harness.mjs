/**
 * Test harness: the whole enterprise story with both management reviews (the
 * review harness), plus the governed tools and the intelligence runtime over it,
 * on the deterministic reference provider — no model, no credentials.
 *
 * Not a test file itself (no `.test.` in the name).
 */

import { seqIdGen } from '@helm/shared';
import { createGovernedTools, createInMemoryAiRunStore, createIntelligenceRuntime, createReferenceProvider } from '../src/index.ts';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, buildReviewStory, expectFail, unwrap } from '../../review-runtime/test/harness.mjs';

export { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, expectFail, unwrap };

export const ALL_CLASSES = ['FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED'];

const clearance = (userId, sensitivity) => ({ id: `${userId}-${sensitivity}`, orgId: 'o', userId, sensitivity, validFrom: '2026-01-01T00:00:00.000Z', validTo: null, reason: 'test', grantedBy: ADMIN, recordedAt: '2026-01-01T00:00:00.000Z' });
export const viewer = (userId, classes = [], orgRole = 'member') => ({ userId, orgRole, memberUnitIds: MEMBERSHIP[userId] ?? [], clearances: classes.map((k) => clearance(userId, k)) });

/** A caller: who is asking, the units, and which decisions they may see. */
export const caller = (v, decisionVisible = () => true) => ({ viewer: v, units: DEMO_UNITS, facts: { decisionVisible } });
export const adminCaller = () => caller(viewer(ADMIN, [], 'admin'));
export const gmCaller = (decisionVisible = () => true) => caller(viewer(USERS.countryGM, ALL_CLASSES), decisionVisible);

export function buildIntelligence(s, provider = createReferenceProvider()) {
  const tools = createGovernedTools({ twin: s.twin, decisions: s.decisionsRuntime, authority: s.authority, causal: s.causal, genome: s.genome, counterfactual: s.counterfactual, review: s.review });
  const store = createInMemoryAiRunStore({ clock: s.clock, idGen: seqIdGen('ai') });
  const intelligence = createIntelligenceRuntime({ provider, tools, store, clock: s.clock });
  return { tools, aiStore: store, intelligence };
}

export async function buildIntelligenceStory() {
  const s = await buildReviewStory();
  return { ...s, ...buildIntelligence(s) };
}

/** A fake provider that proposes whatever the test says, and records everything it was handed. */
export function scriptedProvider(draft, { plan } = {}) {
  const received = [];
  return {
    id: 'scripted-fake',
    model: 'none',
    modelVersion: '0',
    received,
    ...(plan ? { plan: async (input) => { received.push({ plan: input }); return plan; } } : {}),
    async synthesize(input) {
      received.push({ synthesize: input });
      return typeof draft === 'function' ? draft(input) : draft;
    },
  };
}
