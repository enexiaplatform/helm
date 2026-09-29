/**
 * Phase 7 performance, measured in memory over the canonical twin story.
 * Run with: node scripts/lib/bench-twin.mjs
 *
 * It measures the twin's own work: composing a snapshot (build), loading a
 * stored one, replay, comparison, explaining a difference, and the current
 * state against the committed future. Postgres numbers are NOT produced here
 * and are not guessed.
 */

import { MERIDIAN_DEMO_UNITS } from '@helm/authority-runtime';
import { buildStory, unwrap, UNITS, USERS } from './twinStack.mjs';

const ms = (t) => `${(Number(t) / 1e6).toFixed(2)} ms`;
const time = async (label, fn, n = 1) => {
  const t0 = process.hrtime.bigint();
  let last;
  for (let i = 0; i < n; i += 1) last = await fn(i);
  const total = process.hrtime.bigint() - t0;
  console.log(`${label.padEnd(60)} ${ms(total).padStart(10)}${n > 1 ? `  (${ms(total / BigInt(n))} each)` : ''}`);
  return last;
};

const start = process.hrtime.bigint();
const s = await buildStory();
console.log(`${'stack + canonical story (Phases 1–6 seed, 9 snapshots)'.padEnd(60)} ${ms(process.hrtime.bigint() - start).padStart(10)}`);
const { twin, scope, story } = s;
const { S0, S1, CF1, S2, H23 } = story;
console.log(`items per snapshot: S0 ${S0.items.length} · S1 ${S1.items.length} · CF1 ${CF1.items.length} · S2 ${S2.items.length} · H23 ${H23.items.length}`);

const built = await time('build CURRENT snapshot, Vietnam scope (compose + store)', async (i) =>
  unwrap(await twin.buildSnapshot(scope, { kind: 'CURRENT', label: `bench ${i}`, scope: story.scopes.vietnam, grantedUnitIds: [UNITS.vietnam] }), 'build'),
  10,
);
await time('build HISTORICAL snapshot, 23 Sep lens (compose + store)', async (i) =>
  unwrap(await twin.buildSnapshot(scope, { kind: 'HISTORICAL', label: `bench H ${i}`, scope: story.scopes.vietnam, lens: H23.snapshot.spec.lens, grantedUnitIds: [UNITS.vietnam] }), 'historical'),
  10,
);
await time('load a stored snapshot (getSnapshot)', async () => unwrap(await twin.getSnapshot(scope, S2.snapshot.id), 'load'), 100);
await time('list snapshots of the org', async () => unwrap(await twin.listSnapshots(scope), 'list'), 100);
await time('replay S2 (recompose under its lens + fingerprint compare)', async () => {
  const r = unwrap(await twin.replaySnapshot(scope, S2.snapshot.id), 'replay');
  if (!r.identical) throw new Error('replay diverged');
  return r;
}, 10);
await time('compare S0 → S2 (twin delta + delta attention)', async () => unwrap(await twin.compareSnapshots(scope, S0.snapshot.id, S2.snapshot.id), 'compare'), 50);
await time('compare S1 → S1 (identical, no change)', async () => unwrap(await twin.compareSnapshots(scope, S1.snapshot.id, S1.snapshot.id), 'same'), 50);

const gm = S2.items.find((i) => i.kind === 'VALUE' && i.layer === 'ACTUAL' && /gross margin/i.test(i.label));
const gmCf = CF1.items.find((i) => i.kind === 'VALUE' && i.layer === 'COMMITTED_FUTURE' && /gross margin/i.test(i.label));
if (!gm || !gmCf) throw new Error('bench: gross margin items not found');
await time('explain difference CF1 → S2 (GM%, attribution walk)', async () =>
  unwrap(await twin.explainDifference(scope, CF1.snapshot.id, S2.snapshot.id, gmCf.key, gm.key), 'explain difference'),
  20,
);
await time('explain one item (S2 GM%, lineage to observations)', async () => unwrap(await twin.explainItem(scope, S2.snapshot.id, gm.key), 'explain'), 50);
await time('current vs committed future (trajectory S2 against CF1)', async () => unwrap(await twin.getTrajectory(scope, S2.snapshot.id, CF1.snapshot.id), 'trajectory'), 50);
await time('management state of S2 (by category + attention)', async () => unwrap(await twin.getManagementState(scope, S2.snapshot.id), 'management'), 50);
await time('project S2 for the Country GM (visibility + sensitivity)', async () =>
  unwrap(await twin.projectForViewer(scope, S2.snapshot.id, { userId: USERS.countryGM, orgRole: 'member', memberUnitIds: [UNITS.vietnam], clearances: [] }, MERIDIAN_DEMO_UNITS), 'project'),
  50,
);
console.log(`last CURRENT build: ${built.items.length} items, ${built.snapshot.completeness}, ${built.snapshot.fingerprint}`);
