/**
 * createReviewRuntime — the management review loop.
 *
 * A review binds; it does not decide. Framing, committing and governing are done
 * in the decision and authority runtimes, and a review only records — by
 * reference, in an append-only item — that in this review management did. What a
 * review is prepared with (the pack) is assembled from the kernel under an
 * explicit lens, and what it closed with is checked by fingerprint: a closed
 * review is memory, and later data cannot rewrite what management saw.
 */

import { canSeeDecision, type OrgUnit } from '@helm/authority-runtime';
import { isCleared, type SensitivityClass, type TwinScope, type TwinViewer } from '@helm/twin-runtime';
import { fail, ok, type Clock, type Result, type Scope } from '@helm/shared';
import { computePack } from './pack.ts';
import type { AddItemInput, OpenReviewInput, ReviewRuntime, ReviewSources, ReviewStore, ReviewView, ReviewVisibilityFacts } from './port.ts';
import {
  ReviewErrors,
  cadences,
  dispositions as dispositionValues,
  itemKinds,
  itemRoles,
  type ItemKind,
  type ItemRef,
  type ManagementReview,
  type ReviewClosure,
  type ReviewItem,
  type ReviewLens,
  type ReviewPack,
} from './types.ts';

export type ReviewRuntimeOptions = { store: ReviewStore; sources: ReviewSources; clock: Clock };

const ms = (t: string) => Date.parse(t);
const scopeKey = (s: TwinScope) => (s.kind === 'ENTERPRISE' ? 'ENTERPRISE' : s.entityId);
const DECISION_BOUND: readonly ItemKind[] = ['DECISION', 'COMMITMENT', 'ASSUMPTION', 'ACTION_INTENT', 'EPISODE', 'COUNTERFACTUAL_CASE'];

export function createReviewRuntime(opts: ReviewRuntimeOptions): ReviewRuntime {
  const { store, sources } = opts;
  const invalid = (m: string) => fail(ReviewErrors.INVALID, m);
  const atNow = (): ReviewLens => ({ effectiveAsOf: opts.clock.now().toISOString(), recordedThrough: opts.clock.now().toISOString() });

  async function closureOf(scope: Scope, reviewId: string, lens?: ReviewLens): Promise<Result<ReviewClosure | null>> {
    const c = await store.getClosure(scope, reviewId);
    if (!c.ok) return c;
    return ok(c.value && (!lens || ms(c.value.recordedAt) <= ms(lens.recordedThrough)) ? c.value : null);
  }

  async function view(scope: Scope, review: ManagementReview, lens?: ReviewLens): Promise<Result<ReviewView>> {
    const items = await store.listItems(scope, review.id);
    if (!items.ok) return items;
    const closure = await closureOf(scope, review.id, lens);
    if (!closure.ok) return closure;
    const known = items.value.filter((i) => !lens || ms(i.recordedAt) <= ms(lens.recordedThrough));
    let previous: ReviewView['previous'] = null;
    if (review.previousReviewId) {
      const p = await store.getReview(scope, review.previousReviewId);
      if (p.ok && p.value) previous = { id: p.value.id, title: p.value.title, periodLabel: p.value.periodLabel };
    }
    let change: ReviewView['changeDuringReview'] = null;
    if (closure.value) {
      const d = await sources.twin.compareSnapshots(scope, review.openingSnapshotId, closure.value.closingSnapshotId);
      if (d.ok) {
        change = {
          counts: { structural: d.value.structuralChanges.length, value: d.value.valueChanges.length, knowledge: d.value.knowledgeChanges.length, decision: d.value.decisionChanges.length, assumption: d.value.assumptionChanges.length, governance: d.value.governanceChanges.length, constraint: d.value.constraintChanges.length, attention: d.value.attentionChanges.length },
          statement: `${d.value.statement} Measured from this review's opening state to its closing state.`,
        };
      }
    }
    return ok({
      review,
      lens: lens ?? atNow(),
      status: closure.value ? 'CLOSED' : 'OPEN',
      items: known,
      closure: closure.value,
      previous,
      changeDuringReview: change,
      statement: closure.value
        ? `${review.cadence} review ${review.periodLabel}: closed. ${known.length} item(s), each resolved, carried forward or dropped; the closing state is a stored twin snapshot.`
        : `${review.cadence} review ${review.periodLabel}: open. Preparation was assembled from the kernel; deciding, committing and governing happen in their own runtimes and are linked here.`,
    });
  }

  async function previousClosureFor(scope: Scope, review: Pick<ManagementReview, 'previousReviewId'>) {
    if (!review.previousReviewId) return null;
    const c = await store.getClosure(scope, review.previousReviewId);
    return c.ok ? c.value : null;
  }

  async function validateRef(scope: Scope, review: ManagementReview, kind: ItemKind, ref: ItemRef): Promise<Result<{ decisionId: string | null }>> {
    const bad = (m: string) => fail(ReviewErrors.BAD_REF, m);
    switch (kind) {
      case 'ATTENTION': {
        const snap = await sources.twin.getSnapshot(scope, review.openingSnapshotId);
        if (!snap.ok) return snap;
        const it = snap.value.items.find((i) => i.key === ref.id);
        return it && it.categories.includes('ATTENTION') ? ok({ decisionId: null }) : bad(`"${ref.id}" is not an attention item of this review's opening state.`);
      }
      case 'DECISION': {
        const d = await sources.decisions.getDecision(scope, ref.id);
        if (!d.ok) return d;
        return d.value ? ok({ decisionId: d.value.id }) : bad('No such decision.');
      }
      case 'COMMITMENT': {
        const c = await sources.decisions.getCommitment(scope, ref.id);
        if (!c.ok) return c;
        return c.value ? ok({ decisionId: c.value.decisionId }) : bad('No such commitment.');
      }
      case 'ASSUMPTION':
      case 'ACTION_INTENT': {
        const ds = await sources.decisions.listDecisions(scope);
        if (!ds.ok) return ds;
        for (const d of ds.value) {
          if (kind === 'ASSUMPTION') {
            const revs = await sources.decisions.listRevisions(scope, d.id);
            if (!revs.ok) continue;
            for (const r of revs.value) {
              const a = await sources.decisions.listAssumptions(scope, r.id);
              if (a.ok && a.value.some((x) => x.id === ref.id)) return ok({ decisionId: d.id });
            }
          } else {
            const cs = await sources.decisions.listCommitments(scope, d.id);
            if (!cs.ok) continue;
            for (const c of cs.value) {
              const i = await sources.decisions.listActionIntents(scope, c.id);
              if (i.ok && i.value.some((x) => x.id === ref.id)) return ok({ decisionId: d.id });
            }
          }
        }
        return bad(`No such ${kind === 'ASSUMPTION' ? 'assumption' : 'action intent'}.`);
      }
      case 'EPISODE': {
        if (!sources.genome) return fail(ReviewErrors.SOURCE_MISSING, 'No genome is connected to this enterprise.');
        const e = await sources.genome.getEpisode(scope, ref.id);
        if (!e.ok) return e;
        return ok({ decisionId: e.value.episode.decisionId });
      }
      case 'PATTERN': {
        if (!sources.genome) return fail(ReviewErrors.SOURCE_MISSING, 'No genome is connected to this enterprise.');
        const p = await sources.genome.getPattern(scope, ref.id);
        return p.ok ? ok({ decisionId: null }) : p;
      }
      case 'LESSON': {
        if (!sources.genome) return fail(ReviewErrors.SOURCE_MISSING, 'No genome is connected to this enterprise.');
        const g = await sources.genome.viewAt(scope);
        if (!g.ok) return g;
        return g.value.lessons.some((l) => l.lesson.id === ref.id) ? ok({ decisionId: null }) : bad('No such lesson.');
      }
      case 'COUNTERFACTUAL_CASE': {
        if (!sources.counterfactual) return fail(ReviewErrors.SOURCE_MISSING, 'No counterfactual engine is connected to this enterprise.');
        const c = await sources.counterfactual.getCase(scope, ref.id);
        if (!c.ok) return c;
        return ok({ decisionId: c.value.case.decisionId });
      }
      case 'CAUSAL_CLAIM': {
        if (!sources.causal) return fail(ReviewErrors.SOURCE_MISSING, 'No causal graph is connected to this enterprise.');
        const cl = await sources.causal.listClaims(scope);
        if (!cl.ok) return cl;
        return cl.value.some((v) => v.claim.id === ref.id) ? ok({ decisionId: null }) : bad('No such causal claim.');
      }
      default:
        return bad(`Unknown item kind ${kind}.`);
    }
  }

  return {
    async openReview(scope, input: OpenReviewInput) {
      if (!input.title.trim() || !input.periodLabel.trim() || !input.openedByLabel.trim()) return invalid('A review has a title, a period and a name.');
      if (!(cadences as readonly string[]).includes(input.cadence)) return invalid(`Unknown cadence "${input.cadence}".`);
      const all = await store.listReviews(scope);
      if (!all.ok) return all;
      const closures = await store.listClosures(scope);
      if (!closures.ok) return closures;
      const closedIds = new Set(closures.value.map((c) => c.reviewId));
      const same = all.value.filter((r) => scopeKey(r.scope) === scopeKey(input.scope) && r.cadence === input.cadence);
      if (same.some((r) => !closedIds.has(r.id))) return fail(ReviewErrors.ALREADY_OPEN, `A ${input.cadence} review of ${input.scope.label} is already open: close it before opening the next.`);

      let previous: ManagementReview | null = null;
      if (input.previousReviewId === undefined) {
        const closedSame = same.filter((r) => closedIds.has(r.id));
        previous = closedSame.length > 0 ? closedSame.reduce((a, b) => (ms(closures.value.find((c) => c.reviewId === a.id)!.recordedAt) >= ms(closures.value.find((c) => c.reviewId === b.id)!.recordedAt) ? a : b)) : null;
      } else if (input.previousReviewId !== null) {
        const p = await store.getReview(scope, input.previousReviewId);
        if (!p.ok) return p;
        if (!p.value) return fail(ReviewErrors.NOT_FOUND, 'The previous review does not exist.');
        if (!closedIds.has(p.value.id)) return fail(ReviewErrors.PREVIOUS_NOT_CLOSED, 'A review follows a CLOSED review: what is still open there is carried forward from its closure.');
        if (scopeKey(p.value.scope) !== scopeKey(input.scope)) return fail(ReviewErrors.PREVIOUS_OTHER_SCOPE, 'The previous review is of another scope.');
        previous = p.value;
      }
      const prevClosure = previous ? closures.value.find((c) => c.reviewId === previous!.id) ?? null : null;
      // Periods stated > the previous review's > the twin's own default for the lens. An empty list is never passed on:
      // the first review of a scope has no previous one, and "no periods" would compose a state that reads nothing.
      let periods: readonly string[] | undefined = input.periods && input.periods.length > 0 ? input.periods : undefined;
      if (previous && !periods) {
        const ps = await sources.twin.getSnapshot(scope, previous.openingSnapshotId);
        if (ps.ok) periods = ps.value.snapshot.spec.periods;
      }

      const composed = await sources.twin.buildSnapshot(scope, { kind: 'CURRENT', label: `${input.title} — opening state`, scope: input.scope, ...(periods ? { periods } : {}), grantedUnitIds: input.grantedUnitIds ?? [] });
      if (!composed.ok) return composed;
      const lens = composed.value.snapshot.spec.lens;
      const pack = await computePack(sources, scope, {
        lens,
        since: prevClosure ? prevClosure.closingLens : null,
        previousReviewId: previous?.id ?? null,
        snapshotId: composed.value.snapshot.id,
        previousClosingSnapshotId: prevClosure ? prevClosure.closingSnapshotId : null,
      });
      const review = await store.insertReview(scope, {
        title: input.title.trim(),
        cadence: input.cadence,
        periodLabel: input.periodLabel.trim(),
        scope: input.scope,
        previousReviewId: previous?.id ?? null,
        openingSnapshotId: composed.value.snapshot.id,
        openingLens: lens,
        preparationFingerprint: pack.fingerprint,
        sensitivityClasses: composed.value.snapshot.sensitivityClasses,
        visibility: input.visibility ?? 'ORG_WIDE',
        grantedUnitIds: [...(input.grantedUnitIds ?? [])].sort(),
        openedBy: scope.actorId,
        openedByLabel: input.openedByLabel,
      });
      if (!review.ok) return review;
      // What the previous review left open is carried forward BY REFERENCE: the same object, not a copy.
      if (prevClosure) {
        const prevItems = await store.listItems(scope, previous!.id);
        if (!prevItems.ok) return prevItems;
        for (const d of prevClosure.dispositions.filter((x) => x.disposition === 'CARRIED_FORWARD')) {
          const it = prevItems.value.find((i) => i.id === d.itemId);
          if (!it) continue;
          const carried = await store.insertItem(scope, { reviewId: review.value.id, kind: it.kind, role: 'RAISED', ref: it.ref, decisionId: it.decisionId, note: it.kind === 'QUESTION' ? it.note : `Carried forward: ${d.reason}`, carriedFromItemId: it.id, addedBy: scope.actorId });
          if (!carried.ok) return carried;
        }
      }
      return view(scope, review.value);
    },

    async addItem(scope, reviewId, input: AddItemInput) {
      const r = await store.getReview(scope, reviewId);
      if (!r.ok) return r;
      if (!r.value) return fail(ReviewErrors.NOT_FOUND, 'No such review.');
      const closure = await closureOf(scope, reviewId);
      if (!closure.ok) return closure;
      if (closure.value) return fail(ReviewErrors.CLOSED, 'This review is closed: it is memory and takes no more items. Raise it in the next review.');
      if (!(itemKinds as readonly string[]).includes(input.kind)) return invalid(`Unknown item kind "${input.kind}".`);
      const role = input.role ?? 'RAISED';
      if (!(itemRoles as readonly string[]).includes(role)) return invalid(`Unknown role "${role}".`);
      if (role === 'COMMITTED' && input.kind !== 'COMMITMENT') return invalid('Only a commitment can be recorded as committed in a review.');
      if ((role === 'FRAMED' || role === 'RECONSIDERED') && input.kind !== 'DECISION') return invalid(`Only a decision can be recorded as ${role.toLowerCase()} in a review.`);
      const note = (input.note ?? '').trim();
      if (input.kind === 'QUESTION') {
        if (note.length < 8) return invalid('A question is a sentence: say what management is asking.');
        if (role !== 'RAISED') return invalid('A question is raised.');
        return store.insertItem(scope, { reviewId, kind: 'QUESTION', role: 'RAISED', ref: null, decisionId: null, note, carriedFromItemId: null, addedBy: scope.actorId });
      }
      if (!input.ref || !input.ref.id) return invalid('Point at the object this review touched.');
      if (input.ref.kind !== input.kind) return invalid(`The reference is a ${input.ref.kind}, not a ${input.kind}.`);
      const existing = await store.listItems(scope, reviewId);
      if (!existing.ok) return existing;
      if (existing.value.some((i) => i.kind === input.kind && i.ref?.id === input.ref!.id && i.role === role)) return fail(ReviewErrors.DUPLICATE, 'This review already records that.');
      const valid = await validateRef(scope, r.value, input.kind, input.ref);
      if (!valid.ok) return valid;
      return store.insertItem(scope, { reviewId, kind: input.kind, role, ref: input.ref, decisionId: DECISION_BOUND.includes(input.kind) ? valid.value.decisionId : null, note, carriedFromItemId: null, addedBy: scope.actorId });
    },

    async closeReview(scope, reviewId, input) {
      const r = await store.getReview(scope, reviewId);
      if (!r.ok) return r;
      if (!r.value) return fail(ReviewErrors.NOT_FOUND, 'No such review.');
      const review = r.value;
      const already = await closureOf(scope, reviewId);
      if (!already.ok) return already;
      if (already.value) return fail(ReviewErrors.CLOSED, 'This review is already closed.');
      if (!input.summary.trim() || !input.closedByLabel.trim()) return invalid('A closure has management\'s summary and a name.');
      const items = await store.listItems(scope, reviewId);
      if (!items.ok) return items;
      const byItem = new Map(input.dispositions.map((d) => [d.itemId, d]));
      for (const d of input.dispositions) {
        if (!(dispositionValues as readonly string[]).includes(d.disposition)) return invalid(`Unknown disposition "${d.disposition}".`);
        if (!items.value.some((i) => i.id === d.itemId)) return fail(ReviewErrors.BAD_REF, 'A disposition names an item that is not part of this review.');
        if (!d.reason.trim()) return invalid('Every disposition says why.');
      }
      const missing = items.value.filter((i) => !byItem.has(i.id));
      if (missing.length > 0) return fail(ReviewErrors.OPEN_ITEMS, `${missing.length} item(s) have no disposition: each is resolved, carried forward or dropped — none is left hanging.`, { itemIds: missing.map((i) => i.id) });

      const opening = await sources.twin.getSnapshot(scope, review.openingSnapshotId);
      if (!opening.ok) return opening;
      const composed = await sources.twin.buildSnapshot(scope, { kind: 'CURRENT', label: `${review.title} — closing state`, scope: review.scope, periods: opening.value.snapshot.spec.periods, grantedUnitIds: review.grantedUnitIds });
      if (!composed.ok) return composed;
      const lens = composed.value.snapshot.spec.lens;
      const pack = await computePack(sources, scope, { lens, since: review.openingLens, previousReviewId: review.previousReviewId, snapshotId: composed.value.snapshot.id, previousClosingSnapshotId: review.openingSnapshotId });
      const closed = await store.insertClosure(scope, {
        reviewId,
        closingSnapshotId: composed.value.snapshot.id,
        closingLens: lens,
        closingFingerprint: pack.fingerprint,
        summary: input.summary.trim(),
        dispositions: input.dispositions.map((d) => ({ itemId: d.itemId, disposition: d.disposition, reason: d.reason.trim() })),
        closedBy: scope.actorId,
        closedByLabel: input.closedByLabel,
      });
      if (!closed.ok) return closed;
      return view(scope, review);
    },

    async getReview(scope, id, lens) {
      const r = await store.getReview(scope, id);
      if (!r.ok) return r;
      if (!r.value) return fail(ReviewErrors.NOT_FOUND, 'No such review.');
      if (lens && ms(r.value.recordedAt) > ms(lens.recordedThrough)) return fail(ReviewErrors.NOT_KNOWN_AT_LENS, 'This review had not been opened at that lens.');
      return view(scope, r.value, lens);
    },

    async listReviews(scope, lens) {
      const all = await store.listReviews(scope);
      if (!all.ok) return all;
      const out: ReviewView[] = [];
      for (const r of all.value) {
        if (lens && ms(r.recordedAt) > ms(lens.recordedThrough)) continue;
        const v = await view(scope, r, lens);
        if (!v.ok) return v;
        out.push(v.value);
      }
      return ok(out);
    },

    async prepare(scope, reviewId) {
      const r = await store.getReview(scope, reviewId);
      if (!r.ok) return r;
      if (!r.value) return fail(ReviewErrors.NOT_FOUND, 'No such review.');
      const prev = await previousClosureFor(scope, r.value);
      return ok(await computePack(sources, scope, { lens: r.value.openingLens, since: prev ? prev.closingLens : null, previousReviewId: r.value.previousReviewId, snapshotId: r.value.openingSnapshotId, previousClosingSnapshotId: prev ? prev.closingSnapshotId : null }));
    },

    async closingPack(scope, reviewId) {
      const r = await store.getReview(scope, reviewId);
      if (!r.ok) return r;
      if (!r.value) return fail(ReviewErrors.NOT_FOUND, 'No such review.');
      const c = await store.getClosure(scope, reviewId);
      if (!c.ok) return c;
      if (!c.value) return ok(null);
      return ok(await computePack(sources, scope, { lens: c.value.closingLens, since: r.value.openingLens, previousReviewId: r.value.previousReviewId, snapshotId: c.value.closingSnapshotId, previousClosingSnapshotId: r.value.openingSnapshotId }));
    },

    async reproduce(scope, reviewId, which) {
      const r = await store.getReview(scope, reviewId);
      if (!r.ok) return r;
      if (!r.value) return fail(ReviewErrors.NOT_FOUND, 'No such review.');
      let stored: string;
      let recomputed: string;
      if (which === 'PREPARATION') {
        const p = await this.prepare(scope, reviewId);
        if (!p.ok) return p;
        stored = r.value.preparationFingerprint;
        recomputed = p.value.fingerprint;
      } else {
        const c = await store.getClosure(scope, reviewId);
        if (!c.ok) return c;
        if (!c.value) return fail(ReviewErrors.NOT_KNOWN_AT_LENS, 'This review is not closed: there is no closing state to reproduce.');
        const p = await this.closingPack(scope, reviewId);
        if (!p.ok) return p;
        stored = c.value.closingFingerprint;
        recomputed = p.value!.fingerprint;
      }
      const identical = stored === recomputed;
      return ok({
        reviewId,
        which,
        storedFingerprint: stored,
        recomputedFingerprint: recomputed,
        identical,
        statement: identical
          ? `The ${which === 'PREPARATION' ? 'preparation' : 'closing'} pack recomputed from the kernel at the review's own lens is identical to what management saw: later data has not rewritten it.`
          : `The ${which === 'PREPARATION' ? 'preparation' : 'closing'} pack recomputed at the review's own lens differs from what was stored. Something recorded at or before that lens has changed; this is a defect, not a new fact.`,
      });
    },

    async preparedFor(scope, reviewId, viewer: TwinViewer, units: readonly OrgUnit[], facts: ReviewVisibilityFacts) {
      const r = await store.getReview(scope, reviewId);
      if (!r.ok) return r;
      if (!r.value) return fail(ReviewErrors.NOT_FOUND, 'No such review.');
      const at = opts.clock.now().toISOString();
      const isAdmin = viewer.orgRole === 'admin';
      const rv = r.value;
      const unitOk = isAdmin || rv.visibility === 'ORG_WIDE' || canSeeDecision({ userId: viewer.userId, orgRole: viewer.orgRole, memberUnitIds: viewer.memberUnitIds }, { createdBy: rv.openedBy, grantedUnitIds: rv.grantedUnitIds }, units).visible;
      const classesOk = (rv.sensitivityClasses as readonly SensitivityClass[]).every((c) => isCleared(viewer, c, at));
      if (!unitOk || !classesOk) return fail(ReviewErrors.NOT_FOUND, 'This review is not within your unit audience and clearance: a review is read whole or not at all.');
      const full = await this.prepare(scope, reviewId);
      if (!full.ok) return full;
      const p = full.value;
      const seeD = (id: string) => isAdmin || facts.decisionVisible(id);
      const pattern = new Set<string>();
      const lesson = new Set<string>();
      const claim = new Set<string>();
      if (sources.genome) {
        const g = await sources.genome.projectForViewer(scope, viewer, units, facts);
        if (g.ok) {
          g.value.patterns.forEach((x) => pattern.add(x.pattern.id));
          g.value.lessons.forEach((x) => lesson.add(x.lesson.id));
        }
      }
      if (sources.causal) {
        const c = await sources.causal.projectForViewer(scope, viewer, units, facts);
        if (c.ok) c.value.claims.forEach((v) => claim.add(v.claim.id));
      }
      const clear = (k: SensitivityClass) => isCleared(viewer, k, at);
      let withheld = 0;
      const keep = <T>(items: readonly T[], ok2: (x: T) => boolean): readonly T[] => {
        const kept = items.filter(ok2);
        withheld += items.length - kept.length;
        return kept;
      };
      const pack: ReviewPack = {
        ...p,
        changed: { ...p.changed, changes: keep(p.changed.changes, (c) => clear(c.sensitivity)) },
        attention: { ...p.attention, items: keep(p.attention.items, (a) => clear(a.sensitivity)) },
        decisionsNeeded: { ...p.decisionsNeeded, items: keep(p.decisionsNeeded.items, (d) => seeD(d.decisionId)) },
        commitmentsOffTrack: { ...p.commitmentsOffTrack, items: keep(p.commitmentsOffTrack.items, (o) => seeD(o.decisionId)) },
        assumptionsChanged: { ...p.assumptionsChanged, items: keep(p.assumptionsChanged.items, (a) => seeD(a.decisionId)) },
        outcomesArrived: { ...p.outcomesArrived, items: keep(p.outcomesArrived.items, (o) => seeD(o.decisionId)) },
        learning: {
          episodes: { ...p.learning.episodes, items: keep(p.learning.episodes.items, (e) => seeD(e.decisionId)) },
          patterns: { ...p.learning.patterns, items: keep(p.learning.patterns.items, (x) => pattern.has(x.id)) },
          lessons: { ...p.learning.lessons, items: keep(p.learning.lessons.items, (x) => lesson.has(x.id)) },
          counterfactuals: { ...p.learning.counterfactuals, items: keep(p.learning.counterfactuals.items, (c) => seeD(c.decisionId)) },
        },
        causalChanges: { ...p.causalChanges, items: keep(p.causalChanges.items, (c) => claim.has(c.claimId)) },
      };
      return ok({
        pack,
        withheld,
        statement: withheld === 0 ? 'Every section of this pack is within your clearance and the decisions you can see.' : `${withheld} entr${withheld === 1 ? 'y' : 'ies'} withheld: they exist in the pack and are above your clearance or rest on a decision you cannot see. The pack itself is unchanged.`,
      });
    },

    async projectForViewer(scope, viewer: TwinViewer, units: readonly OrgUnit[], facts: ReviewVisibilityFacts, lens) {
      const all = await this.listReviews(scope, lens);
      if (!all.ok) return all;
      const at = lens?.recordedThrough ?? opts.clock.now().toISOString();
      const isAdmin = viewer.orgRole === 'admin';
      // Genome and causal items are read through the runtimes' own rules — a review never widens what they show.
      const visiblePattern = new Set<string>();
      const visibleLesson = new Set<string>();
      const visibleClaim = new Set<string>();
      if (sources.genome) {
        const g = await sources.genome.projectForViewer(scope, viewer, units, facts);
        if (g.ok) {
          g.value.patterns.forEach((p) => visiblePattern.add(p.pattern.id));
          g.value.lessons.forEach((l) => visibleLesson.add(l.lesson.id));
        }
      }
      if (sources.causal) {
        const c = await sources.causal.projectForViewer(scope, viewer, units, facts);
        if (c.ok) c.value.claims.forEach((v) => visibleClaim.add(v.claim.id));
      }
      const itemOk = (i: ReviewItem) => {
        if (i.decisionId) return isAdmin || facts.decisionVisible(i.decisionId);
        if (i.kind === 'PATTERN') return visiblePattern.has(i.ref!.id);
        if (i.kind === 'LESSON') return visibleLesson.has(i.ref!.id);
        if (i.kind === 'CAUSAL_CLAIM') return visibleClaim.has(i.ref!.id);
        return true;
      };
      const reviews: ReviewView[] = [];
      let withheld = 0;
      for (const v of all.value) {
        const r = v.review;
        const unitOk = isAdmin || r.visibility === 'ORG_WIDE' || canSeeDecision({ userId: viewer.userId, orgRole: viewer.orgRole, memberUnitIds: viewer.memberUnitIds }, { createdBy: r.openedBy, grantedUnitIds: r.grantedUnitIds }, units).visible;
        const classesOk = (r.sensitivityClasses as readonly SensitivityClass[]).every((c) => isCleared(viewer, c, at));
        if (unitOk && classesOk) reviews.push({ ...v, items: v.items.filter(itemOk) });
        else withheld += 1;
      }
      return ok({
        reviews,
        withheld,
        statement: withheld === 0 ? 'Every review is within your unit audience and clearance.' : `${withheld} review(s) withheld whole: a review is read whole or not at all, and your unit audience or clearance does not cover it. Items about a decision you cannot see are withheld from the reviews you can read.`,
      });
    },
  };
}
