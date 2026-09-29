/**
 * The Phase 1–8 stack with the canonical twin story and the DEMO causal
 * story, for the verify:causal-* contracts. It is the test harness's story,
 * so a contract and a test can never disagree about what was built.
 */

export { buildCausalStack, buildCausalStory, at, unwrap, expectFail, USERS, MEMBERSHIP, UNITS, ADMIN, DEMO_UNITS, valueKey } from '../../packages/causal-runtime/test/harness.mjs';
export { contract } from './twinStack.mjs';
