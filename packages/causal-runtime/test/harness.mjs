/**
 * Test harness: the Phase 1–7 stack with the canonical twin story (the twin
 * harness), plus the causal graph over it and the DEMO causal story.
 *
 * Not a test file itself (no `.test.` in the name).
 */

import { seqIdGen } from '@helm/shared';
import { buildSeedValueRegistry } from '@helm/value-graph';
import { MERIDIAN_DEMO_UNITS } from '@helm/authority-runtime';
import { createCausalGraph, createInMemoryCausalStore, runMeridianCausalStory } from '../src/index.ts';
import { ADMIN, MEMBERSHIP, UNITS, USERS, buildStory, item, itemsOf, unwrap, valueKey } from '../../twin-runtime/test/harness.mjs';

export { ADMIN, MEMBERSHIP, UNITS, USERS, item, itemsOf, unwrap, valueKey };
export { expectFail } from '../../twin-runtime/test/harness.mjs';
export const DEMO_UNITS = MERIDIAN_DEMO_UNITS;

export async function buildCausalStack() {
  const s = await buildStory();
  const causalStore = createInMemoryCausalStore({ clock: s.clock, idGen: seqIdGen('c') });
  const causal = createCausalGraph({ store: causalStore, graph: s.graph, metrics: buildSeedValueRegistry(), calculations: s.registry, clock: s.clock });
  return { ...s, causalStore, causal };
}

/** The canonical causal story over a fresh stack. */
export async function buildCausalStory(existing = null) {
  const s = existing ?? (await buildCausalStack());
  const e = s.governance.entities;
  const revisions = unwrap(await s.decisionStore.listRevisions(s.scope, s.story.decisionId), 'revisions');
  const assumptions = [];
  for (const r of revisions) assumptions.push(...unwrap(await s.decisionStore.listAssumptions(s.scope, r.id), 'assumptions'));
  const cf1Gm = s.story.CF1.items.find((i) => i.kind === 'VALUE' && i.state.nodeId === s.nodeIds.freightOpex);
  const causalStory = unwrap(
    await runMeridianCausalStory({
      causal: s.causal,
      admin: s.scope,
      as: s.as,
      users: USERS,
      entities: { vn: e.vn, buPharma: e.buPharma, rohto: e.rohto, buIndustrial: e.buIndustrial, buThPharma: e.buThPharma },
      nodeIds: { freightOpex: s.nodeIds.freightOpex, grossMarginPctOpp: s.nodeIds.grossMarginPctOpp },
      twin: {
        decisionId: s.story.decisionId,
        cf1SnapshotId: s.story.CF1.snapshot.id,
        s2SnapshotId: s.story.S2.snapshot.id,
        fulfilmentItemKey: cf1Gm?.key ?? valueKey(s.nodeIds.freightOpex, 'ACTUAL'),
      },
      assumptions,
      advanceTo: (iso) => s.clock.jumpTo(iso),
    }),
    'causal story',
  );
  return { ...s, causalStory, assumptions };
}

/** A lens at a moment of the story, both times the same. */
export const at = (iso) => ({ effectiveAsOf: iso, recordedThrough: iso });
