/**
 * The Phase 1–8 stack with the canonical twin story, the DEMO causal story and
 * the DEMO management episodes, for the verify:genome-* contracts. It is the
 * test harness's story, so a contract and a test can never disagree about what
 * was built.
 */

export { buildGenomeStack, buildGenomeStory, at, unwrap, expectFail, USERS, MEMBERSHIP, UNITS, ADMIN, DEMO_UNITS } from '../../packages/genome-runtime/test/harness.mjs';
export { contract } from './twinStack.mjs';
