/**
 * Test harness: the whole enterprise story with both reviews and the governed AI
 * tools (the intelligence harness), plus the council over them on the deterministic
 * reference perspective composer — no model, no credentials.
 *
 * Not a test file itself (no `.test.` in the name).
 */

import { createCouncil, createReferencePerspectiveProvider } from '../src/index.ts';
import { ADMIN, ALL_CLASSES, DEMO_UNITS, USERS, adminCaller, buildIntelligenceStory, caller, expectFail, gmCaller, scriptedProvider, unwrap, viewer } from '../../intelligence-runtime/test/harness.mjs';

export { ADMIN, ALL_CLASSES, DEMO_UNITS, USERS, adminCaller, caller, expectFail, gmCaller, scriptedProvider, unwrap, viewer };

export function buildCouncil(s, provider = createReferencePerspectiveProvider()) {
  return createCouncil({ provider, tools: s.tools, store: s.aiStore, clock: s.clock });
}

export async function buildCouncilStory() {
  const s = await buildIntelligenceStory();
  return { ...s, council: buildCouncil(s) };
}
