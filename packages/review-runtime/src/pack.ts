/**
 * The review pack: what a review is prepared with, assembled from the kernel.
 *
 * Every section is a READ of an existing runtime under an explicit lens; nothing
 * is typed in, and nothing is decided here. Kernel order, no ranking and no
 * score: an item is in the pack because it happened in the window, not because
 * it matters more. Reproducible: the same review recomputed at its own lens
 * from the same records gives the same fingerprint.
 */

import { fnv1a64, type Scope } from '@helm/shared';
import type { SensitivityClass } from '@helm/twin-runtime';
import type { ReviewSources } from './port.ts';
import type { PackChange, ReviewLens, ReviewPack } from './types.ts';

export const REVIEW_PACK_VERSION = 'helm-review-pack@1';

export type PackInput = {
  readonly lens: ReviewLens;
  /** The previous review's closing lens. */
  readonly since: ReviewLens | null;
  readonly previousReviewId: string | null;
  /** The twin state under review: the opening snapshot (preparation) or the closing one. */
  readonly snapshotId: string;
  /** The previous review's closing snapshot: what "change since the previous review" is measured from. */
  readonly previousClosingSnapshotId: string | null;
};

const ms = (t: string) => Date.parse(t);
const inWindow = (at: string, since: ReviewLens | null, lens: ReviewLens) => ms(at) <= ms(lens.recordedThrough) && (since === null || ms(at) > ms(since.recordedThrough));
const section = <T>(items: readonly T[], note: string | null = null) => ({ items, note });
const empty = <T>(note: string) => section<T>([], note);

export async function computePack(sources: ReviewSources, scope: Scope, input: PackInput): Promise<ReviewPack> {
  const { lens, since } = input;
  const unavailable: string[] = [];

  // ---- what changed
  let changed: ReviewPack['changed'];
  if (input.previousClosingSnapshotId) {
    const d = await sources.twin.compareSnapshots(scope, input.previousClosingSnapshotId, input.snapshotId);
    if (d.ok) {
      const groups: [string, readonly { itemKey: string; label: string; category: string; change: 'ADDED' | 'REMOVED' | 'CHANGED'; statement: string; before: { sensitivity: SensitivityClass } | null; after: { sensitivity: SensitivityClass } | null }[]][] = [
        ['structural', d.value.structuralChanges],
        ['value', d.value.valueChanges],
        ['knowledge', d.value.knowledgeChanges],
        ['decision', d.value.decisionChanges],
        ['assumption', d.value.assumptionChanges],
        ['governance', d.value.governanceChanges],
        ['constraint', d.value.constraintChanges],
        ['attention', d.value.attentionChanges],
      ];
      const changes: PackChange[] = groups.flatMap(([, list]) => list.map((c) => ({ itemKey: c.itemKey, label: c.label, category: c.category, change: c.change, statement: c.statement, sensitivity: c.after?.sensitivity ?? c.before?.sensitivity ?? 'GENERAL_MANAGEMENT' })));
      changed = {
        fromSnapshotId: input.previousClosingSnapshotId,
        toSnapshotId: input.snapshotId,
        comparable: d.value.comparability.sameScope && d.value.comparability.sameModel,
        warnings: d.value.comparability.warnings,
        counts: Object.fromEntries(groups.map(([k, list]) => [k, list.length])),
        changes,
        statement: `${d.value.statement} Measured from the previous review's closing state.`,
      };
    } else {
      unavailable.push(`the change since the previous review (${d.error.message})`);
      changed = { fromSnapshotId: input.previousClosingSnapshotId, toSnapshotId: input.snapshotId, comparable: false, warnings: [d.error.message], counts: {}, changes: [], statement: 'The previous closing state could not be compared.' };
    }
  } else {
    changed = { fromSnapshotId: null, toSnapshotId: input.snapshotId, comparable: false, warnings: [], counts: {}, changes: [], statement: 'This is the first review of its scope and cadence: there is no previous closing state to measure change from.' };
  }

  // ---- what requires attention
  let attention: ReviewPack['attention'] = empty('No attention condition holds in this state.');
  const ms0 = await sources.twin.getManagementState(scope, input.snapshotId);
  if (ms0.ok) {
    const items = ms0.value.categories.ATTENTION.map((i) => ({
      itemKey: i.key,
      label: i.label,
      condition: String((i.state as { condition?: unknown }).condition ?? ''),
      statement: String((i.state as { statement?: unknown }).statement ?? i.reason ?? ''),
      sensitivity: i.sensitivity,
    }));
    attention = section(items, items.length === 0 ? 'No attention condition holds in this state.' : 'Named conditions with a cause — never a ranking.');
  } else unavailable.push(`attention (${ms0.error.message})`);

  // ---- decisions and commitments
  const decisionsNeeded: ReviewPack['decisionsNeeded']['items'][number][] = [];
  const offTrack: ReviewPack['commitmentsOffTrack']['items'][number][] = [];
  const assumptionsChanged: ReviewPack['assumptionsChanged']['items'][number][] = [];
  const outcomesArrived: ReviewPack['outcomesArrived']['items'][number][] = [];
  const decisions = await sources.decisions.listDecisions(scope);
  if (!decisions.ok) unavailable.push(`decisions (${decisions.error.message})`);
  else {
    const cfs = await sources.twin.listSnapshots(scope, { kind: 'COMMITTED_FUTURE' });
    for (const d of decisions.value) {
      if (ms(d.createdAt) > ms(lens.recordedThrough)) continue;
      const commitments = await sources.decisions.listCommitments(scope, d.id);
      if (!commitments.ok) continue;
      const known = commitments.value.filter((c) => ms(c.committedAt) <= ms(lens.recordedThrough));
      if (known.length === 0) decisionsNeeded.push({ decisionId: d.id, title: d.title, question: d.managementQuestion, openedAt: d.createdAt });
      for (const c of known) {
        const cf = cfs.ok ? cfs.value.find((s) => s.spec.commitmentId === c.id && ms(s.createdAt) <= ms(lens.recordedThrough)) : undefined;
        if (!cf) continue;
        const traj = await sources.twin.getTrajectory(scope, input.snapshotId, cf.id);
        if (!traj.ok) continue;
        const lines = traj.value.lines.filter((l) => l.beyondMateriality === true).map((l) => ({ label: l.label, committed: l.committed, current: l.current, difference: l.difference, unit: l.differenceUnit ?? l.unit }));
        if (lines.length > 0 || traj.value.unresolved.length > 0) {
          offTrack.push({ commitmentId: c.id, decisionId: d.id, title: d.title, relation: traj.value.relation, lines, unresolved: traj.value.unresolved.map((u) => `${u.label}: ${u.why}`) });
        }
      }
      const reviews = await sources.decisions.listOutcomeReviews(scope, d.id);
      if (!reviews.ok) continue;
      for (const r of reviews.value) {
        if (!inWindow(r.reviewedAt, since, lens)) continue;
        outcomesArrived.push({ decisionId: d.id, commitmentId: r.commitmentId, outcomeReviewId: r.id, reviewedAt: r.reviewedAt, variances: r.variances.map((v) => ({ label: v.label, expected: v.expected, actual: v.actual, variance: v.variance, unit: v.unit ? String(v.unit) : null })) });
        for (const a of r.assumptionResults) {
          if (a.outcome === 'PENDING') continue;
          assumptionsChanged.push({ decisionId: d.id, assumptionId: a.assumptionId, statement: a.statement, outcome: a.outcome, reviewedAt: r.reviewedAt });
        }
      }
    }
  }

  // ---- learning
  const learning: ReviewPack['learning'] = {
    episodes: empty('No episode was opened in the window.'),
    patterns: empty('No pattern was recorded or revised in the window.'),
    lessons: empty('No lesson was recorded in the window.'),
    counterfactuals: empty('No counterfactual case was asked in the window.'),
  };
  if (sources.genome) {
    const g = await sources.genome.viewAt(scope, lens);
    if (g.ok) {
      (learning as { episodes: unknown }).episodes = section(g.value.episodes.filter((e) => inWindow(e.episode.recordedAt, since, lens)).map((e) => ({ id: e.episode.id, decisionId: e.episode.decisionId, title: e.episode.title, status: e.status })));
      (learning as { patterns: unknown }).patterns = section(g.value.patterns.filter((p) => inWindow(p.revision.recordedAt, since, lens) || inWindow(p.pattern.recordedAt, since, lens)).map((p) => ({ id: p.pattern.id, title: p.pattern.title, status: p.status })));
      (learning as { lessons: unknown }).lessons = section(g.value.lessons.filter((l) => inWindow(l.lesson.recordedAt, since, lens)).map((l) => ({ id: l.lesson.id, claim: l.lesson.claim, status: l.status })));
    } else unavailable.push(`the genome (${g.error.message})`);
  } else unavailable.push('the genome (no genome is connected to this enterprise)');
  if (sources.counterfactual) {
    const c = await sources.counterfactual.viewAt(scope, lens);
    if (c.ok) (learning as { counterfactuals: unknown }).counterfactuals = section(c.value.cases.filter((k) => inWindow(k.case.recordedAt, since, lens)).map((k) => ({ id: k.case.id, decisionId: k.case.decisionId, title: k.case.title, status: k.status })));
    else unavailable.push(`counterfactual cases (${c.error.message})`);
  } else unavailable.push('counterfactual cases (none connected to this enterprise)');

  // ---- causal changes
  let causalChanges: ReviewPack['causalChanges'] = empty('No causal belief was recorded or revised in the window.');
  if (sources.causal) {
    const cl = await sources.causal.listClaims(scope, { lens });
    if (cl.ok) causalChanges = section(cl.value.filter((v) => inWindow(v.revision.recordedAt, since, lens)).map((v) => ({ claimId: v.claim.id, statement: v.revision.statement, status: v.evaluation.status, revision: v.revision.revision, recordedAt: v.revision.recordedAt })));
    else unavailable.push(`causal claims (${cl.error.message})`);
  } else unavailable.push('causal claims (none connected to this enterprise)');

  const body = {
    version: REVIEW_PACK_VERSION,
    snapshotId: input.snapshotId,
    previousClosingSnapshotId: input.previousClosingSnapshotId,
    changed: { counts: changed.counts, changes: changed.changes.map((c) => [c.itemKey, c.change, c.statement]), comparable: changed.comparable },
    attention: attention.items,
    decisionsNeeded: decisionsNeeded.map((d) => [d.decisionId, d.title]),
    offTrack: offTrack.map((o) => [o.commitmentId, o.lines.map((l) => [l.label, l.committed, l.current]), o.unresolved]),
    assumptionsChanged: assumptionsChanged.map((a) => [a.assumptionId, a.outcome]),
    outcomesArrived: outcomesArrived.map((o) => [o.outcomeReviewId, o.variances.map((v) => [v.label, v.expected, v.actual])]),
    learning: {
      episodes: learning.episodes.items.map((e) => [e.id, e.status]),
      patterns: learning.patterns.items.map((p) => [p.id, p.status]),
      lessons: learning.lessons.items.map((l) => [l.id, l.status]),
      counterfactuals: learning.counterfactuals.items.map((k) => [k.id, k.status]),
    },
    causal: causalChanges.items.map((c) => [c.claimId, c.revision, c.status]),
    // Which sources happened to be connected when the pack was computed is not content at the lens: an enterprise
    // that had no genome then has an empty one at that lens now. `unavailable` is shown, and never fingerprinted.
  };
  const fingerprint = `rvp_${fnv1a64(JSON.stringify(body))}`;
  return {
    lens,
    since,
    previousReviewId: input.previousReviewId,
    openingSnapshotId: input.snapshotId,
    changed,
    attention,
    decisionsNeeded: section(decisionsNeeded, decisionsNeeded.length === 0 ? 'Every decision opened at this lens has a commitment.' : null),
    commitmentsOffTrack: section(offTrack, offTrack.length === 0 ? 'No commitment is beyond materiality of its committed future.' : 'Current state against the committed future, beyond materiality; nothing is scored.'),
    assumptionsChanged: section(assumptionsChanged, assumptionsChanged.length === 0 ? 'No assumption result was recorded in the window.' : null),
    outcomesArrived: section(outcomesArrived, outcomesArrived.length === 0 ? 'No outcome review was recorded in the window.' : null),
    learning,
    causalChanges,
    unavailable,
    statement: `${changed.changes.length} change(s) since the previous review, ${attention.items.length} attention condition(s), ${decisionsNeeded.length} decision(s) needed, ${offTrack.length} commitment(s) off-track, ${assumptionsChanged.length} assumption result(s), ${outcomesArrived.length} outcome(s) arrived. Kernel order; nothing is ranked, weighted or totalled.`,
    fingerprint,
  };
}
