/**
 * Phase 9 performance, measured in memory over the canonical genome story.
 * Run with: node scripts/lib/bench-genome.mjs
 *
 * It measures the genome's own work: episode assembly from the kernel,
 * situation derivation, similarity, pattern evaluation over linked episodes,
 * historical reconstruction and per-viewer projection. Postgres numbers are NOT
 * produced here and are not guessed.
 */

import { decidePattern } from '../../packages/genome-runtime/src/index.ts';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, USERS, buildGenomeStory, unwrap } from './genomeStack.mjs';

const ms = (t) => `${(Number(t) / 1e6).toFixed(2)} ms`;
const time = async (label, fn, n = 1) => {
  const t0 = process.hrtime.bigint();
  let last;
  for (let i = 0; i < n; i += 1) last = await fn(i);
  const total = process.hrtime.bigint() - t0;
  console.log(`${label.padEnd(66)} ${ms(total).padStart(10)}${n > 1 ? `  (${ms(total / BigInt(n))} each)` : ''}`);
  return last;
};

const start = process.hrtime.bigint();
const s = await buildGenomeStory();
console.log(`${'stack + twin + causal + genome story (5 episodes, 3 patterns)'.padEnd(66)} ${ms(process.hrtime.bigint() - start).padStart(10)}`);
const { genome, scope, genomeStory: g } = s;
const E1 = g.episodes.E1.episode.id;
const P1 = g.patterns.P1.pattern.id;

await time('episode retrieval — getEpisode(Rohto), assembled from the kernel', async () => unwrap(await genome.getEpisode(scope, E1), 'get'), 50);
await time('episode listing — all five, each assembled', async () => unwrap(await genome.listEpisodes(scope), 'list'), 20);
await time('situation derivation — situationOf(decision), nothing recorded', async () => unwrap(await genome.situationOf(scope, g.episodes.E5.episode.decisionId), 'situation'), 100);
await time('similarity — three required features', async () => unwrap(await genome.findSimilar(scope, { episodeId: E1, require: ['decisionType', 'businessUnit', 'triggerType'] }), 'similar'), 50);
await time('pattern retrieval — getPattern(P1), evaluated at now', async () => unwrap(await genome.getPattern(scope, P1), 'pattern'), 50);
await time('pattern listing — all three, each evaluated over its links', async () => unwrap(await genome.listPatterns(scope), 'patterns'), 20);
await time('classification — one episode against one pattern', async () => unwrap(await genome.classifyEpisode(scope, P1, E1), 'classify'), 100);
await time('historical view — viewAt(6 April), reconstructed', async () => unwrap(await genome.viewAt(scope, { effectiveAsOf: '2027-04-06T05:00:00.000Z', recordedThrough: '2027-04-06T05:00:00.000Z' }), 'view'), 20);
const viewer = { userId: USERS.countryGM, orgRole: 'member', memberUnitIds: MEMBERSHIP[USERS.countryGM] ?? [], clearances: [] };
await time('per-viewer projection — projectForViewer (uncleared GM)', async () => unwrap(await genome.projectForViewer(scope, viewer, DEMO_UNITS, { decisionVisible: () => true }), 'project'), 20);
await time('per-viewer projection — projectForViewer (admin)', async () => unwrap(await genome.projectForViewer(scope, { userId: ADMIN, orgRole: 'admin', memberUnitIds: [], clearances: [] }, DEMO_UNITS, { decisionVisible: () => true }), 'project'), 20);

const link = (n, context) => ({ episodeId: `e${n}`, decisionId: `d${n}`, contextKey: context });
const many = Array.from({ length: 500 }, (_, i) => link(i, `ctx${i % 7}`));
await time('pattern policy alone — decidePattern over 500 supporting episodes, pure', async () =>
  decidePattern({ supporting: many, contradictory: [], contextual: 0, retired: { retired: false, reason: null }, coverage: { matching: 500, linked: 500, unlinkedMatching: [] } }),
  2000,
);
