/**
 * InMemoryCausalStore — the reference adapter, held to the same conformance
 * suite as PostgresCausalStore.
 *
 * Integrity it enforces (the database enforces the same, ADR-0026 §6):
 *   - every record is write-once; nothing is updated or deleted;
 *   - the store stamps record time from its own clock;
 *   - references stay inside the organization;
 *   - revisions are numbered 1, 2, 3 … and a retired claim takes no more;
 *   - one link per (claim, evidence); a CONTRADICTORY_CASE never SUPPORTS;
 *   - a correction supersedes one item of the same organization, once;
 *   - a question's candidate is an existing claim.
 */

import { fail, ok, type Clock, type IdGen, type Scope } from '@helm/shared';
import type { CausalStore, NewCandidate, NewClaim, NewCorrelation, NewEvidence, NewLink, NewQuestion, NewRevision, NewVariable } from './port.ts';
import {
  CausalErrors,
  type CausalClaim,
  type CausalEvidence,
  type CausalQuestion,
  type CausalVariable,
  type ClaimRevision,
  type CorrelationFinding,
  type EvidenceLink,
  type QuestionCandidate,
} from './types.ts';

export type InMemoryCausalStoreOptions = {
  clock: Clock;
  idGen: IdGen;
};

type Tenant = {
  variables: CausalVariable[];
  claims: CausalClaim[];
  revisions: ClaimRevision[];
  evidence: CausalEvidence[];
  links: EvidenceLink[];
  correlations: CorrelationFinding[];
  questions: CausalQuestion[];
  candidates: QuestionCandidate[];
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export function createInMemoryCausalStore(opts: InMemoryCausalStoreOptions): CausalStore {
  const tenants = new Map<string, Tenant>();
  const t = (scope: Scope): Tenant => {
    let x = tenants.get(scope.orgId);
    if (!x) {
      x = { variables: [], claims: [], revisions: [], evidence: [], links: [], correlations: [], questions: [], candidates: [] };
      tenants.set(scope.orgId, x);
    }
    return x;
  };
  const now = () => opts.clock.now().toISOString();
  const id = () => opts.idGen.next();
  const invalid = (msg: string) => fail(CausalErrors.INVALID, msg);

  const store: CausalStore = {
    async insertVariable(scope, input: NewVariable) {
      const x = t(scope);
      if (x.variables.some((v) => v.key === input.key)) return invalid(`A causal variable "${input.key}" already exists in this organization.`);
      const v: CausalVariable = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      x.variables.push(v);
      return ok(v);
    },
    async listVariables(scope) {
      return ok([...t(scope).variables]);
    },

    async insertClaim(scope, claim: NewClaim, first: NewRevision) {
      const x = t(scope);
      for (const key of [claim.causeKey, claim.effectKey]) {
        if (!x.variables.some((v) => v.key === key)) return invalid(`The claim names "${key}", which is not a causal variable of this organization.`);
      }
      if (claim.targetClaimId !== null && !x.claims.some((c) => c.id === claim.targetClaimId)) {
        return invalid('The claim qualifies a claim that does not exist in this organization.');
      }
      if (first.retired) return invalid('A claim cannot be created retired.');
      const at = now();
      const c: CausalClaim = deepFreeze({ ...claim, id: id(), orgId: scope.orgId, recordedAt: at });
      const r: ClaimRevision = deepFreeze({ ...first, id: id(), orgId: scope.orgId, claimId: c.id, revision: 1, recordedAt: at });
      x.claims.push(c);
      x.revisions.push(r);
      return ok({ claim: c, revision: r });
    },
    async insertRevision(scope, claimId, input: NewRevision) {
      const x = t(scope);
      if (!x.claims.some((c) => c.id === claimId)) return fail(CausalErrors.NOT_FOUND, 'No such claim in this organization.');
      const prior = x.revisions.filter((r) => r.claimId === claimId).sort((a, b) => a.revision - b.revision);
      const last = prior[prior.length - 1];
      if (last.retired) return fail(CausalErrors.IMMUTABLE, 'The claim is retired; it takes no further revision. Author a new claim.');
      const r: ClaimRevision = deepFreeze({ ...input, id: id(), orgId: scope.orgId, claimId, revision: last.revision + 1, recordedAt: now() });
      x.revisions.push(r);
      return ok(r);
    },
    async getClaim(scope, claimId) {
      return ok(t(scope).claims.find((c) => c.id === claimId) ?? null);
    },
    async listClaims(scope) {
      return ok([...t(scope).claims]);
    },
    async listRevisions(scope, claimId) {
      return ok(t(scope).revisions.filter((r) => claimId === undefined || r.claimId === claimId));
    },

    async insertEvidence(scope, input: NewEvidence) {
      const x = t(scope);
      if (input.supersedesId !== null) {
        if (!x.evidence.some((e) => e.id === input.supersedesId)) return invalid('A correction must supersede evidence of this organization.');
        if (x.evidence.some((e) => e.supersedesId === input.supersedesId)) {
          return fail(CausalErrors.IMMUTABLE, 'That evidence has already been corrected; correct the correction instead.');
        }
      }
      if (input.correlationFindingId !== null && !x.correlations.some((c) => c.id === input.correlationFindingId)) {
        return invalid('The evidence cites a correlation finding that does not exist in this organization.');
      }
      if (input.type === 'STATISTICAL_ANALYSIS' && input.statistical === null) {
        return invalid('A STATISTICAL_ANALYSIS states its method, population, period, estimate, uncertainty and limitations.');
      }
      const e: CausalEvidence = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      x.evidence.push(e);
      return ok(e);
    },
    async listEvidence(scope) {
      return ok([...t(scope).evidence]);
    },

    async insertLink(scope, input: NewLink) {
      const x = t(scope);
      if (!x.claims.some((c) => c.id === input.claimId)) return fail(CausalErrors.NOT_FOUND, 'No such claim in this organization.');
      const e = x.evidence.find((v) => v.id === input.evidenceId);
      if (!e) return fail(CausalErrors.NOT_FOUND, 'No such evidence in this organization.');
      if (e.type === 'CONTRADICTORY_CASE' && input.stance === 'SUPPORTS') {
        return invalid('A CONTRADICTORY_CASE is evidence against a claim; it cannot support one.');
      }
      if (x.links.some((l) => l.claimId === input.claimId && l.evidenceId === input.evidenceId)) {
        return fail(CausalErrors.DUPLICATE_LINK, 'This evidence is already linked to this claim; its stance is not rewritten.');
      }
      const l: EvidenceLink = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      x.links.push(l);
      return ok(l);
    },
    async listLinks(scope, claimId) {
      return ok(t(scope).links.filter((l) => claimId === undefined || l.claimId === claimId));
    },

    async insertCorrelation(scope, input: NewCorrelation) {
      const x = t(scope);
      for (const key of [input.xKey, input.yKey]) {
        if (!x.variables.some((v) => v.key === key)) return invalid(`The finding names "${key}", which is not a causal variable of this organization.`);
      }
      const c: CorrelationFinding = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      x.correlations.push(c);
      return ok(c);
    },
    async listCorrelations(scope) {
      return ok([...t(scope).correlations]);
    },

    async insertQuestion(scope, input: NewQuestion) {
      const x = t(scope);
      if (!x.variables.some((v) => v.key === input.target.variableKey)) return invalid('The question targets a variable that does not exist in this organization.');
      const q: CausalQuestion = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      x.questions.push(q);
      return ok(q);
    },
    async listQuestions(scope) {
      return ok([...t(scope).questions]);
    },
    async insertCandidate(scope, input: NewCandidate) {
      const x = t(scope);
      if (!x.questions.some((q) => q.id === input.questionId)) return fail(CausalErrors.NOT_FOUND, 'No such question in this organization.');
      if (!x.claims.some((c) => c.id === input.claimId)) return fail(CausalErrors.NOT_FOUND, 'A candidate explanation must be an existing claim of this organization.');
      if (x.candidates.some((c) => c.questionId === input.questionId && c.claimId === input.claimId)) {
        return fail(CausalErrors.DUPLICATE_LINK, 'That claim is already a candidate for this question.');
      }
      const c: QuestionCandidate = deepFreeze({ ...input, id: id(), orgId: scope.orgId, recordedAt: now() });
      x.candidates.push(c);
      return ok(c);
    },
    async listCandidates(scope, questionId) {
      return ok(t(scope).candidates.filter((c) => questionId === undefined || c.questionId === questionId));
    },
  };
  return store;
}
