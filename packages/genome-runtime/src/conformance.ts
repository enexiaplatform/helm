/**
 * The GenomeStore conformance suite.
 *
 * ONE contract, run against EVERY adapter: records are write-once and stamped
 * with the store's own record time; an episode reference is bound once; a
 * pattern and its first revision exist together, revisions are sequential and
 * stop at retirement, and its limitations are required; one link per
 * (pattern, episode); a lesson rests on at least one reference and its author
 * cannot endorse it; nothing crosses a tenant wall.
 *
 * Runner-agnostic, so it works under `node --test` and anything later.
 */

import type { Result, Scope, UserId } from '@helm/shared';
import type { GenomeStore, NewEpisode, NewPattern, NewPatternRevision } from './port.ts';

export type GenomeTestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  };
};

export type GenomeStoreHarness = {
  name: string;
  create(): Promise<{
    store: GenomeStore;
    scopeA: Scope;
    scopeB: Scope;
    /** A decision of scopeA's organization to wrap in fixture episodes. */
    decisionId: string;
    /** The acting user of scopeA — the author of everything the suite records. */
    userId: UserId;
    now: () => Date;
    cleanup?: () => Promise<void>;
  }>;
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

const BASIC_SCOPE = { kind: 'ENTERPRISE_WIDE', justification: 'A conformance fixture that claims nothing about any enterprise.' } as const;
const NO_FEATURES = { values: { decisionType: [], triggerType: [], reversibility: [], businessUnit: [], country: [], constraintKind: [], expectedMetric: [], overrideMetric: [], customerClass: [] }, notStated: [], placement: {}, anchorIds: [] } as const;

const episodeOf = (decisionId: string, title: string, at: string, author: UserId): NewEpisode => ({
  decisionId,
  commitmentId: null,
  title,
  scope: BASIC_SCOPE,
  situation: NO_FEATURES,
  boundary: { effectiveAsOf: at, recordedThrough: at },
  sensitivityClasses: ['GENERAL_MANAGEMENT'],
  visibility: 'ORG_WIDE',
  grantedUnitIds: [],
  authoredBy: author,
  authoredByLabel: 'conformance',
});
const patternOf = (author: UserId): NewPattern => ({
  title: 'conformance pattern',
  scope: BASIC_SCOPE,
  conditions: {},
  characteristic: { kind: 'PROCESS_FEATURE', feature: 'CHALLENGE_OPEN_AT_COMMITMENT' },
  visibility: 'ORG_WIDE',
  grantedUnitIds: [],
  authoredBy: author,
  authoredByLabel: 'conformance',
});
const revisionOf = (statement: string, author: UserId): NewPatternRevision => ({ statement, limitations: 'A fixture: it shows nothing.', retired: false, retirementReason: null, recordedBy: author });

export function runGenomeStoreConformanceSuite(api: GenomeTestApi, harness: GenomeStoreHarness): void {
  const { describe, it, assert } = api;

  describe(`GenomeStore conformance — ${harness.name}`, () => {
    it('stamps record time itself; an episode reference is bound once per (episode, role, referenced id)', async () => {
      const h = await harness.create();
      const before = h.now().getTime() - 5 * 60_000;
      const ep = expectOk(await h.store.insertEpisode(h.scopeA, episodeOf(h.decisionId, 'conformance episode', h.now().toISOString(), h.userId)), 'episode');
      assert.ok(Date.parse(ep.recordedAt) >= before, "record time is the store's, not a caller's");
      const ref = { kind: 'TWIN_SNAPSHOT' as const, id: '00000000-0000-4000-8000-0000000000aa', pin: null, label: 'fixture' };
      expectOk(await h.store.insertEpisodeRef(h.scopeA, { episodeId: ep.id, role: 'OUTCOME_SNAPSHOT', ref, note: null, boundBy: h.userId }), 'ref');
      const again = await h.store.insertEpisodeRef(h.scopeA, { episodeId: ep.id, role: 'OUTCOME_SNAPSHOT', ref, note: 'again', boundBy: h.userId });
      assert.equal(again.ok, false, 'the same reference is not bound twice in the same role');
      const other = await h.store.insertEpisodeRef(h.scopeA, { episodeId: ep.id, role: 'COMMITTED_FUTURE', ref, note: null, boundBy: h.userId });
      assert.equal(other.ok, true, 'the same artifact may play another role');
      const listed = expectOk(await h.store.listEpisodeRefs(h.scopeA, ep.id), 'list');
      assert.equal(listed.length, 2);
      await h.cleanup?.();
    });

    it('records a pattern with its revision 1; revisions follow in order, need limitations, and stop at retirement', async () => {
      const h = await harness.create();
      const { pattern, revision } = expectOk(await h.store.insertPattern(h.scopeA, patternOf(h.userId), revisionOf('first', h.userId)), 'pattern');
      assert.equal(revision.revision, 1);
      assert.equal(revision.patternId, pattern.id);
      const r2 = expectOk(await h.store.insertPatternRevision(h.scopeA, pattern.id, revisionOf('second', h.userId)), 'rev 2');
      assert.equal(r2.revision, 2);
      const bare = await h.store.insertPatternRevision(h.scopeA, pattern.id, { ...revisionOf('no limits', h.userId), limitations: '  ' });
      assert.equal(bare.ok, false, 'a revision without limitations is refused');
      expectOk(await h.store.insertPatternRevision(h.scopeA, pattern.id, { ...revisionOf('retired', h.userId), retired: true, retirementReason: 'superseded' }), 'retire');
      const after = await h.store.insertPatternRevision(h.scopeA, pattern.id, revisionOf('after retirement', h.userId));
      assert.equal(after.ok, false, 'a retired pattern takes no further revision');
      const revs = expectOk(await h.store.listPatternRevisions(h.scopeA, pattern.id), 'revisions');
      assert.deepEqual(revs.map((r) => r.revision).sort(), [1, 2, 3]);
      assert.equal(revs.find((r) => r.revision === 1)!.statement, 'first', 'revision 1 is never rewritten');
      const unlimited = await h.store.insertPattern(h.scopeA, patternOf(h.userId), { ...revisionOf('x', h.userId), limitations: '' });
      assert.equal(unlimited.ok, false, 'a pattern cannot be recorded without limitations');
      await h.cleanup?.();
    });

    it('links one episode to one pattern once; the stance is not rewritten by linking again', async () => {
      const h = await harness.create();
      const ep = expectOk(await h.store.insertEpisode(h.scopeA, episodeOf(h.decisionId, 'linked episode', h.now().toISOString(), h.userId)), 'episode');
      const { pattern } = expectOk(await h.store.insertPattern(h.scopeA, patternOf(h.userId), revisionOf('linked', h.userId)), 'pattern');
      expectOk(await h.store.insertPatternEvidence(h.scopeA, { patternId: pattern.id, episodeId: ep.id, stance: 'CONTEXTUAL_EPISODE', rationale: 'r', observed: 'OUT_OF_SCOPE', linkedBy: h.userId }), 'link');
      const again = await h.store.insertPatternEvidence(h.scopeA, { patternId: pattern.id, episodeId: ep.id, stance: 'CONTEXTUAL_EPISODE', rationale: 'again', observed: 'OUT_OF_SCOPE', linkedBy: h.userId });
      assert.equal(again.ok, false, 'one link per (pattern, episode)');
      await h.cleanup?.();
    });

    it('a lesson rests on a reference; its author cannot endorse it; a review is appended, never edited', async () => {
      const h = await harness.create();
      const ep = expectOk(await h.store.insertEpisode(h.scopeA, episodeOf(h.decisionId, 'lesson episode', h.now().toISOString(), h.userId)), 'episode');
      const bare = await h.store.insertLesson(h.scopeA, { claim: 'no evidence', scope: BASIC_SCOPE, evidence: [], visibility: 'ORG_WIDE', grantedUnitIds: [], authoredBy: h.userId, authoredByLabel: 'conformance' });
      assert.equal(bare.ok, false, 'a lesson with no episode or pattern behind it is refused');
      const lesson = expectOk(
        await h.store.insertLesson(h.scopeA, {
          claim: 'Remember this.',
          scope: BASIC_SCOPE,
          evidence: [{ kind: 'MANAGEMENT_EPISODE', id: ep.id, pin: null, label: 'lesson episode' }],
          visibility: 'ORG_WIDE',
          grantedUnitIds: [],
          authoredBy: h.userId,
          authoredByLabel: 'conformance',
        }),
        'lesson',
      );
      const self = await h.store.insertLessonReview(h.scopeA, { lessonId: lesson.id, status: 'ENDORSED', note: 'I agree with myself.', reviewedBy: h.userId, reviewedByLabel: 'conformance' });
      assert.equal(self.ok, false, 'an author cannot endorse their own lesson');
      const dispute = await h.store.insertLessonReview(h.scopeA, { lessonId: lesson.id, status: 'DISPUTED', note: 'On reflection, the case is thinner than I said.', reviewedBy: h.userId, reviewedByLabel: 'conformance' });
      assert.equal(dispute.ok, true, 'an author may dispute their own lesson');
      const reviews = expectOk(await h.store.listLessonReviews(h.scopeA, lesson.id), 'reviews');
      assert.equal(reviews.length, 1);
      await h.cleanup?.();
    });

    it('nothing crosses the tenant wall', async () => {
      const h = await harness.create();
      const ep = expectOk(await h.store.insertEpisode(h.scopeA, episodeOf(h.decisionId, 'tenant A episode', h.now().toISOString(), h.userId)), 'episode');
      const { pattern } = expectOk(await h.store.insertPattern(h.scopeA, patternOf(h.userId), revisionOf('tenant A', h.userId)), 'pattern');
      const seen = expectOk(await h.store.listEpisodes(h.scopeB), 'B episodes');
      assert.ok(!seen.some((e) => e.id === ep.id), "B does not see A's episodes");
      const patterns = expectOk(await h.store.listPatterns(h.scopeB), 'B patterns');
      assert.ok(!patterns.some((p) => p.id === pattern.id), "B does not see A's patterns");
      const cross = await h.store.insertPatternEvidence(h.scopeB, { patternId: pattern.id, episodeId: ep.id, stance: 'CONTEXTUAL_EPISODE', rationale: 'r', observed: 'OUT_OF_SCOPE', linkedBy: h.userId });
      assert.equal(cross.ok, false, "B cannot link A's episode to A's pattern");
      await h.cleanup?.();
    });
  });
}
