/**
 * verify:genome-security — the genome is read whole, or not at all.
 *
 * The kernel statement of helm_private.can_see_genome_episode/pattern/lesson:
 * an episode is read only with every sensitivity class it carries, the units
 * it is restricted to, and the decision it wraps; a pattern or lesson only when
 * every episode it rests on is readable — otherwise it is withheld with its
 * title. Admins read everything; visibility is not authority. And the SQL twin
 * of every one of those rules exists.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, buildGenomeStory, contract, unwrap } from './lib/genomeStack.mjs';

const c = contract('verify:genome-security');
const s = await buildGenomeStory();
const g = s.genomeStory;
const clearance = (userId, sensitivity) => ({ id: `${userId}-${sensitivity}`, orgId: 'o', userId, sensitivity, validFrom: '2026-01-01T00:00:00.000Z', validTo: null, reason: 'contract', grantedBy: ADMIN, recordedAt: '2026-01-01T00:00:00.000Z' });
const viewer = (userId, classes = [], orgRole = 'member') => ({ userId, orgRole, memberUnitIds: MEMBERSHIP[userId] ?? [], clearances: classes.map((k) => clearance(userId, k)) });
const project = async (v, decisionVisible = () => true) => unwrap(await s.genome.projectForViewer(s.scope, v, DEMO_UNITS, { decisionVisible }), 'project');
const ids = (xs, pick) => new Set(xs.map(pick));

// Sensitivity is derived from the metrics the commitment expected to move.
c.check('sensitivity', JSON.stringify([...g.episodes.E1.episode.sensitivityClasses].sort()) === JSON.stringify(['FINANCIAL_SENSITIVE', 'GENERAL_MANAGEMENT']), 'the Rohto episode does not carry FINANCIAL_SENSITIVE: gross margin and cash impact are margin-grade');

const uncleared = await project(viewer(USERS.industrialHead));
c.check('sensitivity', uncleared.episodes.length === 0 && uncleared.patterns.length === 0 && uncleared.lessons.length === 0, 'an uncleared viewer reads an episode, or a pattern or lesson resting on one');
c.check('stated', uncleared.withheld.episodes === 5 && /withheld whole/.test(uncleared.statement), 'withheld episodes are not counted and stated');
const cleared = await project(viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE']));
c.check('sensitivity', cleared.episodes.length === 5 && cleared.patterns.length === 3 && cleared.lessons.length === 2 && cleared.withheld.episodes + cleared.withheld.patterns + cleared.withheld.lessons === 0, 'a cleared viewer cannot read the whole genome');
const admin = await project(viewer(ADMIN, [], 'admin'), () => false);
c.check('admin', admin.episodes.length === 5, 'an admin cannot read every episode without a decision grant');

// Read whole: an unreadable decision withholds the episode and everything resting on it.
const blindRohto = await project(viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE']), (id) => id !== s.story.decisionId);
c.check('decision-capture', blindRohto.episodes.length === 4 && blindRohto.patterns.length === 0 && blindRohto.lessons.length === 0 && blindRohto.withheld.patterns === 3, 'a pattern or lesson resting on an invisible decision is readable');
const blindThai = await project(viewer(USERS.countryGM, ['FINANCIAL_SENSITIVE']), (id) => id !== g.episodes.E3.episode.decisionId);
c.check('decision-capture', JSON.stringify([...ids(blindThai.patterns, (v) => v.pattern.id)].sort()) === JSON.stringify([g.patterns.P2.pattern.id, g.patterns.P3.pattern.id].sort()), 'withholding one unrelated decision withheld patterns that do not rest on it, or kept one that does');

// A RESTRICTED pattern follows its unit grants.
const pharma = { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] };
const restricted = unwrap(await s.genome.proposePattern(s.scope, { title: 'restricted to Pharma', scope: pharma, conditions: { decisionType: ['INVENTORY_ALLOCATION'] }, characteristic: { kind: 'PROCESS_FEATURE', feature: 'ALTERNATIVE_UNMODELLED' }, statement: 's', limitations: 'l', visibility: 'RESTRICTED', grantedUnitIds: [UNITS.pharma], authoredByLabel: 'contract' }), 'restricted');
const readers = async (userId) => ids((await project(viewer(userId, ['FINANCIAL_SENSITIVE']))).patterns, (v) => v.pattern.id);
c.check('bu-restriction', (await readers(USERS.pharmaAnalyst)).has(restricted.pattern.id), 'Pharma cannot read a pattern restricted to Pharma');
c.check('bu-restriction', (await readers(USERS.countryGM)).has(restricted.pattern.id), 'the Country GM above Pharma cannot read it');
c.check('bu-restriction', !(await readers(USERS.industrialHead)).has(restricted.pattern.id), 'Industrial reads a pattern restricted to Pharma');

// Visibility is not authority; no person is a feature.
const dir = join(process.cwd(), 'packages', 'genome-runtime', 'src');
const strip = (f) => readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');
const src = ['runtime.ts', 'policy.ts', 'situation.ts'].map(strip).join('\n');
c.check('visibility-not-authority', !/evaluateAuthority|createAuthorityRuntime|recordApproval|\.evaluate\(/.test(src), 'the genome consults the authority engine');
c.check('no-person-dimension', !/committedBy|reviewedBy|ownerUserId|performance|rating|leaderboard/i.test(strip('policy.ts') + strip('situation.ts')), 'the pattern policy or the situation features refer to a person');
c.check('no-person-view', Object.keys(s.genome).every((m) => !/byPerson|byManager|byAuthor|byOwner|leaderboard|performance/i.test(m)), 'the genome offers a per-person view');

const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260930110000_helm_management_genome.sql'), 'utf8');
for (const [rule, re] of [
  ['sql-twin', /FUNCTION helm_private\.can_see_genome_episode/],
  ['sql-twin', /FUNCTION helm_private\.genome_episode_row_visible/],
  ['sql-twin', /FUNCTION helm_private\.can_see_genome_pattern/],
  ['sql-twin', /FUNCTION helm_private\.genome_pattern_row_visible/],
  ['sql-twin', /FUNCTION helm_private\.can_see_genome_lesson/],
  ['sql-twin', /FUNCTION helm_private\.genome_lesson_row_visible/],
  ['sql-twin', /CREATE POLICY "Scoped read genome episodes"[\s\S]*?genome_episode_row_visible\(org_id, decision_id, visibility, authored_by, granted_unit_ids, sensitivity_classes\)/],
  ['sql-twin', /CREATE POLICY "Scoped read genome patterns"[\s\S]*?genome_pattern_row_visible\(org_id, id, visibility, authored_by, granted_unit_ids\)/],
  ['sql-twin', /CREATE POLICY "Scoped read genome lessons"[\s\S]*?genome_lesson_row_visible\(org_id, visibility, authored_by, granted_unit_ids, evidence\)/],
  ['sql-twin', /CREATE POLICY "Scoped read genome episode refs"[\s\S]*?can_see_genome_episode\(episode_id\)/],
  ['sql-twin', /CREATE POLICY "Readers link genome pattern evidence"[\s\S]*?can_see_genome_pattern\(pattern_id\) AND helm_private\.can_see_genome_episode\(episode_id\)/],
  ['sql-twin', /CREATE POLICY "Readers review genome lessons"[\s\S]*?can_see_genome_lesson\(lesson_id\)/],
]) c.check(rule, re.test(sql), `the database lacks ${re}`);

c.finish('an episode is read with every class it carries, its units and its decision; patterns and lessons only when every episode they rest on is readable, otherwise withheld whole; admins read all; visibility ≠ authority; no person view; SQL twin present');
