/**
 * The CausalStore conformance suite.
 *
 * ONE contract, run against EVERY adapter: records are write-once and
 * stamped with the store's own record time; a claim and its first revision
 * exist together; revisions are sequential and stop at retirement; a
 * correction supersedes once; a link is unique, never lets a contradictory
 * case support a claim, and never points at a correlation finding; a
 * question's candidate is an existing claim; nothing crosses a tenant wall.
 *
 * Runner-agnostic, so it works under `node --test` and anything later.
 */

import type { Result, Scope } from '@helm/shared';
import type { CausalStore, NewClaim, NewEvidence, NewRevision } from './port.ts';

export type CausalTestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  };
};

export type CausalStoreHarness = {
  name: string;
  create(): Promise<{
    store: CausalStore;
    scopeA: Scope;
    scopeB: Scope;
    /** An entity of scopeA to anchor fixture scopes on. */
    anchorEntityId: string;
    now: () => Date;
    cleanup?: () => Promise<void>;
  }>;
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

let seq = 0;
const unique = (p: string, now: () => Date) => `${p}_${now().getTime().toString(36).toUpperCase()}_${(seq += 1)}`;

const claimOf = (cause: string, effect: string, anchor: string): NewClaim => ({
  causeKey: cause,
  effectKey: effect,
  relationshipType: 'INCREASES',
  targetClaimId: null,
  scope: { kind: 'ANCHORED', anchors: [{ entityId: anchor, label: 'anchor', dimension: 'BUSINESS_UNIT' }] },
  conditions: [],
  applicablePeriod: { from: null, to: null },
  sensitivity: 'GENERAL_MANAGEMENT',
  visibility: 'ORG_WIDE',
  grantedUnitIds: [],
  authoredBy: null,
  authoredByLabel: 'conformance',
});
const revisionOf = (statement: string): NewRevision => ({
  statement,
  mechanism: [],
  confounders: [],
  rationale: 'conformance',
  externalValidity: 'unknown',
  links: [],
  retired: false,
  retirementReason: null,
  recordedBy: null,
});
const evidenceOf = (type: NewEvidence['type'], supersedesId: string | null = null): NewEvidence => ({
  type,
  statement: `conformance ${type}`,
  assessedStrength: 'MEDIUM',
  strengthRationale: 'conformance',
  provenance: { sourceSystem: 'manual', sourceReference: 'conformance', method: 'DOCUMENT', assertedBy: null, assertedByLabel: 'conformance', assertedRole: null },
  causeObservedAt: null,
  effectObservedAt: null,
  statistical: null,
  correlationFindingId: null,
  refs: [],
  sensitivity: 'GENERAL_MANAGEMENT',
  supersedesId,
  recordedBy: null,
});

export function runCausalStoreConformanceSuite(api: CausalTestApi, harness: CausalStoreHarness): void {
  const { describe, it, assert } = api;

  async function fixture() {
    const h = await harness.create();
    const x = unique('X', h.now);
    const y = unique('Y', h.now);
    for (const key of [x, y]) {
      expectOk(
        await h.store.insertVariable(h.scopeA, { key, label: key, kind: 'EVENT', metricKey: null, description: '', sensitivity: 'GENERAL_MANAGEMENT', refs: [], recordedBy: null }),
        `variable ${key}`,
      );
    }
    return { ...h, x, y };
  }

  describe(`CausalStore conformance — ${harness.name}`, () => {
    it('stamps record time itself, and a variable key is unique per organization', async () => {
      const h = await fixture();
      const before = h.now().getTime() - 5 * 60_000;
      const vars = expectOk(await h.store.listVariables(h.scopeA), 'list');
      const v = vars.find((q) => q.key === h.x);
      assert.ok(v, 'the variable is listed');
      assert.ok(Date.parse(v!.recordedAt) >= before, 'record time is the store\'s, not a caller\'s');
      const dup = await h.store.insertVariable(h.scopeA, { key: h.x, label: 'again', kind: 'EVENT', metricKey: null, description: '', sensitivity: 'GENERAL_MANAGEMENT', refs: [], recordedBy: null });
      assert.equal(dup.ok, false, 'a second variable with the same key is refused');
      await h.cleanup?.();
    });

    it('creates a claim with its revision 1; revisions follow in order and stop at retirement', async () => {
      const h = await fixture();
      const { claim, revision } = expectOk(await h.store.insertClaim(h.scopeA, claimOf(h.x, h.y, h.anchorEntityId), revisionOf('first')), 'claim');
      assert.equal(revision.revision, 1);
      assert.equal(revision.claimId, claim.id);
      const r2 = expectOk(await h.store.insertRevision(h.scopeA, claim.id, revisionOf('second')), 'rev 2');
      assert.equal(r2.revision, 2);
      expectOk(await h.store.insertRevision(h.scopeA, claim.id, { ...revisionOf('retired'), retired: true, retirementReason: 'superseded by a narrower claim' }), 'retire');
      const after = await h.store.insertRevision(h.scopeA, claim.id, revisionOf('after retirement'));
      assert.equal(after.ok, false, 'a retired claim takes no further revision');
      const revs = expectOk(await h.store.listRevisions(h.scopeA, claim.id), 'revisions');
      assert.deepEqual(revs.map((r) => r.revision).sort(), [1, 2, 3]);
      assert.equal(revs.find((r) => r.revision === 1)!.statement, 'first', 'revision 1 is never rewritten');
      const unknown = await h.store.insertClaim(h.scopeA, claimOf(h.x, unique('NOPE', h.now), h.anchorEntityId), revisionOf('dangling'));
      assert.equal(unknown.ok, false, 'a claim must name existing variables');
      await h.cleanup?.();
    });

    it('evidence is write-once; a correction supersedes exactly once', async () => {
      const h = await fixture();
      const e = expectOk(await h.store.insertEvidence(h.scopeA, evidenceOf('PROCESS_MECHANISM')), 'evidence');
      const c1 = expectOk(await h.store.insertEvidence(h.scopeA, evidenceOf('PROCESS_MECHANISM', e.id)), 'correction');
      assert.equal(c1.supersedesId, e.id);
      const c2 = await h.store.insertEvidence(h.scopeA, evidenceOf('PROCESS_MECHANISM', e.id));
      assert.equal(c2.ok, false, 'an item is superseded once; correct the correction instead');
      const listed = expectOk(await h.store.listEvidence(h.scopeA), 'list');
      assert.ok(listed.some((x) => x.id === e.id), 'the corrected item is still there');
      const stat = await h.store.insertEvidence(h.scopeA, evidenceOf('STATISTICAL_ANALYSIS'));
      assert.equal(stat.ok, false, 'a statistical analysis states its method, population, period, estimate, uncertainty and limitations');
      await h.cleanup?.();
    });

    it('links are unique; a contradictory case never supports; a correlation is never linked as evidence', async () => {
      const h = await fixture();
      const { claim } = expectOk(await h.store.insertClaim(h.scopeA, claimOf(h.x, h.y, h.anchorEntityId), revisionOf('linked')), 'claim');
      const e = expectOk(await h.store.insertEvidence(h.scopeA, evidenceOf('REPEATED_PATTERN')), 'evidence');
      expectOk(await h.store.insertLink(h.scopeA, { claimId: claim.id, evidenceId: e.id, stance: 'SUPPORTS', rationale: 'r', linkedBy: null }), 'link');
      const again = await h.store.insertLink(h.scopeA, { claimId: claim.id, evidenceId: e.id, stance: 'CONTRADICTS', rationale: 'flip', linkedBy: null });
      assert.equal(again.ok, false, 'a stance is not rewritten by linking again');
      const counter = expectOk(await h.store.insertEvidence(h.scopeA, evidenceOf('CONTRADICTORY_CASE')), 'counter-case');
      const wrong = await h.store.insertLink(h.scopeA, { claimId: claim.id, evidenceId: counter.id, stance: 'SUPPORTS', rationale: 'r', linkedBy: null });
      assert.equal(wrong.ok, false, 'a contradictory case cannot support a claim');
      const corr = expectOk(
        await h.store.insertCorrelation(h.scopeA, {
          xKey: h.x,
          yKey: h.y,
          direction: 'POSITIVE',
          method: 'm',
          population: 'p',
          period: 'q',
          effectEstimate: 'e',
          uncertainty: 'u',
          limitations: 'l',
          scope: { kind: 'ANCHORED', anchors: [{ entityId: h.anchorEntityId, label: 'anchor', dimension: 'BUSINESS_UNIT' }] },
          refs: [],
          sensitivity: 'GENERAL_MANAGEMENT',
          recordedBy: null,
        }),
        'correlation',
      );
      const asEvidence = await h.store.insertLink(h.scopeA, { claimId: claim.id, evidenceId: corr.id, stance: 'SUPPORTS', rationale: 'r', linkedBy: null });
      assert.equal(asEvidence.ok, false, 'a correlation finding is not evidence until a person records evidence citing it');
      await h.cleanup?.();
    });

    it('a question\'s candidate is an existing claim, proposed once', async () => {
      const h = await fixture();
      const { claim } = expectOk(await h.store.insertClaim(h.scopeA, claimOf(h.x, h.y, h.anchorEntityId), revisionOf('candidate')), 'claim');
      const q = expectOk(
        await h.store.insertQuestion(h.scopeA, {
          statement: 'why?',
          target: { variableKey: h.y, metricKey: null, nodeId: null, fromSnapshotId: null, toSnapshotId: null, itemKey: null, observedChange: null, unit: null },
          scope: { kind: 'ANCHORED', anchors: [{ entityId: h.anchorEntityId, label: 'anchor', dimension: 'BUSINESS_UNIT' }] },
          period: { from: null, to: null },
          grantedUnitIds: [],
          askedBy: null,
        }),
        'question',
      );
      expectOk(await h.store.insertCandidate(h.scopeA, { questionId: q.id, claimId: claim.id, rationale: 'r', proposedBy: null }), 'candidate');
      const dup = await h.store.insertCandidate(h.scopeA, { questionId: q.id, claimId: claim.id, rationale: 'again', proposedBy: null });
      assert.equal(dup.ok, false, 'proposed once');
      const ghost = await h.store.insertCandidate(h.scopeA, { questionId: q.id, claimId: '00000000-0000-4000-8000-000000000000', rationale: 'r', proposedBy: null });
      assert.equal(ghost.ok, false, 'a candidate must be an existing claim — HELM never invents one');
      await h.cleanup?.();
    });

    it('nothing crosses the tenant wall', async () => {
      const h = await fixture();
      const { claim } = expectOk(await h.store.insertClaim(h.scopeA, claimOf(h.x, h.y, h.anchorEntityId), revisionOf('tenant A')), 'claim');
      const e = expectOk(await h.store.insertEvidence(h.scopeA, evidenceOf('PROCESS_MECHANISM')), 'evidence');
      const seenByB = expectOk(await h.store.listClaims(h.scopeB), 'B claims');
      assert.ok(!seenByB.some((c) => c.id === claim.id), 'B does not see A\'s claims');
      const evB = expectOk(await h.store.listEvidence(h.scopeB), 'B evidence');
      assert.ok(!evB.some((x) => x.id === e.id), 'B does not see A\'s evidence');
      const cross = await h.store.insertLink(h.scopeB, { claimId: claim.id, evidenceId: e.id, stance: 'SUPPORTS', rationale: 'r', linkedBy: null });
      assert.equal(cross.ok, false, 'B cannot link A\'s evidence to A\'s claim');
      await h.cleanup?.();
    });
  });
}
